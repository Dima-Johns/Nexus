"""Yangi orders indekslarini sinov sxemasida o'chirish/yaratish: python idx.py drop|create"""
import sys

from common import pg_connect

INDEXES = {
    "ix_orders_driver_id": "orders (driver_id)",
    "ix_orders_client_id": "orders (client_id)",
    "ix_orders_org_date": "orders (org_id, delivery_date)",
}

with pg_connect() as db:
    for name, target in INDEXES.items():
        if sys.argv[1] == "drop":
            db.execute(f"drop index if exists {name}")
        else:
            db.execute(f"create index if not exists {name} on {target}")
    db.execute("analyze orders")
    db.commit()
print(sys.argv[1], "ok")
