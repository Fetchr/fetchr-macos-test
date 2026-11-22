import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";

import { join } from "node:path";

import { createWebLoginBox } from "../web-login.mjs";
import { extractMachineId } from "./registration.mjs";

// These tests pin list prices; the sale has its own test in catalog.test.mjs.
process.env.FETCHR_BOT_PROMO = "off";
import {
  ADMIN_ID,
  MACHINE_ID,
  USER,
  buttons,
  callbackUpdate,
  fakeApi,
  fakeRobokassa,
  makeBot,
  textUpdate,
} from "./test-harness.mjs";
import { starsFor } from "./catalog.mjs";
import { SITE_FIRST_INV_ID, createSiteCheckout } from "../site-checkout.mjs";
import { readJsonLines } from "./store.mjs";

/** The site's checkout against the bot's order file, as the API server runs it. */
function siteCheckoutFor(robokassa, dir) {
  return createSiteCheckout({
    robokassa: robokassa.kassa,
    readOrders: async () => readJsonLines(join(dir, "orders.jsonl")),
    readSiteOrders: async () => readJsonLines(join(dir, "site-orders.jsonl")),
    sitePath: join(dir, "site-orders.jsonl"),
  });
}

const NBSP = "\u00a0";

async function setupBot(options = {}) {
  const telegram = fakeApi(options);
  const harness = makeBot({ api: telegram.api, ...options });
  await harness.bot.setup();
  telegram.reset();
  return { telegram, ...harness };
}

describe("menu", () => {
  test("/start draws the dashboard and offers the next step", async () => {
    const { telegram, bot } = await setupBot();
    await bot.handleUpdate(textUpdate("/start"));
    const screen = telegram.last("sendMessage");
    assert.equal(screen.parse_mode, "HTML");
    assert.match(screen.text, /Ключ — <b>бесплатно<\/b>/);
    const rows = screen.reply_markup.inline_keyboard.map((row) => row.map((button) => button.text));
    assert.deepEqual(rows.slice(0, 3), [["🔑 Получить ключ"], ["💾 Архив VPS", "📡 Рестрим"], ["💬 Поддержка", "📢 Канал"]]);
    assert.equal(buttons(screen.reply_markup)[0].style, "primary");
  });

  test("buttons edit the menu in place and fall back to a new message", async () => {
    const { telegram, bot } = await setupBot({ failEdit: true });
    await bot.handleUpdate(callbackUpdate("shop"));
    assert.equal(telegram.of("editMessageText").length, 1);
    assert.match(telegram.last("sendMessage").text, /Архив VPS<\/b> — сервер пишет эфир/);
    assert.equal(telegram.of("answerCallbackQuery").length, 1);
  });

  test("setup registers commands, fills empty descriptions and finds the channel owner", async () => {
    const telegram = fakeApi();
    const { bot, logs } = makeBot({ api: telegram.api });
    await bot.setup();
    assert.ok(telegram.last("setMyCommands").commands.some((command) => command.command === "paysupport"));
    assert.ok(telegram.last("setMyDescription").description.includes("Fetchr"));
    assert.ok(telegram.last("setMyShortDescription").short_description.length <= 120);
    assert.deepEqual(await bot.adminChats(), [ADMIN_ID]);
    assert.ok(logs.includes(`Admin chats: ${ADMIN_ID}`));
  });

  test("unknown text gets the menu with a hint", async () => {
    const { telegram, bot } = await setupBot();
    await bot.handleUpdate(textUpdate("привет"));
    assert.match(telegram.last("sendMessage").text, /Не понял сообщение/);
  });

  test("closed beta turns away users outside the allow-list", async () => {
    const { telegram, bot } = await setupBot({ allowedUsers: [1] });
    await bot.handleUpdate(textUpdate("/start"));
    assert.match(telegram.last("sendMessage").text, /Доступ закрыт/);
  });
});

describe("registration", () => {
  test("reads Machine IDs from deep links and pasted text", () => {
    assert.equal(extractMachineId(`fetchr_${MACHINE_ID}`), MACHINE_ID);
    assert.equal(extractMachineId(`мой id ${MACHINE_ID.toLowerCase()}`), MACHINE_ID.toLowerCase());
    assert.equal(extractMachineId("123"), null);
  });

  test("a subscriber gets a key from the app's deep link", async () => {
    const { telegram, bot, licensesPath } = await setupBot();
    await bot.handleUpdate(textUpdate(`/start fetchr_${MACHINE_ID}`));
    const screen = telegram.last("sendMessage");
    assert.match(screen.text, /Устройство зарегистрировано/);
    assert.match(screen.text, new RegExp(`<pre>FTR1\\.test\\.${MACHINE_ID}</pre>`));
    const [record] = readFileSync(licensesPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(record.machine_id, MACHINE_ID);
    assert.equal(record.telegram_user_id, USER.id);
    for (const field of ["username", "first_name", "last_name"]) assert.equal(record[field], undefined, field);
  });

  test("sending the same Machine ID again returns the same key", async () => {
    const { bot, licensesPath } = await setupBot();
    await bot.handleUpdate(textUpdate(MACHINE_ID));
    await bot.handleUpdate(textUpdate(MACHINE_ID.toLowerCase()));
    assert.equal(readFileSync(licensesPath, "utf8").trim().split("\n").length, 1);
  });

  test("without a subscription the ID waits, then the key arrives on «Я подписался»", async () => {
    const { telegram, bot, licensesPath } = await setupBot({ member: "left" });
    await bot.handleUpdate(textUpdate(MACHINE_ID));
    const waiting = telegram.last("sendMessage");
    assert.match(waiting.text, /Почти готово/);
    assert.match(waiting.text, /Шаг 1 из 2/);
    assert.ok(buttons(waiting.reply_markup).some((button) => button.url === "https://t.me/streamcutter"));

    await bot.handleUpdate(callbackUpdate("reg:check"));
    assert.equal(telegram.last("answerCallbackQuery").text, "Подписка пока не найдена");

    telegram.state.member = "member";
    await bot.handleUpdate(callbackUpdate("reg:check"));
    assert.match(telegram.last("editMessageText").text, /Устройство зарегистрировано/);
    assert.equal(readFileSync(licensesPath, "utf8").trim().split("\n").length, 1);
  });

  test("registered devices are listed and their keys can be shown again", async () => {
    const { telegram, bot } = await setupBot();
    await bot.handleUpdate(textUpdate(MACHINE_ID));
    await bot.handleUpdate(callbackUpdate("reg"));
    const screen = telegram.last("editMessageText");
    assert.match(screen.text, /Ваши устройства/);
    const keyButton = buttons(screen.reply_markup).find((button) => button.callback_data === `reg:key:${MACHINE_ID}`);
    assert.ok(keyButton);
    await bot.handleUpdate(callbackUpdate(keyButton.callback_data));
    assert.match(telegram.last("editMessageText").text, /Ваш ключ/);

    await bot.handleUpdate(callbackUpdate(`reg:key:${"F".repeat(32)}`, { from: { id: 43, first_name: "B" } }));
    assert.equal(telegram.last("answerCallbackQuery").text, "Ключ не найден");
  });
});

describe("shop", () => {
  test("lists the plans on sale in rubles, no currency switch", async () => {
    const { telegram, bot } = await setupBot();
    await bot.handleUpdate(callbackUpdate("shop:rub"));
    const screen = telegram.last("editMessageText");
    const labels = buttons(screen.reply_markup).map((button) => button.text);
    assert.ok(labels.includes("👑 Стример · 500 ₽"));
    assert.ok(!labels.some((text) => /Макс|Архив ·|⭐/.test(text)));
    assert.ok(buttons(screen.reply_markup).some((button) => button.callback_data === "ad:rub"), "add-ons are their own product");
    assert.ok(!buttons(screen.reply_markup).some((button) => /^shop:/.test(button.callback_data || "")));
    assert.deepEqual(screen.reply_markup.inline_keyboard.slice(0, 2).map((row) => row.length), [2, 2]);
    for (const id of ["free", "mini", "start", "streamer"]) {
      assert.ok(buttons(screen.reply_markup).some((button) => button.callback_data === `plan:${id}:rub:0:1`), id);
    }
  });

  test("plan card totals packs and links the offer", async () => {
    const { telegram, bot } = await setupBot();
    await bot.handleUpdate(callbackUpdate("plan:streamer:rub:2"));
    const screen = telegram.last("editMessageText");
    assert.match(screen.text, /Срок: <b>1 месяц — 560 ₽<\/b>/);
    assert.ok(screen.text.includes("https://fetchr.fun/oferta/"));
    assert.ok(screen.text.includes(`170${NBSP}ГБ`));
    const pay = buttons(screen.reply_markup).find((button) => button.callback_data === "star:streamer:rub:2:1");
    assert.equal(pay.style, "success");
    assert.equal(pay.text, `⭐ Оплатить ${starsFor(560)} Stars`);
    assert.ok(buttons(screen.reply_markup).some((button) => button.callback_data === "plan:streamer:rub:3:1"));
    assert.ok(!buttons(screen.reply_markup).some((button) => button.url?.includes("robokassa")), "no ruble links in the bot");
    assert.match(screen.text, /рублями.*fetchr\.fun/i);
  });

  test("the card switches the term in place; old term links open the card", async () => {
    const { telegram, bot } = await setupBot();
    await bot.handleUpdate(callbackUpdate("per:streamer:rub:2"));
    const screen = telegram.last("editMessageText");
    assert.deepEqual(screen.reply_markup.inline_keyboard[0].map((button) => button.text), ["✅ 1 мес", "🗓 3 мес", "🗓 6 мес", "🗓 12 мес"]);
    const terms = buttons(screen.reply_markup).map((button) => button.callback_data);
    for (const months of [1, 3, 6, 12]) assert.ok(terms.includes(`plan:streamer:rub:2:${months}`));
    await bot.handleUpdate(callbackUpdate("plan:streamer:rub:2:3"));
    assert.match(telegram.last("editMessageText").text, /<b>3 месяца — <s>1 680 ₽<\/s> 1 596 ₽<\/b>/);
    assert.equal(telegram.of("sendMessage").length, 0, "the term is switched by editing the same message");
  });

  test("old stars and dollar links open the ruble price", async () => {
    const { telegram, bot } = await setupBot();
    await bot.handleUpdate(textUpdate("/start buy_streamer_p2_usd"));
    assert.match(telegram.last("sendMessage").text, /1 месяц — 560 ₽/);
    await bot.handleUpdate(callbackUpdate("plan:start:stars:0"));
    assert.match(telegram.last("editMessageText").text, /1 месяц — 200 ₽/);
  });

  test("stars and crypto are refused, a leftover Stars invoice is declined", async () => {
    const { telegram, bot } = await setupBot();
    await bot.handleUpdate(callbackUpdate("pay:streamer:stars:0"));
    assert.equal(telegram.last("answerCallbackQuery").text, "Тариф не найден");
    await bot.handleUpdate(callbackUpdate("pay:streamer:crypto:0"));
    assert.equal(telegram.last("answerCallbackQuery").text, "Тариф не найден");
    await bot.handleUpdate({
      update_id: 1,
      pre_checkout_query: { id: "pq", from: USER, currency: "XTR", total_amount: 350, invoice_payload: "ord:ABCDEF" },
    });
    assert.equal(telegram.last("answerPreCheckoutQuery").ok, false);
    assert.equal(telegram.of("sendInvoice").length, 0);
  });

  test("without Robokassa in the bot «Оплатить» is a Stars invoice, never a ruble request", async () => {
    const { telegram, bot } = await setupBot();
    await bot.handleUpdate(callbackUpdate("pay:mini:rub:1"));
    const invoice = telegram.last("sendInvoice");
    assert.equal(invoice.currency, "XTR");
    assert.equal(invoice.prices[0].amount, starsFor(130));
    assert.equal(telegram.of("sendMessage").filter((call) => call.body.chat_id === ADMIN_ID).length, 0);
  });

  test("site orders: imported, then confirmed once ResultURL arrives", async () => {
    const robokassa = fakeRobokassa();
    const { telegram, bot, dir } = await setupBot({ robokassa });
    const checkout = siteCheckoutFor(robokassa, dir);
    const quote = await checkout.quote(USER.id, { plan: "start", packs: 1, months: 1 });
    assert.equal(quote.amount, 230);
    const created = await checkout.create(USER.id, { plan: "start", packs: 1, months: 1 });
    const link = new URL(created.pay_url);
    assert.equal(link.hostname, "auth.robokassa.ru");
    assert.equal(link.searchParams.get("OutSum"), "230.00");
    assert.equal(Number(link.searchParams.get("InvId")), SITE_FIRST_INV_ID);
    assert.equal(link.searchParams.get("Shp_order"), created.order_id);
    assert.equal((await checkout.create(USER.id, { plan: "start", packs: 1, months: 1 })).order_id, created.order_id, "a second tap reuses the order");

    await bot.pollPayments();
    assert.equal(
      telegram.of("sendMessage").filter((call) => call.body.chat_id === ADMIN_ID && /Новый заказ с сайта/.test(call.body.text)).length,
      1,
    );
    await bot.pollPayments();
    assert.equal(
      telegram.of("sendMessage").filter((call) => call.body.chat_id === ADMIN_ID && /Новый заказ с сайта/.test(call.body.text)).length,
      1,
      "site checkout notice is sent only once",
    );
    await bot.handleUpdate(callbackUpdate(`chk:${created.order_id}`));
    assert.equal(telegram.last("answerCallbackQuery").text, "Оплата пока не поступила");

    robokassa.payments.push({ inv_id: SITE_FIRST_INV_ID, order_id: created.order_id, out_sum: 230 });
    await bot.pollPayments();
    await bot.pollPayments();
    assert.equal(telegram.of("sendMessage").filter((call) => /Оплачено\./.test(call.body.text)).length, 1);
    assert.ok(telegram.of("sendMessage").some((call) => call.body.chat_id === ADMIN_ID && /Оплачен заказ.*Сайт/.test(call.body.text)));
    await bot.handleUpdate(callbackUpdate(`chk:${created.order_id}`));
    assert.equal(telegram.last("answerCallbackQuery").text, "Оплата получена ✅");
    const stored = readFileSync(`${dir}/orders.jsonl`, "utf8");
    assert.ok(stored.includes('"paid_via":"robokassa"') && stored.includes('"source":"site"'));
    const next = await checkout.create(USER.id, { plan: "streamer", packs: 0, months: 12 });
    assert.equal(Number(new URL(next.pay_url).searchParams.get("InvId")), SITE_FIRST_INV_ID + 1);
  });

  test("site orders: a short or foreign payment does not open the plan", async () => {
    const robokassa = fakeRobokassa();
    const { telegram, bot, dir } = await setupBot({ robokassa });
    const created = await siteCheckoutFor(robokassa, dir).create(USER.id, { plan: "mini", months: 1 });
    const paidCount = () => telegram.of("sendMessage").filter((call) => /Оплачено\./.test(call.body.text)).length;
    robokassa.payments.push({ inv_id: SITE_FIRST_INV_ID, order_id: "ZZZZZZ", out_sum: 100 });
    await bot.pollPayments();
    assert.equal(paidCount(), 0);
    robokassa.payments.splice(0, 1, { inv_id: SITE_FIRST_INV_ID, order_id: created.order_id, out_sum: 50 });
    await bot.pollPayments();
    assert.equal(paidCount(), 0);
    assert.ok(telegram.of("sendMessage").some((call) => call.body.chat_id === ADMIN_ID && /не полностью/.test(call.body.text)));
  });

  test("a site order never overwrites a bot order with the same id", async () => {
    const robokassa = fakeRobokassa();
    const { bot, dir, logs } = await setupBot({ robokassa });
    await bot.handleUpdate(callbackUpdate("star:mini:rub:0:1"));
    const own = readFileSync(`${dir}/orders.jsonl`, "utf8").trim().split("\n").map((line) => JSON.parse(line)).at(-1);
    robokassa.siteOrders.push({ id: own.id, user_id: 7, method: "robokassa", inv_id: SITE_FIRST_INV_ID, amount: 1, status: "pending", created_at: new Date().toISOString() });
    await bot.pollPayments();
    const latest = readFileSync(`${dir}/orders.jsonl`, "utf8").trim().split("\n").map((line) => JSON.parse(line)).filter((row) => row.id === own.id).at(-1);
    assert.equal(latest.user_id, USER.id);
    assert.ok(logs.some((line) => /clashes/.test(line)));
  });

  test("free plan needs registration, switches on at once and only once", async () => {
    const { telegram, bot, dir } = await setupBot();
    await bot.handleUpdate(callbackUpdate("free"));
    assert.equal(telegram.last("answerCallbackQuery").text, "Сначала пройдите регистрацию");
    await bot.handleUpdate(textUpdate(MACHINE_ID));
    await bot.handleUpdate(callbackUpdate("free"));
    await bot.handleUpdate(callbackUpdate("free"));
    assert.equal(telegram.last("answerCallbackQuery").text, "Free уже подключён");
    const notices = telegram.of("sendMessage").filter((call) => call.body.chat_id === ADMIN_ID);
    assert.equal(notices.length, 1);
    assert.match(notices[0].body.text, /Подключён Free/);
    assert.match(notices[0].body.text, /бессрочно/);
    const stored = JSON.parse(readFileSync(`${dir}/orders.jsonl`, "utf8").trim().split("\n").at(-1));
    assert.equal(stored.method, "free");
    assert.equal(stored.status, "paid");
    assert.ok(stored.paid_at);
  });

  test("tampered callbacks are clamped or refused", async () => {
    const { telegram, bot } = await setupBot();
    await bot.handleUpdate(callbackUpdate("plan:streamer:rub:999"));
    assert.ok(telegram.last("editMessageText").text.includes(`350${NBSP}ГБ`));
    await bot.handleUpdate(callbackUpdate("pay:free:rub:0"));
    assert.equal(telegram.last("answerCallbackQuery").text, "Тариф не найден");
    await bot.handleUpdate(callbackUpdate("pay:gold:rub:0"));
    assert.equal(telegram.last("answerCallbackQuery").text, "Тариф не найден");
  });
});

describe("consent", () => {
  test("the first key waits for consent, then arrives on «Даю согласие»", async () => {
    const { telegram, bot, licensesPath, dir } = await setupBot({ consentVersion: "v1" });
    await bot.handleUpdate(textUpdate(`/start fetchr_${MACHINE_ID}`));
    const ask = telegram.last("sendMessage");
    assert.match(ask.text, /Согласие на обработку данных/);
    assert.match(ask.text, /Шаг 1 из 2/);
    assert.match(ask.text, /Для выдачи ключа бот сохранит ваш Telegram ID и Machine ID компьютера/);
    assert.match(ask.text, /href="https:\/\/fetchr\.fun\/soglasie\/"/);
    assert.ok(buttons(ask.reply_markup).some((button) => button.callback_data === "cons:ok" && button.style === "primary"));
    assert.throws(() => readFileSync(licensesPath, "utf8"));

    await bot.handleUpdate(callbackUpdate("cons:ok"));
    assert.equal(telegram.last("answerCallbackQuery").text, "Согласие сохранено");
    assert.ok(readFileSync(licensesPath, "utf8").includes(MACHINE_ID));
    assert.match(readFileSync(`${dir}/consents.jsonl`, "utf8"), /"version":"v1"/);

    // Asked once: the next registration goes straight through.
    telegram.reset();
    await bot.handleUpdate(textUpdate(MACHINE_ID));
    assert.ok(!/Согласие/.test(telegram.last("sendMessage").text));
  });
});

describe("support", () => {
  test("a ticket reaches the admin and the answer comes back", async () => {
    const { telegram, bot } = await setupBot();
    await bot.handleUpdate(callbackUpdate("sup:write"));
    assert.match(telegram.last("editMessageText").text, /Жду ваше сообщение/);
    await bot.handleUpdate(textUpdate("Не качается VOD <script>"));

    const header = telegram.of("sendMessage").find((call) => call.body.chat_id === ADMIN_ID);
    assert.match(header.body.text, /Обращение #1/);
    const copy = telegram.last("copyMessage");
    assert.equal(copy.chat_id, ADMIN_ID);
    assert.match(telegram.last("sendMessage").text, /Обращение #1 отправлено/);

    await bot.handleUpdate(
      textUpdate("Обновите Fetchr до 0.6.7 & перезапустите", {
        from: { id: ADMIN_ID, first_name: "Admin" },
        replyTo: header.result.message_id,
      }),
    );
    const answer = telegram.last("sendMessage");
    assert.equal(answer.chat_id, USER.id);
    assert.match(answer.text, /Поддержка Fetchr<\/b> · обращение #1/);
    assert.match(answer.text, /0\.6\.7 &amp; перезапустите/);
    assert.equal(telegram.last("setMessageReaction").reaction[0].emoji, "👌");

    await bot.handleUpdate(textUpdate("Спасибо, помогло"));
    assert.match(telegram.of("sendMessage").filter((call) => call.body.chat_id === ADMIN_ID).at(-1).body.text, /дополнение/);
  });

  test("payment questions are tagged for the admin", async () => {
    const { telegram, bot } = await setupBot();
    await bot.handleUpdate(textUpdate("/paysupport"));
    assert.match(telegram.last("sendMessage").text, /Вопрос по оплате/);
    await bot.handleUpdate(callbackUpdate("sup:write:pay"));
    await bot.handleUpdate(textUpdate("Списали дважды"));
    assert.ok(telegram.of("sendMessage").some((call) => call.body.chat_id === ADMIN_ID && /Оплата · обращение/.test(call.body.text)));
  });

  test("floods are cut off", async () => {
    const { telegram, bot } = await setupBot({ limit: 2 });
    for (let index = 0; index < 3; index += 1) {
      await bot.handleUpdate(callbackUpdate("sup:write"));
      await bot.handleUpdate(textUpdate(`msg ${index}`));
    }
    assert.match(telegram.last("sendMessage").text, /Слишком много сообщений/);
  });

  test("media answers are copied, and a blocked user is reported to the admin", async () => {
    const { telegram, bot } = await setupBot();
    await bot.handleUpdate(callbackUpdate("sup:write"));
    await bot.handleUpdate(textUpdate("вот лог"));
    const header = telegram.of("sendMessage").find((call) => call.body.chat_id === ADMIN_ID);

    const photo = textUpdate("", { from: { id: ADMIN_ID, first_name: "Admin" }, replyTo: header.result.message_id });
    delete photo.message.text;
    photo.message.photo = [{ file_id: "p" }];
    await bot.handleUpdate(photo);
    assert.equal(telegram.last("copyMessage").chat_id, USER.id);
    assert.equal(telegram.last("copyMessage").reply_markup.inline_keyboard[0][0].callback_data, "sup:reply:1");

    const blocked = fakeApi();
    const original = blocked.api;
    const harness = makeBot({
      api: async (method, body) => {
        if (method === "sendMessage" && body.chat_id === USER.id && /Поддержка Fetchr<\/b> ·/.test(body.text)) {
          const { TelegramError } = await import("./telegram-api.mjs");
          throw new TelegramError(method, { error_code: 403, description: "Forbidden: bot was blocked by the user" });
        }
        return original(method, body);
      },
    });
    await harness.bot.setup();
    await harness.bot.handleUpdate(callbackUpdate("sup:write"));
    await harness.bot.handleUpdate(textUpdate("помогите"));
    const adminHeader = blocked.of("sendMessage").find((call) => call.body.chat_id === ADMIN_ID);
    await harness.bot.handleUpdate(
      textUpdate("ответ", { from: { id: ADMIN_ID, first_name: "Admin" }, replyTo: adminHeader.result.message_id }),
    );
    assert.match(blocked.last("sendMessage").text, /заблокировал бота/);
  });

  test("a user can continue a ticket from the answer's button", async () => {
    const { telegram, bot } = await setupBot();
    await bot.handleUpdate(callbackUpdate("sup:write"));
    await bot.handleUpdate(textUpdate("первое"));
    await bot.handleUpdate(callbackUpdate("sup:reply:1"));
    assert.match(telegram.last("sendMessage").text, /Жду ваше сообщение/);
    await bot.handleUpdate(textUpdate("второе"));
    const headers = telegram.of("sendMessage").filter((call) => call.body.chat_id === ADMIN_ID);
    assert.equal(headers.length, 2);
    assert.match(headers[1].body.text, /Обращение #1<\/b> · дополнение/);

    await bot.handleUpdate(callbackUpdate("sup:reply:1", { from: { id: 77, first_name: "Чужой" } }));
    assert.equal(telegram.last("answerCallbackQuery").text, "Обращение не найдено");
  });

  test("cancel returns to the support screen", async () => {
    const { telegram, bot } = await setupBot();
    await bot.handleUpdate(callbackUpdate("sup:write"));
    await bot.handleUpdate(callbackUpdate("sup:cancel"));
    assert.match(telegram.last("editMessageText").text, /Опишите проблему/);
    await bot.handleUpdate(textUpdate("просто текст"));
    assert.match(telegram.last("sendMessage").text, /Не понял сообщение/);
  });
});

describe("device limit", () => {
  test("a second Machine ID is refused until the first is reset", async () => {
    const { telegram, bot, licensesPath } = await setupBot();
    const other = "F".repeat(32);
    await bot.handleUpdate(textUpdate(MACHINE_ID));
    await bot.handleUpdate(textUpdate(other));
    const screen = telegram.last("sendMessage");
    assert.match(screen.text, /Доступно одно устройство/);
    assert.ok(buttons(screen.reply_markup).some((button) => button.url === "https://fetchr.fun/account/"));
    assert.equal(readFileSync(licensesPath, "utf8").trim().split("\n").length, 1);

    const [record] = readFileSync(licensesPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    const { appendFileSync } = await import("node:fs");
    appendFileSync(licensesPath, `${JSON.stringify({ ...record, revoked_at: new Date().toISOString() })}\n`);
    await bot.handleUpdate(textUpdate(other));
    assert.match(telegram.last("sendMessage").text, /Устройство зарегистрировано/);
  });
});

describe("web login", () => {
  const ID = "abcdefghijklmnopqrstuvwxyz012345";

  test("a registered user confirms the site sign-in with one tap", async () => {
    const { telegram, bot, dir } = await setupBot();
    await bot.handleUpdate(textUpdate(MACHINE_ID));
    const box = createWebLoginBox(join(dir, "web-logins"));
    box.open(ID, { browser: "Chrome · Windows", ip: "1.2.3.4" });

    await bot.handleUpdate(textUpdate(`/start web_${ID}`));
    const prompt = telegram.lastScreen();
    assert.match(prompt.text, /Вход на fetchr\.fun/);
    assert.match(prompt.text, /Chrome · Windows/);
    assert.deepEqual(buttons(prompt.reply_markup).map((button) => button.callback_data), [`web:ok:${ID}`, `web:no:${ID}`]);

    await bot.handleUpdate(callbackUpdate(`web:ok:${ID}`));
    assert.equal(box.read(ID).status, "approved");
    assert.equal(box.read(ID).user_id, USER.id);
    assert.match(telegram.lastScreen().text, /вы вошли/);

    await bot.handleUpdate(callbackUpdate(`web:no:${ID}`));
    assert.equal(box.read(ID).status, "approved", "a decided request cannot be flipped");
  });

  test("an unregistered user is sent to registration, a stale link says so", async () => {
    const { telegram, bot, dir } = await setupBot();
    createWebLoginBox(join(dir, "web-logins")).open(ID);
    await bot.handleUpdate(textUpdate(`/start web_${ID}`));
    assert.match(telegram.lastScreen().text, /Аккаунта пока нет/);

    await bot.handleUpdate(textUpdate(`/start web_${"z".repeat(32)}`));
    assert.match(telegram.lastScreen().text, /устарела/);
  });
});

describe("win-back", () => {
  test("admin previews, then sends once to people whose key a release revoked", async () => {
    const { appendFileSync } = await import("node:fs");
    const { telegram, bot, licensesPath } = await setupBot();
    const line = (record) => appendFileSync(licensesPath, `${JSON.stringify(record)}\n`);
    const old = { issued_at: "2026-10-01T00:00:00Z", license_key: "k", revoked_at: "2026-11-04T00:00:00Z", revoked_by: "release" };
    line({ ...old, machine_id: "A".repeat(32), telegram_user_id: 50 });
    line({ ...old, machine_id: "B".repeat(32), telegram_user_id: 51 });
    line({ issued_at: "2026-11-05T00:00:00Z", machine_id: "B".repeat(32), license_key: "k2", telegram_user_id: 51 });
    line({ issued_at: "2026-11-05T00:00:00Z", machine_id: "C".repeat(32), license_key: "k3", telegram_user_id: 52 });

    await bot.handleUpdate(textUpdate("/winback", { from: { id: 50, first_name: "Не админ" } }));
    assert.ok(!telegram.of("sendMessage").some((call) => /Возврат ушедших/.test(call.body.text)));
    telegram.reset();

    const admin = { id: ADMIN_ID, first_name: "Админ" };
    await bot.handleUpdate(textUpdate("/winback", { from: admin }));
    assert.ok(telegram.of("sendMessage").some((call) => call.body.chat_id === ADMIN_ID && /Возврат ушедших<\/b>: 1 человек/.test(call.body.text)));
    assert.ok(!telegram.of("sendMessage").some((call) => call.body.chat_id === 50));

    await bot.handleUpdate(textUpdate("/winback send", { from: admin }));
    await bot.winbackDone();
    await bot.handleUpdate(textUpdate("/winback send", { from: admin }));
    await bot.winbackDone();
    const toUser = telegram.of("sendMessage").filter((call) => call.body.chat_id === 50);
    assert.equal(toUser.length, 1);
    assert.match(toUser[0].body.text, /новый бесплатно/);
    assert.ok(!telegram.of("sendMessage").some((call) => call.body.chat_id === 51 || call.body.chat_id === 52));
  });
});

describe("follow-ups and channel size", () => {
  const HOUR = 3_600_000;

  test("a newcomer gets service tips after a day, once, and no promo without opt-in", async () => {
    const { telegram, bot } = await setupBot();
    const start = Date.now();
    assert.equal(await bot.followUps(start), 0);
    await bot.handleUpdate(textUpdate(MACHINE_ID));
    telegram.reset();
    const tips = () => telegram.of("sendMessage").filter((call) => /Три совета/.test(call.body.text));
    const offer = () => telegram.of("sendMessage").filter((call) => /записываются сами/.test(call.body.text));

    assert.equal(await bot.followUps(start + 2 * HOUR), 0);
    assert.equal(await bot.followUps(start + 25 * HOUR), 1);
    assert.equal(await bot.followUps(start + 26 * HOUR), 0);
    assert.equal(tips().length, 1);
    assert.equal(tips()[0].body.chat_id, USER.id);
    assert.equal(await bot.followUps(start + 97 * HOUR), 0);
    assert.equal(offer().length, 0);
    assert.equal(await bot.followUps(start + 200 * HOUR), 0);
  });

  test("«Не присылать советы» stops the rest, and old users are never followed up", async () => {
    const { appendFileSync } = await import("node:fs");
    const { telegram, bot, licensesPath } = await setupBot();
    appendFileSync(licensesPath, `${JSON.stringify({ issued_at: "2020-01-01T00:00:00Z", machine_id: "C".repeat(32), license_key: "k", telegram_user_id: 77 })}\n`);
    const start = Date.now();
    await bot.followUps(start);
    await bot.handleUpdate(textUpdate(MACHINE_ID));
    await bot.handleUpdate(callbackUpdate("drip:off"));
    assert.equal(telegram.last("answerCallbackQuery").text, "Хорошо, больше не пришлю");
    telegram.reset();
    assert.equal(await bot.followUps(start + 100 * HOUR), 0);
    assert.equal(telegram.of("sendMessage").length, 0);
  });

  test("channel size is recorded once a day", async () => {
    const { telegram, bot, dir } = await setupBot();
    assert.equal(await bot.recordChannelSize(), 1234);
    assert.equal(await bot.recordChannelSize(), null);
    assert.equal(telegram.of("getChatMemberCount").length, 1);
    assert.match(readFileSync(`${dir}/channel-members.jsonl`, "utf8"), /"members":1234/);
  });
});

describe("win-back under Telegram limits", () => {
  test("429 is waited out and retried, a blocked user is recorded, «again» reminds only the unsure", async () => {
    const { appendFileSync, readFileSync: read } = await import("node:fs");
    const { telegram, bot, licensesPath, dir } = await setupBot({ rateLimitChats: [60], failChats: [61] });
    const old = { issued_at: "2026-10-01T00:00:00Z", license_key: "k", revoked_at: "2026-11-04T00:00:00Z", revoked_by: "release" };
    for (const [id, letter] of [[60, "D"], [61, "E"], [62, "F"]]) {
      appendFileSync(licensesPath, `${JSON.stringify({ ...old, machine_id: letter.repeat(32), telegram_user_id: id })}\n`);
    }
    // A first-run line without an outcome: that person counts as unsure.
    const { createHash } = await import("node:crypto");
    const markOf = (id) => createHash("sha256").update(`fetchr-winback:${id}`).digest("hex").slice(0, 24);
    appendFileSync(`${dir}/winback.jsonl`, `${JSON.stringify({ mark: markOf(62), at: "2026-11-09T01:10:00Z" })}\n`);

    const admin = { id: ADMIN_ID, first_name: "Админ" };
    await bot.handleUpdate(textUpdate("/winback send", { from: admin }));
    await bot.winbackDone();
    assert.match(telegram.of("sendMessage").find((call) => call.body.chat_id === ADMIN_ID).body.text, /Рассылка началась/);
    const to = (id) => telegram.of("sendMessage").filter((call) => call.body.chat_id === id);
    assert.equal(to(60).length, 2, "the 429 attempt and the retry");
    assert.equal(to(62).length, 0, "already handled by the first run");
    assert.match(telegram.last("sendMessage").text, /дошло 1, бот заблокирован у 1, не удалось 0/);
    assert.match(read(`${dir}/winback.jsonl`, "utf8"), /"result":"blocked"/);

    telegram.reset();
    await bot.handleUpdate(textUpdate("/winback again", { from: admin }));
    await bot.winbackDone();
    assert.equal(to(62).length, 1);
    assert.match(to(62)[0].body.text, /Напоминание/);
    assert.equal(to(60).length + to(61).length, 0);
  });
});
