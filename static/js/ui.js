export const $ = (s, root = document) => root.querySelector(s);
export const $$ = (s, root = document) => [...root.querySelectorAll(s)];

export function formData(form) {
  return Object.fromEntries(new FormData(form).entries());
}

export function table(headers, rows) {
  return `<div class="table-wrap"><table><thead><tr>${headers.map((h) => `<th>${h}</th>`).join("")}</tr></thead><tbody>${rows}</tbody></table></div>`;
}

export function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

const DRIVER_STATUS = { idle: "Bo‘sh", on_route: "Yo‘lda", assigned: "Tayinlangan" };

function seenAgo(iso) {
  const t = Date.parse(iso || "");
  if (!t) return "";
  const min = Math.floor((Date.now() - t) / 60000);
  if (min < 1) return "hozirgina";
  if (min < 60) return `${min} daq oldin`;
  if (min < 24 * 60) return `${Math.floor(min / 60)} soat oldin`;
  const d = new Date(t);
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function driverStatusHtml(d) {
  if (!d.online) {
    const sub = d.seen_at ? `oxirgi aloqa: ${seenAgo(d.seen_at)}` : "ilovaga hali kirmagan";
    return `<span class="drv-status"><span class="badge offline"><i class="dot"></i>Offline</span><span class="drv-status-sub">${escapeHtml(sub)}</span></span>`;
  }
  const label = DRIVER_STATUS[d.status] || d.status || "—";
  return `<span class="drv-status"><span class="badge ${escapeHtml(d.status)} live"><i class="dot"></i>${escapeHtml(label)}</span><span class="drv-status-sub">online</span></span>`;
}

export function money(value) {
  const n = Number(value || 0);
  return n.toLocaleString("uz-UZ");
}

export function formatPhone(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  let digits = raw.replace(/\D/g, "");
  if (digits.startsWith("998")) digits = digits.slice(3);
  else if (digits.startsWith("8") && digits.length >= 10) digits = digits.slice(1);
  if (digits.length < 9) return raw;
  digits = digits.slice(-9);
  return `+998 ${digits.slice(0, 2)} ${digits.slice(2, 5)} ${digits.slice(5, 7)} ${digits.slice(7, 9)}`;
}

export function bindPhoneInputs(root = document) {
  root.querySelectorAll('input[name="phone"]').forEach((el) => {
    if (el.dataset.phoneBound) return;
    el.dataset.phoneBound = "1";
    el.placeholder = "+998 90 123 45 67";
    el.maxLength = 17;
    el.addEventListener("blur", () => {
      el.value = formatPhone(el.value);
    });
  });
}

let confirmBusy = null;

export function askConfirm(text, opts = {}) {
  const overlay = document.getElementById("app-confirm");
  const titleEl = document.getElementById("app-confirm-title");
  const textEl = document.getElementById("app-confirm-text");
  const okBtn = document.getElementById("app-confirm-ok");
  const cancelBtn = document.getElementById("app-confirm-cancel");
  if (!overlay || !textEl || !okBtn || !cancelBtn) {
    return Promise.resolve(window.confirm(text));
  }
  if (confirmBusy) confirmBusy(false);
  titleEl.textContent = opts.title || "Tasdiqlash";
  textEl.textContent = text;
  okBtn.textContent = opts.ok || "OK";
  cancelBtn.textContent = opts.cancel || "Bekor qilish";
  okBtn.classList.toggle("ok-danger", Boolean(opts.danger));
  okBtn.classList.toggle("primary", !opts.danger);
  overlay.classList.remove("hidden");
  return new Promise((resolve) => {
    const finish = (value) => {
      overlay.classList.add("hidden");
      okBtn.onclick = null;
      cancelBtn.onclick = null;
      overlay.onclick = null;
      confirmBusy = null;
      resolve(value);
    };
    confirmBusy = finish;
    okBtn.onclick = () => finish(true);
    cancelBtn.onclick = () => finish(false);
    overlay.onclick = (e) => {
      if (e.target === overlay) finish(false);
    };
  });
}
