import { api, can, me } from "../api.js";
import { $, escapeHtml, formData, table, askConfirm } from "../ui.js?v=78";

const L = window.L;
let bound = false;
let paneRoot = null;
let cache = [];
let pickMap = null;
let pickMarker = null;

const ICON_PENCIL = `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>`;
const ICON_TRASH = `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>`;

function canManage() {
  return me?.role === "admin" || can("warehouses.manage");
}

function modal(root) {
  return $("#wh-edit-modal", root);
}

function formEl(root) {
  return $("#wh-form", root);
}

function showErr(el, text) {
  if (!el) return;
  el.classList.toggle("hidden", !text);
  el.textContent = text || "";
}

function gpsOk(lat, lng) {
  return lat > 37 && lat < 46 && lng > 55 && lng < 76;
}

function destroyPickMap() {
  if (pickMap) {
    pickMap.remove();
    pickMap = null;
    pickMarker = null;
  }
}

function setPick(lat, lng, form) {
  if (form?.elements.lat) form.elements.lat.value = Number(lat).toFixed(6);
  if (form?.elements.lng) form.elements.lng.value = Number(lng).toFixed(6);
  if (!pickMap) return;
  const pt = [Number(lat), Number(lng)];
  if (!pickMarker) pickMarker = L.marker(pt).addTo(pickMap);
  else pickMarker.setLatLng(pt);
  pickMap.setView(pt, Math.max(pickMap.getZoom(), 14));
}

function initPickMap(root, lat, lng) {
  destroyPickMap();
  const box = $("#wh-pick-map", root);
  if (!box || !L) return;
  const start = gpsOk(lat, lng) ? [lat, lng] : [41.3111, 69.2797];
  pickMap = L.map(box, { zoomControl: true }).setView(start, gpsOk(lat, lng) ? 15 : 12);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19 }).addTo(pickMap);
  const form = formEl(root);
  setPick(start[0], start[1], form);
  pickMap.on("click", (e) => setPick(e.latlng.lat, e.latlng.lng, form));
  setTimeout(() => pickMap && pickMap.invalidateSize(), 80);
}

function closeEditor(root) {
  const form = formEl(root);
  form?.reset();
  if (form?.elements.id) form.elements.id.value = "";
  destroyPickMap();
  modal(root)?.classList.add("hidden");
  showErr($("#wh-edit-err", root), "");
}

function openEditor(root, row) {
  const form = formEl(root);
  const title = $("#wh-edit-title", root);
  if (!form) return;
  form.reset();
  showErr($("#wh-edit-err", root), "");
  if (title) title.textContent = row ? "Skladni tahrirlash" : "Yangi sklad";
  form.elements.id.value = row?.id || "";
  form.elements.name.value = row?.name || "";
  form.elements.address.value = row?.address || "";
  form.elements.lat.value = row?.lat ?? 41.3111;
  form.elements.lng.value = row?.lng ?? 69.2797;
  form.elements.is_default.checked = row ? Boolean(row.is_default) : !cache.length;
  form.elements.is_active.checked = row ? Boolean(row.is_active) : true;
  modal(root)?.classList.remove("hidden");
  initPickMap(root, Number(form.elements.lat.value), Number(form.elements.lng.value));
  form.elements.name?.focus();
}

async function load(root) {
  const box = $("#wh-table", root);
  const err = $("#wh-err", root);
  if (!box) return;
  try {
    showErr(err, "");
    cache = await api("/warehouses");
    const manage = canManage();
    const headers = manage ? ["Nomi", "Manzil", "Lokatsiya", "Holat", ""] : ["Nomi", "Manzil", "Lokatsiya", "Holat"];
    if (!cache.length) {
      box.innerHTML = `<div class="empty-list">Sklad yo‘q. Qo‘shing — road plan shu nuqtadan boshlanadi.</div>`;
      return;
    }
    box.innerHTML = table(
      headers,
      cache
        .map((w) => {
          const buttons = [];
          if (manage) {
            buttons.push(`<button class="icon-btn row-icon" type="button" data-edit="${w.id}" title="Tahrirlash">${ICON_PENCIL}</button>`);
            buttons.push(`<button class="icon-btn row-icon danger" type="button" data-del="${w.id}" title="O‘chirish">${ICON_TRASH}</button>`);
          }
          const actions = buttons.length ? `<td class="col-actions"><div class="row-icons">${buttons.join("")}</div></td>` : "";
          const mark = w.is_default ? ` <span class="muted">asosiy</span>` : "";
          return `<tr>
            <td><b>${escapeHtml(w.name)}</b>${mark}</td>
            <td>${escapeHtml(w.address || "—")}</td>
            <td>${Number(w.lat).toFixed(5)}, ${Number(w.lng).toFixed(5)}</td>
            <td>${w.is_active ? "Faol" : "O‘chiq"}</td>
            ${actions}
          </tr>`;
        })
        .join("")
    );
  } catch (ex) {
    showErr(err, ex.message || "Skladlarni yuklab bo‘lmadi");
    box.innerHTML = `<div class="empty-list">Ro‘yxatni ochib bo‘lmadi.</div>`;
  }
}

export async function init(root) {
  paneRoot = root;
  const openBtn = root.querySelector("[data-open]");
  if (openBtn) openBtn.classList.toggle("hidden", !canManage());
  if (!bound) {
    bound = true;
    if (openBtn) openBtn.onclick = () => openEditor(root, null);
    const form = formEl(root);
    if (form) {
      form.onsubmit = async (e) => {
        e.preventDefault();
        const err = $("#wh-edit-err", root);
        showErr(err, "");
        const d = formData(form);
        const id = Number(d.id || 0);
        const body = {
          name: String(d.name || "").trim(),
          address: String(d.address || "").trim(),
          lat: Number(d.lat),
          lng: Number(d.lng),
          is_default: Boolean(form.elements.is_default?.checked),
          is_active: Boolean(form.elements.is_active?.checked),
        };
        if (!body.name) {
          showErr(err, "Sklad nomi majburiy");
          return;
        }
        if (!gpsOk(body.lat, body.lng)) {
          showErr(err, "Lokatsiyani xaritadan tanlang");
          return;
        }
        try {
          if (id) await api(`/warehouses/${id}`, { method: "PUT", body });
          else await api("/warehouses", { method: "POST", body });
          closeEditor(root);
          await load(root);
          window.dispatchEvent(new CustomEvent("nexus:orders-changed"));
        } catch (ex) {
          showErr(err, ex.message);
        }
      };
    }
    $("#wh-edit-close", root)?.addEventListener("click", () => closeEditor(root));
    $("#wh-edit-cancel", root)?.addEventListener("click", () => closeEditor(root));
    modal(root)?.addEventListener("click", (e) => {
      if (e.target === modal(root)) closeEditor(root);
    });
    root.addEventListener("click", async (e) => {
      const editBtn = e.target.closest("[data-edit]");
      if (editBtn) {
        const row = cache.find((w) => String(w.id) === String(editBtn.dataset.edit));
        if (row) openEditor(root, row);
        return;
      }
      const delBtn = e.target.closest("[data-del]");
      if (!delBtn) return;
      const id = Number(delBtn.dataset.del);
      const row = cache.find((w) => w.id === id);
      const ok = await askConfirm(`${row?.name || "Sklad"}ni o‘chirasizmi?`, {
        title: "O‘chirish",
        ok: "O‘chirish",
        danger: true,
      });
      if (!ok) return;
      try {
        await api(`/warehouses/${id}`, { method: "DELETE" });
        await load(root);
        window.dispatchEvent(new CustomEvent("nexus:orders-changed"));
      } catch (ex) {
        showErr($("#wh-err", root), ex.message);
      }
    });
  }
  await load(root);
}

export async function show() {
  if (paneRoot) await load(paneRoot);
}

export function destroy() {
  bound = false;
  paneRoot = null;
  destroyPickMap();
}
