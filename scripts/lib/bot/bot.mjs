/** Update dispatcher. Screens are edited in place, so the chat reads as one
 *  living menu rather than a scroll of stale keyboards.
 *
 * The shop can be closed (`config.shopEnabled` false): its buttons, commands
 * and profile lines disappear, and its deep links land on the menu with a note.
 */

import { parseCheckoutStart, productById } from "./catalog.mjs";
import { createDelivery } from "./delivery.mjs";
import { applyProfile } from "./profile.mjs";
import { createRegistration, extractMachineId } from "./registration.mjs";
import { deniedText, homeScreen, termsScreen } from "./screens.mjs";
import { createShop } from "./shop.mjs";
import { adminOrderText, adminSiteCheckoutText } from "./shop-screens.mjs";
import { createSupport } from "./support.mjs";
import { createWebLogin } from "./web-login.mjs";
import { createWinback } from "./winback.mjs";
import { createRestream } from "./restream.mjs";
import { createPromoBroadcast } from "./promo-broadcast.mjs";
import { createChannelStats } from "./channel-stats.mjs";
import { createDrip } from "./drip.mjs";
import { webLoginIdFromStart } from "../web-login.mjs";

const MONTHS = ["январь", "февраль", "март", "апрель", "май", "июнь", "июль", "август", "сентябрь", "октябрь", "ноябрь", "декабрь"];

export function statsText(activity) {
  const lines = activity.monthly(6).map(({ month, users }, index) => {
    const [year, number] = month.split("-");
    const label = `${MONTHS[Number(number) - 1]} ${year}`;
    return `${index === 0 ? "▸ " : ""}${label} — <b>${users}</b>${index === 0 ? " <i>(текущий)</i>" : ""}`;
  });
  return ["📊 <b>Пользователи по месяцам</b>", "", ...lines, "", `Всего уникальных: <b>${activity.total()}</b>`].join("\n");
}

const OOPS = "⚠️ Что-то пошло не так. Попробуйте ещё раз или напишите в поддержку.";
const SHOP_CLOSED = "🛒 <b>Магазин скоро откроется</b> — следите за новостями в канале.";
const SHOP_ROUTES = new Set(["shop", "per", "plan", "pay", "star", "free", "chk", "opt", "ad", "apay", "astar", "rs"]);

function errorText(err) {
  return err instanceof Error ? err.stack || err.message : String(err);
}

export function createBot(deps) {
  const { api, config, licenses, orders, tickets, sessions, activity, log } = deps;
  const shopOpen = Boolean(config.shopEnabled);
  let admins = [...config.adminIds];

  /** Explicit FETCHR_BOT_ADMIN_IDS, else the creator of the required channel. */
  async function adminChats() {
    if (admins.length > 0 || !config.requiredChannel) return admins;
    try {
      const members = await api("getChatAdministrators", { chat_id: config.requiredChannel });
      const creator = members.find((member) => member.status === "creator");
      if (creator?.user?.id) admins = [creator.user.id];
    } catch (err) {
      log.error(`Admin lookup failed: ${errorText(err)}`);
    }
    return admins;
  }

  const isAdminChat = (chatId) => admins.includes(chatId);
  const allowed = (userId) =>
    config.allowedUsers.size === 0 || config.allowedUsers.has(String(userId)) || isAdminChat(userId);

  const { send, show } = createDelivery({ api, banners: deps.banners, pictures: deps.pictures, decorate: deps.decorateScreen, log });

  /** Returns how many admin chats got the notice. With a ticket, a reply to
   *  it goes to that ticket's user. */
  async function notifyAdmins(text, ticket = null) {
    let delivered = 0;
    for (const chatId of await adminChats()) {
      try {
        const sent = await send(chatId, { text });
        if (ticket) tickets.link(ticket.id, chatId, sent.message_id);
        delivered += 1;
      } catch (err) {
        log.error(`Admin notice to ${chatId} failed: ${errorText(err)}`);
      }
    }
    if (delivered === 0) log.error("Admin notice reached nobody: no admin chat accepted it");
    return delivered;
  }

  function notifyOrder(order, user) {
    const ticket = tickets.open({ kind: "order", order_id: order.id, user_id: order.user_id, chat_id: order.user_id });
    return notifyAdmins(adminOrderText({ order, plan: productById(order.plan_id), user }), ticket);
  }

  function notifySiteCheckout(order, user) {
    return notifyAdmins(adminSiteCheckoutText({ order, plan: productById(order.plan_id), user }));
  }

  const common = { ...deps, adminChats, show, send, notifyAdmins, notifyOrder, notifySiteCheckout };
  const registration = createRegistration(common);
  const shop = createShop(common);
  const support = createSupport(common);
  const webLogin = createWebLogin(common);
  const winback = deps.winbackPath && licenses.records
    ? createWinback({ path: deps.winbackPath, licenseRecords: licenses.records, liveDevices: licenses.devices, send, sleep: deps.sleep, log })
    : null;
  let winbackRunning = null;
  // Promotional broadcasts require separate prior opt-in consent (ст. 15 152-ФЗ, ст. 18 ФЗ «О рекламе»).
  const promo = deps.promoPath && shopOpen
    ? createPromoBroadcast({
        path: deps.promoPath,
        audience: typeof deps.promoAudience === "function" ? deps.promoAudience : () => [],
        send,
        sleep: deps.sleep,
        now: deps.now,
        log,
      })
    : null;
  let promoRunning = null;
  const restream = createRestream({ api, restreamApi: deps.restreamApi, sessions, show, send, log });
  const drip = deps.dripPath && licenses.records
    ? createDrip({ path: deps.dripPath, licenseRecords: licenses.records, send, shopOpen, now: deps.now, log })
    : null;
  const channelStats = deps.channelStatsPath
    ? createChannelStats({ api, channel: config.requiredChannel, path: deps.channelStatsPath, now: deps.now, log })
    : null;

  function showHome(chatId, messageId, from, notice = "") {
    const devices = licenses.devices(from.id);
    return show(
      chatId,
      messageId,
      homeScreen({
        user: from,
        deviceCount: devices.length,
        machineId: devices.at(-1)?.machineId ?? "",
        subscription: shopOpen ? shop.subscriptionFor(from.id) : null,
        monthlyUsers: activity.monthly(1)[0].users,
        channelUrl: config.requiredChannelUrl,
        shop: shopOpen,
        notice,
      }),
    );
  }

  /** Returns the toast for answerCallbackQuery, or null. */
  async function routeCallback(data, chatId, messageId, from) {
    const [head, ...rest] = data.split(":");
    if (!shopOpen && SHOP_ROUTES.has(head)) {
      await showHome(chatId, messageId, from, SHOP_CLOSED);
      return null;
    }
    switch (head) {
      case "cons":
        return registration.consent(chatId, messageId, from);
      case "drip":
        drip?.optOut(from.id);
        return "Хорошо, больше не пришлю";
      case "promo":
        promo?.optOut(from.id);
        return "Хорошо, акции больше не пришлю";
      case "reg":
        if (rest[0] === "check") return registration.recheck(chatId, messageId, from);
        if (rest[0] === "key") return registration.showKey(chatId, messageId, from, rest[1]);
        await registration.open(chatId, messageId, from);
        return null;
      case "shop":
        await shop.openShop(chatId, messageId, from, rest[0]);
        return null;
      case "per":
        await shop.openTerm(chatId, messageId, from, rest[0], rest[1], Number(rest[2]));
        return null;
      case "plan":
        await shop.openPlan(chatId, messageId, from, rest[0], rest[1], Number(rest[2]), Number(rest[3]));
        return null;
      case "opt":
        await shop.openAddons(chatId, messageId, from, rest[1], rest[4], Number(rest[3]) || 1);
        return null;
      case "ad":
        await shop.openAddons(chatId, messageId, from, rest[0], rest[1], Number(rest[2]) || 1);
        return null;
      // `apay:` is on older add-on screens: Stars too.
      case "apay":
      case "astar":
        return shop.checkoutAddons(chatId, messageId, from, rest[0], Number(rest[1]));
      case "pay":
        return shop.checkout(chatId, messageId, from, rest[0], rest[1], Number(rest[2]), Number(rest[3]));
      case "star":
        return shop.checkoutStars(chatId, messageId, from, rest[0], rest[1], Number(rest[2]), Number(rest[3]));
      case "rs":
        await restream.route(rest, chatId, messageId, from);
        return null;
      case "free":
        return shop.requestFree(chatId, messageId, from);
      case "chk": {
        if (orders.get(rest[0])?.user_id !== from.id) return "Заказ не найден";
        const status = await shop.pollPayments(rest[0]);
        if (status === "paid") return "Оплата получена ✅";
        return "Оплата пока не поступила";
      }
      case "sup":
        return routeSupport(rest, chatId, messageId, from);
      case "web":
        return webLogin.decide(chatId, messageId, from, rest[0], rest.slice(1).join(":"));
      case "terms": {
        // The way back comes from the button itself; only screens the terms
        // are linked from are accepted, so a forged one cannot break the edit.
        const backTo = rest.join(":");
        const safe = /^(home|shop(:[a-z]+)?|plan:[a-z]+:[a-z]+:\d{1,2}(:\d{1,2})?(:c\d{1,2}r\d{1,2}e\d{1,2})?)$/.test(backTo) ? backTo : "home";
        await show(chatId, messageId, termsScreen({ backTo: safe }));
        return null;
      }
      case "noop":
        if (rest[0] === "slots") return "Свободных мест для рестрима сейчас нет";
        if (rest[0] === "optmax") return "Это максимум";
        return rest[0] === "max" ? "Больше места выгоднее взять тарифом выше" : null;
      default:
        await showHome(chatId, messageId, from);
        return null;
    }
  }

  async function routeSupport([action, arg], chatId, messageId, from) {
    if (action === "write") {
      await support.startWriting(chatId, messageId, from, { kind: arg === "pay" ? "payment" : "support" });
    } else if (action === "pay") {
      await support.open(chatId, messageId, { payment: true, shop: shopOpen });
    } else if (action === "cancel") {
      await support.cancel(chatId, messageId, from);
    } else if (action === "reply") {
      const ticket = support.ownTicket(from, arg);
      if (!ticket) return "Обращение не найдено";
      await support.startWriting(chatId, null, from, { kind: ticket.kind, ticketId: ticket.id });
    } else {
      await support.open(chatId, messageId, { shop: shopOpen });
    }
    return null;
  }

  async function onCallback(query) {
    let toast = null;
    let alert = false;
    try {
      const chatId = query.message?.chat?.id;
      if (!chatId) return;
      if (!allowed(query.from.id)) {
        toast = "Доступ закрыт";
        alert = true;
        return;
      }
      toast = await routeCallback(String(query.data || ""), chatId, query.message.message_id, query.from);
    } catch (err) {
      log.error(`Callback ${query.data} failed: ${errorText(err)}`);
      toast = "Что-то пошло не так — попробуйте ещё раз";
      alert = true;
    } finally {
      await api("answerCallbackQuery", {
        callback_query_id: query.id,
        ...(toast ? { text: toast, show_alert: alert } : {}),
      }).catch((err) => log.error(`answerCallbackQuery failed: ${errorText(err)}`));
    }
  }

  function onStart(chatId, from, arg) {
    const webLoginId = webLoginIdFromStart(arg);
    if (webLoginId) return webLogin.prompt(chatId, from, webLoginId);
    const machineId = extractMachineId(arg);
    if (machineId) return registration.register(chatId, from, machineId);
    const checkout = parseCheckoutStart(arg);
    if ((checkout || arg === "shop") && !shopOpen) return showHome(chatId, null, from, SHOP_CLOSED);
    if (checkout) return shop.openTerm(chatId, null, from, checkout.planId, checkout.currency, checkout.packs);
    if (arg === "shop") return shop.openShop(chatId, null, from);
    if (arg === "register") return registration.open(chatId, null, from);
    if (arg === "support") return support.open(chatId, null, { shop: shopOpen });
    if (arg === "paysupport") return support.open(chatId, null, { payment: true, shop: shopOpen });
    return showHome(chatId, null, from);
  }

  function onCommand(chatId, from, name, arg) {
    sessions.set(from.id, { awaiting: null });
    if (name === "refund" && isAdminChat(chatId)) {
      const [userId, chargeId] = arg.split(/\s+/);
      if (/^\d+$/.test(userId || "") && /^[\w-]{1,128}$/.test(chargeId || "")) {
        return shop.refund(chatId, Number(userId), chargeId);
      }
      return send(chatId, { text: "Формат: <code>/refund user_id charge_id</code>" });
    }
    if (name === "winback" && isAdminChat(chatId) && winback) {
      const mode = arg.trim();
      if (mode !== "send" && mode !== "again") return winback.preview(chatId);
      // Minutes of sending must not hold up everyone else's updates.
      if (winbackRunning) return send(chatId, { text: "📣 Рассылка уже идёт — итог придёт сюда." });
      winbackRunning = send(chatId, { text: "📣 Рассылка началась, итог придёт сюда." })
        .catch(() => {})
        .then(() => (mode === "send" ? winback.sendAll(chatId) : winback.sendAgain(chatId)))
        .catch((err) => log.error(`Win-back run failed: ${errorText(err)}`))
        .finally(() => { winbackRunning = null; });
      return null;
    }
    if (name === "promo" && isAdminChat(chatId) && promo) {
      if (arg.trim() !== "send") return promo.preview(chatId);
      if (promoRunning) return send(chatId, { text: "📣 Рассылка уже идёт — итог придёт сюда." });
      promoRunning = send(chatId, { text: "📣 Рассылка акции началась, итог придёт сюда." })
        .catch(() => {})
        .then(() => promo.sendAll(chatId))
        .catch((err) => log.error(`Sale broadcast failed: ${errorText(err)}`))
        .finally(() => { promoRunning = null; });
      return null;
    }
    switch (name) {
      case "start":
        return onStart(chatId, from, arg);
      case "register":
      case "key":
        return registration.open(chatId, null, from);
      case "shop":
        return shopOpen ? shop.openShop(chatId, null, from) : showHome(chatId, null, from, SHOP_CLOSED);
      case "restream":
        return shopOpen ? restream.home(chatId, null, from) : showHome(chatId, null, from, SHOP_CLOSED);
      case "support":
      case "help":
        return support.open(chatId, null, { shop: shopOpen });
      case "paysupport":
        return support.open(chatId, null, { payment: true, shop: shopOpen });
      case "terms":
        return send(chatId, termsScreen());
      case "stats":
        return send(chatId, { text: statsText(activity) });
      default:
        return showHome(chatId, null, from);
    }
  }

  async function onMessage(message) {
    const { chat } = message;
    const from = message.from || {};
    if (message.reply_to_message && isAdminChat(chat.id) && (await support.fromAdmin(message))) return;
    if (chat.type !== "private") return;
    if (message.successful_payment) return shop.onSuccessfulPayment(message);
    if (!allowed(from.id)) return send(chat.id, { text: deniedText() });

    const text = message.text || "";
    const command = /^\/([a-z_]+)(?:@\w+)?(?:\s+([\s\S]+))?$/i.exec(text.trim());
    if (command) return onCommand(chat.id, from, command[1].toLowerCase(), (command[2] || "").trim());

    // An open conversation wins over Machine ID detection: a pasted log with
    // an md5 in it is a message for support, not a device to register.
    const session = sessions.get(from.id);
    const own = session.ticketId ? support.ownTicket(from, session.ticketId) : null;
    if (session.awaiting === "support") return support.fromUser(message, own);
    if (session.awaiting === "restream" && shopOpen && text) return restream.onText(message);
    const replied = message.reply_to_message ? tickets.find(chat.id, message.reply_to_message.message_id) : null;
    const ticket = (replied?.user_id === from.id ? replied : null) || own;
    if (ticket) return support.fromUser(message, ticket);

    const machineId = extractMachineId(text);
    if (machineId) return registration.register(chat.id, from, machineId);

    return showHome(chat.id, null, from, "🤔 <i>Не понял сообщение. Выберите раздел ниже или напишите в поддержку.</i>");
  }

  return {
    adminChats,

    async handleUpdate(update) {
      try {
        const visitor = update.callback_query?.from ?? (update.message?.chat?.type === "private" ? update.message.from : null);
        if (visitor && !visitor.is_bot) activity.touch(visitor.id);
        if (update.pre_checkout_query) await shop.onPreCheckout(update.pre_checkout_query);
        else if (update.callback_query) await onCallback(update.callback_query);
        else if (update.message) await onMessage(update.message);
      } catch (err) {
        log.error(`Update ${update.update_id} failed: ${errorText(err)}`);
        const chat = update.message?.chat;
        if (chat?.type === "private") await send(chat.id, { text: OOPS }).catch(() => {});
      }
    },

    pollPayments: () => shop.pollPayments(),
    followUps: (at) => drip?.tick(at) ?? 0,
    /** Resolves when a background win-back run has finished (tests). */
    winbackDone: () => winbackRunning ?? Promise.resolve(),
    promoDone: () => promoRunning ?? Promise.resolve(),
    recordChannelSize: () => channelStats?.record() ?? null,

    async setup() {
      await applyProfile(api, { shop: shopOpen }, log);
      const chats = await adminChats();
      log.info(
        chats.length
          ? `Admin chats: ${chats.join(", ")}`
          : "No admin chats: support messages and orders will not reach anyone",
      );
      if (chats.length > 0) {
        const resent = await shop.announcePending();
        if (resent > 0) log.info(`Re-announced ${resent} order(s) admins had not seen`);
      }
    },
  };
}
