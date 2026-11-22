import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { botDays, botSnapshot, jobLogStats, jobLogStatsAsync, latestOrders, mergeDays } from "./ops-stats.mjs";

const NOW = Date.parse("2026-11-09T12:00:00Z");

const licenses = [
  { issued_at: "2026-10-01T10:00:00Z", machine_id: "A".repeat(32), license_key: "k1", telegram_user_id: 1 },
  { issued_at: "2026-10-01T10:00:00Z", machine_id: "A".repeat(32), license_key: "k1", telegram_user_id: 1, revoked_at: "2026-11-04T10:00:00Z", revoked_by: "release" },
  { issued_at: "2026-10-02T10:00:00Z", machine_id: "B".repeat(32), license_key: "k2", telegram_user_id: 2 },
  { issued_at: "2026-10-02T10:00:00Z", machine_id: "B".repeat(32), license_key: "k2", telegram_user_id: 2, revoked_at: "2026-11-04T10:00:00Z", revoked_by: "release" },
  { issued_at: "2026-11-05T10:00:00Z", machine_id: "B".repeat(32), license_key: "k3", telegram_user_id: 2 },
];
const orders = [
  { id: "A1", user_id: 2, method: "robokassa", status: "pending", plan_id: "start", amount: 230, created_at: "2026-11-08T09:00:00Z" },
  { id: "A1", status: "paid", paid_at: "2026-11-08T12:00:00Z", paid_amount: 230, reminded_at: "2026-11-08T10:00:00Z" },
  { id: "B2", user_id: 3, method: "robokassa", status: "pending", plan_id: "start", amount: 230, created_at: "2026-11-09T09:00:00Z" },
  { id: "C3", user_id: 4, method: "free", status: "requested", created_at: "2026-11-09T11:30:00Z" },
];
const activity = [
  { user_id: 1, at: "2026-10-01T09:00:00Z" },
  { user_id: 2, at: "2026-10-02T09:00:00Z" },
  { user_id: 2, at: "2026-11-05T09:00:00Z" },
  { user_id: 3, at: "2026-11-09T08:00:00Z" },
];
const consents = [{ user_id: 1, at: "2026-10-01T09:30:00Z" }, { user_id: 2, at: "2026-10-02T09:30:00Z" }];

test("orders collapse to their latest state", () => {
  assert.equal(latestOrders(orders).find((order) => order.id === "A1").status, "paid");
});

test("bot and sales become daily counters without ids", () => {
  const days = botDays({ activity, consents, licenses, orders, now: NOW });
  assert.equal(days["2026-11-04"]["biz.revoked:release"], 2);
  assert.equal(days["2026-11-05"]["biz.licenses"], 1);
  assert.equal(days["2026-11-08"]["biz.paid"], 1);
  assert.equal(days["2026-11-08"]["biz.paid_after_reminder"], 1);
  assert.equal(days["2026-11-08"]["biz.revenue"], 230);
  assert.equal(days["2026-11-08"]["biz.reminded"], 1);
  assert.equal(days["2026-11-09"]["biz.abandoned"], 1);
  assert.equal(days["2026-11-09"]["biz.method:free"], 1);
  assert.equal(days["2026-10-01"]["bot.consents"], 1);
  assert.equal(JSON.stringify(days).includes("user_id"), false);
});

test("snapshot: monthly funnel, live keys and win-back candidates", () => {
  const snap = botSnapshot({ activity, consents, licenses, orders });
  assert.deepEqual(snap.by_month, [
    { month: "2026-10", users: 2, consents: 2, keys: 2, paid: 0 },
    { month: "2026-11", users: 2, consents: 0, keys: 1, paid: 1 },
  ]);
  assert.equal(snap.users_with_live_key, 1);
  assert.equal(snap.winback_candidates, 1);
  assert.equal(snap.users_paid, 1);
  assert.equal(snap.average_check, 230);
});

test("job logs are read by file name only", () => {
  const root = mkdtempSync(join(tmpdir(), "fetchr-jobs-"));
  mkdirSync(join(root, "2026-11-08"));
  mkdirSync(join(root, "2026-11-09"));
  writeFileSync(join(root, "2026-11-08", "101010_AAAAAAAA_error_video_11111111.log.gz"), "");
  writeFileSync(join(root, "2026-11-09", "101010_AAAAAAAA_done_video_22222222.log.gz"), "");
  writeFileSync(join(root, "2026-11-09", "111010_BBBBBBBB_cancelled_chat_33333333.log.gz"), "");
  writeFileSync(join(root, "2026-11-09", "junk.txt"), "");
  const { days, snapshot } = jobLogStats(root);
  assert.equal(days["2026-11-09"]["job.done"], 1);
  assert.equal(days["2026-11-09"]["job.kind:chat:cancelled"], 1);
  assert.equal(snapshot.devices, 2);
  assert.equal(snapshot.first_failed_then_succeeded, 1);
  assert.equal(snapshot.never_succeeded, 1);
  assert.deepEqual(jobLogStats(join(root, "missing")), { days: {}, snapshot: null });
});

test("day maps add up", () => {
  assert.deepEqual(mergeDays({ "2026-11-09": { a: 1 } }, { "2026-11-09": { a: 2, b: 1 } }, null), { "2026-11-09": { a: 3, b: 1 } });
});

test("plan cards: superseded ones vanish, unpaid ones are «card opened», not abandoned", () => {
  const cards = [
    // Opened, switched to another term (superseded), never paid: nothing counts.
    { id: "S1", user_id: 7, method: "robokassa", source: "card", status: "pending", plan_id: "streamer", amount: 500, created_at: "2026-11-09T08:00:00Z" },
    { id: "S1", status: "superseded", superseded_at: "2026-11-09T08:01:00Z" },
    // The card that replaced it: only looked at.
    { id: "S2", user_id: 7, method: "robokassa", source: "card", status: "pending", plan_id: "streamer", amount: 4800, created_at: "2026-11-09T08:01:00Z" },
    // «Оплатить» tapped, unpaid for hours: a real abandoned checkout.
    { id: "S3", user_id: 8, method: "robokassa", source: "card", status: "pending", plan_id: "mini", amount: 100, created_at: "2026-11-09T08:00:00Z", pay_tapped_at: "2026-11-09T08:02:00Z" },
    // Opened and paid.
    { id: "S4", user_id: 9, method: "robokassa", source: "card", status: "pending", plan_id: "start", amount: 200, created_at: "2026-11-09T08:00:00Z" },
    { id: "S4", status: "paid", paid_at: "2026-11-09T08:05:00Z", paid_amount: 200 },
  ];
  const day = botDays({ orders: [...orders, ...cards], now: NOW })["2026-11-09"];
  assert.equal(day["biz.card_opened"], 3, "S2, S3, S4 — not the superseded S1");
  assert.equal(day["biz.card_paid"], 1);
  assert.equal(day["biz.abandoned"], 2, "the old-style B2 and the tapped S3; S2 was only opened");
  assert.equal(day["biz.orders"], 3, "B2, C3 as before, plus the paid card S4");

  const snapshot = botSnapshot({ orders: [...orders, ...cards] });
  assert.equal(snapshot.orders_by_status["robokassa:superseded"], undefined);
  assert.equal(snapshot.orders_by_status["robokassa:card_opened"], 2);
  assert.equal(snapshot.orders_by_status["robokassa:pending"], 1, "old orders keep their status");
  assert.deepEqual(snapshot.card_funnel, { opened: 3, paid: 1, opened_users: 3, paid_users: 1 });
});

test("stars abandoned, currency guard, MRR/active subs and async job logs", async () => {
  const mixedOrders = [
    // Abandoned Stars invoice (>1h old)
    { id: "ST1", user_id: 10, method: "stars", status: "pending", plan_id: "start", currency: "rub", amount: 200, stars: 125, created_at: "2026-11-09T08:00:00Z" },
    // Paid Stars order
    { id: "ST2", user_id: 11, method: "stars", status: "paid", plan_id: "streamer", currency: "rub", amount: 500, stars: 313, paid_total: 313, months: 1, created_at: "2026-11-08T10:00:00Z", paid_at: "2026-11-08T10:05:00Z" },
    // Paid site order (3 months -> MRR = 600 / 3 = 200)
    { id: "SI1", user_id: 12, method: "robokassa", source: "site", status: "paid", plan_id: "start", currency: "rub", amount: 600, paid_amount: 600, months: 3, created_at: "2026-11-05T10:00:00Z", paid_at: "2026-11-05T10:05:00Z" },
    // Legacy USD order must not be added directly into ruble revenue
    { id: "US1", user_id: 13, method: "crypto_manual", status: "paid", plan_id: "start", currency: "usd", amount: 10, months: 1, created_at: "2026-10-01T10:00:00Z", paid_at: "2026-10-01T10:05:00Z" },
  ];
  const days = botDays({ orders: mixedOrders, now: NOW });
  assert.equal(days["2026-11-09"]["biz.abandoned"], 1, "unpaid Stars order counts as abandoned");
  assert.equal(days["2026-11-08"]["biz.paid.stars"], 1);
  assert.equal(days["2026-11-08"]["biz.stars"], 313);
  assert.equal(days["2026-11-08"]["biz.revenue.stars"], 500);
  assert.equal(days["2026-11-05"]["biz.paid.site"], 1);
  assert.equal(days["2026-11-05"]["biz.revenue.site"], 600);
  assert.equal(days["2026-10-01"]["biz.revenue"], undefined, "USD order not counted as RUB");

  const snap = botSnapshot({ orders: mixedOrders, now: NOW });
  assert.equal(snap.active_paid_subs, 2);
  assert.equal(snap.mrr_rub, 700, "500/1 + 600/3");
  assert.equal(snap.stars_total, 313);
  assert.equal(snap.site_paid_count, 1);
  assert.equal(snap.stars_paid_count, 1);
  assert.equal(snap.average_check, 550, "(500 + 600) / 2, excluding USD");

  const root = mkdtempSync(join(tmpdir(), "fetchr-jobs-async-"));
  mkdirSync(join(root, "2026-11-09"));
  writeFileSync(join(root, "2026-11-09", "101010_AAAAAAAA_done_video_11111111.log.gz"), "");
  const asyncStats = await jobLogStatsAsync(root);
  assert.equal(asyncStats.days["2026-11-09"]["job.done"], 1);
  assert.equal(asyncStats.snapshot.devices, 1);
});
