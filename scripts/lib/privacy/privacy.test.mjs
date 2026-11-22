import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gunzipSync, gzipSync } from "node:zlib";

import { createActivityLog, createConsentLog, createOrderStore, createTicketStore, readJsonLines } from "../bot/store.mjs";
import { createErrorTelemetry } from "../error-telemetry.mjs";
import { createJobLogs } from "../job-logs.mjs";
import { sanitizeTelemetryEvent } from "../telemetry-events.mjs";
import { emptyAggregates, foldEvents, readAggregates, summarize } from "../telemetry-summary.mjs";
import { dataPaths, deleteUser, runCleanup } from "./data-cleanup.mjs";
import { rewriteJsonLines } from "./jsonl-rewrite.mjs";
import { baselineFrom, migrateAll, migrateDownloadEvent, migrateLogText, verifyMigrated } from "./migration.mjs";
import { createPseudonymizer } from "./pseudonym.mjs";
import { maskDeep, maskSensitiveText } from "./redact.mjs";
import { purgeConsents, purgeLicenses, purgeSessions, purgeTelemetry, purgeTickets, releaseRevocations } from "./retention.mjs";

const NOW = Date.parse("2026-11-03T12:00:00Z");
const DAY = 86_400_000;
const ago = (days) => new Date(NOW - days * DAY).toISOString();
const MACHINE = "0123456789ABCDEF0123456789ABCDEF";
const tempDir = () => mkdtempSync(join(tmpdir(), "fetchr-privacy-"));
const jsonl = (records) => records.map((record) => `${JSON.stringify(record)}\n`).join("");

function pathsIn(dir) {
  return dataPaths({ FETCHR_VPS_DATA_DIR: dir });
}

const download = (receivedAt, payload = {}) => ({
  event_type: "stream_downloaded",
  app_version: "0.9.0",
  received_at: receivedAt,
  payload: { job_id: `job-${Math.random()}`, platform: "twitch", streamer: "Somebody", output_bytes: 2e9, media_seconds: 3600, ...payload },
});

// ---- redaction

test("logs lose URLs with parameters, user paths, tokens and addresses", () => {
  const masked = maskSensitiveText(
    [
      "GET https://usher.ttvnw.net/api/channel/hls/x.m3u8?sig=abc&token=def failed",
      "usher.ttvnw.net/vod/x.m3u8?sig=abc123",
      "open C:\\Users\\Иван Петров\\Videos\\clip.mp4",
      "open /home/bob/videos/clip.mp4 now",
      "Authorization: Bearer abc.def",
      "Cookie: auth-token=secret1; persistent=secret2",
      "token=shortvalue",
      "key FTR1.eyJwYXlsb2Fk.c2lnbmF0dXJl",
      `machine ${MACHINE}`,
      "mail bob@example.com from 10.20.30.40:8080",
    ].join("\n"),
  );
  for (const leak of ["sig=abc", "def", "Иван", "bob", "secret1", "secret2", "shortvalue", "eyJwYXlsb2Fk", MACHINE, "10.20.30.40"]) {
    assert.ok(!masked.includes(leak), `${leak} leaked: ${masked}`);
  }
  assert.match(masked, /<url:usher\.ttvnw\.net>/);
});

test("the leaks and damage the first version of the mask had", () => {
  for (const [line, leak] of [
    ["proxy alice:hunter2@10.0.0.1", "hunter2"],
    ["from 2001:db8::1 ok", "2001:db8"],
    ["at \\Users\\Bob Smith\\clip.mp4 x", "Bob"],
    ["at /Volumes/Bob/clip.mp4 x", "Bob"],
    ["at C:\\Users\\O'Brien\\clip.mp4 x", "Brien"],
    ["bare AbC123dEf456gHi789jKl012", "AbC123"],
    ["[youtube] dQw4w9WgXcQ: Downloading", "dQw4w9WgXcQ"],
    ["id 550e8400-e29b-41d4-a716-446655440000", "550e8400"],
  ]) {
    assert.ok(!maskSensitiveText(line).includes(leak), `${line} -> ${maskSensitiveText(line)}`);
  }
  assert.equal(maskSensitiveText("C:\\Users\\Bob\\x.mp4 failed with code 1"), "<path>.mp4 failed with code 1");
  assert.equal(maskSensitiveText("session: started"), "session: started");
  assert.equal(maskSensitiveText("[download] Destination: <path>.mp4"), "[download] Destination: <path>.mp4");
});

test("the daily job leaves the old log alone until it is migrated", async () => {
  const paths = seedOld(tempDir());
  const before = readFileSync(paths.telemetry, "utf8");
  const lines = [];
  assert.equal(await runCleanup(paths, { now: NOW, log: (line) => lines.push(line) }), 1);
  assert.equal(readFileSync(paths.telemetry, "utf8"), before);
  assert.equal(existsSync(paths.aggregates), false);
  assert.ok(lines.some((line) => line.includes("run vps-data-migrate-privacy.mjs first")));
  await migrateAll(paths, { now: NOW, log: () => {} });
  assert.equal((await readAggregates(paths.aggregates)).baseline.app_devices, 2);
});

test("an unreadable job log fails the migration check", async () => {
  const paths = seedOld(tempDir());
  writeFileSync(join(paths.jobLogs, "2026-11-01", "101011_ABCDEF01_error_video_bbbbbbbb.log.gz"), "not gzip");
  await migrateAll(paths, { now: NOW, log: () => {} });
  assert.ok(verifyMigrated(paths).some((problem) => problem.includes("unreadable")));
});

test("what the client already scrubbed stays readable", () => {
  const line = "ffmpeg exited with code 1 at <path>.mp4 from <url:example.com> at app:/assets/index.js:10:5";
  assert.equal(maskSensitiveText(line), line);
  assert.deepEqual(maskDeep({ a: ["x", 1], b: { c: "token=abc" } }), { a: ["x", 1], b: { c: "token=<secret>" } });
});

test("the reporter id cannot be recomputed without the secret and is stable with it", () => {
  const one = createPseudonymizer({ secret: "a" });
  assert.equal(one(MACHINE), createPseudonymizer({ secret: "a" })(MACHINE));
  assert.notEqual(one(MACHINE), createPseudonymizer({ secret: "b" })(MACHINE));
  assert.match(one(MACHINE), /^[A-F0-9]{32}$/);
  assert.notEqual(one(MACHINE), MACHINE);
  assert.notEqual(createPseudonymizer()(MACHINE), createPseudonymizer()(MACHINE), "no secret: a key per process");
});

// ---- ingest

test("a download event stores no id, no query and only hour-level times", () => {
  const clean = sanitizeTelemetryEvent({
    event_type: "stream_downloaded",
    machine_id: MACHINE,
    telemetry_id: "F".repeat(32),
    sent_at: "2026-11-03T10:37:59.123Z",
    payload: {
      job_id: "j",
      url_hash: "deadbeef",
      source_url_hint: "https://cdn.example/x.m3u8?token=secret",
      finished_at: Date.parse("2026-11-03T10:37:59Z"),
      title: "Стрим",
    },
  });
  assert.equal(clean.machine_id, undefined);
  assert.equal(clean.telemetry_id, undefined, "downloads need no id");
  assert.equal(clean.sent_at, "2026-11-03T10:00:00.000Z");
  assert.equal(clean.payload.url_hash, undefined);
  assert.equal(clean.payload.source_url_hint, "https://cdn.example/x.m3u8");
  assert.equal(clean.payload.finished_at, Date.parse("2026-11-03T10:00:00Z"));
  assert.equal(clean.payload.title, "Стрим");
});

test("job logs keep no address and no machine id; a reporter id replaces it", async () => {
  const dataDir = tempDir();
  const pseudonym = createPseudonymizer({ secret: "s" });
  const logs = createJobLogs({ dataDir, pseudonym });
  await logs.ingest(
    {
      log_id: "11111111-1111-4111-8111-111111111111",
      machine_id: MACHINE,
      kind: "video",
      status: "error",
      name: "C:\\Users\\Bob\\clip.mp4",
      source: "https://site.example/x?token=abc",
      log: "fetch https://site.example/x?token=abc\n",
    },
    "1.2.3.4",
  );
  const [entry] = await logs.list();
  const text = await logs.read(entry.path);
  assert.doesNotMatch(text, /IP/);
  assert.ok(!text.includes(MACHINE));
  assert.ok(!text.includes("token=abc"));
  assert.ok(!text.includes("Bob"));
  assert.ok(text.includes(pseudonym(MACHINE)));
  assert.equal(entry.machine, pseudonym(MACHINE).slice(0, 8));
});

test("error reports are stored under the reporter id, masked", async () => {
  const dataDir = tempDir();
  const pseudonym = createPseudonymizer({ secret: "s" });
  const errors = createErrorTelemetry({ dataDir, adminToken: "x", pseudonym });
  await errors.ingest(
    {
      machine_id: MACHINE,
      reports: [{ fingerprint: "a".repeat(32), source: "log", level: "error", count: 1, code: "c", message: "at C:\\Users\\Bob\\a.mp4", context: { url: "https://x.example/?token=abc" } }],
    },
    "1.2.3.4",
  );
  const [row] = readJsonLines(join(dataDir, "errors.jsonl"));
  assert.equal(row.machine_id, pseudonym(MACHINE));
  assert.ok(!JSON.stringify(row).includes("Bob"));
  assert.ok(!JSON.stringify(row).includes("token=abc"));
});

// ---- aggregates

test("the site's numbers are the same from aggregates as from raw events", () => {
  const events = [
    download("2026-10-01T10:00:00.000Z", { streamer: "@Somebody", thumbnail: "https://i.ytimg.com/vi/a/h.jpg", source_url_hint: "https://twitch.tv/x/1" }),
    download("2026-10-01T11:00:00.000Z", { streamer: "somebody", source_url_hint: "https://twitch.tv/x/1" }),
    download("2026-10-30T11:00:00.000Z", { platform: "kick", streamer: "other", output_bytes: 1e9, media_seconds: 1800 }),
    download("2026-11-02T11:00:00.000Z", { platform: "youtube", streamer: "", source_url_hint: "https://youtu.be/q" }),
    download("2026-11-03T09:00:00.000Z", { job_kind: "chat" }),
    download("2026-11-03T09:00:00.000Z", { output_bytes: 10 }),
    download("2026-11-03T10:00:00.000Z", { streamer: "Other", platform: "kick" }),
    { event_type: "app_launch", app_version: "0.9.0", telemetry_id: "A".repeat(32), received_at: "2026-11-03T10:00:00.000Z", payload: { first_run: true } },
    { event_type: "app_launch", app_version: "0.9.0", telemetry_id: "B".repeat(32), received_at: "2026-11-02T10:00:00.000Z", payload: {} },
  ];
  const base = { ...emptyAggregates(), baseline: { app_devices: 100, app_launches: 150, devices_by_version: { "0.8.0": 90 } } };
  const allRaw = summarize(foldEvents(base, events), NOW);

  // A daily rollup in the middle changes nothing: yesterday's folded, today's live.
  const rolled = foldEvents(base, events, { throughDay: "2026-11-02" });
  const fromAggregates = summarize(foldEvents(rolled, events), NOW);
  assert.deepEqual(fromAggregates, allRaw);

  assert.equal(allRaw.app_downloads, 101);
  assert.equal(allRaw.app_launches, 152);
  assert.equal(allRaw.downloaded_streams, 5);
  assert.equal(allRaw.downloaded_bytes, 2e9 * 2 + 1e9 + 2e9 + 2e9);
  assert.equal(allRaw.downloaded_hours, 4.5);
  assert.deepEqual(allRaw.stream_downloads_by_platform, { twitch: 2, kick: 2, youtube: 1 });
  assert.equal(allRaw.downloads_last_7d, 3);
  assert.deepEqual(allRaw.top_streamers.map((row) => [row.streamer, row.downloads, row.platform]), [["other", 2, "kick"], ["somebody", 2, "twitch"]]);
  assert.equal(allRaw.top_streamers[1].preview_url, "https://i.ytimg.com/vi/a/h.jpg");
  assert.match(allRaw.top_streamers[1].avatar_url, /unavatar\.io\/twitch\/somebody/);
  assert.equal(allRaw.app_devices_by_version["0.8.0"], 90);
  assert.equal(allRaw.app_devices_by_version["0.9.0"], 2);
});

test("aggregates hold no ids, titles or URLs", () => {
  const rolled = foldEvents(emptyAggregates(), [
    download("2026-10-01T10:00:00.000Z", { title: "Секретный стрим", source_url_hint: "https://twitch.tv/a/b" }),
    { event_type: "app_launch", telemetry_id: "A".repeat(32), received_at: "2026-10-01T10:00:00.000Z", payload: {} },
  ], { throughDay: "2026-10-02" });
  const text = JSON.stringify(rolled);
  for (const leak of ["Секретный", "twitch.tv/a", "AAAA", "job-"]) assert.ok(!text.includes(leak), leak);
});

// ---- rewriting a live file

test("lines appended during a rewrite survive it", async () => {
  const path = join(tempDir(), "live.jsonl");
  writeFileSync(path, jsonl([{ n: 1 }, { n: 2 }]));
  const result = await rewriteJsonLines(
    path,
    (records) => {
      // Another process appends while this one is working.
      appendFileSync(path, `${JSON.stringify({ n: 3 })}\n`);
      return records.filter((record) => record.n !== 1);
    },
    { settleMs: 10 },
  );
  assert.equal(result.removed, 1);
  assert.deepEqual(readJsonLines(path).map((record) => record.n), [2, 3]);
});

test("a broken line is dropped and counted, a half-written last line is left alone", async () => {
  const path = join(tempDir(), "torn.jsonl");
  writeFileSync(path, `${JSON.stringify({ n: 1 })}\nnot json\n{"n":`);
  const result = await rewriteJsonLines(path, (records) => records, { settleMs: 0 });
  assert.equal(result.malformed, 1);
  assert.equal(readFileSync(path, "utf8"), `${JSON.stringify({ n: 1 })}\n{"n":`);
});

test("nothing is written when nothing changes", async () => {
  const path = join(tempDir(), "same.jsonl");
  writeFileSync(path, jsonl([{ n: 1 }]));
  assert.equal((await rewriteJsonLines(path, (records) => records)).changed, false);
  assert.deepEqual(await rewriteJsonLines(join(tempDir(), "absent.jsonl"), () => []), { before: 0, after: 0, removed: 0, malformed: 0, changed: false });
});

// ---- retention rules

test("licenses: live keys stay, keys revoked over 30 days ago go with their first line", () => {
  const live = { machine_id: "A", license_key: "K1", telegram_user_id: 1, issued_at: ago(400) };
  const recent = { machine_id: "B", license_key: "K2", telegram_user_id: 2, issued_at: ago(100) };
  const recentRevoked = { ...recent, revoked_at: ago(29) };
  const old = { machine_id: "C", license_key: "K3", telegram_user_id: 3, issued_at: ago(100) };
  const oldRevoked = { ...old, revoked_at: ago(31) };
  const reissued = { machine_id: "D", license_key: "K4", telegram_user_id: 4, issued_at: ago(90) };
  const reissuedRevoked = { ...reissued, revoked_at: ago(40) };
  const reissuedAgain = { ...reissued, issued_at: ago(20) };
  assert.deepEqual(
    purgeLicenses([live, recent, recentRevoked, old, oldRevoked, reissued, reissuedRevoked, reissuedAgain], NOW),
    [live, recent, recentRevoked, reissuedAgain],
  );
});

test("a release revokes old live keys, which then expire and free the device slot", () => {
  const cutoff = NOW - DAY;
  const old = { machine_id: "A", license_key: "K1", telegram_user_id: 1, issued_at: ago(100) };
  const fresh = { machine_id: "B", license_key: "K2", telegram_user_id: 2, issued_at: ago(0) };
  const gone = { machine_id: "C", license_key: "K3", telegram_user_id: 3, issued_at: ago(100), revoked_at: ago(50) };
  const replaced = { machine_id: "D", license_key: "K4", telegram_user_id: 4, issued_at: ago(100) };
  const replacement = { machine_id: "D", license_key: "K5", telegram_user_id: 4, issued_at: ago(0) };
  const records = [old, fresh, gone, replaced, replacement];

  const lines = releaseRevocations(records, cutoff, NOW);
  assert.deepEqual(lines.map((line) => line.license_key), ["K1"]);
  assert.equal(lines[0].revoked_by, "release");

  const after = [...records, ...lines];
  assert.deepEqual(releaseRevocations(after, cutoff, NOW), [], "running it twice adds nothing");
  const later = purgeLicenses(after, NOW + 31 * DAY);
  assert.ok(!later.some((record) => record.license_key === "K1"), "the old key and the names in it are gone");
  assert.ok(later.some((record) => record.license_key === "K2"));
});

test("consents stay while the account exists and go with it", () => {
  const records = [
    { user_id: 1, at: ago(500) },
    { user_id: 2, at: ago(500) },
    { user_id: 3, at: ago(5) },
  ];
  assert.deepEqual(purgeConsents(records, new Set([1]), NOW).map((r) => r.user_id), [1, 3]);
});

test("tickets expire 90 days after the last message and never reuse a number", () => {
  const records = [
    { type: "ticket", id: 1, user_id: 7, created_at: ago(200) },
    { type: "link", ticket_id: 1, chat_id: 7, message_id: 1 },
    { type: "ticket", id: 2, user_id: 8, created_at: ago(200) },
    { type: "link", ticket_id: 2, chat_id: 8, message_id: 2, at: ago(10) },
    { type: "ticket", id: 3, user_id: 9, created_at: ago(91) },
  ];
  const kept = purgeTickets(records, NOW);
  assert.deepEqual(kept.filter((e) => e.type === "ticket").map((e) => e.id), [2]);
  assert.deepEqual(kept.filter((e) => e.type === "link").map((e) => e.ticket_id), [2]);
  assert.deepEqual(kept[0], { type: "seq", last_id: 3 });

  const path = join(tempDir(), "tickets.jsonl");
  writeFileSync(path, jsonl([{ type: "seq", last_id: 3 }]));
  assert.equal(createTicketStore(path).open({ user_id: 1 }).id, 4);
  assert.equal(purgeTickets(purgeTickets(records, NOW), NOW).filter((e) => e.type === "seq").length, 1);
});

test("telemetry and sessions expire on their own clocks", () => {
  assert.equal(purgeTelemetry([{ received_at: ago(89) }, { received_at: ago(91) }, {}], NOW).length, 1);
  assert.deepEqual(purgeSessions([{ expires_at: NOW + 1 }, { expires_at: NOW - 1 }], NOW), [{ expires_at: NOW + 1 }]);
});

// ---- the daily job over real files

function seed(dir) {
  const paths = pathsIn(dir);
  writeFileSync(paths.telemetry, jsonl([
    download(ago(120), { streamer: "ancient" }),
    download(ago(10), { streamer: "recent" }),
    download(ago(0), { streamer: "today" }),
  ]));
  writeFileSync(paths.licenses, jsonl([
    { machine_id: "A", license_key: "K1", telegram_user_id: 1, issued_at: ago(300) },
    { machine_id: "B", license_key: "K2", telegram_user_id: 2, issued_at: ago(300), revoked_at: ago(40) },
  ]));
  writeFileSync(paths.orders, jsonl([{ id: "O1", user_id: 5, status: "paid", created_at: ago(700) }]));
  writeFileSync(paths.payments, jsonl([{ inv_id: 1, order_id: "O1", out_sum: "100", received_at: ago(700) }]));
  writeFileSync(paths.activity, jsonl([{ user_id: 1, at: ago(100) }, { user_id: 9, at: ago(120) }, { user_id: 1, at: ago(5) }]));
  writeFileSync(paths.tickets, jsonl([{ type: "ticket", id: 1, user_id: 9, chat_id: 9, created_at: ago(200) }]));
  writeFileSync(paths.consents, jsonl([{ user_id: 1, at: ago(300) }, { user_id: 2, at: ago(300) }, { user_id: 5, at: ago(700) }]));
  writeFileSync(paths.errors, jsonl([{ machine_id: "X", received_at: ago(31) }, { machine_id: "Y", received_at: ago(1) }]));
  writeFileSync(paths.sessions, JSON.stringify([{ hash: "a", user_id: 1, expires_at: NOW + DAY }, { hash: "b", user_id: 1, expires_at: NOW - DAY }]));
  mkdirSync(join(paths.jobLogs, "2026-09-01"), { recursive: true });
  mkdirSync(join(paths.jobLogs, "2026-11-01"), { recursive: true });
  return paths;
}

test("the daily job applies every rule and keeps the site's counts", async () => {
  const paths = seed(tempDir());
  const lines = [];
  assert.equal(await runCleanup(paths, { now: NOW, log: (line) => lines.push(line) }), 0);

  assert.deepEqual(readJsonLines(paths.telemetry).map((e) => e.payload.streamer), ["recent", "today"]);
  assert.deepEqual(readJsonLines(paths.licenses).map((r) => r.license_key), ["K1"]);
  assert.equal(readJsonLines(paths.orders).length, 1, "orders are tax records");
  assert.equal(readJsonLines(paths.payments).length, 1, "payments are tax records");
  assert.deepEqual(readJsonLines(paths.activity).map((r) => r.at), [ago(5)]);
  assert.deepEqual(readJsonLines(paths.tickets).filter((e) => e.type === "ticket"), []);
  assert.deepEqual(readJsonLines(paths.consents).map((r) => r.user_id), [1, 5]);
  assert.equal(readJsonLines(paths.errors).length, 1);
  assert.deepEqual(JSON.parse(readFileSync(paths.sessions, "utf8")).map((s) => s.hash), ["a"]);
  assert.deepEqual(readdirSync(paths.jobLogs), ["2026-11-01"]);
  assert.ok(lines.some((line) => line.includes('"removed":1') && line.includes("telemetry.jsonl")), lines.join("\n"));

  const summary = summarize(foldEvents(await readAggregates(paths.aggregates), readJsonLines(paths.telemetry)), NOW);
  assert.equal(summary.downloaded_streams, 3, "an expired event stays counted");
  assert.deepEqual(summary.top_streamers.map((row) => row.streamer).sort(), ["ancient", "recent", "today"]);

  // Twice in a row is harmless.
  assert.equal(await runCleanup(paths, { now: NOW, log: () => {} }), 0);
  const again = summarize(foldEvents(await readAggregates(paths.aggregates), readJsonLines(paths.telemetry)), NOW);
  assert.equal(again.downloaded_streams, 3);
});

test("/stats keeps its history after activity lines expire", async () => {
  const paths = seed(tempDir());
  const before = createActivityLog(paths.activity, { now: () => NOW }).monthly(6);
  await runCleanup(paths, { now: NOW, log: () => {} });
  const activity = createActivityLog(paths.activity, { archivePath: paths.activityArchive, now: () => NOW });
  const after = activity.monthly(6);
  for (const { month, users } of before) {
    assert.ok(after.find((row) => row.month === month).users >= users, month);
  }
  assert.ok(activity.total() >= 1);
});

test("a broken aggregates file stops the raw events from expiring", async () => {
  const paths = seed(tempDir());
  writeFileSync(paths.aggregates, "{broken");
  const lines = [];
  const failed = await runCleanup(paths, { now: NOW, log: (line) => lines.push(line) });
  assert.equal(failed, 1);
  assert.equal(readJsonLines(paths.telemetry).length, 3);
  assert.equal(readFileSync(paths.aggregates, "utf8"), "{broken");
  assert.deepEqual(readJsonLines(paths.licenses).map((r) => r.license_key), ["K1"], "other steps still run");
});

test("a dry run reports and writes nothing", async () => {
  const paths = seed(tempDir());
  const before = readFileSync(paths.licenses, "utf8");
  await runCleanup(paths, { now: NOW, dryRun: true, log: () => {} });
  assert.equal(readFileSync(paths.licenses, "utf8"), before);
  assert.equal(existsSync(paths.aggregates), false);
});

test("deleting a user removes everything but the tax records", async () => {
  const paths = seed(tempDir());
  await deleteUser(paths, 1, { log: () => {} });
  assert.deepEqual(readJsonLines(paths.licenses).map((r) => r.telegram_user_id), [2]);
  assert.deepEqual(readJsonLines(paths.consents).map((r) => r.user_id), [2, 5]);
  assert.deepEqual(readJsonLines(paths.activity).map((r) => r.user_id), [9]);
  assert.deepEqual(JSON.parse(readFileSync(paths.sessions, "utf8")), []);
  await deleteUser(paths, 5, { log: () => {} });
  assert.equal(readJsonLines(paths.orders).length, 1);
});

// ---- bot stores

test("an old order's profile fields are not written back by an update", () => {
  const path = join(tempDir(), "orders.jsonl");
  writeFileSync(path, jsonl([{ id: "O1", user_id: 5, chat_id: 5, username: "neo", first_name: "Thomas", status: "pending" }]));
  createOrderStore(path).update("O1", { status: "paid" });
  const last = readJsonLines(path).at(-1);
  assert.equal(last.status, "paid");
  for (const field of ["chat_id", "username", "first_name"]) assert.equal(last[field], undefined, field);
});

test("a consent deleted by the job is asked for again without a restart", () => {
  const path = join(tempDir(), "consents.jsonl");
  const consents = createConsentLog(path, { version: "1" });
  consents.give(1);
  assert.equal(consents.has(1), true);
  writeFileSync(path, "");
  assert.equal(consents.has(1), false);
});

// ---- migration

function seedOld(dir) {
  const paths = pathsIn(dir);
  const old = (fields) => ({ app_version: "0.8.0", channel: "beta", machine_id: MACHINE, sent_at: "2026-10-01T10:37:59Z", received_at: "2026-10-01T10:38:00.123Z", ...fields });
  writeFileSync(paths.telemetry, jsonl([
    old({ event_type: "app_launch", payload: {} }),
    old({ event_type: "app_launch", machine_id: "F".repeat(32), payload: {} }),
    old({ event_type: "stream_downloaded", payload: { job_id: "j1", url_hash: "h", streamer: "alice", platform: "twitch", title: "T", output_bytes: 2e9, media_seconds: 3600, finished_at: 1790000123456, source_url_hint: "https://twitch.tv/alice?x=1" } }),
    old({ event_type: "stream_downloaded", received_at: new Date(NOW).toISOString(), payload: { job_id: "j2", streamer: "bob", platform: "kick", output_bytes: 3e9 } }),
  ]));
  writeFileSync(paths.licenses, jsonl([{ machine_id: MACHINE, license_key: "K1", telegram_user_id: 1, username: "neo", first_name: "Thomas", last_name: "A", issued_at: ago(10) }]));
  writeFileSync(paths.orders, jsonl([{ id: "O1", user_id: 5, chat_id: 5, username: "neo", first_name: "Thomas", amount: 100, status: "paid" }]));
  writeFileSync(paths.payments, jsonl([{ inv_id: 1, order_id: "O1", out_sum: "100", email: "buyer@example.com", received_at: ago(1) }]));
  writeFileSync(paths.errors, jsonl([{ machine_id: "A".repeat(32), message: "at C:\\Users\\Bob\\a.mp4", context: { line: "token=abc" }, received_at: ago(1) }]));
  const dir2 = join(paths.jobLogs, "2026-11-01");
  mkdirSync(dir2, { recursive: true });
  const header = ["Получен: x", "Машина: ABCDEF0123456789ABCDEF0123456789", "IP (хэш): 0123456789ab", "Задача: clip", "Источник: <url:twitch.tv>"].join("\n");
  writeFileSync(join(dir2, "101010_ABCDEF01_error_video_aaaaaaaa.log.gz"), gzipSync(`${header}\n\nfetch https://x.example/?token=abc\n`));
  return paths;
}

test("migration removes the fields, keeps the public numbers and cannot be run twice over the baseline", async () => {
  const paths = seedOld(tempDir());
  await migrateAll(paths, { now: NOW, log: () => {} });

  assert.deepEqual(verifyMigrated(paths), []);
  const events = readJsonLines(paths.telemetry);
  assert.equal(events.length, 2, "launches are in the baseline");
  assert.equal(events[0].received_at, "2026-10-01T10:00:00.000Z");
  assert.equal(events[0].payload.title, "T");
  assert.equal(events[0].payload.source_url_hint, "https://twitch.tv/alice");
  assert.ok(!JSON.stringify(events).includes(MACHINE));

  const summary = summarize(foldEvents(await readAggregates(paths.aggregates), events), NOW);
  assert.equal(summary.app_downloads, 2);
  assert.equal(summary.downloaded_streams, 2, "no double count of today's event");
  assert.equal(summary.downloaded_bytes, 5e9);

  assert.deepEqual(Object.keys(readJsonLines(paths.licenses)[0]).sort(), ["issued_at", "license_key", "machine_id", "telegram_user_id"]);
  assert.deepEqual(Object.keys(readJsonLines(paths.orders)[0]).sort(), ["amount", "id", "status", "user_id"]);
  const payment = readJsonLines(paths.payments)[0];
  assert.equal(payment.email, undefined);
  assert.equal(payment.status, "paid");

  const [row] = readJsonLines(paths.errors);
  assert.notEqual(row.machine_id, "A".repeat(32));
  assert.ok(!JSON.stringify(row).includes("Bob"));

  const [day] = readdirSync(paths.jobLogs);
  const [file] = readdirSync(join(paths.jobLogs, day));
  assert.ok(!file.includes("ABCDEF01"));
  const text = gunzipSync(readFileSync(join(paths.jobLogs, day, file))).toString("utf8");
  assert.doesNotMatch(text, /IP \(хэш\)/);
  assert.ok(!text.includes("ABCDEF0123456789"));
  assert.ok(!text.includes("token=abc"));

  await migrateAll(paths, { now: NOW, log: () => {} });
  const twice = summarize(foldEvents(await readAggregates(paths.aggregates), readJsonLines(paths.telemetry)), NOW);
  assert.equal(twice.app_downloads, 2);
  assert.equal(twice.downloaded_streams, 2);
});

test("a migration stopped half way finishes on the next run with the same baseline", async () => {
  const paths = seedOld(tempDir());
  await migrateAll(paths, { now: NOW, log: () => {} });
  // The crash window: aggregates written, raw log still old; a new launch came in.
  const newLaunch = { event_type: "app_launch", telemetry_id: "A".repeat(32), received_at: new Date(NOW).toISOString(), payload: {} };
  appendFileSync(paths.telemetry, jsonl([{ event_type: "stream_downloaded", machine_id: MACHINE, received_at: "2026-10-01T10:38:00Z", payload: { job_id: "late" } }, newLaunch]));
  await migrateAll(paths, { now: NOW, log: () => {} });
  assert.deepEqual(verifyMigrated(paths), []);
  const events = readJsonLines(paths.telemetry);
  assert.ok(events.some((event) => event.telemetry_id), "launches of new versions stay");
  assert.equal((await readAggregates(paths.aggregates)).baseline.app_devices, 2);
});

test("a migration dry run writes nothing", async () => {
  const paths = seedOld(tempDir());
  const before = readFileSync(paths.telemetry, "utf8");
  await migrateAll(paths, { now: NOW, dryRun: true, log: () => {} });
  assert.equal(readFileSync(paths.telemetry, "utf8"), before);
  assert.equal(existsSync(paths.aggregates), false);
  assert.ok(verifyMigrated(paths).length > 0);
});

test("the pure migration helpers", () => {
  const event = migrateDownloadEvent({ machine_id: MACHINE, received_at: "2026-10-01T10:38:00Z", payload: { url_hash: "h", url: "https://a.example/b?c=d" } });
  assert.equal(event.machine_id, undefined);
  assert.equal(event.payload.url_hash, undefined);
  assert.equal(event.payload.url, "https://a.example/b");
  assert.deepEqual(baselineFrom([
    { event_type: "app_launch", machine_id: "a", app_version: "1" },
    { event_type: "app_launch", machine_id: "A", app_version: "1" },
    { event_type: "stream_downloaded", machine_id: "b", app_version: "2" },
  ]), { app_devices: 1, app_launches: 2, devices_by_version: { 1: 1, 2: 1 } });
  assert.equal(migrateLogText("Машина: X\nIP (хэш): y\n\nbody", "R"), "Машина: R\n\nbody");
});
