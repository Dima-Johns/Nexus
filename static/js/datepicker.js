// Interfeysga mos kalendar: sahifadagi barcha <input type="date"> uchun brauzer/Android kalendari o‘rniga ochiladi.
// Input o‘zi joyida qoladi — qiymat (YYYY-MM-DD) va input/change hodisalari avvalgidek, shuning uchun sahifa kodi o‘zgarmaydi.
// data-clearable — «Tozalash» tugmasi; data-range-start / data-range-end — juft inputning id si (oraliq bo‘yalishi uchun).
(() => {
  if (window.__nxDatepicker) return;
  window.__nxDatepicker = true;

  const UZ_MONTHS = ["Yanvar", "Fevral", "Mart", "Aprel", "May", "Iyun", "Iyul", "Avgust", "Sentabr", "Oktabr", "Noyabr", "Dekabr"];
  const UZ_DAYS = ["Du", "Se", "Ch", "Pa", "Ju", "Sh", "Ya"];
  const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;
  const SELECTOR = 'input[type="date"], input[data-dp="text"]';

  const pad = (n) => String(n).padStart(2, "0");
  const iso = (y, m, d) => `${y}-${pad(m + 1)}-${pad(d)}`;
  const parse = (v) => {
    const m = ISO.exec(String(v || "").slice(0, 10));
    return m ? { y: +m[1], m: +m[2] - 1, d: +m[3] } : null;
  };
  const todayIso = () => {
    const t = new Date();
    return iso(t.getFullYear(), t.getMonth(), t.getDate());
  };
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

  function lang() {
    return (document.documentElement.lang || "uz").toLowerCase();
  }

  // O‘zbekcha (lotin) nomlar: kirill rejimida i18n ularni o‘zi o‘giradi
  function monthNames(style = "long") {
    const l = lang();
    if (l.startsWith("ru") || l.startsWith("en")) {
      const f = new Intl.DateTimeFormat(l, { month: style });
      return Array.from({ length: 12 }, (_, i) => cap(f.format(new Date(2020, i, 1)).replace(".", "")));
    }
    return style === "long" ? UZ_MONTHS : UZ_MONTHS.map((m) => m.slice(0, 3));
  }

  function dayNames() {
    const l = lang();
    if (l.startsWith("ru") || l.startsWith("en")) {
      const f = new Intl.DateTimeFormat(l, { weekday: "short" });
      // 2024-01-01 — dushanba
      return Array.from({ length: 7 }, (_, i) => cap(f.format(new Date(2024, 0, 1 + i))).slice(0, 2));
    }
    return UZ_DAYS;
  }

  const nativeValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");

  let cur = null; // { input, el, backdrop, view, y, m, focus, sheet, timer }

  const display = (v) => {
    const p = parse(v);
    return p ? `${pad(p.d)}.${pad(p.m + 1)}.${p.y}` : "";
  };

  // Ko‘rinadigan input matnga aylanadi: ekranda 14.10.2026 (brauzer tilidan qat’i nazar), .value esa avvalgidek YYYY-MM-DD.
  // Ustiga yopishtirilgan shaffof inputlar (sana chip) o‘zgarmaydi — ular faqat bosishni ushlaydi.
  function enhance(input) {
    if (input.dataset.dp) return;
    if (Number(getComputedStyle(input).opacity) < 0.1) {
      input.dataset.dp = "overlay";
      return;
    }
    let v = parse(input.value) ? input.value.slice(0, 10) : "";
    input.type = "text";
    input.dataset.dp = "text";
    input.readOnly = true;
    input.dataset.dpRo = "1";
    input.autocomplete = "off";
    input.setAttribute("inputmode", "none");
    if (!input.placeholder) input.placeholder = "Sanani tanlang";
    Object.defineProperty(input, "value", {
      configurable: true,
      get: () => v,
      set: (x) => {
        v = parse(x) ? String(x).slice(0, 10) : "";
        nativeValue.set.call(input, display(v));
      },
    });
    nativeValue.set.call(input, display(v));
  }

  function enhanceAll(root) {
    if (root.nodeType !== 1) return;
    if (root.matches('input[type="date"]')) enhance(root);
    root.querySelectorAll?.('input[type="date"]').forEach(enhance);
  }

  function isSheet() {
    return window.matchMedia("(max-width: 600px)").matches;
  }

  function usable(input) {
    if (!input || input.disabled) return false;
    // Ilova o‘zi readonly qilgan inputni ochmaymiz (biz qo‘ygan readonly — data-dp-ro)
    return !input.readOnly || input.dataset.dpRo === "1";
  }

  function lock(input) {
    // Readonly — Android/brauzer o‘z kalendarini ochmasin; qiymatni JS baribir o‘zgartira oladi
    if (input.dataset.dpRo || input.readOnly) return;
    input.readOnly = true;
    input.dataset.dpRo = "1";
  }

  function bounds(input) {
    return { min: parse(input.min) ? input.min : "", max: parse(input.max) ? input.max : "" };
  }

  function outside(v, b) {
    return (b.min && v < b.min) || (b.max && v > b.max);
  }

  function rangeOf(input) {
    const other = (id) => (id ? document.getElementById(id) : null);
    const a = other(input.dataset.rangeStart);
    const b = other(input.dataset.rangeEnd);
    const start = a ? a.value : input.value;
    const end = b ? b.value : input.value;
    return parse(start) && parse(end) && start < end ? { start, end } : null;
  }

  function title(input) {
    const label = input.closest("label");
    const own = input.getAttribute("aria-label") || label?.getAttribute("title") || "";
    if (own) return own;
    const text = label ? [...label.childNodes].filter((n) => n.nodeType === 3).map((n) => n.nodeValue).join(" ").trim() : "";
    return text || "Sanani tanlang";
  }

  const ICON_PREV = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 6l-6 6 6 6"/></svg>`;
  const ICON_NEXT = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>`;

  // input.dpBadges = { day(iso) => [{ n, tone }], legend: [{ tone, label }] } — kun ustida rangli sonlar (tone: blue | green | red)
  function badgesOf(input) {
    const b = input.dpBadges;
    return b && typeof b.day === "function" ? b : null;
  }

  function dayBadges(bd, v) {
    let items = [];
    try {
      items = (bd.day(v) || []).filter((x) => Number(x.n) > 0);
    } catch {
      /* belgisiz ko‘rsatiladi */
    }
    const label = (tone) => bd.legend?.find((l) => l.tone === tone)?.label || "";
    return {
      html: items.map((x) => `<i class="dp-b dp-b-${escapeHtml(x.tone)}">${Number(x.n)}</i>`).join(""),
      title: items.map((x) => `${label(x.tone)}: ${Number(x.n)}`).join(", "),
    };
  }

  function legendHtml(bd) {
    if (!bd.legend?.length) return "";
    return `<div class="dp-legend">${bd.legend
      .map((l) => `<span><i class="dp-b dp-b-${escapeHtml(l.tone)}"></i>${escapeHtml(l.label)}</span>`)
      .join("")}</div>`;
  }

  function daysHtml(input) {
    const { y, m } = cur;
    const b = bounds(input);
    const bd = badgesOf(input);
    const value = parse(input.value) ? input.value.slice(0, 10) : "";
    const today = todayIso();
    const range = rangeOf(input);
    const first = new Date(y, m, 1);
    const shift = (first.getDay() + 6) % 7;
    const cells = [];
    for (let i = 0; i < 42; i++) {
      const dt = new Date(y, m, 1 - shift + i);
      const v = iso(dt.getFullYear(), dt.getMonth(), dt.getDate());
      const cls = ["dp-day"];
      if (dt.getMonth() !== m) cls.push("dp-out");
      if (i % 7 >= 5) cls.push("dp-wk");
      if (v === today) cls.push("dp-today");
      if (range && v >= range.start && v <= range.end) {
        cls.push("dp-in");
        if (v === range.start) cls.push("dp-from");
        if (v === range.end) cls.push("dp-to");
      }
      if (v === value) cls.push("dp-sel");
      const off = outside(v, b);
      if (off) cls.push("dp-off");
      const marks = bd ? dayBadges(bd, v) : null;
      const inner = marks ? `<span class="dp-bs">${marks.html}</span><span class="dp-n">${dt.getDate()}</span>` : dt.getDate();
      cells.push(
        `<button type="button" class="${cls.join(" ")}" data-v="${v}" tabindex="${v === cur.focus ? 0 : -1}"${off ? " disabled" : ""}${
          v === value ? ' aria-selected="true"' : ""
        }${marks?.title ? ` title="${escapeHtml(marks.title)}"` : ""}>${inner}</button>`
      );
    }
    const head = dayNames()
      .map((d, i) => `<span class="dp-wd${i >= 5 ? " dp-wk" : ""}">${d}</span>`)
      .join("");
    return `<div class="dp-week">${head}</div><div class="dp-grid${bd ? " dp-badged" : ""}" role="grid">${cells.join("")}</div>${
      bd ? legendHtml(bd) : ""
    }`;
  }

  function monthsHtml(input) {
    const b = bounds(input);
    const value = parse(input.value);
    const now = parse(todayIso());
    const names = monthNames("short");
    return `<div class="dp-months">${names
      .map((n, i) => {
        const last = new Date(cur.y, i + 1, 0).getDate();
        const off = (b.min && iso(cur.y, i, last) < b.min) || (b.max && iso(cur.y, i, 1) > b.max);
        const cls = ["dp-month"];
        if (value && value.y === cur.y && value.m === i) cls.push("dp-sel");
        if (now.y === cur.y && now.m === i) cls.push("dp-today");
        return `<button type="button" class="${cls.join(" ")}" data-m="${i}"${off ? " disabled" : ""}>${n}</button>`;
      })
      .join("")}</div>`;
  }

  function render() {
    if (!cur) return;
    const { input, el } = cur;
    const months = cur.view === "months";
    const today = todayIso();
    const clearable = "clearable" in input.dataset;
    el.innerHTML = `
      ${cur.sheet ? `<div class="dp-sheet-head"><b>${escapeHtml(title(input))}</b><button type="button" class="dp-x" data-act="close" aria-label="Yopish">×</button></div>` : ""}
      <div class="dp-head">
        <button type="button" class="dp-nav" data-act="prev" aria-label="${months ? "Oldingi yil" : "Oldingi oy"}">${ICON_PREV}</button>
        <button type="button" class="dp-title" data-act="view" aria-label="Oyni tanlash">${
          months ? cur.y : `${monthNames()[cur.m]} ${cur.y}`
        }</button>
        <button type="button" class="dp-nav" data-act="next" aria-label="${months ? "Keyingi yil" : "Keyingi oy"}">${ICON_NEXT}</button>
      </div>
      ${months ? monthsHtml(input) : daysHtml(input)}
      <div class="dp-foot">
        ${clearable ? `<button type="button" class="dp-link" data-act="clear">Tozalash</button>` : "<span></span>"}
        <button type="button" class="dp-link dp-strong" data-act="today"${outside(today, bounds(input)) ? " disabled" : ""}>Bugun</button>
      </div>`;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  }

  function place() {
    if (!cur || cur.sheet) return;
    const r = cur.input.getBoundingClientRect();
    if (!cur.input.isConnected || (r.width === 0 && r.height === 0)) {
      close();
      return;
    }
    const el = cur.el;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let top = r.bottom + 6;
    if (top + h > vh - 8 && r.top - h - 6 >= 8) top = r.top - h - 6;
    top = Math.max(8, Math.min(top, vh - h - 8));
    const left = Math.max(8, Math.min(r.left, vw - w - 8));
    el.style.top = `${Math.round(top)}px`;
    el.style.left = `${Math.round(left)}px`;
  }

  function focusCell() {
    const btn = cur?.el.querySelector(`.dp-day[data-v="${cur.focus}"]`);
    if (btn) btn.focus({ preventScroll: true });
  }

  function setView(y, m) {
    const d = new Date(y, m, 1);
    cur.y = d.getFullYear();
    cur.m = d.getMonth();
  }

  function emit(input, value) {
    if (input.dataset.dp === "text") input.value = value;
    else nativeValue.set.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function pick(v) {
    const input = cur.input;
    close();
    if (input.value !== v) emit(input, v);
  }

  function open(input) {
    if (!usable(input)) return;
    if (cur && cur.input === input) return;
    close();
    lock(input);
    const b = bounds(input);
    let start = parse(input.value) ? input.value.slice(0, 10) : todayIso();
    if (b.min && start < b.min) start = b.min;
    if (b.max && start > b.max) start = b.max;
    const p = parse(start);
    const sheet = isSheet();
    const el = document.createElement("div");
    el.className = `dp${sheet ? " dp-sheet" : ""}${badgesOf(input) ? " dp-wide" : ""}`;
    el.setAttribute("role", "dialog");
    let backdrop = null;
    if (sheet) {
      backdrop = document.createElement("div");
      backdrop.className = "dp-backdrop";
      backdrop.addEventListener("click", close);
      document.body.appendChild(backdrop);
    }
    cur = { input, el, backdrop, view: "days", y: p.y, m: p.m, focus: start, sheet, timer: 0 };
    render();
    document.body.appendChild(el);
    input.classList.add("dp-active");
    input.closest("label")?.classList.add("dp-active");
    place();
    requestAnimationFrame(() => {
      el.classList.add("dp-in-view");
      backdrop?.classList.add("dp-in-view");
      if (!sheet) focusCell();
    });
    el.addEventListener("click", onClick);
    el.addEventListener("keydown", onKey);
    // Inputni yashirib/o‘chirib yuborishsa (modal yopildi, sahifa almashdi) — kalendar ham yopiladi
    cur.timer = setInterval(place, 400);
    input.addEventListener("input", onInputTyped);
  }

  function close() {
    if (!cur) return;
    const { input, el, backdrop, timer } = cur;
    clearInterval(timer);
    input.removeEventListener("input", onInputTyped);
    input.classList.remove("dp-active");
    input.closest("label")?.classList.remove("dp-active");
    el.remove();
    backdrop?.remove();
    cur = null;
  }

  function onInputTyped() {
    if (!cur) return;
    const p = parse(cur.input.value);
    if (p) {
      setView(p.y, p.m);
      cur.focus = cur.input.value.slice(0, 10);
    }
    render();
  }

  function onClick(e) {
    e.stopPropagation();
    const day = e.target.closest(".dp-day");
    if (day && !day.disabled) return pick(day.dataset.v);
    const month = e.target.closest(".dp-month");
    if (month && !month.disabled) {
      setView(cur.y, +month.dataset.m);
      cur.view = "days";
      const p = parse(cur.focus);
      const last = new Date(cur.y, cur.m + 1, 0).getDate();
      cur.focus = iso(cur.y, cur.m, Math.min(p ? p.d : 1, last));
      render();
      place();
      return;
    }
    const act = e.target.closest("[data-act]")?.dataset.act;
    if (!act) return;
    if (act === "close") return close();
    if (act === "today") return pick(todayIso());
    if (act === "clear") return pick("");
    if (act === "view") cur.view = cur.view === "days" ? "months" : "days";
    if (act === "prev" || act === "next") {
      const step = act === "prev" ? -1 : 1;
      if (cur.view === "months") cur.y += step;
      else setView(cur.y, cur.m + step);
    }
    render();
    place();
  }

  function onKey(e) {
    if (cur.view !== "days" || !e.target.classList.contains("dp-day")) return;
    const moves = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
    const p = parse(cur.focus);
    let next = null;
    if (moves[e.key]) next = new Date(p.y, p.m, p.d + moves[e.key]);
    else if (e.key === "PageUp") next = new Date(p.y, p.m - 1, p.d);
    else if (e.key === "PageDown") next = new Date(p.y, p.m + 1, p.d);
    else if (e.key === "Home") next = new Date(p.y, p.m, p.d - ((new Date(p.y, p.m, p.d).getDay() + 6) % 7));
    else if (e.key === "End") next = new Date(p.y, p.m, p.d + 6 - ((new Date(p.y, p.m, p.d).getDay() + 6) % 7));
    if (!next) return;
    e.preventDefault();
    cur.focus = iso(next.getFullYear(), next.getMonth(), next.getDate());
    setView(next.getFullYear(), next.getMonth());
    render();
    focusCell();
  }

  // Sahifa kodi showPicker() chaqirsa ham shu kalendar ochiladi
  const nativeShow = HTMLInputElement.prototype.showPicker;
  HTMLInputElement.prototype.showPicker = function () {
    if ((this.type === "date" || this.dataset.dp === "text") && !("nativePicker" in this.dataset)) return open(this);
    if (nativeShow) return nativeShow.call(this);
  };

  const target = (e) => {
    const el = e.target?.closest?.(SELECTOR);
    return el && !("nativePicker" in el.dataset) ? el : null;
  };

  // Bosishdan oldin readonly — Android WebView o‘z kalendarini ochmasin
  document.addEventListener(
    "pointerdown",
    (e) => {
      const input = target(e);
      if (input && usable(input)) lock(input);
      if (cur && !cur.el.contains(e.target) && e.target !== cur.input && !cur.backdrop) close();
    },
    true
  );
  document.addEventListener(
    "click",
    (e) => {
      const input = target(e);
      if (!input || !usable(input)) return;
      e.preventDefault();
      // Sahifaning o‘z click ishlovchisi (qiymatni tayyorlab showPicker chaqiradi) avval ishlasin
      setTimeout(() => open(input), 0);
    },
    true
  );
  document.addEventListener(
    "keydown",
    (e) => {
      // Escape faqat kalendarni yopsin, ostidagi modalni emas
      if (cur && e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        const input = cur.input;
        const inside = cur.el.contains(document.activeElement);
        close();
        if (inside) input.focus({ preventScroll: true });
        return;
      }
      const input = target(e);
      if (!input || !usable(input)) return;
      if (e.key === "Enter" || e.key === " " || e.key === "F4" || (e.altKey && e.key === "ArrowDown")) {
        e.preventDefault();
        open(input);
      }
    },
    true
  );
  window.addEventListener("resize", () => place());
  document.addEventListener("scroll", () => place(), true);
  window.addEventListener("popstate", close);

  // Sahifalar keyin yuklanadi (SPA) — yangi qo‘shilgan sana inputlari ham ulanadi
  enhanceAll(document.body);
  new MutationObserver((records) => {
    for (const r of records) r.addedNodes.forEach(enhanceAll);
  }).observe(document.body, { childList: true, subtree: true });
})();
