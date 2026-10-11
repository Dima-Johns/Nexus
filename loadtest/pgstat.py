"""Yuklama vaqtida Postgres ulanishlari holatini ko'rsatadi."""
from common import pg_connect

with pg_connect() as c:
    rows = c.execute(
        "select state, wait_event_type, left(regexp_replace(query, '\\s+', ' ', 'g'), 100), count(*) "
        "from pg_stat_activity where datname = current_database() and pid <> pg_backend_pid() "
        "group by 1, 2, 3 order by 4 desc limit 15"
    ).fetchall()
    for r in rows:
        print(r)
