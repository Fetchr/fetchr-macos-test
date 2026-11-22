/**
 * Покадровый рендер ролика в видео.
 *
 *   node promo/scripts/render.mjs --out promo/out/master.mkv [--fps 60] [--scale 2] [--from 0] [--to 65.4]
 *
 * Кадры снимаются headless Edge в scale-кратном разрешении и уходят в ffmpeg
 * по трубе; ffmpeg ужимает их до 1080p (суперсэмплинг вместо сглаживания
 * браузера) и пишет мастер 4:4:4 в BT.709. Веб-версии кодируются из мастера
 * отдельно — encode.mjs.
 */
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";

import { launchBrowser, waitFor } from "./cdp.mjs";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, value, index, list) => {
    if (value.startsWith("--")) pairs.push([value.slice(2), list[index + 1]]);
    return pairs;
  }, []),
);

const out = path.resolve(args.out ?? "promo/out/master.mkv");
const fps = Number(args.fps ?? 60);
const scale = Number(args.scale ?? 2);
const url = args.url ?? "http://127.0.0.1:5188/";
const ffmpeg = args.ffmpeg ?? path.resolve("ffmpeg.exe");
/** jpeg заметно быстрее png на 4K; после ужатия вдвое его артефактов не видно */
const format = args.format ?? "jpeg";
const quality = Number(args.quality ?? 95);
const port = Number(args.port ?? 9336);
mkdirSync(path.dirname(out), { recursive: true });

const browser = await launchBrowser({ width: 1920, height: 1080, scale, port });
const problems = [];
browser.on("Runtime.exceptionThrown", (p) => problems.push(p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text));

await browser.navigate(url);
await waitFor(browser.evaluate, "window.__promo?.ready === true", 30000);
const duration = await browser.evaluate("window.__promo.duration");
const from = Number(args.from ?? 0);
const to = Math.min(Number(args.to ?? duration), duration);
const first = Math.round(from * fps);
const last = Math.round(to * fps);

const encoder = spawn(
  ffmpeg,
  [
    "-hide_banner",
    "-loglevel", "error",
    "-y",
    // Входные кадры декодируются в 2 потока, x264 — в 4 и с коротким
    // lookahead: иначе шесть параллельных кодеров съедают всю память.
    "-threads", "2",
    "-f", "image2pipe",
    "-framerate", String(fps),
    "-c:v", format === "jpeg" ? "mjpeg" : "png",
    "-i", "-",
    "-vf",
    "scale=1920:1080:flags=lanczos+accurate_rnd+full_chroma_int:out_color_matrix=bt709:out_range=tv,format=yuv444p",
    "-filter_threads", "2",
    "-c:v", "libx264",
    "-preset", "fast",
    "-crf", "8",
    "-threads", "4",
    "-x264-params", "rc-lookahead=12",
    "-pix_fmt", "yuv444p",
    "-colorspace", "bt709",
    "-color_primaries", "bt709",
    "-color_trc", "bt709",
    "-color_range", "tv",
    out,
  ],
  { stdio: ["pipe", "inherit", "inherit"] },
);
const encoderDone = new Promise((resolve, reject) => {
  encoder.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited with ${code}`))));
});

const write = (buffer) =>
  new Promise((resolve) => {
    if (encoder.stdin.write(buffer)) resolve();
    else encoder.stdin.once("drain", resolve);
  });

const started = Date.now();
try {
  for (let frame = first; frame < last; frame += 1) {
    const time = frame / fps;
    await browser.evaluate(
      `(async () => { window.__promo.seek(${time}); await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))); })()`,
    );
    const { data } = await browser.send(
      "Page.captureScreenshot",
      format === "jpeg" ? { format: "jpeg", quality, optimizeForSpeed: true } : { format: "png", optimizeForSpeed: true },
    );
    await write(Buffer.from(data, "base64"));
    const done = frame - first + 1;
    if (done % fps === 0 || frame === last - 1) {
      const elapsed = (Date.now() - started) / 1000;
      const eta = (elapsed / done) * (last - first - done);
      console.log(`frame ${done}/${last - first} · ${time.toFixed(2)} s · ${(done / elapsed).toFixed(1)} fps · eta ${eta.toFixed(0)} s`);
    }
  }
} finally {
  encoder.stdin.end();
  await browser.close();
}
await encoderDone;
if (problems.length) console.log("page problems:\n" + problems.slice(0, 10).join("\n---\n"));
console.log(`master: ${out}`);
