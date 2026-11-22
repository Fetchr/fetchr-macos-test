/**
 * Стоп-кадры ролика для проверки композиции: node promo/scripts/stills.mjs <out-dir> <t1> <t2> ...
 * Сервер промо должен быть запущен (npx vite --config promo/vite.config.ts).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { launchBrowser, waitFor } from "./cdp.mjs";

const [outDir, ...times] = process.argv.slice(2);
if (!outDir || times.length === 0) {
  console.error("usage: node promo/scripts/stills.mjs <out-dir> <t1> [t2 ...]");
  process.exit(2);
}
mkdirSync(outDir, { recursive: true });

const scale = Number(process.env.PROMO_SCALE ?? 1);
const url = process.env.PROMO_URL ?? "http://127.0.0.1:5188/";
const browser = await launchBrowser({ width: 1920, height: 1080, scale, port: 9335 });
const problems = [];
browser.on("Runtime.exceptionThrown", (p) => problems.push(p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text));
browser.on("Runtime.consoleAPICalled", (p) => {
  if (p.type === "error" || p.type === "warning") problems.push(p.args.map((a) => a.value ?? a.description).join(" ").slice(0, 400));
});

try {
  await browser.navigate(url);
  await waitFor(browser.evaluate, "window.__promo?.ready === true", 30000);
  const duration = await browser.evaluate("window.__promo.duration");
  console.log(`duration ${duration.toFixed(2)} s`);
  for (const raw of times) {
    const t = Number(raw);
    await browser.evaluate(`(async () => { window.__promo.seek(${t}); await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))); })()`);
    const file = path.join(outDir, `t${t.toFixed(2).padStart(6, "0")}.png`);
    writeFileSync(file, await browser.screenshot());
    console.log("still", file);
  }
} finally {
  if (problems.length) console.log("page problems:\n" + problems.slice(0, 10).join("\n---\n"));
  await browser.close();
}
