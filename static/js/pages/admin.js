import { api, apiDownload, apiUpload, can } from "../api.js";
import { openDriverAccess } from "../driver-access.js?v=63";
import { $, escapeHtml, formData, table, askConfirm, bindPhoneInputs, driverStatusHtml } from "../ui.js?v=63";

const TAB_KEY = "nx_admin_tab";
const TPL_STATUS = { approved: "Tasdiqlangan", pending: "Kutilmoqda", rejected: "Rad etilgan" };
const ENTITY = { orders: "Buyurtmalar", drivers: "Haydovchilar" };
const ROLE = { admin: "Administrator", dispatcher: "Dispetcher" };
const ADMIN_ONLY = new Set(["users.manage", "perms.manage"]);

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
  return btn.dataset.perm.split(",").some((k) => can(k.trim()));
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
          <td><select class="agent-pick" data-agent-drv="${d.id}">${agentOptions(agentsCache, d.agent_id)}</select></td>
          <td class="col-actions">
            <button class="btn tiny" data-drv-access="${d.id}">Kirish</button>
            <button class="btn tiny danger-text" data-drv-del="${d.id}">O‘chirish</button>
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
  if (sel) sel.innerHTML = agentOptions(agents, "");
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
  setCount(root, "cnt-perms", users.length);
  const groups = {};
  (catalog.permissions || []).forEach((p) => {
    if (!groups[p.group]) groups[p.group] = [];
    groups[p.group].push(p);
  });
  box.innerHTML = users
    .map((u) => {
      const keys = new Set(u.permissions || []);
      const locked = u.role === "admin";
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
        return `<div class="adm-card perm-card" data-perm-user="${u.id}">${head}
          <p class="perm-locked">Administrator barcha bo‘lim va amallarga to‘liq ruxsatga ega, uni cheklab bo‘lmaydi.</p>
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

function markPermDirty(card) {
  card.classList.add("dirty");
  const btn = card.querySelector("[data-perm-save]");
  if (btn) {
    btn.disabled = false;
    btn.textContent = "Saqlash";
  }
  permCount(card);
}

export async function init(root) {
  showTab(root, localStorage.getItem(TAB_KEY) || "");
  root.querySelector("#admin-tabs")?.addEventListener("click", (e) => {
    const tab = e.target.closest("[data-admin-tab]");
    if (tab) showTab(root, tab.dataset.adminTab);
  });

  await Promise.all([
    can("perms.manage") ? loadPermsAdmin(root).catch(() => {}) : null,
    can("admin.panel")
      ? loadFields($("#tpl-entity", root)?.value || "orders").then(() => loadList(root)).catch(() => {})
      : null,
    can("drivers.view") || can("drivers.manage") ? loadDrivers(root).catch(() => {}) : null,
  ]);
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
    const id = await driverTplId();
    try {
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
      if (created.id) openDriverAccess(created.id, created.password).catch(() => {});
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
    if (id) await api(`/templates/${id}`, { method: "PUT", body: payload });
    else await api("/templates", { method: "POST", body: payload });
    $("#sample-msg", root).textContent = "Shablon saqlandi.";
    $("#tpl-id", root).value = "";
    await loadList(root);
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
      await api(`/drivers/${drvDel}`, { method: "DELETE" });
      await loadDrivers(root);
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
  });
}

export function destroy() {}
