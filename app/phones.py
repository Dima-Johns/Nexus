import re

_DIGITS = re.compile(r"\D+")

# O‘zbekiston operator / hudud kodlari: +998 XX XXX XX XX
PHONE_MASK = "+998 {code} {a} {b} {c}"


def phone_digits(value: str) -> str:
    return _DIGITS.sub("", str(value or ""))


def format_uz_phone(value: str) -> str:
    raw = str(value or "").strip()
    if not raw:
        return ""
    digits = phone_digits(raw)
    if digits.startswith("998"):
        rest = digits[3:]
    elif digits.startswith("8") and len(digits) >= 10:
        rest = digits[1:]
    else:
        rest = digits
    if len(rest) < 9:
        return raw
    rest = rest[-9:]
    return PHONE_MASK.format(code=rest[:2], a=rest[2:5], b=rest[5:7], c=rest[7:9])
