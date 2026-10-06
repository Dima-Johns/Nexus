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
    {"key": "clients.view", "group": "Klientlar", "label": "Klientlar bazasini ko‘rish va Excel yuklash"},
    {"key": "clients.manage", "group": "Klientlar", "label": "Klientni tahrirlash / o‘chirish"},
    {"key": "admin.panel", "group": "Admin", "label": "Admin panel (shablonlar)"},
    {"key": "trash.view", "group": "Admin", "label": "O‘chirilgan ma’lumotlarni ko‘rish"},
    {"key": "users.manage", "group": "Admin", "label": "Akkauntlar"},
    {"key": "perms.manage", "group": "Admin", "label": "Dostuplar"},
    {"key": "orgs.manage", "group": "Tashkilotlar", "label": "Tashkilot ochish va akkaunt berish"},
]

ALL_PERMISSION_KEYS = [p["key"] for p in PERMISSIONS]
ADMIN_ONLY_KEYS = {"users.manage", "perms.manage"}
# Faqat superadmin beradi; boshqa rollarga sukut bo‘yicha yopiq va ularning Dostuplar bo‘limida ko‘rinmaydi
SUPER_ONLY_KEYS = {"orgs.manage"}
ADMIN_ROLES = {"superadmin", "admin"}


def is_super(user) -> bool:
    return getattr(user, "role", "") == "superadmin"


def is_admin_role(user) -> bool:
    return getattr(user, "role", "") in ADMIN_ROLES


def catalog_for(user) -> list[dict]:
    if is_super(user):
        return list(PERMISSIONS)
    return [p for p in PERMISSIONS if p["key"] not in SUPER_ONLY_KEYS]


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
    if is_super(user):
        return list(ALL_PERMISSION_KEYS)
    granted = parse_permission_list(getattr(user, "permissions_json", "") or "")
    if getattr(user, "role", "") == "admin":
        return [k for k in ALL_PERMISSION_KEYS if k not in SUPER_ONLY_KEYS or k in granted]
    return granted


def has_perm(user, key: str) -> bool:
    if not user:
        return False
    if is_super(user):
        return True
    return key in permissions_of(user)


def can_write_agent_code(user, agent=None) -> bool:
    if is_admin_role(user):
        return True
    if agent is not None and getattr(agent, "code_locked", False):
        return False
    return has_perm(user, "agents.code.set") or has_perm(user, "agents.manage")
