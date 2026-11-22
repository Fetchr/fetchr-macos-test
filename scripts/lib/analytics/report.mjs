/** The admin dashboard's data (`GET /admin/analytics?days=N`).
 *
 * Every number comes from the daily counters, compared with the N days
 * before, so the page can show what grows and what fades. Sales come from the
 * bot's order log, reduced to counts and sums — no buyer is named. */

import { dayKey } from "./counters.mjs";

const DAY_MS = 86_400_000;

export const SERIES = [
  "site.visitors",
  "site.pageviews",
  "ev:download_click",
  "dl.site",
  "dl.app",
  "app.installs",
  "app.active",
  "app.downloads",
  "app.job.done",
  "app.job.error",
  "ev:grab_job",
  "biz.licenses",
  "biz.orders",
  "biz.paid",
  "biz.paid.site",
  "biz.paid.stars",
  "biz.revenue",
  "biz.revenue.site",
  "biz.revenue.stars",
  "biz.stars",
  "biz.abandoned",
  "biz.card_opened",
  "biz.card_paid",
  "biz.reminded",
  "biz.paid_after_reminder",
  "bot.users",
  "bot.consents",
  "bot.followup_off",
  "ev:grab_info",
  "ev:grab_done",
  "ev:grab_error",
  "ev:bot_click",
  "ev:channel_click",
  "ev:cta_click",
  "site.engaged",
  "site.bots",
  "job.done",
  "job.error",
  "job.cancelled",
];

const BREAKDOWNS = {
  methods: "biz.method:",
  followups: "bot.followup:",
  revoked: "biz.revoked:",
  cta: "ev:cta_click:",
  bot_starts: "ev:bot_click:",
  pages: "page:",
  entries: "entry:",
  referrers: "ref:",
  utm: "utm:",
  devices: "device:",
  os: "os:",
  browsers: "browser:",
  site_events: "ev:",
  files: "dl.file:",
  versions: "app.version:",
  platforms: "app.dl.platform:",
  job_kinds: "app.dl.kind:",
  modes: "app.dl.mode:",
  types: "app.dl.type:",
  streamers: "app.dl.streamer:",
  screens: "app.screen:",
  qualities: "app.quality:",
  plans: "biz.plan:",
  download_pages: "evpage:download_click:",
  installer_pages: "dlpage:",
  robots: "bot:",
  grab_pages: "evpage:grab_job:",
};

function sumRows(rows) {
  const total = {};
  for (const { counts } of rows) {
    for (const [key, value] of Object.entries(counts)) total[key] = (total[key] || 0) + value;
  }
  return total;
}

const inGroup = (key, prefix) => key.startsWith(prefix) && !key.slice(prefix.length).includes(":");

function breakdown(current, previous, prefix, limit = 30) {
  return Object.entries(current)
    .filter(([key]) => inGroup(key, prefix))
    .map(([key, value]) => ({ key: key.slice(prefix.length), value, prev: previous[key] || 0 }))
    .concat(
      Object.entries(previous)
        .filter(([key]) => inGroup(key, prefix) && !(key in current))
        .map(([key, prev]) => ({ key: key.slice(prefix.length), value: 0, prev })),
    )
    .sort((a, b) => b.value - a.value || b.prev - a.prev || a.key.localeCompare(b.key))
    .slice(0, limit);
}

/** `app.feature:<name>:<outcome>` and the like → one row per name. */
function outcomes(current, previous, prefix) {
  const rows = new Map();
  const add = (source, field) => {
    for (const [key, value] of Object.entries(source)) {
      if (!key.startsWith(prefix)) continue;
      const rest = key.slice(prefix.length);
      const cut = rest.lastIndexOf(":");
      if (cut <= 0) continue;
      const name = rest.slice(0, cut);
      const outcome = rest.slice(cut + 1);
      const row = rows.get(name) || { key: name, done: 0, error: 0, cancelled: 0, prev: 0 };
      const bucket = outcome === "error" ? "error" : outcome === "cancelled" ? "cancelled" : "done";
      if (field === "prev") row.prev += bucket === "done" ? value : 0;
      else row[bucket] += value;
      rows.set(name, row);
    }
  };
  add(current, "now");
  add(previous, "prev");
  return [...rows.values()].sort(
    (a, b) => (b.done + b.error + b.cancelled) - (a.done + a.error + a.cancelled) || a.key.localeCompare(b.key),
  );
}

/** Bot orders and licences as daily counters (not persisted: rebuilt per report). */
export function businessCounts(orders = [], licenses = []) {
  const days = {};
  const bump = (day, key, amount = 1) => {
    if (!day) return;
    days[day] = { ...days[day], [key]: (days[day]?.[key] || 0) + amount };
  };
  for (const license of licenses) {
    if (license?.issued_at) bump(String(license.issued_at).slice(0, 10), "biz.licenses");
  }
  const latest = new Map();
  for (const order of orders) if (order?.id != null) latest.set(order.id, { ...latest.get(order.id), ...order });
  for (const order of latest.values()) {
    bump(String(order.created_at || "").slice(0, 10), "biz.orders");
    if (order.status !== "paid" || order.method === "free") continue;
    const day = String(order.paid_at || order.created_at || "").slice(0, 10);
    const plan = String(order.plan_id || order.plan || "other").toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 32) || "other";
    const rub = Number(order.paid_amount ?? (order.currency === "rub" || !order.currency ? order.amount : 0)) || 0;
    bump(day, "biz.paid");
    bump(day, `biz.plan:${plan}`);
    if (rub > 0) bump(day, "biz.revenue", Math.round(rub));
  }
  return days;
}

const PAGE_FIELDS = {
  views: "page:",
  visitors: "pagevis:",
  entries: "entry:",
  download_clicks: "evpage:download_click:",
  installer: "dlpage:",
  bot_clicks: "evpage:bot_click:",
  grab_info: "evpage:grab_info:",
  grab_jobs: "evpage:grab_job:",
  grab_done: "evpage:grab_done:",
  grab_errors: "evpage:grab_error:",
};

/** One row per site page: traffic, what people press and what they download there. */
function pageDetails(current, previous, limit = 80) {
  const pages = new Map();
  const row = (path) => {
    if (!pages.has(path)) {
      pages.set(path, { path, ...Object.fromEntries(Object.keys(PAGE_FIELDS).map((field) => [field, 0])), prev_views: 0, platforms: {}, kinds: {} });
    }
    return pages.get(path);
  };
  for (const [key, value] of Object.entries(current)) {
    for (const [field, prefix] of Object.entries(PAGE_FIELDS)) {
      if (inGroup(key, prefix)) row(key.slice(prefix.length))[field] += value;
    }
    const [kind, event, path, label] = key.split(":");
    if (event !== "grab_job" || !path || !label) continue;
    if (kind === "evpv") row(path).platforms[label] = (row(path).platforms[label] || 0) + value;
    if (kind === "evpk") row(path).kinds[label] = (row(path).kinds[label] || 0) + value;
  }
  for (const [key, value] of Object.entries(previous)) {
    if (inGroup(key, "page:") && pages.has(key.slice(5))) pages.get(key.slice(5)).prev_views += value;
  }
  return [...pages.values()]
    .filter((page) => page.path.startsWith("/"))
    .sort((a, b) => b.views - a.views || b.grab_jobs - a.grab_jobs || a.path.localeCompare(b.path))
    .slice(0, limit);
}

/** A level, not a count (channel members): the series carries the last known
 *  value forward, the total is the value at the end of each period. */
function gaugeOf(values, calendar, prevTo) {
  const known = Object.keys(values).sort();
  const at = (day) => {
    let value = null;
    for (const d of known) if (d <= day) value = values[d];
    return value;
  };
  return {
    since: known[0],
    series: calendar.map((day) => at(day) ?? 0),
    total: { value: at(calendar.at(-1)) ?? 0, prev: at(prevTo) ?? 0 },
  };
}

export function buildReport({ counters, days = 30, now = Date.now(), business = {}, errors = [], allTime = null, snapshots = {}, gauges = {} }) {
  const span = Math.max(1, Math.min(365, Math.round(days)));
  const today = dayKey(now);
  const from = dayKey(now - (span - 1) * DAY_MS);
  const prevFrom = dayKey(now - (2 * span - 1) * DAY_MS);
  const prevTo = dayKey(now - span * DAY_MS);

  const merged = (start, end) => {
    const rows = counters.range(start, end);
    const byDay = new Map(rows.map((row) => [row.day, { ...row.counts }]));
    for (const [day, counts] of Object.entries(business)) {
      if (day < start || day > end) continue;
      const base = byDay.get(day) || {};
      byDay.set(day, Object.fromEntries([...Object.entries(base), ...Object.entries(counts)]));
    }
    return [...byDay].map(([day, counts]) => ({ day, counts })).sort((a, b) => a.day.localeCompare(b.day));
  };

  const rows = merged(from, today);
  const prevRows = merged(prevFrom, prevTo);
  // First day each metric has data: the page must not compare with a period
  // when the metric was not collected yet.
  const since = {};
  for (const { day, counts } of merged("0001-01-01", today)) {
    for (const key of SERIES) if (counts[key] && !since[key]) since[key] = day;
  }
  // Sparse child metrics share their parent's collection start date so days with
  // zero occurrences render as 0 instead of "нет данных".
  const SPARSE_PARENTS = [
    ["biz.orders", ["biz.paid", "biz.paid.site", "biz.paid.stars", "biz.revenue", "biz.revenue.site", "biz.revenue.stars", "biz.stars", "biz.abandoned", "biz.reminded", "biz.paid_after_reminder"]],
    ["ev:grab_job", ["ev:grab_done", "ev:grab_error"]],
    ["job.done", ["job.error", "job.cancelled"]],
  ];
  for (const [parent, children] of SPARSE_PARENTS) {
    if (!since[parent]) continue;
    for (const child of children) {
      if (since[child] && since[parent] < since[child]) since[child] = since[parent];
    }
  }
  const gaugeRows = Object.entries(gauges).map(([key, values]) => [key, gaugeOf(values || {}, Array.from({ length: span }, (_, index) => dayKey(now - (span - 1 - index) * DAY_MS)), prevTo)]);
  for (const [key, gauge] of gaugeRows) if (gauge.since) since[key] = gauge.since;
  const current = sumRows(rows);
  const previous = sumRows(prevRows);
  const byDay = new Map(rows.map((row) => [row.day, row.counts]));
  const calendar = Array.from({ length: span }, (_, index) => dayKey(now - (span - 1 - index) * DAY_MS));

  return {
    generated_at: new Date(now).toISOString(),
    days: span,
    from,
    to: today,
    calendar,
    since,
    series: Object.fromEntries([
      ...SERIES.map((key) => [key, calendar.map((day) => byDay.get(day)?.[key] || 0)]),
      ...gaugeRows.map(([key, gauge]) => [key, gauge.series]),
    ]),
    totals: Object.fromEntries([
      ...[...SERIES, "app.dl.bytes", "app.dl.seconds", "site.bots", "site.engaged"].map((key) => [key, { value: current[key] || 0, prev: previous[key] || 0 }]),
      ...gaugeRows.map(([key, gauge]) => [key, gauge.total]),
    ]),
    breakdowns: Object.fromEntries(Object.entries(BREAKDOWNS).map(([name, prefix]) => [name, breakdown(current, previous, prefix)])),
    features: outcomes(current, previous, "app.feature:"),
    job_platforms: outcomes(current, previous, "app.job.platform:"),
    job_kinds: outcomes(current, previous, "app.job.kind:"),
    grab_platforms: breakdown(current, previous, "ev:grab_job:"),
    grab_kinds: breakdown(current, previous, "evk:grab_job:"),
    pages_detail: pageDetails(current, previous),
    errors,
    all_time: allTime,
    log_job_kinds: outcomes(current, previous, "job.kind:"),
    bot: snapshots.bot || null,
    job_logs: snapshots.jobs || null,
  };
}
