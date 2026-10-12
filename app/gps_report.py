"""Haydovchi GPS tarixidan hisobot: qayerda va qancha turgani, harakat va signal yo‘q bo‘lgan vaqtlar."""

from __future__ import annotations

import io
from dataclasses import dataclass
from datetime import date, datetime, timedelta

from sqlalchemy import and_, or_
from sqlalchemy.orm import Session, joinedload

from .dispatch import LOCAL_TZ, local_now
from .models import Client, Driver, GpsPing, Order, Warehouse
from .tracking import _aware, _distance_m

STOP_RADIUS_M = 80
BAD_ACCURACY_M = 300
GAP_SEC = 20 * 60
OUTLIER_SEC = 3 * 60
MERGE_GAP_SEC = 5 * 60
ORDER_RADIUS_M = 150
WAREHOUSE_RADIUS_M = 200
CLIENT_RADIUS_M = 100
MAX_SPEED_MS = 50
TRACK_MAX = 4000
ONGOING_SEC = 10 * 60
MAX_DAYS_ONE = 31
MAX_DAYS_ALL = 7


@dataclass
class Pt:
    t: datetime
    lat: float
    lng: float
    acc: float


def parse_range(date_from: str, date_to: str, max_days: int) -> tuple[date, date]:
    today = local_now().date()
    try:
        d1 = date.fromisoformat((date_from or "").strip()[:10]) if date_from else today
        d2 = date.fromisoformat((date_to or "").strip()[:10]) if date_to else d1
    except ValueError as exc:
        raise ValueError("Sana noto‘g‘ri") from exc
    if d2 < d1:
        d1, d2 = d2, d1
    if (d2 - d1).days + 1 > max_days:
        raise ValueError(f"Oraliq {max_days} kundan oshmasin")
    return d1, d2


def _bounds(d1: date, d2: date) -> tuple[datetime, datetime]:
    start = datetime.combine(d1, datetime.min.time(), tzinfo=LOCAL_TZ)
    end = datetime.combine(d2 + timedelta(days=1), datetime.min.time(), tzinfo=LOCAL_TZ)
    return start, end


def load_points(db: Session, driver_ids: list[int], start: datetime, end: datetime) -> dict[int, list[Pt]]:
    out: dict[int, list[Pt]] = {i: [] for i in driver_ids}
    if not driver_ids:
        return out
    rows = (
        db.query(GpsPing.driver_id, GpsPing.recorded_at, GpsPing.lat, GpsPing.lng, GpsPing.accuracy)
        .filter(GpsPing.driver_id.in_(driver_ids), GpsPing.recorded_at >= start, GpsPing.recorded_at < end)
        .order_by(GpsPing.driver_id.asc(), GpsPing.recorded_at.asc(), GpsPing.id.asc())
        .all()
    )
    raw: dict[int, list[Pt]] = {i: [] for i in driver_ids}
    for did, t, lat, lng, acc in rows:
        if t is None:
            continue
        raw[did].append(Pt(_aware(t).astimezone(LOCAL_TZ), float(lat), float(lng), float(acc or 0)))
    for did, pts in raw.items():
        good = [p for p in pts if p.acc <= 0 or p.acc <= BAD_ACCURACY_M]
        if len(good) < max(2, len(pts) // 5):
            good = pts
        seen: set[int] = set()
        uniq = []
        for p in good:
            key = int(p.t.timestamp())
            if key in seen:
                continue
            seen.add(key)
            uniq.append(p)
        out[did] = uniq
    return out


def _clusters(points: list[Pt]) -> list[list[Pt]]:
    """Ketma-ket nuqtalar markazdan STOP_RADIUS_M ichida bo‘lsa — bitta joy. Bitta “sakragan” nuqta shovqin deb tashlanadi."""
    out: list[list[Pt]] = []
    if not points:
        return out
    cur = [points[0]]
    clat, clng = points[0].lat, points[0].lng
    i, n = 1, len(points)
    while i < n:
        p = points[i]
        if _distance_m(clat, clng, p.lat, p.lng) <= STOP_RADIUS_M:
            k = len(cur)
            clat = (clat * k + p.lat) / (k + 1)
            clng = (clng * k + p.lng) / (k + 1)
            cur.append(p)
        else:
            nxt = points[i + 1] if i + 1 < n else None
            if (
                nxt is not None
                and len(cur) >= 2
                and (nxt.t - p.t).total_seconds() <= OUTLIER_SEC
                and _distance_m(clat, clng, nxt.lat, nxt.lng) <= STOP_RADIUS_M
            ):
                i += 1
                continue
            out.append(cur)
            cur = [p]
            clat, clng = p.lat, p.lng
        i += 1
    out.append(cur)
    return out


def _center(pts: list[Pt]) -> tuple[float, float]:
    return sum(p.lat for p in pts) / len(pts), sum(p.lng for p in pts) / len(pts)


def _path_m(pts: list[Pt]) -> float:
    total = 0.0
    for a, b in zip(pts, pts[1:]):
        d = _distance_m(a.lat, a.lng, b.lat, b.lng)
        sec = max(1.0, (b.t - a.t).total_seconds())
        if d / sec <= MAX_SPEED_MS:
            total += d
    return total


def _secs(a: datetime, b: datetime) -> int:
    return max(0, int((b - a).total_seconds()))


def _day_items(points: list[Pt], min_stop_s: int) -> list[dict]:
    clusters = _clusters(points)
    marks: list[tuple[str, list[Pt]]] = []
    for c in clusters:
        if _secs(c[0].t, c[-1].t) >= min_stop_s:
            # Bir joyda turib, bir-ikki daqiqaga chetga chiqib qaytgan bo‘lsa — bitta to‘xtash
            prev, between = None, []
            if len(marks) >= 2 and marks[-1][0] == "move" and marks[-2][0] == "stop":
                prev, between = marks[-2][1], marks[-1][1]
            elif marks and marks[-1][0] == "stop":
                prev = marks[-1][1]
            if prev is not None:
                plat, plng = _center(prev)
                clat, clng = _center(c)
                if _secs(prev[-1].t, c[0].t) <= MERGE_GAP_SEC and _distance_m(plat, plng, clat, clng) <= STOP_RADIUS_M * 1.5:
                    prev.extend(between)
                    prev.extend(c)
                    if between:
                        marks.pop()
                    continue
            marks.append(("stop", c))
        else:
            if marks and marks[-1][0] == "move":
                marks[-1][1].extend(c)
            else:
                marks.append(("move", list(c)))

    items: list[dict] = []
    for idx, (kind, pts) in enumerate(marks):
        if kind == "stop":
            lat, lng = _center(pts)
            silent = sum(_secs(a.t, b.t) for a, b in zip(pts, pts[1:]) if _secs(a.t, b.t) >= GAP_SEC)
            items.append(
                {
                    "type": "stop",
                    "start": pts[0].t,
                    "end": pts[-1].t,
                    "lat": round(lat, 6),
                    "lng": round(lng, 6),
                    "points": len(pts),
                    "silent_sec": silent,
                }
            )
            continue
        # Harakat oldingi to‘xtash oxiridan keyingi to‘xtash boshigacha hisoblanadi
        path = list(pts)
        if idx > 0 and marks[idx - 1][0] == "stop":
            path.insert(0, marks[idx - 1][1][-1])
        if idx + 1 < len(marks) and marks[idx + 1][0] == "stop":
            path.append(marks[idx + 1][1][0])
        seg = [path[0]]
        for a, b in zip(path, path[1:]):
            if _secs(a.t, b.t) >= GAP_SEC and _distance_m(a.lat, a.lng, b.lat, b.lng) > STOP_RADIUS_M:
                if len(seg) > 1:
                    items.append(_move(seg))
                items.append(
                    {
                        "type": "gap",
                        "start": a.t,
                        "end": b.t,
                        "lat": round(a.lat, 6),
                        "lng": round(a.lng, 6),
                        "to_lat": round(b.lat, 6),
                        "to_lng": round(b.lng, 6),
                        "distance_m": round(_distance_m(a.lat, a.lng, b.lat, b.lng)),
                    }
                )
                seg = [b]
            else:
                seg.append(b)
        if len(seg) > 1:
            items.append(_move(seg))
    for it in items:
        it["seconds"] = _secs(it["start"], it["end"])
    return [it for it in items if it["type"] != "move" or it["seconds"] > 0 or it.get("distance_m", 0) > 0]


def _move(seg: list[Pt]) -> dict:
    return {
        "type": "move",
        "start": seg[0].t,
        "end": seg[-1].t,
        "lat": round(seg[0].lat, 6),
        "lng": round(seg[0].lng, 6),
        "to_lat": round(seg[-1].lat, 6),
        "to_lng": round(seg[-1].lng, 6),
        "distance_m": round(_path_m(seg)),
        "points": len(seg),
    }


def _summary(items: list[dict], points: list[Pt]) -> dict:
    stops = [i for i in items if i["type"] == "stop"]
    moves = [i for i in items if i["type"] == "move"]
    gaps = [i for i in items if i["type"] == "gap"]
    return {
        "points": len(points),
        "first_at": points[0].t.isoformat() if points else None,
        "last_at": points[-1].t.isoformat() if points else None,
        "stops": len(stops),
        "stop_sec": sum(i["seconds"] for i in stops),
        "move_sec": sum(i["seconds"] for i in moves),
        "gap_sec": sum(i["seconds"] for i in gaps),
        "distance_m": sum(i.get("distance_m", 0) for i in moves),
        "longest_stop_sec": max((i["seconds"] for i in stops), default=0),
    }


def _merge_summaries(parts: list[dict]) -> dict:
    out = {"points": 0, "first_at": None, "last_at": None, "stops": 0, "stop_sec": 0, "move_sec": 0, "gap_sec": 0, "distance_m": 0, "longest_stop_sec": 0}
    for s in parts:
        for k in ("points", "stops", "stop_sec", "move_sec", "gap_sec", "distance_m"):
            out[k] += s[k]
        out["longest_stop_sec"] = max(out["longest_stop_sec"], s["longest_stop_sec"])
        if s["first_at"] and (not out["first_at"] or s["first_at"] < out["first_at"]):
            out["first_at"] = s["first_at"]
        if s["last_at"] and (not out["last_at"] or s["last_at"] > out["last_at"]):
            out["last_at"] = s["last_at"]
    return out


def _by_day(points: list[Pt]) -> dict[str, list[Pt]]:
    days: dict[str, list[Pt]] = {}
    for p in points:
        days.setdefault(p.t.strftime("%Y-%m-%d"), []).append(p)
    return days


class _Places:
    """To‘xtash joyini nomlash: shu haydovchining zayavka klienti, sklad yoki klientlar bazasidagi eng yaqin nuqta."""

    def __init__(self, db: Session, driver: Driver, d1: date, d2: date, stops: list[dict]):
        self.orders: list[Order] = []
        self.warehouses: list[Warehouse] = []
        self.clients: list[Client] = []
        if not stops:
            return
        start, end = _bounds(d1 - timedelta(days=1), d2 + timedelta(days=1))
        lo, hi = (d1 - timedelta(days=1)).isoformat(), (d2 + timedelta(days=1)).isoformat() + "~"
        self.orders = (
            db.query(Order)
            .options(joinedload(Order.client))
            .filter(
                Order.driver_id == driver.id,
                or_(and_(Order.proof_at >= start, Order.proof_at < end), and_(Order.delivery_date >= lo, Order.delivery_date <= hi)),
            )
            .limit(5000)
            .all()
        )
        self.warehouses = db.query(Warehouse).filter(Warehouse.org_id == driver.org_id).all()
        lats = [s["lat"] for s in stops]
        lngs = [s["lng"] for s in stops]
        pad = 0.003
        self.clients = (
            db.query(Client)
            .filter(
                Client.org_id == driver.org_id,
                Client.lat.between(min(lats) - pad, max(lats) + pad),
                Client.lng.between(min(lngs) - pad, max(lngs) + pad),
            )
            .limit(20000)
            .all()
        )

    @staticmethod
    def _near(lat, lng, rows, getter, radius):
        best, best_d = None, radius + 1
        for r in rows:
            plat, plng = getter(r)
            if not (37 < plat < 46 and 55 < plng < 76):
                continue
            if abs(plat - lat) > 0.01 or abs(plng - lng) > 0.01:
                continue
            d = _distance_m(lat, lng, plat, plng)
            if d < best_d:
                best, best_d = r, d
        return (best, round(best_d)) if best is not None else (None, None)

    def describe(self, stop: dict) -> dict:
        lat, lng = stop["lat"], stop["lng"]
        place = {"kind": "", "name": "", "address": "", "distance_m": None}
        near_orders = [
            o
            for o in self.orders
            if abs(float(o.dropoff_lat or 0) - lat) < 0.01
            and abs(float(o.dropoff_lng or 0) - lng) < 0.01
            and _distance_m(lat, lng, float(o.dropoff_lat), float(o.dropoff_lng)) <= ORDER_RADIUS_M
        ]
        lo = stop["start"] - timedelta(minutes=5)
        hi = stop["end"] + timedelta(minutes=5)
        done_here = [
            o for o in self.orders if o.proof_at and lo <= _aware(o.proof_at).astimezone(LOCAL_TZ) <= hi
        ]
        o, d = self._near(lat, lng, near_orders, lambda r: (float(r.dropoff_lat), float(r.dropoff_lng)), ORDER_RADIUS_M)
        if o is not None:
            place = {
                "kind": "client",
                "name": (o.client.name if o.client else "") or o.code,
                "address": o.dropoff_address or "",
                "distance_m": d,
            }
        else:
            w, d = self._near(lat, lng, self.warehouses, lambda r: (float(r.lat or 0), float(r.lng or 0)), WAREHOUSE_RADIUS_M)
            if w is not None:
                place = {"kind": "warehouse", "name": w.name, "address": w.address or "", "distance_m": d}
            else:
                c, d = self._near(lat, lng, self.clients, lambda r: (float(r.lat or 0), float(r.lng or 0)), CLIENT_RADIUS_M)
                if c is not None:
                    place = {"kind": "client_base", "name": c.name, "address": c.address or "", "distance_m": d}
        orders = {o.id: o for o in near_orders + done_here}
        return {
            **place,
            "orders": [
                {
                    "id": o.id,
                    "code": o.code,
                    "client": o.client.name if o.client else "",
                    "status": o.status,
                    "proof_at": _aware(o.proof_at).astimezone(LOCAL_TZ).isoformat() if o.proof_at else None,
                    "done_here": o in done_here,
                }
                for o in sorted(orders.values(), key=lambda x: (x.proof_at is None, x.proof_at or datetime.min.replace(tzinfo=LOCAL_TZ)))
            ][:20],
        }


def _iso_items(items: list[dict]) -> list[dict]:
    out = []
    for it in items:
        row = dict(it)
        row["start"] = it["start"].isoformat()
        row["end"] = it["end"].isoformat()
        out.append(row)
    return out


def _thin_track(points: list[Pt]) -> list[list]:
    step = max(1, len(points) // TRACK_MAX + (1 if len(points) % TRACK_MAX else 0))
    pts = points[::step]
    if points and pts[-1] is not points[-1]:
        pts.append(points[-1])
    return [[round(p.lat, 6), round(p.lng, 6), int(p.t.timestamp())] for p in pts]


def driver_out(d: Driver) -> dict:
    return {"id": d.id, "name": d.name, "plate": d.vehicle_plate or "", "phone": d.phone or ""}


def driver_report(db: Session, driver: Driver, d1: date, d2: date, min_stop_min: int) -> dict:
    start, end = _bounds(d1, d2)
    points = load_points(db, [driver.id], start, end)[driver.id]
    min_stop_s = max(1, int(min_stop_min)) * 60
    now = local_now()
    days = []
    all_stops: list[dict] = []
    per_day: list[tuple[str, list[Pt], list[dict]]] = []
    for day, pts in sorted(_by_day(points).items()):
        items = _day_items(pts, min_stop_s)
        per_day.append((day, pts, items))
        all_stops.extend(i for i in items if i["type"] == "stop")
    places = _Places(db, driver, d1, d2, all_stops)
    n = 0
    for day, pts, items in per_day:
        for it in items:
            if it["type"] != "stop":
                continue
            n += 1
            it["no"] = n
            it.update(place=places.describe(it))
        if items and items[-1]["type"] == "stop" and (now - items[-1]["end"]).total_seconds() <= ONGOING_SEC:
            items[-1]["ongoing"] = True
        days.append({"date": day, "summary": _summary(items, pts), "items": _iso_items(items)})
    return {
        "mode": "one",
        "driver": driver_out(driver),
        "date_from": d1.isoformat(),
        "date_to": d2.isoformat(),
        "min_stop": int(min_stop_min),
        "summary": _merge_summaries([d["summary"] for d in days]),
        "days": days,
        "track": _thin_track(points),
        "generated_at": now.isoformat(),
    }


def drivers_overview(db: Session, drivers: list[Driver], d1: date, d2: date, min_stop_min: int) -> dict:
    start, end = _bounds(d1, d2)
    pts_by = load_points(db, [d.id for d in drivers], start, end)
    min_stop_s = max(1, int(min_stop_min)) * 60
    rows = []
    for d in drivers:
        pts = pts_by.get(d.id) or []
        parts = []
        for _, day_pts in sorted(_by_day(pts).items()):
            parts.append(_summary(_day_items(day_pts, min_stop_s), day_pts))
        rows.append({"driver": driver_out(d), "summary": _merge_summaries(parts)})
    rows.sort(key=lambda r: (-(r["summary"]["points"] > 0), r["driver"]["name"].lower()))
    return {
        "mode": "all",
        "date_from": d1.isoformat(),
        "date_to": d2.isoformat(),
        "min_stop": int(min_stop_min),
        "drivers": rows,
        "generated_at": local_now().isoformat(),
    }


TYPE_LABELS = {"stop": "To‘xtash", "move": "Harakat", "gap": "Signal yo‘q"}
PLACE_LABELS = {"client": "Klient (zayavka)", "warehouse": "Sklad", "client_base": "Klient (baza)"}


def _hm(sec: int) -> str:
    sec = int(sec or 0)
    h, m = divmod(sec // 60, 60)
    return f"{h} soat {m} daq" if h else f"{m} daq"


def report_xlsx(reports: list[dict]) -> bytes:
    from openpyxl import Workbook
    from openpyxl.styles import Font

    wb = Workbook()
    ws = wb.active
    ws.title = "GPS hisobot"
    head = [
        "Haydovchi",
        "Raqam",
        "Sana",
        "№",
        "Turi",
        "Boshlanish",
        "Tugash",
        "Davomiyligi",
        "Daqiqa",
        "Joy",
        "Joy turi",
        "Manzil",
        "Masofa (km)",
        "Zayavkalar",
        "Koordinata",
    ]
    ws.append(head)
    for c in ws[1]:
        c.font = Font(bold=True)
    for rep in reports:
        drv = rep["driver"]
        for day in rep["days"]:
            for it in day["items"]:
                place = it.get("place") or {}
                orders = ", ".join(
                    f"{o['code']}{' ✓' if o.get('done_here') else ''}" for o in (place.get("orders") or [])
                )
                ws.append(
                    [
                        drv["name"],
                        drv["plate"],
                        day["date"],
                        it.get("no") or "",
                        TYPE_LABELS.get(it["type"], it["type"]),
                        it["start"][11:16],
                        it["end"][11:16],
                        _hm(it["seconds"]),
                        round(it["seconds"] / 60, 1),
                        place.get("name", ""),
                        PLACE_LABELS.get(place.get("kind", ""), ""),
                        place.get("address", ""),
                        round(it.get("distance_m", 0) / 1000, 2) if it["type"] != "stop" else "",
                        orders,
                        f"{it['lat']}, {it['lng']}",
                    ]
                )
    widths = [22, 12, 11, 5, 12, 10, 10, 14, 9, 30, 16, 40, 11, 30, 22]
    for i, w in enumerate(widths):
        ws.column_dimensions[chr(65 + i)].width = w
    ws.freeze_panes = "A2"
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()
