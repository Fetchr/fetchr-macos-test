/** Bot, sales and job-log figures for the admin dashboard, reduced to counts.
 *
 * Inputs are the raw logs (bot activity, consents, licences, orders, job-log
 * file names); outputs never carry a user id, a name or a machine id. Daily
 * figures go into the same `{ day: { key: n } }` shape as the counters so the
 * report folds them into series and totals; the rest is a snapshot. */

import { existsSync, readdirSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

import { activeAddons, paidCoverage } from "../account-subscription.mjs";

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const ABANDONED_AFTER_MS = HOUR_MS;

const dayOf = (stamp) => String(stamp || "").slice(0, 10);
const monthOf = (stamp) => String(stamp || "").slice(0, 7);
const tally = (keys) => keys.reduce((out, key) => ({ ...out, [key]: (out[key] || 0) + 1 }), {});

/** Ruble value of an order: ignores non-RUB legacy currencies unless paid_amount is set. */
export function rubAmount(order) {
  if (!order) return 0;
  if (order.paid_amount != null) return Number(order.paid_amount) || 0;
  if (!order.currency || order.currency === "rub") return Number(order.amount) || 0;
  return 0;
}

export function starsAmount(order) {
  if (!order || order.method !== "stars") return 0;
  return Number(order.paid_total ?? order.stars) || 0;
}

function addTo(days, day, key, amount = 1) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return;
  days[day] = { ...days[day], [key]: (days[day]?.[key] || 0) + amount };
}

/** Last state of every order (the log holds snapshots). */
export function latestOrders(orders = []) {
  const byId = new Map();
  for (const order of orders) if (order?.id != null) byId.set(order.id, { ...byId.get(order.id), ...order });
  return [...byId.values()];
}

/** Orders that count. A card order another term or plan replaced
 *  (`superseded`) was never a separate purchase attempt: it is dropped. */
export const countedOrders = (orders = []) => latestOrders(orders).filter((order) => order.status !== "superseded");

/** A plan card with its payment link prepared when it opened (`source: "card"`):
 *  until paid it means «opened the card», not a checkout. */
export const isCardOrder = (order) => order?.source === "card";

/** Unpaid for an hour after a real checkout: Robokassa (site checkout, older
 *  invoice, add-on, or a card whose payment page was opened / tapped) or a
 *  Telegram Stars invoice. */
export function isAbandoned(order, now) {
  if (order.status !== "pending") return false;
  if (order.method === "robokassa") {
    if (isCardOrder(order) && !order.pay_tapped_at && !order.pay_clicked_at) return false;
    return now - Date.parse(order.created_at) > ABANDONED_AFTER_MS;
  }
  if (order.method === "stars") {
    return now - Date.parse(order.created_at) > ABANDONED_AFTER_MS;
  }
  return false;
}

/** «method:status», with an unpaid card shown as «method:card_opened». */
export const statusKey = (order) =>
  `${order.method || "other"}:${isCardOrder(order) && order.status !== "paid" ? "card_opened" : order.status || "?"}`;

/** Funnel of the plan cards: opened → paid (orders and people). */
export function cardFunnel(orders) {
  const cards = orders.filter(isCardOrder);
  const paid = cards.filter((order) => order.status === "paid");
  return {
    opened: cards.length,
    paid: paid.length,
    opened_users: new Set(cards.map((order) => order.user_id)).size,
    paid_users: new Set(paid.map((order) => order.user_id)).size,
  };
}

/** Daily bot and sales counters. */
export function botDays({ activity = [], consents = [], licenses = [], orders = [], followUps = [], now = Date.now() }) {
  const days = {};
  for (const row of followUps) {
    if (row?.sent) addTo(days, dayOf(row.at), `bot.followup:${row.step || "tips"}`);
    if (row?.off) addTo(days, dayOf(row.at), "bot.followup_off");
  }
  for (const row of activity) addTo(days, dayOf(row?.at), "bot.users");
  for (const row of consents) if (!row?.withdrawn) addTo(days, dayOf(row?.at), "bot.consents");
  for (const row of licenses) {
    if (row?.revoked_at) addTo(days, dayOf(row.revoked_at), `biz.revoked:${row.revoked_by || "manual"}`);
    else if (row?.issued_at) addTo(days, dayOf(row.issued_at), "biz.licenses");
  }
  for (const order of countedOrders(orders)) {
    const created = dayOf(order.created_at);
    const card = isCardOrder(order);
    if (card) {
      addTo(days, created, "biz.card_opened");
      if (order.status === "paid") addTo(days, dayOf(order.paid_at || order.created_at), "biz.card_paid");
    }
    // An opened card becomes an order once it is paid; older orders count as before.
    if (!card || order.status === "paid") {
      addTo(days, created, "biz.orders");
      addTo(days, created, `biz.method:${order.method || "other"}`);
    }
    if (isAbandoned(order, now)) addTo(days, created, "biz.abandoned");
    if (order.reminded_at) addTo(days, dayOf(order.reminded_at), "biz.reminded");
    if (order.status !== "paid" || order.method === "free") continue;
    const paidDay = dayOf(order.paid_at || order.created_at);
    const plan = String(order.plan_id || order.plan || "other").toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 32) || "other";
    const rub = rubAmount(order);
    const stars = starsAmount(order);
    addTo(days, paidDay, "biz.paid");
    addTo(days, paidDay, `biz.plan:${plan}`);
    if (order.reminded_at) addTo(days, paidDay, "biz.paid_after_reminder");
    if (rub > 0) addTo(days, paidDay, "biz.revenue", Math.round(rub));
    if (order.method === "stars") {
      addTo(days, paidDay, "biz.paid.stars");
      if (rub > 0) addTo(days, paidDay, "biz.revenue.stars", Math.round(rub));
      if (stars > 0) addTo(days, paidDay, "biz.stars", Math.round(stars));
    } else if (order.source === "site" || order.method === "robokassa") {
      addTo(days, paidDay, "biz.paid.site");
      if (rub > 0) addTo(days, paidDay, "biz.revenue.site", Math.round(rub));
    }
  }
  return days;
}

/** People per month at each bot step, and where keys and orders stand now. */
export function botSnapshot({ activity = [], consents = [], licenses = [], orders = [], now = Date.now() }) {
  const months = {};
  const step = (month, name, user) => {
    if (!/^\d{4}-\d{2}$/.test(month) || user == null) return;
    months[month] ||= { users: new Set(), consents: new Set(), keys: new Set(), paid: new Set() };
    months[month][name].add(user);
  };
  for (const row of activity) step(monthOf(row?.at), "users", row?.user_id);
  for (const row of consents) if (!row?.withdrawn) step(monthOf(row?.at), "consents", row?.user_id);
  for (const row of licenses) if (row?.issued_at && !row.revoked_at) step(monthOf(row.issued_at), "keys", row.telegram_user_id);
  const all = countedOrders(orders);
  const paid = all.filter((order) => order.status === "paid" && order.method !== "free");
  for (const order of paid) step(monthOf(order.paid_at || order.created_at), "paid", order.user_id);

  const live = new Map();
  const releaseRevoked = new Set();
  for (const row of licenses) {
    if (!row?.machine_id || !row.telegram_user_id) continue;
    const key = `${row.telegram_user_id}|${String(row.machine_id).toUpperCase()}`;
    if (row.revoked_at) {
      live.delete(key);
      if (row.revoked_by === "release") releaseRevoked.add(row.telegram_user_id);
    } else if (row.license_key) live.set(key, row.telegram_user_id);
  }
  const liveUsers = new Set(live.values());
  const keysPerUser = tally(licenses.filter((row) => row?.issued_at && !row.revoked_at && row.telegram_user_id).map((row) => row.telegram_user_id));
  const paidUsers = new Set(paid.map((order) => order.user_id));

  // Active paid subscriptions, MRR estimate and 7-day renewals.
  const byUser = new Map();
  for (const order of all) {
    if (order.user_id == null) continue;
    const list = byUser.get(order.user_id) || [];
    list.push(order);
    byUser.set(order.user_id, list);
  }
  let activePaidSubs = 0;
  let expiring7d = 0;
  let mrrRub = 0;
  for (const userOrderList of byUser.values()) {
    const spans = paidCoverage(userOrderList);
    const active = spans.find(({ from, until }) => from <= now && until > now);
    const maxUntil = spans.reduce((m, s) => Math.max(m, s.until), 0);
    if (active) {
      activePaidSubs += 1;
      const monthsCount = Math.max(1, Number(active.order.months) || 1);
      mrrRub += rubAmount(active.order) / monthsCount;
      if (maxUntil > now && maxUntil <= now + 7 * DAY_MS) expiring7d += 1;
    }
    for (const addon of activeAddons(userOrderList, now)) {
      const monthsCount = Math.max(1, Number(addon.months) || 1);
      mrrRub += rubAmount(addon) / monthsCount;
    }
  }
  const rubPaid = paid.filter((order) => rubAmount(order) > 0);

  return {
    by_month: Object.keys(months).sort().map((month) => ({
      month,
      users: months[month].users.size,
      consents: months[month].consents.size,
      keys: months[month].keys.size,
      paid: months[month].paid.size,
    })),
    users_with_live_key: liveUsers.size,
    users_ever_keyed: new Set(licenses.map((row) => row?.telegram_user_id).filter(Boolean)).size,
    users_paid: paidUsers.size,
    winback_candidates: [...releaseRevoked].filter((user) => !liveUsers.has(user)).length,
    keys_per_user: tally(Object.values(keysPerUser).map((count) => (count >= 5 ? "5+" : String(count)))),
    orders_by_status: tally(all.map(statusKey)),
    card_funnel: cardFunnel(all),
    average_check: rubPaid.length ? Math.round(rubPaid.reduce((sum, order) => sum + rubAmount(order), 0) / rubPaid.length) : 0,
    repeat_buyers: Object.values(tally(paid.map((order) => order.user_id))).filter((count) => count > 1).length,
    active_paid_subs: activePaidSubs,
    mrr_rub: Math.round(mrrRub),
    expiring_7d: expiring7d,
    stars_total: paid.reduce((sum, order) => sum + starsAmount(order), 0),
    site_paid_count: paid.filter((order) => order.source === "site" || order.method === "robokassa").length,
    stars_paid_count: paid.filter((order) => order.method === "stars").length,
    recent_orders: all
      .filter((order) => order.method !== "free" && (order.status === "paid" || order.source === "site" || !isCardOrder(order)))
      .map((order) => ({
        id: order.id,
        at: order.paid_at || order.created_at || null,
        source: order.source === "site" ? "site" : "bot",
        method: order.method || "",
        plan_id: order.plan_id || "",
        packs: Number(order.packs) || 0,
        months: Number(order.months) || 1,
        extra_channels: Number(order.extra_channels) || 0,
        restream_streamers: Number(order.restream_streamers) || 0,
        restream_extra: Number(order.restream_extra) || 0,
        currency: order.currency || "rub",
        amount: rubAmount(order),
        stars: starsAmount(order),
        status: order.status || "",
      }))
      .sort((a, z) => Date.parse(z.at || 0) - Date.parse(a.at || 0))
      .slice(0, 30),
  };
}

const JOB_FILE = /^(\d{6})_([A-F0-9]{8})_(done|error|cancelled)_([a-z_]+)_/;

function summarizeJobFiles(files) {
  const sorted = [...files].sort((a, b) => a.time.localeCompare(b.time));
  const days = {};
  for (const job of sorted) {
    addTo(days, job.day, `job.${job.status}`);
    addTo(days, job.day, `job.kind:${job.kind}:${job.status === "done" ? "done" : job.status === "error" ? "error" : "cancelled"}`);
  }
  const devices = new Map();
  for (const job of sorted) devices.set(job.device, [...(devices.get(job.device) || []), job]);
  const histories = [...devices.values()];
  return {
    days,
    snapshot: {
      devices: histories.length,
      first_job: tally(histories.map((jobs) => jobs[0].status)),
      never_succeeded: histories.filter((jobs) => jobs.every((job) => job.status !== "done")).length,
      first_failed_then_succeeded: histories.filter((jobs) => jobs[0].status === "error" && jobs.some((job) => job.status === "done")).length,
      jobs_per_device: tally(histories.map((jobs) => (jobs.length >= 10 ? "10+" : jobs.length >= 4 ? "4–9" : String(jobs.length)))),
      active_last_7d: histories.filter((jobs) => Date.parse(jobs.at(-1).day) > Date.now() - 7 * DAY_MS).length,
    },
  };
}

/** Job-log file names only (never opened): outcomes per day and kind, and what
 *  became of each reporting device. The reporter prefix is used to group and
 *  then dropped. */
export function jobLogStats(root) {
  if (!root || !existsSync(root)) return { days: {}, snapshot: null };
  const files = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(entry.name))
    .flatMap((dir) => readdirSync(join(root, dir.name)).map((name) => ({ day: dir.name, match: JOB_FILE.exec(name) })))
    .filter((file) => file.match)
    .map(({ day, match }) => ({ day, time: `${day}${match[1]}`, device: match[2], status: match[3], kind: match[4] }));
  return summarizeJobFiles(files);
}

/** Non-blocking async version of jobLogStats for request handlers. */
export async function jobLogStatsAsync(root) {
  if (!root || !existsSync(root)) return { days: {}, snapshot: null };
  let entries = [];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return { days: {}, snapshot: null };
  }
  const dayDirs = entries.filter((entry) => entry.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(entry.name));
  const files = [];
  for (const dir of dayDirs) {
    let names = [];
    try {
      names = await readdir(join(root, dir.name));
    } catch {
      continue;
    }
    for (const name of names) {
      const match = JOB_FILE.exec(name);
      if (match) files.push({ day: dir.name, time: `${dir.name}${match[1]}`, device: match[2], status: match[3], kind: match[4] });
    }
  }
  return summarizeJobFiles(files);
}

/** Counter maps added together (the report treats them as one source). */
export function mergeDays(...sources) {
  const out = {};
  for (const source of sources) {
    for (const [day, counts] of Object.entries(source || {})) {
      for (const [key, value] of Object.entries(counts)) addTo(out, day, key, value);
    }
  }
  return out;
}
