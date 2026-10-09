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
let qrScanner = null;
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

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open("nexus-driver", 2);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("kv")) db.createObjectStore("kv");
      if (!db.objectStoreNames.contains("gps")) db.createObjectStore("gps", { autoIncrement: true });
      if (!db.objectStoreNames.contains("outbox")) db.createObjectStore("outbox", { keyPath: "qid", autoIncrement: true });
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      resolve(db);
    };
    req.onerror = () => {
      dbPromise = null;
      reject(req.error);
    };
  });
  return dbPromise;
}

async function storeTx(store, mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const out = fn(tx.objectStore(store));
    tx.oncomplete = () => resolve(out?.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

// Oflayn navbat: tasdiq (rasm bilan), tartib va «Boshlash» internet chiqqach shu tartibda serverga yuboriladi.
// outboxMeta — rasmsiz nusxa: ro‘yxat va server javobi ustiga mahalliy o‘zgarishlarni qo‘yish uchun.
let outboxMeta = [];

function metaOf(item) {
  const { blob, ...meta } = item;
  return meta;
}

async function outboxLoad() {
  try {
    const all = (await storeTx("outbox", "readonly", (s) => s.getAll())) || [];
    outboxMeta = all.map(metaOf);
  } catch {
    outboxMeta = [];
  }
  return outboxMeta;
}

async function outboxPut(item) {
  const qid = await storeTx("outbox", "readwrite", (s) => s.add(item));
  outboxMeta.push(metaOf({ ...item, qid }));
  return qid;
}

async function outboxDel(qid) {
  await storeTx("outbox", "readwrite", (s) => s.delete(qid));
  outboxMeta = outboxMeta.filter((x) => x.qid !== qid);
}

async function outboxClear() {
  outboxMeta = [];
  await storeTx("outbox", "readwrite", (s) => s.clear());
}

function queuedProof(id) {
  return outboxMeta.find((x) => x.type === "proof" && Number(x.orderId) === Number(id)) || null;
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

// gpsQueue — faqat IndexedDB ishlamaganda xotiradagi zaxira
async function gpsAdd(point) {
  try {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction("gps", "readwrite");
      tx.objectStore("gps").add(point);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    gpsQueue.push(point);
  }
}

async function gpsDump() {
  let keys = [];
  let points = [];
  try {
    const db = await openDb();
    [keys, points] = await new Promise((resolve, reject) => {
      const tx = db.transaction("gps", "readonly");
      const store = tx.objectStore("gps");
      const k = store.getAllKeys();
      const v = store.getAll();
      tx.oncomplete = () => resolve([k.result || [], v.result || []]);
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    /* faqat xotiradagi nuqtalar */
  }
  const mem = gpsQueue.slice();
  return { points: points.concat(mem), keys, mem: mem.length };
}

/** Faqat yuborilgan nuqtalar o‘chadi: yuborish paytida qo‘shilganlari navbatda qoladi. */
async function gpsClear(batch) {
  if (!batch) gpsQueue = [];
  else gpsQueue = gpsQueue.slice(batch.mem);
  if (batch && !batch.keys.length) return;
  const db = await openDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction("gps", "readwrite");
    const store = tx.objectStore("gps");
    if (batch) batch.keys.forEach((k) => store.delete(k));
    else store.clear();
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

// Heartbeat, birinchi GPS nuqta va sync bir vaqtda ishlasa bir nuqta ikki marta ketmasin
let gpsLock = Promise.resolve();
function withGpsLock(fn) {
  const run = gpsLock.then(fn);
  gpsLock = run.catch(() => {});
  return run;
}

async function api(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (token) headers.Authorization = `Bearer ${token}`;
  let body = opts.body;
  if (body && typeof body === "object" && !(body instanceof FormData)) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(body);
  }
  const { timeout, ...rest } = opts;
  const ctrl = timeout ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), timeout) : null;
  let res;
  try {
    res = await fetch(API + path, { ...rest, headers, body, signal: ctrl?.signal });
  } finally {
    clearTimeout(timer);
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) {
    const lost = !!headers.Authorization && headers.Authorization === `Bearer ${token}`;
    token = "";
    localStorage.removeItem(TOKEN_KEY);
    kvSet("token", "").catch(() => {});
    const err = new Error(typeof data.detail === "string" ? data.detail : "Sessiya yaroqsiz");
    err.status = 401;
    if (lost) onSessionLost(err.message);
    throw err;
  }
  if (!res.ok) {
    const d = data.detail;
    const err = new Error(typeof d === "string" ? d : "Xatolik");
    err.status = res.status;
    throw err;
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
  const n = queuedCount();
  btn.textContent = n ? `${n} ta tasdiq hali yuborilmagan va o‘chadi! Baribir chiqish — yana bosing` : "Rostdan chiqasizmi? Yana bosing";
  outArmed = setTimeout(resetLogoutBtn, n ? 6000 : 3500);
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

// Yopilganlar (yetkazilgan/qaytarilgan) yopilgan vaqti bo‘yicha boshida, kutilayotganlar — borish tartibida
function orderedStops() {
  const byStop = (a, b) => Number(a.stop_no || 0) - Number(b.stop_no || 0) || a.id - b.id;
  const rows = visibleOrders();
  const done = rows.filter(isDone).sort((a, b) => (Date.parse(a.proof_at || "") || 0) - (Date.parse(b.proof_at || "") || 0) || byStop(a, b));
  return [...done, ...rows.filter((o) => !isDone(o)).sort(byStop)];
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
  const cls = kind ? `drv-stop ${kind}` : "drv-stop";
  const html = `<div class="${cls}">${n}</div>`;
  return L.divIcon({ className: "drv-pin", html, iconSize: [28, 28], iconAnchor: [14, 14] });
}

function drawMap() {
  if (!L) return;
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
    const kind = cur && cur.id === o.id ? "current" : o.status === "delivered" ? "done" : o.status === "returned" ? "back" : "";
    const m = L.marker([o.dropoff_lat, o.dropoff_lng], { icon: stopIcon(n, kind), zIndexOffset: kind === "current" ? 1000 : 0 })
      .addTo(map)
      .bindPopup(
        `<b>${n} · ${esc(o.code)}</b><br>${esc(o.client_name)}<br>${esc(o.dropoff_address)}` +
          (isDone(o)
            ? `<br><b style="color:${o.status === "returned" ? "#dc2626" : "#16a34a"}">${o.status === "returned" ? "Qaytarildi" : "Yetkazildi"}</b>`
            : `<br><button class="popup-go" data-go="${esc(o.id)}" type="button">Bu do‘konga borish</button>`)
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
  return String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
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
  const body = { ...startFilterBody(), order_ids: full };
  let queued = false;
  try {
    await queueSingle("reorder", body);
    queued = true;
  } catch {
    /* IndexedDB yo‘q — to‘g‘ridan-to‘g‘ri yuboramiz */
  }
  if (!navigator.onLine) {
    toast("Offline: tartib telefonda saqlandi, internet chiqqach serverga yoziladi", true);
    return "queued";
  }
  if (queued) {
    await flushOutbox();
    if (!outboxMeta.some((x) => x.type === "reorder")) return true;
    toast("Tartib telefonda saqlandi, serverga keyinroq yoziladi", true);
    return "queued";
  }
  try {
    applyRoute(await api("/driver/reorder", { method: "POST", body }));
    return true;
  } catch (err) {
    toast(err.message || "Tartib serverga yozilmadi", true);
  }
}

function currentFullOrder() {
  return orderedStops().map((o) => o.id);
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
  // Oflayn tuzilgan reja ham serverga yetib borsin, aks holda internet chiqqach tartib eski holiga qaytadi
  const keepLocal = () => queueSingle("reorder", { ...startFilterBody(), order_ids: currentFullOrder() }).catch(() => {});
  if (!navigator.onLine) {
    await keepLocal();
    return;
  }
  try {
    const data = await api("/driver/replan", {
      method: "POST",
      body: { ...startFilterBody(), first_id: firstId ?? null, lat: me ? me.lat : null, lng: me ? me.lng : null },
      timeout: 30000,
    });
    applyRoute(data);
  } catch (err) {
    if (err?.status) toast(err.message || "Reja serverga yozilmadi", true);
    else await keepLocal();
  }
}

async function markStarted() {
  if (driver?.status === "on_route" || route.started) return;
  const body = startFilterBody();
  if (navigator.onLine) {
    try {
      applyRoute(await api("/driver/start", { method: "POST", body, timeout: 30000 }));
      return;
    } catch (err) {
      if (err?.status) {
        if (err.status !== 400) toast(err.message || "Serverga yozilmadi", true);
        return;
      }
    }
  }
  route.started = true;
  await queueSingle("start", body).catch(() => {});
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
  await markStarted();
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

const MIN_COMMENT = 3;

function proofStep(step) {
  $("proof-reasons")?.classList.toggle("hidden", step !== "reason");
  $("proof-shoot")?.classList.toggle("hidden", step !== "shoot");
  $("proof-preview")?.classList.toggle("hidden", step !== "preview");
  const returned = proof.result === "returned";
  $("proof-comment-box")?.classList.toggle("hidden", step !== "preview");
  $("proof-chips")?.classList.toggle("hidden", !returned);
  const label = $("proof-comment-label");
  if (label) label.textContent = returned ? "Izoh: nima uchun qaytarildi? *" : "Izoh (ixtiyoriy)";
  const area = $("proof-comment");
  if (area) area.placeholder = returned ? "Qisqacha yozing yoki yuqoridan tanlang" : "Masalan: pulni ertaga beradi, mahsulot omborga qo‘yildi";
  syncProofSend();
}

function proofComment() {
  return ($("proof-comment")?.value || "").trim();
}

function syncProofSend() {
  const btn = $("proof-send");
  if (!btn) return;
  btn.disabled = proof.result === "returned" && proofComment().length < MIN_COMMENT;
  const typed = proofComment();
  document.querySelectorAll("#proof-chips .proof-chip").forEach((c) => c.classList.toggle("on", c.textContent.trim() === typed));
}

function proofErr(text) {
  const el = $("proof-err");
  if (el) el.textContent = text || "";
}

function openProof(id, result) {
  const o = allOrders().find((x) => Number(x.id) === Number(id));
  if (o && isDone(o)) {
    toast("Bu zayavka allaqachon yopilgan", true);
    return;
  }
  if (proof.url) URL.revokeObjectURL(proof.url);
  proof = { id: Number(id), result, reason: "", blob: null, url: "" };
  if ($("proof-comment")) $("proof-comment").value = "";
  $("proof-title").textContent = result === "delivered" ? "Yetkazildi" : "Qaytarildi";
  $("proof-sheet").classList.toggle("returned", result === "returned");
  $("proof-sub").textContent = o ? `${o.client_name || o.code || "Do‘kon"}${o.dropoff_address ? " · " + o.dropoff_address : ""}` : "";
  $("proof-tag").textContent = result === "returned" ? "Qaytarildi" : "";
  proofErr("");
  proofStep(result === "delivered" ? "reason" : "shoot");
  $("proof-sheet").classList.remove("hidden");
  // Qaytarishda sabab so‘ralmaydi — kamera darhol ochiladi
  if (result === "returned") openCamera();
}

function closeProof() {
  closeCamera();
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

// Ilova ichidagi kamera: tizim kamera ilovasiga o‘tilmaydi, shuning uchun Android ilovani xotiradan
// chiqarib yubormaydi va rasm bir bosishda olinadi. Ishlamasa — tizim kamerasi (input file).
const cam = { stream: null, starting: null, torch: false, failed: false };

function camSupported() {
  return !cam.failed && window.isSecureContext && !!navigator.mediaDevices?.getUserMedia;
}

async function startCamStream() {
  if (cam.stream?.active) return cam.stream;
  if (!cam.starting) {
    cam.starting = navigator.mediaDevices
      .getUserMedia({
        audio: false,
        video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } },
      })
      .finally(() => {
        cam.starting = null;
      });
  }
  cam.stream = await cam.starting;
  return cam.stream;
}

function stopCamStream() {
  cam.stream?.getTracks().forEach((t) => t.stop());
  cam.stream = null;
  cam.torch = false;
  $("cam-torch")?.classList.remove("on");
  const v = $("cam-video");
  if (v) v.srcObject = null;
}

function closeCamera() {
  $("cam")?.classList.add("hidden");
  stopCamStream();
}

async function openCamera() {
  if (!proof.id) return;
  if (!camSupported()) {
    takeProofPhoto();
    return;
  }
  const box = $("cam");
  const shot = $("cam-shot");
  const v = $("cam-video");
  $("cam-err").textContent = "";
  $("cam-title").textContent =
    proof.result === "returned" ? "Qaytarilgan mahsulotni rasmga oling" : PROOF_REASONS[proof.reason] || "Rasmga oling";
  box.classList.remove("hidden");
  box.classList.add("loading");
  shot.disabled = true;
  const t0 = Date.now();
  try {
    const stream = await startCamStream();
    if (!proof.id || box.classList.contains("hidden")) {
      stopCamStream();
      return;
    }
    if (v.srcObject !== stream) v.srcObject = stream;
    await v.play().catch(() => {});
    if (!v.videoWidth) {
      await new Promise((resolve) => {
        v.addEventListener("loadedmetadata", resolve, { once: true });
        setTimeout(resolve, 2500);
      });
    }
    if (!v.videoWidth) throw new Error("no frames");
    box.classList.remove("loading");
    shot.disabled = false;
    const caps = stream.getVideoTracks()[0]?.getCapabilities?.() || {};
    $("cam-torch").classList.toggle("hidden", !caps.torch);
  } catch {
    cam.failed = true;
    box.classList.remove("loading");
    closeCamera();
    if (!proof.id) return;
    proofStep(proof.blob ? "preview" : "shoot");
    // Fayl tanlash oynasi faqat bosishdan keyin tez ochilsa ruxsat etiladi; kechiksa — tugma ko‘rinib turadi
    if (Date.now() - t0 < 4000) takeProofPhoto();
  }
}

async function toggleTorch() {
  const track = cam.stream?.getVideoTracks()[0];
  if (!track) return;
  cam.torch = !cam.torch;
  try {
    await track.applyConstraints({ advanced: [{ torch: cam.torch }] });
  } catch {
    cam.torch = false;
  }
  $("cam-torch")?.classList.toggle("on", cam.torch);
}

async function shootCamera() {
  const v = $("cam-video");
  const box = $("cam");
  if (!v?.videoWidth || !proof.id) return;
  const scale = Math.min(1, 1600 / Math.max(v.videoWidth, v.videoHeight));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(v.videoWidth * scale);
  canvas.height = Math.round(v.videoHeight * scale);
  canvas.getContext("2d").drawImage(v, 0, 0, canvas.width, canvas.height);
  box.classList.remove("flash");
  void box.offsetWidth;
  box.classList.add("flash");
  if (navigator.vibrate) navigator.vibrate(30);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.82));
  if (!blob) {
    $("cam-err").textContent = "Rasm olinmadi — yana bosing";
    return;
  }
  closeCamera();
  setProofPhoto(blob);
}

function setProofPhoto(blob) {
  if (proof.url) URL.revokeObjectURL(proof.url);
  proof.blob = blob;
  proof.url = URL.createObjectURL(blob);
  $("proof-img").src = proof.url;
  $("proof-tag").textContent = proof.result === "delivered" ? PROOF_REASONS[proof.reason] || "" : "Qaytarildi";
  proofStep("preview");
  if (proof.result === "returned" && !proofComment()) setTimeout(() => $("proof-comment")?.focus(), 150);
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
    setProofPhoto(await compressImage(file).catch(() => file));
  } catch (err) {
    proofErr(err.message || "Rasm o‘qilmadi");
  }
}

async function sendProof() {
  if (!proof.id || !proof.blob) return;
  const comment = proofComment();
  if (proof.result === "returned" && comment.length < MIN_COMMENT) {
    proofErr("Qaytarish sababini izohda yozing");
    $("proof-comment")?.focus();
    return;
  }
  const btn = $("proof-send");
  if (btn) btn.disabled = true;
  proofErr("");
  const item = {
    type: "proof",
    orderId: proof.id,
    result: proof.result,
    reason: proof.result === "delivered" ? proof.reason : "",
    comment,
    done_at: new Date().toISOString(),
    blob: proof.blob,
  };
  try {
    await outboxPut(item);
  } catch {
    // IndexedDB ishlamasa — navbatsiz, darhol yuboramiz
    try {
      await sendQueued(item);
    } catch (err) {
      proofErr(err.message || "Yuborilmadi");
      syncProofSend();
      return;
    }
  }
  const { orderId: id, result } = item;
  const label = result === "delivered" ? "Yetkazildi" : "Qaytarildi";
  closeProof();
  markDone(id, item);
  toast(navigator.onLine ? `${label} ✓` : `${label} ✓ — internet chiqqach serverga yuboriladi`, !navigator.onLine);
  afterStopDone(id, result).catch(() => {});
  flushOutbox().catch(() => {});
}

let freshDoneId = null;

function markDone(id, item) {
  const o = allOrders().find((x) => Number(x.id) === Number(id));
  if (!o) return;
  freshDoneId = o.id;
  o.status = item.result;
  o.proof_at = item.done_at;
  o.proof_comment = item.comment || "";
  o.proof_reason = item.reason || item.result;
  saveSession();
}

// Server javobi kelganda ham hali yuborilmagan tasdiq va tartib telefondagidek ko‘rinsin
function overlayLocal(orders) {
  const byId = new Map((orders || []).map((o) => [Number(o.id), o]));
  outboxMeta.forEach((it) => {
    if (it.type !== "proof") return;
    const o = byId.get(Number(it.orderId));
    if (!o) return;
    o.status = it.result;
    o.proof_at = it.done_at;
    o.proof_comment = it.comment || "";
    o.proof_reason = it.reason || it.result;
  });
  const ro = [...outboxMeta].reverse().find((x) => x.type === "reorder");
  (ro?.body?.order_ids || []).forEach((id, i) => {
    const o = byId.get(Number(id));
    if (o) o.stop_no = i + 1;
  });
}

function sendQueued(item) {
  if (item.type === "proof") {
    const form = new FormData();
    form.append("result", item.result);
    form.append("reason", item.reason || "");
    form.append("comment", item.comment || "");
    form.append("done_at", item.done_at || "");
    form.append("photo", item.blob, `proof_${item.orderId}.jpg`);
    return api(`/driver/orders/${item.orderId}/proof`, { method: "POST", body: form, timeout: 90000 });
  }
  if (item.type === "reorder") return api("/driver/reorder", { method: "POST", body: item.body, timeout: 30000 });
  if (item.type === "start") {
    return api("/driver/start", { method: "POST", body: item.body, timeout: 30000 }).catch((err) => {
      if (err.status === 400) return null;
      throw err;
    });
  }
  return Promise.resolve(null);
}

// 4xx (401 dan tashqari) — qayta yuborish foyda bermaydi; tarmoq xatosi va 5xx — keyinroq qayta uriniladi
function permanentFail(err) {
  return err?.status >= 400 && err.status < 500 && ![401, 408, 429].includes(err.status);
}

let flushing = null;

function flushOutbox() {
  if (flushing) return flushing;
  flushing = (async () => {
    let sent = 0;
    if (!token || !navigator.onLine) return sent;
    const items = (await storeTx("outbox", "readonly", (s) => s.getAll()).catch(() => [])) || [];
    for (const item of items) {
      try {
        const data = await sendQueued(item);
        await outboxDel(item.qid);
        sent += 1;
        if (item.type !== "proof" && data?.orders) applyRoute(data);
      } catch (err) {
        if (err?.status === 401) break;
        if (permanentFail(err)) {
          await outboxDel(item.qid).catch(() => {});
          const o = allOrders().find((x) => Number(x.id) === Number(item.orderId));
          toast(`Yuborilmadi${o ? ` (${o.client_name || o.code})` : ""}: ${err.message}`, true);
          continue;
        }
        break;
      }
    }
    return sent;
  })().finally(() => {
    flushing = null;
    syncQueueUi();
  });
  return flushing;
}

function queuedCount() {
  return outboxMeta.filter((x) => x.type === "proof").length;
}

function syncQueueUi() {
  const n = queuedCount();
  if (n) setSync(`${navigator.onLine ? "" : "Offline · "}Yuborilmagan: ${n} ta tasdiq`, true);
  else if (/yuborilmagan/i.test(syncState.text)) setSync("Hammasi yuborildi", false);
  if (!drag && !hold) renderList();
}

async function queueSingle(type, body) {
  const key = `${body.delivery_date || ""}|${body.route_code || ""}`;
  for (const it of outboxMeta.filter((x) => x.type === type && x.key === key)) {
    await outboxDel(it.qid).catch(() => {});
  }
  await outboxPut({ type, key, body, at: new Date().toISOString() });
}

function renderListHead() {
  const head = $("list-head");
  if (!head) return;
  const pending = pendingStops();
  if (editing) {
    head.innerHTML = `
      <div class="lh-txt"><b>Tartibni o‘zgartirish</b><span class="muted">Ushlab turib suring yoki ↑ ↓ ni bosing</span></div>
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
  if ((await saveOrder(ids)) === true) toast("Ketma-ketlik saqlandi", false);
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

// Sudrash: zayavka ustida barmoqni ushlab turing — u barmoq ortidan yuradi, qolganlari silliq joy beradi.
// Ro‘yxatda ushlab turilsa tahrir rejimi o‘zi ochiladi; tahrirda ⋮⋮ tutqichdan darhol sudrash mumkin.
const HOLD_MS = 320;
const HOLD_SLOP = 10;
let drag = null;
let hold = null;
let suppressClick = 0;

function listContentY(clientY) {
  const box = $("list");
  return clientY - box.getBoundingClientRect().top + box.scrollTop;
}

function cancelHold() {
  if (!hold) return;
  clearTimeout(hold.timer);
  hold.el?.classList.remove("holding");
  hold = null;
}

// Tahrirga o‘tishda kartochka qayta chiziladi va touch hodisalari uzilgan elementga keladi —
// shu element ustida ham sahifa siljishini to‘xtatamiz
function guardTouch(target) {
  if (!target?.addEventListener) return;
  const onMove = (ev) => {
    if (drag && ev.cancelable) ev.preventDefault();
  };
  const off = () => {
    target.removeEventListener("touchmove", onMove);
    target.removeEventListener("touchend", off);
    target.removeEventListener("touchcancel", off);
  };
  target.addEventListener("touchmove", onMove, { passive: false });
  target.addEventListener("touchend", off);
  target.addEventListener("touchcancel", off);
}

function onListPointerDown(e) {
  if (drag || (e.pointerType === "mouse" && e.button !== 0)) return;
  if (e.target.closest(".re-arrows, [data-edit-auto]")) return;
  const grip = editing ? e.target.closest("[data-grip]") : null;
  if (grip) {
    e.preventDefault();
    beginDrag(grip.closest(".re-row"), e.pointerId, e.clientY);
    return;
  }
  const el = editing ? e.target.closest(".re-row") : e.target.closest(".card.pending");
  if (!el || (!editing && pendingStops().length < 2)) return;
  cancelHold();
  hold = { el, id: Number(el.dataset.id), pointerId: e.pointerId, x: e.clientX, y: e.clientY };
  el.classList.add("holding");
  hold.timer = setTimeout(() => {
    const h = hold;
    hold = null;
    h.el.classList.remove("holding");
    if (!editing) {
      startReorder();
      const row = $("list").querySelector(`.re-row[data-id="${h.id}"]`);
      if (row) row.scrollIntoView({ block: "nearest" });
      beginDrag(row, h.pointerId, h.lastY ?? h.y);
    } else {
      beginDrag(h.el, h.pointerId, h.lastY ?? h.y);
    }
  }, HOLD_MS);
}

function beginDrag(row, pointerId, clientY) {
  if (!row || !editing) return;
  const box = $("list");
  try {
    box.setPointerCapture(pointerId);
  } catch {
    /* barmoq allaqachon ko‘tarilgan */
  }
  drag = {
    row,
    pointerId,
    startY: listContentY(clientY),
    startTop: row.offsetTop,
    clientY,
    raf: 0,
  };
  row.classList.add("dragging");
  box.classList.add("drag-on");
  navigator.vibrate?.(18);
  drag.raf = requestAnimationFrame(dragTick);
}

function flipRows(rows, mutate) {
  const before = new Map(rows.map((r) => [r, r.offsetTop]));
  mutate();
  rows.forEach((r) => {
    const dy = before.get(r) - r.offsetTop;
    if (!dy) return;
    r.style.transition = "none";
    r.style.transform = `translateY(${dy}px)`;
    r.getBoundingClientRect();
    r.style.transition = "transform .18s cubic-bezier(.2,.8,.2,1)";
    r.style.transform = "";
  });
}

function dragLayout() {
  const box = $("list");
  const { row } = drag;
  const offset = listContentY(drag.clientY) - drag.startY;
  const center = drag.startTop + offset + row.offsetHeight / 2;
  const others = [...box.querySelectorAll(".re-row")].filter((r) => r !== row);
  const target = others.find((r) => center < r.offsetTop + r.offsetHeight / 2) || null;
  const lastRow = others[others.length - 1];
  const inPlace = target ? row.nextElementSibling === target : lastRow && lastRow.nextElementSibling === row;
  if (!inPlace && lastRow) {
    flipRows(others, () => (target ? box.insertBefore(row, target) : lastRow.after(row)));
  }
  row.style.transform = `translateY(${drag.startTop + offset - row.offsetTop}px) scale(1.02)`;
}

function dragTick() {
  if (!drag) return;
  const box = $("list");
  const rect = box.getBoundingClientRect();
  const edge = 64;
  let speed = 0;
  if (drag.clientY < rect.top + edge) speed = -Math.ceil(((rect.top + edge - drag.clientY) / edge) * 14);
  else if (drag.clientY > rect.bottom - edge) speed = Math.ceil(((drag.clientY - (rect.bottom - edge)) / edge) * 14);
  if (speed) box.scrollTop += speed;
  dragLayout();
  drag.raf = requestAnimationFrame(dragTick);
}

function onListPointerMove(e) {
  if (hold && e.pointerId === hold.pointerId) {
    hold.lastY = e.clientY;
    if (Math.hypot(e.clientX - hold.x, e.clientY - hold.y) > HOLD_SLOP) cancelHold();
    return;
  }
  if (!drag || e.pointerId !== drag.pointerId) return;
  e.preventDefault();
  drag.clientY = e.clientY;
}

function endDrag(e) {
  if (hold && e.pointerId === hold.pointerId) cancelHold();
  if (!drag || e.pointerId !== drag.pointerId) return;
  cancelAnimationFrame(drag.raf);
  const box = $("list");
  const rows = [...box.querySelectorAll(".re-row")];
  editing = rows.map((r) => Number(r.dataset.id));
  rows.forEach((r) => {
    r.style.transition = "";
    r.style.transform = "";
  });
  drag.row.classList.remove("dragging");
  box.classList.remove("drag-on");
  drag = null;
  suppressClick = Date.now();
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
  const queued = new Set(outboxMeta.filter((x) => x.type === "proof").map((x) => Number(x.orderId)));
  const pendingN = rows.filter((o) => !isDone(o)).length;
  box.innerHTML =
    rows
      .map((o, i) => {
        const meta = `<div class="muted">${esc(o.dropoff_address || "")}</div>
          <div class="muted">${[o.route_code, o.delivery_date, o.window_start && o.window_end ? `${o.window_start}–${o.window_end}` : ""].filter(Boolean).map(esc).join(" · ")}</div>`;
        if (isDone(o)) {
          const kind = o.status === "delivered" ? "delivered" : o.status === "returned" ? "returned" : "cancelled";
          const label = { delivered: "Yetkazildi", returned: "Qaytarildi", cancelled: "Bekor qilindi" }[kind];
          const at = o.proof_at ? new Date(o.proof_at) : null;
          const time = at && !Number.isNaN(at.getTime()) ? at.toLocaleTimeString("uz-UZ", { hour: "2-digit", minute: "2-digit" }) : "";
          const why = kind === "returned" && o.proof_reason && o.proof_reason !== "returned" ? o.proof_reason : "";
          const note = [why, o.proof_comment].filter(Boolean).join(" — ");
          return `<article class="card done ${kind}${o.id === freshDoneId ? " fresh" : ""}" data-id="${o.id}">
            <div class="top">
              <span class="stop">${kind === "delivered" ? "✓" : kind === "returned" ? "↩" : "×"}</span>
              <div style="flex:1;min-width:0">
                <b>${esc(o.code || "")}</b>
                <div>${esc(o.client_name || "Mijoz")}</div>
              </div>
              <span class="pill st-${kind}">${label}${time ? ` · ${time}` : ""}</span>
            </div>
            ${meta}
            ${note ? `<div class="card-note">${esc(note)}</div>` : ""}
            ${queued.has(Number(o.id)) ? `<div class="card-queue">Internet chiqqach serverga yuboriladi</div>` : ""}
          </article>`;
        }
        const gps = gpsOk(o.dropoff_lat, o.dropoff_lng);
        const isCur = cur && cur.id === o.id;
        return `<article class="card pending ${isCur ? "current" : ""}" data-id="${o.id}">
          <div class="top">
            <span class="stop">${i + 1}</span>
            <div style="flex:1;min-width:0">
              <b>${esc(o.code || "")}</b>
              <div>${esc(o.client_name || "Mijoz")}</div>
            </div>
            ${isCur ? `<span class="pill live">${run.going ? "Hozirgi" : "Keyingi"}</span>` : ""}
          </div>
          ${meta}
          ${gps ? "" : `<div class="muted">Lokatsiya yo‘q</div>`}
          <div class="actions">
            <button class="btn primary" data-nav="${o.id}" type="button" ${gps ? "" : "disabled"}>Borish</button>
            <button class="btn ok" data-done="${o.id}" type="button">Yetkazildi</button>
            <button class="btn warn" data-return="${o.id}" type="button">Qaytarildi</button>
          </div>
        </article>`;
      })
      .join("") +
    (pendingN > 1 ? `<p class="list-hint muted">Tartibni o‘zgartirish uchun zayavka ustida barmoqni ushlab turing va suring</p>` : "");
  freshDoneId = null;
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
  overlayLocal(route.orders);
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
  if (queuedCount()) syncQueueUi();
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
    if (!run.active) await markStarted();
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

function flushGps() {
  return withGpsLock(async () => {
    const batch = await gpsDump();
    const n = batch.points.length;
    if (!token || !navigator.onLine) {
      if (n) setSync(`GPS kesh: ${n}`, true);
      return 0;
    }
    try {
      await api("/driver/location", { method: "POST", body: { points: batch.points } });
      if (n) await gpsClear(batch);
      return n;
    } catch {
      if (n) setSync(`GPS kesh: ${n}`, true);
      return 0;
    }
  });
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
  if (outboxMeta.length) await flushOutbox();
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
  if (!token) throw new Error("Sessiya tugagan — qayta kiring");
  if (!navigator.onLine) {
    const cached = await kvGet("route");
    if (cached) applyRoute(cached);
    setSync(queuedCount() ? `Offline · yuborilmagan: ${queuedCount()} ta` : "Offline kesh", true);
    return;
  }
  await flushOutbox().catch(() => {});
  const data = await withGpsLock(async () => {
    const batch = await gpsDump();
    const res = await api("/driver/sync", { method: "POST", body: { points: batch.points } });
    if (batch.points.length) await gpsClear(batch).catch(() => {});
    return res;
  });
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
      return gpsDump().then((q) => setSync(`GPS kesh: ${q.points.length}`, true));
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

/** Haydovchi o‘chirilgan/bloklangan: kuzatuv to‘xtaydi, lekin yuborilmagan tasdiqlar saqlanib qoladi. */
function onSessionLost(message) {
  if ($("view-app").classList.contains("hidden")) return;
  nativeTracking(false);
  stopHeartbeat();
  if (watchId != null) {
    navigator.geolocation.clearWatch(watchId);
    watchId = null;
  }
  closeProfile();
  show("view-login");
  const n = queuedCount();
  $("login-err").textContent = `${message}. Qayta kiring${n ? ` — ${n} ta yuborilmagan tasdiq saqlanib turibdi` : ""}.`;
}

async function enterApp(payload) {
  // Boshqa haydovchi kirsa, oldingisining yuborilmagan navbati unga tegishli emas
  const prev = driver || (await kvGet("driver").catch(() => null));
  if (prev?.id && payload.driver?.id && prev.id !== payload.driver.id) {
    await outboxClear().catch(() => {});
    await gpsClear().catch(() => {});
    route = { orders: [], geometry: [], downloaded_at: null };
    run = { ...RUN_EMPTY };
    localStorage.removeItem(RUN_KEY);
  }
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
  if (qrScanner) {
    qrScanner.stop().catch(() => {});
    qrScanner = null;
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
    qrScanner = new window.Html5Qrcode("reader");
    await qrScanner.start(
      { facingMode: "environment" },
      { fps: 8, qrbox: 220 },
      (text) => {
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
  gpsClear().catch(() => {});
  outboxClear().catch(() => {});
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
  const list = $("list");
  list.addEventListener("pointerdown", (e) => {
    onListPointerDown(e);
    guardTouch(e.target);
  });
  list.addEventListener("pointermove", onListPointerMove);
  list.addEventListener("pointerup", endDrag);
  list.addEventListener("pointercancel", endDrag);
  list.addEventListener("touchmove", (e) => {
    if (drag && e.cancelable) e.preventDefault();
  }, { passive: false });
  list.addEventListener("contextmenu", (e) => {
    if (hold || drag || e.target.closest(".card, .re-row")) e.preventDefault();
  });
  list.addEventListener(
    "click",
    (e) => {
      if (Date.now() - suppressClick < 450) {
        e.preventDefault();
        e.stopPropagation();
      }
    },
    true
  );
  list.addEventListener("click", async (e) => {
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
    proofStep("shoot");
    openCamera();
  });
  $("proof-camera")?.addEventListener("click", openCamera);
  $("proof-retake")?.addEventListener("click", openCamera);
  $("cam-shot")?.addEventListener("click", shootCamera);
  $("cam-torch")?.addEventListener("click", toggleTorch);
  $("cam-close")?.addEventListener("click", closeCamera);
  $("proof-send")?.addEventListener("click", sendProof);
  $("proof-comment")?.addEventListener("input", () => {
    proofErr("");
    syncProofSend();
  });
  $("proof-chips")?.addEventListener("click", (e) => {
    const chip = e.target.closest(".proof-chip");
    const box = $("proof-comment");
    if (!chip || !box) return;
    box.value = chip.textContent.trim();
    proofErr("");
    syncProofSend();
  });
  $("proof-file")?.addEventListener("change", onProofFile);
  window.addEventListener("online", () => {
    setNet();
    flushOutbox()
      .catch(() => {})
      .then(() => flushGps())
      .then(() => pullRoute())
      .catch(() => {});
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) closeCamera();
    else if (outboxMeta.length && navigator.onLine) flushOutbox().catch(() => {});
  });
  window.addEventListener("offline", setNet);
  setNet();
}

async function boot() {
  bind();
  // Service worker sahifani keshlaydi: Android ilova ham internetsiz ochilib, zayavkalar bilan ishlaydi
  try {
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/driver/sw.js", { scope: "/driver/" }).catch(() => {});
      navigator.serviceWorker.ready
        .then(() => {
          if (typeof window.NexusNative?.offlineReady === "function") window.NexusNative.offlineReady(location.href);
        })
        .catch(() => {});
    }
  } catch {
    /* ignore */
  }
  const saved = localStorage.getItem(TOKEN_KEY) || (await kvGet("token").catch(() => ""));
  const cachedDriver = await kvGet("driver").catch(() => null);
  const cachedRoute = await kvGet("route").catch(() => null);
  await outboxLoad();
  if (saved) {
    token = saved;
    driver = cachedDriver;
    if (cachedRoute) route = cachedRoute;
    overlayLocal(route.orders);
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
        // onSessionLost login oynasini ochdi; navbatdagi tasdiqlar o‘chirilmaydi
      } else if (cachedRoute) {
        applyRoute(cachedRoute);
        setSync(queuedCount() ? `Offline · yuborilmagan: ${queuedCount()} ta` : "Offline kesh", true);
      } else {
        setSync(navigator.onLine ? err?.message || "Server javob bermadi" : "Offline", true);
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
