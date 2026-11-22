import assert from "node:assert/strict";
import { test } from "node:test";

import { effectiveSubscription, grantSubscription, subscriptionOf, unusedCredit } from "./account-subscription.mjs";

const DAY = 86_400_000;
const at = (iso) => Date.parse(iso);
const paid = (plan_id, paid_at, extra = {}) => ({ id: paid_at, plan_id, status: "paid", paid_at, ...extra });

test("no paid order means no subscription", () => {
  assert.equal(subscriptionOf([{ plan_id: "mini", status: "awaiting_payment" }]), null);
});

test("one payment covers 30 days from the payment", () => {
  const sub = subscriptionOf([paid("streamer", "2026-09-01T00:00:00Z", { quota_gb: 170, packs: 2 })], at("2026-09-11T00:00:00Z"));
  assert.equal(sub.active, true);
  assert.equal(sub.plan, "Стример");
  assert.equal(sub.quota_gb, 170);
  assert.equal(sub.channels, 2);
  assert.equal(sub.paid_until, "2026-10-01T00:00:00.000Z");
  assert.equal(sub.days_left, 20);
});

test("paying early extends the running period instead of overlapping", () => {
  const sub = subscriptionOf(
    [paid("start", "2026-09-01T00:00:00Z"), paid("archive", "2026-09-20T00:00:00Z")],
    at("2026-09-25T00:00:00Z"),
  );
  assert.equal(sub.paid_until, "2026-10-31T00:00:00.000Z");
  assert.equal(sub.plan, "Архив");
  assert.equal(sub.started_at, "2026-09-01T00:00:00.000Z");
});

test("a lapsed subscription is reported as inactive, a later payment restarts it", () => {
  const orders = [paid("mini", "2026-06-01T00:00:00Z")];
  assert.equal(subscriptionOf(orders, at("2026-08-01T00:00:00Z")).active, false);
  const renewed = subscriptionOf([...orders, paid("mini", "2026-08-01T00:00:00Z")], at("2026-08-02T00:00:00Z"));
  assert.equal(renewed.started_at, "2026-08-01T00:00:00.000Z");
  assert.equal(renewed.days_left, 29);
  assert.equal(Date.parse(renewed.paid_until) - Date.parse(renewed.started_at), 30 * DAY);
});

test("a grant by Machine ID shows as the subscription when nothing is paid", () => {
  const licenses = [{ machine_id: "AB".repeat(16), telegram_user_id: 5 }];
  const grants = [{ machine_id: "ab".repeat(16), plan: "streamer", quota_gb: 200, channels: 2, packs: 5, until: "2026-10-26T00:00:00Z" }];
  const granted = grantSubscription(grants, licenses, 5, at("2026-09-26T00:00:00Z"));
  assert.equal(granted.active, true);
  assert.equal(granted.quota_gb, 200);
  assert.equal(granted.days_left, 30);
  assert.equal(granted.period_days, 30);
  assert.equal(grantSubscription(grants, licenses, 6, at("2026-09-26T00:00:00Z")), null);
  assert.equal(effectiveSubscription(null, granted), granted);
  const paid = subscriptionOf([{ id: "x", plan_id: "mini", status: "paid", paid_at: "2026-09-20T00:00:00Z" }], at("2026-09-26T00:00:00Z"));
  assert.equal(effectiveSubscription(paid, granted), granted, "a bigger grant upgrades a running plan");
});

test("a running plan stays when the grant is no bigger", () => {
  const licenses = [{ machine_id: "AB".repeat(16), telegram_user_id: 5 }];
  const grants = [{ machine_id: "AB".repeat(16), plan: "start", quota_gb: 10, channels: 1, until: "2026-10-26T00:00:00Z" }];
  const granted = grantSubscription(grants, licenses, 5, at("2026-09-26T00:00:00Z"));
  const paid = subscriptionOf([{ id: "x", plan_id: "streamer", status: "paid", paid_at: "2026-09-20T00:00:00Z" }], at("2026-09-26T00:00:00Z"));
  assert.equal(effectiveSubscription(paid, granted), paid);
});

test("a 3-month payment covers 90 days", () => {
  const sub = subscriptionOf([paid("start", "2026-09-01T00:00:00Z", { months: 3 })], at("2026-09-02T00:00:00Z"));
  assert.equal(sub.paid_until, "2026-11-30T00:00:00.000Z");
});

test("unused days are worth their share of what was paid", () => {
  const orders = [paid("start", "2026-09-01T00:00:00Z", { amount: 300 })];
  assert.equal(unusedCredit(orders, at("2026-09-19T00:00:00Z")), 120);
  assert.equal(unusedCredit(orders, at("2026-10-05T00:00:00Z")), 0);
});

test("a queued renewal adds its full price to the credit", () => {
  const orders = [
    paid("start", "2026-09-01T00:00:00Z", { amount: 300 }),
    paid("start", "2026-09-10T00:00:00Z", { amount: 300 }),
  ];
  assert.equal(unusedCredit(orders, at("2026-09-19T00:00:00Z")), 420);
});

test("a payment with credit replaces the running period", () => {
  const orders = [
    paid("start", "2026-09-01T00:00:00Z", { amount: 300 }),
    paid("streamer", "2026-09-19T00:00:00Z", { months: 3, amount: 1305, credit: 120 }),
  ];
  const sub = subscriptionOf(orders, at("2026-09-20T00:00:00Z"));
  assert.equal(sub.plan_id, "streamer");
  assert.equal(sub.paid_until, "2026-12-18T00:00:00.000Z");
  assert.equal(unusedCredit(orders, at("2026-09-19T00:00:00Z")), 1305);
});

const free = (created_at, status = "paid") => ({ id: `f${created_at}`, plan_id: "free", method: "free", status, created_at, paid_at: status === "paid" ? created_at : undefined, quota_gb: 5 });

test("Free is active at once and never expires", () => {
  const sub = subscriptionOf([free("2026-01-01T00:00:00Z")], at("2027-06-01T00:00:00Z"));
  assert.equal(sub.active, true);
  assert.equal(sub.free, true);
  assert.equal(sub.plan_id, "free");
  assert.equal(sub.quota_gb, 5);
  assert.equal(sub.paid_until, null);
  assert.equal(sub.days_left, null);
});

test("an old Free request counts as switched on", () => {
  assert.equal(subscriptionOf([free("2026-10-01T00:00:00Z", "requested")], at("2026-11-09T00:00:00Z"))?.free, true);
});

test("a running paid plan wins over Free, and Free returns only after the grace days", () => {
  const orders = [free("2026-09-01T00:00:00Z"), paid("streamer", "2026-10-01T00:00:00Z", { months: 1, amount: 500 })];
  assert.equal(subscriptionOf(orders, at("2026-10-15T00:00:00Z")).plan_id, "streamer");
  const justEnded = subscriptionOf(orders, at("2026-11-03T00:00:00Z"));
  assert.equal(justEnded.plan_id, "streamer");
  assert.equal(justEnded.active, false, "recordings kept, no 5 GB cut yet");
  assert.equal(subscriptionOf(orders, at("2026-11-09T00:00:00Z")).plan_id, "free");
});

test("Free leaves no credit to carry into a paid plan", () => {
  assert.equal(unusedCredit([free("2026-11-01T00:00:00Z")], at("2026-11-09T00:00:00Z")), 0);
});

test("running storage add-ons add their gigabytes to the plan", () => {
  const plan = paid("start", "2026-09-01T00:00:00Z", { quota_gb: 50 });
  const addon = { id: "ad1", user_id: 1, kind: "addon", plan_id: "addons", packs: 2, quota_gb: 20, months: 1, status: "paid", paid_at: "2026-09-05T00:00:00Z", created_at: "2026-09-05T00:00:00Z" };
  const sub = subscriptionOf([plan, addon], at("2026-09-10T00:00:00Z"));
  assert.equal(sub.quota_gb, 70);
  assert.equal(sub.addon_packs, 2);
  assert.equal(subscriptionOf([plan, addon], at("2026-10-06T00:00:00Z")).quota_gb, 50);
});
