/** Proposed bot covers, 1280×720, in the fetchr.fun «Split F / Round 07» language:
 *  flat surface ladder, 48 px line grid fading from the top, Inter 700 headings with
 *  one blue word, «01 / РАЗДЕЛ» eyebrows, product windows instead of clip-art icons.
 *
 *  node design/bot-redesign/covers.mjs
 *  → covers/*.svg (sources), covers/*.png (resvg check renders), covers.js (for the mock).
 *  Self-contained on purpose: nothing in scripts/lib/bot is touched until approval. */

import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { glyphSvg, planGlyph } from "./icons.mjs";

/** A plan icon from icons.mjs drawn straight on a card, `size` px square. */
const planIcon = (dir, id, x, y, size) =>
  `<g transform="translate(${x} ${y}) scale(${(size / 24).toFixed(3)})">${glyphSvg(planGlyph(dir, id), { stroke: 2 })}</g>`;

const W = 1280;
const H = 720;

/* Tokens from site-vitrina/css/tokens.css */
const T = {
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
  twitch: "#a970ff",
  kick: "#53fc18",
  youtube: "#ff4d4d",
};
const SOFT = {
  accent: "rgba(61,125,255,0.16)",
  success: "rgba(47,212,155,0.14)",
  warning: "rgba(242,169,59,0.14)",
  danger: "rgba(240,80,110,0.14)",
  muted: "rgba(243,246,251,0.06)",
};
const FG = { accent: T.accentBright, success: T.success, warning: T.warning, danger: T.danger, muted: T.text2 };

const SANS = "Inter";
const MONO = "JetBrains Mono";
const MARK =
  "M18 14H87Q91 14 91 18V29Q91 33 87 33H34V48H43Q47 48 47 52V63Q47 67 43 67H34V80Q34 84 30 84H18Q14 84 14 80V18Q14 14 18 14ZM71 48H87Q91 48 91 52V63Q91 67 87 67H71Q67 67 67 63V52Q67 48 71 48Z";

const xml = (v) => String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function width(text, size, { mono = false, weight = 600 } = {}) {
  const per = mono ? 0.6 : weight >= 700 ? 0.62 : weight >= 600 ? 0.59 : 0.56;
  return [...String(text)].reduce((s, ch) => s + (ch === " " ? 0.28 : /[ШЩЖМЮшщжмюWM@]/.test(ch) ? per * 1.35 : per), 0) * size;
}

/** Text with optional coloured runs: `parts` is a string or [[text, fill], …]. */
function text(x, y, parts, { size = 32, weight = 600, fill = T.text, mono = false, anchor = "start", ls = 0, cls = "" } = {}) {
  const runs = Array.isArray(parts) ? parts.map((run) => (Array.isArray(run) ? run : [run, fill])) : [[parts, fill]];
  const body = runs.map(([s, f]) => (f && f !== fill ? `<tspan fill="${f}">${xml(s)}</tspan>` : xml(s))).join("");
  return `<text${cls ? ` class="${cls}"` : ""} x="${x}" y="${y}" font-family="${mono ? MONO : SANS}" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}"${ls ? ` letter-spacing="${ls}"` : ""}>${body}</text>`;
}

const mark = (x, y, h, fill = T.accent) => `<path transform="translate(${x - (14 * h) / 70} ${y - (14 * h) / 70}) scale(${(h / 70).toFixed(4)})" fill="${fill}" d="${MARK}"/>`;

/** Pill tag with the mark, the site's `.eyebrow.tag`. */
function tag(x, y, label) {
  const size = 26;
  const w = Math.round(28 + 30 + 14 + width(label.toUpperCase(), size, { weight: 600 }) + label.length * 1.6 + 26);
  return `<rect x="${x}" y="${y}" width="${w}" height="60" rx="30" fill="${T.panel}" stroke="${T.line}" stroke-width="2"/>` +
    mark(x + 26, y + 15, 30) +
    text(x + 26 + 30 + 14, y + 39, label.toUpperCase(), { size, weight: 600, fill: T.text2, ls: 1.6 });
}

/** «01 / ТАРИФЫ»: number in accent, label in text-2 (`.eyebrow.idx`). */
function idx(x, y, num, label) {
  return text(x, y, [[num, T.accent], [` / ${label.toUpperCase()}`, T.text2]], { size: 28, weight: 700, ls: 1.8 });
}

function chip(x, y, label, { tone = "muted", dot = false, size = 26, h = 50, cls = "" } = {}) {
  const pad = 20;
  const dw = dot ? 22 : 0;
  const w = Math.round(pad * 2 + dw + width(label, size, { weight: 600 }));
  const cy = y + h / 2;
  return [
    `<g${cls ? ` class="${cls}"` : ""}><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${h / 2}" fill="${SOFT[tone]}" stroke="${FG[tone]}" stroke-opacity="0.32" stroke-width="2"/>` +
      (dot ? `<circle class="${tone === "danger" ? "mo-live" : ""}" cx="${x + pad + 6}" cy="${cy}" r="7" fill="${FG[tone]}"/>` : "") +
      text(x + pad + dw, cy + size * 0.36, label, { size, weight: 600, fill: FG[tone] }) + "</g>",
    w,
  ];
}

function rail(x, y, w, ratio, fill = T.accent, cls = "") {
  const r = Math.max(0, Math.min(1, ratio));
  return `<rect x="${x}" y="${y}" width="${w}" height="12" rx="6" fill="${T.raised}"/>` +
    (r > 0 ? `<rect${cls ? ` class="${cls}"` : ""} x="${x}" y="${y}" width="${Math.max(12, Math.round(w * r))}" height="12" rx="6" fill="${fill}"/>` : "");
}

/** App window (`.win` on the site): chrome bar with the mark, title and a right-hand chip. */
function win(x, y, w, h, title, right = "") {
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="36" fill="${T.chrome}" stroke="${T.lineStrong}" stroke-width="2"/>` +
    `<path d="M${x} ${y + 78}H${x + w}" stroke="${T.lineSubtle}" stroke-width="2"/>` +
    mark(x + 30, y + 26, 26) +
    text(x + 30 + 26 + 14, y + 49, title, { size: 26, weight: 600, fill: T.text }) +
    right;
}

function frame(body, { grid = true } = {}) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <pattern id="grid" width="48" height="48" patternUnits="userSpaceOnUse"><path d="M48 0H0V48" fill="none" stroke="${T.lineSubtle}" stroke-width="2"/></pattern>
    <radialGradient id="gridFade" cx="0.32" cy="0.1" r="0.8"><stop offset="0.15" stop-color="#fff"/><stop offset="1" stop-color="#000"/></radialGradient>
    <mask id="gridMask"><rect width="${W}" height="${H}" fill="url(#gridFade)"/></mask>
  </defs>
  <rect width="${W}" height="${H}" fill="${T.canvas}"/>
  ${grid ? `<rect width="${W}" height="${H}" fill="url(#grid)" mask="url(#gridMask)"/>` : ""}
  ${body}
</svg>`;
}

/** H1 lines: each line is a string or coloured runs. Inter 700, −0.045em, 0.98 line height. */
function h1(x, y, lines, size) {
  return lines.map((line, i) => text(x, y + i * size * 0.98, line, { size, weight: 700, ls: -(size * 0.045).toFixed(1) })).join("");
}

const L = 72;

/* ─────────────────────────────── covers ─────────────────────────────── */

/** Home, no key yet: the offer and the two-step path. */
function homeNew() {
  const wx = 724, wy = 92, ww = 484, wh = 536;
  const step = (n, y, title, sub, state) => {
    const col = state === "done" ? T.success : state === "now" ? T.accent : T.line;
    return `<rect x="${wx + 30}" y="${y}" width="56" height="56" rx="14" fill="${state === "next" ? T.raised : state === "done" ? SOFT.success : SOFT.accent}" stroke="${col}" stroke-width="2"/>` +
      text(wx + 58, y + 38, n, { size: 28, weight: 700, fill: state === "next" ? T.text3 : FG[state === "done" ? "success" : "accent"], anchor: "middle", mono: true }) +
      text(wx + 108, y + 26, title, { size: 30, weight: 600, fill: state === "next" ? T.text2 : T.text }) +
      text(wx + 108, y + 62, sub, { size: 24, weight: 500, fill: T.text3 });
  };
  return frame([
    tag(L, 72, "Fetchr · бот"),
    h1(L, 268, [["Ключ"], [["бесплатно,", T.accent]], ["за минуту"]], 104),
    text(L, 590, "Мат, музыка, блюр и чат —", { size: 34, weight: 500, fill: T.text2 }),
    text(L, 636, "исходник готов к монтажу", { size: 34, weight: 500, fill: T.text2 }),
    win(wx, wy, ww, wh, "Активация", chip(wx + ww - 168, wy + 14, "2 шага", { tone: "accent" })[0]),
    step("1", wy + 120, "Подписка на канал", "@streamcutter", "now"),
    `<path d="M${wx + 58} ${wy + 186}V${wy + 226}" stroke="${T.line}" stroke-width="2" stroke-dasharray="4 6"/>`,
    step("2", wy + 236, "Machine ID", "Fetchr → Настройки", "next"),
    `<path d="M${wx + 58} ${wy + 302}V${wy + 342}" stroke="${T.line}" stroke-width="2" stroke-dasharray="4 6"/>`,
    step("✓", wy + 352, "Ключ в чате", "копируется одной кнопкой", "next"),
    `<rect x="${wx + 30}" y="${wy + wh - 92}" width="${ww - 60}" height="62" rx="16" fill="${T.accentDeep}"/>`,
    text(wx + ww / 2, wy + wh - 51, "Получить ключ", { size: 28, weight: 600, fill: "#fff", anchor: "middle" }),
  ].join(""));
}

/** Home, key active: status tiles like the site's bento. */
function homeActive({ name = "Миша", archive = null } = {}) {
  const tile = (x, y, w, h, pick = false) =>
    `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="30" fill="${T.panel}" stroke="${pick ? T.accent : T.line}" stroke-width="2"/>` +
    (pick ? `<path d="M${x + 30} ${y + 1.5}H${x + w - 30}" stroke="${T.accent}" stroke-width="5" stroke-linecap="round"/>` : "");
  const ax = 492, ay = 300, aw = 716, ah = 348;
  return frame([
    tag(L, 72, "Fetchr"),
    `<circle cx="${W - 72 - 44}" cy="${102}" r="44" fill="${SOFT.accent}" stroke="${T.lineStrong}" stroke-width="2"/>`,
    text(W - 72 - 44, 118, name[0], { size: 44, weight: 700, fill: T.accentBright, anchor: "middle" }),
    h1(L, 236, [[[`${name}, `, T.text], ["всё работает", T.accent]]], 80),
    tile(L, 300, 396, 348),
    text(L + 36, 360, "КЛЮЧ", { size: 26, weight: 600, fill: T.text3, ls: 1.6 }),
    chip(L + 36, 392, "Активен", { tone: "success", dot: true, size: 34, h: 66 })[0],
    text(L + 36, 532, "1 устройство", { size: 36, weight: 600 }),
    text(L + 36, 586, "7F3A…5A61", { size: 30, weight: 500, mono: true, fill: T.text3 }),
    tile(ax, ay, aw, ah, !archive),
    text(ax + 36, ay + 60, archive ? `АРХИВ VPS · ${archive.plan.toUpperCase()}` : "АРХИВ VPS", { size: 26, weight: 600, fill: T.text3, ls: 1.6 }),
    ...(archive
      ? [
          text(ax + 36, ay + 178, [[archive.used, T.text], [` / ${archive.quota}`, T.text3]], { size: 96, weight: 700, ls: -3 }),
          rail(ax + 36, ay + 212, aw - 72, archive.ratio, T.accent, "mo-rail"),
          chip(ax + 36, ay + 256, "REC · kirya_live", { tone: "danger", dot: true, size: 28, h: 56 })[0],
          text(ax + aw - 36, ay + 296, `ещё ${archive.days} дн.`, { size: 30, weight: 600, fill: T.text2, anchor: "end" }),
        ]
      : [
          text(ax + 36, ay + 168, [["5 ГБ ", T.text], ["бесплатно", T.accent]], { size: 76, weight: 700, ls: -2.5 }),
          text(ax + 36, ay + 240, "Сервер пишет эфир с чатом,", { size: 32, weight: 500, fill: T.text2 }),
          text(ax + 36, ay + 284, "пока компьютер выключен", { size: 32, weight: 500, fill: T.text2 }),
        ]),
  ].join(""));
}

/** Registration step: subscribe (step 1) or waiting for the Machine ID (step 2). */
function register({ step = 1 } = {}) {
  const wx = 724, wy = 92, ww = 484, wh = 536;
  const field = step === 2
    ? `<rect x="${wx + 30}" y="${wy + 300}" width="${ww - 60}" height="76" rx="16" fill="${T.inset}" stroke="${T.accent}" stroke-width="2"/>` +
      text(wx + 54, wy + 349, "7F3A9C21D4E8…", { size: 28, weight: 500, mono: true, fill: T.text2 }) +
      `<rect class="mo-caret" x="${wx + 54 + width("7F3A9C21D4E8…", 28, { mono: true })}" y="${wy + 322}" width="3" height="34" fill="${T.accent}"/>` +
      `<rect x="${wx + 30}" y="${wy + 400}" width="${ww - 60}" height="62" rx="16" fill="${T.raised}" stroke="${T.line}" stroke-width="2"/>` +
      text(wx + ww / 2, wy + 441, "Скопировать Machine ID", { size: 26, weight: 600, fill: T.text, anchor: "middle" })
    : `<rect x="${wx + 30}" y="${wy + 300}" width="${ww - 60}" height="164" rx="20" fill="${T.panel}" stroke="${T.line}" stroke-width="2"/>` +
      mark(wx + 62, wy + 334, 40) +
      text(wx + 122, wy + 352, "Fetchr · канал", { size: 30, weight: 600 }) +
      text(wx + 122, wy + 390, "@streamcutter", { size: 26, weight: 500, fill: T.text3, mono: true }) +
      `<rect x="${wx + 62}" y="${wy + 412}" width="${ww - 124}" height="34" rx="17" fill="${T.accentDeep}"/>` +
      text(wx + ww / 2, wy + 437, "Подписаться", { size: 24, weight: 600, fill: "#fff", anchor: "middle" });
  return frame([
    idx(L, 108, `0${step}`, "из 02 · ключ"),
    h1(L, 244, step === 1 ? [["Подпишитесь"], [["— ключ ваш", T.accent]]] : [["Пришлите"], [["Machine ID", T.accent]]], 88),
    text(L, 470, step === 1 ? "Канал — анонсы и новые функции." : "Fetchr → Настройки →", { size: 34, weight: 500, fill: T.text2 }),
    text(L, 516, step === 1 ? "Ключ бесплатный и навсегда." : "Лицензия → Machine ID", { size: 34, weight: 500, fill: T.text2 }),
    rail(L, 600, 260, 1, step > 1 ? T.success : T.accent),
    rail(L + 280, 600, 260, step === 2 ? 1 : 0, T.accent, step === 2 ? "mo-rail" : ""),
    win(wx, wy, ww, wh, step === 1 ? "Telegram" : "Fetchr — Настройки"),
    text(wx + 30, wy + 150, step === 1 ? "Шаг 1" : "Лицензия и beta", { size: 26, weight: 600, fill: T.text3, ls: 1.2 }),
    text(wx + 30, wy + 206, step === 1 ? "Подписка на канал" : "Machine ID", { size: 40, weight: 700 }),
    text(wx + 30, wy + 252, step === 1 ? "проверим автоматически" : "или «Активировать через TG»", { size: 26, weight: 500, fill: T.text2 }),
    field,
  ].join(""));
}

/** Key issued: the activation window with the key already pasted. */
function keyReady() {
  const wx = 680, wy = 120, ww = 528, wh = 480;
  return frame([
    idx(L, 108, "✓", "ключ готов"),
    h1(L, 250, [["Ключ"], [["готов", T.success]]], 116),
    text(L, 448, "Скопируйте кнопкой под", { size: 34, weight: 500, fill: T.text2 }),
    text(L, 494, "сообщением и вставьте в Fetchr", { size: 34, weight: 500, fill: T.text2 }),
    rail(L, 580, 260, 1, T.success),
    rail(L + 280, 580, 260, 1, T.success),
    win(wx, wy, ww, wh, "Fetchr — Активация"),
    text(wx + 34, wy + 150, "ЛИЦЕНЗИОННЫЙ КЛЮЧ", { size: 24, weight: 600, fill: T.text3, ls: 1.6 }),
    `<rect x="${wx + 34}" y="${wy + 172}" width="${ww - 68}" height="84" rx="16" fill="${T.inset}" stroke="${T.success}" stroke-width="2"/>`,
    text(wx + 60, wy + 226, "FX1-7F3A-Q8KD-2MZP", { size: 32, weight: 500, mono: true, fill: T.text }),
    chip(wx + 34, wy + 290, "Активировано", { tone: "success", dot: true, size: 30, h: 60, cls: "mo-pop" })[0],
    text(wx + 34, wy + 410, "Устройство", { size: 26, weight: 500, fill: T.text3 }),
    text(wx + ww - 34, wy + 410, "7F3A…5A61", { size: 26, weight: 500, mono: true, fill: T.text2, anchor: "end" }),
    `<path d="M${wx + 34} ${wy + 432}H${wx + ww - 34}" stroke="${T.lineSubtle}" stroke-width="2"/>`,
  ].join(""));
}

/** Shop: the three plans as site plan cards, the pick with an accent top border. */
function shop({ dir = null } = {}) {
  const plans = dir
    ? [
        { id: "mini", name: "Мини · ≈ 7 ч", gb: "20 ГБ", h: "", price: "100 ₽" },
        { id: "start", name: "Старт · ≈ 17 ч", gb: "50 ГБ", h: "", price: "200 ₽" },
        { id: "streamer", name: "Стример · ≈ 52 ч", gb: "150 ГБ", h: "", price: "500 ₽", pick: true },
      ]
    : [
        { name: "Мини", gb: "20 ГБ", h: "≈ 7 ч эфира", price: "100 ₽" },
        { name: "Старт", gb: "50 ГБ", h: "≈ 17 ч эфира", price: "200 ₽" },
        { name: "Стример · 2 канала", gb: "150 ГБ", h: "≈ 52 ч", price: "500 ₽", pick: true },
      ];
  const tx = dir ? 132 : 34;
  const cx = 620, cw = 588, ch = 150, gap = 18;
  const cards = plans.map((p, i) => {
    const y = 96 + i * (ch + gap);
    return `<g class="mo-card" style="--i:${i}"><rect x="${cx}" y="${y}" width="${cw}" height="${ch}" rx="28" fill="${p.pick ? T.raised : T.panel}" stroke="${p.pick ? T.accent : T.line}" stroke-width="2"/>` +
      (p.pick ? `<path d="M${cx + 28} ${y + 1.5}H${cx + cw - 28}" stroke="${T.accent}" stroke-width="6" stroke-linecap="round"/>` : "") +
      (dir ? planIcon(dir, p.id, cx + 30, y + 37, 76) : "") +
      text(cx + tx, y + 58, p.name.toUpperCase(), { size: 26, weight: 600, fill: T.text2, ls: 1.6 }) +
      text(cx + tx, y + 116, p.gb, { size: 52, weight: 700, ls: -1.5 }) +
      (p.h ? text(cx + tx + width(p.gb, 52, { weight: 700 }) + 20, y + 114, p.h, { size: 26, weight: 500, fill: T.text3 }) : "") +
      text(cx + cw - 34, y + 116, p.price, { size: 52, weight: 700, anchor: "end", ls: -1.5 }) +
      (p.pick
        ? chip(cx + cw - 34 - (dir ? 84 : 176), y + 26, dir ? "Хит" : "Популярный", { tone: "accent", size: 22, h: 40 })[0]
        : text(cx + cw - 34, y + 58, "в месяц", { size: 24, weight: 500, fill: T.text3, anchor: "end" })) +
      "</g>";
  });
  return frame([
    idx(L, 108, "01", "архив vps"),
    h1(L, 230, [["Стрим запишется"], [["без вашего ПК", T.accent]]], 62),
    text(L, 400, "Копия эфира с чатом остаётся,", { size: 32, weight: 500, fill: T.text2 }),
    text(L, 444, "даже если VOD удалят", { size: 32, weight: 500, fill: T.text2 }),
    chip(L, 540, "Free · 5 ГБ навсегда", { tone: "success", size: 28, h: 58 })[0],
    text(L, 650, "Цены за 30 дней · Robokassa", { size: 26, weight: 500, fill: T.text3 }),
    ...cards,
  ].join(""));
}

/** Plan card with the term picked: a receipt the user reads before paying. */
function plan({ months = 1, dir = null } = {}) {
  const rows = { 1: ["1 месяц", "500 ₽", "", "500 ₽/мес"], 12: ["12 месяцев", "4 800 ₽", "6 000 ₽", "400 ₽/мес"] }[months];
  const wx = 660, wy = 96, ww = 548, wh = 528;
  const line = (y, a, b, opts = {}) =>
    text(wx + 34, y, a, { size: 28, weight: 500, fill: T.text2 }) + text(wx + ww - 34, y, b, { size: 28, weight: 600, anchor: "end", ...opts });
  return frame([
    idx(L, 108, "02", "оплата"),
    h1(L, 232, [["Стример"]], 112),
    dir ? planIcon(dir, "streamer", 566, 150, 84) : "",
    text(L, 370, [[rows[3].split("/")[0], T.text], ["/мес", T.text3]], { size: 88, weight: 700, ls: -3 }),
    ...(months === 12 ? [chip(L, 420, "−20% за год · экономия 1 200 ₽", { tone: "success", size: 26, h: 54 })[0]] : [text(L, 456, "12 мес — 400 ₽/мес", { size: 32, weight: 500, fill: T.text2 })]),
    text(L, 620, "Оферта · возврат за неиспользованные дни", { size: 24, weight: 500, fill: T.text3 }),
    win(wx, wy, ww, wh, "Заказ", chip(wx + ww - 186, wy + 14, "Robokassa", { tone: "muted", size: 22, h: 48 })[0]),
    line(wy + 146, "Место в архиве", "150 ГБ"),
    line(wy + 202, "Эфира в 1080p", "≈ 52 ч"),
    line(wy + 258, "Стримеров разом", "2"),
    line(wy + 314, "Срок", rows[0]),
    `<path d="M${wx + 34} ${wy + 350}H${wx + ww - 34}" stroke="${T.line}" stroke-width="2" stroke-dasharray="6 8"/>`,
    text(wx + 34, wy + 418, "Итого", { size: 32, weight: 600 }),
    ...(rows[2] ? [text(wx + ww - 34, wy + 380, rows[2], { size: 26, weight: 500, fill: T.text3, anchor: "end" }) + `<path d="M${wx + ww - 34 - width(rows[2], 26, { weight: 500 })} ${wy + 371}H${wx + ww - 34}" stroke="${T.text3}" stroke-width="2"/>`] : []),
    text(wx + ww - 34, wy + 424, rows[1], { size: 52, weight: 700, anchor: "end", ls: -1.5, cls: "mo-price" }),
    ...["СБП", "Карта", "T-Pay", "Яндекс Пэй"].reduce((acc, label) => {
      const [svg, w] = chip(acc.x, wy + 456, label, { tone: "muted", size: 22, h: 44 });
      return { x: acc.x + w + 10, out: [...acc.out, svg] };
    }, { x: wx + 34, out: [] }).out,
  ].join(""));
}

/** Paid: the archive queue from the site hero, the first stream already recording. */
function paid() {
  const wx = 600, wy = 96, ww = 608, wh = 528;
  const row = (y, title, sub, status, tone, ratio, cls = "") =>
    `<rect x="${wx + 2}" y="${y}" width="${ww - 4}" height="118" fill="${tone === "danger" ? "rgba(61,125,255,0.05)" : "transparent"}"/>` +
    `<rect x="${wx + 30}" y="${y + 26}" width="96" height="64" rx="10" fill="${T.raised}" stroke="${T.lineStrong}" stroke-width="2"/>` +
    `<path d="M${wx + 70} ${y + 44}V${y + 72}L${wx + 92} ${y + 58}Z" fill="${T.text3}"/>` +
    text(wx + 150, y + 54, title, { size: 28, weight: 600 }) +
    text(wx + 150, y + 90, sub, { size: 22, weight: 500, mono: true, fill: T.text3 }) +
    `<circle class="${tone === "danger" ? "mo-live" : ""}" cx="${wx + ww - 196}" cy="${y + 46}" r="7" fill="${FG[tone]}"/>` +
    text(wx + ww - 180, y + 55, status, { size: 26, weight: 600, fill: FG[tone] }) +
    rail(wx + ww - 196, y + 74, 166, ratio, tone === "success" ? T.success : T.accent, cls) +
    `<path d="M${wx + 2} ${y + 118}H${wx + ww - 2}" stroke="${T.lineSubtle}" stroke-width="2"/>`;
  return frame([
    idx(L, 108, "✓", "оплачено"),
    h1(L, 236, [["Сервер"], [["уже пишет", T.success]]], 100),
    text(L, 408, "Стример · 150 ГБ · 12 мес", { size: 34, weight: 600, fill: T.text }),
    text(L, 454, "до 18.11.2027 · заказ #A7F3K2", { size: 28, weight: 500, mono: true, fill: T.text3 }),
    chip(L, 520, "Компьютер можно выключить", { tone: "muted", size: 26, h: 54 })[0],
    win(wx, wy, ww, wh, "Архив VPS", chip(wx + ww - 214, wy + 14, "2 / 2 канала", { tone: "accent", size: 22, h: 48 })[0]),
    row(wy + 80, "kirya_live", "02:14:08 · 7,9 ГБ", "LIVE", "danger", 0.42, "mo-rail"),
    row(wy + 198, "nightcap_tv", "ждём эфир", "ждём", "warning", 0),
    row(wy + 316, "kirya_live · вчера", "03:58:12 · 13,5 ГБ", "готово", "success", 1),
    text(wx + 30, wy + wh - 30, "Занято 21,4 из 150 ГБ", { size: 24, weight: 500, fill: T.text3 }),
  ].join(""));
}

/** BotFather description picture (export 640×360): what the bot does in one second. */
function description() {
  return frame([
    tag(L, 72, "Fetchr · бот"),
    h1(L, 250, [["Ключ Fetchr"], [["и Архив VPS", T.accent]]], 96),
    text(L, 452, "Ключ — бесплатно, за минуту", { size: 40, weight: 600, fill: T.text }),
    text(L, 510, "Сервер пишет стримы 24/7 · от 100 ₽", { size: 40, weight: 500, fill: T.text2 }),
    text(L, 568, "Поддержка отвечает прямо в чате", { size: 40, weight: 500, fill: T.text2 }),
    mark(964, 240, 196),
  ].join(""));
}

export const COVERS = {
  "home-new": homeNew,
  "home-active": () => homeActive(),
  "register-1": () => register({ step: 1 }),
  "register-2": () => register({ step: 2 }),
  key: keyReady,
  shop: () => shop(),
  "shop-A": () => shop({ dir: "A" }),
  "shop-B": () => shop({ dir: "B" }),
  "shop-C": () => shop({ dir: "C" }),
  "plan-1-A": () => plan({ months: 1, dir: "A" }),
  "plan-1-B": () => plan({ months: 1, dir: "B" }),
  "plan-1-C": () => plan({ months: 1, dir: "C" }),
  "plan-1": () => plan({ months: 1 }),
  "plan-12": () => plan({ months: 12 }),
  paid,
  "botfather-description": description,
};

async function main() {
  const here = (p) => fileURLToPath(new URL(p, import.meta.url));
  mkdirSync(here("./covers/"), { recursive: true });
  const svgs = Object.fromEntries(Object.entries(COVERS).map(([name, build]) => [name, build()]));
  let Resvg = null;
  try {
    ({ Resvg } = await import("@resvg/resvg-js"));
  } catch {
    Resvg = null;
  }
  for (const [name, svg] of Object.entries(svgs)) {
    writeFileSync(here(`./covers/${name}.svg`), svg, "utf8");
    if (Resvg) {
      const png = new Resvg(svg, { font: { fontDirs: [here("../../scripts/assets/fonts/")], loadSystemFonts: false, defaultFontFamily: "Inter" } }).render().asPng();
      writeFileSync(here(`./covers/${name}.png`), png);
    }
  }
  writeFileSync(here("./covers.js"), `/* Generated by covers.mjs */\nwindow.FETCHR_COVERS = ${JSON.stringify(svgs)};\n`, "utf8");
}

main().catch((err) => {
  process.stderr.write(`covers: ${err instanceof Error ? err.message : err}\n`);
  process.exitCode = 1;
});
