import { api, apiDownload, apiUpload, me } from "../api.js";
import { openDriverAccess } from "../driver-access.js?v=68";
import { $, escapeHtml, formData, table, askConfirm, bindPhoneInputs, driverStatusHtml } from "../ui.js?v=68";

const REFRESH_MS = 60000;

let bound = false;
let paneRoot = null;
let refreshTimer = null;

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
      agentSel.innerHTML = agentOptions(agents, "");
    }
    const isAdmin = me?.role === "admin";
    if (!drivers.length) {
      box.innerHTML = `<div class="empty-list">Haydovchi yo‘q. ${isAdmin ? "Yuqoridan qo‘shing yoki Excel import qiling." : "Admin qo‘shishi kerak."}</div>`;
      return;
    }
    box.innerHTML = table(
      ["Ism", "Login", "Telefon", "Raqam", "Holat", "Agent", ""],
      drivers
        .map(
          (d) => `<tr>
          <td>${escapeHtml(d.name)}</td>
          <td>${escapeHtml(d.username || "—")}</td>
          <td>${escapeHtml(d.phone || "—")}</td>
          <td>${escapeHtml(d.vehicle_plate || "—")}</td>
          <td data-status-drv="${d.id}">${driverStatusHtml(d)}</td>
          <td>${
            isAdmin
              ? `<select class="agent-pick" data-agent-drv="${d.id}">${agentOptions(agents, d.agent_id)}</select>`
              : escapeHtml(d.agent_code ? `${d.agent_code} · ${d.agent_name}` : d.agent_name || "—")
          }</td>
          <td>${
            isAdmin
              ? `<button class="btn tiny" type="button" data-access="${d.id}">Kirish</button>
                 <button class="btn tiny" type="button" data-del="${d.id}">O‘chirish</button>`
              : ""
          }</td>
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

function showMsg(root, text, ok = false) {
  const err = $("#driver-err", root);
  if (!err) return;
  err.classList.remove("hidden");
  err.style.color = ok ? "var(--ok)" : "";
  err.textContent = text;
}

export async function init(root) {
  paneRoot = root;
  const isAdmin = me?.role === "admin";
  root.querySelectorAll(".admin-only").forEach((el) => el.classList.toggle("hidden", !isAdmin));
  const hint = $("#driver-hint", root);
  if (hint) {
    hint.textContent = isAdmin
      ? "Har bir haydovchiga istalgan agent kodini ro‘yxatdan tanlab biriktiring."
      : "Haydovchilarni faqat administrator qo‘shadi.";
  }
  if (!bound) {
    bound = true;
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
          showMsg(root, `Haydovchi qo‘shildi. Login: ${created.username || "—"} · Parol: ${created.password || "—"}`, true);
          await load(root);
          if (created.id) openDriverAccess(created.id, created.password).catch(() => {});
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
  startRefresh();
  await load(paneRoot);
}

export function hide() {
  stopRefresh();
}

export function destroy() {
  stopRefresh();
  bound = false;
  paneRoot = null;
}
