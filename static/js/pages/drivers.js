import { api, apiDownload, apiUpload, can } from "../api.js";
import { onDriverAccessChange, openDriverAccess } from "../driver-access.js?v=91";
import { openDriverPerms } from "../driver-perms.js?v=103";
import { $, escapeHtml, formData, table, askConfirm, bindPhoneInputs, driverStatusHtml } from "../ui.js?v=91";

const REFRESH_MS = 60000;

const ICON_GPS = `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 21s-6-5.3-6-10a6 6 0 1 1 12 0c0 4.7-6 10-6 10Z"/><circle cx="12" cy="11" r="2.2"/></svg>`;
const ICON_LOGIN = `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><polyline points="10 17 15 12 10 7"/><line x1="15" y1="12" x2="3" y2="12"/></svg>`;
const ICON_PERMS = `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3 5 6v6c0 4.2 2.8 7.4 7 9 4.2-1.6 7-4.8 7-9V6l-7-3z"/><path d="m9 12 2 2 4-4"/></svg>`;
const ICON_TRASH = `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>`;

let bound = false;
let paneRoot = null;
let refreshTimer = null;
let offAccessChange = null;

function clockNow() {
  return new Date().toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
}

function renderLiveBar(root, drivers, failed = false) {
  const bar = $("#drv-live", root);
  if (!bar) return;
  if (failed) {
    bar.innerHTML = `<span class="adm-pill warn">Server bilan aloqa yo‘q — holatlar yangilanmayapti</span>`;
    return;
  }
  const online = drivers.filter((d) => d.online).length;
  bar.innerHTML = `<span class="adm-pill on">Online <b>${online}</b></span>
    <span class="adm-pill">Offline <b>${drivers.length - online}</b></span>
    <span class="drv-live-time">Har daqiqada yangilanadi · oxirgi: ${clockNow()}</span>`;
}

async function refreshStatus(root) {
  let drivers;
  try {
    drivers = await api("/drivers");
  } catch {
    renderLiveBar(root, [], true);
    return;
  }
  const cells = [...root.querySelectorAll("[data-status-drv]")];
  const byId = new Map(drivers.map((d) => [String(d.id), d]));
  if (cells.length !== drivers.length || cells.some((c) => !byId.has(c.dataset.statusDrv))) {
    await load(root);
    return;
  }
  cells.forEach((c) => {
    c.innerHTML = driverStatusHtml(byId.get(c.dataset.statusDrv));
  });
  renderLiveBar(root, drivers);
}

function startRefresh() {
  stopRefresh();
  refreshTimer = setInterval(() => {
    if (paneRoot) refreshStatus(paneRoot);
  }, REFRESH_MS);
}

function stopRefresh() {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = null;
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

async function load(root) {
  const err = $("#driver-err", root);
  const box = $("#drivers-table", root);
  if (!box) return;
  try {
    const [drivers, agents] = await Promise.all([api("/drivers"), api("/agents")]);
    const agentSel = $("#driver-agent", root);
    if (agentSel) {
      // Yarim to‘ldirilgan formadagi tanlov yangilanishda tushib qolmasin
      const keep = agentSel.value;
      agentSel.innerHTML = agentOptions(agents, keep);
    }
    const manage = can("drivers.manage");
    const access = can("drivers.access");
    const gps = can("tracking.live");
    const staff = manage || access;
    if (!drivers.length) {
      box.innerHTML = `<div class="empty-list">Haydovchi yo‘q. ${manage ? "Yuqoridan qo‘shing yoki Excel import qiling." : "Qo‘shish uchun dostup kerak."}</div>`;
      return;
    }
    const loginCell = (d) =>
      d.username
        ? `${escapeHtml(d.username)}${d.has_password ? "" : ` <span class="adm-pill warn">parol yo‘q</span>`}`
        : `<span class="muted">berilmagan</span>`;
    box.innerHTML = table(
      ["Ism", ...(access ? ["Login"] : []), "Telefon", "Raqam", "Holat", "Agent", ""],
      drivers
        .map(
          (d) => `<tr>
          <td>${escapeHtml(d.name)}</td>
          ${access ? `<td>${loginCell(d)}</td>` : ""}
          <td>${escapeHtml(d.phone || "—")}</td>
          <td>${escapeHtml(d.vehicle_plate || "—")}</td>
          <td data-status-drv="${d.id}">${driverStatusHtml(d)}</td>
          <td>${
            manage
              ? `<select class="agent-pick" data-agent-drv="${d.id}">${agentOptions(agents, d.agent_id)}</select>`
              : escapeHtml(d.agent_code ? `${d.agent_code} · ${d.agent_name}` : d.agent_name || "—")
          }</td>
          <td class="col-actions"><div class="row-icons">${
            gps
              ? `<a class="icon-btn row-icon" href="/gps?driver=${d.id}" data-link title="Bugungi GPS hisobot: qayerda qancha turgani" aria-label="GPS">${ICON_GPS}</a>`
              : ""
          }${
            access
              ? `<button class="icon-btn row-icon" type="button" data-access="${d.id}" title="Ilovaga kirish: login, parol, QR" aria-label="Kirish">${ICON_LOGIN}</button>`
              : ""
          }${
            staff
              ? `<button class="icon-btn row-icon" type="button" data-perms="${d.id}" title="Ilova ruxsatlari" aria-label="Ruxsatlar">${ICON_PERMS}</button>`
              : ""
          }${
            manage
              ? `<button class="icon-btn row-icon danger" type="button" data-del="${d.id}" title="O‘chirish" aria-label="O‘chirish">${ICON_TRASH}</button>`
              : ""
          }</div></td>
        </tr>`
        )
        .join("")
    );
    renderLiveBar(root, drivers);
  } catch (ex) {
    if (err) {
      err.classList.remove("hidden");
      err.textContent = ex.message || "Haydovchilarni yuklab bo‘lmadi";
    }
    box.innerHTML = `<div class="empty-list">Ro‘yxatni ochib bo‘lmadi.</div>`;
  }
}

async function driverTplId() {
  const tpls = await api("/templates");
  return tpls.find((t) => t.entity === "drivers" && t.status === "approved")?.id;
}

function applyDriverPerms(root) {
  const manage = can("drivers.manage");
  const access = can("drivers.access");
  root.querySelectorAll(".admin-only").forEach((el) => el.classList.toggle("hidden", !manage));
  const hint = $("#driver-hint", root);
  if (!hint) return;
  if (manage && access) hint.textContent = "Haydovchiga agent biriktiring. «Kirish» — login va QR, «Ruxsatlar» — ilovada nima qila olishi.";
  else if (access) hint.textContent = "«Kirish» — login, parol yoki QR. «Ruxsatlar» — ilovada nima qila olishi.";
  else if (manage) hint.textContent = "Agentni ro‘yxatdan biriktiring. «Ruxsatlar» — ilovada nima qila olishi.";
  else hint.textContent = "Ro‘yxatni ko‘rish rejimi: qo‘shish va kirish berish uchun dostup kerak.";
}

function showMsg(root, text, ok = false) {
  const err = $("#driver-err", root);
  if (!err) return;
  err.classList.remove("hidden");
  err.style.color = ok ? "var(--ok)" : "";
  err.textContent = text;
}

export async function init(root) {
  paneRoot = root;
  applyDriverPerms(root);
  if (!bound) {
    bound = true;
    offAccessChange = onDriverAccessChange(() => paneRoot && load(paneRoot));
    const openBtn = root.querySelector("[data-open]");
    if (openBtn) {
      openBtn.onclick = () => $("#driver-form", root)?.classList.toggle("hidden");
    }
    const excelBtn = $("#page-drv-excel", root);
    if (excelBtn) {
      excelBtn.onclick = async () => {
        try {
          const id = await driverTplId();
          if (id) await apiDownload(`/templates/${id}/excel`, "Haydovchilar_shablon.xlsx");
          else await apiDownload("/templates/excel?entity=drivers", "Haydovchilar_shablon.xlsx");
        } catch (ex) {
          showMsg(root, ex.message);
        }
      };
    }
    const importBtn = $("#page-drv-import-btn", root);
    const importFile = $("#page-drv-import-file", root);
    if (importBtn && importFile) {
      importBtn.onclick = () => {
        importFile.value = "";
        importFile.click();
      };
      importFile.onchange = async () => {
        const file = importFile.files[0];
        if (!file) return;
        try {
          const data = await apiUpload("/drivers/import", file);
          const extra = data.skipped ? `, ${data.skipped} qator o‘tkazib yuborildi` : "";
          const why = Array.isArray(data.reasons) && data.reasons.length ? ` (${data.reasons.join("; ")})` : "";
          const logins = (data.logins || [])
            .map((l) => `${l.name}: ${l.username}/${l.password || "—"}`)
            .join("; ");
          showMsg(root, `${data.created} ta haydovchi import qilindi${extra}${why}.${logins ? " " + logins : ""}`, true);
          await load(root);
        } catch (ex) {
          showMsg(root, ex.message);
        } finally {
          importFile.value = "";
        }
      };
    }
    const form = $("#driver-form", root);
    if (form) {
      form.onsubmit = async (e) => {
        e.preventDefault();
        const d = formData(e.target);
        d.agent_id = d.agent_id ? Number(d.agent_id) : null;
        try {
          const created = await api("/drivers", { method: "POST", body: d });
          e.target.reset();
          form.classList.add("hidden");
          const canAccess = can("drivers.access");
          showMsg(
            root,
            canAccess
              ? `Haydovchi qo‘shildi. Login: ${created.username || "—"} · Parol: ${created.password || "—"}`
              : "Haydovchi qo‘shildi. Ilovaga kirishni dostupi bor akkaunt beradi.",
            true
          );
          await load(root);
          if (created.id && canAccess) openDriverAccess(created.id, created.password).catch(() => {});
        } catch (ex) {
          showMsg(root, ex.message);
        }
      };
    }
    root.addEventListener("change", async (e) => {
      const sel = e.target.closest("[data-agent-drv]");
      if (!sel) return;
      sel.disabled = true;
      try {
        const updated = await api(`/drivers/${sel.dataset.agentDrv}/agent`, {
          method: "PUT",
          body: { agent_id: sel.value ? Number(sel.value) : null },
        });
        const label = updated.agent_code ? `${updated.agent_code} · ${updated.agent_name}` : "Agent yo‘q";
        showMsg(root, `${updated.name}: ${label}`, true);
      } catch (ex) {
        showMsg(root, ex.message);
        await load(root);
      } finally {
        sel.disabled = false;
      }
    });
    root.addEventListener("click", async (e) => {
      const permsId = e.target.closest("[data-perms]")?.dataset?.perms;
      if (permsId) {
        try {
          await openDriverPerms(permsId);
        } catch (ex) {
          showMsg(root, ex.message);
        }
        return;
      }
      const accessId = e.target.closest("[data-access]")?.dataset?.access;
      if (accessId) {
        try {
          await openDriverAccess(accessId);
        } catch (ex) {
          showMsg(root, ex.message);
        }
        return;
      }
      const id = e.target.closest("[data-del]")?.dataset?.del;
      if (!id) return;
      if (!(await askConfirm("Haydovchini o‘chirasizmi?", { title: "O‘chirish", ok: "O‘chirish", danger: true }))) return;
      try {
        await api(`/drivers/${id}`, { method: "DELETE" });
        await load(root);
      } catch (ex) {
        showMsg(root, ex.message);
      }
    });
  }
  bindPhoneInputs(root);
  await load(root);
  startRefresh();
}

export async function show() {
  if (!paneRoot) return;
  applyDriverPerms(paneRoot);
  startRefresh();
  await load(paneRoot);
}

export function hide() {
  stopRefresh();
}

export function destroy() {
  stopRefresh();
  offAccessChange?.();
  offAccessChange = null;
  bound = false;
  paneRoot = null;
}
