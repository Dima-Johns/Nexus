import { api } from "../api.js";
import { escapeHtml, money, table } from "../ui.js?v=68";

export async function init(root) {
  const orders = await api("/orders");
  root.querySelector("#orders-table").innerHTML = table(
    ["Kod", "Mijoz", "Yuklama", "Olish", "Yetkazish", "Yuk", "kg", "Summa", "Holat"],
    orders
      .map(
        (o) => `<tr>
          <td>${escapeHtml(o.code)}</td>
          <td>${escapeHtml(o.client_name || "—")}</td>
          <td>${escapeHtml(o.route_code || "—")}</td>
          <td>${escapeHtml(o.pickup_address)}</td>
          <td>${escapeHtml(o.dropoff_address)}</td>
          <td>${escapeHtml(o.cargo || "—")}</td>
          <td>${o.weight_kg || 0}</td>
          <td>${money(o.amount)}</td>
          <td><span class="badge ${o.status}">${o.status}</span></td>
        </tr>`
      )
      .join("")
  );
}

export function destroy() {}
