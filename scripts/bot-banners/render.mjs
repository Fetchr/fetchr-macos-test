#!/usr/bin/env node
/** Renders the bot's section banners to looping MP4s (Telegram shows an
 *  MP4 without sound as a GIF): banner.html → headless Chrome frames → ffmpeg.
 *
 *   node scripts/bot-banners/render.mjs [home register support shop]
 *   node scripts/bot-banners/render.mjs update --version=0.6.7   (1280×320, channel posts)
 *
 * Output: scripts/assets/bot/<kind>.mp4 plus <kind>.png, a still for review.
 * Env: CHROME (browser path), FFMPEG (ffmpeg path).
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const OUT = join(ROOT, "scripts", "assets", "bot");
const ARGS = process.argv.slice(2);
const VERSION = (ARGS.find((arg) => arg.startsWith("--version=")) || "").slice(10);
const NAMED = ARGS.filter((arg) => !arg.startsWith("--"));
const KINDS = NAMED.length ? NAMED : ["home", "register", "support", "shop"];
const WIDTH = 960;
const HEIGHT = 320;
/** Channel posts get a wider strip than the bot's section banners. */
const SIZES = { update: [1280, 320] };
const FPS = 25;
const SECONDS = 4;

const FILES = {
  "/banner.html": [join(ROOT, "scripts", "bot-banners", "banner.html"), "text/html; charset=utf-8"],
  "/fonts/inter-latin.woff2": [join(ROOT, "node_modules/@fontsource-variable/inter/files/inter-latin-wght-normal.woff2"), "font/woff2"],
  "/fonts/inter-cyrillic.woff2": [join(ROOT, "node_modules/@fontsource-variable/inter/files/inter-cyrillic-wght-normal.woff2"), "font/woff2"],
  "/fonts/jetbrains-latin.woff2": [join(ROOT, "node_modules/@fontsource-variable/jetbrains-mono/files/jetbrains-mono-latin-wght-normal.woff2"), "font/woff2"],
};

function firstExisting(paths) {
  return paths.find((path) => path && existsSync(path)) || null;
}

const chromePath = firstExisting([
  process.env.CHROME,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
]);
const ffmpegPath =
  firstExisting([process.env.FFMPEG, join(process.env.LOCALAPPDATA || "", "Fetchr/resources/ffmpeg.exe")]) || "ffmpeg";
if (!chromePath) throw new Error("Chrome not found: set CHROME");

function serve() {
  const server = createServer((req, res) => {
    const entry = FILES[new URL(req.url, "http://x").pathname];
    if (!entry) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "Content-Type": entry[1] }).end(readFileSync(entry[0]));
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

function launchChrome(profile) {
  const chrome = spawn(chromePath, [
    "--headless=new",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    "--hide-scrollbars",
    "--force-device-scale-factor=1",
    `--window-size=${WIDTH},${HEIGHT}`,
    "--no-first-run",
    "about:blank",
  ]);
  return new Promise((resolve, reject) => {
    let log = "";
    chrome.stderr.on("data", (chunk) => {
      log += chunk;
      const match = /DevTools listening on (ws:\/\/\S+)/.exec(log);
      if (match) resolve({ chrome, wsUrl: match[1] });
    });
    chrome.on("exit", (code) => reject(new Error(`Chrome exited ${code}: ${log.slice(-400)}`)));
  });
}

function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let seq = 0;
  const pending = new Map();
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(JSON.stringify(message.error)));
    else waiter.resolve(message.result);
  };
  const send = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  return new Promise((resolve, reject) => {
    ws.onopen = () => resolve({ ws, send });
    ws.onerror = reject;
  });
}

async function renderKind(send, sessionId, origin, kind) {
  const call = (method, params) => send(method, params, sessionId);
  const [width, height] = SIZES[kind] || [WIDTH, HEIGHT];
  await call("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
  const query = `kind=${kind}&w=${width}&h=${height}${VERSION ? `&v=${VERSION}` : ""}`;
  await call("Page.navigate", { url: `${origin}/banner.html?${query}` });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const { result } = await call("Runtime.evaluate", { expression: "window.bannerReady", awaitPromise: true, returnByValue: true });
    if (result?.value === true) break;
    await new Promise((done) => setTimeout(done, 100));
  }
  const frames = mkdtempSync(join(tmpdir(), `fetchr-banner-${kind}-`));
  const total = FPS * SECONDS;
  for (let index = 0; index < total; index += 1) {
    await call("Runtime.evaluate", { expression: `renderAt(${index / total})` });
    const { data } = await call("Page.captureScreenshot", { format: "png" });
    writeFileSync(join(frames, `f${String(index).padStart(4, "0")}.png`), Buffer.from(data, "base64"));
    if (index === Math.round(total * 0.55)) writeFileSync(join(OUT, `${kind}.png`), Buffer.from(data, "base64"));
  }
  const encode = spawnSync(
    ffmpegPath,
    [
      "-y", "-hide_banner", "-loglevel", "error",
      "-framerate", String(FPS),
      "-i", join(frames, "f%04d.png"),
      "-c:v", "libx264", "-preset", "slow", "-crf", "23",
      "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-an",
      join(OUT, `${kind}.mp4`),
    ],
    { encoding: "utf8" },
  );
  rmSync(frames, { recursive: true, force: true });
  if (encode.status !== 0) throw new Error(`ffmpeg failed for ${kind}: ${encode.stderr}`);
}

mkdirSync(OUT, { recursive: true });
const server = await serve();
const origin = `http://127.0.0.1:${server.address().port}`;
const profile = mkdtempSync(join(tmpdir(), "fetchr-banner-chrome-"));
const { chrome, wsUrl } = await launchChrome(profile);
try {
  const { ws, send } = await connect(wsUrl);
  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  await send("Page.enable", {}, sessionId);
  await send("Emulation.setDeviceMetricsOverride", { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false }, sessionId);
  for (const kind of KINDS) {
    await renderKind(send, sessionId, origin, kind);
    console.log(`${kind}: ${join(OUT, `${kind}.mp4`)}`);
  }
  ws.close();
} finally {
  chrome.kill();
  server.close();
  setTimeout(() => rmSync(profile, { recursive: true, force: true }), 500);
}
