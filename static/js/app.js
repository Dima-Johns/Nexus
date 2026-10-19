import "./i18n.js?v=91";
import { bindNavigation, render } from "./router.js?v=97";
import { bindProfile } from "./profile.js?v=95";
import { bindWorkspace } from "./workspace.js?v=97";
import { bindDriverAccessModal } from "./driver-access.js?v=91";
import { me, setMe, setToken, token } from "./api.js";
import { applyTheme, bindThemeToggle, currentTheme } from "./theme.js?v=91";
import { watchInputLimits } from "./input-limits.js?v=91";

applyTheme(currentTheme());

let lastActivity = Date.now();
function bindIdleWatch() {
  const bump = () => {
    lastActivity = Date.now();
  };
  ["click", "keydown", "mousemove", "scroll", "touchstart"].forEach((ev) => {
    document.addEventListener(ev, bump, { passive: true });
  });
  setInterval(() => {
    const mins = Number(me?.idle_timeout_minutes || 0);
    if (!token || !me || mins <= 0) return;
    if (Date.now() - lastActivity > mins * 60 * 1000) {
      setToken("");
      setMe(null);
      history.replaceState({}, "", "/login");
      window.dispatchEvent(new PopStateEvent("popstate"));
    }
  }, 10000);
}

// index.html dagi app.js?v= bilan bir xil — import.meta.url orqali olinadi (qo‘lda yangilab unutilmasin)
const BUILD = (() => {
  try {
    const v = new URL(import.meta.url).searchParams.get("v");
    return v ? `v=${v}` : "";
  } catch {
    return "";
  }
})();

let reloading = false;
let updateBanner = null;

function showUpdateBanner() {
  if (updateBanner || reloading) return;
  const el = document.createElement("button");
  el.type = "button";
  el.className = "nx-update-banner";
  el.textContent = "Yangi versiya chiqdi — yangilash";
  el.onclick = () => {
    reloading = true;
    location.reload();
  };
  document.body.appendChild(el);
  updateBanner = el;
}

async function checkBuild() {
  if (reloading || !BUILD) return;
  try {
    const res = await fetch("/api/version", { cache: "no-store" });
    const { version } = await res.json();
    if (!version || version === BUILD) return;
    // Foydalanuvchi ishlayotganda majburiy reload qilinmasin
    const idleMs = Date.now() - lastActivity;
    if (document.hidden || idleMs > 120000) {
      reloading = true;
      location.reload();
      return;
    }
    showUpdateBanner();
  } catch {
    // tarmoq uzilgan bo‘lsa keyingi tekshiruvda qayta urinadi
  }
}

// Faqat sekin interval — tab almashtirish / navigatsiyada reload yo‘q
setInterval(checkBuild, 10 * 60 * 1000);
setTimeout(checkBuild, 15000);

watchInputLimits();
bindNavigation();
bindProfile();
bindWorkspace();
bindDriverAccessModal();
bindIdleWatch();
bindThemeToggle(document.getElementById("theme-toggle"));
render();
