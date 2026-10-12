"""Brauzer tekshiruvi uchun: token | add | restore (holat loadtest/results/notices_ui.json da)."""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.auth import create_driver_token  # noqa: E402
from app.database import SessionLocal  # noqa: E402
from app.dispatch import local_today  # noqa: E402
from app.models import Driver, Order, SessionToken  # noqa: E402

STATE = Path(__file__).resolve().parent / "results" / "notices_ui.json"
FIELDS = ("route_code", "driver_id", "status", "delivery_date")


def main(cmd):
    db = SessionLocal()
    drv = db.query(Driver).filter(Driver.is_active.is_(True)).order_by(Driver.id).first()
    if cmd == "token":
        token = create_driver_token(db, drv)
        db.commit()
        STATE.parent.mkdir(exist_ok=True)
        STATE.write_text(json.dumps({"token": token, "driver": drv.id, "orders": {}}))
        print(token)
    elif cmd == "add":
        st = json.loads(STATE.read_text())
        drv = db.get(Driver, st["driver"])
        rows = db.query(Order).filter(Order.org_id == drv.org_id).order_by(Order.id.desc()).limit(3).all()
        for row in rows:
            st["orders"].setdefault(str(row.id), {k: getattr(row, k) for k in FIELDS})
            row.route_code, row.driver_id, row.status, row.delivery_date = "NTF-UI", drv.id, "assigned", local_today()
        db.commit()
        STATE.write_text(json.dumps(st))
        print("qo‘shildi:", [r.id for r in rows])
    elif cmd == "restore":
        st = json.loads(STATE.read_text())
        for oid, vals in st["orders"].items():
            row = db.get(Order, int(oid))
            for k, v in vals.items():
                setattr(row, k, v)
        db.query(SessionToken).filter(SessionToken.token == st["token"]).delete()
        db.commit()
        STATE.unlink()
        print("tiklandi")
    db.close()


if __name__ == "__main__":
    main(sys.argv[1])
