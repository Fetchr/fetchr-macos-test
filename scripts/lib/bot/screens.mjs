/** Every non-shop screen: text in HTML parse mode plus its inline keyboard.
 *  Pure functions of a view model, so they are tested without Telegram.
 *
 * `media` names the cover shown above the text (covers.mjs). The cover
 * already carries the section title, so a screen opens with its content, not
 * with a heading that repeats the picture. Text must stay under Telegram's
 * 1024-character caption limit. Buttons: one coloured main action, the rest
 * two to a row, and the same «← Назад» / «🏠 Меню» everywhere. */

import { PROMO, promoActive } from "./catalog.mjs";
import { backBtn, btn, copyBtn, esc, fmtDate, keyboard, maskMachineId, menuBtn, plural, urlBtn, userCard } from "./ui.mjs";

export const CONSENT_URL = "https://fetchr.fun/soglasie/";
const OFFER_URL = "https://fetchr.fun/oferta/";
const PRIVACY_URL = "https://fetchr.fun/privacy/";

/** The consent wording, synchronized with https://fetchr.fun/soglasie/ (152-ФЗ ст. 9). */
export const CONSENT_TEXT = [
  "Для выдачи ключа бот сохранит ваш Telegram ID и Machine ID компьютера. Отчёты об ошибках и логи задач приложение отправляет только если вы сами включите их в настройках.",
  "",
  `<i>Отдельное <a href="${CONSENT_URL}">согласие на обработку ПДн</a> · <a href="${PRIVACY_URL}">политика конфиденциальности</a>. Отозвать можно в любой момент через поддержку или fetchr@mail.ru.</i>`,
];

/** `notice` is trusted HTML written by the bot, never user text. */
function withNotice(notice, lines) {
  return [...(notice ? [notice, ""] : []), ...lines].join("\n");
}

/** Buttons two to a row. */
function pairs(buttons) {
  const list = buttons.filter(Boolean);
  return Array.from({ length: Math.ceil(list.length / 2) }, (_, row) => list.slice(row * 2, row * 2 + 2));
}

const fmtDay = (iso) => new Date(iso).toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit", timeZone: "Europe/Moscow" });

/** The lines under the home cover. The cover is the same for everyone in a
 *  state (an animated MP4); the name, Machine ID and plan are here. Every
 *  line opens with an emoji the premium pack animates. */
function homeLines({ name, deviceCount, machineId, shop, promo, paid, subscription, monthlyUsers }) {
  const people = monthlyUsers ? [`👥 <i>${monthlyUsers} ${plural(monthlyUsers, ["пользователь", "пользователя", "пользователей"])} за месяц</i>`] : [];
  if (!deviceCount) {
    return [
      ...(name ? [`👤 Привет, <b>${esc(name)}</b>!`] : []),
      "🔥 <b>Fetchr</b> готовит исходник к монтажу:",
      "✅ глушит мат и блюрит рекламу",
      "✅ голос и музыка — отдельно, чат — слоем",
      "",
      "🔑 Ключ — <b>бесплатно</b>, выдаём здесь за минуту.",
      ...people,
    ];
  }
  const lines = [
    `👤 <b>${name ? esc(name) : "Привет"}</b>, всё работает`,
    `🔑 Ключ активен${machineId ? ` · <code>${esc(machineId)}</code>` : ""}`,
  ];
  if (paid) {
    lines.push(`💾 <b>${esc(subscription.plan)}</b> · ещё ${subscription.days_left} дн.${subscription.paid_until ? ` · до ${fmtDay(subscription.paid_until)}` : ""}`);
  } else if (subscription?.active) {
    lines.push("💾 <b>Free</b> · 5 ГБ в Архиве VPS, бесплатно навсегда");
  } else if (shop) {
    lines.push("💾 <b>Архив VPS</b> пишет эфиры с чатом, пока ПК выключен — <b>5 ГБ бесплатно</b>");
  }
  if (promo) lines.push(`🔥 <b>${PROMO.label}: −${PROMO.maxPercent}%</b> на тарифы до ${PROMO.untilLabel}`);
  return [...lines, ...(people.length ? ["", ...people] : [])];
}

/** The one coloured button: what this user most likely wants next. */
function homeMain({ deviceCount, shop, promo, paid }) {
  if (!deviceCount) return btn("🔑 Получить ключ", "reg", "primary");
  if (!shop) return btn("💬 Поддержка", "sup", "primary");
  if (promo) return btn(paid ? `🔥 Продлить −${PROMO.maxPercent}%` : `🔥 Архив VPS −${PROMO.maxPercent}%`, "shop", "success");
  return btn(paid ? "💾 Архив VPS" : "💾 Архив VPS · 5 ГБ бесплатно", "shop", "primary");
}

/** Which home cover this user sees: nothing personal, so it can be a shared animation. */
function homeState({ deviceCount, paid, subscription }) {
  if (!deviceCount) return "new";
  if (paid) return "paid";
  return subscription?.active ? "free" : "key";
}

export function homeScreen({
  user,
  deviceCount = 0,
  machineId = "",
  subscription = null,
  monthlyUsers = 0,
  channelUrl = "",
  notice = "",
  shop = false,
}) {
  const promo = shop && promoActive();
  const paid = Boolean(subscription?.active && !subscription.free);
  const masked = machineId ? maskMachineId(machineId) : "";
  const name = user?.first_name || user?.username || "";
  const state = { name, deviceCount, machineId: masked, shop, promo, paid, subscription: shop ? subscription : null, monthlyUsers };
  const main = homeMain(state);
  const rest = [
    deviceCount ? btn("🔑 Мой ключ", "reg") : null,
    shop ? btn("💾 Архив VPS", "shop") : null,
    shop ? btn("📡 Рестрим", "rs") : null,
    btn("💬 Поддержка", "sup"),
    channelUrl ? urlBtn("📢 Канал", channelUrl) : null,
  ].filter((button) => button && button.callback_data !== main.callback_data);
  return {
    media: "home",
    art: {
      state: homeState(state),
      shop,
      promo: promo ? { percent: PROMO.maxPercent, until: PROMO.untilLabel } : null,
    },
    text: withNotice(notice, homeLines(state)),
    markup: keyboard([[main], ...pairs(rest)]),
  };
}

/** Five rows at most: the caption under a cover is capped at 1024 characters. */
function deviceLines(devices) {
  return [
    ...devices.slice(0, 5).map((device) => `🔑 <code>${esc(maskMachineId(device.machineId))}</code> · с ${fmtDate(device.issuedAt)}`),
    ...(devices.length > 5 ? [`➕ …и ещё ${devices.length - 5}`] : []),
  ];
}

const deviceButtons = (devices) =>
  devices.slice(0, 5).map((device) => [btn(`🔑 Ключ ${maskMachineId(device.machineId)}`, `reg:key:${device.machineId}`)]);

/**
 * Two steps. Step 1 — subscribe to the channel and agree to the data
 * processing; one button does both («Согласен, проверить подписку»). With
 * both done, step 2 asks for the Machine ID. `consented` false shows the
 * consent wording (CONSENT_TEXT, word for word) on step 1.
 */
export function registrationScreen({
  channel = "",
  channelUrl = "",
  subscribed,
  consented = true,
  devices = [],
  pendingMachineId = "",
  notice = "",
}) {
  const needsChannel = Boolean(channel) && subscribed !== true;
  const list = deviceLines(devices);
  const pending = pendingMachineId
    ? [`⏳ Machine ID <code>${esc(maskMachineId(pendingMachineId))}</code> получен — ключ выдадим сразу после этого шага.`]
    : [];

  if (needsChannel || !consented) {
    const lead = needsChannel
      ? [`📢 <b>Шаг 1 из 2.</b> Подпишитесь на ${esc(channel)} — анонсы и новые функции там.`]
      : ["🔒 <b>Шаг 1 из 2.</b> Согласие на обработку данных."];
    const main = !consented
      ? btn("✅ Даю согласие", "cons:ok", "primary")
      : btn("🔄 Проверить подписку", "reg:check", "primary");
    return {
      media: "register-1",
      art: { channel: needsChannel ? channel : "" },
      text: withNotice(notice, [
        ...lead,
        ...(needsChannel && subscribed === null ? ["⚠️ Не удалось проверить подписку — попробуйте ещё раз через минуту."] : []),
        ...(consented ? [] : ["", `🔒 ${CONSENT_TEXT[0]}`, ...CONSENT_TEXT.slice(1)]),
        ...(pending.length ? ["", ...pending] : []),
        ...(list.length ? ["", "🔑 <b>Ваши устройства</b>", ...list] : []),
      ]),
      markup: keyboard([
        needsChannel && channelUrl ? [urlBtn("📢 Подписаться на канал", channelUrl)] : null,
        [main],
        ...deviceButtons(devices),
        [backBtn("home")],
      ]),
    };
  }

  return {
    media: "register-2",
    text: withNotice(notice, [
      ...(devices.length ? ["🔑 <b>Ваши устройства</b> — нажмите, чтобы показать ключ.", ...list, ""] : []),
      `✍️ ${devices.length ? "Новый компьютер?" : "<b>Шаг 2 из 2.</b>"} Пришлите <b>Machine ID</b> одним сообщением.`,
      "",
      "📄 Fetchr → Настройки → Лицензия и beta → «Скопировать».",
      "<blockquote>▶️ Быстрее: «Активировать через Telegram» в приложении — ключ придёт сам.</blockquote>",
    ]),
    markup: keyboard([...deviceButtons(devices), [backBtn("home")]]),
  };
}

/** The key with a copy button (Bot API 7.11 copy_text). A key longer than
 *  Telegram's 256-character copy limit keeps only the tap-to-copy <pre>. */
export function keyScreen({ machineId, licenseKey, channel = "", fresh, shop = false }) {
  const copy = copyBtn("🔑 Скопировать ключ", licenseKey, "primary", "copy");
  return {
    media: "register-3",
    art: { fresh: Boolean(fresh) },
    text: [
      `${fresh ? "✅ <b>Устройство зарегистрировано</b>" : "🔑 <b>Ваш ключ</b>"} · <code>${esc(maskMachineId(machineId))}</code>`,
      `<pre>${esc(licenseKey)}</pre>`,
      copy ? "▶️ Fetchr → Активация → вставьте ключ." : "▶️ Нажмите на ключ, чтобы скопировать, и вставьте его: Fetchr → Активация.",
      ...(channel
        ? [`<blockquote expandable>🔒 Ключ работает, пока вы подписаны на ${esc(channel)}. Новый компьютер — сбросьте старый в личном кабинете.</blockquote>`]
        : []),
    ].join("\n"),
    markup: keyboard([copy ? [copy] : null, [...(shop ? [btn("💾 Архив VPS", "shop")] : []), menuBtn()]]),
  };
}

/** One device per account: a second Machine ID waits for a reset on the site. */
export function deviceLimitScreen({ current, requested, accountUrl }) {
  return {
    media: "register-limit",
    text: [
      "🔒 <b>Доступно одно устройство</b>",
      "",
      `🔑 Ключ уже выдан устройству <code>${esc(maskMachineId(current))}</code>.`,
      `➕ Новое: <code>${esc(maskMachineId(requested))}</code>`,
      "",
      "🔄 Сбросьте текущее устройство в личном кабинете — и отправьте Machine ID ещё раз. Ключ старого устройства перестанет работать.",
    ].join("\n"),
    markup: keyboard([[urlBtn("👤 Личный кабинет", accountUrl, "primary")], [backBtn("reg"), menuBtn()]]),
  };
}

export function invalidMachineIdScreen({ reason }) {
  return {
    media: "register-bad",
    text: [`⚠️ ${esc(reason)}`, "", "📄 Скопируйте его заново: Fetchr → Настройки → Лицензия и beta."].join("\n"),
    markup: keyboard([[backBtn("reg"), menuBtn()]]),
  };
}

export function supportScreen({ payment = false, shop = false } = {}) {
  const body = payment
    ? [
        "💸 <b>Вопрос по оплате</b>",
        "",
        "💳 Укажите номер заказа и что пошло не так — разберёмся и, если нужно, вернём оплату.",
        "",
        "<blockquote>📄 Номер заказа есть в сообщении об оплате: <code>#XXXXXX</code>.</blockquote>",
      ]
    : [
        "💬 Опишите проблему одним сообщением — можно приложить скриншот или файл лога. Ответ придёт сюда же.",
        "",
        "<blockquote>⏳ Ускорит ответ: версия Fetchr, что делали и что пошло не так.</blockquote>",
      ];
  return {
    media: payment ? "support-pay" : "support",
    text: body.join("\n"),
    markup: keyboard([
      [btn("✍️ Написать", payment ? "sup:write:pay" : "sup:write", "primary")],
      !payment && shop ? [btn("💸 Проблема с оплатой", "sup:pay")] : null,
      [backBtn("home")],
    ]),
  };
}

export function supportPromptScreen() {
  return {
    media: "support-write",
    text: ["✍️ <b>Жду ваше сообщение</b>", "", "💬 Напишите одним сообщением — текст, скриншот или файл."].join("\n"),
    markup: keyboard([[btn("✖️ Отмена", "sup:cancel")]]),
  };
}

export function supportSentScreen({ ticketId }) {
  return {
    media: "support-sent",
    art: { id: String(ticketId) },
    text: [
      `✅ <b>Обращение #${ticketId} отправлено</b>`,
      "",
      "💬 Ответ придёт сюда же. Чтобы дополнить обращение, нажмите «Дополнить» или ответьте на это сообщение.",
    ].join("\n"),
    markup: keyboard([[btn("✍️ Дополнить", `sup:reply:${ticketId}`), menuBtn()]]),
  };
}

function ticketLabel(ticket) {
  return ticket.order_id ? `заказ #${esc(ticket.order_id)}` : `обращение #${ticket.id}`;
}

export function supportAnswerText({ ticket, text }) {
  const header = `💬 <b>Поддержка Fetchr</b> · ${ticketLabel(ticket)}`;
  return text ? `${header}\n\n${esc(text)}` : header;
}

export function supportAnswerMarkup(ticketId) {
  return keyboard([[btn("✍️ Ответить", `sup:reply:${ticketId}`)]]);
}

function adminTicketTitle(ticket) {
  if (ticket.order_id) return `🧾 <b>Заказ #${esc(ticket.order_id)}</b>`;
  if (ticket.kind === "payment") return `💸 <b>Оплата · обращение #${ticket.id}</b>`;
  return `🆘 <b>Обращение #${ticket.id}</b>`;
}

export function adminTicketHeader({ ticket, user, deviceCount = 0, orderCount = 0, followUp = false }) {
  const title = adminTicketTitle(ticket);
  return [
    followUp ? `${title} · дополнение` : title,
    `От: ${userCard(user)}`,
    `Устройств: ${deviceCount} · Оплаченных заказов: ${orderCount}`,
    "",
    "<i>Ответьте на это сообщение (reply) — ответ уйдёт пользователю.</i>",
  ].join("\n");
}


export function termsScreen({ backTo = "home" } = {}) {
  return {
    media: "terms",
    text: [
      `📄 Тарифы Архива VPS продаются по <a href="${OFFER_URL}">публичной оферте</a>. Коротко:`,
      "",
      "🗓 Платный тариф действует 30 дней с момента оплаты (или выбранный срок); Free — без срока.",
      "⭐ Оплата в боте — Telegram Stars. Рублями (карта, СБП) — на <a href=\"https://fetchr.fun/arhiv-vps/\">fetchr.fun/arhiv-vps</a>, чек на e-mail.",
      "✅ Доступ подключается автоматически сразу после оплаты — бот напишет в этот чат.",
      "💸 От тарифа можно отказаться в любой момент: вернём деньги за неиспользованные дни.",
      "💬 Вопросы по платежам — /paysupport.",
      "",
      `🔒 Данные обрабатываются по <a href="${PRIVACY_URL}">политике конфиденциальности</a>.`,
    ].join("\n"),
    markup: keyboard([[urlBtn("📄 Оферта", OFFER_URL)], [backBtn(backTo)]]),
  };
}

export function deniedText() {
  return "⛔️ <b>Доступ закрыт</b>\n\nЗакрытая beta-версия пока не открыта для этого Telegram-аккаунта.";
}
