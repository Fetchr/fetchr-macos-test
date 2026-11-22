/**
 * Параллельный рендер: ролик режется на отрезки по кадрам, каждый отрезок
 * снимает свой экземпляр Edge, потом отрезки склеиваются без перекодирования.
 *
 *   node promo/scripts/render-parallel.mjs --out promo/out/master.mkv [--workers 4] [--fps 60] [--scale 2]
 */
import { spawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { launchBrowser, waitFor } from "./cdp.mjs";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, value, index, list) => {
    if (value.startsWith("--")) pairs.push([value.slice(2), list[index + 1]]);
    return pairs;
  }, []),
);
const out = path.resolve(args.out ?? "promo/out/master.mkv");
const url = args.url ?? "http://127.0.0.1:5188/";
const workers = Number(args.workers ?? 4);
const fps = Number(args.fps ?? 60);
const scale = args.scale ?? "2";
const format = args.format ?? "jpeg";
const ffmpeg = path.resolve(args.ffmpeg ?? "ffmpeg.exe");
const partsDir = `${out}.parts`;
rmSync(partsDir, { recursive: true, force: true });
mkdirSync(partsDir, { recursive: true });

// Длительность спрашиваем у самой страницы, чтобы не держать её в двух местах
const probe = await launchBrowser({ width: 1920, height: 1080, scale: 1, port: 9340 });
await probe.navigate(url);
await waitFor(probe.evaluate, "window.__promo?.ready === true", 30000);
const duration = await probe.evaluate("window.__promo.duration");
await probe.close();

const totalFrames = Math.round(duration * fps);
const perWorker = Math.ceil(totalFrames / workers);
const started = Date.now();

const jobs = Array.from({ length: workers }, (_, index) => {
  const fromFrame = index * perWorker;
  const toFrame = Math.min(totalFrames, fromFrame + perWorker);
  const file = path.join(partsDir, `part-${String(index).padStart(2, "0")}.mkv`);
  return { index, fromFrame, toFrame, file };
}).filter((job) => job.toFrame > job.fromFrame);

await Promise.all(
  jobs.map(
    (job) =>
      new Promise((resolve, reject) => {
        const child = spawn(
          process.execPath,
          [
            path.resolve("promo/scripts/render.mjs"),
            "--url", url,
            "--out", job.file,
            "--fps", String(fps),
            "--scale", String(scale),
            "--format", format,
            "--from", String(job.fromFrame / fps),
            "--to", String(job.toFrame / fps),
            "--port", String(9341 + job.index),
          ],
          { stdio: ["ignore", "pipe", "inherit"] },
        );
        child.stdout.on("data", (chunk) => {
          for (const line of chunk.toString().split("\n")) {
            if (line.trim()) console.log(`[${job.index}] ${line.trim()}`);
          }
        });
        child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`worker ${job.index} exited with ${code}`))));
      }),
  ),
);

const list = path.join(partsDir, "list.txt");
writeFileSync(list, jobs.map((job) => `file '${job.file.split(path.sep).join("/")}'`).join("\n"));
await new Promise((resolve, reject) => {
  const concat = spawn(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", out], {
    stdio: "inherit",
  });
  concat.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`concat exited with ${code}`))));
});
// Куски может ещё держать антивирус или только что закрытый ffmpeg: мастер
// уже склеен, поэтому неудачная уборка — предупреждение, а не провал рендера.
try {
  rmSync(partsDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 400 });
} catch (error) {
  console.warn(`could not remove ${partsDir}: ${error.message}`);
}
console.log(`master: ${out} · ${totalFrames} frames · ${((Date.now() - started) / 60000).toFixed(1)} min`);
