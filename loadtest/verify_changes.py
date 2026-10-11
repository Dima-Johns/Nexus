"""O‘zgarishlarni tekshirish (yuklama serveri, nexus_load sxemasi):

1) /orders?date_from&date_to — panel filtri natijasi butun ro‘yxatdagi bilan aynan bir xil;
2) tasdiq rasmi omborga yoziladi, o‘qiladi, qayta yuborilganda eskisi o‘chadi.
"""

import io
import json
import re
import time
from datetime import date, timedelta

import httpx
from PIL import Image

from common import BASE, STATE, pg_connect
from s3check import BUCKET, s3

state = json.loads(STATE.read_text(encoding="utf-8"))
org = state["orgs"][5]
ok = True


def day_of(o):
    raw = str(o.get("delivery_date") or "")[:10]
    return raw if re.fullmatch(r"\d{4}-\d{2}-\d{2}", raw) else ""


def presets():
    t = date.today()
    first = t.replace(day=1)
    last_month_end = first - timedelta(days=1)
    return {
        "today": (t, t),
        "yesterday": (t - timedelta(days=1),) * 2,
        "tomorrow": (t + timedelta(days=1),) * 2,
        "last7": (t - timedelta(days=6), t),
        "last30": (t - timedelta(days=29), t),
        "this_month": (first, t),
        "last_month": (last_month_end.replace(day=1), last_month_end),
        "custom (200 kun oldin)": (t - timedelta(days=200),) * 2,
    }


with httpx.Client(base_url=BASE, timeout=300) as c:
    tok = c.post("/api/auth/login", json={"username": f"adm{org['i']:02d}", "password": "Load-pass-123", "org_code": org["code"]}).json()["token"]
    h = {"Authorization": f"Bearer {tok}"}
    t0 = time.perf_counter()
    full_resp = c.get("/api/orders", headers=h)
    full = full_resp.json()
    print(f"butun ro‘yxat: {len(full)} ta, {len(full_resp.content) / 2**20:.1f} MB, {time.perf_counter() - t0:.2f} s")
    for name, (a, b) in presets().items():
        t0 = time.perf_counter()
        r = c.get(f"/api/orders?date_from={a}&date_to={b}", headers=h)
        took = time.perf_counter() - t0
        part = r.json()
        want = {o["id"] for o in full if day_of(o) and a.isoformat() <= day_of(o) <= b.isoformat()}
        got = {o["id"] for o in part if day_of(o) and a.isoformat() <= day_of(o) <= b.isoformat()}
        same = want == got
        ok &= same
        print(f"{'OK ' if same else 'XATO'} {name:24} panelda {len(got):>5} ta | keldi {len(part):>5} ta, "
              f"{len(r.content) / 1024:>7.0f} KB, {took:.2f} s")
    bad = c.get("/api/orders?date_from=2026-13-40", headers=h)
    ok &= bad.status_code == 400
    print(f"{'OK ' if bad.status_code == 400 else 'XATO'} noto‘g‘ri sana -> {bad.status_code}")

    # 2) Rasm: omborga yozish, o‘qish, almashtirish
    drv = org["drivers"][0]
    with pg_connect() as db:
        oid = db.execute(
            "select id from orders where driver_id=%s order by id desc limit 1", (drv["id"],)
        ).fetchone()[0]
    def photo(color):
        buf = io.BytesIO()
        Image.new("RGB", (900, 700), color).save(buf, "JPEG", quality=90)
        return buf.getvalue()

    dh = {"Authorization": f"Bearer {drv['token']}"}
    with pg_connect() as db:
        prev = (db.execute("select storage_key from proof_photos where order_id=%s", (oid,)).fetchone() or [""])[0]
    before = {o["Key"] for o in s3.list_objects_v2(Bucket=BUCKET).get("Contents", [])}
    keys = []
    for color in ("red", "blue"):
        r = c.post(f"/api/driver/orders/{oid}/proof", headers=dh, data={"result": "delivered", "reason": "fridge_yes"},
                   files={"photo": ("p.jpg", photo(color), "image/jpeg")})
        with pg_connect() as db:
            key, size = db.execute("select storage_key, length(data) from proof_photos where order_id=%s", (oid,)).fetchone()
        keys.append(key)
        body = s3.get_object(Bucket=BUCKET, Key=key)["Body"].read() if key else b""
        pix = Image.open(io.BytesIO(body)).convert("RGB").getpixel((10, 10)) if body else None
        good = r.status_code == 200 and key and size == 0 and pix and (pix[0] > 200 if color == "red" else pix[2] > 200)
        ok &= bool(good)
        print(f"{'OK ' if good else 'XATO'} rasm ({color}): yuborish {r.status_code}, kalit {key}, bazada {size} bayt, "
              f"omborda {len(body) // 1024} KB, rang {pix}")
    time.sleep(1.5)
    names = {o["Key"] for o in s3.list_objects_v2(Bucket=BUCKET).get("Contents", [])}
    good = keys[0] not in names and keys[1] in names and (not prev or prev not in names) and len(names) == len(before - {prev}) + 1
    ok &= good
    print(f"{'OK ' if good else 'XATO'} almashtirilgan eski rasmlar ombordan o‘chdi, faqat oxirgisi turibdi ({len(before)} -> {len(names)})")

print("HAMMASI OK" if ok else "XATOLAR BOR")
