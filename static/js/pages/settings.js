import { api, can, me, setMe } from "../api.js";
import { $, escapeHtml, formData, table } from "../ui.js?v=63";
import { loadRemembered, saveRemembered } from "../theme.js?v=63";

function loadIdle(root) {
  const sel = $("#idle-mins", root);
  if (sel) sel.value = String(me?.idle_timeout_minutes ?? 30);
  const line = $("#org-line", root);
  if (line) line.textContent = me?.org_name ? `Joriy tashkilot: ${me.org_name}` : "";
}

async function loadUsers(root) {
  const box = $("#users-table", root);
  if (!box) return;
  const users = await api("/users");
  box.innerHTML = table(
    ["Login", "Ism", "Tashkilot", "Rol", "Holat", ""],
    users
      .map((u) => {
        const self = me && u.id === me.id;
        return `<tr>
          <td>${escapeHtml(u.username)}</td>
          <td>${escapeHtml(u.full_name)}</td>
          <td>${escapeHtml(u.org_name || "—")}</td>
          <td><span class="badge ${u.role === "admin" ? "approved" : "assigned"}">${escapeHtml(u.role)}</span></td>
          <td><span class="badge ${u.is_active ? "approved" : "rejected"}">${u.is_active ? "faol" : "o‘chiq"}</span></td>
          <td class="row-actions">
            ${self ? `<span class="muted">siz</span>` : `
              <button class="btn tiny" data-toggle="${u.id}" data-active="${u.is_active ? "1" : "0"}">${u.is_active ? "Faolsiz" : "Yoqish"}</button>
              <button class="btn tiny" data-pass="${u.id}">Parol</button>
              <button class="btn tiny" data-del="${u.id}">Olib tashlash</button>
            `}
          </td>
        </tr>`;
      })
      .join("")
  );
}

function showError(root, id, message) {
  const err = $(id, root);
  if (!err) return;
  err.classList.toggle("hidden", !message);
  err.textContent = message || "";
}

function fillProfile(root) {
  if (!me) return;
  const user = $("#profile-user", root);
  const name = $("#profile-name", root);
  if (user) user.value = me.username || "";
  if (name) name.value = me.full_name || "";
}

export async function init(root) {
  fillProfile(root);
  loadIdle(root);
  const profileForm = $("#profile-form", root);
  if (profileForm) {
    profileForm.onsubmit = async (e) => {
      e.preventDefault();
      showError(root, "#profile-err", "");
      const ok = $("#profile-ok", root);
      if (ok) {
        ok.classList.add("hidden");
        ok.textContent = "";
      }
      const d = formData(e.target);
      if ((d.password || d.password2) && d.password !== d.password2) {
        showError(root, "#profile-err", "Yangi parollar mos kelmadi");
        return;
      }
      const body = {
        username: String(d.username || "").trim(),
        full_name: String(d.full_name || "").trim(),
        current_password: d.current_password || "",
      };
      if (d.password) body.password = d.password;
      try {
        const updated = await api("/auth/me", { method: "PUT", body });
        setMe(updated);
        fillProfile(root);
        e.target.current_password.value = "";
        e.target.password.value = "";
        e.target.password2.value = "";
        const remembered = loadRemembered();
        if (remembered) saveRemembered(updated.username, d.password || remembered.password);
        const who = document.getElementById("who");
        if (who) who.textContent = updated.org_name ? `${updated.full_name} · ${updated.org_name}` : updated.full_name;
        if (ok) {
          ok.classList.remove("hidden");
          ok.textContent = "Login ma’lumotlari saqlandi";
        }
      } catch (ex) {
        showError(root, "#profile-err", ex.message);
      }
    };
  }
  $("#idle-form", root).onsubmit = async (e) => {
    e.preventDefault();
    showError(root, "#idle-err", "");
    const d = formData(e.target);
    const body = { idle_timeout_minutes: Number(d.idle_timeout_minutes) };
    try {
      const updated = await api("/auth/me", { method: "PUT", body });
      setMe(updated);
      loadIdle(root);
    } catch (ex) {
      showError(root, "#idle-err", ex.message);
    }
  };

  const accounts = $("#accounts-panel", root);
  if (accounts) accounts.classList.toggle("hidden", !can("users.manage"));
  if (!can("users.manage")) return;

  $("#user-open", root).onclick = () => $("#user-form", root).classList.toggle("hidden");
  $("#user-form", root).onsubmit = async (e) => {
    e.preventDefault();
    try {
      const d = formData(e.target);
      d.org_id = me?.org_id || null;
      d.idle_timeout_minutes = 30;
      d.permissions = [];
      await api("/users", { method: "POST", body: d });
      e.target.reset();
      $("#user-form", root).classList.add("hidden");
      await loadUsers(root);
    } catch (ex) {
      showError(root, "#user-err", ex.message);
    }
  };
  root.addEventListener("click", async (e) => {
    const del = e.target.dataset?.del;
    const toggle = e.target.dataset?.toggle;
    const pass = e.target.dataset?.pass;
    try {
      if (del) {
        if (!confirm("Akkauntni o‘chirasizmi?")) return;
        await api(`/users/${del}`, { method: "DELETE" });
        await loadUsers(root);
      }
      if (toggle) {
        const active = e.target.dataset.active === "1";
        await api(`/users/${toggle}`, { method: "PUT", body: { is_active: !active } });
        await loadUsers(root);
      }
      if (pass) {
        const next = prompt("Yangi parol (kamida 6 belgi):");
        if (!next) return;
        await api(`/users/${pass}`, { method: "PUT", body: { password: next } });
        await loadUsers(root);
      }
    } catch (ex) {
      showError(root, "#user-err", ex.message);
    }
  });
  await loadUsers(root);
}

export function destroy() {}
