import { api, can } from "../api.js";
import { escapeHtml } from "../ui.js?v=68";
import * as wsModule from "../workspace.js?v=68";

// Har doim bindWorkspace() chaqirilgan (zayavkalar yuklangan) nusxadan o'qiymiz.
function ws() {
  return window.__nxWorkspace || wsModule;
}
const filteredOrders = () => ws().filteredOrders();
const getWarehouses = () => ws().getWarehouses();
const hasGps = (o) => ws().hasGps(o);

const L = window.L;
const OSRM_MAX = 80;

let map = null;
let vehicleMarkers = {};
let orderMarkers = {};
let pinLayer = null;
let sketchLayer = null;
let roadLayer = null;
let selectedId = null;
let timer = null;
let onSelect = null;
let onChanged = null;
let onResize = null;
let onDriver = null;
let focusedDriverId = null;
let roadKey = "";
let roadToken = 0;

const CAR_SVG =
  '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 13.5V16a1 1 0 0 0 1 1h1"/><path d="M19 17h1a1 1 0 0 0 1-1v-2.5a2 2 0 0 0-1.4-1.9L17 11l-1.8-3.2A2 2 0 0 0 13.5 7H8.6a2 2 0 0 0-1.7 1L5 11l-1.6.5A2 2 0 0 0 3 13.5"/><circle cx="7.5" cy="17" r="1.8"/><circle cx="16.5" cy="17" r="1.8"/></svg>';

function shortName(name) {
  const s = String(name || "").trim();
  return s.length > 16 ? `${s.slice(0, 15)}…` : s;
}

function agoText(iso) {
  if (!iso) return "hech qachon";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "—";
  const sec = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (sec < 60) return "hozirgina";
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} daqiqa oldin`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} soat oldin`;
  return `${Math.round(h / 24)} kun oldin`;
}

function clockText(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("uz-UZ", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function vehicleIcon(v) {
  const state = v.online ? "online" : "offline";
  return L.divIcon({
    className: "order-pin",
    html: `<div class="veh-pin ${state}${v.status === "on_route" ? " moving" : ""}">
      <span class="veh-car">${CAR_SVG}</span>
      <span class="veh-name">${escapeHtml(shortName(v.name))}</span>
      <span class="veh-dot"></span>
    </div>`,
    iconSize: [0, 0],
    iconAnchor: [14, 14],
  });
}

function vehiclePopup(v) {
  const state = v.online
    ? `<span class="veh-badge online">Online</span>`
    : `<span class="veh-badge offline">Offline</span>`;
  const addr = v.address ? escapeHtml(v.address) : `<span class="muted">Manzil aniqlanmoqda…</span>`;
  const acc = v.accuracy ? ` · ±${Math.round(v.accuracy)} m` : "";
  return `<div class="veh-pop">
    <div class="veh-pop-head"><b>${escapeHtml(v.name)}</b>${state}</div>
    ${v.plate ? `<div class="muted">${escapeHtml(v.plate)}</div>` : ""}
    <div class="veh-pop-addr">${addr}</div>
    <div class="muted">Joylashuv: ${escapeHtml(clockText(v.gps_at))} (${escapeHtml(agoText(v.gps_at))})${acc}</div>
    <div class="muted">Ilova signali: ${escapeHtml(agoText(v.seen_at))}</div>
  </div>`;
}

function driverLabel(o) {
  const name = String(o.driver_name || "").trim();
  if (!name) return "";
  return name.length > 18 ? `${name.slice(0, 17)}…` : name;
}

function driverColor(name) {
  const palette = ["#5eead4", "#7aa2ff", "#fbbf24", "#fb7185", "#a78bfa", "#34d399", "#f472b6", "#38bdf8"];
  let h = 0;
  for (const ch of String(name)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return palette[h % palette.length];
}

function dist2(a, b) {
  const dy = (a[0] - b[0]) * 111;
  const dx = (a[1] - b[1]) * 85;
  return dx * dx + dy * dy;
}

function twoOptFrom(origin, list) {
  if (list.length < 3) return list;
  const pts = list.map((o) => [o.dropoff_lat, o.dropoff_lng]);
  const plen = (idx) => {
    let s = origin ? dist2(origin, pts[idx[0]]) : 0;
    for (let i = 1; i < idx.length; i++) s += dist2(pts[idx[i - 1]], pts[idx[i]]);
    return s;
  };
  let idx = list.map((_, i) => i);
  let improved = true;
  let guard = 0;
  while (improved && guard++ < 80) {
    improved = false;
    const best = plen(idx);
    for (let i = 0; i < idx.length - 1; i++) {
      for (let k = i + 1; k < idx.length; k++) {
        const next = idx.slice(0, i).concat(idx.slice(i, k + 1).reverse(), idx.slice(k + 1));
        if (plen(next) + 1e-9 < best) {
          idx = next;
          improved = true;
        }
      }
    }
  }
  return idx.map((i) => list[i]);
}

function warehousePoint(stops) {
  const o = (stops || []).find((x) => {
    const lat = Number(x.warehouse_lat);
    const lng = Number(x.warehouse_lng);
    return lat > 37 && lat < 46 && lng > 55 && lng < 76;
  });
  if (o) return [Number(o.warehouse_lat), Number(o.warehouse_lng)];
  const w = (getWarehouses() || []).find((x) => x.is_default && x.is_active) || (getWarehouses() || []).find((x) => x.is_active);
  if (w) {
    const lat = Number(w.lat);
    const lng = Number(w.lng);
    if (lat > 37 && lat < 46 && lng > 55 && lng < 76) return [lat, lng];
  }
  const first = (stops || []).find(hasGps);
  if (!first) return null;
  const lat = Number(first.pickup_lat);
  const lng = Number(first.pickup_lng);
  const placeholder =
    (Math.abs(lat - 41.3111) < 0.003 && Math.abs(lng - 69.2797) < 0.003) ||
    (Math.abs(lat - 41.31) < 0.003 && Math.abs(lng - 69.28) < 0.003);
  if (!placeholder && lat > 37 && lat < 46 && lng > 55 && lng < 76 && first.warehouse_id) return [lat, lng];
  return null;
}

function sequenceStops(list) {
  const gps = list.filter(hasGps);
  const rest = list.filter((o) => !hasGps(o));
  if (!gps.length) return list.slice();
  if (gps.every((o) => Number(o.stop_no) > 0)) {
    return gps.slice().sort((a, b) => Number(a.stop_no) - Number(b.stop_no) || a.id - b.id).concat(rest);
  }
  const remaining = gps.slice();
  let cur = warehousePoint(remaining) || [remaining[0].dropoff_lat, remaining[0].dropoff_lng];
  const ordered = [];
  while (remaining.length) {
    let bi = 0;
    let bd = Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const d = dist2(cur, [remaining[i].dropoff_lat, remaining[i].dropoff_lng]);
      if (d < bd) {
        bd = d;
        bi = i;
      }
    }
    const next = remaining.splice(bi, 1)[0];
    ordered.push(next);
    cur = [next.dropoff_lat, next.dropoff_lng];
  }
  return twoOptFrom(warehousePoint(ordered), ordered).concat(rest);
}

function routeGroups() {
  const mapGroups = new Map();
  visibleOrders().forEach((o) => {
    if (!o.driver_id) return;
    if (!mapGroups.has(o.driver_id)) mapGroups.set(o.driver_id, []);
    mapGroups.get(o.driver_id).push(o);
  });
  const out = [];
  mapGroups.forEach((rows, driverId) => {
    const stops = sequenceStops(rows);
    out.push({
      driverId,
      name: driverLabel(stops[0] || {}) || "Haydovchi",
      color: driverColor((stops[0] && stops[0].driver_name) || String(driverId)),
      stops,
    });
  });
  return out;
}

function stopIcon(o, n, active, showLabel) {
  const name = driverLabel(o);
  const color = name ? driverColor(name) : "#2563eb";
  const pin = `<div class="stop-num${active ? " active" : ""}" style="background:${active ? "#dc2626" : color}">${n}</div>`;
  if (!name || !showLabel) {
    return L.divIcon({
      className: "order-pin",
      html: pin,
      iconSize: active ? [26, 26] : [22, 22],
      iconAnchor: active ? [13, 13] : [11, 11],
    });
  }
  return L.divIcon({
    className: "order-pin",
    html: `<div class="store-pin-wrap">${pin}<span class="pin-label">${escapeHtml(name)}</span></div>`,
    iconSize: [140, 44],
    iconAnchor: [70, 12],
  });
}

function popupHtml(o, n) {
  const driver = String(o.driver_name || "").trim();
  const stop = n ? `To‘xtash ${n}<br>` : "";
  const driverLine = driver ? `<br><b>${escapeHtml(driver)}</b>` : "";
  return `${stop}<b>${escapeHtml(o.client_name || "Do‘kon")}</b><br>${escapeHtml(o.dropoff_address || "")}${driverLine}<br><small>${escapeHtml(o.code)}</small>`;
}

function validPoint(o) {
  return hasGps(o);
}

function visibleOrders() {
  const rows = filteredOrders().filter(validPoint);
  if (!focusedDriverId) return rows;
  return rows.filter((o) => String(o.driver_id || 0) === String(focusedDriverId));
}

function fitStores() {
  if (!map) return;
  const pts = visibleOrders().map((o) => [o.dropoff_lat, o.dropoff_lng]);
  const start = warehousePoint(visibleOrders());
  if (start) pts.push(start);
  if (pts.length === 1) {
    map.setView(pts[0], 15);
    return;
  }
  if (pts.length > 1) {
    map.fitBounds(pts, { padding: [28, 28], maxZoom: 15 });
    return;
  }
  map.setView([41.3111, 69.2797], 12);
}

function startPoint(stops) {
  return warehousePoint(stops);
}

function pathPoints(stops) {
  const pts = [];
  const start = startPoint(stops);
  if (start) pts.push(start);
  stops.filter(hasGps).forEach((o) => pts.push([o.dropoff_lat, o.dropoff_lng]));
  return pts;
}

function currentRoadKey(groups) {
  return groups
    .map((g) => `${g.driverId}:${g.stops.filter(hasGps).map((o) => o.id).join(",")}`)
    .join("|");
}

function updateLegend(groups) {
  const box = document.getElementById("map-legend");
  if (!box) return;
  const routed = groups.filter((g) => g.stops.filter(hasGps).length >= 2);
  if (!routed.length) {
    box.classList.add("hidden");
    box.innerHTML = "";
    return;
  }
  box.classList.remove("hidden");
  box.innerHTML = routed
    .map(
      (g) =>
        `<div class="map-legend-row"><span class="map-legend-dot" style="background:${g.color}"></span>${escapeHtml(g.name)} · ${g.stops.filter(hasGps).length} nuqta</div>`
    )
    .join("");
}

function drawStores() {
  if (!map) return;
  if (pinLayer) pinLayer.remove();
  pinLayer = L.layerGroup().addTo(map);
  orderMarkers = {};
  const showLabel = map.getZoom() >= 14;
  const groups = routeGroups();
  const stopOf = new Map();
  groups.forEach((g) => {
    g.stops.filter(hasGps).forEach((o, i) => stopOf.set(o.id, i + 1));
  });
  visibleOrders().forEach((o) => {
    const n = stopOf.get(o.id) || 0;
    const name = driverLabel(o);
    const marker = L.marker([o.dropoff_lat, o.dropoff_lng], {
      icon: n ? stopIcon(o, n, String(o.id) === String(selectedId), showLabel) : storeFallback(o, String(o.id) === String(selectedId), showLabel),
    })
      .addTo(pinLayer)
      .bindPopup(popupHtml(o, n));
    if (name && !showLabel) {
      marker.bindTooltip(n ? `${n}. ${escapeHtml(name)}` : escapeHtml(name), { direction: "top", opacity: 0.95, className: "pin-tip" });
    }
    marker.on("click", () => {
      selectedId = o.id;
      drawStores();
      marker.openPopup();
      const card = document.querySelector(`.order-card[data-id="${o.id}"]`);
      if (card) {
        document.querySelectorAll(".order-card").forEach((c) => c.classList.toggle("selected", c === card));
        card.scrollIntoView({ block: "nearest" });
      }
    });
    orderMarkers[o.id] = marker;
  });
  const start = warehousePoint(visibleOrders());
  if (start) {
    const wh = (getWarehouses() || []).find((w) => w.is_default) || (getWarehouses() || [])[0];
    const label = escapeHtml(wh?.name || "Sklad");
    L.marker(start, {
      icon: L.divIcon({
        className: "order-pin",
        html: `<div class="store-pin-wrap"><div class="wh-pin"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 20V9l9-5 9 5v11" /><path d="M7 20v-8h10v8" /><path d="M7 16h10" /></svg></div><span class="pin-label">${label}</span></div>`,
        iconSize: [140, 60],
        iconAnchor: [70, 17],
      }),
      zIndexOffset: 800,
    })
      .addTo(pinLayer)
      .bindPopup(`<b>${label}</b><br>Yo‘nalish shu yerdan boshlanadi`);
  }
}

function storeFallback(o, active, showLabel) {
  const name = driverLabel(o);
  const color = name ? driverColor(name) : "#2563eb";
  const pin = `<div class="store-pin${active ? " active" : ""}" style="background:${active ? "#dc2626" : color}"></div>`;
  if (!name || !showLabel) {
    return L.divIcon({
      className: "order-pin",
      html: pin,
      iconSize: active ? [22, 22] : [14, 14],
      iconAnchor: active ? [11, 11] : [7, 7],
    });
  }
  return L.divIcon({
    className: "order-pin",
    html: `<div class="store-pin-wrap">${pin}<span class="pin-label">${escapeHtml(name)}</span></div>`,
    iconSize: [140, 40],
    iconAnchor: [70, 10],
  });
}

function drawSketch(groups) {
  if (!map) return;
  if (sketchLayer) sketchLayer.remove();
  sketchLayer = L.layerGroup().addTo(map);
  groups.forEach((g) => {
    const pts = pathPoints(g.stops);
    if (pts.length < 2) return;
    L.polyline(pts, { color: g.color, weight: 3, opacity: 0.35, dashArray: "7 8" }).addTo(sketchLayer);
  });
}

async function osrmChunk(pts) {
  const path = pts.map(([lat, lng]) => `${lng},${lat}`).join(";");
  const url = `https://router.project-osrm.org/route/v1/driving/${path}?overview=full&geometries=geojson`;
  const res = await fetch(url);
  if (!res.ok) throw new Error("osrm");
  const data = await res.json();
  const coords = data?.routes?.[0]?.geometry?.coordinates;
  if (!coords?.length) throw new Error("empty");
  return coords.map(([lng, lat]) => [lat, lng]);
}

async function osrmLine(pts) {
  if (pts.length < 2) return pts;
  const lines = [];
  for (let i = 0; i < pts.length - 1; i += OSRM_MAX - 1) {
    const chunk = pts.slice(i, i + OSRM_MAX);
    if (chunk.length < 2) continue;
    try {
      lines.push(await osrmChunk(chunk));
    } catch {
      lines.push(chunk);
    }
  }
  return lines.flat();
}

async function drawRoads(groups) {
  if (!map) return;
  const key = currentRoadKey(groups);
  if (key === roadKey && roadLayer) return;
  const token = ++roadToken;
  roadKey = key;
  if (roadLayer) roadLayer.remove();
  roadLayer = L.layerGroup().addTo(map);
  for (const g of groups) {
    const pts = pathPoints(g.stops);
    if (pts.length < 2) continue;
    const geo = await osrmLine(pts);
    if (token !== roadToken || !map || !roadLayer) return;
    L.polyline(geo, { color: g.color, weight: 4, opacity: 0.88 }).addTo(roadLayer);
  }
}

function redrawMap(fit = false) {
  if (!map) return;
  const visible = visibleOrders();
  if (selectedId && !visible.some((o) => String(o.id) === String(selectedId))) selectedId = null;
  const groups = routeGroups();
  drawStores();
  drawSketch(groups);
  updateLegend(groups);
  drawRoads(groups).catch(() => {});
  if (fit || !selectedId) fitStores();
}

function focusStore(detail) {
  if (!map) return;
  selectedId = detail.id;
  drawStores();
  const lat = Number(detail.lat);
  const lng = Number(detail.lng);
  if (!(lat > 37 && lat < 46 && lng > 55 && lng < 76)) return;
  map.flyTo([lat, lng], 16, { duration: 0.6 });
  const marker = orderMarkers[detail.id];
  if (marker) setTimeout(() => marker.openPopup(), 350);
}

async function refreshVehicles() {
  if (!map) return;
  if (!can("tracking.live")) {
    Object.values(vehicleMarkers).forEach((m) => m.remove());
    vehicleMarkers = {};
    return;
  }
  const data = await api("/tracking/live");
  const vehicles = data.vehicles || [];
  lastVehicles = vehicles;
  const seen = new Set();
  vehicles.forEach((v) => {
    if (!v.has_location) return;
    seen.add(String(v.id));
    const latlng = [v.lat, v.lng];
    const popup = vehiclePopup(v);
    const z = v.online ? 900 : 500;
    if (vehicleMarkers[v.id]) {
      vehicleMarkers[v.id].setLatLng(latlng);
      vehicleMarkers[v.id].setIcon(vehicleIcon(v));
      vehicleMarkers[v.id].setZIndexOffset(z);
      vehicleMarkers[v.id].setPopupContent(popup);
    } else {
      vehicleMarkers[v.id] = L.marker(latlng, { icon: vehicleIcon(v), zIndexOffset: z })
        .addTo(map)
        .bindPopup(popup, { maxWidth: 280 });
    }
  });
  Object.keys(vehicleMarkers).forEach((id) => {
    if (seen.has(String(id))) return;
    vehicleMarkers[id].remove();
    delete vehicleMarkers[id];
  });
  renderFleet(vehicles);
  const now = new Date();
  setFleetUpdated(`Yangilandi ${now.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`);
}

let lastVehicles = [];
let fleetOpen = false;
let toastTimer = null;
let pickedVehId = null;
let fleetRefreshing = null;

function setFleetOpen(open) {
  fleetOpen = open;
  document.getElementById("fleet-panel")?.classList.toggle("hidden", !open || !lastVehicles.length);
  document.getElementById("fleet-fab")?.classList.toggle("active", open);
}

function setFleetUpdated(text) {
  const el = document.getElementById("fleet-updated");
  if (el) el.textContent = text;
}

function refreshFleetNow() {
  if (fleetRefreshing) return fleetRefreshing;
  const fab = document.getElementById("fleet-fab");
  const btn = document.getElementById("fleet-refresh");
  fab?.classList.add("loading");
  btn?.classList.add("spin");
  setFleetUpdated("Yangilanmoqda…");
  fleetRefreshing = refreshVehicles()
    .catch(() => {
      setFleetUpdated("Yangilab bo‘lmadi");
      fleetToast("Haydovchilar ma’lumotini yangilab bo‘lmadi — internetni tekshiring");
    })
    .finally(() => {
      fab?.classList.remove("loading");
      btn?.classList.remove("spin");
      fleetRefreshing = null;
    });
  return fleetRefreshing;
}

function fleetToast(text) {
  const el = document.getElementById("fleet-toast");
  if (!el) return;
  el.textContent = text;
  el.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add("hidden"), 2600);
}

function renderFleet(vehicles) {
  const fab = document.getElementById("fleet-fab");
  if (fab) fab.classList.toggle("hidden", !vehicles.length);
  const online = vehicles.filter((v) => v.online).length;
  const badge = document.getElementById("fleet-fab-badge");
  if (badge) {
    badge.textContent = String(online);
    badge.classList.toggle("on", online > 0);
  }
  const counts = document.getElementById("fleet-counts");
  if (counts) {
    counts.innerHTML = `<span class="fc on">${online} online</span><span class="fc off">${vehicles.length - online} offline</span>`;
  }
  setFleetOpen(fleetOpen);
  const list = document.getElementById("fleet-list");
  if (!list) return;
  const rows = vehicles
    .slice()
    .sort((a, b) => Number(b.online) - Number(a.online) || String(a.name).localeCompare(String(b.name), "uz"));
  list.innerHTML = rows
    .map((v) => {
      const where = v.has_location
        ? escapeHtml(v.address || "Manzil aniqlanmoqda…")
        : "Joylashuv hali kelmagan";
      const picked = String(v.id) === String(pickedVehId) ? " picked" : "";
      return `<button type="button" class="fleet-row${v.online ? " online" : ""}${v.has_location ? "" : " noloc"}${picked}" data-veh="${v.id}">
        <span class="fleet-dot"></span>
        <span class="fleet-main">
          <span class="fleet-name">${escapeHtml(v.name)}${v.plate ? ` <span class="muted">· ${escapeHtml(v.plate)}</span>` : ""}</span>
          <span class="fleet-addr">${where}</span>
        </span>
        <span class="fleet-ago">${escapeHtml(v.online ? agoText(v.gps_at || v.seen_at) : agoText(v.seen_at))}</span>
      </button>`;
    })
    .join("");
}

function focusVehicle(id) {
  const v = lastVehicles.find((x) => String(x.id) === String(id));
  if (!v || !map) return;
  const marker = vehicleMarkers[id];
  if (!v.has_location || !marker) {
    fleetToast(`${v.name}: joylashuv hali kelmagan — ilovaga kirishi kerak`);
    return;
  }
  pickedVehId = id;
  document.querySelectorAll(".fleet-row.picked").forEach((r) => r.classList.remove("picked"));
  document.querySelector(`.fleet-row[data-veh="${id}"]`)?.classList.add("picked");
  const zoom = 16;
  // Panel xaritaning chap qismini yopadi — nuqtani ko‘rinadigan qismning markaziga suramiz
  const panel = document.getElementById("fleet-panel");
  const shift = panel && !panel.classList.contains("hidden") ? panel.offsetWidth / 2 : 0;
  const pt = map.project([v.lat, v.lng], zoom).subtract([shift, 0]);
  map.flyTo(map.unproject(pt, zoom), zoom, { duration: 0.7 });
  setTimeout(() => marker.openPopup(), 750);
}

export async function init(root) {
  map = L.map("map", { zoomControl: false, fadeAnimation: false, zoomAnimation: false }).setView([41.3111, 69.2797], 12);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "© OpenStreetMap",
  }).addTo(map);
  setTimeout(() => {
    map.invalidateSize();
    redrawMap(true);
  }, 40);
  await refreshVehicles().catch(() => {});
  startTimer();
  onSelect = (e) => focusStore(e.detail);
  onChanged = () => redrawMap(true);
  onResize = () => map && map.invalidateSize();
  onDriver = (e) => {
    focusedDriverId = e.detail?.id || null;
    redrawMap(true);
  };
  window.addEventListener("nexus:order-select", onSelect);
  window.addEventListener("nexus:orders-changed", onChanged);
  window.addEventListener("nexus:rail-resize", onResize);
  window.addEventListener("nexus:driver-select", onDriver);
  map.on("zoomend", () => drawStores());
  root.querySelector("#map-fit")?.addEventListener("click", fitStores);
  root.querySelector("#fleet-fab")?.addEventListener("click", () => {
    const open = !fleetOpen;
    setFleetOpen(open);
    if (open) refreshFleetNow();
  });
  root.querySelector("#fleet-refresh")?.addEventListener("click", () => refreshFleetNow());
  root.querySelector("#fleet-close")?.addEventListener("click", () => setFleetOpen(false));
  root.querySelector("#fleet-list")?.addEventListener("click", (e) => {
    const row = e.target.closest("[data-veh]");
    if (row) focusVehicle(row.dataset.veh);
  });
}

function startTimer() {
  if (timer) return;
  timer = setInterval(() => refreshVehicles().catch(() => {}), 15000);
}

function resizeMap() {
  if (!map) return;
  map.invalidateSize();
  redrawMap(true);
}

export function hide() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

export function show() {
  if (!map) return;
  startTimer();
  requestAnimationFrame(() => {
    resizeMap();
    setTimeout(resizeMap, 80);
  });
}

export function destroy() {
  hide();
  vehicleMarkers = {};
  orderMarkers = {};
  selectedId = null;
  focusedDriverId = null;
  pickedVehId = null;
  roadKey = "";
  roadToken += 1;
  if (onSelect) window.removeEventListener("nexus:order-select", onSelect);
  if (onChanged) window.removeEventListener("nexus:orders-changed", onChanged);
  if (onResize) window.removeEventListener("nexus:rail-resize", onResize);
  if (onDriver) window.removeEventListener("nexus:driver-select", onDriver);
  if (map) {
    map.remove();
    map = null;
  }
  pinLayer = null;
  sketchLayer = null;
  roadLayer = null;
}
