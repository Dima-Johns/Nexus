import asyncio
import json
import math
import os
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

from sqlalchemy import or_
from sqlalchemy.orm import Session, joinedload

from .database import SessionLocal
from .dispatch import local_today
from .models import DONE_STATUSES, Driver, GpsPing, Order

_task: asyncio.Task | None = None
LIVE_TTL = timedelta(seconds=90)
# Ilova har 60 soniyada signal yuboradi; 2.5 daqiqa jim bo‘lsa — offline
ONLINE_TTL = timedelta(seconds=150)
OSRM_URL = "https://router.project-osrm.org/route/v1/driving/"
NOMINATIM_URL = "https://nominatim.openstreetmap.org/reverse"
GEOCODE_MOVE_M = 60
_geo_lock = threading.Lock()
_geo_pending: set[int] = set()
_geo_last_call = 0.0


def _aware(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value


def parse_device_time(raw: str | None) -> datetime:
    now = datetime.now(timezone.utc)
    text = str(raw or "").strip()
    if not text:
        return now
    try:
        stamp = datetime.fromisoformat(text.replace("Z", "+00:00"))
        return _aware(stamp) or now
    except Exception:
        return now


def _step(driver: Driver) -> None:
    speed = 0.00028 if driver.status == "on_route" else 0.00004
    driver.heading = (driver.heading + (3 if driver.status == "on_route" else 0.4)) % 360
    rad = math.radians(driver.heading)
    driver.lat += math.cos(rad) * speed
    driver.lng += math.sin(rad) * speed
    driver.lat = min(max(driver.lat, 41.20), 41.42)
    driver.lng = min(max(driver.lng, 69.12), 69.40)
    if driver.lat in (41.20, 41.42) or driver.lng in (69.12, 69.40):
        driver.heading = (driver.heading + 140) % 360


async def simulate_loop() -> None:
    while True:
        db: Session = SessionLocal()
        try:
            for driver in db.query(Driver).filter(Driver.is_active.is_(True)).all():
                if driver.gps_at:
                    continue
                _step(driver)
            db.commit()
        finally:
            db.close()
        await asyncio.sleep(1.6)


def start_simulator() -> None:
    global _task
    if os.getenv("SIMULATE_GPS", "").strip().lower() not in {"1", "true", "yes", "on"}:
        return
    if _task is None or _task.done():
        _task = asyncio.create_task(simulate_loop())


def stop_simulator() -> None:
    global _task
    if _task and not _task.done():
        _task.cancel()
    _task = None


def _distance_m(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    r = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = p2 - p1
    dl = math.radians(lng2 - lng1)
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(h))


def _short_address(data: dict) -> str:
    addr = data.get("address") or {}
    road = addr.get("road") or addr.get("pedestrian") or addr.get("street") or ""
    house = addr.get("house_number") or ""
    area = (
        addr.get("neighbourhood")
        or addr.get("suburb")
        or addr.get("quarter")
        or addr.get("city_district")
        or ""
    )
    city = addr.get("city") or addr.get("town") or addr.get("village") or addr.get("county") or ""
    parts = [" ".join(x for x in (road, house) if x), area, city]
    text = ", ".join(p for p in parts if p)
    return (text or data.get("display_name") or "")[:500]


def reverse_geocode(lat: float, lng: float) -> str:
    global _geo_last_call
    query = urllib.parse.urlencode(
        {"lat": f"{lat:.6f}", "lon": f"{lng:.6f}", "format": "jsonv2", "zoom": 18, "accept-language": "uz,ru"}
    )
    with _geo_lock:
        # Nominatim: sekundiga 1 so‘rovdan oshmasin
        wait = 1.1 - (time.monotonic() - _geo_last_call)
        if wait > 0:
            time.sleep(wait)
        _geo_last_call = time.monotonic()
    try:
        req = urllib.request.Request(f"{NOMINATIM_URL}?{query}", headers={"User-Agent": "NexusLogistika/1.0"})
        with urllib.request.urlopen(req, timeout=6) as resp:
            return _short_address(json.loads(resp.read().decode("utf-8")))
    except (urllib.error.URLError, TimeoutError, ValueError, json.JSONDecodeError):
        return ""


def _geocode_job(driver_id: int, lat: float, lng: float) -> None:
    try:
        address = reverse_geocode(lat, lng)
        if not address:
            return
        db: Session = SessionLocal()
        try:
            row = db.query(Driver).filter(Driver.id == driver_id).first()
            if row:
                row.gps_address = address
                row.geo_lat = lat
                row.geo_lng = lng
                db.commit()
        finally:
            db.close()
    finally:
        with _geo_lock:
            _geo_pending.discard(driver_id)


def schedule_geocode(driver: Driver) -> None:
    lat, lng = float(driver.lat or 0), float(driver.lng or 0)
    if not (37 < lat < 46 and 55 < lng < 76):
        return
    glat, glng = float(driver.geo_lat or 0), float(driver.geo_lng or 0)
    if driver.gps_address and glat and _distance_m(lat, lng, glat, glng) < GEOCODE_MOVE_M:
        return
    with _geo_lock:
        if driver.id in _geo_pending:
            return
        _geo_pending.add(driver.id)
    threading.Thread(target=_geocode_job, args=(driver.id, lat, lng), daemon=True).start()


def ingest_gps(db: Session, driver: Driver, points: list) -> dict:
    if not points:
        return {"accepted": 0, "lat": driver.lat, "lng": driver.lng}
    now = datetime.now(timezone.utc)
    rows = []
    latest = None
    for item in points[-200:]:
        lat = float(getattr(item, "lat", 0) or 0)
        lng = float(getattr(item, "lng", 0) or 0)
        if not (37 < lat < 46 and 55 < lng < 76):
            continue
        recorded = parse_device_time(getattr(item, "recorded_at", None))
        ping = GpsPing(
            driver_id=driver.id,
            lat=lat,
            lng=lng,
            heading=float(getattr(item, "heading", 0) or 0),
            accuracy=float(getattr(item, "accuracy", 0) or 0),
            speed=float(getattr(item, "speed", 0) or 0),
            offline_cached=bool(getattr(item, "offline", False)),
            recorded_at=recorded,
            received_at=now,
        )
        rows.append(ping)
        if latest is None or recorded >= latest.recorded_at:
            latest = ping
    if not rows or latest is None:
        return {"accepted": 0, "lat": driver.lat, "lng": driver.lng}
    db.add_all(rows)
    driver.lat = latest.lat
    driver.lng = latest.lng
    driver.heading = latest.heading or driver.heading
    driver.gps_at = latest.recorded_at
    driver.gps_accuracy = latest.accuracy or 0
    db.flush()
    old = (
        db.query(GpsPing.id)
        .filter(GpsPing.driver_id == driver.id)
        .order_by(GpsPing.recorded_at.desc())
        .offset(400)
        .all()
    )
    if old:
        db.query(GpsPing).filter(GpsPing.id.in_([x[0] for x in old])).delete(synchronize_session=False)
        db.flush()
    schedule_geocode(driver)
    return {
        "accepted": len(rows),
        "lat": driver.lat,
        "lng": driver.lng,
        "gps_at": driver.gps_at.isoformat() if driver.gps_at else None,
    }


def osrm_geometry(coords: list[tuple[float, float]]) -> list[list[float]]:
    if len(coords) < 2:
        return [[c[0], c[1]] for c in coords]
    path = ";".join(f"{lng:.6f},{lat:.6f}" for lat, lng in coords[:80])
    url = f"{OSRM_URL}{path}?overview=full&geometries=geojson"
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "NexusLogistika/1.0"})
        with urllib.request.urlopen(req, timeout=8) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        geometry = (data.get("routes") or [{}])[0].get("geometry") or {}
        line = geometry.get("coordinates") or []
        return [[lat, lng] for lng, lat in line] or [[c[0], c[1]] for c in coords]
    except (urllib.error.URLError, TimeoutError, ValueError, json.JSONDecodeError, IndexError, KeyError):
        return [[c[0], c[1]] for c in coords]


def driver_active_orders(db: Session, driver: Driver, delivery_date: str | None = None) -> list[Order]:
    """Haydovchining yetkazilmagan zayavkalari. Sana berilsa shu kun; aks holda bugun va keyingi kunlar."""
    q = (
        db.query(Order)
        .options(joinedload(Order.client), joinedload(Order.driver), joinedload(Order.warehouse))
        .filter(
            Order.driver_id == driver.id,
            Order.status.notin_(DONE_STATUSES),
        )
    )
    today = local_today()
    day = (delivery_date or "").strip()[:10]
    if day and len(day) == 10:
        if day < today:
            return []
        q = q.filter(Order.delivery_date.startswith(day))
    else:
        q = q.filter(or_(Order.delivery_date >= today, Order.delivery_date.is_(None), Order.delivery_date == ""))
    return q.order_by(Order.delivery_date.asc(), Order.stop_no.asc(), Order.id.asc()).all()


def real_driver_point(driver: Driver) -> tuple[float, float] | None:
    if not getattr(driver, "gps_at", None):
        return None
    try:
        lat = float(driver.lat or 0)
        lng = float(driver.lng or 0)
    except (TypeError, ValueError):
        return None
    if 37 < lat < 46 and 55 < lng < 76:
        return (lat, lng)
    return None


def route_geometry_for(orders: list[Order], driver: Driver, warehouse=None) -> list[list[float]]:
    pts: list[tuple[float, float]] = []
    live = real_driver_point(driver)
    if driver.status == "on_route" and live:
        pts.append(live)
    elif warehouse is not None:
        try:
            wlat = float(getattr(warehouse, "lat", 0) or 0)
            wlng = float(getattr(warehouse, "lng", 0) or 0)
        except (TypeError, ValueError):
            wlat = wlng = 0
        if 37 < wlat < 46 and 55 < wlng < 76:
            pts.append((wlat, wlng))
    for order in orders:
        lat = float(order.dropoff_lat or 0)
        lng = float(order.dropoff_lng or 0)
        if 37 < lat < 46 and 55 < lng < 76:
            pts.append((lat, lng))
    if len(pts) < 2:
        return [[p[0], p[1]] for p in pts]
    return osrm_geometry(pts)


def tracking_payload(db: Session, org_id: int | None = None) -> dict:
    q = db.query(Driver).filter(Driver.is_active.is_(True))
    if org_id:
        q = q.filter(Driver.org_id == org_id)
    drivers = q.all()
    now = datetime.now(timezone.utc)
    vehicles = []
    online_count = 0
    for d in drivers:
        gps_at = _aware(d.gps_at)
        seen_at = _aware(getattr(d, "seen_at", None))
        live = bool(gps_at and now - gps_at <= LIVE_TTL)
        online = bool(seen_at and now - seen_at <= ONLINE_TTL)
        if online:
            online_count += 1
        has_location = bool(gps_at) and 37 < float(d.lat or 0) < 46 and 55 < float(d.lng or 0) < 76
        if has_location and not d.gps_address:
            schedule_geocode(d)
        vehicles.append(
            {
                "id": d.id,
                "name": d.name,
                "plate": d.vehicle_plate,
                "type": d.vehicle_type,
                "status": d.status,
                "lat": round(d.lat, 6),
                "lng": round(d.lng, 6),
                "heading": round(d.heading, 1),
                "agent_id": d.agent_id,
                "gps_at": gps_at.isoformat() if gps_at else None,
                "seen_at": seen_at.isoformat() if seen_at else None,
                "accuracy": round(float(d.gps_accuracy or 0), 1),
                "address": d.gps_address or "",
                "online": online,
                "has_location": has_location,
                "live": live,
                "stale": bool(gps_at and not live),
                "source": "device" if gps_at else "none",
            }
        )
    return {"ts": now.isoformat(), "online": online_count, "total": len(vehicles), "vehicles": vehicles}
