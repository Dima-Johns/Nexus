from datetime import date
from typing import Annotated
from urllib.parse import quote

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import Response
from sqlalchemy import func
from sqlalchemy.orm import Session

from .database import get_db
from .dispatch import local_now
from .models import Agent, Client, Driver, Order, Organization, User, Warehouse
from .permissions import has_perm
from .reports import (
    SECTIONS,
    STATUS_LABELS,
    ReportFilter,
    build_full_export,
    build_overview,
    build_report_xlsx,
    fetch_rows,
    order_dict,
)
from .tenancy import can_cross_org, org_id_of, require_perm

router = APIRouter(prefix="/api/reports")

DayParam = Annotated[str, Query(max_length=10, pattern=r"^(\d{4}-\d{2}-\d{2})?$")]
ORDERS_PAGE_MAX = 2000


def _scope_org(user: User, org_id: int | None) -> int | None:
    """Tashkilotlarni boshqaruvchi barcha (None) yoki tanlangan tashkilotni, qolganlar faqat o‘zinikini ko‘radi."""
    if can_cross_org(user):
        return org_id or None
    own = org_id_of(user)
    if org_id and org_id != own:
        raise HTTPException(403, "Boshqa tashkilot hisobotini ko‘rib bo‘lmaydi")
    return own


def report_filter(
    user: Annotated[User, Depends(require_perm("reports.view"))],
    date_from: DayParam = "",
    date_to: DayParam = "",
    org_id: int | None = Query(None, ge=1),
    agent_code: str = Query("", max_length=8),
    driver_id: int | None = Query(None, ge=1),
    warehouse_id: int | None = Query(None, ge=1),
    client_id: int | None = Query(None, ge=1),
    status: str = Query("", max_length=20),
    payment: str = Query("", max_length=80),
    q: str = Query("", max_length=120),
) -> ReportFilter:
    for day in (date_from, date_to):
        if day:
            try:
                date.fromisoformat(day)
            except ValueError:
                raise HTTPException(400, f"Sana noto‘g‘ri: {day}") from None
    if date_from and date_to and date_from > date_to:
        date_from, date_to = date_to, date_from
    if status and status not in STATUS_LABELS:
        raise HTTPException(400, "Noto‘g‘ri holat")
    return ReportFilter(
        org_id=_scope_org(user, org_id),
        date_from=date_from,
        date_to=date_to,
        agent_code=agent_code.strip(),
        driver_id=driver_id,
        warehouse_id=warehouse_id,
        client_id=client_id,
        status=status,
        payment=payment.strip(),
        q=q.replace("\x00", "").strip(),
    )


def _xlsx(content: bytes, filename: str) -> Response:
    return Response(
        content=content,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f"attachment; filename*=UTF-8''{quote(filename)}"},
    )


def _filter_names(db: Session, f: ReportFilter) -> dict[str, str]:
    def own(model, item_id):
        row = db.get(model, item_id)
        return row if row and (not f.org_id or row.org_id == f.org_id) else None

    names: dict[str, str] = {}
    if f.org_id:
        org = db.get(Organization, f.org_id)
        names["org"] = org.name if org else ""
    if f.agent_code:
        q = db.query(Agent.name).filter(Agent.code == f.agent_code)
        if f.org_id:
            q = q.filter(Agent.org_id == f.org_id)
        row = q.first()
        names["agent"] = f"{f.agent_code} · {row[0]}" if row else f.agent_code
    if f.driver_id:
        d = own(Driver, f.driver_id)
        names["driver"] = d.name if d else f"#{f.driver_id}"
    if f.warehouse_id:
        w = own(Warehouse, f.warehouse_id)
        names["warehouse"] = w.name if w else f"#{f.warehouse_id}"
    if f.client_id:
        c = own(Client, f.client_id)
        names["client"] = " · ".join(x for x in (c.code, c.name) if x) if c else f"#{f.client_id}"
    return names


def _who(user: User) -> str:
    return f"{user.full_name} ({user.username})" if user.full_name else user.username


@router.get("/options")
def report_options(
    org_id: int | None = Query(None, ge=1),
    db: Session = Depends(get_db),
    user: User = Depends(require_perm("reports.view")),
):
    oid = _scope_org(user, org_id)

    def scoped(q, model):
        return q.filter(model.org_id == oid) if oid else q

    agents = scoped(db.query(Agent.code, Agent.name, Agent.org_id), Agent).filter(Agent.code != "").order_by(Agent.code).all()
    drivers = scoped(db.query(Driver.id, Driver.name, Driver.vehicle_plate), Driver).order_by(Driver.name).all()
    warehouses = scoped(db.query(Warehouse.id, Warehouse.name), Warehouse).order_by(Warehouse.name).all()
    span = scoped(db.query(func.min(Order.delivery_date), func.max(Order.delivery_date)), Order).filter(
        Order.delivery_date.like("____-__-__%")
    ).one()
    seen_agents = set()
    agent_items = []
    for code, name, _ in agents:
        if code in seen_agents:
            continue
        seen_agents.add(code)
        agent_items.append({"code": code, "name": name})
    cross = can_cross_org(user)
    return {
        "cross_org": cross,
        "can_export": has_perm(user, "reports.export"),
        "orgs": [{"id": o.id, "name": o.name} for o in db.query(Organization).order_by(Organization.name).all()] if cross else [],
        "agents": agent_items,
        "drivers": [{"id": d.id, "name": " · ".join(x for x in (d.name, d.vehicle_plate) if x)} for d in drivers],
        "warehouses": [{"id": w.id, "name": w.name} for w in warehouses],
        "statuses": [{"key": k, "label": v} for k, v in STATUS_LABELS.items()],
        "date_min": (span[0] or "")[:10],
        "date_max": (span[1] or "")[:10],
        "today": local_now().strftime("%Y-%m-%d"),
    }


@router.get("/overview")
def report_overview(f: ReportFilter = Depends(report_filter), db: Session = Depends(get_db)):
    rows = fetch_rows(db, f)
    data = build_overview(rows, cross_org=f.org_id is None)
    data["payment_options"] = sorted({r.payment for r in rows if r.payment})
    return data


@router.get("/orders")
def report_orders(
    f: ReportFilter = Depends(report_filter),
    limit: int = Query(300, ge=1, le=ORDERS_PAGE_MAX),
    offset: int = Query(0, ge=0, le=10_000_000),
    db: Session = Depends(get_db),
):
    rows = fetch_rows(db, f)
    rows.sort(key=lambda r: (r.day, r.id), reverse=True)
    return {"total": len(rows), "rows": [order_dict(r) for r in rows[offset : offset + limit]]}


@router.get("/export")
def report_export(
    section: str = Query("all", max_length=40),
    f: ReportFilter = Depends(report_filter),
    db: Session = Depends(get_db),
    user: User = Depends(require_perm("reports.export")),
):
    keys = list(SECTIONS) if section == "all" else [s for s in section.split(",") if s in SECTIONS]
    if not keys:
        raise HTTPException(400, "Hisobot bo‘limi noto‘g‘ri")
    rows = fetch_rows(db, f)
    cross = f.org_id is None
    overview = build_overview(rows, cross_org=cross, returns_limit=len(rows) + 1)
    orders = None
    if "orders" in keys:
        rows.sort(key=lambda r: (r.day, r.id), reverse=True)
        orders = [order_dict(r) for r in rows]
    names = _filter_names(db, f)
    if cross:
        names["org"] = "barcha tashkilotlar"
    content = build_report_xlsx(keys, overview, orders, f.describe(names), _who(user), with_org=cross)
    title = SECTIONS[keys[0]][0] if len(keys) == 1 else "Hisobot"
    period = "_".join(x for x in (f.date_from, f.date_to) if x) or local_now().strftime("%Y-%m-%d")
    return _xlsx(content, f"{title}_{period}.xlsx".replace(" ", "_"))


@router.get("/full-export")
def report_full_export(
    org_id: int | None = Query(None, ge=1),
    gps_days: int = Query(0, ge=0, le=31),
    db: Session = Depends(get_db),
    user: User = Depends(require_perm("reports.export")),
):
    oid = _scope_org(user, org_id)
    content = build_full_export(
        db,
        oid,
        include_users=has_perm(user, "users.manage"),
        include_trash=has_perm(user, "trash.view"),
        gps_days=gps_days,
    )
    org_part = "barcha"
    if oid:
        org = db.get(Organization, oid)
        org_part = (org.name if org else str(oid)).replace(" ", "_")
    return _xlsx(content, f"Nexus_barcha_malumot_{org_part}_{local_now().strftime('%Y-%m-%d_%H%M')}.xlsx")
