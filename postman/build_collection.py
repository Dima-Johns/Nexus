"""Nexus API uchun Postman kolleksiyasini yaratadi: python postman/build_collection.py"""

import json
from pathlib import Path

HERE = Path(__file__).resolve().parent


def test(*lines: str) -> list[dict]:
    return [{"listen": "test", "script": {"type": "text/javascript", "exec": list(lines)}}]


def status(code: int) -> str:
    return f'pm.test("status {code}", () => pm.response.to.have.status({code}));'


JSON_OK = 'pm.test("JSON javob", () => pm.response.to.be.json);'
ARRAY = 'pm.test("massiv qaytdi", () => pm.expect(pm.response.json()).to.be.an("array"));'


def req(name, method, path, *tests, body=None, auth="admin", form=None, pre=None):
    headers = []
    if auth == "admin":
        headers.append({"key": "Authorization", "value": "Bearer {{token}}"})
    elif auth == "driver":
        headers.append({"key": "Authorization", "value": "Bearer {{driverToken}}"})
    elif auth == "dispatcher":
        headers.append({"key": "Authorization", "value": "Bearer {{dispToken}}"})
    elif auth == "bogus":
        headers.append({"key": "Authorization", "value": "Bearer soxta-token-0000"})
    request = {"method": method, "header": headers, "url": "{{baseUrl}}" + path}
    if body is not None:
        headers.append({"key": "Content-Type", "value": "application/json"})
        request["body"] = {"mode": "raw", "raw": json.dumps(body, ensure_ascii=False)}
    if form is not None:
        request["body"] = {"mode": "formdata", "formdata": form}
    events = test(*tests)
    if pre:
        events.append({"listen": "prerequest", "script": {"type": "text/javascript", "exec": pre}})
    return {"name": name, "request": request, "event": events}


def folder(name, *items):
    return {"name": name, "item": list(items)}


public = folder(
    "1. Ochiq va himoya",
    req("Versiya", "GET", "/api/version", status(200), 'pm.test("versiya bor", () => pm.expect(pm.response.json().version).to.match(/^v=\\d+$/));', auth=None),
    req("Login sahifasi", "GET", "/login", status(200), 'pm.test("HTML", () => pm.expect(pm.response.text()).to.include("<html"));', auth=None),
    req("Haydovchi ilovasi", "GET", "/driver/", status(200), auth=None),
    req("Tokensiz zayavkalar → 401", "GET", "/api/orders", status(401), auth=None),
    req("Tokensiz rasm → 401", "GET", "/api/orders/1/proof-photo", status(401), auth=None),
    req("Tokensiz hisobot → 401", "GET", "/api/reports/overview", status(401), auth=None),
    req("Soxta token → 401", "GET", "/api/auth/me", status(401), auth="bogus"),
    req(
        "Noto‘g‘ri parol → 401",
        "POST",
        "/api/auth/login",
        status(401),
        body={"username": "{{username}}", "password": "notogri-parol-123", "org_code": "{{orgCode}}"},
        auth=None,
    ),
)

auth = folder(
    "2. Kirish",
    req(
        "Admin login",
        "POST",
        "/api/auth/login",
        status(200),
        'const d = pm.response.json();',
        'pm.test("token keldi", () => pm.expect(d.token).to.be.a("string").and.not.empty);',
        'pm.collectionVariables.set("token", d.token);',
        'pm.collectionVariables.set("orgId", d.user.org_id || "");',
        'pm.collectionVariables.set("myOrgCode", d.user.org_code || "");',
        body={"username": "{{username}}", "password": "{{password}}", "org_code": "{{orgCode}}"},
        auth=None,
    ),
    req("Profil (auth/me)", "GET", "/api/auth/me", status(200), 'pm.test("rol bor", () => pm.expect(pm.response.json().role).to.be.oneOf(["superadmin","admin","dispatcher"]));'),
    req("Ruxsatlar katalogi", "GET", "/api/permissions", status(200), 'pm.test("proofs.view bor", () => pm.expect(JSON.stringify(pm.response.json())).to.include("proofs.view"));'),
)

reads = folder(
    "3. O‘qish (GET)",
    req("Zayavkalar", "GET", "/api/orders", status(200), ARRAY),
    req("Haydovchilar", "GET", "/api/drivers", status(200), ARRAY),
    req("Agentlar", "GET", "/api/agents", status(200), ARRAY),
    req("Skladlar", "GET", "/api/warehouses", status(200), ARRAY),
    req("Klientlar", "GET", "/api/clients", status(200), ARRAY),
    req("Klientlar bazasi", "GET", "/api/clients/base", status(200), ARRAY),
    req("Foydalanuvchilar", "GET", "/api/users", status(200), ARRAY),
    req("Tashkilotlar", "GET", "/api/orgs", status(200), ARRAY),
    req("Dashboard statistika", "GET", "/api/dashboard/stats", status(200), JSON_OK),
    req("Jonli kuzatuv", "GET", "/api/tracking/live", status(200), JSON_OK),
    req("Import shablonlari", "GET", "/api/templates", status(200), ARRAY),
    req("Shablon maydonlari", "GET", "/api/templates/fields", status(200), JSON_OK),
    req("O‘chirilganlar", "GET", "/api/trash", status(200), JSON_OK),
    req("Hisobot: filtrlar", "GET", "/api/reports/options", status(200), JSON_OK),
    req("Hisobot: umumiy", "GET", "/api/reports/overview", status(200), 'pm.test("jami ko‘rsatkichlar bor", () => pm.expect(pm.response.json().summary).to.have.property("orders"));'),
    req("Hisobot: zayavkalar", "GET", "/api/reports/orders?limit=5", status(200), 'pm.test("total bor", () => pm.expect(pm.response.json()).to.have.property("total"));'),
    req("Pivot maydonlari", "GET", "/api/reports/pivot/fields", status(200), JSON_OK),
    req("Pivot hisob", "POST", "/api/reports/pivot", status(200), JSON_OK, body={}),
    req("Saqlangan pivotlar", "GET", "/api/reports/layouts", status(200), JSON_OK),
    req(
        "Klientlar Excel",
        "GET",
        "/api/clients/base/export",
        status(200),
        'pm.test("xlsx", () => pm.expect(pm.response.headers.get("Content-Type")).to.include("spreadsheetml"));',
    ),
    req(
        "Haydovchi shabloni Excel",
        "GET",
        "/api/templates/excel?entity=drivers",
        status(200),
        'pm.test("xlsx", () => pm.expect(pm.response.headers.get("Content-Type")).to.include("spreadsheetml"));',
    ),
)

SUFFIX = "{{$timestamp}}"

crud = folder(
    "4. Yaratish → o‘zgartirish → o‘chirish",
    req(
        "Sklad yaratish",
        "POST",
        "/api/warehouses",
        status(200),
        'pm.collectionVariables.set("whId", pm.response.json().id);',
        body={"name": "Postman test sklad", "address": "Toshkent", "lat": 41.31, "lng": 69.28},
    ),
    req("Sklad o‘chirish", "DELETE", "/api/warehouses/{{whId}}", status(200)),
    req(
        "Agent yaratish",
        "POST",
        "/api/agents",
        status(200),
        'pm.collectionVariables.set("agentId", pm.response.json().id);',
        body={"name": "Postman agent", "code": "{{freeAgentCode}}"},
        pre=[
            "// Agent kodi 01–99: tashkilotda band bo‘lmaganini tanlaymiz",
            "pm.sendRequest({url: pm.variables.replaceIn('{{baseUrl}}/api/agents'), header: {Authorization: 'Bearer ' + pm.collectionVariables.get('token')}}, (err, res) => {",
            "  const used = new Set((res.json() || []).map((a) => String(a.code)));",
            "  for (let i = 99; i >= 1; i--) { const c = String(i).padStart(2, '0'); if (!used.has(c)) { pm.collectionVariables.set('freeAgentCode', c); break; } }",
            "});",
        ],
    ),
    req("Agent tahrirlash", "PUT", "/api/agents/{{agentId}}", status(200), 'pm.test("nom o‘zgardi", () => pm.expect(pm.response.json().name).to.eql("Postman agent 2"));', body={"name": "Postman agent 2", "code": "{{freeAgentCode}}"}),
    req("Agent o‘chirish", "DELETE", "/api/agents/{{agentId}}", status(200)),
    req(
        "Haydovchi yaratish",
        "POST",
        "/api/drivers",
        status(200),
        'pm.collectionVariables.set("drvId", pm.response.json().id);',
        body={"name": "Postman haydovchi"},
    ),
    req(
        "Haydovchiga login/parol berish",
        "POST",
        "/api/drivers/{{drvId}}/access",
        status(200),
        'pm.test("login saqlandi", () => pm.expect(pm.response.json().username).to.eql("pm" + pm.collectionVariables.get("agentCode")));',
        body={"username": "pm{{agentCode}}", "password": "pm-test-1234"},
    ),
    req(
        "Zayavka yaratish (haydovchiga)",
        "POST",
        "/api/orders",
        status(200),
        'pm.collectionVariables.set("orderId", pm.response.json().id);',
        body={"pickup_address": "Sklad", "dropoff_address": "Postman test manzil", "driver_id": "{{drvIdNum}}", "cargo": "Postman"},
    ),
    req("Rasm hali yo‘q → 404", "GET", "/api/orders/{{orderId}}/proof-photo", status(404)),
    req(
        "Zayavka tahrirlash",
        "PUT",
        "/api/orders/{{orderId}}",
        status(200),
        'pm.test("yuk o‘zgardi", () => pm.expect(pm.response.json().cargo).to.eql("Postman 2"));',
        body={"pickup_address": "Sklad", "dropoff_address": "Postman test manzil", "driver_id": "{{drvIdNum}}", "cargo": "Postman 2"},
    ),
)

driver = folder(
    "5. Haydovchi ilovasi API",
    req(
        "Haydovchi login",
        "POST",
        "/api/auth/driver-login",
        status(200),
        'pm.collectionVariables.set("driverToken", pm.response.json().token);',
        body={"username": "pm{{agentCode}}", "password": "pm-test-1234"},
        auth=None,
    ),
    req("Haydovchi profili", "GET", "/api/driver/me", status(200), auth="driver"),
    req("Marshrut", "GET", "/api/driver/route", status(200), auth="driver"),
    req(
        "GPS + sinxron",
        "POST",
        "/api/driver/sync",
        status(200),
        'pm.test("zayavka marshrutda", () => pm.expect(JSON.stringify(pm.response.json())).to.include("Postman test manzil"));',
        body={"points": [{"lat": 41.31, "lng": 69.28, "accuracy": 5}]},
        auth="driver",
    ),
    req(
        "Yetkazildi + rasm",
        "POST",
        "/api/driver/orders/{{orderId}}/proof",
        status(200),
        'pm.test("rasm bazada", () => pm.expect(pm.response.json().order.proof_photo).to.include("/proof-photo"));',
        form=[
            {"key": "result", "value": "delivered", "type": "text"},
            {"key": "reason", "value": "fridge_yes", "type": "text"},
            {"key": "comment", "value": "Postman test", "type": "text"},
            {"key": "photo", "type": "file", "src": "{{proofFile}}", "contentType": "image/png"},
        ],
        auth="driver",
    ),
    req(
        "Admin rasmni ko‘radi → 200",
        "GET",
        "/api/orders/{{orderId}}/proof-photo",
        status(200),
        'pm.test("rasm", () => pm.expect(pm.response.headers.get("Content-Type")).to.include("image/"));',
    ),
    req("Haydovchi boshqa yo‘lni ololmaydi → 401", "GET", "/api/orders", status(401), auth="driver"),
)

perms = folder(
    "6. Ruxsatlar (dostup)",
    req(
        "Dispetcher yaratish",
        "POST",
        "/api/users",
        status(200),
        'pm.collectionVariables.set("dispId", pm.response.json().id);',
        body={"username": "pmdisp{{agentCode}}", "password": "pm-disp-1234", "full_name": "Postman dispetcher", "role": "dispatcher", "org_id": "{{orgIdNum}}", "permissions": ["orders.view"]},
    ),
    req(
        "Dispetcher login",
        "POST",
        "/api/auth/login",
        status(200),
        'pm.collectionVariables.set("dispToken", pm.response.json().token);',
        body={"username": "pmdisp{{agentCode}}", "password": "pm-disp-1234", "org_code": "{{myOrgCode}}"},
        auth=None,
    ),
    req("Ruxsatsiz rasm → 403", "GET", "/api/orders/{{orderId}}/proof-photo", status(403), auth="dispatcher"),
    req("Ruxsatsiz o‘chirish → 403", "DELETE", "/api/orders/{{orderId}}", status(403), auth="dispatcher"),
    req(
        "Superadmin proofs.view beradi",
        "PUT",
        "/api/users/{{dispId}}/permissions",
        status(200),
        body={"permissions": ["orders.view", "proofs.view"]},
    ),
    req("Ruxsat bilan rasm → 200", "GET", "/api/orders/{{orderId}}/proof-photo", status(200), auth="dispatcher"),
)

cleanup = folder(
    "7. Tozalash",
    req("Test zayavkani o‘chirish", "DELETE", "/api/orders/{{orderId}}", status(200)),
    req("O‘chgan zayavka rasmi → 404", "GET", "/api/orders/{{orderId}}/proof-photo", status(404)),
    req("Test haydovchini o‘chirish", "DELETE", "/api/drivers/{{drvId}}", status(200)),
    req("Test dispetcherni o‘chirish", "DELETE", "/api/users/{{dispId}}", status(200)),
)

PRE = [
    "// Har ishga tushirishda yangi kod — test obyektlari boshqalari bilan to‘qnashmasin",
    'if (!pm.collectionVariables.get("agentCode")) pm.collectionVariables.set("agentCode", String(Date.now()).slice(-6));',
    'const n = (k) => pm.collectionVariables.get(k);',
    'pm.collectionVariables.set("drvIdNum", n("drvId") || "");',
    'pm.collectionVariables.set("orgIdNum", n("orgId") || "");',
]
# JSON tanasida raqam kerak bo‘lgan joylarda "{{x}}" → {{x}}
NUM_FIX = [
    "if (pm.request.body && pm.request.body.mode === 'raw') {",
    "  pm.request.body.raw = pm.request.body.raw.replace(/\"\\{\\{(drvIdNum|orgIdNum)\\}\\}\"/g, (m, k) => n(k) || 'null');",
    "}",
]
GLOBAL_TEST = ['pm.test("javob 5 soniyadan tez", () => pm.expect(pm.response.responseTime).to.be.below(5000));']

collection = {
    "info": {
        "name": "Nexus Logistika API",
        "description": "Dispetcher paneli, haydovchi ilovasi, hisobotlar va dostuplar tekshiruvi. Test obyektlari oxirida o‘chiriladi.",
        "schema": "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
    },
    "event": [
        {"listen": "prerequest", "script": {"type": "text/javascript", "exec": PRE + NUM_FIX}},
        {"listen": "test", "script": {"type": "text/javascript", "exec": GLOBAL_TEST}},
    ],
    "variable": [{"key": k, "value": ""} for k in ("token", "driverToken", "dispToken", "orgId", "myOrgCode", "whId", "agentId", "drvId", "orderId", "dispId", "agentCode", "freeAgentCode")],
    "item": [public, auth, reads, crud, driver, perms, cleanup],
}


def env(name, base, username, password, org_code=""):
    return {
        "name": name,
        "values": [
            {"key": "baseUrl", "value": base, "enabled": True},
            {"key": "username", "value": username, "enabled": True},
            {"key": "password", "value": password, "type": "secret", "enabled": True},
            {"key": "orgCode", "value": org_code, "enabled": True},
            {"key": "proofFile", "value": str(HERE / "test-proof.png"), "enabled": True},
        ],
    }


(HERE / "Nexus-API.postman_collection.json").write_text(json.dumps(collection, ensure_ascii=False, indent=2), encoding="utf-8")
(HERE / "Nexus-local.postman_environment.json").write_text(
    json.dumps(env("Nexus local", "http://127.0.0.1:8000", "admin", ""), ensure_ascii=False, indent=2), encoding="utf-8"
)
(HERE / "Nexus-prod.postman_environment.json").write_text(
    json.dumps(env("Nexus prod", "https://nexuslogistic.up.railway.app", "admin", ""), ensure_ascii=False, indent=2), encoding="utf-8"
)
print("ok")
