"""1 yillik ish holati: barcha tashkilotlarga 31..365 kunlik tarix (kuniga 3000 ta) qo'shiladi va o'lchanadi.

python year.py fill    — tarixni qo'shadi (1-tashkilotga scale.py allaqachon qo'shgan)
python year.py probe X — ertalabki to'lqin + og'ir o'qishlar, natija results/year_X.json
"""

import asyncio
import json
import random
import sys
from datetime import date, datetime, timedelta, timezone

import httpx

from common import BASE, STATE, Stats, now_ms, pg_connect, save, show

state = json.loads(STATE.read_text(encoding="utf-8"))
orgs = state["orgs"]
drivers = [d for o in orgs for d in o["drivers"]]
ADMIN_PASS = "Load-pass-123"


def fill():
    t0 = now_ms()
    n = 0
    today = date.today()
    with pg_connect() as db:
        clients = {}
        for org in orgs[1:]:
            clients[org["id"]] = db.execute(
                "select id, lat, lng, address, agent_code from clients where org_id=%s", (org["id"],)
            ).fetchall()
        with db.cursor() as cur, cur.copy(
            "copy orders (org_id, code, client_id, driver_id, warehouse_id, pickup_address, dropoff_address, pickup_lat, pickup_lng,"
            " dropoff_lat, dropoff_lng, cargo, weight_kg, amount, route_code, sales_rep, agent_code, delivery_date, window_start,"
            " window_end, extra_json, stop_no, status, eta_minutes, proof_reason, proof_photo, proof_comment, proof_at, created_at) from stdin"
        ) as cp:
            for back in range(31, 366):
                day = today - timedelta(days=back)
                for org in orgs[1:]:
                    cl_all = clients[org["id"]]
                    for j in range(60):
                        cl = random.choice(cl_all)
                        dr = org["drivers"][j % len(org["drivers"])]
                        st = "delivered" if random.random() < 0.9 else "returned"
                        done = datetime(day.year, day.month, day.day, 9, tzinfo=timezone.utc) + timedelta(minutes=random.randint(0, 540))
                        cp.write_row((
                            org["id"], f"Y{day:%y%m%d}-{j}", cl[0], dr["id"], org["warehouse_id"], "Sklad", cl[3], 41.31, 69.28,
                            cl[1], cl[2], "Ichimliklar", round(random.uniform(5, 300), 1), round(random.uniform(1e5, 9e6), 2),
                            f"R{dr['id']}", "", cl[4], day.isoformat(), "", "", "{}", j // 6 + 1, st, 30,
                            "fridge_yes" if st == "delivered" else "returned", "", "" if st == "delivered" else "Do‘kon yopiq",
                            done, done - timedelta(hours=10),
                        ))
                        n += 1
        db.commit()
        db.execute("analyze orders")
        total = db.execute("select count(*) from orders").fetchone()[0]
    print(f"qo'shildi {n} zayavka, {(now_ms() - t0) / 1000:.1f} s; jami orders: {total}")


async def timed(client, stats, name, method, url, token, **kw):
    t = now_ms()
    try:
        r = await client.request(method, url, headers={"Authorization": f"Bearer {token}"}, **kw)
        stats.add(name, now_ms() - t, r.status_code < 400, r.status_code, len(r.content))
    except Exception:
        stats.add(name, now_ms() - t, False, 599)


async def probe(label):
    out = {}
    async with httpx.AsyncClient(base_url=BASE, timeout=120, limits=httpx.Limits(max_connections=1000)) as c:
        org = orgs[5]
        tok = (await c.post("/api/auth/login", json={"username": f"adm{org['i']:02d}", "password": ADMIN_PASS,
                                                     "org_code": org["code"]})).json()["token"]
        stats = Stats()
        t0 = now_ms()
        await asyncio.gather(*(timed(c, stats, "300 haydovchi bir vaqtda /driver/sync", "POST", "/api/driver/sync", d["token"],
                                     json={"points": [{"lat": 41.3, "lng": 69.25}]}) for d in drivers))
        took = now_ms() - t0
        rows = stats.table()
        show(f"[{label}] ertalabki to‘lqin: {took / 1000:.1f} s", rows)
        out["burst"] = {"seconds": round(took / 1000, 1), "rows": rows}

        stats = Stats()
        for d in drivers[:60]:
            await timed(c, stats, "bitta /driver/sync (navbatsiz)", "POST", "/api/driver/sync", d["token"],
                        json={"points": [{"lat": 41.3, "lng": 69.25}]})
            await timed(c, stats, "bitta /driver/location (navbatsiz)", "POST", "/api/driver/location", d["token"],
                        json={"lat": 41.3, "lng": 69.25, "accuracy": 10})
        for _ in range(3):
            await timed(c, stats, "GET /orders (hammasi)", "GET", "/api/orders", tok)
            await timed(c, stats, "GET /dashboard/stats", "GET", "/api/dashboard/stats", tok)
            await timed(c, stats, "GET /reports/overview", "GET", "/api/reports/overview", tok)
            await timed(c, stats, "GET /reports/orders?limit=50", "GET", "/api/reports/orders?limit=50", tok)
        rows = stats.table()
        show(f"[{label}] ketma-ket so‘rovlar", rows)
        out["serial"] = rows
    save(f"year_{label}", out)


if sys.argv[1] == "fill":
    fill()
else:
    asyncio.run(probe(sys.argv[2]))
