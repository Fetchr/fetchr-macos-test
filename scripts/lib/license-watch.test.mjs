import assert from "node:assert/strict";
import { test } from "node:test";

import { createLicenseWatch } from "./license-watch.mjs";

const MACHINE = "0123456789ABCDEF0123456789ABCDEF";
const HWID = `${MACHINE}${"A".repeat(32)}`;
const KEY = "FTR1.payload.signature-that-must-never-reach-the-log";
const OFFICIAL = "B".repeat(64);

const request = (extra = {}) => ({
  machine_id: MACHINE,
  license_key: KEY,
  app_version: "0.6.6",
  hwid_sha256: HWID,
  executable_sha256: OFFICIAL,
  ...extra,
});

function watch(options = {}) {
  const logs = [];
  const instance = createLicenseWatch({ log: (line) => logs.push(line), ...options });
  return { logs, observe: instance.observe };
}

test("without a list of official builds the executable hash is not judged", () => {
  const { logs, observe } = watch();
  observe(request({ executable_sha256: "C".repeat(64) }), "1.1.1.1");
  assert.deepEqual(logs, []);
});

test("an unknown executable is reported once per machine and hash", () => {
  const { logs, observe } = watch({ officialExeHashes: [OFFICIAL.toLowerCase()] });
  observe(request(), "1.1.1.1");
  assert.deepEqual(logs, []);
  observe(request({ executable_sha256: "C".repeat(64) }), "1.1.1.1");
  observe(request({ executable_sha256: "C".repeat(64) }), "1.1.1.1");
  assert.equal(logs.length, 1);
  assert.match(logs[0], /unknown executable/);
  assert.match(logs[0], /0\.6\.6/);
});

test("a hardware hash that does not produce the machine id is reported once", () => {
  const { logs, observe } = watch();
  observe(request({ hwid_sha256: "F".repeat(64) }), "1.1.1.1");
  observe(request({ hwid_sha256: "F".repeat(64) }), "1.1.1.1");
  assert.equal(logs.length, 1);
  assert.match(logs[0], /hwid does not match/);
});

test("one key checked from many addresses is reported once per window", () => {
  let time = 0;
  const { logs, observe } = watch({ shareIpThreshold: 3, windowMs: 1_000, now: () => time });
  for (const ip of ["1.0.0.1", "1.0.0.2", "1.0.0.3"]) observe(request(), ip);
  assert.deepEqual(logs, []);
  observe(request(), "1.0.0.4");
  observe(request(), "1.0.0.5");
  assert.equal(logs.length, 1);
  assert.match(logs[0], /4 addresses/);
  time += 1_001;
  for (const ip of ["2.0.0.1", "2.0.0.2", "2.0.0.3"]) observe(request(), ip);
  assert.equal(logs.length, 1);
});

test("log lines never carry the licence key itself", () => {
  const { logs, observe } = watch({ officialExeHashes: [OFFICIAL], shareIpThreshold: 1 });
  observe(request({ executable_sha256: "C".repeat(64), hwid_sha256: "F".repeat(64) }), "1.0.0.1");
  observe(request({ executable_sha256: "C".repeat(64), hwid_sha256: "F".repeat(64) }), "1.0.0.2");
  assert.equal(logs.length, 3);
  for (const line of logs) assert.equal(line.includes(KEY), false, line);
});
