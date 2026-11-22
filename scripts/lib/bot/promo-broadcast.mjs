/** Sale broadcast: one message about the running sale to everyone the bot
 * knows — people with a key, buyers and anyone who opened the bot. Admin-only:
 * `/promo` shows how many and the message, `/promo send` sends it.
 *
 * Each person gets a campaign once; «Не присылать акции» stops every later
 * one. Outcomes and opt-outs are kept under a hash of the Telegram id, never
 * the id itself. On 429 the bot waits as long as Telegram asks. */

import { createHash } from "node:crypto";

import { PROMO, promoActive } from "./catalog.mjs";
import { appendJsonLine, readJsonLines } from "./store.mjs";
import { btn, keyboard, plural } from "./ui.mjs";

const PAUSE_MS = 1_000;
const MAX_TRIES = 4;
const OPT_OUT = "optout";

const mark = (userId) => createHash("sha256").update(`fetchr-promo:${userId}`).digest("hex").slice(0, 24);
const campaignId = () => `sale-${PROMO.label}-${PROMO.until.slice(0, 10)}`;

export function promoScreen() {
  return {
    text: [
      `🔥 <b>Распродажа ${PROMO.label} в Fetchr</b>`,
      "",
      "С 9 по 15 ноября тарифы Архива VPS дешевле:",
      "",
      "<blockquote>• −10% при оплате на месяц",
      "• −20% за 3, 6 и 12 месяцев на все тарифы",
      "• <b>Стример: −30% за полгода и −50% за год</b></blockquote>",
      "",
      "Например, Стример на год стоит <s>6 000 ₽</s> <b>3 000 ₽</b>: это 150 ГБ и две записи одновременно, 250 ₽ в месяц.",
      "",
      "Сервер сам ловит эфир и пишет его вместе с чатом, даже когда компьютер выключен. Скидка действует на весь заказ, включая доп. память.",
      "",
      `⏳ Только до ${PROMO.untilLabel} включительно.`,
    ].join("\n"),
    markup: keyboard([
      [btn(`🛒 Магазин · до −${PROMO.maxPercent}%`, "shop", "success")],
      [btn("🔕 Не присылать акции", "promo:off")],
    ]),
  };
}

export function createPromoBroadcast({ path, audience, send, sleep = (ms) => new Promise((done) => setTimeout(done, ms)), now = () => Date.now(), log }) {
  function seen() {
    const campaign = campaignId();
    const done = new Set();
    const optedOut = new Set();
    for (const line of readJsonLines(path)) {
      if (!line?.mark) continue;
      if (line.result === OPT_OUT) optedOut.add(line.mark);
      else if (line.campaign === campaign && line.result !== "failed") done.add(line.mark);
    }
    return { done, optedOut };
  }

  function pending() {
    const { done, optedOut } = seen();
    return [...new Set(audience())].filter((userId) => {
      const key = mark(userId);
      return !done.has(key) && !optedOut.has(key);
    });
  }

  async function deliver(userId, screen) {
    for (let attempt = 1; attempt <= MAX_TRIES; attempt += 1) {
      try {
        await send(userId, screen);
        return "delivered";
      } catch (err) {
        if (err?.code === 403) return "blocked";
        if (err?.code === 429 && attempt < MAX_TRIES) {
          await sleep(((err.retryAfter || 5) + 1) * 1000);
          continue;
        }
        log.error(`Sale broadcast to a user failed: ${err instanceof Error ? err.message : err}`);
        return "failed";
      }
    }
    return "failed";
  }

  async function preview(adminChatId) {
    if (!promoActive(now())) {
      await deliver(adminChatId, { text: "📣 Акция не идёт — рассылать нечего." });
      return 0;
    }
    const people = pending();
    await deliver(adminChatId, {
      text: [
        `📣 <b>Рассылка акции ${PROMO.label}</b>: ${people.length} ${plural(people.length, ["человек", "человека", "человек"])} ещё не получили.`,
        "",
        "Каждый получит сообщение ниже один раз. Отправить: <code>/promo send</code>",
      ].join("\n"),
    });
    await deliver(adminChatId, promoScreen());
    return people.length;
  }

  async function sendAll(adminChatId) {
    if (!promoActive(now())) return { delivered: 0, blocked: 0, failed: 0 };
    const campaign = campaignId();
    const tally = { delivered: 0, blocked: 0, failed: 0 };
    for (const userId of pending()) {
      const result = await deliver(userId, promoScreen());
      tally[result] += 1;
      appendJsonLine(path, { mark: mark(userId), campaign, result, at: new Date(now()).toISOString() });
      await sleep(PAUSE_MS);
    }
    await deliver(adminChatId, {
      text: `📣 Акция ${PROMO.label}: дошло ${tally.delivered}, бот заблокирован у ${tally.blocked}, не удалось ${tally.failed}.`
        + (tally.failed ? " Повторить: <code>/promo send</code>" : ""),
    });
    return tally;
  }

  function optOut(userId) {
    appendJsonLine(path, { mark: mark(userId), result: OPT_OUT, at: new Date(now()).toISOString() });
  }

  return { pending, preview, sendAll, optOut };
}
