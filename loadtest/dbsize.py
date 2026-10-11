"""Sinov sxemasidagi jadvallar hajmi; `reset` argumenti bilan 1-tashkilotning yillik (Y...) tarixini o'chiradi."""
import json
import sys

from common import STATE, pg_connect

with pg_connect() as db:
    if len(sys.argv) > 1 and sys.argv[1] == "reset":
        org1 = json.loads(STATE.read_text(encoding="utf-8"))["orgs"][0]["id"]
        n = db.execute("delete from orders where org_id=%s and code like 'Y%%'", (org1,)).rowcount
        db.commit()
        print(f"o'chirildi: {n}")
    rows = db.execute(
        "select relname, pg_total_relation_size(relid), n_live_tup from pg_stat_user_tables"
        " where schemaname='nexus_load' order by 2 desc limit 8"
    ).fetchall()
    for name, size, live in rows:
        print(f"{name:20} {size / 2**20:8.1f} MB  {live} qator")
    total = db.execute("select sum(pg_total_relation_size(relid)) from pg_stat_user_tables where schemaname='nexus_load'").fetchone()[0]
    print(f"jami: {int(total) / 2**20:.1f} MB; orders: {db.execute('select count(*) from orders').fetchone()[0]}")
