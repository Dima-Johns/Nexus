import { api, setMe, setToken } from "../api.js";
import { $ } from "../ui.js?v=66";
import { bindThemeToggle, clearRemembered, loadRemembered, saveRemembered } from "../theme.js?v=66";

const ORG_KEY = "nx_org_code";

export async function init(root) {
  bindThemeToggle($("#login-theme", root));
  const orgInput = $("#login-org", root);
  orgInput.value = localStorage.getItem(ORG_KEY) || "";
  orgInput.addEventListener("input", () => {
    orgInput.value = orgInput.value.replace(/\D/g, "").slice(0, 6);
  });
  const remembered = loadRemembered();
  if (remembered) {
    $("#login-user", root).value = remembered.username;
    $("#login-pass", root).value = remembered.password;
    $("#login-remember", root).checked = true;
  }
  if (!remembered) $("#login-user", root).focus();
  const login = async () => {
    $("#login-error", root).textContent = "";
    const org_code = orgInput.value.trim();
    const username = $("#login-user", root).value.trim();
    const password = $("#login-pass", root).value;
    if (org_code && !/^\d{6}$/.test(org_code)) {
      $("#login-error", root).textContent = "Tashkilot kodi 6 xonali raqam bo‘lishi kerak";
      orgInput.focus();
      return;
    }
    try {
      const data = await api("/auth/login", {
        method: "POST",
        body: { org_code, username, password },
      });
      if (org_code) localStorage.setItem(ORG_KEY, org_code);
      if ($("#login-remember", root).checked) saveRemembered(username, password);
      else clearRemembered();
      setToken(data.token);
      setMe(data.user);
      history.replaceState({}, "", "/dashboard");
      window.dispatchEvent(new PopStateEvent("popstate"));
    } catch (e) {
      $("#login-error", root).textContent = e.message === "unauthorized" ? "Tashkilot kodi, login yoki parol noto‘g‘ri" : e.message;
    }
  };
  $("#login-btn", root).onclick = login;
  ["#login-org", "#login-user", "#login-pass"].forEach((id) =>
    $(id, root).addEventListener("keydown", (e) => e.key === "Enter" && login())
  );
}

export function destroy() {}
