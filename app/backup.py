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
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy import Boolean, Date, DateTime, Float, Integer, LargeBinary, Numeric, delete, func, insert, select, text, update
from starlette.background import BackgroundTask

from . import models  # noqa: F401  (jadvallar metadata'ga yozilsin)
from .auth import require_superadmin
from .database import Base, engine
from .models import SystemBackup, SystemBackupChunk, User

log = logging.getLogger("nexus")
router = APIRouter(prefix="/api/admin/backup", tags=["backup"])

APP_ID = "nexus-logistika"
FORMAT = 1
NULL = r"\N"
# Serverda saqlangan zaxiralar nusxaga ham kirmaydi, tiklashda ham o‘chirilmaydi
KEEP_TABLES = {"system_backups", "system_backup_chunks"}
SKIP_TABLES = {"session_tokens"} | KEEP_TABLES
CONFIRM_WORD = "TIKLASH"
WIPE_WORD = "TOZALASH"
BATCH = 500
CHUNK = 8 * 1024 * 1024

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
            names = [t.name for t in Base.metadata.sorted_tables if t.name not in KEEP_TABLES]
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


# --- Server ichida saqlanadigan zaxiralar -------------------------------------------------------


def _who(user: User) -> str:
    return (user.full_name or user.username or "")[:160]


def _backup_out(b: SystemBackup) -> dict:
    return {
        "id": b.id,
        "reason": b.reason,
        "created_by": b.created_by,
        "created_at": b.created_at.isoformat() if b.created_at else None,
        "size": int(b.size or 0),
        "rows": int(b.rows or 0),
        "complete": bool(b.complete),
    }


def store_backup(reason: str, user: User) -> SystemBackup:
    """Butun bazani ZIP qilib, bo‘laklab system_backup_chunks ga yozadi. Xato bo‘lsa — hech narsa qolmaydi."""
    fd, path = tempfile.mkstemp(prefix="nexus-backup-", suffix=".zip")
    os.close(fd)
    bid = None
    try:
        manifest = write_backup(path)
        rows = sum(t["rows"] for t in manifest["tables"].values())
        size = os.path.getsize(path)
        with engine.begin() as conn:
            bid = conn.execute(
                insert(SystemBackup)
                .values(
                    reason=reason[:160],
                    created_by=_who(user),
                    size=size,
                    rows=rows,
                    manifest_json=json.dumps({k: v["rows"] for k, v in manifest["tables"].items()}),
                    complete=False,
                    created_at=datetime.now(timezone.utc),
                )
                .returning(SystemBackup.id)
            ).scalar_one()
        with open(path, "rb") as fh:
            seq = 0
            while True:
                part = fh.read(CHUNK)
                if not part:
                    break
                with engine.begin() as conn:
                    conn.execute(insert(SystemBackupChunk).values(backup_id=bid, seq=seq, data=part))
                seq += 1
        with engine.begin() as conn:
            conn.execute(update(SystemBackup).where(SystemBackup.id == bid).values(complete=True))
            row = conn.execute(select(SystemBackup).where(SystemBackup.id == bid)).one()
        log.warning("Serverda zaxira saqlandi #%s: %s qator, %s bayt (%s)", bid, rows, size, user.username)
        return SystemBackup(**row._mapping)
    except Exception:
        log.exception("Serverda zaxira saqlanmadi")
        if bid is not None:
            _forget_backup(bid)
        raise HTTPException(500, "Zaxira nusxani saqlab bo‘lmadi — hech narsa o‘chirilmadi")
    finally:
        _drop(path)


def _forget_backup(bid: int) -> None:
    with engine.begin() as conn:
        conn.execute(delete(SystemBackupChunk).where(SystemBackupChunk.backup_id == bid))
        conn.execute(delete(SystemBackup).where(SystemBackup.id == bid))


def _saved_or_404(bid: int) -> SystemBackup:
    with engine.connect() as conn:
        row = conn.execute(select(SystemBackup).where(SystemBackup.id == bid)).first()
    if not row or not row._mapping["complete"]:
        raise HTTPException(404, "Zaxira topilmadi")
    return SystemBackup(**row._mapping)


def _chunk_seqs(bid: int) -> list[int]:
    with engine.connect() as conn:
        return [
            s
            for (s,) in conn.execute(
                select(SystemBackupChunk.seq).where(SystemBackupChunk.backup_id == bid).order_by(SystemBackupChunk.seq)
            )
        ]


def _iter_chunks(bid: int):
    # Har bo‘lak alohida o‘qiladi: katta zaxira xotirani to‘ldirmasin
    for seq in _chunk_seqs(bid):
        with engine.connect() as conn:
            data = conn.execute(
                select(SystemBackupChunk.data).where(SystemBackupChunk.backup_id == bid, SystemBackupChunk.seq == seq)
            ).scalar_one()
        yield bytes(data)


@router.get("/saved")
def list_saved(user: User = Depends(require_superadmin)):
    with engine.connect() as conn:
        rows = conn.execute(select(SystemBackup).order_by(SystemBackup.id.desc())).all()
    items = [_backup_out(SystemBackup(**r._mapping)) for r in rows]
    return {"items": items, "total_size": sum(i["size"] for i in items if i["complete"])}


@router.post("/saved")
def create_saved(user: User = Depends(require_superadmin)):
    return _backup_out(store_backup("Qo‘lda saqlangan nusxa", user))


@router.get("/saved/{bid}/download")
def download_saved(bid: int, user: User = Depends(require_superadmin)):
    b = _saved_or_404(bid)
    stamp = (b.created_at or datetime.now(timezone.utc)).astimezone().strftime("%Y%m%d-%H%M")
    return StreamingResponse(
        _iter_chunks(bid),
        media_type="application/zip",
        headers={
            "Content-Disposition": f'attachment; filename="nexus-baza-{stamp}-{bid}.zip"',
            "Content-Length": str(b.size),
            "Cache-Control": "no-store",
        },
    )


@router.post("/saved/{bid}/restore")
def restore_saved(bid: int, confirm: str = Form(""), user: User = Depends(require_superadmin)):
    if confirm.strip().upper() != CONFIRM_WORD:
        raise HTTPException(400, f"Tasdiqlash uchun «{CONFIRM_WORD}» so‘zini yozing")
    _saved_or_404(bid)
    fd, path = tempfile.mkstemp(prefix="nexus-restore-", suffix=".zip")
    os.close(fd)
    try:
        with open(path, "wb") as fh:
            for part in _iter_chunks(bid):
                fh.write(part)
        log.warning("Baza serverdagi zaxira #%s dan tiklanmoqda (%s)", bid, user.username)
        with open(path, "rb") as fh:
            result = restore_backup(fh)
        log.warning("Baza tiklandi: %s", result["tables"])
        return result
    finally:
        _drop(path)


@router.delete("/saved/{bid}")
def delete_saved(bid: int, user: User = Depends(require_superadmin)):
    with engine.connect() as conn:
        found = conn.execute(select(SystemBackup.id).where(SystemBackup.id == bid)).first()
    if not found:
        raise HTTPException(404, "Zaxira topilmadi")
    _forget_backup(bid)
    log.warning("Serverdagi zaxira #%s o‘chirildi (%s)", bid, user.username)
    return {"ok": True}


# --- Umumiy tozalash -----------------------------------------------------------------------------

WIPE_SCOPES = {
    "orders": "Zayavkalar (barcha holatdagi), tasdiq rasmlari, tarix va kunlik rejalar",
    "clients": "Klientlar bazasi",
    "drivers": "Haydovchilar (ilova kirishlari va GPS izlari bilan)",
    "gps": "GPS izlari",
    "agents": "Agentlar",
    "warehouses": "Skladlar",
    "trash": "O‘chirilganlar arxivi",
}


class WipeIn(BaseModel):
    scopes: list[str] = Field(default_factory=list, max_length=20)
    confirm: str = Field("", max_length=40)


def _count(conn, table: str) -> int:
    return int(conn.execute(text(f'SELECT COUNT(*) FROM "{table}"')).scalar() or 0)


def wipe_data(scopes: set[str]) -> dict[str, int]:
    """Tanlangan bo‘limlarni bitta tranzaksiyada o‘chiradi. Tashkilotlar, akkauntlar, dostuplar, shablonlar qoladi.

    S3/R2 omboridagi rasm fayllari o‘chirilmaydi: zaxira nusxa ularga havola qiladi.
    """
    pg = engine.dialect.name == "postgresql"
    counts: dict[str, int] = {}
    with engine.begin() as conn:
        if pg:
            conn.execute(text("SET LOCAL lock_timeout = '30s'"))

        def clear(table: str) -> None:
            # Bu jadvallarga boshqa jadval bog‘lanmagan: TRUNCATE tez va diskni darhol bo‘shatadi
            counts[table] = counts.get(table, 0) + _count(conn, table)
            conn.execute(text(f'TRUNCATE "{table}"' if pg else f'DELETE FROM "{table}"'))

        def run(table: str, sql: str) -> None:
            counts[table] = counts.get(table, 0) + int(conn.execute(text(sql)).rowcount or 0)

        orders = "orders" in scopes
        drivers = "drivers" in scopes
        if orders:
            for t in ("order_events", "proof_photos", "proof_photo_extras", "orders", "day_plans"):
                clear(t)
        if "clients" in scopes:
            if not orders:
                conn.execute(text("UPDATE orders SET client_id = NULL WHERE client_id IS NOT NULL"))
            run("clients", "DELETE FROM clients")
        if drivers:
            if not orders:
                conn.execute(text("UPDATE orders SET driver_id = NULL, stop_no = 0 WHERE driver_id IS NOT NULL"))
            conn.execute(text("DELETE FROM session_tokens WHERE driver_id IS NOT NULL"))
            clear("gps_pings")
            run("drivers", "DELETE FROM drivers")
        elif "gps" in scopes:
            clear("gps_pings")
        if "agents" in scopes:
            if not drivers:
                conn.execute(text("UPDATE drivers SET agent_id = NULL WHERE agent_id IS NOT NULL"))
            run("agents", "DELETE FROM agents")
        if "warehouses" in scopes:
            if not orders:
                conn.execute(text("UPDATE orders SET warehouse_id = NULL WHERE warehouse_id IS NOT NULL"))
            run("warehouses", "DELETE FROM warehouses")
        if "trash" in scopes:
            clear("deleted_records")
    return counts


@router.get("/wipe/scopes")
def wipe_scopes(user: User = Depends(require_superadmin)):
    tables = {
        "orders": "orders",
        "clients": "clients",
        "drivers": "drivers",
        "gps": "gps_pings",
        "agents": "agents",
        "warehouses": "warehouses",
        "trash": "deleted_records",
    }
    with engine.connect() as conn:
        return {"items": [{"key": k, "label": v, "count": _count(conn, tables[k])} for k, v in WIPE_SCOPES.items()]}


@router.post("/wipe")
def wipe(payload: WipeIn, user: User = Depends(require_superadmin)):
    if payload.confirm.strip().upper() != WIPE_WORD:
        raise HTTPException(400, f"Tasdiqlash uchun «{WIPE_WORD}» so‘zini yozing")
    scopes = {s for s in payload.scopes if s in WIPE_SCOPES}
    if not scopes:
        raise HTTPException(400, "Nimani o‘chirishni tanlang")
    labels = ", ".join(WIPE_SCOPES[s].split(" (")[0] for s in WIPE_SCOPES if s in scopes)
    saved = store_backup(f"Umumiy tozalashdan oldin: {labels}"[:160], user)
    log.warning("Umumiy tozalash boshlandi (%s): %s", user.username, sorted(scopes))
    try:
        counts = wipe_data(scopes)
    except Exception:
        log.exception("Umumiy tozalash bajarilmadi")
        raise HTTPException(500, "Tozalash bajarilmadi — ma’lumotlar o‘zgarmadi. Zaxira nusxa saqlab qolindi.")
    log.warning("Umumiy tozalash tugadi: %s (zaxira #%s)", counts, saved.id)
    return {"ok": True, "deleted": counts, "backup": _backup_out(saved)}
