import { api } from "./api.js";
import { escapeHtml } from "./ui.js?v=74";

const L = window.L;
const CITY_CENTER = [41.3111, 69.2797];
const PICK_HINT = "Xaritada ofis joylashgan nuqtani bosing yoki manzilni qidiring. Belgini sudrab aniqlashtirish mumkin.";

export function mountOfficePicker(box, { address = "", lat = null, lng = null } = {}) {
  box.innerHTML = `
    <div class="office-search">
      <input type="search" data-office-q placeholder="Manzilni qidiring: ko‘cha, mahalla, mo‘ljal" />
      <button class="btn tiny" type="button" data-office-find>Qidirish</button>
    </div>
    <div class="office-results hidden" data-office-results></div>
    <div class="wh-pick-map office-map" data-office-map></div>
    <input class="office-address" data-office-address placeholder="Ofis manzili" maxlength="300" />
    <p class="muted adm-sub office-hint" data-office-hint></p>`;
  const q = box.querySelector("[data-office-q]");
  const results = box.querySelector("[data-office-results]");
  const addrEl = box.querySelector("[data-office-address]");
  const hint = box.querySelector("[data-office-hint]");

  let point = Number.isFinite(lat) && Number.isFinite(lng) ? [lat, lng] : null;
  let marker = null;
  let seq = 0;
  // Qo‘lda yozilgan manzil xaritadan aniqlangan manzil bilan almashtirilmaydi
  let typed = false;
  addrEl.value = address || "";
  addrEl.addEventListener("input", () => {
    typed = addrEl.value.trim() !== "";
  });

  const mapEl = box.querySelector("[data-office-map]");
  const map = L ? L.map(mapEl).setView(point || CITY_CENTER, point ? 16 : 12) : null;
  if (map) L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19 }).addTo(map);
  const sizer = map ? new ResizeObserver(() => map.invalidateSize()) : null;
  sizer?.observe(mapEl);

  const showHint = () => {
    hint.textContent = point ? `Belgilangan nuqta: ${point[0].toFixed(5)}, ${point[1].toFixed(5)}` : PICK_HINT;
  };

  const setMarker = () => {
    if (!map || !point) return;
    if (!marker) {
      marker = L.marker(point, { draggable: true }).addTo(map);
      marker.on("dragend", () => {
        const p = marker.getLatLng();
        place(p.lat, p.lng);
      });
    } else {
      marker.setLatLng(point);
    }
  };

  const place = async (plat, plng, found = "") => {
    point = [Number(plat), Number(plng)];
    setMarker();
    map?.setView(point, Math.max(map.getZoom(), 16));
    showHint();
    if (found) {
      addrEl.value = found;
      typed = false;
      return;
    }
    if (typed) return;
    const my = ++seq;
    addrEl.placeholder = "Manzil aniqlanmoqda…";
    const res = await api(`/geo/reverse?lat=${point[0]}&lng=${point[1]}`).catch(() => null);
    addrEl.placeholder = "Ofis manzili";
    if (my === seq && !typed && res?.address) addrEl.value = res.address;
  };

  const find = async () => {
    const text = q.value.trim();
    results.classList.remove("hidden");
    if (text.length < 3) {
      results.innerHTML = `<p class="muted">Kamida 3 belgi kiriting.</p>`;
      return;
    }
    results.innerHTML = `<p class="muted">Qidirilmoqda…</p>`;
    const list = await api(`/geo/search?q=${encodeURIComponent(text)}`).catch(() => []);
    if (!list.length) {
      results.innerHTML = `<p class="muted">Topilmadi. Xaritadan nuqtani bosing.</p>`;
      return;
    }
    results.innerHTML = list
      .map((r, i) => `<button type="button" class="office-result" data-i="${i}">${escapeHtml(r.address || `${r.lat}, ${r.lng}`)}</button>`)
      .join("");
    results.onclick = (e) => {
      const btn = e.target.closest("[data-i]");
      if (!btn) return;
      const r = list[Number(btn.dataset.i)];
      results.classList.add("hidden");
      place(r.lat, r.lng, r.address);
    };
  };

  box.querySelector("[data-office-find]").onclick = find;
  q.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    find();
  });
  map?.on("click", (e) => place(e.latlng.lat, e.latlng.lng));
  setMarker();
  showHint();

  return {
    value: () => ({ address: addrEl.value.trim(), lat: point ? point[0] : null, lng: point ? point[1] : null }),
    destroy: () => {
      seq++;
      sizer?.disconnect();
      map?.remove();
      box.innerHTML = "";
    },
  };
}
