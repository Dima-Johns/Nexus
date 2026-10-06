import { api, apiUpload, token } from "./api.js";
import { $, $$, askConfirm, escapeHtml, formData } from "./ui.js?v=70";

let orders = [];
let filter = "incoming";
let sortAsc = false;
let bound = false;
let selected = new Set();
let driversById = {};
let warehouses = [];
let expandedDrivers = new Set();

function isDone(o) {
  return o.status === "delivered" || o.status === "returned";
}

function hasDriver(o) {
  return Boolean(o.driver_id || String(o.driver_name || "").trim());
}

const BUCKETS = {
  incoming: (o) => !isDone(o) && !hasDriver(o),
  active: (o) => !isDone(o) && hasDriver(o),
  done: (o) => isDone(o),
};

function hasGps(o) {
  const lat = Number(o.dropoff_lat);
  const lng = Number(o.dropoff_lng);
  return lat > 37 && lat < 46 && lng > 55 && lng < 76;
}

function orderDay(o) {
  const raw = String(o.delivery_date || "").slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const created = String(o.created_at || "").slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(created) ? created : "";
}

function isoDay(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

const MONTHS_UZ = ["yanv.", "fev.", "mart", "apr.", "may", "iyun", "iyul", "avg.", "sent.", "okt.", "noy.", "dek."];
const ALL_STATUSES = ["new", "assigned", "in_transit", "delivered", "returned"];

function defaultFilters() {
  return {
    datePreset: "today",
    customDate: "",
    routeCodes: null,
    includeNoRoute: true,
    statuses: null,
    driverNames: null,
    includeNoDriver: true,
  };
}

function cloneFilters(src) {
  return {
    datePreset: src.datePreset,
    customDate: src.customDate || "",
    routeCodes: src.routeCodes ? [...src.routeCodes] : null,
    includeNoRoute: src.includeNoRoute,
    statuses: src.statuses ? [...src.statuses] : null,
    driverNames: src.driverNames ? [...src.driverNames] : null,
    includeNoDriver: src.includeNoDriver,
  };
}

let applied = defaultFilters();
let draft = defaultFilters();

function formatDayLabel(iso) {
  const [y, m, d] = String(iso).split("-").map(Number);
  if (!y || !m || !d) return "—";
  return `${String(d).padStart(2, "0")} ${MONTHS_UZ[m - 1]} ${y}`;
}

function presetRange(preset, customDate = "") {
  const now = new Date();
  const today = isoDay(now);
  if (preset === "all") return { from: "", to: "" };
  if (preset === "custom") {
    const day = String(customDate || "").slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(day)) return { from: day, to: day };
    return { from: today, to: today };
  }
  if (preset === "yesterday") {
    const d = new Date(now);
    d.setDate(d.getDate() - 1);
    const day = isoDay(d);
    return { from: day, to: day };
  }
  if (preset === "tomorrow") {
    const d = new Date(now);
    d.setDate(d.getDate() + 1);
    const day = isoDay(d);
    return { from: day, to: day };
  }
  if (preset === "last7") {
    const from = new Date(now);
    from.setDate(from.getDate() - 6);
    return { from: isoDay(from), to: today };
  }
  if (preset === "last30") {
    const from = new Date(now);
    from.setDate(from.getDate() - 29);
    return { from: isoDay(from), to: today };
  }
  if (preset === "this_month") {
    const start = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
    return { from: start, to: today };
  }
  if (preset === "last_month") {
    const startDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const endDate = new Date(now.getFullYear(), now.getMonth(), 0);
    return { from: isoDay(startDate), to: isoDay(endDate) };
  }
  return { from: today, to: today };
}

function activeCustomDate(src = draft) {
  if (src.datePreset === "custom" && /^\d{4}-\d{2}-\d{2}$/.test(String(src.customDate || "").slice(0, 10))) {
    return String(src.customDate).slice(0, 10);
  }
  return "";
}

function rangeText(preset, customDate = "") {
  if (preset === "all") return "Barcha sanalar · bosing — kalendar";
  const { from, to } = presetRange(preset, customDate);
  if (from === to) return `${formatDayLabel(from)} · bosing — kalendar`;
  return `${formatDayLabel(from)}, 00:00 — ${formatDayLabel(to)}, 23:59`;
}

function chipText(preset, customDate = "") {
  if (preset === "all") return "Barchasi";
  const { from, to } = presetRange(preset, customDate);
  if (from === to) return formatDayLabel(from);
  return `${from.slice(8)}.${from.slice(5, 7)} – ${to.slice(8)}.${to.slice(5, 7)}`;
}

function tomorrowIso() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return isoDay(d);
}

function inDatePreset(o) {
  if (applied.datePreset === "all") return true;
  const day = orderDay(o);
  if (!day) return false;
  const { from, to } = presetRange(applied.datePreset, applied.customDate);
  return day >= from && day <= to;
}

function todayIso() {
  return isoDay(new Date());
}

function earliestSelectedDay(picked) {
  const days = picked.map(orderDay).filter(Boolean).sort();
  return days[0] || tomorrowIso();
}

function matchesBase(o) {
  const q = ($("#order-search")?.value || "").trim().toLowerCase();
  if (q) {
    const blob = `${o.code} ${o.client_name || ""} ${o.route_code || ""} ${o.dropoff_address} ${o.sales_rep || ""} ${o.driver_name || ""}`.toLowerCase();
    if (!blob.includes(q)) return false;
  }
  if (!inDatePreset(o)) return false;
  if (applied.statuses && !applied.statuses.includes(o.status)) return false;
  const route = String(o.route_code || "").trim();
  if (!route) {
    if (!applied.includeNoRoute) return false;
  } else if (applied.routeCodes && !applied.routeCodes.includes(route)) {
    return false;
  }
  const drv = String(o.driver_name || "").trim();
  if (!drv) {
    if (!applied.includeNoDriver) return false;
  } else if (applied.driverNames && !applied.driverNames.includes(drv)) {
    return false;
  }
  return true;
}

function matches(o) {
  if (!matchesBase(o)) return false;
  return BUCKETS[filter] ? BUCKETS[filter](o) : true;
}

function updateDateChip() {
  const chip = $("#date-summary");
  if (chip) chip.textContent = chipText(applied.datePreset, applied.customDate);
}

function setPresetButtons(preset) {
  $$("[data-dpreset]").forEach((btn) => btn.classList.toggle("active", btn.dataset.dpreset === preset && preset !== "custom"));
  const label = $("#filter-range-label");
  if (label) label.textContent = rangeText(preset, draft.customDate);
  const wrap = $(".filter-range-wrap");
  if (wrap) wrap.classList.toggle("custom", preset === "custom");
  const pick = $("#filter-date-pick");
  if (pick) {
    if (preset === "custom" && draft.customDate) pick.value = draft.customDate;
    else if (preset !== "custom") {
      const { from, to } = presetRange(preset, draft.customDate);
      pick.value = from && from === to ? from : todayIso();
    }
  }
}

function syncDraftToDom() {
  setPresetButtons(draft.datePreset);
  const drvNames = JSON.parse($("#drv-list")?.dataset.names || "[]");
  const drvBoxes = $$("#drv-list [data-drv-idx]");
  drvBoxes.forEach((box) => {
    const name = drvNames[Number(box.dataset.drvIdx)] ?? "";
    if (!name) box.checked = draft.includeNoDriver;
    else box.checked = draft.driverNames === null || draft.driverNames.includes(name);
  });
  const drvAll = $("#drv-all");
  if (drvAll) drvAll.checked = drvBoxes.length > 0 && drvBoxes.every((b) => b.checked);
  $$("[data-st]").forEach((box) => {
    box.checked = draft.statuses === null || draft.statuses.includes(box.dataset.st);
  });
  const routeBoxes = $$("#route-list [data-route-idx]");
  const routeNames = JSON.parse($("#route-list")?.dataset.names || "[]");
  routeBoxes.forEach((box) => {
    const name = routeNames[Number(box.dataset.routeIdx)] ?? "";
    if (!name) box.checked = draft.includeNoRoute;
    else box.checked = draft.routeCodes === null || draft.routeCodes.includes(name);
  });
  const routeAll = $("#route-all");
  if (routeAll) routeAll.checked = routeBoxes.length > 0 && routeBoxes.every((b) => b.checked);
}

function readDraftFromDom() {
  const active = $("[data-dpreset].active");
  if (draft.datePreset === "custom" && activeCustomDate(draft)) {
    /* keep custom */
  } else {
    draft.datePreset = active?.dataset.dpreset || draft.datePreset || "all";
    if (draft.datePreset !== "custom") draft.customDate = "";
  }
  const drvBoxes = $$("#drv-list [data-drv-idx]");
  const drvNames = JSON.parse($("#drv-list")?.dataset.names || "[]");
  const drvChecked = drvBoxes.filter((b) => b.checked);
  const selectedDrivers = drvChecked.map((b) => drvNames[Number(b.dataset.drvIdx)] ?? "");
  draft.includeNoDriver = selectedDrivers.includes("");
  const namedDrivers = selectedDrivers.filter(Boolean);
  draft.driverNames = drvChecked.length === drvBoxes.length ? null : namedDrivers;
  const st = $$("[data-st]").filter((b) => b.checked).map((b) => b.dataset.st);
  draft.statuses = st.length === ALL_STATUSES.length ? null : st;
  const routeBoxes = $$("#route-list [data-route-idx]");
  const routeNames = JSON.parse($("#route-list")?.dataset.names || "[]");
  const routeChecked = routeBoxes.filter((b) => b.checked);
  const selectedRoutes = routeChecked.map((b) => routeNames[Number(b.dataset.routeIdx)] ?? "");
  draft.includeNoRoute = selectedRoutes.includes("");
  const coded = selectedRoutes.filter(Boolean);
  draft.routeCodes = routeChecked.length === routeBoxes.length ? null : coded;
}

async function fillFilterLists() {
  const drvList = $("#drv-list");
  if (drvList) {
    let catalog = [];
    try {
      catalog = await api("/drivers");
    } catch {
      catalog = [];
    }
    const counts = {};
    orders.forEach((o) => {
      const name = String(o.driver_name || "").trim();
      counts[name] = (counts[name] || 0) + 1;
    });
    const fromDb = (catalog || []).map((d) => String(d.name || "").trim()).filter(Boolean);
    const fromOrders = Object.keys(counts).filter(Boolean);
    const unique = [...new Set([...fromDb, ...fromOrders])].sort((a, b) => a.localeCompare(b, "uz"));
    const names = ["", ...unique];
    drvList.innerHTML = names
      .map((name, i) => {
        const n = counts[name] || 0;
        const label = name ? `${name} · ${n}` : `Haydovchi yo‘q · ${n}`;
        return `<label class="chk"><input type="checkbox" data-drv-idx="${i}" /> ${escapeHtml(label)}</label>`;
      })
      .join("");
    drvList.dataset.names = JSON.stringify(names);
  }
  const routeList = $("#route-list");
  if (routeList) {
    const counts = {};
    orders.forEach((o) => {
      const code = String(o.route_code || "").trim();
      counts[code] = (counts[code] || 0) + 1;
    });
    const codes = Object.keys(counts)
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    const names = counts[""] || codes.length ? ["", ...codes] : [""];
    routeList.innerHTML = names
      .map((code, i) => {
        const n = counts[code] || 0;
        const label = code ? `${code} · ${n}` : `Yuklama yo‘q · ${n}`;
        return `<label class="chk"><input type="checkbox" data-route-idx="${i}" /> ${escapeHtml(label)}</label>`;
      })
      .join("");
    routeList.dataset.names = JSON.stringify(names);
  }
  syncDraftToDom();
}

async function openFilterPanel() {
  const panel = $("#filter-panel");
  if (!panel) return;
  draft = cloneFilters(applied);
  panel.classList.remove("hidden");
  $("#btn-filter")?.classList.add("active");
  await fillFilterLists();
}

function closeFilterPanel() {
  $("#filter-panel")?.classList.add("hidden");
  $("#btn-filter")?.classList.remove("active");
}

let quietNotify = false;
function notifyMap() {
  window.dispatchEvent(new CustomEvent("nexus:orders-changed", { detail: { quiet: quietNotify } }));
}

function driverColor(name) {
  const palette = ["#5eead4", "#7aa2ff", "#fbbf24", "#fb7185", "#a78bfa", "#34d399", "#f472b6", "#38bdf8"];
  let h = 0;
  for (const ch of String(name)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return palette[h % palette.length];
}

function haversineKm(a, b) {
  const toRad = (x) => (x * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(b[0] - a[0]);
  const dLng = toRad(b[1] - a[1]);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a[0])) * Math.cos(toRad(b[0])) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

function routeKm(list) {
  const pts = list.filter(hasGps).map((o) => [Number(o.dropoff_lat), Number(o.dropoff_lng)]);
  let km = 0;
  for (let i = 1; i < pts.length; i++) km += haversineKm(pts[i - 1], pts[i]);
  return km;
}

function driverTitle(o) {
  const meta = o.driver_id ? driversById[o.driver_id] : null;
  const raw = String((meta && meta.name) || o.driver_name || "").trim();
  return raw || "Haydovchi yo‘q";
}

function driverPlate(o) {
  const meta = o.driver_id ? driversById[o.driver_id] : null;
  return String((meta && meta.vehicle_plate) || "").trim();
}

function sortStops(list) {
  return list.slice().sort((a, b) => (Number(a.stop_no) || 9999) - (Number(b.stop_no) || 9999) || a.id - b.id);
}

function orderCardHtml(o) {
  const checked = selected.has(o.id);
  return `<div class="order-card${checked ? " selected" : ""}" data-id="${o.id}" data-lat="${o.dropoff_lat}" data-lng="${o.dropoff_lng}" data-name="${escapeHtml(o.client_name || "")}" data-addr="${escapeHtml(o.dropoff_address || "")}">
        <label class="chk card-chk"><input type="checkbox" data-check="${o.id}" ${checked ? "checked" : ""} /></label>
        <div class="order-body">
          <div class="order-card-top">
          <b>${escapeHtml(o.code)}</b>
          <span class="card-top-right">
            ${Number(o.stop_no) > 0 ? `<span class="stop-chip">${o.stop_no}</span>` : ""}
            <span class="badge ${o.status}">${escapeHtml(o.route_code || o.status)}</span>
          </span>
        </div>
          <div>${escapeHtml(o.client_name || "—")}</div>
          <div class="muted">${
            o.agent_code
              ? `Agent ${escapeHtml(o.agent_code)}${o.sales_rep ? " · " + escapeHtml(o.sales_rep) : ""}`
              : escapeHtml(o.sales_rep || "Agent ko‘rsatilmagan")
          }</div>
          ${
            o.window_start && o.window_end
              ? `<div class="muted">${escapeHtml(o.delivery_date || "")} · ${escapeHtml(o.window_start)}–${escapeHtml(o.window_end)}</div>`
              : ""
          }
          <div class="muted">${escapeHtml(o.dropoff_address || "")}</div>
          ${proofHtml(o)}
        </div>
      </div>`;
}

const PROOF_LABELS = {
  fridge_yes: "Muzlatgich bor",
  foreign_goods: "Begona mahsulot bor",
  fridge_no: "Muzlatgich yo‘q",
  returned: "Qaytarildi",
  delivered: "Yetkazildi",
};

function proofHtml(o) {
  if (!o.proof_photo && !o.proof_reason) return "";
  const kind = o.status === "returned" ? "returned" : o.proof_reason === "fridge_no" ? "bad" : o.proof_reason === "foreign_goods" ? "warn" : "ok";
  const label = PROOF_LABELS[o.proof_reason] || PROOF_LABELS[o.status] || "";
  const when = o.proof_at
    ? new Date(o.proof_at).toLocaleString("uz-UZ", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })
    : "";
  return `<div class="proof-line">
    <span class="proof-chip ${kind}">${escapeHtml(label)}</span>
    ${when ? `<span class="muted">${escapeHtml(when)}</span>` : ""}
    ${
      o.proof_photo
        ? `<a class="proof-thumb" href="${escapeHtml(o.proof_photo)}" target="_blank" rel="noopener" title="Rasmni ochish"><img src="${escapeHtml(o.proof_photo)}" alt="" loading="lazy" /></a>`
        : ""
    }
  </div>`;
}

function groupByDriver(rows) {
  const map = new Map();
  for (const o of rows) {
    const key = String(o.driver_id || 0);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(o);
  }
  return [...map.entries()].sort((a, b) => driverTitle(a[1][0]).localeCompare(driverTitle(b[1][0]), "uz"));
}

function driverGroupHtml(key, list) {
  const stops = sortStops(list);
  const open = expandedDrivers.has(key);
  const name = driverTitle(stops[0]);
  const plate = driverPlate(stops[0]);
  const color = driverColor(stops[0].driver_name || name);
  const km = routeKm(stops);
  const ids = stops.map((o) => o.id);
  const picked = ids.filter((id) => selected.has(id)).length;
  const allOn = picked === ids.length && ids.length > 0;
  return `<div class="drv-group${open ? " open" : ""}" data-drv-group="${escapeHtml(key)}">
    <div class="drv-row" data-drv-toggle="${escapeHtml(key)}" style="--drv:${color}">
      <label class="chk card-chk" data-drv-check="${escapeHtml(key)}"><input type="checkbox" ${allOn ? "checked" : ""} /></label>
      <span class="drv-stripe"></span>
      <div class="drv-main">
        <div class="drv-top">
          <b class="drv-name">${escapeHtml(name)}</b>
          ${plate ? `<span class="drv-plate">${escapeHtml(plate)}</span>` : ""}
        </div>
        <div class="drv-meta">
          <span>${stops.length}/${stops.length}</span>
          <span>${km.toFixed(1)} km</span>
        </div>
      </div>
      <span class="drv-chevron">${open ? "▴" : "▾"}</span>
    </div>
    <div class="drv-orders${open ? "" : " hidden"}">${stops.map(orderCardHtml).join("")}</div>
  </div>`;
}

function updateBulkUi() {
  const visible = orders.filter(matches);
  const count = selected.size;
  const box = $("#select-all");
  if (box) {
    box.checked = visible.length > 0 && visible.every((o) => selected.has(o.id));
    box.indeterminate = count > 0 && !box.checked;
  }
  const label = $("#sel-count");
  if (label) label.textContent = count ? `${count} ta tanlandi` : "";
  const moveBtn = $("#btn-to-active");
  if (moveBtn) moveBtn.classList.toggle("hidden", filter !== "incoming");
  const backBtn = $("#btn-to-incoming");
  if (backBtn) {
    backBtn.classList.toggle("hidden", filter !== "active");
    backBtn.disabled = count === 0;
  }
  const routesBtn = $("#btn-routes");
  if (routesBtn) {
    routesBtn.classList.toggle("hidden", filter !== "active");
  }
  if (filter !== "active") closeRoutesPanel();
  const incomingActions = $("#incoming-actions");
  if (incomingActions) incomingActions.classList.toggle("hidden", filter !== "incoming");
  if (filter !== "incoming") $("#order-form")?.classList.add("hidden");
  const delBtn = $("#btn-delete-orders");
  if (delBtn) {
    delBtn.classList.toggle("hidden", filter === "done");
    delBtn.disabled = count === 0;
  }
  const assignBar = $("#assign-bar");
  if (assignBar) assignBar.classList.toggle("hidden", filter === "done");
  const assignBtn = $("#btn-assign");
  if (assignBtn) {
    assignBtn.disabled = count === 0;
    const lbl = $("#assign-label");
    if (lbl) lbl.textContent = filter === "active" ? "O‘tkazish" : "Biriktirish";
  }
  const dateBtn = $("#btn-edit-date");
  if (dateBtn) {
    dateBtn.classList.toggle("hidden", filter !== "incoming");
    dateBtn.disabled = count === 0;
  }
}

function renderList() {
  const list = $("#order-list");
  if (!list) return;
  let rows = orders.filter(matches);
  rows.sort((a, b) => {
    if (filter === "active") {
      const dn = String(a.driver_name || "").localeCompare(String(b.driver_name || ""), "uz");
      if (dn) return dn;
      const sn = (Number(a.stop_no) || 9999) - (Number(b.stop_no) || 9999);
      if (sn) return sn;
    }
    return (sortAsc ? 1 : -1) * String(a.code).localeCompare(String(b.code), undefined, { numeric: true });
  });
  $("#cnt-incoming").textContent = orders.filter((o) => matchesBase(o) && BUCKETS.incoming(o)).length;
  $("#cnt-active").textContent = orders.filter((o) => matchesBase(o) && BUCKETS.active(o)).length;
  $("#cnt-done").textContent = orders.filter((o) => matchesBase(o) && BUCKETS.done(o)).length;
  updateDateChip();
  $$(".htab[data-filter]").forEach((tab) => tab.classList.toggle("active", tab.dataset.filter === filter));
  if (!rows.length) {
    list.innerHTML = `<div class="empty-list">Buyurtma yo‘q</div>`;
    updateBulkUi();
    notifyMap();
    return;
  }
  if (filter === "incoming") {
    list.innerHTML = rows.map(orderCardHtml).join("");
  } else {
    const groups = groupByDriver(rows);
    const keys = new Set(groups.map(([key]) => key));
    expandedDrivers = new Set([...expandedDrivers].filter((key) => keys.has(key)));
    list.innerHTML = groups.map(([key, items]) => driverGroupHtml(key, items)).join("");
    list.querySelectorAll("[data-drv-check] input").forEach((box) => {
      const key = box.closest("[data-drv-check]")?.dataset.drvCheck;
      const items = groups.find((row) => row[0] === key)?.[1] || [];
      const n = items.filter((o) => selected.has(o.id)).length;
      box.checked = n === items.length && items.length > 0;
      box.indeterminate = n > 0 && n < items.length;
    });
  }
  updateBulkUi();
  notifyMap();
}

async function fillSelects() {
  const [clients, drivers, tpls, whs] = await Promise.all([
    api("/clients").catch(() => []),
    api("/drivers").catch(() => []),
    api("/templates").catch(() => []),
    api("/warehouses").catch(() => []),
  ]);
  warehouses = whs || [];
  driversById = Object.fromEntries((drivers || []).map((d) => [String(d.id), d]));
  setOptions($("#order-client"), clients.map((c) => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join(""));
  setOptions(
    $("#order-driver"),
    `<option value="">Haydovchi yo‘q</option>` + drivers.map((d) => `<option value="${d.id}">${escapeHtml(d.name)}</option>`).join("")
  );
  renderDriverPicker(drivers || [], $("#driver-picker-search")?.value || "");
  const approved = tpls.filter((t) => t.status === "approved" && (t.entity || "orders") === "orders");
  setOptions($("#approved-templates"), approved.map((t) => `<option value="${t.id}">${escapeHtml(t.name)}</option>`).join(""));
}

function setOptions(sel, html) {
  if (!sel) return;
  const cur = sel.value;
  sel.innerHTML = html;
  if (cur && [...sel.options].some((o) => o.value === cur)) sel.value = cur;
}

function renderDriverPicker(drivers, query = "") {
  const box = $("#driver-picker-list");
  if (!box) return;
  const q = String(query || "").trim().toLowerCase();
  const rows = (drivers || Object.values(driversById)).filter((d) => {
    if (!q) return true;
    const blob = `${d.name || ""} ${d.vehicle_plate || ""} ${d.agent_code || ""} ${d.username || ""}`.toLowerCase();
    return blob.includes(q);
  });
  const cur = $("#assign-driver")?.value || "";
  if (!rows.length) {
    box.innerHTML = `<div class="empty-list" style="min-height:80px">Haydovchi topilmadi</div>`;
    return;
  }
  box.innerHTML = rows
    .map((d) => {
      const label = d.agent_code ? `${d.agent_code} · ${d.name}` : d.name;
      const plate = d.vehicle_plate ? `<span class="muted">${escapeHtml(d.vehicle_plate)}</span>` : "";
      return `<button type="button" class="driver-pick-item${String(d.id) === String(cur) ? " active" : ""}" data-drv="${d.id}" data-label="${escapeHtml(label)}">
        <span>${escapeHtml(label)}</span>${plate}
      </button>`;
    })
    .join("");
}

function openDriverPicker() {
  const panel = $("#driver-picker");
  if (!panel) return;
  panel.classList.remove("hidden");
  renderDriverPicker(Object.values(driversById), $("#driver-picker-search")?.value || "");
  $("#driver-picker-search")?.focus();
}

function closeDriverPicker() {
  $("#driver-picker")?.classList.add("hidden");
}

function defaultPlanName(dateStr) {
  const months = ["yanvar", "fevral", "mart", "aprel", "may", "iyun", "iyul", "avgust", "sentabr", "oktabr", "noyabr", "dekabr"];
  const raw = String(dateStr || isoDay(new Date())).slice(0, 10);
  const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return raw;
  return `${Number(m[3])}-${months[Number(m[2]) - 1]} ${m[1]}`;
}

function activePlanStats() {
  const today = isoDay(new Date());
  const rows = orders.filter((o) => matchesBase(o) && BUCKETS.active(o) && orderDay(o) === today);
  let km = 0;
  groupByDriver(rows).forEach(([, items]) => {
    km += routeKm(sortStops(items));
  });
  return { count: rows.length, km };
}

async function renderRoutesPanel() {
  const list = $("#routes-list");
  const summary = $("#routes-summary");
  if (!list) return;
  const today = isoDay(new Date());
  const local = activePlanStats();
  let plan = { plan_date: today, name: defaultPlanName(today), count: local.count, km: Number(local.km.toFixed(1)) };
  try {
    const data = await api(`/day-plan?plan_date=${encodeURIComponent(today)}`);
    plan = { ...plan, ...data, count: data.count ?? local.count, km: data.km ?? plan.km };
  } catch {
    /* offline / no perm — local stats */
  }
  if (summary) summary.textContent = `${plan.count} ta zayavka · ${Number(plan.km).toFixed(1)} km`;
  list.innerHTML = `<article class="route-card route-card-main" data-plan-date="${escapeHtml(plan.plan_date)}">
      <label class="muted" style="font-size:12px">Yo‘nalish nomi</label>
      <div class="route-card-top">
        <input class="route-name-input" id="plan-name-input" value="${escapeHtml(plan.name || defaultPlanName(plan.plan_date))}" />
        <button type="button" class="rail-btn route-save" id="plan-name-save">Saqlash</button>
      </div>
      <div class="route-stats">
        <span><strong id="plan-count">${plan.count}</strong> zayavka</span>
        <span><strong id="plan-km">${Number(plan.km).toFixed(1)}</strong> km</span>
        <span>${escapeHtml(plan.plan_date)}</span>
      </div>
    </article>`;
}

async function openRoutesPanel() {
  const panel = $("#routes-panel");
  if (!panel) return;
  panel.classList.remove("hidden");
  await renderRoutesPanel();
}

function closeRoutesPanel() {
  $("#routes-panel")?.classList.add("hidden");
}

function applyRailWidth(px) {
  const w = Math.min(560, Math.max(220, px));
  document.documentElement.style.setProperty("--rail-w", `${w}px`);
  localStorage.setItem("nx_rail_w", String(w));
  window.dispatchEvent(new CustomEvent("nexus:rail-resize"));
}

function bindResizer() {
  const saved = Number(localStorage.getItem("nx_rail_w") || 340);
  applyRailWidth(saved);
  const handle = $("#rail-resizer");
  if (!handle) return;
  let dragging = false;
  handle.onmousedown = (e) => {
    dragging = true;
    document.body.classList.add("resizing");
    e.preventDefault();
  };
  window.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    applyRailWidth(e.clientX);
  });
  window.addEventListener("mouseup", () => {
    if (!dragging) return;
    dragging = false;
    document.body.classList.remove("resizing");
  });
}

function hourOptions() {
  const hours = [];
  for (let h = 6; h <= 22; h += 1) hours.push(`${String(h).padStart(2, "0")}:00`);
  return hours;
}

function fillHourSelect(sel, value) {
  if (!sel) return;
  const hours = hourOptions();
  sel.innerHTML = hours.map((h) => `<option value="${h}">${h}</option>`).join("");
  sel.value = hours.includes(value) ? value : hours[3] || hours[0];
}

function closePlan() {
  $("#plan-modal")?.classList.add("hidden");
}

function closeDateEdit() {
  $("#date-edit-modal")?.classList.add("hidden");
}

function openDateEdit() {
  if (filter !== "incoming") return;
  const modal = $("#date-edit-modal");
  if (!modal) return;
  const picked = orders.filter(matches).filter((o) => selected.has(o.id));
  if (!picked.length) {
    if ($("#sel-count")) $("#sel-count").textContent = "Zayavka tanlang";
    return;
  }
  const hint = $("#date-edit-hint");
  if (hint) {
    hint.textContent = `${picked.length} ta kiruvchi zayavka sanasini o‘zgartirasiz. Orqa sana tanlab bo‘lmaydi.`;
  }
  const err = $("#date-edit-err");
  if (err) {
    err.classList.add("hidden");
    err.textContent = "";
  }
  const dateEl = $("#date-edit-input");
  if (dateEl) {
    const today = todayIso();
    const cur = earliestSelectedDay(picked);
    dateEl.min = today;
    dateEl.removeAttribute("max");
    dateEl.value = cur >= today ? cur : tomorrowIso();
  }
  modal.classList.remove("hidden");
}

async function runDateEdit() {
  const err = $("#date-edit-err");
  const showErr = (msg) => {
    if (!err) return;
    err.classList.remove("hidden");
    err.textContent = msg;
  };
  const picked = orders.filter(matches).filter((o) => selected.has(o.id));
  const ids = picked.map((o) => o.id);
  const date = ($("#date-edit-input")?.value || "").trim();
  if (!ids.length) {
    showErr("Zayavka tanlang");
    return;
  }
  if (!date) {
    showErr("Yetkazish sanasini tanlang");
    return;
  }
  if (date < todayIso()) {
    showErr(`Orqa sana tanlab bo‘lmaydi (eng erta: ${todayIso()})`);
    return;
  }
  try {
    const data = await api("/orders/bulk-date", {
      method: "POST",
      body: { ids, delivery_date: date },
    });
    selected.clear();
    closeDateEdit();
    const msg = $("#import-msg");
    if (msg) {
      msg.classList.remove("hidden", "error");
      msg.textContent = `${data.updated || 0} ta zayavka sanasi: ${data.delivery_date || date}`;
      setTimeout(() => msg.classList.add("hidden"), 4000);
    }
    await refreshWorkspace();
  } catch (ex) {
    showErr(ex.message || "Sana saqlanmadi");
  }
}

async function openPlan() {
  if (filter !== "incoming") return;
  const modal = $("#plan-modal");
  if (!modal) return;
  const visible = orders.filter(matches);
  const picked = visible.filter((o) => selected.has(o.id));
  const n = picked.length || visible.length;
  const hint = $("#plan-hint");
  if (hint) {
    hint.textContent = picked.length
      ? `${picked.length} ta tanlangan zayavka: fayldagi «Код торгового» tizimdagi agent kodiga mos tushishi kerak.`
      : `${n} ta kiruvchi zayavka: fayldagi «Код торгового» tizimdagi agent kodiga mos tushishi kerak.`;
  }
  const err = $("#plan-err");
  if (err) {
    err.classList.add("hidden");
    err.textContent = "";
  }
  const dateEl = $("#plan-date");
  if (dateEl) {
    const today = todayIso();
    const orderDayMin = earliestSelectedDay(picked.length ? picked : visible);
    // Faolga: zayavka kuni yoki undan keyin (orqa sana yo‘q)
    const minDay = orderDayMin > today ? orderDayMin : today;
    dateEl.min = minDay;
    dateEl.removeAttribute("max");
    dateEl.value = minDay;
  }
  fillHourSelect($("#plan-from"), "09:00");
  fillHourSelect($("#plan-to"), "18:00");
  const drivers = await api("/drivers");
  const box = $("#plan-drivers");
  if (box) {
    box.innerHTML = drivers
      .map((d) => {
        const code = d.agent_code ? `<span class="code">${escapeHtml(d.agent_code)}</span>` : `<span class="code">—</span>`;
        return `<label class="chk">${code} <input type="checkbox" data-plan-drv="${d.id}" checked /> ${escapeHtml(d.name)}</label>`;
      })
      .join("");
  }
  const all = $("#plan-drv-all");
  if (all) all.checked = true;
  modal.classList.remove("hidden");
}

async function runPlan() {
  const err = $("#plan-err");
  const showErr = (msg) => {
    if (!err) return;
    err.classList.remove("hidden");
    err.textContent = msg;
  };
  const visible = orders.filter(matches);
  const picked = visible.filter((o) => selected.has(o.id));
  const ids = (picked.length ? picked : visible).map((o) => o.id);
  const driverIds = $$("#plan-drivers [data-plan-drv]:checked").map((b) => Number(b.dataset.planDrv));
  if (!ids.length) {
    showErr("Rejalashtirish uchun zayavka yo‘q");
    return;
  }
  if (!driverIds.length) {
    showErr("Kamida bitta haydovchi tanlang");
    return;
  }
  try {
    const data = await api("/orders/plan", {
      method: "POST",
      body: {
        ids,
        driver_ids: driverIds,
        delivery_date: $("#plan-date")?.value || tomorrowIso(),
        window_start: $("#plan-from")?.value || "09:00",
        window_end: $("#plan-to")?.value || "18:00",
      },
    });
    const unmatched = Number(data.unmatched || 0);
    const errors = Array.isArray(data.errors) ? data.errors : [];
    selected.clear();
    const label = $("#sel-count");
    if (label) label.textContent = `${data.assigned || 0} ta taqsimlandi`;
    await refreshWorkspace();
    if (unmatched || errors.length) {
      const extra = unmatched > errors.length ? `\n… jami ${unmatched} ta xato` : "";
      showErr(
        `${data.assigned || 0} ta Faolga o‘tdi, ${unmatched} tasi Kiruvchida qoldi:\n${errors.join("\n")}${extra}`
      );
      return;
    }
    closePlan();
  } catch (ex) {
    showErr(ex.message || "Rejalashtirish bajarilmadi");
  }
}

export async function refreshWorkspace({ quiet = false } = {}) {
  orders = await api("/orders");
  const ids = new Set(orders.map((o) => o.id));
  selected = new Set([...selected].filter((id) => ids.has(id)));
  await fillSelects().catch(() => {});
  quietNotify = quiet;
  try {
    renderList();
  } finally {
    quietNotify = false;
  }
  lastSync = Date.now();
}

const SYNC_GAP_MS = 3000;
let lastSync = 0;
let syncing = null;

export function syncWorkspace() {
  if (syncing) return syncing;
  if (!token || document.hidden || Date.now() - lastSync < SYNC_GAP_MS) return Promise.resolve();
  syncing = refreshWorkspace({ quiet: true })
    .catch(() => {})
    .finally(() => {
      syncing = null;
    });
  return syncing;
}

export function bindWorkspace() {
  if (bound) return;
  bound = true;
  // Bitta haqiqiy nusxa: xarita va boshqa sahifalar shu obyekt orqali ma'lumot oladi.
  window.__nxWorkspace = { filteredOrders, getWarehouses, hasGps, refreshWorkspace };
  bindResizer();
  $$(".htab[data-filter]").forEach((tab) => {
    tab.onclick = () => {
      filter = tab.dataset.filter;
      selected.clear();
      syncWorkspace();
      if (filter === "incoming") {
        expandedDrivers.clear();
        window.dispatchEvent(new CustomEvent("nexus:driver-select", { detail: { id: null } }));
      }
      renderList();
      if (filter === "incoming" || filter === "active") {
        window.dispatchEvent(new CustomEvent("nexus:show-map"));
      }
    };
  });
  $("#order-search").oninput = renderList;
  $("#btn-filter").onclick = () => {
    if ($("#filter-panel")?.classList.contains("hidden")) openFilterPanel();
    else closeFilterPanel();
  };
  $("#date-summary").onclick = () => {
    if ($("#filter-panel")?.classList.contains("hidden")) openFilterPanel();
    else closeFilterPanel();
  };
  $("#filter-close").onclick = closeFilterPanel;
  $$("[data-dpreset]").forEach((btn) => {
    btn.onclick = () => {
      draft.datePreset = btn.dataset.dpreset;
      draft.customDate = "";
      setPresetButtons(draft.datePreset);
    };
  });
  const openFilterCalendar = () => {
    const pick = $("#filter-date-pick");
    if (!pick) return;
    const cur =
      activeCustomDate(draft) ||
      (draft.datePreset !== "all" ? presetRange(draft.datePreset, draft.customDate).from : todayIso()) ||
      todayIso();
    pick.value = cur || todayIso();
    try {
      if (typeof pick.showPicker === "function") pick.showPicker();
    } catch {
      /* overlay indicator opens calendar */
    }
  };
  $("#filter-date-pick")?.addEventListener("click", (e) => {
    e.stopPropagation();
    openFilterCalendar();
  });
  $("#filter-date-pick")?.addEventListener("change", () => {
    const val = ($("#filter-date-pick")?.value || "").slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(val)) return;
    draft.datePreset = "custom";
    draft.customDate = val;
    setPresetButtons("custom");
  });
  $$(".fcat").forEach((btn) => {
    btn.onclick = () => {
      $$(".fcat").forEach((b) => b.classList.toggle("active", b === btn));
      $("#fcat-drivers").classList.toggle("hidden", btn.dataset.fcat !== "drivers");
      $("#fcat-statuses").classList.toggle("hidden", btn.dataset.fcat !== "statuses");
      $("#fcat-orders").classList.toggle("hidden", btn.dataset.fcat !== "orders");
    };
  });
  $("#drv-all").onchange = () => {
    $$("#drv-list [data-drv-idx]").forEach((b) => {
      b.checked = $("#drv-all").checked;
    });
  };
  $("#route-all").onchange = () => {
    $$("#route-list [data-route-idx]").forEach((b) => {
      b.checked = $("#route-all").checked;
    });
  };
  $("#drv-list").addEventListener("change", () => {
    const boxes = $$("#drv-list [data-drv-idx]");
    $("#drv-all").checked = boxes.length > 0 && boxes.every((b) => b.checked);
  });
  $("#route-list").addEventListener("change", () => {
    const boxes = $$("#route-list [data-route-idx]");
    $("#route-all").checked = boxes.length > 0 && boxes.every((b) => b.checked);
  });
  $("#filter-reset").onclick = () => {
    applied = defaultFilters();
    draft = defaultFilters();
    syncDraftToDom();
    renderList();
  };
  $("#filter-apply").onclick = () => {
    readDraftFromDom();
    applied = cloneFilters(draft);
    closeFilterPanel();
    selected.clear();
    renderList();
  };
  $("#order-sort").onclick = () => {
    sortAsc = !sortAsc;
    renderList();
  };
  $("#select-all").onchange = () => {
    const visible = orders.filter(matches);
    if ($("#select-all").checked) visible.forEach((o) => selected.add(o.id));
    else visible.forEach((o) => selected.delete(o.id));
    renderList();
  };
  const assignSelected = async (driverIdOverride = null, driverLabel = "") => {
    if (filter === "done") return;
    const ids = orders.filter(matches).filter((o) => selected.has(o.id)).map((o) => o.id);
    const driverId = Number(driverIdOverride || $("#assign-driver")?.value || 0);
    if (!ids.length) {
      $("#sel-count").textContent = "Zayavka tanlang";
      return;
    }
    if (!driverId) {
      openDriverPicker();
      $("#sel-count").textContent = "Haydovchini tanlang";
      return;
    }
    try {
      const data = await api("/orders/assign", { method: "POST", body: { ids, driver_id: driverId } });
      const msg = $("#import-msg");
      if (data.errors?.length) {
        if (msg) {
          msg.classList.remove("hidden");
          msg.classList.add("error");
          msg.textContent = `${data.assigned || 0} ta faolga o‘tdi. ${data.unmatched || data.errors.length} tasi xato: ${data.errors.slice(0, 6).join("; ")}`;
        }
        if ($("#sel-count")) $("#sel-count").textContent = "Agent xatosi";
      } else if (msg) {
        msg.classList.add("hidden");
        msg.classList.remove("error");
        msg.textContent = `${data.assigned || ids.length} ta → ${data.driver_name || driverLabel}`;
      }
      selected.clear();
      closeDriverPicker();
      await refreshWorkspace();
    } catch (ex) {
      const msg = $("#import-msg");
      if (msg) {
        msg.classList.remove("hidden");
        msg.classList.add("error");
        msg.textContent = ex.message;
      }
      if ($("#sel-count")) $("#sel-count").textContent = "Xato";
    }
  };
  const returnSelected = async () => {
    if (filter !== "active") return;
    const ids = orders.filter(matches).filter((o) => selected.has(o.id)).map((o) => o.id);
    if (!ids.length) {
      $("#sel-count").textContent = "Zayavka tanlang";
      return;
    }
    const ok = await askConfirm(`${ids.length} ta zayavka Kiruvchiga qaytarilsinmi? Haydovchi olib tashlanadi.`);
    if (!ok) return;
    await api("/orders/bulk-status", { method: "POST", body: { ids, status: "new" } });
    selected.clear();
    await refreshWorkspace();
  };
  const reassignSelected = async (driverIdOverride = null, driverLabel = "") => {
    if (filter !== "active") return;
    const picked = orders.filter(matches).filter((o) => selected.has(o.id));
    const driverId = Number(driverIdOverride || $("#assign-driver")?.value || 0);
    const msg = $("#import-msg");
    if (!picked.length) {
      $("#sel-count").textContent = "Zayavka tanlang";
      return;
    }
    if (!driverId) {
      openDriverPicker();
      $("#sel-count").textContent = "Haydovchini tanlang";
      return;
    }
    const ids = picked.filter((o) => Number(o.driver_id || 0) !== driverId).map((o) => o.id);
    if (!ids.length) {
      $("#sel-count").textContent = "Bu zayavkalar allaqachon shu haydovchida";
      return;
    }
    const target = driverLabel || driversById[driverId]?.name || "tanlangan haydovchi";
    const ok = await askConfirm(`${ids.length} ta zayavka «${target}» ga o‘tkazilsinmi? Ular haydovchi ilovasida ko‘rinadi.`);
    if (!ok) return;
    try {
      const data = await api("/orders/reassign", { method: "POST", body: { ids, driver_id: driverId } });
      if (msg) {
        msg.classList.remove("hidden", "error");
        msg.textContent = `${data.moved || 0} ta zayavka ${data.driver_name || target} ga o‘tkazildi.`;
      }
      selected.clear();
      expandedDrivers.add(String(driverId));
      closeDriverPicker();
      await refreshWorkspace();
    } catch (ex) {
      if (msg) {
        msg.classList.remove("hidden");
        msg.classList.add("error");
        msg.textContent = ex.message;
      }
    }
  };
  $("#btn-to-active").onclick = () => {
    if (!selected.size) {
      $("#sel-count").textContent = "Zayavka tanlang";
      return;
    }
    openDriverPicker();
  };
  $("#btn-to-incoming").onclick = returnSelected;
  $("#btn-assign").onclick = () => {
    if (!selected.size) {
      $("#sel-count").textContent = "Zayavka tanlang";
      return;
    }
    const panel = $("#driver-picker");
    if (panel && !panel.classList.contains("hidden")) closeDriverPicker();
    else openDriverPicker();
  };
  $("#btn-routes")?.addEventListener("click", () => {
    const panel = $("#routes-panel");
    if (panel?.classList.contains("hidden")) openRoutesPanel();
    else closeRoutesPanel();
  });
  $("#routes-close")?.addEventListener("click", closeRoutesPanel);
  $("#routes-list")?.addEventListener("click", async (e) => {
    const btn = e.target.closest("#plan-name-save");
    if (!btn) return;
    const card = btn.closest(".route-card");
    const input = $("#plan-name-input");
    const newName = (input?.value || "").trim();
    if (!newName) return;
    btn.disabled = true;
    try {
      const data = await api("/day-plan", {
        method: "PUT",
        body: {
          plan_date: card?.dataset.planDate || isoDay(new Date()),
          name: newName,
        },
      });
      if (input) input.value = data.name || newName;
      if ($("#routes-summary")) {
        $("#routes-summary").textContent = `${data.count ?? 0} ta zayavka · ${Number(data.km || 0).toFixed(1)} km`;
      }
      if ($("#plan-count")) $("#plan-count").textContent = String(data.count ?? 0);
      if ($("#plan-km")) $("#plan-km").textContent = Number(data.km || 0).toFixed(1);
      const msg = $("#import-msg");
      if (msg) {
        msg.classList.remove("hidden", "error");
        msg.textContent = `Yo‘nalish nomi saqlandi: ${data.name || newName}`;
      }
    } catch (ex) {
      const msg = $("#import-msg");
      if (msg) {
        msg.classList.remove("hidden");
        msg.classList.add("error");
        msg.textContent = ex.message;
      }
    } finally {
      btn.disabled = false;
    }
  });
  if ($("#btn-plan")) $("#btn-plan").onclick = openPlan;
  if ($("#plan-close")) $("#plan-close").onclick = closePlan;
  if ($("#plan-cancel")) $("#plan-cancel").onclick = closePlan;
  if ($("#plan-run")) $("#plan-run").onclick = runPlan;
  if ($("#btn-edit-date")) $("#btn-edit-date").onclick = openDateEdit;
  if ($("#date-edit-close")) $("#date-edit-close").onclick = closeDateEdit;
  if ($("#date-edit-cancel")) $("#date-edit-cancel").onclick = closeDateEdit;
  if ($("#date-edit-save")) $("#date-edit-save").onclick = runDateEdit;
  if ($("#plan-drv-all")) {
    $("#plan-drv-all").onchange = () => {
      $$("#plan-drivers [data-plan-drv]").forEach((b) => {
        b.checked = $("#plan-drv-all").checked;
      });
    };
  }
  $("#plan-drivers")?.addEventListener("change", () => {
    const boxes = $$("#plan-drivers [data-plan-drv]");
    const all = $("#plan-drv-all");
    if (all) all.checked = boxes.length > 0 && boxes.every((b) => b.checked);
  });
  const assignBar = $("#assign-bar");
  $("#driver-picker-search")?.addEventListener("input", (e) => {
    renderDriverPicker(Object.values(driversById), e.target.value);
  });
  $("#driver-picker-list")?.addEventListener("click", async (e) => {
    const item = e.target.closest("[data-drv]");
    if (!item) return;
    const id = item.dataset.drv;
    const label = item.dataset.label || item.textContent.trim();
    if ($("#assign-driver")) $("#assign-driver").value = id;
    renderDriverPicker(Object.values(driversById), $("#driver-picker-search")?.value || "");
    if (filter === "active") await reassignSelected(id, label);
    else await assignSelected(id, label);
  });
  document.addEventListener("click", (e) => {
    if (!assignBar) return;
    if (assignBar.contains(e.target)) return;
    closeDriverPicker();
  });
  $("#btn-delete-orders").onclick = async () => {
    if (filter === "done") return;
    const ids = orders.filter(matches).filter((o) => selected.has(o.id)).map((o) => o.id);
    if (!ids.length) {
      $("#sel-count").textContent = "Zayavka tanlang";
      return;
    }
    const ok = await askConfirm(`${ids.length} ta zayavkani o‘chirasizmi?`, {
      title: "O‘chirish",
      ok: "O‘chirish",
      danger: true,
    });
    if (!ok) return;
    await api("/orders/bulk-delete", { method: "POST", body: { ids } });
    selected.clear();
    await refreshWorkspace();
  };
  $("#btn-create").onclick = () => {
    $("#order-form").classList.toggle("hidden");
    $("#import-msg").classList.add("hidden");
  };
  $("#btn-import").onclick = () => {
    $("#order-form").classList.add("hidden");
    $("#import-msg").classList.add("hidden");
    const input = $("#import-file");
    input.value = "";
    input.click();
  };
  $("#import-file").onchange = async () => {
    const file = $("#import-file").files[0];
    const msg = $("#import-msg");
    if (!file) return;
    msg.classList.remove("hidden");
    msg.textContent = "Yuklanmoqda...";
    try {
      const data = await apiUpload("/orders/import", file);
      const created = data.created || 0;
      const moved = data.existing_incoming || 0;
      const landed = created + moved;
      const parts = [];
      if (created) parts.push(`${created} ta yangi zayavka Kiruvchiga tushdi.`);
      if (moved) parts.push(`${moved} ta Kiruvchidagi zayavka ertangi kunga ko‘chirildi.`);
      if (landed) parts.push(`Yetkazish: ${data.delivery_date} (ertaga). Filtrdan «Ertaga» ni tanlab ko‘ring.`);
      else parts.push("Yangi zayavka qo‘shilmadi — bu fayl avval import qilingan.");
      const already = [
        data.existing_faol ? `${data.existing_faol} tasi Faolda` : "",
        data.existing_done ? `${data.existing_done} tasi Yakunlanganda` : "",
      ].filter(Boolean);
      if (already.length) parts.push(`Fayldagi zayavkalardan ${already.join(", ")} turibdi, ular o‘zgartirilmadi.`);
      if (data.agents_created) parts.push(`${data.agents_created} agent ochildi.`);
      if (data.drivers_created) parts.push(`${data.drivers_created} haydovchi ochildi.`);
      if (data.clients_created) parts.push(`${data.clients_created} ta yangi klient bazaga qo‘shildi.`);
      const errs = Array.isArray(data.errors) ? data.errors : [];
      if (errs.length) parts.push(`Diqqat: ${errs.slice(0, 4).join("; ")}`);
      msg.textContent = parts.join(" ");
      if (errs.length || !landed) {
        msg.classList.add("error");
      } else {
        msg.classList.remove("error");
        setTimeout(() => msg.classList.add("hidden"), 9000);
      }
      // Filtr qanday bo‘lishidan qat’i nazar import ertaga tushadi; default «Bugun» — bugungi ro‘yxatda ko‘rinmaydi
      applied = defaultFilters();
      draft = defaultFilters();
      updateDateChip();
      setPresetButtons(applied.datePreset);
      selected.clear();
      await refreshWorkspace();
      filter = "incoming";
      renderList();
      fillSelects().catch(() => {});
    } catch (err) {
      msg.textContent = err.message;
    } finally {
      $("#import-file").value = "";
    }
  };
  $("#order-list").addEventListener("click", (e) => {
    const drvCheck = e.target.closest("[data-drv-check]");
    if (drvCheck) {
      e.stopPropagation();
      const key = drvCheck.dataset.drvCheck;
      const items = orders.filter(matches).filter((o) => String(o.driver_id || 0) === String(key));
      const ids = items.map((o) => o.id);
      const allOn = ids.length > 0 && ids.every((id) => selected.has(id));
      ids.forEach((id) => (allOn ? selected.delete(id) : selected.add(id)));
      renderList();
      return;
    }
    const toggle = e.target.closest("[data-drv-toggle]");
    if (toggle) {
      const key = toggle.dataset.drvToggle;
      if (expandedDrivers.has(key)) expandedDrivers.delete(key);
      else {
        expandedDrivers.clear();
        expandedDrivers.add(key);
      }
      renderList();
      const open = expandedDrivers.has(key);
      const sample = orders.find((o) => String(o.driver_id || 0) === String(key));
      window.dispatchEvent(
        new CustomEvent("nexus:driver-select", {
          detail: { id: open ? key : null, name: sample ? driverTitle(sample) : "" },
        })
      );
      return;
    }
    const check = e.target.closest("[data-check]");
    if (check) {
      e.stopPropagation();
      const id = Number(check.dataset.check);
      if (check.checked) selected.add(id);
      else selected.delete(id);
      updateBulkUi();
      check.closest(".order-card")?.classList.toggle("selected", check.checked);
      const group = check.closest("[data-drv-group]");
      if (group) {
        const key = group.dataset.drvGroup;
        const items = orders.filter(matches).filter((o) => String(o.driver_id || 0) === String(key));
        const n = items.filter((o) => selected.has(o.id)).length;
        const box = group.querySelector("[data-drv-check] input");
        if (box) {
          box.checked = n === items.length && items.length > 0;
          box.indeterminate = n > 0 && n < items.length;
        }
      }
      return;
    }
    const card = e.target.closest(".order-card");
    if (!card) return;
    window.dispatchEvent(
      new CustomEvent("nexus:order-select", {
        detail: {
          id: card.dataset.id,
          lat: Number(card.dataset.lat),
          lng: Number(card.dataset.lng),
          name: card.dataset.name || "",
          addr: card.dataset.addr || "",
        },
      })
    );
  });
  $("#order-form").onsubmit = async (e) => {
    e.preventDefault();
    const d = formData(e.target);
    d.client_id = d.client_id ? Number(d.client_id) : null;
    d.driver_id = d.driver_id ? Number(d.driver_id) : null;
    d.weight_kg = Number(d.weight_kg || 0);
    await api("/orders", { method: "POST", body: d });
    e.target.reset();
    $("#order-form").classList.add("hidden");
    await refreshWorkspace();
  };
  fillSelects().catch(() => {});
}

export function filteredOrders() {
  return orders.filter(matches);
}

export function getWarehouses() {
  return warehouses;
}

export { hasGps };
