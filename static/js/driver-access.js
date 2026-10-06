import { api } from "./api.js";
import { $ } from "./ui.js?v=71";

let currentId = null;
let bound = false;

function renderAccess(data, password) {
  const name = $("#drv-access-name");
  const user = $("#drv-access-user");
  const pass = $("#drv-access-pass");
  const box = $("#drv-access-qr");
  if (name) name.textContent = data.name || "";
  const url = $("#drv-access-url");
  if (url) url.textContent = `${location.origin}/driver/`;
  if (user) user.textContent = data.username || "—";
  if (pass) {
    pass.textContent = password || (data.has_password ? "Parol o‘rnatilgan (yashirin). Yangi parol uchun tugmani bosing." : "Parol yo‘q — «Yangi parol» ni bosing");
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

export async function openDriverAccess(id, initialPassword = null) {
  currentId = id;
  const modal = $("#drv-access-modal");
  if (!modal) return;
  modal.classList.remove("hidden");
  const data = await api(`/drivers/${id}/access`);
  renderAccess(data, initialPassword || data.password || null);
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
  $("#drv-access-reset-pass")?.addEventListener("click", async () => {
    if (!currentId) return;
    const data = await api(`/drivers/${currentId}/access`, { method: "POST", body: { reset_password: true } });
    renderAccess(data, data.password);
  });
  $("#drv-access-reset-qr")?.addEventListener("click", async () => {
    if (!currentId) return;
    const data = await api(`/drivers/${currentId}/access`, { method: "POST", body: { reset_qr: true } });
    renderAccess(data, null);
  });
}
