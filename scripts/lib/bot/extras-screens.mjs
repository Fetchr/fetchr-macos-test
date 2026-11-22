/** «➕ Доп. услуги» — storage, extra streamers and restream as their own product, bought
 *  on top of a running paid plan for their own term. */

import {
  ADDON_PACK_PRICE,
  ADDON_STEP_GB,
  EXTRA_CHANNEL_PRICE,
  MAX_PACKS,
  MAX_EXTRA_CHANNELS,
  NO_EXTRAS,
  RESTREAM_EXTRA_PRICE,
  RESTREAM_PRICE,
  TERMS,
  addonsListTotal,
  addonsTotal,
  extrasCode,
  fmtMonths,
  fmtPrice,
  fmtQuota,
  hasExtras,
  restreamOutputs,
  starsFor,
} from "./catalog.mjs";
import { named } from "./premium-emoji.mjs";
import { backBtn, btn, esc, keyboard } from "./ui.mjs";

const plural = (n, [one, few, many]) => {
  const tens = n % 100;
  const units = n % 10;
  if (tens > 10 && tens < 20) return many;
  if (units === 1) return one;
  return units > 1 && units < 5 ? few : many;
};

/** Lines for an order's summary (admin notice, receipt, invoice screen). */
export function orderExtrasLines(order) {
  const lines = [];
  if (order?.kind === "addon" && order.packs) lines.push(`Память — +${fmtQuota(order.packs * ADDON_STEP_GB)}`);
  if (order?.extra_channels) lines.push(`Доп. стримеры — +${order.extra_channels}`);
  if (order?.restream_streamers) {
    lines.push(`Рестрим — ${order.restream_streamers} стрим., площадок ${order.restream_streamers + (order.restream_extra || 0)}`);
  }
  return lines;
}

/** Kept for older plan cards that still carry add-ons in the order. */
export function extrasFacts(extras = NO_EXTRAS) {
  return orderExtrasLines({ extra_channels: extras.channels, restream_streamers: extras.restream, restream_extra: extras.restreamExtra });
}

function heldLine(held) {
  const parts = [];
  if (held.addon_packs) parts.push(`+${fmtQuota(held.addon_packs * ADDON_STEP_GB)} памяти`);
  if (held.extra_channels) parts.push(`+${held.extra_channels} ${plural(held.extra_channels, ["стример", "стримера", "стримеров"])}`);
  if (held.restream_streamers) {
    const outputs = held.restream_streamers + (held.restream_extra || 0);
    parts.push(`рестрим на ${outputs} ${plural(outputs, ["площадку", "площадки", "площадок"])}`);
  }
  return parts.length ? [`✅ Уже подключено: ${parts.join(", ")}`] : [];
}

export function addonsNeedPlanScreen() {
  return {
    media: "shop-addons",
    text: [
      "➕ <b>Доп. услуги</b>",
      "",
      "Память, стримеры и рестрим работают поверх платного тарифа. Сначала оформите тариф — потом добавьте сюда.",
    ].join("\n"),
    markup: keyboard([[btn("💾 Выбрать тариф", "shop:rub", "primary")], [backBtn("home")]]),
  };
}

/**
 * `limits` — the most this buyer may add now: { channels, restream, restreamExtra }.
 * `held` — add-ons already running (from the subscription).
 */
/** «Оплатить» opens a Telegram Stars invoice for the chosen add-ons. */
export function addonsScreen({ currency, extras, months, subscription, limits, held }) {
  const at = (next, nextMonths = months) => {
    const code = extrasCode(next);
    return `ad:${currency}:${code || "-"}:${nextMonths}`;
  };
  const change = (patch) => at({ ...extras, ...patch });
  const counter = (icon, label, value, max, key) => [
    btn("➖", value > 0 ? change({ [key]: value - 1 }) : "noop"),
    btn(`${icon} ${label}: ${value}`, "noop"),
    btn("➕", value < max ? change({ [key]: value + 1 }) : (max === 0 && key.startsWith("restream") ? "noop:slots" : "noop:optmax")),
  ];
  const chosen = hasExtras(extras);
  const total = addonsTotal(extras, months, currency);
  const full = addonsListTotal(extras, months, currency);
  const code = extrasCode(extras);

  return {
    media: "shop-addons",
    text: [
      `➕ <b>Доп. услуги</b> к тарифу «${esc(subscription.plan)}»`,
      ...heldLine(held),
      "",
      `${named("memory")} <b>Память</b> — +${ADDON_STEP_GB} ГБ к архиву · ${fmtPrice(ADDON_PACK_PRICE[currency])}`,
      `👤 <b>Стример</b> — пишет ещё один канал · ${fmtPrice(EXTRA_CHANNEL_PRICE[currency])}`,
      `📡 <b>Рестрим</b> — эфир на YouTube, VK, Kick… · ${fmtPrice(RESTREAM_PRICE[currency])}`,
      `➕ <b>Площадка</b> — ещё одна к рестриму · ${fmtPrice(RESTREAM_EXTRA_PRICE[currency])}`,
      "<i>Цены за месяц. Рестрим — только своего канала, качество как на Twitch.</i>",
      "💳 <i>Рублями — на <a href=\"https://fetchr.fun/arhiv-vps/\">fetchr.fun/arhiv-vps</a>.</i>",
      ...(chosen
        ? ["", `🗓 ${fmtMonths(months)} — ${total < full ? `<s>${fmtPrice(full)}</s> ` : ""}<b>${fmtPrice(total)}</b>`]
        : []),
    ].join("\n"),
    markup: keyboard([
      [
        btn(`➖ ${ADDON_STEP_GB} ГБ`, extras.packs > 0 ? change({ packs: extras.packs - 1 }) : "noop"),
        btn(extras.packs ? `💾 +${fmtQuota(extras.packs * ADDON_STEP_GB)}` : "💾 Память", "noop", undefined, "memory"),
        btn(`➕ ${ADDON_STEP_GB} ГБ`, extras.packs < limits.packs ? change({ packs: extras.packs + 1 }) : "noop:optmax"),
      ],
      counter("👤", "Стримеры", extras.channels, limits.channels, "channels"),
      counter("📡", "Рестрим", extras.restream, limits.restream, "restream"),
      ...(extras.restream || held.restream_streamers
        ? [counter("➕", "Площадки", extras.restreamExtra, limits.restreamExtra, "restreamExtra")]
        : []),
      TERMS.map((term) => btn(term.months === months ? `✓ ${term.months} мес` : `${term.months} мес`, at(extras, term.months))),
      ...(chosen
        ? [
            [
              btn(`⭐ Оплатить ${starsFor(total)} Stars`, `astar:${code}:${months}`, "success"),
            ],
          ]
        : []),
      [backBtn(`shop:${currency}`, "Магазин")],
    ]),
  };
}

/** Outputs the screen and checkout allow: never past the plan or the server. */
export function addonLimits({ subscription, extras, slotsLeft }) {
  const heldOutputs = (subscription.restream_streamers || 0) + (subscription.restream_extra || 0);
  const roomForOutputs = Math.max(0, slotsLeft - heldOutputs);
  const recorded = (subscription.channels || 1) + extras.channels;
  const restream = Math.min(Math.max(0, recorded - (subscription.restream_streamers || 0)), Math.max(0, roomForOutputs - extras.restreamExtra));
  const streamers = (subscription.restream_streamers || 0) + extras.restream;
  const extraRoom = streamers * 3 - (subscription.restream_extra || 0);
  return {
    packs: Math.max(0, MAX_PACKS - (subscription.addon_packs || 0)),
    channels: MAX_EXTRA_CHANNELS,
    restream,
    restreamExtra: Math.max(0, Math.min(extraRoom, roomForOutputs - extras.restream)),
  };
}

export const withinLimits = (extras, limits) =>
  (extras.packs || 0) <= limits.packs && extras.channels <= limits.channels && extras.restream <= limits.restream && extras.restreamExtra <= limits.restreamExtra;

export { restreamOutputs };
