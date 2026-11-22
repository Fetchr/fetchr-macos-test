/** The daily cleanup: rolls raw telemetry into aggregates, then applies the
 *  retention rules to every data file. Each step logs what it removed, and a
 *  failing step does not stop the others. */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { pastActivity, readActivityArchive, readJsonLines } from "../bot/store.mjs";
import { foldEvents, readAggregates } from "../telemetry-summary.mjs";
import { createWebLoginBox } from "../web-login.mjs";
import { rewriteJsonLines, writeJsonAtomic } from "./jsonl-rewrite.mjs";
import {
  RETENTION_DAYS,
  purgeActivity,
  purgeBroadcastLog,
  purgeConsents,
  purgeErrors,
  purgeLicenses,
  purgeOrders,
  purgePayClicks,
  purgePayments,
  purgeSessions,
  purgeTelemetry,
  purgeTickets,
  usersPerMonth,
} from "./retention.mjs";

const DAY_MS = 86_400_000;
const DAY_DIR = /^\d{4}-\d{2}-\d{2}$/;

/** The paths the API server and the bot use, from the same variables. */
export function dataPaths(env = process.env) {
  const dataDir = resolve(env.FETCHR_VPS_DATA_DIR || "vps-data");
  const licenses = resolve(env.FETCHR_BETA_BOT_LOG || join(dataDir, "beta-bot-licenses.jsonl"));
  const botDir = resolve(env.FETCHR_BOT_DATA_DIR || env.FETCHR_VPS_DATA_DIR || dirname(licenses));
  return {
    dataDir,
    licenses,
    telemetry: join(dataDir, "telemetry.jsonl"),
    aggregates: join(dataDir, "telemetry-aggregates.json"),
    errors: join(dataDir, "errors.jsonl"),
    errorsRotated: join(dataDir, "errors.1.jsonl"),
    jobLogs: join(dataDir, "job-logs"),
    sessions: join(dataDir, "account-sessions.json"),
    payments: join(dataDir, "robokassa-payments.jsonl"),
    siteOrders: join(dataDir, "site-orders.jsonl"),
    payClicks: join(dataDir, "pay-clicks.jsonl"),
    webLogins: join(dataDir, "web-logins"),
    orders: resolve(env.FETCHR_BOT_ORDERS || join(botDir, "bot-orders.jsonl")),
    tickets: join(botDir, "bot-tickets.jsonl"),
    activity: join(botDir, "bot-activity.jsonl"),
    activityArchive: join(botDir, "bot-activity-archive.json"),
    consents: join(botDir, "bot-consents.jsonl"),
    followups: join(botDir, "bot-followups.jsonl"),
    winback: join(botDir, "bot-winback.jsonl"),
    promo: join(botDir, "bot-promo.jsonl"),
  };
}

const dayOf = (time) => new Date(time).toISOString().slice(0, 10);

function userIds(records, field = "user_id") {
  return new Set(records.map((record) => record?.[field]).filter(Number.isFinite));
}

function allActivity(paths) {
  return [
    ...readJsonLines(paths.activity),
    ...pastActivity({ licensesPath: paths.licenses, ordersPath: paths.orders, ticketsPath: paths.tickets }),
  ];
}

export async function rollUpTelemetry(paths, { now = Date.now(), dryRun = false } = {}) {
  const yesterday = dayOf(now - DAY_MS);
  const events = readJsonLines(paths.telemetry);
  // Rolling up and expiring the old log would lose the device count only the
  // migration can take from it.
  if (events.some((event) => event?.machine_id)) {
    throw new Error("telemetry.jsonl still holds machine_id: run vps-data-migrate-privacy.mjs first");
  }
  const current = await readAggregates(paths.aggregates);
  const next = foldEvents(current, events, { throughDay: yesterday });
  if (!dryRun) writeJsonAtomic(paths.aggregates, next);
  return { through_day: next.through_day, rows: next.downloads.length };
}

function purgeJobLogDirs(paths, { now, dryRun }) {
  if (!existsSync(paths.jobLogs)) return { removed: 0 };
  const cutoff = dayOf(now - RETENTION_DAYS.jobLogs * DAY_MS);
  const expired = readdirSync(paths.jobLogs).filter((day) => DAY_DIR.test(day) && day < cutoff);
  if (!dryRun) expired.forEach((day) => rmSync(join(paths.jobLogs, day), { recursive: true, force: true }));
  return { removed: expired.length };
}

/** The API server keeps sessions in memory and rewrites this file from them;
 *  its own sweep drops expired ones too, so no session comes back from here. */
function purgeSessionFile(paths, { now, dryRun }) {
  if (!existsSync(paths.sessions)) return { removed: 0 };
  const sessions = JSON.parse(readFileSync(paths.sessions, "utf8"));
  const kept = purgeSessions(sessions, now);
  if (!dryRun && kept.length !== sessions.length) writeJsonAtomic(paths.sessions, kept, { mode: 0o600 });
  return { before: sessions.length, removed: sessions.length - kept.length };
}

/** Keeps `/stats` whole: per-month counts and a running total survive the lines. */
async function purgeBotLogs(paths, { now, dryRun }) {
  const before = allActivity(paths);
  const archive = readActivityArchive(paths.activityArchive);
  const months = { ...archive.months };
  for (const [month, users] of Object.entries(usersPerMonth(before))) {
    months[month] = Math.max(months[month] ?? 0, users);
  }

  const options = { dryRun };
  const activity = await rewriteJsonLines(paths.activity, (records) => purgeActivity(records, now), options);
  const tickets = await rewriteJsonLines(paths.tickets, (records) => purgeTickets(records, now), options);
  const licenses = await rewriteJsonLines(paths.licenses, (records) => purgeLicenses(records, now), options);

  const accounts = new Set([
    ...userIds(readJsonLines(paths.licenses), "telegram_user_id"),
    ...userIds(readJsonLines(paths.orders)),
  ]);
  const consents = await rewriteJsonLines(paths.consents, (records) => purgeConsents(records, accounts, now), options);

  if (!dryRun) {
    const left = userIds(allActivity(paths));
    const dropped = [...userIds(before)].filter((id) => !left.has(id)).length;
    writeJsonAtomic(paths.activityArchive, { months, dropped_total: archive.dropped_total + dropped });
  }
  return { activity, tickets, licenses, consents };
}

export async function runCleanup(paths, { now = Date.now(), dryRun = false, log = console.log } = {}) {
  const options = { now, dryRun };
  const steps = {
    // Aggregates first: raw events may only expire once they are counted.
    "telemetry rollup": () => rollUpTelemetry(paths, options),
    "telemetry.jsonl": () => rewriteJsonLines(paths.telemetry, (records) => purgeTelemetry(records, now), { dryRun }),
    "bot logs and licenses": () => purgeBotLogs(paths, options),
    "errors.jsonl": () => rewriteJsonLines(paths.errors, (records) => purgeErrors(records, now), { dryRun }),
    "errors.1.jsonl": () => rewriteJsonLines(paths.errorsRotated, (records) => purgeErrors(records, now), { dryRun }),
    "job-logs": () => purgeJobLogDirs(paths, options),
    "account-sessions.json": () => purgeSessionFile(paths, options),
    "bot-orders.jsonl": () => rewriteJsonLines(paths.orders, (records) => purgeOrders(records, now), { dryRun }),
    "site-orders.jsonl": () => rewriteJsonLines(paths.siteOrders, (records) => purgeOrders(records, now), { dryRun }),
    "robokassa-payments.jsonl": () => rewriteJsonLines(paths.payments, (records) => purgePayments(records, now), { dryRun }),
    "pay-clicks.jsonl": () => rewriteJsonLines(paths.payClicks, (records) => purgePayClicks(records, now), { dryRun }),
    "bot-followups.jsonl": () => rewriteJsonLines(paths.followups, (records) => purgeBroadcastLog(records, now), { dryRun }),
    "bot-winback.jsonl": () => rewriteJsonLines(paths.winback, (records) => purgeBroadcastLog(records, now), { dryRun }),
    "bot-promo.jsonl": () => rewriteJsonLines(paths.promo, (records) => purgeBroadcastLog(records, now), { dryRun }),
    "web-logins": () => {
      if (!dryRun && paths.webLogins) createWebLoginBox(paths.webLogins, { now: () => now }).sweep();
      return { swept: Boolean(paths.webLogins) };
    },
  };
  let failed = 0;
  let rollupFailed = false;
  for (const [name, step] of Object.entries(steps)) {
    // Without a rollup, expiring raw events would lose them for good.
    if (name === "telemetry.jsonl" && rollupFailed) {
      log("cleanup: telemetry.jsonl skipped until the rollup works");
      continue;
    }
    try {
      log(`cleanup: ${name}: ${JSON.stringify(await step())}${dryRun ? " (dry run)" : ""}`);
    } catch (err) {
      failed += 1;
      log(`cleanup: ${name} FAILED: ${err instanceof Error ? err.message : err}`);
      rollupFailed ||= name === "telemetry rollup";
    }
  }
  return failed;
}

const broadcastMark = (prefix, value) => createHash("sha256").update(`${prefix}:${value}`).digest("hex").slice(0, 24);

/** A deletion request through support. Paid orders and payments stay for tax accounting. */
export async function deleteUser(paths, userId, { dryRun = false, log = console.log } = {}) {
  const others = (field) => (records) => records.filter((record) => record?.[field] !== userId);
  const options = { dryRun };
  const dropUnpaidOfUser = (records) => {
    const latest = new Map();
    for (const record of records) if (record?.id) latest.set(record.id, record);
    return records.filter((record) => {
      if (record?.user_id !== userId) return true;
      const status = (record?.id ? latest.get(record.id)?.status : record?.status) || "pending";
      return status === "paid" || status === "refunded" || status === "underpaid";
    });
  };
  const dripMarks = new Set([
    broadcastMark("fetchr-drip", userId),
    broadcastMark("fetchr-drip", `${userId}:tips`),
    broadcastMark("fetchr-drip", `${userId}:archive`),
  ]);
  const winbackMark = broadcastMark("fetchr-winback", userId);
  const promoMark = broadcastMark("fetchr-promo", userId);
  const results = {
    licenses: await rewriteJsonLines(paths.licenses, others("telegram_user_id"), options),
    consents: await rewriteJsonLines(paths.consents, others("user_id"), options),
    activity: await rewriteJsonLines(paths.activity, others("user_id"), options),
    unpaidSiteOrders: paths.siteOrders ? await rewriteJsonLines(paths.siteOrders, dropUnpaidOfUser, options) : { skipped: true },
    unpaidBotOrders: await rewriteJsonLines(paths.orders, dropUnpaidOfUser, options),
    followups: paths.followups
      ? await rewriteJsonLines(paths.followups, (rows) => rows.filter((r) => !dripMarks.has(r?.sent) && !dripMarks.has(r?.off)), options)
      : { skipped: true },
    winback: paths.winback
      ? await rewriteJsonLines(paths.winback, (rows) => rows.filter((r) => r?.mark !== winbackMark), options)
      : { skipped: true },
    promo: paths.promo
      ? await rewriteJsonLines(paths.promo, (rows) => rows.filter((r) => r?.mark !== promoMark), options)
      : { skipped: true },
    tickets: await rewriteJsonLines(
      paths.tickets,
      (records) => {
        const mine = new Set(records.filter((e) => e?.type === "ticket" && e.user_id === userId).map((e) => e.id));
        return records.filter((e) => !(e?.type === "ticket" ? mine.has(e.id) : e?.type === "link" && mine.has(e.ticket_id)));
      },
      options,
    ),
  };
  if (existsSync(paths.sessions)) {
    const sessions = JSON.parse(readFileSync(paths.sessions, "utf8"));
    const kept = sessions.filter((session) => session?.user_id !== userId);
    if (!dryRun && kept.length !== sessions.length) writeJsonAtomic(paths.sessions, kept, { mode: 0o600 });
    results.sessions = { removed: sessions.length - kept.length };
  }
  log(`delete-user: ${JSON.stringify(results)}${dryRun ? " (dry run)" : ""}`);
  return results;
}
