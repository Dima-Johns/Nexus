"""Brauzerda tarix oynasini ko‘rish uchun: bugungi sanada to‘liq tarixli yakunlangan test zayavka (make | drop)."""
import io
import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import requests
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.auth import create_driver_token  # noqa: E402
from app.database import SessionLocal  # noqa: E402
from app.dispatch import local_today  # noqa: E402
from app.models import Driver, SessionToken  # noqa: E402

BASE = "http://127.0.0.1:8000/api"
STATE = Path(__file__).resolve().parent / "results" / "history_ui.json"


def admin():
    s = requests.Session()
    t = s.post(f"{BASE}/auth/login", json={"username": "admin", "password": "admin123"}).json()["token"]
    s.headers["Authorization"] = f"Bearer {t}"
    return s


def make():
    s = admin()
    o = s.post(f"{BASE}/orders", json={"pickup_address": "Asosiy sklad", "dropoff_address": "Chilonzor 9-kvartal, 12-uy"}).json()
    s.post(f"{BASE}/orders/bulk-date", json={"ids": [o["id"]], "delivery_date": local_today()})
    db = SessionLocal()
    drv = db.query(Driver).filter(Driver.is_active.is_(True)).order_by(Driver.id).first()
    drv_id, token = drv.id, create_driver_token(db, drv)
    db.commit()
    db.close()
    s.post(f"{BASE}/orders/reassign", json={"ids": [o["id"]], "driver_id": drv_id})
    buf = io.BytesIO()
    Image.new("RGB", (640, 480), (90, 140, 90)).save(buf, "JPEG")
    now = datetime.now(timezone.utc)
    r = requests.post(
        f"{BASE}/driver/orders/{o['id']}/proof",
        headers={"Authorization": f"Bearer {token}"},
        data={"result": "delivered", "reason": "foreign_goods", "comment": "Do‘konda boshqa firma mahsuloti bor", "done_at": now.isoformat(), "photo_at": (now - timedelta(seconds=40)).isoformat()},
        files={"photo": ("p.jpg", buf.getvalue(), "image/jpeg")},
    )
    r.raise_for_status()
    STATE.write_text(json.dumps({"order": o["id"], "token": token}))
    print(o["id"], o["code"])


def drop():
    st = json.loads(STATE.read_text())
    admin().delete(f"{BASE}/orders/{st['order']}")
    db = SessionLocal()
    db.query(SessionToken).filter(SessionToken.token == st["token"]).delete()
    db.commit()
    db.close()
    STATE.unlink()
    print("o‘chirildi")


if __name__ == "__main__":
    {"make": make, "drop": drop}[sys.argv[1]]()
