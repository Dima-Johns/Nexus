import mimetypes
import re
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles

from .api import UPLOAD_DIR, router
from .reports_api import router as reports_router
from .database import Base, SessionLocal, engine
from .migrate import migrate_schema
from .seed import ensure_agents, ensure_default_templates, ensure_driver_logins, ensure_phone_format, seed_if_empty
from .tracking import start_simulator, stop_simulator

# Railway konteyneridagi mime bazasida .webp yo‘q — logo octet-stream bo‘lib ketadi
mimetypes.add_type("image/webp", ".webp")

STATIC_DIR = Path(__file__).resolve().parent.parent / "static"
SPA_ROUTES = {"", "login", "dashboard", "orders", "drivers", "agents", "warehouses", "settings", "admin", "reports"}


@asynccontextmanager
async def lifespan(_: FastAPI):
    Base.metadata.create_all(bind=engine)
    migrate_schema()
    db = SessionLocal()
    try:
        from .models import SessionToken
        from .seed import ensure_dispatcher_perms, ensure_org_codes, ensure_superadmin, ensure_tenancy

        ensure_tenancy(db)
        ensure_dispatcher_perms(db)
        db.query(SessionToken).filter(SessionToken.driver_id.is_(None)).delete()
        db.commit()
        seed_if_empty(db)
        ensure_superadmin(db)
        ensure_org_codes(db)
        ensure_default_templates(db)
        ensure_agents(db)
        ensure_phone_format(db)
        ensure_driver_logins(db)
    finally:
        db.close()
    start_simulator()
    yield
    stop_simulator()


app = FastAPI(
    title="Nexus Logistika API",
    description="Mobil ilova uchun REST API asosidagi logistika platformasi",
    version="1.0.0",
    lifespan=lifespan,
)

MAX_BODY_MB = 25


class BodyLimitMiddleware:
    """Juda katta so‘rovni o‘qimasdan rad etadi: xotira to‘lib server qulamasin."""

    def __init__(self, app, max_bytes: int):
        self.app = app
        self.max_bytes = max_bytes

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        length = dict(scope.get("headers") or []).get(b"content-length")
        too_big = JSONResponse(
            {"detail": f"So‘rov hajmi juda katta (ko‘pi bilan {MAX_BODY_MB} MB)"}, status_code=413
        )
        if length is not None and (not length.isdigit() or int(length) > self.max_bytes):
            return await too_big(scope, receive, send)
        received = 0

        async def limited_receive():
            nonlocal received
            message = await receive()
            if message["type"] == "http.request":
                received += len(message.get("body", b""))
                if received > self.max_bytes:
                    raise ValueError("request body too large")
            return message

        return await self.app(scope, limited_receive, send)


app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.add_middleware(BodyLimitMiddleware, max_bytes=MAX_BODY_MB * 1024 * 1024)

FIELD_LABELS = {
    "username": "Login",
    "password": "Parol",
    "current_password": "Joriy parol",
    "full_name": "To‘liq ism",
    "name": "Nomi",
    "new_name": "Yangi nom",
    "phone": "Telefon",
    "address": "Manzil",
    "pickup_address": "Olish manzili",
    "dropoff_address": "Yetkazish manzili",
    "code": "Kod",
    "notes": "Izoh",
    "note": "Izoh",
    "description": "Tavsif",
    "company": "Kompaniya",
    "region": "Hudud",
    "cargo": "Yuk",
    "route_code": "Yo‘nalish",
    "sales_rep": "Agent",
    "agent_code": "Agent kodi",
    "vehicle_plate": "Davlat raqami",
    "vehicle_type": "Transport turi",
    "lat": "Latitude",
    "lng": "Longitude",
    "amount": "Summa",
    "weight_kg": "Og‘irlik",
    "commission_pct": "Komissiya",
    "idle_timeout_minutes": "Faolsizlik vaqti",
    "ids": "Tanlangan zayavkalar",
    "permissions": "Dostuplar",
    "mapping": "Ustunlar moslamasi",
    "q": "Qidiruv",
    "comment": "Izoh",
}


def _validation_message(err: dict) -> str:
    loc = [str(x) for x in err.get("loc", []) if x not in ("body", "query", "path")]
    field = next((x for x in reversed(loc) if not x.isdigit()), "")
    label = FIELD_LABELS.get(field, field or "Qiymat")
    ctx = err.get("ctx") or {}
    kind = err.get("type", "")
    if kind == "string_too_long":
        return f"«{label}» juda uzun: ko‘pi bilan {ctx.get('max_length')} belgi"
    if kind == "too_long":
        return f"«{label}»: ko‘pi bilan {ctx.get('max_length')} ta bo‘lishi mumkin"
    if kind in ("less_than_equal", "less_than"):
        return f"«{label}» juda katta: ko‘pi bilan {ctx.get('le', ctx.get('lt'))}"
    if kind in ("greater_than_equal", "greater_than"):
        return f"«{label}» juda kichik: kamida {ctx.get('ge', ctx.get('gt'))}"
    if kind == "missing":
        return f"«{label}» to‘ldirilishi shart"
    return f"«{label}» noto‘g‘ri kiritilgan"


@app.exception_handler(RequestValidationError)
async def validation_error(_: Request, exc: RequestValidationError):
    messages = list(dict.fromkeys(_validation_message(e) for e in exc.errors()))
    return JSONResponse({"detail": "; ".join(messages[:3])}, status_code=422)

app.include_router(router)
app.include_router(reports_router)
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
app.mount("/uploads", StaticFiles(directory=UPLOAD_DIR), name="uploads")


RESERVED = {"docs", "redoc", "openapi.json", "uploads"}
_build = re.search(r"app\.js\?v=(\d+)", (STATIC_DIR / "index.html").read_text(encoding="utf-8"))
FRONTEND_VERSION = f"v={_build.group(1)}" if _build else ""


@app.get("/api/version")
def frontend_version():
    return JSONResponse({"version": FRONTEND_VERSION}, headers={"Cache-Control": "no-store"})


@app.get("/driver")
def driver_app_redirect():
    return RedirectResponse("/driver/", status_code=307)


@app.get("/driver/")
def driver_app():
    return FileResponse(STATIC_DIR / "driver.html", headers={"Cache-Control": "no-cache"})


@app.get("/driver/sw.js")
def driver_sw():
    return FileResponse(
        STATIC_DIR / "driver-sw.js",
        media_type="application/javascript",
        headers={"Service-Worker-Allowed": "/driver/", "Cache-Control": "no-cache"},
    )


@app.get("/")
@app.get("/{page}")
def spa(page: str = ""):
    return FileResponse(STATIC_DIR / "index.html", headers={"Cache-Control": "no-cache"})
