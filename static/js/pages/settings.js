import { api, me, setMe } from "../api.js";
import { $, formData } from "../ui.js?v=76";
import { loadRemembered, saveRemembered } from "../theme.js?v=76";
import { renderProfile } from "../profile.js?v=76";

function loadIdle(root) {
  const sel = $("#idle-mins", root);
  if (sel) sel.value = String(me?.idle_timeout_minutes ?? 30);
  const line = $("#org-line", root);
  if (line) {
    const parts = [];
    if (me?.org_name) parts.push(`Joriy tashkilot: ${me.org_name}`);
    if (me?.org_code) parts.push(`kirish kodi: ${me.org_code}`);
    line.textContent = parts.join(" · ");
  }
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

let onMeUpdated = null;

export async function init(root) {
  fillProfile(root);
  loadIdle(root);
  onMeUpdated = () => fillProfile(root);
  window.addEventListener("nexus:me-updated", onMeUpdated);
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
        renderProfile();
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
}

export function destroy() {
  if (onMeUpdated) window.removeEventListener("nexus:me-updated", onMeUpdated);
  onMeUpdated = null;
}
