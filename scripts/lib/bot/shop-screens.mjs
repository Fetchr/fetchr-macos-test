/** Shop screens: catalog, plan card, checkout outcomes and the admin notices
 *  that come with each order.
 *
 * Path to payment: shop (plans 2×2) → plan card → «Оплатить». The card picks
 * the term with a segment (the same message is edited); «Оплатить» opens a
 * Telegram Stars invoice. Rubles (Robokassa) are sold only on the site. */

import {
  ADDON_PACK_PRICE,
  ADDON_STEP_GB,
  MAX_PACKS,
  SALE_PLANS,
  PROMO,
  TERMS,
  canAddPacks,
  discountFor,
  fmtMonths,
  fmtHours,
  fmtPrice,
  fmtQuota,
  hoursAt1080p,
  orderQuotaGb,
  orderTotal,
  periodDays,
  promoActive,
  promoTotal,
  NO_EXTRAS,
  RESTREAM_PRICE,
  hasExtras,
  starsFor,
} from "./catalog.mjs";
import { orderExtrasLines } from "./extras-screens.mjs";
import { named } from "./premium-emoji.mjs";
import { backBtn, btn, esc, keyboard, menuBtn, urlBtn, userCard } from "./ui.mjs";

export const OFFER_URL = "https://fetchr.fun/oferta/";
export const ARCHIVE_GUIDE_URL = "https://fetchr.fun/arhiv-vps/";

/** Plan icons from the premium pack in assets/bot-emoji/ids.json, so they
 *  are animated: a gift for Free, a disk for the small plan, «play» for
 *  Старт, the crown for Стример. */
const PLAN_ICONS = { free: "🎉", mini: "💾", start: "▶️", streamer: "👑", archive: "💾", max: "💾" };

export const planIcon = (plan) => PLAN_ICONS[plan.id] || "💾";

/** The Fetchr Line sign of a plan on sale (B «Ячейка»), or null for retired ones. */
const planSignName = (plan) => (["free", "mini", "start", "streamer"].includes(plan?.id) ? `plan-${plan.id}` : null);

/** The plan icon in text: the named Fetchr Line cell, plain emoji until its id is known. */
export const planSign = (plan) => (planSignName(plan) ? named(planSignName(plan), planIcon(plan)) : planIcon(plan));

function pairs(items) {
  return Array.from({ length: Math.ceil(items.length / 2) }, (_, row) => items.slice(row * 2, row * 2 + 2));
}

/** "<s>200 ₽</s> 120 ₽" while a discount applies, the plain price otherwise. */
function priceWithPromo(full, paid) {
  return paid < full ? `<s>${fmtPrice(full)}</s> ${fmtPrice(paid)}` : fmtPrice(full);
}

const fmtDate = (iso) => new Date(iso).toLocaleDateString("ru-RU", { timeZone: "Europe/Moscow" });

/** «Осталось N дн.» for the running plan, or nothing without one. */
export function subscriptionLines(subscription) {
  if (!subscription?.active) return [];
  return [`⏳ Ваш тариф: <b>${esc(subscription.plan)}</b> · ещё ${subscription.days_left} дн. (до ${fmtDate(subscription.paid_until)})`];
}

const channelsText = (count) => (count > 1 ? `${count} стримера` : "1 стример");

export function shopScreen({ currency, subscription = null }) {
  const plans = SALE_PLANS.map((plan) =>
    btn(
      `${planIcon(plan)} ${plan.name} · ${plan.price[currency] ? fmtPrice(promoTotal(plan, 0, currency)) : "0 ₽"}`,
      `plan:${plan.id}:${currency}:0:1`,
      plan.id === "streamer" ? "primary" : undefined,
      planSignName(plan),
    ),
  );
  const facts = SALE_PLANS.map((plan) =>
    `${planSign(plan)} ${plan.name} — ${fmtQuota(plan.quotaGb)}${plan.price[currency] ? `, ≈ ${fmtHours(hoursAt1080p(plan.quotaGb))} эфира` : " навсегда"}, ${channelsText(plan.channels)}`,
  );
  const top = TERMS.at(-1);
  return {
    media: "shop-1",
    art: { plan: subscription?.active ? subscription.plan : "" },
    text: [
      ...(promoActive() ? [`🔥 Акция ${PROMO.label}: скидки до <b>−${PROMO.maxPercent}%</b> до ${PROMO.untilLabel}`] : []),
      ...subscriptionLines(subscription),
      "💾 <b>Архив VPS</b> — сервер пишет эфир с чатом, даже когда ПК выключен.",
      "✅ Копия останется, если VOD удалят.",
      `<blockquote expandable>📄 <b>Что входит</b>\n${facts.join("\n")}</blockquote>`,
      `🗓 <i>Цены за 30 дней, в рублях. За ${top.months} мес — −${top.percent}%.</i>`,
    ].join("\n"),
    markup: keyboard([
      ...pairs(plans),
      [btn("➕ Память, стримеры, рестрим", `ad:${currency}`)],
      [backBtn("home")],
    ]),
  };
}

function discountLine(discount) {
  if (!discount) return [];
  if (discount.kind === "promo") return [`🔥 Акция ${PROMO.label}: −${discount.percent}%`];
  return [];
}

/** What the plan card's picture shows: the receipt the buyer reads before paying. */
export function planArt({ plan, packs = 0, months = 1, total = null, full = null }) {
  const paid = canAddPacks(plan);
  const quota = orderQuotaGb(plan, packs);
  const perMonth = paid && total != null && total > 0 ? fmtPrice(Math.round(total / months)) : "";
  const saved = full != null && total != null && full > total ? full - total : 0;
  return {
    id: plan.id,
    plan: plan.name,
    quota: fmtQuota(quota).replace(" ", " "),
    hours: `≈ ${fmtHours(hoursAt1080p(quota)).replace(" ", " ")}`,
    channels: String(plan.channels),
    months: paid ? fmtMonths(months) : "бессрочно",
    price: paid ? fmtPrice(total ?? 0).replace(/ /g, " ") : "0 ₽",
    full: saved ? fmtPrice(full).replace(/ /g, " ") : "",
    perMonth: perMonth.replace(/ /g, " "),
    note: saved ? `−${Math.round((saved / full) * 100)}% · экономия ${fmtPrice(saved).replace(/ /g, " ")}` : "",
  };
}

/** The payment line under a plan card: terms of the deal in one place. */
const PAY_NOTE = [
  `⭐ <i>Оплата Telegram Stars · без автопродления · <a href="${OFFER_URL}">оферта</a></i>`,
  "💳 <i>Удобнее рублями? Тот же тариф — на <a href=\"https://fetchr.fun/arhiv-vps/\">fetchr.fun/arhiv-vps</a>.</i>",
].join("\n");

/** The plan card. `stars`: the invoice sum «Оплатить» shows. */
export function planScreen({
  plan,
  currency,
  packs,
  months = 1,
  registered,
  credit = 0,
  daysLeft = 0,
  blocked = false,
  subscription = null,
  stars = null,
}) {
  const paid = canAddPacks(plan);
  const full = orderTotal(plan, packs, currency, months);
  const discounted = promoTotal(plan, packs, currency, Date.now(), months);
  const total = discounted - credit;
  const at = (nextPacks, nextMonths = months) => `plan:${plan.id}:${currency}:${nextPacks}:${nextMonths}`;
  const quota = orderQuotaGb(plan, packs);
  const termHint = TERMS.filter((term) => term.percent > 0).map((term) => `${term.months} мес −${term.percent}%`).join(" · ");

  const text = [
    `${planSign(plan)} <b>${plan.name}</b> · ${fmtQuota(quota)} · ≈ ${fmtHours(hoursAt1080p(quota))} эфира · ${channelsText(plan.channels)}`,
    ...subscriptionLines(subscription),
    "",
    ...(paid
      ? [
          `🗓 Срок: <b>${fmtMonths(months)} — ${priceWithPromo(full, total)}</b>`,
          months > 1
            ? `💸 <i>${fmtPrice(Math.round(total / months))}/мес${full > discounted ? ` · экономия ${fmtPrice(full - discounted)}` : ""}.</i>`
            : `🔥 <i>${termHint}.</i>`,
          ...(discounted < full ? discountLine(discountFor(plan, months)) : []),
          ...(credit > 0 ? [`🔄 Зачтено ${fmtPrice(credit)} за ${daysLeft} дн. текущей подписки`] : []),
          ...(blocked ? [`⚠️ Оплачено ещё ${daysLeft} дн. — для смены тарифа выберите срок длиннее`] : []),
          "",
          PAY_NOTE,
        ]
      : [registered ? "🎉 Бесплатно для пользователей Fetchr." : "🔑 Бесплатно — нужна только регистрация."]),
  ].join("\n");

  let actions;
  if (paid) {
    const label = `⭐ Оплатить ${stars ?? starsFor(total)} Stars`;
    actions = [[btn(label, `star:${plan.id}:${currency}:${packs}:${months}`, "success")]];
  } else if (registered) actions = [[btn("✅ Подключить бесплатно", "free", "success")]];
  else actions = [[btn("🔑 Пройти регистрацию", "reg", "primary")]];

  return {
    media: "shop-3",
    art: planArt({ plan, packs, months, total, full }),
    text,
    markup: keyboard([
      paid ? TERMS.map((term) => btn(term.months === months ? `✅ ${term.months} мес` : `🗓 ${term.months} мес`, at(packs, term.months))) : null,
      paid
        ? packs > 0
          ? [
              btn(`➖ ${ADDON_STEP_GB} ГБ`, at(packs - 1)),
              btn(`💾 +${fmtQuota(packs * ADDON_STEP_GB)}`, "noop", undefined, "memory"),
              btn(`➕ ${ADDON_STEP_GB} ГБ`, packs < MAX_PACKS ? at(packs + 1) : "noop:max"),
            ]
          : [btn(`💾 +${ADDON_STEP_GB} ГБ · ${fmtPrice(ADDON_PACK_PRICE[currency])}/мес`, at(1), undefined, "memory")]
        : null,
      ...actions,
      [backBtn(`shop:${currency}`, "Тарифы"), btn("📄 Условия", `terms:${at(packs)}`)],
    ]),
  };
}

/** First line of an order summary: the plan with its storage, or the add-ons product. */
const productLine = (order, plan) =>
  order.kind === "addon" ? "Товар — <b>Доп. услуги</b>" : `Тариф — <b>${plan.name}</b> · ${fmtQuota(order.quota_gb)}`;

const orderTerm = (order) => (order.method === "free" ? "бессрочно" : fmtMonths(order.months ?? 1));

function orderFacts(order, plan) {
  return [
    `<blockquote>💾 ${productLine(order, plan)}`,
    `🗓 Срок — ${orderTerm(order)}`,
    ...orderExtrasLines(order).map((line) => `➕ ${line}`),
    ...(order.credit > 0 ? [`🔄 Зачёт остатка — −${fmtPrice(order.credit)}`] : []),
    `💳 Сумма — <b>${fmtPrice(order.amount)}</b></blockquote>`,
  ];
}

const productName = (order, plan) => (order.kind === "addon" ? "Доп. услуги" : plan?.name || "Тариф");

/** The new message that confirms a payment, with the next step and one upsell. */
export function paidScreen({ order, plan }) {
  const addon = order.kind === "addon";
  const restream = Boolean(order.restream_streamers);
  const receipt = [
    `💳 Заказ <code>#${order.id}</code> · ${fmtPrice(order.amount)}`,
    ...(addon ? [] : [`💾 ${productLine(order, plan)}`]),
    ...orderExtrasLines(order).map((line) => `➕ ${line}`),
    ...(order.method === "robokassa" ? ["📄 Чек — на e-mail из Robokassa"] : []),
    ...(order.method === "stars" && order.stars ? [`⭐ Оплачено ${order.stars} Stars`] : []),
  ];
  return {
    media: "shop-done",
    // No order id on the picture: one animated cover per plan and term.
    art: { plan: productName(order, plan), months: orderTerm(order) },
    text: [
      `🎉 <b>Оплачено.</b> ${productName(order, plan)} на ${orderTerm(order)}`,
      `<blockquote>${receipt.join("\n")}</blockquote>`,
      addon
        ? "✅ Доп. услуги подключены автоматически — уже работают."
        : "▶️ Откройте в Fetchr <b>Архив VPS</b> → «Добавить стримера» — запись начнётся с ближайшего эфира.",
      ...(restream ? ["", "📡 Рестрим: выберите стримера и добавьте площадки в разделе «Рестрим»."] : []),
    ].join("\n"),
    markup: keyboard([
      restream
        ? [btn("📡 Настроить рестрим", "rs", "primary")]
        : [urlBtn("▶️ Как начать запись", ARCHIVE_GUIDE_URL, "primary")],
      !addon && !restream ? [btn(`📡 Рестрим · +${fmtPrice(RESTREAM_PRICE.rub)}/мес`, "ad:rub:c0r1e0:1")] : null,
      [btn("💬 Поддержка", "sup"), menuBtn()],
    ]),
  };
}

/** The plan card a payment came from, edited once the order is paid: no buttons left. */
export function paidCardScreen({ order, plan }) {
  const card = plan && order.kind !== "addon" ? planArt({ plan, packs: order.packs || 0, months: order.months ?? 1, total: order.amount }) : null;
  return {
    media: card ? "shop-3" : "shop-done",
    art: card || { plan: productName(order, plan), months: orderTerm(order) },
    text: [
      `${plan && order.kind !== "addon" ? `${planSign(plan)} ` : ""}<b>${productName(order, plan)}</b> · ${orderTerm(order)} · ${fmtPrice(order.amount)}`,
      `✅ Заказ <code>#${order.id}</code> оплачен`,
    ].join("\n"),
    markup: { inline_keyboard: [] },
  };
}

export function freeRequestedScreen({ order }) {
  return {
    media: "shop-free",
    text: [
      `🎉 <b>Free подключён</b> · ${fmtQuota(order.quota_gb)} бессрочно`,
      "",
      "⏳ Архив будет готов через пару минут: откройте в Fetchr раздел «Архив VPS» и выберите стримера — сервер начнёт писать его эфиры, даже когда компьютер выключен.",
      "",
      "👑 Нужно больше места или несколько стримеров сразу — возьмите тариф побольше.",
    ].join("\n"),
    markup: keyboard([[btn("💾 Тарифы", "shop:rub", "primary")], [menuBtn()]]),
  };
}


const METHOD_LABELS = {
  robokassa: "Robokassa",
  rub_manual: "рубли, вручную",
  free: "бесплатно",
  stars: "Telegram Stars",
  crypto: "Crypto Pay",
  crypto_manual: "крипта, вручную",
};

/** Tap-to-copy command an admin sends back to the bot to refund Stars. */
function refundCommand(userId, chargeId) {
  return `<code>/refund ${Number(userId) || 0} ${esc(chargeId)}</code>`;
}

export function adminPaymentIssueText({ title, hint, user, payment }) {
  return [
    title,
    `От: ${userCard(user)}`,
    "",
    `<blockquote>Сумма — ${esc(payment.total_amount)} ${esc(payment.currency)}`,
    `Возврат — ${refundCommand(user?.id, payment.telegram_payment_charge_id)}</blockquote>`,
    "",
    `<i>${esc(hint)}</i>`,
  ].join("\n");
}

function adminOrderFacts(order, plan) {
  const packs = order.packs ? ` + ${fmtQuota(order.packs * ADDON_STEP_GB)}` : "";
  const sourceSuffix = order.source === "site" ? " (сайт)" : "";
  return [
    order.kind === "addon" ? "Товар — Доп. услуги" : `Тариф — ${plan.name}${packs} = ${fmtQuota(order.quota_gb)}`,
    `Срок — ${orderTerm(order)}`,
    ...orderExtrasLines(order),
    ...(order.credit > 0 ? [`Зачёт остатка — −${fmtPrice(order.credit)} (старый период закрыт)`] : []),
    `Сумма — ${fmtPrice(order.amount)} · ${METHOD_LABELS[order.method] || esc(order.method)}${sourceSuffix}`,
    ...(order.charge_id ? [`Возврат — ${refundCommand(order.user_id, order.charge_id)}`] : []),
    ...(order.paid_asset ? [`Оплачено — ${esc(order.paid_amount)} ${esc(order.paid_asset)}`] : []),
  ];
}

export function adminOrderText({ order, plan, user }) {
  const origin = order.source === "site" ? " · 🌐 Сайт" : order.method === "stars" ? " · ⭐ Бот" : "";
  const titles = {
    paid: `💰 <b>Оплачен заказ #${order.id}</b>${origin}`,
    manual: `🧾 <b>Заявка #${order.id}</b> · нужны реквизиты`,
    free: `🌱 <b>Подключён Free #${order.id}</b> · автоматически`,
  };
  const kind = order.method === "free" ? "free" : order.status === "paid" ? "paid" : "manual";
  const facts = adminOrderFacts(order, plan);
  return [
    titles[kind],
    `От: ${userCard(user)}`,
    "",
    `<blockquote>${facts.join("\n")}</blockquote>`,
    "",
    kind === "manual"
      ? "<i>Ответьте реквизитами на это сообщение (reply) — они уйдут покупателю.</i>"
      : kind === "free"
        ? "<i>Ничего делать не нужно: архив создастся сам. Ответ на это сообщение (reply) уйдёт пользователю.</i>"
        : "<i>Архив активируется автоматически. Ответ на это сообщение (reply) уйдёт покупателю.</i>",
  ].join("\n");
}

/** Notice when a buyer starts a Robokassa checkout on the site (still unpaid). */
export function adminSiteCheckoutText({ order, plan, user }) {
  return [
    `🛒 <b>Новый заказ с сайта #${order.id}</b> · ждёт оплату`,
    `От: ${userCard(user)}`,
    "",
    `<blockquote>${adminOrderFacts(order, plan).join("\n")}</blockquote>`,
    "",
    "<i>Как только Робокасса подтвердит оплату, придёт отдельное уведомление.</i>",
  ].join("\n");
}

/** Title, description and line label for a Telegram invoice. */
export function invoiceFields({ plan, packs, months = 1, extras = NO_EXTRAS }) {
  const quota = orderQuotaGb(plan, packs);
  const count = plan.channels + extras.channels;
  const channels = (count > 1 ? `до ${count} стримеров одновременно` : "один стример")
    + (extras.restream ? `, рестрим на ${extras.restream + extras.restreamExtra} площ.` : "");
  return {
    title: `Fetchr · ${plan.name}`,
    description: `${fmtQuota(quota).replace("\u00a0", " ")} в Архиве VPS на ${periodDays(months)} дней, ${channels}. Записи скачиваются в Fetchr.`,
    label: `${packs ? `${plan.name} + ${packs * ADDON_STEP_GB} ГБ` : plan.name}${hasExtras(extras) ? " + опции" : ""}${months > 1 ? ` · ${months} мес` : ""}`,
  };
}
