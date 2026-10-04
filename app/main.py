import re
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles

from .api import UPLOAD_DIR, router
from .database import Base, SessionLocal, engine
from .migrate import migrate_schema
from .seed import ensure_agents, ensure_default_templates, ensure_driver_logins, ensure_phone_format, seed_if_empty
from .tracking import start_simulator, stop_simulator

STATIC_DIR = Path(__file__).resolve().parent.parent / "static"
SPA_ROUTES = {"", "login", "dashboard", "orders", "drivers", "agents", "warehouses", "settings", "admin"}


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

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(router)
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
