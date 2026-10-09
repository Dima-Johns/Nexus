import { can, token } from "./api.js";
import { escapeHtml } from "./ui.js?v=77";

// Rasm endpointi token talab qiladi: <img src> sarlavha yubora olmaydi, shuning uchun fetch + blob URL
const cache = new Map();
const CAM = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg>`;

export function proofThumb(src) {
  if (!src) return "";
  if (!can("proofs.view")) return `<span class="proof-thumb locked" title="Rasmni ko‘rishga ruxsat yo‘q">${CAM}</span>`;
  return `<button type="button" class="proof-thumb" data-proof-src="${escapeHtml(src)}" title="Rasmni ochish">${CAM}</button>`;
}

function load(src) {
  if (!cache.has(src)) {
    const p = fetch(src, { headers: token ? { Authorization: `Bearer ${token}` } : {} })
      .then((r) => (r.ok && (r.headers.get("content-type") || "").startsWith("image/") ? r.blob() : null))
      .then((b) => (b ? URL.createObjectURL(b) : null))
      .catch(() => {
        cache.delete(src);
        return null;
      });
    cache.set(src, p);
  }
  return cache.get(src);
}

async function hydrate(el) {
  el.dataset.proofState = "loading";
  const url = await load(el.dataset.proofSrc);
  if (!url) {
    el.dataset.proofState = "lost";
    el.classList.add("lost");
    el.title = "Rasm o‘chgan";
    return;
  }
  el.dataset.proofState = "ok";
  el.innerHTML = `<img src="${url}" alt="" />`;
}

const io =
  "IntersectionObserver" in window
    ? new IntersectionObserver(
        (entries) => {
          for (const e of entries) {
            if (!e.isIntersecting) continue;
            io.unobserve(e.target);
            hydrate(e.target);
          }
        },
        { rootMargin: "200px" }
      )
    : null;

let scheduled = false;
function scan() {
  scheduled = false;
  document.querySelectorAll("[data-proof-src]:not([data-proof-state])").forEach((el) => {
    el.dataset.proofState = "wait";
    if (io) io.observe(el);
    else hydrate(el);
  });
}

new MutationObserver(() => {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(scan);
}).observe(document.body, { childList: true, subtree: true });
scan();

function openLightbox(url) {
  const box = document.createElement("div");
  box.className = "proof-lightbox";
  box.innerHTML = `<img src="${url}" alt="" /><button type="button" class="icon-btn proof-lb-close" aria-label="Yopish">✕</button>`;
  const close = () => {
    box.remove();
    document.removeEventListener("keydown", onKey);
  };
  const onKey = (e) => e.key === "Escape" && close();
  box.addEventListener("click", close);
  document.addEventListener("keydown", onKey);
  document.body.appendChild(box);
}

// capture: kartaning o‘zi bosilganda xaritada tanlanishi ishga tushmasin
document.addEventListener(
  "click",
  async (e) => {
    const el = e.target.closest?.("[data-proof-src]");
    if (!el) return;
    e.preventDefault();
    e.stopPropagation();
    const url = await load(el.dataset.proofSrc);
    if (url) openLightbox(url);
  },
  true
);
