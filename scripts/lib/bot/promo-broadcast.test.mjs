import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

import { createPromoBroadcast, promoScreen } from "./promo-broadcast.mjs";
import { ADMIN_ID, buttons, callbackUpdate, fakeApi, makeBot, textUpdate } from "./test-harness.mjs";

const SALE_DAY = Date.parse("2026-11-11T12:00:00+03:00");
const AFTER_SALE = Date.parse("2026-11-16T00:00:00+03:00");

function setup({ audience = [1, 2, 3], now = SALE_DAY, failFor = {} } = {}) {
  const path = join(mkdtempSync(join(tmpdir(), "fetchr-promo-")), "promo.jsonl");
  const sent = [];
  const send = async (chatId, screen) => {
    if (failFor[chatId]) throw failFor[chatId];
    sent.push({ chatId, screen });
  };
  const logs = [];
  const broadcast = createPromoBroadcast({
    path,
    audience: () => audience,
    send,
    sleep: async () => {},
    now: () => now,
    log: { error: (line) => logs.push(line) },
  });
  return { broadcast, sent, path, logs };
}

describe("sale broadcast", () => {
  test("sends once to everyone, deduplicated, never twice", async () => {
    const { broadcast, sent } = setup({ audience: [1, 2, 2, 3] });
    const tally = await broadcast.sendAll(ADMIN_ID);
    assert.deepEqual(tally, { delivered: 3, blocked: 0, failed: 0 });
    await broadcast.sendAll(ADMIN_ID);
    const toUsers = sent.filter((item) => item.chatId !== ADMIN_ID);
    assert.deepEqual(toUsers.map((item) => item.chatId), [1, 2, 3]);
    assert.match(toUsers[0].screen.text, /Распродажа 11\.11/);
    assert.match(sent.at(-1).screen.text, /дошло 0/);
  });

  test("an opt-out is respected and ids never reach the log", async () => {
    const { broadcast, sent, path } = setup({ audience: [111111111, 222222222] });
    broadcast.optOut(222222222);
    await broadcast.sendAll(ADMIN_ID);
    assert.deepEqual(sent.filter((item) => item.chatId !== ADMIN_ID).map((item) => item.chatId), [111111111]);
    const log = readFileSync(path, "utf8");
    assert.ok(!log.includes("111111111") && !log.includes("222222222"));
  });

  test("blocked users are counted, failed ones are retried on the next run", async () => {
    const blocked = Object.assign(new Error("blocked"), { code: 403 });
    const broken = Object.assign(new Error("boom"), { code: 500 });
    const { broadcast } = setup({ audience: [1, 2, 3], failFor: { 2: blocked, 3: broken } });
    assert.deepEqual(await broadcast.sendAll(ADMIN_ID), { delivered: 1, blocked: 1, failed: 1 });
    assert.deepEqual(broadcast.pending(), [3]);
  });

  test("nothing goes out once the sale is over", async () => {
    const { broadcast, sent } = setup({ now: AFTER_SALE });
    assert.deepEqual(await broadcast.sendAll(ADMIN_ID), { delivered: 0, blocked: 0, failed: 0 });
    assert.equal(await broadcast.preview(ADMIN_ID), 0);
    assert.equal(sent.filter((item) => item.chatId !== ADMIN_ID).length, 0);
  });

  test("the message leads to the shop and offers an opt-out", () => {
    const data = buttons(promoScreen().markup).map((button) => button.callback_data);
    assert.deepEqual(data, ["shop", "promo:off"]);
  });

  test("the bot keeps /promo to admins and records the opt-out button", async () => {
    const telegram = fakeApi();
    const { bot, dir } = makeBot({ api: telegram.api });
    await bot.setup();
    telegram.reset();
    await bot.handleUpdate(textUpdate("/promo", { from: { id: 60, first_name: "Не админ" } }));
    assert.ok(!telegram.of("sendMessage").some((call) => /Рассылка акции|Акция не идёт/.test(call.body.text)));
    await bot.handleUpdate(textUpdate("/promo", { from: { id: ADMIN_ID, first_name: "Админ" } }));
    assert.ok(telegram.of("sendMessage").some((call) => call.body.chat_id === ADMIN_ID && /Рассылка акции|Акция не идёт/.test(call.body.text)));
    await bot.handleUpdate(callbackUpdate("promo:off", { from: { id: 61, first_name: "Без акций" } }));
    assert.match(readFileSync(join(dir, "promo.jsonl"), "utf8"), /optout/);
  });
});
