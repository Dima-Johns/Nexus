"""Zayavka tarixi: har bir muhim amal order_events jadvaliga yoziladi."""

from datetime import datetime, timezone

from sqlalchemy import insert
from sqlalchemy.orm import Session

from .models import Driver, Order, OrderEvent, ProofPhoto, User

KIND_LABELS = {
    "imported": "Tizimga import qilindi",
    "reimported": "Qayta importda yangilandi",
    "created": "Qo‘lda yaratildi",
    "edited": "Tahrirlandi",
    "assigned": "Haydovchiga biriktirildi",
    "reassigned": "Boshqa haydovchiga o‘tkazildi",
    "planned": "Rejalashtirildi (Faolga o‘tdi)",
    "unassigned": "Kiruvchiga qaytarildi",
    "date": "Yetkazish sanasi o‘zgartirildi",
    "route": "Marshrut nomi o‘zgartirildi",
    "status": "Holat o‘zgartirildi",
    "started": "Haydovchi yo‘lga chiqdi",
    "photo": "Rasm olindi",
    "photo_uploaded": "Rasm serverga yuklandi",
    "delivered": "Yetkazildi (yakunlandi)",
    "returned": "Qaytarildi (yakunlandi)",
}

STATUS_LABELS = {
    "new": "Yangi",
    "assigned": "Tayinlangan",
    "in_transit": "Yo‘lda",
    "on_route": "Yo‘lda",
    "delivered": "Yetkazilgan",
    "returned": "Qaytarilgan",
    "cancelled": "Bekor qilingan",
}


def actor_of(user: User | None = None, driver: Driver | None = None) -> tuple[str, str]:
    if driver is not None:
        return (driver.name or "Haydovchi")[:160], "driver"
    if user is not None:
        return (user.full_name or user.username or "")[:160], "user"
    return "", "system"


def log_events(
    db: Session,
    orders,
    kind: str,
    *,
    user: User | None = None,
    driver: Driver | None = None,
    note: str = "",
    at: datetime | None = None,
    notes: dict[int, str] | None = None,
) -> None:
    """Bir nechta zayavkaga bitta amalni yozadi (orders — Order obyektlari, id'lari bo‘lishi kerak)."""
    actor, actor_type = actor_of(user, driver)
    when = at or datetime.now(timezone.utc)
    rows = [
        {
            "order_id": o.id,
            "org_id": o.org_id,
            "kind": kind,
            "note": ((notes or {}).get(o.id, note) or "")[:500],
            "actor": actor,
            "actor_type": actor_type,
            "at": when,
        }
        for o in orders
        if o is not None and o.id
    ]
    for i in range(0, len(rows), 1000):
        db.execute(insert(OrderEvent), rows[i : i + 1000])


def log_event(db: Session, order: Order, kind: str, **kw) -> None:
    log_events(db, [order], kind, **kw)


def delete_events(db: Session, cond) -> None:
    db.query(OrderEvent).filter(cond).delete(synchronize_session=False)


def _iso(d: datetime | None) -> str | None:
    if d is None:
        return None
    if d.tzinfo is None:
        d = d.replace(tzinfo=timezone.utc)
    # Hammasi UTC'da: satr bo‘yicha saralash vaqt bo‘yicha saralash bilan bir xil bo‘lsin
    return d.astimezone(timezone.utc).isoformat()


def order_timeline(db: Session, order: Order) -> list[dict]:
    """Yozilgan amallar + eski zayavkalar uchun maydonlardan tiklangan asosiy bosqichlar."""
    events = (
        db.query(OrderEvent)
        .filter(OrderEvent.order_id == order.id)
        .order_by(OrderEvent.at.asc(), OrderEvent.id.asc())
        .all()
    )
    items = [
        {
            "kind": e.kind,
            "title": KIND_LABELS.get(e.kind, e.kind),
            "note": e.note or "",
            "actor": e.actor or "",
            "actor_type": e.actor_type or "system",
            "at": _iso(e.at),
            "derived": False,
        }
        for e in events
    ]
    kinds = {e.kind for e in events}

    def derived(kind: str, at: datetime | None, note: str = "", actor: str = "", actor_type: str = "system"):
        if at is None:
            return
        items.append(
            {
                "kind": kind,
                "title": KIND_LABELS.get(kind, kind),
                "note": note,
                "actor": actor,
                "actor_type": actor_type,
                "at": _iso(at),
                "derived": True,
            }
        )

    if not kinds & {"imported", "created"}:
        manual = (order.code or "").startswith("ORD-")
        derived("created" if manual else "imported", order.created_at)
    driver_name = order.driver.name if order.driver else ""
    if order.status in ("delivered", "returned") and order.status not in kinds:
        note = order.proof_comment or ""
        derived(order.status, order.proof_at, note, driver_name, "driver" if driver_name else "system")
    if "photo_uploaded" not in kinds:
        photo = db.get(ProofPhoto, order.id)
        if photo is not None:
            derived("photo_uploaded", photo.created_at, "", driver_name, "driver" if driver_name else "system")
    items.sort(key=lambda x: x["at"] or "")
    return items
