from __future__ import annotations

import json
from typing import Annotated

from fastapi import Depends, HTTPException
from sqlalchemy.orm import Session

from .auth import get_current_user, require_admin
from .models import User
from .permissions import ADMIN_ONLY_KEYS, has_perm, permissions_of


def org_id_of(user: User) -> int:
    if not getattr(user, "org_id", None):
        raise HTTPException(403, "Tashkilot biriktirilmagan")
    return int(user.org_id)


def q_org(db: Session, model, user: User):
    return db.query(model).filter(model.org_id == org_id_of(user))


def get_org_row(db: Session, model, item_id: int, user: User, err: str = "Topilmadi"):
    row = q_org(db, model, user).filter(model.id == item_id).first()
    if not row:
        raise HTTPException(404, err)
    return row


def dump_permissions(keys: list[str]) -> str:
    return json.dumps(keys, ensure_ascii=False)


def require_perm(key: str):
    def _inner(user: Annotated[User, Depends(get_current_user)]) -> User:
        if key in ADMIN_ONLY_KEYS:
            require_admin(user)
        if not has_perm(user, key):
            raise HTTPException(403, "Bu amal uchun ruxsat yo‘q")
        return user

    return _inner


def user_payload(user: User) -> dict:
    org = getattr(user, "org", None)
    return {
        "id": user.id,
        "username": user.username,
        "full_name": user.full_name,
        "role": user.role,
        "is_active": user.is_active,
        "org_id": user.org_id,
        "org_name": org.name if org else "",
        "idle_timeout_minutes": int(user.idle_timeout_minutes or 0),
        "permissions": permissions_of(user),
    }
