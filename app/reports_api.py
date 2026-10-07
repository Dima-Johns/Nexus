import json
from datetime import date
from typing import Annotated, Literal
from urllib.parse import quote

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import Response
from pydantic import Field, field_validator
from sqlalchemy import func, or_
from sqlalchemy.orm import Session

from .database import get_db
from .dispatch import local_now
from .models import Agent, Client, Driver, Order, Organization, ReportLayout, User, Warehouse, utcnow
from .permissions import has_perm, is_admin_role
from .pivot import (
    DIMENSIONS,
    MAX_COLS_DIMS,
    MAX_FILTER_FIELDS,
    MAX_FILTER_VALUES,
    MAX_ROWS_DIMS,
    MAX_VALUES,
    PivotConfig,
    apply_value_filters,
    build_pivot_xlsx,
    catalog,
    distinct_values,
    run_pivot,
)
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
from .schemas import Schema
from .tenancy import can_cross_org, org_id_of, require_perm
from .trash import archive_deleted

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
    return make_filter(user, date_from, date_to, org_id, agent_code, driver_id, warehouse_id, client_id, status, payment, q)


def make_filter(
    user: User,
    date_from: str = "",
    date_to: str = "",
    org_id: int | None = None,
    agent_code: str = "",
    driver_id: int | None = None,
    warehouse_id: int | None = None,
    client_id: int | None = None,
    status: str = "",
    payment: str = "",
    q: str = "",
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


# ---------- Pivot konstruktor ----------

FieldKey = Annotated[str, Field(max_length=30)]
LAYOUT_JSON_MAX = 30_000
LAYOUTS_PER_USER = 200


class FilterIn(Schema):
    date_from: Annotated[str, Field(max_length=10, pattern=r"^(\d{4}-\d{2}-\d{2})?$")] = ""
    date_to: Annotated[str, Field(max_length=10, pattern=r"^(\d{4}-\d{2}-\d{2})?$")] = ""
    org_id: Annotated[int, Field(ge=1)] | None = None
    agent_code: Annotated[str, Field(max_length=8)] = ""
    driver_id: Annotated[int, Field(ge=1)] | None = None
    warehouse_id: Annotated[int, Field(ge=1)] | None = None
    client_id: Annotated[int, Field(ge=1)] | None = None
    status: Annotated[str, Field(max_length=20)] = ""
    payment: Annotated[str, Field(max_length=80)] = ""
    q: Annotated[str, Field(max_length=120)] = ""


class PivotIn(Schema):
    filters: FilterIn = Field(default_factory=FilterIn)
    rows: Annotated[list[FieldKey], Field(max_length=MAX_ROWS_DIMS)] = []
    cols: Annotated[list[FieldKey], Field(max_length=MAX_COLS_DIMS)] = []
    values: Annotated[list[FieldKey], Field(max_length=MAX_VALUES)] = ["count"]
    value_filters: dict[FieldKey, list[Annotated[str, Field(max_length=300)]]] = {}
    subtotals: bool = False
    sort_by: Annotated[str, Field(max_length=30)] = ""
    sort_dir: Literal["asc", "desc"] = "desc"
    title: Annotated[str, Field(max_length=120)] = ""

    @field_validator("value_filters")
    @classmethod
    def _limit_filters(cls, v: dict) -> dict:
        if len(v) > MAX_FILTER_FIELDS:
            raise ValueError(f"Ko‘pi bilan {MAX_FILTER_FIELDS} ta filtr maydoni")
        if any(len(vals) > MAX_FILTER_VALUES for vals in v.values()):
            raise ValueError(f"Bitta filtrda ko‘pi bilan {MAX_FILTER_VALUES} ta qiymat")
        return {k: vals for k, vals in v.items() if vals}

    def config(self) -> PivotConfig:
        cfg = PivotConfig(
            rows=list(self.rows),
            cols=list(self.cols),
            values=list(self.values),
            filters={k: list(v) for k, v in self.value_filters.items()},
            subtotals=self.subtotals,
            sort_by=self.sort_by,
            sort_dir=self.sort_dir,
        )
        try:
            cfg.validate()
        except ValueError as e:
            raise HTTPException(400, str(e)) from None
        return cfg


class PivotValuesIn(Schema):
    filters: FilterIn = Field(default_factory=FilterIn)
    field: FieldKey
    value_filters: dict[FieldKey, list[Annotated[str, Field(max_length=300)]]] = {}


class LayoutIn(Schema):
    name: Annotated[str, Field(min_length=1, max_length=120)]
    shared: bool = False
    config: dict


def _filter_from(user: User, fi: FilterIn) -> ReportFilter:
    return make_filter(user, **fi.model_dump())


@router.get("/pivot/fields")
def pivot_fields(user: User = Depends(require_perm("reports.view"))):
    return catalog()


@router.post("/pivot")
def pivot_run(body: PivotIn, db: Session = Depends(get_db), user: User = Depends(require_perm("reports.view"))):
    cfg = body.config()
    rows = fetch_rows(db, _filter_from(user, body.filters))
    result = run_pivot(rows, cfg, row_limit=3000)
    result["payment_options"] = sorted({r.payment for r in rows if r.payment})
    return result


@router.post("/pivot/values")
def pivot_values(body: PivotValuesIn, db: Session = Depends(get_db), user: User = Depends(require_perm("reports.view"))):
    if body.field not in DIMENSIONS:
        raise HTTPException(400, "Noma’lum maydon")
    filters = {k: v for k, v in body.value_filters.items() if k in DIMENSIONS and v}
    rows = apply_value_filters(fetch_rows(db, _filter_from(user, body.filters)), filters, skip=body.field)
    return {"field": body.field, "values": distinct_values(rows, body.field), "total": len(rows)}


@router.post("/pivot/export")
def pivot_export(body: PivotIn, db: Session = Depends(get_db), user: User = Depends(require_perm("reports.export"))):
    cfg = body.config()
    f = _filter_from(user, body.filters)
    rows = fetch_rows(db, f)
    result = run_pivot(rows, cfg, row_limit=1_000_000, col_limit=200)
    names = _filter_names(db, f)
    if f.org_id is None:
        names["org"] = "barcha tashkilotlar"
    used = apply_value_filters(rows, cfg.filters)
    used.sort(key=lambda r: (r.day, r.id))
    title = body.title.strip() or "Pivot hisobot"
    content = build_pivot_xlsx(result, cfg, title, f.describe(names), used, _who(user))
    period = "_".join(x for x in (f.date_from, f.date_to) if x) or local_now().strftime("%Y-%m-%d")
    safe = "".join(ch if ch.isalnum() or ch in "-_" else "_" for ch in title)[:60].strip("_") or "Pivot"
    return _xlsx(content, f"{safe}_{period}.xlsx")


def _layout_scope(user: User):
    oid = org_id_of(user)
    return ReportLayout.org_id == oid if oid else ReportLayout.org_id.is_(None)


def _layout_dict(row: ReportLayout, user: User) -> dict:
    try:
        config = json.loads(row.config_json or "{}")
    except ValueError:
        config = {}
    return {
        "id": row.id,
        "name": row.name,
        "shared": row.shared,
        "mine": row.user_id == user.id,
        "can_edit": row.user_id == user.id or is_admin_role(user),
        "user_name": row.user_name,
        "config": config,
        "updated_at": row.updated_at.isoformat() if row.updated_at else None,
    }


def _layout_json(config: dict) -> str:
    text = json.dumps(config, ensure_ascii=False)
    if len(text) > LAYOUT_JSON_MAX:
        raise HTTPException(400, "Shablon juda katta (filtrlarda qiymatlar juda ko‘p)")
    return text


def _get_layout(db: Session, user: User, layout_id: int, edit: bool) -> ReportLayout:
    row = db.get(ReportLayout, layout_id)
    if not row or row.org_id != org_id_of(user) or (row.user_id != user.id and not row.shared):
        raise HTTPException(404, "Shablon topilmadi")
    if edit and row.user_id != user.id and not is_admin_role(user):
        raise HTTPException(403, "Faqat shablon egasi yoki admin o‘zgartira oladi")
    return row


@router.get("/layouts")
def list_layouts(db: Session = Depends(get_db), user: User = Depends(require_perm("reports.view"))):
    rows = (
        db.query(ReportLayout)
        .filter(_layout_scope(user), or_(ReportLayout.user_id == user.id, ReportLayout.shared.is_(True)))
        .order_by(func.lower(ReportLayout.name))
        .all()
    )
    return [_layout_dict(r, user) for r in rows]


@router.post("/layouts")
def create_layout(body: LayoutIn, db: Session = Depends(get_db), user: User = Depends(require_perm("reports.view"))):
    count = db.query(func.count(ReportLayout.id)).filter(ReportLayout.user_id == user.id).scalar() or 0
    if count >= LAYOUTS_PER_USER:
        raise HTTPException(400, f"Ko‘pi bilan {LAYOUTS_PER_USER} ta shablon saqlash mumkin")
    row = ReportLayout(
        org_id=org_id_of(user),
        user_id=user.id,
        user_name=_who(user)[:160],
        name=body.name.strip(),
        config_json=_layout_json(body.config),
        shared=body.shared,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return _layout_dict(row, user)


@router.put("/layouts/{layout_id}")
def update_layout(layout_id: int, body: LayoutIn, db: Session = Depends(get_db), user: User = Depends(require_perm("reports.view"))):
    row = _get_layout(db, user, layout_id, edit=True)
    row.name = body.name.strip()
    row.shared = body.shared
    row.config_json = _layout_json(body.config)
    row.updated_at = utcnow()
    db.commit()
    db.refresh(row)
    return _layout_dict(row, user)


@router.delete("/layouts/{layout_id}")
def delete_layout(layout_id: int, db: Session = Depends(get_db), user: User = Depends(require_perm("reports.view"))):
    row = _get_layout(db, user, layout_id, edit=True)
    archive_deleted(db, user, "report_layout", row, row.name)
    db.delete(row)
    db.commit()
    return {"ok": True}

