import json
import os

from sqlalchemy.orm import Session

from .auth import hash_password, issue_driver_credentials
from .dispatch import next_agent_code, normalize_agent_code
from .importer import DRIVER_MAPPING, RELOG_MAPPING, build_template_json
from .models import Agent, Client, Driver, ImportTemplate, Order, Organization, User
from .permissions import parse_permission_list

DEFAULT_DISPATCHER_PERMS = [
    "orders.view",
    "orders.create",
    "orders.import",
    "orders.assign",
    "orders.plan",
    "orders.routes",
    "map.view",
    "tracking.live",
    "drivers.view",
    "agents.view",
    "agents.code.set",
    "warehouses.view",
    "warehouses.manage",
]

DEFAULT_AGENTS = [
    ("01", "Jasur Abdullayev", "+998 90 101 01 01", "Chorsu"),
    ("02", "Nilufar Saidova", "+998 91 102 02 02", "Yunusobod"),
    ("03", "Bekzod Tursunov", "+998 93 103 03 03", "Chilonzor"),
    ("04", "Madina Ergasheva", "+998 94 104 04 04", "Sergeli"),
    ("05", "Farhod Rahimov", "+998 95 105 05 05", "Mirzo Ulug‘bek"),
    ("06", "Sevara Aliyeva", "+998 97 106 06 06", "Shayxontohur"),
    ("07", "Rustam Qosimov", "+998 98 107 07 07", "Olmazor"),
    ("08", "Dilshoda Nazarova", "+998 99 108 08 08", "Bektemir"),
]


def default_org(db: Session) -> Organization:
    org = db.query(Organization).order_by(Organization.id.asc()).first()
    if org:
        return org
    org = Organization(name="Nexus Logistika", code="01", is_active=True)
    db.add(org)
    db.flush()
    return org


def ensure_tenancy(db: Session) -> None:
    org = default_org(db)
    oid = org.id
    for model in (User, Client, Agent, Driver, Order, ImportTemplate):
        db.query(model).filter(model.org_id.is_(None)).update({model.org_id: oid}, synchronize_session=False)
    db.commit()


def ensure_dispatcher_perms(db: Session) -> None:
    for user in db.query(User).filter(User.role == "dispatcher").all():
        keys = parse_permission_list(user.permissions_json)
        changed = False
        if not keys:
            keys = list(DEFAULT_DISPATCHER_PERMS)
            changed = True
        for extra in ("agents.view", "agents.code.set", "tracking.live", "warehouses.view", "warehouses.manage", "orders.routes"):
            if extra not in keys:
                keys.append(extra)
                changed = True
        if changed:
            user.permissions_json = json.dumps(keys, ensure_ascii=False)
    db.commit()


def seed_org_agents(db: Session, org_id: int) -> None:
    existing = db.query(Agent).filter(Agent.org_id == org_id).all()
    used = {normalize_agent_code(a.code) for a in existing if normalize_agent_code(a.code)}
    by_name = {a.name.strip().lower(): a for a in existing}
    for code, name, phone, region in DEFAULT_AGENTS:
        if code in used:
            continue
        found = by_name.get(name.lower())
        if found:
            found.code = code
            found.phone = found.phone or phone
            found.region = found.region or region
            found.org_id = found.org_id or org_id
        else:
            db.add(Agent(org_id=org_id, name=name, code=code, phone=phone, region=region, commission_pct=5))
        used.add(code)
    db.flush()


def seed_if_empty(db: Session) -> None:
    if db.query(User).first():
        return

    org = default_org(db)
    admin = User(
        username="admin",
        password_hash=hash_password(os.getenv("ADMIN_PASSWORD") or "admin123"),
        full_name="Tizim administratori",
        role="admin",
        org_id=org.id,
        idle_timeout_minutes=30,
        permissions_json="[]",
    )
    dispatcher = User(
        username="dispatcher",
        password_hash=hash_password(os.getenv("DISPATCHER_PASSWORD") or "dispatch123"),
        full_name="Dispetcher",
        role="dispatcher",
        org_id=org.id,
        idle_timeout_minutes=30,
        permissions_json=json.dumps(DEFAULT_DISPATCHER_PERMS, ensure_ascii=False),
    )
    db.add_all([admin, dispatcher])

    clients = [
        Client(org_id=org.id, name="Orient Market", phone="+998 90 111 22 33", company="Orient LLC", address="Chilonzor 12"),
        Client(org_id=org.id, name="Silk Logistics", phone="+998 91 444 55 66", company="Silk Group", address="Yunusobod 7"),
        Client(org_id=org.id, name="Fresh Dairy", phone="+998 93 777 88 99", company="Fresh", address="Sergeli 4"),
        Client(org_id=org.id, name="Tech Hub", phone="+998 97 222 33 44", company="TH", address="Mirzo Ulug'bek 21"),
    ]
    db.add_all(clients)

    agents = [
        Agent(org_id=org.id, name=name, code=code, phone=phone, region=region, commission_pct=5)
        for code, name, phone, region in DEFAULT_AGENTS
    ]
    db.add_all(agents)
    db.flush()

    db.add_all(
        [
            ImportTemplate(
                org_id=org.id,
                name="Buyurtmalar CSV v1",
                entity="orders",
                description="Standart buyurtma importi: kod, mijoz, manzillar, yuk.",
                mapping_json=json.dumps(
                    {
                        "code": "code",
                        "client_name": "client_name",
                        "pickup_address": "pickup_address",
                        "dropoff_address": "dropoff_address",
                        "cargo": "cargo",
                        "weight_kg": "weight_kg",
                    },
                    ensure_ascii=False,
                ),
                status="approved",
                submitted_by="dispatcher",
                reviewed_by="admin",
                review_note="Asosiy shablon tasdiqlandi",
            ),
            ImportTemplate(
                org_id=org.id,
                name="Excel moslashuvi (kutilyapti)",
                entity="orders",
                description="Ustunlar: OrderID, Customer, From, To, Goods.",
                mapping_json=json.dumps(
                    {
                        "code": "OrderID",
                        "client_name": "Customer",
                        "pickup_address": "From",
                        "dropoff_address": "To",
                        "cargo": "Goods",
                        "weight_kg": "Weight",
                    },
                    ensure_ascii=False,
                ),
                status="pending",
                submitted_by="dispatcher",
            ),
        ]
    )
    db.commit()


def ensure_org_templates(db: Session, org_id: int) -> None:
    relog = build_template_json("Sheet1", 1, RELOG_MAPPING)
    existing = db.query(ImportTemplate).filter(ImportTemplate.name == "RELOG Excel", ImportTemplate.org_id == org_id).first()
    if existing:
        existing.mapping_json = relog
        existing.entity = "orders"
        existing.status = "approved"
    else:
        db.add(
            ImportTemplate(
                org_id=org_id,
                name="RELOG Excel",
                entity="orders",
                description="RELOG Excel: mijoz, ombor, GPS, kg, summa.",
                mapping_json=relog,
                status="approved",
                submitted_by="admin",
                reviewed_by="admin",
                review_note="RELOG asosiy shablon",
            )
        )
    drivers = build_template_json("Haydovchilar", 1, DRIVER_MAPPING)
    drv = db.query(ImportTemplate).filter(ImportTemplate.name == "Haydovchilar Excel", ImportTemplate.org_id == org_id).first()
    if drv:
        drv.mapping_json = drivers
        drv.entity = "drivers"
        drv.status = "approved"
    else:
        db.add(
            ImportTemplate(
                org_id=org_id,
                name="Haydovchilar Excel",
                entity="drivers",
                description="Haydovchilarni Excel orqali qo‘shish: Ism, Telefon, Davlat raqami.",
                mapping_json=drivers,
                status="approved",
                submitted_by="admin",
                reviewed_by="admin",
                review_note="Haydovchilar shabloni",
            )
        )
    db.flush()


def ensure_default_templates(db: Session) -> None:
    orgs = db.query(Organization).all()
    if not orgs:
        orgs = [default_org(db)]
    for org in orgs:
        ensure_org_templates(db, org.id)
    db.commit()


def ensure_driver_template(db: Session) -> None:
    ensure_default_templates(db)


def ensure_driver_logins(db: Session) -> None:
    changed = False
    for driver in db.query(Driver).all():
        before_user = driver.username or ""
        before_qr = driver.qr_token or ""
        issue_driver_credentials(db, driver, reset_password=False, reset_qr=False)
        if (driver.username or "") != before_user or (driver.qr_token or "") != before_qr:
            changed = True
    if changed:
        db.commit()


def ensure_agents(db: Session) -> None:
    orgs = db.query(Organization).all()
    if not orgs:
        orgs = [default_org(db)]
    for org in orgs:
        seed_org_agents(db, org.id)
        leftover = db.query(Agent).filter(Agent.org_id == org.id).all()
        used = {normalize_agent_code(a.code) for a in leftover if normalize_agent_code(a.code)}
        for agent in leftover:
            if not normalize_agent_code(agent.code):
                agent.code = next_agent_code(used)
                used.add(agent.code)
            else:
                agent.code = normalize_agent_code(agent.code)
        db.flush()
        coded = {a.code: a for a in leftover if a.code}
        roster = [coded[c] for c, *_ in DEFAULT_AGENTS if c in coded]
        if not roster:
            continue
        unbound = (
            db.query(Driver)
            .filter(Driver.org_id == org.id, Driver.agent_id.is_(None))
            .order_by(Driver.id)
            .all()
        )
        for i, driver in enumerate(unbound):
            driver.agent_id = roster[i % len(roster)].id
        blank_orders = (
            db.query(Order)
            .filter(
                Order.org_id == org.id,
                (Order.agent_code == None) | (Order.agent_code == ""),  # noqa: E711
            )
            .order_by(Order.id)
            .all()
        )
        codes = [a.code for a in roster]
        for i, order in enumerate(blank_orders):
            order.agent_code = codes[i % len(codes)]
    db.commit()


def ensure_phone_format(db: Session) -> None:
    from .phones import format_uz_phone

    changed = False
    for model in (Agent, Driver, Client):
        for row in db.query(model).all():
            formatted = format_uz_phone(row.phone or "")
            if formatted and formatted != (row.phone or ""):
                row.phone = formatted
                changed = True
    if changed:
        db.commit()
