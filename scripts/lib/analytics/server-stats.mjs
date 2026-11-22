/** Server health for the admin dashboard: CPU, memory, disks, network,
 * services, and what the archive recorders are doing right now.
 *
 * A sampler reads /proc once a minute and keeps 24 hours of points plus daily
 * traffic totals in one small JSON file, so rates and history survive an API
 * restart. Live recordings, tenants and services are read when the dashboard
 * asks. Nothing here holds a user id: tenants appear by their recorder id,
 * channels by their public Twitch name. */

import { execFile } from "node:child_process";
import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { lstat, readdir, readFile, stat, statfs } from "node:fs/promises";
import { join } from "node:path";

import { RESTREAM_SLOTS } from "../bot/catalog.mjs";

const HISTORY_POINTS = 24 * 60;
const KEEP_DAYS = 45;
const PERSIST_EVERY = 5;
const TENANT_USAGE_TTL_MS = 10 * 60_000;
const HOT_USAGE_TTL_MS = 2 * 60_000;
/** A live recording whose segment list has not moved for this long is stuck. */
export const STALLED_AFTER_SEC = 120;

// ---------- /proc parsers (pure) ----------

export function parseCpu(text) {
  const line = String(text).split("\n").find((row) => row.startsWith("cpu "));
  if (!line) return null;
  const values = line.trim().split(/\s+/).slice(1).map(Number);
  const idle = (values[3] || 0) + (values[4] || 0);
  const total = values.slice(0, 8).reduce((sum, value) => sum + (value || 0), 0);
  return { idle, total };
}

export function parseCpuIowait(text) {
  const line = String(text).split("\n").find((row) => row.startsWith("cpu "));
  if (!line) return null;
  const values = line.trim().split(/\s+/).slice(1).map(Number);
  const iowait = values[4] || 0;
  const total = values.slice(0, 8).reduce((sum, value) => sum + (value || 0), 0);
  return { iowait, total };
}

export function cpuPercent(prev, cur) {
  if (!prev || !cur) return null;
  const total = cur.total - prev.total;
  if (total <= 0) return null;
  return Math.min(100, Math.max(0, (1 - (cur.idle - prev.idle) / total) * 100));
}

export function cpuIowaitPercent(prev, cur) {
  if (!prev || !cur) return null;
  const total = cur.total - prev.total;
  if (total <= 0) return null;
  return Math.min(100, Math.max(0, ((cur.iowait - prev.iowait) / total) * 100));
}

/** `/proc/pressure/io` → `{ some_avg10, some_avg60, full_avg10, full_avg60 }`. */
export function parseIoPsi(text) {
  const out = {};
  for (const row of String(text || "").split("\n")) {
    const kind = /^(some|full)\s+/.exec(row)?.[1];
    if (!kind) continue;
    for (const part of row.split(/\s+/).slice(1)) {
      const [key, raw] = part.split("=");
      if (key === "avg10" || key === "avg60") {
        const val = Number(raw);
        if (Number.isFinite(val)) out[`${kind}_${key}`] = val;
      }
    }
  }
  return Object.keys(out).length ? out : null;
}

export function parseMeminfo(text) {
  const kb = {};
  for (const row of String(text).split("\n")) {
    const match = /^(\w+):\s+(\d+)/.exec(row);
    if (match) kb[match[1]] = Number(match[2]) * 1024;
  }
  return {
    total: kb.MemTotal || 0,
    available: kb.MemAvailable ?? kb.MemFree ?? 0,
    swap_total: kb.SwapTotal || 0,
    swap_free: kb.SwapFree || 0,
  };
}

export function parseLoadavg(text) {
  return String(text).trim().split(/\s+/).slice(0, 3).map(Number);
}

/** `{ iface: { rx, tx } }` in bytes since boot. */
export function parseNetDev(text) {
  const out = {};
  for (const row of String(text).split("\n").slice(2)) {
    const [name, rest] = row.split(":");
    if (!rest) continue;
    const fields = rest.trim().split(/\s+/).map(Number);
    out[name.trim()] = { rx: fields[0] || 0, tx: fields[8] || 0 };
  }
  return out;
}

/** The busiest non-loopback interface: the one the internet goes through. */
export function mainIface(net) {
  return Object.entries(net)
    .filter(([name]) => name !== "lo")
    .sort(([, a], [, z]) => z.rx + z.tx - (a.rx + a.tx))[0]?.[0] ?? null;
}

/** Bytes moved between two readings; a counter that went down was reset by a reboot. */
export const counterDelta = (prev, cur) => (cur >= prev ? cur - prev : cur);

export function addTraffic(days, day, rx, tx) {
  const current = days[day] || { rx: 0, tx: 0 };
  return { ...days, [day]: { rx: current.rx + rx, tx: current.tx + tx } };
}

export function trafficSince(days, fromDay) {
  return Object.entries(days)
    .filter(([day]) => day >= fromDay)
    .reduce((sum, [, value]) => ({ rx: sum.rx + value.rx, tx: sum.tx + value.tx }), { rx: 0, tx: 0 });
}

export function pruneDays(days, keepFrom) {
  return Object.fromEntries(Object.entries(days).filter(([day]) => day >= keepFrom));
}

/** `systemctl show -p Id -p ActiveState -p SubState` output for many units. */
export function parseUnits(text) {
  return String(text).split(/\n\s*\n/).map((block) => {
    const props = Object.fromEntries(block.split("\n").filter(Boolean).map((row) => {
      const at = row.indexOf("=");
      return [row.slice(0, at), row.slice(at + 1)];
    }));
    return props.Id ? { name: props.Id, state: props.ActiveState, sub: props.SubState } : null;
  }).filter(Boolean);
}

const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);
const dayBefore = (ms, days) => dayOf(ms - days * 86_400_000);

// ---------- sampler ----------

export function createServerStats({
  statePath,
  procRoot = "/proc",
  tenantsRoot = "/srv/tenants",
  hotRoot = "/var/lib/fetchr-hot",
  disks = ["/", "/srv"],
  baseUnits = ["nginx", "fetchr-api", "fetchr-telegram-bot", "fetchr-grab", "fetchr-backup-meta.timer", "fetchr-data-cleanup.timer", "fetchr-monitor.timer", "fetchr-cert-renew.timer"],
  now = () => Date.now(),
  log = () => {},
  /** Recorder ids left out of the tenant table, live list and services. */
  hidden = [],
  /** Restream outputs the bot may sell in total (bot/catalog.mjs RESTREAM_SLOTS). */
  restreamSlots = RESTREAM_SLOTS,
} = {}) {
  const hiddenTenants = new Set(hidden);
  let state = loadState();
  let samples = 0;
  const usageCache = new Map();
  const usageInflight = new Map();
  let hotCache = { at: 0, bytes: null };
  let hotInflight = null;

  function loadState() {
    try {
      const saved = JSON.parse(readFileSync(statePath, "utf8"));
      return { history: [], days: {}, last: null, ...saved };
    } catch {
      return { history: [], days: {}, last: null };
    }
  }

  function persist() {
    if (!statePath) return;
    const tmp = `${statePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(state));
    renameSync(tmp, statePath);
  }

  const proc = (name) => readFile(join(procRoot, name), "utf8");

  async function sample() {
    const at = now();
    const [statText, memText, loadText, netText, psiText] = await Promise.all([
      proc("stat"),
      proc("meminfo"),
      proc("loadavg"),
      proc("net/dev"),
      proc("pressure/io").catch(() => ""),
    ]);
    const cpu = parseCpu(statText);
    const iowait = parseCpuIowait(statText);
    const ioPsi = parseIoPsi(psiText);
    const mem = parseMeminfo(memText);
    const net = parseNetDev(netText);
    const iface = mainIface(net);
    const counters = iface ? net[iface] : { rx: 0, tx: 0 };
    const last = state.last;
    const seconds = last ? (at - last.at) / 1000 : 0;
    let days = state.days;
    let rxRate = null;
    let txRate = null;
    if (last && seconds > 0 && last.iface === iface) {
      const rx = counterDelta(last.rx, counters.rx);
      const tx = counterDelta(last.tx, counters.tx);
      days = addTraffic(days, dayOf(at), rx, tx);
      // A gap of hours (API was down) would smear into a fake average.
      if (seconds < 600) {
        rxRate = (rx * 8) / seconds;
        txRate = (tx * 8) / seconds;
      }
    }
    const [live, disksNow, hotBytes] = await Promise.all([
      liveRecordings().catch(() => []),
      diskUsage(),
      hotUsage().catch(() => null),
    ]);
    const storageDisk = disksNow.find((d) => d.mount === "/srv") || disksNow[0];
    const point = {
      t: at,
      cpu: cpuPercent(last?.cpu, cpu),
      iowait: cpuIowaitPercent(last?.iowait, iowait),
      io_psi: ioPsi?.full_avg10 ?? null,
      mem: mem.total ? mem.total - mem.available : null,
      load: parseLoadavg(loadText)[0],
      rx: rxRate,
      tx: txRate,
      rec: live.length,
      disk: storageDisk ? storageDisk.used : null,
      hot: hotBytes,
    };
    state = {
      history: [...state.history, point].slice(-HISTORY_POINTS),
      days: pruneDays(days, dayBefore(at, KEEP_DAYS)),
      last: { at, cpu, iowait, iface, rx: counters.rx, tx: counters.tx },
    };
    samples += 1;
    if (samples % PERSIST_EVERY === 1) persist();
    return point;
  }

  function start(intervalMs = 60_000) {
    const tick = () => sample().catch((err) => log(`server-stats: sample failed: ${err.message}`));
    tick();
    return setInterval(tick, intervalMs).unref();
  }

  // ---------- live readings ----------

  async function readJson(path) {
    try {
      return JSON.parse(await readFile(path, "utf8"));
    } catch {
      return null;
    }
  }

  async function tenantIds() {
    try {
      return (await readdir(tenantsRoot)).filter((id) => /^[a-z0-9]{12}$/.test(id)).sort();
    } catch {
      return [];
    }
  }

  /** Segment count, recorded duration and the time the segment list last moved. */
  async function sessionProgress(dir) {
    let segments = 0;
    let durationSec = 0;
    let lastWrite = 0;
    let names = [];
    try {
      names = (await readdir(dir)).filter((name) => /^run_\d+\.csv$/.test(name));
    } catch {
      return { segments: 0, duration_sec: 0, last_write: null };
    }
    for (const name of names) {
      const path = join(dir, name);
      const [info, text] = await Promise.all([stat(path), readFile(path, "utf8")]);
      lastWrite = Math.max(lastWrite, info.mtimeMs);
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        segments += 1;
        const parts = line.split(",");
        const start = Number(parts[1]);
        const end = Number(parts[2]);
        durationSec += Number.isFinite(start) && Number.isFinite(end) && end > start ? end - start : 10;
      }
    }
    return { segments, duration_sec: Math.round(durationSec), last_write: lastWrite || null };
  }

  async function liveRecordings() {
    const at = now();
    const out = [];
    for (const id of await tenantIds()) {
      const activeDir = join(tenantsRoot, id, "data", "active");
      let markers = [];
      try {
        markers = (await readdir(activeDir)).filter((name) => name.endsWith(".json"));
      } catch {
        continue;
      }
      for (const name of markers) {
        const marker = await readJson(join(activeDir, name));
        if (!marker?.session) continue;
        const progress = await sessionProgress(join(tenantsRoot, id, "data", "buffer", marker.session));
        const idle = progress.last_write ? (at - progress.last_write) / 1000 : null;
        out.push({
          tenant: id,
          channel: String(marker.channel || "").slice(0, 40),
          session: marker.session,
          started_at: marker.started_at ? marker.started_at * 1000 : null,
          segments: progress.segments,
          duration_sec: progress.duration_sec,
          last_write: progress.last_write,
          stalled: idle === null ? progress.segments === 0 && at - (marker.started_at || 0) * 1000 > STALLED_AFTER_SEC * 1000 : idle > STALLED_AFTER_SEC,
        });
      }
    }
    return out;
  }

  /** Bytes on disk under a folder, symlinks not followed, hard links once per device. */
  async function folderBytes(root, seen) {
    let total = 0;
    let entries = [];
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch {
      return 0;
    }
    for (const entry of entries) {
      const path = join(root, entry.name);
      if (entry.isDirectory()) total += await folderBytes(path, seen);
      else if (entry.isFile()) {
        const info = await lstat(path).catch(() => null);
        if (!info) continue;
        const key = `${info.dev}:${info.ino}`;
        if (seen.has(key)) continue;
        seen.add(key);
        total += info.blocks * 512;
      }
    }
    return total;
  }

  async function tenantUsage(id) {
    const cached = usageCache.get(id);
    if (cached && now() - cached.at < TENANT_USAGE_TTL_MS) return cached.bytes;
    if (usageInflight.has(id)) return usageInflight.get(id);
    const task = (async () => {
      const seen = new Set();
      const bytes = (await folderBytes(join(tenantsRoot, id), seen)) + (await folderBytes(join(hotRoot, id), seen));
      usageCache.set(id, { at: now(), bytes });
      return bytes;
    })().finally(() => usageInflight.delete(id));
    usageInflight.set(id, task);
    return task;
  }

  async function hotUsage() {
    if (!hotRoot) return null;
    if (hotCache.bytes !== null && now() - hotCache.at < HOT_USAGE_TTL_MS) return hotCache.bytes;
    if (hotInflight) return hotInflight;
    hotInflight = (async () => {
      const exists = await stat(hotRoot).then((s) => s.isDirectory(), () => false);
      if (!exists) return null;
      const bytes = await folderBytes(hotRoot, new Set());
      hotCache = { at: now(), bytes };
      return bytes;
    })().finally(() => {
      hotInflight = null;
    });
    return hotInflight;
  }

  async function tenants(live, allIds) {
    const out = [];
    let soldBytesAll = 0;
    let soldActiveBytesAll = 0;
    for (const id of allIds) {
      const config = (await readJson(join(tenantsRoot, id, "config.json"))) || {};
      const quotaBytes = Number(config.quota_gb || 0) * 1e9;
      const suspended = Boolean(config.suspended);
      soldBytesAll += quotaBytes;
      if (!suspended) soldActiveBytesAll += quotaBytes;
      if (hiddenTenants.has(id)) continue;
      const targets = (await readJson(join(tenantsRoot, id, "data", "targets.json")))?.targets || [];
      const restreamStatus = (await readJson(join(tenantsRoot, id, "data", "restream-status.json")))?.folders || {};
      const folders = Object.values(restreamStatus);
      const pushing = folders.filter((folder) => folder?.state === "live");
      const failedOutputs = folders.reduce(
        (sum, folder) => sum + (folder?.outputs || []).filter((o) => o?.state === "error").length,
        0,
      );
      out.push({
        restream: {
          slots: Number(config.subscription?.restream_streamers || 0) + Number(config.subscription?.restream_extra || 0),
          live_streamers: pushing.length,
          live_outputs: pushing.reduce((sum, folder) => sum + (folder.outputs || []).filter((o) => o?.state === "live").length, 0),
        },
        restream_failed_outputs: failedOutputs,
        id,
        plan: config.subscription?.plan || null,
        paid_until: config.subscription?.paid_until ? config.subscription.paid_until * 1000 : null,
        suspended,
        quota_bytes: quotaBytes,
        used_bytes: await tenantUsage(id),
        max_channels: Number(config.max_channels || 0),
        channels: targets.map((target) => String(target.channel || "").slice(0, 40)).filter(Boolean),
        live: live.filter((row) => row.tenant === id).length,
      });
    }
    return { rows: out, soldBytesAll, soldActiveBytesAll };
  }

  async function diskUsage() {
    const out = [];
    const seenDev = new Set();
    for (const mount of disks) {
      try {
        const [meta, info] = await Promise.all([stat(mount), statfs(mount)]);
        if (meta?.dev != null && seenDev.has(meta.dev)) continue;
        if (meta?.dev != null) seenDev.add(meta.dev);
        const total = info.blocks * info.bsize;
        const free = info.bavail * info.bsize;
        out.push({ mount, total, free, used: total - info.bfree * info.bsize });
      } catch {
        /* mount gone */
      }
    }
    return out;
  }

  function units(names) {
    return new Promise((done) => {
      execFile("systemctl", ["show", "-p", "Id", "-p", "ActiveState", "-p", "SubState", ...names], { timeout: 5000 }, (err, stdout) => {
        done(err ? [] : parseUnits(stdout));
      });
    });
  }

  async function snapshot() {
    const at = now();
    const [allLive, memText, loadText, uptimeText, disksNow, psiText, hotBytes] = await Promise.all([
      liveRecordings(),
      proc("meminfo"),
      proc("loadavg"),
      proc("uptime"),
      diskUsage(),
      proc("pressure/io").catch(() => ""),
      hotUsage().catch(() => null),
    ]);
    // Hidden tenants still load the machine, so host figures and history keep them.
    const live = allLive.filter((row) => !hiddenTenants.has(row.tenant));
    const allIds = await tenantIds();
    const visibleIds = allIds.filter((id) => !hiddenTenants.has(id));
    const [tenantInfo, rawServices] = await Promise.all([
      tenants(live, allIds),
      units([...baseUnits, ...visibleIds.flatMap((id) => [`fetchr-agent@${id}`, `fetchr-rec-api@${id}`])]),
    ]);
    const tenantRows = tenantInfo.rows;
    const suspendedSet = new Set(tenantRows.filter((row) => row.suspended).map((row) => row.id));
    const services = rawServices.map((unit) => {
      const m = /^fetchr-agent@([a-z0-9]{12})(?:\.service)?$/.exec(unit.name);
      return m && suspendedSet.has(m[1]) ? { ...unit, suspended: true } : unit;
    });
    const mem = parseMeminfo(memText);
    const latest = state.history.at(-1) || {};
    const cpus = (await proc("stat").catch(() => "")).split("\n").filter((row) => /^cpu\d+ /.test(row)).length;
    return {
      generated_at: new Date(at).toISOString(),
      host: {
        uptime_sec: Number(String(uptimeText).split(" ")[0]) || 0,
        cpus,
        cpu_pct: latest.cpu ?? null,
        cpu_iowait_pct: latest.iowait ?? null,
        io_psi: parseIoPsi(psiText),
        load: parseLoadavg(loadText),
        mem,
      },
      disks: disksNow,
      storage: {
        hot_bytes: hotBytes,
        sold_bytes: tenantInfo.soldBytesAll,
        sold_active_bytes: tenantInfo.soldActiveBytesAll,
      },
      net: {
        iface: state.last?.iface || null,
        rx_bps: latest.rx ?? null,
        tx_bps: latest.tx ?? null,
        today: trafficSince(state.days, dayOf(at)),
        last_72h: trafficSince(state.days, dayBefore(at, 2)),
        last_30d: trafficSince(state.days, dayBefore(at, 29)),
        days: Object.entries(state.days).sort(([a], [z]) => a.localeCompare(z)).slice(-30).map(([day, value]) => ({ day, ...value })),
        counted_since: Object.keys(state.days).sort()[0] || null,
      },
      recording: {
        live,
        live_count: live.length,
        total_live_count: allLive.length,
        stalled_count: live.filter((row) => row.stalled).length,
        channels_watched: tenantRows.reduce((sum, row) => sum + row.channels.length, 0),
        restream_slots_sold: tenantRows.filter((row) => !row.suspended).reduce((sum, row) => sum + row.restream.slots, 0),
        restream_slots_total: restreamSlots,
        restream_live_outputs: tenantRows.reduce((sum, row) => sum + row.restream.live_outputs, 0),
        restream_failed_outputs: tenantRows.reduce((sum, row) => sum + (row.restream_failed_outputs || 0), 0),
      },
      tenants: tenantRows,
      services,
      history: state.history.filter((point) => point.t >= at - 24 * 3_600_000),
    };
  }

  return { sample, start, snapshot, persist };
}
