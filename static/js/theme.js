const THEME_KEY = "nx_theme";
const REMEMBER_KEY = "nx_remember";

export function currentTheme() {
  return localStorage.getItem(THEME_KEY) === "light" ? "light" : "dark";
}

export function applyTheme(theme) {
  const next = theme === "light" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  localStorage.setItem(THEME_KEY, next);
}

export function toggleTheme() {
  applyTheme(currentTheme() === "dark" ? "light" : "dark");
  return currentTheme();
}

const SUN_SVG =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4" /><path d="M12 2.5v2M12 19.5v2M4.6 4.6 6 6M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4 6 18M18 6l1.4-1.4" /></svg>';
const MOON_SVG =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5Z" /></svg>';

export function syncThemeButton(btn) {
  if (!btn) return;
  const light = currentTheme() === "light";
  if (btn.classList.contains("nav-ico")) btn.innerHTML = light ? MOON_SVG : SUN_SVG;
  else btn.textContent = light ? "☾" : "☀";
  btn.title = light ? "Tun rejimi" : "Kun rejimi";
  btn.setAttribute("aria-label", btn.title);
}

export function bindThemeToggle(btn) {
  if (!btn || btn.dataset.themeBound) return;
  btn.dataset.themeBound = "1";
  syncThemeButton(btn);
  btn.addEventListener("click", () => {
    toggleTheme();
    document.querySelectorAll("[data-theme-toggle]").forEach(syncThemeButton);
  });
}

export function loadRemembered() {
  try {
    const raw = localStorage.getItem(REMEMBER_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (!data?.username) return null;
    // Eski versiyalar parolni ochiq saqlagan — darhol o‘chiriladi
    if ("password" in data) localStorage.setItem(REMEMBER_KEY, JSON.stringify({ username: data.username }));
    return { username: String(data.username) };
  } catch {
    return null;
  }
}

/** Parol localStorage’ga yozilmaydi: u brauzerning parol menejeriga topshiriladi. */
export function saveRemembered(username, password) {
  localStorage.setItem(REMEMBER_KEY, JSON.stringify({ username }));
  if (!password || !window.PasswordCredential || !navigator.credentials?.store) return;
  try {
    navigator.credentials.store(new window.PasswordCredential({ id: username, password, name: username })).catch(() => {});
  } catch {
    /* brauzer qo‘llamaydi */
  }
}

export async function loadSavedPassword(username) {
  if (!window.PasswordCredential || !navigator.credentials?.get) return "";
  try {
    const cred = await navigator.credentials.get({ password: true, mediation: "silent" });
    return cred && cred.id === username ? cred.password || "" : "";
  } catch {
    return "";
  }
}

export function clearRemembered() {
  localStorage.removeItem(REMEMBER_KEY);
}

applyTheme(currentTheme());
