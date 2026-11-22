/* Семь правил валидатора. Каждое получает разобранный файл и возвращает
 * нарушения вида { rule, line, snippet, suggestion }. */
const {
  MAP,
  COLOR_PROPS,
  MOTION_PROPS,
  TW_PREFIXES,
  resolve,
  normalizeColor,
  eachDeclaration,
  eachBlock,
  eachVarCall,
} = require("./token-rules.cjs");

const HEX = /#[0-9a-fA-F]{3,8}\b/g;
const LITERAL_FN = /\b(?:rgba?|hsla?)\(\s*[\d.]/g;
const RAW_EASE = /\bcubic-bezier\(|(?<![-\w])(?:ease-in-out|ease-in|ease-out|ease|linear)(?![-\w])/g;
const RAW_TIME = /(?<![\w.-])\d*\.?\d+m?s\b/g;

const lineAt = (text, index) => text.slice(0, index).split("\n").length;
const squash = (s) => s.trim().replace(/\s+/g, " ").slice(0, 120);

function suggestColor(literal, tokens) {
  const norm = normalizeColor(literal);
  if (tokens.hexIndex.has(norm)) return `var(${tokens.hexIndex.get(norm)})`;
  const pair = MAP.color.find(([from]) => normalizeColor(from) === norm);
  return pair ? pair[1] : null;
}

function suggestMotion(literal) {
  const ease = MAP.ease.find(([from]) => from === literal);
  if (ease) return ease[1];
  return MAP.duration[literal] ?? null;
}

/** var(--fetchr-…) на имя, которого нет в fetchrTokens.css. */
function unknownToken(file, tokens) {
  const out = [];
  for (const call of eachVarCall(file.clean)) {
    if (!call.name.startsWith("--fetchr-")) continue;
    if (tokens.names.has(call.name)) continue;
    out.push({
      rule: "unknown-token",
      line: lineAt(file.clean, call.index),
      snippet: squash(call.raw),
      suggestion: null,
    });
  }
  return out;
}

/** var(--x, <литерал>), где литерал разошёлся со значением токена.
 *  Фолбэк-переменная — легитимный алиасный паттерн, не нарушение. */
function badFallback(file, tokens) {
  const out = [];
  for (const call of eachVarCall(file.clean)) {
    if (!call.name.startsWith("--fetchr-")) continue;
    if (!call.fallback || !tokens.names.has(call.name)) continue;
    if (/^var\(/i.test(call.fallback)) continue;
    const actual = normalizeColor(resolve(call.name, tokens.values));
    if (normalizeColor(call.fallback) === actual) continue;
    out.push({
      rule: "bad-fallback",
      line: lineAt(file.clean, call.index),
      snippet: squash(call.raw),
      suggestion: `var(${call.name}) — токен равен ${actual}`,
    });
  }
  return out;
}

/** Хардкод-цвет в цветовом свойстве. */
function colorLiteral(file, tokens) {
  const out = [];
  for (const decl of eachDeclaration(file.clean)) {
    if (!COLOR_PROPS.has(decl.prop)) continue;
    for (const re of [HEX, LITERAL_FN]) {
      re.lastIndex = 0;
      for (const m of decl.value.matchAll(re)) {
        const literal = re === HEX ? m[0] : decl.value.slice(m.index).match(/^[a-z]+\([^)]*\)/i)?.[0] ?? m[0];
        out.push({
          rule: "color-literal",
          line: lineAt(file.clean, decl.valueIndex + m.index),
          snippet: squash(`${decl.prop}: ${decl.value}`),
          suggestion: suggestColor(literal, tokens),
        });
      }
    }
  }
  return out;
}

/** Сырая кривая или длительность мимо моушн-токенов. */
function rawMotion(file) {
  const out = [];
  for (const decl of eachDeclaration(file.clean)) {
    if (!MOTION_PROPS.has(decl.prop)) continue;
    for (const re of [RAW_EASE, RAW_TIME]) {
      re.lastIndex = 0;
      for (const m of decl.value.matchAll(re)) {
        const literal =
          re === RAW_EASE && m[0] === "cubic-bezier("
            ? decl.value.slice(m.index).match(/^cubic-bezier\([^)]*\)/)?.[0] ?? m[0]
            : m[0];
        out.push({
          rule: "raw-motion",
          line: lineAt(file.clean, decl.valueIndex + m.index),
          snippet: squash(`${decl.prop}: ${decl.value}`),
          suggestion: suggestMotion(literal),
        });
      }
    }
  }
  return out;
}

/** Высота роли или радиус вне шкалы в правиле, которое не композит примитив. */
function roleValue(file, tokens, roleHeights) {
  const out = [];
  for (const block of eachBlock(file.clean)) {
    if (/composes\s*:[^;]*primitives\.module\.css/.test(block.body)) continue;
    for (const m of block.body.matchAll(/(?:^|[;{\s])((?:min-)?height)\s*:\s*([\d.]+)px/g)) {
      if (!roleHeights.has(parseFloat(m[2]))) continue;
      out.push({
        rule: "role-value",
        line: lineAt(file.clean, block.start + m.index),
        snippet: `${squash(block.selector)} { ${m[1]}: ${m[2]}px }`,
        suggestion: "composes: … from primitives.module.css",
      });
    }
    for (const m of block.body.matchAll(/(?:^|[;{\s])border-radius\s*:\s*([\d.]+)px/g)) {
      const px = parseFloat(m[1]);
      // 1–2px — скругление волосяных маркеров и полос прогресса высотой
      // в те же 2px. Наименьший радиус шкалы (4px) там бессмыслен.
      if (px < 4 || tokens.radii.has(px)) continue;
      out.push({
        rule: "role-value",
        line: lineAt(file.clean, block.start + m.index),
        snippet: `${squash(block.selector)} { border-radius: ${px}px }`,
        suggestion: `шкала ${[...tokens.radii].sort((a, b) => a - b).join(" · ")}`,
      });
    }
  }
  return out;
}

const INLINE_PROP =
  /\b(color|background|backgroundColor|backgroundImage|border|borderColor|borderTop|borderBottom|borderLeft|borderRight|outline|outlineColor|fill|stroke|boxShadow|textShadow)\s*:\s*(["'`])([^"'`\n]*(?:#[0-9a-fA-F]{3,8}|rgba?\(\s*[\d.])[^"'`\n]*)\2/g;

/** Хардкод-цвет в инлайн-стиле React. */
function inlineColor(file, tokens) {
  const out = [];
  for (const m of file.clean.matchAll(INLINE_PROP)) {
    const hex = m[3].match(/#[0-9a-fA-F]{3,8}\b/)?.[0];
    out.push({
      rule: "inline-color",
      line: lineAt(file.clean, m.index),
      snippet: squash(`${m[1]}: ${m[3]}`),
      suggestion: hex ? suggestColor(hex, tokens) : null,
    });
  }
  return out;
}

/** Произвольное значение Tailwind мимо конфига: bg-[#1a1a1a], h-[34px]. */
function twArbitrary(file) {
  const out = [];
  const re = new RegExp(`(?<![\\w-])(?:${TW_PREFIXES})-\\[[^\\]\\s]+\\]`, "g");
  for (const m of file.clean.matchAll(re)) {
    out.push({
      rule: "tw-arbitrary",
      line: lineAt(file.clean, m.index),
      snippet: m[0],
      suggestion: null,
    });
  }
  return out;
}

const CSS_RULES = { "unknown-token": unknownToken, "bad-fallback": badFallback, "color-literal": colorLiteral, "raw-motion": rawMotion, "role-value": roleValue };
const TSX_RULES = { "unknown-token": unknownToken, "inline-color": inlineColor, "tw-arbitrary": twArbitrary };

const ALL_RULES = [...new Set([...Object.keys(CSS_RULES), ...Object.keys(TSX_RULES)])];

function runFile(file, ctx) {
  const table = file.path.endsWith(".css") ? CSS_RULES : TSX_RULES;
  const out = [];
  for (const [id, fn] of Object.entries(table)) {
    if (ctx.only && ctx.only !== id) continue;
    out.push(...fn(file, ctx.tokens, ctx.roleHeights));
  }
  return out.sort((a, b) => a.line - b.line);
}

module.exports = { runFile, ALL_RULES };
