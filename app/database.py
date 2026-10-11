import os
from pathlib import Path

from sqlalchemy import create_engine
from sqlalchemy.orm import DeclarativeBase, sessionmaker

try:
    from dotenv import load_dotenv

    load_dotenv(Path(__file__).resolve().parent.parent / ".env")
except ImportError:
    pass

DATABASE_URL = os.getenv(
    "DATABASE_URL",
    "postgresql+psycopg://nexus:nexus_local_2026@127.0.0.1:5432/logistika",
).strip()
# Railway/Heroku "postgres://" yoki "postgresql://" beradi; drayver psycopg v3
for _prefix in ("postgres://", "postgresql://"):
    if DATABASE_URL.startswith(_prefix):
        DATABASE_URL = "postgresql+psycopg://" + DATABASE_URL[len(_prefix):]
        break

connect_args = {}
pool_args = {}
if DATABASE_URL.startswith("sqlite"):
    connect_args["check_same_thread"] = False
else:
    # FastAPI 40 ta oqimda ishlaydi: ulanishlar ham shuncha bo‘lmasa so‘rovlar navbatda qotib qoladi
    pool_args = {
        "pool_size": int(os.getenv("DB_POOL_SIZE", "20")),
        "max_overflow": int(os.getenv("DB_MAX_OVERFLOW", "20")),
        "pool_timeout": int(os.getenv("DB_POOL_TIMEOUT", "10")),
        "pool_recycle": 1800,
    }

engine = create_engine(DATABASE_URL, connect_args=connect_args, pool_pre_ping=True, **pool_args)
SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False)


class Base(DeclarativeBase):
    pass


async def get_db():
    # async: sessiyani yopish (ulanishni qaytarish) bo‘sh oqim kutmaydi — aks holda yuklamada
    # barcha oqimlar ulanish kutib, ulanishlarni qaytaradigan yopish esa oqim kutib, server qotadi
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
