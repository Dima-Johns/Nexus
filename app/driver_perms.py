"""Haydovchi ilovasi ruxsatlari.

Bo‘sh permissions_json — eski haydovchilar: hammasi ochiq.
JSON ro‘yxat — aniq tanlangan ruxsatlar (bo‘sh ro‘yxat = hech narsa).
"""

from __future__ import annotations

import json

from fastapi import HTTPException

DRIVER_PERMISSIONS = [
    {"key": "orders.view", "label": "Zayavkalarni ko‘rish", "hint": "Kunlik reys va zayavkalar ro‘yxati"},
    {"key": "orders.status", "label": "Statusini o‘zgartirish", "hint": "Yetkazildi yoki qaytarildi deb belgilash"},
    {"key": "orders.reorder", "label": "Zayavka tartibini o‘zgartirish", "hint": "Borish ketma-ketligini qo‘lda surish"},
    {"key": "orders.photo", "label": "Suratga olish", "hint": "Yetkazish va qaytarishni rasm bilan tasdiqlash"},
    {"key": "orders.comment", "label": "Izoh yozish", "hint": "Qaytarish sababi va qo‘shimcha izoh"},
    {"key": "route.start", "label": "Reysni boshlash", "hint": "Yo‘lga chiqish va zayavkalarni yo‘lda holatiga o‘tkazish"},
    {"key": "route.replan", "label": "Marshrutni qayta hisoblash", "hint": "Joylashuv bo‘yicha avtomatik tartib"},
    {"key": "map.view", "label": "Xaritani ko‘rish", "hint": "Xarita va yo‘nalish"},
    {"key": "history.view", "label": "Yopilgan zayavkalarni ko‘rish", "hint": "Yetkazilgan va qaytarilganlar"},
    {"key": "gps.send", "label": "Joylashuvni yuborish", "hint": "Ofis xaritada haydovchini ko‘radi"},
    {"key": "notices.view", "label": "Bildirishnomalar", "hint": "Yangi reys haqida xabar"},
]

ALL_DRIVER_PERMS = [p["key"] for p in DRIVER_PERMISSIONS]
_ALLOWED = set(ALL_DRIVER_PERMS)


def driver_permission_keys(driver) -> list[str]:
    raw = getattr(driver, "permissions_json", None)
    if raw is None:
        return list(ALL_DRIVER_PERMS)
    text = str(raw).strip()
    if not text:
        return list(ALL_DRIVER_PERMS)
    try:
        data = json.loads(text)
    except Exception:
        return list(ALL_DRIVER_PERMS)
    if not isinstance(data, list):
        return list(ALL_DRIVER_PERMS)
    out: list[str] = []
    for key in data:
        if key in _ALLOWED and key not in out:
            out.append(key)
    return out


def driver_can(driver, key: str) -> bool:
    return key in driver_permission_keys(driver)


def dump_driver_permissions(keys: list[str]) -> str:
    clean: list[str] = []
    for key in keys or []:
        if key in _ALLOWED and key not in clean:
            clean.append(key)
    return json.dumps(clean, ensure_ascii=False)


def require_driver_perm(driver, key: str) -> None:
    if not driver_can(driver, key):
        raise HTTPException(403, "Bu amal uchun ruxsat yo‘q")
