import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { ClientError } from "./http-errors.mjs";
import {
  createTelemetryEvents,
  isAllowedThumbnail,
  isCountedDownload,
  sanitizeTelemetryEvent,
} from "./telemetry-events.mjs";

const MACHINE = "0123456789ABCDEF0123456789ABCDEF";

const tempFile = () => join(mkdtempSync(join(tmpdir(), "fetchr-telemetry-")), "telemetry.jsonl");
const lines = (path) => readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));

const ID = "ABCDEF0123456789ABCDEF0123456789";
const launch = (id = ID) => ({ event_type: "app_launch", app_version: "0.9.0", telemetry_id: id, payload: {} });
const download = (jobId, payload = {}) => ({
  event_type: "stream_downloaded",
  app_version: "0.6.6",
  channel: "beta",
  machine_id: MACHINE,
  sent_at: "2026-09-27T10:00:00Z",
  payload: { job_id: jobId, platform: "twitch", streamer: "somebody", ...payload },
});

test("thumbnails are accepted only over https from the platforms' own image hosts", () => {
  for (const url of [
    "https://i.ytimg.com/vi/abcdefghijk/hqdefault.jpg",
    "https://static-cdn.jtvnw.net/cf_vods/x/thumb.jpg",
    "https://images.kick.com/video_thumbnails/x.webp",
    "https://sun9-12.userapi.com/impg/x.jpg",
  ]) {
    assert.equal(isAllowedThumbnail(url), true, url);
  }
  for (const url of [
    "http://i.ytimg.com/vi/x/hqdefault.jpg",
    "https://i.ytimg.com.attacker.example/x.jpg",
    "https://attacker.example/i.ytimg.com/x.jpg",
    "https://user:pass@i.ytimg.com/x.jpg",
    "javascript:alert(1)",
    "",
    null,
    42,
  ]) {
    assert.equal(isAllowedThumbnail(url), false, String(url));
  }
});

test("malformed events are a client error, not a server error", () => {
  for (const event of [
    null,
    { ...launch(), event_type: "anything" },
    { event_type: "app_launch", telemetry_id: ID },
  ]) {
    assert.throws(() => sanitizeTelemetryEvent(event), (err) => err instanceof ClientError && err.status === 400);
  }
});

test("only the fields the app sends are kept, clipped, with a foreign thumbnail dropped", () => {
  const clean = sanitizeTelemetryEvent(download("job-1", {
    title: "t".repeat(5000),
    thumbnail: "https://tracker.example/pixel.gif",
    injected: { deep: "x".repeat(10_000) },
    source_url_hint: "https://www.twitch.tv/somebody",
  }));
  assert.equal(clean.machine_id, undefined);
  assert.equal(clean.payload.injected, undefined);
  assert.equal(clean.payload.thumbnail, undefined);
  assert.ok(clean.payload.title.length <= 300);
  assert.equal(clean.payload.source_url_hint, "https://www.twitch.tv/somebody");
  assert.ok(JSON.stringify(clean).length < 4096);

  const kept = sanitizeTelemetryEvent(download("job-2", { thumbnail: "https://i.ytimg.com/vi/abcdefghijk/hqdefault.jpg" }));
  assert.equal(kept.payload.thumbnail, "https://i.ytimg.com/vi/abcdefghijk/hqdefault.jpg");
  assert.equal(sanitizeTelemetryEvent(launch(ID.toLowerCase())).telemetry_id, ID);
});

test("app_launch is stored once per monthly id and version, also across a restart", async () => {
  const path = tempFile();
  writeFileSync(path, `${JSON.stringify(launch())}\n`);
  const events = createTelemetryEvents({ path, buildSummary: () => ({}) });
  const again = await events.ingest(launch(), "1.1.1.1");
  assert.equal(again.status, 202);
  assert.equal(again.body.duplicate, true);
  const other = await events.ingest(launch("FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF"), "1.1.1.1");
  assert.equal(other.body.duplicate, false);
  const upgraded = await events.ingest({ ...launch(), app_version: "1.0.0" }, "1.1.1.1");
  assert.equal(upgraded.body.duplicate, false);
  assert.equal(lines(path).length, 3);
});

test("a launch from an old app version is accepted but not stored", async () => {
  const path = tempFile();
  const events = createTelemetryEvents({ path, buildSummary: () => ({}) });
  const old = await events.ingest({ event_type: "app_launch", machine_id: MACHINE, payload: {} }, "1.1.1.1");
  assert.equal(old.status, 202);
  assert.throws(() => readFileSync(path));
});

test("a retried download event is stored once", async () => {
  const path = tempFile();
  const events = createTelemetryEvents({ path, buildSummary: () => ({}) });
  await events.ingest(download("job-1"), "1.1.1.1");
  const retry = await events.ingest(download("job-1"), "1.1.1.1");
  await events.ingest(download("job-2"), "1.1.1.1");
  assert.equal(retry.body.duplicate, true);
  assert.deepEqual(lines(path).map((event) => event.payload.job_id), ["job-1", "job-2"]);
  assert.ok(lines(path).every((event) => typeof event.received_at === "string"));
});

test("a flood from one address is refused before anything is written", async () => {
  const path = tempFile();
  const events = createTelemetryEvents({
    path,
    buildSummary: () => ({}),
    perIp: { limit: 2, windowMs: 60_000 },
    now: () => 0,
  });
  assert.equal((await events.ingest(download("a"), "6.6.6.6")).status, 202);
  assert.equal((await events.ingest(download("b"), "6.6.6.6")).status, 202);
  const refused = await events.ingest(download("c"), "6.6.6.6");
  assert.equal(refused.status, 429);
  assert.equal((await events.ingest(download("d"), "7.7.7.7")).status, 202);
  assert.equal(lines(path).length, 3);
});

test("the public summary is computed at most once per TTL", async () => {
  const path = tempFile();
  let time = 0;
  let builds = 0;
  const events = createTelemetryEvents({
    path,
    summaryTtlMs: 30_000,
    now: () => time,
    buildSummary: (all) => {
      builds += 1;
      return { count: all.length };
    },
  });
  await events.ingest(download("a"), "1.1.1.1");
  assert.deepEqual(await events.summary(), { count: 1 });
  await events.ingest(download("b"), "1.1.1.1");
  assert.deepEqual(await events.summary(), { count: 1 });
  assert.equal(builds, 1);
  time += 30_001;
  assert.deepEqual(await events.summary(), { count: 2 });
  assert.equal(builds, 2);
});

test("broken files and non-download jobs stay out of the public counter", () => {
  const MB = 1024 * 1024;
  assert.equal(isCountedDownload(download("a", { output_bytes: 50 * MB })), true);
  assert.equal(isCountedDownload(download("legacy-no-size")), true);
  assert.equal(isCountedDownload(download("empty", { output_bytes: 0 })), false);
  assert.equal(isCountedDownload(download("stub", { output_bytes: 1396 })), false);
  assert.equal(isCountedDownload(download("mute", { job_kind: "fetchr_mute", output_bytes: 50 * MB })), false);
  assert.equal(isCountedDownload(download("chat", { job_kind: "chat" })), false);
  assert.equal(isCountedDownload(launch()), false);
});

test("job kind and media length survive sanitizing", () => {
  const clean = sanitizeTelemetryEvent(download("1", { job_kind: "vps_download", media_seconds: 61.5 }));
  assert.equal(clean.payload.job_kind, "vps_download");
  assert.equal(clean.payload.media_seconds, 61.5);
});
