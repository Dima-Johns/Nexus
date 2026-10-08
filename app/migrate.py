from sqlalchemy import text

from .database import engine


def migrate_schema() -> None:
    statements = [
        "ALTER TABLE orders ADD COLUMN IF NOT EXISTS amount DOUBLE PRECISION DEFAULT 0",
        "ALTER TABLE orders ADD COLUMN IF NOT EXISTS route_code VARCHAR(80) DEFAULT ''",
        "ALTER TABLE orders ADD COLUMN IF NOT EXISTS extra_json TEXT DEFAULT '{}'",
        "ALTER TABLE orders ADD COLUMN IF NOT EXISTS sales_rep VARCHAR(160) DEFAULT ''",
        "ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_date VARCHAR(40) DEFAULT ''",
        "ALTER TABLE orders ALTER COLUMN code TYPE VARCHAR(80)",
        "ALTER TABLE orders ALTER COLUMN pickup_address TYPE VARCHAR(500)",
        "ALTER TABLE orders ALTER COLUMN dropoff_address TYPE VARCHAR(500)",
        "ALTER TABLE orders ALTER COLUMN cargo TYPE VARCHAR(255)",
        "ALTER TABLE clients ALTER COLUMN name TYPE VARCHAR(255)",
        "ALTER TABLE clients ALTER COLUMN company TYPE VARCHAR(255)",
        "ALTER TABLE clients ALTER COLUMN address TYPE VARCHAR(500)",
        "ALTER TABLE drivers ADD COLUMN IF NOT EXISTS username VARCHAR(80) DEFAULT ''",
        "ALTER TABLE drivers ADD COLUMN IF NOT EXISTS password_hash VARCHAR(128) DEFAULT ''",
        "ALTER TABLE drivers ADD COLUMN IF NOT EXISTS qr_token VARCHAR(64) DEFAULT ''",
        "ALTER TABLE session_tokens ALTER COLUMN user_id DROP NOT NULL",
        "ALTER TABLE session_tokens ADD COLUMN IF NOT EXISTS driver_id INTEGER",
        "ALTER TABLE agents ADD COLUMN IF NOT EXISTS code VARCHAR(2) DEFAULT ''",
        "ALTER TABLE agents ADD COLUMN IF NOT EXISTS code_locked BOOLEAN DEFAULT FALSE",
        "ALTER TABLE orders ADD COLUMN IF NOT EXISTS agent_code VARCHAR(2) DEFAULT ''",
        "ALTER TABLE orders ADD COLUMN IF NOT EXISTS window_start VARCHAR(8) DEFAULT ''",
        "ALTER TABLE orders ADD COLUMN IF NOT EXISTS window_end VARCHAR(8) DEFAULT ''",
        "ALTER TABLE orders ADD COLUMN IF NOT EXISTS stop_no INTEGER DEFAULT 0",
        """
        CREATE TABLE IF NOT EXISTS organizations (
            id SERIAL PRIMARY KEY,
            name VARCHAR(160) NOT NULL,
            code VARCHAR(32) DEFAULT '',
            is_active BOOLEAN DEFAULT TRUE,
            created_at TIMESTAMPTZ DEFAULT NOW()
        )
        """,
        "ALTER TABLE organizations ADD COLUMN IF NOT EXISTS address VARCHAR(300) DEFAULT ''",
        "ALTER TABLE organizations ADD COLUMN IF NOT EXISTS lat DOUBLE PRECISION",
        "ALTER TABLE organizations ADD COLUMN IF NOT EXISTS lng DOUBLE PRECISION",
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS org_id INTEGER",
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS idle_timeout_minutes INTEGER DEFAULT 30",
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS permissions_json TEXT DEFAULT '[]'",
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_key VARCHAR(32) DEFAULT ''",
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS lang VARCHAR(8) DEFAULT 'uz'",
        "ALTER TABLE session_tokens ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ DEFAULT NOW()",
        "ALTER TABLE clients ADD COLUMN IF NOT EXISTS org_id INTEGER",
        "ALTER TABLE agents ADD COLUMN IF NOT EXISTS org_id INTEGER",
        "ALTER TABLE drivers ADD COLUMN IF NOT EXISTS org_id INTEGER",
        "ALTER TABLE orders ADD COLUMN IF NOT EXISTS org_id INTEGER",
        "ALTER TABLE import_templates ADD COLUMN IF NOT EXISTS org_id INTEGER",
        "ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_code_key",
        "DROP INDEX IF EXISTS ux_agents_code",
        "CREATE UNIQUE INDEX IF NOT EXISTS ux_orders_org_code ON orders (org_id, code) WHERE org_id IS NOT NULL",
        "CREATE UNIQUE INDEX IF NOT EXISTS ux_agents_org_code ON agents (org_id, code) WHERE org_id IS NOT NULL AND COALESCE(code, '') <> ''",
        "ALTER TABLE drivers ADD COLUMN IF NOT EXISTS gps_at TIMESTAMPTZ",
        "ALTER TABLE drivers ADD COLUMN IF NOT EXISTS gps_accuracy DOUBLE PRECISION DEFAULT 0",
        "ALTER TABLE drivers ADD COLUMN IF NOT EXISTS seen_at TIMESTAMPTZ",
        "ALTER TABLE orders ADD COLUMN IF NOT EXISTS proof_reason VARCHAR(40) DEFAULT ''",
        "ALTER TABLE orders ADD COLUMN IF NOT EXISTS proof_photo VARCHAR(300) DEFAULT ''",
        "ALTER TABLE orders ADD COLUMN IF NOT EXISTS proof_comment VARCHAR(500) DEFAULT ''",
        "ALTER TABLE orders ADD COLUMN IF NOT EXISTS proof_at TIMESTAMPTZ",
        "ALTER TABLE drivers ADD COLUMN IF NOT EXISTS gps_address VARCHAR(500) DEFAULT ''",
        "ALTER TABLE drivers ADD COLUMN IF NOT EXISTS geo_lat DOUBLE PRECISION DEFAULT 0",
        "ALTER TABLE drivers ADD COLUMN IF NOT EXISTS geo_lng DOUBLE PRECISION DEFAULT 0",
        """
        CREATE TABLE IF NOT EXISTS gps_pings (
            id SERIAL PRIMARY KEY,
            driver_id INTEGER NOT NULL,
            lat DOUBLE PRECISION NOT NULL,
            lng DOUBLE PRECISION NOT NULL,
            heading DOUBLE PRECISION DEFAULT 0,
            accuracy DOUBLE PRECISION DEFAULT 0,
            speed DOUBLE PRECISION DEFAULT 0,
            offline_cached BOOLEAN DEFAULT FALSE,
            recorded_at TIMESTAMPTZ DEFAULT NOW(),
            received_at TIMESTAMPTZ DEFAULT NOW()
        )
        """,
        "CREATE INDEX IF NOT EXISTS ix_gps_pings_driver_time ON gps_pings (driver_id, recorded_at DESC)",
        """
        CREATE TABLE IF NOT EXISTS warehouses (
            id SERIAL PRIMARY KEY,
            org_id INTEGER,
            name VARCHAR(160) NOT NULL,
            address VARCHAR(500) DEFAULT '',
            lat DOUBLE PRECISION DEFAULT 41.3111,
            lng DOUBLE PRECISION DEFAULT 69.2797,
            is_default BOOLEAN DEFAULT FALSE,
            is_active BOOLEAN DEFAULT TRUE,
            created_at TIMESTAMPTZ DEFAULT NOW()
        )
        """,
        "ALTER TABLE orders ADD COLUMN IF NOT EXISTS warehouse_id INTEGER",
        "CREATE INDEX IF NOT EXISTS ix_orders_warehouse_id ON orders (warehouse_id)",
        "CREATE INDEX IF NOT EXISTS ix_warehouses_org_id ON warehouses (org_id)",
        """
        CREATE TABLE IF NOT EXISTS day_plans (
            id SERIAL PRIMARY KEY,
            org_id INTEGER,
            plan_date VARCHAR(10) NOT NULL,
            name VARCHAR(160) DEFAULT '',
            created_at TIMESTAMPTZ DEFAULT NOW(),
            updated_at TIMESTAMPTZ DEFAULT NOW()
        )
        """,
        "CREATE UNIQUE INDEX IF NOT EXISTS ux_day_plans_org_date ON day_plans (org_id, plan_date)",
        "ALTER TABLE clients ADD COLUMN IF NOT EXISTS code VARCHAR(80) DEFAULT ''",
        "ALTER TABLE clients ADD COLUMN IF NOT EXISTS lat DOUBLE PRECISION DEFAULT 0",
        "ALTER TABLE clients ADD COLUMN IF NOT EXISTS lng DOUBLE PRECISION DEFAULT 0",
        "ALTER TABLE clients ADD COLUMN IF NOT EXISTS sales_rep VARCHAR(160) DEFAULT ''",
        "ALTER TABLE clients ADD COLUMN IF NOT EXISTS agent_code VARCHAR(2) DEFAULT ''",
        "ALTER TABLE clients ADD COLUMN IF NOT EXISTS source VARCHAR(20) DEFAULT 'manual'",
        "CREATE INDEX IF NOT EXISTS ix_clients_org_code ON clients (org_id, code)",
        """
        CREATE TABLE IF NOT EXISTS app_migrations (
            key VARCHAR(80) PRIMARY KEY,
            applied_at TIMESTAMPTZ DEFAULT NOW()
        )
        """,
    ]
    with engine.begin() as conn:
        clients_had_code = conn.execute(
            text("SELECT 1 FROM information_schema.columns WHERE table_name = 'clients' AND column_name = 'code'")
        ).scalar()
        for sql in statements:
            conn.execute(text(sql))
        if not clients_had_code:
            _backfill_clients(conn)
        if _claim_once(conn, "clients_rebuild_from_orders_v1"):
            rebuild_clients(conn)
        conn.execute(
            text(
                """
                UPDATE orders
                SET sales_rep = extra_json::json->>'sales_rep'
                WHERE COALESCE(sales_rep, '') = ''
                  AND extra_json LIKE '%sales_rep%'
                """
            )
        )
        conn.execute(
            text(
                """
                UPDATE orders
                SET delivery_date = extra_json::json->>'delivery_date'
                WHERE COALESCE(delivery_date, '') = ''
                  AND extra_json LIKE '%delivery_date%'
                """
            )
        )
        conn.execute(
            text(
                """
                CREATE UNIQUE INDEX IF NOT EXISTS ux_drivers_username
                ON drivers (username) WHERE COALESCE(username, '') <> ''
                """
            )
        )
        conn.execute(
            text(
                """
                CREATE UNIQUE INDEX IF NOT EXISTS ux_drivers_qr_token
                ON drivers (qr_token) WHERE COALESCE(qr_token, '') <> ''
                """
            )
        )
        conn.execute(text("DROP INDEX IF EXISTS ux_agents_code"))
        # Eski global unique login indeksi — har tashkilotda o‘z «admin»i bo‘lishi uchun olib tashlanadi
        legacy = conn.execute(
            text("SELECT indexdef FROM pg_indexes WHERE tablename = 'users' AND indexname = 'ix_users_username'")
        ).scalar()
        if legacy and "UNIQUE" in legacy.upper():
            conn.execute(text("DROP INDEX ix_users_username"))
            conn.execute(text("CREATE INDEX ix_users_username ON users (username)"))
        conn.execute(text("ALTER TABLE users DROP CONSTRAINT IF EXISTS users_username_key"))
        conn.execute(text("CREATE UNIQUE INDEX IF NOT EXISTS ux_users_org_username ON users (org_id, username)"))


def _claim_once(conn, key: str) -> bool:
    return bool(
        conn.execute(
            text("INSERT INTO app_migrations (key) VALUES (:k) ON CONFLICT DO NOTHING RETURNING key"), {"k": key}
        ).scalar()
    )


def _client_key(code: str, name: str) -> str:
    code = (code or "").strip().lower()
    return f"c:{code}" if code else "n:" + " ".join((name or "").lower().split())


def rebuild_clients(conn, org_id: int | None = None) -> int:
    """Klientlar bazasini tozalab, zayavkalardan qayta yig‘adi: tashkilot zayavkadan, koordinata oxirgi GPS'li zayavkadan."""
    where = "WHERE o.org_id = :org" if org_id else ""
    params = {"org": org_id} if org_id else {}
    rows = conn.execute(
        text(
            f"""
            SELECT o.id, COALESCE(o.org_id, c.org_id) AS org_id, c.name, c.code, c.phone,
                   o.dropoff_address, o.dropoff_lat, o.dropoff_lng, o.sales_rep, o.agent_code, o.created_at
            FROM orders o JOIN clients c ON c.id = o.client_id
            {where}
            ORDER BY o.id
            """
        ),
        params,
    ).all()
    groups: dict[tuple, dict] = {}
    for r in rows:
        key = (r.org_id, _client_key(r.code, r.name))
        g = groups.setdefault(key, {"org_id": r.org_id, "orders": [], "created_at": r.created_at, "phone": ""})
        g["orders"].append(r.id)
        g["name"], g["code"] = r.name, (r.code or "").strip()
        g["phone"] = g["phone"] or (r.phone or "")
        if r.created_at and (not g["created_at"] or r.created_at < g["created_at"]):
            g["created_at"] = r.created_at
        if (r.dropoff_lat and r.dropoff_lng) or "lat" not in g:
            g.update(
                address=r.dropoff_address or "",
                lat=r.dropoff_lat or 0,
                lng=r.dropoff_lng or 0,
                sales_rep=r.sales_rep or "",
                agent_code=r.agent_code or "",
            )

    if org_id:
        conn.execute(text("UPDATE orders SET client_id = NULL WHERE org_id = :org"), params)
        conn.execute(
            text("UPDATE orders SET client_id = NULL WHERE client_id IN (SELECT id FROM clients WHERE org_id = :org)"),
            params,
        )
        conn.execute(text("DELETE FROM clients WHERE org_id = :org"), params)
    else:
        conn.execute(text("UPDATE orders SET client_id = NULL WHERE client_id IS NOT NULL"))
        conn.execute(text("DELETE FROM clients"))

    for g in groups.values():
        cid = conn.execute(
            text(
                """
                INSERT INTO clients (org_id, name, code, phone, company, address, lat, lng,
                                     sales_rep, agent_code, source, notes, created_at)
                VALUES (:org_id, :name, :code, :phone, '', :address, :lat, :lng,
                        :sales_rep, :agent_code, 'import', '', COALESCE(:created_at, NOW()))
                RETURNING id
                """
            ),
            {k: g[k] for k in ("org_id", "name", "code", "phone", "address", "lat", "lng", "sales_rep", "agent_code", "created_at")},
        ).scalar()
        conn.execute(text("UPDATE orders SET client_id = :cid WHERE id = ANY(:ids)"), {"cid": cid, "ids": g["orders"]})
    return len(groups)


def _backfill_clients(conn) -> None:
    """Bir martalik: avval importda mijoz kodi «company»ga yozilgan; koordinata va agentni oxirgi zayavkadan olamiz."""
    conn.execute(
        text(
            """
            UPDATE clients
            SET code = LEFT(company, 80), company = '', source = 'import'
            WHERE COALESCE(company, '') <> ''
              AND id IN (SELECT client_id FROM orders WHERE client_id IS NOT NULL)
            """
        )
    )
    conn.execute(
        text(
            """
            UPDATE clients c
            SET lat = o.dropoff_lat, lng = o.dropoff_lng,
                sales_rep = COALESCE(o.sales_rep, ''), agent_code = COALESCE(o.agent_code, ''),
                source = 'import'
            FROM (
                SELECT DISTINCT ON (client_id) client_id, dropoff_lat, dropoff_lng, sales_rep, agent_code
                FROM orders
                WHERE client_id IS NOT NULL
                ORDER BY client_id, (dropoff_lat <> 0) DESC, id DESC
            ) o
            WHERE c.id = o.client_id
            """
        )
    )
