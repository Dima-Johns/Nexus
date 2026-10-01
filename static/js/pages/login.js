import { api, setMe, setToken } from "../api.js";
import { $ } from "../ui.js?v=63";
import { bindThemeToggle, clearRemembered, loadRemembered, saveRemembered } from "../theme.js?v=63";

export async function init(root) {
  bindThemeToggle($("#login-theme", root));
  const remembered = loadRemembered();
  if (remembered) {
    $("#login-user", root).value = remembered.username;
    $("#login-pass", root).value = remembered.password;
    $("#login-remember", root).checked = true;
  }
  const login = async () => {
    $("#login-error", root).textContent = "";
    const username = $("#login-user", root).value.trim();
    const password = $("#login-pass", root).value;
    try {
      const data = await api("/auth/login", {
        method: "POST",
        body: { username, password },
      });
      if ($("#login-remember", root).checked) saveRemembered(username, password);
      else clearRemembered();
      setToken(data.token);
      setMe(data.user);
      history.replaceState({}, "", "/dashboard");
      window.dispatchEvent(new PopStateEvent("popstate"));
    } catch (e) {
      $("#login-error", root).textContent = e.message === "unauthorized" ? "Login yoki parol noto‘g‘ri" : e.message;
    }
  };
  $("#login-btn", root).onclick = login;
  $("#login-pass", root).addEventListener("keydown", (e) => e.key === "Enter" && login());
  $("#login-user", root).addEventListener("keydown", (e) => e.key === "Enter" && login());
}

export function destroy() {}
