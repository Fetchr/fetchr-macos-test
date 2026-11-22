/** Pictures above the bot's screens, drawn as SVG in the fetchr.fun language
 *  («Split F / Round 07», site-vitrina/css/tokens.css): a flat surface ladder
 *  from #0b0d12, a 48 px line grid fading from the top, Inter 700 headings
 *  with one blue word, «01 / РАЗДЕЛ» eyebrows and product windows instead of
 *  clip-art. No shadows, no glows. pictures.mjs turns them into PNG.
 *
 * Everything is 1280×720. Telegram shows it about 400 px wide, so text is
 * never smaller than 22 px and the main facts are 64 px and up. */

export const WIDTH = 1280;
export const HEIGHT = 720;

export const C = {
  canvas: "#0b0d12",
  inset: "#0e1117",
  chrome: "#10131a",
  panel: "#141821",
  raised: "#1a1f2a",
  elevated: "#1f2531",
  lineSubtle: "#191e28",
  line: "#222835",
  lineStrong: "rgba(243,246,251,0.16)",
  text: "#f3f6fb",
  text2: "#a4aebe",
  text3: "#7d8799",
  accent: "#3d7dff",
  accentBright: "#86abff",
  accentDeep: "#2e63d6",
  success: "#2fd49b",
  warning: "#f2a93b",
  danger: "#f0506e",
  zone: "#a78bfa",
};
const SANS = "Inter";
const MONO = "JetBrains Mono";

export function xml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Rough advance width; enough to size chips and to clip long names. */
export function textWidth(text, size, { mono = false, weight = 600 } = {}) {
  const per = mono ? 0.6 : weight >= 700 ? 0.62 : weight >= 600 ? 0.59 : 0.56;
  return [...String(text)].reduce((sum, ch) => sum + (ch === " " ? 0.28 : /[ШЩЖМЮшщжмю@WMm]/.test(ch) ? per * 1.35 : per), 0) * size;
}

export function clip(text, size, maxWidth, options) {
  const chars = [...String(text)];
  if (textWidth(text, size, options) <= maxWidth) return String(text);
  while (chars.length > 1 && textWidth(`${chars.join("")}…`, size, options) > maxWidth) chars.pop();
  return `${chars.join("").trimEnd()}…`;
}

/** Largest size ≤ `max` (step 4, floor 36) at which every line fits `width`. */
export function fit(lines, max, width, options) {
  const plain = (line) => (Array.isArray(line) ? line.map((run) => (Array.isArray(run) ? run[0] : run)).join("") : line);
  let size = max;
  while (size > 36 && lines.some((line) => textWidth(plain(line), size, options) > width)) size -= 4;
  return size;
}

/** Text with optional coloured runs: `content` is a string or [[text, fill], …]. */
export function t(x, y, content, { size = 32, weight = 600, fill = C.text, mono = false, anchor = "start", spacing = 0, cls = "" } = {}) {
  const runs = Array.isArray(content) ? content.map((run) => (Array.isArray(run) ? run : [run, fill])) : [[content, fill]];
  const body = runs.map(([text, color]) => (color && color !== fill ? `<tspan fill="${color}">${xml(text)}</tspan>` : xml(text))).join("");
  const ls = spacing ? ` letter-spacing="${spacing}"` : "";
  return `<text${cls ? ` class="${cls}"` : ""} x="${x}" y="${y}" font-family="${mono ? MONO : SANS}" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}"${ls}>${body}</text>`;
}

/** Heading lines, Inter 700, −0.045em, line height 0.98. Returns [svg, bottom y]. */
export function h1(x, y, lines, size) {
  const svg = lines.map((line, index) => t(x, y + index * size * 0.98, line, { size, weight: 700, spacing: -(size * 0.045).toFixed(1) })).join("");
  return [svg, y + (lines.length - 1) * size * 0.98];
}

/** «01 / РАЗДЕЛ»: the number in accent, the label in text-2 (`.eyebrow.idx`). */
export function idx(x, y, num, label) {
  return t(x, y, [[num, C.accent], [` / ${String(label).toUpperCase()}`, C.text2]], { size: 28, weight: 700, spacing: 1.8 });
}

/** Uppercase label, the site's eyebrow. */
export function eyebrow(x, y, text, fill = C.text3) {
  return t(x, y, String(text).toUpperCase(), { size: 26, weight: 600, fill, spacing: 1.6 });
}

const TONES = {
  success: [C.success, "rgba(47,212,155,0.14)"],
  warning: [C.warning, "rgba(242,169,59,0.14)"],
  danger: [C.danger, "rgba(240,80,110,0.14)"],
  accent: [C.accentBright, "rgba(61,125,255,0.16)"],
  muted: [C.text2, "rgba(243,246,251,0.06)"],
  zone: [C.zone, "rgba(167,139,250,0.16)"],
};
export const toneColor = (tone) => (TONES[tone] || TONES.accent)[0];
export const toneSoft = (tone) => (TONES[tone] || TONES.accent)[1];

/** A status chip with an optional dot. Returns [svg, width]. */
export function chip(x, y, label, { tone = "muted", size = 26, dot = false, h = 50 } = {}) {
  const [fg, bg] = TONES[tone] || TONES.muted;
  const pad = 20;
  const dotW = dot ? 22 : 0;
  const w = Math.round(pad * 2 + dotW + textWidth(label, size, { weight: 600 }));
  const cy = y + h / 2;
  return [
    `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${h / 2}" fill="${bg}" stroke="${fg}" stroke-opacity="0.32" stroke-width="2"/>` +
      (dot ? `<circle cx="${x + pad + 6}" cy="${cy}" r="7" fill="${fg}"/>` : "") +
      t(x + pad + dotW, cy + size * 0.36, label, { size, weight: 600, fill: fg }),
    w,
  ];
}

/** Pill tag with the mark, the site's `.eyebrow.tag`. */
export function tag(x, y, label) {
  const text = String(label).toUpperCase();
  const w = Math.round(26 + 30 + 14 + textWidth(text, 26, { weight: 600 }) + text.length * 1.6 + 26);
  return `<rect x="${x}" y="${y}" width="${w}" height="60" rx="30" fill="${C.panel}" stroke="${C.line}" stroke-width="2"/>` +
    mark(x + 26, y + 15, 30) +
    t(x + 26 + 30 + 14, y + 39, text, { size: 26, weight: 600, fill: C.text2, spacing: 1.6 });
}

export function rail(x, y, w, ratio, fill = C.accent) {
  const r = Math.max(0, Math.min(1, Number(ratio) || 0));
  return `<rect x="${x}" y="${y}" width="${w}" height="12" rx="6" fill="${C.raised}"/>` +
    (r > 0 ? `<rect x="${x}" y="${y}" width="${Math.max(12, Math.round(w * r))}" height="12" rx="6" fill="${fill}"/>` : "");
}

/** A flat tile; `pick` adds the accent border and top edge of `.plan.pick`. */
export function panel(x, y, w, h, { pick = false, fill = C.panel } = {}) {
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="30" fill="${pick ? C.raised : fill}" stroke="${pick ? C.accent : C.line}" stroke-width="2"/>` +
    (pick ? `<path d="M${x + 30} ${y + 1.5}H${x + w - 30}" stroke="${C.accent}" stroke-width="6" stroke-linecap="round"/>` : "");
}

/** App window (`.win` on the site): chrome bar with the mark, a title and an optional right-hand part. */
export function win(x, y, w, h, title, right = "") {
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="36" fill="${C.chrome}" stroke="${C.lineStrong}" stroke-width="2"/>` +
    `<path d="M${x} ${y + 78}H${x + w}" stroke="${C.lineSubtle}" stroke-width="2"/>` +
    mark(x + 30, y + 26, 26) +
    t(x + 70, y + 49, clip(title, 26, w - 120 - (right ? 160 : 0), { weight: 600 }), { size: 26, weight: 600 }) +
    right;
}

export const MARK =
  "M18 14H87Q91 14 91 18V29Q91 33 87 33H34V48H43Q47 48 47 52V63Q47 67 43 67H34V80Q34 84 30 84H18Q14 84 14 80V18Q14 14 18 14ZM71 48H87Q91 48 91 52V63Q91 67 87 67H71Q67 67 67 63V52Q67 48 71 48Z";

/** The Split F mark with its top-left corner at (x, y), `h` px tall. */
export function mark(x, y, h, fill = C.accent) {
  const s = h / 70;
  return `<path transform="translate(${(x - 14 * s).toFixed(2)} ${(y - 14 * s).toFixed(2)}) scale(${s.toFixed(4)})" fill="${fill}" d="${MARK}"/>`;
}

/** Canvas and the 48 px line grid fading out from the top left (`.hero-grid`). Flat: no glow. */
export function frame(body) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
  <defs>
    <pattern id="grid" width="48" height="48" patternUnits="userSpaceOnUse"><path d="M48 0H0V48" fill="none" stroke="${C.lineSubtle}" stroke-width="2"/></pattern>
    <radialGradient id="gridFade" cx="0.32" cy="0.1" r="0.8"><stop offset="0.15" stop-color="#fff"/><stop offset="1" stop-color="#000"/></radialGradient>
    <mask id="gridMask"><rect width="${WIDTH}" height="${HEIGHT}" fill="url(#gridFade)"/></mask>
  </defs>
  <rect width="${WIDTH}" height="${HEIGHT}" fill="${C.canvas}"/>
  <rect width="${WIDTH}" height="${HEIGHT}" fill="url(#grid)" mask="url(#gridMask)"/>
  ${body}
</svg>`;
}

const fmtGb = (gb) => (gb >= 1000 ? `${+(gb / 1000).toFixed(1)} ТБ` : `${gb} ГБ`);
const devicesWord = (n) => (n % 10 === 1 && n % 100 !== 11 ? "устройство" : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? "устройства" : "устройств");

/** Round profile photo with a hairline ring; without one, the initial on
 *  an accent disc (or nothing when there is no initial either). */
export function avatarBadge(cx, cy, r, uri, initial = "") {
  const ring = `<circle cx="${cx}" cy="${cy}" r="${r + 3}" fill="none" stroke="${C.text}" stroke-opacity="0.16" stroke-width="3"/>`;
  if (uri) {
    return `<defs><clipPath id="avatar"><circle cx="${cx}" cy="${cy}" r="${r}"/></clipPath></defs>` +
      `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${C.raised}"/>` +
      `<image href="${uri}" x="${cx - r}" y="${cy - r}" width="${r * 2}" height="${r * 2}" preserveAspectRatio="xMidYMid slice" clip-path="url(#avatar)"/>` + ring;
  }
  const letter = [...String(initial).trim()][0];
  if (!letter) return "";
  return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="rgba(61,125,255,0.16)"/>` + ring +
    t(cx, cy + r * 0.36, letter.toUpperCase(), { size: r, weight: 700, fill: C.accentBright, anchor: "middle" });
}

/* ───────────────────────── motion ─────────────────────────
 * One loop of LOOP_S seconds for the animated covers (MP4, render-covers.mjs).
 * `t` null is the still picture, and frame t = 0 is exactly that picture, so
 * the MP4's first frame equals the PNG. At RESET_AT the moving parts settle
 * back (320 ms), then rails grow back (2.4 s) and blocks rise (320 ms each,
 * 80 ms apart) on the site's ease-cine curve; the rest of the loop holds
 * still, so the seam between loops is invisible. Live dots pulse in step
 * with the loop (1.6 s, three times per loop). */

export const LOOP_S = 4.8;
const RESET_AT = 0.6;
const RESET_S = 0.32;
const GROW_S = 2.4;
const RISE_S = 0.32;
const STEP_S = 0.08;
const RISE_PX = 14;
/** Close to cubic-bezier(0.22, 1, 0.36, 1), the site's --ease-cine. */
const easeOut = (x) => 1 - (1 - x) ** 4;
const easeIn = (x) => x ** 2;

/** Share of a rail drawn at time `t` (1 = as in the still). */
export function grow(t) {
  if (t == null || t < RESET_AT) return 1;
  const since = t - RESET_AT;
  if (since < RESET_S) return 1 - 0.85 * easeIn(since / RESET_S);
  const p = (since - RESET_S) / GROW_S;
  return p >= 1 ? 1 : 0.15 + 0.85 * easeOut(p);
}

/** Offset and opacity of the `index`-th rising block at time `t`. */
export function rise(t, index = 0) {
  if (t == null || t < RESET_AT) return { dy: 0, opacity: 1 };
  const since = t - RESET_AT;
  if (since < RESET_S) {
    const p = easeIn(since / RESET_S);
    return { dy: RISE_PX * p, opacity: 1 - p };
  }
  const p = (since - RESET_S - index * STEP_S) / RISE_S;
  if (p <= 0) return { dy: RISE_PX, opacity: 0 };
  if (p >= 1) return { dy: 0, opacity: 1 };
  const e = easeOut(p);
  return { dy: RISE_PX * (1 - e), opacity: e };
}

/** Wraps a block that rises; untouched (no wrapper) whenever it is at rest. */
export function riseG(t, index, svg) {
  const { dy, opacity } = rise(t, index);
  if (dy === 0 && opacity === 1) return svg;
  return `<g transform="translate(0 ${dy.toFixed(2)})" opacity="${opacity.toFixed(3)}">${svg}</g>`;
}

/** Opacity of a live dot: 1 at t = 0 and every 1.6 s, dimmest in between. */
export function pulse(t, period = 1.6) {
  if (t == null) return 1;
  return 0.35 + 0.65 * (0.5 + 0.5 * Math.cos((2 * Math.PI * t) / period));
}

/** A live dot (REC / LIVE) that pulses with the loop. */
export function liveDot(cx, cy, r, fill, t) {
  const o = pulse(t);
  return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${fill}"${o === 1 ? "" : ` opacity="${o.toFixed(3)}"`}/>`;
}

/* ───────────────────────── home dashboard ───────────────────────── */

const L = 72;

/**
 * The home cover without anything personal, so one animated MP4 serves
 * everyone in the same state; the name, Machine ID and days left are in the
 * text under it. `state`: "new" (no key), "key" (key, no archive), "free"
 * (Free archive), "paid" (paid archive). `promo`: { percent, until } or null.
 */
export function homeSceneSvg({ state = "new", shop = true, promo = null, t: time = null } = {}) {
  const top = [tag(L, 72, "Fetchr")];
  if (promo) {
    const label = `−${promo.percent}% до ${promo.until}`;
    const w = Math.round(40 + textWidth(label, 28, { weight: 600 }));
    top.push(chip(WIDTH - L - w, 74, label, { tone: "danger", size: 28, h: 56 })[0]);
  }
  if (state === "new") return frame(top.join("") + homeNew("", time));
  const kw = shop ? 396 : WIDTH - L * 2;
  const keyTile = panel(L, 300, kw, 348) +
    eyebrow(L + 36, 360, "Ключ") +
    chip(L + 36, 392, "Активен", { tone: "success", dot: true, size: 34, h: 66 })[0] +
    t(L + 36, 532, "Fetchr готов", { size: 36, weight: 600 }) +
    t(L + 36, 586, "к работе", { size: 36, weight: 600, fill: C.text2 });
  const sub = state === "paid" ? { active: true, generic: true } : state === "free" ? { active: true, free: true, quota_gb: 5 } : null;
  return frame([
    ...top,
    t(L, 236, [["Всё ", C.text], ["работает", C.accent]], { size: 80, weight: 700, spacing: -3.6 }),
    riseG(time, 0, keyTile),
    shop ? riseG(time, 1, archiveTile(492, 300, 716, 348, sub, time)) : "",
  ].join(""));
}

/** No key yet: the offer on the left, the two steps in an activation window. */
function homeNew(name, time = null) {
  const wx = 724, wy = 92, ww = 484, wh = 536;
  const step = (n, y, title, sub, now) =>
    `<rect x="${wx + 30}" y="${y}" width="56" height="56" rx="14" fill="${now ? toneSoft("accent") : C.raised}" stroke="${now ? C.accent : C.line}" stroke-width="2"/>` +
    t(wx + 58, y + 38, n, { size: 28, weight: 700, mono: true, anchor: "middle", fill: now ? C.accentBright : C.text3 }) +
    t(wx + 108, y + 26, title, { size: 30, weight: 600, fill: now ? C.text : C.text2 }) +
    t(wx + 108, y + 62, sub, { size: 24, weight: 500, fill: C.text3 });
  const dash = (y) => `<path d="M${wx + 58} ${y}V${y + 40}" stroke="${C.line}" stroke-width="2" stroke-dasharray="4 6"/>`;
  const [title] = h1(L, 300, [["Ключ"], [["бесплатно,", C.accent]], ["за минуту"]], 100);
  return [
    name ? t(L, 200, clip(`Привет, ${name}`, 36, 600, { weight: 600 }), { size: 36, weight: 600, fill: C.text2 }) : "",
    title,
    t(L, 594, "Мат, музыка, блюр и чат —", { size: 32, weight: 500, fill: C.text2 }),
    t(L, 638, "исходник готов к монтажу", { size: 32, weight: 500, fill: C.text2 }),
    win(wx, wy, ww, wh, "Активация", chip(wx + ww - 168, wy + 14, "2 шага", { tone: "accent" })[0]),
    riseG(time, 0, step("1", wy + 120, "Подписка на канал", "анонсы и новые функции", true)),
    dash(wy + 186),
    riseG(time, 1, step("2", wy + 236, "Machine ID", "Fetchr → Настройки", false)),
    dash(wy + 302),
    riseG(time, 2, step("✓", wy + 352, "Ключ в чате", "копируется одной кнопкой", false)),
    riseG(time, 3, `<rect x="${wx + 30}" y="${wy + wh - 92}" width="${ww - 60}" height="62" rx="16" fill="${C.accentDeep}"/>` +
      t(wx + ww / 2, wy + wh - 51, "Получить ключ", { size: 28, weight: 600, fill: "#fff", anchor: "middle" })),
  ].join("");
}

function archiveTile(x, y, w, h, subscription, time = null) {
  const paid = subscription?.active && !subscription.free;
  const parts = [panel(x, y, w, h, { pick: !paid && !subscription?.active })];
  if (paid && subscription.generic) {
    parts.push(
      eyebrow(x + 36, y + 60, "Архив VPS · тариф активен"),
      t(x + 36, y + 176, "24/7", { size: 96, weight: 700, spacing: -3 }),
      rail(x + 36, y + 212, w - 72, grow(time)),
      liveDot(x + 50, y + 284, 8, C.danger, time),
      t(x + 70, y + 296, "REC · сервер пишет эфиры", { size: 34, weight: 600 }),
    );
  } else if (paid) {
    const ratio = subscription.period_days ? subscription.days_left / subscription.period_days : 1;
    const until = new Date(subscription.paid_until).toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit", timeZone: "Europe/Moscow" });
    parts.push(
      eyebrow(x + 36, y + 60, `Архив VPS · ${subscription.plan}`),
      t(x + 36, y + 176, fmtGb(subscription.quota_gb || 0), { size: 96, weight: 700, spacing: -3 }),
      rail(x + 36, y + 212, w - 72, ratio),
      t(x + 36, y + 296, `ещё ${subscription.days_left} дн.`, { size: 40, weight: 700 }),
      t(x + w - 36, y + 296, `до ${until}`, { size: 30, weight: 500, mono: true, fill: C.text3, anchor: "end" }),
    );
  } else if (subscription?.active) {
    parts.push(
      eyebrow(x + 36, y + 60, "Архив VPS · Free"),
      t(x + 36, y + 176, fmtGb(subscription.quota_gb || 5), { size: 96, weight: 700, spacing: -3 }),
      t(x + 36, y + 250, "бесплатно навсегда", { size: 36, weight: 600, fill: C.accentBright }),
      t(x + 36, y + 300, "больше места — в тарифах", { size: 30, weight: 500, fill: C.text2 }),
    );
  } else {
    parts.push(
      eyebrow(x + 36, y + 60, "Архив VPS"),
      t(x + 36, y + 168, [["5 ГБ ", C.text], ["бесплатно", C.accent]], { size: 76, weight: 700, spacing: -2.5 }),
      t(x + 36, y + 240, "Сервер пишет эфир с чатом,", { size: 32, weight: 500, fill: C.text2 }),
      t(x + 36, y + 284, "пока компьютер выключен", { size: 32, weight: 500, fill: C.text2 }),
    );
  }
  return parts.join("");
}

/** Key active: «Имя, всё работает», then the key tile and (with the shop) the archive tile. */
function homeActive({ name, devices, machineId, shop, subscription }) {
  const head = clip(`${name || "Fetchr"}, `, 80, 520, { weight: 700 });
  const kw = shop ? 396 : WIDTH - L * 2;
  return [
    t(L, 236, [[head, C.text], ["всё работает", C.accent]], { size: 80, weight: 700, spacing: -3.6 }),
    panel(L, 300, kw, 348),
    eyebrow(L + 36, 360, "Ключ"),
    chip(L + 36, 392, "Активен", { tone: "success", dot: true, size: 34, h: 66 })[0],
    t(L + 36, 532, `${devices} ${devicesWord(devices)}`, { size: 36, weight: 600 }),
    machineId ? t(L + 36, 586, machineId, { size: 30, weight: 500, mono: true, fill: C.text3 }) : "",
    shop ? archiveTile(492, 300, 716, 348, subscription) : "",
  ].join("");
}

/** `data`: { name, devices, machineId, shop, subscription, promo, avatar }.
 *  subscription: { active, free, plan, quota_gb, days_left, period_days, paid_until } or null.
 *  promo: { percent, until } or null. */
export function homeCardSvg({ name = "", devices = 0, machineId = "", shop = false, subscription = null, promo = null, avatar = null } = {}) {
  const R = 44;
  const active = devices > 0;
  // A new user's dashboard has the activation window top right: no avatar there.
  const top = [tag(L, 72, "Fetchr"), active ? avatarBadge(WIDTH - L - R, 102, R, avatar, name) : ""];
  if (promo && active) {
    const label = `−${promo.percent}% до ${promo.until}`;
    const w = Math.round(40 + textWidth(label, 28, { weight: 600 }));
    top.push(chip(WIDTH - L - R * 2 - 24 - w, 74, label, { tone: "danger", size: 28, h: 56 })[0]);
  }
  const body = active ? homeActive({ name, devices, machineId, shop, subscription }) : homeNew(name);
  return frame(top.join("") + body);
}
