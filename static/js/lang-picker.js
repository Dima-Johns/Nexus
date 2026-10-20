import { api, me, setMe, token } from "./api.js";
import { LANGS, getLang, setLang } from "./i18n.js?v=91";

// Serverga yozilmagan tanlov: keyingi yuklanishda serverdagi eski til uni bosib ketmasligi uchun
const PENDING_KEY = "nx_lang_pending";

async function saveServerLang(code) {
  try {
    setMe(await api("/auth/me", { method: "PUT", body: { lang: code } }));
    localStorage.removeItem(PENDING_KEY);
  } catch {
    localStorage.setItem(PENDING_KEY, code);
  }
}

/** Kirgan foydalanuvchida til serverga ham yoziladi — boshqa qurilmada ham shu til ochiladi. */
export async function chooseLang(code) {
  if (code === getLang()) return;
  if (token && me) await saveServerLang(code);
  setLang(code);
}

/** Boshqa qurilmada tanlangan til shu yerga ham o‘tadi. */
export function syncServerLang() {
  const server = me?.lang;
  const pending = localStorage.getItem(PENDING_KEY);
  if (pending) {
    if (pending !== getLang() || server === pending) localStorage.removeItem(PENDING_KEY);
    else {
      saveServerLang(pending);
      return;
    }
  }
  if (server && LANGS.some((l) => l.code === server) && server !== getLang()) setLang(server);
}

const GLOBE =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M3 12h18" /><path d="M12 3a14 14 0 0 1 0 18" /><path d="M12 3a14 14 0 0 0 0 18" /></svg>';

let openMenu = null;

function placeMenu(btn, menu, up = false) {
  const r = btn.getBoundingClientRect();
  const width = Math.max(menu.offsetWidth || 170, 170);
  const left = Math.max(8, Math.min(window.innerWidth - width - 8, r.right - width));
  menu.style.left = `${Math.round(left)}px`;
  menu.style.right = "auto";
  if (up) {
    menu.style.top = "auto";
    menu.style.bottom = `${Math.round(window.innerHeight - r.top + 6)}px`;
  } else {
    menu.style.bottom = "auto";
    menu.style.top = `${Math.round(r.bottom + 6)}px`;
  }
}

function closeOpen() {
  if (!openMenu) return;
  openMenu.menu.classList.add("hidden");
  openMenu.btn.setAttribute("aria-expanded", "false");
  openMenu = null;
}

document.addEventListener("click", (e) => {
  if (openMenu && !openMenu.wrap.contains(e.target) && !openMenu.menu.contains(e.target)) closeOpen();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeOpen();
});
window.addEventListener(
  "resize",
  () => {
    if (openMenu) placeMenu(openMenu.btn, openMenu.menu, openMenu.up);
  },
  { passive: true }
);
window.addEventListener(
  "scroll",
  () => {
    if (openMenu) placeMenu(openMenu.btn, openMenu.menu, openMenu.up);
  },
  { passive: true, capture: true }
);

/** Globus tugmasi + tillar ro‘yxati. Tarjimaga tushmasligi uchun data-no-i18n. */
export function mountLangPicker(host, { up = false } = {}) {
  if (!host) return;
  const cur = LANGS.find((l) => l.code === getLang()) || LANGS[0];
  host.classList.add("lang-pick");
  host.setAttribute("data-no-i18n", "");
  host.innerHTML = `
    <button type="button" class="lang-btn" aria-haspopup="menu" aria-expanded="false" title="Til / Language">
      ${GLOBE}<b>${cur.short}</b>
    </button>
    <div class="lang-menu glass hidden${up ? " up" : ""}" role="menu">
      ${LANGS.map(
        (l) =>
          `<button type="button" role="menuitemradio" aria-checked="${l.code === cur.code}" class="${l.code === cur.code ? "active" : ""}" data-lang="${l.code}"><b>${l.short}</b><span>${l.label}</span></button>`
      ).join("")}
    </div>`;
  const btn = host.querySelector(".lang-btn");
  const menu = host.querySelector(".lang-menu");
  // Xarita Leaflet pane ustida qolishi uchun bodyga chiqaramiz
  if (menu.parentElement !== document.body) document.body.appendChild(menu);
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    const wasOpen = openMenu?.menu === menu;
    closeOpen();
    if (wasOpen) return;
    menu.classList.remove("hidden");
    placeMenu(btn, menu, up);
    btn.setAttribute("aria-expanded", "true");
    openMenu = { wrap: host, menu, btn, up };
  });
  menu.addEventListener("click", (e) => {
    const item = e.target.closest("[data-lang]");
    if (!item) return;
    closeOpen();
    chooseLang(item.dataset.lang);
  });
}
