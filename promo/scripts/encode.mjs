/**
 * Веб-версии ролика из мастера render-parallel.mjs.
 *
 *   node promo/scripts/encode.mjs [--in promo/out/master.mkv] [--poster 10.4]
 *
 * MP4/H.264 — для всех браузеров, WebM/VP9 — легче при том же качестве;
 * постер — кадр, который сайт покажет до старта видео.
 */
import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import path from "node:path";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, value, index, list) => {
    if (value.startsWith("--")) pairs.push([value.slice(2), list[index + 1]]);
    return pairs;
  }, []),
);
const input = path.resolve(args.in ?? "promo/out/master.mkv");
const dir = path.dirname(input);
const ffmpeg = path.resolve(args.ffmpeg ?? "ffmpeg.exe");
const posterAt = Number(args.poster ?? 10.4);
// Саундтрек из soundtrack.py; без него ролик кодируется немым
const audio = args.audio ? path.resolve(args.audio) : null;
const audioIn = audio ? ["-i", audio] : [];
const maps = audio ? ["-map", "0:v:0", "-map", "1:a:0", "-shortest"] : ["-an"];

// Мастер уже в BT.709 limited: только сжимаем цветность до 4:2:0 и помечаем поток
const color = ["-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-color_range", "tv"];

const probeSeconds = (file) =>
  new Promise((resolve, reject) => {
    const probe = spawn(path.join(path.dirname(ffmpeg), "ffprobe.exe"), [
      "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file,
    ]);
    let text = "";
    probe.stdout.on("data", (chunk) => (text += chunk));
    probe.on("exit", (code) => (code === 0 ? resolve(Number(text.trim())) : reject(new Error(`ffprobe exited with ${code}`))));
  });

const totalSeconds = await probeSeconds(input);

/** Прогресс ffmpeg каждые 10%: -progress пишет out_time_us в stdout */
const run = (label, list) =>
  new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-progress", "pipe:1", "-nostats", ...list], {
      stdio: ["ignore", "pipe", "inherit"],
    });
    let shown = 0;
    let pending = "";
    child.stdout.on("data", (chunk) => {
      pending += chunk;
      const lines = pending.split("\n");
      pending = lines.pop();
      for (const line of lines) {
        const match = line.match(/^out_time_us=(\d+)/);
        if (!match) continue;
        const percent = Math.min(100, Math.floor((Number(match[1]) / 1e6 / totalSeconds) * 100));
        if (percent >= shown + 10) {
          shown = percent - (percent % 10);
          const elapsed = (Date.now() - started) / 1000;
          const eta = percent > 0 ? (elapsed * (100 - percent)) / percent : 0;
          console.log(`${label}: ${shown}% · ${elapsed.toFixed(0)} s · eta ${eta.toFixed(0)} s`);
        }
      }
    });
    child.on("exit", (code) => {
      if (code !== 0) return reject(new Error(`${label}: ffmpeg exited with ${code}`));
      const file = list[list.length - 1];
      const size = (statSync(file).size / 1024 / 1024).toFixed(1);
      console.log(`${label}: ${file} · ${size} MB · ${((Date.now() - started) / 1000).toFixed(0)} s`);
      resolve();
    });
  });

// gradfun подмешивает дизеринг в плавные градиенты: тёмные свечения
// иначе расходятся на кольца после сжатия
const debandedYuv420 = "gradfun=strength=1.2:radius=16,format=yuv420p";

await run("mp4", [
  "-i", input,
  ...audioIn,
  "-vf", debandedYuv420,
  "-c:v", "libx264",
  "-preset", "slow",
  "-crf", "20",
  "-profile:v", "high",
  "-level", "4.2",
  // aq-mode 3 отдаёт биты тёмным плоским участкам — меньше полос на свечениях
  "-x264-params", "aq-mode=3:aq-strength=0.9",
  "-g", "120",
  "-movflags", "+faststart",
  ...maps,
  ...(audio ? ["-c:a", "aac", "-b:a", "192k"] : []),
  ...color,
  path.join(dir, "fetchr-promo.mp4"),
]);

await run("webm", [
  "-i", input,
  ...audioIn,
  "-vf", debandedYuv420,
  "-c:v", "libvpx-vp9",
  "-crf", "30",
  "-b:v", "0",
  "-row-mt", "1",
  "-deadline", "good",
  "-cpu-used", "2",
  "-g", "120",
  ...maps,
  ...(audio ? ["-c:a", "libopus", "-b:a", "160k"] : []),
  ...color,
  path.join(dir, "fetchr-promo.webm"),
]);

await run("poster", [
  "-ss", String(posterAt),
  "-i", input,
  "-frames:v", "1",
  "-q:v", "2",
  path.join(dir, "fetchr-promo-poster.jpg"),
]);
