import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

import { statsText } from "./bot.mjs";
import { createActivityLog } from "./store.mjs";
import { ADMIN_ID, USER, callbackUpdate, fakeApi, makeBot, textUpdate } from "./test-harness.mjs";

const tempLog = () => join(mkdtempSync(join(tmpdir(), "fetchr-activity-")), "activity.jsonl");

describe("activity log", () => {
  test("counts each user once per calendar month and survives a restart", () => {
    const path = tempLog();
    let clock = Date.parse("2026-08-20T10:00:00Z");
    const now = () => clock;
    const log = createActivityLog(path, { now });
    log.touch(1);
    log.touch(1);
    log.touch(2);
    clock = Date.parse("2026-09-02T10:00:00Z");
    log.touch(1);

    const reopened = createActivityLog(path, { now });
    assert.deepEqual(reopened.monthly(3), [
      { month: "2026-09", users: 1 },
      { month: "2026-08", users: 2 },
      { month: "2026-07", users: 0 },
    ]);
    assert.equal(reopened.total(), 2);
  });

  test("seeds older history without writing it", () => {
    const path = tempLog();
    const now = () => Date.parse("2026-09-10T00:00:00Z");
    const log = createActivityLog(path, {
      now,
      seed: [
        { user_id: 5, at: "2026-06-01T00:00:00Z" },
        { user_id: null, at: "2026-06-01T00:00:00Z" },
        { user_id: 6, at: "garbage" },
      ],
    });
    assert.equal(log.monthly(4)[3].users, 1);
    assert.equal(createActivityLog(path, { now }).total(), 0);
  });
});

describe("/stats", () => {
  async function setup() {
    const telegram = fakeApi();
    const harness = makeBot({ api: telegram.api });
    await harness.bot.setup();
    telegram.reset();
    return { telegram, ...harness };
  }

  test("monthly users, visitors are counted from messages and buttons", async () => {
    const { telegram, bot } = await setup();
    await bot.handleUpdate(textUpdate("/start"));
    await bot.handleUpdate(callbackUpdate("shop", { from: { id: 77, first_name: "Олег" } }));
    await bot.handleUpdate(textUpdate("/stats", { from: { id: ADMIN_ID, first_name: "Админ" } }));
    const text = telegram.last("sendMessage").text;
    assert.match(text, /Пользователи по месяцам/);
    assert.match(text, /— <b>3<\/b> <i>\(текущий\)/);
    assert.match(text, /Всего уникальных: <b>3<\/b>/);
  });

  test("everyone can see the numbers, and the menu shows this month", async () => {
    const { telegram, bot } = await setup();
    await bot.handleUpdate(textUpdate("/stats", { from: USER }));
    assert.match(telegram.last("sendMessage").text, /Пользователи по месяцам/);
    await bot.handleUpdate(callbackUpdate("home", { from: { id: 78, first_name: "Ира" } }));
    await bot.handleUpdate(textUpdate("/stats", { from: USER }));
    assert.match(telegram.last("sendMessage").text, /Всего уникальных: <b>2<\/b>/);
    assert.match(telegram.last("editMessageText").text, /👥 <i>2 пользователя за месяц<\/i>/);
  });

  test("month names are Russian", () => {
    const text = statsText({ monthly: () => [{ month: "2026-09", users: 4 }], total: () => 9 });
    assert.match(text, /сентябрь 2026 — <b>4<\/b>/);
  });
});
