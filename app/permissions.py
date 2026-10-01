PERMISSIONS = [
    {"key": "orders.view", "group": "Zayavkalar", "label": "Ro‘yxatni ko‘rish"},
    {"key": "orders.create", "group": "Zayavkalar", "label": "Yaratish"},
    {"key": "orders.import", "group": "Zayavkalar", "label": "Excel import"},
    {"key": "orders.assign", "group": "Zayavkalar", "label": "Haydovchi biriktirish"},
    {"key": "orders.plan", "group": "Zayavkalar", "label": "Planlashtirish"},
    {"key": "orders.routes", "group": "Zayavkalar", "label": "Yo‘nalish (marshrutlar)"},
    {"key": "orders.delete", "group": "Zayavkalar", "label": "O‘chirish"},
    {"key": "map.view", "group": "Xarita", "label": "Xaritani ko‘rish"},
    {"key": "tracking.live", "group": "Xarita", "label": "Haydovchi joylashuvi (real-time GPS)"},
    {"key": "drivers.view", "group": "Haydovchilar", "label": "Ro‘yxatni ko‘rish"},
    {"key": "drivers.manage", "group": "Haydovchilar", "label": "Qo‘shish / tahrirlash / o‘chirish"},
    {"key": "drivers.access", "group": "Haydovchilar", "label": "Login, parol va QR"},
    {"key": "agents.view", "group": "Agentlar", "label": "Ro‘yxatni ko‘rish"},
    {"key": "agents.manage", "group": "Agentlar", "label": "Qo‘shish / tahrirlash / o‘chirish"},
    {"key": "agents.code.set", "group": "Agentlar", "label": "Agent kodini bir marta kiritish"},
    {"key": "warehouses.view", "group": "Sklad", "label": "Skladlarni ko‘rish"},
    {"key": "warehouses.manage", "group": "Sklad", "label": "Sklad qo‘shish / tahrirlash"},
    {"key": "admin.panel", "group": "Admin", "label": "Admin panel (shablonlar)"},
    {"key": "users.manage", "group": "Admin", "label": "Akkauntlar"},
    {"key": "perms.manage", "group": "Admin", "label": "Dostuplar"},
]

ALL_PERMISSION_KEYS = [p["key"] for p in PERMISSIONS]
ADMIN_ONLY_KEYS = {"users.manage", "perms.manage"}


def parse_permission_list(raw) -> list[str]:
    if isinstance(raw, list):
        keys = raw
    else:
        text = str(raw or "").strip()
        if not text:
            keys = []
        else:
            try:
                import json

                data = json.loads(text)
                keys = data if isinstance(data, list) else []
            except Exception:
                keys = [x.strip() for x in text.split(",") if x.strip()]
    out = []
    for key in keys:
        if key in ALL_PERMISSION_KEYS and key not in out:
            out.append(key)
    return out


def permissions_of(user) -> list[str]:
    if getattr(user, "role", "") == "admin":
        return list(ALL_PERMISSION_KEYS)
    return parse_permission_list(getattr(user, "permissions_json", "") or "")


def has_perm(user, key: str) -> bool:
    if not user:
        return False
    if getattr(user, "role", "") == "admin":
        return True
    return key in permissions_of(user)


def can_write_agent_code(user, agent=None) -> bool:
    if getattr(user, "role", "") == "admin":
        return True
    if agent is not None and getattr(agent, "code_locked", False):
        return False
    return has_perm(user, "agents.code.set") or has_perm(user, "agents.manage")
