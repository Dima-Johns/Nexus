import { bindNavigation, render } from "./router.js?v=63";
import { bindWorkspace } from "./workspace.js?v=63";
import { bindDriverAccessModal } from "./driver-access.js?v=63";
import { me, setMe, setToken, token } from "./api.js";
import { applyTheme, bindThemeToggle, currentTheme } from "./theme.js?v=63";

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

bindNavigation();
bindWorkspace();
bindDriverAccessModal();
bindIdleWatch();
bindThemeToggle(document.getElementById("theme-toggle"));
render();
