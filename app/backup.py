"""Butun bazaning zaxira nusxasi: har jadval alohida CSV, hammasi bitta ZIP ichida.

Server almashtirilganda eski serverdan yuklab olinadi va yangisida «Bazani tiklash» bilan yoziladi.
Sessiya tokenlari nusxaga kirmaydi: fayl qo‘lga tushsa ham birovning akkauntiga kirib bo‘lmasin.
"""

import base64
import csv
import io
import json
import logging
import os
import sys
import tempfile
import zipfile
from datetime import date, datetime, timezone

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from sqlalchemy import Boolean, Date, DateTime, Float, Integer, LargeBinary, Numeric, select, text
from starlette.background import BackgroundTask

from . import models  # noqa: F401  (jadvallar metadata'ga yozilsin)
from .auth import require_superadmin
from .database import Base, engine
from .models import User

log = logging.getLogger("nexus")
router = APIRouter(prefix="/api/admin/backup", tags=["backup"])

APP_ID = "nexus-logistika"
FORMAT = 1
NULL = r"\N"
SKIP_TABLES = {"session_tokens"}
CONFIRM_WORD = "TIKLASH"
BATCH = 500

csv.field_size_limit(min(sys.maxsize, 2**31 - 1))


def _tables():
    return [t for t in Base.metadata.sorted_tables if t.name not in SKIP_TABLES]


def _enc(v) -> str:
    if v is None:
        return NULL
    if isinstance(v, bool):
        return "1" if v else "0"
    if isinstance(v, (bytes, bytearray, memoryview)):
        return base64.b64encode(bytes(v)).decode("ascii")
    if isinstance(v, (datetime, date)):
        return v.isoformat()
    s = str(v)
    # "\N" (bo‘sh qiymat belgisi) bilan adashmasin: teskari chiziq bilan boshlangan matnga bitta qo‘shiladi
    return "\\" + s if s.startswith("\\") else s


def _dec(col, s: str):
    if s == NULL:
        return None
    t = col.type
    if isinstance(t, Boolean):
        return s in ("1", "true", "True", "t")
    if isinstance(t, Integer):
        return int(s) if s != "" else None
    if isinstance(t, Float):
        return float(s) if s != "" else None
    if isinstance(t, Numeric):
        return float(s) if s != "" else None
    if isinstance(t, DateTime):
        if not s:
            return None
        d = datetime.fromisoformat(s)
        if t.timezone and d.tzinfo is None:
            d = d.replace(tzinfo=timezone.utc)
        return d
    if isinstance(t, Date):
        return date.fromisoformat(s) if s else None
    if isinstance(t, LargeBinary):
        return base64.b64decode(s) if s else b""
    return s[1:] if s.startswith("\\") else s


def write_backup(path: str) -> dict:
    manifest = {
        "app": APP_ID,
        "format": FORMAT,
        "created_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "null": NULL,
        "skipped": sorted(SKIP_TABLES),
        "tables": {},
    }
    with engine.connect() as conn, zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED, allowZip64=True) as zf:
        for table in _tables():
            cols = list(table.columns)
            pk = list(table.primary_key.columns) or cols[:1]
            rows = 0
            with zf.open(f"{table.name}.csv", "w", force_zip64=True) as raw:
                out = io.TextIOWrapper(raw, encoding="utf-8-sig", newline="")
                w = csv.writer(out)
                w.writerow([c.name for c in cols])
                result = conn.execution_options(stream_results=True, yield_per=BATCH).execute(select(*cols).order_by(*pk))
                for part in result.partitions(BATCH):
                    for r in part:
                        w.writerow([_enc(v) for v in r])
                    rows += len(part)
                out.flush()
                out.detach()
            manifest["tables"][table.name] = {"rows": rows, "columns": [c.name for c in cols]}
        conn.rollback()
        zf.writestr("manifest.json", json.dumps(manifest, ensure_ascii=False, indent=2))
    return manifest


def _read_manifest(zf: zipfile.ZipFile) -> dict:
    try:
        manifest = json.loads(zf.read("manifest.json").decode("utf-8"))
    except KeyError:
        raise HTTPException(400, "Bu Nexus zaxira fayli emas: manifest.json topilmadi")
    except ValueError:
        raise HTTPException(400, "manifest.json buzilgan")
    if manifest.get("app") != APP_ID:
        raise HTTPException(400, "Bu Nexus zaxira fayli emas")
    if int(manifest.get("format") or 0) > FORMAT:
        raise HTTPException(400, "Zaxira dasturning yangiroq versiyasida olingan — avval serverni yangilang")
    names = set(zf.namelist())
    for name in (manifest.get("tables") or {}):
        if f"{name}.csv" not in names:
            raise HTTPException(400, f"Zaxirada {name}.csv yo‘q — fayl to‘liq emas")
    return manifest


def _header(zf: zipfile.ZipFile, name: str) -> list[str]:
    with zf.open(f"{name}.csv") as raw:
        return next(csv.reader(io.TextIOWrapper(raw, encoding="utf-8-sig", newline="")), [])


def restore_backup(fileobj) -> dict:
    try:
        zf = zipfile.ZipFile(fileobj)
    except zipfile.BadZipFile:
        raise HTTPException(400, "Fayl ZIP emas. «Bazani yuklab olish» bergan .zip faylni tanlang")
    with zf:
        manifest = _read_manifest(zf)
        in_backup = set(manifest.get("tables") or {})
        tables = _tables()
        plan = []
        for table in tables:
            if table.name not in in_backup:
                continue
            header = _header(zf, table.name)
            known = {c.name for c in table.columns}
            pk = [c.name for c in table.primary_key.columns]
            if any(k not in header for k in pk):
                raise HTTPException(400, f"{table.name}.csv da asosiy ustun ({', '.join(pk)}) yo‘q")
            plan.append((table, header, [h for h in header if h in known]))
        if not plan:
            raise HTTPException(400, "Zaxirada tiklanadigan jadval yo‘q")

        counts: dict[str, int] = {}
        pg = engine.dialect.name == "postgresql"
        # Hammasi bitta tranzaksiyada: biror qator xato bo‘lsa, baza avvalgi holicha qoladi
        with engine.begin() as conn:
            names = [t.name for t in Base.metadata.sorted_tables]
            if pg:
                conn.execute(text("SET LOCAL lock_timeout = '30s'"))
                conn.execute(text("TRUNCATE " + ", ".join(f'"{n}"' for n in names) + " RESTART IDENTITY CASCADE"))
            else:
                for n in reversed(names):
                    conn.execute(text(f'DELETE FROM "{n}"'))
            for table, header, cols in plan:
                idx = [(header.index(c), table.columns[c]) for c in cols]
                n = 0
                batch = []
                with zf.open(f"{table.name}.csv") as raw:
                    reader = csv.reader(io.TextIOWrapper(raw, encoding="utf-8-sig", newline=""))
                    next(reader, None)
                    for line, row in enumerate(reader, start=2):
                        if not row:
                            continue
                        try:
                            batch.append({col.name: _dec(col, row[i]) for i, col in idx})
                        except (ValueError, IndexError) as exc:
                            raise HTTPException(400, f"{table.name}.csv, {line}-qator buzilgan: {exc}")
                        if len(batch) >= BATCH:
                            conn.execute(table.insert(), batch)
                            n += len(batch)
                            batch = []
                if batch:
                    conn.execute(table.insert(), batch)
                    n += len(batch)
                counts[table.name] = n
            if pg:
                for table in tables:
                    pk = list(table.primary_key.columns)
                    if len(pk) != 1 or not isinstance(pk[0].type, Integer):
                        continue
                    col = pk[0].name
                    conn.execute(
                        text(
                            f"SELECT setval(seq, COALESCE((SELECT MAX(\"{col}\") FROM \"{table.name}\"), 1), "
                            f"(SELECT MAX(\"{col}\") FROM \"{table.name}\") IS NOT NULL) "
                            f"FROM pg_get_serial_sequence('{table.name}', '{col}') AS seq WHERE seq IS NOT NULL"
                        )
                    )
    missing = [t.name for t in tables if t.name not in in_backup]
    return {"ok": True, "created_at": manifest.get("created_at", ""), "tables": counts, "missing": missing}


def _drop(path: str) -> None:
    try:
        os.remove(path)
    except OSError:
        pass


@router.get("")
def download_backup(user: User = Depends(require_superadmin)):
    fd, path = tempfile.mkstemp(prefix="nexus-backup-", suffix=".zip")
    os.close(fd)
    try:
        manifest = write_backup(path)
    except Exception:
        _drop(path)
        log.exception("Zaxira nusxa yaratilmadi")
        raise HTTPException(500, "Zaxira nusxani yaratib bo‘lmadi")
    total = sum(t["rows"] for t in manifest["tables"].values())
    log.info("Zaxira nusxa: %s qator, %s (%s)", total, os.path.getsize(path), user.username)
    stamp = datetime.now().strftime("%Y%m%d-%H%M")
    return FileResponse(
        path,
        media_type="application/zip",
        filename=f"nexus-baza-{stamp}.zip",
        background=BackgroundTask(_drop, path),
        headers={"Cache-Control": "no-store"},
    )


@router.post("/restore")
def upload_restore(
    file: UploadFile = File(...),
    confirm: str = Form(""),
    user: User = Depends(require_superadmin),
):
    if confirm.strip().upper() != CONFIRM_WORD:
        raise HTTPException(400, f"Tasdiqlash uchun «{CONFIRM_WORD}» so‘zini yozing")
    log.warning("Baza zaxiradan tiklanmoqda (%s, %s)", user.username, file.filename)
    result = restore_backup(file.file)
    log.warning("Baza tiklandi: %s", result["tables"])
    return result
