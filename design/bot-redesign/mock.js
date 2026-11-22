/* Fetchr bot redesign mock: plays the same user goal in two Telegram chats.
   «Сейчас» repeats screens.mjs / shop-screens.mjs as they are today (texts copied
   from the code, current covers rendered from covers.mjs/cards.mjs).
   «Предлагаю» uses covers.mjs in this folder (window.FETCHR_COVERS). */
(function () {
  "use strict";

  /* ── Custom emoji: the proposed «Fetchr Line» pack (site sprite glyphs on a tile) ── */
  const GLYPH = {
    key: '<circle cx="8" cy="15" r="4"/><path d="m11 12 9-9M17 6l3 3M14 9l2 2"/>',
    archive: '<rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/><path d="M7 7.5h.01M7 16.5h.01"/>',
    chat: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
    tg: '<path d="m22 3-20 8 7 2 2 7 3-4 5 4z"/><path d="m9 13 13-10"/>',
    check: '<path d="m5 12 5 5 9-10"/>',
    restream: '<circle cx="12" cy="12" r="2"/><path d="M16.2 7.8a6 6 0 0 1 0 8.4M7.8 16.2a6 6 0 0 1 0-8.4M19 5a10 10 0 0 1 0 14M5 19A10 10 0 0 1 5 5"/>',
    copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/>',
    card: '<rect x="2.5" y="5" width="19" height="14" rx="2.5"/><path d="M2.5 10h19M6 15h4"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    play: '<path d="M7 4v16l13-8z"/>',
    home: '<path d="M3 11 12 4l9 7M5 10v10h14V10"/>',
    doc: '<path d="M6 3h8l4 4v14H6zM14 3v4h4M9 12h6M9 16h6"/>',
    spark: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6"/>',
    rec: '<circle cx="12" cy="12" r="5" fill="currentColor"/>',
  };
  const TONE = { check: "ok", rec: "live", spark: "warm" };
  /* «Fetchr Line» from icons.js: tile emoji in text, one-colour adaptive emoji in buttons.
     {p_free}…{p_streamer} are the plan icons of the recommended direction (B · Ячейка). */
  const PACK = window.FETCHR_ICONS || null;
  const ALIAS = { tg: "channel", rec: "live" };
  const PLAN_DIR = "B";
  function packIcon(name) {
    if (!PACK) return null;
    if (name.startsWith("p_")) return PACK.plans[`${PLAN_DIR}-${name.slice(2)}`] || null;
    return PACK.service[ALIAS[name] || name] || null;
  }
  function ce(name, where = "text") {
    const icon = packIcon(name);
    if (icon && where === "text") return `<span class="ce2" title="custom emoji: ${name}">${icon.tile}</span>`;
    if (icon) return `<span class="ce ce-mono" title="adaptive emoji: ${name}"><svg viewBox="0 0 24 24">${icon.mono}</svg></span>`;
    if (!GLYPH[name]) return null;
    return `<span class="ce ${TONE[name] || ""}" title="custom emoji: ${name}"><svg viewBox="0 0 24 24">${GLYPH[name]}</svg></span>`;
  }
  const withEmoji = (html, where = "text") => html.replace(/\{(\w+)\}/g, (m, name) => ce(name, where) || m);

  /* ── Proposed covers: inline SVG with unique ids, so several can live in one page ── */
  let uid = 0;
  function coverNode(src) {
    if (src.startsWith("svg:")) {
      const raw = (window.FETCHR_COVERS || {})[src.slice(4)];
      const wrap = document.createElement("div");
      if (!raw) return wrap;
      const n = ++uid;
      wrap.innerHTML = raw.replace(/id="(grid|gridFade|gridMask)"/g, `id="$1-${n}"`).replace(/url\(#(grid|gridFade|gridMask)\)/g, `url(#$1-${n})`);
      return wrap;
    }
    const img = document.createElement("img");
    img.src = src;
    img.alt = "";
    return img;
  }

  /* ── Scenarios ── */
  const ID = "7F3A9C21D4E85B60A1F29C0D3E4B5A61";
  const KEY = "FX1-7F3A-Q8KD-2MZP-HT4W-9LCE";
  const CONSENT = '<a href="#">текст</a> · <a href="#">политика конфиденциальности</a>';

  const NOW = {
    homeNew: { cover: "current/home-new.png", text: "Ключ бесплатный — выдаём прямо в этом чате за минуту.\n\n👥 <i>48 пользователей за месяц</i>",
      kb: [[["🔑 Получить ключ", "primary"]], [["🛒 Архив VPS"], ["💬 Помощь"], ["📡 Рестрим"]], [["📢 Канал", "url"]]] },
    consent: { cover: "current/welcome.png", text: `🔑 <b>Последний шаг — и ключ ваш</b>\n\nДля ключа бот запомнит ваш Telegram ID, имя пользователя и Machine ID компьютера, а приложение будет присылать отчёты об ошибках.\n\n<i>Согласие на обработку данных: ${CONSENT}. Отозвать можно в любой момент через поддержку.</i>`,
      kb: [[["✅ Согласен — получить ключ", "success"]], [["‹ Назад"]]] },
    reg1: { cover: "current/register-1.png", text: "Ключ Fetchr бесплатный и привязывается к вашему компьютеру.\n\n▫️ Подпишитесь на @streamcutter\n▫️ Отправьте Machine ID из приложения одним сообщением\n\n<blockquote class=\"exp\"><b>Где взять Machine ID</b>\nFetchr → Настройки → Лицензия и beta → Machine ID → «Скопировать».\nБыстрее: кнопка «Активировать через Telegram» в приложении — ключ придёт сюда сам.</blockquote>",
      kb: [[["📢 Подписаться", "primary url"], ["🔄 Я подписался"]], [["‹ Назад"]]] },
    reg2: { cover: "current/register-2.png", text: "Ключ Fetchr бесплатный и привязывается к вашему компьютеру.\n\n✅ Подписка на @streamcutter\n▫️ Отправьте Machine ID из приложения одним сообщением\n\n<blockquote class=\"exp\"><b>Где взять Machine ID</b>\nFetchr → Настройки → Лицензия и beta → Machine ID → «Скопировать».\nБыстрее: кнопка «Активировать через Telegram» в приложении — ключ придёт сюда сам.</blockquote>",
      kb: [[["‹ Назад"]]] },
    key: { cover: "current/register-3.png", text: `✅ <b>Устройство зарегистрировано</b>\n\nMachine ID: <code>7F3A…5A61</code>\n\n<pre>${KEY}</pre>\nСкопируйте ключ и вставьте его в окно активации Fetchr.\n\n<blockquote>Ключ работает, пока вы подписаны на @streamcutter.</blockquote>`,
      kb: [[["🛒 Архив VPS"], ["🏠 Меню"]]] },
    home: { cover: "current/home.png", text: "Архив VPS пишет эфиры, пока компьютер выключен. <b>5 ГБ бесплатно.</b>\n\n👥 <i>48 пользователей за месяц</i>",
      kb: [[["🛒 Архив VPS · 5 ГБ бесплатно", "primary"]], [["🔑 Мой ключ"], ["💬 Помощь"], ["📡 Рестрим"]], [["📢 Канал", "url"]]] },
    shop: { cover: "current/shop-1.png", text: "🛒 <b>Магазин</b>\n\nСервер записывает эфиры, пока компьютер выключен.\n<i>Цены за 30 дней.</i>",
      kb: [[["🌱 Free · 5 ГБ · бесплатно"]], [["🔹 Мини · 20 ГБ · 100 ₽"]], [["🔷 Старт · 50 ГБ · 200 ₽"]], [["🔥 Стример · 150 ГБ · 500 ₽", "primary"]], [["➕ Доп. услуги · память, стримеры, рестрим", "success"]], [["‹ Назад"]]] },
    term: { cover: "current/shop-2.png", text: "🔥 <b>Стример</b> · 150 ГБ\n\nНа какой срок?\n<i>Чем дольше, тем дешевле месяц.</i>",
      kb: [[["1 мес · 500 ₽"], ["3 мес · 1 425 ₽ · −5%"]], [["6 мес · 2 700 ₽ · −10%"], ["12 мес · 4 800 ₽ · −20%", "success"]], [["‹ Тарифы"]]] },
    plan: { cover: "current/shop-3.png", text: '🔥 <b>Стример</b>\n\n💾 <b>150 ГБ</b> · ≈ 52 ч эфира · 2 стримера разом\n🗓 1 месяц — <b>500 ₽</b>\n\n<i>Карта, СБП, Яндекс Пэй, T-Pay или звёзды Telegram. <a href="#">Оферта</a></i>',
      kb: [[["🗓 1 месяц · сменить срок"]], [["💳 Оплатить 500 ₽", "success"]], [["⭐ Звёздами · 313"]], [["‹ Тарифы"], ["📄 Условия"]]] },
    invoice: { cover: "current/shop-invoice.png", text: "💳 <b>Счёт на оплату</b> · <code>#A7F3K2</code>\n\n<blockquote>Тариф — <b>Стример</b> · 150 ГБ\nСрок — 1 месяц\nСумма — <b>500 ₽</b></blockquote>\n\nОплата на странице Robokassa: карты РФ и БЛ, Яндекс Пэй, T-Pay, СБП. Чек придёт на e-mail, который вы укажете при оплате. После оплаты вернитесь сюда — бот подтвердит заказ сам.",
      kb: [[["💳 Оплатить 500 ₽", "success url"]], [["🔄 Проверить оплату"]], [["‹ Тарифы"]]] },
    paid: { cover: "current/shop-done.png", text: "🎉 <b>Оплата прошла</b>\n\n<blockquote>Заказ — <code>#A7F3K2</code>\nТариф — <b>Стример</b> · 150 ГБ\nСрок — 1 месяц\nСумма — 500 ₽</blockquote>\n\nТариф подключён автоматически — можно пользоваться. Спасибо, что вы с Fetchr!",
      kb: [[["💬 Поддержка"], ["🏠 Меню"]]] },
  };

  const PLAN_TERMS = (pick) => ["1", "3", "6", "12"].map((m) => [m === pick ? `✓ ${m} мес` : `${m} мес`]);
  const NEXT = {
    homeNew: { cover: "svg:home-new", text: "<b>Fetchr</b> готовит исходник к монтажу: глушит мат, делит голос и музыку, блюрит рекламу, рендерит чат слоем.\n\n{key} Ключ — <b>бесплатно</b>, выдаём здесь за минуту.",
      kb: [[["{key} Получить ключ", "primary"]], [["{archive} Архив VPS"], ["{restream} Рестрим"]], [["{chat} Поддержка"], ["{tg} Канал", "url"]]] },
    reg1: { cover: "svg:register-1", text: `<b>Шаг 1 из 2.</b> Подпишитесь на @streamcutter — анонсы и новые функции там.\n\n<i>Нажимая «Согласен», вы разрешаете боту хранить Telegram ID, ник и Machine ID для ключа: ${CONSENT}.</i>\n<blockquote class="exp"><b>Зачем это</b>\nКлюч привязан к компьютеру, по Machine ID. Приложение присылает отчёты об ошибках. Отозвать согласие — через поддержку.</blockquote>`,
      kb: [[["{tg} Подписаться на канал", "url"]], [["{check} Согласен, проверить подписку", "primary"]], [["← Назад"]]] },
    reg2: { cover: "svg:register-2", text: "<b>Шаг 2 из 2.</b> Пришлите <b>Machine ID</b> одним сообщением.\n\nFetchr → Настройки → Лицензия и beta → «Скопировать».\n<blockquote>Быстрее: «Активировать через Telegram» в приложении — ключ придёт сам.</blockquote>",
      kb: [[["← Назад"]]] },
    key: { cover: "svg:key", text: `<b>Ключ для 7F3A…5A61</b>\n<pre>${KEY}</pre>\nFetchr → Активация → вставьте ключ.\n<blockquote class="exp">Ключ работает, пока вы подписаны на @streamcutter. Новый компьютер — сбросьте старый в личном кабинете.</blockquote>`,
      kb: [[["{copy} Скопировать ключ", "primary copy"]], [["{archive} Архив · 5 ГБ бесплатно"], ["{home} Меню"]]] },
    home: { cover: "svg:home-active", text: "{check} Ключ активен · <code>7F3A…5A61</code>\n\n<b>Архив VPS</b> пишет эфиры с чатом, пока компьютер выключен. <b>5 ГБ — бесплатно навсегда.</b>",
      kb: [[["{archive} Архив VPS · 5 ГБ бесплатно", "primary"]], [["{key} Мой ключ"], ["{restream} Рестрим"]], [["{chat} Поддержка"], ["{tg} Канал", "url"]]] },
    shop: { cover: "svg:shop-B", text: "<b>Архив VPS</b> — сервер пишет эфир с чатом, даже когда ПК выключен. Копия останется, если VOD удалят.\n<blockquote class=\"exp\"><b>Что входит</b>\nFree — 5 ГБ навсегда, 1 стример\nМини — 20 ГБ, ≈ 7 ч эфира, 1 стример\nСтарт — 50 ГБ, ≈ 17 ч, 1 стример\nСтример — 150 ГБ, ≈ 52 ч, 2 стримера</blockquote>\n<i>Цены за 30 дней, в рублях. За год — −20%.</i>",
      kb: [[["{p_free} Free · 0 ₽"], ["{p_mini} Мини · 100 ₽"]], [["{p_start} Старт · 200 ₽"], ["{p_streamer} Стример · 500 ₽", "primary"]], [["{plus} Память, стримеры, рестрим"]], [["← Назад"]]] },
    plan1: { cover: "svg:plan-1-B", text: '{p_streamer} <b>Стример</b> · 150 ГБ · ≈ 52 ч эфира · 2 стримера\n\nСрок: <b>1 месяц — 500 ₽</b>\n<i>3 мес −5% · 6 мес −10% · 12 мес −20% (400 ₽/мес).</i>\n\n<i>СБП, карта, Яндекс Пэй, T-Pay · чек на e-mail · без автопродления · <a href="#">оферта</a></i>',
      kb: [PLAN_TERMS("1"), [["{plus} +10 ГБ · 30 ₽/мес"]], [["{card} Оплатить 500 ₽", "success url"]], [["← Тарифы"], ["{doc} Условия"]]] },
    plan12: { cover: "svg:plan-12", text: '{p_streamer} <b>Стример</b> · 150 ГБ · ≈ 52 ч эфира · 2 стримера\n\nСрок: <b>12 месяцев — <s>6 000 ₽</s> 4 800 ₽</b>\n<i>400 ₽/мес · экономия 1 200 ₽.</i>\n\n<i>СБП, карта, Яндекс Пэй, T-Pay · чек на e-mail · без автопродления · <a href="#">оферта</a></i>',
      kb: [PLAN_TERMS("12"), [["{plus} +10 ГБ · 30 ₽/мес"]], [["{card} Оплатить 4 800 ₽", "success url"]], [["← Тарифы"], ["{doc} Условия"]]] },
    planPaid: { cover: "svg:plan-12", text: "<b>Стример</b> · 12 месяцев · 4 800 ₽\n{check} Заказ <code>#A7F3K2</code> оплачен", kb: [] },
    paid: { cover: "svg:paid", text: "<b>Оплачено.</b> Стример на 12 месяцев\n<blockquote>Заказ <code>#A7F3K2</code> · 4 800 ₽ · до 18.11.2027\nЧек — на e-mail из Robokassa</blockquote>\nОткройте в Fetchr <b>Архив VPS</b> → «Добавить стримера» — запись начнётся с ближайшего эфира.",
      kb: [[["{play} Как начать запись", "primary"]], [["{restream} Рестрим · +100 ₽/мес"], ["{home} Меню"]]] },
  };

  const PROFILE = {
    now: { cover: null, text: "<b>Что может делать этот бот?</b>\nFetchr — премиальный стрим-конвейер.\n\n🔑 Бесплатный ключ активации приложения\n🛒 Архив VPS — облачная запись стримов\n💬 Поддержка прямо в чате" },
    next: { cover: "svg:botfather-description", text: "<b>Что может делать этот бот?</b>\nFetchr готовит исходники к монтажу: глушит мат, делит голос и музыку, блюрит рекламу, рендерит чат слоем.\n\n🔑 Ключ приложения — бесплатно, за минуту\n🗄 Архив VPS — сервер пишет стримы 24/7, от 100 ₽/мес\n💬 Поддержка — отвечаем в этом чате" },
  };

  const ROBOKASSA = (sum) => ({ title: `Robokassa · ${sum}`, body: "Fetchr · Архив VPS «Стример»", pay: ["СБП", "Карта", "T-Pay", "Яндекс Пэй"], go: `Оплатить ${sum}` });
  const CHANNEL = { title: "Fetchr · канал", body: "@streamcutter · анонсы и новые функции", go: "Подписаться" };

  const FLOWS = {
    key: {
      label: "Ключ с нуля",
      now: [["show", NOW.homeNew], ["tap", "Получить ключ"], ["edit", NOW.consent], ["tap", "Согласен"], ["toast", "Согласие сохранено"], ["edit", NOW.reg1],
        ["tap", "Подписаться"], ["sheet", CHANNEL], ["tap", "Я подписался"], ["edit", NOW.reg2], ["user", ID], ["typing"], ["show", NOW.key], ["wait", 2200]],
      next: [["show", NEXT.homeNew], ["tap", "Получить ключ"], ["edit", NEXT.reg1], ["tap", "Подписаться"], ["sheet", CHANNEL], ["tap", "Согласен"],
        ["toast", "Подписка есть ✓"], ["edit", NEXT.reg2], ["user", ID], ["typing"], ["show", NEXT.key], ["tap", "Скопировать"], ["toast", "Ключ скопирован"], ["wait", 1400]],
      clicks: ["4 нажатия + ввод ID", "3 нажатия + ввод ID, ключ копируется кнопкой"],
    },
    buy: {
      label: "Покупка Архива",
      now: [["show", NOW.home], ["tap", "Архив VPS"], ["edit", NOW.shop], ["tap", "Стример"], ["edit", NOW.term], ["tap", "1 мес"], ["edit", NOW.plan],
        ["tap", "Оплатить"], ["edit", NOW.invoice], ["tap", "Оплатить"], ["sheet", ROBOKASSA("500 ₽")], ["typing"], ["show", NOW.paid], ["wait", 2200]],
      next: [["show", NEXT.home], ["tap", "Архив VPS"], ["edit", NEXT.shop], ["tap", "Стример"], ["edit", NEXT.plan1], ["tap", "12 мес"], ["edit", NEXT.plan12],
        ["tap", "Оплатить"], ["sheet", ROBOKASSA("4 800 ₽")], ["typing"], ["edit", NEXT.planPaid], ["show", NEXT.paid], ["wait", 2600]],
      clicks: ["5 нажатий до Robokassa", "3 нажатия (4 со сменой срока)"],
    },
    profile: {
      label: "Профиль и старт",
      now: [["intro", PROFILE.now], ["wait", 1600], ["start"], ["user", "/start"], ["show", NOW.homeNew], ["wait", 2400]],
      next: [["intro", PROFILE.next], ["wait", 1600], ["start"], ["user", "/start"], ["show", NEXT.homeNew], ["wait", 2400]],
      clicks: ["описание без картинки", "картинка 640×360 + оффер за 1 секунду"],
    },
  };

  /* ── Phone ── */
  const AVATAR = '<svg viewBox="0 0 512 512"><rect width="512" height="512" fill="#0B0D12"/><path fill="#3D7DFF" d="M112 110.33H399.5Q416.17 110.33 416.17 127V172.83Q416.17 189.5 399.5 189.5H178.67V252H216.17Q232.83 252 232.83 268.67V314.5Q232.83 331.17 216.17 331.17H178.67V385.33Q178.67 402 162 402H112Q95.33 402 95.33 385.33V127Q95.33 110.33 112 110.33ZM332.83 252H399.5Q416.17 252 416.17 268.66V314.5Q416.17 331.16 399.5 331.16H332.83Q316.17 331.16 316.17 314.5V268.66Q316.17 252 332.83 252Z"/></svg>';

  function buildPhone(host) {
    host.innerHTML = `<div class="phone">
      <div class="tg-head"><span class="back">‹</span><span class="tg-ava">${AVATAR}</span><span class="tg-title"><b>Fetchr</b><small>бот</small></span></div>
      <div class="chat"></div>
      <div class="tg-foot"><button class="menu-btn" type="button"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M4 7h16M4 12h16M4 17h16"/></svg>Меню</button><span class="field">Сообщение</span><svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3zM19 10v2a7 7 0 0 1-14 0v-2M12 19v3"/></svg></div>
      <div class="toast"></div><div class="sheet"></div><div class="touch"></div>
    </div>`;
    const phone = host.firstElementChild;
    return { phone, chat: phone.querySelector(".chat"), toast: phone.querySelector(".toast"), sheet: phone.querySelector(".sheet"), touch: phone.querySelector(".touch"), status: phone.querySelector(".tg-title small") };
  }

  function keyboardHtml(rows, fancy) {
    return rows.map((row) => `<div class="row">${row.map(([label, cls = ""]) => {
      const text = fancy ? withEmoji(label, "button") : label;
      const m = text.match(/^(<span class="ce[^"]*"[^>]*><svg[\s\S]*?<\/svg><\/span>)\s*/);
      const inner = m ? `${m[1]}<span class="t">${text.slice(m[0].length)}</span>` : `<span class="t">${text}</span>`;
      return `<button type="button" class="${cls}" data-label="${label.replace(/\{\w+\}\s*/g, "").replace(/"/g, "&quot;")}">${inner}</button>`;
    }).join("")}</div>`).join("");
  }

  const clock = () => "12:0" + (Math.floor(Date.now() / 60000) % 10);

  function messageNode(screen, fancy) {
    const msg = document.createElement("div");
    msg.className = "msg";
    msg.innerHTML = `<div class="bubble">${screen.cover ? '<div class="cover"></div>' : ""}<div class="caption"></div></div><div class="kb"></div>`;
    fill(msg, screen, fancy, false);
    return msg;
  }

  function fill(msg, screen, fancy, edited) {
    const cover = msg.querySelector(".cover");
    if (cover && screen.cover && cover.dataset.src !== screen.cover) {
      const next = coverNode(screen.cover);
      const old = [...cover.children];
      if (old.length) next.classList.add("out");
      cover.appendChild(next);
      cover.dataset.src = screen.cover;
      requestAnimationFrame(() => requestAnimationFrame(() => {
        next.classList.remove("out");
        old.forEach((node) => node.classList.add("out"));
        setTimeout(() => old.forEach((node) => node.remove()), 300);
      }));
    }
    const caption = msg.querySelector(".caption");
    const html = (fancy ? withEmoji(screen.text) : screen.text) + `<span class="time">${edited ? "<em>изменено</em>" : ""}${clock()}</span>`;
    const kb = msg.querySelector(".kb");
    if (!edited) {
      caption.innerHTML = html;
      kb.innerHTML = keyboardHtml(screen.kb || [], fancy);
      return;
    }
    caption.classList.add("swap");
    setTimeout(() => {
      caption.innerHTML = html;
      kb.innerHTML = keyboardHtml(screen.kb || [], fancy);
      caption.classList.remove("swap");
    }, 120);
  }

  /* ── Runner with pause and restart ── */
  let paused = false;
  let generation = 0;

  async function sleep(ms, gen) {
    let left = ms;
    while (left > 0) {
      if (gen !== generation) throw new Error("restart");
      const step = Math.min(50, left);
      await new Promise((resolve) => setTimeout(resolve, step));
      if (!paused) left -= step;
    }
    if (gen !== generation) throw new Error("restart");
  }

  function scrollDown(ui) {
    ui.chat.scrollTop = ui.chat.scrollHeight;
  }

  async function run(ui, steps, fancy, gen) {
    ui.chat.innerHTML = "";
    let last = null;
    for (const [kind, arg] of steps) {
      if (kind === "show") {
        last = messageNode(arg, fancy);
        ui.chat.appendChild(last);
        scrollDown(ui);
        await sleep(1700, gen);
      } else if (kind === "edit") {
        if (last) fill(last, arg, fancy, true);
        await sleep(260, gen);
        scrollDown(ui);
        await sleep(1500, gen);
      } else if (kind === "tap") {
        const target = last && [...last.querySelectorAll(".kb button")].find((b) => b.dataset.label.includes(arg));
        if (target) await tap(ui, target, gen);
      } else if (kind === "toast") {
        ui.toast.textContent = arg;
        ui.toast.classList.add("on");
        await sleep(1100, gen);
        ui.toast.classList.remove("on");
        await sleep(200, gen);
      } else if (kind === "sheet") {
        ui.sheet.innerHTML = `<b>${arg.title}</b><span>${arg.body}</span>${arg.pay ? `<div class="pay">${arg.pay.map((p, i) => `<span class="${i === 0 ? "on" : ""}">${p}</span>`).join("")}</div>` : ""}<button class="go" type="button">${arg.go}</button>`;
        ui.sheet.classList.add("on");
        await sleep(1500, gen);
        const go = ui.sheet.querySelector(".go");
        await tap(ui, go, gen);
        ui.sheet.classList.remove("on");
        await sleep(400, gen);
      } else if (kind === "user") {
        const msg = document.createElement("div");
        msg.className = "msg user";
        msg.innerHTML = `<div class="bubble">${arg}<span class="time">${clock()} ✓✓</span></div>`;
        ui.chat.appendChild(msg);
        scrollDown(ui);
        await sleep(700, gen);
      } else if (kind === "typing") {
        ui.status.textContent = "печатает…";
        ui.status.classList.add("typing");
        await sleep(800, gen);
        ui.status.textContent = "бот";
        ui.status.classList.remove("typing");
      } else if (kind === "intro") {
        const card = document.createElement("div");
        card.className = "intro-card";
        card.innerHTML = `${arg.cover ? '<div class="cover"></div>' : ""}<div class="ct">${arg.text}</div>`;
        if (arg.cover) card.querySelector(".cover").appendChild(coverNode(arg.cover));
        ui.chat.appendChild(card);
        const start = document.createElement("button");
        start.className = "start-btn";
        start.type = "button";
        start.textContent = "Запустить";
        ui.phone.querySelector(".tg-foot").replaceWith(start);
        await sleep(400, gen);
      } else if (kind === "start") {
        const start = ui.phone.querySelector(".start-btn");
        if (start) {
          await tap(ui, start, gen);
          start.replaceWith(footer());
        }
        ui.chat.innerHTML = "";
      } else if (kind === "wait") {
        await sleep(arg, gen);
      }
    }
  }

  function footer() {
    const div = document.createElement("div");
    div.className = "tg-foot";
    div.innerHTML = '<button class="menu-btn" type="button"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M4 7h16M4 12h16M4 17h16"/></svg>Меню</button><span class="field">Сообщение</span>';
    return div;
  }

  async function tap(ui, target, gen) {
    if (ui.chat.contains(target)) {
      const c = ui.chat.getBoundingClientRect();
      const t = target.getBoundingClientRect();
      if (t.bottom > c.bottom) ui.chat.scrollTop += t.bottom - c.bottom + 8;
    }
    await sleep(160, gen);
    const p = ui.phone.getBoundingClientRect();
    const r = target.getBoundingClientRect();
    ui.touch.style.left = `${r.left - p.left + r.width / 2}px`;
    ui.touch.style.top = `${r.top - p.top + r.height / 2}px`;
    ui.touch.classList.add("on");
    await sleep(320, gen);
    target.classList.add("press");
    const ripple = document.createElement("span");
    ripple.className = "ripple";
    target.appendChild(ripple);
    await sleep(200, gen);
    target.classList.remove("press");
    ui.touch.classList.remove("on");
    await sleep(160, gen);
    ripple.remove();
  }

  /* ── Wiring ── */
  const phones = { now: buildPhone(document.getElementById("phone-now")), next: buildPhone(document.getElementById("phone-next")) };
  let flow = "key";

  function resetPhone(side) {
    const host = document.getElementById(`phone-${side}`);
    phones[side] = buildPhone(host);
  }

  async function play() {
    generation += 1;
    const gen = generation;
    paused = false;
    document.getElementById("pause").textContent = "Пауза";
    resetPhone("now");
    resetPhone("next");
    const f = FLOWS[flow];
    document.getElementById("count-now").innerHTML = `До цели: <b>${f.clicks[0]}</b>`;
    document.getElementById("count-next").innerHTML = `До цели: <b>${f.clicks[1]}</b>`;
    try {
      await Promise.all([run(phones.now, f.now, false, gen), run(phones.next, f.next, true, gen)]);
      await sleep(1200, gen);
      if (gen === generation) play();
    } catch (err) {
      if (!(err instanceof Error) || err.message !== "restart") throw err;
    }
  }

  function bindSeg(id, onPick) {
    const seg = document.getElementById(id);
    seg.addEventListener("click", (event) => {
      const button = event.target.closest("button");
      if (!button) return;
      seg.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(b === button)));
      onPick(button.dataset.v);
    });
  }

  bindSeg("seg-flow", (v) => { flow = v; play(); });
  bindSeg("seg-theme", (v) => document.body.classList.toggle("light", v === "light"));
  bindSeg("seg-width", (v) => document.documentElement.style.setProperty("--w", `${v}px`));
  bindSeg("seg-full", (v) => document.getElementById("cover-grid").classList.toggle("full", v === "full"));
  document.getElementById("replay").addEventListener("click", play);
  document.getElementById("pause").addEventListener("click", (event) => {
    paused = !paused;
    event.currentTarget.textContent = paused ? "▶ Продолжить" : "Пауза";
  });
  document.addEventListener("click", (event) => {
    const quote = event.target.closest("blockquote.exp");
    if (quote) quote.classList.toggle("open");
  });

  /* Emoji pack sheet: every glyph at 20 / 32 / 100 px */
  const sheet = document.getElementById("emoji-sheet");
  if (sheet) {
    sheet.innerHTML = Object.keys(GLYPH).map((name) => `<div><span class="s20">${ce(name)}</span><span class="s32">${ce(name)}</span><span class="s100">${ce(name)}</span>${name}</div>`).join("");
  }

  /* #flow=buy&theme=light&w=360 opens the mock in that state (handy for screenshots) */
  const params = new URLSearchParams(location.hash.slice(1));
  const pick = (segId, value) => {
    const button = value && document.querySelector(`#${segId} button[data-v="${value}"]`);
    if (button) button.click();
  };
  pick("seg-theme", params.get("theme"));
  pick("seg-width", params.get("w"));
  if (params.get("flow") && FLOWS[params.get("flow")]) pick("seg-flow", params.get("flow"));
  else play();
})();
