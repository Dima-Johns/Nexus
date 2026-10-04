import { bindNavigation, render } from "./router.js?v=68";
import { bindWorkspace } from "./workspace.js?v=68";
import { bindDriverAccessModal } from "./driver-access.js?v=68";
import { me, setMe, setToken, token } from "./api.js";
import { applyTheme, bindThemeToggle, currentTheme } from "./theme.js?v=68";

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

// index.html dagi app.js?v= bilan bir xil bo‘lishi shart — server /api/version shundan oladi
const BUILD = "v=68";
let reloading = false;
async function checkBuild() {
  if (reloading || document.hidden) return;
  try {
    const res = await fetch("/api/version", { cache: "no-store" });
    const { version } = await res.json();
    if (version && version !== BUILD) {
      reloading = true;
      location.reload();
    }
  } catch {
    // tarmoq uzilgan bo‘lsa keyingi tekshiruvda qayta urinadi
  }
}
document.addEventListener("visibilitychange", checkBuild);
window.addEventListener("popstate", checkBuild);
setInterval(checkBuild, 5 * 60 * 1000);

bindNavigation();
bindWorkspace();
bindDriverAccessModal();
bindIdleWatch();
bindThemeToggle(document.getElementById("theme-toggle"));
render();
