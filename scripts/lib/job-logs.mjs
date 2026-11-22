// Full job logs from Fetchr clients (see src-tauri/src/job_logs.rs).
//
// Every finished job sends its whole log, already scrubbed of paths, URLs and
// secrets on the client; it is masked again here for old clients. The sender's
// address is used for rate limits only and is not written. Logs are stored gzipped, one file per job, under
// <dataDir>/job-logs/<YYYY-MM-DD>/, and only an admin can list or read them.
// The VPS disk is small, so storage is capped by age and by total size: the
// oldest logs go first.

import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";

import { maskSensitiveText } from "./privacy/redact.mjs";
import { createRateLimiter } from "./rate-limit.mjs";

export const MAX_LOG_CHARS = 1_000_000;
const STATUSES = new Set(["done", "error", "cancelled"]);
const KINDS = new Set(["video", "chat", "fetchr_mute", "vps_download"]);
const DAY_DIR = /^\d{4}-\d{2}-\d{2}$/;
const FILE_NAME = /^\d{6}_[A-F0-9]{8}_(done|error|cancelled)_[a-z_]+_[a-f0-9]{8}\.log\.gz$/;
const HOUR = 60 * 60 * 1000;
// Every this many stored logs the size cap is enforced again.
const PRUNE_EVERY = 25;

export class JobLogValidationError extends Error {}

export function createJobLogs({
  dataDir,
  maxBytes = 400 * 1024 * 1024,
  retentionDays = 30,
  perMachinePerHour = 120,
  perIpPerHour = 300,
  now = () => Date.now(),
  pseudonym = (id) => id,
}) {
  const root = join(dataDir, "job-logs");
  const allowMachine = createRateLimiter({ limit: perMachinePerHour, windowMs: HOUR, now });
  const allowIp = createRateLimiter({ limit: perIpPerHour, windowMs: HOUR, now });
  const recentIds = new Set();
  let storedSincePrune = PRUNE_EVERY;

  async function ingest(body, ip) {
    let entry;
    try {
      entry = validate(body);
    } catch (err) {
      if (err instanceof JobLogValidationError) return { status: 400, body: { error: err.message } };
      throw err;
    }
    // A client retries after a timeout that may have hit after the write.
    if (recentIds.has(entry.logId)) return { status: 200, body: { ok: true, duplicate: true } };
    if (!allowIp(`ip:${ip}`) || !allowMachine(entry.machineId)) {
      return { status: 429, body: { error: "rate_limited" } };
    }

    const stamp = new Date(now());
    const day = stamp.toISOString().slice(0, 10);
    const time = stamp.toISOString().slice(11, 19).replaceAll(":", "");
    const reporter = pseudonym(entry.machineId);
    const name = `${time}_${reporter.slice(0, 8)}_${entry.status}_${entry.kind}_${entry.logId.slice(0, 8)}.log.gz`;
    const dir = join(root, day);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, name), gzipSync(renderLog(entry, reporter, stamp)));

    recentIds.add(entry.logId);
    if (recentIds.size > 5_000) recentIds.clear();
    storedSincePrune += 1;
    if (storedSincePrune >= PRUNE_EVERY) {
      storedSincePrune = 0;
      await prune();
    }
    return { status: 200, body: { ok: true } };
  }

  /** Newest first. `status`, `machine` (id prefix) and `kind` filter. */
  async function list({ day = "", status = "", machine = "", kind = "", limit = 100 } = {}) {
    const days = day ? [day].filter((d) => DAY_DIR.test(d)) : (await listDays()).reverse();
    const out = [];
    for (const d of days) {
      const files = (await safeReaddir(join(root, d))).filter((f) => FILE_NAME.test(f)).sort().reverse();
      for (const file of files) {
        const [, machineId, fileStatus, ...rest] = file.replace(".log.gz", "").split("_");
        const fileKind = rest.slice(0, -1).join("_");
        if (status && fileStatus !== status) continue;
        if (kind && fileKind !== kind) continue;
        if (machine && !machineId.startsWith(machine.toUpperCase().slice(0, 8))) continue;
        out.push({ path: `${d}/${file}`, day: d, status: fileStatus, kind: fileKind, machine: machineId });
        if (out.length >= limit) return out;
      }
    }
    return out;
  }

  /** Plain text of one stored log, or null when the path is not a log. */
  async function read(path) {
    const [day, file, extra] = String(path || "").split("/");
    if (extra !== undefined || !DAY_DIR.test(day || "") || !FILE_NAME.test(file || "")) return null;
    const full = join(root, day, file);
    if (!existsSync(full)) return null;
    return gunzipSync(await readFile(full)).toString("utf8");
  }

  async function listDays() {
    return (await safeReaddir(root)).filter((d) => DAY_DIR.test(d)).sort();
  }

  async function prune() {
    const cutoff = new Date(now() - retentionDays * 24 * HOUR).toISOString().slice(0, 10);
    const days = await listDays();
    for (const day of days.filter((d) => d < cutoff)) {
      await rm(join(root, day), { recursive: true, force: true });
    }
    const files = [];
    for (const day of days.filter((d) => d >= cutoff)) {
      for (const file of (await safeReaddir(join(root, day))).sort()) {
        const full = join(root, day, file);
        const info = await stat(full).catch(() => null);
        if (info?.isFile()) files.push({ full, size: info.size });
      }
    }
    let total = files.reduce((sum, file) => sum + file.size, 0);
    for (const file of files) {
      if (total <= maxBytes) break;
      await rm(file.full, { force: true });
      total -= file.size;
    }
  }

  return { ingest, list, read, prune };
}

function validate(body) {
  if (!body || typeof body !== "object") throw new JobLogValidationError("body must be an object");
  const machineId = String(body.machine_id || "").toUpperCase();
  if (!/^[A-F0-9]{32}$/.test(machineId)) throw new JobLogValidationError("invalid machine_id");
  const logId = String(body.log_id || "").toLowerCase();
  if (!/^[a-f0-9-]{32,36}$/.test(logId)) throw new JobLogValidationError("invalid log_id");
  const status = String(body.status || "");
  if (!STATUSES.has(status)) throw new JobLogValidationError("invalid status");
  const kind = String(body.kind || "");
  if (!KINDS.has(kind)) throw new JobLogValidationError("invalid kind");
  if (typeof body.log !== "string") throw new JobLogValidationError("log must be a string");
  if (body.log.length > MAX_LOG_CHARS) throw new JobLogValidationError("log too long");
  const text = (value, max) => (value == null ? "" : String(value).slice(0, max));
  const duration = Number(body.duration_ms);
  return {
    machineId,
    logId: logId.replaceAll("-", ""),
    status,
    kind,
    appVersion: text(body.app_version, 40),
    channel: text(body.channel, 20),
    os: text(body.os, 40),
    sentAt: text(body.sent_at, 40),
    name: text(body.name, 300),
    source: text(body.source, 400),
    error: text(body.error, 4_000),
    durationMs: Number.isFinite(duration) && duration >= 0 ? Math.round(duration) : null,
    log: body.log,
  };
}

function renderLog(entry, reporter, stamp) {
  const header = [
    `Получен: ${stamp.toISOString()}`,
    `Машина: ${reporter}`,
    `Версия: ${entry.appVersion} (${entry.channel}), ${entry.os}`,
    `Тип: ${entry.kind}, статус: ${entry.status}`,
    `Задача: ${maskSensitiveText(entry.name)}`,
    `Источник: ${maskSensitiveText(entry.source)}`,
    entry.durationMs == null ? null : `Длительность: ${(entry.durationMs / 1000).toFixed(1)} с`,
    entry.error ? `Ошибка: ${maskSensitiveText(entry.error)}` : null,
  ].filter((line) => line !== null);
  return `${header.join("\n")}\n\n${maskSensitiveText(entry.log)}`;
}

async function safeReaddir(dir) {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}
