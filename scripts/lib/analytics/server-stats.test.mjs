import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

import {
  STALLED_AFTER_SEC,
  addTraffic,
  counterDelta,
  cpuIowaitPercent,
  cpuPercent,
  createServerStats,
  mainIface,
  parseCpu,
  parseCpuIowait,
  parseIoPsi,
  parseLoadavg,
  parseMeminfo,
  parseNetDev,
  parseUnits,
  trafficSince,
} from "./server-stats.mjs";

const NET_DEV = `Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo: 5000 10 0 0 0 0 0 0 5000 10 0 0 0 0 0 0
  eth0: RXBYTES 100 0 0 0 0 0 0 TXBYTES 50 0 0 0 0 0 0
`;
const netDev = (rx, tx) => NET_DEV.replace("RXBYTES", String(rx)).replace("TXBYTES", String(tx));
const statText = (busy, idle) => `cpu  ${busy} 0 0 ${idle} 0 0 0 0 0 0\ncpu0 1 0 0 1 0 0 0 0\ncpu1 1 0 0 1 0 0 0 0\n`;
const MEMINFO = "MemTotal:        8000000 kB\nMemFree:          1000000 kB\nMemAvailable:    6000000 kB\nSwapTotal: 0 kB\nSwapFree: 0 kB\n";

describe("proc parsers", () => {
  test("cpu busy share between two readings", () => {
    const a = parseCpu(statText(100, 900));
    const b = parseCpu(statText(150, 950));
    assert.deepEqual(a, { idle: 900, total: 1000 });
    assert.equal(cpuPercent(a, b), 50);
    assert.equal(cpuPercent(null, b), null);
  });

  test("memory, load, network and the main interface", () => {
    assert.deepEqual(parseMeminfo(MEMINFO), { total: 8_192_000_000, available: 6_144_000_000, swap_total: 0, swap_free: 0 });
    assert.deepEqual(parseLoadavg("0.52 0.40 0.30 1/200 999"), [0.52, 0.4, 0.3]);
    const net = parseNetDev(netDev(724_000, 15_600));
    assert.deepEqual(net.eth0, { rx: 724_000, tx: 15_600 });
    assert.equal(mainIface(net), "eth0");
  });

  test("traffic survives a counter reset and sums by day", () => {
    assert.equal(counterDelta(100, 160), 60);
    assert.equal(counterDelta(1000, 40), 40);
    let days = addTraffic({}, "2026-11-08", 10, 1);
    days = addTraffic(days, "2026-11-09", 5, 2);
    days = addTraffic(days, "2026-11-09", 5, 2);
    assert.deepEqual(days["2026-11-09"], { rx: 10, tx: 4 });
    assert.deepEqual(trafficSince(days, "2026-11-09"), { rx: 10, tx: 4 });
    assert.deepEqual(trafficSince(days, "2026-11-01"), { rx: 20, tx: 5 });
  });

  test("systemctl show blocks", () => {
    const units = parseUnits("Id=nginx.service\nActiveState=active\nSubState=running\n\nId=fetchr-api.service\nActiveState=failed\nSubState=failed\n");
    assert.deepEqual(units, [
      { name: "nginx.service", state: "active", sub: "running" },
      { name: "fetchr-api.service", state: "failed", sub: "failed" },
    ]);
  });
});

function fakeServer() {
  const root = mkdtempSync(join(tmpdir(), "fetchr-server-stats-"));
  const proc = join(root, "proc");
  const tenants = join(root, "tenants");
  const hot = join(root, "hot");
  mkdirSync(join(proc, "net"), { recursive: true });
  writeFileSync(join(proc, "meminfo"), MEMINFO);
  writeFileSync(join(proc, "loadavg"), "1.00 0.50 0.25 1/100 1");
  writeFileSync(join(proc, "uptime"), "3600.5 100.0");

  const tenant = (id, { channels = [], live = null, writtenSecAgo = 0 } = {}) => {
    const data = join(tenants, id, "data");
    mkdirSync(join(data, "active"), { recursive: true });
    mkdirSync(join(hot, id), { recursive: true });
    writeFileSync(join(tenants, id, "config.json"), JSON.stringify({ quota_gb: 50, max_channels: 1, subscription: { plan: "start", paid_until: 1_800_000_000 } }));
    writeFileSync(join(data, "targets.json"), JSON.stringify({ targets: channels.map((channel) => ({ channel })) }));
    if (!live) return;
    const session = join(data, "buffer", live);
    mkdirSync(session, { recursive: true });
    writeFileSync(join(session, "seg_00000.ts"), Buffer.alloc(4096));
    writeFileSync(join(session, "run_00.csv"), "seg_00000.ts,0,10\nseg_00001.ts,10,20\n");
    const when = (Date.now() - writtenSecAgo * 1000) / 1000;
    utimesSync(join(session, "run_00.csv"), when, when);
    writeFileSync(join(data, "active", `${live}.json`), JSON.stringify({ session: live, channel: channels[0], started_at: Date.now() / 1000 - 600 }));
  };
  return { root, proc, tenants, hot, tenant };
}

describe("server stats", () => {
  test("samples rates and traffic, then reports live and stalled recordings", async () => {
    const fake = fakeServer();
    fake.tenant("aaaaaaaaaaaa", { channels: ["mafanyaking"], live: "sess_1", writtenSecAgo: 5 });
    fake.tenant("bbbbbbbbbbbb", { channels: ["rachelr"], live: "sess_2", writtenSecAgo: STALLED_AFTER_SEC + 60 });
    fake.tenant("cccccccccccc", { channels: [] });

    // Real time: recording progress is judged by real file times.
    let clock = Date.now();
    const stats = createServerStats({
      statePath: join(fake.root, "server-stats.json"),
      procRoot: fake.proc,
      tenantsRoot: fake.tenants,
      hotRoot: fake.hot,
      disks: [fake.root],
      baseUnits: [],
      now: () => clock,
    });
    writeFileSync(join(fake.proc, "stat"), statText(100, 900));
    writeFileSync(join(fake.proc, "net", "dev"), netDev(1_000_000, 500_000));
    const first = await stats.sample();
    assert.equal(first.cpu, null);
    assert.equal(first.rx, null);
    assert.equal(first.rec, 2);

    clock += 60_000;
    writeFileSync(join(fake.proc, "stat"), statText(175, 925));
    writeFileSync(join(fake.proc, "net", "dev"), netDev(1_000_000 + 7_500_000, 500_000 + 750_000));
    const second = await stats.sample();
    assert.equal(second.cpu, 75);
    assert.equal(second.rx, 1_000_000);
    assert.equal(second.tx, 100_000);

    const snap = await stats.snapshot();
    assert.equal(snap.host.cpus, 2);
    assert.equal(snap.host.cpu_pct, 75);
    assert.deepEqual(snap.host.load, [1, 0.5, 0.25]);
    assert.deepEqual(snap.net.today, { rx: 7_500_000, tx: 750_000 });
    assert.equal(snap.recording.live_count, 2);
    assert.equal(snap.recording.stalled_count, 1);
    assert.equal(snap.recording.channels_watched, 2);
    const live = Object.fromEntries(snap.recording.live.map((row) => [row.channel, row]));
    assert.equal(live.mafanyaking.segments, 2);
    assert.equal(live.mafanyaking.stalled, false);
    assert.equal(live.rachelr.stalled, true);
    assert.equal(snap.tenants.length, 3);
    const a = snap.tenants.find((row) => row.id === "aaaaaaaaaaaa");
    assert.equal(a.plan, "start");
    assert.equal(a.quota_bytes, 50e9);
    assert.ok(a.used_bytes >= 4096);
    assert.equal(a.live, 1);
    assert.equal(snap.disks.length, 1);
    assert.ok(snap.disks[0].total > 0);
    assert.equal(snap.history.length, 2);
    assert.ok(snap.history[1].disk > 0, "disk use is kept for the fill-up forecast");
  });

  test("hidden tenants leave the tables but still count in the host load", async () => {
    const fake = fakeServer();
    fake.tenant("aaaaaaaaaaaa", { channels: ["mafanyaking"], live: "sess_1", writtenSecAgo: 5 });
    fake.tenant("bbbbbbbbbbbb", { channels: ["rachelr"], live: "sess_2", writtenSecAgo: 5 });
    writeFileSync(join(fake.proc, "stat"), statText(100, 900));
    writeFileSync(join(fake.proc, "net", "dev"), netDev(1000, 1000));
    const stats = createServerStats({
      procRoot: fake.proc, tenantsRoot: fake.tenants, hotRoot: fake.hot, disks: [], baseUnits: [], hidden: ["bbbbbbbbbbbb"],
    });
    const point = await stats.sample();
    assert.equal(point.rec, 2);
    const snap = await stats.snapshot();
    assert.deepEqual(snap.tenants.map((row) => row.id), ["aaaaaaaaaaaa"]);
    assert.deepEqual(snap.recording.live.map((row) => row.channel), ["mafanyaking"]);
    assert.equal(snap.recording.live_count, 1);
    assert.equal(snap.recording.channels_watched, 1);
  });

  test("restream slots and live pushes are counted", async () => {
    const fake = fakeServer();
    fake.tenant("aaaaaaaaaaaa", { channels: ["mafanyaking"] });
    writeFileSync(join(fake.tenants, "aaaaaaaaaaaa", "config.json"), JSON.stringify({
      quota_gb: 50, max_channels: 1, subscription: { plan: "start", restream_streamers: 1, restream_extra: 2 },
    }));
    writeFileSync(join(fake.tenants, "aaaaaaaaaaaa", "data", "restream-status.json"), JSON.stringify({
      folders: { mafanyaking: { state: "live", outputs: [{ id: "yt0001", state: "live" }, { id: "kk0001", state: "live" }, { id: "vk0001", state: "error" }] } },
    }));
    writeFileSync(join(fake.proc, "stat"), statText(100, 900));
    writeFileSync(join(fake.proc, "net", "dev"), netDev(1000, 1000));
    const stats = createServerStats({ procRoot: fake.proc, tenantsRoot: fake.tenants, hotRoot: fake.hot, disks: [], baseUnits: [] });
    const snap = await stats.snapshot();
    assert.equal(snap.recording.restream_slots_sold, 3);
    assert.equal(snap.recording.restream_slots_total, 20);
    assert.equal(snap.recording.restream_live_outputs, 2);
    assert.deepEqual(snap.tenants[0].restream, { slots: 3, live_streamers: 1, live_outputs: 2 });
  });

  test("history and traffic survive a restart", async () => {
    const fake = fakeServer();
    const statePath = join(fake.root, "server-stats.json");
    let clock = Date.parse("2026-11-09T18:00:00Z");
    const make = () => createServerStats({ statePath, procRoot: fake.proc, tenantsRoot: fake.tenants, hotRoot: fake.hot, disks: [], baseUnits: [], now: () => clock });
    writeFileSync(join(fake.proc, "stat"), statText(100, 900));
    writeFileSync(join(fake.proc, "net", "dev"), netDev(1000, 1000));
    const one = make();
    await one.sample();
    clock += 60_000;
    writeFileSync(join(fake.proc, "net", "dev"), netDev(3000, 1500));
    await one.sample();
    one.persist();

    const two = make();
    clock += 60_000;
    writeFileSync(join(fake.proc, "net", "dev"), netDev(4000, 1600));
    await two.sample();
    const snap = await two.snapshot();
    assert.equal(snap.history.length, 3);
    assert.deepEqual(snap.net.today, { rx: 3000, tx: 600 });
  });

  test("parses iowait and IO PSI, tracks total_live_count, failed restream outputs and excludes suspended slots", async () => {
    const a = parseCpuIowait("cpu  100 0 0 800 100 0 0 0 0 0\n");
    const b = parseCpuIowait("cpu  120 0 0 840 140 0 0 0 0 0\n");
    assert.equal(cpuIowaitPercent(a, b), 40);
    const psi = parseIoPsi("some avg10=12.50 avg60=8.00 avg300=4.00 total=100\nfull avg10=45.20 avg60=30.10 avg300=10.00 total=50\n");
    assert.deepEqual(psi, { some_avg10: 12.5, some_avg60: 8, full_avg10: 45.2, full_avg60: 30.1 });

    const fake = fakeServer();
    fake.tenant("aaaaaaaaaaaa", { channels: ["ch1"], live: "sess_1", writtenSecAgo: 5 });
    fake.tenant("bbbbbbbbbbbb", { channels: ["ch2"], live: "sess_2", writtenSecAgo: 5 });
    fake.tenant("cccccccccccc", { channels: ["ch3"] });
    writeFileSync(join(fake.tenants, "aaaaaaaaaaaa", "config.json"), JSON.stringify({
      quota_gb: 50, max_channels: 1, subscription: { plan: "start", restream_streamers: 1, restream_extra: 1 },
    }));
    writeFileSync(join(fake.tenants, "aaaaaaaaaaaa", "data", "restream-status.json"), JSON.stringify({
      folders: { ch1: { state: "live", outputs: [{ id: "yt", state: "live" }, { id: "vk", state: "error" }] } },
    }));
    writeFileSync(join(fake.tenants, "cccccccccccc", "config.json"), JSON.stringify({
      quota_gb: 150, max_channels: 2, suspended: true, subscription: { plan: "streamer", restream_streamers: 2, restream_extra: 0 },
    }));
    mkdirSync(join(fake.proc, "pressure"), { recursive: true });
    writeFileSync(join(fake.proc, "pressure", "io"), "some avg10=5.00 avg60=4.00 avg300=1.00 total=1\nfull avg10=2.50 avg60=1.50 avg300=0.50 total=1\n");
    writeFileSync(join(fake.proc, "stat"), statText(100, 900));
    writeFileSync(join(fake.proc, "net", "dev"), netDev(1000, 1000));

    const stats = createServerStats({
      procRoot: fake.proc, tenantsRoot: fake.tenants, hotRoot: fake.hot, disks: [], baseUnits: [], hidden: ["bbbbbbbbbbbb"],
    });
    await stats.sample();
    const snap = await stats.snapshot();
    assert.equal(snap.recording.live_count, 1);
    assert.equal(snap.recording.total_live_count, 2);
    assert.equal(snap.recording.restream_slots_sold, 2, "suspended tenant slots excluded");
    assert.equal(snap.recording.restream_failed_outputs, 1);
    assert.equal(snap.recording.live[0].duration_sec, 20);
    assert.equal(snap.host.io_psi.full_avg10, 2.5);
    assert.equal(snap.storage.sold_bytes, 250e9, "includes hidden + visible quotas");
    assert.equal(snap.storage.sold_active_bytes, 100e9, "excludes suspended tenant quota");
  });
});
