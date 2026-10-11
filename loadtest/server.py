"""Yuklama testi uchun alohida server: alohida sxema (nexus_load) va tashqi xizmatlarsiz.

python loadtest/server.py  — 8100-portda ishga tushadi.
OSRM va Nominatim ochiq serverlariga minglab so‘rov yubormaslik uchun ular tarmoq kechikishi bilan almashtiriladi.
"""

import os
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from dotenv import load_dotenv  # noqa: E402

load_dotenv(ROOT / ".env")
base = os.environ["DATABASE_URL"]
sep = "&" if "?" in base else "?"
os.environ["DATABASE_URL"] = f"{base}{sep}options=-csearch_path%3Dnexus_load"

import app.tracking as tracking  # noqa: E402

OSRM_DELAY = float(os.getenv("LOAD_OSRM_DELAY", "0.3"))


def fake_osrm(coords):
    time.sleep(OSRM_DELAY)
    return [[c[0], c[1]] for c in coords]


def fake_fetch(url: str):
    time.sleep(0.2)
    if "/search" in url:
        return [{"lat": "41.31", "lon": "69.28", "address": {"road": "Sinov ko‘chasi", "city": "Toshkent"}}]
    return {"address": {"road": "Sinov ko‘chasi", "city": "Toshkent"}}


# Faqat tarmoq chaqiruvi almashtiriladi — navbat/cheklov mantig‘i haqiqiy kod bilan sinaladi
tracking.osrm_geometry = fake_osrm
tracking._fetch_json = fake_fetch

if __name__ == "__main__":
    import uvicorn

    uvicorn.run("app.main:app", host="127.0.0.1", port=int(os.getenv("LOAD_PORT", "8100")), log_level="warning")
