"""Klientlar bazasi: ommaviy o'chirish (POST /api/clients/base/bulk-delete) tekshiruvi."""
import json
import sys
import urllib.error
import urllib.request

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8000/api"
PASSWORD = sys.argv[2] if len(sys.argv) > 2 else "admin123"


def call(method, path, token=None, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(req) as r:
            return r.status, json.loads(r.read() or b"null")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"null")


st, res = call("POST", "/auth/login", body={"username": "admin", "password": PASSWORD})
assert st == 200, (st, res)
tok = res["token"]

made = []
for i in range(3):
    st, row = call("POST", "/clients", tok, {"name": f"BulkTest {i}", "code": f"BT-{i}", "address": "Toshkent"})
    assert st == 200, (st, row)
    made.append(row["id"])
before = {c["id"] for c in call("GET", "/clients/base", tok)[1]}
assert set(made) <= before

st, res = call("POST", "/clients/base/bulk-delete", tok, {"ids": []})
print("empty ids ->", st)
st, res = call("POST", "/clients/base/bulk-delete", tok, {"ids": [999999999]})
assert st == 404, (st, res)
st, res = call("POST", "/clients/base/bulk-delete", tok, {"ids": made + [999999999]})
assert st == 200 and res["deleted"] == 3, (st, res)
after = {c["id"] for c in call("GET", "/clients/base", tok)[1]}
assert not (set(made) & after), "o'chmagan klient qoldi"
assert len(before) - len(after) == 3

st, trash = call("GET", "/trash?entity=client&q=BulkTest", tok)
assert st == 200 and trash["total"] >= 3, (st, trash.get("total"))
print("OK: 3 ta klient o'chirildi, arxivda", trash["total"])
