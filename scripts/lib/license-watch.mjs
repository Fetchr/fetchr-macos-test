/** Log-only watch over `POST /license/status`: flags what a patched build or a
 *  shared key looks like, without refusing anyone yet.
 *
 * - an executable hash that is not one of the official builds
 *   (FETCHR_OFFICIAL_EXE_SHA256, comma-separated; empty = not judged);
 * - a hardware hash that does not produce the machine id — the app takes
 *   machine_id from the first 32 hex digits of hwid_sha256 (src-tauri/src/license.rs);
 * - one licence key checked from more than `shareIpThreshold` addresses
 *   inside `windowMs`.
 *
 * Each finding is logged once. Keys never reach the log, only a short hash. */

import { createHash } from "node:crypto";

const keyFingerprint = (key) => createHash("sha256").update(String(key || "")).digest("hex").slice(0, 12);

export function createLicenseWatch({
  officialExeHashes = [],
  shareIpThreshold = 5,
  windowMs = 24 * 3_600_000,
  maxKeys = 20_000,
  now = () => Date.now(),
  log = () => {},
}) {
  const official = new Set(officialExeHashes.map((hash) => String(hash).trim().toUpperCase()).filter(Boolean));
  const reported = new Set();
  const addresses = new Map();

  function once(tag, line) {
    if (reported.has(tag)) return;
    if (reported.size >= maxKeys) reported.clear();
    reported.add(tag);
    log(line);
  }

  function trackAddresses(keyId, machine, ip) {
    const stamp = now();
    const current = addresses.get(keyId);
    const entry = current && stamp - current.since <= windowMs
      ? current
      : { since: stamp, ips: new Set(), reported: false };
    const ips = new Set(entry.ips).add(String(ip || "unknown"));
    const crossed = !entry.reported && ips.size > shareIpThreshold;
    if (crossed) {
      const hours = Math.max(1, Math.round(windowMs / 3_600_000));
      log(`license-watch: key ${keyId} (machine ${machine}) checked from ${ips.size} addresses within ${hours} h`);
    }
    if (!addresses.has(keyId) && addresses.size >= maxKeys) addresses.delete(addresses.keys().next().value);
    addresses.set(keyId, { since: entry.since, ips, reported: entry.reported || crossed });
  }

  function observe(request, ip) {
    const machine = String(request?.machine_id || "").toUpperCase();
    const version = String(request?.app_version || "?").slice(0, 32);
    const exe = String(request?.executable_sha256 || "").trim().toUpperCase();
    if (official.size > 0 && !official.has(exe)) {
      once(
        `exe:${machine}:${exe}`,
        `license-watch: unknown executable ${exe.slice(0, 16) || "(none)"} from machine ${machine} (app ${version})`,
      );
    }
    const hwid = String(request?.hwid_sha256 || "").trim().toUpperCase();
    if (!machine || !hwid.startsWith(machine)) {
      once(`hwid:${machine}`, `license-watch: hwid does not match machine id ${machine} (app ${version})`);
    }
    trackAddresses(keyFingerprint(request?.license_key), machine, ip);
  }

  return { observe };
}
