import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createEmojiDecorator, loadEmojiIds } from "./premium-emoji.mjs";

const ids = { "🔑": "5368324170671202286", "⚠": "5447644880824181073" };
const screen = {
  text: "🔑 <b>Ключ</b>\n⚠️ Внимание\n<pre>🔑 raw</pre> <code>⚠️</code>",
  markup: {
    inline_keyboard: [
      [{ text: "🔑 Регистрация", callback_data: "reg", style: "primary" }],
      [{ text: "⚠️ Ошибка", callback_data: "x" }, { text: "‹ Назад", callback_data: "home" }],
    ],
  },
};

test("without ids the screen is returned unchanged", () => {
  assert.equal(createEmojiDecorator({})(screen), screen);
});

test("text emoji become tg-emoji, code and pre stay plain", () => {
  const out = createEmojiDecorator(ids)(screen);
  assert.equal(
    out.text,
    '<tg-emoji emoji-id="5368324170671202286">🔑</tg-emoji> <b>Ключ</b>\n' +
      '<tg-emoji emoji-id="5447644880824181073">⚠️</tg-emoji> Внимание\n<pre>🔑 raw</pre> <code>⚠️</code>',
  );
});

test("a button's leading emoji moves into icon_custom_emoji_id", () => {
  const [[reg], [warn, back]] = createEmojiDecorator(ids)(screen).markup.inline_keyboard;
  assert.deepEqual(reg, { text: "Регистрация", callback_data: "reg", style: "primary", icon_custom_emoji_id: "5368324170671202286" });
  assert.equal(warn.text, "Ошибка");
  assert.equal(warn.icon_custom_emoji_id, "5447644880824181073");
  assert.deepEqual(back, { text: "‹ Назад", callback_data: "home" });
});

test("the source screen is not mutated", () => {
  const before = JSON.stringify(screen);
  createEmojiDecorator(ids)(screen);
  assert.equal(JSON.stringify(screen), before);
});

test("loadEmojiIds drops bad ids and tolerates a missing file", () => {
  const dir = mkdtempSync(join(tmpdir(), "emoji-"));
  const path = join(dir, "ids.json");
  writeFileSync(path, JSON.stringify({ "⚠️": "5447644880824181073", "🔑": "nope" }));
  assert.deepEqual(loadEmojiIds(path), { "⚠": "5447644880824181073" });
  assert.deepEqual(loadEmojiIds(join(dir, "missing.json")), {});
});

test("delivery falls back to plain screens when Telegram refuses custom emoji", async () => {
  const { createDelivery } = await import("./delivery.mjs");
  const { TelegramError } = await import("./telegram-api.mjs");
  const calls = [];
  const api = async (method, body) => {
    calls.push(body.text);
    if (body.text.includes("tg-emoji")) throw new TelegramError(method, { error_code: 400, description: "Bad Request: DOCUMENT_INVALID" });
    return { message_id: 1 };
  };
  const errors = [];
  const delivery = createDelivery({ api, decorate: createEmojiDecorator(ids), log: { error: (m) => errors.push(m) } });
  await delivery.send(1, { text: "🔑 a" });
  await delivery.send(1, { text: "🔑 b" });
  assert.deepEqual(calls, ['<tg-emoji emoji-id="5368324170671202286">🔑</tg-emoji> a', "🔑 a", "🔑 b"]);
  assert.equal(errors.length, 1);
});

test("screens use emoji the premium pack animates", async () => {
  const { readFileSync } = await import("node:fs");
  const ids = JSON.parse(readFileSync(new URL("../../assets/bot-emoji/ids.json", import.meta.url), "utf8"));
  const known = new Set(Object.keys(ids).map((char) => char.replace(/️/g, "")));
  const { PLANS } = await import("./catalog.mjs");
  const s = await import("./screens.mjs");
  const shop = await import("./shop-screens.mjs");
  const order = { id: "AAAAAA", amount: 500, months: 1, quota_gb: 150, method: "robokassa", pay_url: "https://auth.robokassa.ru/x" };
  const screens = [
    s.homeScreen({ user: { first_name: "А" }, shop: true, channelUrl: "https://t.me/x", monthlyUsers: 3 }),
    s.homeScreen({ user: { first_name: "А" }, shop: true, deviceCount: 1, machineId: "F".repeat(32), subscription: { active: true, plan: "Стример", days_left: 3, paid_until: "2026-12-01" } }),
    s.registrationScreen({ channel: "@x", channelUrl: "https://t.me/x", subscribed: false, consented: false }),
    s.registrationScreen({ channel: "@x", subscribed: true }),
    s.keyScreen({ machineId: "F".repeat(32), licenseKey: "k", channel: "@x", fresh: true, shop: true }),
    s.supportScreen({ shop: true }),
    s.termsScreen(),
    shop.shopScreen({ currency: "rub" }),
    shop.planScreen({ plan: PLANS[3], currency: "rub", packs: 0, months: 1, registered: true }),
    shop.paidScreen({ order, plan: PLANS[3] }),
    shop.freeRequestedScreen({ order: { ...order, quota_gb: 5 } }),
  ];
  const flat = new Set();
  for (const screen of screens) {
    for (const line of screen.text.split("\n").map((row) => row.replace(/<[^>]+>/g, "").trim()).filter(Boolean)) {
      const lead = /^(\p{Extended_Pictographic})/u.exec(line)?.[1];
      if (lead && !known.has(lead)) flat.add(lead);
    }
    for (const button of screen.markup.inline_keyboard.flat()) {
      const lead = /^(\p{Extended_Pictographic})/u.exec(button.text)?.[1];
      if (lead && !known.has(lead)) flat.add(lead);
    }
  }
  assert.deepEqual([...flat], [], `emoji without a premium id: ${[...flat].join(" ")}`);
});

test("Fetchr Line decorates by sign name; without its ids the plain emoji (or ids.json) stays", async () => {
  const { loadFetchrLine, named, plainScreen } = await import("./premium-emoji.mjs");
  const dir = mkdtempSync(join(tmpdir(), "line-"));
  const path = join(dir, "fetchr-line.json");
  writeFileSync(path, JSON.stringify({
    "plan-mini": { text: "70000000001", button: "80000000001" },
    archive: { text: "70000000002", button: "80000000002" },
    back: { text: "70000000003", button: "80000000003" },
    nope: { text: "70000000009", button: "80000000009" },
    copy: { text: "bad", button: "80000000004" },
  }));
  const line = loadFetchrLine(path);
  assert.deepEqual(line.text, { "plan-mini": "70000000001", archive: "70000000002", back: "70000000003" });
  assert.equal(line.button.copy, "80000000004");
  assert.deepEqual(loadFetchrLine(join(dir, "missing.json")), { text: {}, button: {} });

  const screen = {
    text: `${named("plan-mini", "💾")} Мини\n💾 Архив VPS\n🔑 ключ`,
    markup: { inline_keyboard: [[
      { text: "💾 Мини · 100 ₽", callback_data: "plan:mini", icon: "plan-mini" },
      { text: "💾 Архив VPS", callback_data: "shop" },
      { text: "← Назад", callback_data: "home", icon: "back" },
    ]] },
  };
  const ids = { "🔑": "60000000001", "💾": "60000000002" };
  const out = createEmojiDecorator(ids, ids, line)(screen);
  // The Мини cell and the archive share 💾 but get their own signs.
  assert.equal(out.text, '<tg-emoji emoji-id="70000000001">💾</tg-emoji> Мини\n<tg-emoji emoji-id="70000000002">💾</tg-emoji> Архив VPS\n<tg-emoji emoji-id="60000000001">🔑</tg-emoji> ключ');
  const [mini, archive, back] = out.markup.inline_keyboard[0];
  assert.deepEqual(mini, { text: "Мини · 100 ₽", callback_data: "plan:mini", icon_custom_emoji_id: "80000000001" });
  assert.equal(archive.icon_custom_emoji_id, "80000000002");
  assert.deepEqual(back, { text: "Назад", callback_data: "home", icon_custom_emoji_id: "80000000003" });

  // Without the pack: ids.json by character, markers and icon fields gone.
  const plain = createEmojiDecorator(ids, ids)(screen);
  assert.equal(plain.text, '<tg-emoji emoji-id="60000000002">💾</tg-emoji> Мини\n<tg-emoji emoji-id="60000000002">💾</tg-emoji> Архив VPS\n<tg-emoji emoji-id="60000000001">🔑</tg-emoji> ключ');
  assert.ok(plain.markup.inline_keyboard.flat().every((button) => !("icon" in button)));
  assert.equal(plainScreen(screen).text, "💾 Мини\n💾 Архив VPS\n🔑 ключ");
  assert.equal(createEmojiDecorator({}, {})(screen).text, "💾 Мини\n💾 Архив VPS\n🔑 ключ");
});
