#!/usr/bin/env node
/** Why people leave: one JSON of aggregates for analysis, no ids or names.
 *
 *   node churn-snapshot.mjs /var/lib/fetchr > /tmp/fetchr-churn.json
 *
 * Bot funnel per month (started → consent → key → paid), what happens to keys
 * (revoked, reissued), what each device's first jobs ended with (from job
 * logs, per pseudonymous reporter prefix, never output), the most common
 * failure lines, open error groups and the dashboard report for 90 days. */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";

import { createCounters } from "./lib/analytics/counters.mjs";
import { cardFunnel, countedOrders, statusKey } from "./lib/analytics/ops-stats.mjs";
import { buildReport, businessCounts } from "./lib/analytics/report.mjs";
import { createErrorTelemetry } from "./lib/error-telemetry.mjs";
import { readAggregates, summarize } from "./lib/telemetry-summary.mjs";

const dataDir = process.argv[2] || "/var/lib/fetchr";
const month = (stamp) => String(stamp || "").slice(0, 7);

function lines(file) {
  const path = join(dataDir, file);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter(Boolean).flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
}

const tally = (rows) => rows.reduce((out, key) => ({ ...out, [key]: (out[key] || 0) + 1 }), {});
const uniquePerMonth = (rows, userOf, stampOf) => {
  const seen = {};
  for (const row of rows) {
    const m = month(stampOf(row));
    const user = userOf(row);
    if (!m || user == null) continue;
    (seen[m] ||= new Set()).add(user);
  }
  return Object.fromEntries(Object.entries(seen).sort().map(([m, users]) => [m, users.size]));
};

function botFunnel() {
  const activity = lines("bot-activity.jsonl");
  const consents = lines("bot-consents.jsonl").filter((row) => !row.withdrawn);
  const licenses = lines("beta-bot-licenses.jsonl");
  // Superseded card orders are dropped; an unpaid card counts as «card opened».
  const orders = countedOrders(lines("bot-orders.jsonl"));
  const paid = orders.filter((order) => order.status === "paid" && order.method !== "free");

  const keyUsers = new Set(licenses.map((row) => row.telegram_user_id).filter(Boolean));
  const paidUsers = new Set(paid.map((order) => order.user_id).filter(Boolean));
  const keysPerUser = tally(licenses.map((row) => row.telegram_user_id).filter(Boolean));

  return {
    bot_users_by_month: uniquePerMonth(activity, (row) => row.user_id, (row) => row.at),
    consents_by_month: uniquePerMonth(consents, (row) => row.user_id, (row) => row.at),
    key_users_by_month: uniquePerMonth(licenses, (row) => row.telegram_user_id, (row) => row.issued_at),
    keys_issued_by_month: tally(licenses.map((row) => month(row.issued_at))),
    keys_revoked_by_reason: tally(licenses.filter((row) => row.revoked_at).map((row) => row.revoked_by || "manual")),
    keys_per_user: tally(Object.values(keysPerUser).map((count) => (count >= 5 ? "5+" : String(count)))),
    users_with_key: keyUsers.size,
    users_paid: paidUsers.size,
    users_paid_with_key: [...paidUsers].filter((user) => keyUsers.has(user)).length,
    orders_by_status: tally(orders.map(statusKey)),
    card_funnel: cardFunnel(orders),
    paid_by_plan: tally(paid.map((order) => order.plan_id || order.plan || "other")),
    tickets_by_kind_month: tally(lines("bot-tickets.jsonl").filter((row) => row.type === "ticket").map((row) => `${month(row.created_at)} ${row.kind || "support"}`)),
  };
}

/** Folds a failure line into a pattern: numbers, paths, URLs and ids out. */
function pattern(line) {
  return line
    .replace(/https?:\/\/\S+/g, "<url>")
    .replace(/[A-Za-z]:\\[^\s"']+|\/(?:home|Users|tmp|var|mnt)\/[^\s"']+/g, "<path>")
    .replace(/[0-9a-f]{8,}/gi, "<id>")
    .replace(/\d+/g, "#")
    .replace(/^.*?\b(ERROR|WARN|error|failed|Failed|ошибк)/, "$1")
    .slice(0, 160);
}

function jobLogs() {
  const root = join(dataDir, "job-logs");
  if (!existsSync(root)) return { note: "no job-logs folder" };
  const files = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((dir) => readdirSync(join(root, dir.name)).map((name) => ({ dir: dir.name, name })))
    .map(({ dir, name }) => {
      const match = /^(\d{6})_([A-F0-9]{8})_(done|error|cancelled)_([a-z_]+)_/.exec(name);
      return match ? { dir, name, time: `${dir}${match[1]}`, device: match[2], status: match[3], kind: match[4] } : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.time.localeCompare(b.time));

  const devices = new Map();
  for (const file of files) devices.set(file.device, [...(devices.get(file.device) || []), file]);
  const firstOutcome = tally([...devices.values()].map((jobs) => jobs[0].status));
  const onlyFailures = [...devices.values()].filter((jobs) => jobs.every((job) => job.status !== "done"));
  const afterFirstError = [...devices.values()].filter((jobs) => jobs[0].status === "error");

  const failurePatterns = {};
  for (const file of files.filter((job) => job.status === "error").slice(-400)) {
    try {
      const text = gunzipSync(readFileSync(join(root, file.dir, file.name))).toString("utf8");
      const hits = text.split("\n").filter((line) => /\b(ERROR|error|failed|Failed)\b|ошибк/.test(line)).slice(-2);
      for (const hit of hits) {
        const key = `${file.kind}: ${pattern(hit)}`;
        failurePatterns[key] = (failurePatterns[key] || 0) + 1;
      }
    } catch {}
  }

  return {
    devices: devices.size,
    jobs_by_status_kind: tally(files.map((job) => `${job.kind}:${job.status}`)),
    first_job_outcome_per_device: firstOutcome,
    devices_never_succeeded: onlyFailures.length,
    devices_first_job_failed: afterFirstError.length,
    devices_first_job_failed_then_succeeded: afterFirstError.filter((jobs) => jobs.some((job) => job.status === "done")).length,
    jobs_per_device: tally([...devices.values()].map((jobs) => (jobs.length >= 10 ? "10+" : String(jobs.length)))),
    top_failure_lines: Object.entries(failurePatterns).sort((a, b) => b[1] - a[1]).slice(0, 40),
  };
}

async function errorGroups() {
  try {
    const telemetry = createErrorTelemetry({ dataDir, adminToken: "" });
    const { groups } = await telemetry.groups({ status: "", limit: 40 });
    return groups.map(({ name, code, source, message, occurrences, machines, versions, status, last_seen }) => ({
      name, code, source, status, message: pattern(String(message || "")), occurrences, machines, versions, last_seen,
    }));
  } catch (err) {
    return { error: err.message };
  }
}

const counters = createCounters({ path: join(dataDir, "analytics-counters.json"), flushMs: 0 });
const report = buildReport({
  counters,
  days: 90,
  business: businessCounts(lines("bot-orders.jsonl"), lines("beta-bot-licenses.jsonl")),
});
const aggregates = await readAggregates(join(dataDir, "telemetry-aggregates.json"));
const { top_streamers: _skip, ...allTime } = summarize(aggregates);

console.log(JSON.stringify({
  generated_at: new Date().toISOString(),
  bot: botFunnel(),
  job_logs: jobLogs(),
  error_groups: await errorGroups(),
  launches_by_month: aggregates.launches_by_month,
  all_time: allTime,
  dashboard_90d: { ...report, series: undefined, calendar: undefined },
}, null, 1));
