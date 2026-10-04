import hashlib
import json
import re
import secrets
from datetime import datetime, timedelta, timezone
from typing import Annotated
from urllib.parse import parse_qs, unquote, urlparse

from fastapi import Depends, Header, HTTPException, Request
from sqlalchemy.orm import Session, joinedload

from .database import get_db
from .models import Driver, SessionToken, User


def hash_password(password: str) -> str:
    return hashlib.sha256(password.encode("utf-8")).hexdigest()


def verify_password(password: str, password_hash: str) -> bool:
    return hash_password(password) == password_hash


def create_token(db: Session, user: User) -> str:
    token = secrets.token_hex(32)
    now = datetime.now(timezone.utc)
    db.add(SessionToken(token=token, user_id=user.id, driver_id=None, last_seen_at=now))
    db.commit()
    return token


def create_driver_token(db: Session, driver: Driver) -> str:
    token = secrets.token_hex(32)
    now = datetime.now(timezone.utc)
    db.add(SessionToken(token=token, user_id=None, driver_id=driver.id, last_seen_at=now))
    db.commit()
    return token


def slug_username(name: str) -> str:
    raw = (name or "").lower().strip()
    raw = raw.replace("o‘", "o").replace("g‘", "g").replace("o'", "o").replace("g'", "g")
    raw = re.sub(r"[^a-z0-9]+", ".", raw).strip(".")
    return raw[:24]


def unique_driver_username(db: Session, name: str, driver_id: int | None = None) -> str:
    base = slug_username(name) or (f"drv{driver_id}" if driver_id else "drv")
    candidate = base
    n = 1
    while True:
        q = db.query(Driver).filter(Driver.username == candidate)
        if driver_id:
            q = q.filter(Driver.id != driver_id)
        if not q.first():
            return candidate
        n += 1
        candidate = f"{base}{n}"
        if n > 80:
            return f"drv{driver_id or secrets.token_hex(3)}"


QR_PREFIX = "NXD1:"


def qr_payload_for(driver: Driver) -> str:
    # Qisqa payload: QR kichik va telefon kamerasi tez o‘qiydi.
    return f"{QR_PREFIX}{driver.qr_token or ''}"


def qr_svg_for(payload: str) -> str:
    try:
        import segno

        qr = segno.make(payload, error="m")
        return qr.svg_inline(scale=6, border=2, dark="#111111", light="#ffffff")
    except Exception:
        return ""


def issue_driver_credentials(
    db: Session,
    driver: Driver,
    *,
    reset_password: bool = False,
    reset_qr: bool = False,
) -> dict:
    if not (driver.username or "").strip():
        driver.username = unique_driver_username(db, driver.name, driver.id)
    password = None
    if reset_password:
        password = secrets.token_urlsafe(6)
        driver.password_hash = hash_password(password)
    if reset_qr or not (driver.qr_token or "").strip():
        driver.qr_token = secrets.token_urlsafe(24)
    payload = qr_payload_for(driver)
    return {
        "id": driver.id,
        "name": driver.name,
        "username": driver.username,
        "password": password,
        "qr_payload": payload,
        "qr_svg": qr_svg_for(payload),
        "has_password": bool(driver.password_hash),
    }


def parse_qr_token(raw: str) -> str:
    text = (raw or "").strip().lstrip("\ufeff")
    if not text:
        return ""
    if (text.startswith('"') and text.endswith('"')) or (text.startswith("'") and text.endswith("'")):
        text = text[1:-1].strip()
    if text.upper().startswith(QR_PREFIX):
        return text[len(QR_PREFIX):].strip()
    try:
        data = json.loads(text)
        if isinstance(data, dict):
            for key in ("token", "qr_token", "t"):
                val = data.get(key)
                if val:
                    return str(val).strip()
            nested = data.get("data")
            if isinstance(nested, dict) and nested.get("token"):
                return str(nested["token"]).strip()
        elif isinstance(data, str) and data.strip() and data.strip() != text:
            return parse_qr_token(data)
    except Exception:
        pass
    if "token=" in text:
        try:
            parsed = urlparse(text)
            qs = parse_qs(parsed.query)
            if not qs.get("token") and parsed.fragment:
                qs = parse_qs(parsed.fragment)
            if qs.get("token"):
                return unquote(str(qs["token"][0])).strip()
        except Exception:
            pass
    return text


POLL_PATHS = {"/api/tracking/live", "/api/dashboard/stats", "/api/driver/location"}


def get_current_user(
    request: Request,
    db: Annotated[Session, Depends(get_db)],
    authorization: Annotated[str | None, Header()] = None,
) -> User:
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="Avtorizatsiya talab qilinadi")
    token = authorization.split(" ", 1)[1].strip()
    row = db.query(SessionToken).filter(SessionToken.token == token).first()
    if not row or not row.user_id:
        raise HTTPException(status_code=401, detail="Sessiya yaroqsiz")
    user = db.query(User).options(joinedload(User.org)).filter(User.id == row.user_id).first()
    if not user or not user.is_active:
        raise HTTPException(status_code=401, detail="Foydalanuvchi faol emas")
    if user.role != "superadmin" and user.org is not None and not user.org.is_active:
        raise HTTPException(status_code=401, detail="Tashkilot faol emas")
    now = datetime.now(timezone.utc)
    timeout = int(user.idle_timeout_minutes or 0)
    seen = row.last_seen_at
    if seen and seen.tzinfo is None:
        seen = seen.replace(tzinfo=timezone.utc)
    if timeout > 0 and seen and now - seen > timedelta(minutes=timeout):
        db.delete(row)
        db.commit()
        raise HTTPException(status_code=401, detail="Harakatsizlik tufayli sessiya yopildi")
    if request.url.path not in POLL_PATHS:
        row.last_seen_at = now
        db.commit()
    return user


def get_current_driver(
    request: Request,
    db: Annotated[Session, Depends(get_db)],
    authorization: Annotated[str | None, Header()] = None,
) -> Driver:
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="Avtorizatsiya talab qilinadi")
    token = authorization.split(" ", 1)[1].strip()
    row = db.query(SessionToken).filter(SessionToken.token == token).first()
    if not row or not row.driver_id:
        raise HTTPException(status_code=401, detail="Haydovchi sessiyasi yaroqsiz")
    driver = db.query(Driver).filter(Driver.id == row.driver_id).first()
    if not driver or not driver.is_active:
        raise HTTPException(status_code=401, detail="Haydovchi faol emas")
    now = datetime.now(timezone.utc)
    driver.seen_at = now
    if request.url.path not in POLL_PATHS:
        row.last_seen_at = now
    db.commit()
    db.refresh(driver)
    return driver


def require_admin(user: Annotated[User, Depends(get_current_user)]) -> User:
    if user.role not in ("superadmin", "admin"):
        raise HTTPException(status_code=403, detail="Faqat admin ruxsati")
    return user


def require_superadmin(user: Annotated[User, Depends(get_current_user)]) -> User:
    if user.role != "superadmin":
        raise HTTPException(status_code=403, detail="Faqat superadmin ruxsati")
    return user
