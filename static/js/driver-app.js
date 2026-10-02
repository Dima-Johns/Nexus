const API = "/api";
const L = window.L;
const TOKEN_KEY = "nx_drv_token";

let token = localStorage.getItem(TOKEN_KEY) || "";
let driver = null;
let route = { orders: [], geometry: [], downloaded_at: null };
let map = null;
let line = null;
let markers = [];
let meMarker = null;
let watchId = null;
let scanStream = null;
let lastGpsAt = 0;
let gpsQueue = [];
let lastGps = null;
let reysFilter = localStorage.getItem("nx_drv_reys") || "";
let dateFilter = localStorage.getItem("nx_drv_date") || "";
let qrBusy = false;
const RUN_KEY = "nx_drv_run";
// going=false — zayavka tugadi, keyingisi tavsiya qilingan, haydovchi hali «Borish»ni bosmagan
// manual=true — haydovchi tartibni o‘zi tuzgan, GPS bo‘yicha avtomatik qayta tuzilmaydi
const RUN_EMPTY = { active: false, currentId: null, arrived: false, going: false, manual: false };
let run = { ...RUN_EMPTY };
try {
  const savedRun = JSON.parse(localStorage.getItem(RUN_KEY) || "null");
  if (savedRun && typeof savedRun === "object") run = { ...run, ...savedRun, arrived: false };
} catch {
  /* fresh run */
}
let tab = "map";
// Tartibni o‘zgartirish rejimida: kutilayotgan zayavkalar id'lari yangi tartibda
let editing = null;

function saveRun() {
  localStorage.setItem(RUN_KEY, JSON.stringify({ active: run.active, currentId: run.currentId, going: run.going, manual: run.manual }));
  localStorage.setItem("nx_drv_reys", reysFilter || "");
  localStorage.setItem("nx_drv_date", dateFilter || "");
}
let lastQrText = "";
let lastQrAt = 0;
let starting = false;

function $(id) {
  return document.getElementById(id);
}

function show(id) {
  ["view-login", "view-scan", "view-app"].forEach((name) => $(name).classList.toggle("hidden", name !== id));
}

function nativeApp() {
  try {
    return Boolean(window.NexusNative);
  } catch {
    return false;
  }
}

function nativeCall(name, arg) {
  if (!nativeApp()) return false;
  try {
    if (name === "scanQr") {
      window.NexusNative.scanQr();
      return true;
    }
    if (name === "openRoute") {
      window.NexusNative.openRoute(arg);
      return true;
    }
    if (name === "navigate") {
      if (typeof window.NexusNative.navigate !== "function") return false;
      window.NexusNative.navigate(arg);
      return true;
    }
    if (name === "retry") {
      window.NexusNative.retry();
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("nexus-driver", 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("kv")) db.createObjectStore("kv");
      if (!db.objectStoreNames.contains("gps")) db.createObjectStore("gps", { autoIncrement: true });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function kvSet(key, value) {
  const db = await openDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction("kv", "readwrite");
    tx.objectStore("kv").put(value, key);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

async function kvGet(key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("kv", "readonly");
    const req = tx.objectStore("kv").get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function gpsAdd(point) {
  gpsQueue.push(point);
  const db = await openDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction("gps", "readwrite");
    tx.objectStore("gps").add(point);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

async function gpsDump() {
  const db = await openDb();
  const queued = await new Promise((resolve, reject) => {
    const tx = db.transaction("gps", "readonly");
    const req = tx.objectStore("gps").getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
  return queued.length ? queued : gpsQueue.slice();
}

async function gpsClear() {
  gpsQueue = [];
  const db = await openDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction("gps", "readwrite");
    tx.objectStore("gps").clear();
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

async function api(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (token) headers.Authorization = `Bearer ${token}`;
  let body = opts.body;
  if (body && typeof body === "object" && !(body instanceof FormData)) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(body);
  }
  const res = await fetch(API + path, { ...opts, headers, body });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) {
    token = "";
    localStorage.removeItem(TOKEN_KEY);
    kvSet("token", "").catch(() => {});
    const err = new Error(typeof data.detail === "string" ? data.detail : "Sessiya yaroqsiz");
    err.status = 401;
    throw err;
  }
  if (!res.ok) {
    const d = data.detail;
    throw new Error(typeof d === "string" ? d : "Xatolik");
  }
  return data;
}

function setNet() {
  const on = navigator.onLine;
  const dot = $("profile-dot");
  if (dot) {
    dot.classList.toggle("on", on);
    dot.classList.toggle("off", !on);
  }
  const state = $("drv-state");
  if (state) {
    state.textContent = on ? "Online" : "Offline";
    state.classList.toggle("live", on);
    state.classList.toggle("off", !on);
  }
}

function initials(name) {
  const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "H";
  return (parts[0][0] + (parts[1]?.[0] || "")).toUpperCase();
}

function renderProfile() {
  const name = driver?.name || "Haydovchi";
  $("drv-name").textContent = name;
  $("drv-plate").textContent = driver?.vehicle_plate || "";
  $("drv-initials").textContent = initials(name);
  const rows = [
    ["Telefon", driver?.phone],
    ["Mashina", [driver?.vehicle_plate, driver?.vehicle_type].filter(Boolean).join(" · ")],
    ["Agent", driver?.agent_name ? `${driver.agent_code ? driver.agent_code + " · " : ""}${driver.agent_name}` : ""],
    ["Login", driver?.username],
    ["GPS", gpsState.text],
    ["Marshrut", syncState.text],
  ].filter(([, v]) => v);
  $("profile-rows").innerHTML = rows.map(([k, v]) => `<div class="profile-row"><span>${k}</span><span>${esc(v)}</span></div>`).join("");
  $("profile-rows").classList.toggle("hidden", !rows.length);
}

let outArmed = null;

function openProfile() {
  renderProfile();
  setNet();
  resetLogoutBtn();
  $("profile-sheet")?.classList.remove("hidden");
}

function closeProfile() {
  $("profile-sheet")?.classList.add("hidden");
  resetLogoutBtn();
}

function resetLogoutBtn() {
  clearTimeout(outArmed);
  outArmed = null;
  const btn = $("btn-out");
  if (!btn) return;
  btn.classList.remove("confirm");
  btn.textContent = "Chiqish";
}

// Tasodifan chiqib ketmaslik uchun: birinchi bosish so‘raydi, ikkinchisi chiqaradi
function onLogoutClick() {
  const btn = $("btn-out");
  if (outArmed) {
    closeProfile();
    logout();
    return;
  }
  btn.classList.add("confirm");
  btn.textContent = "Rostdan chiqasizmi? Yana bosing";
  outArmed = setTimeout(resetLogoutBtn, 3500);
}

const INTRO_STARTED = Date.now();

function hideIntro() {
  const el = $("intro");
  if (!el || el.classList.contains("out")) return;
  const minMs = el.classList.contains("quick") ? 1300 : 2100;
  setTimeout(() => {
    el.classList.add("out");
    setTimeout(() => el.remove(), 700);
  }, Math.max(0, minMs - (Date.now() - INTRO_STARTED)));
}

let gpsState = { text: "", live: false };
let syncState = { text: "", warn: false };

function profileOpen() {
  return !$("profile-sheet")?.classList.contains("hidden");
}

function setGps(text, live) {
  gpsState = { text, live: !!live };
  if (profileOpen()) renderProfile();
}

// Holat profil oynasida va yangilash ikonkasidagi nuqtada ko‘rinadi
function setSync(text, warn) {
  syncState = { text, warn: !!warn };
  $("sync-dot")?.classList.toggle("on", !!warn);
  if (profileOpen()) renderProfile();
}

let toastTimer = null;

function toast(text, warn) {
  setSync(text, warn);
  const el = $("toast");
  if (!el || !text) return;
  el.textContent = text;
  el.classList.toggle("warn", !!warn);
  el.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add("hidden"), 2800);
}

function saveSession() {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  kvSet("token", token).catch(() => {});
  kvSet("driver", driver).catch(() => {});
  kvSet("route", route).catch(() => {});
}

function gpsOk(lat, lng) {
  lat = Number(lat);
  lng = Number(lng);
  return lat > 37 && lat < 46 && lng > 55 && lng < 76;
}

function isPlaceholder(lat, lng) {
  lat = Number(lat);
  lng = Number(lng);
  return (
    (Math.abs(lat - 41.3111) < 0.003 && Math.abs(lng - 69.2797) < 0.003) ||
    (Math.abs(lat - 41.31) < 0.003 && Math.abs(lng - 69.28) < 0.003)
  );
}

function reysKey(o) {
  const d = String(o.delivery_date || "").slice(0, 10);
  const r = String(o.route_code || "").trim();
  return `${d}|${r}`;
}

function orderDay(o) {
  return String(o.delivery_date || "").slice(0, 10);
}

function isoDay(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function todayIso() {
  return isoDay(new Date());
}

function tomorrowIso() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return isoDay(d);
}

function formatDayShort(iso) {
  const raw = String(iso || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return "Sana";
  const today = todayIso();
  if (raw === today) return "Bugun";
  if (raw === tomorrowIso()) return "Ertaga";
  const [, m, d] = raw.split("-");
  return `${d}.${m}`;
}

function formatDayLong(iso) {
  const raw = String(iso || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return "—";
  const today = todayIso();
  if (raw === today) return `Bugun · ${raw.slice(8)}.${raw.slice(5, 7)}`;
  if (raw === tomorrowIso()) return `Ertaga · ${raw.slice(8)}.${raw.slice(5, 7)}`;
  return `${raw.slice(8)}.${raw.slice(5, 7)}.${raw.slice(0, 4)}`;
}

function reysLabel(o) {
  const r = String(o.route_code || "").trim();
  if (r) return r;
  return "Reys";
}

function parseReys(key) {
  let raw = String(key || "");
  try {
    raw = decodeURIComponent(raw);
  } catch {
    /* keep */
  }
  const i = raw.indexOf("|");
  if (i < 0) return { delivery_date: dateFilter || "", route_code: raw };
  return { delivery_date: raw.slice(0, i).trim(), route_code: raw.slice(i + 1).trim() };
}

function startFilterBody() {
  if (reysFilter) return parseReys(reysFilter);
  return { delivery_date: dateFilter || todayIso(), route_code: "" };
}

function allOrders() {
  return route.orders || [];
}

function availableDates() {
  const set = new Set();
  allOrders().forEach((o) => {
    const d = orderDay(o);
    if (d) set.add(d);
  });
  return [...set].sort();
}

let dateChosen = false;

function ensureDateFilter() {
  const today = todayIso();
  const valid = /^\d{4}-\d{2}-\d{2}$/.test(dateFilter || "");
  // Haydovchi o‘zi tanlagan sana — zayavka bo‘lmasa ham saqlanadi
  if (dateChosen && valid && dateFilter >= today) return;
  if (valid && dateFilter >= today) return;
  const dates = availableDates();
  if (dates.includes(today)) {
    dateFilter = today;
    return;
  }
  const future = dates.find((d) => d >= today);
  dateFilter = future || today;
}

function shiftDay(iso, delta) {
  const [y, m, d] = String(iso || todayIso()).split("-").map(Number);
  const dt = new Date(y, (m || 1) - 1, d || 1);
  dt.setDate(dt.getDate() + delta);
  return isoDay(dt);
}

function ordersForDate() {
  ensureDateFilter();
  const day = dateFilter;
  return allOrders().filter((o) => {
    const d = orderDay(o);
    if (d) return d === day;
    return day === todayIso();
  });
}

function visibleOrders() {
  const rows = ordersForDate();
  if (!reysFilter) return rows;
  return rows.filter((o) => reysKey(o) === reysFilter);
}

function orderedStops() {
  return visibleOrders()
    .slice()
    .sort((a, b) => Number(a.stop_no || 0) - Number(b.stop_no || 0) || a.id - b.id);
}

function pendingStops() {
  return orderedStops().filter((o) => !["delivered", "returned", "cancelled"].includes(o.status));
}

function currentStop() {
  const pending = pendingStops();
  if (!pending.length) return null;
  if (run.currentId != null) {
    const picked = pending.find((o) => Number(o.id) === Number(run.currentId));
    if (picked) return picked;
  }
  return pending[0];
}

function stopIndex(o) {
  if (!o) return 0;
  return orderedStops().findIndex((x) => x.id === o.id) + 1;
}

function distanceM(a, b) {
  const R = 6371000;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const la1 = (a.lat * Math.PI) / 180;
  const la2 = (b.lat * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function phonePoint() {
  if (lastGps && gpsOk(lastGps.lat, lastGps.lng) && !isPlaceholder(lastGps.lat, lastGps.lng)) {
    return { lat: Number(lastGps.lat), lng: Number(lastGps.lng), name: "Telefon" };
  }
  return null;
}

function navigateTo(o) {
  if (!o || !gpsOk(o.dropoff_lat, o.dropoff_lng)) {
    toast("Bu do‘konda lokatsiya yo‘q", true);
    return false;
  }
  const dest = { lat: Number(o.dropoff_lat), lng: Number(o.dropoff_lng), name: o.client_name || o.code || "Do‘kon" };
  if (nativeCall("navigate", JSON.stringify(dest))) return true;
  const me = phonePoint();
  if (nativeCall("openRoute", JSON.stringify(me ? [me, dest] : [dest]))) return true;
  window.location.href = `https://www.google.com/maps/dir/?api=1&destination=${dest.lat},${dest.lng}&travelmode=driving&dir_action=navigate`;
  return true;
}

function stopIcon(n, kind) {
  const cls = kind === "current" ? "drv-stop current" : kind === "done" ? "drv-stop done" : "drv-stop";
  const html = `<div class="${cls}">${n}</div>`;
  return L.divIcon({ className: "drv-pin", html, iconSize: [28, 28], iconAnchor: [14, 14] });
}

function drawMap() {
  if (!map) {
    map = L.map("map", { zoomControl: false }).setView([41.3111, 69.2797], 12);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19 }).addTo(map);
    map.on("popupopen", (e) => {
      const btn = e.popup.getElement()?.querySelector("[data-go]");
      if (btn) {
        btn.addEventListener("click", () => {
          const o = allOrders().find((x) => Number(x.id) === Number(btn.dataset.go));
          if (o) goToStop(o);
          map.closePopup();
        });
      }
    });
  }
  if (line) {
    map.removeLayer(line);
    line = null;
  }
  markers.forEach((m) => map.removeLayer(m));
  markers = [];
  const cur = run.active ? currentStop() : null;
  const latlngs = [];
  orderedStops().forEach((o, i) => {
    if (!gpsOk(o.dropoff_lat, o.dropoff_lng)) return;
    const n = i + 1;
    const kind = cur && cur.id === o.id ? "current" : o.status === "delivered" ? "done" : "";
    const m = L.marker([o.dropoff_lat, o.dropoff_lng], { icon: stopIcon(n, kind), zIndexOffset: kind === "current" ? 1000 : 0 })
      .addTo(map)
      .bindPopup(
        `<b>${n} · ${o.code || ""}</b><br>${o.client_name || ""}<br>${o.dropoff_address || ""}` +
          `<br><button class="popup-go" data-go="${o.id}" type="button">Bu do‘konga borish</button>`
      );
    markers.push(m);
    latlngs.push([o.dropoff_lat, o.dropoff_lng]);
  });
  const me = phonePoint();
  if (me) {
    const latlng = [me.lat, me.lng];
    if (!meMarker) {
      meMarker = L.circleMarker(latlng, { radius: 8, color: "#0f766e", fillColor: "#5eead4", fillOpacity: 1 }).addTo(map);
    } else meMarker.setLatLng(latlng);
    latlngs.push(latlng);
  }
  if (latlngs.length) map.fitBounds(L.latLngBounds(latlngs), { padding: [36, 36], maxZoom: 15 });
  setTimeout(() => map && map.invalidateSize(), 80);
}

function fillReysFilter() {
  ensureDateFilter();
  const label = $("date-label");
  if (label) label.textContent = formatDayShort(dateFilter);
  const pick = $("date-pick");
  if (pick) {
    pick.min = todayIso();
    pick.value = dateFilter || todayIso();
  }
  const prev = $("date-prev");
  if (prev) prev.disabled = !dateFilter || dateFilter <= todayIso();
  const box = $("reys-chips");
  const count = $("reys-count");
  const dayRows = ordersForDate();
  const groups = new Map();
  dayRows.forEach((o) => {
    const key = reysKey(o);
    if (!groups.has(key)) groups.set(key, { key, label: reysLabel(o), n: 0 });
    groups.get(key).n += 1;
  });
  if (reysFilter && !groups.has(reysFilter)) reysFilter = "";
  const total = dayRows.length;
  const chips = [
    `<button type="button" class="reys-chip${!reysFilter ? " active" : ""}" data-reys="">Barchasi <span class="n">${total}</span></button>`,
  ];
  [...groups.values()]
    .sort((a, b) => a.label.localeCompare(b.label, "uz"))
    .forEach((g) => {
      const active = reysFilter === g.key ? " active" : "";
      chips.push(
        `<button type="button" class="reys-chip${active}" data-reys="${esc(g.key)}">${esc(g.label)} <span class="n">${g.n}</span></button>`
      );
    });
  if (box) box.innerHTML = chips.join("");
  if (count) count.textContent = `${visibleOrders().length}/${total || allOrders().length}`;
  saveRun();
}

function setDateFilter(iso, resetReys = true) {
  let next = String(iso || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(next)) return;
  if (next < todayIso()) next = todayIso();
  dateChosen = true;
  dateFilter = next;
  if (resetReys) reysFilter = "";
  run.currentId = null;
  run.arrived = false;
  run.going = false;
  run.manual = false;
  editing = null;
  saveRun();
  fillReysFilter();
  drawMap();
  renderList();
  syncStartUi();
}

function openDatePicker() {
  ensureDateFilter();
  const pick = $("date-pick");
  if (!pick) return;
  pick.min = todayIso();
  pick.value = dateFilter || todayIso();
  try {
    if (typeof pick.showPicker === "function") pick.showPicker();
  } catch {
    /* Android WebView: transparent input + indicator opens calendar */
  }
}

function onReysChange(key) {
  reysFilter = key || "";
  run.currentId = null;
  run.arrived = false;
  run.going = false;
  run.manual = false;
  editing = null;
  saveRun();
  fillReysFilter();
  drawMap();
  renderList();
  syncStartUi();
}

function esc(v) {
  return String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
}

const START_ICON = `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 2.5 20 21l-8-4.5L4 21z"/></svg>`;

function syncStartUi() {
  const overlay = $("start-overlay");
  const btn = $("btn-start");
  const pending = pendingStops();
  const total = orderedStops().length;
  const cur = run.active ? currentStop() : null;
  if (run.active && !cur && total > 0 && !pending.length) {
    run.active = false;
    run.currentId = null;
    saveRun();
  }
  if (btn) {
    btn.disabled = !pending.length || !!editing;
    const label = run.active && cur ? (run.going ? "Navigator" : "Borish") : "Boshlash";
    const sub = !pending.length ? (total ? "Hamma zayavkalar yetkazildi" : "Zayavka yo‘q") : run.active && cur ? `${stopIndex(cur)}. ${cur.client_name || cur.code || "Do‘kon"}` : `${pending.length} ta zayavka`;
    btn.innerHTML = `${START_ICON}<span class="start-txt"><b>${label}</b><small>${esc(sub)}</small></span>`;
  }
  const badge = $("list-badge");
  if (badge) {
    badge.textContent = String(pending.length);
    badge.classList.toggle("hidden", !pending.length);
  }
  if (!overlay) return;
  overlay.classList.toggle("hidden", total === 0 || tab !== "map");
  if (!total) return;
  if (run.active && cur) {
    const n = stopIndex(cur);
    const distText = stopDistText(cur);
    const next = nextAfter(cur);
    const pickBtn = pending.length > 1 ? `<button class="btn ghost" type="button" data-pick-open>Boshqasini tanlash</button>` : "";
    overlay.classList.toggle("arrived", !!(run.going && run.arrived));
    overlay.classList.toggle("suggest", !run.going);
    const head = `
      <div class="cur-label">${run.going ? "Hozir shu zayavkaga boryapsiz" : "Keyingi zayavka"}</div>
      <div class="cur-head"><span class="stop">${n}</span><div style="flex:1;min-width:0"><b>${esc(cur.client_name || cur.code || "Do‘kon")}</b><div class="muted">${esc(cur.dropoff_address || "")}</div></div><span class="muted cur-meta">${n}/${total}${distText ? `<br>${distText}` : ""}</span></div>`;
    if (!run.going) {
      overlay.innerHTML = `${head}
        <p class="cur-hint">${run.manual ? "Siz tuzgan tartib bo‘yicha keyingi zayavka." : "Reja telefon joylashuvidan yaqinidan uzog‘iga qayta tuzildi."} Shu zayavkaga borasizmi?</p>
        <div class="result-row">
          <button class="btn primary" type="button" data-go-cur="${cur.id}">Borish</button>
          ${pickBtn}
        </div>`;
      return;
    }
    overlay.innerHTML = `${head}
      <p class="cur-hint">${run.arrived ? "Do‘konga yetib keldingiz. «Yetkazildi» ni bosing — keyingi zayavka ko‘rsatiladi." : "Do‘konga yetib borgach «Yetkazildi» ni bosing, shundan keyin keyingi zayavka ko‘rsatiladi."}</p>
      <div class="result-row">
        <button class="btn ok ${run.arrived ? "pulse" : ""}" id="btn-delivered" type="button" data-done="${cur.id}">Yetkazildi</button>
        <button class="btn warn" type="button" data-return="${cur.id}">Qaytarildi</button>
      </div>
      <div class="cur-next">
        <span class="muted">${next ? `Keyingisi: <b>${stopIndex(next)}. ${esc(next.client_name || next.code || "Do‘kon")}</b>` : "Bu oxirgi zayavka"}</span>
        ${pickBtn}
      </div>`;
    return;
  }
  overlay.classList.remove("arrived", "suggest");
  const first = pending[0];
  overlay.innerHTML = `<p id="start-hint">${
    pending.length
      ? `Reysda ${pending.length} ta zayavka. ${run.manual ? "Tartibni o‘zingiz tuzdingiz" : "Reja skladdan tuzilgan"} — 1-zayavka: <b>${esc(first.client_name || first.code || "Do‘kon")}</b>. «Boshlash» ni bosing.`
      : "Bu reysdagi hamma zayavkalar yetkazildi."
  }</p>`;
}

function stopDistText(o) {
  const me = phonePoint();
  if (!me || !gpsOk(o.dropoff_lat, o.dropoff_lng)) return "";
  const d = distanceM(me, { lat: Number(o.dropoff_lat), lng: Number(o.dropoff_lng) });
  return d >= 1000 ? `${(d / 1000).toFixed(1)} km` : `${Math.round(d)} m`;
}

function nextAfter(cur) {
  return pendingStops().find((o) => !cur || o.id !== cur.id) || null;
}

// Oflayn holatda: tanlangan zayavka birinchi, qolganlari undan (yoki telefondan) eng yaqinidan boshlab
function localReplan(firstId, me) {
  const pending = pendingStops();
  if (!pending.length) return;
  const first = firstId != null ? pending.find((o) => Number(o.id) === Number(firstId)) : null;
  let rest = pending.filter((o) => o !== first);
  const ordered = first ? [first] : [];
  let cur = first && gpsOk(first.dropoff_lat, first.dropoff_lng) ? { lat: Number(first.dropoff_lat), lng: Number(first.dropoff_lng) } : me;
  const noGps = rest.filter((o) => !gpsOk(o.dropoff_lat, o.dropoff_lng));
  rest = rest.filter((o) => gpsOk(o.dropoff_lat, o.dropoff_lng));
  while (rest.length) {
    let j = 0;
    if (cur) {
      let best = Infinity;
      rest.forEach((o, i) => {
        const d = distanceM(cur, { lat: Number(o.dropoff_lat), lng: Number(o.dropoff_lng) });
        if (d < best) {
          best = d;
          j = i;
        }
      });
    }
    const [o] = rest.splice(j, 1);
    ordered.push(o);
    cur = { lat: Number(o.dropoff_lat), lng: Number(o.dropoff_lng) };
  }
  [...ordered, ...noGps].forEach((o, i) => {
    o.stop_no = i + 1;
  });
  saveSession();
}

function isDone(o) {
  return ["delivered", "returned", "cancelled"].includes(o.status);
}

// Qo‘lda tuzilgan tartibni telefonga va serverga yozadi; ids — kutilayotgan zayavkalar yangi tartibda
async function saveOrder(ids) {
  const full = [...orderedStops().filter(isDone).map((o) => o.id), ...ids];
  full.forEach((id, i) => {
    const o = allOrders().find((x) => Number(x.id) === Number(id));
    if (o) o.stop_no = i + 1;
  });
  saveSession();
  drawMap();
  renderList();
  syncStartUi();
  if (!navigator.onLine) {
    toast("Offline: tartib telefonda saqlandi", true);
    return;
  }
  try {
    applyRoute(await api("/driver/reorder", { method: "POST", body: { ...startFilterBody(), order_ids: full } }));
    return true;
  } catch (err) {
    toast(err.message || "Tartib serverga yozilmadi", true);
  }
}

async function replan(firstId) {
  if (run.manual) {
    // Qo‘lda tuzilgan tartib saqlanadi — tanlangan zayavka faqat boshiga o‘tadi
    if (firstId == null) {
      drawMap();
      renderList();
      syncStartUi();
      return;
    }
    const ids = pendingStops().map((o) => o.id);
    await saveOrder([firstId, ...ids.filter((id) => Number(id) !== Number(firstId))]);
    return;
  }
  const me = phonePoint();
  localReplan(firstId, me);
  drawMap();
  renderList();
  syncStartUi();
  if (!navigator.onLine) return;
  try {
    const data = await api("/driver/replan", {
      method: "POST",
      body: { ...startFilterBody(), first_id: firstId ?? null, lat: me ? me.lat : null, lng: me ? me.lng : null },
    });
    applyRoute(data);
  } catch (err) {
    toast(err.message || "Reja serverga yozilmadi", true);
  }
}

async function goToStop(o) {
  if (!o) return;
  closePick();
  const wasFirst = pendingStops()[0]?.id === o.id;
  run.active = true;
  run.currentId = o.id;
  run.arrived = false;
  run.going = true;
  saveRun();
  if (navigator.onLine && !(driver?.status === "on_route" || route.started)) {
    try {
      applyRoute(await api("/driver/start", { method: "POST", body: startFilterBody() }));
    } catch {
      /* oflayn — mahalliy reja bilan davom etamiz */
    }
  }
  drawMap();
  renderList();
  syncStartUi();
  navigateTo(o);
  if (!wasFirst) replan(o.id);
}

async function afterStopDone(id, result) {
  if (Number(run.currentId) === Number(id)) run.currentId = null;
  run.arrived = false;
  run.going = false;
  saveRun();
  const done = allOrders().find((o) => Number(o.id) === Number(id));
  if (done) done.status = result || "delivered";
  if (!run.active) {
    await pullRoute();
    return;
  }
  if (pendingStops().length) await replan(null);
  else await pullRoute();
  const next = pendingStops()[0];
  if (next) {
    run.currentId = next.id;
    run.going = false;
    saveRun();
    if (navigator.vibrate) navigator.vibrate(120);
    toast(`Keyingi: ${next.client_name || next.code || "zayavka"}`, false);
    drawMap();
    renderList();
    syncStartUi();
  } else {
    run.active = false;
    saveRun();
    syncStartUi();
    toast("Reys yakunlandi", false);
  }
}

function openPick() {
  const sheet = $("pick-sheet");
  const box = $("pick-list");
  if (!sheet || !box) return;
  const sub = $("pick-sub");
  if (sub) {
    sub.textContent = run.manual
      ? "Tanlangan zayavka birinchi bo‘ladi, qolganlari siz tuzgan tartibda qoladi."
      : "Tanlangan zayavka birinchi bo‘ladi, qolganlari undan yaqinidan uzog‘iga qayta tuziladi.";
  }
  const cur = run.active ? currentStop() : null;
  const suggested = run.going ? nextAfter(cur) : cur;
  box.innerHTML = pendingStops()
    .map((o) => {
      const tag = run.going && cur && cur.id === o.id ? `<span class="pill live">Hozirgi</span>` : suggested && suggested.id === o.id ? `<span class="pill">Tavsiya</span>` : "";
      const dist = stopDistText(o);
      const gps = gpsOk(o.dropoff_lat, o.dropoff_lng);
      return `<button type="button" class="pick-row" data-pick="${o.id}" ${gps ? "" : "disabled"}>
        <span class="stop">${stopIndex(o)}</span>
        <span class="pick-txt"><b>${esc(o.client_name || o.code || "Do‘kon")}</b><span class="muted">${esc(o.dropoff_address || (gps ? "" : "Lokatsiya yo‘q"))}</span></span>
        <span class="pick-side">${tag}${dist ? `<span class="muted">${dist}</span>` : ""}</span>
      </button>`;
    })
    .join("");
  sheet.classList.remove("hidden");
}

function closePick() {
  $("pick-sheet")?.classList.add("hidden");
}

const PROOF_REASONS = {
  fridge_yes: "Muzlatgich bor",
  foreign_goods: "Begona mahsulot bor",
  fridge_no: "Muzlatgich yo‘q",
};
let proof = { id: null, result: "", reason: "", blob: null, url: "" };

function proofStep(step) {
  $("proof-reasons")?.classList.toggle("hidden", step !== "reason");
  $("proof-shoot")?.classList.toggle("hidden", step !== "shoot");
  $("proof-preview")?.classList.toggle("hidden", step !== "preview");
}

function proofErr(text) {
  const el = $("proof-err");
  if (el) el.textContent = text || "";
}

function openProof(id, result) {
  if (!navigator.onLine) {
    toast("Offline: internet chiqqach belgilang", true);
    return;
  }
  const o = allOrders().find((x) => Number(x.id) === Number(id));
  if (proof.url) URL.revokeObjectURL(proof.url);
  proof = { id: Number(id), result, reason: "", blob: null, url: "" };
  $("proof-title").textContent = result === "delivered" ? "Yetkazildi" : "Qaytarildi";
  $("proof-sheet").classList.toggle("returned", result === "returned");
  $("proof-sub").textContent = o ? `${o.client_name || o.code || "Do‘kon"}${o.dropoff_address ? " · " + o.dropoff_address : ""}` : "";
  $("proof-tag").textContent = result === "returned" ? "Qaytarildi" : "";
  proofErr("");
  proofStep(result === "delivered" ? "reason" : "shoot");
  $("proof-sheet").classList.remove("hidden");
}

function closeProof() {
  $("proof-sheet")?.classList.add("hidden");
  if (proof.url) URL.revokeObjectURL(proof.url);
  proof = { id: null, result: "", reason: "", blob: null, url: "" };
}

function takeProofPhoto() {
  const input = $("proof-file");
  if (!input) return;
  input.value = "";
  input.click();
}

function compressImage(file, maxSide = 1600, quality = 0.78) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
      const w = Math.round(img.naturalWidth * scale);
      const h = Math.round(img.naturalHeight * scale);
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      canvas.getContext("2d").drawImage(img, 0, 0, w, h);
      URL.revokeObjectURL(url);
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Rasm o‘qilmadi"))), "image/jpeg", quality);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Rasm o‘qilmadi"));
    };
    img.src = url;
  });
}

async function onProofFile() {
  const file = $("proof-file")?.files?.[0];
  if (!file || !proof.id) return;
  proofErr("");
  try {
    const blob = await compressImage(file).catch(() => file);
    if (proof.url) URL.revokeObjectURL(proof.url);
    proof.blob = blob;
    proof.url = URL.createObjectURL(blob);
    $("proof-img").src = proof.url;
    $("proof-tag").textContent = proof.result === "delivered" ? PROOF_REASONS[proof.reason] || "" : "Qaytarildi";
    proofStep("preview");
  } catch (err) {
    proofErr(err.message || "Rasm o‘qilmadi");
  }
}

async function sendProof() {
  if (!proof.id || !proof.blob) return;
  const btn = $("proof-send");
  if (btn) btn.disabled = true;
  proofErr("");
  try {
    const form = new FormData();
    form.append("result", proof.result);
    form.append("reason", proof.result === "delivered" ? proof.reason : "");
    form.append("photo", proof.blob, `proof_${proof.id}.jpg`);
    const id = proof.id;
    const result = proof.result;
    const label = result === "delivered" ? "Yetkazildi" : "Qaytarildi";
    await api(`/driver/orders/${id}/proof`, { method: "POST", body: form });
    closeProof();
    toast(`${label} ✓`, false);
    await afterStopDone(id, result);
  } catch (err) {
    proofErr(err.message || "Yuborilmadi");
  } finally {
    if (btn) btn.disabled = false;
  }
}

function renderListHead() {
  const head = $("list-head");
  if (!head) return;
  const pending = pendingStops();
  if (editing) {
    head.innerHTML = `
      <div class="lh-txt"><b>Tartibni o‘zgartirish</b><span class="muted">Sudrang yoki ↑ ↓ tugmalarini bosing</span></div>
      <div class="lh-actions">
        <button class="btn ghost" type="button" data-edit-cancel>Bekor</button>
        <button class="btn primary sm" type="button" data-edit-save>Saqlash</button>
      </div>`;
    return;
  }
  const mode = run.manual ? "Siz tuzgan tartib" : "Avtomatik tartib";
  head.innerHTML = `
    <div class="lh-txt"><b>Borish ketma-ketligi</b><span class="muted">${pending.length ? `${mode} · ${pending.length} ta kutilmoqda` : "Kutilayotgan zayavka yo‘q"}</span></div>
    <button class="btn ghost lh-edit" type="button" data-edit-start ${pending.length > 1 ? "" : "disabled"}>
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 4v16M7 4 3.5 7.5M7 4l3.5 3.5M17 20V4M17 20l-3.5-3.5M17 20l3.5-3.5"/></svg>
      O‘zgartirish
    </button>`;
}

function editRows() {
  const pending = pendingStops();
  const byId = new Map(pending.map((o) => [Number(o.id), o]));
  const rows = editing.map((id) => byId.get(Number(id))).filter(Boolean);
  pending.forEach((o) => {
    if (!rows.includes(o)) rows.push(o);
  });
  editing = rows.map((o) => o.id);
  return rows;
}

function renderEditList(box) {
  const doneN = orderedStops().filter(isDone).length;
  const rows = editRows();
  const last = rows.length - 1;
  box.innerHTML =
    (doneN ? `<div class="re-done muted">${doneN} ta zayavka yakunlangan — ular ro‘yxat boshida qoladi</div>` : "") +
    rows
      .map(
        (o, i) => `<div class="re-row" data-id="${o.id}">
        <span class="re-grip" data-grip aria-label="Sudrash">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><circle cx="9" cy="6" r="1.6"/><circle cx="15" cy="6" r="1.6"/><circle cx="9" cy="12" r="1.6"/><circle cx="15" cy="12" r="1.6"/><circle cx="9" cy="18" r="1.6"/><circle cx="15" cy="18" r="1.6"/></svg>
        </span>
        <span class="stop">${doneN + i + 1}</span>
        <span class="re-txt"><b>${esc(o.client_name || o.code || "Do‘kon")}</b><span class="muted">${esc(o.dropoff_address || o.code || "")}</span></span>
        <span class="re-arrows">
          <button type="button" data-move="-1" ${i === 0 ? "disabled" : ""} aria-label="Yuqoriga">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m6 15 6-6 6 6"/></svg>
          </button>
          <button type="button" data-move="1" ${i === last ? "disabled" : ""} aria-label="Pastga">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>
          </button>
        </span>
      </div>`
      )
      .join("") +
    `<button type="button" class="btn ghost re-auto" data-edit-auto>Avtomatik tartibga qaytarish (GPS bo‘yicha)</button>`;
}

function startReorder() {
  if (pendingStops().length < 2) return;
  editing = pendingStops().map((o) => o.id);
  renderList();
  syncStartUi();
}

function cancelReorder() {
  editing = null;
  renderList();
  syncStartUi();
}

async function saveReorder() {
  if (!editing) return;
  const ids = editRows().map((o) => o.id);
  editing = null;
  run.manual = true;
  // Hali yo‘lga chiqmagan bo‘lsa — yangi tartibdagi birinchi zayavka tavsiya qilinadi
  if (!run.going) run.currentId = null;
  saveRun();
  if (await saveOrder(ids)) toast("Ketma-ketlik saqlandi", false);
}

async function autoReorder() {
  editing = null;
  run.manual = false;
  if (!run.going) run.currentId = null;
  saveRun();
  await replan(run.going ? run.currentId : null);
  toast("Tartib GPS bo‘yicha qayta tuzildi", false);
}

function moveEdit(id, delta) {
  const i = editing.findIndex((x) => Number(x) === Number(id));
  const j = i + delta;
  if (i < 0 || j < 0 || j >= editing.length) return;
  [editing[i], editing[j]] = [editing[j], editing[i]];
  renderList();
}

// Barmoq bilan sudrash: qator barmoq ostidagi joyga ko‘chadi, qo‘yib yuborilganda tartib yoziladi
let drag = null;

function onGripDown(e) {
  const grip = e.target.closest("[data-grip]");
  if (!grip || !editing) return;
  const row = grip.closest(".re-row");
  e.preventDefault();
  try {
    grip.setPointerCapture(e.pointerId);
  } catch {
    /* capture bo‘lmasa ham ro‘yxat ustidagi harakatlar yetadi */
  }
  drag = { row, grip, id: e.pointerId };
  row.classList.add("dragging");
}

function onGripMove(e) {
  if (!drag || e.pointerId !== drag.id) return;
  const box = $("list");
  const rect = box.getBoundingClientRect();
  if (e.clientY < rect.top + 40) box.scrollTop -= 10;
  else if (e.clientY > rect.bottom - 40) box.scrollTop += 10;
  const rows = [...box.querySelectorAll(".re-row")].filter((r) => r !== drag.row);
  const before = rows.find((r) => {
    const b = r.getBoundingClientRect();
    return e.clientY < b.top + b.height / 2;
  });
  if (before) {
    if (drag.row.nextElementSibling !== before) box.insertBefore(drag.row, before);
  } else {
    const lastRow = rows[rows.length - 1];
    if (lastRow && lastRow.nextElementSibling !== drag.row) lastRow.after(drag.row);
  }
}

function onGripUp(e) {
  if (!drag || e.pointerId !== drag.id) return;
  drag.row.classList.remove("dragging");
  drag = null;
  editing = [...$("list").querySelectorAll(".re-row")].map((r) => Number(r.dataset.id));
  renderList();
}

function renderList() {
  const box = $("list");
  const rows = orderedStops();
  renderListHead();
  if (!rows.length) {
    box.innerHTML = `<div class="empty">${navigator.onLine ? "Bu sana/reysda zayavka yo‘q. Sanani yoki reysni almashtiring." : "Keshda marshrut yo‘q. Internet chiqishi bilan yangilang."}</div>`;
    return;
  }
  if (editing) {
    if (!drag) renderEditList(box);
    return;
  }
  const cur = run.active ? currentStop() : null;
  box.innerHTML = rows
    .map((o, i) => {
      const gps = gpsOk(o.dropoff_lat, o.dropoff_lng);
      const isCur = cur && cur.id === o.id;
      return `<article class="card ${isCur ? "current" : ""}" data-id="${o.id}">
        <div class="top">
          <span class="stop">${i + 1}</span>
          <div style="flex:1">
            <b>${esc(o.code || "")}</b>
            <div>${esc(o.client_name || "Mijoz")}</div>
          </div>
          ${isCur ? `<span class="pill live">${run.going ? "Hozirgi" : "Keyingi"}</span>` : ""}
        </div>
        <div class="muted">${esc(o.dropoff_address || "")}</div>
        <div class="muted">${[o.route_code, o.delivery_date, o.window_start && o.window_end ? `${o.window_start}–${o.window_end}` : ""].filter(Boolean).map(esc).join(" · ")}</div>
        ${gps ? "" : `<div class="muted">Lokatsiya yo‘q</div>`}
        <div class="actions">
          <button class="btn primary" data-nav="${o.id}" type="button" ${gps ? "" : "disabled"}>Borish</button>
          <button class="btn ok" data-done="${o.id}" type="button">Yetkazildi</button>
          <button class="btn warn" data-return="${o.id}" type="button">Qaytarildi</button>
        </div>
      </article>`;
    })
    .join("");
}

function applyRoute(data) {
  const keepReys = reysFilter;
  const keepDate = dateFilter;
  driver = data.driver || driver;
  route = {
    orders: data.orders || [],
    geometry: data.geometry || [],
    warehouse: data.warehouse || null,
    started: Boolean(data.started || driver?.status === "on_route"),
    downloaded_at: data.downloaded_at || new Date().toISOString(),
  };
  reysFilter = keepReys;
  dateFilter = keepDate;
  renderProfile();
  saveSession();
  fillReysFilter();
  drawMap();
  renderList();
  syncStartUi();
  const when = route.downloaded_at ? new Date(route.downloaded_at) : null;
  const label = when && !Number.isNaN(when.getTime()) ? `Yuklandi ${when.toLocaleTimeString("uz-UZ", { hour: "2-digit", minute: "2-digit" })}` : "Kesh";
  setSync(label, !navigator.onLine);
}

async function startRun() {
  if (starting) return;
  const first = currentStop();
  if (!first) {
    toast("Tanlangan reysda do‘kon yo‘q", true);
    return;
  }
  starting = true;
  const btn = $("btn-start");
  if (btn) btn.disabled = true;
  try {
    if (navigator.onLine && !run.active) {
      try {
        const data = await api("/driver/start", {
          method: "POST",
          body: startFilterBody(),
        });
        applyRoute(data);
      } catch (err) {
        toast(err.message || "Serverga yozilmadi", true);
      }
    }
    const target = currentStop() || first;
    if (!run.going) run.arrived = false;
    run.active = true;
    run.currentId = target.id;
    run.going = true;
    saveRun();
    drawMap();
    renderList();
    navigateTo(target);
  } finally {
    starting = false;
    syncStartUi();
  }
}

async function flushGps() {
  const points = await gpsDump();
  if (!token || !navigator.onLine) {
    if (points.length) setSync(`GPS kesh: ${points.length}`, true);
    return 0;
  }
  try {
    await api("/driver/location", { method: "POST", body: { points } });
    if (points.length) await gpsClear();
    return points.length;
  } catch {
    if (points.length) setSync(`GPS kesh: ${points.length}`, true);
    return 0;
  }
}

const BEAT_MS = 60000;
let beatTimer = null;
let lastQueuedAt = 0;

function queuePoint(point) {
  lastQueuedAt = Date.now();
  return gpsAdd(point).catch(() => {});
}

async function heartbeat() {
  if (!token) return;
  if (lastGps && Date.now() - lastQueuedAt >= BEAT_MS - 5000) {
    await queuePoint({
      lat: lastGps.lat,
      lng: lastGps.lng,
      heading: lastGps.heading || 0,
      accuracy: lastGps.accuracy || 0,
      speed: lastGps.speed || 0,
      recorded_at: new Date().toISOString(),
      offline: !navigator.onLine,
    });
  }
  await flushGps();
}

function startHeartbeat() {
  if (beatTimer) return;
  heartbeat().catch(() => {});
  beatTimer = setInterval(() => heartbeat().catch(() => {}), BEAT_MS);
}

function stopHeartbeat() {
  if (beatTimer) clearInterval(beatTimer);
  beatTimer = null;
}

function nativeTracking(on) {
  try {
    if (!window.NexusNative) return;
    if (on && typeof window.NexusNative.startTracking === "function") window.NexusNative.startTracking(token);
    if (!on && typeof window.NexusNative.stopTracking === "function") window.NexusNative.stopTracking();
  } catch {
    /* eski APK */
  }
}

async function pullRoute() {
  if (!token) return;
  if (!navigator.onLine) {
    const cached = await kvGet("route");
    if (cached) applyRoute(cached);
    setSync("Offline kesh", true);
    return;
  }
  const points = await gpsDump();
  const data = await api("/driver/sync", { method: "POST", body: { points } });
  await gpsClear();
  applyRoute(data);
}

function onPos(pos) {
  const point = {
    lat: pos.coords.latitude,
    lng: pos.coords.longitude,
    heading: pos.coords.heading || 0,
    accuracy: pos.coords.accuracy || 0,
    speed: pos.coords.speed || 0,
    recorded_at: new Date().toISOString(),
    offline: !navigator.onLine,
  };
  const now = Date.now();
  if (now - lastGpsAt < 8000) return;
  lastGpsAt = now;
  const firstFix = !lastGps;
  lastGps = { lat: point.lat, lng: point.lng, heading: point.heading, accuracy: point.accuracy, speed: point.speed };
  setGps(`GPS ±${Math.round(point.accuracy)}m`, true);
  if (map) {
    const latlng = [point.lat, point.lng];
    if (!meMarker) {
      meMarker = L.circleMarker(latlng, { radius: 8, color: "#0f766e", fillColor: "#5eead4", fillOpacity: 1 }).addTo(map);
    } else meMarker.setLatLng(latlng);
  }
  if (run.active) {
    const cur = run.going ? currentStop() : null;
    if (cur && gpsOk(cur.dropoff_lat, cur.dropoff_lng)) {
      const d = distanceM({ lat: point.lat, lng: point.lng }, { lat: Number(cur.dropoff_lat), lng: Number(cur.dropoff_lng) });
      const near = d <= Math.max(120, Math.min(300, point.accuracy * 2 || 0));
      if (near && !run.arrived && navigator.vibrate) navigator.vibrate([200, 100, 200]);
      run.arrived = near;
    }
    syncStartUi();
  }
  // Serverga daqiqada bir marta; birinchi nuqta darhol
  if (firstFix || now - lastQueuedAt >= BEAT_MS) {
    queuePoint(point).then(() => {
      if (navigator.onLine) return flushGps();
      return gpsDump().then((q) => setSync(`GPS kesh: ${q.length}`, true));
    });
  }
}

function startGps() {
  if (!navigator.geolocation || watchId != null) return;
  watchId = navigator.geolocation.watchPosition(onPos, () => setGps("GPS yo‘q", false), {
    enableHighAccuracy: true,
    maximumAge: 5000,
    timeout: 20000,
  });
}

async function enterApp(payload) {
  token = payload.token;
  driver = payload.driver;
  localStorage.setItem(TOKEN_KEY, token);
  saveSession();
  show("view-app");
  renderProfile();
  drawMap();
  startGps();
  startHeartbeat();
  nativeTracking(true);
  try {
    await pullRoute();
  } catch (err) {
    const cached = await kvGet("route");
    if (cached) applyRoute(cached);
    else setSync(err.message || "Yuklanmadi", true);
  }
}

async function login(ev) {
  ev.preventDefault();
  $("login-err").textContent = "";
  try {
    const data = await api("/auth/driver-login", {
      method: "POST",
      body: { username: $("login-user").value.trim(), password: $("login-pass").value },
    });
    await enterApp(data);
  } catch (err) {
    $("login-err").textContent = err.message || "Kirish xato";
  }
}

function stopScan() {
  if (scanStream) {
    scanStream.getTracks().forEach((t) => t.stop());
    scanStream = null;
  }
  const reader = $("reader");
  if (reader) reader.innerHTML = "";
}

function qrTokenFromRaw(raw) {
  const text = String(raw || "").trim();
  if (!text) return "";
  try {
    const data = JSON.parse(text);
    if (data && typeof data === "object") {
      return String(data.token || data.qr_token || data.t || text);
    }
  } catch {
    /* raw token */
  }
  return text;
}

async function loginQr(raw) {
  const payload = String(raw || "").trim();
  if (!payload) return;
  const now = Date.now();
  if (qrBusy || (payload === lastQrText && now - lastQrAt < 2500)) return;
  lastQrText = payload;
  lastQrAt = now;
  qrBusy = true;
  stopScan();
  show("view-login");
  $("login-err").textContent = "";
  try {
    const data = await api("/auth/driver-qr", {
      method: "POST",
      body: { token: payload },
    });
    await enterApp(data);
  } catch (err) {
    const extracted = qrTokenFromRaw(payload);
    if (extracted && extracted !== payload) {
      try {
        const data = await api("/auth/driver-qr", { method: "POST", body: { token: extracted } });
        await enterApp(data);
        return;
      } catch (err2) {
        $("login-err").textContent = err2.message || "QR yaroqsiz";
        return;
      }
    }
    $("login-err").textContent = err.message || "QR yaroqsiz";
  } finally {
    qrBusy = false;
  }
}

async function startScan() {
  $("login-err").textContent = "";
  $("scan-err").textContent = "";
  if (nativeCall("scanQr")) return;
  show("view-scan");
  const box = $("reader");
  box.innerHTML = "";
  try {
    scanStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false });
    const video = document.createElement("video");
    video.setAttribute("playsinline", "true");
    video.autoplay = true;
    video.srcObject = scanStream;
    box.appendChild(video);
    await video.play();
    if (window.BarcodeDetector) {
      const det = new window.BarcodeDetector({ formats: ["qr_code"] });
      const loop = async () => {
        if (!scanStream) return;
        try {
          const codes = await det.detect(video);
          if (codes && codes[0]?.rawValue) {
            await loginQr(codes[0].rawValue);
            return;
          }
        } catch {
          /* keep scanning */
        }
        requestAnimationFrame(loop);
      };
      loop();
      return;
    }
    await new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "https://unpkg.com/html5-qrcode@2.3.8/html5-qrcode.min.js";
      s.onload = resolve;
      s.onerror = reject;
      document.head.appendChild(s);
    });
    stopScan();
    const qr = new window.Html5Qrcode("reader");
    await qr.start(
      { facingMode: "environment" },
      { fps: 8, qrbox: 220 },
      (text) => {
        qr.stop().catch(() => {});
        loginQr(text);
      }
    );
  } catch (err) {
    $("scan-err").textContent = nativeApp()
      ? "Kamera ochilmadi. Ilovaga kamera ruxsatini bering."
      : "Kamerani ilova orqali ochib bo‘lmadi. Login/parol bilan kiring.";
  }
}

window.nexusQrResult = (raw) => {
  if (!raw) return;
  loginQr(String(raw));
};

function logout() {
  const old = token;
  if (old && navigator.onLine) {
    fetch(API + "/driver/logout", { method: "POST", headers: { Authorization: `Bearer ${old}` }, keepalive: true }).catch(() => {});
  }
  nativeTracking(false);
  stopHeartbeat();
  token = "";
  driver = null;
  route = { orders: [], geometry: [], downloaded_at: null };
  run = { ...RUN_EMPTY };
  editing = null;
  localStorage.removeItem(RUN_KEY);
  localStorage.removeItem(TOKEN_KEY);
  // Token IndexedDB'da ham saqlanadi — tozalanmasa ilova qayta ochilganda shu akkauntga o‘zi kirib ketadi
  ["token", "driver", "route"].forEach((k) => kvSet(k, null).catch(() => {}));
  if (watchId != null) {
    navigator.geolocation.clearWatch(watchId);
    watchId = null;
  }
  const pass = $("login-pass");
  if (pass) pass.value = "";
  show("view-login");
}

function setTab(next) {
  tab = next === "list" ? "list" : "map";
  document.querySelectorAll("[data-tab]").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  $("map").classList.toggle("hidden", tab !== "map");
  $("list-view").classList.toggle("hidden", tab !== "list");
  if (tab === "map") setTimeout(() => map && map.invalidateSize(), 40);
  syncStartUi();
}

let refreshing = false;

async function refresh() {
  if (refreshing) return;
  refreshing = true;
  const btn = $("btn-sync");
  btn?.classList.add("spin");
  try {
    if (!navigator.onLine) {
      await pullRoute();
      toast("Internet yo‘q — saqlangan marshrut ko‘rsatildi", true);
      return;
    }
    await pullRoute();
    toast("Marshrut yangilandi", false);
  } catch (err) {
    toast(err.message || "Yangilanmadi", true);
  } finally {
    refreshing = false;
    setTimeout(() => btn?.classList.remove("spin"), 300);
  }
}

function bind() {
  $("login-form").addEventListener("submit", login);
  $("btn-qr").addEventListener("click", startScan);
  $("scan-cancel").addEventListener("click", () => {
    stopScan();
    show("view-login");
  });
  $("btn-out").addEventListener("click", onLogoutClick);
  $("btn-profile")?.addEventListener("click", openProfile);
  $("profile-close")?.addEventListener("click", closeProfile);
  $("profile-sheet")?.addEventListener("click", (e) => {
    if (e.target === $("profile-sheet")) closeProfile();
  });
  $("btn-sync").addEventListener("click", refresh);
  $("btn-start")?.addEventListener("click", startRun);
  const onPick = () => {
    const val = $("date-pick")?.value;
    if (val && val !== dateFilter) setDateFilter(val);
  };
  $("date-pick")?.addEventListener("change", onPick);
  $("date-pick")?.addEventListener("input", onPick);
  $("date-pick")?.addEventListener("blur", onPick);
  $("date-pick")?.addEventListener("click", (e) => {
    e.stopPropagation();
    openDatePicker();
  });
  $("date-prev")?.addEventListener("click", () => setDateFilter(shiftDay(dateFilter, -1)));
  $("date-next")?.addEventListener("click", () => setDateFilter(shiftDay(dateFilter, 1)));
  $("reys-chips")?.addEventListener("click", (e) => {
    const chip = e.target.closest("[data-reys]");
    if (!chip) return;
    onReysChange(chip.dataset.reys || "");
  });
  document.querySelectorAll("[data-tab]").forEach((btn) => {
    btn.addEventListener("click", () => setTab(btn.dataset.tab));
  });
  $("list-head")?.addEventListener("click", (e) => {
    if (e.target.closest("[data-edit-start]")) return startReorder();
    if (e.target.closest("[data-edit-cancel]")) return cancelReorder();
    if (e.target.closest("[data-edit-save]")) saveReorder();
  });
  $("list").addEventListener("pointerdown", onGripDown);
  $("list").addEventListener("pointermove", onGripMove);
  $("list").addEventListener("pointerup", onGripUp);
  $("list").addEventListener("pointercancel", onGripUp);
  $("list").addEventListener("click", async (e) => {
    if (editing) {
      const mv = e.target.closest("[data-move]");
      if (mv) return moveEdit(mv.closest(".re-row").dataset.id, Number(mv.dataset.move));
      if (e.target.closest("[data-edit-auto]")) autoReorder();
      return;
    }
    const nav = e.target.closest("[data-nav]");
    if (nav) {
      const o = allOrders().find((x) => Number(x.id) === Number(nav.dataset.nav));
      if (o) goToStop(o);
      return;
    }
    const done = e.target.closest("[data-done]");
    if (done) return openProof(done.dataset.done, "delivered");
    const back = e.target.closest("[data-return]");
    if (back) openProof(back.dataset.return, "returned");
  });
  $("start-overlay")?.addEventListener("click", (e) => {
    const done = e.target.closest("[data-done]");
    if (done) return openProof(done.dataset.done, "delivered");
    const back = e.target.closest("[data-return]");
    if (back) return openProof(back.dataset.return, "returned");
    if (e.target.closest("[data-go-cur]")) return startRun();
    if (e.target.closest("[data-pick-open]")) openPick();
  });
  $("pick-close")?.addEventListener("click", closePick);
  $("pick-sheet")?.addEventListener("click", (e) => {
    if (e.target === $("pick-sheet")) return closePick();
    const row = e.target.closest("[data-pick]");
    if (!row) return;
    const o = allOrders().find((x) => Number(x.id) === Number(row.dataset.pick));
    if (o) goToStop(o);
  });
  $("proof-close")?.addEventListener("click", closeProof);
  $("proof-sheet")?.addEventListener("click", (e) => {
    if (e.target === $("proof-sheet")) closeProof();
  });
  $("proof-reasons")?.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-reason]");
    if (!btn) return;
    proof.reason = btn.dataset.reason;
    takeProofPhoto();
  });
  $("proof-camera")?.addEventListener("click", takeProofPhoto);
  $("proof-retake")?.addEventListener("click", takeProofPhoto);
  $("proof-send")?.addEventListener("click", sendProof);
  $("proof-file")?.addEventListener("change", onProofFile);
  window.addEventListener("online", () => {
    setNet();
    flushGps().then(() => pullRoute()).catch(() => {});
  });
  window.addEventListener("offline", setNet);
  setNet();
}

async function boot() {
  bind();
  try {
    if ("serviceWorker" in navigator) {
      if (nativeApp()) {
        const regs = await navigator.serviceWorker.getRegistrations();
        await Promise.all(regs.map((r) => r.unregister()));
      } else {
        navigator.serviceWorker.register("/driver/sw.js", { scope: "/driver/" }).catch(() => {});
      }
    }
  } catch {
    /* ignore */
  }
  const saved = localStorage.getItem(TOKEN_KEY) || (await kvGet("token"));
  const cachedDriver = await kvGet("driver");
  const cachedRoute = await kvGet("route");
  if (saved) {
    token = saved;
    driver = cachedDriver;
    if (cachedRoute) route = cachedRoute;
    show("view-app");
    hideIntro();
    renderProfile();
    fillReysFilter();
    drawMap();
    renderList();
    syncStartUi();
    startGps();
    startHeartbeat();
    nativeTracking(true);
    try {
      await api("/driver/me");
      await pullRoute();
    } catch (err) {
      if (err?.status === 401) {
        logout();
      } else if (cachedRoute) {
        applyRoute(cachedRoute);
        setSync("Offline kesh", true);
      } else {
        logout();
      }
    }
  } else {
    show("view-login");
    hideIntro();
  }
}

if (nativeApp()) $("intro")?.classList.add("quick");
setTimeout(hideIntro, 4000);
boot();
