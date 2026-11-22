// Error reports from Fetchr clients: intake, grouping and naming.
//
// Clients send batches of already-scrubbed reports (see
// src-tauri/src/error_reports). Every report carries a fingerprint that is
// equal for all occurrences of one error, so the base here is a log of
// occurrences plus a small file of names/statuses keyed by fingerprint.
// Reading endpoints are admin-only: even scrubbed errors describe users'
// machines and are not public like the download counters.

import { timingSafeEqual } from "node:crypto";
import { createReadStream, existsSync, statSync } from "node:fs";
import { appendFile, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";

import { maskDeep, maskSensitiveText } from "./privacy/redact.mjs";

const MAX_BATCH = 50;
// The API shares its disk with the stream recorder (5.5 GB free on
// 2026-09-23): the log rotates at this size and one older file is kept.
const ROTATE_AT_BYTES = 64 * 1024 * 1024;
const RATE_WINDOW_MS = 60 * 60 * 1000;
const RATE_LIMIT_PER_MACHINE = 300;
const RATE_LIMIT_PER_IP = 600;
const RATE_LIMIT_GLOBAL = 20_000;
const MAX_TRACKED_KEYS = 20_000;
const RECENT_BATCHES = 5_000;
const SAMPLES_PER_GROUP = 5;
const STATUSES = new Set(["open", "fixed", "ignored"]);
const SOURCES = new Set(["log", "tracing", "panic", "frontend"]);
const LEVELS = new Set(["warn", "error"]);
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;

export class ValidationError extends Error {}

export function createErrorTelemetry({ dataDir, adminToken, pseudonym = (id) => id }) {
  const errorsPath = join(dataDir, "errors.jsonl");
  const rotatedPath = join(dataDir, "errors.1.jsonl");
  const namesPath = join(dataDir, "error-names.json");
  const windows = new Map();
  const recentBatches = new Set();
  let globalWindow = { start: Date.now(), used: 0 };
  let groupsCache = { sig: "", all: null };

  function filesSignature() {
    return [rotatedPath, errorsPath, namesPath].map((p) => {
      if (!existsSync(p)) return "-";
      try {
        const s = statSync(p);
        return `${s.size}:${s.mtimeMs}`;
      } catch {
        return "-";
      }
    }).join("|");
  }

  function isAdmin(req) {
    if (!adminToken) return false;
    const given = Buffer.from(String(req.headers["x-admin-token"] || ""));
    const expected = Buffer.from(adminToken);
    return given.length === expected.length && timingSafeEqual(given, expected);
  }

  function take(key, limit, count, now) {
    const window = windows.get(key);
    if (!window || now - window.start > RATE_WINDOW_MS) {
      if (windows.size >= MAX_TRACKED_KEYS) sweep(now);
      windows.set(key, { start: now, used: count });
      return count <= limit;
    }
    if (window.used + count > limit) return false;
    window.used += count;
    return true;
  }

  function sweep(now) {
    for (const [key, window] of windows) {
      if (now - window.start > RATE_WINDOW_MS) windows.delete(key);
    }
    // Still full: a flood of fresh keys. Starting over is safer than growing.
    if (windows.size >= MAX_TRACKED_KEYS) windows.clear();
  }

  function allow(ip, machineId, count) {
    const now = Date.now();
    if (now - globalWindow.start > RATE_WINDOW_MS) globalWindow = { start: now, used: 0 };
    if (globalWindow.used + count > RATE_LIMIT_GLOBAL) return false;
    if (!take(`ip:${ip}`, RATE_LIMIT_PER_IP, count, now)) return false;
    if (!take(`machine:${machineId}`, RATE_LIMIT_PER_MACHINE, count, now)) return false;
    globalWindow.used += count;
    return true;
  }

  function remember(batchId) {
    if (recentBatches.size >= RECENT_BATCHES) {
      recentBatches.delete(recentBatches.values().next().value);
    }
    recentBatches.add(batchId);
  }

  async function rotateIfNeeded() {
    if (existsSync(errorsPath) && statSync(errorsPath).size > ROTATE_AT_BYTES) {
      await rename(errorsPath, rotatedPath);
    }
  }

  async function ingest(batch, ip) {
    const clean = validateBatch(batch);
    if (clean.batch_id && recentBatches.has(clean.batch_id)) {
      return { status: 202, body: { ok: true, duplicate: true } };
    }
    if (!allow(ip || "unknown", clean.machine_id, clean.reports.length)) {
      return { status: 429, body: { error: "rate_limited" } };
    }
    await rotateIfNeeded();
    const receivedAt = new Date().toISOString();
    const lines = clean.reports.map((report) =>
      JSON.stringify({
        ...report,
        machine_id: pseudonym(clean.machine_id),
        app_version: clean.app_version,
        channel: clean.channel,
        os: clean.os,
        received_at: receivedAt,
      }),
    );
    await appendFile(errorsPath, `${lines.join("\n")}\n`, "utf8");
    groupsCache = { sig: "", all: null };
    if (clean.batch_id) remember(clean.batch_id);
    return { status: 202, body: { ok: true, accepted: lines.length } };
  }

  async function allGroups() {
    const sig = filesSignature();
    if (groupsCache.all && groupsCache.sig === sig) return groupsCache.all;
    const names = await readNames();
    const byFingerprint = new Map();
    await forEachRow((row) => {
      const group = byFingerprint.get(row.fingerprint) || {
        fingerprint: row.fingerprint,
        code: row.code,
        source: row.source,
        level: row.level,
        message: row.message,
        occurrences: 0,
        machines: new Set(),
        versions: new Set(),
        first_seen: row.received_at,
        last_seen: row.received_at,
      };
      group.occurrences += Number(row.count) || 1;
      group.machines.add(row.machine_id);
      if (row.app_version) group.versions.add(row.app_version);
      // Server time, not the client's claim, decides which sample is newest.
      if (row.received_at > group.last_seen) {
        group.last_seen = row.received_at;
        group.message = row.message;
      }
      if (row.received_at < group.first_seen) group.first_seen = row.received_at;
      byFingerprint.set(row.fingerprint, group);
    });
    const all = [...byFingerprint.values()].map((group) => {
      const meta = names[group.fingerprint] || {};
      return {
        fingerprint: group.fingerprint,
        name: meta.name || null,
        status: meta.status || "open",
        fixed_in: meta.fixed_in || null,
        note: meta.note || null,
        code: group.code,
        source: group.source,
        level: group.level,
        message: group.message,
        occurrences: group.occurrences,
        machines: group.machines.size,
        versions: [...group.versions].sort(),
        first_seen: group.first_seen,
        last_seen: group.last_seen,
      };
    });
    groupsCache = { sig, all };
    return all;
  }

  async function groups({ status, limit }) {
    const all = await allGroups();
    const filtered = status ? all.filter((group) => group.status === status) : all;
    const sorted = [...filtered].sort((a, b) => b.machines - a.machines || b.occurrences - a.occurrences);
    return { total_groups: all.length, groups: sorted.slice(0, limit) };
  }

  async function samples(fingerprint) {
    const rows = [];
    await forEachRow((row) => {
      if (row.fingerprint !== fingerprint) return;
      rows.push(row);
      if (rows.length > SAMPLES_PER_GROUP) rows.shift();
    });
    const names = await readNames();
    return {
      fingerprint,
      meta: names[fingerprint] || null,
      samples: rows.map((row) => ({
        message: row.message,
        context: row.context,
        count: row.count,
        app_version: row.app_version,
        os: row.os,
        received_at: row.received_at,
      })),
    };
  }

  async function name(request) {
    const fingerprint = String(request?.fingerprint || "");
    if (!/^[a-f0-9]{32}$/.test(fingerprint)) throw new ValidationError("invalid fingerprint");
    const status = request.status === undefined ? undefined : String(request.status);
    if (status !== undefined && !STATUSES.has(status)) throw new ValidationError("invalid status");
    // A corrupt names file must fail loudly: treating it as empty and
    // writing back would erase every name given so far.
    const names = await readNames();
    const current = names[fingerprint] || {};
    names[fingerprint] = {
      ...current,
      ...(request.name !== undefined ? { name: clip(request.name, 120) } : {}),
      ...(status !== undefined ? { status } : {}),
      ...(request.note !== undefined ? { note: clip(request.note, 2000) } : {}),
      ...(request.fixed_in !== undefined ? { fixed_in: clip(request.fixed_in, 32) } : {}),
      updated_at: new Date().toISOString(),
    };
    const temp = `${namesPath}.tmp`;
    await writeFile(temp, `${JSON.stringify(names, null, 2)}\n`, "utf8");
    await rename(temp, namesPath);
    groupsCache = { sig: "", all: null };
    return { ok: true, fingerprint, ...names[fingerprint] };
  }

  async function forEachRow(visit) {
    for (const path of [rotatedPath, errorsPath]) {
      if (!existsSync(path)) continue;
      const lines = createInterface({ input: createReadStream(path, "utf8"), crlfDelay: Infinity });
      for await (const line of lines) {
        if (!line) continue;
        try {
          visit(JSON.parse(line));
        } catch {
          // A torn last line from a crash must not hide the rest.
        }
      }
    }
  }

  async function readNames() {
    if (!existsSync(namesPath)) return {};
    return JSON.parse(await readFile(namesPath, "utf8"));
  }

  return { isAdmin, ingest, groups, samples, name };
}

function validateBatch(batch) {
  if (!batch || typeof batch !== "object") throw new ValidationError("batch must be an object");
  const machineId = String(batch.machine_id || "").toUpperCase();
  if (!/^[A-F0-9]{32}$/.test(machineId)) throw new ValidationError("invalid machine_id");
  if (!Array.isArray(batch.reports) || batch.reports.length === 0) {
    throw new ValidationError("reports must be a non-empty array");
  }
  if (batch.reports.length > MAX_BATCH) throw new ValidationError("too many reports");
  const batchId = batch.batch_id === undefined ? null : String(batch.batch_id);
  if (batchId !== null && !/^[0-9a-f-]{36}$/i.test(batchId)) {
    throw new ValidationError("invalid batch_id");
  }
  return {
    batch_id: batchId,
    machine_id: machineId,
    app_version: clip(batch.app_version, 32),
    channel: clip(batch.channel, 16),
    os: clip(batch.os, 40),
    reports: batch.reports.map(validateReport),
  };
}

function validateReport(report) {
  if (!report || typeof report !== "object") throw new ValidationError("report must be an object");
  const fingerprint = String(report.fingerprint || "");
  if (!/^[a-f0-9]{32}$/.test(fingerprint)) throw new ValidationError("invalid fingerprint");
  if (!SOURCES.has(report.source)) throw new ValidationError("invalid source");
  if (!LEVELS.has(report.level)) throw new ValidationError("invalid level");
  const count = Number(report.count);
  if (!Number.isInteger(count) || count < 1 || count > 1_000_000) {
    throw new ValidationError("invalid count");
  }
  const context = sanitize(report.context && typeof report.context === "object" ? report.context : {}, 0);
  const contextText = JSON.stringify(context);
  return {
    fingerprint,
    source: report.source,
    level: report.level,
    code: clip(report.code, 120),
    message: maskSensitiveText(clip(report.message, 1000)),
    context: maskDeep(contextText.length > 8192 ? { truncated: contextText.slice(0, 8192) } : context),
    count,
  };
}

/** Strings anywhere in a context lose control characters; depth and
 *  breadth are capped so a crafted report cannot blow up the stored line. */
function sanitize(value, depth) {
  if (typeof value === "string") return clip(value, 4000);
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (depth > 4) return null;
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => sanitize(item, depth + 1));
  if (typeof value === "object") {
    const out = {};
    for (const [key, item] of Object.entries(value).slice(0, 40)) {
      out[clip(key, 60)] = sanitize(item, depth + 1);
    }
    return out;
  }
  return null;
}

/** Length cap plus control characters removed: values end up in terminals. */
export function clip(value, max) {
  return String(value ?? "").replace(CONTROL_CHARS, "").slice(0, max);
}
