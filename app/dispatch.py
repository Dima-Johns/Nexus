import json
import re
from datetime import datetime, timedelta, timezone
from collections import Counter, defaultdict

from sqlalchemy.orm import Session, joinedload

from .models import DONE_STATUSES, Agent, Driver, Order, SessionToken, Warehouse

CODE_RE = re.compile(r"^\d{1,2}$")
LEADING_CODE_RE = re.compile(r"^0?(\d{1,2})(?:\D|$)")
LABELED_CODE_RE = re.compile(r"(?:kod|код|agent|агент)\s*[:#№]?\s*0?(\d{1,2})\b", re.I)


# Server (masalan Railway) UTC’da ishlaydi, ish kuni esa Toshkent vaqti bilan almashadi
LOCAL_TZ = timezone(timedelta(hours=5), "Asia/Tashkent")


def local_now() -> datetime:
    return datetime.now(LOCAL_TZ)


def local_today() -> str:
    return local_now().strftime("%Y-%m-%d")


def local_tomorrow() -> str:
    return (local_now() + timedelta(days=1)).strftime("%Y-%m-%d")


def order_day(order: Order) -> str:
    return str(getattr(order, "delivery_date", "") or "")[:10]


def normalize_agent_code(value) -> str:
    text = str(value or "").strip()
    if not text:
        return ""
    if CODE_RE.fullmatch(text):
        n = int(text)
        return f"{n:02d}" if 1 <= n <= 99 else ""
    labeled = LABELED_CODE_RE.search(text)
    if labeled:
        n = int(labeled.group(1))
        return f"{n:02d}" if 1 <= n <= 99 else ""
    leading = LEADING_CODE_RE.match(text)
    if leading and len(text) <= 24:
        n = int(leading.group(1))
        return f"{n:02d}" if 1 <= n <= 99 else ""
    return ""


def next_agent_code(used: set[str]) -> str:
    for n in range(1, 100):
        code = f"{n:02d}"
        if code not in used:
            return code
    raise ValueError("Barcha agent kodlari band")


def _norm_name(value: str) -> str:
    return re.sub(r"[^\wа-яё]+", " ", (value or "").lower(), flags=re.IGNORECASE).strip()


_NAME_LETTERS = re.compile(r"[A-Za-zА-Яа-яЁёЎўҚқҒғҲҳ]")


def names_match(left: str, right: str) -> bool:
    a, b = _norm_name(left), _norm_name(right)
    if not a or not b:
        return False
    if a == b:
        return True
    short, long = (a, b) if len(a) <= len(b) else (b, a)
    return len(short) >= 6 and (long == short or long.startswith(short + " ") or f" {short} " in f" {long} ")


def _is_code_only(value: str) -> bool:
    text = (value or "").strip()
    if not text:
        return False
    return bool(normalize_agent_code(text)) and not _NAME_LETTERS.search(text)


def resolve_agent(agents: list[Agent], *, code: str = "", name: str = "") -> Agent | None:
    name = (name or "").strip()
    code = (code or "").strip()
    ncode = normalize_agent_code(code) or (normalize_agent_code(name) if _is_code_only(name) else "")
    if ncode:
        for agent in agents:
            if (agent.code or "") == ncode:
                return agent
        return None
    if name:
        for agent in agents:
            if names_match(agent.name, name):
                return agent
    return None


def order_agent_label(order: Order) -> str:
    return (getattr(order, "sales_rep", "") or "").strip() or (getattr(order, "agent_code", "") or "").strip()


def resolve_order_agent(order: Order, agents: list[Agent]) -> Agent | None:
    return resolve_agent(agents, code=getattr(order, "agent_code", "") or "", name=order.sales_rep or "")


def sync_agents_from_orders(db: Session, orders: list[Order], org_id: int) -> dict:
    if not orders:
        return {"created": 0, "updated": 0}
    agents = db.query(Agent).filter(Agent.org_id == org_id).all()
    used = {normalize_agent_code(a.code) for a in agents if normalize_agent_code(a.code)}
    by_code = {normalize_agent_code(a.code): a for a in agents if normalize_agent_code(a.code)}
    created = 0
    updated = 0
    wanted: dict[str, str] = {}
    nameless: dict[str, str] = {}
    for order in orders:
        code = normalize_agent_code(getattr(order, "agent_code", "") or "") or normalize_agent_code(order.sales_rep or "")
        name = (order.sales_rep or "").strip()
        if code:
            wanted[code] = name or wanted.get(code) or f"Agent {code}"
        elif name:
            nameless[_norm_name(name)] = name
    for code, name in wanted.items():
        agent = by_code.get(code)
        if agent:
            if name and not names_match(agent.name, name):
                agent.name = name[:160]
                updated += 1
            continue
        agent = Agent(org_id=org_id, name=(name or f"Agent {code}")[:160], code=code, code_locked=True, is_active=True)
        db.add(agent)
        db.flush()
        agents.append(agent)
        by_code[code] = agent
        used.add(code)
        created += 1
    for _key, name in nameless.items():
        if any(names_match(a.name, name) for a in agents):
            continue
        code = next_agent_code(used)
        agent = Agent(org_id=org_id, name=name[:160], code=code, code_locked=True, is_active=True)
        db.add(agent)
        db.flush()
        agents.append(agent)
        by_code[code] = agent
        used.add(code)
        created += 1
    for order in orders:
        found = resolve_order_agent(order, agents)
        if found and found.code:
            order.agent_code = found.code
    db.flush()
    return {"created": created, "updated": updated}


def agents_for_orders(orders: list[Order], agents: list[Agent]) -> list[Agent]:
    seen: set[int] = set()
    out: list[Agent] = []
    for order in orders:
        agent = resolve_order_agent(order, agents)
        if agent and agent.id not in seen:
            seen.add(agent.id)
            out.append(agent)
    return out


def _order_extra(order: Order) -> dict:
    try:
        data = json.loads(order.extra_json or "{}")
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


FAKE_AGENT_DRIVER_RE = re.compile(r"^\d{1,2}\s*[·•]\s+")
JUNK_COURIER = {"zablokirovano", "eksportirovan", "voditel", "haydovchi", "заблокировано"}


def is_fake_agent_driver_name(name: str) -> bool:
    return bool(FAKE_AGENT_DRIVER_RE.match(str(name or "").strip()))


def courier_info(order: Order) -> tuple[str, str]:
    extra = _order_extra(order)
    name = str(extra.get("driver_name") or "").strip()
    plate = str(extra.get("vehicle_plate") or "").strip()
    if is_fake_agent_driver_name(name):
        name = ""
    if plate and not re.search(r"\d", plate):
        plate = ""
    return name[:160], plate[:32]


def purge_fake_agent_drivers(db: Session, org_id: int) -> dict:
    drivers = db.query(Driver).filter(Driver.org_id == org_id).all()
    fake = [d for d in drivers if is_fake_agent_driver_name(d.name)]
    if not fake:
        return {"removed": 0, "unassigned": 0}
    ids = [d.id for d in fake]
    orders = db.query(Order).filter(Order.driver_id.in_(ids)).all()
    unassigned = 0
    for order in orders:
        order.driver_id = None
        order.stop_no = 0
        if (order.status or "") in {"assigned", "on_route"}:
            order.status = "new"
        unassigned += 1
    db.query(SessionToken).filter(SessionToken.driver_id.in_(ids)).delete(synchronize_session=False)
    for driver in fake:
        db.delete(driver)
    db.flush()
    return {"removed": len(fake), "unassigned": unassigned}


def ensure_drivers_from_orders(db: Session, orders: list[Order], org_id: int, *, assign: bool = True) -> dict:
    from .auth import issue_driver_credentials

    if not orders:
        return {"created": 0, "linked": 0, "assigned": 0}
    purge_fake_agent_drivers(db, org_id)
    drivers = db.query(Driver).filter(Driver.org_id == org_id, Driver.is_active.is_(True)).all()
    agents = db.query(Agent).filter(Agent.org_id == org_id).all()
    groups: dict[str, list[Order]] = defaultdict(list)
    for order in orders:
        name, _plate = courier_info(order)
        key = _norm_name(name)
        if not key or key in JUNK_COURIER or is_fake_agent_driver_name(name):
            continue
        groups[key].append(order)
    created = 0
    linked = 0
    assigned = 0
    for _key, group in groups.items():
        display, plate = courier_info(group[0])
        for order in group:
            extra = _order_extra(order)
            if not plate:
                plate = str(extra.get("vehicle_plate") or "").strip()[:32]
        driver = next(
            (d for d in drivers if not is_fake_agent_driver_name(d.name) and names_match(d.name, display)),
            None,
        )
        if not driver:
            driver = Driver(
                org_id=org_id,
                name=display,
                vehicle_plate=plate,
                vehicle_type="furgon",
                status="idle",
                is_active=True,
            )
            db.add(driver)
            db.flush()
            issue_driver_credentials(db, driver, reset_password=True, reset_qr=True)
            drivers.append(driver)
            created += 1
        else:
            if display and driver.name != display:
                driver.name = display
            if plate and not (driver.vehicle_plate or "").strip():
                driver.vehicle_plate = plate
        agent_ids = []
        for order in group:
            agent = resolve_order_agent(order, agents)
            if agent:
                agent_ids.append(agent.id)
        if agent_ids and not driver.agent_id:
            driver.agent_id = Counter(agent_ids).most_common(1)[0][0]
            linked += 1
        if not assign:
            continue
        for order in group:
            order.driver_id = driver.id
            if order.status == "new":
                order.status = "assigned"
            assigned += 1
        if driver.status == "idle":
            driver.status = "assigned"
    if assign:
        sequence_drivers(db, {o.driver_id for o in orders if o.driver_id}, org_id)
    return {"created": created, "linked": linked, "assigned": assigned}


def missing_agent_error(order: Order) -> str:
    label = order_agent_label(order) or "ko‘rsatilmagan"
    return f"{order.code}: «{label}» — bunaqa agent mavjud emas, agentni qo‘shing"


def missing_org_agents(orders: list[Order], agents: list[Agent]) -> list[str]:
    missing = []
    for order in orders:
        if resolve_order_agent(order, agents):
            continue
        missing.append(missing_agent_error(order))
    return missing


def extract_order_agent_code(order: Order, agents: list[Agent] | None = None) -> str:
    if agents:
        found = resolve_order_agent(order, agents)
        if found and found.code:
            return found.code
    code = normalize_agent_code(getattr(order, "agent_code", "") or "")
    if code:
        return code
    for raw in (order.sales_rep, order.route_code):
        code = normalize_agent_code(raw)
        if code:
            return code
    return ""


def _drivers_by_agent(drivers: list[Driver]) -> dict[int, list[Driver]]:
    by_agent: dict[int, list[Driver]] = defaultdict(list)
    for driver in drivers:
        if driver.agent_id:
            by_agent[driver.agent_id].append(driver)
    return by_agent


def agent_driver_error(order: Order, agents: list[Agent], by_agent: dict[int, list[Driver]]) -> str | None:
    agent = resolve_order_agent(order, agents)
    if not agent:
        return missing_agent_error(order)
    if not by_agent.get(agent.id):
        return f"{order.code}: agent «{agent.name}» haydovchiga bog‘lanmagan"
    return None


def _least_loaded(drivers: list[Driver], loads: dict[int, int]) -> Driver:
    return min(drivers, key=lambda d: (loads.get(d.id, 0), d.id))


def auto_assign_orders(db: Session, orders: list[Order]) -> dict:
    if not orders:
        return {"assigned": 0, "unmatched": 0}
    org_id = orders[0].org_id
    agents = db.query(Agent).filter(Agent.is_active.is_(True), Agent.org_id == org_id).all()
    drivers = (
        db.query(Driver)
        .options(joinedload(Driver.agent))
        .filter(Driver.is_active.is_(True), Driver.agent_id.isnot(None), Driver.org_id == org_id)
        .all()
    )
    loads: dict[int, int] = defaultdict(int)
    q_loads = db.query(Order.driver_id).filter(Order.driver_id.isnot(None), Order.status.notin_(DONE_STATUSES))
    if org_id:
        q_loads = q_loads.filter(Order.org_id == org_id)
    for row in q_loads:
        if row[0]:
            loads[row[0]] += 1
    assigned = 0
    unmatched = 0
    by_agent = _drivers_by_agent(drivers)
    for order in orders:
        if order.driver_id:
            continue
        err = agent_driver_error(order, agents, by_agent)
        if err:
            unmatched += 1
            continue
        agent = resolve_order_agent(order, agents)
        if agent and agent.code:
            order.agent_code = agent.code
        pool = by_agent.get(agent.id) if agent else None
        if not pool:
            unmatched += 1
            continue
        driver = _least_loaded(pool, loads)
        order.driver_id = driver.id
        if order.status == "new":
            order.status = "assigned"
        if driver.status == "idle":
            driver.status = "assigned"
        loads[driver.id] += 1
        assigned += 1
    sequence_drivers(db, {o.driver_id for o in orders if o.driver_id}, org_id)
    return {"assigned": assigned, "unmatched": unmatched}


def plan_orders(
    db: Session,
    *,
    order_ids: list[int],
    driver_ids: list[int],
    delivery_date: str,
    window_start: str,
    window_end: str,
    org_id: int | None = None,
) -> dict:
    if not driver_ids:
        raise ValueError("Haydovchi tanlang")
    dq = db.query(Driver).options(joinedload(Driver.agent)).filter(Driver.id.in_(driver_ids), Driver.is_active.is_(True))
    if org_id:
        dq = dq.filter(Driver.org_id == org_id)
    drivers = dq.all()
    if not drivers:
        raise ValueError("Faol haydovchi topilmadi")
    q = db.query(Order).filter(Order.status.notin_(DONE_STATUSES), Order.driver_id.is_(None))
    if org_id:
        q = q.filter(Order.org_id == org_id)
    if order_ids:
        q = q.filter(Order.id.in_(order_ids))
    orders = q.order_by(Order.id.asc()).all()
    if not orders:
        raise ValueError("Rejalashtirish uchun zayavka yo‘q")
    # Zayavka kiritilgan kuni va undan keyingi kunlarga o‘tkaziladi; bugundan orqa sana taqiqlanadi
    today = local_today()
    if delivery_date < today:
        raise ValueError(f"Orqa sana tanlab bo‘lmaydi (eng erta: {today})")
    eligible = []
    skipped_early = 0
    for order in orders:
        day = str(getattr(order, "delivery_date", "") or "")[:10]
        if day and delivery_date < day:
            skipped_early += 1
            continue
        eligible.append(order)
    if not eligible:
        if skipped_early:
            raise ValueError(
                f"{delivery_date} uchun hali erta: zayavkalar {skipped_early} tasi keyingi kunga belgilangan"
            )
        raise ValueError(f"{delivery_date} uchun Faolga o‘tkaziladigan Kiruvchi zayavka yo‘q")
    orders = eligible
    org_agents_q = db.query(Agent)
    if org_id:
        org_agents_q = org_agents_q.filter(Agent.org_id == org_id)
    agents = org_agents_q.all()
    org_dq = db.query(Driver).filter(Driver.is_active.is_(True), Driver.agent_id.isnot(None))
    if org_id:
        org_dq = org_dq.filter(Driver.org_id == org_id)
    org_by_agent = _drivers_by_agent(org_dq.all())
    by_agent = _drivers_by_agent(drivers)
    loads: dict[int, int] = defaultdict(int)
    assigned = 0
    errors: list[str] = []
    for order in orders:
        agent = resolve_order_agent(order, agents)
        if not agent:
            errors.append(missing_agent_error(order))
            continue
        if not org_by_agent.get(agent.id):
            errors.append(f"{order.code}: agent «{agent.name}» haydovchiga bog‘lanmagan")
            continue
        pool = by_agent.get(agent.id)
        if not pool:
            errors.append(f"{order.code}: agent «{agent.name}» haydovchisi tanlanmagan")
            continue
        if agent.code:
            order.agent_code = agent.code
        driver = _least_loaded(pool, loads)
        _apply_plan(order, driver, delivery_date, window_start, window_end, loads)
        assigned += 1
    if assigned == 0:
        raise ValueError("Hech qaysi zayavka taqsimlanmadi. " + "; ".join(errors[:8]))
    sequence_drivers(db, {o.driver_id for o in orders if o.driver_id}, org_id)
    return {
        "ok": True,
        "assigned": assigned,
        "unmatched": len(errors),
        "errors": errors[:30],
        "by_code": assigned,
        "balanced": 0,
        "delivery_date": delivery_date,
        "window_start": window_start,
        "window_end": window_end,
    }


def _apply_plan(order: Order, driver: Driver, delivery_date: str, window_start: str, window_end: str, loads: dict[int, int]) -> None:
    order.driver_id = driver.id
    order.delivery_date = delivery_date
    order.window_start = window_start
    order.window_end = window_end
    if order.status == "new":
        order.status = "assigned"
    if driver.status == "idle":
        driver.status = "assigned"
    loads[driver.id] += 1


def _gps_ok(lat, lng) -> bool:
    try:
        return 37 < float(lat) < 46 and 55 < float(lng) < 76
    except (TypeError, ValueError):
        return False


def _is_placeholder_gps(lat, lng) -> bool:
    try:
        lat_f = float(lat)
        lng_f = float(lng)
    except (TypeError, ValueError):
        return True
    if not _gps_ok(lat_f, lng_f):
        return True
    return (abs(lat_f - 41.3111) < 0.003 and abs(lng_f - 69.2797) < 0.003) or (
        abs(lat_f - 41.31) < 0.003 and abs(lng_f - 69.28) < 0.003
    )


def reys_key(order: Order) -> tuple[str, str]:
    date = str(getattr(order, "delivery_date", "") or "")[:10]
    code = str(getattr(order, "route_code", "") or "").strip()
    return (date, code)


def _dist2(a: tuple[float, float], b: tuple[float, float]) -> float:
    dy = (a[0] - b[0]) * 111.0
    dx = (a[1] - b[1]) * 85.0
    return dx * dx + dy * dy


def _norm_wh_name(value) -> str:
    return " ".join(str(value or "").strip().lower().split())


def match_warehouse(warehouses: list[Warehouse], name: str) -> Warehouse | None:
    key = _norm_wh_name(name)
    if not key:
        return None
    for row in warehouses:
        if _norm_wh_name(row.name) == key:
            return row
    return None


def pick_warehouse(warehouses: list[Warehouse], orders: list[Order] | None = None, name: str = "") -> Warehouse | None:
    found = match_warehouse(warehouses, name)
    if found:
        return found
    ids = {getattr(o, "warehouse_id", None) for o in (orders or []) if getattr(o, "warehouse_id", None)}
    if len(ids) == 1:
        wid = next(iter(ids))
        found = next((w for w in warehouses if w.id == wid), None)
        if found:
            return found
    default = next((w for w in warehouses if w.is_default and w.is_active), None)
    if default:
        return default
    active = next((w for w in warehouses if w.is_active), None)
    return active or (warehouses[0] if warehouses else None)


def apply_warehouse(order: Order, warehouse: Warehouse | None) -> None:
    if not warehouse:
        return
    order.warehouse_id = warehouse.id
    if warehouse.name:
        order.pickup_address = warehouse.name
    if _gps_ok(warehouse.lat, warehouse.lng):
        order.pickup_lat = float(warehouse.lat)
        order.pickup_lng = float(warehouse.lng)


def warehouse_origin(warehouse: Warehouse | None) -> tuple[float, float] | None:
    if warehouse and _gps_ok(warehouse.lat, warehouse.lng):
        return (float(warehouse.lat), float(warehouse.lng))
    return None


def org_warehouses(db: Session, org_id: int | None) -> list[Warehouse]:
    if not org_id:
        return []
    return (
        db.query(Warehouse)
        .filter(Warehouse.org_id == org_id, Warehouse.is_active.is_(True))
        .order_by(Warehouse.is_default.desc(), Warehouse.id.asc())
        .all()
    )


def _two_opt(coords: list[tuple[float, float]]) -> list[int]:
    return _two_opt_from(None, coords)


def _two_opt_from(origin: tuple[float, float] | None, coords: list[tuple[float, float]]) -> list[int]:
    n = len(coords)
    idx = list(range(n))
    if n < (3 if origin else 4):
        return idx

    def point(pos: int) -> tuple[float, float] | None:
        if pos < 0:
            return origin
        return coords[idx[pos]] if pos < n else None

    def edge(a: tuple[float, float] | None, b: tuple[float, float] | None) -> float:
        return _dist2(a, b) if a is not None and b is not None else 0.0

    # Ochiq yo‘l: i..k bo‘lagini teskari qilganda faqat ikki chetdagi qirra o‘zgaradi
    improved = True
    guard = 0
    while improved and guard < 80:
        improved = False
        guard += 1
        for i in range(0 if origin else 1, n - 1):
            for k in range(i + 1, n):
                before, first, last, after = point(i - 1), point(i), point(k), point(k + 1)
                delta = edge(before, last) + edge(first, after) - edge(before, first) - edge(last, after)
                if delta < -1e-9:
                    idx[i : k + 1] = idx[i : k + 1][::-1]
                    improved = True
    return idx


def sequence_driver_orders(orders: list[Order], origin: tuple[float, float] | None = None) -> None:
    if not orders:
        return
    gps = [o for o in orders if _gps_ok(o.dropoff_lat, o.dropoff_lng)]
    gps_ids = {o.id for o in gps}
    rest = [o for o in orders if o.id not in gps_ids]
    if not gps:
        for i, o in enumerate(orders, 1):
            o.stop_no = i
        return
    start = origin if origin and _gps_ok(*origin) and not _is_placeholder_gps(*origin) else None
    if not start:
        cand = (float(gps[0].pickup_lat or 0), float(gps[0].pickup_lng or 0))
        if _gps_ok(*cand) and not _is_placeholder_gps(*cand) and getattr(gps[0], "warehouse_id", None):
            start = cand
        else:
            start = (float(gps[0].dropoff_lat), float(gps[0].dropoff_lng))
    remaining = gps[:]
    ordered: list[Order] = []
    cur = start
    while remaining:
        j = min(range(len(remaining)), key=lambda i: _dist2(cur, (remaining[i].dropoff_lat, remaining[i].dropoff_lng)))
        chosen = remaining.pop(j)
        ordered.append(chosen)
        cur = (chosen.dropoff_lat, chosen.dropoff_lng)
    opt = _two_opt_from(start if _gps_ok(*start) else None, [(o.dropoff_lat, o.dropoff_lng) for o in ordered])
    ordered = [ordered[i] for i in opt]
    for i, o in enumerate(ordered, 1):
        o.stop_no = i
    for i, o in enumerate(rest, len(ordered) + 1):
        o.stop_no = i


def sequence_drivers(db: Session, driver_ids, org_id: int | None = None) -> None:
    ids = [int(i) for i in driver_ids if i]
    if not ids:
        return
    q = db.query(Order).filter(Order.driver_id.in_(ids), Order.status.notin_(DONE_STATUSES))
    if org_id:
        q = q.filter(Order.org_id == org_id)
    by: dict[tuple, list[Order]] = defaultdict(list)
    for order in q.all():
        date, code = reys_key(order)
        by[(order.driver_id, date, code)].append(order)
    oid = org_id
    if not oid and by:
        oid = next(iter(by.values()))[0].org_id
    warehouses = org_warehouses(db, oid)
    for group in by.values():
        sequence_driver_orders(group, warehouse_origin(pick_warehouse(warehouses, group)))


def resequence_org(db: Session, org_id: int | None) -> None:
    if not org_id:
        return
    ids = [d.id for d in db.query(Driver.id).filter(Driver.org_id == org_id).all()]
    sequence_drivers(db, ids, org_id)
