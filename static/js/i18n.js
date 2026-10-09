import RU from "./i18n-ru.js?v=78";

export const LANGS = [
  { code: "uz", label: "O‘zbekcha", short: "UZ" },
  { code: "uz-cyrl", label: "Ўзбекча", short: "ЎЗ" },
  { code: "ru", label: "Русский", short: "RU" },
  { code: "en", label: "English", short: "EN" },
];
const STORE_KEY = "nx_lang";
const EN = getLang() === "en" ? (await import("./i18n-en.js?v=78")).default : null;

export function getLang() {
  const v = localStorage.getItem(STORE_KEY);
  return LANGS.some((l) => l.code === v) ? v : "uz";
}

/** Tarjima qilingan matnni orqaga qaytarib bo‘lmaydi — til almashganda sahifa qayta yuklanadi. */
export function setLang(code, { reload = true } = {}) {
  if (!LANGS.some((l) => l.code === code)) return;
  const changed = getLang() !== code;
  localStorage.setItem(STORE_KEY, code);
  if (changed && reload) location.reload();
}

// ---- lotin → kirill (o‘zbek) ----
const KEEP =
  /(«\{q\}»|\{[nq]\}|\b(?:Excel|GPS|QR|CSV|API|REST|RELOG|Nexus|OpenStreetMap|PNG|JPG|JPEG|WEBP|MB|OK|Esc|Enter|Benchmark|Sheet1|road plan|orgs\.manage|xlsx|xls|pivot|lat|lng|sardor\.a|dispetcher2)\b)/;
const LETTERS = {
  a: "а", b: "б", c: "с", d: "д", e: "е", f: "ф", g: "г", h: "ҳ", i: "и", j: "ж", k: "к", l: "л", m: "м",
  n: "н", o: "о", p: "п", q: "қ", r: "р", s: "с", t: "т", u: "у", v: "в", w: "в", x: "х", y: "й", z: "з",
};
const APOS = "‘’ʻ'`";
const isApos = (ch) => !!ch && APOS.includes(ch);
const isLetter = (ch) => !!ch && /\p{L}/u.test(ch);

function latinToCyr(s) {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    const lo = c.toLowerCase();
    const next = (s[i + 1] || "").toLowerCase();
    let r;
    let skip = 0;
    if ((lo === "o" || lo === "g") && isApos(s[i + 1])) {
      r = lo === "o" ? "ў" : "ғ";
      skip = 1;
    } else if (lo === "s" && next === "h") {
      r = "ш";
      skip = 1;
    } else if (lo === "c" && next === "h") {
      r = "ч";
      skip = 1;
    } else if (lo === "t" && next === "s" && /^i(?:ya|o)/i.test(s.slice(i + 2))) {
      r = "ц";
      skip = 1;
    } else if (lo === "y" && next && "oaue".includes(next) && !(next === "o" && isApos(s[i + 2]))) {
      r = { o: "ё", a: "я", u: "ю", e: "е" }[next];
      skip = 1;
    } else if (lo === "e") {
      r = isLetter(s[i - 1]) ? "е" : "э";
    } else if (isApos(c)) {
      r = isLetter(s[i - 1]) ? "ъ" : c;
    } else {
      r = LETTERS[lo];
    }
    if (r === undefined) {
      out += c;
      continue;
    }
    out += c !== lo ? r.toUpperCase() : r;
    i += skip;
  }
  return out;
}

export function toCyrillic(text) {
  return String(text)
    .split(KEEP)
    .map((part, i) => (i % 2 ? part : latinToCyr(part)))
    .join("");
}

// ---- lug‘at ----
const norm = (s) => s.replace(/[‘’ʻ`']/g, "'").replace(/\s+/g, " ").trim();
const NUM = /\d+(?:[ \u00a0\u202f]\d{3})*(?:[.,]\d+)?/g;
const QUOTE = /«[^»]*»/g;

let dict = null;
const cache = new Map();

// Transliteratsiya xato beradigan xorijiy so‘zlar
const CYRL_FIXED = { Online: "Онлайн", Offline: "Офлайн" };

function build(lang) {
  if (lang === "uz") return null;
  const map = new Map();
  if (lang === "en") {
    for (const [k, v] of Object.entries(EN || {})) map.set(norm(k), v);
    return map;
  }
  for (const [k, v] of Object.entries(RU)) {
    map.set(norm(k), lang === "ru" ? v : CYRL_FIXED[k] ?? toCyrillic(k));
  }
  return map;
}

function plural(value, one, few, many) {
  const n = Math.abs(parseInt(String(value).replace(/\D/g, ""), 10) || 0);
  if (getLang() === "en") return n === 1 ? one : many;
  if (n % 10 === 1 && n % 100 !== 11) return one;
  if (n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20)) return few;
  return many;
}

function fillNums(tpl, nums) {
  let i = 0;
  return tpl.replace(/\{n\}(?:(\s*)\{([^{}|]*)\|([^{}|]*)\|([^{}]*)\})?/g, (m, sp, a, b, c) => {
    const v = nums[i++] ?? "";
    return a === undefined ? v : v + sp + plural(v, a, b, c);
  });
}

function fillQuotes(tpl, quotes) {
  let i = 0;
  return tpl.replace(/«\{q\}»/g, () => `«${quotes[i++] ?? ""}»`);
}

function lookup(text) {
  const get = (k) => dict.get(norm(k)) ?? dict.get(norm(`${k}:`))?.replace(/:$/, "");
  let v = get(text);
  if (v != null) return v;
  const nums = [];
  const withNums = text.replace(NUM, (m) => (nums.push(m), "{n}"));
  if (nums.length && (v = get(withNums)) != null) return fillNums(v, nums);
  const quotes = [];
  const withQuotes = text.replace(QUOTE, (m) => (quotes.push(m.slice(1, -1)), "«{q}»"));
  if (!quotes.length) return null;
  if ((v = get(withQuotes)) != null) return fillQuotes(v, quotes);
  const nums2 = [];
  const both = withQuotes.replace(NUM, (m) => (nums2.push(m), "{n}"));
  if (nums2.length && (v = get(both)) != null) return fillQuotes(fillNums(v, nums2), quotes);
  return null;
}

function whole(t) {
  if (!t) return null;
  const r = lookup(t);
  if (r != null) return r;
  const m = /^((?:Σ )?[^\p{L}\d«(]*)(.*?)((?: \(\d+\))?[\s.:…!?*,]*)$/u.exec(t);
  if (m && m[2] && (m[1] || m[3])) {
    const inner = lookup(m[2]);
    if (inner != null) return m[1] + inner + m[3];
  }
  return null;
}

function compute(raw) {
  const lead = raw.match(/^\s*/)[0];
  const trail = raw.slice(lead.length).match(/\s*$/)[0];
  const core = raw.trim();
  if (!core) return null;
  if (core.includes("\n")) {
    let changed = false;
    const lines = core.split("\n").map((line) => {
      const r = compute(line);
      if (r == null) return line;
      changed = true;
      return r;
    });
    return changed ? lead + lines.join("\n") + trail : null;
  }
  const r = whole(core);
  if (r != null) return lead + r + trail;
  const parts = core.split(/( · | — | – | → |: |; | \/ )/);
  if (parts.length < 2) return null;
  let changed = false;
  const out = parts.map((p, i) => {
    if (i % 2) return p;
    const t = p.trim();
    const tr = whole(t);
    if (tr == null) return p;
    changed = true;
    return p.replace(t, tr);
  });
  return changed ? lead + out.join("") + trail : null;
}

/** Faqat lotin harfli matn tarjima qilinadi: tarjima natijasi qayta tarjimaga tushmaydi. */
function translate(raw) {
  if (!dict || !raw || !/[A-Za-z]/.test(raw)) return null;
  if (cache.has(raw)) return cache.get(raw);
  const res = compute(raw);
  if (cache.size > 8000) cache.clear();
  cache.set(raw, res);
  return res;
}

export function t(text) {
  return translate(String(text ?? "")) ?? text;
}

// ---- DOM ----
const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "TEXTAREA", "NOSCRIPT", "CODE", "PRE"]);
const ATTRS = ["placeholder", "title", "aria-label"];

function skipped(el) {
  return !el || SKIP_TAGS.has(el.tagName) || !!el.closest("[data-no-i18n]") || el.isContentEditable;
}

function setText(node) {
  const r = translate(node.nodeValue);
  if (r != null && r !== node.nodeValue) node.nodeValue = r;
}

function setAttr(el, name) {
  const v = el.getAttribute(name);
  if (!v) return;
  const r = translate(v);
  if (r != null && r !== v) el.setAttribute(name, r);
}

const walkFilter = {
  acceptNode(n) {
    if (n.nodeType === 1 && (SKIP_TAGS.has(n.tagName) || n.hasAttribute("data-no-i18n"))) return NodeFilter.FILTER_REJECT;
    return NodeFilter.FILTER_ACCEPT;
  },
};

function walk(root) {
  if (root.nodeType === 3) {
    if (!skipped(root.parentElement)) setText(root);
    return;
  }
  if (root.nodeType !== 1 || skipped(root)) return;
  ATTRS.forEach((a) => setAttr(root, a));
  const tw = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, walkFilter);
  let n;
  while ((n = tw.nextNode())) {
    if (n.nodeType === 3) setText(n);
    else ATTRS.forEach((a) => setAttr(n, a));
  }
}

function patchDialogs() {
  ["alert", "confirm", "prompt"].forEach((name) => {
    const orig = window[name];
    if (typeof orig !== "function") return;
    window[name] = function (msg, ...rest) {
      return orig.call(window, msg == null ? msg : t(String(msg)), ...rest);
    };
  });
}

function initI18n() {
  const lang = getLang();
  document.documentElement.lang = lang === "uz-cyrl" ? "uz-Cyrl" : lang;
  dict = build(lang);
  if (!dict) return;
  walk(document.documentElement);
  new MutationObserver((records) => {
    for (const m of records) {
      if (m.type === "childList") m.addedNodes.forEach(walk);
      else if (m.type === "characterData") {
        if (!skipped(m.target.parentElement)) setText(m.target);
      } else if (m.type === "attributes" && !skipped(m.target)) setAttr(m.target, m.attributeName);
    }
  }).observe(document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ATTRS,
  });
  patchDialogs();
}

initI18n();
