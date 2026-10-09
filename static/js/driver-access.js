import { api } from "./api.js";
import { $ } from "./ui.js?v=77";

let currentId = null;
let bound = false;
let shown = { username: "", password: "" };
const changeHandlers = new Set();

export function onDriverAccessChange(fn) {
  changeHandlers.add(fn);
  return () => changeHandlers.delete(fn);
}

function accessErr(text) {
  const el = $("#drv-access-err");
  if (!el) return;
  el.textContent = text || "";
  el.classList.toggle("hidden", !text);
}

function renderAccess(data, password) {
  const name = $("#drv-access-name");
  const user = $("#drv-access-user");
  const pass = $("#drv-access-pass");
  const box = $("#drv-access-qr");
  shown = { username: data.username || "", password: password || "" };
  if (name) name.textContent = data.name || "";
  const url = $("#drv-access-url");
  if (url) url.textContent = `${location.origin}/driver/`;
  if (user) user.textContent = data.username || "—";
  const login = $("#drv-access-login");
  if (login) login.value = data.username || "";
  const newPass = $("#drv-access-newpass");
  if (newPass) newPass.value = "";
  if (pass) {
    pass.textContent = password || (data.has_password ? "Parol o‘rnatilgan (yashirin). Yangisini kiriting yoki avtomatik yarating." : "Parol yo‘q — yangi parol kiriting");
  }
  if (!box) return;
  box.innerHTML = "";
  if (data.qr_svg) {
    box.innerHTML = data.qr_svg;
    const svg = box.querySelector("svg");
    if (svg) {
      svg.removeAttribute("width");
      svg.removeAttribute("height");
      svg.style.width = "100%";
      svg.style.height = "100%";
    }
  } else if (window.QRCode && data.qr_payload) {
    new window.QRCode(box, {
      text: data.qr_payload,
      width: 220,
      height: 220,
      colorDark: "#111111",
      colorLight: "#ffffff",
      correctLevel: window.QRCode.CorrectLevel.M,
    });
  } else {
    box.textContent = data.qr_payload || "";
  }
}

async function changeAccess(body) {
  if (!currentId) return;
  accessErr("");
  try {
    const data = await api(`/drivers/${currentId}/access`, { method: "POST", body });
    renderAccess(data, data.password || null);
    changeHandlers.forEach((fn) => fn(data));
  } catch (ex) {
    accessErr(ex.message || "Saqlanmadi");
  }
}

let openSeq = 0;

export async function openDriverAccess(id, initialPassword = null) {
  const seq = ++openSeq;
  currentId = id;
  const modal = $("#drv-access-modal");
  if (!modal) return;
  accessErr("");
  renderAccess({ name: "…", username: "" }, null);
  modal.classList.remove("hidden");
  try {
    const data = await api(`/drivers/${id}/access`);
    if (seq !== openSeq) return;
    renderAccess(data, initialPassword || data.password || null);
  } catch (ex) {
    if (seq === openSeq) accessErr(ex.message || "Ma’lumot yuklanmadi");
  }
}

export function bindDriverAccessModal() {
  if (bound) return;
  bound = true;
  const modal = $("#drv-access-modal");
  if (!modal) return;
  $("#drv-access-close")?.addEventListener("click", () => modal.classList.add("hidden"));
  modal.addEventListener("click", (e) => {
    if (e.target === modal) modal.classList.add("hidden");
  });
  $("#drv-access-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const login = ($("#drv-access-login")?.value || "").trim().toLowerCase();
    const password = ($("#drv-access-newpass")?.value || "").trim();
    const body = {};
    if (login && login !== shown.username) body.username = login;
    if (password) body.password = password;
    if (!login) return accessErr("Login bo‘sh bo‘lmasin");
    if (!Object.keys(body).length) return accessErr("O‘zgarish yo‘q");
    const btn = $("#drv-access-save");
    if (btn) btn.disabled = true;
    try {
      await changeAccess(body);
    } finally {
      if (btn) btn.disabled = false;
    }
  });
  $("#drv-access-reset-pass")?.addEventListener("click", () => changeAccess({ reset_password: true }));
  $("#drv-access-reset-qr")?.addEventListener("click", () => changeAccess({ reset_qr: true }));
  $("#drv-access-copy")?.addEventListener("click", async () => {
    const lines = [`Ilova: ${location.origin}/driver/`, `Login: ${shown.username || "—"}`];
    if (shown.password) lines.push(`Parol: ${shown.password}`);
    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      accessErr("");
      const btn = $("#drv-access-copy");
      if (btn) {
        btn.textContent = "Nusxalandi ✓";
        setTimeout(() => (btn.textContent = "Nusxa olish"), 1500);
      }
    } catch {
      accessErr("Nusxa olib bo‘lmadi — qo‘lda ko‘chiring");
    }
  });
}
