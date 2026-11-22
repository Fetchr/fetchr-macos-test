/** Public download statistics, built from aggregates that hold no user data.
 *
 * The daily job folds raw events into `telemetry-aggregates.json` and raw events
 * expire after 90 days; aggregates stay. `GET /telemetry/summary` folds whatever
 * has not been rolled up yet (today's events) over a copy of them, so the page
 * stays live and one code path produces every number.
 *
 * `baseline` is what the old machine_id-keyed log counted when it was migrated;
 * unique devices cannot be recounted without ids, so later installs add to it. */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";

import { isAllowedThumbnail, isCountedDownload } from "./telemetry-events.mjs";

const DAY_MS = 86_400_000;

export const dayOf = (stamp) => String(stamp || "").slice(0, 10);

export const emptyAggregates = () => ({
  version: 1,
  through_day: "",
  baseline: { app_devices: 0, app_launches: 0, devices_by_version: {} },
  installs: 0,
  launches: 0,
  launches_by_month: {},
  downloads: [],
  streamers: {},
});

export async function readAggregates(path) {
  if (!existsSync(path)) return emptyAggregates();
  return { ...emptyAggregates(), ...JSON.parse(await readFile(path, "utf8")) };
}

/** A new aggregates object with `events` folded in. Only days after
 *  `through_day` count, so an event is never added twice; `throughDay` caps
 *  the days taken and becomes the new mark. */
export function foldEvents(aggregates, events, { throughDay = null } = {}) {
  const rows = new Map(aggregates.downloads.map((row) => [rowKey(row), { ...row, keys: new Set() }]));
  const streamers = { ...aggregates.streamers };
  const byMonth = Object.fromEntries(
    Object.entries(aggregates.launches_by_month).map(([month, versions]) => [month, { ...versions }]),
  );
  let { installs, launches } = aggregates;

  for (const event of events) {
    const day = dayOf(event?.received_at);
    if (!day || day <= aggregates.through_day || (throughDay && day > throughDay)) continue;
    if (event.event_type === "app_launch") {
      launches += 1;
      if (event.payload?.first_run === true) installs += 1;
      const month = day.slice(0, 7);
      const version = event.app_version || "unknown";
      byMonth[month] = { ...byMonth[month], [version]: (byMonth[month]?.[version] || 0) + 1 };
    } else if (isCountedDownload(event)) {
      const payload = event.payload || {};
      const streamer = streamerFromTelemetryPayload(payload) || "";
      const platform = platformFromTelemetryPayload(payload);
      const key = rowKey({ day, streamer, platform });
      const row = rows.get(key) || { day, streamer, platform, downloads: 0, bytes: 0, seconds: 0, unique_streams: 0, keys: new Set() };
      const stream = payload.source_url_hint || payload.source_url || payload.url;
      const fresh = stream && !row.keys.has(stream);
      if (fresh) row.keys.add(stream);
      row.downloads += 1;
      row.unique_streams += fresh ? 1 : 0;
      if (typeof payload.output_bytes === "number") row.bytes += payload.output_bytes;
      if (typeof payload.media_seconds === "number" && payload.media_seconds > 0) row.seconds += payload.media_seconds;
      rows.set(key, row);
      if (streamer) {
        const known = streamers[streamer];
        const preview = known?.preview_url || previewUrlForStreamer(known?.platform || platform, streamer, payload);
        streamers[streamer] = { platform: known?.platform || platform, preview_url: preview };
      }
    }
  }

  return {
    ...aggregates,
    through_day: throughDay && throughDay > aggregates.through_day ? throughDay : aggregates.through_day,
    installs,
    launches,
    launches_by_month: byMonth,
    downloads: [...rows.values()].map(({ keys, ...row }) => row),
    streamers,
  };
}

const rowKey = ({ day, streamer, platform }) => `${day}|${streamer}|${platform}`;

/** The shape the landing page and the showcase read. */
export function summarize(aggregates, now = Date.now()) {
  const weekAgo = dayOf(new Date(now - 7 * DAY_MS).toISOString());
  const totals = { streams: 0, unique: 0, bytes: 0, seconds: 0, lastWeek: 0 };
  const byPlatform = {};
  const downloadsOf = new Map();
  for (const row of aggregates.downloads) {
    totals.streams += row.downloads;
    totals.unique += row.unique_streams || 0;
    totals.bytes += row.bytes;
    totals.seconds += row.seconds;
    if (row.day >= weekAgo) totals.lastWeek += row.downloads;
    byPlatform[row.platform] = (byPlatform[row.platform] || 0) + row.downloads;
    if (row.streamer) downloadsOf.set(row.streamer, (downloadsOf.get(row.streamer) || 0) + row.downloads);
  }
  const devices = aggregates.baseline.app_devices + aggregates.installs;
  return {
    app_downloads: devices,
    app_unique_devices: devices,
    app_launches: aggregates.baseline.app_launches + aggregates.launches,
    app_devices_by_version: devicesByVersion(aggregates),
    downloaded_streams: totals.streams,
    // Counted per day and streamer: the same stream on two days counts twice.
    unique_streams: totals.unique,
    downloaded_bytes: totals.bytes,
    downloaded_hours: Math.round(totals.seconds / 360) / 10,
    downloads_last_7d: totals.lastWeek,
    stream_downloads_by_platform: byPlatform,
    top_streamers: [...downloadsOf]
      .map(([streamer, downloads]) => {
        const { platform, preview_url: previewUrl } = aggregates.streamers[streamer] || {};
        return { streamer, downloads, platform, avatar_url: avatarUrlForStreamer(platform, streamer), preview_url: previewUrl ?? null };
      })
      .sort((a, b) => b.downloads - a.downloads || a.streamer.localeCompare(b.streamer))
      .slice(0, 20),
  };
}

/** Ids rotate monthly, so months cannot be summed: the busiest month of a
 *  version is the closest honest count, on top of what the old log knew. */
function devicesByVersion({ baseline, launches_by_month: byMonth }) {
  const peak = {};
  for (const versions of Object.values(byMonth)) {
    for (const [version, count] of Object.entries(versions)) peak[version] = Math.max(peak[version] || 0, count);
  }
  const out = { ...baseline.devices_by_version };
  for (const [version, count] of Object.entries(peak)) out[version] = (out[version] || 0) + count;
  return out;
}

function normalizeStreamer(value) {
  const streamer = String(value || "").trim().replace(/^@/, "").toLowerCase();
  return streamer || null;
}

export function streamerFromTelemetryPayload(payload) {
  return normalizeStreamer(payload?.streamer)
    || parseCreatorFromUrl(payload?.source_url_hint)
    || parseCreatorFromUrl(payload?.chat_source_url_hint)
    || parseCreatorFromUrl(payload?.source_url)
    || parseCreatorFromUrl(payload?.url);
}

export function platformFromTelemetryPayload(payload) {
  const explicit = String(payload?.platform || "").trim().toLowerCase();
  if (explicit && explicit !== "hls" && explicit !== "unknown") return explicit;
  const url = [
    payload?.source_url_hint,
    payload?.chat_source_url_hint,
    payload?.source_url,
    payload?.url,
  ].filter(Boolean).join(" ").toLowerCase();
  if (url.includes("twitch.tv") || url.includes("ttvnw.net") || url.includes("jtvnw.net") || url.includes("twitchcdn.net")) return "twitch";
  if (url.includes("kick.com")) return "kick";
  if (url.includes("youtube.com") || url.includes("youtu.be")) return "youtube";
  if (url.includes("vkvideo.ru") || url.includes("vk.com") || url.includes("vkplay")) return "vk";
  if (url.includes("rutube.ru")) return "rutube";
  if (url.includes("trovo.live")) return "trovo";
  if (url.includes("rtmp://") || url.includes("rtmps://")) return "rtmp";
  if (url.includes(".mpd")) return "dash";
  if (url.includes(".m3u8")) return "hls";
  return explicit || "unknown";
}

function parseCreatorFromUrl(input, depth = 0) {
  if (!input || depth > 2) return null;
  let parsed;
  try {
    parsed = new URL(String(input));
  } catch {
    return null;
  }

  for (const value of parsed.searchParams.values()) {
    if (/^https?:\/\//i.test(value)) {
      const nested = parseCreatorFromUrl(value, depth + 1);
      if (nested) return nested;
    }
  }

  const host = parsed.hostname.toLowerCase();
  const segments = parsed.pathname.split("/").filter(Boolean);
  const first = segments[0] || "";

  if (host.includes("twitch.tv")) {
    if (!first || ["videos", "video", "v", "clip", "directory"].includes(first.toLowerCase())) return null;
    return normalizeStreamer(first);
  }

  if (host.includes("kick.com")) {
    if (!first || ["video", "categories"].includes(first.toLowerCase())) return null;
    return normalizeStreamer(first);
  }

  if (host.includes("youtube.com") || host.includes("youtu.be")) {
    if (first.startsWith("@")) return normalizeStreamer(first);
    if (["c", "channel", "user"].includes(first.toLowerCase()) && segments[1]) return normalizeStreamer(segments[1]);
  }

  if (host.includes("vkvideo.ru") || host.includes("vk.com") || host.includes("vkplay")) {
    if (!first || ["video", "clips", "feed", "search"].includes(first.toLowerCase())) return null;
    return normalizeStreamer(first);
  }

  if (host.includes("rutube.ru")) {
    if (["channel", "u"].includes(first.toLowerCase()) && segments[1]) return normalizeStreamer(segments[1]);
  }

  if (host.includes("trovo.live")) {
    if (!first || ["video", "category", "clip"].includes(first.toLowerCase())) return null;
    return normalizeStreamer(first);
  }

  if (host.includes("usher.ttvnw.net") && segments[0] === "api" && segments[1] === "channel" && segments[2] === "hls") {
    return normalizeStreamer((segments[3] || "").replace(/\.m3u8$/i, ""));
  }

  if (
    parsed.pathname.toLowerCase().includes(".m3u8")
    || host.includes("ttvnw.net")
    || host.includes("jtvnw.net")
    || host.includes("twitchcdn.net")
    || host.includes("cloudfront.net")
  ) {
    for (const segment of segments) {
      const match = segment.match(/^[a-f0-9]+_([A-Za-z0-9_]{2,25})_\d+_\d+/);
      if (match) return normalizeStreamer(match[1]);
    }
  }

  return null;
}

function avatarUrlForStreamer(platform, streamer) {
  const value = normalizeStreamer(streamer);
  if (!value) return null;
  if (platform === "youtube") return `https://unavatar.io/youtube/${encodeURIComponent(value.replace(/^@/, ""))}`;
  if (platform === "kick") return `https://unavatar.io/kick/${encodeURIComponent(value)}`;
  if (platform === "vk") return `https://unavatar.io/vk/${encodeURIComponent(value)}`;
  if (platform === "rutube") return `https://unavatar.io/rutube/${encodeURIComponent(value)}`;
  if (platform === "twitch" || platform === "hls" || platform === "unknown") return `https://unavatar.io/twitch/${encodeURIComponent(value)}`;
  return `https://unavatar.io/${encodeURIComponent(value)}`;
}

/** Old log lines may still hold any URL as a thumbnail; only platform images reach the page. */
function previewUrlForStreamer(platform, streamer, payload) {
  if (isAllowedThumbnail(payload?.thumbnail)) return payload.thumbnail;
  const value = normalizeStreamer(streamer);
  if (!value) return null;
  if (platform === "twitch" || platform === "hls" || platform === "unknown") {
    return `https://static-cdn.jtvnw.net/previews-ttv/live_user_${encodeURIComponent(value)}-440x248.jpg`;
  }
  return null;
}
