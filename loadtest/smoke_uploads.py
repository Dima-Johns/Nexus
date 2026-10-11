"""Fayl yuklanadigan endpointlar ishlashini tekshiradi (lokal server, superadmin)."""
import io
import sys
from pathlib import Path

import httpx
from openpyxl import Workbook

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8000"
PNG = (Path(__file__).resolve().parent.parent / "postman" / "test-proof.png").read_bytes()


def xlsx(rows):
    wb = Workbook()
    for r in rows:
        wb.active.append(r)
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
ok = True
with httpx.Client(base_url=BASE, timeout=60) as c:
    tok = c.post("/api/auth/login", json={"username": "admin", "password": "admin123"}).json()["token"]
    h = {"Authorization": f"Bearer {tok}"}

    def check(name, r, want):
        global ok
        good = r.status_code in want
        ok &= good
        print(f"{'OK ' if good else 'XATO'} {name}: {r.status_code} {r.text[:120]}")

    check("avatar yuklash", c.post("/api/auth/me/avatar", headers=h, files={"file": ("a.png", PNG, "image/png")}), {200})
    check("avatar o'chirish", c.delete("/api/auth/me/avatar", headers=h), {200})
    check("avatar: rasm emas", c.post("/api/auth/me/avatar", headers=h, files={"file": ("a.txt", b"salom", "text/plain")}), {400})
    table = xlsx([["Mijoz", "Manzil", "Summa"], ["Test do'kon", "Toshkent", 1000]])
    check("templates/inspect", c.post("/api/templates/inspect", headers=h, files={"file": ("t.xlsx", table, XLSX)}), {200})
    check("templates/inspect: buzuq fayl", c.post("/api/templates/inspect", headers=h, files={"file": ("t.xlsx", b"xx", XLSX)}), {400})
    check("drivers/import: buzuq fayl", c.post("/api/drivers/import", headers=h, files={"file": ("d.xlsx", b"xx", XLSX)}), {400})
    check("orders/import: buzuq fayl", c.post("/api/orders/import", headers=h, files={"file": ("o.xlsx", b"xx", XLSX)}), {400})
    tpls = c.get("/api/templates", headers=h)
    items = tpls.json() if tpls.status_code == 200 else []
    approved = [t for t in items if t.get("status") == "approved"]
    if approved:
        check(f"templates/{approved[0]['id']}/import: buzuq fayl",
              c.post(f"/api/templates/{approved[0]['id']}/import", headers=h, files={"file": ("o.xlsx", b"xx", XLSX)}), {400})
    check("templates/999999/import: yo'q shablon",
          c.post("/api/templates/999999/import", headers=h, files={"file": ("o.xlsx", table, XLSX)}), {404})
print("HAMMASI OK" if ok else "XATOLAR BOR")
