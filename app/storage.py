"""Tasdiq rasmlari uchun S3-mos ombor (Cloudflare R2, AWS S3, MinIO).

Sozlanmagan bo'lsa yoki ombor ishlamasa rasm avvalgidek bazada saqlanadi — haydovchi topshirig'i hech qachon to'xtamaydi.

Railway o'zgaruvchilari:
  S3_ENDPOINT          https://<account_id>.r2.cloudflarestorage.com
  S3_BUCKET            nexus-proofs
  S3_ACCESS_KEY_ID     ...
  S3_SECRET_ACCESS_KEY ...
  S3_REGION            auto (R2 uchun)
"""

import logging
import os
import secrets
import threading
import time

from sqlalchemy import event
from sqlalchemy.orm import Session

log = logging.getLogger("nexus.storage")

_client = None
_client_lock = threading.Lock()
_PENDING = "nx_storage_drop"
# Ombor javob bermasa har bir topshiriq kutib qolmasin: shu vaqt davomida rasm to‘g‘ridan-to‘g‘ri bazaga yoziladi
PAUSE_AFTER_FAIL = 60.0
_down_until = 0.0


def _cfg(name: str) -> str:
    return os.getenv(name, "").strip()


def enabled() -> bool:
    return all(_cfg(k) for k in ("S3_ENDPOINT", "S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"))


def _s3():
    global _client
    with _client_lock:
        if _client is None:
            import boto3
            from botocore.config import Config

            _client = boto3.client(
                "s3",
                endpoint_url=_cfg("S3_ENDPOINT"),
                aws_access_key_id=_cfg("S3_ACCESS_KEY_ID"),
                aws_secret_access_key=_cfg("S3_SECRET_ACCESS_KEY"),
                region_name=_cfg("S3_REGION") or "auto",
                config=Config(
                    signature_version="s3v4",
                    s3={"addressing_style": "path"},
                    connect_timeout=3,
                    read_timeout=10,
                    retries={"max_attempts": 2, "mode": "standard"},
                ),
            )
        return _client


def new_key(org_id: int | None, order_id: int, mime: str) -> str:
    ext = {"image/png": "png", "image/webp": "webp"}.get(mime, "jpg")
    return f"proofs/{org_id or 0}/{order_id}-{secrets.token_hex(6)}.{ext}"


def put(key: str, data: bytes, mime: str) -> bool:
    global _down_until
    if time.monotonic() < _down_until:
        return False
    try:
        _s3().put_object(Bucket=_cfg("S3_BUCKET"), Key=key, Body=data, ContentType=mime)
        return True
    except Exception:
        _down_until = time.monotonic() + PAUSE_AFTER_FAIL
        log.exception("Rasm omborga yozilmadi: %s", key)
        return False


def get(key: str) -> bytes | None:
    try:
        return _s3().get_object(Bucket=_cfg("S3_BUCKET"), Key=key)["Body"].read()
    except Exception:
        log.exception("Rasm ombordan o'qilmadi: %s", key)
        return None


def delete_now(keys: list[str]) -> None:
    bucket = _cfg("S3_BUCKET")
    for i in range(0, len(keys), 1000):
        chunk = keys[i : i + 1000]
        try:
            _s3().delete_objects(Bucket=bucket, Delete={"Objects": [{"Key": k} for k in chunk], "Quiet": True})
        except Exception:
            log.exception("Ombordan %s ta rasm o'chirilmadi", len(chunk))


def delete_after_commit(db: Session, keys: list[str]) -> None:
    """Ombordagi fayl baza o'zgarishi saqlangandan keyingina o'chiriladi (rollback bo'lsa rasm yo'qolmaydi)."""
    keys = [k for k in keys if k]
    if keys:
        db.info.setdefault(_PENDING, []).extend(keys)


@event.listens_for(Session, "after_commit")
def _after_commit(session: Session) -> None:
    keys = session.info.pop(_PENDING, None)
    if keys and enabled():
        threading.Thread(target=delete_now, args=(keys,), daemon=True).start()


@event.listens_for(Session, "after_rollback")
def _after_rollback(session: Session) -> None:
    session.info.pop(_PENDING, None)
