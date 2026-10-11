import json
import os
import statistics
import sys
import time
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
BASE = os.getenv("LOAD_BASE", "http://127.0.0.1:8100")
STATE = Path(__file__).resolve().parent / "state.json"
RESULTS = Path(__file__).resolve().parent / "results"
RESULTS.mkdir(exist_ok=True)


def pg_connect():
    import psycopg
    from dotenv import load_dotenv
    from sqlalchemy.engine import make_url

    load_dotenv(ROOT / ".env")
    u = make_url(os.environ["DATABASE_URL"])
    return psycopg.connect(
        host=u.host, port=u.port or 5432, user=u.username, password=u.password, dbname=u.database,
        options="-csearch_path=nexus_load",
    )


def pct(values, p):
    if not values:
        return 0.0
    s = sorted(values)
    k = min(len(s) - 1, max(0, int(round(p / 100 * (len(s) - 1)))))
    return s[k]


class Stats:
    def __init__(self):
        self.lat = defaultdict(list)
        self.err = defaultdict(int)
        self.codes = defaultdict(lambda: defaultdict(int))
        self.bytes = defaultdict(int)

    def add(self, name, ms, ok, code, size=0):
        self.lat[name].append(ms)
        self.codes[name][code] += 1
        self.bytes[name] += size
        if not ok:
            self.err[name] += 1

    def table(self, seconds=None):
        rows = []
        for name in sorted(self.lat):
            v = self.lat[name]
            rows.append({
                "endpoint": name,
                "count": len(v),
                "rps": round(len(v) / seconds, 2) if seconds else None,
                "errors": self.err[name],
                "p50": round(pct(v, 50)),
                "p95": round(pct(v, 95)),
                "p99": round(pct(v, 99)),
                "max": round(max(v)),
                "avg_kb": round(self.bytes[name] / max(1, len(v)) / 1024, 1),
                "codes": dict(self.codes[name]),
            })
        return rows


def show(title, rows):
    print(f"\n== {title}")
    print(f"{'endpoint':34} {'soni':>6} {'rps':>6} {'xato':>5} {'p50':>6} {'p95':>6} {'p99':>6} {'max':>7} {'KB':>7}")
    for r in rows:
        print(
            f"{r['endpoint'][:34]:34} {r['count']:>6} {str(r['rps'] or ''):>6} {r['errors']:>5} "
            f"{r['p50']:>6} {r['p95']:>6} {r['p99']:>6} {r['max']:>7} {r['avg_kb']:>7}"
        )
        bad = {k: v for k, v in r["codes"].items() if not (200 <= int(k) < 300)}
        if bad:
            print(f"{'':34}   kodlar: {bad}")


def save(name, data):
    (RESULTS / f"{name}.json").write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def now_ms():
    return time.perf_counter() * 1000


def mean(v):
    return statistics.mean(v) if v else 0
