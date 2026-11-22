/** A picture for every screen, in the fetchr.fun language: «NN / РАЗДЕЛ»
 *  eyebrow, an Inter 700 heading with one blue word, the screen's own fact
 *  (plan, price, ticket…) and, on the right, a product window instead of
 *  clip-art. `art` carries those facts, so every button lands on a picture of
 *  its own. Key screens (registration, shop, plan, paid) have scenes of their
 *  own; the rest share `hero`. */

import { C, WIDTH, avatarBadge, chip, clip, eyebrow, fit, frame, grow, h1, homeSceneSvg, idx, liveDot, mark, panel, rail, riseG, t, textWidth, toneColor, toneSoft, win } from "./cards.mjs";
import { GLYPHS, glyphAt, planGlyph } from "./icons.mjs";

const L = 72;
const COLUMN = 600;
const WX = 724;
const WY = 92;
const WW = 484;
const WH = 536;

const plural = (n, [one, few, many]) => {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
};

/** The avatar sits in the window's title bar, right-aligned. */
const avatarIn = (x, y, w, avatar) => (avatar ? avatarBadge(x + w - 30 - 24, y + 39, 24, avatar) : "");

/** Left column: eyebrow, heading, the fact and a sub line. Returns svg. */
function leftColumn({ num = "", section, title, value = null, sub = null, tone = "accent", width = COLUMN }) {
  const parts = [num ? idx(L, 108, num, section) : eyebrow(L, 108, section, C.text2)];
  const size = fit(title, 100, width, { weight: 700 });
  const [heading, bottom] = h1(L, 196 + size * 0.8, title, size);
  parts.push(heading);
  let y = bottom + 24;
  if (value) {
    const vs = fit([value], 80, width, { weight: 700 });
    parts.push(t(L, y + vs * 0.85, value, { size: vs, weight: 700, fill: toneColor(tone) === C.accentBright ? C.text : toneColor(tone), spacing: -2 }));
    y += vs * 0.85 + 18;
  }
  if (sub) {
    const ss = fit([sub], 34, width, { weight: 500 });
    parts.push(t(L, y + ss + 8, sub, { size: ss, weight: 500, fill: C.text2 }));
  }
  return parts.join("");
}

/** Generic scene: the section's glyph in a product window with a status line. */
function hero(spec, avatar, time = null) {
  const { glyph = "doc", tone = "accent", window = "Fetchr", status = null, chips = [] } = spec;
  const g = GLYPHS[glyph] || GLYPHS.doc;
  const tile = 220;
  const tx = WX + (WW - tile) / 2;
  const ty = WY + 130;
  const color = toneColor(tone);
  const parts = [
    leftColumn(spec),
    win(WX, WY, WW, WH, window, avatarIn(WX, WY, WW, avatar)),
    riseG(time, 0, `<rect x="${tx}" y="${ty}" width="${tile}" height="${tile}" rx="48" fill="${toneSoft(tone)}" stroke="${color}" stroke-opacity="0.32" stroke-width="2"/>` +
      glyphAt(g, tx + 30, ty + 30, tile - 60, { stroke: 1.75 })),
  ];
  if (status) parts.push(riseG(time, 1, t(WX + WW / 2, ty + tile + 74, clip(status, 30, WW - 60, { weight: 600 }), { size: 30, weight: 600, fill: C.text, anchor: "middle" })));
  let x = L;
  for (const [label, chipTone = "muted"] of chips) {
    const [svg, w] = chip(x, 588, label, { tone: chipTone, size: 26, h: 54 });
    if (x + w > WX - 24) break;
    parts.push(riseG(time, 2, svg));
    x += w + 12;
  }
  return frame(parts.join(""));
}

/* ───────────────────────── registration ───────────────────────── */

/** Two step rails; the current step's rail grows with the loop. */
function steps(at, done = false, time = null) {
  const first = at > 1 || done ? 1 : grow(time);
  const second = done ? 1 : at === 2 ? grow(time) : 0;
  return rail(L, 612, 260, first, at > 1 || done ? C.success : C.accent) + rail(L + 280, 612, 260, second, done ? C.success : C.accent);
}

function register1({ channel = "" }, avatar, time = null) {
  const [title] = h1(L, 244, [["Подпишитесь"], [["— ключ ваш", C.accent]]], 88);
  return frame([
    idx(L, 108, "01", "из 02 · ключ"),
    title,
    t(L, 470, "Канал — анонсы и новые функции.", { size: 32, weight: 500, fill: C.text2 }),
    t(L, 516, "Ключ бесплатный.", { size: 32, weight: 500, fill: C.text2 }),
    steps(1, false, time),
    win(WX, WY, WW, WH, "Telegram", avatarIn(WX, WY, WW, avatar)),
    t(WX + 30, WY + 150, "Шаг 1", { size: 26, weight: 600, fill: C.text3 }),
    t(WX + 30, WY + 206, "Подписка на канал", { size: 40, weight: 700 }),
    t(WX + 30, WY + 252, "проверим автоматически", { size: 26, weight: 500, fill: C.text2 }),
    riseG(time, 0, `<rect x="${WX + 30}" y="${WY + 300}" width="${WW - 60}" height="164" rx="20" fill="${C.panel}" stroke="${C.line}" stroke-width="2"/>` +
      mark(WX + 62, WY + 334, 40) +
      t(WX + 122, WY + 352, "Fetchr · канал", { size: 30, weight: 600 }) +
      (channel ? t(WX + 122, WY + 390, clip(channel, 26, WW - 170, { mono: true }), { size: 26, weight: 500, mono: true, fill: C.text3 }) : "") +
      `<rect x="${WX + 62}" y="${WY + 412}" width="${WW - 124}" height="34" rx="17" fill="${C.accentDeep}"/>` +
      t(WX + WW / 2, WY + 437, "Подписаться", { size: 24, weight: 600, fill: "#fff", anchor: "middle" })),
  ].join(""));
}

function register2(_art, avatar, time = null) {
  // The caret blinks: 0.6 s on, 0.6 s off, four times per loop.
  const caret = time == null || Math.floor(time / 0.6) % 2 === 0;
  const [title] = h1(L, 244, [["Пришлите"], [["Machine ID", C.accent]]], 88);
  return frame([
    idx(L, 108, "02", "из 02 · ключ"),
    title,
    t(L, 470, "Fetchr → Настройки →", { size: 32, weight: 500, fill: C.text2 }),
    t(L, 516, "Лицензия → Machine ID", { size: 32, weight: 500, fill: C.text2 }),
    steps(2, false, time),
    win(WX, WY, WW, WH, "Fetchr — Настройки", avatarIn(WX, WY, WW, avatar)),
    t(WX + 30, WY + 150, "Лицензия и beta", { size: 26, weight: 600, fill: C.text3 }),
    t(WX + 30, WY + 206, "Machine ID", { size: 40, weight: 700 }),
    t(WX + 30, WY + 252, "или «Активировать через TG»", { size: 26, weight: 500, fill: C.text2 }),
    `<rect x="${WX + 30}" y="${WY + 300}" width="${WW - 60}" height="76" rx="16" fill="${C.inset}" stroke="${C.accent}" stroke-width="2"/>`,
    t(WX + 54, WY + 349, "7F3A9C21D4E8…", { size: 28, weight: 500, mono: true, fill: C.text2 }),
    caret ? `<rect x="${WX + 54 + textWidth("7F3A9C21D4E8…", 28, { mono: true })}" y="${WY + 322}" width="3" height="34" fill="${C.accent}"/>` : "",
    `<rect x="${WX + 30}" y="${WY + 400}" width="${WW - 60}" height="62" rx="16" fill="${C.raised}" stroke="${C.line}" stroke-width="2"/>`,
    t(WX + WW / 2, WY + 441, "Скопировать Machine ID", { size: 26, weight: 600, anchor: "middle" }),
  ].join(""));
}

function keyReady({ fresh = true }, avatar, time = null) {
  const wx = 680, wy = 120, ww = 528, wh = 480;
  const [title] = h1(L, 250, [["Ключ"], [[fresh ? "готов" : "ваш", C.success]]], 116);
  return frame([
    idx(L, 108, "✓", fresh ? "ключ готов" : "ваш ключ"),
    title,
    t(L, 448, "Скопируйте кнопкой под", { size: 32, weight: 500, fill: C.text2 }),
    t(L, 494, "сообщением и вставьте в Fetchr", { size: 32, weight: 500, fill: C.text2 }),
    steps(2, true, time),
    win(wx, wy, ww, wh, "Fetchr — Активация", avatarIn(wx, wy, ww, avatar)),
    eyebrow(wx + 34, wy + 150, "Лицензионный ключ"),
    riseG(time, 0, `<rect x="${wx + 34}" y="${wy + 172}" width="${ww - 68}" height="84" rx="16" fill="${C.inset}" stroke="${C.success}" stroke-width="2"/>` +
      t(wx + 60, wy + 226, "FTR1.eyJ2IjoxLCJw…", { size: 30, weight: 500, mono: true })),
    riseG(time, 2, chip(wx + 34, wy + 290, "Активировано", { tone: "success", dot: true, size: 30, h: 60 })[0]),
  ].join(""));
}

/* ───────────────────────── shop ───────────────────────── */

const SHOP_PLANS = [
  { id: "mini", name: "Мини · ≈ 7 ч", gb: "20 ГБ", price: "100 ₽" },
  { id: "start", name: "Старт · ≈ 17 ч", gb: "50 ГБ", price: "200 ₽" },
  { id: "streamer", name: "Стример · ≈ 52 ч", gb: "150 ГБ", price: "500 ₽", pick: true },
];

/** The plans as the site's plan cards with B «Ячейка» icons; the pick has the accent top edge. */
function shopScene({ plan = "" }, avatar, time = null) {
  const cx = 620, cw = 588, ch = 150, gap = 18;
  const cards = SHOP_PLANS.map((p, i) => {
    const y = 96 + i * (ch + gap);
    return riseG(time, i, panel(cx, y, cw, ch, { pick: p.pick }) +
      glyphAt(planGlyph(p.id), cx + 30, y + 37, 76) +
      t(cx + 132, y + 58, p.name.toUpperCase(), { size: 26, weight: 600, fill: C.text2, spacing: 1.6 }) +
      t(cx + 132, y + 116, p.gb, { size: 52, weight: 700, spacing: -1.5 }) +
      t(cx + cw - 34, y + 116, p.price, { size: 52, weight: 700, anchor: "end", spacing: -1.5 }) +
      (p.pick ? chip(cx + cw - 34 - 84, y + 26, "Хит", { tone: "accent", size: 22, h: 40 })[0] : t(cx + cw - 34, y + 58, "в месяц", { size: 24, weight: 500, fill: C.text3, anchor: "end" })));
  });
  const [title] = h1(L, 230, [["Стрим запишется"], [["без вашего ПК", C.accent]]], 62);
  return frame([
    idx(L, 108, "01", "архив vps"),
    title,
    t(L, 400, "Копия эфира с чатом остаётся,", { size: 32, weight: 500, fill: C.text2 }),
    t(L, 444, "даже если VOD удалят", { size: 32, weight: 500, fill: C.text2 }),
    chip(L, 520, plan ? `Сейчас: ${clip(plan, 28, 360, { weight: 600 })}` : "Free · 5 ГБ навсегда", { tone: plan ? "accent" : "success", size: 28, h: 58 })[0],
    t(L, 650, "Цены за 30 дней · Robokassa", { size: 26, weight: 500, fill: C.text3 }),
    avatar ? avatarBadge(WIDTH - 72 - 30, 52, 26, avatar) : "",
    ...cards,
  ].join(""));
}

/** Plan card: a receipt the buyer reads before paying. art: { id, plan, quota, hours, channels, months, price, full, perMonth, note }. */
function planScene(art, avatar, time = null) {
  const { id = "streamer", plan = "Тариф", quota = "", hours = "", channels = "", months = "", price = "", full = "", perMonth = "", note = "" } = art;
  const wx = 660, wy = 96, ww = 548, wh = 528;
  const line = (y, a, b) => t(wx + 34, y, a, { size: 28, weight: 500, fill: C.text2 }) + t(wx + ww - 34, y, b, { size: 28, weight: 600, anchor: "end" });
  const size = fit([plan], 112, 470, { weight: 700 });
  const [title] = h1(L, 232, [plan], size);
  const titleEnd = L + textWidth(plan, size, { weight: 700 }) + 20;
  return frame([
    idx(L, 108, "02", "оплата"),
    title,
    titleEnd + 84 < wx - 10 ? glyphAt(planGlyph(id), titleEnd, 150, 84) : "",
    perMonth ? t(L, 370, [[perMonth, C.text], ["/мес", C.text3]], { size: 88, weight: 700, spacing: -3 }) : t(L, 370, price, { size: 88, weight: 700, spacing: -3 }),
    note ? chip(L, 420, clip(note, 26, 540, { weight: 600 }), { tone: "success", size: 26, h: 54 })[0] : "",
    t(L, 620, "Оферта · возврат за неиспользованные дни", { size: 24, weight: 500, fill: C.text3 }),
    win(wx, wy, ww, wh, "Заказ", avatar ? avatarIn(wx, wy, ww, avatar) : chip(wx + ww - 186, wy + 14, "Robokassa", { tone: "muted", size: 22, h: 48 })[0]),
    quota ? riseG(time, 0, line(wy + 146, "Место в архиве", quota)) : "",
    hours ? riseG(time, 1, line(wy + 202, "Эфира в 1080p", hours)) : "",
    channels ? riseG(time, 2, line(wy + 258, "Стримеров разом", channels)) : "",
    months ? riseG(time, 3, line(wy + 314, "Срок", months)) : "",
    `<path d="M${wx + 34} ${wy + 350}H${wx + ww - 34}" stroke="${C.line}" stroke-width="2" stroke-dasharray="6 8"/>`,
    t(wx + 34, wy + 418, "Итого", { size: 32, weight: 600 }),
    full ? t(wx + ww - 34, wy + 380, full, { size: 26, weight: 500, fill: C.text3, anchor: "end" }) +
      `<path d="M${wx + ww - 34 - textWidth(full, 26, { weight: 500 })} ${wy + 371}H${wx + ww - 34}" stroke="${C.text3}" stroke-width="2"/>` : "",
    riseG(time, 4, t(wx + ww - 34, wy + 424, price, { size: 52, weight: 700, anchor: "end", spacing: -1.5 })),
    ["СБП", "Карта", "T-Pay", "Яндекс Пэй"].reduce((acc, label) => {
      const [svg, w] = chip(acc.x, wy + 456, label, { tone: "muted", size: 22, h: 44 });
      return { x: acc.x + w + 10, svg: acc.svg + svg };
    }, { x: wx + 34, svg: "" }).svg,
  ].join(""));
}

/** Paid: the archive queue, the server already waiting for the first stream. */
function paidScene({ plan = "", months = "", until = "", id = "" }, avatar, time = null) {
  const wx = 600, wy = 96, ww = 608, wh = 528;
  const row = (y, title, sub, status, tone, ratio, index) => riseG(time, index,
    `<rect x="${wx + 30}" y="${y + 26}" width="96" height="64" rx="10" fill="${C.raised}" stroke="${C.lineStrong}" stroke-width="2"/>` +
    `<path d="M${wx + 70} ${y + 44}V${y + 72}L${wx + 92} ${y + 58}Z" fill="${C.text3}"/>` +
    t(wx + 150, y + 54, title, { size: 28, weight: 600 }) +
    t(wx + 150, y + 90, sub, { size: 22, weight: 500, mono: true, fill: C.text3 }) +
    (tone === "danger" ? liveDot(wx + ww - 196, y + 46, 7, toneColor(tone), time) : `<circle cx="${wx + ww - 196}" cy="${y + 46}" r="7" fill="${toneColor(tone)}"/>`) +
    t(wx + ww - 180, y + 55, status, { size: 26, weight: 600, fill: toneColor(tone) }) +
    rail(wx + ww - 196, y + 74, 166, ratio * grow(time), tone === "success" ? C.success : C.accent) +
    `<path d="M${wx + 2} ${y + 118}H${wx + ww - 2}" stroke="${C.lineSubtle}" stroke-width="2"/>`);
  const [title] = h1(L, 236, [["Сервер"], [["уже пишет", C.success]]], 100);
  const facts = [plan, months].filter(Boolean).join(" · ");
  return frame([
    idx(L, 108, "✓", "оплачено"),
    title,
    facts ? t(L, 408, clip(facts, 34, 500, { weight: 600 }), { size: 34, weight: 600 }) : "",
    until || id ? t(L, 454, [until ? `до ${until}` : "", id ? `заказ #${id}` : ""].filter(Boolean).join(" · "), { size: 26, weight: 500, mono: true, fill: C.text3 }) : "",
    chip(L, 520, "Компьютер можно выключить", { tone: "muted", size: 26, h: 54 })[0],
    win(wx, wy, ww, wh, "Архив VPS", avatarIn(wx, wy, ww, avatar)),
    row(wy + 80, "Ваш стример", "ждём ближайший эфир", "ждём", "warning", 0, 0),
    row(wy + 198, "Запись", "видео + чат", "REC", "danger", 0.35, 1),
    row(wy + 316, "Клипы", "режутся на сервере", "готово", "success", 1, 2),
  ].join(""));
}

/** Manual order (no Robokassa): the order number and the sum. */
function orderScene({ price = "", id = "" }, avatar, time = null) {
  return hero({ num: "02", section: "заказ", title: [["Заявка"], [["принята", C.accent]]], value: price || null, sub: id ? `Заказ #${id}` : null, glyph: "doc", window: "Заказ", status: "Ссылку пришлёт менеджер" }, avatar, time);
}

/** name → (art, avatar, time) → svg. */
const COVERS = {
  /** The home cover, nothing personal in it: { state: new|key|free|paid, shop, promo }. */
  home: ({ state = "new", shop = true, promo = null }, _avatar, m) => homeSceneSvg({ state, shop, promo, t: m }),
  terms: (_, a, m) => hero({ section: "Fetchr", title: [["Условия"]], sub: "Оферта, возврат, данные", glyph: "doc", window: "Оферта" }, a, m),

  "register-1": register1,
  "register-2": register2,
  "register-3": keyReady,
  "register-limit": (_, a, m) => hero({ section: "Ключ", title: [["Одно"], [["устройство", C.warning]]], sub: "Сбросьте старое в кабинете", glyph: "lock", tone: "warning", window: "Устройства", status: "Лимит: 1 компьютер" }, a, m),
  "register-bad": (_, a, m) => hero({ section: "Ключ", title: [["ID"], [["не подошёл", C.danger]]], sub: "Скопируйте его заново", glyph: "error", tone: "warning", window: "Machine ID", status: "32 символа: 0–9 и A–F" }, a, m),

  "shop-1": shopScene,
  "shop-3": planScene,
  "shop-order": orderScene,
  "shop-done": paidScene,
  "shop-free": (_, a, m) => hero({ section: "Архив VPS", title: [["Free"], [["подключён", C.success]]], value: "5 ГБ", sub: "Бесплатно навсегда", glyph: "gift", tone: "success", window: "Архив VPS", status: "Стример — в Fetchr" }, a, m),
  "shop-addons": (_, a, m) => hero({ section: "Архив VPS", title: [["Доп."], [["услуги", C.accent]]], sub: "Память, стримеры, рестрим", glyph: "plus", window: "Доп. услуги", status: "Поверх платного тарифа" }, a, m),

  support: (_, a, m) => hero({ section: "Поддержка", title: [["Ответим"], [["прямо здесь", C.accent]]], sub: "Опишите проблему одним сообщением", glyph: "chat", window: "Поддержка", status: "Обычно отвечаем за час" }, a, m),
  "support-pay": (_, a, m) => hero({ section: "Поддержка", title: [["Вопрос"], [["по оплате", C.accent]]], sub: "Укажите номер заказа", glyph: "card", window: "Оплата", status: "Разберёмся и вернём" }, a, m),
  "support-write": (_, a, m) => hero({ section: "Поддержка", title: [["Жду ваше"], [["сообщение", C.accent]]], sub: "Текст, скриншот или файл", glyph: "chat", window: "Новое обращение", status: "Одним сообщением" }, a, m),
  "support-sent": ({ id = "" }, a, m) => hero({ section: "Поддержка", title: [["Обращение"], [["отправлено", C.success]]], value: id ? `#${id}` : null, sub: "Ответ придёт сюда", glyph: "check", tone: "success", window: "Поддержка", status: "Ответ придёт в этот чат" }, a, m),

  "rs-none": (_, a, m) => hero({ section: "Рестрим", title: [["Нужен"], [["тариф", C.accent]]], sub: "Рестрим работает на Архиве VPS", glyph: "restream", window: "Рестрим" }, a, m),
  "rs-off": (_, a, m) => hero({ section: "Рестрим", title: [["Сервер"], [["не отвечает", C.warning]]], sub: "Попробуйте через минуту", glyph: "error", tone: "warning", window: "Рестрим" }, a, m),
  "rs-home": ({ outputs = 0 }, a, m) => hero({
    section: "Рестрим",
    title: [["Один эфир —"], [["все площадки", C.accent]]],
    value: outputs ? `${outputs} ${plural(outputs, ["площадка", "площадки", "площадок"])}` : null,
    sub: "Twitch, Kick, YouTube, VK, Rutube",
    glyph: "restream",
    window: "Рестрим",
  }, a, m),
  "rs-channel": (_, a, m) => hero({ section: "Рестрим", title: [["Какой"], [["канал?", C.accent]]], sub: "Откуда берём эфир", glyph: "user", window: "Рестрим" }, a, m),
  "rs-own": ({ channel = "" }, a, m) => hero({ section: "Рестрим", title: [["Это ваш"], [["канал?", C.accent]]], value: channel || null, glyph: "user", window: "Рестрим", status: "Только свой канал" }, a, m),
  "rs-folder": ({ channel = "" }, a, m) => hero({ section: "Рестрим", title: [["Площадки"]], value: channel || null, sub: "Куда ретранслируем эфир", glyph: "restream", window: "Рестрим" }, a, m),
  "rs-platform": (_, a, m) => hero({ section: "Рестрим", title: [["Площадка"]], sub: "Куда отправить эфир", glyph: "channel", window: "Рестрим" }, a, m),
  "rs-ask": ({ platform = "" }, a, m) => hero({ section: "Рестрим", title: [[platform || "Ключ потока"]], sub: "Пришлите адрес и ключ", glyph: "key", window: "Рестрим", status: "Ключ из чата удалим" }, a, m),
  "rs-remove": (_, a, m) => hero({ section: "Рестрим", title: [["Удалить"], [["площадку?", C.danger]]], glyph: "trash", tone: "danger", window: "Рестрим" }, a, m),
};

export const COVER_NAMES = Object.freeze(Object.keys(COVERS));

/** `time` (seconds into the loop) draws one frame of the animated cover;
 *  null — the still picture — is the same as frame 0. */
export function coverSvg(name, art = null, avatar = null, time = null) {
  const build = COVERS[name];
  return build ? build(art || {}, avatar, time) : null;
}
