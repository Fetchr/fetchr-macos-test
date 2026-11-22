import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createJobLogs, MAX_LOG_CHARS } from "./job-logs.mjs";

const MACHINE = "0123456789ABCDEF0123456789ABCDEF";
const tempDir = () => mkdtempSync(join(tmpdir(), "fetchr-job-logs-"));

let counter = 0;
const body = (overrides = {}) => ({
  log_id: `${String(++counter).padStart(8, "0")}-1111-4111-8111-111111111111`,
  machine_id: MACHINE,
  app_version: "0.7.0",
  channel: "beta",
  os: "windows-x86_64",
  kind: "chat",
  status: "error",
  name: "rachelr_clip",
  error: "ffmpeg exited with 1",
  duration_ms: 12_345,
  log: "line one\nline two\n",
  ...overrides,
});

test("stores a log and reads it back with its header", async () => {
  const logs = createJobLogs({ dataDir: tempDir(), now: () => Date.parse("2026-10-03T12:34:56Z") });
  const result = await logs.ingest(body(), "1.2.3.4");
  assert.equal(result.status, 200);
  const [entry] = await logs.list();
  assert.equal(entry.day, "2026-10-03");
  assert.equal(entry.status, "error");
  assert.equal(entry.kind, "chat");
  const text = await logs.read(entry.path);
  assert.match(text, /Ошибка: ffmpeg exited with 1/);
  assert.match(text, /line two/);
  assert.doesNotMatch(text, /1\.2\.3\.4/, "the client address is not stored");
  assert.doesNotMatch(text, /IP/);
});

test("filters by status and machine prefix", async () => {
  const logs = createJobLogs({ dataDir: tempDir() });
  await logs.ingest(body({ status: "done" }), "ip");
  await logs.ingest(body({ status: "error" }), "ip");
  assert.equal((await logs.list({ status: "done" })).length, 1);
  assert.equal((await logs.list({ machine: "01234567" })).length, 2);
  assert.equal((await logs.list({ machine: "FFFFFFFF" })).length, 0);
});

test("rejects malformed bodies with 400", async () => {
  const logs = createJobLogs({ dataDir: tempDir() });
  for (const bad of [
    body({ machine_id: "nope" }),
    body({ status: "weird" }),
    body({ kind: "../etc" }),
    body({ log: 42 }),
    body({ log: "x".repeat(MAX_LOG_CHARS + 1) }),
  ]) {
    assert.equal((await logs.ingest(bad, "ip")).status, 400);
  }
});

test("a retried log is stored once", async () => {
  const logs = createJobLogs({ dataDir: tempDir() });
  const same = body();
  await logs.ingest(same, "ip");
  const again = await logs.ingest(same, "ip");
  assert.equal(again.body.duplicate, true);
  assert.equal((await logs.list()).length, 1);
});

test("rate limits one machine", async () => {
  const logs = createJobLogs({ dataDir: tempDir(), perMachinePerHour: 2 });
  assert.equal((await logs.ingest(body(), "a")).status, 200);
  assert.equal((await logs.ingest(body(), "b")).status, 200);
  assert.equal((await logs.ingest(body(), "c")).status, 429);
});

test("read refuses anything that is not a stored log path", async () => {
  const logs = createJobLogs({ dataDir: tempDir() });
  for (const path of ["../../etc/passwd", "2026-10-03/../../x", "2026-10-03/a.log.gz", "", null]) {
    assert.equal(await logs.read(path), null);
  }
});

test("prune drops old days and keeps the total under the cap", async () => {
  const dir = tempDir();
  let clock = Date.parse("2026-09-01T00:00:00Z");
  const logs = createJobLogs({ dataDir: dir, maxBytes: 600, retentionDays: 10, now: () => clock });
  await logs.ingest(body({ log: "old" }), "ip");
  clock = Date.parse("2026-10-03T00:00:00Z");
  for (let i = 0; i < 5; i += 1) {
    clock += 1000;
    await logs.ingest(body({ log: `fresh ${i} ${"y".repeat(200)}` }), "ip");
  }
  await logs.prune();
  const left = await logs.list();
  assert.ok(left.every((entry) => entry.day === "2026-10-03"), "the old day is gone");
  assert.ok(left.length < 5, "the oldest fresh logs went first to fit the cap");
});
