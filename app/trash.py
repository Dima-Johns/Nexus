import json
from datetime import date, datetime

from sqlalchemy import inspect as sa_inspect
from sqlalchemy.orm import Session

from .models import DeletedRecord, User

ENTITY_LABELS = {
    "user": "Foydalanuvchi",
    "client": "Klient",
    "agent": "Agent",
    "driver": "Haydovchi",
    "warehouse": "Sklad",
}

SECRET_FIELDS = {"password_hash", "qr_token"}


def snapshot(row) -> dict:
    data = {}
    for attr in sa_inspect(row).mapper.column_attrs:
        if attr.key in SECRET_FIELDS:
            continue
        value = getattr(row, attr.key)
        if isinstance(value, (datetime, date)):
            value = value.isoformat()
        data[attr.key] = value
    return data


def archive_deleted(db: Session, actor: User | None, entity: str, row, title: str, extra: dict | None = None) -> None:
    data = snapshot(row)
    if extra:
        data.update(extra)
    who = ""
    if actor:
        who = f"{actor.full_name} ({actor.username})" if actor.full_name else actor.username
    db.add(
        DeletedRecord(
            org_id=getattr(row, "org_id", None),
            entity=entity,
            entity_id=getattr(row, "id", None),
            title=(title or "")[:255],
            data_json=json.dumps(data, ensure_ascii=False, default=str),
            deleted_by_id=actor.id if actor else None,
            deleted_by_name=who[:160],
        )
    )
