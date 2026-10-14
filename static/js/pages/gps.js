import { api, apiDownload } from "../api.js";
import { $, escapeHtml, table } from "../ui.js?v=88";

const LIVE_MS = 60000;
const GAP_SEC = 20 * 60;
const PLACE_KIND = { client: "Klient", warehouse: "Sklad", client_base: "Klient (baza)" };

let paneRoot = null;
let bound = false;
let visible = false;
let liveTimer = null;
let map = null;
let layer = null;
let markers = new Map();
let lastKey = "";
let loading = false;
let freshInit = false;
const addrCache = new Map();

const pad = (n) => String(n).padStart(2, "0");

function ymd(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function today() {
  return ymd(new Date());
}

function hm(iso) {
  return iso ? String(iso).slice(11, 16) : "—";
}

function dayLabel(day) {
  const [y, m, d] = String(day).split("-");
  return `${d}.${m}.${y}`;
}

function dur(sec) {
  sec = Math.max(0, Math.round(Number(sec) || 0));
  if (sec < 60) return `${sec} son`;
  const min = Math.round(sec / 60);
  const h = Math.floor(min / 60);
  return h ? `${h} soat ${min % 60} daq` : `${min} daq`;
}

function km(m) {
  return `${((Number(m) || 0) / 1000).toLocaleString("ru-RU", { maximumFractionDigits: 1 })} km`;
}

function stamp(iso) {
  if (!iso) return "—";
  const s = String(iso);
  return `${s.slice(8, 10)}.${s.slice(5, 7)} ${s.slice(11, 16)}`;
}

function params() {
  const r = paneRoot;
  return {
    driver: $("#gps-driver", r).value,
    from: $("#gps-from", r).value || today(),
    to: $("#gps-to", r).value || $("#gps-from", r).value || today(),
    min: $("#gps-min", r).value || "5",
  };
}

function query(p) {
  const q = new URLSearchParams({ date_from: p.from, date_to: p.to, min_stop: p.min });
  if (p.driver) q.set("driver_id", p.driver);
  return q.toString();
}

function setErr(text) {
  const el = $("#gps-err", paneRoot);
  el.textContent = text || "";
  el.classList.toggle("hidden", !text);
}

function isLive(p) {
  return p.from <= today() && today() <= p.to;
}

function setStatus(p, failed = false) {
  const el = $("#gps-status", paneRoot);
  const now = new Date();
  if (failed) {
    el.innerHTML = `<span class="adm-pill warn">Server bilan aloqa yo‘q — keyingi urinish 1 daqiqadan keyin</span>`;
    return;
  }
  el.innerHTML = isLive(p)
    ? `<span class="adm-pill on"><i class="gps-live-dot"></i> Jonli</span><span class="muted">Telefondan kelayotgan GPS har daqiqada yangilanadi · oxirgi: ${pad(now.getHours())}:${pad(now.getMinutes())}</span>`
    : `<span class="muted">Tarix: ${dayLabel(p.from)}${p.to !== p.from ? ` — ${dayLabel(p.to)}` : ""}</span>`;
}

function markPresets() {
  const p = params();
  const t = today();
  const y = new Date();
  y.setDate(y.getDate() - 1);
  const w = new Date();
  w.setDate(w.getDate() - 6);
  const on = { today: p.from === t && p.to === t, yesterday: p.from === ymd(y) && p.to === ymd(y), 7: p.from === ymd(w) && p.to === t };
  paneRoot.querySelectorAll("[data-gps-preset]").forEach((b) => b.classList.toggle("on", !!on[b.dataset.gpsPreset]));
}

function applyPreset(name) {
  const t = new Date();
  let from = new Date(t);
  let to = new Date(t);
  if (name === "yesterday") {
    from.setDate(from.getDate() - 1);
    to = new Date(from);
  } else if (name === "7") {
    from.setDate(from.getDate() - 6);
  }
  $("#gps-from", paneRoot).value = ymd(from);
  $("#gps-to", paneRoot).value = ymd(to);
}

async function loadDrivers() {
  const sel = $("#gps-driver", paneRoot);
  const keep = sel.value;
  const drivers = await api("/drivers");
  drivers.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  sel.innerHTML =
    `<option value="">Barcha haydovchilar</option>` +
    drivers
      .map((d) => `<option value="${d.id}">${escapeHtml(d.name)}${d.vehicle_plate ? ` · ${escapeHtml(d.vehicle_plate)}` : ""}</option>`)
      .join("");
  if (keep && drivers.some((d) => String(d.id) === keep)) sel.value = keep;
}

function kpis(s, mode) {
  const cards = [
    ["Yurgan yo‘li", km(s.distance_m), "GPS nuqtalari bo‘yicha", "accent"],
    ["Harakatda", dur(s.move_sec), "", ""],
    ["To‘xtashlarda", dur(s.stop_sec), `${s.stops} ta to‘xtash`, "ok"],
    ["Eng uzun to‘xtash", dur(s.longest_stop_sec), "", ""],
    ["Signal yo‘q", dur(s.gap_sec), "20 daqiqadan uzun uzilishlar", s.gap_sec ? "bad" : ""],
    ["Birinchi / oxirgi signal", `${stamp(s.first_at)}`, `oxirgi: ${stamp(s.last_at)}`, ""],
  ];
  if (mode === "all") cards.pop();
  $("#gps-kpis", paneRoot).innerHTML = cards
    .map(([label, value, sub, cls]) => `<div class="rep-kpi ${cls}"><span>${label}</span><b>${value}</b><em>${escapeHtml(sub)}</em></div>`)
    .join("");
}

function ensureMap() {
  if (map) return;
  map = L.map($("#gps-map", paneRoot), { zoomControl: true, fadeAnimation: false }).setView([41.3111, 69.2797], 12);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "© OpenStreetMap" }).addTo(map);
  layer = L.layerGroup().addTo(map);
}

function placeKind(it) {
  if (it.ongoing) return "now";
  return it.place?.kind || "unknown";
}

function stopPopup(it) {
  const pl = it.place || {};
  const name = pl.name ? `${escapeHtml(pl.name)}${PLACE_KIND[pl.kind] ? ` <span class="muted">(${PLACE_KIND[pl.kind]})</span>` : ""}` : "Noma’lum joy";
  return `<b>№${it.no} · ${hm(it.start)}–${it.ongoing ? "hozir" : hm(it.end)}</b><br>${dur(it.seconds)} turdi<br>${name}`;
}

function drawMap(rep, refit) {
  ensureMap();
  layer.clearLayers();
  markers = new Map();
  const track = rep.track || [];
  let seg = [];
  const segs = [];
  const gaps = [];
  track.forEach((p, i) => {
    if (i && p[2] - track[i - 1][2] >= GAP_SEC) {
      if (seg.length > 1) segs.push(seg);
      gaps.push([track[i - 1], p]);
      seg = [];
    }
    seg.push([p[0], p[1]]);
  });
  if (seg.length > 1) segs.push(seg);
  segs.forEach((s) => L.polyline(s, { color: "#2563eb", weight: 4, opacity: 0.75 }).addTo(layer));
  gaps.forEach(([a, b]) =>
    L.polyline([[a[0], a[1]], [b[0], b[1]]], { color: "#94a3b8", weight: 3, dashArray: "6 8", opacity: 0.9 })
      .bindTooltip(`Signal yo‘q: ${dur(b[2] - a[2])}`)
      .addTo(layer)
  );
  if (track.length) {
    const f = track[0];
    L.circleMarker([f[0], f[1]], { radius: 6, color: "#16a34a", fillColor: "#fff", fillOpacity: 1, weight: 3 })
      .bindTooltip("Kunning birinchi nuqtasi")
      .addTo(layer);
  }
  rep.days.forEach((day) =>
    day.items
      .filter((it) => it.type === "stop")
      .forEach((it) => {
        const icon = L.divIcon({
          className: `gps-pin gps-pin-${placeKind(it)}`,
          html: `<span>${it.no}</span>`,
          iconSize: [28, 28],
          iconAnchor: [14, 14],
        });
        const m = L.marker([it.lat, it.lng], { icon, zIndexOffset: it.ongoing ? 1000 : 0 }).bindPopup(stopPopup(it)).addTo(layer);
        markers.set(String(it.no), m);
      })
  );
  setTimeout(() => {
    map.invalidateSize();
    if (!refit) return;
    const pts = track.map((p) => [p[0], p[1]]);
    if (pts.length > 1) map.fitBounds(L.latLngBounds(pts), { padding: [30, 30], maxZoom: 16 });
    else if (pts.length === 1) map.setView(pts[0], 15);
  }, 30);
}

function orderChips(pl) {
  const list = pl?.orders || [];
  if (!list.length) return "";
  return `<div class="gps-orders">${list
    .map(
      (o) =>
        `<span class="gps-order ${o.done_here ? "done" : ""}" title="${escapeHtml(o.client || "")}">${escapeHtml(o.code)}${
          o.done_here ? ` · yakunlandi ${hm(o.proof_at)}` : ""
        }</span>`
    )
    .join("")}</div>`;
}

function addrKey(it) {
  return `${Number(it.lat).toFixed(4)},${Number(it.lng).toFixed(4)}`;
}

function stopHtml(it) {
  const pl = it.place || {};
  const kind = placeKind(it);
  const key = addrKey(it);
  const title = pl.name
    ? `${escapeHtml(pl.name)} <span class="gps-kind">${PLACE_KIND[pl.kind] || ""}</span>`
    : `<span class="muted">Noma’lum joy</span>`;
  const addr = pl.address || addrCache.get(key) || "";
  return `<li class="gps-item stop k-${kind}" data-stop="${it.no}">
    <span class="gps-no">${it.no}</span>
    <div class="gps-main">
      <div class="gps-row1"><b>${hm(it.start)} – ${it.ongoing ? "hozir" : hm(it.end)}</b><span class="gps-dur">${dur(it.seconds)}</span>${
    it.ongoing ? `<span class="adm-pill on">hozir ham shu yerda</span>` : ""
  }</div>
      <div class="gps-place">${title}</div>
      <div class="gps-addr muted" ${pl.name || addr ? "" : `data-addr="${key}"`}>${escapeHtml(addr) || (pl.name ? "" : "manzil aniqlanmoqda…")}</div>
      ${it.silent_sec ? `<div class="gps-note">Turgan paytda telefon ${dur(it.silent_sec)} signal yubormagan (joyi o‘zgarmagan)</div>` : ""}
      ${orderChips(pl)}
    </div>
    <a class="gps-maplink" href="https://maps.google.com/?q=${it.lat},${it.lng}" target="_blank" rel="noopener" title="Google xaritada ochish">↗</a>
  </li>`;
}

function itemHtml(it) {
  if (it.type === "stop") return stopHtml(it);
  if (it.type === "gap") {
    return `<li class="gps-item gap"><span class="gps-ico">!</span><div class="gps-main"><b>Signal yo‘q: ${hm(it.start)} – ${hm(it.end)}</b> <span class="gps-dur">${dur(
      it.seconds
    )}</span><div class="muted">Telefon GPS yubormagan (o‘chiq, internet yo‘q yoki ilova yopilgan). Keyin ${km(it.distance_m)} narida paydo bo‘ldi.</div></div></li>`;
  }
  return `<li class="gps-item move"><span class="gps-ico">→</span><div class="gps-main">Harakat ${hm(it.start)} – ${hm(it.end)} · ${dur(it.seconds)} · ${km(
    it.distance_m
  )}</div></li>`;
}

function renderOne(rep, refit) {
  $("#gps-all", paneRoot).innerHTML = "";
  $("#gps-body", paneRoot).classList.remove("hidden");
  kpis(rep.summary, "one");
  const list = $("#gps-list", paneRoot);
  if (!rep.days.length) {
    list.innerHTML = `<div class="empty-list">Tanlangan kunlarda bu haydovchidan GPS ma’lumoti kelmagan. Haydovchi ilovaga kirgan va joylashuvga ruxsat bergan bo‘lishi kerak.</div>`;
  } else {
    const keepScroll = refit ? 0 : list.scrollTop;
    list.innerHTML = rep.days
      .map(
        (d) => `<div class="gps-day"><div class="gps-day-head"><b>${dayLabel(d.date)}</b><span class="muted">${d.summary.stops} ta to‘xtash · ${dur(
          d.summary.stop_sec
        )} turgan · ${km(d.summary.distance_m)} · ${hm(d.summary.first_at)}–${hm(d.summary.last_at)}</span></div><ol class="gps-items">${d.items
          .map(itemHtml)
          .join("")}</ol></div>`
      )
      .join("");
    list.scrollTop = keepScroll;
  }
  drawMap(rep, refit);
  resolveAddresses();
}

function renderAll(rep) {
  $("#gps-body", paneRoot).classList.add("hidden");
  const sum = rep.drivers.reduce(
    (acc, r) => {
      ["distance_m", "move_sec", "stop_sec", "gap_sec", "stops", "points"].forEach((k) => (acc[k] += r.summary[k] || 0));
      acc.longest_stop_sec = Math.max(acc.longest_stop_sec, r.summary.longest_stop_sec || 0);
      return acc;
    },
    { distance_m: 0, move_sec: 0, stop_sec: 0, gap_sec: 0, stops: 0, points: 0, longest_stop_sec: 0 }
  );
  kpis(sum, "all");
  const rows = rep.drivers
    .map(({ driver: d, summary: s }) => {
      const none = !s.points;
      return `<tr class="${none ? "gps-none" : ""}">
        <td><b>${escapeHtml(d.name)}</b>${d.plate ? `<div class="muted">${escapeHtml(d.plate)}</div>` : ""}</td>
        <td>${none ? "—" : stamp(s.first_at)}</td>
        <td>${none ? "—" : stamp(s.last_at)}</td>
        <td>${none ? "—" : km(s.distance_m)}</td>
        <td>${none ? "—" : dur(s.move_sec)}</td>
        <td>${none ? "—" : `${dur(s.stop_sec)} <span class="muted">(${s.stops} ta)</span>`}</td>
        <td>${none ? "—" : dur(s.longest_stop_sec)}</td>
        <td>${none ? "—" : s.gap_sec ? `<span class="gps-warn">${dur(s.gap_sec)}</span>` : "—"}</td>
        <td class="col-actions">${none ? `<span class="muted">GPS kelmagan</span>` : `<button class="btn tiny" type="button" data-gps-open="${d.id}">Batafsil</button>`}</td>
      </tr>`;
    })
    .join("");
  $("#gps-all", paneRoot).innerHTML = rep.drivers.length
    ? table(["Haydovchi", "Birinchi signal", "Oxirgi signal", "Yo‘l", "Harakatda", "To‘xtashlarda", "Eng uzun", "Signal yo‘q", ""], rows)
    : `<div class="empty-list">Haydovchi yo‘q.</div>`;
}

let addrBusy = false;
async function resolveAddresses() {
  if (addrBusy) return;
  addrBusy = true;
  try {
    for (;;) {
      const el = paneRoot?.querySelector("[data-addr]");
      if (!el || !visible) break;
      const key = el.dataset.addr;
      let text = addrCache.get(key);
      if (text === undefined) {
        const [lat, lng] = key.split(",");
        try {
          text = (await api(`/geo/reverse?lat=${lat}&lng=${lng}`)).address || "";
        } catch {
          text = "";
        }
        addrCache.set(key, text);
      }
      paneRoot.querySelectorAll(`[data-addr="${key}"]`).forEach((n) => {
        n.textContent = text || `${key.replace(",", ", ")}`;
        n.removeAttribute("data-addr");
      });
    }
  } finally {
    addrBusy = false;
  }
}

async function load({ refit = false, silent = false } = {}) {
  if (!paneRoot || loading) return;
  const p = params();
  const key = `${p.driver}|${p.from}|${p.to}|${p.min}`;
  refit = refit || key !== lastKey;
  loading = true;
  if (!silent) setErr("");
  markPresets();
  try {
    const rep = await api(`/gps/report?${query(p)}`);
    lastKey = key;
    if (rep.mode === "one") renderOne(rep, refit);
    else renderAll(rep);
    setErr("");
    setStatus(p);
  } catch (ex) {
    if (silent) setStatus(p, true);
    else setErr(ex.message || "Hisobotni olib bo‘lmadi");
  } finally {
    loading = false;
  }
}

function startLive() {
  stopLive();
  liveTimer = setInterval(() => {
    if (!visible || document.hidden) return;
    if (isLive(params())) load({ silent: true });
  }, LIVE_MS);
}

function stopLive() {
  if (liveTimer) clearInterval(liveTimer);
  liveTimer = null;
}

function driverFromUrl() {
  return new URLSearchParams(location.search).get("driver") || "";
}

export async function init(root) {
  paneRoot = root;
  visible = true;
  $("#gps-from", root).value = today();
  $("#gps-to", root).value = today();
  if (!bound) {
    bound = true;
    root.addEventListener("click", (e) => {
      const preset = e.target.closest("[data-gps-preset]")?.dataset.gpsPreset;
      if (preset) {
        applyPreset(preset);
        load();
        return;
      }
      const open = e.target.closest("[data-gps-open]")?.dataset.gpsOpen;
      if (open) {
        $("#gps-driver", root).value = open;
        load({ refit: true });
        return;
      }
      const stop = e.target.closest("[data-stop]");
      if (stop && !e.target.closest("a") && map) {
        const m = markers.get(stop.dataset.stop);
        if (m) {
          map.setView(m.getLatLng(), Math.max(map.getZoom(), 16));
          m.openPopup();
          root.querySelectorAll(".gps-item.sel").forEach((n) => n.classList.remove("sel"));
          stop.classList.add("sel");
        }
      }
    });
    $("#gps-show", root).onclick = () => load({ refit: true });
    ["#gps-driver", "#gps-min"].forEach((s) => ($(s, root).onchange = () => load()));
    ["#gps-from", "#gps-to"].forEach((s) => ($(s, root).onchange = () => markPresets()));
    $("#gps-excel", root).onclick = async () => {
      const p = params();
      try {
        await apiDownload(`/gps/report.xlsx?${query(p)}`, `GPS_hisobot_${p.from}${p.to !== p.from ? `_${p.to}` : ""}.xlsx`);
      } catch (ex) {
        setErr(ex.message);
      }
    };
  }
  try {
    await loadDrivers();
  } catch (ex) {
    setErr(ex.message);
  }
  const want = driverFromUrl();
  if (want) $("#gps-driver", root).value = want;
  await load({ refit: true });
  freshInit = true;
  startLive();
}

export async function show() {
  if (!paneRoot) return;
  visible = true;
  if (freshInit) {
    freshInit = false;
    return;
  }
  const want = driverFromUrl();
  if (want && $("#gps-driver", paneRoot).value !== want) {
    await loadDrivers().catch(() => {});
    $("#gps-driver", paneRoot).value = want;
  }
  await load({ refit: !!want });
  startLive();
  if (map) setTimeout(() => map.invalidateSize(), 30);
}

export function refresh() {
  return load({ silent: true });
}

export function hide() {
  visible = false;
  stopLive();
}

export function destroy() {
  stopLive();
  map?.remove();
  map = null;
  layer = null;
  markers = new Map();
  bound = false;
  visible = false;
  paneRoot = null;
  lastKey = "";
}
