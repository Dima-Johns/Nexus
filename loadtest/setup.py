"""50 tashkilot, 300 haydovchi, 300 agent, 30 kunlik tarix (kuniga 3000 zayavka) va bugungi 3000 zayavka.

python loadtest/setup.py
"""

import asyncio
import io
import json
import random
from datetime import date, datetime, timedelta, timezone

import httpx

from common import BASE, STATE, Stats, now_ms, pg_connect, save, show

ORGS = 50
DRIVERS_PER_ORG = 6
AGENTS_PER_ORG = 6
CLIENTS_PER_ORG = 100
ORDERS_PER_DAY = 3000
HISTORY_DAYS = 30
ADMIN_PASS = "Load-pass-123"
DRIVER_PASS = "drv-pass-123"
random.seed(42)


def rand_point():
    return round(41.24 + random.random() * 0.16, 6), round(69.15 + random.random() * 0.20, 6)


async def call(client, stats, name, method, url, token=None, **kw):
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    t = now_ms()
    r = await client.request(method, url, headers=headers, **kw)
    stats.add(name, now_ms() - t, r.status_code < 400, r.status_code, len(r.content))
    if r.status_code >= 400:
        raise RuntimeError(f"{name} {r.status_code} {r.text[:200]}")
    return r.json()


async def main():
    stats = Stats()
    async with httpx.AsyncClient(base_url=BASE, timeout=120, limits=httpx.Limits(max_connections=200)) as c:
        sup = await call(c, stats, "login superadmin", "POST", "/api/auth/login", json={"username": "admin", "password": "admin123"})
        stok = sup["token"]
        existing = {o["name"] for o in await call(c, stats, "GET /orgs", "GET", "/api/orgs", stok)}

        sem = asyncio.Semaphore(10)
        orgs = []

        async def make_org(i):
            name = f"Yuklama tashkilot {i:02d}"
            async with sem:
                if name in existing:
                    return
                lat, lng = rand_point()
                org = await call(
                    c, stats, "POST /orgs", "POST", "/api/orgs", stok,
                    json={"name": name, "admin_username": f"adm{i:02d}", "admin_password": ADMIN_PASS,
                          "admin_full_name": f"Admin {i:02d}", "address": "Toshkent", "lat": lat, "lng": lng},
                )
                orgs.append({"i": i, "id": org["id"], "code": org["code"]})

        t0 = now_ms()
        await asyncio.gather(*(make_org(i) for i in range(1, ORGS + 1)))
        print(f"tashkilotlar: {len(orgs)} ta, {(now_ms() - t0) / 1000:.1f} s")
        orgs.sort(key=lambda o: o["i"])

        async def fill_org(org):
            async with sem:
                lg = await call(c, stats, "login org admin", "POST", "/api/auth/login",
                                json={"username": f"adm{org['i']:02d}", "password": ADMIN_PASS, "org_code": org["code"]})
                tok = org["token"] = lg["token"]
                wlat, wlng = rand_point()
                wh = await call(c, stats, "POST /warehouses", "POST", "/api/warehouses", tok,
                                json={"name": f"Sklad {org['i']:02d}", "address": "Toshkent", "lat": wlat, "lng": wlng, "is_default": True})
                org["warehouse_id"] = wh["id"]
                agents = []
                for a in range(1, AGENTS_PER_ORG + 1):
                    ag = await call(c, stats, "POST /agents", "POST", "/api/agents", tok,
                                    json={"name": f"Agent {org['i']:02d}-{a}", "code": f"{a:02d}"})
                    agents.append({"id": ag["id"], "code": f"{a:02d}"})
                org["agents"] = agents
                drivers = []
                for d in range(1, DRIVERS_PER_ORG + 1):
                    ag = agents[(d - 1) % len(agents)]
                    dr = await call(c, stats, "POST /drivers", "POST", "/api/drivers", tok,
                                    json={"name": f"Haydovchi {org['i']:02d}-{d}", "phone": f"+99890{org['i']:02d}{d:05d}",
                                          "vehicle_plate": f"01A{org['i']:02d}{d}AA", "agent_id": ag["id"]})
                    login = f"o{org['i']:02d}d{d}"
                    await call(c, stats, "POST /drivers/{id}/access", "POST", f"/api/drivers/{dr['id']}/access", tok,
                               json={"username": login, "password": DRIVER_PASS})
                    drivers.append({"id": dr["id"], "login": login, "agent_code": ag["code"]})
                org["drivers"] = drivers

        t0 = now_ms()
        await asyncio.gather(*(fill_org(o) for o in orgs))
        print(f"sklad/agent/haydovchilar: {(now_ms() - t0) / 1000:.1f} s")

    # Klientlar va 30 kunlik tarix — to‘g‘ridan-to‘g‘ri bazaga (tez)
    t0 = now_ms()
    today = date.today()
    with pg_connect() as db:
        clients_by_org = {}
        for org in orgs:
            rows = []
            for k in range(CLIENTS_PER_ORG):
                lat, lng = rand_point()
                rows.append((org["id"], f"Do‘kon {org['i']:02d}-{k:03d}", f"C{org['i']:02d}{k:03d}", f"+99893{org['i']:02d}{k:05d}",
                             f"Toshkent, {k}-uy", lat, lng, org["agents"][k % AGENTS_PER_ORG]["code"]))
            with db.cursor() as cur:
                cur.executemany(
                    "insert into clients (org_id, name, code, phone, company, address, lat, lng, sales_rep, agent_code, source, notes, created_at)"
                    " values (%s,%s,%s,%s,'',%s,%s,%s,'',%s,'import','',now())",
                    rows,
                )
                cur.execute("select id, lat, lng, address, agent_code from clients where org_id=%s", (org["id"],))
                clients_by_org[org["id"]] = cur.fetchall()
        n = 0
        with db.cursor() as cur:
            with cur.copy(
                "copy orders (org_id, code, client_id, driver_id, warehouse_id, pickup_address, dropoff_address, pickup_lat, pickup_lng,"
                " dropoff_lat, dropoff_lng, cargo, weight_kg, amount, route_code, sales_rep, agent_code, delivery_date, window_start,"
                " window_end, extra_json, stop_no, status, eta_minutes, proof_reason, proof_photo, proof_comment, proof_at, created_at) from stdin"
            ) as cp:
                for day_back in range(HISTORY_DAYS, 0, -1):
                    day = today - timedelta(days=day_back)
                    for j in range(ORDERS_PER_DAY):
                        org = orgs[j % ORGS]
                        cl = random.choice(clients_by_org[org["id"]])
                        dr = org["drivers"][j % DRIVERS_PER_ORG]
                        st = "delivered" if random.random() < 0.9 else "returned"
                        done = datetime(day.year, day.month, day.day, 9, tzinfo=timezone.utc) + timedelta(minutes=random.randint(0, 540))
                        cp.write_row((
                            org["id"], f"H{day:%m%d}-{j}", cl[0], dr["id"], org["warehouse_id"], "Sklad", cl[3], 41.31, 69.28,
                            cl[1], cl[2], "Ichimliklar", round(random.uniform(5, 300), 1), round(random.uniform(1e5, 9e6), 2),
                            f"R{dr['id']}", "", cl[4], day.isoformat(), "", "", "{}", j // DRIVERS_PER_ORG % 60 + 1, st, 30,
                            "fridge_yes" if st == "delivered" else "returned", "", "" if st == "delivered" else "Do‘kon yopiq",
                            done, done - timedelta(hours=10),
                        ))
                        n += 1
        db.commit()
    print(f"tarix: {n} zayavka, {(now_ms() - t0) / 1000:.1f} s")

    # Bugungi 3000 zayavka — API orqali (dispetcher yaratgandek), 30 parallel
    async with httpx.AsyncClient(base_url=BASE, timeout=120, limits=httpx.Limits(max_connections=200)) as c:
        sem = asyncio.Semaphore(30)
        today_orders = {}

        async def make_order(j):
            org = orgs[j % ORGS]
            dr = org["drivers"][j % DRIVERS_PER_ORG]
            cl = random.choice(clients_by_org[org["id"]])
            async with sem:
                o = await call(c, stats, "POST /orders", "POST", "/api/orders", org["token"], json={
                    "client_id": cl[0], "driver_id": dr["id"], "pickup_address": "Sklad", "dropoff_address": cl[3],
                    "dropoff_lat": cl[1], "dropoff_lng": cl[2], "cargo": "Ichimliklar", "weight_kg": 40, "amount": 1500000,
                    "agent_code": cl[4], "delivery_date": today.isoformat(), "route_code": f"R{dr['id']}", "status": "assigned",
                })
                today_orders.setdefault(str(dr["id"]), []).append(o["id"])

        t0 = now_ms()
        await asyncio.gather(*(make_order(j) for j in range(ORDERS_PER_DAY)))
        took = (now_ms() - t0) / 1000
        print(f"bugungi zayavkalar: {sum(len(v) for v in today_orders.values())} ta, {took:.1f} s ({ORDERS_PER_DAY / took:.0f} ta/s)")

        # 300 haydovchi bir vaqtda kiradi (ertalab)
        sem = asyncio.Semaphore(300)
        drivers = [(o, d) for o in orgs for d in o["drivers"]]

        async def drv_login(o, d):
            async with sem:
                r = await call(c, stats, "driver-login (300 bir vaqtda)", "POST", "/api/auth/driver-login",
                               json={"username": d["login"], "password": DRIVER_PASS})
                d["token"] = r["token"]

        t0 = now_ms()
        await asyncio.gather(*(drv_login(o, d) for o, d in drivers))
        print(f"300 haydovchi kirishi: {(now_ms() - t0) / 1000:.1f} s")

    STATE.write_text(json.dumps({"orgs": orgs, "today_orders": today_orders}, ensure_ascii=False), encoding="utf-8")
    rows = stats.table()
    show("Sozlash bosqichi", rows)
    save("setup", rows)


asyncio.run(main())
