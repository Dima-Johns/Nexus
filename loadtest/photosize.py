"""Haqiqiy telefon rasmlari ilova zanjiridan o'tgandagi hajmi (faqat o'lchanadi, hech narsa saqlanmaydi).

python photosize.py rasm1.jpg rasm2.jpg ...
"""
import io
import sys
from pathlib import Path

from PIL import Image, ImageOps

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from app.api import shrink_proof_photo  # noqa: E402


def phone_side(raw: bytes) -> bytes:
    """driver-app.js compressImage: eng uzun tomon 1600 px, JPEG 0.78."""
    img = ImageOps.exif_transpose(Image.open(io.BytesIO(raw))).convert("RGB")
    img.thumbnail((1600, 1600))
    buf = io.BytesIO()
    img.save(buf, "JPEG", quality=78)
    return buf.getvalue()


sizes = []
for name in sys.argv[1:]:
    raw = Path(name).read_bytes()
    phone = phone_side(raw)
    final = shrink_proof_photo(phone, "image/jpeg")[0]
    sizes.append(len(final))
    print(f"{len(raw) // 1024:>6} KB -> telefon {len(phone) // 1024:>4} KB -> server {len(final) // 1024:>4} KB")
if sizes:
    print(f"o'rtacha saqlanadigan hajm: {sum(sizes) / len(sizes) / 1024:.0f} KB")
