#!/usr/bin/env node
/* Валидатор дизайн-токенов Fetchr.
 *
 *   node scripts/validate-tokens.cjs --dir src/
 *
 * Гейт с baseline: exit 1 только на нарушения, которых нет в
 * scripts/token-baseline.json. Старый долг зафиксирован и не мешает работать,
 * но и не растёт незаметно.
 */
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const { stripComments, loadTokens, loadRoleHeights, TOKENS_FILE, PRIMITIVES_FILE } = require("./lib/token-rules.cjs");
const { runFile, ALL_RULES } = require("./lib/token-checks.cjs");

const ROOT = path.resolve(__dirname, "..");
const BASELINE = path.join(__dirname, "token-baseline.json");

/* Вендорный video-js не наш и чинить его нельзя; файлы темы — место
   объявления значений, а не потребления. ChatPreviewPlacement держит
   мок-ленту чата: цвета там — ники зрителей Twitch/Kick, пользовательские
   данные, а не хром приложения, и токенам не подчиняются. */
const SKIP = [
  /(^|\/)src\/lib\//,
  /(^|\/)node_modules\//,
  /(^|\/)dist\//,
  /chat-render\/ChatPreviewPlacement\.tsx$/,
  new RegExp(`${TOKENS_FILE}$`),
  new RegExp(`${PRIMITIVES_FILE}$`),
];

function parseArgs(argv) {
  const args = { dir: "src", update: false, json: false, only: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--dir") args.dir = argv[++i];
    else if (argv[i] === "--rule") args.only = argv[++i];
    else if (argv[i] === "--update-baseline") args.update = true;
    else if (argv[i] === "--json") args.json = true;
    else if (argv[i] === "--help" || argv[i] === "-h") args.help = true;
  }
  return args;
}

function walk(dir, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, acc);
    else if (/\.(css|tsx)$/.test(entry.name)) acc.push(full);
  }
  return acc;
}

const rel = (full) => path.relative(ROOT, full).split(path.sep).join("/");

const fingerprint = (relPath, v) =>
  crypto.createHash("sha1").update(`${relPath}|${v.rule}|${v.snippet}`).digest("hex").slice(0, 16);

function loadBaseline() {
  if (!fs.existsSync(BASELINE)) return {};
  try {
    return JSON.parse(fs.readFileSync(BASELINE, "utf8"));
  } catch (error) {
    console.error(`Cause: ${BASELINE} не читается как JSON — ${error.message}`);
    console.error("Fix: удалить файл и пересоздать через --update-baseline");
    process.exit(2);
  }
}

function collect(args) {
  const tokens = loadTokens(ROOT);
  const roleHeights = loadRoleHeights(ROOT);
  const target = path.resolve(ROOT, args.dir);
  if (!fs.existsSync(target)) {
    console.error(`Cause: каталог ${args.dir} не найден`);
    console.error("Fix: передать существующий путь в --dir");
    process.exit(2);
  }

  const found = [];
  for (const full of walk(target)) {
    const relPath = rel(full);
    if (SKIP.some((re) => re.test(relPath))) continue;
    const raw = fs.readFileSync(full, "utf8");
    const file = { path: relPath, clean: stripComments(raw) };
    for (const v of runFile(file, { tokens, roleHeights, only: args.only })) {
      found.push({ ...v, file: relPath, id: fingerprint(relPath, v) });
    }
  }
  return found;
}

function toCounts(violations) {
  const counts = {};
  for (const v of violations) {
    (counts[v.rule] ??= {});
    counts[v.rule][v.id] = (counts[v.rule][v.id] ?? 0) + 1;
  }
  return counts;
}

function diff(violations, baseline) {
  const seen = {};
  const fresh = [];
  for (const v of violations) {
    const allowed = baseline[v.rule]?.[v.id] ?? 0;
    const used = (seen[v.rule] ??= {});
    used[v.id] = (used[v.id] ?? 0) + 1;
    if (used[v.id] > allowed) fresh.push(v);
  }
  let fixed = 0;
  for (const [rule, ids] of Object.entries(baseline)) {
    for (const [id, count] of Object.entries(ids)) {
      fixed += Math.max(0, count - (seen[rule]?.[id] ?? 0));
    }
  }
  return { fresh, fixed };
}

function report(fresh, total, fixed, debt) {
  const byFile = new Map();
  for (const v of fresh) {
    if (!byFile.has(v.file)) byFile.set(v.file, []);
    byFile.get(v.file).push(v);
  }
  for (const [file, items] of byFile) {
    console.log(`\n${file}`);
    for (const v of items) {
      const tail = v.suggestion ? `  → ${v.suggestion}` : "";
      console.log(`  ${String(v.line).padStart(5)}  ${v.rule.padEnd(14)} ${v.snippet}${tail}`);
    }
  }
  console.log("");
  if (fresh.length) console.log(`Новый дрейф: ${fresh.length} в ${byFile.size} файлах.`);
  if (fixed) console.log(`Починено с прошлого среза: ${fixed}. Зафиксировать: --update-baseline`);
  console.log(`Долг в baseline: ${debt} из ${total} найденных нарушений.`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(`node scripts/validate-tokens.cjs [--dir src/] [--rule <id>] [--update-baseline] [--json]\n\nПравила: ${ALL_RULES.join(", ")}`);
    return 0;
  }
  if (args.only && !ALL_RULES.includes(args.only)) {
    console.error(`Cause: правила ${args.only} нет`);
    console.error(`Fix: одно из ${ALL_RULES.join(", ")}`);
    return 2;
  }

  const violations = collect(args);

  if (args.update) {
    fs.writeFileSync(BASELINE, `${JSON.stringify(toCounts(violations), null, 2)}\n`, "utf8");
    console.log(`Срез записан: ${violations.length} нарушений → ${rel(BASELINE)}`);
    return 0;
  }

  const baseline = loadBaseline();
  const { fresh, fixed } = diff(violations, baseline);
  const debt = violations.length - fresh.length;

  if (args.json) {
    console.log(JSON.stringify({ fresh, fixed, debt, total: violations.length }, null, 2));
    return fresh.length ? 1 : 0;
  }

  report(fresh, violations.length, fixed, debt);
  return fresh.length ? 1 : 0;
}

process.exit(main());
