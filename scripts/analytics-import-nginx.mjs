#!/usr/bin/env node
/** Fills (or redoes) the dashboard's site history from nginx access logs.
 *
 * Run with fetchr-api stopped (it keeps the counters in memory):
 *   systemctl stop fetchr-api; node analytics-import-nginx.mjs --before=YYYY-MM-DD /var/lib/fetchr/analytics-counters.json /var/log/nginx/access.log*; systemctl start fetchr-api
 *
 * `--before` is the day the site beacon went live: later days are the beacon's.
 * For every earlier day the logs cover, the site counters are replaced, so an
 * earlier import with weaker robot filtering is redone, not added to. The
 * oldest day in the logs is usually cut by rotation and is only filled when
 * empty. App, sales and other counters are never touched. */

import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";

import { createCounters } from "./lib/analytics/counters.mjs";
import { countLogLines } from "./lib/analytics/nginx-import.mjs";

const MARK_DAY = "0000-00-00";
const DONE = "site.imported_human";
const SITE_KEYS = /^(site\.(pageviews|visitors|bots|engaged)$|page:|pagevis:|entry:|ref:|utm:|device:|os:|browser:|dl\.|dlpage:|ev:grab_|evpage:grab_|bot:)/;

const args = process.argv.slice(2);
const beforeDay = args.find((arg) => arg.startsWith("--before="))?.slice("--before=".length) || "";
const force = args.includes("--force");
const [countersPath, ...logs] = args.filter((arg) => !arg.startsWith("--"));
if (!countersPath || logs.length === 0 || !/^\d{4}-\d{2}-\d{2}$/.test(beforeDay)) {
  console.error("usage: analytics-import-nginx.mjs --before=YYYY-MM-DD [--force] <analytics-counters.json> <access.log>...");
  process.exit(2);
}

const counters = createCounters({ path: countersPath, flushMs: 0, log: console.error });
const marks = counters.range(MARK_DAY, MARK_DAY)[0]?.counts || {};
if (marks[DONE] && !force) {
  console.log("already imported with robot filtering, nothing to do (--force to redo)");
  process.exit(0);
}

const lines = logs.flatMap((file) => {
  try {
    const raw = readFileSync(file);
    return (file.endsWith(".gz") ? gunzipSync(raw) : raw).toString("utf8").split("\n");
  } catch (err) {
    console.error(`skip ${file}: ${err.message}`);
    return [];
  }
});

const { days } = countLogLines(lines, { beforeDay });
const covered = Object.keys(days).sort();
const oldest = covered[0];
const has = (day) => counters.range(day, day)[0]?.counts?.["site.pageviews"];

let replaced = 0;
for (const day of covered) {
  if (day === oldest && has(day)) continue;
  counters.remove(day, (key) => SITE_KEYS.test(key));
  for (const [key, value] of Object.entries(days[day])) counters.bump(key, value, day);
  replaced += 1;
}
counters.bump(DONE, 1, MARK_DAY);
await counters.flush();

const total = (key) => covered.reduce((sum, day) => sum + (days[day][key] || 0), 0);
console.log(
  `days ${covered[0] || "-"}..${covered.at(-1) || "-"} (${replaced} written, before ${beforeDay}); ` +
    `people ${total("site.visitors")}, views ${total("site.pageviews")}, robots ${total("site.bots")} ` +
    `(no js ${total("bot:no_js")}, agent ${total("bot:agent")})`,
);
