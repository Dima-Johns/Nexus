"""Ombor ishlamay qolganda haydovchi tasdig‘i to‘xtamasligini tekshiradi (rasm bazaga yoziladi)."""
import io
import json
import time

import httpx
from PIL import Image

from common import BASE, STATE, pg_connect

org = json.loads(STATE.read_text(encoding="utf-8"))["orgs"][7]
buf = io.BytesIO()
Image.new("RGB", (800, 600), "green").save(buf, "JPEG")
for n, drv in enumerate(org["drivers"][2:5], 1):
    with pg_connect() as db:
        oid = db.execute(
            "select id from orders where driver_id=%s order by id desc limit 1", (drv["id"],)
        ).fetchone()[0]
    t0 = time.perf_counter()
    r = httpx.post(f"{BASE}/api/driver/orders/{oid}/proof", headers={"Authorization": f"Bearer {drv['token']}"},
                   data={"result": "delivered", "reason": "fridge_yes"}, files={"photo": ("p.jpg", buf.getvalue(), "image/jpeg")},
                   timeout=120)
    took = time.perf_counter() - t0
    with pg_connect() as db:
        key, size = db.execute("select storage_key, length(data) from proof_photos where order_id=%s", (oid,)).fetchone()
    good = r.status_code == 200 and key == "" and size > 0
    print(f"{'OK ' if good else 'XATO'} ombor o‘chiq, {n}-topshiriq: {r.status_code} ({took:.1f} s), kalit '{key}', bazada {size} bayt")
