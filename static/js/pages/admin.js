import { api, apiDownload, apiUpload, can, isSuper, me, setMe } from "../api.js";
import { openDriverAccess } from "../driver-access.js?v=91";
import { mountOfficePicker } from "../office-picker.js?v=91";
import { $, escapeHtml, formData, table, askConfirm, bindPhoneInputs, driverStatusHtml } from "../ui.js?v=91";

const TAB_KEY = "nx_admin_tab";
const TPL_STATUS = { approved: "Tasdiqlangan", pending: "Kutilmoqda", rejected: "Rad etilgan" };
const ENTITY = { orders: "Buyurtmalar", drivers: "Haydovchilar" };
const ROLE = { superadmin: "Superadmin", admin: "Administrator", dispatcher: "Dispetcher" };
const ADMIN_ONLY = new Set(["users.manage", "perms.manage"]);
let superOnly = new Set();
let orgsCache = [];
const openOrgs = new Set();
let usersCache = [];
let clientsCache = [];
// Filtrdagi klientlar (boshqa varaqlardagilari ham) — «Hammasini belgilash» shularni oladi
let clVisible = [];
const clPicked = new Set();
let createPicker = null;
let editPicker = null;
let officeOrgId = null;
let paneRoot = null;

let fields = [];
let inspectData = null;
let currentHeaders = [];
let driversCache = [];
let agentsCache = [];
const labelCache = {};

function setCount(root, id, n) {
  const el = $(`#${id}`, root);
  if (el) el.textContent = n ? String(n) : "";
}

function tabAllowed(btn) {
  return btn.dataset.perm.split(",").some((k) => (k.trim() === "superadmin" ? isSuper() : can(k.trim())));
}

function showTab(root, name) {
  const tabs = [...root.querySelectorAll("[data-admin-tab]")].filter(tabAllowed);
  if (!tabs.length) return;
  const pick = tabs.find((t) => t.dataset.adminTab === name) || tabs[0];
  const key = pick.dataset.adminTab;
  root.querySelectorAll("[data-admin-tab]").forEach((t) => t.classList.toggle("active", t === pick));
  root.querySelectorAll("[data-admin-sec]").forEach((s) => s.classList.toggle("admin-off", s.dataset.adminSec !== key));
  localStorage.setItem(TAB_KEY, key);
}

function initials(name) {
  const parts = String(name || "?").trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] || "?") + (parts[1]?.[0] || "")).toUpperCase();
}

function optionList(headers, selected) {
  const opts = [`<option value="">— moslama —</option>`];
  headers.forEach((h) => {
    const sel = h === selected ? "selected" : "";
    opts.push(`<option value="${escapeHtml(h)}" ${sel}>${escapeHtml(h)}</option>`);
  });
  return opts.join("");
}

function renderMapGrid(root, mapping = {}) {
  $("#map-grid", root).innerHTML = fields
    .map(
      (f) => `<label class="map-row">
        <span>${escapeHtml(f.label)}${f.required ? " *" : ""}</span>
        <select data-field="${f.key}">${optionList(currentHeaders, mapping[f.key] || "")}</select>
      </label>`
    )
    .join("");
}

function collectMapping(root) {
  const mapping = {};
  root.querySelectorAll("#map-grid select").forEach((sel) => {
    if (sel.value) mapping[sel.dataset.field] = sel.value;
  });
  return mapping;
}

function fillForm(root, tpl) {
  $("#tpl-form", root).classList.remove("hidden");
  $("#tpl-id", root).value = tpl?.id || "";
  $("#tpl-name", root).value = tpl?.name || "";
  $("#tpl-desc", root).value = tpl?.description || "";
  $("#tpl-header-row", root).value = tpl?.header_row || 1;
  if (tpl?.sheet) $("#tpl-sheet", root).value = tpl.sheet;
  renderMapGrid(root, tpl?.mapping || {});
}

async function fieldLabels(entity) {
  if (!labelCache[entity]) {
    const list = (await api(`/templates/fields?entity=${entity}`).catch(() => ({ fields: [] }))).fields || [];
    labelCache[entity] = Object.fromEntries(list.map((f) => [f.key, f.label]));
  }
  return labelCache[entity];
}

async function loadList(root) {
  const tpls = await api("/templates");
  setCount(root, "cnt-templates", tpls.length);
  const box = $("#admin-templates", root);
  if (!tpls.length) {
    box.innerHTML = `<p class="muted adm-empty">Hozircha shablon yo‘q.</p>`;
    return;
  }
  const labels = {
    orders: await fieldLabels("orders"),
    drivers: await fieldLabels("drivers"),
  };
  box.innerHTML = tpls
    .map((t) => {
      const entity = t.entity || "orders";
      const names = labels[entity] || {};
      const pairs = Object.entries(t.mapping || {});
      const mapRows = pairs
        .map(([k, v]) => `<span class="k">${escapeHtml(names[k] || k)}</span><span class="v">${escapeHtml(v)}</span>`)
        .join("");
      return `<div class="adm-card tpl-card">
        <div class="tpl-head">
          <div class="tpl-title"><b>${escapeHtml(t.name)}</b><span class="badge entity">${escapeHtml(ENTITY[entity] || entity)}</span></div>
          <span class="badge ${t.status}">${escapeHtml(TPL_STATUS[t.status] || t.status)}</span>
        </div>
        <div class="tpl-meta">Varaq: ${escapeHtml(t.sheet || "—")} · Sarlavha qatori: ${t.header_row || 1} · Muallif: ${escapeHtml(t.submitted_by || "—")}</div>
        ${t.description ? `<p class="tpl-desc">${escapeHtml(t.description)}</p>` : ""}
        <details class="tpl-map">
          <summary>Ustunlar moslamasi · ${pairs.length} ta</summary>
          <div class="tpl-map-grid">${mapRows || `<span class="muted">Moslama yo‘q</span>`}</div>
        </details>
        <div class="row-actions tpl-actions">
          <button class="btn tiny" data-edit="${t.id}">Tahrirlash</button>
          <button class="btn tiny" data-excel="${t.id}">Excel</button>
          ${
            t.status === "pending"
              ? `<button class="btn tiny primary" data-approve="${t.id}">Tasdiqlash</button>
                 <button class="btn tiny" data-reject="${t.id}">Rad etish</button>`
              : t.review_note
                ? `<span class="tpl-note">${escapeHtml(t.review_note)}</span>`
                : ""
          }
        </div>
      </div>`;
    })
    .join("");
}

function agentOptions(agents, selectedId) {
  const cur = selectedId ? String(selectedId) : "";
  return (
    `<option value="">Agent yo‘q</option>` +
    agents
      .map((a) => {
        const sel = String(a.id) === cur ? "selected" : "";
        return `<option value="${a.id}" ${sel}>${escapeHtml(`${a.code || "—"} · ${a.name}`)}</option>`;
      })
      .join("")
  );
}

function renderDriverSummary(root) {
  const el = $("#drv-summary", root);
  if (!el) return;
  const noAgent = driversCache.filter((d) => !d.agent_id).length;
  const online = driversCache.filter((d) => d.online).length;
  el.innerHTML = `<span class="adm-pill">Jami <b>${driversCache.length}</b></span>
    <span class="adm-pill on">Online <b>${online}</b></span>
    <span class="adm-pill${noAgent ? " warn" : ""}">Agentsiz <b>${noAgent}</b></span>`;
}

function renderDrivers(root) {
  const box = $("#admin-drivers-table", root);
  if (!box) return;
  renderDriverSummary(root);
  if (!driversCache.length) {
    box.innerHTML = `<p class="muted adm-empty">Hozircha haydovchi yo‘q. «+ Yangi haydovchi» yoki Excel import orqali qo‘shing.</p>`;
    return;
  }
  const q = ($("#drv-search", root)?.value || "").trim().toLowerCase();
  const rows = driversCache
    .filter((d) => !q || [d.name, d.username, d.phone, d.vehicle_plate].some((v) => String(v || "").toLowerCase().includes(q)))
    .sort((a, b) => String(a.name).localeCompare(String(b.name), "uz"));
  if (!rows.length) {
    box.innerHTML = `<p class="muted adm-empty">«${escapeHtml(q)}» bo‘yicha haydovchi topilmadi.</p>`;
    return;
  }
  box.innerHTML = table(
    ["#", "Haydovchi", "Telefon", "Davlat raqami", "Holat", "Agent", ""],
    rows
      .map(
        (d, i) => `<tr>
          <td class="adm-num">${i + 1}</td>
          <td><div class="drv-cell"><span class="user-avatar sm">${escapeHtml(initials(d.name))}</span><span><b>${escapeHtml(d.name)}</b><span class="drv-login">${escapeHtml(d.username || "login yo‘q")}</span></span></div></td>
          <td class="nowrap">${escapeHtml(d.phone || "—")}</td>
          <td class="nowrap">${escapeHtml(d.vehicle_plate || "—")}</td>
          <td>${driverStatusHtml(d)}</td>
          <td>${
            can("drivers.manage")
              ? `<select class="agent-pick" data-agent-drv="${d.id}">${agentOptions(agentsCache, d.agent_id)}</select>`
              : escapeHtml(d.agent_code ? `${d.agent_code} · ${d.agent_name}` : d.agent_name || "—")
          }</td>
          <td class="col-actions">
            ${can("drivers.access") ? `<button class="btn tiny" data-drv-access="${d.id}">Kirish</button>` : ""}
            ${can("drivers.manage") ? `<button class="btn tiny danger-text" data-drv-del="${d.id}">O‘chirish</button>` : ""}
          </td>
        </tr>`
      )
      .join("")
  );
}

async function loadDrivers(root) {
  const [drivers, agents] = await Promise.all([api("/drivers"), api("/agents")]);
  driversCache = drivers;
  agentsCache = agents;
  setCount(root, "cnt-drivers", drivers.length);
  const sel = $("#admin-driver-agent", root);
  if (sel) sel.innerHTML = agentOptions(agents, sel.value);
  renderDrivers(root);
}

async function loadFields(entity) {
  fields = (await api(`/templates/fields?entity=${entity || "orders"}`)).fields;
}

async function driverTplId() {
  const tpls = await api("/templates");
  return tpls.find((t) => t.entity === "drivers" && t.status === "approved")?.id;
}

function permCount(card) {
  const on = card.querySelectorAll("[data-perm-key]:checked").length;
  const all = card.querySelectorAll("[data-perm-key]").length;
  const el = card.querySelector(".perm-count");
  if (el && all) el.textContent = `${on} / ${all} ruxsat`;
}

async function loadPermsAdmin(root) {
  const box = $("#perm-list", root);
  if (!box) return;
  const [catalog, users] = await Promise.all([api("/permissions"), api("/users")]);
  superOnly = new Set(catalog.super_only || []);
  setCount(root, "cnt-perms", users.length);
  const groups = {};
  (catalog.permissions || []).forEach((p) => {
    if (!groups[p.group]) groups[p.group] = [];
    groups[p.group].push(p);
  });
  const superItems = (catalog.permissions || []).filter((p) => superOnly.has(p.key));
  box.innerHTML = users
    .map((u) => {
      const keys = new Set(u.permissions || []);
      const isAdminRole = u.role === "admin" || u.role === "superadmin";
      // Admin barcha oddiy ruxsatlarga ega; superadmin unga faqat «superadmin beradigan» ruxsatlarni qo‘sha oladi
      const superEditable = u.role === "admin" && isSuper() && superItems.length;
      const locked = isAdminRole && !superEditable;
      const head = `<div class="perm-head">
          <span class="user-avatar">${escapeHtml(initials(u.full_name))}</span>
          <div class="perm-who">
            <b>${escapeHtml(u.full_name)}</b>
            <span>${escapeHtml(u.username)} · ${escapeHtml(u.org_name || "Tashkilot yo‘q")}</span>
          </div>
          <span class="badge role-${escapeHtml(u.role)}">${escapeHtml(ROLE[u.role] || u.role)}</span>
          ${
            locked
              ? `<span class="perm-count">Barcha ruxsatlar</span>`
              : `<span class="perm-count"></span><button class="btn tiny primary" type="button" data-perm-save="${u.id}" disabled>Saqlash</button>`
          }
        </div>`;
      if (locked) {
        const text =
          u.role === "superadmin"
            ? "Superadmin barcha tashkilot va amallarga to‘liq ruxsatga ega."
            : "Administrator o‘z tashkilotidagi barcha bo‘lim va amallarga to‘liq ruxsatga ega.";
        return `<div class="adm-card perm-card" data-perm-user="${u.id}">${head}<p class="perm-locked">${text}</p></div>`;
      }
      if (superEditable) {
        const boxes = superItems
          .map(
            (p) =>
              `<label class="chk"><input type="checkbox" data-perm-key="${p.key}" ${keys.has(p.key) ? "checked" : ""} /> ${escapeHtml(p.label)}</label>`
          )
          .join("");
        return `<div class="adm-card perm-card" data-perm-user="${u.id}">${head}
          <p class="perm-locked">Administrator o‘z tashkilotidagi barcha amallarga ega. Quyidagi imkoniyatni faqat superadmin beradi.</p>
          <div class="perm-grid"><div class="perm-group super-perm">${boxes}</div></div>
        </div>`;
      }
      const checks = Object.entries(groups)
        .map(([group, items]) => {
          const boxes = items
            .filter((p) => !ADMIN_ONLY.has(p.key))
            .map(
              (p) =>
                `<label class="chk"><input type="checkbox" data-perm-key="${p.key}" ${keys.has(p.key) ? "checked" : ""} /> ${escapeHtml(p.label)}</label>`
            )
            .join("");
          if (!boxes) return "";
          return `<div class="perm-group" data-perm-group>
            <div class="perm-group-head"><b>${escapeHtml(group)}</b><button type="button" class="perm-all" data-perm-all>hammasi</button></div>
            ${boxes}
          </div>`;
        })
        .join("");
      return `<div class="adm-card perm-card" data-perm-user="${u.id}">${head}<div class="perm-grid">${checks}</div></div>`;
    })
    .join("");
  box.querySelectorAll(".perm-card").forEach(permCount);
}

function crossOrg() {
  return can("orgs.manage");
}

function usrErr(root, text, ok = false, id = "#usr-err") {
  const el = $(id, root);
  if (!el) return;
  el.classList.toggle("hidden", !text);
  el.style.color = ok ? "var(--ok)" : "";
  el.textContent = text || "";
}

function orgOptions(selected) {
  const list = crossOrg() && orgsCache.length ? orgsCache : [{ id: me?.org_id, name: me?.org_name || "Joriy tashkilot", is_active: true }];
  return list
    .map(
      (o) =>
        `<option value="${o.id}" ${String(o.id) === String(selected) ? "selected" : ""}>${escapeHtml(o.name)}${o.is_active === false ? " (faolsiz)" : ""}</option>`
    )
    .join("");
}

function fillOrgSelects(root) {
  fillClientOrgFilter(root);
  root.querySelectorAll("[data-org-select]").forEach((sel) => {
    sel.innerHTML = orgOptions(sel.value || me?.org_id);
    sel.disabled = !crossOrg();
  });
  const filter = $("#usr-org-filter", root);
  if (!filter) return;
  const cur = filter.value;
  filter.classList.toggle("hidden", !(crossOrg() && orgsCache.length > 1));
  filter.innerHTML =
    `<option value="">Barcha tashkilotlar</option>` +
    orgsCache.map((o) => `<option value="${o.id}">${escapeHtml(o.name)}</option>`).join("");
  filter.value = orgsCache.some((o) => String(o.id) === cur) ? cur : "";
}

function canTouchUser(u) {
  return u.role !== "superadmin" || isSuper();
}

function renderUsers(root) {
  const box = $("#usr-table", root);
  if (!box) return;
  const total = usersCache.length;
  const active = usersCache.filter((u) => u.is_active).length;
  $("#usr-summary", root).innerHTML = `<span class="adm-pill">Jami <b>${total}</b></span>
    <span class="adm-pill on">Faol <b>${active}</b></span>
    <span class="adm-pill${total - active ? " warn" : ""}">Nofaol <b>${total - active}</b></span>`;
  if (!total) {
    box.innerHTML = `<p class="muted adm-empty">Hozircha akkaunt yo‘q. «+ Yangi akkaunt» orqali qo‘shing.</p>`;
    return;
  }
  const q = ($("#usr-search", root)?.value || "").trim().toLowerCase();
  const org = $("#usr-org-filter", root)?.value || "";
  const rows = usersCache.filter(
    (u) =>
      (!org || String(u.org_id) === org) &&
      (!q || [u.username, u.full_name].some((v) => String(v || "").toLowerCase().includes(q)))
  );
  if (!rows.length) {
    box.innerHTML = `<p class="muted adm-empty">Mos akkaunt topilmadi.</p>`;
    return;
  }
  box.innerHTML = table(
    ["#", "Akkaunt", "Tashkilot", "Rol", "Holat", ""],
    rows
      .map((u, i) => {
        const self = u.id === me?.id;
        const touch = canTouchUser(u);
        const actions = [
          touch ? `<button class="btn tiny" type="button" data-usr-edit="${u.id}">Tahrirlash</button>` : "",
          touch && !self
            ? `<button class="btn tiny" type="button" data-usr-toggle="${u.id}">${u.is_active ? "Nofaol qilish" : "Faollashtirish"}</button>
               <button class="btn tiny danger-text" type="button" data-usr-del="${u.id}">O‘chirish</button>`
            : "",
          self ? `<span class="muted">siz</span>` : "",
        ].join("");
        return `<tr class="${u.is_active ? "" : "usr-off"}">
          <td class="adm-num">${i + 1}</td>
          <td class="cell-main"><div class="drv-cell"><span class="user-avatar sm">${escapeHtml(initials(u.full_name))}</span><span><b>${escapeHtml(u.full_name)}</b><span class="drv-login">${escapeHtml(u.username)}</span></span></div></td>
          <td class="cell-inline"><span class="usr-org">${escapeHtml(u.org_name || "—")}</span>${u.org_code ? `<span class="drv-login">kod: ${escapeHtml(u.org_code)}</span>` : ""}</td>
          <td><span class="badge role-${escapeHtml(u.role)}">${escapeHtml(ROLE[u.role] || u.role)}</span></td>
          <td><span class="badge ${u.is_active ? "approved" : "rejected"}">${u.is_active ? "faol" : "nofaol"}</span></td>
          <td class="col-actions">${actions}</td>
        </tr>`;
      })
      .join("")
  );
}

async function loadUsers(root) {
  if (!$("#usr-table", root)) return;
  usersCache = await api("/users");
  setCount(root, "cnt-users", usersCache.length);
  renderUsers(root);
}

async function afterUserChange(root) {
  await loadUsers(root);
  refreshPerms(root);
  if (crossOrg()) await loadOrgs(root).catch(() => {});
}

function openUserEdit(root, u) {
  const form = $("#usr-edit-form", root);
  if (!form) return;
  usrErr(root, "", false, "#usr-edit-err");
  form.reset();
  fillOrgSelects(root);
  const self = u.id === me?.id;
  const isSA = u.role === "superadmin";
  const el = form.elements;
  el.id.value = u.id;
  el.username.value = u.username;
  el.full_name.value = u.full_name;
  el.password.value = "";
  el.role.value = u.role;
  el.role.disabled = isSA || self;
  el.org_id.value = String(u.org_id ?? "");
  el.org_id.disabled = !crossOrg() || isSA || self;
  el.is_active.checked = Boolean(u.is_active);
  el.is_active.disabled = self;
  const note = $("#usr-edit-note", root);
  const text = self
    ? "Bu sizning akkauntingiz: rol, tashkilot va holatni o‘zgartirib bo‘lmaydi."
    : isSA
      ? "Superadmin rolini va tashkilotini o‘zgartirib bo‘lmaydi."
      : "";
  note.textContent = text;
  note.classList.toggle("hidden", !text);
  $("#usr-modal", root).classList.remove("hidden");
  el.username.focus();
}

function closeUserEdit(root) {
  $("#usr-modal", root)?.classList.add("hidden");
}

function bindUsers(root) {
  const form = $("#usr-form", root);
  if (!form) return;
  $("#usr-add-toggle", root).onclick = () => {
    form.classList.toggle("hidden");
    if (!form.classList.contains("hidden")) form.querySelector("[name=username]")?.focus();
  };
  $("#usr-add-cancel", root).onclick = () => {
    form.reset();
    form.classList.add("hidden");
  };
  $("#usr-search", root).addEventListener("input", () => renderUsers(root));
  $("#usr-org-filter", root).addEventListener("change", () => renderUsers(root));

  form.onsubmit = async (e) => {
    e.preventDefault();
    usrErr(root, "");
    const d = formData(form);
    const body = {
      username: String(d.username || "").trim(),
      full_name: String(d.full_name || "").trim(),
      password: d.password || "",
      role: d.role || "dispatcher",
      org_id: d.org_id ? Number(d.org_id) : null,
      is_active: form.elements.is_active.checked,
      idle_timeout_minutes: 30,
      permissions: [],
    };
    try {
      const u = await api("/users", { method: "POST", body });
      form.reset();
      form.classList.add("hidden");
      usrErr(
        root,
        `«${u.username}» akkaunti ochildi: ${u.org_name}${u.org_code ? `, kirish kodi ${u.org_code}` : ""}.`,
        true
      );
      await afterUserChange(root);
    } catch (ex) {
      usrErr(root, ex.message);
    }
  };

  $("#usr-table", root).addEventListener("click", async (e) => {
    const btn = e.target.closest("button");
    if (!btn) return;
    const id = Number(btn.dataset.usrEdit || btn.dataset.usrToggle || btn.dataset.usrDel);
    const u = usersCache.find((x) => x.id === id);
    if (!u) return;
    usrErr(root, "");
    try {
      if (btn.dataset.usrEdit) {
        openUserEdit(root, u);
        return;
      }
      if (btn.dataset.usrToggle) {
        if (u.is_active) {
          const ok = await askConfirm(`«${u.username}» nofaol qilinsa, tizimdan chiqariladi va qayta kira olmaydi.`, {
            title: "Nofaol qilish",
            ok: "Nofaol qilish",
            danger: true,
          });
          if (!ok) return;
        }
        await api(`/users/${u.id}`, { method: "PUT", body: { is_active: !u.is_active } });
        await afterUserChange(root);
        return;
      }
      if (btn.dataset.usrDel) {
        const ok = await askConfirm(`«${u.username}» (${u.full_name}) akkaunti butunlay o‘chiriladi. Bu amalni qaytarib bo‘lmaydi.`, {
          title: "Akkauntni o‘chirish",
          ok: "O‘chirish",
          danger: true,
        });
        if (!ok) return;
        await api(`/users/${u.id}`, { method: "DELETE" });
        usrErr(root, `«${u.username}» o‘chirildi.`, true);
        await afterUserChange(root);
        loadTrash(root).catch(() => {});
      }
    } catch (ex) {
      usrErr(root, ex.message);
    }
  });

  const modal = $("#usr-modal", root);
  modal.addEventListener("click", (e) => {
    if (e.target === modal || e.target.closest("[data-usr-close]")) closeUserEdit(root);
  });
  $("#usr-edit-form", root).onsubmit = async (e) => {
    e.preventDefault();
    const el = e.target.elements;
    const u = usersCache.find((x) => String(x.id) === el.id.value);
    if (!u) return;
    usrErr(root, "", false, "#usr-edit-err");
    const body = { username: el.username.value.trim(), full_name: el.full_name.value.trim() };
    if (el.password.value) body.password = el.password.value;
    if (!el.role.disabled && el.role.value !== u.role) body.role = el.role.value;
    if (!el.org_id.disabled && el.org_id.value && Number(el.org_id.value) !== u.org_id) body.org_id = Number(el.org_id.value);
    if (!el.is_active.disabled && el.is_active.checked !== u.is_active) body.is_active = el.is_active.checked;
    if (body.org_id) {
      const target = orgsCache.find((o) => o.id === body.org_id);
      const ok = await askConfirm(
        `«${u.username}» «${target?.name || "boshqa"}» tashkilotiga o‘tkaziladi va tizimdan chiqariladi. Endi u ${target?.code || "yangi"} kodi bilan kiradi.`,
        { title: "Tashkilotni o‘zgartirish", ok: "O‘tkazish" }
      );
      if (!ok) return;
    }
    try {
      const updated = await api(`/users/${u.id}`, { method: "PUT", body });
      if (updated.id === me?.id) setMe({ ...me, ...updated });
      closeUserEdit(root);
      usrErr(root, `«${updated.username}» saqlandi.`, true);
      await afterUserChange(root);
    } catch (ex) {
      usrErr(root, ex.message, false, "#usr-edit-err");
    }
  };
}

// Sahifada nechta klient: 0 — hammasi. Tanlov brauzerda eslab qolinadi
const CL_SIZES = [10, 50, 100, 500, 0];
const CL_SIZE_KEY = "nx_cl_page_size";
let clSize = (() => {
  const saved = localStorage.getItem(CL_SIZE_KEY);
  return saved != null && CL_SIZES.includes(Number(saved)) ? Number(saved) : 50;
})();
let clPage = 1;

// 1 … 4 5 6 … 20 — joriy varaq atrofi va chetlari
function pageList(cur, total) {
  const keep = new Set([1, total, cur - 1, cur, cur + 1].filter((n) => n >= 1 && n <= total));
  if (cur <= 3) [2, 3, 4].forEach((n) => n <= total && keep.add(n));
  if (cur >= total - 2) [total - 1, total - 2, total - 3].forEach((n) => n >= 1 && keep.add(n));
  const out = [];
  let prev = 0;
  [...keep].sort((a, b) => a - b).forEach((n) => {
    if (n - prev > 1) out.push(null);
    out.push(n);
    prev = n;
  });
  return out;
}

function renderClPager(root, total) {
  const box = $("#cl-pager", root);
  if (!box) return;
  const pages = clSize ? Math.max(1, Math.ceil(total / clSize)) : 1;
  box.classList.toggle("hidden", !total);
  if (!total) {
    box.innerHTML = "";
    return;
  }
  const from = clSize ? (clPage - 1) * clSize + 1 : 1;
  const to = clSize ? Math.min(total, clPage * clSize) : total;
  const nums =
    pages > 1
      ? pageList(clPage, pages)
          .map((n) =>
            n == null
              ? `<span class="pg-gap">…</span>`
              : `<button type="button" class="pg-btn${n === clPage ? " on" : ""}" data-cl-page="${n}"${n === clPage ? ' aria-current="page"' : ""}>${n}</button>`
          )
          .join("")
      : "";
  box.innerHTML = `
    <span class="pg-info"><b>${from}–${to}</b> / ${total}</span>
    <div class="pg-nav">
      ${pages > 1 ? `<button type="button" class="pg-btn pg-step" data-cl-page="${clPage - 1}" aria-label="Oldingi sahifa"${clPage <= 1 ? " disabled" : ""}>‹</button>` : ""}
      ${nums}
      ${pages > 1 ? `<button type="button" class="pg-btn pg-step" data-cl-page="${clPage + 1}" aria-label="Keyingi sahifa"${clPage >= pages ? " disabled" : ""}>›</button>` : ""}
    </div>
    <span class="pg-info">${pages} varaq</span>`;
}

function clErr(root, text, ok = false) {
  usrErr(root, text, ok, "#cl-err");
}

function fillClientOrgFilter(root) {
  const sel = $("#cl-org", root);
  if (!sel) return;
  const show = crossOrg() && orgsCache.length > 1;
  sel.classList.toggle("hidden", !show);
  if (!show) return;
  const cur = sel.value;
  const counts = {};
  clientsCache.forEach((c) => (counts[c.org_id] = (counts[c.org_id] || 0) + 1));
  sel.innerHTML =
    `<option value="">Barcha tashkilotlar (${clientsCache.length})</option>` +
    orgsCache.map((o) => `<option value="${o.id}">${escapeHtml(o.name)} (${counts[o.id] || 0})</option>`).join("");
  sel.value = orgsCache.some((o) => String(o.id) === cur) ? cur : "";
}

function addedSince(days) {
  if (days === "") return null;
  const since = new Date();
  since.setHours(0, 0, 0, 0);
  since.setDate(since.getDate() - Number(days));
  return since;
}

function clientMatches(c, q, since) {
  if (since && (!c.created_at || new Date(c.created_at) < since)) return false;
  if (!q) return true;
  return [c.name, c.code, c.address, c.sales_rep, c.agent_code, c.phone].some((v) => String(v || "").toLowerCase().includes(q));
}

function renderClients(root) {
  const box = $("#cl-table", root);
  if (!box) return;
  const q = ($("#cl-search", root)?.value || "").trim().toLowerCase();
  const since = addedSince($("#cl-added", root)?.value ?? "");
  const org = $("#cl-org", root)?.value || "";
  const scoped = org ? clientsCache.filter((c) => String(c.org_id) === org) : clientsCache;
  const rows = scoped.filter((c) => clientMatches(c, q, since));
  clVisible = rows;
  const visibleIds = new Set(rows.map((c) => c.id));
  [...clPicked].forEach((id) => {
    if (!visibleIds.has(id)) clPicked.delete(id);
  });
  syncClBulk(root);
  const today = scoped.filter((c) => clientMatches(c, "", addedSince("0"))).length;
  const noGps = scoped.filter((c) => !c.lat || !c.lng).length;
  $("#cl-summary", root).innerHTML = `<span class="adm-pill">Jami <b>${scoped.length}</b></span>
    <span class="adm-pill on">Bugun qo‘shilgan <b>${today}</b></span>
    <span class="adm-pill${noGps ? " warn" : ""}">Koordinatasiz <b>${noGps}</b></span>`;
  const pages = clSize ? Math.max(1, Math.ceil(rows.length / clSize)) : 1;
  clPage = Math.min(Math.max(1, clPage), pages);
  renderClPager(root, rows.length);
  if (!scoped.length) {
    box.innerHTML = `<p class="muted adm-empty">Hozircha klient yo‘q. Zayavkalar import qilinganda mijozlar shu yerga avtomatik tushadi.</p>`;
    return;
  }
  if (!rows.length) {
    box.innerHTML = `<p class="muted adm-empty">Mos klient topilmadi.</p>`;
    return;
  }
  const start = clSize ? (clPage - 1) * clSize : 0;
  const multiOrg = crossOrg() || new Set(rows.map((c) => c.org_id)).size > 1;
  const manage = can("clients.manage");
  const headers = [...(manage ? [""] : []), "#", "Klient", ...(multiOrg ? ["Tashkilot"] : []), "Manzil", "Agent", "Zayavkalar", "Qo‘shilgan", ...(manage ? [""] : [])];
  const body = (clSize ? rows.slice(start, start + clSize) : rows)
    .map((c, i) => {
      const gps = c.lat && c.lng ? `${Number(c.lat).toFixed(5)}, ${Number(c.lng).toFixed(5)}` : "koordinata yo‘q";
      return `<tr>
        ${manage ? `<td class="col-check"><input type="checkbox" data-cl-pick="${c.id}" ${clPicked.has(c.id) ? "checked" : ""} aria-label="Belgilash" /></td>` : ""}
        <td class="adm-num">${start + i + 1}</td>
        <td class="cell-main"><b>${escapeHtml(c.name)}</b><span class="cl-sub">${c.code ? `kod: ${escapeHtml(c.code)}` : "kodsiz"}${c.phone ? ` · ${escapeHtml(c.phone)}` : ""}</span></td>
        ${multiOrg ? `<td class="cell-inline"><span class="usr-org">${escapeHtml(c.org_name || "—")}</span></td>` : ""}
        <td class="cell-wide"><span class="cl-addr">${escapeHtml(c.address || "—")}</span><span class="cl-sub">${gps}</span></td>
        <td class="cell-inline">${c.agent_code ? `<b>${escapeHtml(c.agent_code)}</b> · ` : ""}${escapeHtml(c.sales_rep || (c.agent_code ? "" : "—"))}</td>
        <td class="cell-inline nowrap">${c.orders_count} ta${c.last_order_date ? `<span class="cl-sub">oxirgi: ${escapeHtml(c.last_order_date)}</span>` : ""}</td>
        <td class="cell-inline nowrap">${fmtDate(c.created_at)} <span class="badge ${c.source === "import" ? "src-import" : "entity"}">${c.source === "import" ? "import" : "qo‘lda"}</span></td>
        ${
          manage
            ? `<td class="col-actions">
                <button class="btn tiny" type="button" data-cl-edit="${c.id}">Tahrirlash</button>
                <button class="btn tiny danger-text" type="button" data-cl-del="${c.id}">O‘chirish</button>
              </td>`
            : ""
        }
      </tr>`;
    })
    .join("");
  box.innerHTML = table(headers, body);
}

function syncClBulk(root) {
  const bar = $("#cl-bulk", root);
  if (!bar) return;
  bar.classList.toggle("hidden", !can("clients.manage") || !clVisible.length);
  const n = clPicked.size;
  const all = $("#cl-all", root);
  if (all) {
    all.checked = n > 0 && n === clVisible.length;
    all.indeterminate = n > 0 && n < clVisible.length;
  }
  const label = $("#cl-all-label", root);
  if (label) label.textContent = `Hammasini belgilash (${clVisible.length})`;
  const count = $("#cl-sel-count", root);
  if (count) count.textContent = n ? `${n} ta tanlandi` : "";
  const del = $("#cl-bulk-del", root);
  if (del) del.disabled = !n;
}

async function loadClients(root) {
  if (!$("#cl-table", root)) return;
  clientsCache = await api("/clients/base");
  setCount(root, "cnt-clients", clientsCache.length);
  fillClientOrgFilter(root);
  renderClients(root);
}

function openClientEdit(root, c) {
  const form = $("#cl-edit-form", root);
  usrErr(root, "", false, "#cl-edit-err");
  form.reset();
  const el = form.elements;
  el.id.value = c.id;
  ["name", "code", "phone", "address", "agent_code", "sales_rep", "notes"].forEach((k) => (el[k].value = c[k] || ""));
  el.lat.value = c.lat || "";
  el.lng.value = c.lng || "";
  $("#cl-modal", root).classList.remove("hidden");
  el.name.focus();
}

function bindClients(root) {
  const box = $("#cl-table", root);
  if (!box) return;
  let typing = null;
  const firstPage = () => {
    clPage = 1;
    renderClients(root);
  };
  $("#cl-search", root).addEventListener("input", () => {
    clearTimeout(typing);
    typing = setTimeout(firstPage, 150);
  });
  $("#cl-added", root).addEventListener("change", firstPage);
  $("#cl-org", root).addEventListener("change", firstPage);
  const size = $("#cl-size", root);
  if (size) {
    size.value = String(clSize);
    size.addEventListener("change", () => {
      clSize = CL_SIZES.includes(Number(size.value)) ? Number(size.value) : 50;
      localStorage.setItem(CL_SIZE_KEY, String(clSize));
      firstPage();
    });
  }
  $("#cl-pager", root)?.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-cl-page]");
    if (!btn || btn.disabled) return;
    clPage = Number(btn.dataset.clPage) || 1;
    renderClients(root);
    let sp = box.parentElement;
    while (sp && sp !== document.body && !/(auto|scroll)/.test(getComputedStyle(sp).overflowY)) sp = sp.parentElement;
    const edge = sp && sp !== document.body ? sp.getBoundingClientRect().top : 0;
    if (box.getBoundingClientRect().top < edge) box.scrollIntoView({ block: "start", behavior: "smooth" });
  });

  $("#cl-export", root).onclick = async (e) => {
    const btn = e.currentTarget;
    clErr(root, "");
    const org = $("#cl-org", root)?.value || "";
    const params = new URLSearchParams();
    if (org) params.set("org_id", org);
    const q = $("#cl-search", root).value.trim();
    if (q) params.set("q", q);
    const days = $("#cl-added", root).value;
    if (days !== "") params.set("days", days);
    const orgName = org ? orgsCache.find((o) => String(o.id) === org)?.name : crossOrg() ? "barcha" : me?.org_name;
    const stamp = new Date().toISOString().slice(0, 10);
    btn.disabled = true;
    try {
      await apiDownload(`/clients/base/export?${params}`, `Klientlar_${orgName || "baza"}_${stamp}.xlsx`);
    } catch (ex) {
      clErr(root, ex.message);
    } finally {
      btn.disabled = false;
    }
  };

  box.addEventListener("click", async (e) => {
    const btn = e.target.closest("button");
    if (!btn) return;
    const id = Number(btn.dataset.clEdit || btn.dataset.clDel);
    const c = clientsCache.find((x) => x.id === id);
    if (!c) return;
    clErr(root, "");
    if (btn.dataset.clEdit) {
      openClientEdit(root, c);
      return;
    }
    const ok = await askConfirm(
      `«${c.name}» klient bazasidan o‘chiriladi. Zayavkalar o‘chmaydi, faqat klientga bog‘lanishi uziladi. Keyingi importda u yana yangi klient sifatida qo‘shilishi mumkin.`,
      { title: "Klientni o‘chirish", ok: "O‘chirish", danger: true }
    );
    if (!ok) return;
    try {
      await api(`/clients/base/${c.id}`, { method: "DELETE" });
      clientsCache = clientsCache.filter((x) => x.id !== c.id);
      setCount(root, "cnt-clients", clientsCache.length);
      fillClientOrgFilter(root);
      loadTrash(root).catch(() => {});
      renderClients(root);
      clErr(root, `«${c.name}» o‘chirildi.`, true);
    } catch (ex) {
      clErr(root, ex.message);
    }
  });

  box.addEventListener("change", (e) => {
    const pick = e.target.closest("[data-cl-pick]");
    if (!pick) return;
    const id = Number(pick.dataset.clPick);
    if (pick.checked) clPicked.add(id);
    else clPicked.delete(id);
    syncClBulk(root);
  });
  $("#cl-all", root)?.addEventListener("change", (e) => {
    clPicked.clear();
    if (e.target.checked) clVisible.forEach((c) => clPicked.add(c.id));
    box.querySelectorAll("[data-cl-pick]").forEach((el) => {
      el.checked = clPicked.has(Number(el.dataset.clPick));
    });
    syncClBulk(root);
  });
  $("#cl-bulk-del", root)?.addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    const ids = [...clPicked];
    if (!ids.length) return;
    clErr(root, "");
    const ok = await askConfirm(
      `${ids.length} ta klient bazadan o‘chiriladi. Zayavkalar o‘chmaydi, faqat klientga bog‘lanishi uziladi. Ular «O‘chirilganlar» bo‘limida saqlanadi.`,
      { title: "Klientlarni o‘chirish", ok: `${ids.length} tasini o‘chirish`, danger: true }
    );
    if (!ok) return;
    btn.disabled = true;
    let deleted = 0;
    try {
      for (let i = 0; i < ids.length; i += 5000) {
        const part = ids.slice(i, i + 5000);
        const res = await api("/clients/base/bulk-delete", { method: "POST", body: { ids: part } });
        deleted += res?.deleted || 0;
        const gone = new Set(part);
        clientsCache = clientsCache.filter((x) => !gone.has(x.id));
        part.forEach((id) => clPicked.delete(id));
      }
      clErr(root, `${deleted} ta klient o‘chirildi.`, true);
    } catch (ex) {
      clErr(root, deleted ? `${deleted} ta o‘chirildi, qolganida xato: ${ex.message}` : ex.message);
    } finally {
      setCount(root, "cnt-clients", clientsCache.length);
      fillClientOrgFilter(root);
      loadTrash(root).catch(() => {});
      renderClients(root);
    }
  });

  const modal = $("#cl-modal", root);
  modal.addEventListener("click", (e) => {
    if (e.target === modal || e.target.closest("[data-cl-close]")) modal.classList.add("hidden");
  });
  $("#cl-edit-form", root).onsubmit = async (e) => {
    e.preventDefault();
    const el = e.target.elements;
    const body = {
      name: el.name.value.trim(),
      code: el.code.value.trim(),
      phone: el.phone.value.trim(),
      address: el.address.value.trim(),
      lat: el.lat.value === "" ? 0 : Number(el.lat.value),
      lng: el.lng.value === "" ? 0 : Number(el.lng.value),
      agent_code: el.agent_code.value.trim(),
      sales_rep: el.sales_rep.value.trim(),
      notes: el.notes.value.trim(),
    };
    try {
      const updated = await api(`/clients/base/${el.id.value}`, { method: "PUT", body });
      clientsCache = clientsCache.map((x) => (x.id === updated.id ? updated : x));
      modal.classList.add("hidden");
      renderClients(root);
      clErr(root, `«${updated.name}» saqlandi.`, true);
    } catch (ex) {
      usrErr(root, ex.message, false, "#cl-edit-err");
    }
  };
}

const TR_FIELDS = {
  name: "Nomi",
  full_name: "To‘liq ism",
  username: "Login",
  role: "Rol",
  code: "Kod",
  phone: "Telefon",
  address: "Manzil",
  vehicle_plate: "Davlat raqami",
  vehicle_type: "Transport turi",
  agent_name: "Agent",
  region: "Hudud",
  commission_pct: "Komissiya, %",
  agent_code: "Agent kodi",
  sales_rep: "Agent (savdo vakili)",
  company: "Kompaniya",
  lat: "Latitude",
  lng: "Longitude",
  is_default: "Asosiy sklad",
  is_active: "Faol",
  source: "Manba",
  notes: "Izoh",
  created_at: "Yaratilgan",
};
let trashTotal = 0;

function trErr(root, text) {
  usrErr(root, text, false, "#tr-err");
}

function trashValue(key, v) {
  if (v === true) return "ha";
  if (v === false) return "yo‘q";
  if (key === "created_at") return fmtDate(v);
  if (key === "role") return ROLE[v] || v;
  if (key === "source") return v === "import" ? "Import" : "Qo‘lda";
  return String(v);
}

function trashDataHtml(data) {
  const rows = Object.entries(TR_FIELDS)
    .filter(([k]) => data[k] !== undefined && data[k] !== null && data[k] !== "" && !((k === "lat" || k === "lng") && !data[k]))
    .map(([k, label]) => `<dt>${label}</dt><dd>${escapeHtml(trashValue(k, data[k]))}</dd>`)
    .join("");
  return rows ? `<dl class="tr-data">${rows}</dl>` : `<p class="muted">Qo‘shimcha ma’lumot yo‘q</p>`;
}

function fillTrashFilters(root, res) {
  const ent = $("#tr-entity", root);
  const cur = ent.value;
  const counts = res.counts || {};
  const all = Object.values(counts).reduce((a, b) => a + b, 0);
  ent.innerHTML =
    `<option value="">Turi: hammasi (${all})</option>` +
    res.entities.map((e) => `<option value="${e.key}">${escapeHtml(e.label)} (${counts[e.key] || 0})</option>`).join("");
  ent.value = cur;
  const org = $("#tr-org", root);
  const show = crossOrg() && orgsCache.length > 1;
  org.classList.toggle("hidden", !show);
  if (show) {
    const oc = org.value;
    org.innerHTML =
      `<option value="">Barcha tashkilotlar</option>` +
      orgsCache.map((o) => `<option value="${o.id}">${escapeHtml(o.name)}</option>`).join("");
    org.value = orgsCache.some((o) => String(o.id) === oc) ? oc : "";
  }
}

function renderTrash(root, res) {
  fillTrashFilters(root, res);
  const items = res.items || [];
  $("#tr-summary", root).innerHTML =
    `<span class="adm-pill">Topildi <b>${res.total}</b></span>` +
    (items.length < res.total ? `<span class="adm-pill">Ko‘rsatildi <b>${items.length}</b></span>` : "");
  const box = $("#tr-list", root);
  if (!items.length) {
    box.innerHTML = `<p class="muted adm-empty">O‘chirilgan ma’lumot topilmadi.</p>`;
    return;
  }
  const showOrg = crossOrg();
  box.innerHTML = items
    .map((it) => {
      const when = it.deleted_at ? new Date(it.deleted_at).toLocaleString("uz-UZ") : "—";
      return `<article class="tr-item">
        <div class="tr-head">
          <span class="badge tr-ent tr-${escapeHtml(it.entity)}">${escapeHtml(it.entity_label)}</span>
          <b class="tr-title">${escapeHtml(it.title || "—")}</b>
          ${showOrg && it.org_name ? `<span class="usr-org">${escapeHtml(it.org_name)}</span>` : ""}
        </div>
        <div class="tr-meta">O‘chirdi: <b>${escapeHtml(it.deleted_by || "—")}</b> · ${escapeHtml(when)}</div>
        <details class="tr-more"><summary>O‘chirilgan paytdagi ma’lumot</summary>${trashDataHtml(it.data || {})}</details>
      </article>`;
    })
    .join("");
}

async function loadTrash(root) {
  if (!$("#tr-list", root) || !can("trash.view")) return;
  const params = new URLSearchParams();
  const q = $("#tr-search", root).value.trim();
  const entity = $("#tr-entity", root).value;
  const org = $("#tr-org", root).value;
  const days = $("#tr-days", root).value;
  if (q) params.set("q", q);
  if (entity) params.set("entity", entity);
  if (org) params.set("org_id", org);
  if (days !== "") params.set("days", days);
  const res = await api(`/trash?${params}`);
  if (!q && !entity && !org && days === "") trashTotal = res.total;
  setCount(root, "cnt-trash", trashTotal);
  trErr(root, "");
  renderTrash(root, res);
}

function bindTrash(root) {
  const reload = () => loadTrash(root).catch((ex) => trErr(root, ex.message));
  let typing = null;
  $("#tr-search", root).addEventListener("input", () => {
    clearTimeout(typing);
    typing = setTimeout(reload, 300);
  });
  ["#tr-entity", "#tr-org", "#tr-days"].forEach((id) => $(id, root).addEventListener("change", reload));
  $("#tr-refresh", root).onclick = reload;
}

function orgErr(root, text, ok = false) {
  const el = $("#org-err", root);
  if (!el) return;
  el.classList.toggle("hidden", !text);
  el.style.color = ok ? "var(--ok)" : "";
  el.textContent = text || "";
}

function fmtDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleDateString("uz-UZ");
}

function orgUsersHtml(org, users) {
  const rows = users.length
    ? table(
        ["Login", "Ism", "Rol", "Holat", ""],
        users
          .map((u) => {
            const locked = (u.role === "superadmin" && !isSuper()) || u.id === me?.id;
            return `<tr>
              <td class="nowrap"><b>${escapeHtml(u.username)}</b></td>
              <td>${escapeHtml(u.full_name)}</td>
              <td><span class="badge role-${escapeHtml(u.role)}">${escapeHtml(ROLE[u.role] || u.role)}</span></td>
              <td><span class="badge ${u.is_active ? "approved" : "rejected"}">${u.is_active ? "faol" : "o‘chiq"}</span></td>
              <td class="col-actions">${
                locked
                  ? `<span class="muted">${u.id === me?.id ? "siz" : ""}</span>`
                  : `<button class="btn tiny" type="button" data-ou-pass="${u.id}">Parol</button>
                     <button class="btn tiny" type="button" data-ou-toggle="${u.id}" data-active="${u.is_active ? "1" : "0"}">${u.is_active ? "Faolsiz" : "Yoqish"}</button>`
              }</td>
            </tr>`;
          })
          .join("")
      )
    : `<p class="muted adm-empty">Bu tashkilotda hali akkaunt yo‘q.</p>`;
  return `${rows}
    <form class="org-user-form form-grid" data-ou-form="${org.id}" autocomplete="off">
      <input name="username" placeholder="Login" required minlength="3" autocomplete="off" />
      <input name="full_name" placeholder="To‘liq ism" />
      <input name="password" type="password" placeholder="Parol (kamida 6)" required minlength="6" autocomplete="new-password" />
      <select name="role">
        <option value="dispatcher">Dispetcher</option>
        <option value="admin">Administrator</option>
      </select>
      <button class="btn primary" type="submit">Akkaunt ochish</button>
    </form>`;
}

function orgCardHtml(org) {
  const open = openOrgs.has(org.id);
  return `<div class="adm-card org-card${org.is_active ? "" : " off"}" data-org="${org.id}">
    <div class="org-head">
      <div class="org-title">
        <b>${escapeHtml(org.name)}</b>
        ${org.is_own ? `<span class="badge entity">Sizning tashkilot</span>` : ""}
        ${org.is_active ? "" : `<span class="badge rejected">Faolsiz</span>`}
      </div>
      <div class="org-code" title="Tizimga kirish kodi">
        <span>Kirish kodi</span>
        <b>${escapeHtml(org.code || "——————")}</b>
        <button class="btn tiny" type="button" data-org-copy="${escapeHtml(org.code)}">Nusxa</button>
      </div>
    </div>
    <div class="org-office-line${org.lat == null ? " warn" : ""}">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21Z" /><circle cx="12" cy="9.5" r="2.5" /></svg>
      <span>${
        org.address
          ? escapeHtml(org.address)
          : org.lat != null
            ? `${Number(org.lat).toFixed(5)}, ${Number(org.lng).toFixed(5)}`
            : "Ofis manzili kiritilmagan"
      }</span>
    </div>
    <div class="adm-summary org-meta">
      <span class="adm-pill">Admin <b>${org.admin_count}</b></span>
      <span class="adm-pill">Dispetcher <b>${org.dispatcher_count}</b></span>
      <span class="adm-pill">Haydovchi <b>${org.driver_count}</b></span>
      <span class="adm-pill">Ochilgan <b>${fmtDate(org.created_at)}</b></span>
    </div>
    <div class="row-actions org-actions">
      <button class="btn tiny${open ? " primary" : ""}" type="button" data-org-users="${org.id}">Akkauntlar (${org.user_count})</button>
      <button class="btn tiny" type="button" data-org-rename="${org.id}">Nomini o‘zgartirish</button>
      <button class="btn tiny" type="button" data-org-office="${org.id}">Ofis manzili</button>
      <button class="btn tiny" type="button" data-org-code="${org.id}">Yangi kod</button>
      ${org.is_own ? "" : `<button class="btn tiny${org.is_active ? " danger-text" : ""}" type="button" data-org-toggle="${org.id}">${org.is_active ? "Faolsizlantirish" : "Faollashtirish"}</button>`}
    </div>
    <div class="org-users${open ? "" : " hidden"}" data-org-box="${org.id}"></div>
  </div>`;
}

async function loadOrgUsers(root, orgId) {
  const box = root.querySelector(`[data-org-box="${orgId}"]`);
  if (!box) return;
  const org = orgsCache.find((o) => o.id === Number(orgId));
  box.innerHTML = `<p class="muted adm-empty">Yuklanmoqda…</p>`;
  const users = await api(`/orgs/${orgId}/users`);
  box.innerHTML = orgUsersHtml(org, users);
}

async function loadOrgs(root) {
  const box = $("#org-list", root);
  if (!box) return;
  orgsCache = await api("/orgs");
  setCount(root, "cnt-orgs", orgsCache.length);
  box.innerHTML = orgsCache.length ? orgsCache.map(orgCardHtml).join("") : `<p class="muted adm-empty">Hozircha tashkilot yo‘q.</p>`;
  fillOrgSelects(root);
  await Promise.all([...openOrgs].map((id) => loadOrgUsers(root, id).catch(() => {})));
}

function openOffice(root, org) {
  if (!org) return;
  officeOrgId = org.id;
  orgErr(root, "");
  usrErr(root, "", false, "#org-office-err");
  $("#org-office-title", root).textContent = `«${org.name}» ofis manzili`;
  $("#org-office-modal", root).classList.remove("hidden");
  editPicker?.destroy();
  editPicker = mountOfficePicker($("#org-office-edit", root), { address: org.address, lat: org.lat, lng: org.lng });
}

function closeOffice(root) {
  $("#org-office-modal", root)?.classList.add("hidden");
  editPicker?.destroy();
  editPicker = null;
  officeOrgId = null;
}

function bindOffice(root) {
  const modal = $("#org-office-modal", root);
  if (!modal) return;
  modal.addEventListener("click", (e) => {
    if (e.target === modal || e.target.closest("[data-office-close]")) closeOffice(root);
  });
  $("#org-office-save", root).onclick = async () => {
    const office = editPicker?.value() || {};
    if (office.lat == null) {
      usrErr(root, "Xaritadan ofis joylashuvini belgilang.", false, "#org-office-err");
      return;
    }
    if (!office.address) {
      usrErr(root, "Ofis manzilini kiriting.", false, "#org-office-err");
      return;
    }
    try {
      await api(`/orgs/${officeOrgId}`, { method: "PUT", body: office });
      closeOffice(root);
      orgErr(root, "Ofis manzili saqlandi.", true);
      await loadOrgs(root);
    } catch (ex) {
      usrErr(root, ex.message, false, "#org-office-err");
    }
  };
}

function refreshPerms(root) {
  if (can("perms.manage")) loadPermsAdmin(root).catch(() => {});
}

function bindOrgs(root) {
  const form = $("#org-form", root);
  if (!form) return;
  const closeCreate = () => {
    form.reset();
    form.classList.add("hidden");
    createPicker?.destroy();
    createPicker = null;
  };
  $("#org-add-toggle", root).onclick = () => {
    if (!form.classList.contains("hidden")) {
      closeCreate();
      return;
    }
    form.classList.remove("hidden");
    createPicker = mountOfficePicker($("#org-office-create", root));
    form.querySelector("[name=name]")?.focus();
  };
  $("#org-add-cancel", root).onclick = closeCreate;
  form.onsubmit = async (e) => {
    e.preventDefault();
    orgErr(root, "");
    const office = createPicker?.value() || {};
    if (office.lat == null) {
      orgErr(root, "Xaritadan ofis joylashuvini belgilang yoki manzilni qidiring.");
      return;
    }
    if (!office.address) {
      orgErr(root, "Ofis manzilini kiriting.");
      return;
    }
    const d = { ...formData(form), ...office };
    try {
      const org = await api("/orgs", { method: "POST", body: d });
      closeCreate();
      const done = $("#org-created", root);
      done.innerHTML = `<div class="org-created-row">
          <div><b>«${escapeHtml(org.name)}» tashkiloti ochildi</b>
          <p class="muted adm-sub">Admin shu kod, «${escapeHtml(d.admin_username)}» login va siz kiritgan parol bilan kiradi.</p></div>
          <div class="org-code big"><span>Kirish kodi</span><b>${escapeHtml(org.code)}</b>
          <button class="btn tiny" type="button" data-org-copy="${escapeHtml(org.code)}">Nusxa</button></div>
          <button class="icon-x-btn" type="button" data-org-created-close aria-label="Yopish">×</button>
        </div>`;
      done.classList.remove("hidden");
      openOrgs.add(org.id);
      await loadOrgs(root);
      refreshPerms(root);
    } catch (ex) {
      orgErr(root, ex.message);
    }
  };

  const section = root.querySelector('[data-admin-sec="orgs"]');
  section.addEventListener("submit", async (e) => {
    const f = e.target.closest("[data-ou-form]");
    if (!f) return;
    e.preventDefault();
    orgErr(root, "");
    try {
      const u = await api(`/orgs/${f.dataset.ouForm}/users`, { method: "POST", body: formData(f) });
      orgErr(root, `«${u.username}» akkaunti ochildi (${ROLE[u.role] || u.role}).`, true);
      await loadOrgs(root);
      refreshPerms(root);
    } catch (ex) {
      orgErr(root, ex.message);
    }
  });
  section.addEventListener("click", async (e) => {
    const t = e.target.closest("button");
    if (!t) return;
    const card = t.closest("[data-org]");
    const orgId = card?.dataset.org;
    const org = orgsCache.find((o) => String(o.id) === String(orgId));
    try {
      if (t.dataset.orgCreatedClose !== undefined) {
        $("#org-created", root).classList.add("hidden");
        return;
      }
      if (t.dataset.orgCopy !== undefined) {
        await navigator.clipboard?.writeText(t.dataset.orgCopy).catch(() => {});
        t.textContent = "Nusxalandi ✓";
        setTimeout(() => (t.textContent = "Nusxa"), 1500);
        return;
      }
      if (t.dataset.orgUsers) {
        const id = Number(t.dataset.orgUsers);
        if (openOrgs.has(id)) openOrgs.delete(id);
        else openOrgs.add(id);
        card.querySelector("[data-org-box]").classList.toggle("hidden", !openOrgs.has(id));
        t.classList.toggle("primary", openOrgs.has(id));
        if (openOrgs.has(id)) await loadOrgUsers(root, id);
        return;
      }
      if (t.dataset.orgOffice) {
        openOffice(root, org);
        return;
      }
      if (t.dataset.orgRename) {
        const name = prompt("Tashkilotning yangi nomi:", org?.name || "");
        if (!name || name.trim() === org?.name) return;
        await api(`/orgs/${orgId}`, { method: "PUT", body: { name: name.trim() } });
        await loadOrgs(root);
        return;
      }
      if (t.dataset.orgCode) {
        const ok = await askConfirm(
          `«${org?.name}» uchun yangi kirish kodi beriladi. Eski kod (${org?.code}) bilan endi kirib bo‘lmaydi — xodimlarga yangi kodni yetkazing.`,
          { title: "Yangi kod", ok: "Yangi kod berish" }
        );
        if (!ok) return;
        const upd = await api(`/orgs/${orgId}/code`, { method: "POST" });
        orgErr(root, `«${upd.name}» yangi kirish kodi: ${upd.code}`, true);
        await loadOrgs(root);
        return;
      }
      if (t.dataset.orgToggle) {
        const next = !org?.is_active;
        if (!next) {
          const ok = await askConfirm(`«${org?.name}» faolsizlantirilsa, uning barcha xodimlari tizimdan chiqariladi va kira olmaydi.`, {
            title: "Faolsizlantirish",
            ok: "Faolsizlantirish",
            danger: true,
          });
          if (!ok) return;
        }
        await api(`/orgs/${orgId}`, { method: "PUT", body: { is_active: next } });
        await loadOrgs(root);
        return;
      }
      if (t.dataset.ouPass) {
        const next = prompt("Yangi parol (kamida 6 belgi):");
        if (!next) return;
        await api(`/orgs/${orgId}/users/${t.dataset.ouPass}`, { method: "PUT", body: { password: next } });
        orgErr(root, "Parol yangilandi.", true);
        return;
      }
      if (t.dataset.ouToggle) {
        const active = t.dataset.active === "1";
        await api(`/orgs/${orgId}/users/${t.dataset.ouToggle}`, { method: "PUT", body: { is_active: !active } });
        await loadOrgUsers(root, orgId);
      }
    } catch (ex) {
      orgErr(root, ex.message);
    }
  });
}

function markPermDirty(card) {
  card.classList.add("dirty");
  const btn = card.querySelector("[data-perm-save]");
  if (btn) {
    btn.disabled = false;
    btn.textContent = "Saqlash";
  }
  permCount(card);
}

function bindBackup(root) {
  const err = $("#bk-err", root);
  const setErr = (text) => {
    if (!err) return;
    err.classList.toggle("hidden", !text);
    err.textContent = text || "";
  };
  const downBtn = $("#bk-download", root);
  const downMsg = $("#bk-down-msg", root);
  if (downBtn) {
    downBtn.onclick = async () => {
      setErr("");
      downBtn.disabled = true;
      downMsg.textContent = "Tayyorlanmoqda… baza katta bo‘lsa bir necha daqiqa olishi mumkin.";
      const d = new Date();
      const p = (v) => String(v).padStart(2, "0");
      const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
      try {
        await apiDownload("/admin/backup", `nexus-baza-${stamp}.zip`);
        downMsg.textContent = `Yuklab olindi: nexus-baza-${stamp}.zip`;
      } catch (ex) {
        downMsg.textContent = "";
        setErr(ex.message || "Yuklab bo‘lmadi");
      } finally {
        downBtn.disabled = false;
      }
    };
  }
  const file = $("#bk-file", root);
  const confirmEl = $("#bk-confirm", root);
  const upBtn = $("#bk-restore", root);
  const upMsg = $("#bk-up-msg", root);
  const sync = () => {
    if (upBtn) upBtn.disabled = !file?.files?.[0] || confirmEl?.value.trim().toUpperCase() !== "TIKLASH";
  };
  file?.addEventListener("change", sync);
  confirmEl?.addEventListener("input", sync);
  if (upBtn) {
    upBtn.onclick = async () => {
      const f = file?.files?.[0];
      if (!f) return;
      const ok = await askConfirm(
        `«${f.name}» faylidagi ma’lumot hozirgi bazaning o‘rniga yoziladi. Hozirgi barcha ma’lumot o‘chadi. Davom etasizmi?`,
        { title: "Bazani import qilish", ok: "Import qilish", danger: true }
      );
      if (!ok) return;
      setErr("");
      upBtn.disabled = true;
      upMsg.textContent = "Yuklanmoqda va tiklanmoqda… sahifani yopmang.";
      const fd = new FormData();
      fd.append("file", f);
      fd.append("confirm", confirmEl.value.trim());
      try {
        const res = await api("/admin/backup/restore", { method: "POST", body: fd });
        const total = Object.values(res.tables || {}).reduce((s, n) => s + n, 0);
        const lines = Object.entries(res.tables || {})
          .filter(([, n]) => n)
          .map(([t, n]) => `${t}: ${n}`);
        upMsg.textContent = `Baza tiklandi (${total} ta yozuv, nusxa sanasi: ${res.created_at || "—"}).\n${lines.join(", ")}\nBir necha soniyadan keyin qayta kirish oynasi ochiladi.`;
        file.value = "";
        confirmEl.value = "";
        setTimeout(() => api("/auth/me").catch(() => {}), 5000);
      } catch (ex) {
        upMsg.textContent = "";
        setErr(`${ex.message || "Import bo‘lmadi"}. Hozirgi baza o‘zgarmadi.`);
        sync();
      }
    };
  }
  bindSavedBackups(root, setErr);
  bindWipe(root, setErr);
}

function fmtSize(n) {
  const v = Number(n || 0);
  if (v >= 1024 * 1024 * 1024) return `${(v / 1024 / 1024 / 1024).toFixed(2)} GB`;
  if (v >= 1024 * 1024) return `${(v / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(v / 1024))} KB`;
}

function fmtStamp(iso) {
  const d = iso ? new Date(iso) : null;
  return d && !Number.isNaN(d.getTime())
    ? d.toLocaleString("uz-UZ", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" })
    : "—";
}

async function loadSavedBackups(root) {
  const box = $("#bk-saved", root);
  if (!box) return;
  const data = await api("/admin/backup/saved");
  const items = (data.items || []).filter((b) => b.complete);
  if (!items.length) {
    box.innerHTML = `<p class="muted adm-empty">Hozircha saqlangan nusxa yo‘q.</p>`;
    return;
  }
  const rows = items
    .map(
      (b) => `<tr>
        <td class="nowrap">${escapeHtml(fmtStamp(b.created_at))}</td>
        <td class="cell-wide">${escapeHtml(b.reason || "—")}<span class="cl-sub">${escapeHtml(b.created_by || "")}</span></td>
        <td class="nowrap">${fmtSize(b.size)}</td>
        <td class="nowrap">${Number(b.rows || 0).toLocaleString("uz-UZ")}</td>
        <td class="col-actions">
          <button class="btn tiny" type="button" data-bk-get="${b.id}">Yuklab olish</button>
          <button class="btn tiny" type="button" data-bk-back="${b.id}">Shu holatga qaytarish</button>
          <button class="btn tiny danger-text" type="button" data-bk-del="${b.id}">O‘chirish</button>
        </td>
      </tr>`
    )
    .join("");
  box.innerHTML =
    table(["Sana", "Sabab", "Hajmi", "Yozuvlar", ""], rows) +
    `<p class="muted bk-total">Jami: ${items.length} ta, ${fmtSize(data.total_size)} (server bazasida joy egallaydi — keraksizlarini o‘chiring)</p>`;
}

function bindSavedBackups(root, setErr) {
  const box = $("#bk-saved", root);
  const msg = $("#bk-saved-msg", root);
  if (!box) return;
  loadSavedBackups(root).catch((ex) => setErr(ex.message));
  const saveBtn = $("#bk-save-now", root);
  if (saveBtn) {
    saveBtn.onclick = async () => {
      setErr("");
      saveBtn.disabled = true;
      msg.textContent = "Nusxa olinmoqda… baza katta bo‘lsa bir necha daqiqa olishi mumkin.";
      try {
        const b = await api("/admin/backup/saved", { method: "POST" });
        msg.textContent = `Saqlandi: ${fmtStamp(b.created_at)}, ${fmtSize(b.size)}.`;
        await loadSavedBackups(root);
      } catch (ex) {
        msg.textContent = "";
        setErr(ex.message || "Nusxa saqlanmadi");
      } finally {
        saveBtn.disabled = false;
      }
    };
  }
  box.addEventListener("click", async (e) => {
    const btn = e.target.closest("button");
    if (!btn) return;
    const id = btn.dataset.bkGet || btn.dataset.bkBack || btn.dataset.bkDel;
    if (!id) return;
    setErr("");
    if (btn.dataset.bkGet) {
      btn.disabled = true;
      try {
        await apiDownload(`/admin/backup/saved/${id}/download`, `nexus-baza-${id}.zip`);
      } catch (ex) {
        setErr(ex.message || "Yuklab bo‘lmadi");
      } finally {
        btn.disabled = false;
      }
      return;
    }
    if (btn.dataset.bkDel) {
      const ok = await askConfirm("Bu nusxa serverdan butunlay o‘chiriladi. Kerak bo‘lsa avval yuklab oling.", {
        title: "Nusxani o‘chirish",
        ok: "O‘chirish",
        danger: true,
      });
      if (!ok) return;
      try {
        await api(`/admin/backup/saved/${id}`, { method: "DELETE" });
        await loadSavedBackups(root);
      } catch (ex) {
        setErr(ex.message);
      }
      return;
    }
    const ok = await askConfirm(
      "Hozirgi bazadagi barcha ma’lumot o‘chiriladi va shu nusxadagi holatga qaytariladi. Tiklangandan keyin hamma (haydovchilar ham) qayta kiradi. Davom etasizmi?",
      { title: "Bazani shu holatga qaytarish", ok: "Qaytarish", danger: true }
    );
    if (!ok) return;
    btn.disabled = true;
    msg.textContent = "Tiklanmoqda… sahifani yopmang.";
    const fd = new FormData();
    fd.append("confirm", "TIKLASH");
    try {
      const res = await api(`/admin/backup/saved/${id}/restore`, { method: "POST", body: fd });
      const total = Object.values(res.tables || {}).reduce((s, n) => s + n, 0);
      msg.textContent = `Baza tiklandi (${total} ta yozuv). Bir necha soniyadan keyin qayta kirish oynasi ochiladi.`;
      setTimeout(() => api("/auth/me").catch(() => {}), 5000);
    } catch (ex) {
      msg.textContent = "";
      setErr(`${ex.message || "Tiklanmadi"}. Hozirgi baza o‘zgarmadi.`);
      btn.disabled = false;
    }
  });
}

async function loadWipeScopes(root) {
  const list = $("#bk-wipe-list", root);
  if (!list) return;
  const data = await api("/admin/backup/wipe/scopes");
  list.innerHTML = (data.items || [])
    .map(
      (s) => `<label class="chk bk-wipe-item"><input type="checkbox" data-wipe="${escapeHtml(s.key)}" checked />
        <span>${escapeHtml(s.label)}</span><span class="adm-pill">${Number(s.count || 0).toLocaleString("uz-UZ")}</span></label>`
    )
    .join("");
}

function bindWipe(root, setErr) {
  const list = $("#bk-wipe-list", root);
  const all = $("#bk-wipe-all", root);
  const confirmEl = $("#bk-wipe-confirm", root);
  const btn = $("#bk-wipe", root);
  const msg = $("#bk-wipe-msg", root);
  if (!list || !btn) return;
  const picked = () => [...list.querySelectorAll("[data-wipe]:checked")].map((el) => el.dataset.wipe);
  const sync = () => {
    const boxes = [...list.querySelectorAll("[data-wipe]")];
    const n = picked().length;
    if (all) {
      all.checked = boxes.length > 0 && n === boxes.length;
      all.indeterminate = n > 0 && n < boxes.length;
    }
    btn.disabled = !n || confirmEl.value.trim().toUpperCase() !== "TOZALASH";
  };
  loadWipeScopes(root)
    .then(sync)
    .catch((ex) => setErr(ex.message));
  list.addEventListener("change", sync);
  all?.addEventListener("change", () => {
    list.querySelectorAll("[data-wipe]").forEach((el) => (el.checked = all.checked));
    sync();
  });
  confirmEl.addEventListener("input", sync);
  btn.onclick = async () => {
    const scopes = picked();
    if (!scopes.length) return;
    const names = [...list.querySelectorAll("[data-wipe]:checked")].map((el) => el.closest("label").querySelector("span").textContent);
    const ok = await askConfirm(
      `Quyidagilar butun tizimdan o‘chiriladi: ${names.join("; ")}. Oldin baza nusxasi serverda saqlanadi. Davom etasizmi?`,
      { title: "Umumiy tozalash", ok: "Tozalash", danger: true }
    );
    if (!ok) return;
    setErr("");
    btn.disabled = true;
    msg.textContent = "Avval baza nusxasi saqlanmoqda, keyin tozalanadi… sahifani yopmang.";
    try {
      const res = await api("/admin/backup/wipe", { method: "POST", body: { scopes, confirm: confirmEl.value.trim() } });
      const total = Object.values(res.deleted || {}).reduce((s, n) => s + n, 0);
      msg.innerHTML = `Tozalandi: ${total.toLocaleString("uz-UZ")} ta yozuv o‘chirildi. Nusxa saqlandi (${escapeHtml(fmtStamp(res.backup?.created_at))}, ${fmtSize(res.backup?.size)}).
        <div class="bk-wipe-after">
          <button class="btn tiny" type="button" data-bk-get-new="${res.backup?.id}">Nusxani yuklab olish</button>
          <button class="btn tiny primary" type="button" data-bk-reload>Sahifani yangilash</button>
        </div>`;
      confirmEl.value = "";
      await Promise.all([loadSavedBackups(root), loadWipeScopes(root)]);
      window.__nxWorkspace?.refreshWorkspace?.().catch(() => {});
    } catch (ex) {
      msg.textContent = "";
      setErr(ex.message || "Tozalanmadi");
    } finally {
      sync();
    }
  };
  msg.addEventListener("click", async (e) => {
    if (e.target.closest("[data-bk-reload]")) {
      location.reload();
      return;
    }
    const get = e.target.closest("[data-bk-get-new]");
    if (!get) return;
    get.disabled = true;
    try {
      await apiDownload(`/admin/backup/saved/${get.dataset.bkGetNew}/download`, `nexus-baza-${get.dataset.bkGetNew}.zip`);
    } catch (ex) {
      setErr(ex.message || "Yuklab bo‘lmadi");
    } finally {
      get.disabled = false;
    }
  });
}

export async function init(root) {
  paneRoot = root;
  showTab(root, localStorage.getItem(TAB_KEY) || "");
  root.querySelector("#admin-tabs")?.addEventListener("click", (e) => {
    const tab = e.target.closest("[data-admin-tab]");
    if (tab) showTab(root, tab.dataset.adminTab);
  });

  if (can("orgs.manage")) {
    bindOrgs(root);
    bindOffice(root);
  }
  if (can("users.manage")) bindUsers(root);
  if (can("clients.view")) bindClients(root);
  if (can("trash.view")) bindTrash(root);
  if (isSuper()) bindBackup(root);
  fillOrgSelects(root);
  await Promise.all([
    can("orgs.manage") ? loadOrgs(root).catch((ex) => orgErr(root, ex.message)) : null,
    can("users.manage") ? loadUsers(root).catch((ex) => usrErr(root, ex.message)) : null,
    can("clients.view") ? loadClients(root).catch((ex) => clErr(root, ex.message)) : null,
    can("perms.manage") ? loadPermsAdmin(root).catch(() => {}) : null,
    can("admin.panel")
      ? loadFields($("#tpl-entity", root)?.value || "orders").then(() => loadList(root)).catch(() => {})
      : null,
    can("drivers.view") || can("drivers.manage") ? loadDrivers(root).catch(() => {}) : null,
  ]);
  await loadTrash(root).catch((ex) => trErr(root, ex.message));
  bindPhoneInputs(root);

  $("#drv-search", root)?.addEventListener("input", () => renderDrivers(root));
  const drvForm = $("#admin-driver-form", root);
  $("#drv-add-toggle", root).onclick = () => {
    drvForm.classList.toggle("hidden");
    if (!drvForm.classList.contains("hidden")) drvForm.querySelector("[name=name]")?.focus();
  };
  $("#drv-add-cancel", root).onclick = () => {
    drvForm.reset();
    drvForm.classList.add("hidden");
  };

  const entitySel = $("#tpl-entity", root);
  if (entitySel) {
    entitySel.onchange = async () => {
      await loadFields(entitySel.value);
      renderMapGrid(root, collectMapping(root));
    };
  }

  const makeTpl = $("#make-driver-tpl", root);
  if (makeTpl) {
    makeTpl.onclick = async () => {
      $("#tpl-entity", root).value = "drivers";
      await loadFields("drivers");
      currentHeaders = fields.map((f) => f.label);
      $("#tpl-sheet", root).innerHTML = `<option value="Haydovchilar">Haydovchilar</option>`;
      fillForm(root, {
        name: "Haydovchilar Excel",
        description: "Haydovchilarni Excel orqali qo‘shish: Ism, Telefon, Davlat raqami.",
        sheet: "Haydovchilar",
        header_row: 1,
        mapping: Object.fromEntries(fields.map((f) => [f.key, f.label])),
      });
      try {
        await apiDownload("/templates/excel?entity=drivers", "Haydovchilar_shablon.xlsx");
        $("#sample-msg", root).textContent = "Excel yuklandi. Saqlash va tasdiqlash bosing.";
      } catch (ex) {
        $("#sample-msg", root).textContent = ex.message;
      }
    };
  }

  $("#drv-excel", root).onclick = async () => {
    try {
      const id = await driverTplId();
      if (id) await apiDownload(`/templates/${id}/excel`, "Haydovchilar_shablon.xlsx");
      else await apiDownload("/templates/excel?entity=drivers", "Haydovchilar_shablon.xlsx");
    } catch (ex) {
      $("#admin-drv-err", root).classList.remove("hidden");
      $("#admin-drv-err", root).textContent = ex.message;
    }
  };

  $("#drv-import-btn", root).onclick = () => {
    $("#drv-import-file", root).value = "";
    $("#drv-import-file", root).click();
  };
  $("#drv-import-file", root).onchange = async () => {
    const file = $("#drv-import-file", root).files[0];
    if (!file) return;
    const err = $("#admin-drv-err", root);
    err.classList.add("hidden");
    try {
      const data = await apiUpload("/drivers/import", file);
      err.classList.remove("hidden");
      err.style.color = "var(--ok)";
      const why = Array.isArray(data.reasons) && data.reasons.length ? ` (${data.reasons.join("; ")})` : "";
      err.textContent = `${data.created} ta haydovchi import qilindi${data.skipped ? `, ${data.skipped} o‘tkazib yuborildi` : ""}${why}.`;
      await loadDrivers(root);
    } catch (ex) {
      err.classList.remove("hidden");
      err.style.color = "";
      err.textContent = ex.message;
    } finally {
      $("#drv-import-file", root).value = "";
    }
  };

  drvForm.onsubmit = async (e) => {
    e.preventDefault();
    const err = $("#admin-drv-err", root);
    err.classList.add("hidden");
    const d = formData(e.target);
    d.agent_id = d.agent_id ? Number(d.agent_id) : null;
    try {
      const created = await api("/drivers", { method: "POST", body: d });
      e.target.reset();
      drvForm.classList.add("hidden");
      await loadDrivers(root);
      if (created.id && can("drivers.access")) openDriverAccess(created.id, created.password).catch(() => {});
    } catch (ex) {
      err.classList.remove("hidden");
      err.style.color = "";
      err.textContent = ex.message;
    }
  };

  $("#read-sample", root).onclick = async () => {
    const file = $("#sample-file", root).files[0];
    const msg = $("#sample-msg", root);
    if (!file) {
      msg.textContent = "Namuna Excel/CSV tanlang.";
      return;
    }
    msg.textContent = "O‘qilmoqda...";
    try {
      inspectData = await apiUpload("/templates/inspect", file);
      const sheets = inspectData.sheets || [];
      $("#tpl-sheet", root).innerHTML = sheets.map((s) => `<option value="${escapeHtml(s.name)}">${escapeHtml(s.name)}</option>`).join("");
      const first = sheets[0];
      currentHeaders = first?.headers || [];
      $("#tpl-form", root).classList.remove("hidden");
      if (!$("#tpl-name", root).value) $("#tpl-name", root).value = file.name.replace(/\.[^.]+$/, "");
      renderMapGrid(root, {});
      msg.textContent = `${currentHeaders.length} ta ustun topildi.`;
    } catch (err) {
      msg.textContent = err.message;
    }
  };

  $("#tpl-sheet", root).onchange = () => {
    const name = $("#tpl-sheet", root).value;
    const sheet = (inspectData?.sheets || []).find((s) => s.name === name);
    currentHeaders = sheet?.headers || currentHeaders;
    renderMapGrid(root, collectMapping(root));
  };

  $("#tpl-reset", root).onclick = () => {
    $("#tpl-id", root).value = "";
    $("#tpl-form", root).reset();
    $("#tpl-id", root).value = "";
    renderMapGrid(root, {});
  };

  $("#tpl-form", root).onsubmit = async (e) => {
    e.preventDefault();
    const payload = {
      name: $("#tpl-name", root).value,
      description: $("#tpl-desc", root).value,
      entity: $("#tpl-entity", root).value || "orders",
      sheet: $("#tpl-sheet", root).value || "Sheet1",
      header_row: Number($("#tpl-header-row", root).value || 1),
      mapping: collectMapping(root),
      status: "approved",
    };
    const id = $("#tpl-id", root).value;
    try {
      if (id) await api(`/templates/${id}`, { method: "PUT", body: payload });
      else await api("/templates", { method: "POST", body: payload });
    } catch (ex) {
      $("#sample-msg", root).textContent = ex.message || "Shablon saqlanmadi";
      return;
    }
    $("#sample-msg", root).textContent = "Shablon saqlandi.";
    $("#tpl-id", root).value = "";
    await loadList(root).catch(() => {});
  };

  root.addEventListener("change", async (e) => {
    const permBox = e.target.closest("[data-perm-key]");
    if (permBox) {
      markPermDirty(permBox.closest("[data-perm-user]"));
      return;
    }
    const selEl = e.target.closest("[data-agent-drv]");
    if (!selEl) return;
    const err = $("#admin-drv-err", root);
    selEl.disabled = true;
    try {
      const updated = await api(`/drivers/${selEl.dataset.agentDrv}/agent`, {
        method: "PUT",
        body: { agent_id: selEl.value ? Number(selEl.value) : null },
      });
      const row = driversCache.find((d) => String(d.id) === String(selEl.dataset.agentDrv));
      if (row) row.agent_id = updated.agent_id;
      renderDriverSummary(root);
      if (err) {
        err.classList.remove("hidden");
        err.style.color = "var(--ok)";
        err.textContent = `${updated.name}: ${updated.agent_code ? `${updated.agent_code} · ${updated.agent_name}` : "Agent yo‘q"}`;
      }
    } catch (ex) {
      if (err) {
        err.classList.remove("hidden");
        err.style.color = "";
        err.textContent = ex.message;
      }
      await loadDrivers(root);
    } finally {
      selEl.disabled = false;
    }
  });
  root.addEventListener("click", async (e) => {
    const allBtn = e.target.closest("[data-perm-all]");
    if (allBtn) {
      const group = allBtn.closest("[data-perm-group]");
      const boxes = [...group.querySelectorAll("[data-perm-key]")];
      const next = boxes.some((b) => !b.checked);
      boxes.forEach((b) => (b.checked = next));
      markPermDirty(group.closest("[data-perm-user]"));
      return;
    }
    const permSave = e.target.closest("[data-perm-save]")?.dataset.permSave;
    if (permSave) {
      const card = e.target.closest("[data-perm-user]");
      const keys = [...(card?.querySelectorAll("[data-perm-key]:checked") || [])].map((b) => b.dataset.permKey);
      const err = $("#perm-err", root);
      err?.classList.add("hidden");
      try {
        await api(`/users/${permSave}/permissions`, { method: "PUT", body: { permissions: keys } });
        await loadPermsAdmin(root);
        const btn = root.querySelector(`[data-perm-save="${permSave}"]`);
        if (btn) btn.textContent = "Saqlandi ✓";
      } catch (ex) {
        if (err) {
          err.classList.remove("hidden");
          err.textContent = ex.message;
        }
      }
      return;
    }
    const drvAccess = e.target.dataset?.drvAccess;
    if (drvAccess) {
      try {
        await openDriverAccess(drvAccess);
      } catch (ex) {
        const err = $("#admin-drv-err", root);
        if (err) {
          err.classList.remove("hidden");
          err.textContent = ex.message;
        }
      }
      return;
    }
    const drvDel = e.target.dataset?.drvDel;
    if (drvDel) {
      if (!(await askConfirm("Haydovchini o‘chirasizmi?", { title: "O‘chirish", ok: "O‘chirish", danger: true }))) return;
      try {
        await api(`/drivers/${drvDel}`, { method: "DELETE" });
      } catch (ex) {
        const err = $("#admin-drv-err", root);
        if (err) {
          err.classList.remove("hidden");
          err.style.color = "";
          err.textContent = ex.message;
        }
        return;
      }
      await loadDrivers(root).catch(() => {});
      loadTrash(root).catch(() => {});
      return;
    }
    const excelId = e.target.dataset?.excel;
    if (excelId) {
      try {
        await apiDownload(`/templates/${excelId}/excel`, "shablon.xlsx");
      } catch (ex) {
        $("#sample-msg", root).textContent = ex.message;
      }
      return;
    }
    const editId = e.target.dataset?.edit;
    const approveId = e.target.dataset?.approve;
    const rejectId = e.target.dataset?.reject;
    if (editId || approveId || rejectId) {
      try {
        await templateAction(root, editId, approveId, rejectId);
      } catch (ex) {
        $("#sample-msg", root).textContent = ex.message;
      }
    }
  });
}

async function templateAction(root, editId, approveId, rejectId) {
  if (editId) {
    const tpls = await api("/templates");
    const tpl = tpls.find((t) => String(t.id) === String(editId));
    if (!tpl) return;
    $("#tpl-entity", root).value = tpl.entity || "orders";
    await loadFields(tpl.entity || "orders");
    currentHeaders = Object.values(tpl.mapping || {});
    const unique = [...new Set(currentHeaders.filter(Boolean))];
    if (inspectData?.sheets) {
      const sheet = inspectData.sheets.find((s) => s.name === tpl.sheet) || inspectData.sheets[0];
      currentHeaders = sheet?.headers || unique;
      $("#tpl-sheet", root).innerHTML = inspectData.sheets
        .map((s) => `<option value="${escapeHtml(s.name)}">${escapeHtml(s.name)}</option>`)
        .join("");
    } else {
      currentHeaders = unique;
      $("#tpl-sheet", root).innerHTML = `<option value="${escapeHtml(tpl.sheet || "Sheet1")}">${escapeHtml(tpl.sheet || "Sheet1")}</option>`;
    }
    fillForm(root, tpl);
    $("#tpl-form", root).scrollIntoView({ behavior: "smooth", block: "start" });
  }
  if (approveId) {
    await api(`/templates/${approveId}/approve`, { method: "POST", body: { note: "Tasdiqlandi" } });
    await loadList(root);
  }
  if (rejectId) {
    await api(`/templates/${rejectId}/reject`, { method: "POST", body: { note: "Rad etildi" } });
    await loadList(root);
  }
}

export async function show() {
  const root = paneRoot;
  if (!root) return;
  await Promise.all([
    can("orgs.manage") ? loadOrgs(root).catch(() => {}) : null,
    can("users.manage") ? loadUsers(root).catch(() => {}) : null,
    can("clients.view") ? loadClients(root).catch(() => {}) : null,
    can("drivers.view") || can("drivers.manage") ? loadDrivers(root).catch(() => {}) : null,
  ]);
  await loadTrash(root).catch(() => {});
}

export function destroy() {
  createPicker?.destroy();
  editPicker?.destroy();
  createPicker = null;
  editPicker = null;
  paneRoot = null;
}
