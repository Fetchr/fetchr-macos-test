/** «Fetchr Line» — custom emoji and button/cover icons for the bot, in the
 *  fetchr.fun language: 24 px grid, 2 px keyline padding, stroke 2, round caps
 *  and joins, corner radius 2.5, one accent element and one soft tone fill per
 *  glyph (the app's duotone rule, src/ui/redesign/icons/motion/tone.ts).
 *  Flat: no gloss, no glow, depth only from the surface ladder.
 *
 *  node design/bot-redesign/icons.mjs
 *  → icons/<name>.svg            24×24 source glyph (currentColor + accent)
 *    icons/emoji/<name>.svg|png  100×100 tile emoji for text (<tg-emoji>)
 *    icons/adaptive/<name>.png   100×100 one-colour glyph for a needs_repainting set (buttons)
 *    icons/plans/<dir>-<plan>.svg|png, icons/plans/term-<n>.svg|png
 *    icons/pack.json             emoji → base emoji → where it is used
 *    icons.js                    the same SVGs for the mock (window.FETCHR_ICONS) */

import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const INK = {
  fg: "#f3f6fb",
  accent: "#3d7dff",
  success: "#2fd49b",
  warning: "#f2a93b",
  danger: "#f0506e",
  tile: "#1f2531",
  tileLine: "rgba(243,246,251,0.14)",
};

/* ───────────── glyphs: base (stroke fg), accent (stroke), dot (fill accent), tone (soft fill) ───────────── */

/** Each glyph: { base, accent, dot, tone, hue, ghost } — strings of SVG elements on the 24 grid. */
export const GLYPHS = {
  key: {
    base: '<circle cx="7.5" cy="16.5" r="4.5"/><path d="M10.7 13.3 20.5 3.5"/><path d="m17 7 2.5 2.5"/>',
    accent: '<path d="m14 10 2 2"/>',
    dot: '<circle cx="7.5" cy="16.5" r="1.6"/>',
    tone: '<circle cx="7.5" cy="16.5" r="4.5"/>',
    emoji: "🔑", use: "Получить ключ, Мой ключ, строка ключа",
  },
  archive: {
    base: '<rect x="3" y="3.5" width="18" height="7.5" rx="2.5"/><rect x="3" y="13" width="18" height="7.5" rx="2.5"/><path d="M11 16.75h6"/>',
    accent: '<path d="M11 7.25h6"/>',
    dot: '<circle cx="7" cy="7.25" r="1.5"/><circle cx="7" cy="16.75" r="1.5"/>',
    tone: '<rect x="3" y="3.5" width="18" height="7.5" rx="2.5"/>',
    emoji: "🗄", use: "Архив VPS, тарифы",
  },
  restream: {
    base: '<path d="M16.2 7.8a6 6 0 0 1 0 8.4"/><path d="M7.8 16.2a6 6 0 0 1 0-8.4"/>',
    accent: '<path d="M19.4 4.6a10.5 10.5 0 0 1 0 14.8"/><path d="M4.6 19.4a10.5 10.5 0 0 1 0-14.8"/>',
    dot: '<circle cx="12" cy="12" r="2.4"/>',
    tone: '<circle cx="12" cy="12" r="5"/>',
    emoji: "📡", use: "Рестрим, апселл после оплаты",
  },
  card: {
    base: '<rect x="2.5" y="5" width="19" height="14" rx="2.5"/><path d="M2.5 9.5h19"/>',
    accent: '<path d="M6 15h4"/>',
    tone: '<rect x="2.5" y="5" width="19" height="4.5"/>',
    emoji: "💳", use: "Оплатить",
  },
  copy: {
    base: '<rect x="9" y="9" width="12" height="12" rx="2.5"/><path d="M15 9V5.5A2.5 2.5 0 0 0 12.5 3h-7A2.5 2.5 0 0 0 3 5.5v7A2.5 2.5 0 0 0 5.5 15H9"/>',
    accent: '<path d="M12.5 15h5"/>',
    tone: '<rect x="9" y="9" width="12" height="12" rx="2.5"/>',
    emoji: "📋", use: "Скопировать ключ (copy_text)",
  },
  check: {
    base: '<circle cx="12" cy="12" r="9"/>',
    accent: '<path d="m7.8 12.3 2.8 2.8 5.6-5.8"/>',
    tone: '<circle cx="12" cy="12" r="9"/>',
    hue: "success", emoji: "✅", use: "Ключ активен, оплачено, подписка есть",
  },
  live: {
    base: '<rect x="2.5" y="5" width="19" height="14" rx="2.5"/>',
    accent: '<path d="M6 16.5h3"/>',
    dot: '<circle cx="12" cy="11" r="3.2"/>',
    tone: '<circle cx="12" cy="11" r="5.5"/>',
    hue: "danger", emoji: "🔴", use: "Запись идёт, LIVE",
  },
  spark: {
    base: '<path d="M11 4.5 13 10l5.5 2-5.5 2-2 5.5-2-5.5-5.5-2L9 10z"/>',
    accent: '<path d="M18.5 2.5v4"/><path d="M16.5 4.5h4"/>',
    tone: '<path d="M11 4.5 13 10l5.5 2-5.5 2-2 5.5-2-5.5-5.5-2L9 10z"/>',
    emoji: "✨", use: "Популярный тариф, новое",
  },
  chat: {
    base: '<path d="M20.5 15a2.5 2.5 0 0 1-2.5 2.5H8.5l-5 4V6A2.5 2.5 0 0 1 6 3.5h12A2.5 2.5 0 0 1 20.5 6z"/><path d="M8 13h5"/>',
    accent: '<path d="M8 9h8"/>',
    tone: '<path d="M20.5 15a2.5 2.5 0 0 1-2.5 2.5H8.5l-5 4V6A2.5 2.5 0 0 1 6 3.5h12A2.5 2.5 0 0 1 20.5 6z"/>',
    emoji: "💬", use: "Поддержка, ответ поддержки",
  },
  channel: {
    base: '<path d="M21 3.5 3 10.5l6.5 2.5 2.5 6.5 3.5-4.5 4.5 3.5z"/>',
    accent: '<path d="m9.5 13 11.5-9.5"/>',
    tone: '<path d="M21 3.5 3 10.5l6.5 2.5 2.5 6.5 3.5-4.5 4.5 3.5z"/>',
    emoji: "📢", use: "Канал, подписка",
  },
  home: {
    base: '<path d="M3.5 10.5 12 3.5l8.5 7V19a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/>',
    accent: '<path d="M9.5 21v-4.5a2.5 2.5 0 0 1 5 0V21"/>',
    tone: '<path d="M3.5 10.5 12 3.5l8.5 7V19a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/>',
    emoji: "🏠", use: "Меню",
  },
  doc: {
    base: '<path d="M14 2.5H7a2.5 2.5 0 0 0-2.5 2.5v14A2.5 2.5 0 0 0 7 21.5h10a2.5 2.5 0 0 0 2.5-2.5V8z"/><path d="M14 2.5V8h5.5"/><path d="M8.5 17h4"/>',
    accent: '<path d="M8.5 13h7"/>',
    tone: '<path d="M14 2.5H7a2.5 2.5 0 0 0-2.5 2.5v14A2.5 2.5 0 0 0 7 21.5h10a2.5 2.5 0 0 0 2.5-2.5V8z"/>',
    emoji: "📄", use: "Условия, оферта",
  },
  plus: {
    base: '<circle cx="12" cy="12" r="9"/>',
    accent: '<path d="M12 8v8"/><path d="M8 12h8"/>',
    tone: '<circle cx="12" cy="12" r="9"/>',
    emoji: "➕", use: "Доп. услуги, +10 ГБ",
  },
  minus: {
    base: '<circle cx="12" cy="12" r="9"/>',
    accent: '<path d="M8 12h8"/>',
    tone: '<circle cx="12" cy="12" r="9"/>',
    emoji: "➖", use: "Счётчики допов",
  },
  play: {
    base: '<circle cx="12" cy="12" r="9"/>',
    dot: '<path d="M10 8.3v7.4a.6.6 0 0 0 .9.5l5.6-3.7a.6.6 0 0 0 0-1l-5.6-3.7a.6.6 0 0 0-.9.5z"/>',
    tone: '<circle cx="12" cy="12" r="9"/>',
    emoji: "▶️", use: "Как начать запись",
  },
  back: {
    base: '<path d="M20 12H5"/>',
    accent: '<path d="M11 5.5 4.5 12l6.5 6.5"/>',
    emoji: "⬅️", use: "Назад (только в кнопках, adaptive)",
  },
  wait: {
    base: '<circle cx="12" cy="12" r="9"/>',
    accent: '<path d="M12 7.5V12l3 2"/>',
    tone: '<circle cx="12" cy="12" r="9"/>',
    emoji: "⏳", use: "Ждём Machine ID, ждём эфир, осталось N дней",
  },
  error: {
    base: '<path d="M10.3 4.3a2 2 0 0 1 3.4 0l7.5 12.9a2 2 0 0 1-1.7 3H4.5a2 2 0 0 1-1.7-3z"/>',
    accent: '<path d="M12 9.5v4"/>',
    dot: '<circle cx="12" cy="16.8" r="1.25"/>',
    tone: '<path d="M10.3 4.3a2 2 0 0 1 3.4 0l7.5 12.9a2 2 0 0 1-1.7 3H4.5a2 2 0 0 1-1.7-3z"/>',
    hue: "warning", emoji: "⚠️", use: "Ошибка, ID не подошёл, сервер не отвечает",
  },
  gift: {
    base: '<path d="M4 11.5h16V19a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z"/><rect x="2.5" y="7.5" width="19" height="4" rx="1.5"/><path d="M12 7.5V21"/>',
    accent: '<path d="M12 7.5C10.5 4 7 3.5 7 5.8c0 1.2 1.6 1.7 5 1.7"/><path d="M12 7.5c1.5-3.5 5-4 5-1.7 0 1.2-1.6 1.7-5 1.7"/>',
    tone: '<path d="M4 11.5h16V19a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z"/>',
    emoji: "🎁", use: "Free, бонус, рефералка",
  },
  calendar: {
    base: '<rect x="3" y="4.5" width="18" height="16.5" rx="2.5"/><path d="M3 9.5h18"/><path d="M8 2.5v4"/><path d="M16 2.5v4"/>',
    dot: '<rect x="7" y="13" width="3.5" height="3.5" rx="1"/>',
    tone: '<rect x="3" y="4.5" width="18" height="5"/>',
    emoji: "🗓", use: "Срок тарифа",
  },
  device: {
    base: '<rect x="2.5" y="3.5" width="19" height="13" rx="2.5"/><path d="M12 16.5v4"/><path d="M8.5 20.5h7"/>',
    accent: '<path d="M6.5 12.5h5"/>',
    tone: '<rect x="2.5" y="3.5" width="19" height="13" rx="2.5"/>',
    emoji: "💻", use: "Machine ID, устройство",
  },
  lock: {
    base: '<rect x="4.5" y="10.5" width="15" height="11" rx="2.5"/><path d="M8 10.5v-3a4 4 0 0 1 8 0v3"/>',
    accent: '<path d="M12 14.5V17"/>',
    tone: '<rect x="4.5" y="10.5" width="15" height="11" rx="2.5"/>',
    emoji: "🔒", use: "Одно устройство, лимит",
  },
  refresh: {
    base: '<path d="M20 12a8 8 0 0 1-14.2 5"/><path d="M4 12a8 8 0 0 1 14.2-5"/>',
    accent: '<path d="M18.5 2.5V7H14"/><path d="M5.5 21.5V17H10"/>',
    emoji: "🔄", use: "Проверить оплату, Я подписался",
  },
  user: {
    base: '<circle cx="12" cy="8.5" r="4.5"/><path d="M4 21a8 8 0 0 1 16 0"/>',
    tone: '<circle cx="12" cy="8.5" r="4.5"/>',
    accent: '<path d="M10 9.5a2.5 2.5 0 0 0 4 0"/>',
    emoji: "👤", use: "Стример (доп. канал), кабинет",
  },
  memory: {
    base: '<ellipse cx="12" cy="6" rx="8" ry="3"/><path d="M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6"/>',
    accent: '<path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/>',
    tone: '<ellipse cx="12" cy="6" rx="8" ry="3"/>',
    emoji: "💾", use: "Память, +10 ГБ",
  },
  mute: {
    base: '<path d="M11 4.5 6.5 8.5h-3v7h3l4.5 4z"/>',
    accent: '<path d="m15.5 9.5 5 5"/><path d="m20.5 9.5-5 5"/>',
    tone: '<path d="M11 4.5 6.5 8.5h-3v7h3l4.5 4z"/>',
    emoji: "🔇", use: "Мат заглушён (drip, советы)",
  },
  clip: {
    base: '<circle cx="6" cy="6.5" r="3"/><circle cx="6" cy="17.5" r="3"/>',
    accent: '<path d="M8.5 8.2 20 17"/><path d="M8.5 15.8 20 7"/>',
    tone: '<circle cx="6" cy="6.5" r="3"/><circle cx="6" cy="17.5" r="3"/>',
    emoji: "✂️", use: "Клип готов, нарезка",
  },
  trash: {
    base: '<path d="M5.5 7h13l-1 12.5a2 2 0 0 1-2 1.5h-7a2 2 0 0 1-2-1.5z"/><path d="M3.5 7h17"/><path d="M9 7V4.5h6V7"/>',
    accent: '<path d="M10 11v6"/><path d="M14 11v6"/>',
    tone: '<path d="M5.5 7h13l-1 12.5a2 2 0 0 1-2 1.5h-7a2 2 0 0 1-2-1.5z"/>',
    hue: "danger", emoji: "🗑", use: "Удалить площадку",
  },
};

/* ───────────── plan icons: three directions, power grows Free → Мини → Старт → Стример ───────────── */

export const PLAN_IDS = ["free", "mini", "start", "streamer"];
export const PLAN_LABEL = { free: "Free · 5 ГБ", mini: "Мини · 20 ГБ", start: "Старт · 50 ГБ", streamer: "Стример · 150 ГБ" };

/** A «Стек»: server units stack up; LEDs light per unit, the top unit of Стример carries two (two channels). */
function stack(level) {
  const units = [{ y: 16 }, { y: 9.5 }, { y: 3 }].slice(0, Math.max(1, level));
  const ghost = level === 0;
  const base = units.map((u) => `<rect x="3" y="${u.y}" width="18" height="5" rx="2"/>`).join("") + units.map((u) => `<path d="M12.5 ${u.y + 2.5}h5"/>`).join("");
  const leds = ghost ? "" : units.map((u, i) => (level === 3 && i === units.length - 1
    ? `<circle cx="6.5" cy="${u.y + 2.5}" r="1.3"/><circle cx="9.5" cy="${u.y + 2.5}" r="1.3"/>`
    : `<circle cx="6.5" cy="${u.y + 2.5}" r="1.3"/>`)).join("");
  const outline = ghost ? '<path d="M3 21v-2.5M21 21v-2.5M5.5 21h13" stroke-dasharray="0.01 3.2"/>' : "";
  return { base: base + outline, dot: leds, tone: units.map((u) => `<rect x="3" y="${u.y}" width="18" height="5" rx="2"/>`).join(""), ghostBase: ghost };
}

/** B «Ячейка»: one storage cell fills to its quota (5 / 20 / 50 / 150 ГБ on a 150 scale, floor for legibility). */
function cell(level) {
  const fill = [2, 4.5, 8, 14][level];
  const y = 19 - fill;
  return {
    base: `<rect x="3" y="3" width="18" height="18" rx="3.5"/>`,
    dot: `<rect x="5.5" y="${y.toFixed(1)}" width="13" height="${(fill - 0.5).toFixed(1)}" rx="1.5"/>`,
    tone: `<rect x="3" y="3" width="18" height="18" rx="3.5"/>`,
    accent: level === 3 ? '<path d="M8 8.5h8"/>' : "",
  };
}

/** C «Сборка F»: the Split F mark assembles module by module; Стример is the full mark. */
const F = {
  bar: '<rect x="3" y="3.5" width="18" height="4.5" rx="1.25"/>',
  stem: '<rect x="3" y="3.5" width="4.75" height="17" rx="1.25"/>',
  nub: '<rect x="7.75" y="11.6" width="3.75" height="4.5" rx="1.1"/>',
  dot: '<rect x="15.25" y="11.6" width="5.75" height="4.5" rx="1.25"/>',
};
function assemble(level) {
  const on = [[], ["dot"], ["stem", "nub", "dot"], ["bar", "stem", "nub", "dot"]][level];
  const off = Object.keys(F).filter((k) => !on.includes(k));
  return {
    ghostFill: off.map((k) => F[k]).join(""),
    dot: on.map((k) => F[k]).join(""),
    base: "",
  };
}

export const PLAN_DIRECTIONS = {
  A: { name: "Стек", idea: "Серверные юниты складываются в стойку: 0 → 1 → 2 → 3 юнита, у Стримера два индикатора — два канала", build: stack },
  B: { name: "Ячейка", idea: "Одна ячейка хранилища заполняется до квоты: 5 / 20 / 50 / 150 ГБ, полная — у Стримера", build: cell },
  C: { name: "Сборка F", idea: "Знак Split F собирается по модулям: квадрат → нога → весь знак; Стример = полный знак Fetchr", build: assemble },
};

/** Term icons: a ring that fills by the share of a year (1 / 3 / 6 / 12 months). */
export function termGlyph(months) {
  const share = months / 12;
  const r = 8.5;
  const len = 2 * Math.PI * r;
  return {
    ghost: `<circle cx="12" cy="12" r="${r}"/>`,
    accent: share >= 1
      ? `<circle cx="12" cy="12" r="${r}"/>`
      : `<circle cx="12" cy="12" r="${r}" stroke-dasharray="${(len * share).toFixed(2)} ${len.toFixed(2)}" transform="rotate(-90 12 12)"/>`,
    ...(share >= 1 ? { base: '<path d="m8.4 12.2 2.4 2.4 4.8-5"/>' } : { dot: `<circle cx="12" cy="12" r="${(1.2 + share * 3).toFixed(2)}"/>` }),
  };
}

/* ───────────── rendering ───────────── */

/** One glyph on the 24 grid. mono: one colour (needs_repainting set). */
export function glyphSvg(g, { mono = false, stroke = 2, color = INK.fg } = {}) {
  const fg = mono ? "#fff" : color;
  const hue = mono ? "#fff" : INK[g.hue || "accent"];
  const sw = `stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round"`;
  return [
    g.tone ? `<g fill="${hue}" fill-opacity="${mono ? 0.28 : 0.22}" stroke="none">${g.tone}</g>` : "",
    g.ghost ? `<g fill="none" stroke="${fg}" stroke-opacity="0.32" ${sw}>${g.ghost}</g>` : "",
    g.ghostFill ? `<g fill="${fg}" fill-opacity="0.2" stroke="none">${g.ghostFill}</g>` : "",
    g.base ? `<g fill="none" stroke="${fg}" ${sw}${g.ghostBase ? ' stroke-opacity="0.45"' : ""}>${g.base}</g>` : "",
    g.extra ? `<g fill="none" stroke="${fg}" ${sw}>${g.extra}</g>` : "",
    g.accent ? `<g fill="none" stroke="${hue}" ${sw}>${g.accent}</g>` : "",
    g.dot ? `<g fill="${hue}" stroke="none">${g.dot}</g>` : "",
  ].join("");
}

export const icon24 = (g, opts) => `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">${glyphSvg(g, opts)}</svg>`;

/** 100×100 custom emoji: elevated tile (surface ladder) + glyph. Reads on dark and light chats. */
export function tileSvg(g, { size = 100 } = {}) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 100 100">` +
    `<rect x="3" y="3" width="94" height="94" rx="24" fill="${INK.tile}" stroke="${INK.tileLine}" stroke-width="2"/>` +
    `<g transform="translate(14 14) scale(3)">${glyphSvg(g, { stroke: 2.25 })}</g></svg>`;
}

/** 100×100 adaptive emoji: bare white glyph, Telegram repaints it to the text/button colour. */
export function adaptiveSvg(g, { size = 100 } = {}) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 100 100"><g transform="translate(5 5) scale(3.75)">${glyphSvg(g, { mono: true, stroke: 2.25 })}</g></svg>`;
}

export function planGlyph(dir, plan) {
  return PLAN_DIRECTIONS[dir].build(PLAN_IDS.indexOf(plan));
}

/* ───────────── build ───────────── */

async function main() {
  const here = (p) => fileURLToPath(new URL(p, import.meta.url));
  for (const dir of ["./icons/", "./icons/emoji/", "./icons/adaptive/", "./icons/plans/"]) mkdirSync(here(dir), { recursive: true });
  let Resvg = null;
  try {
    ({ Resvg } = await import("@resvg/resvg-js"));
  } catch {
    Resvg = null;
  }
  const png = (path, svg) => {
    writeFileSync(here(path.replace(/\.png$/, ".svg")), svg, "utf8");
    if (Resvg) writeFileSync(here(path), new Resvg(svg, { fitTo: { mode: "width", value: 100 } }).render().asPng());
  };

  const out = { service: {}, plans: {}, terms: {}, directions: {} };
  for (const [name, g] of Object.entries(GLYPHS)) {
    writeFileSync(here(`./icons/${name}.svg`), icon24(g), "utf8");
    png(`./icons/emoji/${name}.png`, tileSvg(g));
    if (Resvg) writeFileSync(here(`./icons/adaptive/${name}.png`), new Resvg(adaptiveSvg(g), { fitTo: { mode: "width", value: 100 } }).render().asPng());
    out.service[name] = { glyph: glyphSvg(g), mono: glyphSvg(g, { mono: true }), tile: tileSvg(g), emoji: g.emoji, use: g.use };
  }
  for (const [dir, spec] of Object.entries(PLAN_DIRECTIONS)) {
    out.directions[dir] = { name: spec.name, idea: spec.idea };
    for (const plan of PLAN_IDS) {
      const g = planGlyph(dir, plan);
      writeFileSync(here(`./icons/plans/${dir}-${plan}-24.svg`), icon24(g), "utf8");
      png(`./icons/plans/${dir}-${plan}.png`, tileSvg(g));
      out.plans[`${dir}-${plan}`] = { glyph: glyphSvg(g), mono: glyphSvg(g, { mono: true }), tile: tileSvg(g) };
    }
  }
  for (const months of [1, 3, 6, 12]) {
    const g = termGlyph(months);
    png(`./icons/plans/term-${months}.png`, tileSvg(g));
    out.terms[months] = { glyph: glyphSvg(g), mono: glyphSvg(g, { mono: true }), tile: tileSvg(g) };
  }
  const pack = Object.entries(GLYPHS).map(([name, g]) => ({ file: `emoji/${name}.png`, adaptive: `adaptive/${name}.png`, emoji: g.emoji, use: g.use }));
  writeFileSync(here("./icons/pack.json"), `${JSON.stringify({ name: "Fetchr Line", tile: "emoji/*.png — обычный набор", adaptive: "adaptive/*.png — набор с needs_repainting", items: pack }, null, 2)}\n`, "utf8");
  writeFileSync(here("./icons.js"), `/* Generated by icons.mjs */\nwindow.FETCHR_ICONS = ${JSON.stringify(out)};\n`, "utf8");
  if (Resvg) await exportUploadPackage(Resvg);
}

/** The PNGs scripts/bot-emoji/upload-fetchr-line.mjs uploads (100×100, transparent
 *  around the tile): text/ — tiles, button/ — one-colour glyphs for the
 *  needs_repainting set. Names and order follow FETCHR_LINE in the bot. */
async function exportUploadPackage(Resvg) {
  const { FETCHR_LINE } = await import("../../scripts/lib/bot/premium-emoji.mjs");
  const root = fileURLToPath(new URL("../../scripts/assets/bot-emoji/fetchr-line/", import.meta.url));
  for (const dir of ["text", "button"]) mkdirSync(join(root, dir), { recursive: true });
  const toPng = (svg) => new Resvg(svg, { fitTo: { mode: "width", value: 100 } }).render().asPng();
  const items = FETCHR_LINE.map((sign) => {
    const glyph = sign.name.startsWith("plan-") ? planGlyph("B", sign.name.slice(5)) : GLYPHS[sign.name];
    if (!glyph) throw new Error(`no drawing for ${sign.name}`);
    writeFileSync(join(root, "text", `${sign.name}.png`), toPng(tileSvg(glyph)));
    writeFileSync(join(root, "button", `${sign.name}.png`), toPng(adaptiveSvg(glyph)));
    return { name: sign.name, emoji: sign.emoji, text: `text/${sign.name}.png`, button: `button/${sign.name}.png` };
  });
  writeFileSync(join(root, "manifest.json"), `${JSON.stringify(items, null, 2)}\n`, "utf8");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    process.stderr.write(`icons: ${err instanceof Error ? err.message : err}\n`);
    process.exitCode = 1;
  });
}
