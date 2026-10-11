"""Hajm testlari: ertalabki to‘lqin, 1 yillik tarixli tashkilot, baza hajmi.

python loadtest/scale.py
"""

import asyncio
import json
import random
from datetime import date, datetime, timedelta, timezone

import httpx

from common import BASE, STATE, Stats, now_ms, pg_connect, save, show

state = json.loads(STATE.read_text(encoding="utf-8"))
orgs = state["orgs"]
drivers = [d for o in orgs for d in o["drivers"]]
ADMIN_PASS = "Load-pass-123"
out = {}


async def timed(client, stats, name, method, url, token, **kw):
    t = now_ms()
    try:
        r = await client.request(method, url, headers={"Authorization": f"Bearer {token}"}, **kw)
        stats.add(name, now_ms() - t, r.status_code < 400, r.status_code, len(r.content))
        return r
    except Exception:
        stats.add(name, now_ms() - t, False, 599)


def org_order_count(org_id):
    with pg_connect() as db:
        return db.execute("select count(*) from orders where org_id=%s", (org_id,)).fetchone()[0]


async def heavy_reads(client, label, org, tok, sup):
    stats = Stats()
    for _ in range(3):
        await timed(client, stats, "GET /orders (hammasi)", "GET", "/api/orders", tok)
        await timed(client, stats, "GET /dashboard/stats", "GET", "/api/dashboard/stats", tok)
        await timed(client, stats, "GET /reports/overview", "GET", "/api/reports/overview", tok)
        await timed(client, stats, "GET /reports/orders?limit=50", "GET", "/api/reports/orders?limit=50", tok)
        await timed(client, stats, "POST /reports/pivot", "POST", "/api/reports/pivot", tok,
                    json={"rows": ["driver"], "cols": ["status"], "values": ["count", "amount"]})
        await timed(client, stats, "GET /reports/export (Excel)", "GET", "/api/reports/export", tok)
        await timed(client, stats, "superadmin /reports/overview (50 tashkilot)", "GET", "/api/reports/overview", sup)
    rows = stats.table()
    show(f"{label}: tashkilotda {org_order_count(org['id'])} zayavka", rows)
    return rows


async def main():
    async with httpx.AsyncClient(base_url=BASE, timeout=120, limits=httpx.Limits(max_connections=1000)) as c:
        sup = (await c.post("/api/auth/login", json={"username": "admin", "password": "admin123"})).json()["token"]
        org = orgs[0]
        tok = (await c.post("/api/auth/login", json={"username": "adm01", "password": ADMIN_PASS, "org_code": org["code"]})).json()["token"]

        # 1) Ertalab 08:00 — 300 haydovchi bir vaqtda marshrutini yuklaydi
        stats = Stats()
        t0 = now_ms()
        await asyncio.gather(*(timed(c, stats, "300 haydovchi bir vaqtda /driver/sync", "POST", "/api/driver/sync", d["token"],
                                     json={"points": [{"lat": 41.3, "lng": 69.25}]}) for d in drivers))
        took = now_ms() - t0
        rows = stats.table()
        show(f"Ertalabki to‘lqin: hammasi {took / 1000:.1f} s da tugadi", rows)
        out["morning_burst"] = {"seconds": round(took / 1000, 1), "rows": rows}

        # 2) Hozirgi hajm (30 kun) bilan og‘ir o‘qishlar
        out["month"] = await heavy_reads(c, "1 oylik tarix", org, tok, sup)

        # 3) Shu tashkilotga yana 11 oylik tarix qo‘shiladi (kuniga 60 ta) — 1 yildan keyingi holat
        with pg_connect() as db:
            dr = org["drivers"]
            cl = db.execute("select id, lat, lng, address, agent_code from clients where org_id=%s", (org["id"],)).fetchall()
            today = date.today()
            with db.cursor() as cur, cur.copy(
                "copy orders (org_id, code, client_id, driver_id, warehouse_id, pickup_address, dropoff_address, pickup_lat, pickup_lng,"
                " dropoff_lat, dropoff_lng, cargo, weight_kg, amount, route_code, sales_rep, agent_code, delivery_date, window_start,"
                " window_end, extra_json, stop_no, status, eta_minutes, proof_reason, proof_photo, proof_comment, proof_at, created_at) from stdin"
            ) as cp:
                for back in range(31, 366):
                    day = today - timedelta(days=back)
                    for j in range(60):
                        c1 = random.choice(cl)
                        d = dr[j % len(dr)]
                        done = datetime(day.year, day.month, day.day, 10, tzinfo=timezone.utc)
                        cp.write_row((org["id"], f"Y{day:%y%m%d}-{j}", c1[0], d["id"], org["warehouse_id"], "Sklad", c1[3], 41.31, 69.28,
                                      c1[1], c1[2], "Ichimliklar", 50, 2_000_000, f"R{d['id']}", "", c1[4], day.isoformat(), "", "",
                                      "{}", j // 6 + 1, "delivered", 30, "fridge_yes", "", "", done, done))
            db.commit()
        out["year"] = await heavy_reads(c, "1 yillik tarix", org, tok, sup)

    # 4) Baza hajmi
    with pg_connect() as db:
        sizes = db.execute(
            "select relname, pg_total_relation_size(relid), n_live_tup from pg_stat_user_tables where schemaname='nexus_load'"
            " order by 2 desc limit 8"
        ).fetchall()
        photos = db.execute("select count(*), coalesce(avg(length(data)),0) from proof_photos").fetchone()
        orders_n = db.execute("select count(*) from orders").fetchone()[0]
        total = db.execute("select sum(pg_total_relation_size(relid)) from pg_stat_user_tables where schemaname='nexus_load'").fetchone()[0]
    out["db"] = {
        "tables": [(r[0], round(r[1] / 2**20, 1), r[2]) for r in sizes],
        "photos": photos[0],
        "photo_avg_kb": round(float(photos[1]) / 1024, 1),
        "orders": orders_n,
        "total_mb": round(total / 2**20, 1),
    }
    print("\n== Baza hajmi:", json.dumps(out["db"], ensure_ascii=False, default=float))
    save("scale", out)


asyncio.run(main())
