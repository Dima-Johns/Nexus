import { api, me, setMe, token } from "./api.js";
import { LANGS, getLang, setLang } from "./i18n.js?v=79";

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

function closeOpen() {
  if (!openMenu) return;
  openMenu.menu.classList.add("hidden");
  openMenu.btn.setAttribute("aria-expanded", "false");
  openMenu = null;
}

document.addEventListener("click", (e) => {
  if (openMenu && !openMenu.wrap.contains(e.target)) closeOpen();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeOpen();
});

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
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    const wasOpen = openMenu?.menu === menu;
    closeOpen();
    if (wasOpen) return;
    menu.classList.remove("hidden");
    btn.setAttribute("aria-expanded", "true");
    openMenu = { wrap: host, menu, btn };
  });
  menu.addEventListener("click", (e) => {
    const item = e.target.closest("[data-lang]");
    if (!item) return;
    closeOpen();
    chooseLang(item.dataset.lang);
  });
}
