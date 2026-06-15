const BOT = `<path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/>`;

function svg(stroke: string, badge = "") {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="${stroke}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${BOT}${badge}</svg>`;
}

function toUrl(s: string) {
  return `data:image/svg+xml,${encodeURIComponent(s)}`;
}

function setHref(url: string) {
  let el = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (!el) {
    el = Object.assign(document.createElement("link"), { rel: "icon" });
    document.head.appendChild(el);
  }
  el.href = url;
}

function statusSvg(content: string) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">${content}</svg>`;
}

// 10 frames × 100ms = 1 rotation per second, matched to browser favicon refresh rate
const SPINNER_N = 10;
const SPINNER_FRAMES = Array.from({ length: SPINNER_N }, (_, i) => {
  const a = (i / SPINNER_N) * Math.PI * 2 - Math.PI / 2;
  const sweep = Math.PI * 0.65;
  const r = 10;
  const cx = 12, cy = 12;
  const x1 = cx + r * Math.cos(a);
  const y1 = cy + r * Math.sin(a);
  const x2 = cx + r * Math.cos(a + sweep);
  const y2 = cy + r * Math.sin(a + sweep);
  const content =
    `<circle cx="12" cy="12" r="10" stroke="#38bdf8" stroke-width="2.5" fill="none" opacity="0.15"/>` +
    `<path d="M${x1.toFixed(3)} ${y1.toFixed(3)} A10 10 0 0 1 ${x2.toFixed(3)} ${y2.toFixed(3)}" stroke="#38bdf8" stroke-width="2.5" fill="none" stroke-linecap="round"/>`;
  return toUrl(statusSvg(content));
});

const STATUS_ICONS: Record<string, string> = {
  passed:  toUrl(statusSvg(`<circle cx="12" cy="12" r="10" fill="#22c55e"/><path d="M7 12.5l3.5 3.5 6.5-7" stroke="white" stroke-width="2.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`)),
  failed:  toUrl(statusSvg(`<circle cx="12" cy="12" r="10" fill="#ef4444"/><path d="M8 8l8 8M16 8l-8 8" stroke="white" stroke-width="2.2" stroke-linecap="round"/>`)),
  error:   toUrl(statusSvg(`<circle cx="12" cy="12" r="10" fill="#ef4444"/><path d="M8 8l8 8M16 8l-8 8" stroke="white" stroke-width="2.2" stroke-linecap="round"/>`)),
  waiting: toUrl(statusSvg(`<circle cx="12" cy="12" r="10" fill="#facc15"/><path d="M12 7v5.5l3 3" stroke="white" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" fill="none"/>`)),
  paused:  toUrl(statusSvg(`<circle cx="12" cy="12" r="10" fill="#64748b"/><path d="M9 8v8M15 8v8" stroke="white" stroke-width="2.2" stroke-linecap="round"/>`)),
  default: toUrl(svg("white")),
};

let timer: ReturnType<typeof setInterval> | null = null;
let frame = 0;

function stopTimer() {
  if (timer) { clearInterval(timer); timer = null; }
}

export function updateFavicon(status: string) {
  stopTimer();
  if (status === "running") {
    frame = 0;
    setHref(SPINNER_FRAMES[0]);
    timer = setInterval(() => {
      frame = (frame + 1) % SPINNER_N;
      setHref(SPINNER_FRAMES[frame]);
    }, 100);
    return;
  }
  setHref(STATUS_ICONS[status] ?? STATUS_ICONS.default);
}

export function resetFavicon() {
  stopTimer();
  setHref(STATUS_ICONS.default);
}
