"""Ish kuni yuklamasi: 300 haydovchi + 100 dispetcher, bosqichma-bosqich 1x → 2x → 4x → 8x.

python loadtest/load.py [bosqich_soniyasi]
1x = haqiqiy kun: GPS har 30 s (ilova + fon xizmati), marshrut har 5 daqiqa, kuniga 3000 rasmli tasdiq
(eng gavjum soatda 2 barobar), dispetcher paneli xarita/statistika/zayavkalar/hisobotlarni yangilab turadi.
"""

import asyncio
import io
import json
import os
import random
import sys
import threading
import time
from datetime import date, timedelta

import httpx
import psutil
from PIL import Image, ImageFilter

from common import BASE, STATE, Stats, now_ms, save, show

PHASE_SECONDS = int(sys.argv[1]) if len(sys.argv) > 1 else 120
MULTIPLIERS = [int(x) for x in sys.argv[2].split(",")] if len(sys.argv) > 2 else [1, 2, 4, 8]
ADMIN_PASS = "Load-pass-123"
random.seed(7)

state = json.loads(STATE.read_text(encoding="utf-8"))
orgs = state["orgs"]
pending = {int(k): list(v) for k, v in state["today_orders"].items()}
drivers = [d for o in orgs for d in o["drivers"]]

phase = {"m": 1, "i": 0}
phase_stats = [Stats() for _ in MULTIPLIERS]
inflight = {"n": 0, "max": [0] * len(MULTIPLIERS)}


def make_photo() -> bytes:
    img = Image.effect_noise((1600, 1200), 22).convert("RGB").filter(ImageFilter.GaussianBlur(1.2))
    tint = Image.linear_gradient("L").resize((1600, 1200)).convert("RGB")
    img = Image.blend(img, tint, 0.5)
    buf = io.BytesIO()
    img.save(buf, "JPEG", quality=80)
    return buf.getvalue()


PHOTO = make_photo()


async def hit(client, name, method, url, token, **kw):
    stats = phase_stats[phase["i"]]
    inflight["n"] += 1
    inflight["max"][phase["i"]] = max(inflight["max"][phase["i"]], inflight["n"])
    t = now_ms()
    try:
        r = await client.request(method, url, headers={"Authorization": f"Bearer {token}"}, **kw)
        stats.add(name, now_ms() - t, r.status_code < 400, r.status_code, len(r.content))
        return r
    except Exception as e:
        stats.add(name, now_ms() - t, False, 599 if isinstance(e, httpx.TimeoutException) else 598)
    finally:
        inflight["n"] -= 1


def point():
    return {"lat": round(41.24 + random.random() * 0.16, 6), "lng": round(69.15 + random.random() * 0.2, 6),
            "accuracy": 8, "speed": random.random() * 12}


async def every(interval, fn):
    await asyncio.sleep(random.random() * interval)
    while not stop.is_set():
        asyncio.create_task(fn())
        await asyncio.sleep(interval / phase["m"] * random.uniform(0.85, 1.15))


async def proofs(client):
    # Kuniga 3000 tasdiq 10 soatga; eng gavjum soat ×2
    rate = 3000 / 36000 * 2
    while not stop.is_set():
        await asyncio.sleep(random.expovariate(rate * phase["m"]))
        d = random.choice(drivers)
        if not pending.get(d["id"]):
            continue
        oid = pending[d["id"]].pop()
        asyncio.create_task(hit(
            client, "POST proof (rasm)", "POST", f"/api/driver/orders/{oid}/proof", d["token"],
            data={"result": "delivered", "reason": "fridge_yes", "comment": ""},
            files={"photo": ("proof.jpg", PHOTO, "image/jpeg")},
        ))


def monitor(samples):
    server = next(
        (p for p in psutil.process_iter(["cmdline"]) if p.info["cmdline"] and any("server.py" in x for x in p.info["cmdline"])), None
    )
    pg = [p for p in psutil.process_iter(["name"]) if (p.info["name"] or "").lower().startswith("postgres")]
    for p in [server, *pg]:
        if p:
            try:
                p.cpu_percent(None)
            except psutil.Error:
                pass
    while not stop_thread.is_set():
        time.sleep(2)
        try:
            s_cpu = server.cpu_percent(None) if server else 0
            s_mem = server.memory_info().rss / 2**20 if server else 0
        except psutil.Error:
            s_cpu = s_mem = 0
        pg_cpu = 0.0
        for p in pg:
            try:
                pg_cpu += p.cpu_percent(None)
            except psutil.Error:
                pass
        samples[phase["i"]].append((s_cpu, s_mem, pg_cpu, psutil.cpu_percent(None)))


stop = asyncio.Event()
stop_thread = threading.Event()


async def main():
    limits = httpx.Limits(max_connections=3000, max_keepalive_connections=1000)
    async with httpx.AsyncClient(base_url=BASE, timeout=30, limits=limits) as client:
        dispatchers = []
        for o in orgs:
            for _ in range(2):
                r = await client.post("/api/auth/login", json={"username": f"adm{o['i']:02d}", "password": ADMIN_PASS, "org_code": o["code"]})
                dispatchers.append(r.json()["token"])
        tasks = []
        # Dispetcher manzil qidiruvi ham (Nominatim navbatida haydovchilar bilan birga)
        for tok in dispatchers[::10]:
            tasks.append(every(120, lambda tok=tok: hit(client, "GET /geo/search", "GET", "/api/geo/search?q=Chilonzor", tok)))

        for d in drivers:
            tok = d["token"]
            tasks.append(every(30, lambda tok=tok: hit(client, "POST /driver/location", "POST", "/api/driver/location", tok, json={"points": [point()]})))
            tasks.append(every(300, lambda tok=tok: hit(client, "POST /driver/sync", "POST", "/api/driver/sync", tok, json={"points": [point()]})))
        for tok in dispatchers:
            tasks.append(every(15, lambda tok=tok: hit(client, "GET /tracking/live", "GET", "/api/tracking/live", tok)))
            tasks.append(every(60, lambda tok=tok: hit(client, "GET /dashboard/stats", "GET", "/api/dashboard/stats", tok)))
            if os.getenv("LOAD_ORDERS_ALL"):
                tasks.append(every(60, lambda tok=tok: hit(client, "GET /orders (hammasi)", "GET", "/api/orders", tok)))
            else:
                # Panel endi standart «Bugun» filtri bo‘yicha faqat shu kunni so‘raydi
                day = date.today().isoformat()
                tasks.append(every(60, lambda tok=tok: hit(client, "GET /orders (bugun)", "GET",
                                                           f"/api/orders?date_from={day}&date_to={day}", tok)))
            tasks.append(every(60, lambda tok=tok: hit(client, "GET /drivers", "GET", "/api/drivers", tok)))
            # Hisobotlar sahifasi standart «Oxirgi 30 kun» bilan ochiladi
            rng = f"date_from={(date.today() - timedelta(days=29)).isoformat()}&date_to={date.today().isoformat()}"
            pivot_body = {"rows": ["driver"], "values": ["count", "amount"],
                          "date_from": (date.today() - timedelta(days=29)).isoformat(), "date_to": date.today().isoformat()}
            tasks.append(every(600, lambda tok=tok: hit(client, "GET /reports/overview", "GET", f"/api/reports/overview?{rng}", tok)))
            tasks.append(every(600, lambda tok=tok: hit(client, "GET /reports/orders", "GET", f"/api/reports/orders?limit=50&{rng}", tok)))
            tasks.append(every(900, lambda tok=tok: hit(client, "POST /reports/pivot", "POST", "/api/reports/pivot",
                                                         tok, json=pivot_body)))
        tasks.append(proofs(client))

        samples = [[] for _ in MULTIPLIERS]
        mon = threading.Thread(target=monitor, args=(samples,), daemon=True)
        mon.start()
        runners = [asyncio.create_task(t) for t in tasks]
        report = []
        for i, m in enumerate(MULTIPLIERS):
            phase["i"], phase["m"] = i, m
            print(f"\n>>> {m}x yuklama, {PHASE_SECONDS} s ...", flush=True)
            await asyncio.sleep(PHASE_SECONDS)
            rows = phase_stats[i].table(PHASE_SECONDS)
            total = sum(r["count"] for r in rows)
            errors = sum(r["errors"] for r in rows)
            smp = samples[i] or [(0, 0, 0, 0)]
            res = {
                "multiplier": m,
                "rps": round(total / PHASE_SECONDS, 1),
                "requests": total,
                "errors": errors,
                "server_cpu_avg": round(sum(s[0] for s in smp) / len(smp)),
                "server_cpu_max": round(max(s[0] for s in smp)),
                "server_mem_mb": round(max(s[1] for s in smp)),
                "pg_cpu_avg": round(sum(s[2] for s in smp) / len(smp)),
                "machine_cpu_avg": round(sum(s[3] for s in smp) / len(smp)),
                "max_inflight": inflight["max"][i],
                "endpoints": rows,
            }
            report.append(res)
            show(f"{m}x: {res['rps']} so‘rov/s, xato {errors}, server CPU o‘rt. {res['server_cpu_avg']}% "
                 f"(maks {res['server_cpu_max']}%), Postgres CPU {res['pg_cpu_avg']}%, xotira {res['server_mem_mb']} MB, "
                 f"bir vaqtdagi so‘rov maks {res['max_inflight']}", rows)
        stop.set()
        stop_thread.set()
        for r in runners:
            r.cancel()
        await asyncio.sleep(3)
        save("load", report)


asyncio.run(main())
