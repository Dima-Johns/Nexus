"""Mahalliy tekshiruv: /driver/notices va /driver/location?reys=true yangi reysni ko‘rsatadimi."""
import json
import sys
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.auth import create_driver_token  # noqa: E402
from app.database import SessionLocal  # noqa: E402
from app.dispatch import local_today  # noqa: E402
from app.models import DONE_STATUSES, Driver, Order, SessionToken  # noqa: E402

BASE = "http://127.0.0.1:8000/api"


def call(path, token, method="GET", body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method)
    req.add_header("Authorization", f"Bearer {token}")
    if data:
        req.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.loads(r.read())


def main():
    db = SessionLocal()
    today = local_today()
    drv = db.query(Driver).filter(Driver.is_active.is_(True)).first()
    row = db.query(Order).filter(Order.org_id == drv.org_id).order_by(Order.id.desc()).first()
    if not row:
        print("Zayavka topilmadi")
        return
    token = create_driver_token(db, drv)
    db.commit()
    keep = {k: getattr(row, k) for k in ("route_code", "driver_id", "status", "delivery_date")}
    try:
        before = call("/driver/notices", token)["items"]
        print("Oldin:", [(g["key"], g["count"]) for g in before])
        loc = call("/driver/location?reys=true", token, "POST", {"points": []})
        print("location reys bor:", "reys" in loc, len(loc.get("reys", [])))
        plain = call("/driver/location", token, "POST", {"points": []})
        print("oddiy location reys yo‘q:", "reys" not in plain)
        row.route_code = "NTF-TEST"
        row.driver_id = drv.id
        row.status = "assigned"
        row.delivery_date = today
        db.commit()
        after = call("/driver/notices", token)["items"]
        new = {g["key"] for g in after} - {g["key"] for g in before}
        print("Yangi kalitlar:", new)
        assert any(k.endswith("|NTF-TEST") for k in new), "yangi reys topilmadi"
        print("OK")
    finally:
        for k, v in keep.items():
            setattr(row, k, v)
        db.query(SessionToken).filter(SessionToken.token == token).delete()
        db.commit()
        db.close()


if __name__ == "__main__":
    main()
