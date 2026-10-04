import json
import os
import re
import uuid
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote

from fastapi import APIRouter, Depends, File, Form, Header, HTTPException, Query, UploadFile
from fastapi.responses import Response
from sqlalchemy import func
from sqlalchemy.orm import Session, joinedload

from .auth import (
    create_driver_token,
    create_token,
    get_current_driver,
    get_current_user,
    hash_password,
    issue_driver_credentials,
    parse_qr_token,
    require_admin,
    verify_password,
)
from .database import get_db
from .dispatch import (
    apply_warehouse,
    ensure_drivers_from_orders,
    live_origin,
    local_now,
    local_today,
    local_tomorrow,
    missing_agent_error,
    next_agent_code,
    normalize_agent_code,
    org_warehouses,
    pick_warehouse,
    plan_orders,
    replan_orders,
    resequence_org,
    resolve_agent,
    resolve_order_agent,
    reys_key,
    sequence_drivers,
    sync_agents_from_orders,
)
from .seed import DEFAULT_DISPATCHER_PERMS, ensure_org_templates
from .phones import format_uz_phone
from .importer import (
    DRIVER_MAPPING,
    HEADER_LIKE_NAMES,
    RELOG_MAPPING,
    auto_read_order_records,
    build_excel_bytes,
    build_template_json,
    driver_value,
    fields_for,
    header_key,
    headers_from_mapping,
    inspect_table,
    mapped_value,
    parse_template_config,
    read_driver_records,
    read_records,
    to_float,
)
from .models import (
    DONE_STATUSES,
    Agent,
    Client,
    DayPlan,
    Driver,
    ImportTemplate,
    Order,
    Organization,
    SessionToken,
    User,
    Warehouse,
)
from .permissions import (
    ADMIN_ONLY_KEYS,
    SUPER_ONLY_KEYS,
    can_write_agent_code,
    catalog_for,
    has_perm,
    is_super,
    parse_permission_list,
)
from .schemas import (
    AgentCodeIn,
    AgentIn,
    AgentOut,
    BulkAssignIn,
    BulkDateIn,
    BulkIdsIn,
    BulkStatusIn,
    ClientIn,
    ClientOut,
    DayPlanIn,
    DayPlanOut,
    DriverAccessIn,
    DriverAccessOut,
    DriverAgentIn,
    DriverIn,
    DriverOut,
    DriverQrIn,
    GpsBatchIn,
    DriverOrderStatusIn,
    DriverReorderIn,
    DriverReplanIn,
    DriverStartIn,
    LoginIn,
    MeUpdate,
    OrderIn,
    OrderOut,
    OrgIn,
    OrgOut,
    OrgUpdate,
    OrgUserIn,
    OrgUserUpdate,
    PlanIn,
    RouteRenameIn,
    TemplateIn,
    TemplateOut,
    TemplateReviewIn,
    UserCreate,
    UserOut,
    UserPermissionsIn,
    UserUpdate,
    WarehouseIn,
    WarehouseOut,
)
from .tenancy import (
    can_cross_org,
    dump_permissions,
    get_org_row,
    is_org_code,
    new_org_code,
    org_id_of,
    q_org,
    require_perm,
    user_payload,
    users_scope,
)
from .tracking import (
    ONLINE_TTL,
    _aware,
    driver_active_orders,
    ingest_gps,
    reverse_geocode,
    route_geometry_for,
    search_geocode,
    tracking_payload,
)

router = APIRouter(prefix="/api")


def _excel_file(content: bytes, filename: str) -> Response:
    safe = quote(filename)
    return Response(
        content=content,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f"attachment; filename*=UTF-8''{safe}"},
    )


def _import_drivers(db: Session, records: list[dict], mapping: dict[str, str], org_id: int) -> dict:
    agents = db.query(Agent).filter(Agent.org_id == org_id).all()
    existing = {
        (d.name.strip().lower(), (d.vehicle_plate or "").strip().lower())
        for d in db.query(Driver).filter(Driver.org_id == org_id).all()
    }
    created = 0
    skipped = 0
    reasons: list[str] = []
    rows: list[Driver] = []
    for rec in records:
        name = (driver_value(rec, mapping, "name") or "")[:160].strip()
        plate = (driver_value(rec, mapping, "vehicle_plate") or "")[:32].strip()
        phone = (driver_value(rec, mapping, "phone") or "")[:40].strip()
        if not name or header_key(name) in HEADER_LIKE_NAMES:
            skipped += 1
            reasons.append("Ism bo‘sh yoki sarlavha qatori")
            continue
        key = (name.lower(), plate.lower())
        if key in existing:
            skipped += 1
            reasons.append(f"{name}: bazada bor, takroriy")
            continue
        existing.add(key)
        agent_name = driver_value(rec, mapping, "agent_name")
        agent = resolve_agent(agents, code=agent_name, name=agent_name)
        status = (driver_value(rec, mapping, "status") or "idle").strip().lower()
        if status not in {"idle", "on_route", "assigned"}:
            status = "idle"
        vtype = (driver_value(rec, mapping, "vehicle_type") or "furgon")[:64].strip() or "furgon"
        rows.append(
            Driver(
                org_id=org_id,
                name=name,
                phone=format_uz_phone(phone),
                vehicle_plate=plate,
                vehicle_type=vtype,
                status=status,
                agent_id=agent.id if agent else None,
            )
        )
        created += 1
    logins = []
    if rows:
        db.add_all(rows)
        db.flush()
        for row in rows:
            logins.append(issue_driver_credentials(db, row, reset_password=True, reset_qr=True))
        db.commit()
    return {"ok": True, "created": created, "skipped": skipped, "rows": len(records), "reasons": reasons[:12], "logins": logins}


def _client_out(c: Client) -> ClientOut:
    data = ClientOut.model_validate(c)
    data.phone = format_uz_phone(c.phone)
    return data


def _prepare_agent_payload(
    db: Session,
    payload: AgentIn,
    org_id: int,
    user: User,
    existing: Agent | None = None,
) -> dict:
    data = payload.model_dump()
    new_code = normalize_agent_code(data.get("code") or "")
    old_code = (existing.code if existing else "") or ""
    if not new_code and not old_code:
        raise HTTPException(400, "Agent kodi majburiy (01–99)")
    if not new_code:
        new_code = old_code
    if new_code != old_code:
        if not can_write_agent_code(user, existing):
            raise HTTPException(403, "Kodni faqat administrator o‘zgartira oladi")
        clash = db.query(Agent).filter(Agent.org_id == org_id, Agent.code == new_code)
        if existing:
            clash = clash.filter(Agent.id != existing.id)
        if clash.first():
            raise HTTPException(400, f"Agent kodi {new_code} band")
        data["code"] = new_code
        data["code_locked"] = True
    else:
        data["code"] = old_code or new_code
        if existing is None:
            data["code_locked"] = True
        else:
            data.pop("code_locked", None)
    data["phone"] = format_uz_phone(data.get("phone") or "")
    data["org_id"] = org_id
    return data


def _agent_out(a: Agent) -> AgentOut:
    return AgentOut(
        id=a.id,
        name=a.name,
        code=a.code or "",
        phone=format_uz_phone(a.phone),
        region=a.region,
        commission_pct=a.commission_pct,
        is_active=a.is_active,
        driver_count=len(a.drivers or []),
        code_locked=bool(getattr(a, "code_locked", False)),
    )


def _driver_out(d: Driver) -> DriverOut:
    seen_at = _aware(getattr(d, "seen_at", None))
    online = bool(seen_at and datetime.now(timezone.utc) - seen_at <= ONLINE_TTL)
    return DriverOut(
        online=online,
        seen_at=seen_at.isoformat() if seen_at else None,
        id=d.id,
        name=d.name,
        phone=format_uz_phone(d.phone),
        vehicle_plate=d.vehicle_plate,
        vehicle_type=d.vehicle_type,
        status=d.status,
        lat=d.lat,
        lng=d.lng,
        heading=d.heading,
        agent_id=d.agent_id,
        agent_name=d.agent.name if d.agent else None,
        agent_code=(d.agent.code if d.agent else "") or "",
        is_active=d.is_active,
        username=d.username or "",
        has_password=bool(d.password_hash),
    )


def _extra_val(o: Order, key: str) -> str:
    try:
        extra = json.loads(o.extra_json or "{}")
        return str(extra.get(key) or "")
    except Exception:
        return ""


def _order_out(o: Order) -> OrderOut:
    w = getattr(o, "warehouse", None)
    return OrderOut(
        id=o.id,
        code=o.code,
        client_id=o.client_id,
        client_name=o.client.name if o.client else None,
        driver_id=o.driver_id,
        driver_name=o.driver.name if o.driver else None,
        pickup_address=o.pickup_address,
        dropoff_address=o.dropoff_address,
        pickup_lat=o.pickup_lat,
        pickup_lng=o.pickup_lng,
        dropoff_lat=o.dropoff_lat,
        dropoff_lng=o.dropoff_lng,
        cargo=o.cargo,
        weight_kg=o.weight_kg,
        amount=getattr(o, "amount", 0) or 0,
        route_code=getattr(o, "route_code", "") or "",
        extra_json=getattr(o, "extra_json", None),
        stop_no=getattr(o, "stop_no", 0) or 0,
        sales_rep=getattr(o, "sales_rep", "") or _extra_val(o, "sales_rep"),
        agent_code=getattr(o, "agent_code", "") or "",
        delivery_date=getattr(o, "delivery_date", "") or _extra_val(o, "delivery_date"),
        window_start=getattr(o, "window_start", "") or "",
        window_end=getattr(o, "window_end", "") or "",
        status=o.status,
        eta_minutes=o.eta_minutes,
        warehouse_id=getattr(o, "warehouse_id", None),
        warehouse_name=w.name if w else None,
        warehouse_lat=float(w.lat) if w else None,
        warehouse_lng=float(w.lng) if w else None,
        proof_reason=getattr(o, "proof_reason", "") or "",
        proof_photo=getattr(o, "proof_photo", "") or "",
        proof_at=o.proof_at.isoformat() if getattr(o, "proof_at", None) else None,
    )


def _warehouse_out(row: Warehouse) -> WarehouseOut:
    return WarehouseOut(
        id=row.id,
        name=row.name,
        address=row.address or "",
        lat=float(row.lat),
        lng=float(row.lng),
        is_default=bool(row.is_default),
        is_active=bool(row.is_active),
    )


def _bind_order_warehouse(db: Session, order: Order, org_id: int, pickup_name: str = "") -> None:
    warehouses = org_warehouses(db, org_id)
    apply_warehouse(order, pick_warehouse(warehouses, [order], pickup_name or order.pickup_address))


def _set_default_warehouse(db: Session, org_id: int, keep_id: int | None = None) -> None:
    q = db.query(Warehouse).filter(Warehouse.org_id == org_id, Warehouse.is_default.is_(True))
    if keep_id:
        q = q.filter(Warehouse.id != keep_id)
    q.update({Warehouse.is_default: False}, synchronize_session=False)


def _check_wh_gps(lat, lng) -> None:
    try:
        if 37 < float(lat) < 46 and 55 < float(lng) < 76:
            return
    except (TypeError, ValueError):
        pass
    raise HTTPException(400, "Sklad lokatsiyasi O‘zbekiston xaritasi ichida bo‘lishi kerak")


def _norm_reys_code(value: str) -> str:
    return " ".join((value or "").strip().casefold().split())


def _filter_reys(rows: list[Order], route_code: str = "", delivery_date: str = "") -> list[Order]:
    code = _norm_reys_code(route_code)
    date = (delivery_date or "").strip()[:10]
    if not code and not date:
        return rows
    exact = []
    by_code = []
    for order in rows:
        d, c = reys_key(order)
        if code and _norm_reys_code(c) != code:
            continue
        if date and d != date:
            by_code.append(order)
            continue
        exact.append(order)
    return exact or by_code


def _driver_route_payload(db: Session, driver: Driver, rows: list[Order] | None = None) -> dict:
    all_rows = driver_active_orders(db, driver)
    use = rows if rows is not None else all_rows
    warehouses = org_warehouses(db, driver.org_id)
    warehouse = pick_warehouse(warehouses, use)
    reys = []
    seen: set[tuple[str, str]] = set()
    dates: list[str] = []
    date_seen: set[str] = set()
    for order in all_rows:
        key = reys_key(order)
        if key not in seen:
            seen.add(key)
            date, code = key
            label = " · ".join(x for x in (code or "", date) if x) or "Boshqa"
            n = sum(1 for o in all_rows if reys_key(o) == key)
            reys.append({"key": f"{date}|{code}", "route_code": code, "delivery_date": date, "label": label, "count": n})
        d = str(getattr(order, "delivery_date", "") or "")[:10]
        if d and d not in date_seen:
            date_seen.add(d)
            dates.append(d)
    dates.sort()
    return {
        "driver": _driver_out(driver),
        "orders": [_order_out(o) for o in all_rows],
        "all_count": len(all_rows),
        "reys": reys,
        "dates": dates,
        "warehouse": _warehouse_out(warehouse) if warehouse else None,
        "geometry": route_geometry_for(use, driver, warehouse),
        "origin": "gps" if driver.status == "on_route" and getattr(driver, "gps_at", None) else "warehouse",
        "started": driver.status == "on_route",
        "downloaded_at": datetime.now(timezone.utc).isoformat(),
        "offline_ok": True,
    }


def _template_out(t: ImportTemplate) -> TemplateOut:
    sheet, header_row, mapping = parse_template_config(t.mapping_json)
    return TemplateOut(
        id=t.id,
        name=t.name,
        entity=t.entity,
        description=t.description,
        mapping_json=t.mapping_json,
        status=t.status,
        submitted_by=t.submitted_by,
        reviewed_by=t.reviewed_by,
        review_note=t.review_note,
        created_at=t.created_at.isoformat() if t.created_at else None,
        sheet=str(sheet) if sheet is not None else None,
        header_row=header_row,
        mapping=mapping,
    )


@router.post("/auth/login")
def login(payload: LoginIn, db: Session = Depends(get_db)):
    code = (payload.org_code or "").strip()
    if not code:
        candidates = (
            db.query(User)
            .options(joinedload(User.org))
            .filter(User.role == "superadmin", User.username == payload.username.strip(), User.is_active.is_(True))
            .all()
        )
        user = next((u for u in candidates if verify_password(payload.password, u.password_hash)), None)
        if not user:
            raise HTTPException(
                status_code=401,
                detail="Login yoki parol noto‘g‘ri. Superadmin bo‘lmasangiz, tashkilot kodini kiriting",
            )
        token = create_token(db, user)
        return {"token": token, "user": user_payload(user)}
    if not is_org_code(code):
        raise HTTPException(status_code=400, detail="Tashkilot kodi 6 xonali raqam bo‘lishi kerak")
    org = db.query(Organization).filter(Organization.code == code).first()
    user = None
    if org:
        user = (
            db.query(User)
            .options(joinedload(User.org))
            .filter(User.org_id == org.id, User.username == payload.username.strip())
            .first()
        )
    if not user or not user.is_active or not verify_password(payload.password, user.password_hash):
        raise HTTPException(status_code=401, detail="Tashkilot kodi, login yoki parol noto‘g‘ri")
    if not org.is_active and user.role != "superadmin":
        raise HTTPException(status_code=403, detail="Tashkilot faol emas. Administrator bilan bog‘laning")
    token = create_token(db, user)
    return {"token": token, "user": user_payload(user)}


@router.get("/auth/me", response_model=UserOut)
def me(user: User = Depends(get_current_user)):
    return user_payload(user)


@router.put("/auth/me", response_model=UserOut)
def update_me(payload: MeUpdate, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    row = db.query(User).options(joinedload(User.org)).filter(User.id == user.id).first()
    wants_login = payload.username is not None or payload.password is not None or payload.full_name is not None
    if wants_login:
        if not payload.current_password or not verify_password(payload.current_password, row.password_hash):
            raise HTTPException(400, "Joriy parol noto‘g‘ri")
    if payload.username is not None:
        username = payload.username.strip()
        if len(username) < 3:
            raise HTTPException(400, "Login kamida 3 belgi bo‘lsin")
        taken = db.query(User).filter(User.org_id == row.org_id, User.username == username, User.id != row.id).first()
        if taken:
            raise HTTPException(400, "Bu login band")
        row.username = username
    if payload.full_name is not None:
        name = payload.full_name.strip()
        if not name:
            raise HTTPException(400, "Ism bo‘sh bo‘lmasin")
        row.full_name = name
    if payload.password is not None:
        if len(payload.password) < 6:
            raise HTTPException(400, "Yangi parol kamida 6 belgi bo‘lsin")
        row.password_hash = hash_password(payload.password)
    if payload.idle_timeout_minutes is not None:
        mins = int(payload.idle_timeout_minutes)
        if mins < 0 or mins > 1440:
            raise HTTPException(400, "Harakatsizlik 0–1440 daqiqa oralig‘ida")
        row.idle_timeout_minutes = mins
    if payload.org_id is not None and payload.org_id != row.org_id:
        raise HTTPException(403, "Tashkilotni almashtirib bo‘lmaydi")
    db.commit()
    row = db.query(User).options(joinedload(User.org)).filter(User.id == user.id).first()
    return user_payload(row)


@router.post("/auth/driver-login")
def driver_login(payload: LoginIn, db: Session = Depends(get_db)):
    row = db.query(Driver).filter(Driver.username == payload.username.strip()).first()
    if (
        not row
        or not row.is_active
        or not row.password_hash
        or not verify_password(payload.password, row.password_hash)
    ):
        raise HTTPException(status_code=401, detail="Login yoki parol noto'g'ri")
    token = create_driver_token(db, row)
    return {"token": token, "role": "driver", "driver": _driver_out(row)}


@router.post("/auth/driver-qr")
def driver_qr_login(payload: DriverQrIn, db: Session = Depends(get_db)):
    token_value = parse_qr_token(payload.token)
    if not token_value:
        raise HTTPException(status_code=401, detail="QR kod yaroqsiz")
    row = db.query(Driver).filter(Driver.qr_token == token_value, Driver.is_active.is_(True)).first()
    if not row:
        raise HTTPException(status_code=401, detail="QR kod yaroqsiz")
    token = create_driver_token(db, row)
    return {"token": token, "role": "driver", "driver": _driver_out(row)}


@router.get("/driver/me")
def driver_me(driver: Driver = Depends(get_current_driver)):
    return _driver_out(driver)


@router.post("/driver/logout")
def driver_logout(
    authorization: str | None = Header(None),
    db: Session = Depends(get_db),
):
    """Ilovadan chiqish — shu qurilmaning tokeni bekor qilinadi (boshqa qurilmalar sessiyasi qoladi)."""
    token = (authorization or "").split(" ", 1)[-1].strip()
    if token:
        db.query(SessionToken).filter(SessionToken.token == token, SessionToken.driver_id.isnot(None)).delete()
        db.commit()
    return {"ok": True}


@router.get("/driver/orders", response_model=list[OrderOut])
def driver_orders(db: Session = Depends(get_db), driver: Driver = Depends(get_current_driver)):
    rows = driver_active_orders(db, driver)
    return [_order_out(o) for o in rows]


@router.get("/driver/route")
def driver_route(db: Session = Depends(get_db), driver: Driver = Depends(get_current_driver)):
    return _driver_route_payload(db, driver)


@router.post("/driver/location")
def driver_location(
    payload: GpsBatchIn,
    db: Session = Depends(get_db),
    driver: Driver = Depends(get_current_driver),
):
    result = ingest_gps(db, driver, payload.points or [])
    db.commit()
    return {"ok": True, **result}


@router.post("/driver/sync")
def driver_sync(
    payload: GpsBatchIn,
    db: Session = Depends(get_db),
    driver: Driver = Depends(get_current_driver),
):
    gps = ingest_gps(db, driver, payload.points or [])
    payload_out = _driver_route_payload(db, driver)
    db.commit()
    return {"ok": True, "gps": gps, **payload_out}


@router.post("/driver/start")
def driver_start(
    payload: DriverStartIn,
    db: Session = Depends(get_db),
    driver: Driver = Depends(get_current_driver),
):
    all_rows = driver_active_orders(db, driver)
    rows = _filter_reys(all_rows, payload.route_code, payload.delivery_date)
    if not rows:
        raise HTTPException(400, "Tanlangan reysda zayavka yo‘q")
    driver.status = "on_route"
    for row in rows:
        if row.status in {"new", "assigned"}:
            row.status = "in_transit"
    out = _driver_route_payload(db, driver, rows)
    db.commit()
    return {"ok": True, **out}


@router.post("/driver/replan")
def driver_replan(
    payload: DriverReplanIn,
    db: Session = Depends(get_db),
    driver: Driver = Depends(get_current_driver),
):
    """Yo‘lda: tanlangan zayavka birinchi, qolganlari telefon GPS'idan yaqinidan uzog‘iga."""
    all_rows = driver_active_orders(db, driver)
    rows = _filter_reys(all_rows, payload.route_code, payload.delivery_date)
    if not rows:
        return {"ok": True, **_driver_route_payload(db, driver)}
    first = next((o for o in rows if o.id == payload.first_id), None) if payload.first_id else None
    phone = (payload.lat, payload.lng) if payload.lat is not None and payload.lng is not None else None
    origin = phone or live_origin(driver)
    if not origin:
        wh = pick_warehouse(org_warehouses(db, driver.org_id), rows)
        origin = (float(wh.lat), float(wh.lng)) if wh else None
    replan_orders(rows, origin, first)
    db.flush()
    out = _driver_route_payload(db, driver, sorted(rows, key=lambda o: (o.stop_no or 0, o.id)))
    db.commit()
    return {"ok": True, **out}


@router.post("/driver/reorder")
def driver_reorder(
    payload: DriverReorderIn,
    db: Session = Depends(get_db),
    driver: Driver = Depends(get_current_driver),
):
    """Haydovchi ketma-ketlikni qo‘lda o‘zgartirdi — stop_no shu tartibda yoziladi."""
    all_rows = driver_active_orders(db, driver)
    rows = _filter_reys(all_rows, payload.route_code, payload.delivery_date)
    by_id = {o.id: o for o in rows}
    picked = [by_id[i] for i in dict.fromkeys(payload.order_ids) if i in by_id]
    rest = sorted((o for o in rows if o not in picked), key=lambda o: (o.stop_no or 0, o.id))
    for n, row in enumerate(picked + rest, start=1):
        row.stop_no = n
    db.flush()
    out = _driver_route_payload(db, driver, picked + rest)
    db.commit()
    return {"ok": True, **out}


@router.post("/driver/orders/{item_id}/status")
def driver_order_status(
    item_id: int,
    payload: DriverOrderStatusIn,
    db: Session = Depends(get_db),
    driver: Driver = Depends(get_current_driver),
):
    row = (
        db.query(Order)
        .filter(Order.id == item_id, Order.driver_id == driver.id)
        .first()
    )
    if not row:
        raise HTTPException(404, "Zayavka topilmadi")
    status = (payload.status or "").strip()
    if status not in {"assigned", "on_route", "delivered"}:
        raise HTTPException(400, "Noto‘g‘ri status")
    row.status = status
    if status == "on_route":
        driver.status = "on_route"
    left = (
        db.query(Order)
        .filter(Order.driver_id == driver.id, Order.status.notin_(DONE_STATUSES))
        .count()
    )
    if status == "delivered" and left == 0:
        driver.status = "idle"
    db.commit()
    return {"ok": True, "order": _order_out(row), "driver": _driver_out(driver)}


UPLOAD_DIR = Path(os.getenv("UPLOAD_DIR") or Path(__file__).resolve().parent.parent / "uploads")
PROOF_REASONS = {
    "delivered": {"fridge_yes", "foreign_goods", "fridge_no"},
    "returned": {""},
}
MAX_PROOF_BYTES = 12 * 1024 * 1024


@router.post("/driver/orders/{item_id}/proof")
async def driver_order_proof(
    item_id: int,
    result: str = Form(...),
    reason: str = Form(""),
    photo: UploadFile = File(...),
    db: Session = Depends(get_db),
    driver: Driver = Depends(get_current_driver),
):
    """Yetkazildi / Qaytarildi — rasm bilan tasdiqlash."""
    result = (result or "").strip()
    reason = (reason or "").strip()
    if result not in PROOF_REASONS:
        raise HTTPException(400, "Noto‘g‘ri natija")
    if reason not in PROOF_REASONS[result]:
        raise HTTPException(400, "Sababni tanlang")
    row = db.query(Order).filter(Order.id == item_id, Order.driver_id == driver.id).first()
    if not row:
        raise HTTPException(404, "Zayavka topilmadi")
    data = await photo.read()
    if not data:
        raise HTTPException(400, "Rasm tushirilmagan")
    if len(data) > MAX_PROOF_BYTES:
        raise HTTPException(400, "Rasm juda katta")
    if not (photo.content_type or "").startswith("image/"):
        raise HTTPException(400, "Faqat rasm yuklash mumkin")
    now = local_now()
    folder = UPLOAD_DIR / "proofs" / now.strftime("%Y-%m-%d")
    folder.mkdir(parents=True, exist_ok=True)
    name = f"{row.id}_{uuid.uuid4().hex}.jpg"
    (folder / name).write_bytes(data)
    row.proof_photo = f"/uploads/proofs/{now.strftime('%Y-%m-%d')}/{name}"
    row.proof_reason = reason or result
    row.proof_at = now
    row.status = result
    left = (
        db.query(Order)
        .filter(Order.driver_id == driver.id, Order.status.notin_(DONE_STATUSES), Order.id != row.id)
        .count()
    )
    if left == 0:
        driver.status = "idle"
    db.commit()
    return {"ok": True, "order": _order_out(row), "driver": _driver_out(driver)}


# superadmin API orqali berilmaydi — faqat ishga tushishda mavjud administratordan o‘tkaziladi
ALLOWED_ROLES = {"admin", "dispatcher"}


def _count_admins(db: Session, org_id: int | None) -> int:
    return (
        db.query(User)
        .filter(User.org_id == org_id, User.role.in_(("admin", "superadmin")), User.is_active.is_(True))
        .count()
    )


def _scoped_user(db: Session, actor: User, item_id: int) -> User:
    """Boshqa tashkilot akkauntiga tegib bo‘lmaydi; superadmin akkauntini faqat superadmin o‘zgartiradi."""
    row = users_scope(db, actor).filter(User.id == item_id).first()
    if not row:
        raise HTTPException(404, "Foydalanuvchi topilmadi")
    if row.role == "superadmin" and not is_super(actor):
        raise HTTPException(403, "Superadmin akkauntini o‘zgartirib bo‘lmaydi")
    return row


def _new_user(db: Session, org_id: int, username: str, password: str, full_name: str, role: str) -> User:
    username = (username or "").strip()
    if len(username) < 3:
        raise HTTPException(400, "Login kamida 3 belgi bo‘lsin")
    if len(password or "") < 6:
        raise HTTPException(400, "Parol kamida 6 belgi bo‘lsin")
    if role not in ALLOWED_ROLES:
        raise HTTPException(400, "Rol: admin yoki dispetcher")
    if db.query(User).filter(User.org_id == org_id, User.username == username).first():
        raise HTTPException(400, "Bu tashkilotda bu login band")
    row = User(
        username=username,
        password_hash=hash_password(password),
        full_name=(full_name or "").strip() or username,
        role=role,
        is_active=True,
        org_id=org_id,
        idle_timeout_minutes=30,
        permissions_json=dump_permissions(list(DEFAULT_DISPATCHER_PERMS) if role == "dispatcher" else []),
    )
    db.add(row)
    db.flush()
    return row


def _merge_perms(actor: User, row: User, wanted: list[str]) -> list[str]:
    """Faqat superadmin SUPER_ONLY ruxsatlarni beradi/oladi; boshqalar saqlaganda ular o‘z holicha qoladi."""
    keys = parse_permission_list(wanted)
    if row.role not in ("admin", "superadmin"):
        keys = [k for k in keys if k not in ADMIN_ONLY_KEYS]
    if is_super(actor):
        return keys
    kept = [k for k in parse_permission_list(row.permissions_json) if k in SUPER_ONLY_KEYS]
    return [k for k in keys if k not in SUPER_ONLY_KEYS] + kept


@router.get("/users", response_model=list[UserOut])
def list_users(db: Session = Depends(get_db), admin: User = Depends(require_admin)):
    rows = users_scope(db, admin).options(joinedload(User.org)).order_by(User.org_id.asc(), User.id.asc()).all()
    return [user_payload(u) for u in rows]


def _target_org_id(db: Session, actor: User, org_id: int | None) -> int:
    """Akkaunt qaysi tashkilotga biriktiriladi: tashkilotlarni boshqaruvchi tanlaydi, qolganlar faqat o‘z tashkilotiga."""
    own = org_id_of(actor)
    if not org_id or org_id == own:
        return own
    if not can_cross_org(actor):
        raise HTTPException(403, "Boshqa tashkilotga akkaunt biriktirib bo‘lmaydi")
    if not db.query(Organization.id).filter(Organization.id == org_id).first():
        raise HTTPException(404, "Tashkilot topilmadi")
    return int(org_id)


@router.post("/users", response_model=UserOut)
def create_user(payload: UserCreate, db: Session = Depends(get_db), admin: User = Depends(require_perm("users.manage"))):
    role = payload.role if payload.role in ALLOWED_ROLES else "dispatcher"
    org_id = _target_org_id(db, admin, payload.org_id)
    row = _new_user(db, org_id, payload.username, payload.password, payload.full_name, role)
    row.is_active = payload.is_active
    row.idle_timeout_minutes = max(0, min(1440, int(payload.idle_timeout_minutes or 30)))
    picked = [k for k in parse_permission_list(payload.permissions) if k not in ADMIN_ONLY_KEYS | SUPER_ONLY_KEYS]
    if picked:
        row.permissions_json = dump_permissions(picked)
    db.commit()
    row = db.query(User).options(joinedload(User.org)).filter(User.id == row.id).first()
    return user_payload(row)


@router.put("/users/{item_id}", response_model=UserOut)
def update_user(item_id: int, payload: UserUpdate, db: Session = Depends(get_db), admin: User = Depends(require_perm("users.manage"))):
    row = _scoped_user(db, admin, item_id)
    if payload.org_id is not None and payload.org_id != row.org_id:
        target = _target_org_id(db, admin, payload.org_id)
        if row.role == "superadmin":
            raise HTTPException(400, "Superadmin tashkilotini o‘zgartirib bo‘lmaydi")
        if row.id == admin.id:
            raise HTTPException(400, "O‘z akkauntingizni boshqa tashkilotga o‘tkazib bo‘lmaydi")
        if row.role == "admin" and row.is_active and _count_admins(db, row.org_id) <= 1:
            raise HTTPException(400, "Tashkilotdagi oxirgi adminni boshqa tashkilotga o‘tkazib bo‘lmaydi")
        row.org_id = target
        db.query(SessionToken).filter(SessionToken.user_id == row.id).delete()
    if payload.username is not None and payload.username.strip() != row.username:
        username = payload.username.strip()
        if len(username) < 3:
            raise HTTPException(400, "Login kamida 3 belgi bo‘lsin")
        row.username = username
    if payload.org_id is not None or payload.username is not None:
        taken = db.query(User).filter(User.org_id == row.org_id, User.username == row.username, User.id != row.id).first()
        if taken:
            raise HTTPException(400, "Bu tashkilotda bu login band")
    if payload.full_name is not None:
        row.full_name = payload.full_name.strip() or row.full_name
    if payload.password:
        if len(payload.password) < 6:
            raise HTTPException(400, "Parol kamida 6 belgi bo‘lsin")
        row.password_hash = hash_password(payload.password)
    if payload.role is not None and payload.role != row.role:
        if row.role == "superadmin" or payload.role not in ALLOWED_ROLES:
            raise HTTPException(400, "Noto‘g‘ri rol")
        if row.role == "admin" and _count_admins(db, row.org_id) <= 1:
            raise HTTPException(400, "Tashkilotdagi oxirgi admin rolini o‘zgartirib bo‘lmaydi")
        row.role = payload.role
    if payload.is_active is not None:
        if row.id == admin.id and not payload.is_active:
            raise HTTPException(400, "O‘z akkauntingizni o‘chirib bo‘lmaydi")
        if row.role in ("admin", "superadmin") and row.is_active and not payload.is_active and _count_admins(db, row.org_id) <= 1:
            raise HTTPException(400, "Tashkilotdagi oxirgi adminni o‘chirib bo‘lmaydi")
        row.is_active = payload.is_active
        if not payload.is_active:
            db.query(SessionToken).filter(SessionToken.user_id == row.id).delete()
    if payload.idle_timeout_minutes is not None:
        row.idle_timeout_minutes = max(0, min(1440, int(payload.idle_timeout_minutes)))
    if payload.permissions is not None:
        row.permissions_json = dump_permissions(_merge_perms(admin, row, payload.permissions))
    db.commit()
    row = db.query(User).options(joinedload(User.org)).filter(User.id == item_id).first()
    return user_payload(row)


@router.delete("/users/{item_id}")
def delete_user(item_id: int, db: Session = Depends(get_db), admin: User = Depends(require_admin)):
    row = _scoped_user(db, admin, item_id)
    if row.id == admin.id:
        raise HTTPException(400, "O‘z akkauntingizni o‘chirib bo‘lmaydi")
    if row.role in ("admin", "superadmin") and row.is_active and _count_admins(db, row.org_id) <= 1:
        raise HTTPException(400, "Tashkilotdagi oxirgi adminni o‘chirib bo‘lmaydi")
    db.query(SessionToken).filter(SessionToken.user_id == item_id).delete()
    db.delete(row)
    db.commit()
    return {"ok": True}


@router.get("/permissions")
def list_permissions(admin: User = Depends(require_admin)):
    return {"permissions": catalog_for(admin), "super_only": sorted(SUPER_ONLY_KEYS) if is_super(admin) else []}


@router.put("/users/{item_id}/permissions", response_model=UserOut)
def set_user_permissions(
    item_id: int,
    payload: UserPermissionsIn,
    db: Session = Depends(get_db),
    admin: User = Depends(require_perm("perms.manage")),
):
    row = _scoped_user(db, admin, item_id)
    row.permissions_json = dump_permissions(_merge_perms(admin, row, payload.permissions))
    db.commit()
    row = db.query(User).options(joinedload(User.org)).filter(User.id == item_id).first()
    return user_payload(row)


def _org_out(db: Session, org: Organization, actor: User) -> OrgOut:
    roles = dict(
        db.query(User.role, func.count(User.id)).filter(User.org_id == org.id).group_by(User.role).all()
    )
    return OrgOut(
        id=org.id,
        name=org.name,
        code=org.code or "",
        is_active=org.is_active,
        address=org.address or "",
        lat=org.lat,
        lng=org.lng,
        user_count=sum(roles.values()),
        admin_count=roles.get("admin", 0) + roles.get("superadmin", 0),
        dispatcher_count=roles.get("dispatcher", 0),
        driver_count=db.query(Driver).filter(Driver.org_id == org.id).count(),
        is_own=org.id == actor.org_id,
        created_at=org.created_at.isoformat() if org.created_at else None,
    )


def _set_org_office(org: Organization, address: str | None, lat: float | None, lng: float | None) -> None:
    if address is not None:
        org.address = address.strip()[:300]
    if lat is None and lng is None:
        return
    if lat is None or lng is None or not (-90 <= lat <= 90 and -180 <= lng <= 180):
        raise HTTPException(400, "Ofis joylashuvi noto‘g‘ri: xaritadan nuqtani tanlang")
    org.lat = round(float(lat), 6)
    org.lng = round(float(lng), 6)


def _org_or_404(db: Session, item_id: int) -> Organization:
    org = db.query(Organization).filter(Organization.id == item_id).first()
    if not org:
        raise HTTPException(404, "Tashkilot topilmadi")
    return org


@router.get("/orgs", response_model=list[OrgOut])
def list_orgs(db: Session = Depends(get_db), actor: User = Depends(require_perm("orgs.manage"))):
    rows = db.query(Organization).order_by(Organization.id.asc()).all()
    return [_org_out(db, org, actor) for org in rows]


@router.post("/orgs", response_model=OrgOut)
def create_org(payload: OrgIn, db: Session = Depends(get_db), actor: User = Depends(require_perm("orgs.manage"))):
    name = payload.name.strip()
    if len(name) < 2:
        raise HTTPException(400, "Tashkilot nomi kamida 2 belgi bo‘lsin")
    if db.query(Organization).filter(func.lower(Organization.name) == name.lower()).first():
        raise HTTPException(400, "Bu nomdagi tashkilot bor")
    org = Organization(name=name[:160], code=new_org_code(db), is_active=True)
    _set_org_office(org, payload.address, payload.lat, payload.lng)
    db.add(org)
    db.flush()
    if payload.admin_username.strip():
        _new_user(db, org.id, payload.admin_username, payload.admin_password, payload.admin_full_name, "admin")
    ensure_org_templates(db, org.id)
    db.commit()
    return _org_out(db, org, actor)


@router.put("/orgs/{item_id}", response_model=OrgOut)
def update_org(item_id: int, payload: OrgUpdate, db: Session = Depends(get_db), actor: User = Depends(require_perm("orgs.manage"))):
    org = _org_or_404(db, item_id)
    if payload.name is not None:
        name = payload.name.strip()
        if len(name) < 2:
            raise HTTPException(400, "Tashkilot nomi kamida 2 belgi bo‘lsin")
        clash = db.query(Organization).filter(func.lower(Organization.name) == name.lower(), Organization.id != org.id).first()
        if clash:
            raise HTTPException(400, "Bu nomdagi tashkilot bor")
        org.name = name[:160]
    _set_org_office(org, payload.address, payload.lat, payload.lng)
    if payload.is_active is not None and payload.is_active != org.is_active:
        if org.id == actor.org_id:
            raise HTTPException(400, "O‘z tashkilotingizni faolsizlantirib bo‘lmaydi")
        if db.query(User).filter(User.org_id == org.id, User.role == "superadmin").first():
            raise HTTPException(400, "Superadmin tashkilotini faolsizlantirib bo‘lmaydi")
        org.is_active = payload.is_active
        if not org.is_active:
            ids = [u.id for u in db.query(User.id).filter(User.org_id == org.id).all()]
            if ids:
                db.query(SessionToken).filter(SessionToken.user_id.in_(ids)).delete(synchronize_session=False)
    db.commit()
    return _org_out(db, org, actor)


@router.post("/orgs/{item_id}/code", response_model=OrgOut)
def regenerate_org_code(item_id: int, db: Session = Depends(get_db), actor: User = Depends(require_perm("orgs.manage"))):
    org = _org_or_404(db, item_id)
    org.code = new_org_code(db)
    db.commit()
    return _org_out(db, org, actor)


@router.get("/orgs/{item_id}/users", response_model=list[UserOut])
def list_org_users(item_id: int, db: Session = Depends(get_db), _: User = Depends(require_perm("orgs.manage"))):
    org = _org_or_404(db, item_id)
    rows = db.query(User).options(joinedload(User.org)).filter(User.org_id == org.id).order_by(User.id.asc()).all()
    return [user_payload(u) for u in rows]


@router.post("/orgs/{item_id}/users", response_model=UserOut)
def create_org_user(item_id: int, payload: OrgUserIn, db: Session = Depends(get_db), _: User = Depends(require_perm("orgs.manage"))):
    org = _org_or_404(db, item_id)
    row = _new_user(db, org.id, payload.username, payload.password, payload.full_name, payload.role)
    db.commit()
    row = db.query(User).options(joinedload(User.org)).filter(User.id == row.id).first()
    return user_payload(row)


@router.put("/orgs/{item_id}/users/{user_id}", response_model=UserOut)
def update_org_user(
    item_id: int,
    user_id: int,
    payload: OrgUserUpdate,
    db: Session = Depends(get_db),
    actor: User = Depends(require_perm("orgs.manage")),
):
    org = _org_or_404(db, item_id)
    row = db.query(User).filter(User.id == user_id, User.org_id == org.id).first()
    if not row:
        raise HTTPException(404, "Foydalanuvchi topilmadi")
    if row.role == "superadmin" and not is_super(actor):
        raise HTTPException(403, "Superadmin akkauntini o‘zgartirib bo‘lmaydi")
    if payload.password:
        if len(payload.password) < 6:
            raise HTTPException(400, "Parol kamida 6 belgi bo‘lsin")
        row.password_hash = hash_password(payload.password)
    if payload.is_active is not None and payload.is_active != row.is_active:
        if row.id == actor.id:
            raise HTTPException(400, "O‘z akkauntingizni o‘chirib bo‘lmaydi")
        if not payload.is_active and row.role in ("admin", "superadmin") and _count_admins(db, org.id) <= 1:
            raise HTTPException(400, "Tashkilotdagi oxirgi adminni o‘chirib bo‘lmaydi")
        row.is_active = payload.is_active
        if not payload.is_active:
            db.query(SessionToken).filter(SessionToken.user_id == row.id).delete()
    db.commit()
    row = db.query(User).options(joinedload(User.org)).filter(User.id == row.id).first()
    return user_payload(row)


@router.get("/geo/search")
def geo_search(q: str = Query("", max_length=200), _: User = Depends(get_current_user)):
    text = q.strip()
    if len(text) < 3:
        return []
    return search_geocode(text)


@router.get("/geo/reverse")
def geo_reverse(lat: float, lng: float, _: User = Depends(get_current_user)):
    return {"address": reverse_geocode(lat, lng)}


@router.get("/dashboard/stats")
def stats(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    oid = org_id_of(user)
    return {
        "orders": db.query(Order).filter(Order.org_id == oid).count(),
        "in_transit": db.query(Order).filter(Order.org_id == oid, Order.status == "in_transit").count(),
        "drivers": db.query(Driver).filter(Driver.org_id == oid, Driver.is_active.is_(True)).count(),
        "clients": db.query(Client).filter(Client.org_id == oid).count(),
        "agents": db.query(Agent).filter(Agent.org_id == oid, Agent.is_active.is_(True)).count(),
        "pending_templates": db.query(ImportTemplate).filter(ImportTemplate.org_id == oid, ImportTemplate.status == "pending").count(),
    }


@router.get("/tracking/live")
def live_tracking(db: Session = Depends(get_db), user: User = Depends(require_perm("tracking.live"))):
    return tracking_payload(db, org_id_of(user))


@router.get("/clients", response_model=list[ClientOut])
def list_clients(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    return [_client_out(c) for c in q_org(db, Client, user).order_by(Client.id.desc()).all()]


@router.post("/clients", response_model=ClientOut)
def create_client(payload: ClientIn, db: Session = Depends(get_db), user: User = Depends(require_perm("orders.create"))):
    data = payload.model_dump()
    data["phone"] = format_uz_phone(data.get("phone") or "")
    data["org_id"] = org_id_of(user)
    row = Client(**data)
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


@router.put("/clients/{item_id}", response_model=ClientOut)
def update_client(item_id: int, payload: ClientIn, db: Session = Depends(get_db), user: User = Depends(require_perm("orders.create"))):
    row = get_org_row(db, Client, item_id, user, "Mijoz topilmadi")
    data = payload.model_dump()
    data["phone"] = format_uz_phone(data.get("phone") or "")
    for k, v in data.items():
        setattr(row, k, v)
    db.commit()
    db.refresh(row)
    return row


@router.delete("/clients/{item_id}")
def delete_client(item_id: int, db: Session = Depends(get_db), user: User = Depends(require_perm("orders.delete"))):
    row = get_org_row(db, Client, item_id, user, "Mijoz topilmadi")
    db.delete(row)
    db.commit()
    return {"ok": True}


@router.get("/agents", response_model=list[AgentOut])
def list_agents(db: Session = Depends(get_db), user: User = Depends(require_perm("agents.view"))):
    rows = q_org(db, Agent, user).options(joinedload(Agent.drivers)).order_by(Agent.code.asc(), Agent.id.asc()).all()
    return [_agent_out(a) for a in rows]


@router.post("/agents", response_model=AgentOut)
def create_agent(payload: AgentIn, db: Session = Depends(get_db), user: User = Depends(require_perm("agents.manage"))):
    row = Agent(**_prepare_agent_payload(db, payload, org_id_of(user), user))
    db.add(row)
    db.commit()
    db.refresh(row)
    row = q_org(db, Agent, user).options(joinedload(Agent.drivers)).filter(Agent.id == row.id).first()
    return _agent_out(row)


@router.put("/agents/{item_id}", response_model=AgentOut)
def update_agent(item_id: int, payload: AgentIn, db: Session = Depends(get_db), user: User = Depends(require_perm("agents.manage"))):
    row = get_org_row(db, Agent, item_id, user, "Agent topilmadi")
    for k, v in _prepare_agent_payload(db, payload, org_id_of(user), user, existing=row).items():
        setattr(row, k, v)
    db.commit()
    row = q_org(db, Agent, user).options(joinedload(Agent.drivers)).filter(Agent.id == item_id).first()
    return _agent_out(row)


@router.put("/agents/{item_id}/code", response_model=AgentOut)
def set_agent_code(item_id: int, payload: AgentCodeIn, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    if not (has_perm(user, "agents.manage") or has_perm(user, "agents.code.set")):
        raise HTTPException(403, "Bu amal uchun ruxsat yo‘q")
    code = normalize_agent_code(payload.code)
    if not code:
        raise HTTPException(400, "Kod 01–99 oralig‘ida bo‘lsin")
    oid = org_id_of(user)
    row = get_org_row(db, Agent, item_id, user, "Agent topilmadi")
    if (row.code or "") == code:
        if user.role not in ("admin", "superadmin") and not row.code_locked:
            row.code_locked = True
            db.commit()
        row = q_org(db, Agent, user).options(joinedload(Agent.drivers)).filter(Agent.id == item_id).first()
        return _agent_out(row)
    if not can_write_agent_code(user, row):
        raise HTTPException(403, "Kodni faqat administrator o‘zgartira oladi")
    other = q_org(db, Agent, user).filter(Agent.code == code, Agent.id != item_id).first()
    old = row.code or ""
    if other:
        if user.role not in ("admin", "superadmin"):
            raise HTTPException(400, f"Agent kodi {code} band")
        other.code = ""
        db.flush()
        row.code = code
        row.code_locked = True
        db.flush()
        used = {
            normalize_agent_code(a.code)
            for a in db.query(Agent).filter(Agent.org_id == oid).all()
            if a.id != other.id and normalize_agent_code(a.code)
        }
        other.code = old if old and old not in used else next_agent_code(used)
    else:
        row.code = code
        row.code_locked = True
    db.commit()
    row = q_org(db, Agent, user).options(joinedload(Agent.drivers)).filter(Agent.id == item_id).first()
    return _agent_out(row)


@router.delete("/agents/{item_id}")
def delete_agent(item_id: int, db: Session = Depends(get_db), user: User = Depends(require_perm("agents.manage"))):
    row = get_org_row(db, Agent, item_id, user, "Agent topilmadi")
    db.query(Driver).filter(Driver.org_id == org_id_of(user), Driver.agent_id == item_id).update({Driver.agent_id: None})
    db.delete(row)
    db.commit()
    return {"ok": True}


@router.get("/warehouses", response_model=list[WarehouseOut])
def list_warehouses(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    return [_warehouse_out(w) for w in q_org(db, Warehouse, user).order_by(Warehouse.is_default.desc(), Warehouse.id.asc()).all()]


@router.post("/warehouses", response_model=WarehouseOut)
def create_warehouse(payload: WarehouseIn, db: Session = Depends(get_db), user: User = Depends(require_perm("warehouses.manage"))):
    _check_wh_gps(payload.lat, payload.lng)
    oid = org_id_of(user)
    name = payload.name.strip()
    if not name:
        raise HTTPException(400, "Sklad nomi majburiy")
    first = db.query(Warehouse).filter(Warehouse.org_id == oid).count() == 0
    if payload.is_default or first:
        _set_default_warehouse(db, oid)
    row = Warehouse(
        org_id=oid,
        name=name[:160],
        address=(payload.address or "").strip()[:500],
        lat=float(payload.lat),
        lng=float(payload.lng),
        is_default=bool(payload.is_default or first),
        is_active=bool(payload.is_active),
    )
    db.add(row)
    db.flush()
    for order in db.query(Order).filter(Order.org_id == oid, Order.status.notin_(DONE_STATUSES)).all():
        if not order.warehouse_id:
            apply_warehouse(order, pick_warehouse([row], [order], order.pickup_address) or row)
    resequence_org(db, oid)
    db.commit()
    db.refresh(row)
    return _warehouse_out(row)


@router.put("/warehouses/{item_id}", response_model=WarehouseOut)
def update_warehouse(item_id: int, payload: WarehouseIn, db: Session = Depends(get_db), user: User = Depends(require_perm("warehouses.manage"))):
    row = get_org_row(db, Warehouse, item_id, user, "Sklad topilmadi")
    _check_wh_gps(payload.lat, payload.lng)
    name = payload.name.strip()
    if not name:
        raise HTTPException(400, "Sklad nomi majburiy")
    oid = org_id_of(user)
    if payload.is_default:
        _set_default_warehouse(db, oid, row.id)
    row.name = name[:160]
    row.address = (payload.address or "").strip()[:500]
    row.lat = float(payload.lat)
    row.lng = float(payload.lng)
    row.is_default = bool(payload.is_default)
    row.is_active = bool(payload.is_active)
    if not row.is_default and not db.query(Warehouse).filter(Warehouse.org_id == oid, Warehouse.is_default.is_(True), Warehouse.id != row.id).first():
        row.is_default = True
    for order in db.query(Order).filter(Order.org_id == oid, Order.warehouse_id == row.id).all():
        apply_warehouse(order, row)
    resequence_org(db, oid)
    db.commit()
    db.refresh(row)
    return _warehouse_out(row)


@router.delete("/warehouses/{item_id}")
def delete_warehouse(item_id: int, db: Session = Depends(get_db), user: User = Depends(require_perm("warehouses.manage"))):
    row = get_org_row(db, Warehouse, item_id, user, "Sklad topilmadi")
    oid = org_id_of(user)
    was_default = bool(row.is_default)
    db.query(Order).filter(Order.org_id == oid, Order.warehouse_id == row.id).update({Order.warehouse_id: None}, synchronize_session=False)
    db.delete(row)
    db.flush()
    if was_default:
        nxt = db.query(Warehouse).filter(Warehouse.org_id == oid).order_by(Warehouse.id.asc()).first()
        if nxt:
            nxt.is_default = True
    resequence_org(db, oid)
    db.commit()
    return {"ok": True}


@router.get("/drivers", response_model=list[DriverOut])
def list_drivers(db: Session = Depends(get_db), user: User = Depends(require_perm("drivers.view"))):
    return [_driver_out(d) for d in q_org(db, Driver, user).options(joinedload(Driver.agent)).order_by(Driver.id.desc()).all()]


@router.post("/drivers", response_model=DriverAccessOut)
def create_driver(payload: DriverIn, db: Session = Depends(get_db), user: User = Depends(require_perm("drivers.manage"))):
    data = payload.model_dump()
    data["phone"] = format_uz_phone(data.get("phone") or "")
    data["org_id"] = org_id_of(user)
    if data.get("agent_id"):
        get_org_row(db, Agent, data["agent_id"], user, "Agent topilmadi")
    row = Driver(**data)
    db.add(row)
    db.flush()
    info = issue_driver_credentials(db, row, reset_password=True, reset_qr=True)
    db.commit()
    db.refresh(row)
    return DriverAccessOut(**info)


@router.get("/drivers/{item_id}/access", response_model=DriverAccessOut)
def get_driver_access(item_id: int, db: Session = Depends(get_db), user: User = Depends(require_perm("drivers.access"))):
    row = get_org_row(db, Driver, item_id, user, "Haydovchi topilmadi")
    info = issue_driver_credentials(db, row, reset_password=False, reset_qr=False)
    db.commit()
    return DriverAccessOut(**info)


@router.post("/drivers/{item_id}/access", response_model=DriverAccessOut)
def reset_driver_access(
    item_id: int,
    payload: DriverAccessIn,
    db: Session = Depends(get_db),
    user: User = Depends(require_perm("drivers.access")),
):
    row = get_org_row(db, Driver, item_id, user, "Haydovchi topilmadi")
    info = issue_driver_credentials(
        db,
        row,
        reset_password=payload.reset_password,
        reset_qr=payload.reset_qr,
    )
    db.commit()
    return DriverAccessOut(**info)


@router.post("/drivers/import")
async def import_drivers_excel(
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    user: User = Depends(require_perm("drivers.manage")),
):
    raw = await file.read()
    if not raw:
        raise HTTPException(400, "Fayl bo‘sh")
    try:
        records = read_driver_records(raw, file.filename or "drivers.xlsx", 1)
    except Exception as exc:
        raise HTTPException(400, f"Fayl o‘qilmadi: {exc}") from exc
    if not records:
        raise HTTPException(
            400,
            "Jadvalda ma’lumot yo‘q. 1-qator sarlavha bo‘lsin: Ism, Telefon, Davlat raqami, Transport turi, Holat, Agent. 2-qatordan haydovchilarni yozing.",
        )
    result = _import_drivers(db, records, DRIVER_MAPPING, org_id_of(user))
    result["template"] = "Haydovchilar Excel"
    return result


@router.put("/drivers/{item_id}", response_model=DriverOut)
def update_driver(item_id: int, payload: DriverIn, db: Session = Depends(get_db), user: User = Depends(require_perm("drivers.manage"))):
    row = get_org_row(db, Driver, item_id, user, "Haydovchi topilmadi")
    data = payload.model_dump()
    data["phone"] = format_uz_phone(data.get("phone") or "")
    data.pop("org_id", None)
    if data.get("agent_id"):
        get_org_row(db, Agent, data["agent_id"], user, "Agent topilmadi")
    for k, v in data.items():
        setattr(row, k, v)
    db.commit()
    row = q_org(db, Driver, user).options(joinedload(Driver.agent)).filter(Driver.id == item_id).first()
    return _driver_out(row)


@router.put("/drivers/{item_id}/agent", response_model=DriverOut)
def set_driver_agent(item_id: int, payload: DriverAgentIn, db: Session = Depends(get_db), user: User = Depends(require_perm("drivers.manage"))):
    row = get_org_row(db, Driver, item_id, user, "Haydovchi topilmadi")
    if payload.agent_id:
        agent = get_org_row(db, Agent, payload.agent_id, user, "Agent topilmadi")
        row.agent_id = agent.id
    else:
        row.agent_id = None
    db.commit()
    row = q_org(db, Driver, user).options(joinedload(Driver.agent)).filter(Driver.id == item_id).first()
    return _driver_out(row)


@router.delete("/drivers/all")
def delete_all_drivers(db: Session = Depends(get_db), user: User = Depends(require_perm("drivers.manage"))):
    oid = org_id_of(user)
    ids = [d.id for d in db.query(Driver.id).filter(Driver.org_id == oid).all()]
    db.query(Order).filter(Order.org_id == oid).update({Order.driver_id: None})
    if ids:
        db.query(SessionToken).filter(SessionToken.driver_id.in_(ids)).delete(synchronize_session=False)
    n = db.query(Driver).filter(Driver.org_id == oid).delete(synchronize_session=False)
    db.commit()
    return {"ok": True, "deleted": n}


@router.delete("/drivers/{item_id}")
def delete_driver(item_id: int, db: Session = Depends(get_db), user: User = Depends(require_perm("drivers.manage"))):
    row = get_org_row(db, Driver, item_id, user, "Haydovchi topilmadi")
    db.query(Order).filter(Order.org_id == org_id_of(user), Order.driver_id == item_id).update({Order.driver_id: None})
    db.query(SessionToken).filter(SessionToken.driver_id == item_id).delete(synchronize_session=False)
    db.delete(row)
    db.commit()
    return {"ok": True}


@router.delete("/orders/all")
def delete_all_orders(db: Session = Depends(get_db), user: User = Depends(require_perm("orders.delete"))):
    n = q_org(db, Order, user).delete(synchronize_session=False)
    db.commit()
    return {"ok": True, "deleted": n}


def _import_orders(db: Session, records: list[dict], mapping: dict[str, str], org_id: int) -> dict:
    clients_by_name = {c.name: c for c in db.query(Client).filter(Client.org_id == org_id).all()}
    created = 0
    skipped = 0
    existing = {"faol": 0, "done": 0, "incoming": 0}
    extra_keys = [
        k
        for k in mapping.keys()
        if k
        not in {
            "code",
            "client_name",
            "pickup_address",
            "dropoff_address",
            "cargo",
            "weight_kg",
            "amount",
            "route_code",
            "dropoff_lat",
            "dropoff_lng",
            "sales_rep",
            "agent_code",
            "driver_name",
            "vehicle_plate",
            "delivery_date",
        }
    ]
    new_orders: list[Order] = []
    touched: list[Order] = []
    seen: set[str] = set()
    existing_rows = {o.code: o for o in db.query(Order).filter(Order.org_id == org_id).all()}
    agents = db.query(Agent).filter(Agent.org_id == org_id).all()
    warehouses = org_warehouses(db, org_id)
    incoming_day = local_tomorrow()
    for rec in records:
        code = mapped_value(rec, mapping, "code") or f"IMP-{int(datetime.now(timezone.utc).timestamp())}-{created}"
        code = code[:80]
        extras = {key: mapped_value(rec, mapping, key) for key in extra_keys if mapped_value(rec, mapping, key)}
        driver_name = mapped_value(rec, mapping, "driver_name").strip()[:160]
        plate = mapped_value(rec, mapping, "vehicle_plate").strip()[:32]
        if driver_name:
            extras["driver_name"] = driver_name
        if plate and re.search(r"\d", plate):
            extras["vehicle_plate"] = plate
        sales_rep = mapped_value(rec, mapping, "sales_rep")[:160]
        agent_raw = mapped_value(rec, mapping, "agent_code")
        agent = resolve_agent(agents, code=agent_raw, name=sales_rep)
        agent_code = (agent.code if agent else normalize_agent_code(agent_raw) or normalize_agent_code(sales_rep)) or ""
        if code in seen:
            skipped += 1
            continue
        seen.add(code)
        row = existing_rows.get(code)
        if row:
            skipped += 1
            try:
                old = json.loads(row.extra_json or "{}")
                if not isinstance(old, dict):
                    old = {}
            except Exception:
                old = {}
            old.update(extras)
            row.extra_json = json.dumps(old, ensure_ascii=False)
            if sales_rep:
                row.sales_rep = sales_rep
            if agent_code:
                row.agent_code = agent_code
            # Kiruvchidagi (haydovchisiz) zayavkalarni ertangi kungа yangilaymiz
            if row.status in DONE_STATUSES:
                existing["done"] += 1
            elif row.driver_id:
                existing["faol"] += 1
            else:
                existing["incoming"] += 1
                row.delivery_date = incoming_day
                row.status = "new"
            touched.append(row)
            continue
        client_name = mapped_value(rec, mapping, "client_name")
        client = clients_by_name.get(client_name) if client_name else None
        if client_name and not client:
            client = Client(
                org_id=org_id,
                name=client_name,
                company=mapped_value(rec, mapping, "client_code") or "",
                address=mapped_value(rec, mapping, "dropoff_address") or "",
            )
            db.add(client)
            db.flush()
            clients_by_name[client_name] = client
        lat = to_float(mapped_value(rec, mapping, "dropoff_lat"), 0)
        lng = to_float(mapped_value(rec, mapping, "dropoff_lng"), 0)
        new_orders.append(
            Order(
                org_id=org_id,
                code=code,
                client_id=client.id if client else None,
                pickup_address=mapped_value(rec, mapping, "pickup_address") or "Noma'lum",
                dropoff_address=mapped_value(rec, mapping, "dropoff_address") or client_name or "Noma'lum",
                cargo=mapped_value(rec, mapping, "cargo"),
                weight_kg=to_float(mapped_value(rec, mapping, "weight_kg")),
                amount=to_float(mapped_value(rec, mapping, "amount")),
                route_code=mapped_value(rec, mapping, "route_code")[:80],
                sales_rep=sales_rep,
                agent_code=agent_code,
                delivery_date=incoming_day,
                dropoff_lat=lat,
                dropoff_lng=lng,
                extra_json=json.dumps(extras, ensure_ascii=False),
                status="new",
                driver_id=None,
            )
        )
        created += 1
    assigned = 0
    unmatched = 0
    errors: list[str] = []
    agents_sync = {"created": 0, "updated": 0}
    drivers_sync = {"created": 0, "linked": 0, "assigned": 0}
    batch = list(new_orders) + touched
    if new_orders:
        db.add_all(new_orders)
        db.flush()
    if batch:
        for order in batch:
            apply_warehouse(order, pick_warehouse(warehouses, [order], order.pickup_address))
        agents_sync = sync_agents_from_orders(db, batch, org_id)
        # Haydovchilarni ochamiz, lekin zayavkalarni Faolga biriktirmaymiz — Kiruvchida qoladi
        drivers_sync = ensure_drivers_from_orders(db, batch, org_id, assign=False)
        assigned = 0
        unmatched = sum(1 for o in batch if not o.driver_id)
        seen_labels: set[str] = set()
        for order in batch:
            if resolve_order_agent(order, agents):
                continue
            label = (order.sales_rep or order.agent_code or "").strip()
            if label in seen_labels:
                continue
            seen_labels.add(label)
            errors.append(f"«{label}» — bunaqa agent mavjud emas, agentni qo‘shing")
    db.commit()
    return {
        "ok": True,
        "created": created,
        "skipped": skipped,
        "assigned": assigned,
        "unmatched": unmatched,
        "delivery_date": incoming_day,
        "agents_created": agents_sync.get("created", 0),
        "drivers_created": drivers_sync.get("created", 0),
        "errors": errors[:20],
        "rows": len(records),
        "existing_faol": existing["faol"],
        "existing_done": existing["done"],
        "existing_incoming": existing["incoming"],
    }


@router.post("/orders/import")
async def import_orders_file(
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    user: User = Depends(require_perm("orders.import")),
):
    raw = await file.read()
    if not raw:
        raise HTTPException(400, "Fayl bo‘sh")
    mappings = [RELOG_MAPPING]
    for tpl in (
        q_org(db, ImportTemplate, user)
        .filter(ImportTemplate.status == "approved", ImportTemplate.entity == "orders")
        .all()
    ):
        _sheet, _row, mapping = parse_template_config(tpl.mapping_json)
        if mapping:
            mappings.append(mapping)
    try:
        records, mapping, meta = auto_read_order_records(raw, file.filename or "", mappings)
    except Exception as exc:
        raise HTTPException(400, f"Fayl o‘qilmadi: {exc}") from exc
    if meta.get("score", 0) < 3 or not records:
        raise HTTPException(
            400,
            "Fayl ustunlari mos kelmadi. RELOG Excel yoki tasdiqlangan shablon formatida yuklang.",
        )
    result = _import_orders(db, records, mapping, org_id_of(user))
    result["template"] = "avto"
    result["sheet"] = meta.get("sheet")
    return result


@router.get("/orders", response_model=list[OrderOut])
def list_orders(db: Session = Depends(get_db), user: User = Depends(require_perm("orders.view"))):
    rows = (
        q_org(db, Order, user)
        .options(joinedload(Order.client), joinedload(Order.driver), joinedload(Order.warehouse))
        .order_by(Order.id.desc())
        .all()
    )
    # Biriktirish/rejalashtirish marshrutni o‘zi tartiblaydi; bu yerda faqat tartib raqamisizlarini to‘ldiramiz
    need = {
        o.driver_id
        for o in rows
        if o.driver_id and o.status not in DONE_STATUSES and not (getattr(o, "stop_no", 0) or 0)
    }
    if need:
        sequence_drivers(db, need, org_id_of(user))
        db.commit()
    return [_order_out(o) for o in rows]


@router.post("/orders", response_model=OrderOut)
def create_order(payload: OrderIn, db: Session = Depends(get_db), user: User = Depends(require_perm("orders.create"))):
    oid = org_id_of(user)
    n = db.query(Order).filter(Order.org_id == oid).count() + 1006
    data = payload.model_dump()
    data["org_id"] = oid
    row = Order(code=f"ORD-{n}", **data)
    db.add(row)
    db.flush()
    _bind_order_warehouse(db, row, oid)
    if row.driver_id:
        sequence_drivers(db, {row.driver_id}, oid)
    db.commit()
    db.refresh(row)
    return _order_out(row)


@router.put("/orders/{item_id}", response_model=OrderOut)
def update_order(item_id: int, payload: OrderIn, db: Session = Depends(get_db), user: User = Depends(require_perm("orders.create"))):
    row = get_org_row(db, Order, item_id, user, "Buyurtma topilmadi")
    for k, v in payload.model_dump().items():
        setattr(row, k, v)
    _bind_order_warehouse(db, row, org_id_of(user), row.pickup_address)
    if row.driver_id:
        sequence_drivers(db, {row.driver_id}, org_id_of(user))
    db.commit()
    db.refresh(row)
    return _order_out(row)


@router.delete("/orders/{item_id}")
def delete_order(item_id: int, db: Session = Depends(get_db), user: User = Depends(require_perm("orders.delete"))):
    row = get_org_row(db, Order, item_id, user, "Buyurtma topilmadi")
    db.delete(row)
    db.commit()
    return {"ok": True}


@router.post("/orders/assign")
def assign_orders(payload: BulkAssignIn, db: Session = Depends(get_db), user: User = Depends(require_perm("orders.assign"))):
    if not payload.ids:
        raise HTTPException(400, "Zayavka tanlanmagan")
    driver = (
        q_org(db, Driver, user)
        .options(joinedload(Driver.agent))
        .filter(Driver.id == payload.driver_id, Driver.is_active.is_(True))
        .first()
    )
    if not driver:
        raise HTTPException(404, "Haydovchi topilmadi")
    today = local_today()
    rows = q_org(db, Order, user).filter(Order.id.in_(payload.ids)).all()
    agents = db.query(Agent).filter(Agent.org_id == org_id_of(user)).all()
    errors = []
    ok_rows = []
    for row in rows:
        agent = resolve_order_agent(row, agents)
        if not agent:
            errors.append(missing_agent_error(row))
            continue
        if not driver.agent_id:
            errors.append(f"{row.code}: haydovchi {driver.name} agentga bog‘lanmagan")
            continue
        if driver.agent_id != agent.id:
            errors.append(f"{row.code}: agent «{agent.name}» haydovchi {driver.name} ga bog‘lanmagan")
            continue
        ok_rows.append(row)
    if not ok_rows:
        raise HTTPException(400, "; ".join(errors[:8]) or "Zayavka biriktirilmadi")
    for row in ok_rows:
        agent = resolve_order_agent(row, agents)
        row.driver_id = driver.id
        if agent and agent.code:
            row.agent_code = agent.code
        if row.status == "new":
            row.status = "assigned"
        # Sanasi o‘tib ketgan kiruvchi zayavka bugungi kunga o‘tkaziladi
        day = str(row.delivery_date or "")[:10]
        if not day or day < today:
            row.delivery_date = today
    if driver.status == "idle":
        driver.status = "assigned"
    sequence_drivers(db, {driver.id}, org_id_of(user))
    db.commit()
    return {
        "ok": True,
        "assigned": len(ok_rows),
        "unmatched": len(errors),
        "errors": errors[:30],
        "driver_id": driver.id,
        "driver_name": driver.name,
        "delivery_date": today,
    }


@router.post("/orders/reassign")
def reassign_orders(payload: BulkAssignIn, db: Session = Depends(get_db), user: User = Depends(require_perm("orders.assign"))):
    """Faol zayavkalarni boshqa haydovchi akkauntiga o'tkazish (agent moslashuvi talab qilinmaydi)."""
    if not payload.ids:
        raise HTTPException(400, "Zayavka tanlanmagan")
    driver = (
        q_org(db, Driver, user)
        .filter(Driver.id == payload.driver_id, Driver.is_active.is_(True))
        .first()
    )
    if not driver:
        raise HTTPException(404, "Haydovchi topilmadi")
    rows = q_org(db, Order, user).filter(Order.id.in_(payload.ids)).all()
    touched = {driver.id}
    moved = 0
    skipped = 0
    for row in rows:
        if row.status in DONE_STATUSES:
            skipped += 1
            continue
        if row.driver_id == driver.id:
            continue
        if row.driver_id:
            touched.add(row.driver_id)
        row.driver_id = driver.id
        row.stop_no = 0
        if row.status == "new":
            row.status = "assigned"
        moved += 1
    if not moved:
        raise HTTPException(400, "O‘tkaziladigan zayavka yo‘q (yetkazilganlar o‘tkazilmaydi)")
    if driver.status == "idle":
        driver.status = "assigned"
    sequence_drivers(db, touched, org_id_of(user))
    db.commit()
    return {"ok": True, "moved": moved, "skipped": skipped, "driver_id": driver.id, "driver_name": driver.name}


@router.post("/orders/rename-route")
def rename_route(payload: RouteRenameIn, db: Session = Depends(get_db), user: User = Depends(require_perm("orders.routes"))):
    old = (payload.route_code or "").strip()
    new = (payload.new_name or "").strip()[:80]
    date = (payload.delivery_date or "").strip()[:10]
    if not new:
        raise HTTPException(400, "Marshrut nomi bo‘sh bo‘lmasin")
    q = q_org(db, Order, user).filter(Order.status.notin_(DONE_STATUSES))
    if old:
        q = q.filter(Order.route_code == old)
    else:
        q = q.filter((Order.route_code == "") | (Order.route_code.is_(None)))
    if date:
        q = q.filter(Order.delivery_date == date)
    if payload.driver_id:
        q = q.filter(Order.driver_id == payload.driver_id)
    rows = q.all()
    if not rows:
        raise HTTPException(404, "Marshrut topilmadi")
    touched = set()
    for row in rows:
        row.route_code = new
        if row.driver_id:
            touched.add(row.driver_id)
    if touched:
        sequence_drivers(db, touched, org_id_of(user))
    db.commit()
    return {"ok": True, "updated": len(rows), "route_code": new}


def _default_plan_name(plan_date: str) -> str:
    months = [
        "yanvar", "fevral", "mart", "aprel", "may", "iyun",
        "iyul", "avgust", "sentabr", "oktabr", "noyabr", "dekabr",
    ]
    raw = (plan_date or "")[:10]
    try:
        y, m, d = raw.split("-")
        return f"{int(d)}-{months[int(m) - 1]} {y}"
    except Exception:
        return raw or local_today()


def _active_plan_stats(db: Session, oid: int | None) -> tuple[int, float]:
    from math import asin, cos, radians, sin, sqrt

    today = local_today()
    q = db.query(Order).filter(
        Order.status.in_(("assigned", "in_transit", "on_route")),
        Order.delivery_date.startswith(today),
    )
    if oid:
        q = q.filter(Order.org_id == oid)
    rows = q.order_by(Order.driver_id.asc(), Order.stop_no.asc(), Order.id.asc()).all()
    by_driver: dict[int | None, list[Order]] = {}
    for row in rows:
        by_driver.setdefault(row.driver_id, []).append(row)

    def dist(a: Order, b: Order) -> float:
        try:
            lat1, lng1 = float(a.dropoff_lat), float(a.dropoff_lng)
            lat2, lng2 = float(b.dropoff_lat), float(b.dropoff_lng)
        except Exception:
            return 0.0
        if not (37 < lat1 < 46 and 55 < lng1 < 76 and 37 < lat2 < 46 and 55 < lng2 < 76):
            return 0.0
        r = 6371.0
        dlat = radians(lat2 - lat1)
        dlng = radians(lng2 - lng1)
        h = sin(dlat / 2) ** 2 + cos(radians(lat1)) * cos(radians(lat2)) * sin(dlng / 2) ** 2
        return 2 * r * asin(min(1.0, sqrt(h)))

    km = 0.0
    for group in by_driver.values():
        pts = [
            o
            for o in group
            if 37 < float(o.dropoff_lat or 0) < 46 and 55 < float(o.dropoff_lng or 0) < 76
        ]
        for i in range(1, len(pts)):
            km += dist(pts[i - 1], pts[i])
    return len(rows), round(km, 1)


@router.get("/day-plan", response_model=DayPlanOut)
def get_day_plan(
    plan_date: str = Query(""),
    db: Session = Depends(get_db),
    user: User = Depends(require_perm("orders.routes")),
):
    oid = org_id_of(user)
    date = (plan_date or "").strip()[:10]
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", date):
        date = local_today()
    row = (
        db.query(DayPlan)
        .filter(DayPlan.org_id == oid, DayPlan.plan_date == date)
        .first()
    )
    count, km = _active_plan_stats(db, oid)
    return DayPlanOut(
        plan_date=date,
        name=(row.name if row and row.name else _default_plan_name(date)),
        count=count,
        km=km,
    )


@router.put("/day-plan", response_model=DayPlanOut)
def save_day_plan(
    payload: DayPlanIn,
    db: Session = Depends(get_db),
    user: User = Depends(require_perm("orders.routes")),
):
    oid = org_id_of(user)
    date = (payload.plan_date or "").strip()[:10]
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", date):
        date = local_today()
    name = (payload.name or "").strip()[:160] or _default_plan_name(date)
    row = (
        db.query(DayPlan)
        .filter(DayPlan.org_id == oid, DayPlan.plan_date == date)
        .first()
    )
    if not row:
        row = DayPlan(org_id=oid, plan_date=date, name=name)
        db.add(row)
    else:
        row.name = name
        row.updated_at = datetime.now(timezone.utc)
    db.commit()
    count, km = _active_plan_stats(db, oid)
    return DayPlanOut(plan_date=date, name=row.name, count=count, km=km)


@router.post("/orders/plan")
def plan_incoming_orders(payload: PlanIn, db: Session = Depends(get_db), user: User = Depends(require_perm("orders.plan"))):
    date = (payload.delivery_date or "").strip()[:10]
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", date):
        raise HTTPException(400, "Yetkazish sanasini tanlang")
    today = local_today()
    if date < today:
        raise HTTPException(400, f"Orqa sana tanlab bo‘lmaydi (eng erta: {today})")
    start = (payload.window_start or "09:00").strip()[:5]
    end = (payload.window_end or "18:00").strip()[:5]
    if not re.fullmatch(r"\d{2}:\d{2}", start) or not re.fullmatch(r"\d{2}:\d{2}", end):
        raise HTTPException(400, "Soat oralig‘i noto‘g‘ri")
    if start >= end:
        raise HTTPException(400, "Tugash vaqti boshlanishdan keyin bo‘lsin")
    try:
        result = plan_orders(
            db,
            order_ids=payload.ids,
            driver_ids=payload.driver_ids,
            delivery_date=date,
            window_start=start,
            window_end=end,
            org_id=org_id_of(user),
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    db.commit()
    return result


@router.post("/orders/bulk-delete")
def bulk_delete_orders(payload: BulkIdsIn, db: Session = Depends(get_db), user: User = Depends(require_perm("orders.delete"))):
    if not payload.ids:
        raise HTTPException(400, "Zayavka tanlanmagan")
    rows = q_org(db, Order, user).filter(Order.id.in_(payload.ids)).all()
    n = len(rows)
    for row in rows:
        db.delete(row)
    db.commit()
    return {"ok": True, "deleted": n}


@router.post("/orders/bulk-date")
def bulk_set_delivery_date(payload: BulkDateIn, db: Session = Depends(get_db), user: User = Depends(require_perm("orders.assign"))):
    """Kiruvchi zayavkalar yetkazish sanasini o‘zgartirish. Orqa sana taqiqlanadi."""
    date = (payload.delivery_date or "").strip()[:10]
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", date):
        raise HTTPException(400, "Yetkazish sanasini tanlang")
    today = local_today()
    if date < today:
        raise HTTPException(400, f"Orqa sana tanlab bo‘lmaydi (eng erta: {today})")
    if not payload.ids:
        raise HTTPException(400, "Zayavka tanlanmagan")
    rows = q_org(db, Order, user).filter(Order.id.in_(payload.ids)).all()
    updated = 0
    skipped = 0
    for row in rows:
        if row.status in DONE_STATUSES or row.driver_id:
            skipped += 1
            continue
        row.delivery_date = date
        updated += 1
    if not updated:
        raise HTTPException(400, "Faqat Kiruvchidagi zayavkalar sanasini o‘zgartirish mumkin")
    db.commit()
    return {"ok": True, "updated": updated, "skipped": skipped, "delivery_date": date}


@router.post("/orders/bulk-status")
def bulk_status(payload: BulkStatusIn, db: Session = Depends(get_db), user: User = Depends(require_perm("orders.assign"))):
    allowed = {"new", "assigned", "in_transit", "delivered"}
    if payload.status not in allowed:
        raise HTTPException(400, "Noto‘g‘ri holat")
    if not payload.ids:
        raise HTTPException(400, "Zayavka tanlanmagan")
    rows = q_org(db, Order, user).filter(Order.id.in_(payload.ids)).all()
    touched = set()
    for row in rows:
        if payload.status == "assigned" and not row.driver_id:
            continue
        if payload.status == "new":
            if row.driver_id:
                touched.add(row.driver_id)
            row.driver_id = None
            row.stop_no = 0
        row.status = payload.status
        if row.driver_id and payload.status != "new":
            touched.add(row.driver_id)
    if touched and payload.status != "new":
        sequence_drivers(db, touched, org_id_of(user))
    db.commit()
    return {"ok": True, "updated": len(rows), "status": payload.status}


@router.get("/templates/fields")
def template_fields(entity: str = Query("orders"), _: User = Depends(get_current_user)):
    return {"fields": fields_for(entity), "entity": entity}


@router.get("/templates/excel")
def download_blank_excel(entity: str = Query("drivers"), _: User = Depends(get_current_user)):
    mapping = DRIVER_MAPPING if entity == "drivers" else {}
    headers = headers_from_mapping(mapping, entity)
    sheet = "Haydovchilar" if entity == "drivers" else "Buyurtmalar"
    filename = "Haydovchilar_shablon.xlsx" if entity == "drivers" else "Buyurtmalar_shablon.xlsx"
    return _excel_file(build_excel_bytes(headers, sheet, None), filename)


@router.get("/templates", response_model=list[TemplateOut])
def list_templates(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    if not (
        has_perm(user, "admin.panel")
        or has_perm(user, "orders.import")
        or has_perm(user, "drivers.manage")
    ):
        raise HTTPException(403, "Bu amal uchun ruxsat yo‘q")
    q = q_org(db, ImportTemplate, user).order_by(ImportTemplate.id.desc())
    if not has_perm(user, "admin.panel"):
        q = q.filter(ImportTemplate.status == "approved")
    return [_template_out(t) for t in q.all()]


@router.post("/templates/inspect")
async def inspect_import_file(file: UploadFile = File(...), _: User = Depends(get_current_user)):
    raw = await file.read()
    try:
        return inspect_table(raw, file.filename or "")
    except Exception as exc:
        raise HTTPException(400, f"Fayl o‘qilmadi: {exc}") from exc


@router.post("/templates", response_model=TemplateOut)
def submit_template(payload: TemplateIn, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    status = "pending"
    if user.role in ("admin", "superadmin"):
        status = payload.status or "approved"
    row = ImportTemplate(
        org_id=org_id_of(user),
        name=payload.name,
        entity=payload.entity,
        description=payload.description,
        mapping_json=build_template_json(payload.sheet, payload.header_row, payload.mapping),
        status=status,
        submitted_by=user.username,
        reviewed_by=user.username if status == "approved" else None,
        review_note="Admin yaratdi" if status == "approved" else "",
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return _template_out(row)


@router.put("/templates/{item_id}", response_model=TemplateOut)
def update_template(
    item_id: int,
    payload: TemplateIn,
    db: Session = Depends(get_db),
    admin: User = Depends(require_admin),
):
    row = get_org_row(db, ImportTemplate, item_id, admin, "Shablon topilmadi")
    row.name = payload.name
    row.entity = payload.entity
    row.description = payload.description
    row.mapping_json = build_template_json(payload.sheet, payload.header_row, payload.mapping)
    if payload.status:
        row.status = payload.status
    row.reviewed_by = admin.username
    db.commit()
    db.refresh(row)
    return _template_out(row)


@router.get("/templates/{item_id}/excel")
def download_template_excel(item_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    row = get_org_row(db, ImportTemplate, item_id, user, "Shablon topilmadi")
    sheet, _header_row, mapping = parse_template_config(row.mapping_json)
    headers = headers_from_mapping(mapping, row.entity)
    filename = f"{row.name}.xlsx".replace("/", "-")
    return _excel_file(build_excel_bytes(headers, str(sheet or "Shablon"), None), filename)


@router.post("/templates/{item_id}/approve", response_model=TemplateOut)
def approve_template(
    item_id: int,
    payload: TemplateReviewIn,
    db: Session = Depends(get_db),
    admin: User = Depends(require_admin),
):
    row = get_org_row(db, ImportTemplate, item_id, admin, "Shablon topilmadi")
    row.status = "approved"
    row.reviewed_by = admin.username
    row.review_note = payload.note or "Tasdiqlandi"
    row.reviewed_at = datetime.now(timezone.utc)
    db.commit()
    db.refresh(row)
    return _template_out(row)


@router.post("/templates/{item_id}/reject", response_model=TemplateOut)
def reject_template(
    item_id: int,
    payload: TemplateReviewIn,
    db: Session = Depends(get_db),
    admin: User = Depends(require_admin),
):
    row = get_org_row(db, ImportTemplate, item_id, admin, "Shablon topilmadi")
    row.status = "rejected"
    row.reviewed_by = admin.username
    row.review_note = payload.note or "Rad etildi"
    row.reviewed_at = datetime.now(timezone.utc)
    db.commit()
    db.refresh(row)
    return _template_out(row)


@router.post("/templates/{item_id}/import")
async def import_with_template(
    item_id: int,
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    user: User = Depends(require_perm("orders.import")),
):
    row = get_org_row(db, ImportTemplate, item_id, user, "Shablon topilmadi")
    if row.status != "approved":
        raise HTTPException(400, "Faqat tasdiqlangan shablon bilan import qilish mumkin")
    sheet, header_row, mapping = parse_template_config(row.mapping_json)
    raw = await file.read()
    try:
        use_sheet = None if row.entity == "drivers" else sheet
        if row.entity == "drivers":
            records = read_driver_records(raw, file.filename or "", header_row)
        else:
            records = read_records(raw, file.filename or "", use_sheet, header_row)
    except Exception as exc:
        raise HTTPException(400, f"Fayl o‘qilmadi: {exc}") from exc
    if row.entity == "drivers":
        result = _import_drivers(db, records, mapping or DRIVER_MAPPING, org_id_of(user))
        result["template"] = row.name
        return result
    if not records:
        try:
            records, mapping, _meta = auto_read_order_records(raw, file.filename or "", [mapping or RELOG_MAPPING, RELOG_MAPPING])
        except Exception as exc:
            raise HTTPException(400, f"Fayl o‘qilmadi: {exc}") from exc
    result = _import_orders(db, records, mapping or RELOG_MAPPING, org_id_of(user))
    result["template"] = row.name
    return result
