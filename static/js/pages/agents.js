import { api, can, me } from "../api.js";
import { $, escapeHtml, formData, table, askConfirm, bindPhoneInputs } from "../ui.js?v=73";

let bound = false;
let paneRoot = null;
let agentsCache = [];

const ICON_PENCIL = `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>`;
const ICON_TRASH = `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>`;

function isAdmin() {
  return me?.role === "admin";
}

function canManage() {
  return isAdmin() || can("agents.manage");
}

function canSetCode(agent) {
  if (isAdmin()) return true;
  if (agent?.code_locked) return false;
  return can("agents.code.set") || can("agents.manage");
}

function canOpenEditor(agent) {
  if (!agent) return canManage();
  return canManage() || canSetCode(agent);
}

function modal(root) {
  return $("#agent-edit-modal", root);
}

function formEl(root) {
  return $("#agent-form", root);
}

function showErr(el, text) {
  if (!el) return;
  el.classList.toggle("hidden", !text);
  el.textContent = text || "";
}

function closeEditor(root) {
  const form = formEl(root);
  form?.reset();
  if (form?.elements.id) form.elements.id.value = "";
  if (form?.elements.is_active) form.elements.is_active.checked = true;
  modal(root)?.classList.add("hidden");
  showErr($("#agent-edit-err", root), "");
}

function openEditor(root, agent) {
  const form = formEl(root);
  const title = $("#agent-edit-title", root);
  if (!form) return;
  form.reset();
  showErr($("#agent-edit-err", root), "");
  const codeOnly = Boolean(agent) && !canManage() && canSetCode(agent);
  if (title) {
    title.textContent = agent ? (codeOnly ? "Agent kodini kiritish" : "Agentni tahrirlash") : "Yangi agent";
  }
  form.elements.id.value = agent?.id || "";
  form.elements.code.value = agent?.code || "";
  form.elements.name.value = agent?.name || "";
  form.elements.phone.value = agent?.phone || "";
  form.elements.region.value = agent?.region || "";
  form.elements.commission_pct.value = agent?.commission_pct ?? 5;
  form.elements.is_active.checked = agent ? Boolean(agent.is_active) : true;
  const codeLocked = Boolean(agent?.code_locked) && !isAdmin();
  const allowCode = !agent || canSetCode(agent);
  form.elements.code.required = true;
  form.elements.code.readOnly = !allowCode || codeLocked;
  ["name", "phone", "region", "commission_pct"].forEach((key) => {
    if (form.elements[key]) form.elements[key].readOnly = codeOnly;
  });
  if (form.elements.is_active) form.elements.is_active.disabled = codeOnly;
  const hint = $("#agent-edit-hint", root);
  if (hint) {
    if (codeOnly) hint.textContent = "Kodni bir marta kiritasiz. Keyin faqat administrator o‘zgartira oladi.";
    else if (codeLocked) hint.textContent = "Kod kiritilgan. Uni faqat administrator o‘zgartira oladi.";
    else hint.textContent = "Kod majburiy (01–99). Excel «Код торгового» ustuni shu kodga mos tushadi.";
  }
  modal(root)?.classList.remove("hidden");
  bindPhoneInputs(root);
  if (allowCode && !codeLocked) form.elements.code?.focus();
  else form.elements.name?.focus();
}

async function load(root) {
  const box = $("#agents-table", root);
  const err = $("#agent-err", root);
  if (!box) return;
  try {
    showErr(err, "");
    const agents = await api("/agents");
  agentsCache = agents;
  const manage = canManage();
  const headers = manage || can("agents.code.set")
    ? ["Kod", "Ism", "Telefon", "Hudud", "Haydovchilar", ""]
    : ["Kod", "Ism", "Telefon", "Hudud", "Haydovchilar"];
  box.innerHTML = table(
    headers,
    agents
      .map((a) => {
        const buttons = [];
        if (canOpenEditor(a)) {
          buttons.push(`<button class="icon-btn row-icon" type="button" data-edit="${a.id}" title="${canSetCode(a) && !manage ? "Kod kiritish" : "Tahrirlash"}">${ICON_PENCIL}</button>`);
        }
        if (isAdmin()) {
          buttons.push(`<button class="icon-btn row-icon danger" type="button" data-del="${a.id}" title="O‘chirish">${ICON_TRASH}</button>`);
        }
        const actions = buttons.length
          ? `<td class="col-actions"><div class="row-icons">${buttons.join("")}</div></td>`
          : "";
        const lockMark = a.code_locked ? `<span class="muted"> qulf</span>` : "";
        return `<tr>
          <td><b>${escapeHtml(a.code || "—")}</b>${lockMark}</td>
          <td>${escapeHtml(a.name)}</td>
          <td>${escapeHtml(a.phone || "—")}</td>
          <td>${escapeHtml(a.region)}</td>
          <td>${a.driver_count || 0}</td>
          ${actions}
        </tr>`;
      })
      .join("")
  );
  } catch (ex) {
    showErr(err, ex.message || "Agentlarni yuklab bo‘lmadi");
    box.innerHTML = `<div class="empty-list">Ro‘yxatni ochib bo‘lmadi.</div>`;
  }
}

function normCode(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return "";
  return digits.padStart(2, "0").slice(-2);
}

function payloadFromForm(form) {
  const d = formData(form);
  const id = Number(d.id || 0);
  return {
    id,
    body: {
      name: String(d.name || "").trim(),
      code: normCode(d.code),
      phone: String(d.phone || "").trim(),
      region: String(d.region || "").trim(),
      commission_pct: Number(d.commission_pct || 5),
      is_active: Boolean(form.elements.is_active?.checked),
    },
  };
}

export async function init(root) {
  paneRoot = root;
  const openBtn = root.querySelector("[data-open]");
  if (openBtn) openBtn.classList.toggle("hidden", !canManage());
  const hint = $("#agent-hint", root);
  if (hint) {
    if (isAdmin()) hint.textContent = "Qalamcha bilan tahrirlang. Kod Excel «Код торгового» ustuniga mos bo‘lsin.";
    else if (canManage()) hint.textContent = "Agent kodini bir marta kiritasiz, keyin faqat admin o‘zgartiradi.";
    else if (can("agents.code.set")) hint.textContent = "Kod bo‘sh yoki qulfsiz agentlarga kodni bir marta kiritasiz. Keyin faqat admin o‘zgartiradi.";
    else hint.textContent = "Agentlar ro‘yxati. Tahrirlash faqat administrator uchun.";
  }
  if (!bound) {
    bound = true;
    if (openBtn) {
      openBtn.onclick = () => openEditor(root, null);
    }
    const form = formEl(root);
    if (form) {
      form.onsubmit = async (e) => {
        e.preventDefault();
        const err = $("#agent-edit-err", root);
        showErr(err, "");
        const { id, body } = payloadFromForm(form);
        try {
          if (id) {
            const current = agentsCache.find((a) => a.id === id);
            const codeOnly = !canManage() && canSetCode(current);
            if (codeOnly) {
              if (!body.code) {
                showErr(err, "Agent kodi majburiy");
                return;
              }
              await api(`/agents/${id}/code`, { method: "PUT", body: { code: body.code } });
              closeEditor(root);
              await load(root);
              return;
            }
            const code = body.code;
            if (!code) {
              showErr(err, "Agent kodi majburiy");
              return;
            }
            const taken = agentsCache.find((a) => a.id !== id && a.code === code);
            if (taken && code !== (current?.code || "")) {
              if (!isAdmin()) {
                showErr(err, `${code} kodi band (${taken.name})`);
                return;
              }
              const ok = await askConfirm(
                `${code} kodi hozir ${taken.name}da. Kodlarni almashtirasizmi?`,
                { title: "Kodni almashtirish", ok: "Almashtirish" }
              );
              if (!ok) return;
              await api(`/agents/${id}/code`, { method: "PUT", body: { code } });
            }
            await api(`/agents/${id}`, { method: "PUT", body });
          } else {
            if (!body.code) {
              showErr(err, "Agent kodi majburiy");
              return;
            }
            await api("/agents", { method: "POST", body });
          }
          closeEditor(root);
          await load(root);
        } catch (ex) {
          showErr(err, ex.message);
        }
      };
    }
    $("#agent-edit-close", root)?.addEventListener("click", () => closeEditor(root));
    $("#agent-edit-cancel", root)?.addEventListener("click", () => closeEditor(root));
    modal(root)?.addEventListener("click", (e) => {
      if (e.target === modal(root)) closeEditor(root);
    });
    root.addEventListener("click", async (e) => {
      const editBtn = e.target.closest("[data-edit]");
      if (editBtn) {
        const agent = agentsCache.find((a) => String(a.id) === String(editBtn.dataset.edit));
        if (agent) openEditor(root, agent);
        return;
      }
      const delBtn = e.target.closest("[data-del]");
      if (!delBtn) return;
      const id = Number(delBtn.dataset.del);
      const agent = agentsCache.find((a) => a.id === id);
      const ok = await askConfirm(
        `${agent?.name || "Agent"}ni o‘chirasizmi? Haydovchilar shu agentdan yechiladi.`,
        { title: "O‘chirish", ok: "O‘chirish", danger: true }
      );
      if (!ok) return;
      try {
        await api(`/agents/${id}`, { method: "DELETE" });
        await load(root);
      } catch (ex) {
        const err = $("#agent-err", root);
        showErr(err, ex.message);
      }
    });
  }
  bindPhoneInputs(root);
  await load(root);
}

export async function show() {
  if (paneRoot) await load(paneRoot);
}

export function destroy() {
  bound = false;
  paneRoot = null;
}
