/** Win-back: one message to people whose key a release revoked and who never
 * took a new one. Admin-only: `/winback` shows how many and the message,
 * `/winback send` sends it, `/winback again` sends a short reminder to those
 * whose first message may not have arrived.
 *
 * Telegram limits how fast a bot may send: on 429 the bot waits as long as
 * Telegram asks and tries again. Each person's outcome is recorded (delivered,
 * blocked, failed) under a hash of the Telegram id, never the id itself.
 * Lines without an outcome come from the first run, which did not record one. */

import { createHash } from "node:crypto";

import { appendJsonLine, readJsonLines } from "./store.mjs";
import { btn, keyboard, plural, urlBtn } from "./ui.mjs";

const SITE_URL = "https://fetchr.fun/?utm_source=winback";
const PAUSE_MS = 2_000;
const MAX_TRIES = 4;

const mark = (userId) => createHash("sha256").update(`fetchr-winback:${userId}`).digest("hex").slice(0, 24);

const markup = () => keyboard([
  [urlBtn("⬇️ Скачать Fetchr", SITE_URL, "primary")],
  [btn("🔑 Получить ключ", "reg", "success"), btn("💬 Поддержка", "sup")],
]);

export function winbackScreen() {
  return {
    text: [
      "🔑 <b>Ваш ключ Fetchr больше не работает — новый бесплатно за минуту</b>",
      "",
      "Мы обновили защиту ключей, и старые перестали подходить. Это не блокировка: ключ просто нужно взять заново.",
      "",
      "1. Обновите Fetchr — приложение предложит само, или скачайте с сайта.",
      "2. Нажмите «Активировать через Telegram» — ключ придёт сюда.",
      "",
      "Дальше ключи при обновлениях сгорать не будут.",
    ].join("\n"),
    markup: markup(),
  };
}

export function winbackReminderScreen() {
  return {
    text: [
      "🔔 <b>Напоминание: старый ключ Fetchr больше не подходит</b>",
      "",
      "Обновите приложение и нажмите «Активировать через Telegram» — новый ключ бесплатный и придёт сюда за минуту.",
    ].join("\n"),
    markup: markup(),
  };
}

export function createWinback({ path, licenseRecords, liveDevices, send, sleep = (ms) => new Promise((done) => setTimeout(done, ms)), now = () => Date.now(), log }) {
  /** Latest outcome per mark: "delivered", "blocked", "failed" or "unknown" (first run). */
  function outcomes() {
    const out = new Map();
    for (const line of readJsonLines(path)) if (line?.mark) out.set(line.mark, line.result || "unknown");
    return out;
  }

  /** Accounts with a key revoked by a release and no live key today. */
  function lapsed() {
    const revoked = new Set(
      licenseRecords()
        .filter((record) => record?.revoked_by === "release" && record.telegram_user_id)
        .map((record) => record.telegram_user_id),
    );
    return [...revoked].filter((userId) => liveDevices(userId).length === 0);
  }

  const fresh = () => {
    const seen = outcomes();
    return lapsed().filter((userId) => !seen.has(mark(userId)));
  };
  /** Not known to have got anything, and not known to have blocked the bot. */
  const unsure = () => {
    const seen = outcomes();
    return lapsed().filter((userId) => ["unknown", "failed"].includes(seen.get(mark(userId))));
  };

  /** Waits out Telegram's flood limit and retries; returns the outcome. */
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
        log.error(`Win-back to a user failed: ${err instanceof Error ? err.message : err}`);
        return "failed";
      }
    }
    return "failed";
  }

  async function tellAdmin(adminChatId, screen) {
    const outcome = await deliver(adminChatId, screen);
    if (outcome !== "delivered") log.error(`Win-back summary not delivered: ${outcome}`);
  }

  async function preview(adminChatId) {
    const people = fresh();
    const again = unsure();
    await tellAdmin(adminChatId, {
      text: [
        `📣 <b>Возврат ушедших</b>: ${people.length} ${plural(people.length, ["человек", "человека", "человек"])} — ключ сгорел при релизе, новый не взяли.`,
        "",
        "Каждый получит сообщение ниже один раз. Отправить: <code>/winback send</code>",
        ...(again.length
          ? ["", `Ещё ${again.length} — сообщение могло не дойти. Короткое напоминание им: <code>/winback again</code>`]
          : []),
      ].join("\n"),
    });
    await tellAdmin(adminChatId, winbackScreen());
    return people.length;
  }

  async function run(adminChatId, people, screen, title) {
    const tally = { delivered: 0, blocked: 0, failed: 0 };
    for (const userId of people) {
      const result = await deliver(userId, screen);
      tally[result] += 1;
      appendJsonLine(path, { mark: mark(userId), result, at: new Date(now()).toISOString() });
      await sleep(PAUSE_MS);
    }
    await tellAdmin(adminChatId, {
      text: `📣 ${title}: дошло ${tally.delivered}, бот заблокирован у ${tally.blocked}, не удалось ${tally.failed}.`
        + (tally.failed ? " Повторить: <code>/winback again</code>" : ""),
    });
    return tally;
  }

  const sendAll = (adminChatId) => run(adminChatId, fresh(), winbackScreen(), "Возврат");
  const sendAgain = (adminChatId) => run(adminChatId, unsure(), winbackReminderScreen(), "Напоминание");

  return { candidates: fresh, unsure, preview, sendAll, sendAgain };
}
