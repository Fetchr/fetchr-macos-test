/** App telemetry (`POST /telemetry/events`) and the public counters built from
 *  it (`GET /telemetry/summary`, polled by the landing page every 15 s).
 *
 * Anyone can post here, so every event is cut down to the fields the desktop
 * app sends (src-tauri/src/telemetry.rs), rate-limited per address, and
 * de-duplicated: a launch counts once per monthly id and version, a finished
 * download once per job. The summary is cached so page views do not re-read
 * the whole log.
 *
 * Nothing stored here may lead back to a person. A download event carries no
 * id at all, a launch only the app's random id that changes every month, times
 * are rounded to the hour, and `machine_id` from older app versions is dropped
 * on arrival. Older versions' launches are not stored: without a usable id
 * they cannot be de-duplicated, and those devices are already in the baseline. */

import { existsSync } from "node:fs";
import { appendFile, readFile } from "node:fs/promises";

import { ClientError } from "./http-errors.mjs";
import { createRateLimiter } from "./rate-limit.mjs";

const EVENT_TYPES = new Set(["app_launch", "stream_downloaded", "job_finished", "screen_views"]);

/** `job_finished`: every finished or failed job, with the options it used, so
 *  the dashboard can rank features. `screen_views`: how often each screen was
 *  opened since the last report. Both carry no id and no URL. */
export const JOB_FEATURES = new Set([
  "fragments", "split", "chat_render", "chat_separate", "sponsor_blur", "fetchr_mute",
  "vocal_remover", "unmute", "proxy", "audio", "live", "vps", "twitch_auth", "custom_quality",
]);
export const APP_SCREENS = new Set([
  "home", "queue", "logs", "settings", "finder", "chat_render", "presets", "sponsor_blur",
  "fetchr_mute", "vocal_remover", "live_recorder", "vps_recorder",
]);
const JOB_KINDS = new Set(["video", "vps_download", "chat", "fetchr_mute"]);
const OUTCOMES = new Set(["done", "error"]);
const SLUG = /^[a-z0-9_-]{1,32}$/;
const TELEMETRY_ID = /^[A-F0-9]{32}$/i;
const HOUR_MS = 3_600_000;
const MAX_JOB_KEYS = 50_000;

/** Envelope and payload text fields with their maximum length. `source_url`
 *  and `url` come from app versions older than 0.6. */
const ENVELOPE_TEXT = { app_version: 32, channel: 16 };
const PAYLOAD_TEXT = {
  job_id: 64,
  job_kind: 32,
  platform: 32,
  streamer: 64,
  mode: 32,
  download_kind: 32,
  source_url_hint: 500,
  chat_source_url_hint: 500,
  source_url: 500,
  url: 500,
  title: 300,
  thumbnail: 500,
};
const PAYLOAD_NUMBERS = ["output_bytes", "media_seconds", "download_elapsed_ms"];
const PAYLOAD_TIMES = ["created_at", "started_at", "finished_at"];
const PAYLOAD_URLS = ["source_url_hint", "chat_source_url_hint", "source_url", "url"];

/** Job kinds that finish without downloading a stream (older app versions
 *  reported the mute pass as a download). */
const NOT_A_DOWNLOAD = new Set(["chat", "fetchr_mute"]);
/** A "finished" file this small is a failed download (seen: 0, 262, 1396 B). */
const MIN_OUTPUT_BYTES = 1024 * 1024;

/** Whether a stored event counts toward the public "downloaded streams". */
export function isCountedDownload(event) {
  if (event?.event_type !== "stream_downloaded") return false;
  const payload = event.payload || {};
  if (NOT_A_DOWNLOAD.has(payload.job_kind)) return false;
  const bytes = payload.output_bytes;
  return !(typeof bytes === "number" && bytes < MIN_OUTPUT_BYTES);
}

/** Image hosts of the platforms themselves; the landing page shows these URLs. */
const THUMBNAIL_HOSTS = [
  "ytimg.com",
  "jtvnw.net",
  "twitch.tv",
  "kick.com",
  "userapi.com",
  "vkuser.net",
  "vk.com",
  "rutube.ru",
  "rutubelist.ru",
  "trovo.live",
];

export function isAllowedThumbnail(value) {
  if (typeof value !== "string" || value.length > PAYLOAD_TEXT.thumbnail) return false;
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port) return false;
  const host = url.hostname.toLowerCase();
  return THUMBNAIL_HOSTS.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
}

const clippedText = (source, limits) =>
  Object.entries(limits)
    .filter(([key]) => typeof source[key] === "string")
    .map(([key, max]) => [key, source[key].slice(0, max)]);

/** A timestamp rounded down to the hour, or null when it is not one. */
export function hourOf(stamp) {
  const time = typeof stamp === "number" ? stamp : Date.parse(stamp);
  return Number.isFinite(time) ? new Date(time - (time % HOUR_MS)).toISOString() : null;
}

/** Signed URLs carry tokens in the query; old app versions send it. */
function withoutQuery(value) {
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return value.split(/[?#]/)[0];
  }
}

function cleanPayload(payload) {
  const numbers = PAYLOAD_NUMBERS
    .filter((key) => typeof payload[key] === "number" && Number.isFinite(payload[key]))
    .map((key) => [key, payload[key]]);
  const times = PAYLOAD_TIMES
    .filter((key) => typeof payload[key] === "number" && Number.isFinite(payload[key]))
    .map((key) => [key, payload[key] - (payload[key] % HOUR_MS)]);
  const fields = [...clippedText(payload, PAYLOAD_TEXT), ...numbers, ...times]
    .filter(([key, value]) => key !== "thumbnail" || isAllowedThumbnail(value))
    .map(([key, value]) => (PAYLOAD_URLS.includes(key) ? [key, withoutQuery(value)] : [key, value]));
  return Object.fromEntries([...fields, ...(payload.first_run === true ? [["first_run", true]] : [])]);
}

const pick = (value, allowed) => (typeof value === "string" && allowed.has(value) ? value : null);

function cleanJobFinished(payload) {
  const features = Array.isArray(payload.features)
    ? [...new Set(payload.features.filter((name) => typeof name === "string" && JOB_FEATURES.has(name)))].sort()
    : [];
  const platform = typeof payload.platform === "string" ? payload.platform.toLowerCase().slice(0, 32) : "";
  const fields = {
    job_id: typeof payload.job_id === "string" ? payload.job_id.slice(0, 64) : null,
    job_kind: pick(payload.job_kind, JOB_KINDS) || "video",
    outcome: pick(payload.outcome, OUTCOMES),
    platform: SLUG.test(platform) ? platform : "unknown",
    mode: pick(payload.mode, new Set(["vod", "live"])),
    download_kind: pick(payload.download_kind, new Set(["video", "audio"])),
    features,
    quality_height: Number.isInteger(payload.quality_height) && payload.quality_height > 0 && payload.quality_height < 10_000 ? payload.quality_height : null,
    media_seconds: typeof payload.media_seconds === "number" && Number.isFinite(payload.media_seconds) && payload.media_seconds > 0 ? Math.round(payload.media_seconds) : null,
  };
  if (!fields.outcome) throw new ClientError(400, "unsupported outcome");
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== null));
}

function cleanScreenViews(payload) {
  const counts = payload.counts && typeof payload.counts === "object" && !Array.isArray(payload.counts) ? payload.counts : {};
  const clean = Object.entries(counts)
    .filter(([screen, count]) => APP_SCREENS.has(screen) && Number.isInteger(count) && count > 0)
    .map(([screen, count]) => [screen, Math.min(count, 500)]);
  if (clean.length === 0) throw new ClientError(400, "no screen counts");
  return { counts: Object.fromEntries(clean) };
}

const PAYLOAD_CLEANERS = {
  job_finished: cleanJobFinished,
  screen_views: cleanScreenViews,
};

/** The stored form of an incoming event; throws `ClientError` 400 when it is not one. */
export function sanitizeTelemetryEvent(event) {
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    throw new ClientError(400, "event must be an object");
  }
  if (!EVENT_TYPES.has(event.event_type)) throw new ClientError(400, "unsupported event_type");
  if (!event.payload || typeof event.payload !== "object" || Array.isArray(event.payload)) {
    throw new ClientError(400, "payload must be an object");
  }
  const id = event.event_type === "app_launch" && TELEMETRY_ID.test(event.telemetry_id) ? event.telemetry_id : null;
  const sentAt = hourOf(event.sent_at);
  return {
    event_type: event.event_type,
    ...Object.fromEntries(clippedText(event, ENVELOPE_TEXT)),
    ...(sentAt ? { sent_at: sentAt } : {}),
    ...(id ? { telemetry_id: id.toUpperCase() } : {}),
    payload: (PAYLOAD_CLEANERS[event.event_type] || cleanPayload)(event.payload),
  };
}

/** Launches de-duplicate per monthly id and version, downloads per job. */
function dedupeKey(event) {
  if (event?.event_type === "app_launch") {
    return event.telemetry_id ? `launch:${event.telemetry_id}:${event.app_version || ""}` : null;
  }
  const job = event?.payload?.job_id;
  if (event?.event_type === "job_finished") return job ? `fin:${job}` : null;
  return event?.event_type === "stream_downloaded" && job ? `job:${job}` : null;
}

export async function readEvents(path) {
  if (!existsSync(path)) return [];
  const text = await readFile(path, "utf8");
  return text
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

export function createTelemetryEvents({
  path,
  buildSummary,
  summaryTtlMs = 30_000,
  perIp = { limit: 120, windowMs: 10 * 60_000 },
  now = () => Date.now(),
}) {
  const allowIp = createRateLimiter({ ...perIp, now });
  let seen = null;
  let cached = null;
  let building = null;

  /** Keys already in the log, loaded once; job keys are capped, oldest out. */
  function seenKeys() {
    seen ??= readEvents(path)
      .then((events) => ({
        launches: new Set(events.map(dedupeKey).filter((key) => key?.startsWith("launch:"))),
        jobs: new Set(events.map(dedupeKey).filter((key) => key && !key.startsWith("launch:")).slice(-MAX_JOB_KEYS)),
      }))
      .catch((err) => {
        seen = null;
        throw err;
      });
    return seen;
  }

  function remember(keys, key) {
    const bucket = key.startsWith("launch:") ? keys.launches : keys.jobs;
    bucket.add(key);
    if (bucket === keys.jobs && bucket.size > MAX_JOB_KEYS) bucket.delete(bucket.values().next().value);
  }

  async function ingest(raw, ip, onStored = () => {}) {
    const event = sanitizeTelemetryEvent(raw);
    if (!allowIp(ip || "unknown")) {
      return { status: 429, body: { error: "rate_limited" } };
    }
    if (event.event_type === "app_launch" && !event.telemetry_id) {
      return { status: 202, body: { ok: true, duplicate: true } };
    }
    const keys = await seenKeys();
    const key = dedupeKey(event);
    if (key && (keys.launches.has(key) || keys.jobs.has(key))) {
      return { status: 202, body: { ok: true, duplicate: true } };
    }
    if (key) remember(keys, key);
    const stored = { ...event, received_at: hourOf(now()) };
    await appendFile(path, `${JSON.stringify(stored)}\n`, "utf8");
    onStored(stored);
    return { status: 202, body: { ok: true, duplicate: false } };
  }

  function summary() {
    const stamp = now();
    if (cached && stamp - cached.at < summaryTtlMs) return Promise.resolve(cached.value);
    building ??= readEvents(path)
      .then((events) => buildSummary(events))
      .then((value) => {
        cached = { at: stamp, value };
        return value;
      })
      .finally(() => {
        building = null;
      });
    return building;
  }

  return { ingest, summary };
}
