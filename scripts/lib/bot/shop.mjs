/** Shop: catalog, checkout and payment confirmation.
 *
 * In the bot everything is paid with Telegram Stars (Telegram's rules for
 * digital goods). Rubles via Robokassa are sold only on the site
 * (site-checkout.mjs): the API server appends those orders to
 * site-orders.jsonl, `pollPayments` imports them and matches Robokassa's
 * ResultURL records, so a site payment is confirmed here like any other.
 *
 * Stars are priced from the ruble total (`starsFor`) and settle through
 * `onSuccessfulPayment`; `refund` returns them. Crypto is no longer sold.
 *
 * Every order admins must act on carries `announced_at` once a notice reached
 * at least one admin; `announcePending` re-sends the rest after a restart, so
 * a crash between taking a payment and telling anyone never loses it.
 */

import {
  canAddPacks,
  clampMonths,
  clampPacks,
  isCurrency,
  orderQuotaGb,
  periodDays,
  promoTotal,
  isOnSale,
  planById,
  starsFor,
  RESTREAM_SLOTS,
  ADDONS_ID,
  ADDON_STEP_GB,
  addonsTotal,
  clampExtras,
  fmtMonths,
  hasExtras,
  parseExtras,
  productById,
  restreamOutputs,
} from "./catalog.mjs";
import { addonLimits, addonsNeedPlanScreen, addonsScreen, withinLimits } from "./extras-screens.mjs";
import {
  adminPaymentIssueText,
  freeRequestedScreen,
  invoiceFields,
  paidCardScreen,
  paidScreen,
  planScreen,
  shopScreen,
} from "./shop-screens.mjs";
import { esc } from "./ui.mjs";
import { restreamSlotsLeftOf, sameExtras, orderFieldsOf, switchCreditOf } from "./pricing.mjs";
import { subscriptionOf } from "../account-subscription.mjs";

const ORDER_PAYLOAD = /^ord:([A-Z0-9]{6})$/;
const REUSE_WINDOW_MS = 10 * 60_000;
const DEFAULT_CURRENCY = "rub";
const ANNOUNCED_STATUSES = ["paid", "awaiting_payment", "requested"];
const TOO_MANY_ORDERS = "Слишком много заявок подряд — подождите пару минут";
const NO_RESTREAM_SLOTS ="Свободных мест для рестрима сейчас нет — уменьшите число площадок или напишите в поддержку";
const tooManyStars = (max) => `Звёздами можно до ${max} ⭐ — выберите срок короче или оплатите рублями на https://fetchr.fun/arhiv-vps/`;
/** Robokassa orders (bought on the site, or older card links still open)
 *  waiting for a ResultURL record. */
const OPEN_ROBOKASSA = ["pending", "superseded"];
/** Telegram caps one Stars invoice at this many. */
const MAX_INVOICE_STARS = 10_000;

function errorText(err) {
  return err instanceof Error ? err.message : String(err);
}

export function createShop(deps) {
  const { api, orders, sessions, licenses, limiter, notifyOrder, notifySiteCheckout, notifyAdmins, show, send, log } = deps;
  const robokassaPayments = deps.robokassaPayments ?? (() => []);
  /** Robokassa orders the site created (site-orders.jsonl, API server). */
  const siteOrders = deps.siteOrders ?? (() => []);
  const now = deps.now ?? (() => Date.now());
  const stamp = () => new Date(now()).toISOString();

  function currencyFor(userId, requested) {
    if (isCurrency(requested)) return requested;
    const remembered = sessions.get(userId).currency;
    return isCurrency(remembered) ? remembered : DEFAULT_CURRENCY;
  }

  function currentSubscription(userId) {
    return subscriptionOf(
      orders.all().filter((order) => order.user_id === userId),
      now(),
    );
  }

  function switchCredit(userId, plan, packs, months, extras) {
    return switchCreditOf(orders.all().filter((order) => order.user_id === userId), plan, packs, months, extras, now());
  }

  const longerTermNeeded = (daysLeft) =>
    `У вас оплачено ещё ${daysLeft} дн. — чтобы сменить тариф или опции, выберите срок длиннее`;

  function baseOrder(chatId, from, plan, packs, currency, months, extras) {
    const { credit } = canAddPacks(plan) ? switchCredit(from.id, plan, packs, months, extras) : { credit: 0 };
    return {
      user_id: from.id,
      plan_id: plan.id,
      packs,
      quota_gb: orderQuotaGb(plan, packs),
      currency,
      months,
      ...orderFieldsOf(extras),
      credit,
      amount: promoTotal(plan, packs, currency, now(), months, extras) - credit,
    };
  }

  /** The running paid plan add-ons attach to, or null. */
  function addonBase(userId) {
    const subscription = currentSubscription(userId);
    return subscription?.active && !subscription.free ? subscription : null;
  }

  /** Requested add-ons cut down to what the plan and the server allow. */
  function fitAddons(subscription, raw, slotsLeft) {
    let extras = { packs: raw.packs || 0, channels: Math.min(raw.channels, 5), restream: raw.restream, restreamExtra: raw.restreamExtra };
    for (const key of ["packs", "channels", "restream", "restreamExtra"]) {
      const limits = addonLimits({ subscription, extras, slotsLeft });
      extras = { ...extras, [key]: Math.max(0, Math.min(extras[key], limits[key])) };
    }
    return extras;
  }

  function restreamSlotsLeft(userId) {
    return restreamSlotsLeftOf(orders.all(), userId, now());
  }

  /** Orders hold only the id: admins see the buyer's current Telegram profile. */
  async function buyerOf(order) {
    const profile = await api("getChat", { chat_id: order.user_id }).catch(() => null);
    return { id: order.user_id, username: profile?.username, first_name: profile?.first_name };
  }

  async function announce(order, from = null) {
    if ((await notifyOrder(order, from || (await buyerOf(order)))) > 0) orders.update(order.id, { announced_at: stamp() });
  }

  /** A second tap on «Оплатить» should not open a second invoice. */
  function recentOrder(from, plan, packs, currency, method, months, extras) {
    return orders.find(
      (order) =>
        order.user_id === from.id &&
        order.plan_id === plan.id &&
        order.packs === packs &&
        sameExtras(order, extras) &&
        (order.months ?? 1) === months &&
        order.currency === currency &&
        order.method === method &&
        order.status === "pending" &&
        now() - Date.parse(order.created_at) < REUSE_WINDOW_MS,
    );
  }

  /** Copies new site orders into the store under their own id, so the
   *  ResultURL record (Shp_order) matches them. An id the bot already uses
   *  is never overwritten. */
  function importSiteOrders() {
    let incoming = [];
    try {
      incoming = siteOrders();
    } catch (err) {
      log.error(`Site orders unreadable: ${errorText(err)}`);
      return;
    }
    for (const order of incoming) {
      if (!order?.id || !order.inv_id || order.method !== "robokassa") continue;
      const known = orders.get(order.id);
      if (known) {
        if (known.user_id !== order.user_id) log.error(`Site order ${order.id} clashes with a bot order`);
        continue;
      }
      orders.create({ ...order, source: "site" });
    }
  }

  /** Admins first: the buyer's copy is the one that may fail (blocked bot). */
  async function finalizePaid(order, patch, from) {
    const current = orders.get(order.id);
    if (!current || current.status === "paid") return;
    const paid = orders.update(order.id, { ...patch, status: "paid", paid_at: stamp() });
    await announce(paid, from);
    const outputs = (paid.restream_streamers || 0) + (paid.restream_extra || 0);
    if (outputs > restreamSlotsLeft(paid.user_id)) {
      await notifyAdmins(`⚠️ <b>Заказ #${paid.id}</b>: рестрим продан сверх ${RESTREAM_SLOTS} мест. Проверьте трафик в /admin/#server или поднимите RESTREAM_SLOTS.`);
    }
    const product = productById(paid.plan_id);
    // The card the buyer paid from loses its buttons; never a new message for it.
    if (paid.card_chat_id && paid.card_message_id) {
      await show(paid.card_chat_id, paid.card_message_id, paidCardScreen({ order: paid, plan: product }), { fallback: false }).catch((err) =>
        log.error(`Paid card ${paid.id} not updated: ${errorText(err)}`),
      );
    }
    await send(paid.user_id, paidScreen({ order: paid, plan: product })).catch((err) =>
      log.error(`Paid notice to buyer ${paid.user_id} failed: ${errorText(err)}`),
    );
  }

  async function reportPaymentIssue(title, hint, from, payment) {
    log.error(`${title.replace(/<[^>]+>/g, "")}: ${payment.telegram_payment_charge_id}`);
    await notifyAdmins(adminPaymentIssueText({ title, hint, user: from, payment }));
  }

  return {
    /** The user's running plan (or Free), for the home dashboard. */
    subscriptionFor: (userId) => currentSubscription(userId),

    async openShop(chatId, messageId, from, requested) {
      const currency = currencyFor(from.id, requested);
      sessions.set(from.id, { currency });
      return show(chatId, messageId, shopScreen({ currency, subscription: currentSubscription(from.id) }));
    },

    /** Old term-step links (`per:`, the app's deep link) open the plan card:
     *  the term is now a segment on the card itself. */
    async openTerm(chatId, messageId, from, planId, requested, packs) {
      return this.openPlan(chatId, messageId, from, planId, requested, packs, 1);
    },

    /** The plan card; «Оплатить» opens a Stars invoice. */
    async openPlan(chatId, messageId, from, planId, requested, rawPacks, rawMonths, rawExtras) {
      const plan = planById(planId);
      const currency = currencyFor(from.id, requested);
      if (!isOnSale(plan)) {
        await show(chatId, messageId, shopScreen({ currency }));
        return null;
      }
      sessions.set(from.id, { currency });
      const registered = licenses.devices(from.id).length > 0;
      const extras = clampExtras(plan, parseExtras(rawExtras));
      const packs = clampPacks(plan, rawPacks);
      const months = clampMonths(rawMonths);
      const switching = switchCredit(from.id, plan, packs, months, extras);
      return show(
        chatId,
        messageId,
        planScreen({
          plan,
          currency,
          packs,
          months,
          extras,
          registered,
          subscription: currentSubscription(from.id),
          ...switching,
          stars: starsFor(promoTotal(plan, packs, "rub", now(), months, extras) - switching.credit),
        }),
      );
    },

    /** «➕ Доп. услуги»: storage, extra streamers and restream on top of the running plan. */
    async openAddons(chatId, messageId, from, requested, code, rawMonths) {
      const currency = currencyFor(from.id, requested);
      sessions.set(from.id, { currency });
      const subscription = addonBase(from.id);
      if (!subscription) return show(chatId, messageId, addonsNeedPlanScreen());
      const months = clampMonths(rawMonths);
      const extras = fitAddons(subscription, parseExtras(code), restreamSlotsLeft(from.id));
      const limits = addonLimits({ subscription, extras, slotsLeft: restreamSlotsLeft(from.id) });
      return show(chatId, messageId, addonsScreen({ currency, extras, months, subscription, limits, held: subscription }));
    },

    /** Pay for add-ons with Stars. */
    async checkoutAddons(chatId, messageId, from, code, rawMonths) {
      const subscription = addonBase(from.id);
      if (!subscription) return "Сначала оформите тариф";
      const months = clampMonths(rawMonths);
      const extras = parseExtras(code);
      if (!hasExtras(extras)) return "Выберите опции";
      if (!withinLimits(extras, addonLimits({ subscription, extras, slotsLeft: restreamSlotsLeft(from.id) }))) return NO_RESTREAM_SLOTS;
      const amount = addonsTotal(extras, months);
      const packs = extras.packs || 0;
      const draft = {
        user_id: from.id, kind: "addon", plan_id: ADDONS_ID, packs, quota_gb: packs * ADDON_STEP_GB, currency: "rub",
        months, ...orderFieldsOf(extras), credit: 0, amount,
      };
      const reused = orders.find((order) => order.user_id === from.id && order.kind === "addon" && sameExtras(order, extras)
        && (order.packs || 0) === packs
        && (order.months ?? 1) === months && order.method === "stars"
        && order.status === "pending"
        && now() - Date.parse(order.created_at) < REUSE_WINDOW_MS);
      const stars = starsFor(amount);
      if (stars > MAX_INVOICE_STARS) return tooManyStars(MAX_INVOICE_STARS);
      if (!reused && !limiter(from.id)) return TOO_MANY_ORDERS;
      const order = reused || orders.create({ ...draft, method: "stars", stars });
      await api("sendInvoice", {
        chat_id: chatId,
        title: "Fetchr · Доп. услуги",
        description: `Доступ на ${periodDays(months)} дней к доп. услугам Архива VPS.`,
        payload: `ord:${order.id}`,
        currency: "XTR",
        prices: [{ label: `Доп. услуги · ${fmtMonths(months)}`, amount: order.stars }],
      });
      return null;
    },

    /** Old cards carry the `pay:` callback: it now opens the Stars invoice. */
    async checkout(chatId, messageId, from, planId, requested, rawPacks, rawMonths, rawExtras) {
      return this.checkoutStars(chatId, messageId, from, planId, requested, rawPacks, rawMonths, rawExtras);
    },

    /** Free is switched on at once and never expires; the archive server
     *  picks it up on its next reconcile. Admins get a note, nothing to do. */
    async requestFree(chatId, messageId, from) {
      const plan = planById("free");
      if (licenses.devices(from.id).length === 0) return "Сначала пройдите регистрацию";
      const existing = orders.find((order) => order.user_id === from.id && order.method === "free");
      if (!existing && !limiter(from.id)) return TOO_MANY_ORDERS;
      const order = existing
        || orders.create({ ...baseOrder(chatId, from, plan, 0, "rub", 1), method: "free", status: "paid", paid_at: stamp() });
      if (!existing) await announce(order, from);
      await show(chatId, messageId, freeRequestedScreen({ order }));
      return existing ? "Free уже подключён" : null;
    },

    /** Opens a Stars invoice for the plan; the order settles in `onSuccessfulPayment`. */
    async checkoutStars(chatId, messageId, from, planId, requested, rawPacks, rawMonths, rawExtras) {
      const plan = planById(planId);
      if (!isOnSale(plan) || !canAddPacks(plan) || requested !== "rub") return "Тариф не найден";
      const packs = clampPacks(plan, rawPacks);
      const months = clampMonths(rawMonths);
      const extras = clampExtras(plan, parseExtras(rawExtras));
      if (restreamOutputs(extras) > restreamSlotsLeft(from.id)) return NO_RESTREAM_SLOTS;
      const switching = switchCredit(from.id, plan, packs, months, extras);
      if (switching.blocked) return longerTermNeeded(switching.daysLeft);
      const amount = promoTotal(plan, packs, "rub", now(), months, extras) - switchCredit(from.id, plan, packs, months, extras).credit;
      const stars = starsFor(amount);
      if (stars > MAX_INVOICE_STARS) return tooManyStars(MAX_INVOICE_STARS);
      const reused = recentOrder(from, plan, packs, "rub", "stars", months, extras);
      if (!reused && !limiter(from.id)) return TOO_MANY_ORDERS;
      const order = reused
        ? reused.stars === stars
          ? reused
          : orders.update(reused.id, { stars, amount, credit: promoTotal(plan, packs, "rub", now(), months, extras) - amount })
        : orders.create({ ...baseOrder(chatId, from, plan, packs, "rub", months, extras), method: "stars", stars });
      const fields = invoiceFields({ plan, packs, months, extras });
      await api("sendInvoice", {
        chat_id: chatId,
        title: fields.title,
        description: fields.description,
        payload: `ord:${order.id}`,
        currency: "XTR",
        prices: [{ label: fields.label, amount: order.stars }],
      });
      return null;
    },

    async onPreCheckout(query) {
      const order = orders.get(ORDER_PAYLOAD.exec(query.invoice_payload || "")?.[1]);
      const ok = Boolean(order && order.method === "stars" && order.status !== "paid" && order.stars === query.total_amount);
      await api("answerPreCheckoutQuery", {
        pre_checkout_query_id: query.id,
        ok,
        ...(ok ? {} : { error_message: "Заказ не найден или уже оплачен — откройте магазин заново." }),
      });
    },

    async onSuccessfulPayment(message) {
      const payment = message.successful_payment;
      const order = orders.get(ORDER_PAYLOAD.exec(payment.invoice_payload || "")?.[1]);
      if (!order) {
        await reportPaymentIssue(
          "⚠️ <b>Оплата без заказа</b>",
          "Найдите покупателя в поддержке: подключите тариф или верните оплату.",
          message.from,
          payment,
        );
        return;
      }
      if (order.status === "paid") {
        if (order.charge_id === payment.telegram_payment_charge_id) return;
        await reportPaymentIssue(
          `⚠️ <b>Повторная оплата заказа #${order.id}</b>`,
          "Тариф уже оплачен — верните эту оплату.",
          message.from,
          payment,
        );
        await send(message.chat.id, {
          text: `⚠️ Заказ <code>#${order.id}</code> уже был оплачен — вторую оплату вернём. Менеджер уже в курсе.`,
        });
        return;
      }
      await finalizePaid(
        order,
        { charge_id: payment.telegram_payment_charge_id, paid_total: payment.total_amount },
        message.from,
      );
    },

    /** Admin-only: return a Stars payment. */
    async refund(adminChatId, userId, chargeId) {
      try {
        await api("refundStarPayment", { user_id: userId, telegram_payment_charge_id: chargeId });
      } catch (err) {
        return send(adminChatId, { text: `⚠️ Возврат не выполнен: ${esc(errorText(err))}` });
      }
      const order = orders.find((item) => item.charge_id === chargeId);
      if (order) orders.update(order.id, { status: "refunded", refunded_at: stamp() });
      log.info(`Refunded ${chargeId} to ${userId}`);
      return send(adminChatId, { text: `↩️ Оплата возвращена${order ? ` · заказ <code>#${order.id}</code>` : ""}.` });
    },

    /** Orders whose notice never reached an admin, e.g. after a crash or 502. */
    async announcePending() {
      const pending = orders.all().filter((order) => ANNOUNCED_STATUSES.includes(order.status) && !order.announced_at);
      for (const order of pending) await announce(order);
      return pending.length;
    },

    /** Imports site orders, then matches ResultURL records to open Robokassa
     *  orders. Idempotent: a paid order is finalized once however many polls
     *  see it. A record whose sum is short of the order goes to the admins. */
    async pollPayments(onlyOrderId) {
      // Retry any paid-order notice that previously failed (e.g. Telegram 502).
      await this.announcePending();
      importSiteOrders();
      const open = orders
        .all()
        .filter((order) => order.method === "robokassa" && OPEN_ROBOKASSA.includes(order.status) && order.inv_id);
      if (open.length > 0) {
        const byInvId = new Map(robokassaPayments().map((payment) => [Number(payment.inv_id), payment]));
        for (const order of open) {
          const payment = byInvId.get(Number(order.inv_id));
          if (!payment || payment.order_id !== order.id) continue;
          if (Number(payment.out_sum) + 0.001 < order.amount) {
            orders.update(order.id, { status: "underpaid", paid_amount: Number(payment.out_sum) });
            await notifyAdmins(`⚠️ <b>Заказ #${order.id}</b> оплачен не полностью: ${esc(payment.out_sum)} ₽ из ${order.amount} ₽.`);
            continue;
          }
          await finalizePaid(order, { paid_amount: Number(payment.out_sum), paid_via: "robokassa" });
        }
      }
      // Tell admins about fresh unpaid site checkouts (orders already paid in
      // this same poll only emit the paid notice above).
      if (notifySiteCheckout) {
        const cutoff = now() - 24 * 3600_000;
        const freshSite = orders
          .all()
          .filter(
            (order) =>
              order.source === "site" &&
              order.status === "pending" &&
              !order.checkout_noticed_at &&
              Date.parse(order.created_at) >= cutoff,
          );
        for (const order of freshSite) {
          if ((await notifySiteCheckout(order, await buyerOf(order))) > 0) {
            orders.update(order.id, { checkout_noticed_at: stamp() });
          }
        }
      }
      return onlyOrderId ? orders.get(onlyOrderId)?.status ?? null : null;
    },
  };
}
