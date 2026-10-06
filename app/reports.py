"""Hisobotlar kutubxonasi: zayavkalar asosida savdo, klientlar, qaytarishlar va tizim ma’lumotlarining to‘liq eksporti.

Zayavka sanasi — ``delivery_date`` (YYYY-MM-DD); u bo‘sh yoki boshqa formatda bo‘lsa yaratilgan kun (Toshkent vaqti) olinadi.
"""

from __future__ import annotations

import io
import json
import re
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta

from openpyxl import Workbook
from openpyxl.cell import WriteOnlyCell
from openpyxl.cell.cell import ILLEGAL_CHARACTERS_RE
from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.utils import get_column_letter
from sqlalchemy import and_, or_
from sqlalchemy.orm import Session

from .dispatch import LOCAL_TZ
from .models import (
    Agent,
    Client,
    DayPlan,
    DeletedRecord,
    Driver,
    GpsPing,
    ImportTemplate,
    Order,
    Organization,
    User,
    Warehouse,
)

STATUS_LABELS = {
    "new": "Yangi",
    "assigned": "Biriktirilgan",
    "in_transit": "Yo‘lda",
    "delivered": "Yetkazildi",
    "returned": "Qaytarildi",
}
PROOF_LABELS = {
    "fridge_yes": "Muzlatgich bor",
    "foreign_goods": "Begona mahsulot bor",
    "fridge_no": "Muzlatgich yo‘q",
    "returned": "Qaytarildi",
}
ISO_DAY_RE = re.compile(r"^\d{4}-\d{2}-\d{2}")
DOT_DAY_RE = re.compile(r"^(\d{1,2})[./](\d{1,2})[./](\d{4})")
SECRET_COLUMNS = {"password_hash", "qr_token", "token"}
EXCEL_TEXT_MAX = 32000
HEADER_FONT = Font(bold=True, color="FFFFFF")
HEADER_FILL = PatternFill("solid", fgColor="1F3A5F")
TOTAL_FONT = Font(bold=True)
MONEY_FMT = "#,##0"
PCT_FMT = "0.0"


@dataclass
class ReportFilter:
    org_id: int | None = None
    date_from: str = ""
    date_to: str = ""
    agent_code: str = ""
    driver_id: int | None = None
    warehouse_id: int | None = None
    client_id: int | None = None
    status: str = ""
    payment: str = ""
    q: str = ""

    def describe(self, names: dict[str, str] | None = None) -> list[tuple[str, str]]:
        names = names or {}
        period = "barcha davr"
        if self.date_from or self.date_to:
            period = f"{self.date_from or '…'} — {self.date_to or '…'}"
        out = [("Davr", period)]
        for key, label in (
            ("org", "Tashkilot"),
            ("agent", "Agent"),
            ("driver", "Haydovchi"),
            ("warehouse", "Sklad"),
            ("client", "Klient"),
        ):
            if names.get(key):
                out.append((label, names[key]))
        if self.status:
            out.append(("Holat", STATUS_LABELS.get(self.status, self.status)))
        if self.payment:
            out.append(("To‘lov holati", self.payment))
        if self.q:
            out.append(("Qidiruv", self.q))
        return out


@dataclass
class OrderRow:
    id: int
    org_id: int | None
    org_name: str
    code: str
    day: str
    status: str
    amount: float
    weight: float
    client_key: str
    client_id: int | None
    client_code: str
    client_name: str
    address: str
    agent_code: str
    agent_name: str
    driver_id: int | None
    driver_name: str
    warehouse_id: int | None
    warehouse_name: str
    payment: str
    cargo: str
    route_code: str
    proof_reason: str
    proof_comment: str
    proof_photo: str
    proof_at: str
    lat: float
    lng: float


def _local(dt: datetime | None) -> datetime | None:
    if dt is None:
        return None
    if dt.tzinfo is None:
        return dt
    return dt.astimezone(LOCAL_TZ)


def order_day(delivery_date: str, created_at: datetime | None) -> str:
    raw = (delivery_date or "").strip()
    if ISO_DAY_RE.match(raw):
        return raw[:10]
    m = DOT_DAY_RE.match(raw)
    if m:
        d, mth, y = (int(x) for x in m.groups())
        try:
            return date(y, mth, d).isoformat()
        except ValueError:
            pass
    created = _local(created_at)
    return created.strftime("%Y-%m-%d") if created else ""


def _norm(text: str) -> str:
    return " ".join(str(text or "").lower().replace("‘", "'").replace("’", "'").split())


def _payment_of(extra_json: str) -> str:
    try:
        data = json.loads(extra_json or "{}")
    except (TypeError, ValueError):
        return ""
    if not isinstance(data, dict):
        return ""
    for key in ("payment_status", "payment", "Оплата", "To‘lov"):
        if data.get(key):
            return str(data[key]).strip()[:80]
    return ""


def fetch_rows(db: Session, f: ReportFilter) -> list[OrderRow]:
    q = (
        db.query(
            Order.id,
            Order.org_id,
            Order.code,
            Order.delivery_date,
            Order.created_at,
            Order.status,
            Order.amount,
            Order.weight_kg,
            Order.client_id,
            Order.driver_id,
            Order.warehouse_id,
            Order.sales_rep,
            Order.agent_code,
            Order.dropoff_address,
            Order.dropoff_lat,
            Order.dropoff_lng,
            Order.extra_json,
            Order.cargo,
            Order.route_code,
            Order.proof_reason,
            Order.proof_comment,
            Order.proof_photo,
            Order.proof_at,
            Client.code.label("client_code"),
            Client.name.label("client_name"),
            Client.address.label("client_address"),
            Driver.name.label("driver_name"),
            Driver.vehicle_plate.label("driver_plate"),
            Warehouse.name.label("warehouse_name"),
            Organization.name.label("org_name"),
        )
        .outerjoin(Client, Client.id == Order.client_id)
        .outerjoin(Driver, Driver.id == Order.driver_id)
        .outerjoin(Warehouse, Warehouse.id == Order.warehouse_id)
        .outerjoin(Organization, Organization.id == Order.org_id)
    )
    if f.org_id:
        q = q.filter(Order.org_id == f.org_id)
    if f.date_from or f.date_to:
        iso = [Order.delivery_date.like("____-__-__%")]
        if f.date_from:
            iso.append(Order.delivery_date >= f.date_from)
        if f.date_to:
            iso.append(Order.delivery_date <= f.date_to + "~")
        # ISO bo‘lmagan sanalar Python’da yaratilgan kun bo‘yicha aniq tekshiriladi
        q = q.filter(or_(and_(*iso), ~Order.delivery_date.like("____-__-__%")))
    if f.agent_code:
        q = q.filter(Order.agent_code == f.agent_code)
    if f.driver_id:
        q = q.filter(Order.driver_id == f.driver_id)
    if f.warehouse_id:
        q = q.filter(Order.warehouse_id == f.warehouse_id)
    if f.client_id:
        q = q.filter(Order.client_id == f.client_id)
    if f.status:
        q = q.filter(Order.status == f.status)

    agent_names: dict[tuple[int | None, str], str] = {}
    aq = db.query(Agent.org_id, Agent.code, Agent.name)
    if f.org_id:
        aq = aq.filter(Agent.org_id == f.org_id)
    for org_id, code, name in aq.all():
        if code:
            agent_names[(org_id, code)] = name

    text = _norm(f.q)
    rows: list[OrderRow] = []
    for r in q.order_by(Order.id.asc()).yield_per(2000):
        day = order_day(r.delivery_date, r.created_at)
        if f.date_from and day < f.date_from:
            continue
        if f.date_to and day > f.date_to:
            continue
        payment = _payment_of(r.extra_json)
        if f.payment and payment != f.payment:
            continue
        client_name = r.client_name or ""
        client_code = r.client_code or ""
        address = r.client_address or r.dropoff_address or ""
        if text and not any(
            text in _norm(v) for v in (client_name, client_code, r.code, address, r.sales_rep, r.driver_name or "")
        ):
            continue
        key = f"id:{r.client_id}" if r.client_id else f"name:{_norm(client_name) or r.code}"
        agent_code = (r.agent_code or "").strip()
        proof_at = _local(r.proof_at)
        driver_name = r.driver_name or ""
        if driver_name and r.driver_plate:
            driver_name = f"{driver_name} · {r.driver_plate}"
        rows.append(
            OrderRow(
                id=r.id,
                org_id=r.org_id,
                org_name=r.org_name or "",
                code=r.code or "",
                day=day,
                status=r.status or "",
                amount=float(r.amount or 0),
                weight=float(r.weight_kg or 0),
                client_key=key,
                client_id=r.client_id,
                client_code=client_code,
                client_name=client_name or "Klient ko‘rsatilmagan",
                address=address,
                agent_code=agent_code,
                agent_name=agent_names.get((r.org_id, agent_code)) or (r.sales_rep or ""),
                driver_id=r.driver_id,
                driver_name=driver_name,
                warehouse_id=r.warehouse_id,
                warehouse_name=r.warehouse_name or "",
                payment=payment,
                cargo=r.cargo or "",
                route_code=r.route_code or "",
                proof_reason=r.proof_reason or "",
                proof_comment=r.proof_comment or "",
                proof_photo=r.proof_photo or "",
                proof_at=proof_at.strftime("%Y-%m-%d %H:%M") if proof_at else "",
                lat=float(r.dropoff_lat or 0),
                lng=float(r.dropoff_lng or 0),
            )
        )
    return rows


# ---------- agregatsiya ----------


@dataclass
class Bucket:
    key: str
    label: str
    orders: int = 0
    delivered: int = 0
    returned: int = 0
    pending: int = 0
    amount: float = 0.0
    amount_delivered: float = 0.0
    amount_returned: float = 0.0
    weight: float = 0.0
    first_day: str = ""
    last_day: str = ""
    days: set = field(default_factory=set)
    clients: set = field(default_factory=set)
    extra: dict = field(default_factory=dict)

    def add(self, r: OrderRow) -> None:
        self.orders += 1
        self.amount += r.amount
        self.weight += r.weight
        if r.status == "delivered":
            self.delivered += 1
            self.amount_delivered += r.amount
        elif r.status == "returned":
            self.returned += 1
            self.amount_returned += r.amount
        else:
            self.pending += 1
        if r.day:
            self.days.add(r.day)
            if not self.first_day or r.day < self.first_day:
                self.first_day = r.day
            if r.day > self.last_day:
                self.last_day = r.day
        self.clients.add(r.client_key)

    def as_dict(self) -> dict:
        done = self.delivered + self.returned
        return {
            "key": self.key,
            "label": self.label,
            "orders": self.orders,
            "delivered": self.delivered,
            "returned": self.returned,
            "pending": self.pending,
            "amount": round(self.amount, 2),
            "amount_delivered": round(self.amount_delivered, 2),
            "amount_returned": round(self.amount_returned, 2),
            "weight": round(self.weight, 2),
            "avg_check": round(self.amount / self.orders, 2) if self.orders else 0,
            "return_rate": round(self.returned * 100 / done, 1) if done else 0,
            "clients": len(self.clients),
            "active_days": len(self.days),
            "first_day": self.first_day,
            "last_day": self.last_day,
            **self.extra,
        }


def group_rows(rows: list[OrderRow], key_fn, label_fn, extra_fn=None) -> list[dict]:
    buckets: dict[str, Bucket] = {}
    for r in rows:
        key = key_fn(r)
        b = buckets.get(key)
        if b is None:
            b = buckets[key] = Bucket(key=key, label=label_fn(r))
            if extra_fn:
                b.extra = extra_fn(r)
        b.add(r)
    return [b.as_dict() for b in buckets.values()]


def summary(rows: list[OrderRow]) -> dict:
    total = Bucket(key="all", label="Jami")
    drivers, agents, returned_clients = set(), set(), set()
    for r in rows:
        total.add(r)
        if r.driver_id:
            drivers.add(r.driver_id)
        if r.agent_code:
            agents.add((r.org_id, r.agent_code))
        if r.status == "returned":
            returned_clients.add(r.client_key)
    out = total.as_dict()
    done = total.delivered + total.returned
    out.update(
        drivers=len(drivers),
        agents=len(agents),
        returned_clients=len(returned_clients),
        delivery_rate=round(total.delivered * 100 / done, 1) if done else 0,
        progress=round(done * 100 / total.orders, 1) if total.orders else 0,
    )
    return out


def clients_report(rows: list[OrderRow]) -> list[dict]:
    last_comment: dict[str, tuple[str, str]] = {}
    for r in rows:
        if r.status == "returned" and r.proof_comment:
            prev = last_comment.get(r.client_key)
            stamp = r.proof_at or r.day
            if not prev or stamp >= prev[0]:
                last_comment[r.client_key] = (stamp, r.proof_comment)
    data = group_rows(
        rows,
        lambda r: r.client_key,
        lambda r: r.client_name,
        lambda r: {
            "client_id": r.client_id,
            "code": r.client_code,
            "address": r.address,
            "agent": " · ".join(x for x in (r.agent_code, r.agent_name) if x),
            "org_name": r.org_name,
            "lat": r.lat,
            "lng": r.lng,
        },
    )
    for d in data:
        d["last_return_comment"] = last_comment.get(d["key"], ("", ""))[1]
    data.sort(key=lambda d: (-d["amount"], d["label"]))
    return data


def returns_list(rows: list[OrderRow]) -> list[dict]:
    out = [
        {
            "id": r.id,
            "day": r.day,
            "code": r.code,
            "client_id": r.client_id,
            "client_code": r.client_code,
            "client_name": r.client_name,
            "address": r.address,
            "agent": " · ".join(x for x in (r.agent_code, r.agent_name) if x),
            "driver": r.driver_name,
            "amount": round(r.amount, 2),
            "comment": r.proof_comment,
            "photo": r.proof_photo,
            "proof_at": r.proof_at,
            "org_name": r.org_name,
        }
        for r in rows
        if r.status == "returned"
    ]
    out.sort(key=lambda d: (d["proof_at"] or d["day"]), reverse=True)
    return out


def drivers_report(rows: list[OrderRow]) -> list[dict]:
    data = group_rows(
        [r for r in rows if r.driver_id],
        lambda r: str(r.driver_id),
        lambda r: r.driver_name or f"#{r.driver_id}",
        lambda r: {"driver_id": r.driver_id, "org_name": r.org_name},
    )
    data.sort(key=lambda d: (-d["delivered"], -d["orders"]))
    return data


def agents_report(rows: list[OrderRow]) -> list[dict]:
    data = group_rows(
        rows,
        lambda r: f"{r.org_id}:{r.agent_code or '-'}",
        lambda r: r.agent_name or ("Agent ko‘rsatilmagan" if not r.agent_code else f"Agent {r.agent_code}"),
        lambda r: {"code": r.agent_code, "org_name": r.org_name},
    )
    data.sort(key=lambda d: -d["amount"])
    return data


def warehouses_report(rows: list[OrderRow]) -> list[dict]:
    data = group_rows(
        rows,
        lambda r: str(r.warehouse_id or 0),
        lambda r: r.warehouse_name or "Sklad ko‘rsatilmagan",
        lambda r: {"org_name": r.org_name},
    )
    data.sort(key=lambda d: -d["amount"])
    return data


def days_report(rows: list[OrderRow]) -> list[dict]:
    data = group_rows(rows, lambda r: r.day or "—", lambda r: r.day or "Sana yo‘q")
    data.sort(key=lambda d: d["key"])
    return data


def payments_report(rows: list[OrderRow]) -> list[dict]:
    data = group_rows(rows, lambda r: r.payment or "-", lambda r: r.payment or "Ko‘rsatilmagan")
    data.sort(key=lambda d: -d["amount"])
    return data


def statuses_report(rows: list[OrderRow]) -> list[dict]:
    data = group_rows(rows, lambda r: r.status or "-", lambda r: STATUS_LABELS.get(r.status, r.status or "—"))
    order = list(STATUS_LABELS)
    data.sort(key=lambda d: order.index(d["key"]) if d["key"] in order else 99)
    return data


def orgs_report(rows: list[OrderRow]) -> list[dict]:
    data = group_rows(rows, lambda r: str(r.org_id or 0), lambda r: r.org_name or "—")
    data.sort(key=lambda d: -d["amount"])
    return data


def order_dict(r: OrderRow) -> dict:
    return {
        "id": r.id,
        "day": r.day,
        "code": r.code,
        "status": r.status,
        "status_label": STATUS_LABELS.get(r.status, r.status),
        "amount": round(r.amount, 2),
        "weight": round(r.weight, 2),
        "client_id": r.client_id,
        "client_code": r.client_code,
        "client_name": r.client_name,
        "address": r.address,
        "agent": " · ".join(x for x in (r.agent_code, r.agent_name) if x),
        "driver": r.driver_name,
        "warehouse": r.warehouse_name,
        "payment": r.payment,
        "proof": PROOF_LABELS.get(r.proof_reason, ""),
        "comment": r.proof_comment,
        "photo": r.proof_photo,
        "proof_at": r.proof_at,
        "org_name": r.org_name,
    }


def build_overview(rows: list[OrderRow], cross_org: bool, returns_limit: int = 1000) -> dict:
    returns = returns_list(rows)
    clients = clients_report(rows)
    return {
        "summary": summary(rows),
        "clients": clients,
        "returned_clients": sorted(
            (c for c in clients if c["returned"]), key=lambda c: (-c["returned"], -c["amount_returned"])
        ),
        "returns": returns[:returns_limit],
        "returns_total": len(returns),
        "drivers": drivers_report(rows),
        "agents": agents_report(rows),
        "warehouses": warehouses_report(rows),
        "days": days_report(rows),
        "payments": payments_report(rows),
        "statuses": statuses_report(rows),
        "orgs": orgs_report(rows) if cross_org else [],
    }


# ---------- Excel ----------


def _clean(value):
    if isinstance(value, str):
        value = ILLEGAL_CHARACTERS_RE.sub("", value)
        return value[:EXCEL_TEXT_MAX]
    if isinstance(value, datetime):
        local = _local(value)
        return local.replace(tzinfo=None) if local else None
    if isinstance(value, (dict, list)):
        return _clean(json.dumps(value, ensure_ascii=False))
    return value


@dataclass
class Column:
    title: str
    key: str
    kind: str = "text"  # text | int | money | pct | float
    width: int = 0


GROUP_COLUMNS = [
    Column("Zayavkalar", "orders", "int"),
    Column("Yetkazildi", "delivered", "int"),
    Column("Qaytarildi", "returned", "int"),
    Column("Jarayonda", "pending", "int"),
    Column("Savdo summasi", "amount", "money"),
    Column("Yetkazilgan summa", "amount_delivered", "money"),
    Column("Qaytarilgan summa", "amount_returned", "money"),
    Column("O‘rtacha chek", "avg_check", "money"),
    Column("Qaytarish %", "return_rate", "pct"),
    Column("Og‘irlik, kg", "weight", "float"),
]

SECTIONS: dict[str, tuple[str, list[Column]]] = {
    "clients": (
        "Klientlar savdosi",
        [
            Column("Mijoz kodi", "code"),
            Column("Mijoz", "label", width=34),
            Column("Manzil", "address", width=40),
            Column("Agent", "agent", width=26),
            *GROUP_COLUMNS,
            Column("Faol kunlar", "active_days", "int"),
            Column("Birinchi zayavka", "first_day"),
            Column("Oxirgi zayavka", "last_day"),
            Column("Oxirgi qaytarish izohi", "last_return_comment", width=40),
        ],
    ),
    "returned_clients": (
        "Qaytargan klientlar",
        [
            Column("Mijoz kodi", "code"),
            Column("Mijoz", "label", width=34),
            Column("Manzil", "address", width=40),
            Column("Agent", "agent", width=26),
            Column("Qaytarishlar", "returned", "int"),
            Column("Zayavkalar", "orders", "int"),
            Column("Qaytarish %", "return_rate", "pct"),
            Column("Qaytarilgan summa", "amount_returned", "money"),
            Column("Savdo summasi", "amount", "money"),
            Column("Oxirgi izoh", "last_return_comment", width=40),
        ],
    ),
    "returns": (
        "Qaytarishlar",
        [
            Column("Sana", "day"),
            Column("Vaqt", "proof_at"),
            Column("Zayavka", "code"),
            Column("Mijoz kodi", "client_code"),
            Column("Mijoz", "client_name", width=34),
            Column("Manzil", "address", width=40),
            Column("Agent", "agent", width=26),
            Column("Haydovchi", "driver", width=26),
            Column("Summa", "amount", "money"),
            Column("Haydovchi izohi", "comment", width=44),
            Column("Rasm", "photo", width=30),
        ],
    ),
    "drivers": ("Haydovchilar", [Column("Haydovchi", "label", width=30), *GROUP_COLUMNS, Column("Klientlar", "clients", "int"), Column("Ish kunlari", "active_days", "int")]),
    "agents": ("Agentlar", [Column("Kod", "code"), Column("Agent", "label", width=30), *GROUP_COLUMNS, Column("Klientlar", "clients", "int")]),
    "warehouses": ("Skladlar", [Column("Sklad", "label", width=30), *GROUP_COLUMNS, Column("Klientlar", "clients", "int")]),
    "days": ("Kunlar", [Column("Sana", "label"), *GROUP_COLUMNS, Column("Klientlar", "clients", "int")]),
    "payments": ("To‘lov holati", [Column("To‘lov holati", "label", width=24), *GROUP_COLUMNS, Column("Klientlar", "clients", "int")]),
    "statuses": ("Holatlar", [Column("Holat", "label", width=20), *GROUP_COLUMNS[:1], Column("Savdo summasi", "amount", "money"), Column("Klientlar", "clients", "int")]),
    "orgs": ("Tashkilotlar", [Column("Tashkilot", "label", width=30), *GROUP_COLUMNS, Column("Klientlar", "clients", "int")]),
    "orders": (
        "Zayavkalar",
        [
            Column("Sana", "day"),
            Column("Zayavka", "code"),
            Column("Holat", "status_label"),
            Column("Mijoz kodi", "client_code"),
            Column("Mijoz", "client_name", width=34),
            Column("Manzil", "address", width=40),
            Column("Agent", "agent", width=26),
            Column("Haydovchi", "driver", width=26),
            Column("Sklad", "warehouse"),
            Column("Summa", "amount", "money"),
            Column("Og‘irlik, kg", "weight", "float"),
            Column("To‘lov holati", "payment"),
            Column("Tasdiq", "proof"),
            Column("Izoh", "comment", width=40),
            Column("Tasdiq vaqti", "proof_at"),
        ],
    ),
}
SUMMABLE = {"int", "money", "float"}


def _write_section(wb: Workbook, title: str, columns: list[Column], items: list[dict], with_org: bool) -> None:
    ws = wb.create_sheet(title[:31])
    cols = ([Column("Tashkilot", "org_name", width=22)] if with_org else []) + columns
    ws.append([c.title for c in cols])
    for cell in ws[1]:
        cell.font = HEADER_FONT
        cell.fill = HEADER_FILL
        cell.alignment = Alignment(vertical="center", wrap_text=True)
    for item in items:
        ws.append([_clean(item.get(c.key, "")) for c in cols])
    n = len(items)
    if n and any(c.kind in SUMMABLE for c in cols):
        totals = []
        for i, c in enumerate(cols):
            letter = get_column_letter(i + 1)
            if c.kind in SUMMABLE:
                totals.append(f"=SUM({letter}2:{letter}{n + 1})")
            else:
                totals.append("Jami" if i == 0 else "")
        ws.append(totals)
        for cell in ws[n + 2]:
            cell.font = TOTAL_FONT
    for i, c in enumerate(cols, 1):
        letter = get_column_letter(i)
        fmt = {"money": MONEY_FMT, "pct": PCT_FMT, "float": "#,##0.0", "int": "0"}.get(c.kind)
        if fmt:
            for row in ws.iter_rows(min_row=2, min_col=i, max_col=i):
                row[0].number_format = fmt
        ws.column_dimensions[letter].width = c.width or max(12, min(30, len(c.title) + 4))
    ws.freeze_panes = "A2"
    if n:
        ws.auto_filter.ref = f"A1:{get_column_letter(len(cols))}{n + 1}"


def _write_summary(wb: Workbook, meta: list[tuple[str, str]], s: dict, generated_by: str) -> None:
    ws = wb.active
    ws.title = "Umumiy"
    ws.append(["Nexus Logistika — hisobot"])
    ws["A1"].font = Font(bold=True, size=14)
    ws.append([f"Tuzildi: {datetime.now(LOCAL_TZ).strftime('%Y-%m-%d %H:%M')} · {generated_by}"])
    ws.append([])
    for label, value in meta:
        ws.append([label, value])
    ws.append([])
    kpis = [
        ("Zayavkalar", s.get("orders", 0), "0"),
        ("Yetkazildi", s.get("delivered", 0), "0"),
        ("Qaytarildi", s.get("returned", 0), "0"),
        ("Jarayonda", s.get("pending", 0), "0"),
        ("Savdo summasi", s.get("amount", 0), MONEY_FMT),
        ("Yetkazilgan summa", s.get("amount_delivered", 0), MONEY_FMT),
        ("Qaytarilgan summa", s.get("amount_returned", 0), MONEY_FMT),
        ("O‘rtacha chek", s.get("avg_check", 0), MONEY_FMT),
        ("Qaytarish %", s.get("return_rate", 0), PCT_FMT),
        ("Klientlar", s.get("clients", 0), "0"),
        ("Qaytargan klientlar", s.get("returned_clients", 0), "0"),
        ("Haydovchilar", s.get("drivers", 0), "0"),
        ("Agentlar", s.get("agents", 0), "0"),
        ("Og‘irlik, kg", s.get("weight", 0), "#,##0.0"),
    ]
    head = ws.max_row + 1
    ws.append(["Ko‘rsatkich", "Qiymat"])
    for cell in ws[head]:
        cell.font = HEADER_FONT
        cell.fill = HEADER_FILL
    for label, value, fmt in kpis:
        ws.append([label, value])
        ws.cell(row=ws.max_row, column=2).number_format = fmt
    ws.column_dimensions["A"].width = 26
    ws.column_dimensions["B"].width = 34


def build_report_xlsx(
    sections: list[str],
    overview: dict,
    orders: list[dict] | None,
    meta: list[tuple[str, str]],
    generated_by: str,
    with_org: bool = False,
) -> bytes:
    wb = Workbook()
    _write_summary(wb, meta, overview.get("summary", {}), generated_by)
    for key in sections:
        if key not in SECTIONS:
            continue
        title, columns = SECTIONS[key]
        items = orders if key == "orders" else overview.get(key, [])
        if key == "orgs" and not items:
            continue
        _write_section(wb, title, columns, items or [], with_org and key not in ("orgs", "days", "statuses", "payments"))
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


# ---------- tizimdagi barcha ma’lumot (oqim bilan) ----------

COLUMN_LABELS = {
    "id": "ID",
    "org_id": "Tashkilot ID",
    "name": "Nomi",
    "code": "Kod",
    "phone": "Telefon",
    "address": "Manzil",
    "lat": "Latitude",
    "lng": "Longitude",
    "created_at": "Yaratilgan",
    "status": "Holat",
    "amount": "Summa",
    "weight_kg": "Og‘irlik, kg",
    "delivery_date": "Yetkazish sanasi",
    "client_id": "Klient ID",
    "driver_id": "Haydovchi ID",
    "warehouse_id": "Sklad ID",
    "agent_id": "Agent ID",
    "agent_code": "Agent kodi",
    "sales_rep": "Agent",
    "username": "Login",
    "full_name": "To‘liq ism",
    "role": "Rol",
    "is_active": "Faol",
    "proof_comment": "Haydovchi izohi",
    "proof_reason": "Tasdiq",
    "proof_photo": "Tasdiq rasmi",
    "proof_at": "Tasdiq vaqti",
}


def _header_cells(ws, titles: list[str]) -> list:
    cells = []
    for t in titles:
        c = WriteOnlyCell(ws, value=t)
        c.font = HEADER_FONT
        c.fill = HEADER_FILL
        cells.append(c)
    return cells


def _dump_model(wb: Workbook, title: str, model, query, extra: list[tuple[str, callable]] | None = None) -> int:
    ws = wb.create_sheet(title[:31])
    cols = [c for c in model.__table__.columns if c.name not in SECRET_COLUMNS]
    extra = extra or []
    titles = [COLUMN_LABELS.get(c.name, c.name) for c in cols] + [t for t, _ in extra]
    widths = [max(10, min(40, len(t) + 4)) for t in titles]
    for i, w in enumerate(widths, 1):
        ws.column_dimensions[get_column_letter(i)].width = w
    ws.freeze_panes = "A2"
    ws.append(_header_cells(ws, titles))
    n = 0
    for obj in query.yield_per(2000):
        ws.append([_clean(getattr(obj, c.name)) for c in cols] + [_clean(fn(obj)) for _, fn in extra])
        n += 1
    return n


def build_full_export(
    db: Session,
    org_id: int | None,
    *,
    include_users: bool,
    include_trash: bool,
    gps_days: int = 0,
    gps_cap: int = 200_000,
) -> bytes:
    """Tashkilot (yoki org_id=None bo‘lsa barcha tashkilotlar) ma’lumotlari, parol va tokenlarsiz."""
    wb = Workbook(write_only=True)

    def scoped(model):
        q = db.query(model)
        if org_id and hasattr(model, "org_id"):
            q = q.filter(model.org_id == org_id)
        return q.order_by(model.id.asc())

    clients = {cid: (code, name) for cid, code, name in scoped(Client).with_entities(Client.id, Client.code, Client.name)}
    drivers = {did: name for did, name in scoped(Driver).with_entities(Driver.id, Driver.name)}
    warehouses = {wid: name for wid, name in scoped(Warehouse).with_entities(Warehouse.id, Warehouse.name)}

    def _extra(o, key):
        try:
            data = json.loads(o.extra_json or "{}")
            return data.get(key, "") if isinstance(data, dict) else ""
        except (TypeError, ValueError):
            return ""

    counts: list[tuple[str, int]] = []
    orgs_q = db.query(Organization).order_by(Organization.id.asc())
    if org_id:
        orgs_q = orgs_q.filter(Organization.id == org_id)
    counts.append(("Tashkilotlar", _dump_model(wb, "Tashkilotlar", Organization, orgs_q)))
    counts.append(
        (
            "Zayavkalar",
            _dump_model(
                wb,
                "Zayavkalar",
                Order,
                scoped(Order),
                [
                    ("Hisobot sanasi", lambda o: order_day(o.delivery_date, o.created_at)),
                    ("Holat (nomi)", lambda o: STATUS_LABELS.get(o.status, o.status)),
                    ("Mijoz kodi", lambda o: clients.get(o.client_id, ("", ""))[0]),
                    ("Mijoz", lambda o: clients.get(o.client_id, ("", ""))[1]),
                    ("Haydovchi", lambda o: drivers.get(o.driver_id, "")),
                    ("Sklad", lambda o: warehouses.get(o.warehouse_id, "")),
                    ("To‘lov holati", lambda o: _payment_of(o.extra_json)),
                    ("Mijoz kodi (importdan)", lambda o: _extra(o, "client_code")),
                ],
            ),
        )
    )
    counts.append(("Klientlar", _dump_model(wb, "Klientlar", Client, scoped(Client))))
    counts.append(("Haydovchilar", _dump_model(wb, "Haydovchilar", Driver, scoped(Driver))))
    counts.append(("Agentlar", _dump_model(wb, "Agentlar", Agent, scoped(Agent))))
    counts.append(("Skladlar", _dump_model(wb, "Skladlar", Warehouse, scoped(Warehouse))))
    counts.append(("Kun rejalari", _dump_model(wb, "Kun rejalari", DayPlan, scoped(DayPlan))))
    counts.append(("Import shablonlari", _dump_model(wb, "Import shablonlari", ImportTemplate, scoped(ImportTemplate))))
    if include_users:
        counts.append(("Akkauntlar", _dump_model(wb, "Akkauntlar", User, scoped(User))))
    if include_trash:
        counts.append(("O‘chirilganlar", _dump_model(wb, "O‘chirilganlar", DeletedRecord, scoped(DeletedRecord))))
    if gps_days > 0:
        since = datetime.now(LOCAL_TZ) - timedelta(days=gps_days)
        gq = db.query(GpsPing).filter(GpsPing.recorded_at >= since)
        if org_id:
            gq = gq.join(Driver, Driver.id == GpsPing.driver_id).filter(Driver.org_id == org_id)
        gq = gq.order_by(GpsPing.id.asc()).limit(gps_cap)
        counts.append(
            (
                f"GPS (oxirgi {gps_days} kun)",
                _dump_model(wb, f"GPS {gps_days} kun", GpsPing, gq, [("Haydovchi", lambda p: drivers.get(p.driver_id, ""))]),
            )
        )

    ws = wb.create_sheet("Tarkib", 0)
    ws.column_dimensions["A"].width = 28
    ws.column_dimensions["B"].width = 14
    ws.append(_header_cells(ws, ["Varaq", "Qatorlar"]))
    for name, n in counts:
        ws.append([name, n])
    ws.append([])
    ws.append([f"Tuzildi: {datetime.now(LOCAL_TZ).strftime('%Y-%m-%d %H:%M')}"])
    ws.append(["Parollar va kirish tokenlari eksportga kiritilmaydi."])
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()
