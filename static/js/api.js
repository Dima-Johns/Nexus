export const API = "/api";

export let token = localStorage.getItem("nx_token") || "";
export let me = null;

export function setToken(value) {
  token = value || "";
  if (value) localStorage.setItem("nx_token", value);
  else localStorage.removeItem("nx_token");
}

export function setMe(user) {
  me = user;
}

// Admin ruxsatlari serverda hisoblanadi (orgs.manage faqat superadmin bergandan keyin keladi)
export function can(key) {
  if (!me) return false;
  if (me.role === "superadmin") return true;
  return Array.isArray(me.permissions) && me.permissions.includes(key);
}

export function isSuper() {
  return me?.role === "superadmin";
}

function forceLogin() {
  setToken("");
  setMe(null);
  if (!location.pathname.includes("/login")) {
    history.replaceState({}, "", "/login");
    window.dispatchEvent(new PopStateEvent("popstate"));
  }
}

export async function api(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (!(opts.body instanceof FormData) && opts.body && typeof opts.body === "object") {
    headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(opts.body);
  }
  const res = await fetch(API + path, { ...opts, headers });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) {
    const msg = typeof data.detail === "string" ? data.detail : "unauthorized";
    const err = new Error(msg);
    err.code = 401;
    if (!String(path).includes("/auth/login") && !String(path).includes("/auth/driver")) {
      forceLogin();
    }
    throw err;
  }
  if (!res.ok) {
    const d = data.detail;
    const msg = typeof d === "string" ? d : Array.isArray(d) ? d.map((x) => x.msg || x).join("; ") : "Xatolik";
    throw new Error(msg);
  }
  return data;
}

export async function apiUpload(path, file, field = "file") {
  const fd = new FormData();
  fd.append(field, file);
  return api(path, { method: "POST", body: fd });
}

export async function apiDownload(path, filename) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(API + path, { headers });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(typeof data.detail === "string" ? data.detail : "Yuklab bo‘lmadi");
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename || "shablon.xlsx";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
