import { api, me, setMe } from "./api.js";
import { LANGS, getLang } from "./i18n.js?v=79";
import { chooseLang, mountLangPicker, syncServerLang } from "./lang-picker.js?v=79";
import { loadRemembered, saveRemembered } from "./theme.js?v=79";

const $id = (id) => document.getElementById(id);
const AVATAR_PX = 256;

const ROLE_LABEL = { superadmin: "Superadmin", admin: "Administrator", dispatcher: "Dispetcher" };

function initials(user) {
  const src = String(user?.full_name || user?.username || "?").trim();
  const parts = src.split(/\s+/).filter(Boolean);
  const letters = parts.length > 1 ? parts[0][0] + parts[1][0] : src.slice(0, 2);
  return letters.toUpperCase();
}

function hue(text) {
  let h = 0;
  for (const ch of String(text || "")) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}

function paintAvatar(el, user) {
  if (!el) return;
  el.textContent = "";
  el.style.setProperty("--av-hue", hue(user?.username));
  el.classList.toggle("has-img", !!user?.avatar_url);
  if (user?.avatar_url) {
    const img = new Image();
    img.alt = "";
    img.src = user.avatar_url;
    img.onerror = () => {
      el.classList.remove("has-img");
      el.textContent = initials(user);
    };
    el.appendChild(img);
  } else {
    el.textContent = initials(user);
  }
}

export function renderProfile() {
  if (!me) return;
  paintAvatar($id("profile-avatar"), me);
  paintAvatar($id("pm-avatar"), me);
  paintAvatar($id("pf-avatar"), me);
  $id("profile-btn")?.setAttribute("title", me.full_name || me.username);
  const name = $id("pm-name");
  if (name) name.textContent = me.full_name || me.username;
  const login = $id("pm-login");
  if (login) login.textContent = `@${me.username}`;
  const org = $id("pm-org");
  if (org) org.textContent = [ROLE_LABEL[me.role] || me.role, me.org_name].filter(Boolean).join(" · ");
  $id("pf-remove")?.classList.toggle("hidden", !me.avatar_url);
  syncServerLang();
}
// ---- menyu ----
function placeMenu() {
  const btn = $id("profile-btn");
  const menu = $id("profile-menu");
  if (!btn || !menu) return;
  const r = btn.getBoundingClientRect();
  const width = menu.offsetWidth || 260;
  menu.style.top = `${Math.round(r.bottom + 8)}px`;
  menu.style.left = `${Math.round(Math.max(8, Math.min(window.innerWidth - width - 8, r.right - width)))}px`;
}

function menuOpen() {
  return !$id("profile-menu")?.classList.contains("hidden");
}

function toggleMenu(force) {
  const menu = $id("profile-menu");
  if (!menu) return;
  const open = force ?? !menuOpen();
  menu.classList.toggle("hidden", !open);
  $id("profile-btn")?.setAttribute("aria-expanded", String(open));
  if (open) placeMenu();
}

function markLang() {
  const cur = getLang();
  document.querySelectorAll("#pm-langs [data-lang]").forEach((b) => {
    b.classList.toggle("active", b.dataset.lang === cur);
  });
}

// ---- profil oynasi ----
function showMsg(id, text) {
  const el = $id(id);
  if (!el) return;
  el.textContent = text || "";
  el.classList.toggle("hidden", !text);
}

function fillForm() {
  const form = $id("pf-form");
  if (!form || !me) return;
  form.full_name.value = me.full_name || "";
  form.username.value = me.username || "";
  form.current_password.value = "";
  form.password.value = "";
  form.password2.value = "";
}

function openProfile() {
  toggleMenu(false);
  fillForm();
  showMsg("pf-err", "");
  showMsg("pf-ok", "");
  renderProfile();
  $id("profile-modal")?.classList.remove("hidden");
  setTimeout(() => $id("pf-name")?.focus(), 30);
}

function closeProfile() {
  $id("profile-modal")?.classList.add("hidden");
}

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Rasmni o‘qib bo‘lmadi"));
    };
    img.src = url;
  });
}

/** Markazdan kvadrat kesib 256px JPEG qiladi: telefon rasmlari ham yengil yuklanadi. */
async function squareJpeg(file) {
  const img = await loadImage(file);
  const side = Math.min(img.naturalWidth, img.naturalHeight);
  if (!side) throw new Error("Rasmni o‘qib bo‘lmadi");
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = AVATAR_PX;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, AVATAR_PX, AVATAR_PX);
  ctx.drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, AVATAR_PX, AVATAR_PX);
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Rasmni o‘qib bo‘lmadi"))), "image/jpeg", 0.88);
  });
}

async function uploadAvatar(file) {
  showMsg("pf-err", "");
  showMsg("pf-ok", "");
  if (!/^image\/(jpeg|png|webp)$/.test(file.type)) {
    showMsg("pf-err", "Faqat JPG, PNG yoki WEBP rasm yuklang");
    return;
  }
  const btn = $id("pf-upload");
  if (btn) btn.disabled = true;
  try {
    const blob = await squareJpeg(file);
    const fd = new FormData();
    fd.append("file", blob, "avatar.jpg");
    setMe(await api("/auth/me/avatar", { method: "POST", body: fd }));
    renderProfile();
    showMsg("pf-ok", "Rasm saqlandi");
  } catch (ex) {
    showMsg("pf-err", ex.message);
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function removeAvatar() {
  showMsg("pf-err", "");
  showMsg("pf-ok", "");
  try {
    setMe(await api("/auth/me/avatar", { method: "DELETE" }));
    renderProfile();
    showMsg("pf-ok", "Rasm o‘chirildi");
  } catch (ex) {
    showMsg("pf-err", ex.message);
  }
}

async function saveProfile(e) {
  e.preventDefault();
  showMsg("pf-err", "");
  showMsg("pf-ok", "");
  const form = e.target;
  const password = form.password.value;
  if ((password || form.password2.value) && password !== form.password2.value) {
    showMsg("pf-err", "Yangi parollar mos kelmadi");
    return;
  }
  const body = {
    full_name: form.full_name.value.trim(),
    username: form.username.value.trim(),
    current_password: form.current_password.value,
  };
  if (password) body.password = password;
  try {
    const updated = await api("/auth/me", { method: "PUT", body });
    setMe(updated);
    const remembered = loadRemembered();
    if (remembered) saveRemembered(updated.username, password);
    fillForm();
    renderProfile();
    window.dispatchEvent(new CustomEvent("nexus:me-updated"));
    showMsg("pf-ok", "Profil saqlandi");
  } catch (ex) {
    showMsg("pf-err", ex.message);
  }
}

export function bindProfile() {
  const btn = $id("profile-btn");
  const menu = $id("profile-menu");
  if (!btn || !menu) return;
  const langs = $id("pm-langs");
  if (langs) {
    langs.innerHTML = LANGS.map((l) => `<button type="button" data-lang="${l.code}"><b>${l.short}</b>${l.label}</button>`).join("");
  }
  markLang();
  mountLangPicker(document.getElementById("header-lang"));
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleMenu();
  });
  menu.addEventListener("click", (e) => {
    const lang = e.target.closest("[data-lang]");
    if (lang) {
      chooseLang(lang.dataset.lang);
      return;
    }
    if (e.target.closest("#pm-profile")) openProfile();
    else if (e.target.closest(".pm-item")) toggleMenu(false);
  });
  document.addEventListener("click", (e) => {
    if (menuOpen() && !menu.contains(e.target) && !btn.contains(e.target)) toggleMenu(false);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (menuOpen()) toggleMenu(false);
    else if (!$id("profile-modal")?.classList.contains("hidden")) closeProfile();
  });
  window.addEventListener("resize", () => menuOpen() && placeMenu());

  $id("profile-close")?.addEventListener("click", closeProfile);
  $id("pf-cancel")?.addEventListener("click", closeProfile);
  $id("profile-modal")?.addEventListener("click", (e) => {
    if (e.target.id === "profile-modal") closeProfile();
  });
  $id("pf-form")?.addEventListener("submit", saveProfile);
  $id("pf-upload")?.addEventListener("click", () => $id("pf-file")?.click());
  $id("pf-avatar")?.addEventListener("click", () => $id("pf-file")?.click());
  $id("pf-file")?.addEventListener("change", (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (file) uploadAvatar(file);
  });
  $id("pf-remove")?.addEventListener("click", removeAvatar);
}
