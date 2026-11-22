/** Online downloads for the fetchr.fun guide pages.
 *
 * The site downloads up to 1080p on the VPS; anything higher, longer or bigger
 * is offered only in the desktop app, which is the point of the pages. One job
 * runs at a time (the VPS has one core and ~5 GB of free disk), finished files
 * are deleted after FILE_TTL_MS.
 *
 * Routes (behind nginx /api/):
 *   POST /grab/info            { url, search? } -> title, thumbnail, options
 *   POST /grab/jobs            { url, q, section? } -> { id }; q is a height, "audio" or "sub:<lang>"/"auto:<lang>"
 *   GET  /grab/jobs/:id                          -> state, progress, queue position
 *   GET  /grab/jobs/:id/file                     -> the file, as an attachment
 *   GET  /grab/thumb?v=<id>&size=maxres|hq      -> YouTube preview image
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readdirSync, rmSync, statSync, statfsSync } from "node:fs";
import { extname, join } from "node:path";

import { SHORT_LINK_HOSTS, resolveSource } from "./grab-sources.mjs";

export const ONLINE_HEIGHTS = [144, 240, 360, 480, 720, 1080];
export const APP_HEIGHTS = [1440, 2160, 4320];
const MAX_JOB_BYTES = 1.2 * 1024 ** 3;
const MIN_FREE_BYTES = 1.5 * 1024 ** 3;
const MAX_DURATION_S = 4 * 3600;
const FILE_TTL_MS = 30 * 60 * 1000;
const JOB_TIMEOUT_MS = 20 * 60 * 1000;
const INFO_TIMEOUT_MS = 40 * 1000;
const INFO_CACHE_MS = 10 * 60 * 1000;
const MAX_QUEUE = 6;
const JOBS_PER_IP_PER_HOUR = 8;
const INFO_PER_IP_PER_MINUTE = 12;
const THUMBS_PER_IP_PER_MINUTE = 30;
const UPDATE_EVERY_MS = 24 * 3600 * 1000;
const SIZE_CHECK_MS = 2000;
// Vertical-first platforms: quality means the short side, and yt-dlp's -S "res" sorts by it.
const SHORTS = ["tiktok", "pinterest"];
const NO_WATERMARK = "[format_note!*=?watermark]";
const MAX_SECTION_S = 20 * 60;
const MAX_SUB_TRACKS = 12;
const SUB_LANG = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{1,10})?$/;
const SUB_Q = /^(sub|auto):([A-Za-z]{2,3}(?:-[A-Za-z0-9]{1,10})?)$/;

const MIME = {
  ".srt": "application/x-subrip; charset=utf-8",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".m4a": "audio/mp4",
  ".mp3": "audio/mpeg",
  ".opus": "audio/ogg",
  ".ogg": "audio/ogg",
};

export class GrabError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** yt-dlp selector for an online option: H.264 + AAC first so the file plays everywhere. */
export function formatSelector(q, platform = "youtube") {
  if (q === "audio") return platform === "soundcloud" ? "ba[ext=mp3]/ba" : "ba[ext=m4a]/ba";
  const h = Number(q);
  if (!ONLINE_HEIGHTS.includes(h)) throw new GrabError(400, "bad_quality", "Недоступное качество");
  if (SHORTS.includes(platform)) {
    // Resolution and codec come from sortArgs; the watermarked TikTok rendition is never picked.
    const mark = platform === "tiktok" ? NO_WATERMARK : "";
    return [`b${mark}`, `bv*${mark}+ba`, `bv*${mark}`].join("/");
  }
  if (platform !== "youtube") {
    // Twitch, Kick and VK serve muxed renditions; adding +ba would double the audio.
    const plain = "[format_id!^=portrait]";
    return [`b[height<=${h}][vcodec^=avc1]${plain}`, `b[height<=${h}]${plain}`, `bv*[height<=${h}]+ba`].join("/");
  }
  return [
    `bv*[height<=${h}][vcodec^=avc1]+ba[ext=m4a]`,
    `bv*[height<=${h}]+ba[ext=m4a]`,
    `bv*[height<=${h}]+ba`,
    `b[height<=${h}]`,
  ].join("/");
}

/** Extra yt-dlp sort for SHORTS: the largest short side up to q, H.264 over H.265 at equal size. */
export function sortArgs(q, platform) {
  if (q === "audio" || !SHORTS.includes(platform)) return [];
  return ["-S", `res:${Number(q)},vcodec:h264,acodec:aac`];
}

const languageNames = (() => {
  try {
    return new Intl.DisplayNames(["ru"], { type: "language" });
  } catch {
    return null;
  }
})();

const languageLabel = (lang) => {
  const base = lang.replace(/-orig$/, "");
  let name = base;
  try {
    name = languageNames?.of(base) || base;
  } catch {
    name = base;
  }
  return name.charAt(0).toUpperCase() + name.slice(1);
};

/**
 * Subtitle choices from `yt-dlp -J`: uploaded tracks first (Russian and English on top),
 * then auto captions in the original language, Russian and English.
 */
export function buildSubtitles(info) {
  const rank = (lang) => (lang.startsWith("ru") ? 0 : lang.startsWith("en") ? 1 : 2);
  const manual = Object.keys(info.subtitles || {})
    .filter((lang) => SUB_LANG.test(lang))
    .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
    .slice(0, MAX_SUB_TRACKS);
  const auto = info.automatic_captions || {};
  const original = Object.keys(auto).find((lang) => lang.endsWith("-orig") && SUB_LANG.test(lang));
  const taken = new Set(manual);
  const autoLangs = [original, "ru", "en"].filter((lang) => {
    const base = lang?.replace(/-orig$/, "");
    if (!lang || !auto[lang] || taken.has(base)) return false;
    taken.add(base);
    return true;
  });
  return [
    ...manual.map((lang) => ({ q: `sub:${lang}`, label: languageLabel(lang), auto: false })),
    ...autoLangs.map((lang) => ({
      q: `auto:${lang}`,
      label: lang === original ? `${languageLabel(lang)} (оригинал)` : `${languageLabel(lang)} (перевод)`,
      auto: true,
    })),
  ];
}

export const isSubtitleQ = (q) => SUB_Q.test(String(q || ""));

/** yt-dlp arguments that fetch one subtitle track as SRT instead of the video. */
export function subtitleArgs(q) {
  const [, kind, lang] = String(q).match(SUB_Q) || [];
  if (!lang) throw new GrabError(400, "bad_quality", "Недоступные субтитры");
  return ["--skip-download", kind === "auto" ? "--write-auto-subs" : "--write-subs", "--sub-langs", lang, "--convert-subs", "srt"];
}

/** { from, to } in whole seconds for a fragment download, or null for the whole video. */
export function parseSection(section, duration = 0) {
  if (section === undefined || section === null) return null;
  const from = Math.floor(Number(section.from));
  const to = Math.ceil(Number(section.to));
  if (!Number.isFinite(from) || !Number.isFinite(to) || from < 0 || to <= from) {
    throw new GrabError(400, "bad_section", "Конец фрагмента должен быть позже начала");
  }
  if (duration && to > Math.ceil(duration)) throw new GrabError(400, "bad_section", "Фрагмент выходит за конец видео");
  if (to - from > MAX_SECTION_S) {
    throw new GrabError(400, "bad_section", "Онлайн — до 20 минут. Длиннее режет приложение Fetchr.");
  }
  return { from, to };
}

const sectionLabel = ({ from, to }) => {
  const t = (s) => `${Math.floor(s / 60)}.${String(s % 60).padStart(2, "0")}`;
  return `${t(from)}-${t(to)}`;
};

const formatBytes = (f, duration) =>
  Number(f.filesize || f.filesize_approx || (f.tbr && duration ? (f.tbr * 1000 * duration) / 8 : 0)) || 0;

const qualityLabel = (step, fps) =>
  `${step === 2160 ? "4K" : step === 4320 ? "8K" : `${step}p`}${fps > 30 ? String(Math.round(fps)) : ""}`;

/** Options for the widget, built from `yt-dlp -J` output. */
export function buildOptions(info, platform = "youtube") {
  const preferAudio = platform === "soundcloud" ? "mp3" : "m4a";
  const duration = Number(info.duration) || 0;
  const tooLong = duration > MAX_DURATION_S;
  const formats = Array.isArray(info.formats) ? info.formats : [];
  const audio = formats
    .filter((f) => f.vcodec === "none" && f.acodec && f.acodec !== "none" && f.ext !== "mhtml")
    .sort((a, b) => (b.ext === preferAudio) - (a.ext === preferAudio) || (b.abr || 0) - (a.abr || 0))[0];
  const audioBytes = audio ? formatBytes(audio, duration) : 0;
  const shorts = SHORTS.includes(platform);
  const videoHeights = new Map();
  for (const f of formats) {
    // Twitch clips leave vcodec unset; their vertical "portrait-*" crops are not the video.
    if (!f.height || f.vcodec === "none" || String(f.format_id || "").startsWith("portrait")) continue;
    if (platform === "tiktok" && String(f.format_note || "").toLowerCase().includes("watermark")) continue;
    const height = shorts && f.width ? Math.min(f.width, f.height) : f.height;
    const size = formatBytes(f, duration) + (f.acodec && f.acodec !== "none" ? 0 : audioBytes);
    const best = videoHeights.get(height);
    // Prefer the H.264 rendition (what formatSelector picks) and a real size
    // over a bitrate estimate: HLS variants only carry tbr and overshoot.
    const rank = (/^(avc1|h264)/.test(String(f.vcodec || "")) ? 2 : 0) + (f.filesize ? 1 : 0);
    if (!best || rank > best.rank || (rank === best.rank && size > best.size)) {
      videoHeights.set(height, { size, rank, fps: f.fps || 0 });
    }
  }
  const snap = (h) => [...ONLINE_HEIGHTS, ...APP_HEIGHTS].reduce((acc, step) => (h >= step * 0.9 ? step : acc), 0);
  const options = [];
  const seen = new Set();
  for (const h of [...videoHeights.keys()].sort((a, b) => a - b)) {
    const step = snap(h);
    if (!step || seen.has(step)) continue;
    seen.add(step);
    const meta = videoHeights.get(h);
    const online = ONLINE_HEIGHTS.includes(step);
    options.push({
      q: online ? String(step) : null,
      label: qualityLabel(step, meta.fps),
      bytes: Math.round(meta.size),
      online: online && !tooLong && (!meta.size || meta.size <= MAX_JOB_BYTES),
      app_only: !online,
    });
  }
  // 144p/240p only for old videos that have nothing better.
  const result = options.some((o) => Number(o.q) >= 360)
    ? options.filter((o) => !(Number(o.q) > 0 && Number(o.q) < 360))
    : options;
  if (audio) {
    result.push({
      q: "audio",
      label: ["m4a", "mp3", "opus", "webm"].includes(audio.ext) ? `Звук ${audio.ext.toUpperCase()}` : "Звук",
      bytes: Math.round(audioBytes),
      online: !tooLong && audioBytes <= MAX_JOB_BYTES,
      app_only: false,
    });
  }
  return result;
}

export function safeFilename(title, q, ext, section = null) {
  const base = String(title || "video")
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120) || "video";
  const cut = section ? ` ${sectionLabel(section)}` : "";
  if (isSubtitleQ(q)) return `${base} [${String(q).split(":")[1]}]${ext}`;
  return q === "audio" ? `${base}${cut}${ext}` : `${base} [${q}p]${cut}${ext}`;
}

const contentDisposition = (name) => {
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
};

/** Tracks hits per key inside a sliding window. */
function createLimiter(limit, windowMs) {
  const hits = new Map();
  return (key) => {
    const now = Date.now();
    const recent = (hits.get(key) || []).filter((t) => now - t < windowMs);
    if (recent.length >= limit) return false;
    recent.push(now);
    hits.set(key, recent);
    if (hits.size > 5000) hits.clear();
    return true;
  };
}

function run(bin, args, { timeoutMs, onLine, onSpawn } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    if (onSpawn) onSpawn(child);
    let stdout = "";
    let stderr = "";
    let pending = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      if (!onLine) {
        stdout += text;
        return;
      }
      pending += text;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop();
      lines.forEach(onLine);
    });
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-4000);
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(Object.assign(new Error(signal ? `killed by ${signal}` : `exit ${code}`), { stderr }));
    });
  });
}

const dirBytes = (dir) => {
  try {
    return readdirSync(dir).reduce((sum, name) => sum + statSync(join(dir, name)).size, 0);
  } catch {
    return 0;
  }
};

/** Maps a yt-dlp failure to something the page can show and route to the app. */
export function explainFailure(stderr, platform = "") {
  const text = String(stderr || "").toLowerCase();
  if (platform === "twitch" && (text.includes("subscriber") || text.includes("does not exist") || text.includes("404"))) {
    return new GrabError(404, "twitch_hidden", "Запись удалена или только для сабов. Такие VOD находит приложение Fetchr.");
  }
  if (text.includes("confirm your age") || text.includes("age-restricted") || text.includes("inappropriate for some users")) {
    return new GrabError(403, "age_restricted", "Видео 18+ — скачайте через приложение Fetchr.");
  }
  if (text.includes("no video formats found")) {
    return new GrabError(404, "no_video", "Здесь нет видео — только картинка.");
  }
  if (text.includes("ip address is blocked")) {
    return new GrabError(403, "geo", "Видео недоступно в регионе сервера.");
  }
  if (text.includes("sign in to confirm") || text.includes("not a bot")) {
    return new GrabError(503, "blocked", "Сервис временно ограничил загрузки с сервера. Скачайте через приложение Fetchr.");
  }
  if (text.includes("private") || text.includes("members-only") || text.includes("join this channel")) {
    return new GrabError(403, "private", "Видео приватное или только для подписчиков.");
  }
  if (text.includes("not available") || text.includes("unavailable") || text.includes("removed") || text.includes("does not exist")) {
    return new GrabError(404, "unavailable", "Видео недоступно или удалено.");
  }
  if (text.includes("is live") || text.includes("live event") || text.includes("premieres in")) {
    return new GrabError(409, "live", "Эфир ещё идёт. Записать его можно в приложении Fetchr.");
  }
  return new GrabError(502, "failed", "Не получилось скачать. Попробуйте ещё раз или через приложение Fetchr.");
}

/** "Artist Title" from a Spotify track page (Spotify itself is DRM-protected). */
async function spotifyQuery(id) {
  let html;
  try {
    const response = await fetch(`https://open.spotify.com/track/${id}`, {
      headers: { "User-Agent": "Mozilla/5.0", "Accept-Language": "en" },
      signal: AbortSignal.timeout(15000),
    });
    html = await response.text();
  } catch {
    throw new GrabError(502, "failed", "Spotify не ответил. Попробуйте ещё раз.");
  }
  const meta = (name) => html.match(new RegExp(`<meta property="og:${name}" content="([^"]*)"`))?.[1] || "";
  const decode = (s) => s.replace(/&amp;/g, "&").replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"');
  const title = decode(meta("title"));
  const artist = decode(meta("description").split(" · ")[0] || "");
  if (!title) throw new GrabError(404, "unavailable", "Трек не найден в Spotify.");
  return `${artist} ${title}`.trim();
}

export function createGrab({ dataDir, ytdlp, ffmpeg = "", cookies = "", autoUpdate = true, log = () => {} }) {
  const workDir = join(dataDir, "grab");
  rmSync(workDir, { recursive: true, force: true });
  mkdirSync(workDir, { recursive: true });

  const jobs = new Map();
  const queue = [];
  const infoCache = new Map();
  let active = null;
  const allowInfo = createLimiter(INFO_PER_IP_PER_MINUTE, 60 * 1000);
  const allowJob = createLimiter(JOBS_PER_IP_PER_HOUR, 3600 * 1000);
  const allowThumb = createLimiter(THUMBS_PER_IP_PER_MINUTE, 60 * 1000);
  // YouTube bans datacenter IPs ("confirm you're not a bot"); cookies of a spare account lift it.
  // Its "n" challenge needs a JS runtime plus yt-dlp's solver script, fetched from GitHub.
  const auth = (platform) =>
    platform === "youtube"
      ? [
          "--js-runtimes", "node",
          "--remote-components", "ejs:github",
          ...(cookies && existsSync(cookies) ? ["--cookies", cookies] : []),
        ]
      : [];

  const selfUpdate = () =>
    run(ytdlp, ["-U"], { timeoutMs: 120 * 1000 }).then(
      (out) => log(`grab: yt-dlp -U: ${String(out).trim().split("\n").pop()}`),
      (err) => log(`grab: yt-dlp -U failed: ${err.message}`),
    );
  // YouTube breaks old yt-dlp builds within weeks; the standalone binary updates itself.
  if (autoUpdate) {
    selfUpdate();
    setInterval(selfUpdate, UPDATE_EVERY_MS).unref();
  }

  const searchYoutube = async (query) => {
    const out = await run(ytdlp, [...auth("youtube"), "--flat-playlist", "--no-warnings", "--print", "id", `ytsearch1:${query}`], {
      timeoutMs: INFO_TIMEOUT_MS,
    }).catch(() => "");
    const id = String(out).trim().split("\n")[0];
    if (!/^[\w-]{11}$/.test(id)) throw new GrabError(404, "not_found", "Ничего не нашли. Уточните название.");
    return { platform: "youtube", id, url: `https://www.youtube.com/watch?v=${id}` };
  };

  /**
   * vm.tiktok.com and pin.it share links: follow up to three redirects here, staying on the
   * platform's own hosts, and accept only a link that parses as that platform's video.
   */
  const expandShort = async (source) => {
    if (!source.short) return source;
    const sameSite = SHORT_LINK_HOSTS[source.platform];
    let current = source.url;
    for (let hop = 0; hop < 3; hop += 1) {
      let location = "";
      try {
        const response = await fetch(current, {
          redirect: "manual",
          headers: { "User-Agent": "Mozilla/5.0" },
          signal: AbortSignal.timeout(15000),
        });
        location = response.headers.get("location") || "";
      } catch {
        throw new GrabError(502, "failed", "Сервис не ответил. Попробуйте ещё раз.");
      }
      if (!location) break;
      const next = new URL(location, current);
      const target = resolveSource(next.href);
      if (target.platform === source.platform && !target.short) return target;
      if (next.protocol !== "https:" || !sameSite(next.hostname.toLowerCase())) break;
      current = next.href;
    }
    throw new GrabError(404, "unavailable", "Видео недоступно или удалено.");
  };

  const fetchInfo = async (source) => {
    const key = `${source.platform}:${source.id}`;
    const cached = infoCache.get(key);
    if (cached && Date.now() - cached.at < INFO_CACHE_MS) return cached.info;
    let raw;
    try {
      raw = await run(ytdlp, [...auth(source.platform), "-J", "--no-playlist", "--no-warnings", source.url], { timeoutMs: INFO_TIMEOUT_MS });
    } catch (err) {
      throw explainFailure(err.stderr, source.platform);
    }
    const info = JSON.parse(raw);
    if (info.is_live || info.live_status === "is_live" || info.live_status === "is_upcoming") {
      throw explainFailure("is live");
    }
    infoCache.set(key, { at: Date.now(), info });
    if (infoCache.size > 200) infoCache.delete(infoCache.keys().next().value);
    return info;
  };

  /** Visitor text -> a downloadable source; Spotify and plain text go through YouTube search. */
  const toSource = async (raw, allowQuery) => {
    const parsed = resolveSource(raw, { allowQuery });
    if (parsed.error) throw new GrabError(400, "bad_url", parsed.error);
    if (parsed.query) return { source: await searchYoutube(parsed.query), matched: parsed.query };
    if (parsed.platform === "spotify") {
      const query = await spotifyQuery(parsed.id);
      return { source: await searchYoutube(query), matched: query };
    }
    return { source: await expandShort(parsed), matched: "" };
  };

  const publicInfo = (source, info, matched) => ({
    platform: source.platform,
    url: source.url,
    id: source.platform === "youtube" ? source.id : "",
    title: String(info.title || ""),
    channel: String(info.channel || info.uploader || ""),
    duration: Number(info.duration) || 0,
    matched,
    options: buildOptions(info, source.platform),
    subtitles: source.platform === "youtube" ? buildSubtitles(info) : [],
  });

  const view = (job) => ({
    id: job.id,
    state: job.state,
    progress: Math.round(job.progress * 1000) / 10,
    position: job.state === "queued" ? queue.indexOf(job) + 1 : 0,
    filename: job.filename,
    bytes: job.bytes,
    error: job.error,
    error_code: job.errorCode,
  });

  const finish = (job, error) => {
    active = null;
    if (error) {
      const failure = error instanceof GrabError ? error : explainFailure(error.stderr, job.source.platform);
      Object.assign(job, { state: "error", error: failure.message, errorCode: failure.code });
      rmSync(job.dir, { recursive: true, force: true });
    }
    setTimeout(() => {
      rmSync(job.dir, { recursive: true, force: true });
      jobs.delete(job.id);
    }, FILE_TTL_MS).unref();
    pump();
  };

  const mediaArgs = (job) => {
    if (job.subtitles) return subtitleArgs(job.q);
    const args = [
      "-f", formatSelector(job.q, job.source.platform),
      ...sortArgs(job.q, job.source.platform),
      "--max-filesize", String(Math.floor(MAX_JOB_BYTES)),
    ];
    // Cuts land on the nearest keyframes: re-encoding for exact cuts would stall the one-core VPS.
    if (job.section) args.push("--download-sections", `*${job.section.from}-${job.section.to}`);
    if (job.q !== "audio") args.push("--merge-output-format", "mp4");
    return args;
  };

  const download = async (job) => {
    const parts = job.q === "audio" || job.subtitles || job.source.platform !== "youtube" ? 1 : 2;
    let done = 0;
    let oversized = false;
    let child = null;
    const args = [
      ...auth(job.source.platform),
      "--no-playlist", "--no-warnings", "--newline", "--no-part", "--no-mtime",
      // A bare name here is read as a path relative to cwd; leave PATH lookup to yt-dlp.
      ...(ffmpeg ? ["--ffmpeg-location", ffmpeg] : []),
      ...mediaArgs(job),
      "--progress-template", "download:[grab] %(progress.status)s %(progress._percent_str)s",
      "-o", join(job.dir, "media.%(ext)s"),
      job.source.url,
    ];

    // HLS sources (Kick, Twitch) have no size up front, so --max-filesize cannot stop them.
    const watchdog = setInterval(() => {
      if (dirBytes(job.dir) > MAX_JOB_BYTES && child) {
        oversized = true;
        child.kill("SIGKILL");
      }
    }, SIZE_CHECK_MS);
    try {
      await run(ytdlp, args, {
        timeoutMs: JOB_TIMEOUT_MS,
        onSpawn: (c) => { child = c; },
        onLine: (line) => {
          if (line.includes("max-filesize")) oversized = true;
          if (line.startsWith("[Merger]")) {
            job.state = "merging";
            job.progress = 0.99;
            return;
          }
          const match = line.match(/^\[grab\] (\w+)\s+([\d.]+)%/);
          if (!match) return;
          const fraction = Math.min(1, Number(match[2]) / 100);
          job.progress = Math.min(0.98, (done + fraction) / parts);
          if (match[1] === "finished") done = Math.min(parts, done + 1);
        },
      });
    } catch (err) {
      if (!oversized) throw err;
    } finally {
      clearInterval(watchdog);
    }
    if (oversized) {
      throw new GrabError(413, "too_big", "Файл больше лимита онлайн-загрузки. Скачайте через приложение Fetchr — там лимитов нет.");
    }
    const names = readdirSync(job.dir).filter((name) => name.startsWith("media.") && !/\.f[\w-]+\./.test(name));
    const file = job.subtitles ? names.find((name) => name.endsWith(".srt")) : names[0];
    if (!file) {
      throw job.subtitles
        ? new GrabError(404, "no_subs", "Субтитры не скачались. Попробуйте другой язык.")
        : new GrabError(502, "failed", "Не удалось собрать файл. Попробуйте ещё раз.");
    }
    job.path = join(job.dir, file);
    job.ext = extname(file).toLowerCase();
    job.filename = safeFilename(job.title, job.q, job.ext, job.section);
    job.bytes = statSync(job.path).size;
    job.progress = 1;
    job.state = "ready";
  };

  function pump() {
    if (active || queue.length === 0) return;
    const job = queue.shift();
    active = job;
    job.state = "downloading";
    mkdirSync(job.dir, { recursive: true });
    download(job).then(() => finish(job), (err) => finish(job, err));
  }

  const createJob = async (body, ip) => {
    const q = String(body?.q || "");
    const parsed = resolveSource(body?.url);
    if (parsed.error || parsed.short || parsed.platform === "spotify") throw new GrabError(400, "bad_url", "Неверная ссылка");
    const subtitles = isSubtitleQ(q);
    if (subtitles && parsed.platform !== "youtube") throw new GrabError(400, "bad_quality", "Субтитры — только для YouTube");
    if (!subtitles) formatSelector(q, parsed.platform);
    parseSection(body?.section);
    if (!allowJob(ip)) throw new GrabError(429, "rate_limited", "Слишком много загрузок подряд. В приложении Fetchr лимитов нет.");
    if ([...jobs.values()].some((j) => j.ip === ip && ["queued", "downloading", "merging"].includes(j.state))) {
      throw new GrabError(429, "one_at_a_time", "Дождитесь окончания текущей загрузки. В приложении — до трёх сразу.");
    }
    if (queue.length >= MAX_QUEUE) throw new GrabError(503, "busy", "Сервер занят. В приложении Fetchr — без очереди.");

    const info = await fetchInfo(parsed);
    const duration = Number(info.duration) || 0;
    const section = subtitles ? null : parseSection(body?.section, duration);
    let bytes = 0;
    if (subtitles) {
      if (!buildSubtitles(info).some((o) => o.q === q)) throw new GrabError(400, "bad_quality", "Таких субтитров нет");
    } else {
      const option = buildOptions(info, parsed.platform).find((o) => o.q === q);
      if (!option) throw new GrabError(400, "bad_quality", "Такого качества нет");
      bytes = section && duration ? Math.round((option.bytes * (section.to - section.from)) / duration) : option.bytes;
      // A fragment of a long or heavy video is small enough for the server.
      if (section ? bytes > MAX_JOB_BYTES : !option.online) {
        throw new GrabError(413, "too_big", "Файл больше лимита онлайн-загрузки. Скачайте через приложение Fetchr.");
      }
    }
    const free = statfsSync(workDir);
    if (free.bavail * free.bsize - (subtitles ? 0 : bytes || MAX_JOB_BYTES) < MIN_FREE_BYTES) {
      throw new GrabError(503, "busy", "Сервер занят. В приложении Fetchr — без очереди.");
    }

    const id = randomUUID();
    const job = {
      id, ip, q, section, subtitles,
      source: parsed,
      title: info.title,
      dir: join(workDir, id),
      state: "queued",
      progress: 0,
      bytes: bytes || 0,
      filename: "",
    };
    jobs.set(id, job);
    queue.push(job);
    pump();
    return view(job);
  };

  const serveFile = (res, job, headOnly) => {
    if (job.state !== "ready" || !job.path) throw new GrabError(409, "not_ready", "Файл ещё не готов");
    res.writeHead(200, {
      "Content-Type": MIME[job.ext] || "application/octet-stream",
      "Content-Length": String(job.bytes),
      "Content-Disposition": contentDisposition(job.filename),
      "Cache-Control": "no-store",
      "X-Accel-Buffering": "no",
    });
    if (headOnly) return res.end();
    createReadStream(job.path).pipe(res);
  };

  const serveThumb = async (res, url) => {
    const id = url.searchParams.get("v") || "";
    const size = url.searchParams.get("size") === "hq" ? "hq" : "maxres";
    if (!/^[\w-]{11}$/.test(id)) throw new GrabError(400, "bad_url", "Неверная ссылка");
    let image = null;
    for (const name of size === "maxres" ? ["maxresdefault", "sddefault", "hqdefault"] : ["hqdefault"]) {
      const response = await fetch(`https://i.ytimg.com/vi/${id}/${name}.jpg`, { signal: AbortSignal.timeout(15000) }).catch(() => null);
      if (response?.ok) {
        image = Buffer.from(await response.arrayBuffer());
        break;
      }
    }
    if (!image) throw new GrabError(404, "unavailable", "Превью не найдено");
    res.writeHead(200, {
      "Content-Type": "image/jpeg",
      "Content-Length": String(image.length),
      "Content-Disposition": contentDisposition(`${id}-${size}.jpg`),
      "Cache-Control": "public, max-age=3600",
    });
    res.end(image);
  };

  /** Returns true when the request was a /grab route. */
  const handle = async (req, res, url, { json, readJson }) => {
    if (!url.pathname.startsWith("/grab/")) return false;
    const ip = String(req.headers["x-real-ip"] || req.socket.remoteAddress || "");
    try {
      if (req.method === "POST" && url.pathname === "/grab/info") {
        if (!allowInfo(ip)) throw new GrabError(429, "rate_limited", "Слишком много запросов. Подождите минуту.");
        const body = await readJson(req, 4 * 1024);
        const { source, matched } = await toSource(body?.url, body?.search === true);
        json(res, 200, publicInfo(source, await fetchInfo(source), matched));
        return true;
      }
      if (req.method === "POST" && url.pathname === "/grab/jobs") {
        json(res, 202, await createJob(await readJson(req, 4 * 1024), ip));
        return true;
      }
      if (req.method === "GET" && url.pathname === "/grab/thumb") {
        if (!allowThumb(ip)) throw new GrabError(429, "rate_limited", "Слишком много запросов. Подождите минуту.");
        await serveThumb(res, url);
        return true;
      }
      const match = url.pathname.match(/^\/grab\/jobs\/([0-9a-f-]{36})(\/file)?$/);
      const job = match ? jobs.get(match[1]) : null;
      if (match && !job) throw new GrabError(404, "expired", "Ссылка устарела — начните загрузку заново");
      if (job && !match[2] && req.method === "GET") {
        json(res, 200, view(job));
        return true;
      }
      if (job && match[2] && (req.method === "GET" || req.method === "HEAD")) {
        serveFile(res, job, req.method === "HEAD");
        return true;
      }
      throw new GrabError(404, "not_found", "not_found");
    } catch (err) {
      if (err instanceof GrabError) json(res, err.status, { error: err.message, error_code: err.code });
      else {
        log(`grab: ${err.stack || err}`);
        json(res, 500, { error: "Внутренняя ошибка сервера", error_code: "internal" });
      }
      return true;
    }
  };

  return { handle };
}
