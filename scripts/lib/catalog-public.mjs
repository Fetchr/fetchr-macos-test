/** Public Archive VPS price list (`GET /catalog`), built from the bot's own
 * catalog so the site, the app and the bot can never quote different prices.
 * Prices are rubles per 30 days; `price_now_rub` already has the running sale. */

import {
  ADDON_PACK_PRICE,
  EXTRA_CHANNEL_PRICE,
  MAX_EXTRA_CHANNELS,
  MAX_EXTRA_PLATFORMS_PER_STREAMER,
  RESTREAM_EXTRA_PRICE,
  RESTREAM_PRICE,
  ADDON_STEP_GB,
  MAX_PACKS,
  PLAN_PERIOD_DAYS,
  PROMO,
  SALE_PLANS,
  TERMS,
  hoursAt1080p,
  promoActive,
  promoTotal,
} from "./bot/catalog.mjs";

export function publicCatalog(now = Date.now()) {
  const sale = promoActive(now);
  return {
    currency: "rub",
    period_days: PLAN_PERIOD_DAYS,
    plans: SALE_PLANS.map((plan) => ({
      id: plan.id,
      name: plan.name,
      tagline: plan.tagline,
      quota_gb: plan.quotaGb,
      channels: plan.channels,
      hours_1080p: Math.round(hoursAt1080p(plan.quotaGb)),
      price_rub: plan.price.rub,
      price_now_rub: promoTotal(plan, 0, "rub", now, 1),
      free: plan.price.rub === 0,
    })),
    addon: { step_gb: ADDON_STEP_GB, price_rub: ADDON_PACK_PRICE.rub, max_packs: MAX_PACKS },
    extras: {
      channel_rub: EXTRA_CHANNEL_PRICE.rub,
      max_channels: MAX_EXTRA_CHANNELS,
      restream_rub: RESTREAM_PRICE.rub,
      restream_extra_rub: RESTREAM_EXTRA_PRICE.rub,
      platforms_per_streamer: MAX_EXTRA_PLATFORMS_PER_STREAMER,
    },
    terms: TERMS.map(({ months, percent }) => ({ months, percent })),
    sale: sale
      ? { label: PROMO.label, from: PROMO.from, until: PROMO.until, max_percent: PROMO.maxPercent, percents: PROMO.percents }
      : null,
  };
}
