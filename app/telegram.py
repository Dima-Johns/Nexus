"""Telegram bot: begona mahsulot bilan yopilgan zayavkani guruhga yuborish."""

from __future__ import annotations

import json
import logging
import mimetypes
import secrets
import threading
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

log = logging.getLogger("nexus.telegram")

API = "https://api.telegram.org"


def _multipart(fields: dict[str, str], files: dict[str, tuple[str, bytes, str]]) -> tuple[bytes, str]:
    boundary = "----NexusTG" + secrets.token_hex(8)
    parts: list[bytes] = []
    for name, value in fields.items():
        parts.append(
            (
                f"--{boundary}\r\n"
                f'Content-Disposition: form-data; name="{name}"\r\n\r\n'
                f"{value}\r\n"
            ).encode("utf-8")
        )
    for name, (filename, data, mime) in files.items():
        parts.append(
            (
                f"--{boundary}\r\n"
                f'Content-Disposition: form-data; name="{name}"; filename="{filename}"\r\n'
                f"Content-Type: {mime}\r\n\r\n"
            ).encode("utf-8")
        )
        parts.append(data)
        parts.append(b"\r\n")
    parts.append(f"--{boundary}--\r\n".encode("utf-8"))
    return b"".join(parts), f"multipart/form-data; boundary={boundary}"


def _api(token: str, method: str, *, fields: dict[str, str] | None = None, files: dict | None = None) -> dict:
    url = f"{API}/bot{token}/{method}"
    if files:
        body, ctype = _multipart(fields or {}, files)
        req = urllib.request.Request(url, data=body, method="POST", headers={"Content-Type": ctype})
    elif fields is not None:
        data = urllib.parse.urlencode(fields).encode("utf-8")
        req = urllib.request.Request(url, data=data, method="POST")
    else:
        req = urllib.request.Request(url, method="GET")
    try:
        with urllib.request.urlopen(req, timeout=45) as res:
            payload = json.loads(res.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")[:400]
        raise RuntimeError(f"Telegram {method} {exc.code}: {detail}") from exc
    except Exception as exc:
        raise RuntimeError(f"Telegram {method}: {exc}") from exc
    if not payload.get("ok"):
        raise RuntimeError(payload.get("description") or "Telegram xatosi")
    return payload.get("result") or {}


def bot_username(token: str) -> str:
    me = _api(token, "getMe")
    return str(me.get("username") or "")


def send_text(token: str, chat_id: str, text: str) -> None:
    _api(token, "sendMessage", fields={"chat_id": str(chat_id), "text": text[:4000], "disable_web_page_preview": "true"})


def send_photo(token: str, chat_id: str, photo: bytes, caption: str, mime: str | None = None) -> None:
    kind = (mime or "image/jpeg").split(";")[0].strip() or "image/jpeg"
    ext = mimetypes.guess_extension(kind) or ".jpg"
    if ext == ".jpe":
        ext = ".jpg"
    _api(
        token,
        "sendPhoto",
        fields={"chat_id": str(chat_id), "caption": caption[:1024]},
        files={"photo": (f"proof{ext}", photo, kind)},
    )


def format_foreign_goods_caption(
    *,
    order_code: str,
    amount: float | int | None,
    lat: float | None,
    lng: float | None,
    agent_name: str,
    agent_code: str,
    agent_phone: str,
    driver_name: str,
    client_name: str = "",
    address: str = "",
) -> str:
    summa = ""
    if amount is not None:
        try:
            n = float(amount)
            summa = f"{n:,.0f}".replace(",", " ") if n == int(n) else f"{n:,.2f}".replace(",", " ")
        except (TypeError, ValueError):
            summa = str(amount)
    loc = ""
    if lat is not None and lng is not None:
        loc = f"https://maps.google.com/?q={lat},{lng}"
    lines = [
        "Begona mahsulot bor",
        "",
        f"Zayavka: {order_code or '—'}",
    ]
    if client_name:
        lines.append(f"Mijoz: {client_name}")
    if address:
        lines.append(f"Manzil: {address}")
    lines.append(f"Summa: {summa or '—'}")
    lines.append(f"Lokatsiya: {loc or '—'}")
    agent = " · ".join(x for x in (agent_code, agent_name) if x) or "—"
    lines.append(f"Agent: {agent}")
    lines.append(f"Agent telefon: {agent_phone or '—'}")
    lines.append(f"Dastavchik: {driver_name or '—'}")
    return "\n".join(lines)


def notify_async(token: str, chat_id: str, *, photo: bytes | None, mime: str | None, caption: str) -> None:
    """Telegram javobini kutmasdan yuboradi — zayavka yopilishi kechikmasin."""

    def _run() -> None:
        try:
            if photo:
                send_photo(token, chat_id, photo, caption, mime)
            else:
                send_text(token, chat_id, caption)
        except Exception:
            log.exception("Telegram xabar yuborilmadi")

    threading.Thread(target=_run, daemon=True).start()


def org_telegram_ready(org: Any) -> bool:
    if not org or not getattr(org, "telegram_enabled", False):
        return False
    token = (getattr(org, "telegram_bot_token", "") or "").strip()
    chat = (getattr(org, "telegram_chat_id", "") or "").strip()
    return bool(token and chat)
