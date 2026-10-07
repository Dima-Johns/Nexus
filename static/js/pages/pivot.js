import { api, token } from "../api.js";
import { $, askConfirm, escapeHtml } from "../ui.js?v=74";

const LIMITS = { rows: 8, cols: 2, filters: 20, values: 12 };
const ZONE_NAMES = { rows: "Qatorlar", cols: "Ustunlar", filters: "Filtrlar", values: "Qiymatlar" };
const DIM_ZONES = ["rows", "cols", "filters"];
const fmtInt = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 });
const fmtFloat = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 1 });

const TEMPLATES = [
  {
    name: "Yetkazilganlar: tashkilot → agent → haydovchi → izoh",
    rows: ["org", "agent", "driver", "proof", "comment"],
    filters: ["status"],
    values: ["count", "amount"],
    vf: { status: ["Yetkazildi"] },
    subtotals: true,
  },
  {
    name: "Qaytarishlar: sabab (izoh) → klient",
    rows: ["comment", "client"],
    filters: ["status"],
    values: ["count", "amount"],
    vf: { status: ["Qaytarildi"] },
    subtotals: true,
    sort_by: "count",
  },
  { name: "Haydovchilar × holat", rows: ["driver"], cols: ["status"], values: ["count", "amount"], sort_by: "amount" },
  { name: "Agentlar savdosi (kunlar bo‘yicha)", rows: ["agent"], cols: ["day"], values: ["amount"], sort_by: "amount" },
  { name: "Klientlar savdosi", rows: ["client"], values: ["count", "amount", "delivered", "returned", "return_rate"], sort_by: "amount" },
  { name: "Agent → klient (qaytarish %)", rows: ["agent", "client"], values: ["count", "delivered", "returned", "return_rate", "amount_returned"], subtotals: true },
  { name: "Hafta kunlari bo‘yicha", rows: ["weekday"], values: ["count", "amount", "avg_check", "drivers"] },
];

let ctx = null;
let root = null;
let fields = null;
let layouts = [];
let current = "";
let state = blankState();
let result = null;
let runSeq = 0;
let runTimer = null;
let dragging = null;
let picker = null;
let ready = false;
let drawer = null;
let modalEl = null;
const byId = (id) => document.getElementById(id);

function err(text) {
  ctx?.errMsg(text);
  const el = byId("pv-drawer-err");
  if (!el) return;
  el.textContent = text || "";
  el.classList.toggle("hidden", !text);
}

function blankState() {
  return { rows: [], cols: [], filters: [], values: ["count"], vf: {}, subtotals: false, sort_by: "", sort_dir: "desc" };
}

const dimByKey = (k) => fields?.dimensions.find((d) => d.key === k);
const measureByKey = (k) => fields?.measures.find((m) => m.key === k);
const labelOf = (k, kind) => (kind === "measure" ? measureByKey(k)?.label : dimByKey(k)?.label) || k;
const zoneOf = (k) => DIM_ZONES.find((z) => state[z].includes(k)) || "";
const usedDims = () => [...state.rows, ...state.cols, ...state.filters];

function fmt(v, kind) {
  if (v == null || v === "") return "";
  if (kind === "pct") return `${fmtFloat.format(v)}%`;
  if (kind === "float") return fmtFloat.format(v);
  return fmtInt.format(Math.round(Number(v) || 0));
}

function cleanState(raw) {
  const s = blankState();
  if (!raw || typeof raw !== "object") return s;
  const dims = new Set((fields?.dimensions || []).map((d) => d.key));
  const measures = new Set((fields?.measures || []).map((m) => m.key));
  const seen = new Set();
  for (const z of DIM_ZONES) {
    s[z] = (Array.isArray(raw[z]) ? raw[z] : []).filter((k) => dims.has(k) && !seen.has(k) && seen.add(k)).slice(0, LIMITS[z]);
  }
  const vals = (Array.isArray(raw.values) ? raw.values : []).filter((k) => measures.has(k));
  s.values = [...new Set(vals)].slice(0, LIMITS.values);
  if (!s.values.length) s.values = ["count"];
  if (raw.vf && typeof raw.vf === "object") {
    for (const [k, v] of Object.entries(raw.vf)) if (seen.has(k) && Array.isArray(v) && v.length) s.vf[k] = v.map(String).slice(0, 1000);
  }
  s.subtotals = Boolean(raw.subtotals);
  s.sort_by = measures.has(raw.sort_by) ? raw.sort_by : "";
  s.sort_dir = raw.sort_dir === "asc" ? "asc" : "desc";
  return s;
}

function body(extra = {}) {
  const vf = {};
  for (const k of usedDims()) if (state.vf[k]?.length) vf[k] = state.vf[k];
  return {
    filters: ctx.filters(),
    rows: state.rows,
    cols: state.cols,
    values: state.values,
    value_filters: vf,
    subtotals: state.subtotals,
    sort_by: state.sort_by,
    sort_dir: state.sort_dir,
    ...extra,
  };
}

// ---------- maydonlar va zonalar ----------

function renderFields() {
  const box = byId("pv-field-list");
  if (!box || !fields) return;
  const q = (byId("pv-field-q")?.value || "").trim().toLowerCase();
  const used = new Set(usedDims());
  const match = (label) => !q || label.toLowerCase().includes(q);
  const groups = new Map();
  for (const d of fields.dimensions) {
    if (!match(d.label)) continue;
    if (!groups.has(d.group)) groups.set(d.group, []);
    groups.get(d.group).push(d);
  }
  let html = "";
  for (const [group, items] of groups) {
    html += `<div class="pv-group"><span>${escapeHtml(group)}</span>${items
      .map(
        (d) =>
          `<button type="button" class="pv-chip dim ${used.has(d.key) ? "used" : ""}" draggable="true" data-pv-field="${d.key}" data-pv-kind="dim" title="${used.has(d.key) ? `${ZONE_NAMES[zoneOf(d.key)]} zonasida` : "Qatorlarga qo‘shish"}">${escapeHtml(d.label)}</button>`
      )
      .join("")}</div>`;
  }
  const measures = fields.measures.filter((m) => match(m.label));
  if (measures.length) {
    html += `<div class="pv-group"><span>Σ Ko‘rsatkichlar</span>${measures
      .map(
        (m) =>
          `<button type="button" class="pv-chip measure ${state.values.includes(m.key) ? "used" : ""}" draggable="true" data-pv-field="${m.key}" data-pv-kind="measure" title="Qiymatlarga qo‘shish">Σ ${escapeHtml(m.label)}</button>`
      )
      .join("")}</div>`;
  }
  box.innerHTML = html || `<p class="muted">Topilmadi</p>`;
}

function zoneChip(key, zone, i) {
  const kind = zone === "values" ? "measure" : "dim";
  const sel = state.vf[key]?.length;
  const filterBtn =
    kind === "dim"
      ? `<button type="button" class="pv-ic ${sel ? "on" : ""}" data-pv-act="filter" title="Qiymatlarni tanlash">⏷${sel ? ` ${sel}` : ""}</button>`
      : "";
  const moveBtn =
    kind === "dim"
      ? `<button type="button" class="pv-ic" data-pv-act="move" title="Boshqa zonaga o‘tkazish (Qatorlar → Ustunlar → Filtrlar)">⇄</button>`
      : "";
  return `<span class="pv-chip ${kind} in-zone ${sel ? "filtered" : ""}" draggable="true" data-pv-field="${key}" data-pv-kind="${kind}" data-pv-zone="${zone}" data-pv-i="${i}">
    <span class="pv-chip-label">${kind === "measure" ? "Σ " : ""}${escapeHtml(labelOf(key, kind))}</span>${filterBtn}
    <button type="button" class="pv-ic" data-pv-act="left" title="Oldinga">‹</button><button type="button" class="pv-ic" data-pv-act="right" title="Orqaga">›</button>${moveBtn}
    <button type="button" class="pv-ic" data-pv-act="remove" title="Olib tashlash">×</button>
  </span>`;
}

function renderZones() {
  drawer.querySelectorAll(".pv-drop").forEach((drop) => {
    const zone = drop.dataset.zone;
    const items = state[zone];
    drop.innerHTML = items.length
      ? items.map((k, i) => zoneChip(k, zone, i)).join("")
      : `<span class="pv-empty">${zone === "values" ? "Σ ko‘rsatkichni shu yerga torting" : "Maydonni shu yerga torting"}</span>`;
  });
  const sub = byId("pv-subtotals");
  if (sub) {
    sub.checked = state.subtotals;
    sub.disabled = state.rows.length < 2;
  }
}

function renderAll() {
  renderFields();
  renderZones();
  renderLayoutBar();
  renderSummary();
}

function place(key, kind, zone, index = -1) {
  if (kind === "measure") {
    if (zone !== "values") return false;
    const from = state.values.indexOf(key);
    if (from >= 0) {
      state.values.splice(from, 1);
      if (index > from) index -= 1;
    } else if (state.values.length >= LIMITS.values) {
      err(`Qiymatlar: ko‘pi bilan ${LIMITS.values} ta`);
      return false;
    }
    const at = index < 0 || index > state.values.length ? state.values.length : index;
    state.values.splice(at, 0, key);
    return true;
  }
  if (!DIM_ZONES.includes(zone)) return false;
  const fromZone = zoneOf(key);
  if (fromZone !== zone && state[zone].length >= LIMITS[zone]) {
    err(`${ZONE_NAMES[zone]}: ko‘pi bilan ${LIMITS[zone]} ta maydon`);
    return false;
  }
  if (fromZone) {
    const from = state[fromZone].indexOf(key);
    state[fromZone].splice(from, 1);
    if (fromZone === zone && index > from) index -= 1;
  }
  const at = index < 0 || index > state[zone].length ? state[zone].length : index;
  state[zone].splice(at, 0, key);
  return true;
}

function removeField(key, zone) {
  if (zone === "values") {
    state.values = state.values.filter((k) => k !== key);
    if (!state.values.length) state.values = ["count"];
    if (state.sort_by === key) state.sort_by = "";
  } else {
    state[zone] = state[zone].filter((k) => k !== key);
    delete state.vf[key];
  }
}

function changed({ run = true } = {}) {
  err("");
  if (state.rows.length < 2) state.subtotals = false;
  renderAll();
  if (run) scheduleRun();
}

// ---------- natija ----------

function scheduleRun(delay = 250) {
  clearTimeout(runTimer);
  runTimer = setTimeout(() => run(), delay);
}

export async function run() {
  if (!root || !fields) return;
  clearTimeout(runTimer);
  const seq = ++runSeq;
  root.classList.add("pv-busy");
  try {
    const res = await api("/reports/pivot", { method: "POST", body: body() });
    if (seq !== runSeq) return;
    result = res;
    ctx.onPayments?.(res.payment_options);
    renderResult();
    err("");
  } catch (ex) {
    if (seq === runSeq) err(ex.message || "Pivot hisoblanmadi");
  } finally {
    if (seq === runSeq) root?.classList.remove("pv-busy");
  }
}

function sortMark(key) {
  return state.sort_by === key ? ` sorted ${state.sort_dir}` : "";
}

function renderResult() {
  const box = byId("pv-result");
  const info = byId("pv-info");
  if (!box || !result) return;
  const dims = result.row_fields;
  const vals = result.values;
  const cols = result.col_keys;
  const nd = Math.max(1, dims.length);
  const nv = vals.length;
  const parts = [`${fmtInt.format(result.orders_used)} ta zayavka`];
  if (result.orders_used !== result.orders_total) parts.push(`filtrgacha ${fmtInt.format(result.orders_total)}`);
  parts.push(`${fmtInt.format(result.row_count)} qator`);
  if (result.truncated) parts.push("ekranda birinchi 3000 qator, Excel’da hammasi");
  if (result.cols_merged) parts.push("ustunlar ko‘p: kamroq uchraydiganlari «Boshqalar»ga jamlandi");
  if (info) info.textContent = parts.join(" · ");
  if (!result.orders_used) {
    box.innerHTML = `<div class="rep-empty">Tanlangan filtrlar bo‘yicha zayavka yo‘q</div>`;
    return;
  }

  const dimHead = (rowspan) =>
    (dims.length ? dims : [{ key: "", label: "Jami" }])
      .map((d) => `<th class="pv-dim-h" ${rowspan > 1 ? `rowspan="${rowspan}"` : ""} ${d.key ? `data-pv-sort-dim="1"` : ""} title="Nomi bo‘yicha saralash">${escapeHtml(d.label)}</th>`)
      .join("");
  const measureHead = (sortable) =>
    vals
      .map((v) =>
        sortable
          ? `<th class="num sortable${sortMark(v.key)}" data-pv-sort="${v.key}" title="Shu ko‘rsatkich bo‘yicha saralash">${escapeHtml(v.label)}</th>`
          : `<th class="num">${escapeHtml(v.label)}</th>`
      )
      .join("");
  let head = "";
  if (cols.length) {
    const groupTitle = (k) => escapeHtml(k.filter(Boolean).join(" · "));
    if (nv === 1) {
      head = `<tr>${dimHead(1)}${cols.map((k) => `<th class="num pv-col-h">${groupTitle(k)}</th>`).join("")}<th class="num pv-total-h sortable${sortMark(vals[0].key)}" data-pv-sort="${vals[0].key}">Jami: ${escapeHtml(vals[0].label)}</th></tr>`;
    } else {
      head = `<tr>${dimHead(2)}${cols.map((k) => `<th class="pv-col-h" colspan="${nv}">${groupTitle(k)}</th>`).join("")}<th class="pv-total-h" colspan="${nv}">Jami</th></tr>`;
      head += `<tr>${cols.map(() => measureHead(false)).join("")}${measureHead(true)}</tr>`;
    }
  } else {
    head = `<tr>${dimHead(1)}${measureHead(true)}</tr>`;
  }

  const numCells = (row, cls = "") => {
    let out = "";
    for (const chunk of row.cells || []) chunk.forEach((v, i) => (out += `<td class="num ${cls}">${fmt(v, vals[i].kind)}</td>`));
    row.total.forEach((v, i) => (out += `<td class="num pv-total ${cls}">${fmt(v, vals[i].kind)}</td>`));
    return out;
  };
  let prev = [];
  const bodyRows = result.rows
    .map((row) => {
      if (row.type === "subtotal") {
        const lvl = row.level || 0;
        prev = prev.slice(0, lvl);
        const pad = lvl ? `<td colspan="${lvl}"></td>` : "";
        return `<tr class="pv-sub lvl-${Math.min(lvl, 3)}">${pad}<td colspan="${nd - lvl}">${escapeHtml(row.keys[row.keys.length - 1])} — jami</td>${numCells(row)}</tr>`;
      }
      const keys = row.keys.length ? row.keys : ["Jami"];
      let differs = false;
      const cells = keys
        .map((k, i) => {
          differs = differs || prev[i] !== k || i === keys.length - 1;
          return `<td class="pv-key">${differs ? `<div>${escapeHtml(k)}</div>` : ""}</td>`;
        })
        .join("");
      prev = keys;
      return `<tr>${cells}${numCells(row)}</tr>`;
    })
    .join("");
  const total = dims.length ? `<tfoot><tr class="pv-grand"><td colspan="${nd}">Umumiy jami</td>${numCells(result.total)}</tr></tfoot>` : "";
  box.innerHTML = `<div class="table-wrap pv-table"><table><thead>${head}</thead><tbody>${bodyRows}</tbody>${total}</table></div>`;
}

// ---------- qiymat filtri oynasi ----------

async function openPicker(key) {
  const modal = byId("pv-values-modal");
  if (!modal) return;
  picker = { key, values: [], selected: new Set(state.vf[key] || []), all: !(state.vf[key] || []).length };
  byId("pv-values-title").textContent = `${labelOf(key, "dim")}: qiymatlarni tanlash`;
  byId("pv-values-q").value = "";
  byId("pv-values-list").innerHTML = `<p class="muted">Yuklanmoqda…</p>`;
  byId("pv-values-info").textContent = "";
  pickerErr("");
  modal.classList.remove("hidden");
  try {
    const vf = {};
    for (const k of usedDims()) if (state.vf[k]?.length) vf[k] = state.vf[k];
    const res = await api("/reports/pivot/values", { method: "POST", body: { filters: ctx.filters(), field: key, value_filters: vf } });
    if (!picker || picker.key !== key) return;
    picker.values = res.values;
    if (picker.all) picker.selected = new Set(res.values.map((v) => v.value));
    renderPicker();
  } catch (ex) {
    pickerErr(ex.message || "Qiymatlar yuklanmadi");
  }
}

function pickerErr(text) {
  const el = byId("pv-values-err");
  if (!el) return;
  el.textContent = text || "";
  el.classList.toggle("hidden", !text);
}

function pickerVisible() {
  const q = (byId("pv-values-q")?.value || "").trim().toLowerCase();
  return q ? picker.values.filter((v) => v.value.toLowerCase().includes(q)) : picker.values;
}

function renderPicker() {
  if (!picker) return;
  const list = pickerVisible();
  byId("pv-values-list").innerHTML = list.length
    ? list
        .map(
          (v) =>
            `<label class="pv-val"><input type="checkbox" data-pv-val="${escapeHtml(v.value)}" ${picker.selected.has(v.value) ? "checked" : ""} /><span>${escapeHtml(v.value)}</span><em>${fmtInt.format(v.count)}</em></label>`
        )
        .join("")
    : `<p class="muted">Qiymat topilmadi</p>`;
  byId("pv-values-info").textContent = `Tanlangan: ${picker.selected.size} / ${picker.values.length}`;
}

function closePicker() {
  picker = null;
  byId("pv-values-modal")?.classList.add("hidden");
}

function applyPicker() {
  if (!picker) return;
  const chosen = picker.values.map((v) => v.value).filter((v) => picker.selected.has(v));
  if (!chosen.length) return pickerErr("Kamida bitta qiymat tanlang");
  if (chosen.length > 1000) return pickerErr("1000 tadan ko‘p qiymat tanlab bo‘lmaydi — «Hammasi» qoldiring yoki kamroq tanlang");
  if (chosen.length === picker.values.length) delete state.vf[picker.key];
  else state.vf[picker.key] = chosen;
  closePicker();
  changed();
}

// ---------- shablonlar ----------

function selectedLayout() {
  if (!current.startsWith("id:")) return null;
  return layouts.find((l) => `id:${l.id}` === current) || null;
}

function renderLayoutBar() {
  const sel = byId("pv-layout");
  if (!sel) return;
  const opt = (value, label) => `<option value="${escapeHtml(value)}">${escapeHtml(label)}</option>`;
  const mine = layouts.filter((l) => l.mine);
  const shared = layouts.filter((l) => !l.mine);
  sel.innerHTML =
    opt("", "— Yangi hisobot —") +
    `<optgroup label="Namunalar">${TEMPLATES.map((t, i) => opt(`tpl:${i}`, t.name)).join("")}</optgroup>` +
    (mine.length ? `<optgroup label="Mening hisobotlarim">${mine.map((l) => opt(`id:${l.id}`, `${l.name}${l.shared ? " (ulashilgan)" : ""}`)).join("")}</optgroup>` : "") +
    (shared.length ? `<optgroup label="Hamkasblar ulashganlari">${shared.map((l) => opt(`id:${l.id}`, `${l.name} — ${l.user_name}`)).join("")}</optgroup>` : "");
  sel.value = current;
  if (sel.value !== current) {
    current = "";
    sel.value = "";
  }
  const lay = selectedLayout();
  const del = byId("pv-delete");
  if (del) del.classList.toggle("hidden", !lay?.can_edit);
  const save = byId("pv-save");
  if (save) save.textContent = lay?.can_edit ? "Saqlash" : "Saqlash (yangi)";
  byId("pv-save-new")?.classList.toggle("hidden", !lay);
  const excel = byId("pv-excel");
  if (excel) excel.classList.toggle("hidden", !ctx.canExport());
}

async function loadLayouts() {
  layouts = await api("/reports/layouts");
}

function openLayout(value) {
  current = value;
  if (value.startsWith("tpl:")) {
    const tpl = TEMPLATES[Number(value.slice(4))];
    state = cleanState(tpl);
    byId("pv-name").value = tpl.name;
    byId("pv-shared").checked = false;
    changed();
    return;
  }
  const lay = selectedLayout();
  if (!lay) {
    state = blankState();
    byId("pv-name").value = "";
    byId("pv-shared").checked = false;
    changed();
    toggleDrawer(true);
    return;
  }
  state = cleanState(lay.config?.pivot);
  byId("pv-name").value = lay.name;
  byId("pv-shared").checked = Boolean(lay.shared);
  changed({ run: false });
  if (lay.config?.global) ctx.applyFilters(lay.config.global);
  else run();
}

async function saveLayout(asNew) {
  const nameEl = byId("pv-name");
  const name = (nameEl?.value || "").trim();
  if (!name) {
    err("Hisobotga nom bering");
    nameEl?.focus();
    return;
  }
  const lay = selectedLayout();
  const payload = {
    name,
    shared: Boolean(byId("pv-shared")?.checked),
    config: { v: 1, pivot: { ...state }, global: ctx.globalState() },
  };
  try {
    const saved =
      lay?.can_edit && !asNew
        ? await api(`/reports/layouts/${lay.id}`, { method: "PUT", body: payload })
        : await api("/reports/layouts", { method: "POST", body: payload });
    await loadLayouts();
    current = `id:${saved.id}`;
    renderLayoutBar();
    flash(`«${saved.name}» saqlandi`);
  } catch (ex) {
    err(ex.message || "Saqlab bo‘lmadi");
  }
}

async function deleteLayout() {
  const lay = selectedLayout();
  if (!lay) return;
  const ok = await askConfirm(`«${lay.name}» hisobot shabloni o‘chirilsinmi? Ma’lumotlar o‘chmaydi, faqat tuzilma.`, { title: "Shablonni o‘chirish", ok: "O‘chirish", danger: true });
  if (!ok) return;
  try {
    await api(`/reports/layouts/${lay.id}`, { method: "DELETE" });
    await loadLayouts();
    current = "";
    renderLayoutBar();
    flash("Shablon o‘chirildi");
  } catch (ex) {
    err(ex.message || "O‘chirib bo‘lmadi");
  }
}

function flash(text) {
  const info = byId("pv-info");
  if (!info) return;
  const prev = info.textContent;
  info.textContent = `✓ ${text}`;
  info.classList.add("pv-flash");
  setTimeout(() => {
    if (!root) return;
    info.classList.remove("pv-flash");
    if (info.textContent === `✓ ${text}`) info.textContent = prev;
  }, 2500);
}

// ---------- Excel ----------

async function exportExcel(btn) {
  const title = (byId("pv-name")?.value || "").trim() || "Pivot hisobot";
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Tayyorlanmoqda…";
  try {
    const res = await fetch("/api/reports/pivot/export", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body({ title })),
    });
    if (!res.ok) {
      const d = (await res.json().catch(() => ({}))).detail;
      throw new Error(typeof d === "string" ? d : Array.isArray(d) ? d.map((x) => x.msg || x).join("; ") : "Yuklab bo‘lmadi");
    }
    const blob = await res.blob();
    const f = ctx.filters();
    const period = [f.date_from, f.date_to].filter(Boolean).join("_") || "barcha_davr";
    const safe = title.replace(/[^\p{L}\p{N}_-]+/gu, "_").replace(/^_+|_+$/g, "").slice(0, 60) || "Pivot";
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${safe}_${period}.xlsx`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch (ex) {
    err(ex.message || "Yuklab bo‘lmadi");
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

// ---------- hodisalar ----------

function dropIndex(drop, e) {
  const chips = [...drop.querySelectorAll(".pv-chip")];
  for (let i = 0; i < chips.length; i += 1) {
    const r = chips[i].getBoundingClientRect();
    if (e.clientY < r.top) return i;
    if (e.clientY <= r.bottom && e.clientX < r.left + r.width / 2) return i;
  }
  return chips.length;
}

// ---------- sozlash paneli ----------

function renderSummary() {
  const box = byId("pv-summary");
  if (!box || !fields) return;
  const names = (keys) => keys.map((k) => labelOf(k, "dim")).join(", ");
  const parts = [];
  if (state.rows.length) parts.push(`Qatorlar: ${names(state.rows)}`);
  if (state.cols.length) parts.push(`Ustunlar: ${names(state.cols)}`);
  parts.push(`Σ ${state.values.map((k) => labelOf(k, "measure")).join(", ")}`);
  const filtered = usedDims().filter((k) => state.vf[k]?.length);
  if (filtered.length) parts.push(`Filtr: ${filtered.map((k) => `${labelOf(k, "dim")} (${state.vf[k].length})`).join(", ")}`);
  box.textContent = parts.join(" · ");
  box.title = box.textContent;
}

function toggleDrawer(open) {
  if (!drawer) return;
  const show = open ?? drawer.classList.contains("hidden");
  drawer.classList.toggle("hidden", !show);
  byId("pv-config-open")?.classList.toggle("on", show);
  document.body.classList.toggle("pv-drawer-open", show);
  if (!show) err("");
}

function onClick(e) {
  const act = e.target.closest("[data-pv-act]");
  if (act) {
    const chip = act.closest(".pv-chip");
    const key = chip.dataset.pvField;
    const zone = chip.dataset.pvZone;
    const i = Number(chip.dataset.pvI);
    const a = act.dataset.pvAct;
    if (a === "remove") removeField(key, zone);
    else if (a === "filter") return openPicker(key);
    else if (a === "left" && i > 0) [state[zone][i - 1], state[zone][i]] = [state[zone][i], state[zone][i - 1]];
    else if (a === "right" && i < state[zone].length - 1) [state[zone][i + 1], state[zone][i]] = [state[zone][i], state[zone][i + 1]];
    else if (a === "move") {
      const order = ["rows", "cols", "filters"];
      let next = order[(order.indexOf(zone) + 1) % 3];
      if (state[next].length >= LIMITS[next]) next = order[(order.indexOf(next) + 1) % 3];
      if (!place(key, "dim", next)) return;
    } else return;
    changed();
    return;
  }
  const chip = e.target.closest(".pv-fields .pv-chip");
  if (chip) {
    const key = chip.dataset.pvField;
    if (chip.dataset.pvKind === "measure") {
      if (state.values.includes(key)) removeField(key, "values");
      else if (!place(key, "measure", "values")) return;
    } else {
      const z = zoneOf(key);
      if (z) removeField(key, z);
      else if (!place(key, "dim", "rows")) return;
    }
    changed();
    return;
  }
  const sortTh = e.target.closest("th[data-pv-sort]");
  if (sortTh) {
    const key = sortTh.dataset.pvSort;
    if (state.sort_by === key) state.sort_dir = state.sort_dir === "desc" ? "asc" : "desc";
    else Object.assign(state, { sort_by: key, sort_dir: "desc" });
    scheduleRun(0);
    return;
  }
  if (e.target.closest("th[data-pv-sort-dim]")) {
    state.sort_by = "";
    scheduleRun(0);
  }
}

function onKey(e) {
  if (e.key !== "Escape") return;
  if (picker) closePicker();
  else if (drawer && !drawer.classList.contains("hidden")) toggleDrawer(false);
}

function bind() {
  const builder = byId("rep-builder");
  const modal = modalEl;

  builder.addEventListener("click", onClick);
  drawer.addEventListener("click", onClick);
  document.addEventListener("keydown", onKey);

  drawer.addEventListener("dragstart", (e) => {
    const chip = e.target.closest?.(".pv-chip");
    if (!chip) return;
    dragging = { key: chip.dataset.pvField, kind: chip.dataset.pvKind, from: chip.dataset.pvZone || "" };
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", dragging.key);
    chip.classList.add("dragging");
  });
  drawer.addEventListener("dragend", (e) => {
    e.target.closest?.(".pv-chip")?.classList.remove("dragging");
    drawer?.querySelectorAll(".pv-zone.over").forEach((z) => z.classList.remove("over", "deny"));
    dragging = null;
  });
  drawer.addEventListener("dragover", (e) => {
    if (!dragging) return;
    const zone = e.target.closest(".pv-zone");
    const back = e.target.closest(".pv-fields");
    if (!zone && !back) return;
    const ok = back ? Boolean(dragging.from) : (dragging.kind === "measure") === (zone.dataset.zone === "values");
    if (ok) e.preventDefault();
    drawer.querySelectorAll(".pv-zone.over").forEach((z) => z !== zone && z.classList.remove("over", "deny"));
    if (zone) {
      zone.classList.add("over");
      zone.classList.toggle("deny", !ok);
    }
  });
  drawer.addEventListener("drop", (e) => {
    if (!dragging) return;
    e.preventDefault();
    const zone = e.target.closest(".pv-zone");
    const { key, kind, from } = dragging;
    dragging = null;
    drawer.querySelectorAll(".pv-zone.over").forEach((z) => z.classList.remove("over", "deny"));
    if (!zone) {
      if (from && e.target.closest(".pv-fields")) {
        removeField(key, from);
        changed();
      }
      return;
    }
    const drop = zone.querySelector(".pv-drop");
    if (place(key, kind, zone.dataset.zone, dropIndex(drop, e))) changed();
  });

  builder.addEventListener("change", (e) => {
    if (e.target.id === "pv-layout") openLayout(e.target.value);
  });
  drawer.addEventListener("change", (e) => {
    if (e.target.id !== "pv-subtotals") return;
    state.subtotals = e.target.checked;
    renderSummary();
    scheduleRun(0);
  });
  byId("pv-config-open")?.addEventListener("click", () => toggleDrawer());
  byId("pv-config-close")?.addEventListener("click", () => toggleDrawer(false));
  byId("pv-field-q")?.addEventListener("input", renderFields);
  byId("pv-save")?.addEventListener("click", () => saveLayout(false));
  byId("pv-save-new")?.addEventListener("click", () => saveLayout(true));
  byId("pv-delete")?.addEventListener("click", deleteLayout);
  byId("pv-clear")?.addEventListener("click", () => {
    state = blankState();
    changed();
  });
  byId("pv-excel")?.addEventListener("click", (e) => exportExcel(e.currentTarget));

  modal?.addEventListener("click", (e) => {
    if (e.target === modal || e.target.id === "pv-values-cancel") return closePicker();
    if (e.target.id === "pv-values-ok") return applyPicker();
    if (!picker) return;
    if (e.target.id === "pv-values-all" || e.target.id === "pv-values-none") {
      const on = e.target.id === "pv-values-all";
      for (const v of pickerVisible()) on ? picker.selected.add(v.value) : picker.selected.delete(v.value);
      renderPicker();
    }
  });
  modal?.addEventListener("change", (e) => {
    const box = e.target.closest("[data-pv-val]");
    if (!box || !picker) return;
    const v = box.dataset.pvVal;
    box.checked ? picker.selected.add(v) : picker.selected.delete(v);
    byId("pv-values-info").textContent = `Tanlangan: ${picker.selected.size} / ${picker.values.length}`;
  });
  byId("pv-values-q")?.addEventListener("input", renderPicker);
  modal?.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && e.target.id === "pv-values-q") applyPicker();
  });
}

export function setup(context) {
  ctx = context;
  root = context.root;
  // .glass (backdrop-filter) ichida position: fixed ekranga emas, panelga bog‘lanib qoladi
  drawer = byId("pv-drawer");
  modalEl = byId("pv-values-modal");
  if (drawer) document.body.appendChild(drawer);
  if (modalEl) document.body.appendChild(modalEl);
  bind();
}

export async function activate() {
  if (!ready) {
    const [f] = await Promise.all([api("/reports/pivot/fields"), loadLayouts()]);
    fields = f;
    ready = true;
    if (!current && !usedDims().length) {
      current = "tpl:0";
      state = cleanState(TEMPLATES[0]);
      byId("pv-name").value = TEMPLATES[0].name;
    }
  }
  renderAll();
}

export function hide() {
  if (picker) closePicker();
  toggleDrawer(false);
}

export function destroy() {
  clearTimeout(runTimer);
  document.removeEventListener("keydown", onKey);
  document.body.classList.remove("pv-drawer-open");
  drawer?.remove();
  modalEl?.remove();
  drawer = null;
  modalEl = null;
  ctx = null;
  root = null;
  fields = null;
  layouts = [];
  current = "";
  state = blankState();
  result = null;
  picker = null;
  ready = false;
}

