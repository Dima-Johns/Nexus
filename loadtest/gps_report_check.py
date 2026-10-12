"""GPS hisobot tekshiruvi: sintetik kun (sklad, klient, noma’lum joy, signal yo‘q, qisqa to‘xtash, davom etayotgan to‘xtash).

python loadtest/gps_report_check.py make   — test haydovchi + nuqtalar + tekshiruvlar (brauzerda ko‘rish uchun qoladi)
python loadtest/gps_report_check.py drop   — hammasini o‘chirish
"""
import io
import json
import math
import random
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import requests
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.auth import create_driver_token  # noqa: E402
from app.database import SessionLocal  # noqa: E402
from app.dispatch import local_today  # noqa: E402
from app.models import Driver, GpsPing, SessionToken  # noqa: E402

BASE = "http://127.0.0.1:8000/api"
STATE = Path(__file__).resolve().parent / "results" / "gps_report.json"
rnd = random.Random(7)


def admin():
    s = requests.Session()
    t = s.post(f"{BASE}/auth/login", json={"username": "admin", "password": "admin123"}).json()["token"]
    s.headers["Authorization"] = f"Bearer {t}"
    return s


def shift(lat, lng, east_m, north_m):
    return lat + north_m / 111_320, lng + east_m / (111_320 * math.cos(math.radians(lat)))


def jit(lat, lng, m=8):
    return shift(lat, lng, rnd.uniform(-m, m), rnd.uniform(-m, m))


def pt(t, lat, lng, acc=12):
    return {"lat": lat, "lng": lng, "accuracy": acc, "speed": 0, "heading": 0, "recorded_at": t.astimezone(timezone.utc).isoformat()}


def line(t1, a, b, minutes):
    out = []
    for i in range(1, minutes):
        f = i / minutes
        out.append(pt(t1 + timedelta(minutes=i), a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f))
    return out


def check(cond, msg):
    if not cond:
        raise AssertionError(msg)
    print("  ✓", msg)


def make():
    s = admin()
    whs = s.get(f"{BASE}/warehouses").json()
    wh = next(w for w in whs if 37 < float(w["lat"]) < 46)
    W = (float(wh["lat"]), float(wh["lng"]))
    A = shift(*W, 4000, 3000)
    B = shift(*A, -2500, 1500)
    C = shift(*B, 8000, -6000)
    D = shift(*C, 1500, 900)

    drv = s.post(f"{BASE}/drivers", json={"name": "GPS Test haydovchi", "vehicle_plate": "01 T 777 TT", "phone": ""}).json()
    db = SessionLocal()
    token = create_driver_token(db, db.get(Driver, drv["id"]))
    db.commit()
    db.close()
    dh = {"Authorization": f"Bearer {token}"}

    now = datetime.now(timezone.utc).replace(microsecond=0)
    t0 = now - timedelta(minutes=240)
    wh_pts = [pt(t0 + timedelta(minutes=i), *jit(*W)) for i in range(0, 41)]
    wh_pts.insert(20, pt(t0 + timedelta(minutes=19, seconds=30), *shift(*W, 500, 0)))
    pts = list(wh_pts)
    pts += line(t0 + timedelta(minutes=40), W, A, 20)
    pts += [pt(t0 + timedelta(minutes=60 + i), *jit(*A)) for i in range(0, 6)]
    pts.append(pt(t0 + timedelta(minutes=85), *shift(*A, 15, 0)))
    pts += line(t0 + timedelta(minutes=85), A, B, 15)
    pts += [pt(t0 + timedelta(minutes=100 + i), *jit(*B)) for i in range(0, 9)]
    pts += [pt(t0 + timedelta(minutes=150), *shift(*B, 7000, -5000))]
    pts += line(t0 + timedelta(minutes=150), shift(*B, 7000, -5000), C, 10)
    pts += [pt(t0 + timedelta(minutes=160 + i), *jit(*C)) for i in range(0, 4)]
    pts += line(t0 + timedelta(minutes=163), C, D, 12)
    pts += [pt(t0 + timedelta(minutes=175 + i), *jit(*D)) for i in range(0, 65)]

    o = s.post(
        f"{BASE}/orders",
        json={"pickup_address": wh["name"], "dropoff_address": "GPS test klient do‘koni", "dropoff_lat": A[0], "dropoff_lng": A[1]},
    ).json()
    s.post(f"{BASE}/orders/bulk-date", json={"ids": [o["id"]], "delivery_date": local_today()})
    s.post(f"{BASE}/orders/reassign", json={"ids": [o["id"]], "driver_id": drv["id"]})
    STATE.write_text(json.dumps({"driver": drv["id"], "order": o["id"], "token": token}))

    for i in range(0, len(pts), 50):
        r = requests.post(f"{BASE}/driver/location", headers=dh, json={"points": pts[i : i + 50]})
        r.raise_for_status()
    r = requests.post(f"{BASE}/driver/location", headers=dh, json={"points": wh_pts})
    check(r.json()["accepted"] == 0, "takroriy nuqtalar qayta yozilmadi")
    db = SessionLocal()
    n = db.query(GpsPing).filter(GpsPing.driver_id == drv["id"]).count()
    d = db.get(Driver, drv["id"])
    check(n == len(pts), f"bazada {n} ta nuqta (yuborilgan noyob: {len(pts)})")
    check(abs(d.lat - pts[-1]["lat"]) < 1e-6, "kechikkan eski paket joriy joylashuvni orqaga qaytarmadi")
    db.close()

    buf = io.BytesIO()
    Image.new("RGB", (320, 240), (90, 140, 90)).save(buf, "JPEG")
    done = t0 + timedelta(minutes=63)
    r = requests.post(
        f"{BASE}/driver/orders/{o['id']}/proof",
        headers=dh,
        data={"result": "delivered", "reason": "foreign_goods", "comment": "", "done_at": done.isoformat(), "photo_at": done.isoformat()},
        files={"photo": ("p.jpg", buf.getvalue(), "image/jpeg")},
    )
    r.raise_for_status()

    rep = s.get(f"{BASE}/gps/report", params={"driver_id": drv["id"], "date_from": local_today(), "min_stop": 5}).json()
    items = [it for day in rep["days"] for it in day["items"]]
    stops = [it for it in items if it["type"] == "stop"]
    gaps = [it for it in items if it["type"] == "gap"]
    mins = [round(x["seconds"] / 60) for x in stops]
    print("  to‘xtashlar (daq):", mins, [x["place"]["kind"] or "?" for x in stops])
    check(len(stops) == 4, "4 ta to‘xtash: sklad, klient, noma’lum joy, hozirgi joy (3 daqiqalik hisobga olinmadi)")
    check(stops[0]["place"]["kind"] == "warehouse" and 39 <= mins[0] <= 41, "1) skladda ~40 daqiqa (sakragan nuqta to‘xtashni bo‘lmadi)")
    check(stops[1]["place"]["kind"] == "client" and 24 <= mins[1] <= 26, "2) klientda ~25 daqiqa (signal jim bo‘lgan vaqt ham kiradi)")
    check(any(x["done_here"] for x in stops[1]["place"]["orders"]), "2) shu to‘xtashda yakunlangan zayavka ko‘rsatildi")
    check(7 <= mins[2] <= 9, "3) noma’lum joyda ~8 daqiqa")
    check(stops[3].get("ongoing") is True, "4) oxirgi to‘xtash «hozir ham shu yerda»")
    check(len(gaps) == 1 and 41 <= round(gaps[0]["seconds"] / 60) <= 43, "signal yo‘q oraliq ~42 daqiqa")
    check(rep["summary"]["distance_m"] > 8000, f"yurgan yo‘li {rep['summary']['distance_m'] / 1000:.1f} km")
    check(len(rep["track"]) >= len(pts) - 2, f"xarita uchun trek: {len(rep['track'])} nuqta")

    rep10 = s.get(f"{BASE}/gps/report", params={"driver_id": drv["id"], "date_from": local_today(), "min_stop": 10}).json()
    check(rep10["summary"]["stops"] == 3, "min 10 daqiqa: 8 daqiqalik to‘xtash chiqmaydi")

    allr = s.get(f"{BASE}/gps/report", params={"date_from": local_today()}).json()
    row = next(r for r in allr["drivers"] if r["driver"]["id"] == drv["id"])
    check(allr["mode"] == "all" and row["summary"]["stops"] == 4, "barcha haydovchilar rejimi")

    x = s.get(f"{BASE}/gps/report.xlsx", params={"driver_id": drv["id"], "date_from": local_today()})
    check(x.status_code == 200 and x.content[:2] == b"PK", f"Excel ({len(x.content)} bayt)")
    check(s.get(f"{BASE}/gps/report", params={"driver_id": drv["id"], "date_from": "2026-01-01", "date_to": "2026-03-01"}).status_code == 400, "40+ kun — 400")
    check(s.get(f"{BASE}/gps/report", params={"date_from": "2026-01-01", "date_to": "2026-01-20"}).status_code == 400, "barcha haydovchilar 7+ kun — 400")
    check(requests.get(f"{BASE}/gps/report").status_code == 401, "tokensiz — 401")
    print("OK")


def drop():
    st = json.loads(STATE.read_text())
    s = admin()
    s.delete(f"{BASE}/orders/{st['order']}")
    s.delete(f"{BASE}/drivers/{st['driver']}")
    db = SessionLocal()
    db.query(SessionToken).filter(SessionToken.token == st["token"]).delete()
    left = db.query(GpsPing).filter(GpsPing.driver_id == st["driver"]).count()
    db.commit()
    db.close()
    STATE.unlink()
    print("o‘chirildi; qolgan nuqta:", left)


if __name__ == "__main__":
    {"make": make, "drop": drop}[sys.argv[1]]()
