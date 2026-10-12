"""Zayavka tarixi + umumiy tozalash + serverdagi zaxiradan tiklash tekshiruvi (lokal server uchun).

Avval xavfsizlik uchun butun baza loadtest/results/ ga yuklab olinadi.
"""
import io
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import requests
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.auth import create_driver_token  # noqa: E402
from app.database import SessionLocal  # noqa: E402
from app.models import Driver  # noqa: E402

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8000/api"
PASSWORD = sys.argv[2] if len(sys.argv) > 2 else "admin123"
OUT = Path(__file__).resolve().parent / "results"
OUT.mkdir(exist_ok=True)
S = requests.Session()


def login():
    r = S.post(f"{BASE}/auth/login", json={"username": "admin", "password": PASSWORD})
    assert r.status_code == 200, r.text
    S.headers["Authorization"] = f"Bearer {r.json()['token']}"


def j(method, path, **kw):
    r = S.request(method, BASE + path, **kw)
    return r.status_code, (r.json() if r.headers.get("content-type", "").startswith("application/json") else r.content)


def counts():
    return {
        "orders": len(j("GET", "/orders")[1]),
        "clients": len(j("GET", "/clients/base")[1]),
        "drivers": len(j("GET", "/drivers")[1]),
        "agents": len(j("GET", "/agents")[1]),
    }


login()
safety = OUT / f"safety-{datetime.now():%Y%m%d-%H%M%S}.zip"
r = S.get(f"{BASE}/admin/backup")
assert r.status_code == 200
safety.write_bytes(r.content)
print("xavfsizlik nusxasi:", safety.name, len(r.content))

# --- Tarix ---
st, o = j("POST", "/orders", json={"pickup_address": "Sklad", "dropoff_address": "Tarix test do‘kon"})
assert st == 200, o
oid = o["id"]
tomorrow = (datetime.now() + timedelta(days=2)).strftime("%Y-%m-%d")
st, _ = j("POST", "/orders/bulk-date", json={"ids": [oid], "delivery_date": tomorrow})
assert st == 200, _
db = SessionLocal()
drv = db.query(Driver).filter(Driver.is_active.is_(True)).order_by(Driver.id).first()
drv_id = drv.id
dtoken = create_driver_token(db, drv)
db.commit()
db.close()
st, _ = j("POST", "/orders/reassign", json={"ids": [oid], "driver_id": drv_id})
assert st == 200, _

buf = io.BytesIO()
Image.new("RGB", (640, 480), (120, 160, 200)).save(buf, "JPEG")
shot = datetime.now(timezone.utc) - timedelta(minutes=3)
done = datetime.now(timezone.utc) - timedelta(minutes=2)
form = {"result": "delivered", "reason": "fridge_yes", "comment": "", "done_at": done.isoformat(), "photo_at": shot.isoformat()}
for attempt in range(2):
    r = requests.post(
        f"{BASE}/driver/orders/{oid}/proof",
        headers={"Authorization": f"Bearer {dtoken}"},
        data=form,
        files={"photo": ("p.jpg", buf.getvalue(), "image/jpeg")},
    )
    assert r.status_code == 200, r.text

st, h = j("GET", f"/orders/{oid}/history")
assert st == 200, h
kinds = [e["kind"] for e in h["events"]]
print("tarix:", kinds)
for k in ("created", "date", "reassigned", "photo", "photo_uploaded", "delivered"):
    assert k in kinds, k
assert kinds.count("delivered") == 1, "takroriy yuborishda tarix ikki marta yozildi"
photo = next(e for e in h["events"] if e["kind"] == "photo")
assert abs(datetime.fromisoformat(photo["at"]) - shot).total_seconds() < 2, photo
assert any(e["actor"] == "Administrator" or e["actor_type"] == "user" for e in h["events"])
assert all(e["actor_type"] == "driver" for e in h["events"] if e["kind"] in ("photo", "delivered"))

old = next((x for x in j("GET", "/orders")[1] if x["status"] == "delivered" and x["id"] != oid), None)
if old:
    st, h2 = j("GET", f"/orders/{old['id']}/history")
    print("eski zayavka tarixi:", [(e["kind"], e["derived"]) for e in h2["events"]])
assert j("GET", "/orders/999999999/history")[0] == 404

# --- Umumiy tozalash ---
before = counts()
print("oldin:", before)
st, sc = j("GET", "/admin/backup/wipe/scopes")
assert st == 200 and len(sc["items"]) == 7, sc
assert j("POST", "/admin/backup/wipe", json={"scopes": ["orders"], "confirm": "xato"})[0] == 400
assert j("POST", "/admin/backup/wipe", json={"scopes": [], "confirm": "TOZALASH"})[0] == 400
all_scopes = [i["key"] for i in sc["items"]]
st, w = j("POST", "/admin/backup/wipe", json={"scopes": all_scopes, "confirm": "TOZALASH"})
assert st == 200, w
print("o‘chirildi:", w["deleted"], "zaxira:", w["backup"])
bid = w["backup"]["id"]
after = counts()
print("keyin:", after)
assert after["orders"] == 0 and after["clients"] == 0 and after["drivers"] == 0 and after["agents"] == 0

st, saved = j("GET", "/admin/backup/saved")
assert any(b["id"] == bid and b["complete"] for b in saved["items"]), saved
r = S.get(f"{BASE}/admin/backup/saved/{bid}/download")
assert r.status_code == 200 and len(r.content) == w["backup"]["size"], (r.status_code, len(r.content))
assert r.content[:2] == b"PK"

assert j("POST", f"/admin/backup/saved/{bid}/restore", data={"confirm": "yoq"})[0] == 400
st, res = j("POST", f"/admin/backup/saved/{bid}/restore", data={"confirm": "TIKLASH"})
assert st == 200, res
login()
restored = counts()
print("tiklangandan keyin:", restored)
assert restored == before, (restored, before)
st, h3 = j("GET", f"/orders/{oid}/history")
assert st == 200 and [e["kind"] for e in h3["events"]] == kinds, "tarix tiklanmadi"
st, saved2 = j("GET", "/admin/backup/saved")
assert any(b["id"] == bid for b in saved2["items"]), "tiklash serverdagi zaxiralarni o‘chirib yubordi"

# Test izlarini tozalash
assert j("DELETE", f"/admin/backup/saved/{bid}")[0] == 200
assert j("DELETE", f"/orders/{oid}")[0] == 200
print("OK")
