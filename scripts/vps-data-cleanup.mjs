#!/usr/bin/env node
// Daily data cleanup on the VPS (deploy/systemd/fetchr-data-cleanup.timer).
//
//   node scripts/vps-data-cleanup.mjs [--dry-run]
//   node scripts/vps-data-cleanup.mjs --delete-user <telegram_id> [--dry-run]
//
// Reads the same FETCHR_* variables as the API server and the bot. After
// --delete-user restart fetchr-api: it keeps open sessions in memory.

import { closeSync, existsSync, openSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

import { dataPaths, deleteUser, runCleanup } from "./lib/privacy/data-cleanup.mjs";

const STALE_LOCK_MS = 60 * 60 * 1000;

function takeLock(path) {
  try {
    if (Date.now() - statSync(path).mtimeMs > STALE_LOCK_MS) rmSync(path, { force: true });
  } catch {
    // No lock yet.
  }
  closeSync(openSync(path, "wx"));
}

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const paths = dataPaths();
const lock = join(paths.dataDir, ".data-cleanup.lock");

if (!existsSync(paths.dataDir)) {
  console.error(`cleanup: data dir ${paths.dataDir} does not exist; is FETCHR_VPS_DATA_DIR set?`);
  process.exit(1);
}

try {
  takeLock(lock);
} catch {
  console.error(`cleanup: another run holds ${lock}`);
  process.exit(1);
}

try {
  const target = args.indexOf("--delete-user");
  if (target >= 0) {
    const userId = Number(args[target + 1]);
    if (!Number.isSafeInteger(userId) || userId <= 0) throw new Error("--delete-user needs a Telegram id");
    await deleteUser(paths, userId, { dryRun });
  } else {
    process.exitCode = (await runCleanup(paths, { dryRun })) > 0 ? 1 : 0;
  }
} catch (err) {
  console.error(`cleanup: ${err instanceof Error ? err.message : err}`);
  process.exitCode = 1;
} finally {
  rmSync(lock, { force: true });
}
