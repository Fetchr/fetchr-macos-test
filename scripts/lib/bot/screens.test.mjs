import assert from "node:assert/strict";
import { test } from "node:test";

import { CURRENCIES, MAX_PACKS, PLANS } from "./catalog.mjs";
import {
  homeScreen,
  invalidMachineIdScreen,
  keyScreen,
  registrationScreen,
  supportPromptScreen,
  supportScreen,
  supportSentScreen,
  termsScreen,
} from "./screens.mjs";
import {
  freeRequestedScreen,
  paidCardScreen,
  paidScreen,
  planScreen,
  shopScreen,
} from "./shop-screens.mjs";

const LONGEST_ID = "F".repeat(32);
const user = { id: 1, first_name: "Анна" };
const order = {
  id: "ABCDEF",
  quota_gb: 1200,
  amount: 2190,
  currency: "rub",
  pay_url: "https://auth.robokassa.ru/Merchant/Index.aspx?InvId=1001",
};

function allScreens() {
  const planCards = PLANS.flatMap((plan) =>
    CURRENCIES.flatMap((currency) =>
      [0, MAX_PACKS].map((packs) => planScreen({ plan, currency: currency.id, packs, registered: packs > 0 })),
    ),
  );
  return [
    homeScreen({ user, deviceCount: 3, channelUrl: "https://t.me/streamcutter", notice: "<i>n</i>" }),
    registrationScreen({
      channel: "@streamcutter",
      channelUrl: "https://t.me/streamcutter",
      subscribed: false,
      devices: Array.from({ length: 7 }, (_, index) => ({ machineId: LONGEST_ID, issuedAt: `2026-09-0${index + 1}` })),
      pendingMachineId: LONGEST_ID,
    }),
    registrationScreen({ channel: "@streamcutter", subscribed: null }),
    keyScreen({ machineId: LONGEST_ID, licenseKey: "FTR1.".padEnd(330, "x"), channel: "@streamcutter", fresh: true }),
    invalidMachineIdScreen({ reason: "machine_id must be 32 hex characters <x>" }),
    supportScreen(),
    supportScreen({ payment: true }),
    supportPromptScreen(),
    supportSentScreen({ ticketId: 123456 }),
    termsScreen({ backTo: `plan:streamer:rub:${MAX_PACKS}` }),
    ...CURRENCIES.map((currency) => shopScreen({ currency: currency.id })),
    ...planCards,
    planScreen({ plan: PLANS[3], currency: "rub", packs: 2, months: 12, registered: true, stars: 2000 }),
    paidScreen({ order: { ...order, method: "robokassa", months: 12, restream_streamers: 1 }, plan: PLANS[3] }),
    paidScreen({ order: { ...order, kind: "addon", packs: 2 }, plan: null }),
    paidScreen({ order, plan: PLANS[5] }),
    freeRequestedScreen({ order: { ...order, quota_gb: 5 } }),
  ];
}

function tagsBalance(html) {
  const stack = [];
  for (const [, closing, name] of html.matchAll(/<(\/?)([a-z]+)[^>]*>/g)) {
    if (!closing) stack.push(name);
    else if (stack.pop() !== name) return false;
  }
  return stack.length === 0;
}

test("every screen fits Telegram's limits", () => {
  for (const screen of allScreens()) {
    assert.ok(screen.text.length <= 4096, screen.text.slice(0, 40));
    assert.ok(tagsBalance(screen.text), `unbalanced tags in: ${screen.text.slice(0, 60)}`);
    const rows = screen.markup.inline_keyboard;
    assert.ok(rows.length > 0 && rows.length <= 100);
    for (const button of rows.flat()) {
      assert.ok(button.text.length > 0);
      assert.ok(button.callback_data || button.url || button.copy_text, JSON.stringify(button));
      if (button.copy_text) assert.ok(button.copy_text.text.length >= 1 && button.copy_text.text.length <= 256);
      if (button.callback_data) {
        assert.ok(Buffer.byteLength(button.callback_data) <= 64, button.callback_data);
      }
      if (button.style) assert.ok(["primary", "success", "danger"].includes(button.style));
    }
  }
});

/** What Telegram counts against a caption: text after entity parsing. */
function visibleLength(html) {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;|&gt;|&amp;|&quot;/g, "_").length;
}

test("screens under a banner fit the 1024-character caption", () => {
  const withBanner = allScreens().filter((screen) => screen.media);
  assert.ok(withBanner.length > 10);
  for (const screen of withBanner) {
    assert.ok(visibleLength(screen.text) <= 1024, `${visibleLength(screen.text)}: ${screen.text.slice(0, 60)}`);
  }
  const crowded = registrationScreen({
    channel: "@streamcutter",
    subscribed: true,
    devices: Array.from({ length: 40 }, () => ({ machineId: LONGEST_ID, issuedAt: "2026-09-01" })),
    notice: "📢 <b>Почти готово</b> — подпишитесь на канал, и ключ придёт сразу.",
  });
  assert.ok(visibleLength(crowded.text) <= 1024);
  assert.match(crowded.text, /и ещё 35/);
});

test("device buttons are capped so the keyboard stays short", () => {
  const screen = allScreens()[1];
  const keyButtons = screen.markup.inline_keyboard.flat().filter((button) => button.callback_data?.startsWith("reg:key:"));
  assert.equal(keyButtons.length, 5);
});

test("paid plans show the pack stepper, free shows registration", () => {
  const free = planScreen({ plan: PLANS[0], currency: "rub", packs: 0, registered: false });
  assert.ok(!free.markup.inline_keyboard.flat().some((button) => button.text.includes("ГБ") && button.text.startsWith("➕")));
  assert.equal(free.markup.inline_keyboard.flat().find((button) => button.callback_data === "reg").style, "primary");

  const top = planScreen({ plan: PLANS[5], currency: "rub", packs: MAX_PACKS, registered: true });
  assert.ok(top.markup.inline_keyboard.flat().some((button) => button.callback_data === "noop:max"));
});

test("the key screen copies a short key with a button and keeps <pre> for a long one", () => {
  const short = keyScreen({ machineId: LONGEST_ID, licenseKey: "FTR1.short", fresh: true });
  assert.deepEqual(short.markup.inline_keyboard[0][0].copy_text, { text: "FTR1.short" });
  const long = keyScreen({ machineId: LONGEST_ID, licenseKey: "FTR1.".padEnd(330, "x"), fresh: true });
  assert.ok(!long.markup.inline_keyboard.flat().some((button) => button.copy_text));
  assert.match(long.text, /<pre>FTR1./);
});

test("step 1 joins the channel and the consent, word for word; step 2 asks for the Machine ID", async () => {
  const { CONSENT_TEXT } = await import("./screens.mjs");
  const step1 = registrationScreen({ channel: "@streamcutter", channelUrl: "https://t.me/streamcutter", subscribed: false, consented: false });
  assert.equal(step1.media, "register-1");
  for (const line of CONSENT_TEXT.filter(Boolean)) assert.ok(step1.text.includes(line), line);
  const buttons = step1.markup.inline_keyboard.flat();
  assert.equal(buttons[0].url, "https://t.me/streamcutter");
  assert.equal(buttons.find((button) => button.style === "primary").callback_data, "cons:ok");
  const step2 = registrationScreen({ channel: "@streamcutter", subscribed: true, consented: true });
  assert.equal(step2.media, "register-2");
  assert.match(step2.text, /Шаг 2 из 2/);
});

test("the shop is a 2×2 grid that opens plan cards; the card switches the term in place", () => {
  const shop = shopScreen({ currency: "rub" });
  const rows = shop.markup.inline_keyboard;
  assert.deepEqual(rows.slice(0, 2).map((row) => row.length), [2, 2]);
  assert.ok(rows.slice(0, 2).flat().every((button) => /^plan:[a-z]+:rub:0:1$/.test(button.callback_data)));
  assert.doesNotMatch(JSON.stringify(shop), /⭐|Звёзд/);
  const card = planScreen({ plan: PLANS[3], currency: "rub", packs: 0, months: 3, registered: true, stars: 900 });
  const terms = card.markup.inline_keyboard[0].map((button) => button.text);
  assert.deepEqual(terms, ["🗓 1 мес", "✅ 3 мес", "🗓 6 мес", "🗓 12 мес"]);
  const pay = card.markup.inline_keyboard.flat().find((button) => button.text.startsWith("⭐"));
  assert.equal(pay.text, "⭐ Оплатить 900 Stars");
  assert.equal(pay.callback_data, "star:streamer:rub:0:3");
  assert.ok(!card.markup.inline_keyboard.flat().some((button) => button.url?.includes("robokassa")));
  assert.match(card.text, /рублями.*fetchr\.fun/i);
});

test("a paid card loses its buttons", () => {
  const screen = paidCardScreen({ order: { ...order, months: 1, packs: 0 }, plan: PLANS[3] });
  assert.deepEqual(screen.markup.inline_keyboard, []);
  assert.match(screen.text, /оплачен/);
});
