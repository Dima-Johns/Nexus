import { api } from "./api.js";
import { escapeHtml } from "./ui.js?v=84";
import { proofThumb } from "./proof-photo.js?v=84";

const STATUS = {
  new: "Yangi",
  assigned: "Tayinlangan",
  in_transit: "Yo‘lda",
  on_route: "Yo‘lda",
  delivered: "Yetkazilgan",
  returned: "Qaytarilgan",
  cancelled: "Bekor qilingan",
};
const REASONS = { fridge_yes: "Muzlatgich bor", foreign_goods: "Begona mahsulot bor", fridge_no: "Muzlatgich yo‘q" };
const ACTOR = { user: "Dispetcher", driver: "Haydovchi", system: "Tizim" };
// Tarixdagi belgi rangi: yakunlash — yashil/sariq, rasm — ko‘k, qolganlari — kulrang
const TONE = {
  imported: "info",
  created: "info",
  photo: "photo",
  photo_uploaded: "photo",
  delivered: "ok",
  returned: "warn",
  unassigned: "warn",
  started: "go",
  assigned: "go",
  reassigned: "go",
  planned: "go",
};

let box = null;
let seq = 0;

function fmt(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return escapeHtml(iso);
  return d.toLocaleString("uz-UZ", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function close() {
  box?.classList.add("hidden");
  seq += 1;
}

function ensureBox() {
  if (box) return box;
  box = document.createElement("div");
  box.className = "modal-overlay hidden oh-overlay";
  box.innerHTML = `<div class="glass panel modal-card oh-card" role="dialog" aria-modal="true">
      <div class="panel-head">
        <div class="oh-title"><h3 id="oh-code">Zayavka</h3><span class="muted" id="oh-sub"></span></div>
        <button class="icon-btn" type="button" data-oh-close title="Yopish">×</button>
      </div>
      <div id="oh-body" class="oh-body"></div>
    </div>`;
  box.addEventListener("click", (e) => {
    if (e.target === box || e.target.closest("[data-oh-close]")) close();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && box && !box.classList.contains("hidden") && !document.querySelector(".proof-lightbox")) close();
  });
  document.body.appendChild(box);
  return box;
}

function infoRow(label, value) {
  if (value == null || value === "") return "";
  return `<div class="oh-info-row"><span class="muted">${escapeHtml(label)}</span><b>${value}</b></div>`;
}

function render(order, events) {
  const o = order;
  const slot = o.window_start && o.window_end ? `${o.window_start}–${o.window_end}` : "";
  const day = [String(o.delivery_date || "").slice(0, 10), slot].filter(Boolean).join(", ");
  const reason = REASONS[o.proof_reason] || "";
  const info = [
    infoRow("Holat", `<span class="badge ${escapeHtml(o.status)}">${escapeHtml(STATUS[o.status] || o.status)}</span>`),
    infoRow("Klient", escapeHtml(o.client_name || "")),
    infoRow("Manzil", escapeHtml(o.dropoff_address || "")),
    infoRow("Agent", escapeHtml([o.agent_code, o.sales_rep].filter(Boolean).join(" · "))),
    infoRow("Haydovchi", escapeHtml(o.driver_name || "")),
    infoRow("Reys", escapeHtml(o.route_code || "")),
    infoRow("Yetkazish", escapeHtml(day)),
    infoRow("Sklad", escapeHtml(o.warehouse_name || "")),
    infoRow("Summa", o.amount ? escapeHtml(Number(o.amount).toLocaleString("uz-UZ")) : ""),
    infoRow("Yakunlangan", o.proof_at ? escapeHtml(fmt(o.proof_at)) : ""),
  ].join("");
  const proof =
    o.proof_photo || reason || o.proof_comment
      ? `<div class="oh-proof">
          ${proofThumb(o.proof_photo)}
          <div>
            ${reason ? `<b>${escapeHtml(reason)}</b>` : ""}
            ${o.proof_comment ? `<div class="muted">«${escapeHtml(o.proof_comment)}»</div>` : ""}
          </div>
        </div>`
      : "";
  const list = events.length
    ? events
        .map((e) => {
          const who = e.actor ? `${ACTOR[e.actor_type] || ""}: ${escapeHtml(e.actor)}` : ACTOR[e.actor_type] || "";
          return `<li class="oh-ev ${TONE[e.kind] || ""}${e.derived ? " derived" : ""}">
            <span class="oh-dot"></span>
            <div class="oh-ev-main">
              <div class="oh-ev-top"><b>${escapeHtml(e.title)}</b><span class="oh-time">${escapeHtml(fmt(e.at))}</span></div>
              ${who ? `<div class="muted">${who}</div>` : ""}
              ${e.note ? `<div class="oh-note">${escapeHtml(e.note)}</div>` : ""}
              ${e.derived ? `<div class="oh-derived">Eski zayavka: vaqt zayavka ma’lumotlaridan olindi</div>` : ""}
            </div>
          </li>`;
        })
        .join("")
    : `<li class="muted">Tarix yozuvlari yo‘q</li>`;
  $body().innerHTML = `<div class="oh-info">${info}</div>${proof}<h4 class="oh-h">Tarix</h4><ol class="oh-list">${list}</ol>`;
}

function $body() {
  return box.querySelector("#oh-body");
}

export async function openOrderHistory(id, hint = {}) {
  ensureBox();
  const my = ++seq;
  box.querySelector("#oh-code").textContent = hint.code || "Zayavka";
  box.querySelector("#oh-sub").textContent = hint.client || "";
  $body().innerHTML = `<p class="muted">Yuklanmoqda…</p>`;
  box.classList.remove("hidden");
  try {
    const data = await api(`/orders/${id}/history`);
    if (my !== seq) return;
    box.querySelector("#oh-code").textContent = data.order.code || "Zayavka";
    box.querySelector("#oh-sub").textContent = data.order.client_name || "";
    render(data.order, data.events || []);
  } catch (err) {
    if (my !== seq) return;
    $body().innerHTML = `<p class="error">${escapeHtml(err.message || "Tarixni yuklab bo‘lmadi")}</p>`;
  }
}
