#!/usr/bin/env node
// Moves everyone to new keys: revokes keys issued before a moment. NOT for
// ordinary releases — every revoked user has to come back to the bot, and many
// never do (2026-11: 100 revoked keys, most not renewed). Only when the license
// signing key itself is lost or leaked; --apply then also needs --key-lost.
// The cleanup job deletes them 30 days later, with the names inside them.
//
//   node scripts/vps-revoke-old-licenses.mjs --before 2026-12-01T12:00:00Z
//   node scripts/vps-revoke-old-licenses.mjs --before 2026-12-01T12:00:00Z --apply
//
// Publish the update first: a locked app still finds and installs it. Without
// --apply it only counts. Reads the same FETCHR_* variables as the services,
// which may keep running: they read this file on every check.

import { readJsonLines, appendJsonLine } from "./lib/bot/store.mjs";
import { dataPaths } from "./lib/privacy/data-cleanup.mjs";
import { releaseRevocations } from "./lib/privacy/retention.mjs";

const args = process.argv.slice(2);
const at = args.indexOf("--before");
const cutoff = at >= 0 ? Date.parse(args[at + 1]) : NaN;
if (!Number.isFinite(cutoff)) {
  console.error("Usage: vps-revoke-old-licenses.mjs --before <ISO time> [--apply]");
  process.exit(1);
}

const { licenses } = dataPaths();
const lines = releaseRevocations(readJsonLines(licenses), cutoff);
if (args.includes("--apply") && !args.includes("--key-lost")) {
  console.error("Refusing: revoking everyone is only for a lost or leaked signing key. Add --key-lost if that is the case.");
  process.exit(1);
}
if (args.includes("--apply")) lines.forEach((line) => appendJsonLine(licenses, line));
console.log(`${args.includes("--apply") ? "Revoked" : "Would revoke"} ${lines.length} key(s) in ${licenses}`);
