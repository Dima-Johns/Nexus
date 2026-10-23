import { api } from "./api.js";
import { $, escapeHtml } from "./ui.js?v=91";

let currentId = null;
let bound = false;
let catalog = [];

function permsErr(text) {
  const el = $("#drv-perms-err");
  if (!el) return;
  el.textContent = text || "";
  el.classList.toggle("hidden", !text);
}

function renderPerms(data) {
  catalog = data.catalog || catalog;
  const name = $("#drv-perms-name");
  if (name) name.textContent = data.name || "";
  const on = new Set(data.permissions || []);
  const box = $("#drv-perms-list");
  if (!box) return;
  box.innerHTML = catalog
    .map(
      (p) => `<label class="drv-perm">
        <input type="checkbox" data-drv-perm="${escapeHtml(p.key)}" ${on.has(p.key) ? "checked" : ""} />
        <b>${escapeHtml(p.label)}</b>
        <span>${escapeHtml(p.hint || "")}</span>
      </label>`
    )
    .join("");
}

function selectedKeys() {
  return [...document.querySelectorAll("#drv-perms-list [data-drv-perm]:checked")].map((el) => el.dataset.drvPerm);
}

export async function openDriverPerms(id) {
  currentId = id;
  const modal = $("#drv-perms-modal");
  if (!modal) return;
  permsErr("");
  renderPerms({ name: "…", permissions: [], catalog });
  modal.classList.remove("hidden");
  try {
    renderPerms(await api(`/drivers/${id}/permissions`));
  } catch (ex) {
    permsErr(ex.message || "Ruxsatlar yuklanmadi");
  }
}

export function bindDriverPermsModal() {
  if (bound) return;
  bound = true;
  const modal = $("#drv-perms-modal");
  if (!modal) return;
  const close = () => modal.classList.add("hidden");
  $("#drv-perms-close")?.addEventListener("click", close);
  $("#drv-perms-cancel")?.addEventListener("click", close);
  modal.addEventListener("click", (e) => {
    if (e.target === modal) close();
  });
  $("#drv-perms-all")?.addEventListener("click", () => {
    modal.querySelectorAll("[data-drv-perm]").forEach((el) => (el.checked = true));
  });
  $("#drv-perms-none")?.addEventListener("click", () => {
    modal.querySelectorAll("[data-drv-perm]").forEach((el) => (el.checked = false));
  });
  $("#drv-perms-save")?.addEventListener("click", async () => {
    if (!currentId) return;
    const btn = $("#drv-perms-save");
    if (btn) btn.disabled = true;
    permsErr("");
    try {
      const data = await api(`/drivers/${currentId}/permissions`, { method: "PUT", body: { permissions: selectedKeys() } });
      renderPerms(data);
      if (btn) {
        const prev = btn.textContent;
        btn.textContent = "Saqlandi ✓";
        setTimeout(() => {
          btn.textContent = prev;
        }, 1200);
      }
    } catch (ex) {
      permsErr(ex.message || "Saqlanmadi");
    } finally {
      if (btn) btn.disabled = false;
    }
  });
}
