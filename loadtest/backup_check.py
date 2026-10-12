"""Mahalliy tekshiruv: zaxira yuklab olish -> tiklash -> yana yuklab olish, CSV'lar bir xil bo‘lishi kerak."""
import io
import json
import sys
import urllib.error
import urllib.request
import uuid
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sqlalchemy import text  # noqa: E402

from app.database import engine  # noqa: E402

BASE = "http://127.0.0.1:8000/api"
OUT = Path(__file__).resolve().parent / "results"


def req(path, token=None, method="GET", body=None, headers=None, raw=False):
    h = dict(headers or {})
    if token:
        h["Authorization"] = f"Bearer {token}"
    data = body
    if isinstance(body, dict):
        data = json.dumps(body).encode()
        h["Content-Type"] = "application/json"
    r = urllib.request.Request(BASE + path, data=data, method=method, headers=h)
    try:
        with urllib.request.urlopen(r, timeout=600) as resp:
            payload = resp.read()
            return resp.status, payload if raw else json.loads(payload or b"{}")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}")


def multipart(fields, file_bytes, filename):
    b = uuid.uuid4().hex
    parts = []
    for k, v in fields.items():
        parts.append(f'--{b}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n'.encode())
    parts.append(
        f'--{b}\r\nContent-Disposition: form-data; name="file"; filename="{filename}"\r\nContent-Type: application/zip\r\n\r\n'.encode()
        + file_bytes
        + b"\r\n"
    )
    parts.append(f"--{b}--\r\n".encode())
    return b"".join(parts), {"Content-Type": f"multipart/form-data; boundary={b}"}


def login():
    code, data = req("/auth/login", method="POST", body={"username": "admin", "password": "admin123"})
    assert code == 200, (code, data)
    return data["token"]


def csvs(blob):
    with zipfile.ZipFile(io.BytesIO(blob)) as zf:
        return {n: zf.read(n) for n in zf.namelist() if n.endswith(".csv")}, json.loads(zf.read("manifest.json"))


def main():
    OUT.mkdir(exist_ok=True)
    tok = login()
    code, a = req("/admin/backup", tok, raw=True)
    assert code == 200, (code, a)
    (OUT / "backup_a.zip").write_bytes(a)
    files_a, man_a = csvs(a)
    print("A:", len(a), "bayt;", {k: v["rows"] for k, v in man_a["tables"].items()})
    assert "session_tokens.csv" not in files_a

    code, d = req("/admin/backup/restore", tok, "POST", *multipart({"confirm": "yoq"}, a, "a.zip"))
    print("noto‘g‘ri tasdiq:", code, d.get("detail"))
    assert code == 400

    code, d = req("/admin/backup/restore", tok, "POST", *multipart({"confirm": "TIKLASH"}, b"not a zip", "x.zip"))
    print("ZIP emas:", code, d.get("detail"))
    assert code == 400

    broken = io.BytesIO()
    with zipfile.ZipFile(io.BytesIO(a)) as src, zipfile.ZipFile(broken, "w") as dst:
        for n in src.namelist():
            data = src.read(n)
            if n == "orders.csv":
                data = data + b"\r\nabc,def\r\n"
            dst.writestr(n, data)
    code, d = req("/admin/backup/restore", tok, "POST", *multipart({"confirm": "TIKLASH"}, broken.getvalue(), "b.zip"))
    print("buzilgan qator:", code, d.get("detail"))
    assert code == 400
    code, _ = req("/auth/me", tok)
    assert code == 200, "buzilgan fayldan keyin sessiya saqlanishi kerak edi (tranzaksiya qaytarilmagan)"

    code, d = req("/admin/backup/restore", tok, "POST", *multipart({"confirm": "TIKLASH"}, a, "a.zip"))
    print("tiklash:", code, d)
    assert code == 200 and d["ok"]
    code, _ = req("/auth/me", tok)
    print("eski token:", code)
    assert code == 401

    tok = login()
    code, b = req("/admin/backup", tok, raw=True)
    assert code == 200
    (OUT / "backup_b.zip").write_bytes(b)
    files_b, _ = csvs(b)
    diff = [n for n in files_a if files_a[n] != files_b.get(n)]
    print("farqli jadvallar:", diff)
    # users.last_login/agar kirish vaqti yozilsa farq qilishi mumkin — qolganlari bir xil bo‘lishi shart
    assert all(n in ("users.csv",) for n in diff), diff

    with engine.connect() as c:
        for t in ("orders", "clients", "agents", "drivers", "gps_pings"):
            mx = c.execute(text(f"SELECT COALESCE(MAX(id),0) FROM {t}")).scalar()
            nxt = c.execute(text(f"SELECT nextval(pg_get_serial_sequence('{t}','id'))")).scalar()
            assert nxt > mx, (t, nxt, mx)
            c.execute(text(f"SELECT setval(pg_get_serial_sequence('{t}','id'), {max(mx, 1)}, {'true' if mx else 'false'})"))
        c.commit()
    print("ketma-ketliklar to‘g‘ri")

    code, a1 = req("/agents", tok, "POST", body={"name": "BK test 1", "code": "97", "phone": "", "region": "", "commission_pct": 5, "is_active": True})
    code2, a2 = req("/agents", tok, "POST", body={"name": "BK test 2", "code": "98", "phone": "", "region": "", "commission_pct": 5, "is_active": True})
    print("agentlar yaratildi:", code, code2)
    code, d = req("/agents/bulk-delete", tok, "POST", body={"ids": [a1["id"], a2["id"]]})
    print("ommaviy o‘chirish:", code, d)
    assert code == 200 and d["deleted"] == 2
    code, lst = req("/agents", tok)
    assert not any(x["id"] in (a1["id"], a2["id"]) for x in lst)
    print("OK")


if __name__ == "__main__":
    main()
