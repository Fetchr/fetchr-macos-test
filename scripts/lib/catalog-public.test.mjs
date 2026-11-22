import assert from "node:assert/strict";
import { test } from "node:test";

import { SALE_PLANS } from "./bot/catalog.mjs";
import { publicCatalog } from "./catalog-public.mjs";

test("the public list is the bot's catalog, plan for plan", () => {
  const catalog = publicCatalog(Date.parse("2026-11-20T12:00:00Z"));
  assert.deepEqual(catalog.plans.map((plan) => plan.id), SALE_PLANS.map((plan) => plan.id));
  assert.ok(!catalog.plans.some((plan) => ["archive", "max"].includes(plan.id)));
  const streamer = catalog.plans.find((plan) => plan.id === "streamer");
  assert.equal(streamer.price_rub, 500);
  assert.equal(streamer.quota_gb, 150);
  assert.equal(streamer.channels, 2);
  assert.ok(streamer.hours_1080p > 0);
  assert.equal(catalog.plans.find((plan) => plan.id === "free").free, true);
  assert.equal(catalog.period_days, 30);
  assert.equal(catalog.sale, null, "the 11.11 sale ended on 15 November");
  assert.equal(streamer.price_now_rub, 500);
});

test("during the sale the current price is discounted", () => {
  const catalog = publicCatalog(Date.parse("2026-11-11T12:00:00Z"));
  if (process.env.FETCHR_BOT_PROMO === "off") return;
  assert.equal(catalog.sale?.label, "11.11");
  assert.equal(catalog.sale?.max_percent, 50);
  assert.equal(catalog.sale?.percents.streamer[12], 50);
  assert.equal(catalog.plans.find((plan) => plan.id === "streamer").price_now_rub, 450);
});
