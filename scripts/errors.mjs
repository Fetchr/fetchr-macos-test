#!/usr/bin/env node
// Reads and names the error groups collected from Fetchr clients.
//
//   node scripts/errors.mjs list [--status open|fixed|ignored] [--limit 30]
//   node scripts/errors.mjs show <fingerprint>
//   node scripts/errors.mjs name <fingerprint> "<name>" [--status fixed] [--fixed-in 0.6.7] [--note "..."]
//
// ERRORS_ADMIN_TOKEN and FETCHR_VPS_API_URL come from the environment or
// build.env. The token deliberately has no FETCHR_ prefix: Vite exposes
// FETCHR_* variables to the frontend bundle.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_API = "https://fetchr.fun/api";
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g;

/** Client-supplied text reaches the terminal only without control codes. */
function safe(value) {
  return String(value ?? "").replace(CONTROL_CHARS, "");
}

function buildEnv() {
  const path = join(ROOT, "build.env");
  if (!existsSync(path)) return {};
  const values = {};
  for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const index = line.indexOf("=");
    values[line.slice(0, index).trim()] = line.slice(index + 1).trim();
  }
  return values;
}

function option(args, name) {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
}

async function call(api, token, path, body) {
  const response = await fetch(`${api}${path}`, {
    method: body ? "POST" : "GET",
    headers: {
      "x-admin-token": token,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${safe(payload.error || "request failed")}`);
  }
  return payload;
}

function printGroups({ total_groups: total, groups }) {
  console.log(`Групп всего: ${total}, показано: ${groups.length}\n`);
  for (const group of groups) {
    const title = group.name ? `«${safe(group.name)}»` : "(без названия)";
    console.log(`${safe(group.fingerprint)}  ${safe(group.status).padEnd(7)} ${title}`);
    console.log(
      `  ${safe(group.level)} ${safe(group.code)} | машин ${group.machines}, случаев ${group.occurrences} | ` +
        `версии ${safe(group.versions.join(", ")) || "?"} | последний раз ${safe(group.last_seen)}`,
    );
    console.log(`  ${safe(group.message)}\n`);
  }
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  const env = { ...buildEnv(), ...process.env };
  const token = env.ERRORS_ADMIN_TOKEN;
  const api = (env.FETCHR_VPS_API_URL || DEFAULT_API).replace(/\/$/, "");
  if (!token) throw new Error("ERRORS_ADMIN_TOKEN is not set (env or build.env)");

  if (command === "list" || !command) {
    const params = new URLSearchParams({ limit: option(args, "limit") || "30" });
    const status = option(args, "status");
    if (status) params.set("status", status);
    printGroups(await call(api, token, `/telemetry/errors?${params}`));
    return;
  }
  if (command === "show") {
    const [fingerprint] = args;
    const result = await call(
      api,
      token,
      `/telemetry/errors/group?fingerprint=${encodeURIComponent(fingerprint || "")}`,
    );
    // JSON.stringify escapes control characters, so this is terminal-safe.
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (command === "name") {
    const [fingerprint, name] = args;
    const body = { fingerprint, name };
    for (const key of ["status", "note"]) {
      const value = option(args, key);
      if (value !== undefined) body[key] = value;
    }
    const fixedIn = option(args, "fixed-in");
    if (fixedIn !== undefined) body.fixed_in = fixedIn;
    console.log(JSON.stringify(await call(api, token, "/telemetry/errors/name", body), null, 2));
    return;
  }
  throw new Error(`unknown command: ${command}`);
}

main().catch((err) => {
  console.error(safe(err instanceof Error ? err.message : err));
  process.exit(1);
});
