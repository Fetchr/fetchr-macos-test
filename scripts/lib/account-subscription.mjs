/** Archive VPS subscription as the personal account shows it, rebuilt from the
 *  bot's order log: every paid order buys periodDays(order.months), and a payment made
 *  while a period is still running extends it instead of overlapping. The plan
 *  and quota are the latest paid order's. */

import { PLAN_PERIOD_DAYS, fmtPrice, hoursAt1080p, periodDays, planById } from "./bot/catalog.mjs";

const DAY_MS = 86_400_000;
/** Recordings stay this long after a paid plan ends (privacy policy); Free
 *  takes over only afterwards, or its smaller quota would wipe them at once. */
export const PAID_GRACE_DAYS = 7;

/** The free plan: one order per user, no term, no price. */
export const isFreeOrder = (order) => order?.method === "free" || order?.plan_id === "free";

const METHOD_LABELS = { stars: "Telegram Stars", crypto: "Криптовалюта", rub: "Рубли" };

/** Last snapshot per order id, only this user's. */
export function userOrders(orderLines, userId) {
  const orders = new Map();
  for (const order of orderLines) if (order?.id && order.user_id === userId) orders.set(order.id, order);
  return [...orders.values()];
}

/** Paid orders in payment order, each with the stretch of time it covers.
 *  A plain payment queues after the running period; one that took the unused
 *  days as `credit` ends that period and starts the moment it is paid. */
/** Add-ons are their own product with their own term, outside the plan's periods. */
export const isAddonOrder = (order) => order?.kind === "addon";

/** Add-on orders running at `now`: each covers its own term from payment. */
export function activeAddons(orders, now = Date.now()) {
  return orders.filter((order) => {
    if (!isAddonOrder(order) || order.status !== "paid") return false;
    const from = Date.parse(order.paid_at);
    return Number.isFinite(from) && from <= now && now < from + periodDays(order.months ?? 1) * DAY_MS;
  });
}

export function paidCoverage(orders) {
  const paid = orders
    .filter((order) => !isFreeOrder(order) && !isAddonOrder(order) && order.status === "paid" && Number.isFinite(Date.parse(order.paid_at)))
    .sort((a, b) => Date.parse(a.paid_at) - Date.parse(b.paid_at));
  let until = 0;
  let startedAt = 0;
  let spans = [];
  for (const order of paid) {
    const paidAt = Date.parse(order.paid_at);
    const replaces = Number(order.credit) > 0;
    if (replaces) spans = spans.map((span) => ({ ...span, until: Math.min(span.until, paidAt) }));
    const from = replaces ? paidAt : Math.max(until, paidAt);
    if (replaces || paidAt > until) startedAt = paidAt;
    until = from + periodDays(order.months ?? 1) * DAY_MS;
    spans = [...spans, { order, from, until, startedAt }];
  }
  return spans;
}

/** Rubles left in the running period: what each covering order paid, for the
 *  share of its days not used yet. */
export function unusedCredit(orders, now = Date.now()) {
  const total = paidCoverage(orders)
    .filter(({ from, until }) => until > now && until > from)
    .reduce((sum, { order, from, until }) => {
      const full = periodDays(order.months ?? 1) * DAY_MS;
      return sum + (Number(order.amount) || 0) * ((until - Math.max(now, from)) / full);
    }, 0);
  return Math.floor(total);
}

/** Free never expires and starts the moment it is taken. Older free orders
 *  still "requested" (taken when an admin approved them by hand) count too. */
export function freeSubscription(orders) {
  const order = orders
    .filter((item) => isFreeOrder(item) && ["paid", "requested"].includes(item.status))
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))[0];
  if (!order) return null;
  const plan = planById("free");
  const quotaGb = order.quota_gb ?? plan?.quotaGb ?? 5;
  return {
    active: true,
    free: true,
    plan_id: "free",
    plan: plan?.name ?? "Free",
    tagline: plan?.tagline ?? "",
    quota_gb: quotaGb,
    packs: 0,
    channels: plan?.channels ?? 1,
    hours_1080p: Math.round(hoursAt1080p(quotaGb)),
    started_at: order.paid_at || order.created_at,
    paid_until: null,
    days_left: null,
    period_days: null,
  };
}

/** A running paid plan; else Free once the paid one is past its grace days;
 *  else the ended paid plan (so its recordings are kept), else nothing. */
export function subscriptionOf(orders, now = Date.now()) {
  const paid = paidSubscription(orders, now);
  if (paid?.active) return paid;
  const free = freeSubscription(orders);
  if (free && (!paid || now - Date.parse(paid.paid_until) > PAID_GRACE_DAYS * DAY_MS)) return free;
  return paid;
}

const whole = (value) => Math.max(0, Math.trunc(Number(value) || 0));

/** Paid add-ons an order (or a grant) carries: extra streamers and restream. */
export function orderExtras(order) {
  return {
    extra_channels: whole(order?.extra_channels),
    restream_streamers: whole(order?.restream_streamers),
    restream_extra: whole(order?.restream_extra),
  };
}

function paidSubscription(orders, now) {
  const spans = paidCoverage(orders);
  if (spans.length === 0) return null;

  // The latest order's plan applies at once, extending the running period.
  // The shop refuses a different plan or add-ons that the unused rubles of the
  // running period already cover (shop.mjs switchCredit), so this never hands
  // out a bigger plan for the rest of a long prepaid term.
  const { order: last, until, startedAt } = spans.at(-1);
  const plan = planById(last.plan_id);
  const addons = activeAddons(orders, now);
  const addonPacks = addons.reduce((sum, order) => sum + whole(order.packs), 0);
  const quotaGb = (last.quota_gb ?? plan?.quotaGb ?? 0) + addons.reduce((sum, order) => sum + whole(order.quota_gb), 0);
  const active = until > now;
  const extra = [last, ...addons].map(orderExtras).reduce((sum, item) => ({
    extra_channels: sum.extra_channels + item.extra_channels,
    restream_streamers: sum.restream_streamers + item.restream_streamers,
    restream_extra: sum.restream_extra + item.restream_extra,
  }));
  return {
    active,
    plan_id: last.plan_id,
    plan: plan?.name ?? last.plan_id,
    tagline: plan?.tagline ?? "",
    quota_gb: quotaGb,
    packs: Math.max(0, last.packs ?? 0),
    addon_packs: addonPacks,
    channels: (plan?.channels ?? 1) + extra.extra_channels,
    ...extra,
    hours_1080p: Math.round(hoursAt1080p(quotaGb)),
    started_at: new Date(startedAt).toISOString(),
    paid_until: new Date(until).toISOString(),
    days_left: active ? Math.ceil((until - now) / DAY_MS) : 0,
    period_days: Math.round((until - startedAt) / DAY_MS),
  };
}

/** A hand-issued plan from archive-grants.json, in the same shape as
 *  subscriptionOf. Matched by Telegram id, or by a Machine ID whose current
 *  key belongs to this user. */
export function grantSubscription(grants, licenses, userId, now = Date.now()) {
  const owns = (machineId) => {
    const id = String(machineId || "").toUpperCase();
    const latest = licenses.filter((record) => String(record.machine_id || "").toUpperCase() === id).at(-1);
    return Boolean(latest && !latest.revoked_at && latest.telegram_user_id === userId);
  };
  const grant = (Array.isArray(grants) ? grants : []).find(
    (item) => item.telegram_user_id === userId || (item.machine_id && owns(item.machine_id)),
  );
  if (!grant) return null;
  const plan = planById(grant.plan);
  const until = grant.until ? Date.parse(grant.until) : null;
  const active = until === null || until > now;
  const issued = grant.issued_at ? Date.parse(grant.issued_at) : null;
  const startedAt = Number.isFinite(issued) ? issued : until === null ? now : until - PLAN_PERIOD_DAYS * DAY_MS;
  return {
    active,
    granted: true,
    plan_id: grant.plan,
    plan: plan?.name ?? grant.plan,
    tagline: plan?.tagline ?? "",
    quota_gb: grant.quota_gb,
    packs: Math.max(0, grant.packs ?? 0),
    channels: grant.channels ?? plan?.channels ?? 1,
    restream_streamers: whole(grant.restream_streamers),
    restream_extra: whole(grant.restream_extra),
    hours_1080p: Math.round(hoursAt1080p(grant.quota_gb)),
    started_at: new Date(startedAt).toISOString(),
    paid_until: until === null ? null : new Date(until).toISOString(),
    days_left: until === null ? null : active ? Math.ceil((until - now) / DAY_MS) : 0,
    period_days: until === null ? null : Math.max(1, Math.round((until - startedAt) / DAY_MS)),
  };
}

/** A running paid plan wins unless a running grant is bigger: a grant is
 *  how a plan gets upgraded by hand. A grant covers the rest. */
export function effectiveSubscription(paid, granted) {
  if (paid?.active && granted?.active) return largerQuota(paid, granted);
  if (paid?.active) return paid;
  if (granted?.active) return granted;
  return paid || granted;
}

/** The plan with more storage; the paid one on a tie. */
export function largerQuota(paid, granted) {
  return (granted.quota_gb ?? 0) > (paid.quota_gb ?? 0) ? granted : paid;
}

/** Purchase history, newest first. */
export function purchaseHistory(orders, limit = 30) {
  return orders
    .slice()
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
    .slice(0, limit)
    .map((order) => ({
      id: order.id,
      plan: isAddonOrder(order) ? "Доп. услуги" : planById(order.plan_id)?.name ?? order.plan_id,
      quota_gb: order.quota_gb ?? null,
      status: order.status,
      method: METHOD_LABELS[order.method || order.currency] ?? null,
      amount: Number.isFinite(order.amount) && order.currency ? fmtPrice(order.amount, order.currency) : null,
      created_at: order.created_at,
      paid_at: order.paid_at || null,
    }));
}
