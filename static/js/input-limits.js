// Chegaralar app/schemas.py dagi max_length / ge / le bilan bir xil bo‘lishi kerak
const MAX_BY_KEY = {
  username: 80,
  admin_username: 80,
  "login-user": 80,
  password: 128,
  password2: 128,
  current_password: 128,
  admin_password: 128,
  "login-pass": 128,
  full_name: 160,
  admin_full_name: 160,
  name: 160,
  sales_rep: 160,
  "tpl-name": 160,
  "plan-name-input": 160,
  phone: 40,
  code: 80,
  route_code: 80,
  new_name: 80,
  vehicle_plate: 32,
  vehicle_type: 64,
  region: 120,
  cargo: 255,
  address: 500,
  pickup_address: 500,
  dropoff_address: 500,
  notes: 2000,
  note: 2000,
  description: 2000,
  "tpl-desc": 2000,
};

const RANGE_BY_KEY = {
  lat: [-90, 90],
  lng: [-180, 180],
  commission_pct: [0, 100],
  weight_kg: [0, 1_000_000],
  amount: [0, 1_000_000_000_000],
  eta_minutes: [0, 100_000],
  idle_timeout_minutes: [0, 1440],
  "tpl-header-row": [1, 1000],
};

const NO_TEXT = new Set(["checkbox", "radio", "file", "hidden", "date", "time", "datetime-local", "month", "week", "color", "range", "number"]);

function limitField(el) {
  const key = el.name || el.id;
  if (el.type === "number") {
    const range = RANGE_BY_KEY[key];
    if (range) {
      if (!el.hasAttribute("min")) el.min = String(range[0]);
      if (!el.hasAttribute("max")) el.max = String(range[1]);
    }
    return;
  }
  if (el.hasAttribute("maxlength") || NO_TEXT.has(el.type)) return;
  el.maxLength = MAX_BY_KEY[key] || (el.tagName === "TEXTAREA" ? 2000 : el.type === "search" ? 200 : 255);
}

function applyIn(node) {
  if (node.nodeType !== 1) return;
  if (node.matches("input, textarea")) limitField(node);
  node.querySelectorAll("input, textarea").forEach(limitField);
}

export function watchInputLimits() {
  applyIn(document.body);
  new MutationObserver((mutations) => {
    for (const m of mutations) m.addedNodes.forEach(applyIn);
  }).observe(document.body, { childList: true, subtree: true });
}
