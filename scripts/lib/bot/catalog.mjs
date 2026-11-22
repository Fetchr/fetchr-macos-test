/** Archive VPS plans as the bot sells them.
 *
 * Mirrors src/ui/redesign/vps-recorder/plans.ts: the app's «Приобрести» button
 * deep-links here with a plan already picked, so the two must never describe
 * the same plan differently. catalog.test.mjs imports plans.ts and fails the
 * moment they drift. Rubles only: payment goes through Robokassa.
 */

const NBSP = "\u00a0";

export const CURRENCIES = [{ id: "rub", label: "Рубли", icon: "💳" }];

export const PLANS = [
  {
    id: "free",
    name: "Free",
    quotaGb: 5,
    price: { rub: 0 },
    channels: 1,
    tagline: "Попробовать",
  },
  {
    id: "mini",
    name: "Мини",
    quotaGb: 20,
    price: { rub: 100 },
    channels: 1,
    tagline: "Пара эфиров",
  },
  {
    id: "start",
    name: "Старт",
    quotaGb: 50,
    price: { rub: 200 },
    channels: 1,
    tagline: "Один канал",
  },
  {
    id: "streamer",
    name: "Стример",
    quotaGb: 150,
    price: { rub: 500 },
    channels: 2,
    tagline: "Обычный ритм",
  },
  {
    id: "archive",
    name: "Архив",
    quotaGb: 500,
    price: { rub: 1290 },
    channels: 5,
    tagline: "Глубокая история",
    retired: true,
  },
  {
    id: "max",
    name: "Макс",
    quotaGb: 1000,
    price: { rub: 2499 },
    channels: 5,
    tagline: "Без оглядки",
    retired: true,
  },
];

/** Retired plans stay in PLANS so running subscriptions keep resolving, but
 *  are no longer listed or sold. */
export function isOnSale(plan) {
  return Boolean(plan) && !plan.retired;
}

export const SALE_PLANS = PLANS.filter(isOnSale);

/** One stackable storage pack, priced per pack rather than per gigabyte. */
export const ADDON_STEP_GB = 10;
export const ADDON_PACK_PRICE = { rub: 30 };
export const MAX_PACKS = 20;

/** Days one payment covers. */
export const PLAN_PERIOD_DAYS = 30;

/** 1080p60 at 6.4 Mbit/s — the app's reference bitrate for plan quotes. */
const REFERENCE_BYTES_PER_SEC = 800_000;

export function planById(id) {
  return PLANS.find((plan) => plan.id === id) ?? null;
}

export function currencyById(id) {
  return CURRENCIES.find((currency) => currency.id === id) ?? null;
}

export function isCurrency(id) {
  return currencyById(id) !== null;
}

/** Free is excluded: one pack on top of it would undercut the entry plan. */
export function canAddPacks(plan) {
  return plan.price.rub > 0;
}

export function clampPacks(plan, packs) {
  if (!canAddPacks(plan)) return 0;
  return Math.min(MAX_PACKS, Math.max(0, Math.trunc(Number(packs) || 0)));
}

export function orderQuotaGb(plan, packs) {
  return plan.quotaGb + packs * ADDON_STEP_GB;
}

/** Prepaid terms. A longer term earns its own discount; it never stacks with
 *  the sale, the bigger of the two applies. */
export const TERMS = [
  { months: 1, percent: 0 },
  { months: 3, percent: 5 },
  { months: 6, percent: 10 },
  { months: 12, percent: 20 },
];

export function termByMonths(months) {
  return TERMS.find((term) => term.months === Number(months)) ?? TERMS[0];
}

export function clampMonths(months) {
  return termByMonths(months).months;
}

/** Paid add-ons on top of a plan, priced per month like storage packs.
 *  `channels` — extra streamers recorded at once; `restream` — streamers
 *  re-broadcast to other platforms, each with one platform included;
 *  `restreamExtra` — further platforms for those streamers. Restream takes the
 *  stream from the running recording, so the server pulls it from Twitch once. */
export const EXTRA_CHANNEL_PRICE = { rub: 100 };
export const RESTREAM_PRICE = { rub: 100 };
export const RESTREAM_EXTRA_PRICE = { rub: 50 };
export const MAX_EXTRA_CHANNELS = 5;
export const MAX_EXTRA_PLATFORMS_PER_STREAMER = 3;
/** Restream outputs the server can carry within its monthly traffic (see the
 *  admin «Сервер» advice): sales stop past this many across all buyers. */
export const RESTREAM_SLOTS = 20;
export const NO_EXTRAS = Object.freeze({ channels: 0, restream: 0, restreamExtra: 0 });

const count = (value, max) => Math.min(max, Math.max(0, Math.trunc(Number(value) || 0)));

/** Extras a plan can carry: none on Free, restream only for recorded streamers. */
export function clampExtras(plan, raw = {}) {
  if (!plan || !canAddPacks(plan)) return NO_EXTRAS;
  const channels = count(raw.channels, MAX_EXTRA_CHANNELS);
  const restream = count(raw.restream, plan.channels + channels);
  const restreamExtra = count(raw.restreamExtra, restream * MAX_EXTRA_PLATFORMS_PER_STREAMER);
  return { channels, restream, restreamExtra };
}

/** Compact form for callback data: `c1r2e0`, `c1r2e0s3` with storage packs;
 *  empty when nothing is added. */
export function extrasCode(extras = NO_EXTRAS) {
  const { channels = 0, restream = 0, restreamExtra = 0, packs = 0 } = extras;
  if (!channels && !restream && !restreamExtra && !packs) return "";
  return `c${channels}r${restream}e${restreamExtra}${packs ? `s${packs}` : ""}`;
}

export function parseExtras(code) {
  const match = /^c(\d{1,2})r(\d{1,2})e(\d{1,2})(?:s(\d{1,2}))?$/.exec(String(code || ""));
  if (!match) return NO_EXTRAS;
  const extras = { channels: Number(match[1]), restream: Number(match[2]), restreamExtra: Number(match[3]) };
  return match[4] ? { ...extras, packs: Number(match[4]) } : extras;
}

export const hasExtras = (extras = NO_EXTRAS) =>
  Boolean(extras.channels || extras.restream || extras.restreamExtra || extras.packs);

export function extrasMonthly(extras = NO_EXTRAS, currency = "rub") {
  return extras.channels * EXTRA_CHANNEL_PRICE[currency]
    + extras.restream * RESTREAM_PRICE[currency]
    + extras.restreamExtra * RESTREAM_EXTRA_PRICE[currency]
    + (extras.packs || 0) * ADDON_PACK_PRICE[currency];
}

/** Re-broadcast outputs an order holds: one per streamer plus the extra ones. */
export const restreamOutputs = (extras = NO_EXTRAS) => extras.restream + extras.restreamExtra;

/** Add-ons are their own product: bought on top of a running paid plan, for
 *  their own term, and they add up with the plan while they last. */
export const ADDONS_ID = "addons";
export const ADDONS_PRODUCT = Object.freeze({
  id: ADDONS_ID, name: "Доп. услуги", tagline: "Память, стримеры и рестрим", quotaGb: 0, channels: 0, price: { rub: 0 },
});

/** A plan, or the add-ons product, by the id an order carries. */
export const productById = (id) => (id === ADDONS_ID ? ADDONS_PRODUCT : planById(id));

/** Add-ons a buyer can take now. `recorded` — streamers their plan and the
 *  add-ons they hold already record; `restreaming` — of those, already restreamed. */
export function clampAddons(raw = {}, { recorded = 1, restreaming = 0 } = {}) {
  const channels = count(raw.channels, MAX_EXTRA_CHANNELS);
  const restream = count(raw.restream, Math.max(0, recorded + channels - restreaming));
  const restreamExtra = count(raw.restreamExtra, restream * MAX_EXTRA_PLATFORMS_PER_STREAMER);
  return { channels, restream, restreamExtra };
}

/** Add-ons for a term: monthly price × months, less the term discount. */
export function addonsTotal(extras = NO_EXTRAS, months = 1, currency = "rub") {
  const list = extrasMonthly(extras, currency) * clampMonths(months);
  return Math.round((list * (100 - termByMonths(months).percent)) / 100);
}

export const addonsListTotal = (extras = NO_EXTRAS, months = 1, currency = "rub") =>
  Math.round(extrasMonthly(extras, currency) * clampMonths(months));

/** List price for the whole term, before any discount. */
export function orderTotal(plan, packs, currency = "rub", months = 1, extras = NO_EXTRAS) {
  const monthly = plan.price[currency] + packs * ADDON_PACK_PRICE[currency] + extrasMonthly(clampExtras(plan, extras), currency);
  return Math.round(monthly * clampMonths(months));
}

/** 11.11 sale: percent by plan and term, applies to the whole order, runs
 *  from `from` to `until` on its own. */
const SALE_TERMS = { 1: 10, 3: 20, 6: 20, 12: 20 };
export const PROMO = {
  label: "11.11",
  from: "2026-11-09T00:00:00+03:00",
  until: "2026-11-15T23:59:59+03:00",
  untilLabel: "15 ноября",
  maxPercent: 50,
  percents: {
    mini: SALE_TERMS,
    start: SALE_TERMS,
    streamer: { ...SALE_TERMS, 6: 30, 12: 50 },
  },
};

/** FETCHR_BOT_PROMO=off switches the sale off early (and keeps list-price tests stable). */
export function promoActive(now = Date.now()) {
  if (process.env.FETCHR_BOT_PROMO === "off") return false;
  return now >= Date.parse(PROMO.from) && now <= Date.parse(PROMO.until);
}

export function promoPercent(plan, months = 1, now = Date.now()) {
  if (!promoActive(now) || !isOnSale(plan)) return 0;
  return PROMO.percents[plan.id]?.[clampMonths(months)] ?? 0;
}

/** The one discount an order gets: the sale or the term's, whichever is bigger. */
export function discountFor(plan, months = 1, now = Date.now()) {
  const sale = promoPercent(plan, months, now);
  const term = termByMonths(months).percent;
  if (sale === 0 && term === 0) return null;
  return sale >= term ? { kind: "promo", percent: sale } : { kind: "term", percent: term };
}

/** What the buyer pays: orderTotal minus the discount that applies. */
export function promoTotal(plan, packs, currency = "rub", now = Date.now(), months = 1, extras = NO_EXTRAS) {
  const total = orderTotal(plan, packs, currency, months, extras);
  const discount = discountFor(plan, months, now);
  return discount ? Math.round((total * (100 - discount.percent)) / 100) : total;
}

export function periodDays(months = 1) {
  return PLAN_PERIOD_DAYS * clampMonths(months);
}

export function fmtMonths(months) {
  const n = clampMonths(months);
  if (n === 1) return "1 месяц";
  return n < 5 ? `${n} месяца` : `${n} месяцев`;
}

export function hoursAt1080p(quotaGb) {
  return (quotaGb * 1e9) / REFERENCE_BYTES_PER_SEC / 3600;
}

function groupThousands(value) {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, NBSP);
}

/** Rubles charged per Star: 120 ₽ = 75 ⭐. */
export const RUB_PER_STAR = 1.6;

export function starsFor(rubles) {
  return Math.max(1, Math.ceil(rubles / RUB_PER_STAR));
}

export function fmtPrice(amount) {
  if (amount === 0) return "бесплатно";
  return `${groupThousands(Math.round(amount))} ₽`;
}

export function fmtQuota(quotaGb) {
  if (quotaGb >= 1000) {
    const tb = quotaGb / 1000;
    return `${Number.isInteger(tb) ? tb : tb.toFixed(1).replace(".", ",")}${NBSP}ТБ`;
  }
  return `${quotaGb}${NBSP}ГБ`;
}

export function fmtHours(hours) {
  if (hours < 1) return `${Math.round(hours * 60)}${NBSP}мин`;
  if (hours < 10) return `${hours.toFixed(1).replace(".", ",")}${NBSP}ч`;
  return `${Math.round(hours)}${NBSP}ч`;
}

/** The site's deep link: `buy_<plan>_p<packs>_<currency>`. Links from older
 *  app builds still say stars/usd/crypto; they land on the ruble price. */
export function parseCheckoutStart(payload) {
  const match = /^buy_([a-z]+)_p(\d{1,3})_([a-z]+)$/.exec(String(payload || ""));
  if (!match) return null;
  const plan = planById(match[1]);
  const packs = Number(match[2]);
  if (!isOnSale(plan) || !["rub", "stars", "usd", "crypto"].includes(match[3]) || packs > MAX_PACKS) return null;
  return { planId: plan.id, packs: clampPacks(plan, packs), currency: "rub", months: 1 };
}
