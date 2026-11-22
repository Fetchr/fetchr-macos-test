/**
 * Выгружает звуковые события таймлайна в JSON для генератора саундтрека.
 *
 *   node promo/scripts/cues.mjs [--out promo/out/cues.json]
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { launchBrowser, waitFor } from "./cdp.mjs";

const outIndex = process.argv.indexOf("--out");
const out = path.resolve(outIndex > 0 ? process.argv[outIndex + 1] : "promo/out/cues.json");
mkdirSync(path.dirname(out), { recursive: true });

const browser = await launchBrowser({ width: 1920, height: 1080, scale: 1, port: 9360 });
try {
  await browser.navigate(process.env.PROMO_URL ?? "http://127.0.0.1:5188/");
  await waitFor(browser.evaluate, "window.__promo?.ready === true", 30000);
  const data = await browser.evaluate("({ duration: window.__promo.duration, cues: window.__promo.cues })");
  writeFileSync(out, JSON.stringify(data, null, 1));
  const kinds = {};
  for (const item of data.cues) kinds[item.kind] = (kinds[item.kind] ?? 0) + 1;
  console.log(`cues: ${data.cues.length} · duration ${data.duration} s → ${out}`);
  console.log(Object.entries(kinds).map(([k, v]) => `${k}:${v}`).join(" "));
} finally {
  await browser.close();
}
