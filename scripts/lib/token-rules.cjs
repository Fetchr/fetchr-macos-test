/* Правила валидатора токенов.
 *
 * Источники правды не дублируются: имена и значения токенов читаются из
 * fetchrTokens.css, канонические высоты контролов — из primitives.module.css,
 * карта замен — из token-map.json (её же читает кодмод tokenize-colors.py).
 */
const fs = require("node:fs");
const path = require("node:path");

const MAP = JSON.parse(fs.readFileSync(path.join(__dirname, "token-map.json"), "utf8"));

const THEME_DIR = "src/ui/redesign/theme";
const TOKENS_FILE = `${THEME_DIR}/fetchrTokens.css`;
const PRIMITIVES_FILE = `${THEME_DIR}/primitives.module.css`;

/* Роли, чьи высоты считаются канoническими. Не все height в primitives —
   роль: 56px кольца пустого состояния и 24px иконки размечают декор. */
const ROLE_SELECTORS = [
  "button",
  "buttonHero",
  "buttonSmall",
  "buttonIcon",
  "input",
  "tableHeader",
  "toolbar",
];

const COLOR_PROPS = new Set([
  "color",
  "background",
  "background-color",
  "background-image",
  "border",
  "border-color",
  "border-top",
  "border-right",
  "border-bottom",
  "border-left",
  "border-top-color",
  "border-right-color",
  "border-bottom-color",
  "border-left-color",
  "outline",
  "outline-color",
  "fill",
  "stroke",
  "box-shadow",
  "text-shadow",
  "caret-color",
  "accent-color",
  "text-decoration-color",
  "column-rule-color",
]);

const MOTION_PROPS = new Set([
  "transition",
  "transition-duration",
  "transition-timing-function",
  "animation",
  "animation-duration",
  "animation-timing-function",
]);

/* Префиксы Tailwind-утилит, у которых произвольное значение в скобках —
   обход конфига. Список закрытый: иначе под шаблон попадает любой
   индекс массива и дженерик в TS. */
const TW_PREFIXES =
  "bg|text|border|ring|shadow|fill|stroke|from|via|to|h|w|size|min-h|min-w|max-h|max-w|p|px|py|pt|pr|pb|pl|m|mx|my|mt|mr|mb|ml|gap|gap-x|gap-y|rounded|top|right|bottom|left|inset|z|leading|tracking|translate-x|translate-y|grid-cols|grid-rows|basis";

// ── Разбор источников правды ────────────────────────────────────────────

function stripComments(text) {
  // Содержимое комментариев затирается пробелами, переводы строк сохраняются —
  // иначе номера строк в отчёте разъедутся с файлом.
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p) => p + " ".repeat(m.length - p.length));
}

function loadTokens(root) {
  const text = stripComments(fs.readFileSync(path.join(root, TOKENS_FILE), "utf8"));
  const values = new Map();
  for (const m of text.matchAll(/(--fetchr-[a-z0-9-]+)\s*:\s*([^;]+);/gi)) {
    values.set(m[1], m[2].trim());
  }
  const hexIndex = new Map();
  for (const [name, raw] of values) {
    const hex = normalizeColor(raw);
    if (/^#[0-9a-f]{6}$/.test(hex) && !hexIndex.has(hex)) hexIndex.set(hex, name);
  }
  const radii = new Set();
  for (const [name, raw] of values) {
    if (!name.startsWith("--fetchr-radius-")) continue;
    const px = parseFloat(raw);
    if (!Number.isNaN(px)) radii.add(px);
  }
  return { names: new Set(values.keys()), values, hexIndex, radii };
}

function loadRoleHeights(root) {
  const text = stripComments(fs.readFileSync(path.join(root, PRIMITIVES_FILE), "utf8"));
  const heights = new Set();
  for (const { selector, body } of eachBlock(text)) {
    const cls = selector.trim().replace(/^\./, "");
    if (!ROLE_SELECTORS.includes(cls)) continue;
    for (const m of body.matchAll(/(?:^|[;{\s])(?:min-)?height\s*:\s*([\d.]+)px/g)) {
      heights.add(parseFloat(m[1]));
    }
  }
  return heights;
}

function resolve(name, values, depth = 0) {
  const raw = values.get(name);
  if (raw === undefined || depth > 8) return raw ?? "";
  const alias = raw.match(/^var\(\s*(--fetchr-[a-z0-9-]+)\s*\)$/i);
  return alias ? resolve(alias[1], values, depth + 1) : raw;
}

function normalizeColor(value) {
  const v = value.trim().toLowerCase().replace(/\s+/g, " ");
  const short = v.match(/^#([0-9a-f])([0-9a-f])([0-9a-f])$/);
  if (short) return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`;
  return v;
}

// ── Разбор CSS ──────────────────────────────────────────────────────────

/** Объявления `свойство: значение` вместе со смещением в исходнике. */
function* eachDeclaration(text) {
  for (const m of text.matchAll(/(^|[;{}])([\s]*)(-{0,2}[a-z][a-z0-9-]*)\s*:\s*([^;{}]*)/gi)) {
    yield {
      prop: m[3].toLowerCase(),
      value: m[4],
      index: m.index + m[1].length + m[2].length,
      valueIndex: m.index + m[0].length - m[4].length,
    };
  }
}

/** Блоки правил на любой глубине: селектор + тело. */
function* eachBlock(text) {
  const stack = [];
  let prev = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "{") {
      stack.push({ selector: text.slice(prev, i), bodyStart: i + 1 });
      prev = i + 1;
    } else if (text[i] === "}") {
      const open = stack.pop();
      if (open) yield { selector: open.selector, body: text.slice(open.bodyStart, i), start: open.bodyStart };
      prev = i + 1;
    }
  }
}

/** var(...) с балансировкой скобок: фолбэк сам бывает функцией. */
function* eachVarCall(text) {
  for (const m of text.matchAll(/var\(/g)) {
    let depth = 1;
    let i = m.index + 4;
    for (; i < text.length && depth > 0; i++) {
      if (text[i] === "(") depth++;
      else if (text[i] === ")") depth--;
    }
    const inner = text.slice(m.index + 4, i - 1);
    const comma = topLevelComma(inner);
    yield {
      index: m.index,
      name: (comma < 0 ? inner : inner.slice(0, comma)).trim(),
      fallback: comma < 0 ? null : inner.slice(comma + 1).trim(),
      raw: text.slice(m.index, i),
    };
  }
}

function topLevelComma(s) {
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "(") depth++;
    else if (s[i] === ")") depth--;
    else if (s[i] === "," && depth === 0) return i;
  }
  return -1;
}

module.exports = {
  MAP,
  COLOR_PROPS,
  MOTION_PROPS,
  TW_PREFIXES,
  TOKENS_FILE,
  PRIMITIVES_FILE,
  stripComments,
  loadTokens,
  loadRoleHeights,
  resolve,
  normalizeColor,
  eachDeclaration,
  eachBlock,
  eachVarCall,
};
