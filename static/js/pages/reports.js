import { api, apiDownload } from "../api.js";
import { $, escapeHtml } from "../ui.js?v=75";
import * as pivot from "./pivot.js?v=75";

const PAGE = 300;
const fmtMoney = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 });
const fmtNum = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 1 });

let root = null;
let bound = false;
let options = null;
let data = null;
let tab = "clients";
let shown = PAGE;
let clientFilter = null;
let orders = { rows: [], total: 0 };
let visibleRows = [];
let loadSeq = 0;
let qTimer = null;
let preset = "30";
let lastLoaded = 0;
let mode = localStorage.getItem("nx_rep_mode") === "pivot" ? "pivot" : "ready";
const PRESETS = ["today", "yesterday", "7", "30", "month", "prev-month", "all"];
const sortBy = {};
const paymentsSeen = new Set();

const money = (v) => fmtMoney.format(Math.round(Number(v) || 0));
const norm = (v) => String(v ?? "").toLowerCase().replace(/[‘’`]/g, "'").trim();

function addDays(day, n) {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function shortDay(day) {
  const m = /^(\d{4})-(\d{2})(?:-(\d{2}))?/.exec(day || "");
  if (!m) return day || "—";
  return m[3] ? `${m[3]}.${m[2]}` : `${m[2]}.${m[1]}`;
}

const GROUP_COLS = [
  { key: "orders", title: "Zayavka", kind: "int" },
  { key: "delivered", title: "Yetkazildi", kind: "int", cls: "ok" },
  { key: "returned", title: "Qaytarildi", kind: "int", cls: "bad" },
  { key: "pending", title: "Jarayonda", kind: "int" },
  { key: "amount", title: "Savdo, so‘m", kind: "money" },
  { key: "amount_returned", title: "Qaytgan summa", kind: "money", cls: "bad" },
  { key: "avg_check", title: "O‘rtacha chek", kind: "money", noTotal: true },
  { key: "return_rate", title: "Qaytarish %", kind: "pct", noTotal: true },
];

const clientCell = (r) => {
  const name = r.label || r.client_name;
  const addr = r.address && norm(r.address) !== norm(name) ? `<span class="rep-sub">${escapeHtml(r.address)}</span>` : "";
  return `<b>${escapeHtml(name)}</b>${addr}`;
};

const photoCell = (r) =>
  r.photo
    ? `<a class="proof-thumb" href="${escapeHtml(r.photo)}" target="_blank" rel="noopener" title="Rasmni ochish"><img src="${escapeHtml(r.photo)}" alt="" loading="lazy" /></a>`
    : "";

const TABS = {
  clients: {
    cols: [
      { key: "code", title: "Kod" },
      { key: "label", title: "Mijoz", render: clientCell },
      { key: "agent", title: "Agent" },
      ...GROUP_COLS,
      { key: "last_day", title: "Oxirgi", kind: "date" },
    ],
    search: ["code", "label", "address", "agent"],
    hint: "Qatorni bossangiz shu klientning zayavkalari ochiladi",
    click: (r) => r.client_id && pickClient(r.client_id, [r.code, r.label].filter(Boolean).join(" · ")),
  },
  returned_clients: {
    cols: [
      { key: "code", title: "Kod" },
      { key: "label", title: "Mijoz", render: clientCell },
      { key: "agent", title: "Agent" },
      { key: "returned", title: "Qaytarish", kind: "int", cls: "bad" },
      { key: "orders", title: "Zayavka", kind: "int" },
      { key: "return_rate", title: "Qaytarish %", kind: "pct", noTotal: true },
      { key: "amount_returned", title: "Qaytgan summa", kind: "money", cls: "bad" },
      { key: "last_return_comment", title: "Oxirgi izoh", render: (r) => escapeHtml(r.last_return_comment || "—") },
    ],
    search: ["code", "label", "address", "agent", "last_return_comment"],
    hint: "Qatorni bossangiz shu klientning zayavkalari ochiladi",
    click: (r) => r.client_id && pickClient(r.client_id, [r.code, r.label].filter(Boolean).join(" · ")),
  },
  returns: {
    cols: [
      { key: "day", title: "Sana", kind: "date", render: (r) => escapeHtml(r.proof_at || r.day) },
      { key: "client_name", title: "Mijoz", render: (r) => `${r.client_code ? `<span class="rep-sub">${escapeHtml(r.client_code)}</span>` : ""}${clientCell(r)}` },
      { key: "driver", title: "Haydovchi" },
      { key: "agent", title: "Agent" },
      { key: "amount", title: "Summa", kind: "money" },
      { key: "comment", title: "Haydovchi izohi", render: (r) => (r.comment ? `«${escapeHtml(r.comment)}»` : `<span class="muted">izohsiz</span>`) },
      { key: "photo", title: "Rasm", render: photoCell, noSort: true },
    ],
    search: ["client_name", "client_code", "address", "driver", "agent", "comment", "code"],
    hint: "Qatorni bossangiz shu klientning zayavkalari ochiladi",
    click: (r) => r.client_id && pickClient(r.client_id, [r.client_code, r.client_name].filter(Boolean).join(" · ")),
  },
  drivers: {
    cols: [{ key: "label", title: "Haydovchi", render: (r) => `<b>${escapeHtml(r.label)}</b>` }, ...GROUP_COLS, { key: "clients", title: "Klient", kind: "int" }, { key: "active_days", title: "Ish kuni", kind: "int", noTotal: true }],
    search: ["label"],
    hint: "Qatorni bossangiz hisobot shu haydovchi bo‘yicha filtrlanadi",
    click: (r) => setSelect("#rep-driver", r.driver_id),
  },
  agents: {
    cols: [{ key: "code", title: "Kod" }, { key: "label", title: "Agent", render: (r) => `<b>${escapeHtml(r.label)}</b>` }, ...GROUP_COLS, { key: "clients", title: "Klient", kind: "int" }],
    search: ["code", "label"],
    hint: "Qatorni bossangiz hisobot shu agent bo‘yicha filtrlanadi",
    click: (r) => r.code && setSelect("#rep-agent", r.code),
  },
  warehouses: {
    cols: [{ key: "label", title: "Sklad", render: (r) => `<b>${escapeHtml(r.label)}</b>` }, ...GROUP_COLS, { key: "clients", title: "Klient", kind: "int" }],
    search: ["label"],
    hint: "Qatorni bossangiz hisobot shu sklad bo‘yicha filtrlanadi",
    click: (r) => r.key !== "0" && setSelect("#rep-wh", r.key),
  },
  days: {
    cols: [{ key: "key", title: "Sana", kind: "date", render: (r) => `<b>${escapeHtml(r.label)}</b>` }, ...GROUP_COLS, { key: "clients", title: "Klient", kind: "int", noTotal: true }],
    search: ["label"],
    hint: "Qatorni bossangiz shu kun ochiladi",
    click: (r) => /^\d{4}-\d{2}-\d{2}$/.test(r.key) && setRange(r.key, r.key, ""),
  },
  payments: {
    cols: [{ key: "label", title: "To‘lov holati", render: (r) => `<b>${escapeHtml(r.label)}</b>` }, ...GROUP_COLS, { key: "clients", title: "Klient", kind: "int", noTotal: true }],
    search: ["label"],
    hint: "Qatorni bossangiz hisobot shu to‘lov holati bo‘yicha filtrlanadi",
    click: (r) => r.key !== "-" && setSelect("#rep-payment", r.key),
  },
  orgs: {
    cols: [{ key: "label", title: "Tashkilot", render: (r) => `<b>${escapeHtml(r.label)}</b>` }, ...GROUP_COLS, { key: "clients", title: "Klient", kind: "int" }],
    search: ["label"],
    hint: "Qatorni bossangiz hisobot shu tashkilot bo‘yicha filtrlanadi",
    click: (r) => r.key !== "0" && setSelect("#rep-org", r.key),
  },
  orders: {
    cols: [
      { key: "day", title: "Sana", kind: "date" },
      { key: "code", title: "Zayavka" },
      { key: "status_label", title: "Holat", render: (r) => `<span class="rep-st st-${escapeHtml(r.status)}">${escapeHtml(r.status_label)}</span>` },
      { key: "client_name", title: "Mijoz", render: (r) => `${r.client_code ? `<span class="rep-sub">${escapeHtml(r.client_code)}</span>` : ""}${clientCell(r)}` },
      { key: "agent", title: "Agent" },
      { key: "driver", title: "Haydovchi" },
      { key: "amount", title: "Summa", kind: "money" },
      { key: "payment", title: "To‘lov" },
      { key: "comment", title: "Izoh / tasdiq", render: (r) => escapeHtml([r.proof, r.comment && `«${r.comment}»`].filter(Boolean).join(" · ")) },
      { key: "photo", title: "Rasm", render: photoCell, noSort: true },
    ],
    search: ["code", "client_name", "client_code", "address", "agent", "driver", "comment", "payment"],
    hint: "Zayavkalar sana bo‘yicha (yangisi tepada)",
  },
};

function errMsg(text) {
  const el = $("#rep-err", root);
  if (!el) return;
  el.textContent = text || "";
  el.classList.toggle("hidden", !text);
}

function val(sel) {
  return ($(sel, root)?.value || "").trim();
}

function params(extra = {}) {
  const p = new URLSearchParams();
  const map = {
    date_from: "#rep-from",
    date_to: "#rep-to",
    org_id: "#rep-org",
    agent_code: "#rep-agent",
    driver_id: "#rep-driver",
    warehouse_id: "#rep-wh",
    status: "#rep-status",
    payment: "#rep-payment",
    q: "#rep-q",
  };
  for (const [k, sel] of Object.entries(map)) {
    const v = val(sel);
    if (v) p.set(k, v);
  }
  if (clientFilter) p.set("client_id", clientFilter.id);
  for (const [k, v] of Object.entries(extra)) if (v !== "" && v != null) p.set(k, v);
  return p.toString();
}

function filterObject() {
  const num = (sel) => Number(val(sel)) || null;
  return {
    date_from: val("#rep-from"),
    date_to: val("#rep-to"),
    org_id: num("#rep-org"),
    agent_code: val("#rep-agent"),
    driver_id: num("#rep-driver"),
    warehouse_id: num("#rep-wh"),
    client_id: clientFilter ? Number(clientFilter.id) || null : null,
    status: val("#rep-status"),
    payment: val("#rep-payment"),
    q: val("#rep-q"),
  };
}

function globalState() {
  const f = filterObject();
  delete f.client_id;
  if (preset) {
    f.date_from = "";
    f.date_to = "";
  }
  return { ...f, preset };
}

async function applyFilters(g) {
  if (!root || !g || typeof g !== "object") return;
  const setVal = (sel, v) => {
    const el = $(sel, root);
    if (!el) return;
    const want = v == null ? "" : String(v);
    el.value = want;
    if (el.value !== want) el.value = "";
  };
  if (options?.cross_org && val("#rep-org") !== String(g.org_id || "")) {
    setVal("#rep-org", g.org_id);
    try {
      await loadOptions();
    } catch (ex) {
      errMsg(ex.message);
    }
  }
  if (g.payment) fillPayments([String(g.payment)]);
  setVal("#rep-agent", g.agent_code);
  setVal("#rep-driver", g.driver_id);
  setVal("#rep-wh", g.warehouse_id);
  setVal("#rep-status", g.status);
  setVal("#rep-payment", g.payment);
  setVal("#rep-q", g.q);
  clientFilter = null;
  renderClientChip();
  if (PRESETS.includes(g.preset)) {
    const [from, to] = presetRange(g.preset);
    setVal("#rep-from", from);
    setVal("#rep-to", to);
    preset = g.preset;
  } else {
    setVal("#rep-from", g.date_from);
    setVal("#rep-to", g.date_to);
    preset = "";
  }
  markPreset();
  await load();
}

async function setMode(next) {
  mode = next === "pivot" ? "pivot" : "ready";
  localStorage.setItem("nx_rep_mode", mode);
  $(".rep-page", root)?.classList.toggle("mode-pivot", mode === "pivot");
  root.querySelectorAll("[data-rep-mode]").forEach((b) => b.classList.toggle("on", b.dataset.repMode === mode));
  if (mode !== "pivot") pivot.hide();
  if (mode === "pivot") {
    try {
      await pivot.activate();
    } catch (ex) {
      errMsg(ex.message || "Konstruktor yuklanmadi");
      return;
    }
  }
}

function fillSelect(sel, items, allLabel, keep = true) {
  const el = $(sel, root);
  if (!el) return;
  const cur = keep ? el.value : "";
  el.innerHTML =
    `<option value="">${escapeHtml(allLabel)}</option>` +
    items.map(([v, label]) => `<option value="${escapeHtml(v)}">${escapeHtml(label)}</option>`).join("");
  if (cur && items.some(([v]) => String(v) === cur)) el.value = cur;
}

function fillOptions() {
  if (!options) return;
  $("#rep-org-box", root)?.classList.toggle("hidden", !options.cross_org);
  $("#rep-tab-orgs", root)?.classList.toggle("hidden", !options.cross_org);
  if (options.cross_org) fillSelect("#rep-org", options.orgs.map((o) => [String(o.id), o.name]), "Barcha tashkilotlar");
  fillSelect("#rep-agent", options.agents.map((a) => [a.code, `${a.code} · ${a.name}`]), "Barcha agentlar");
  fillSelect("#rep-driver", options.drivers.map((d) => [String(d.id), d.name]), "Barcha haydovchilar");
  fillSelect("#rep-wh", options.warehouses.map((w) => [String(w.id), w.name]), "Barcha skladlar");
  fillSelect("#rep-status", options.statuses.map((s) => [s.key, s.label]), "Barcha holatlar");
  $("#rep-export-box", root)?.classList.toggle("hidden", !options.can_export);
}

function fillPayments(list) {
  (list || []).forEach((p) => paymentsSeen.add(p));
  fillSelect("#rep-payment", [...paymentsSeen].sort().map((p) => [p, p]), "Barchasi");
}

function presetRange(key) {
  const today = options?.today || new Date().toISOString().slice(0, 10);
  const month = today.slice(0, 8);
  switch (key) {
    case "today":
      return [today, today];
    case "yesterday":
      return [addDays(today, -1), addDays(today, -1)];
    case "7":
      return [addDays(today, -6), today];
    case "30":
      return [addDays(today, -29), today];
    case "month":
      return [`${month}01`, today];
    case "prev-month": {
      const last = addDays(`${month}01`, -1);
      return [`${last.slice(0, 8)}01`, last];
    }
    default:
      return ["", ""];
  }
}

function markPreset() {
  root.querySelectorAll("[data-preset]").forEach((b) => b.classList.toggle("on", b.dataset.preset === preset));
}

function setRange(from, to, presetKey) {
  $("#rep-from", root).value = from;
  $("#rep-to", root).value = to;
  preset = presetKey;
  markPreset();
  load();
}

function setSelect(sel, value) {
  const el = $(sel, root);
  if (!el || value == null) return;
  el.value = String(value);
  if (el.value !== String(value)) return;
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

function pickClient(id, label) {
  clientFilter = { id, label };
  renderClientChip();
  switchTab("orders", false);
  load();
}

function renderClientChip() {
  const box = $("#rep-client-chip", root);
  if (!box) return;
  box.classList.toggle("hidden", !clientFilter);
  box.innerHTML = clientFilter
    ? `<span>Klient: <b>${escapeHtml(clientFilter.label || `#${clientFilter.id}`)}</b></span><button type="button" class="btn tiny" data-clear-client>Klient filtrini olib tashlash ×</button>`
    : "";
}

function renderKpis() {
  const k = data?.summary || {};
  const cards = [
    ["Savdo summasi", `${money(k.amount)} <small>so‘m</small>`, `Yetkazilgan: ${money(k.amount_delivered)} so‘m`, "accent"],
    ["Zayavkalar", fmtNum.format(k.orders || 0), `Jarayonda: ${k.pending || 0} · bajarildi ${k.progress || 0}%`, ""],
    ["Yetkazildi", fmtNum.format(k.delivered || 0), `${k.delivery_rate || 0}% yakunlanganlardan`, "ok"],
    ["Qaytarildi", fmtNum.format(k.returned || 0), `${money(k.amount_returned)} so‘m · ${k.return_rate || 0}%`, "bad"],
    ["Klientlar", fmtNum.format(k.clients || 0), `Qaytarganlar: ${k.returned_clients || 0}`, ""],
    ["O‘rtacha chek", `${money(k.avg_check)} <small>so‘m</small>`, `Og‘irlik: ${fmtNum.format(k.weight || 0)} kg`, ""],
    ["Haydovchi / agent", `${k.drivers || 0} / ${k.agents || 0}`, "Davrda ishlaganlar", ""],
  ];
  $("#rep-kpis", root).innerHTML = cards
    .map(([label, value, sub, cls]) => `<div class="rep-kpi ${cls}"><span>${label}</span><b>${value}</b><em>${escapeHtml(sub)}</em></div>`)
    .join("");
}

function chartSeries() {
  const days = (data?.days || []).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d.key));
  if (days.length <= 62) return { items: days, monthly: false };
  const byMonth = new Map();
  for (const d of days) {
    const key = d.key.slice(0, 7);
    const m = byMonth.get(key) || { key, label: key, amount: 0, amount_delivered: 0, amount_returned: 0, orders: 0, delivered: 0, returned: 0 };
    for (const f of ["amount", "amount_delivered", "amount_returned", "orders", "delivered", "returned"]) m[f] += d[f] || 0;
    byMonth.set(key, m);
  }
  return { items: [...byMonth.values()], monthly: true };
}

function renderChart() {
  const box = $("#rep-chart", root);
  const { items, monthly } = chartSeries();
  $("#rep-chart-title", root).textContent = monthly ? "Savdo dinamikasi (oylar bo‘yicha)" : "Savdo dinamikasi (kunlar bo‘yicha)";
  if (!items.length) {
    box.innerHTML = `<div class="rep-empty">Tanlangan davrda zayavka yo‘q</div>`;
    return;
  }
  const max = Math.max(...items.map((d) => d.amount || 0), 1);
  box.innerHTML = `<div class="rep-bars">${items
    .map((d) => {
      const pending = Math.max(0, (d.amount || 0) - (d.amount_delivered || 0) - (d.amount_returned || 0));
      const pct = (v) => ((v || 0) * 100) / max;
      const tip = `${d.label}: ${money(d.amount)} so‘m · ${d.orders} zayavka · yetkazildi ${d.delivered} · qaytdi ${d.returned}`;
      const pick = monthly ? "" : `data-day="${escapeHtml(d.key)}"`;
      return `<div class="rep-bar" title="${escapeHtml(tip)}" ${pick}>
        <div class="rep-bar-stack">
          <i class="seg-pend" style="height:${pct(pending)}%"></i>
          <i class="seg-ret" style="height:${pct(d.amount_returned)}%"></i>
          <i class="seg-ok" style="height:${pct(d.amount_delivered)}%"></i>
        </div>
        <span>${escapeHtml(monthly ? shortDay(d.key) : shortDay(d.key))}</span>
      </div>`;
    })
    .join("")}</div>`;
}

function cellValue(col, r) {
  if (col.render) return col.render(r);
  const v = r[col.key];
  if (col.kind === "money") return money(v);
  if (col.kind === "pct") return v ? `${fmtNum.format(v)}%` : "0";
  if (col.kind === "int") return fmtNum.format(v || 0);
  if (col.kind === "date") return escapeHtml(v || "—");
  return escapeHtml(v || "—");
}

function compare(col, dir) {
  const numeric = ["int", "money", "pct"].includes(col.kind);
  return (a, b) => {
    const x = a[col.key];
    const y = b[col.key];
    const res = numeric ? (Number(x) || 0) - (Number(y) || 0) : String(x ?? "").localeCompare(String(y ?? ""), "uz");
    return dir === "asc" ? res : -res;
  };
}

function renderTable() {
  const def = TABS[tab];
  const box = $("#rep-table", root);
  if (!def || !box) return;
  let rows = tab === "orders" ? orders.rows : data?.[tab] || [];
  const q = norm($("#rep-tab-q", root)?.value);
  if (q) rows = rows.filter((r) => def.search.some((k) => norm(r[k]).includes(q)));
  const s = sortBy[tab];
  if (s) {
    const col = def.cols.find((c) => c.key === s.key);
    if (col) rows = [...rows].sort(compare(col, s.dir));
  }
  visibleRows = tab === "orders" ? rows : rows.slice(0, shown);
  const total = tab === "orders" ? orders.total : rows.length;
  let info = `${fmtNum.format(total)} ta`;
  if (tab === "returns" && data && data.returns_total > (data.returns || []).length) info += ` (ekranda oxirgi ${data.returns.length}, Excel’da hammasi)`;
  $("#rep-tab-info", root).textContent = `${info} · ${def.hint}`;
  if (!rows.length) {
    box.innerHTML = `<div class="rep-empty">${data ? "Ma’lumot yo‘q" : "Yuklanmoqda…"}</div>`;
    return;
  }
  const head = def.cols
    .map((c) => {
      const cls = [c.kind && c.kind !== "text" && c.kind !== "date" ? "num" : "", s?.key === c.key ? `sorted ${s.dir}` : "", c.noSort ? "" : "sortable"].join(" ");
      return `<th class="${cls}" ${c.noSort ? "" : `data-sort="${c.key}"`}>${escapeHtml(c.title)}</th>`;
    })
    .join("");
  const body = visibleRows
    .map(
      (r, i) =>
        `<tr data-i="${i}" class="${def.click ? "clickable" : ""}">${def.cols
          .map((c) => `<td class="${c.kind && c.kind !== "text" && c.kind !== "date" ? "num" : ""} ${c.cls || ""}">${cellValue(c, r)}</td>`)
          .join("")}</tr>`
    )
    .join("");
  let foot = "";
  if (tab !== "orders" && def.cols.some((c) => ["int", "money"].includes(c.kind) && !c.noTotal)) {
    foot = `<tfoot><tr>${def.cols
      .map((c, i) => {
        if (!["int", "money"].includes(c.kind) || c.noTotal) return `<td>${i === 0 ? "Jami" : ""}</td>`;
        const sum = rows.reduce((acc, r) => acc + (Number(r[c.key]) || 0), 0);
        return `<td class="num ${c.cls || ""}">${c.kind === "money" ? money(sum) : fmtNum.format(sum)}</td>`;
      })
      .join("")}</tr></tfoot>`;
  }
  const more =
    tab === "orders"
      ? orders.rows.length < orders.total
        ? `<button class="btn rep-more" type="button" data-more>Yana yuklash (${fmtNum.format(orders.rows.length)} / ${fmtNum.format(orders.total)})</button>`
        : ""
      : rows.length > visibleRows.length
        ? `<button class="btn rep-more" type="button" data-more>Yana ${PAGE} ta (${fmtNum.format(visibleRows.length)} / ${fmtNum.format(rows.length)})</button>`
        : "";
  box.innerHTML = `<div class="table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody>${foot}</table></div>${more}`;
}

async function loadOrders(reset) {
  const offset = reset ? 0 : orders.rows.length;
  const res = await api(`/reports/orders?${params({ limit: PAGE, offset })}`);
  orders = { rows: reset ? res.rows : orders.rows.concat(res.rows), total: res.total };
}

function switchTab(name, render = true) {
  tab = name;
  shown = PAGE;
  root.querySelectorAll("[data-tab]").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  const q = $("#rep-tab-q", root);
  if (q) q.value = "";
  if (!render) return;
  if (name === "orders") {
    renderTable();
    loadOrders(true)
      .then(renderTable)
      .catch((ex) => errMsg(ex.message));
  } else {
    renderTable();
  }
}

async function load({ quiet = false } = {}) {
  if (mode === "pivot") {
    ++loadSeq;
    root.classList.remove("rep-loading");
    await pivot.run();
    lastLoaded = Date.now();
    return;
  }
  const seq = ++loadSeq;
  root.classList.toggle("rep-loading", !quiet);
  try {
    const res = await api(`/reports/overview?${params()}`);
    if (seq !== loadSeq) return;
    data = res;
    fillPayments(res.payment_options);
    if (tab === "orders") await loadOrders(true);
    if (seq !== loadSeq) return;
    if (!quiet) shown = PAGE;
    renderKpis();
    renderChart();
    renderTable();
    errMsg("");
    lastLoaded = Date.now();
  } catch (ex) {
    if (seq === loadSeq) errMsg(ex.message || "Hisobot yuklanmadi");
  } finally {
    if (seq === loadSeq) root.classList.remove("rep-loading");
  }
}

async function loadOptions() {
  const org = val("#rep-org");
  options = await api(`/reports/options${org ? `?org_id=${encodeURIComponent(org)}` : ""}`);
  fillOptions();
}

async function download(btn, path, filename) {
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Tayyorlanmoqda…";
  try {
    await apiDownload(path, filename);
  } catch (ex) {
    errMsg(ex.message || "Yuklab bo‘lmadi");
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

function periodTag() {
  return [val("#rep-from"), val("#rep-to")].filter(Boolean).join("_") || "barcha_davr";
}

function bind() {
  root.addEventListener("click", async (e) => {
    const modeBtn = e.target.closest("[data-rep-mode]");
    if (modeBtn) {
      if (modeBtn.dataset.repMode === mode) return;
      await setMode(modeBtn.dataset.repMode);
      load();
      return;
    }
    const presetBtn = e.target.closest("[data-preset]");
    if (presetBtn) {
      const [from, to] = presetRange(presetBtn.dataset.preset);
      setRange(from, to, presetBtn.dataset.preset);
      return;
    }
    const tabBtn = e.target.closest("[data-tab]");
    if (tabBtn) {
      switchTab(tabBtn.dataset.tab);
      return;
    }
    const th = e.target.closest("th[data-sort]");
    if (th) {
      const cur = sortBy[tab];
      const col = TABS[tab].cols.find((c) => c.key === th.dataset.sort);
      const first = col && ["int", "money", "pct"].includes(col.kind) ? "desc" : "asc";
      sortBy[tab] = cur?.key === th.dataset.sort ? { key: cur.key, dir: cur.dir === "asc" ? "desc" : "asc" } : { key: th.dataset.sort, dir: first };
      renderTable();
      return;
    }
    if (e.target.closest("[data-more]")) {
      if (tab === "orders") {
        loadOrders(false)
          .then(renderTable)
          .catch((ex) => errMsg(ex.message));
      } else {
        shown += PAGE;
        renderTable();
      }
      return;
    }
    if (e.target.closest("[data-clear-client]")) {
      clientFilter = null;
      renderClientChip();
      load();
      return;
    }
    const bar = e.target.closest("[data-day]");
    if (bar) {
      setRange(bar.dataset.day, bar.dataset.day, "");
      return;
    }
    if (e.target.closest("a")) return;
    const tr = e.target.closest("#rep-table tbody tr[data-i]");
    if (tr) TABS[tab].click?.(visibleRows[Number(tr.dataset.i)]);
  });

  root.addEventListener("change", async (e) => {
    const id = e.target.id;
    if (id === "rep-from" || id === "rep-to") {
      preset = "";
      markPreset();
      load();
    } else if (id === "rep-org") {
      clientFilter = null;
      renderClientChip();
      ["#rep-agent", "#rep-driver", "#rep-wh"].forEach((s) => {
        const el = $(s, root);
        if (el) el.value = "";
      });
      try {
        await loadOptions();
      } catch (ex) {
        errMsg(ex.message);
      }
      load();
    } else if (["rep-agent", "rep-driver", "rep-wh", "rep-status", "rep-payment"].includes(id)) {
      load();
    } else if (id === "rep-gps") {
      return;
    }
  });

  $("#rep-q", root)?.addEventListener("input", () => {
    clearTimeout(qTimer);
    qTimer = setTimeout(() => load(), 450);
  });
  $("#rep-tab-q", root)?.addEventListener("input", () => {
    shown = PAGE;
    renderTable();
  });
  $("#rep-reset", root)?.addEventListener("click", () => {
    ["#rep-agent", "#rep-driver", "#rep-wh", "#rep-status", "#rep-payment", "#rep-q", "#rep-org"].forEach((s) => {
      const el = $(s, root);
      if (el) el.value = "";
    });
    clientFilter = null;
    renderClientChip();
    const [from, to] = presetRange("30");
    setRange(from, to, "30");
  });
  $("#rep-export-tab", root)?.addEventListener("click", (e) => {
    const title = root.querySelector(`[data-tab="${tab}"]`)?.textContent?.trim() || "Hisobot";
    download(e.currentTarget, `/reports/export?${params({ section: tab })}`, `${title.replace(/\s+/g, "_")}_${periodTag()}.xlsx`);
  });
  $("#rep-export-all", root)?.addEventListener("click", (e) => {
    download(e.currentTarget, `/reports/export?${params({ section: "all" })}`, `Hisobot_${periodTag()}.xlsx`);
  });
  $("#rep-full", root)?.addEventListener("click", (e) => {
    const p = new URLSearchParams();
    if (val("#rep-org")) p.set("org_id", val("#rep-org"));
    p.set("gps_days", val("#rep-gps") || "0");
    const stamp = (options?.today || "").replace(/-/g, "") || "bugun";
    download(e.currentTarget, `/reports/full-export?${p}`, `Nexus_barcha_malumot_${stamp}.xlsx`);
  });
}

export async function init(pane) {
  root = pane;
  if (!bound) {
    bound = true;
    bind();
    pivot.setup({
      root,
      errMsg,
      filters: filterObject,
      globalState,
      applyFilters,
      canExport: () => Boolean(options?.can_export),
      onPayments: fillPayments,
    });
  }
  try {
    await loadOptions();
  } catch (ex) {
    errMsg(ex.message || "Hisobot sozlamalari yuklanmadi");
    return;
  }
  const [from, to] = presetRange(preset);
  $("#rep-from", root).value = from;
  $("#rep-to", root).value = to;
  markPreset();
  renderClientChip();
  await setMode(mode);
  await load();
}

export async function show() {
  if (root && data && Date.now() - lastLoaded > 5000) await load({ quiet: true });
}

export function hide() {
  pivot.hide();
}

export async function refresh() {
  await show();
}

export function destroy() {
  clearTimeout(qTimer);
  pivot.destroy();
  root = null;
  bound = false;
  data = null;
  options = null;
  clientFilter = null;
  tab = "clients";
  preset = "30";
}
