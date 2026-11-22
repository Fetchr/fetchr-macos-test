import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { ClientError } from "../http-errors.mjs";
import { sanitizeTelemetryEvent } from "../telemetry-events.mjs";
import { createAppCounter } from "./app-counters.mjs";
import { createCounters } from "./counters.mjs";
import { buildReport, businessCounts } from "./report.mjs";
import { classifyAgent, createSiteHits, normalizePath, referrerHost, robotReason } from "./site-hits.mjs";

const DAY = 86_400_000;
const BROWSER = { "accept-language": "ru-RU,ru;q=0.9", "sec-fetch-site": "same-origin", origin: "https://fetchr.fun" };
const NOW = Date.parse("2026-11-09T12:00:00Z");
const CHROME = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0 Safari/537.36";
const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1";

const memoryCounters = (now = () => NOW) =>
  createCounters({ path: join(mkdtempSync(join(tmpdir(), "fetchr-an-")), "c.json"), now, flushMs: 0 });

const today = (counters) => counters.range("2026-11-09", "2026-11-09")[0]?.counts || {};

test("counters bump immutably per day and persist on flush", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fetchr-an-"));
  const path = join(dir, "c.json");
  const counters = createCounters({ path, now: () => NOW, flushMs: 0 });
  counters.bump("a");
  counters.bump("a", 2);
  counters.bump("b", 1, "2026-11-01");
  const before = counters.range("2026-11-09", "2026-11-09")[0].counts;
  counters.bump("a");
  assert.equal(before.a, 3);
  await counters.flush();
  const saved = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(saved.days["2026-11-09"].a, 4);
  const reloaded = createCounters({ path, now: () => NOW, flushMs: 0 });
  assert.deepEqual(reloaded.range("2026-11-01", "2026-11-09").map((row) => row.day), ["2026-11-01", "2026-11-09"]);
});

test("path, referrer and agent are reduced to coarse labels", () => {
  assert.equal(normalizePath("/skachat-strim-s-twitch/index.html?x=1"), "/skachat-strim-s-twitch/");
  assert.equal(normalizePath("/app"), "/app/");
  assert.equal(normalizePath("/<script>"), "/other");
  assert.equal(referrerHost(""), "direct");
  assert.equal(referrerHost("https://fetchr.fun/app/"), null);
  assert.equal(referrerHost("https://www.google.com/search?q=x"), "google");
  assert.equal(referrerHost("https://yandex.ru/search"), "yandex");
  assert.equal(referrerHost("https://t.me/somechannel"), "t.me");
  assert.deepEqual(classifyAgent(CHROME), { os: "windows", device: "desktop", browser: "chrome" });
  assert.deepEqual(classifyAgent(IPHONE), { os: "ios", device: "mobile", browser: "safari" });
});

test("site hits count visitors once per day and drop bots", () => {
  let now = NOW;
  const counters = memoryCounters(() => now);
  const hits = createSiteHits({ counters, now: () => now });
  const pv = { t: "pv", p: "/", r: "https://www.google.com/", u: "tg_ads" };
  assert.equal(hits.ingest(pv, { ip: "1.1.1.1", ua: CHROME, headers: BROWSER }), 204);
  hits.ingest({ ...pv, p: "/app/" }, { ip: "1.1.1.1", ua: CHROME, headers: BROWSER });
  hits.ingest(pv, { ip: "2.2.2.2", ua: IPHONE, headers: BROWSER });
  hits.ingest(pv, { ip: "3.3.3.3", ua: "Googlebot/2.1", headers: BROWSER });
  const counts = today(counters);
  assert.equal(counts["site.pageviews"], 3);
  assert.equal(counts["site.visitors"], 2);
  assert.equal(counts["page:/app/"], 1);
  assert.equal(counts["ref:google"], 2);
  assert.equal(counts["utm:tg_ads"], 2);
  assert.equal(counts["device:mobile"], 1);
  assert.equal(counts["site.bots"], 1);
  now += DAY;
  hits.ingest(pv, { ip: "1.1.1.1", ua: CHROME, headers: BROWSER });
  assert.equal(counters.range("2026-11-10", "2026-11-10")[0].counts["site.visitors"], 1);
});

test("site events are allow-listed", () => {
  const counters = memoryCounters();
  const hits = createSiteHits({ counters, now: () => NOW });
  hits.ingest({ t: "ev", e: "grab_job", v: "youtube", p: "/skachat-video-s-youtube/" }, { ip: "1", ua: CHROME, headers: BROWSER });
  const counts = today(counters);
  assert.equal(counts["ev:grab_job"], 1);
  assert.equal(counts["ev:grab_job:youtube"], 1);
  assert.equal(counts["evpage:grab_job:/skachat-video-s-youtube/"], 1);
  assert.throws(() => hits.ingest({ t: "ev", e: "anything" }, { ip: "1", ua: CHROME, headers: BROWSER }), ClientError);
  assert.throws(() => hits.ingest([], { ip: "1", ua: CHROME, headers: BROWSER }), ClientError);
});

test("site hits are rate limited per address", () => {
  const counters = memoryCounters();
  const hits = createSiteHits({ counters, now: () => NOW, perIp: { limit: 2, windowMs: 60_000 } });
  const pv = { t: "pv", p: "/" };
  hits.ingest(pv, { ip: "9", ua: CHROME, headers: BROWSER });
  hits.ingest(pv, { ip: "9", ua: CHROME, headers: BROWSER });
  assert.equal(hits.ingest(pv, { ip: "9", ua: CHROME, headers: BROWSER }), 429);
});

test("job_finished keeps only allow-listed fields", () => {
  const event = sanitizeTelemetryEvent({
    event_type: "job_finished",
    app_version: "0.8.8",
    payload: {
      job_id: "j1",
      outcome: "done",
      job_kind: "video",
      platform: "Twitch",
      features: ["chat_render", "fragments", "evil", "chat_render"],
      url: "https://twitch.tv/x?token=1",
      quality_height: 1080,
    },
  });
  assert.deepEqual(event.payload, {
    job_id: "j1",
    job_kind: "video",
    outcome: "done",
    platform: "twitch",
    features: ["chat_render", "fragments"],
    quality_height: 1080,
  });
  assert.throws(() => sanitizeTelemetryEvent({ event_type: "job_finished", payload: { outcome: "maybe" } }), ClientError);
});

test("screen_views keeps known screens only", () => {
  const event = sanitizeTelemetryEvent({ event_type: "screen_views", payload: { counts: { queue: 3, hacker: 9, logs: -1 } } });
  assert.deepEqual(event.payload, { counts: { queue: 3 } });
  assert.throws(() => sanitizeTelemetryEvent({ event_type: "screen_views", payload: { counts: {} } }), ClientError);
});

test("app events become counters and backfill runs once", () => {
  const counters = memoryCounters();
  const at = "2026-11-09T12:00:00.000Z";
  const events = [
    { event_type: "app_launch", app_version: "0.8.7", received_at: at, payload: { first_run: true } },
    { event_type: "stream_downloaded", received_at: at, payload: { job_kind: "video", platform: "twitch", streamer: "Ninja", output_bytes: 5e6, media_seconds: 60, mode: "vod" } },
    { event_type: "job_finished", received_at: at, payload: { outcome: "error", job_kind: "video", platform: "kick", features: ["fetchr_mute"] } },
    { event_type: "screen_views", received_at: at, payload: { counts: { queue: 4 } } },
  ];
  assert.equal(createAppCounter(counters).start(events), true);
  assert.equal(createAppCounter(counters).start(events), false);
  const counts = today(counters);
  assert.equal(counts["app.installs"], 1);
  assert.equal(counts["app.active"], 1);
  assert.equal(counts["app.downloads"], 1);
  assert.equal(counts["app.dl.platform:twitch"], 1);
  assert.equal(counts["app.dl.streamer:ninja"], 1);
  assert.equal(counts["app.feature:fetchr_mute:error"], 1);
  assert.equal(counts["app.screen:queue"], 4);
  createAppCounter(counters).count({ event_type: "app_launch", received_at: "bad" });
});

test("business counts use the latest state of each order and name nobody", () => {
  const days = businessCounts(
    [
      { id: 1, created_at: "2026-11-08T10:00:00Z", status: "pending", plan: "Pro", amount: 300, telegram_user_id: 5 },
      { id: 1, status: "paid", paid_at: "2026-11-09T10:00:00Z", paid_amount: 300 },
      { id: 2, created_at: "2026-11-09T10:00:00Z", status: "paid", method: "free", plan: "trial" },
    ],
    [{ issued_at: "2026-11-09T01:00:00Z", username: "someone" }],
  );
  assert.deepEqual(days["2026-11-09"], { "biz.orders": 1, "biz.paid": 1, "biz.plan:pro": 1, "biz.revenue": 300, "biz.licenses": 1 });
  assert.equal(JSON.stringify(days).includes("someone"), false);
});

test("report compares the period with the one before", () => {
  const counters = memoryCounters();
  counters.bump("site.visitors", 10, "2026-11-09");
  counters.bump("site.visitors", 4, "2026-11-01");
  counters.bump("page:/", 7, "2026-11-09");
  counters.bump("page:/old/", 2, "2026-11-01");
  counters.bump("ev:grab_job:youtube", 3, "2026-11-09");
  counters.bump("app.feature:chat_render:done", 5, "2026-11-09");
  counters.bump("app.feature:chat_render:error", 1, "2026-11-09");
  counters.bump("app.feature:chat_render:done", 2, "2026-11-01");
  const report = buildReport({ counters, days: 7, now: NOW, business: { "2026-11-09": { "biz.paid": 2 } } });
  assert.equal(report.calendar.length, 7);
  assert.equal(report.calendar.at(-1), "2026-11-09");
  assert.equal(report.totals["site.visitors"].value, 10);
  assert.equal(report.totals["site.visitors"].prev, 4);
  assert.equal(report.totals["biz.paid"].value, 2);
  assert.deepEqual(report.breakdowns.pages.map((row) => row.key), ["/", "/old/"]);
  assert.deepEqual(report.grab_platforms, [{ key: "youtube", value: 3, prev: 0 }]);
  assert.deepEqual(report.features, [{ key: "chat_render", done: 5, error: 1, cancelled: 0, prev: 2 }]);
  assert.equal(report.breakdowns.site_events.length, 0);
});

test("a flood of distinct keys folds into the group's (other)", () => {
  const counters = memoryCounters();
  for (let i = 0; i < 400; i++) counters.bump(`page:/junk-${i}/`);
  counters.bump("site.visitors");
  const counts = today(counters);
  assert.equal(Object.keys(counts).filter((key) => key.startsWith("page:")).length, 301);
  assert.equal(counts["page:(other)"], 100);
  assert.equal(counts["site.visitors"], 1);
});

test("an update within the month is not a second active device; absurd sizes are ignored", () => {
  const counters = memoryCounters();
  const app = createAppCounter(counters);
  const at = "2026-11-09T12:00:00.000Z";
  app.count({ event_type: "app_launch", telemetry_id: "A", app_version: "0.8.7", received_at: at, payload: {} });
  app.count({ event_type: "app_launch", telemetry_id: "A", app_version: "0.8.8", received_at: at, payload: {} });
  app.count({ event_type: "stream_downloaded", received_at: at, payload: { output_bytes: 1e308, media_seconds: 1e9 } });
  const counts = today(counters);
  assert.equal(counts["app.active"], 1);
  assert.equal(counts["app.version:0.8.8"], 1);
  assert.equal(counts["app.dl.bytes"], undefined);
  assert.equal(counts["app.dl.seconds"], undefined);
});

test("event values are letters only and junk cannot evict other events", () => {
  const counters = memoryCounters();
  const hits = createSiteHits({ counters, now: () => NOW, perIp: { limit: 10_000, windowMs: 60_000 } });
  const letters = "abcdefghijklmnopqrst";
  hits.ingest({ t: "ev", e: "bot_click", v: "web_abc123" }, { ip: "1", ua: CHROME, headers: BROWSER });
  for (let i = 0; i < 400; i++) hits.ingest({ t: "ev", e: "bot_click", v: `x${letters[i % 20]}${letters[Math.floor(i / 20)]}` }, { ip: "1", ua: CHROME, headers: BROWSER });
  hits.ingest({ t: "ev", e: "buy_click" }, { ip: "1", ua: CHROME, headers: BROWSER });
  const counts = today(counters);
  assert.equal(Object.keys(counts).some((key) => key.includes("web")), false);
  assert.equal(counts["ev:buy_click"], 1);
});

test("archive rows fill the days the raw log no longer holds, once", () => {
  const counters = memoryCounters();
  const events = [{ event_type: "stream_downloaded", received_at: "2026-11-01T10:00:00.000Z", payload: { job_kind: "video", platform: "kick" } }];
  const aggregates = {
    downloads: [
      { day: "2026-06-01", streamer: "a", platform: "twitch", downloads: 5, bytes: 1e9, seconds: 600 },
      { day: "2026-11-01", streamer: "b", platform: "kick", downloads: 1, bytes: 0, seconds: 0 },
    ],
  };
  assert.equal(createAppCounter(counters).start(events, aggregates), true);
  assert.equal(createAppCounter(counters).start(events, aggregates), false);
  const june = counters.range("2026-06-01", "2026-06-01")[0].counts;
  assert.equal(june["app.downloads"], 5);
  assert.equal(june["app.dl.platform:twitch"], 5);
  assert.equal(counters.range("2026-11-01", "2026-11-01")[0].counts["app.downloads"], 1);
});

test("nginx log lines become the beacon's counters, before the cutoff only", async () => {
  const { countLogLines } = await import("./nginx-import.mjs");
  const line = (ip, day, path, status, ref, ua) => `${ip} - - [${day}/Nov/2026:10:00:00 +0000] "GET ${path} HTTP/1.1" ${status} 123 "${ref}" "${ua}"`;
  const { days } = countLogLines([
    line("1.1.1.1", "05", "/?utm_source=vk_ads", 200, "https://yandex.ru/", CHROME),
    line("1.1.1.1", "05", "/skachat-strim-s-twitch/", 200, "https://fetchr.fun/", CHROME),
    line("2.2.2.2", "05", "/assets/x.css", 200, "-", CHROME),
    line("3.3.3.3", "05", "/", 200, "-", "Googlebot/2.1"),
    line("4.4.4.4", "05", "/downloads/Fetchr-Setup-latest.exe", 200, "-", CHROME),
    line("5.5.5.5", "05", "/api/downloads/Fetchr-Setup-latest.exe", 200, "-", "reqwest/0.12"),
    line("1.1.1.1", "05", "/api/updates/latest", 200, "https://fetchr.fun/", CHROME),
    line("6.6.6.6", "05", "/skachat-strim-s-twitch/", 200, "-", CHROME),
    line("1.1.1.1", "09", "/", 200, "-", CHROME),
    "garbage",
  ], { beforeDay: "2026-11-09" });
  assert.deepEqual(Object.keys(days), ["2026-11-05"]);
  const d = days["2026-11-05"];
  assert.equal(d["site.pageviews"], 2);
  assert.equal(d["site.visitors"], 1);
  assert.equal(d["ref:yandex"], 1);
  assert.equal(d["utm:vk_ads"], 1);
  assert.equal(d["site.bots"], 2);
  assert.equal(d["bot:no_js"], 1);
  assert.equal(d["bot:agent"], 1);
  assert.equal(d["dl.site"], 1);
  assert.equal(d["dl.app"], 1);
  assert.equal(d["dl.file:fetchr-setup-latest.exe"], 2);
});

test("report says from which day each metric exists", () => {
  const counters = memoryCounters();
  counters.bump("site.visitors", 3, "2026-10-20");
  counters.bump("app.backfilled", 1, "0000-00-00");
  const report = buildReport({ counters, days: 7, now: NOW });
  assert.equal(report.since["site.visitors"], "2026-10-20");
  assert.equal(report.since["ev:download_click"], undefined);
});

test("each site page gets its own traffic and downloads", () => {
  const counters = memoryCounters();
  const hits = createSiteHits({ counters, now: () => NOW });
  const page = "/skachat-video-s-tiktok/";
  hits.ingest({ t: "pv", p: page }, { ip: "1", ua: CHROME, headers: BROWSER });
  hits.ingest({ t: "pv", p: page }, { ip: "1", ua: CHROME, headers: BROWSER });
  hits.ingest({ t: "pv", p: page }, { ip: "2", ua: IPHONE, headers: BROWSER });
  hits.ingest({ t: "pv", p: "/" }, { ip: "1", ua: CHROME, headers: BROWSER });
  hits.ingest({ t: "ev", e: "grab_job", v: "tiktok", k: "video", p: page }, { ip: "1", ua: CHROME, headers: BROWSER });
  hits.ingest({ t: "ev", e: "grab_job", v: "tiktok", k: "audio", p: page }, { ip: "2", ua: IPHONE, headers: BROWSER });
  hits.ingest({ t: "ev", e: "grab_error", v: "tiktok", k: "audio", p: page }, { ip: "2", ua: IPHONE, headers: BROWSER });
  counters.bump(`dlpage:${page}`, 2);
  const report = buildReport({ counters, days: 7, now: NOW });
  const row = report.pages_detail.find((item) => item.path === page);
  assert.equal(row.views, 3);
  assert.equal(row.visitors, 2);
  assert.equal(row.entries, 2);
  assert.equal(row.grab_jobs, 2);
  assert.equal(row.grab_errors, 1);
  assert.equal(row.installer, 2);
  assert.deepEqual(row.platforms, { tiktok: 2 });
  assert.deepEqual(row.kinds, { video: 1, audio: 1 });
  assert.equal(report.pages_detail.find((item) => item.path === "/").visitors, 1);
  assert.deepEqual(report.grab_kinds.map((item) => item.key).sort(), ["audio", "video"]);
});

test("nginx import attributes grab calls and installer downloads to pages", async () => {
  const { countLogLines } = await import("./nginx-import.mjs");
  const line = (method, path, status, ref, ua) => `9.9.9.9 - - [05/Nov/2026:10:00:00 +0000] "${method} ${path} HTTP/1.1" ${status} 1 "${ref}" "${ua}"`;
  const { days } = countLogLines([
    line("POST", "/api/grab/jobs", 200, "https://fetchr.fun/skachat-video-s-vk/", CHROME),
    line("POST", "/api/grab/info", 200, "https://fetchr.fun/skachat-video-s-vk/", CHROME),
    line("POST", "/api/grab/jobs", 429, "https://fetchr.fun/skachat-video-s-vk/", CHROME),
    line("GET", "/downloads/Fetchr-Setup-latest.exe", 200, "https://fetchr.fun/skachat-strim-s-twitch/", CHROME),
  ], { beforeDay: "2026-11-09" });
  const d = days["2026-11-05"];
  assert.equal(d["evpage:grab_job:/skachat-video-s-vk/"], 1);
  assert.equal(d["evpage:grab_info:/skachat-video-s-vk/"], 1);
  assert.equal(d["ev:grab_job"], 1);
  assert.equal(d["dlpage:/skachat-strim-s-twitch/"], 1);
});

test("requests that are not a person's browser are counted as robots", () => {
  assert.equal(robotReason(CHROME, BROWSER), null);
  assert.equal(robotReason("", BROWSER), "no_agent");
  assert.equal(robotReason("Mozilla/5.0 (compatible; YandexBot/3.0)", BROWSER), "agent");
  assert.equal(robotReason("Mozilla/5.0 HeadlessChrome/120", BROWSER), "agent");
  assert.equal(robotReason("axios/1.7", BROWSER), "agent");
  assert.equal(robotReason(`${CHROME} YaBrowser/24.1`, BROWSER), null);
  assert.equal(robotReason(CHROME, {}), "no_language");
  assert.equal(robotReason(CHROME, { ...BROWSER, "sec-fetch-site": "cross-site" }), "cross_site");
  assert.equal(robotReason(CHROME, { ...BROWSER, origin: "https://evil.example" }), "cross_site");

  const counters = memoryCounters();
  const hits = createSiteHits({ counters, now: () => NOW });
  hits.ingest({ t: "pv", p: "/" }, { ip: "1", ua: CHROME, headers: {} });
  const counts = today(counters);
  assert.equal(counts["site.pageviews"], undefined);
  assert.equal(counts["bot:no_language"], 1);
});

test("a visitor paging through everything stops counting", () => {
  const counters = memoryCounters();
  const hits = createSiteHits({ counters, now: () => NOW, perIp: { limit: 10_000, windowMs: 60_000 } });
  for (let i = 0; i < 100; i++) hits.ingest({ t: "pv", p: `/p${i}/`, i: 1 }, { ip: "7", ua: CHROME, headers: BROWSER });
  const counts = today(counters);
  assert.equal(counts["site.pageviews"], 80);
  assert.equal(counts["site.engaged"], 80);
  assert.equal(counts["bot:too_many_views"], 20);
  assert.equal(counts["site.visitors"], 1);
});

test("a gauge keeps its last value instead of summing", () => {
  const counters = memoryCounters();
  const report = buildReport({ counters, days: 7, now: NOW, gauges: { "tg.members": { "2026-10-30": 90, "2026-11-04": 100, "2026-11-08": 120 } } });
  assert.deepEqual(report.totals["tg.members"], { value: 120, prev: 90 });
  assert.equal(report.series["tg.members"].at(-1), 120);
  assert.equal(report.series["tg.members"][0], 90);
  assert.equal(report.since["tg.members"], "2026-10-30");
});
