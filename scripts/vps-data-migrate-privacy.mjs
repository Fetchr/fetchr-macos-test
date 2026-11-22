#!/usr/bin/env node
// One-time migration to the minimised data format. Stop the services first.
//
//   node scripts/vps-data-migrate-privacy.mjs --dry-run
//   node scripts/vps-data-migrate-privacy.mjs --services-stopped
//   node scripts/vps-data-migrate-privacy.mjs --verify
//   node scripts/vps-data-migrate-privacy.mjs --delete-backup <dir>
//
// Takes a backup (mode 700) next to the data dir, migrates, compares the public
// counters before and after, and prints what is left to do. The backup still
// holds the old personal data: delete it once the site and the bot check out.

import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import { readJsonLines } from "./lib/bot/store.mjs";
import { dataPaths } from "./lib/privacy/data-cleanup.mjs";
import { migrateAll, verifyMigrated } from "./lib/privacy/migration.mjs";
import { foldEvents, readAggregates, summarize } from "./lib/telemetry-summary.mjs";

const BACKUP_PREFIX = "fetchr-privacy-backup-";
/** What the site shows; `unique_streams` (nothing reads it) changes by design. */
const COMPARED = ["app_downloads", "downloaded_streams", "downloaded_bytes", "downloaded_hours", "stream_downloads_by_platform"];

function fileList(paths) {
  return [
    paths.telemetry, paths.aggregates, paths.licenses, paths.orders, paths.payments, paths.errors, paths.errorsRotated,
    paths.tickets, paths.activity, paths.activityArchive, paths.consents, paths.sessions, paths.jobLogs,
  ].filter(existsSync);
}

function takeBackup(paths) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = join(dirname(paths.dataDir), `${BACKUP_PREFIX}${stamp}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  for (const source of fileList(paths)) {
    const target = join(dir, basename(source));
    cpSync(source, target, { recursive: true, preserveTimestamps: true });
    if (statSync(source).isFile() && statSync(source).size !== statSync(target).size) {
      throw new Error(`backup of ${source} is incomplete`);
    }
  }
  return dir;
}

/** The old log's numbers, for comparing with the aggregates afterwards. */
async function publicCounters(paths) {
  return summarize(foldEvents(await readAggregates(paths.aggregates), readJsonLines(paths.telemetry)));
}

/** Only the old log can say this; once it is rewritten the aggregates do. */
function oldCounters(events) {
  if (!events.some((event) => event.machine_id)) return {};
  const machines = new Set(events.filter((e) => e.event_type === "app_launch" && e.machine_id).map((e) => e.machine_id.toUpperCase()));
  return { app_downloads: machines.size };
}

const pick = (summary) => Object.fromEntries(COMPARED.map((key) => [key, summary[key]]));

function deleteBackup(dir) {
  const target = resolve(dir);
  if (!basename(target).startsWith(BACKUP_PREFIX) || !existsSync(target)) {
    throw new Error(`${target} is not a migration backup`);
  }
  rmSync(target, { recursive: true, force: true });
  console.log(`Deleted ${target}`);
}

async function main() {
  const args = process.argv.slice(2);
  const paths = dataPaths();
  const deleting = args.indexOf("--delete-backup");
  if (deleting >= 0) return deleteBackup(args[deleting + 1] || "");

  if (args.includes("--verify")) {
    const problems = verifyMigrated(paths);
    problems.forEach((problem) => console.error(problem));
    console.log(problems.length ? "NOT clean" : "Clean: no removed field is left in the data files.");
    console.log(JSON.stringify(pick(await publicCounters(paths)), null, 2));
    process.exitCode = problems.length ? 1 : 0;
    return;
  }

  if (!existsSync(paths.dataDir)) throw new Error(`Data dir ${paths.dataDir} does not exist; is FETCHR_VPS_DATA_DIR set?`);
  const dryRun = args.includes("--dry-run");
  if (!dryRun && !args.includes("--services-stopped")) {
    throw new Error("Stop fetchr-api and fetchr-telegram-bot, then pass --services-stopped (or use --dry-run).");
  }

  console.log(`Data dir: ${paths.dataDir}`);
  console.log(`Files: ${fileList(paths).map((path) => basename(path)).join(", ") || "none"}`);
  const rawBefore = readJsonLines(paths.telemetry);
  const before = pick({ ...(await publicCounters(paths)), ...oldCounters(rawBefore) });

  if (!dryRun) console.log(`Backup: ${takeBackup(paths)}`);
  await migrateAll(paths, { dryRun });
  if (dryRun) return console.log("Dry run: nothing was written.");

  const problems = verifyMigrated(paths);
  const after = pick(await publicCounters(paths));
  const differs = COMPARED.filter((key) => JSON.stringify(sorted(before[key])) !== JSON.stringify(sorted(after[key])));
  console.log(`Counters before: ${JSON.stringify(before)}`);
  console.log(`Counters after:  ${JSON.stringify(after)}`);
  problems.forEach((problem) => console.error(problem));
  differs.forEach((key) => console.error(`Counter changed: ${key}`));
  if (problems.length || differs.length) {
    console.error("Migration is NOT clean. Restore from the backup before starting the services.");
    process.exitCode = 1;
    return;
  }
  console.log("Clean. Start the services, check the site and the bot, then run --delete-backup.");
  console.log(`Other backups in ${dirname(paths.dataDir)}: ${readdirSync(dirname(paths.dataDir)).filter((name) => name.startsWith(BACKUP_PREFIX)).join(", ")}`);
}

function sorted(value) {
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
