import assert from "node:assert/strict";
import { test } from "node:test";

import * as app from "../../../src/ui/redesign/vps-recorder/plans.ts";
import {
  ADDON_PACK_PRICE,
  ADDON_STEP_GB,
  CURRENCIES,
  MAX_PACKS,
  PLANS,
  canAddPacks,
  discountFor,
  fmtHours,
  fmtPrice,
  fmtQuota,
  hoursAt1080p,
  isCurrency,
  orderQuotaGb,
  orderTotal,
  parseCheckoutStart,
  SALE_PLANS,
  isOnSale,
  planById,
  promoActive,
  promoPercent,
  promoTotal,
  clampExtras,
  addonsTotal,
  extrasCode,
  parseExtras,
  restreamOutputs,
} from "./catalog.mjs";

const NBSP = "\u00a0";

test("extras: 100 \u20bd a streamer, 100 \u20bd a restreamed streamer, 50 \u20bd a further platform", () => {
  const start = planById("start");
  const extras = { channels: 1, restream: 2, restreamExtra: 1 };
  assert.equal(orderTotal(start, 0, "rub", 1, extras), 200 + 100 + 2 * 100 + 50);
  assert.equal(orderTotal(start, 2, "rub", 3, extras), (200 + 60 + 100 + 200 + 50) * 3);
  assert.equal(restreamOutputs(extras), 3);
});

test("extras are clamped to what the plan can carry", () => {
  const start = planById("start");
  assert.deepEqual(clampExtras(planById("free"), { channels: 3, restream: 1 }), { channels: 0, restream: 0, restreamExtra: 0 });
  // Restream only for streamers the plan records: \u0421\u0442\u0430\u0440\u0442 has one, +1 extra.
  assert.deepEqual(clampExtras(start, { channels: 1, restream: 5, restreamExtra: 99 }), { channels: 1, restream: 2, restreamExtra: 6 });
  assert.deepEqual(clampExtras(start, { channels: 99 }), { channels: 5, restream: 0, restreamExtra: 0 });
  assert.deepEqual(clampExtras(start, { restream: -2, restreamExtra: "x" }), { channels: 0, restream: 0, restreamExtra: 0 });
});

test("extras travel in callback data as a short code", () => {
  assert.equal(extrasCode({ channels: 1, restream: 2, restreamExtra: 0 }), "c1r2e0");
  assert.equal(extrasCode({ channels: 0, restream: 0, restreamExtra: 0 }), "");
  assert.deepEqual(parseExtras("c1r2e0"), { channels: 1, restream: 2, restreamExtra: 0 });
  assert.deepEqual(parseExtras("garbage"), { channels: 0, restream: 0, restreamExtra: 0 });
  assert.deepEqual(parseExtras(undefined), { channels: 0, restream: 0, restreamExtra: 0 });
});

test("the sale covers extras too", () => {
  const streamer = planById("streamer");
  const sale = Date.parse("2026-11-11T12:00:00+03:00");
  assert.equal(promoTotal(streamer, 0, "rub", sale, 12, { restream: 1 }), Math.round((500 + 100) * 12 * 0.5));
});

test("sells the reduced quotas", () => {
  assert.deepEqual(
    PLANS.map((plan) => [plan.id, plan.quotaGb]),
    [
      ["free", 5],
      ["mini", 20],
      ["start", 50],
      ["streamer", 150],
      ["archive", 500],
      ["max", 1000],
    ],
  );
});

test("add-on packs are 10 GB at the price-list rate", () => {
  assert.equal(ADDON_STEP_GB, 10);
  assert.deepEqual(ADDON_PACK_PRICE, { rub: 30 });
});

test("sells in rubles only", () => {
  assert.deepEqual(
    CURRENCIES.map((currency) => currency.id),
    ["rub"],
  );
  assert.ok(isCurrency("rub"));
  assert.ok(!isCurrency("stars"));
  assert.ok(!isCurrency("crypto"));
});

test("matches the app's subscription page plan for plan", () => {
  assert.equal(app.PLANS.length, PLANS.length);
  for (const appPlan of app.PLANS) {
    const plan = planById(appPlan.id);
    assert.ok(plan, `bot has no plan ${appPlan.id}`);
    assert.equal(plan.name, appPlan.name);
    assert.equal(plan.quotaGb * app.GB, appPlan.quota);
    assert.equal(plan.channels, appPlan.channels);
    assert.deepEqual(plan.price, { rub: appPlan.price });
  }
  const mini = app.planById("mini");
  assert.equal(app.totalQuota(mini, 1) - mini.quota, ADDON_STEP_GB * app.GB);
});

test("totals add packs", () => {
  const streamer = planById("streamer");
  assert.equal(orderTotal(streamer, 2, "rub"), 560);
  assert.equal(orderTotal(planById("max"), MAX_PACKS), 2499 + MAX_PACKS * 30);
  assert.equal(orderQuotaGb(streamer, 2), 170);
});

const SALE_DAY = Date.parse("2026-11-11T12:00:00+03:00");
const BEFORE_SALE = Date.parse("2026-11-08T23:59:00+03:00");
const AFTER_SALE = Date.parse("2026-11-16T00:00:00+03:00");

test("the 11.11 sale runs from 9 to 15 November", () => {
  assert.ok(!promoActive(BEFORE_SALE));
  assert.ok(promoActive(Date.parse("2026-11-09T00:00:00+03:00")));
  assert.ok(promoActive(SALE_DAY));
  assert.ok(promoActive(Date.parse("2026-11-15T23:59:00+03:00")));
  assert.ok(!promoActive(AFTER_SALE));
});

test("11.11: 10% for a month, Мини and Старт 20% for 3/6/12 months, Стример 20/30/50%", () => {
  for (const id of ["mini", "start"]) {
    const plan = planById(id);
    assert.equal(promoPercent(plan, 1, SALE_DAY), 10);
    for (const months of [3, 6, 12]) assert.equal(promoPercent(plan, months, SALE_DAY), 20);
  }
  const streamer = planById("streamer");
  assert.equal(promoPercent(streamer, 1, SALE_DAY), 10);
  assert.equal(promoPercent(streamer, 3, SALE_DAY), 20);
  assert.equal(promoPercent(streamer, 6, SALE_DAY), 30);
  assert.equal(promoPercent(streamer, 12, SALE_DAY), 50);
  assert.equal(promoPercent(planById("free"), 12, SALE_DAY), 0);
  assert.equal(promoPercent(streamer, 12, AFTER_SALE), 0);
});

test("the sale covers the whole order, packs included", () => {
  const streamer = planById("streamer");
  assert.equal(promoTotal(streamer, 0, "rub", SALE_DAY, 12), 3000);
  assert.equal(promoTotal(streamer, 2, "rub", SALE_DAY, 6), 2352);
  assert.equal(promoTotal(streamer, 2, "rub", SALE_DAY, 1), 504);
  assert.equal(promoTotal(planById("mini"), 0, "rub", SALE_DAY, 3), 240);
  assert.equal(promoTotal(planById("free"), 0, "rub", SALE_DAY, 1), 0);
  assert.equal(promoTotal(streamer, 0, "rub", AFTER_SALE, 12), 4800);
});

test("Архив and Макс are off sale but still resolve for running subscriptions", () => {
  assert.deepEqual(
    SALE_PLANS.map((plan) => plan.id),
    ["free", "mini", "start", "streamer"],
  );
  assert.ok(!isOnSale(planById("archive")));
  assert.ok(!isOnSale(planById("max")));
  assert.ok(isOnSale(planById("streamer")));
  assert.equal(planById("archive").name, "Архив");
  assert.equal(parseCheckoutStart("buy_archive_p0_rub"), null);
  assert.equal(parseCheckoutStart("buy_max_p0_rub"), null);
});

test("free plan takes no packs", () => {
  assert.ok(!canAddPacks(planById("free")));
  assert.ok(canAddPacks(planById("mini")));
});

test("formats prices like a shop, not like a float", () => {
  assert.equal(fmtPrice(2499, "rub"), `2${NBSP}499 ₽`);
  assert.equal(fmtPrice(0, "rub"), "бесплатно");
});

test("formats quotas and airtime", () => {
  assert.equal(fmtQuota(150), `150${NBSP}ГБ`);
  assert.equal(fmtQuota(1000), `1${NBSP}ТБ`);
  assert.equal(fmtQuota(1200), `1,2${NBSP}ТБ`);
  assert.equal(fmtHours(hoursAt1080p(5)), `1,7${NBSP}ч`);
  assert.equal(fmtHours(hoursAt1080p(150)), `52${NBSP}ч`);
  assert.equal(fmtHours(0.5), `30${NBSP}мин`);
});

test("reads the checkout deep link, old currencies land on rubles", () => {
  assert.deepEqual(parseCheckoutStart("buy_streamer_p2_usd"), {
    planId: "streamer",
    packs: 2,
    currency: "rub",
    months: 1,
  });
  assert.deepEqual(parseCheckoutStart("buy_mini_p0_rub"), {
    planId: "mini",
    packs: 0,
    currency: "rub",
    months: 1,
  });
  assert.deepEqual(parseCheckoutStart("buy_free_p3_stars"), {
    planId: "free",
    packs: 0,
    currency: "rub",
    months: 1,
  });
  assert.equal(parseCheckoutStart("buy_gold_p0_rub"), null);
  assert.equal(parseCheckoutStart(`buy_mini_p${MAX_PACKS + 1}_rub`), null);
  assert.equal(parseCheckoutStart("buy_mini_p1_eur"), null);
  assert.equal(parseCheckoutStart("fetchr_ABC"), null);
});

test("a longer term earns 5/10/20%, the bigger discount wins and never stacks", () => {
  const start = planById("start");
  const streamer = planById("streamer");
  assert.equal(orderTotal(start, 0, "rub", 3), 600);
  assert.equal(promoTotal(start, 0, "rub", AFTER_SALE, 1), 200);
  assert.equal(promoTotal(start, 0, "rub", AFTER_SALE, 3), 570);
  assert.equal(promoTotal(start, 0, "rub", AFTER_SALE, 6), 1080);
  assert.equal(promoTotal(start, 0, "rub", AFTER_SALE, 12), 1920);
  assert.equal(promoTotal(start, 0, "rub", SALE_DAY, 6), 960);
  assert.deepEqual(discountFor(start, 6, SALE_DAY), { kind: "promo", percent: 20 });
  assert.deepEqual(discountFor(start, 12, SALE_DAY), { kind: "promo", percent: 20 });
  assert.deepEqual(discountFor(streamer, 12, SALE_DAY), { kind: "promo", percent: 50 });
  assert.deepEqual(discountFor(start, 12, AFTER_SALE), { kind: "term", percent: 20 });
  assert.deepEqual(discountFor(start, 1, SALE_DAY), { kind: "promo", percent: 10 });
  assert.equal(discountFor(start, 1, AFTER_SALE), null);
  assert.equal(orderTotal(start, 0, "rub", 7), 200);
});

test("storage packs travel in the add-ons code and are priced per pack", () => {
  assert.equal(extrasCode({ channels: 0, restream: 0, restreamExtra: 0, packs: 3 }), "c0r0e0s3");
  assert.deepEqual(parseExtras("c0r0e0s3"), { channels: 0, restream: 0, restreamExtra: 0, packs: 3 });
  assert.equal(addonsTotal({ channels: 0, restream: 0, restreamExtra: 0, packs: 3 }, 1), 90);
});
