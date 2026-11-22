/** Turns stored app telemetry events into daily counters.
 *
 * Called for every newly stored event, and once over the whole raw log to
 * backfill history (raw events expire after 90 days, counters stay). Launch
 * ids rotate monthly; a set of the ids seen (memory only) makes `app.active`
 * count a device once per month even across app updates. */

import { isCountedDownload } from "../telemetry-events.mjs";
import { platformFromTelemetryPayload, streamerFromTelemetryPayload } from "../telemetry-summary.mjs";

const BACKFILL_DAY = "0000-00-00";
const BACKFILL_KEY = "app.backfilled";
const ARCHIVE_KEY = "app.backfilled_archive";
const MAX_BYTES = 2 ** 42;
const MAX_SECONDS = 7 * 86_400;
const MAX_IDS = 500_000;

const safe = (value, fallback = "unknown") => {
  const text = String(value || "").toLowerCase().slice(0, 40);
  return /^[a-z0-9@._-]+$/.test(text) ? text : fallback;
};
const bounded = (value, max) => typeof value === "number" && value > 0 && value < max;

export function createAppCounter(counters) {
  let ids = new Set();

  const activeKey = (event, day) => (event.telemetry_id ? `${day.slice(0, 7)}:${event.telemetry_id}` : null);

  function firstLaunchThisMonth(event, day) {
    const key = activeKey(event, day);
    if (!key) return true;
    if (ids.has(key)) return false;
    if (ids.size >= MAX_IDS) ids = new Set();
    ids.add(key);
    return true;
  }

  function count(event) {
    const day = String(event?.received_at || "").slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return;
    const bump = (key, amount = 1) => counters.bump(key, amount, day);
    const payload = event.payload || {};

    if (event.event_type === "app_launch") {
      bump(`app.version:${safe(event.app_version)}`);
      if (payload.first_run === true) bump("app.installs");
      if (firstLaunchThisMonth(event, day)) bump("app.active");
      return;
    }

    if (event.event_type === "stream_downloaded") {
      if (!isCountedDownload(event)) return;
      bump("app.downloads");
      bump(`app.dl.platform:${safe(platformFromTelemetryPayload(payload))}`);
      bump(`app.dl.kind:${safe(payload.job_kind || "video")}`);
      bump(`app.dl.mode:${safe(payload.mode)}`);
      bump(`app.dl.type:${safe(payload.download_kind || "video")}`);
      if (bounded(payload.output_bytes, MAX_BYTES)) bump("app.dl.bytes", payload.output_bytes);
      if (bounded(payload.media_seconds, MAX_SECONDS)) bump("app.dl.seconds", Math.round(payload.media_seconds));
      const streamer = streamerFromTelemetryPayload(payload);
      if (streamer) bump(`app.dl.streamer:${safe(streamer)}`);
      return;
    }

    if (event.event_type === "job_finished") {
      const outcome = payload.outcome === "error" ? "error" : "done";
      bump(`app.job.${outcome}`);
      bump(`app.job.kind:${safe(payload.job_kind)}:${outcome}`);
      bump(`app.job.platform:${safe(payload.platform)}:${outcome}`);
      for (const feature of payload.features || []) bump(`app.feature:${safe(feature)}:${outcome}`);
      if (payload.quality_height) bump(`app.quality:${payload.quality_height}`);
      return;
    }

    if (event.event_type === "screen_views") {
      for (const [screen, value] of Object.entries(payload.counts || {})) bump(`app.screen:${safe(screen)}`, value);
    }
  }

  /** Remembers this month's launch ids without counting anything. */
  function prime(events) {
    for (const event of events) {
      const day = String(event?.received_at || "").slice(0, 10);
      if (event?.event_type === "app_launch" && day) firstLaunchThisMonth(event, day);
    }
  }

  /** Download rows of `telemetry-aggregates.json` for the days the raw log
   *  no longer holds (raw events expire after 90 days, rows stay). */
  function foldArchive(aggregates, events) {
    const rawDays = events
      .filter((event) => event?.event_type === "stream_downloaded")
      .map((event) => String(event.received_at || "").slice(0, 10))
      .filter(Boolean)
      .sort();
    const firstRawDay = rawDays[0] || "9999-99-99";
    for (const row of aggregates?.downloads || []) {
      if (!row?.day || row.day >= firstRawDay) continue;
      const bump = (key, amount = 1) => counters.bump(key, amount, row.day);
      bump("app.downloads", row.downloads || 0);
      bump(`app.dl.platform:${safe(row.platform)}`, row.downloads || 0);
      if (bounded(row.bytes, MAX_BYTES * 1000)) bump("app.dl.bytes", row.bytes);
      if (bounded(row.seconds, MAX_SECONDS * 1000)) bump("app.dl.seconds", Math.round(row.seconds));
      if (row.streamer) bump(`app.dl.streamer:${safe(row.streamer)}`, row.downloads || 0);
    }
  }

  const marked = (key) => Boolean(counters.range(BACKFILL_DAY, BACKFILL_DAY)[0]?.counts?.[key]);

  /** Folds the raw log and the archive in once each; later starts only prime the ids. */
  function start(events, aggregates = null) {
    let changed = false;
    if (marked(BACKFILL_KEY)) prime(events);
    else {
      for (const event of events) count(event);
      counters.bump(BACKFILL_KEY, 1, BACKFILL_DAY);
      changed = true;
    }
    if (aggregates && !marked(ARCHIVE_KEY)) {
      foldArchive(aggregates, events);
      counters.bump(ARCHIVE_KEY, 1, BACKFILL_DAY);
      changed = true;
    }
    return changed;
  }

  return { count, start };
}
