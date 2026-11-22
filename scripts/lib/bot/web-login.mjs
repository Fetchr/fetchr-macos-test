/** «Войти через Telegram» on fetchr.fun: the site opens the bot with
 *  `/start web_<id>`, the user confirms here, the site's poll picks it up. */

import { btn, esc, keyboard, urlBtn } from "./ui.mjs";

const SITE = "https://fetchr.fun/account/";

function time(stamp) {
  return new Date(stamp).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Moscow" });
}

export function webLoginPromptScreen(request, id) {
  return {
    text: [
      "🔐 <b>Вход на fetchr.fun</b>",
      "",
      "Кто-то открыл личный кабинет и выбрал «Войти через Telegram».",
      "",
      `<blockquote>🖥 ${esc(request.browser || "Браузер")}${request.ip ? `\n🌐 IP <code>${esc(request.ip)}</code>` : ""}\n🕐 ${time(request.created_at)} МСК</blockquote>`,
      "",
      "<i>Нажимайте «Войти», только если вход начали вы сами. Если ссылку прислал кто-то другой — отмените: он получит доступ к вашему кабинету.</i>",
    ].join("\n"),
    markup: keyboard([[btn("✅ Войти", `web:ok:${id}`, "success"), btn("Отмена", `web:no:${id}`, "danger")]]),
  };
}

export const webLoginDoneScreen = () => ({
  text: "✅ <b>Готово — вы вошли.</b>\n\nВернитесь во вкладку с сайтом: кабинет откроется сам.",
  markup: keyboard([[urlBtn("Открыть кабинет", SITE)]]),
});

export const webLoginDeniedScreen = () => ({ text: "🚫 <b>Вход отменён.</b>\n\nСайт не получил доступа к аккаунту." });

export const webLoginExpiredScreen = () => ({
  text: "⌛️ <b>Ссылка для входа устарела.</b>\n\nОткройте кабинет и нажмите «Войти через Telegram» ещё раз.",
  markup: keyboard([[urlBtn("Открыть кабинет", SITE)]]),
});

export const webLoginUnregisteredScreen = () => ({
  text: "🔑 <b>Аккаунта пока нет.</b>\n\nВход на сайт открывается после регистрации: получите ключ — он привяжется к этому Telegram.",
  markup: keyboard([[btn("🔑 Регистрация", "reg", "primary")]]),
});

export function createWebLogin({ webLogins, licenses, orders, show, send, log }) {
  const registered = (userId) => licenses.known(userId) || Boolean(orders?.find((order) => order.user_id === userId));

  function prompt(chatId, from, id) {
    if (!webLogins) return send(chatId, webLoginExpiredScreen());
    const request = webLogins.read(id);
    if (!request || request.status !== "pending") return send(chatId, webLoginExpiredScreen());
    if (!registered(from.id)) return send(chatId, webLoginUnregisteredScreen());
    return send(chatId, webLoginPromptScreen(request, id));
  }

  /** Returns the callback toast. */
  async function decide(chatId, messageId, from, action, id) {
    const approved = action === "ok";
    if (approved && !registered(from.id)) {
      await show(chatId, messageId, webLoginUnregisteredScreen());
      return null;
    }
    const decided = webLogins?.decide(id, from, approved);
    if (!decided) {
      await show(chatId, messageId, webLoginExpiredScreen());
      return "Ссылка устарела";
    }
    log.info(`web login ${approved ? "approved" : "denied"} by ${from.id}`);
    await show(chatId, messageId, approved ? webLoginDoneScreen() : webLoginDeniedScreen());
    return approved ? "Вы вошли на сайт" : "Вход отменён";
  }

  return { prompt, decide };
}
