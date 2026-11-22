import { fmtHours } from "@/ui/redesign/vps-recorder/format";
import { GB, PLANS, fmtPrice, type Currency } from "@/ui/redesign/vps-recorder/plans";

import { caption, cue, EASE, gsap, onFrame, type Scope, type Timeline } from "../lib/motion";
import { CURRENCY_ORDER, PICKED_PLAN, RECORDINGS } from "../views/VpsView";
import { CAM, cameraTo, clickCursor, cursorAt, focusPose, moveCursor } from "./camera";
import { b } from "./schedule";

/** Уже занято в архиве и битрейт, по которому считаются часы */
const USED = 3.1 * GB;
const BYTES_PER_SEC = 800_000;
const PACK_GB = 10;

const PICK_AT = b(84);
/** Смены валюты: ₽ → $ → ★ → снова ₽ */
const CURRENCY_AT = [b(86), b(87.5), b(89)];
const PACK_AT = [b(90), b(90.75)];

const plan = PLANS.find((item) => item.id === PICKED_PLAN) ?? PLANS[0];

function currencyAt(time: number): Currency {
  const index = CURRENCY_AT.filter((at) => time >= at).length;
  return index === 3 ? "rub" : CURRENCY_ORDER[index];
}

function packsAt(time: number) {
  return PACK_AT.filter((at) => time >= at).length;
}

/** Цена за месяц в момент времени: до выбора тарифа — бесплатный */
function totalAt(time: number, currency: Currency) {
  if (time < PICK_AT) return 0;
  const addonRate = { rub: 3, usd: 0.03, stars: 2.2 }[currency];
  return plan.price[currency] + packsAt(time) * PACK_GB * addonRate;
}

/**
 * Архив VPS: сервер пишет сам, записи лежат карточками. Потом вкладка
 * «Подписка»: тарифы каскадом, выбор «Стримера», переключение валют,
 * докупка места и кнопка оплаты крупным планом.
 */
export function buildVps(tl: Timeline, $: Scope) {
  const cursor = $.one("cursor");
  const cards = RECORDINGS.map((recording) => $.one(`vps.card.${recording.id}`));
  const planCards = PLANS.map((item) => $.one(`vps.plan.${item.id}`));
  const tabPill = $.one("vps.tabPill");
  const tabRec = $.one("vps.tab.rec");
  const tabPlan = $.one("vps.tab.plan");
  gsap.set(tabPill, { x: tabRec.offsetLeft, width: tabRec.offsetWidth });
  gsap.set(cards, { opacity: 0 });

  // ── Архив: карточки каскадом на каждую половину доли ──
  caption(tl, $, "vps", b(72.3), b(75.3));
  cameraTo(tl, $, b(71.6), CAM.side, 1.0, "expo.inOut");
  cards.forEach((card, index) => {
    const at = b(72 + index * 0.5);
    cue("card", at, { n: index, gain: 0.7 });
    tl.fromTo(card, { opacity: 0, y: 40, rotationX: -24, scale: 0.94 }, { opacity: 1, y: 0, rotationX: 0, scale: 1, duration: 0.7, ease: EASE.out, immediateRender: false }, at);
  });

  // Живая запись: точка мигает, длительность идёт
  const recDot = $.one("vps.recDot");
  const liveDuration = $.one("vps.liveDuration");
  onFrame((time) => {
    recDot.style.opacity = Math.floor(time * 1.6) % 2 === 0 ? "1" : "0.25";
    const whole = 11568 + Math.max(0, Math.floor(time - b(72)));
    liveDuration.textContent = `${Math.floor(whole / 3600)}:${String(Math.floor((whole % 3600) / 60)).padStart(2, "0")}:${String(whole % 60).padStart(2, "0")}`;
  });

  // Крупно карточка, которая пишется прямо сейчас, и проезд по архиву
  cameraTo(tl, $, b(75.6), focusPose($, cards[0], 1.75, { rotationY: -10, rotationX: 5 }, { x: 1180, y: 560 }), 1.1, "expo.inOut");
  tl.to($.one("rig"), { x: "-=900", y: "-=260", duration: b(79.2) - b(77.6), ease: "sine.inOut" }, b(77.6));

  // ── Вкладка «Подписка» ──
  cameraTo(tl, $, b(79.2), { x: 0, y: 96, scale: 0.84, rotationX: 7, rotationY: 0 }, 1.0, "expo.inOut");
  tl.fromTo(cursor, { x: 700, y: 420, opacity: 0 }, { opacity: 1, duration: 0.25, immediateRender: false }, b(79.2));
  moveCursor(tl, $, b(79.3), cursorAt($, tabPlan), 0.5);
  clickCursor(tl, $, b(80));
  cue("tab", b(80));
  tl.to(tabPill, { x: tabPlan.offsetLeft, width: tabPlan.offsetWidth, duration: 0.45, ease: EASE.cine }, b(80))
    .to($.one("vps.archive"), { autoAlpha: 0, y: -12, duration: 0.2, ease: "power2.in" }, b(80))
    .fromTo($.one("vps.plans"), { autoAlpha: 0, y: 14 }, { autoAlpha: 1, y: 0, duration: 0.45, ease: EASE.out, immediateRender: false }, b(80.2));
  caption(tl, $, "plans", b(80.5), b(84.1));

  planCards.forEach((card, index) => {
    const at = b(80.5 + index * 0.5);
    cue("card", at, { n: index, gain: 0.6 });
    tl.fromTo(card, { opacity: 0, y: 26, scale: 0.92 }, { opacity: 1, y: 0, scale: 1, duration: 0.6, ease: "back.out(1.6)", immediateRender: false }, at);
  });

  // ── Выбор тарифа: рамка, подробности раскрываются, цена считает вверх ──
  const picked = $.one(`vps.plan.${PICKED_PLAN}`);
  const details = $.one("vps.details");
  moveCursor(tl, $, b(83.2), cursorAt($, picked, 0, -30), 0.5);
  clickCursor(tl, $, PICK_AT);
  cue("select", PICK_AT);
  tl.to($.one(`vps.plan.${PICKED_PLAN}.active`), { opacity: 1, duration: 0.25 }, PICK_AT)
    .fromTo(details, { height: 0 }, { height: (details.firstElementChild as HTMLElement).offsetHeight + 12, duration: 0.5, ease: EASE.cine, immediateRender: false }, PICK_AT + 0.05);
  cameraTo(tl, $, b(84.4), focusPose($, picked, 1.35, { rotationY: 6, rotationX: 4 }, { x: 900, y: 600 }), 1.0, "expo.inOut");

  // Цена, квота и кнопка оплаты — от времени: валюта и пакеты меняют всё сразу
  const total = $.one("vps.total");
  const quotaFill = $.one("vps.quotaFill");
  const quotaText = $.one("vps.quotaText");
  const quotaLeft = $.one("vps.quotaLeft");
  const packs = $.one("vps.packs");
  const buyText = $.one("vps.buyText");
  const prices = CURRENCY_ORDER.map((currency) => $.all(`vps.price.${currency}`));
  onFrame((time) => {
    const currency = currencyAt(time);
    // Цена докатывается за 0.4 с после каждого изменения
    const changes = [PICK_AT, ...CURRENCY_AT, ...PACK_AT].filter((at) => time >= at);
    const last = changes.length ? Math.max(...changes) : 0;
    const roll = gsap.utils.clamp(0, 1, (time - last) / 0.4);
    const eased = 1 - (1 - roll) ** 3;
    const target = totalAt(time, currency);
    const from = changes.length ? totalAt(last - 0.001, currency) : 0;
    const shown = from + (target - from) * eased;
    total.textContent = fmtPrice(currency === "usd" ? Math.round(shown * 100) / 100 : shown, currency);
    buyText.textContent = time < PICK_AT ? "Приобрести" : `Приобрести · ${fmtPrice(target, currency)} в месяц`;

    const quota = (time < PICK_AT ? PLANS[0].quota : plan.quota) + packsAt(time) * PACK_GB * GB;
    quotaFill.style.transform = `scaleX(${Math.min(1, USED / quota)})`;
    quotaText.textContent = `${(USED / GB).toFixed(2)} ГБ из ${Math.round(quota / GB)} ГБ`;
    quotaLeft.textContent = `хватит ещё на ~${fmtHours((quota - USED) / BYTES_PER_SEC / 3600)}`;
    packs.textContent = `+${packsAt(time) * PACK_GB} ГБ`;
    prices.forEach((group, index) => {
      const visible = CURRENCY_ORDER[index] === currency ? "1" : "0";
      group.forEach((price) => (price.style.opacity = visible));
    });
  });

  // ── Валюты ──
  const pill = $.one("vps.currencyPill");
  const currencyTargets: Currency[] = ["usd", "stars", "rub"];
  currencyTargets.forEach((currency, index) => {
    const button = $.one(`vps.cur.${currency}`);
    const at = CURRENCY_AT[index];
    moveCursor(tl, $, at - 0.45, cursorAt($, button), 0.4);
    clickCursor(tl, $, at);
    cue("toggle", at);
    tl.to(pill, { x: button.offsetLeft - 2, width: button.offsetWidth, duration: 0.3, ease: EASE.cine }, at);
  });
  cameraTo(tl, $, b(85.4), focusPose($, $.one("vps.total"), 1.5, { rotationY: -6, rotationX: 3 }, { x: 1150, y: 520 }), 1.0, "expo.inOut");

  // ── Докупить место ──
  const plus = $.one("vps.plus");
  cameraTo(tl, $, b(89.4), focusPose($, plus, 1.3, { rotationY: -4, rotationX: 4 }, { x: 1150, y: 560 }), 0.9, "expo.inOut");
  moveCursor(tl, $, b(89.4), cursorAt($, plus), 0.4);
  PACK_AT.forEach((at, index) => {
    clickCursor(tl, $, at);
    cue("check", at, { n: index });
    tl.fromTo(packs, { scale: 1.25 }, { scale: 1, duration: 0.35, ease: EASE.out, immediateRender: false }, at);
  });

  // ── Оплата: кнопка крупно, камера медленно наезжает под подъём трека ──
  const buy = $.one("vps.buy");
  cameraTo(tl, $, b(91.6), focusPose($, buy, 1.5, { rotationX: 8 }, { x: 960, y: 600 }), 1.1, "expo.inOut");
  tl.to($.one("rig"), { scale: "+=0.25", duration: b(95.2) - b(92.8), ease: "power2.in" }, b(92.8));
  moveCursor(tl, $, b(92.2), cursorAt($, buy, 60, 4), 0.6);
  clickCursor(tl, $, b(94));
  tl.fromTo(buy, { boxShadow: "0 0 0 0 rgba(61,125,255,0.8)" }, { boxShadow: "0 0 0 22px rgba(61,125,255,0)", duration: 0.8, ease: "power2.out", immediateRender: false }, b(94))
    .to(cursor, { opacity: 0, duration: 0.25 }, b(94.6));
}
