import { api, can, me, setMe, setToken, token } from "./api.js";
import { $, $$ } from "./ui.js?v=75";
import { refreshWorkspace, syncWorkspace } from "./workspace.js?v=75";
import { renderProfile } from "./profile.js?v=75";

const ROUTES = {
  "/": "dashboard",
  "/dashboard": "dashboard",
  "/orders": "orders",
  "/drivers": "drivers",
  "/agents": "agents",
  "/warehouses": "warehouses",
  "/settings": "settings",
  "/admin": "admin",
  "/reports": "reports",
  "/login": "login",
};

const pageCache = {};
const panes = {};
let workspaceReady = false;
let current = { name: "", destroy: null };

function pathName() {
  return ROUTES[location.pathname] || "dashboard";
}

export function go(path, replace = false) {
  const url = path.startsWith("/") ? path : `/${path}`;
  if (replace) history.replaceState({}, "", url);
  else if (location.pathname !== url) history.pushState({}, "", url);
  render();
}

async function ensureAuth() {
  if (!token) return false;
  if (me) return true;
  try {
    setMe(await api("/auth/me"));
    return true;
  } catch {
    setToken("");
    setMe(null);
    return false;
  }
}

async function loadPage(name) {
  if (pageCache[name]) return pageCache[name];
  const pending = Promise.all([
    fetch(`/static/pages/${name}.html?v=75`),
    import(`/static/js/pages/${name}.js?v=75`),
  ]).then(async ([htmlRes, mod]) => {
      const packed = { html: await htmlRes.text(), mod };
      pageCache[name] = packed;
      return packed;
    }
  );
  pageCache[name] = pending;
  return pending.catch((err) => {
    delete pageCache[name];
    throw err;
  });
}

function prefetchPages() {
  ["dashboard", "drivers", "agents", "warehouses", "settings", "admin", ...(can("reports.view") ? ["reports"] : [])].forEach((name) => {
    loadPage(name).catch(() => {});
  });
}

function clearPanes() {
  Object.values(panes).forEach((el) => {
    el._mod?.destroy?.();
    el.remove();
  });
  Object.keys(panes).forEach((k) => delete panes[k]);
  current = { name: "", destroy: null };
  workspaceReady = false;
}

async function showPane(name) {
  const root = $("#page-root");
  let created = false;
  if (!panes[name]) {
    const { html, mod } = await loadPage(name);
    const pane = document.createElement("div");
    pane.className = "page-pane";
    pane.innerHTML = html;
    root.appendChild(pane);
    panes[name] = pane;
    pane._mod = mod;
    created = true;
  }
  Object.entries(panes).forEach(([n, el]) => {
    el.classList.toggle("hidden", n !== name);
  });
  if (created) await panes[name]._mod.init(panes[name]);
  Object.entries(panes).forEach(([n, el]) => {
    if (n === name) el._mod?.show?.();
    else el._mod?.hide?.();
  });
  current = { name, destroy: panes[name]?._mod?.destroy || null };
}

function applyPerms() {
  $$("[data-perm]").forEach((el) => {
    const ok = el.dataset.perm.split(",").some((k) => can(k.trim()));
    el.classList.toggle("hidden", !ok);
  });
}

export async function render() {
  const authed = await ensureAuth();
  const name = pathName();
  if (!authed) {
    if (location.pathname !== "/login") history.replaceState({}, "", "/login");
    $("#app-view").classList.add("hidden");
    $("#login-view").classList.remove("hidden");
    if (Object.keys(panes).length) clearPanes();
    if (current.name !== "login") {
      const { html, mod } = await loadPage("login");
      $("#login-view").innerHTML = html;
      current = { name: "login", destroy: mod.destroy || null };
      await mod.init($("#login-view"));
    }
    return;
  }

  if (name === "login") {
    go("/dashboard", true);
    return;
  }
  if (name === "orders") {
    go("/dashboard", true);
    return;
  }
  if (name === "warehouses" && !can("warehouses.view") && !can("warehouses.manage")) {
    go("/dashboard", true);
    return;
  }
  if (name === "admin" && !["admin.panel", "perms.manage", "orgs.manage", "users.manage", "clients.view", "trash.view"].some((k) => can(k))) {
    go("/settings", true);
    return;
  }
  if (name === "reports" && !can("reports.view")) {
    go("/dashboard", true);
    return;
  }

  $("#login-view").classList.add("hidden");
  $("#app-view").classList.remove("hidden");
  renderProfile();
  applyPerms();
  $$("a.icon-btn[data-link], a.htab[data-link]").forEach((a) => {
    const href = a.getAttribute("href");
    a.classList.toggle("active", href === `/${name}` || (name === "dashboard" && href === "/dashboard"));
  });
  $("#page-root").classList.toggle("page-map", name === "dashboard");

  const panePromise = showPane(name);
  if (!workspaceReady) {
    workspaceReady = true;
    await Promise.all([panePromise, refreshWorkspace().catch(() => {})]);
  } else {
    syncWorkspace();
    await panePromise;
  }
  applyPerms();
  prefetchPages();
}

let lastFocusSync = 0;
function syncOnReturn() {
  if (document.hidden || !me || !current.name || current.name === "login") return;
  if (Date.now() - lastFocusSync < 3000) return;
  lastFocusSync = Date.now();
  syncWorkspace();
  const mod = panes[current.name]?._mod;
  Promise.resolve((mod?.refresh || mod?.show)?.()).catch(() => {});
}

export function bindNavigation() {
  window.addEventListener("nexus:show-map", () => {
    if (location.pathname === "/dashboard" || location.pathname === "/") return;
    go("/dashboard");
  });
  document.addEventListener("click", (e) => {
    const link = e.target.closest("[data-link]");
    if (!link) return;
    const href = link.getAttribute("href");
    if (!href || href.startsWith("http")) return;
    e.preventDefault();
    go(href);
  });
  window.addEventListener("popstate", () => render());
  document.addEventListener("visibilitychange", syncOnReturn);
  window.addEventListener("focus", syncOnReturn);
  $("#logout").onclick = () => {
    setToken("");
    setMe(null);
    clearPanes();
    go("/login", true);
  };
}
