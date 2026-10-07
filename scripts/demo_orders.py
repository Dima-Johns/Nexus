"""Hisobotlarni tekshirish uchun o‘tgan kunlarga test zayavkalar yaratadi yoki o‘chiradi.

    python scripts/demo_orders.py create --start 2026-09-30 --days 7 --org 1
    python scripts/demo_orders.py delete --org 1

Test zayavkalar kodi «DEMO-» bilan boshlanadi va extra_json ichida "demo": true bo‘ladi,
shuning uchun ``delete`` faqat ularni o‘chiradi. Ishlatiladigan baza — .env dagi DATABASE_URL.
"""

import argparse
import json
import random
import shutil
import struct
import sys
import zlib
from collections import defaultdict
from datetime import date, datetime, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from app.api import UPLOAD_DIR  # noqa: E402
from app.database import SessionLocal  # noqa: E402
from app.dispatch import LOCAL_TZ  # noqa: E402
from app.models import Agent, Client, Driver, Order, Warehouse  # noqa: E402

PREFIX = "DEMO-"
PHOTO_DIR = UPLOAD_DIR / "proofs" / "demo"
RETURN_COMMENTS = [
    "Do‘kon yopiq",
    "Pul yo‘q",
    "Buyurtmadan voz kechdi",
    "Mahsulot shikastlangan",
    "Muddati o‘tgan",
    "Do‘kon yopiq, ertaga olib kelish so‘raldi",
    "Egasi yo‘q, sotuvchi qabul qilmadi",
    "Pul yo‘q, keyingi haftaga",
    "Narx kelishilmadi",
    "Noto‘g‘ri mahsulot yuborilgan",
]
PAYMENTS = [("Оплачено", 70), ("Не оплачено", 15), ("Частично", 8), ("Консигнация", 7)]
DELIVERED_REASONS = [("fridge_yes", 60), ("fridge_no", 30), ("foreign_goods", 10)]


def weighted(pairs):
    items, weights = zip(*pairs)
    return random.choices(items, weights=weights, k=1)[0]


def png_bytes(w: int, h: int, top: tuple, bottom: tuple, box: tuple) -> bytes:
    rows = bytearray()
    for y in range(h):
        t = y / max(1, h - 1)
        bg = bytes(int(top[i] + (bottom[i] - top[i]) * t) for i in range(3))
        inside_y = h * 0.3 <= y <= h * 0.75
        rows.append(0)
        for x in range(w):
            rows += bytes(box) if inside_y and w * 0.3 <= x <= w * 0.7 else bg

    def chunk(kind: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)

    head = struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", head) + chunk(b"IDAT", zlib.compress(bytes(rows), 6)) + chunk(b"IEND", b"")


def make_photos() -> list[str]:
    PHOTO_DIR.mkdir(parents=True, exist_ok=True)
    palette = [
        ((138, 109, 75), (61, 46, 31), (217, 195, 160)),
        ((70, 90, 120), (30, 40, 60), (200, 210, 225)),
        ((120, 60, 60), (50, 25, 25), (230, 200, 190)),
        ((80, 110, 80), (30, 50, 30), (210, 225, 200)),
        ((110, 100, 130), (45, 40, 60), (220, 215, 235)),
        ((150, 130, 90), (70, 60, 40), (240, 230, 200)),
    ]
    urls = []
    for i, (top, bottom, box) in enumerate(palette):
        name = f"proof_{i + 1}.png"
        (PHOTO_DIR / name).write_bytes(png_bytes(320, 240, top, bottom, box))
        urls.append(f"/uploads/proofs/demo/{name}")
    return urls


def is_demo(order: Order) -> bool:
    try:
        return bool(json.loads(order.extra_json or "{}").get("demo"))
    except (TypeError, ValueError):
        return False


def create(org_id: int, start: date, days: int, per_day: tuple[int, int], seed: int) -> None:
    random.seed(seed)
    db = SessionLocal()
    try:
        if db.query(Order).filter(Order.org_id == org_id, Order.code.like(f"{PREFIX}%")).count():
            sys.exit("Bu tashkilotda test zayavkalar allaqachon bor — avval «delete» qiling.")
        clients = db.query(Client).filter(Client.org_id == org_id, Client.lat != 0).all()
        drivers = db.query(Driver).filter(Driver.org_id == org_id, Driver.is_active.is_(True)).all()
        if not clients or not drivers:
            sys.exit("Tashkilotda GPS’li klient yoki haydovchi yo‘q.")
        wh = db.query(Warehouse).filter(Warehouse.org_id == org_id).order_by(Warehouse.is_default.desc()).first()
        agents = {a.id: a for a in db.query(Agent).filter(Agent.org_id == org_id).all()}
        drivers_by_code = defaultdict(list)
        for d in drivers:
            code = agents[d.agent_id].code if d.agent_id in agents else ""
            drivers_by_code[code].append(d)
        last_real = {}
        for o in db.query(Order).filter(Order.org_id == org_id, ~Order.code.like(f"{PREFIX}%")).all():
            last_real[o.client_id] = o
        photos = make_photos()
        # Har bir klientning o‘z «xarakteri»: ba’zilari ko‘p qaytaradi, ba’zilari katta xaridor
        profile = {c.id: (random.choice([0.02, 0.05, 0.05, 0.1, 0.1, 0.25]), random.uniform(0.4, 2.2)) for c in clients}
        regulars = random.sample(clients, k=min(len(clients), 120))

        total = 0
        stats = defaultdict(int)
        for day_i in range(days):
            day = start + timedelta(days=day_i)
            weekend = day.weekday() == 6
            n = random.randint(*per_day) // (3 if weekend else 1)
            pool = regulars * 2 + clients
            todays = []
            seen = set()
            while len(todays) < n:
                c = random.choice(pool)
                if c.id not in seen:
                    seen.add(c.id)
                    todays.append(c)
            stops = defaultdict(int)
            for k, c in enumerate(todays, 1):
                ret_rate, size = profile[c.id]
                ref = last_real.get(c.id)
                base = ref.amount if ref and ref.amount else random.uniform(300_000, 3_500_000)
                amount = round(max(50_000, base * size * random.uniform(0.6, 1.4)), 2)
                weight = round(max(5, amount / random.uniform(7_000, 11_000)), 2)
                candidates = drivers_by_code.get(c.agent_code or "") or drivers
                driver = random.choice(candidates)
                stops[driver.id] += 1
                agent_name = c.sales_rep or ""
                returned = random.random() < ret_rate
                status = "returned" if returned else "delivered"
                created = datetime.combine(day - timedelta(days=1), datetime.min.time(), LOCAL_TZ) + timedelta(
                    hours=random.randint(16, 21), minutes=random.randint(0, 59)
                )
                proof_at = datetime.combine(day, datetime.min.time(), LOCAL_TZ) + timedelta(
                    hours=9 + stops[driver.id] * 0.5 + random.uniform(0, 0.4)
                )
                extra = {
                    "demo": True,
                    "client_code": c.code or "",
                    "payment_status": weighted(PAYMENTS),
                }
                row = Order(
                    org_id=org_id,
                    code=f"{PREFIX}{day.strftime('%Y%m%d')}-{k:03d}",
                    client_id=c.id,
                    driver_id=driver.id,
                    warehouse_id=wh.id if wh else None,
                    pickup_address=wh.name if wh else "Sklad",
                    dropoff_address=c.address or c.name,
                    pickup_lat=wh.lat if wh else 41.31,
                    pickup_lng=wh.lng if wh else 69.28,
                    dropoff_lat=c.lat,
                    dropoff_lng=c.lng,
                    cargo=(ref.cargo if ref else "") or "ПРОДУКТОВЫЙ МАГАЗИН",
                    weight_kg=weight,
                    amount=amount,
                    route_code=(ref.route_code if ref else "") or "",
                    sales_rep=agent_name,
                    agent_code=c.agent_code or "",
                    delivery_date=day.isoformat(),
                    window_start="09:00",
                    window_end="18:00",
                    extra_json=json.dumps(extra, ensure_ascii=False),
                    stop_no=stops[driver.id],
                    status=status,
                    proof_reason="" if returned else weighted(DELIVERED_REASONS),
                    proof_photo=random.choice(photos),
                    proof_comment=random.choice(RETURN_COMMENTS) if returned else "",
                    proof_at=proof_at,
                    created_at=created,
                )
                db.add(row)
                total += 1
                stats[status] += 1
            print(f"{day.isoformat()} ({'yakshanba' if weekend else 'ish kuni'}): {len(todays)} ta")
        db.commit()
        print(f"Jami {total} ta test zayavka: yetkazildi {stats['delivered']}, qaytarildi {stats['returned']}")
    finally:
        db.close()


def delete(org_id: int) -> None:
    db = SessionLocal()
    try:
        rows = db.query(Order).filter(Order.org_id == org_id, Order.code.like(f"{PREFIX}%")).all()
        ids = [o.id for o in rows if is_demo(o)]
        if ids:
            db.query(Order).filter(Order.id.in_(ids)).delete(synchronize_session=False)
            db.commit()
        if PHOTO_DIR.exists():
            shutil.rmtree(PHOTO_DIR)
        print(f"O‘chirildi: {len(ids)} ta test zayavka")
    finally:
        db.close()


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("action", choices=["create", "delete"])
    p.add_argument("--org", type=int, default=1, help="tashkilot ID")
    p.add_argument("--start", default="", help="birinchi kun YYYY-MM-DD (sukut: 8 kun oldin)")
    p.add_argument("--days", type=int, default=7)
    p.add_argument("--min", type=int, default=45, help="kuniga kamida zayavka")
    p.add_argument("--max", type=int, default=75, help="kuniga ko‘pi bilan zayavka")
    p.add_argument("--seed", type=int, default=2026)
    a = p.parse_args()
    if a.action == "delete":
        delete(a.org)
        return
    today = datetime.now(LOCAL_TZ).date()
    start = date.fromisoformat(a.start) if a.start else today - timedelta(days=a.days + 1)
    if start + timedelta(days=a.days - 1) >= today:
        sys.exit("Faqat o‘tgan kunlar uchun yaratiladi — boshlanish sanasini oldinroq qiling.")
    create(a.org, start, max(1, a.days), (a.min, max(a.min, a.max)), a.seed)


if __name__ == "__main__":
    main()
