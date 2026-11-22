/** Regressions for failure paths: lost notices, stray payments, floods,
 *  torn files, and errors that must not leak to users. */

import assert from "node:assert/strict";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";

import { createOrderStore, readJsonLines } from "./store.mjs";
import { createSiteCheckout } from "../site-checkout.mjs";
import { ADMIN_ID, MACHINE_ID, USER, callbackUpdate, fakeApi, fakeRobokassa, makeBot, textUpdate } from "./test-harness.mjs";

const ADMIN = { id: ADMIN_ID, first_name: "Admin" };

async function setupBot(options = {}) {
  const telegram = fakeApi(options);
  const harness = makeBot({ api: telegram.api, ...options });
  await harness.bot.setup();
  telegram.reset();
  return { telegram, ...harness };
}

/** A Robokassa order placed on the site, then paid. */
async function payRobokassa(bot, dir, robokassa) {
  const created = await createSiteCheckout({
    robokassa: robokassa.kassa,
    readOrders: async () => readJsonLines(join(dir, "orders.jsonl")),
    readSiteOrders: async () => readJsonLines(join(dir, "site-orders.jsonl")),
    sitePath: join(dir, "site-orders.jsonl"),
  }).create(USER.id, { plan: "mini", months: 1 });
  const link = new URL(created.pay_url);
  robokassa.payments.push({ inv_id: Number(link.searchParams.get("InvId")), order_id: created.order_id, out_sum: created.amount });
  await bot.pollPayments();
}

const adminNotices = (telegram) => telegram.of("sendMessage").filter((call) => call.body.chat_id === ADMIN_ID);

describe("payments", () => {
  test("admins hear about a payment even when the buyer blocked the bot", async () => {
    const robokassa = fakeRobokassa();
    const { telegram, bot, dir } = await setupBot({ failChats: [USER.id], robokassa });
    await payRobokassa(bot, dir, robokassa);
    assert.equal(adminNotices(telegram).length, 1);
    assert.match(adminNotices(telegram)[0].body.text, /Оплачен заказ/);
    const snapshots = readFileSync(join(dir, "orders.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.ok(snapshots.at(-1).announced_at);
  });

  test("an order admins never saw is announced after a restart", async () => {
    const robokassa = fakeRobokassa();
    const first = fakeApi({ failChats: [ADMIN_ID] });
    const { bot, dir } = makeBot({ api: first.api, robokassa });
    await bot.setup();
    await payRobokassa(bot, dir, robokassa);
    assert.match(first.last("sendMessage").text, /Оплачено\./);

    const second = fakeApi();
    const restarted = makeBot({ api: second.api, dir, robokassa });
    await restarted.bot.setup();
    assert.equal(adminNotices(second).length, 1);
    assert.ok(restarted.logs.includes("Re-announced 1 order(s) admins had not seen"));

    const third = fakeApi();
    await makeBot({ api: third.api, dir, robokassa }).bot.setup();
    assert.equal(adminNotices(third).length, 0);
  });

  test("a Stars payment from before the switch is flagged for refund", async () => {
    const { telegram, bot } = await setupBot();
    const update = textUpdate("");
    update.message.successful_payment = {
      currency: "XTR",
      total_amount: 70,
      invoice_payload: "ord:ABCDEF",
      telegram_payment_charge_id: "stxOLD",
    };
    await bot.handleUpdate(update);
    const flagged = adminNotices(telegram).at(-1).body.text;
    assert.match(flagged, /Оплата без заказа/);
    assert.match(flagged, /<code>\/refund 42 stxOLD<\/code>/);
  });

  test("admins refund with /refund, others cannot", async () => {
    const { telegram, bot } = await setupBot();
    await bot.handleUpdate(textUpdate("/refund 42 stxONE"));
    assert.equal(telegram.of("refundStarPayment").length, 0);

    await bot.handleUpdate(textUpdate("/refund 42 stxONE", { from: ADMIN }));
    assert.deepEqual(telegram.last("refundStarPayment"), { user_id: 42, telegram_payment_charge_id: "stxONE" });
    assert.match(telegram.last("sendMessage").text, /Оплата возвращена/);

    await bot.handleUpdate(textUpdate("/refund oops", { from: ADMIN }));
    assert.match(telegram.last("sendMessage").text, /Формат/);
  });
});

describe("abuse and leaks", () => {
  test("Stars invoices share the flood limit", async () => {
    const { telegram, bot } = await setupBot({ limit: 2 });
    for (const packs of [0, 1, 2, 3]) await bot.handleUpdate(callbackUpdate(`pay:mini:rub:${packs}`));
    assert.equal(telegram.of("sendInvoice").length, 2);
    assert.equal(telegram.last("answerCallbackQuery").text, "Слишком много заявок подряд — подождите пару минут");
  });

  test("a follow-up containing a hex hash goes to support, not registration", async () => {
    const { telegram, bot, licensesPath } = await setupBot();
    await bot.handleUpdate(callbackUpdate("sup:write"));
    await bot.handleUpdate(textUpdate("не качает"));
    await bot.handleUpdate(textUpdate(`md5 файла ${"a".repeat(32)}`));
    assert.match(adminNotices(telegram).at(-1).body.text, /дополнение/);
    assert.throws(() => readFileSync(licensesPath, "utf8"), /ENOENT/);
  });

  test("a signing failure shows the generic error, never its details", async () => {
    const telegram = fakeApi();
    const { bot, logs } = makeBot({
      api: telegram.api,
      createLicenseKey: () => {
        throw new Error("FETCHR_LICENSE_PRIVATE_KEY is required");
      },
    });
    await bot.handleUpdate(textUpdate(MACHINE_ID));
    const reply = telegram.last("sendMessage").text;
    assert.match(reply, /Что-то пошло не так/);
    assert.doesNotMatch(reply, /FETCHR_LICENSE_PRIVATE_KEY/);
    assert.ok(logs.some((line) => line.includes("FETCHR_LICENSE_PRIVATE_KEY")));
  });

  test("a torn last line does not swallow the next record", async () => {
    const { dir } = makeBot({ api: fakeApi().api });
    const path = join(dir, "torn.jsonl");
    writeFileSync(path, `${JSON.stringify({ id: "AAAAAA", status: "paid" })}\n{"id":"BBBB`);
    const store = createOrderStore(path);
    const order = store.create({ user_id: 1 });
    const replayed = createOrderStore(path);
    assert.equal(replayed.get("AAAAAA").status, "paid");
    assert.equal(replayed.get(order.id).user_id, 1);
    appendFileSync(path, "");
  });
});
