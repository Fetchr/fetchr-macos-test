/** One-time rewrite of data stored before the minimisation. Pure transforms plus
 *  the file walk; `scripts/vps-data-migrate-privacy.mjs` adds the backup and CLI.
 *
 *  Old reporter ids get a throwaway key that is never saved, so what is already
 *  stored cannot be matched with machine_id by anyone, the operator included. */

import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";

import { readJsonLines } from "../bot/store.mjs";
import { hourOf } from "../telemetry-events.mjs";
import { emptyAggregates, foldEvents, readAggregates } from "../telemetry-summary.mjs";
import { rewriteJsonLines, writeJsonAtomic } from "./jsonl-rewrite.mjs";
import { createPseudonymizer } from "./pseudonym.mjs";
import { maskDeep, maskSensitiveText } from "./redact.mjs";

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const DAY_DIR = /^\d{4}-\d{2}-\d{2}$/;
const LOG_FILE = /^(\d{6})_([A-F0-9]{8})_(.+\.log\.gz)$/;

export const FORBIDDEN = {
  licenses: ["username", "first_name", "last_name"],
  orders: ["username", "first_name", "chat_id"],
  payments: ["email"],
};

const without = (record, keys) => Object.fromEntries(Object.entries(record).filter(([key]) => !keys.includes(key)));

function stripQuery(value) {
  return typeof value === "string" ? value.split(/[?#]/)[0] : value;
}

/** The download event as it is stored from now on. */
export function migrateDownloadEvent(event) {
  const { machine_id: machineId, ...rest } = event;
  const { url_hash: urlHash, ...payload } = event.payload || {};
  for (const key of ["created_at", "started_at", "finished_at"]) {
    if (typeof payload[key] === "number") payload[key] -= payload[key] % HOUR_MS;
  }
  for (const key of ["source_url_hint", "chat_source_url_hint", "source_url", "url"]) {
    if (key in payload) payload[key] = stripQuery(payload[key]);
  }
  return {
    ...rest,
    ...(event.sent_at ? { sent_at: hourOf(event.sent_at) } : {}),
    received_at: hourOf(event.received_at) ?? event.received_at,
    payload,
  };
}

/** What the old log counted per machine, which cannot be recounted afterwards. */
export function baselineFrom(events) {
  const launchers = new Set();
  const byVersion = new Map();
  let launches = 0;
  for (const event of events) {
    const machine = String(event.machine_id || "").toUpperCase();
    if (event.app_version && machine) {
      byVersion.set(event.app_version, (byVersion.get(event.app_version) ?? new Set()).add(machine));
    }
    if (event.event_type === "app_launch") {
      launches += 1;
      if (machine) launchers.add(machine);
    }
  }
  return {
    app_devices: launchers.size,
    app_launches: launches,
    devices_by_version: Object.fromEntries([...byVersion].map(([version, machines]) => [version, machines.size])),
  };
}

/** Aggregates are written first, so raw events are never gone uncounted; a
 *  second run keeps that baseline and only finishes the rewrite. Today's
 *  downloads stay raw and are folded live; old launches are all in the baseline. */
export async function migrateTelemetry(paths, { now = Date.now(), dryRun = false } = {}) {
  const events = readJsonLines(paths.telemetry);
  const yesterday = new Date(now - DAY_MS).toISOString().slice(0, 10);
  const current = existsSync(paths.aggregates) ? await readAggregates(paths.aggregates) : null;
  const build = !current?.migrated_at && events.some((event) => event.machine_id);
  if (build && !dryRun) {
    writeJsonAtomic(
      paths.aggregates,
      foldEvents(
        { ...emptyAggregates(), migrated_at: new Date(now).toISOString(), baseline: baselineFrom(events) },
        events.filter((event) => event.event_type !== "app_launch"),
        { throughDay: yesterday },
      ),
    );
  }
  const result = await rewriteJsonLines(
    paths.telemetry,
    (records) =>
      records
        .filter((event) => event?.event_type === "stream_downloaded" || event?.telemetry_id)
        .map((event) => (event.event_type === "stream_downloaded" ? migrateDownloadEvent(event) : event)),
    { dryRun, settleMs: 0 },
  );
  return { ...result, aggregates: build ? "built" : "kept", through_day: yesterday };
}

/** "IP (хэш)" goes, the reporter becomes unlinkable, the body is masked. */
export function migrateLogText(text, reporter) {
  const [header, ...body] = text.split("\n\n");
  const lines = header
    .split("\n")
    .filter((line) => !line.startsWith("IP (хэш):"))
    .map((line) => (line.startsWith("Машина:") ? `Машина: ${reporter}` : maskHeaderLine(line)));
  return [lines.join("\n"), maskSensitiveText(body.join("\n\n"))].join("\n\n");
}

const maskHeaderLine = (line) =>
  /^(Задача|Источник|Ошибка):/.test(line) ? maskSensitiveText(line) : line;

export function migrateJobLogs(paths, pseudonym, { dryRun = false } = {}) {
  if (!existsSync(paths.jobLogs)) return { files: 0 };
  let files = 0;
  let failed = 0;
  for (const day of readdirSync(paths.jobLogs).filter((name) => DAY_DIR.test(name))) {
    const dir = join(paths.jobLogs, day);
    for (const name of readdirSync(dir)) {
      const match = LOG_FILE.exec(name);
      if (!match) continue;
      const [, time, machine, rest] = match;
      try {
        const reporter = pseudonym(machine);
        const text = migrateLogText(gunzipSync(readFileSync(join(dir, name))).toString("utf8"), reporter);
        files += 1;
        if (dryRun) continue;
        const temp = join(dir, `${name}.tmp`);
        writeFileSync(temp, gzipSync(text));
        renameSync(temp, join(dir, name));
        renameSync(join(dir, name), join(dir, `${time}_${reporter.slice(0, 8)}_${rest}`));
      } catch {
        failed += 1;
      }
    }
  }
  return { files, failed };
}

export const migrateErrorRow = (row, pseudonym) => ({
  ...row,
  machine_id: pseudonym(row.machine_id),
  message: maskSensitiveText(row.message),
  context: maskDeep(row.context),
});

const hasAny = (record, keys) => keys.some((key) => key in (record || {}));

/** A file that cannot be unpacked was not rewritten and may hold old ids. */
function jobLogProblems(paths) {
  if (!existsSync(paths.jobLogs)) return [];
  const days = readdirSync(paths.jobLogs).filter((name) => DAY_DIR.test(name));
  return days.flatMap((day) =>
    readdirSync(join(paths.jobLogs, day))
      .filter((name) => name.endsWith(".log.gz"))
      .flatMap((name) => {
        try {
          const text = gunzipSync(readFileSync(join(paths.jobLogs, day, name))).toString("utf8");
          return text.includes("IP (хэш):") ? [`job-logs: ${day}/${name} still holds the address hash`] : [];
        } catch {
          return [`job-logs: ${day}/${name} is unreadable; delete it by hand`];
        }
      }),
  );
}

/** Fails loudly: the backup is only deleted after this comes back empty. */
export function verifyMigrated(paths) {
  const problems = [];
  const check = (path, keys, label) => {
    const hits = readJsonLines(path).filter((record) => hasAny(record, keys)).length;
    if (hits) problems.push(`${label}: ${hits} line(s) still hold ${keys.join("/")}`);
  };
  check(paths.licenses, FORBIDDEN.licenses, "licenses");
  check(paths.orders, FORBIDDEN.orders, "orders");
  check(paths.payments, FORBIDDEN.payments, "payments");
  check(paths.telemetry, ["machine_id", "url_hash"], "telemetry");
  return [...problems, ...jobLogProblems(paths)];
}

export async function migrateAll(paths, { now = Date.now(), dryRun = false, log = console.log } = {}) {
  const pseudonym = createPseudonymizer({ secret: randomBytes(32).toString("hex") });
  const options = { dryRun, settleMs: 0 };
  const strip = (keys) => (records) => records.map((record) => without(record, keys));

  log(`telemetry: ${JSON.stringify(await migrateTelemetry(paths, { now, dryRun }))}`);
  log(`licenses: ${JSON.stringify(await rewriteJsonLines(paths.licenses, strip(FORBIDDEN.licenses), options))}`);
  log(`orders: ${JSON.stringify(await rewriteJsonLines(paths.orders, strip(FORBIDDEN.orders), options))}`);
  log(`payments: ${JSON.stringify(await rewriteJsonLines(paths.payments, (records) =>
    records.map((record) => ({ status: "paid", ...without(record, FORBIDDEN.payments) })), options))}`);
  const errors = (records) => records.map((row) => migrateErrorRow(row, pseudonym));
  log(`errors: ${JSON.stringify(await rewriteJsonLines(paths.errors, errors, options))}`);
  log(`errors.1: ${JSON.stringify(await rewriteJsonLines(paths.errorsRotated, errors, options))}`);
  log(`job-logs: ${JSON.stringify(migrateJobLogs(paths, pseudonym, { dryRun }))}`);
}
