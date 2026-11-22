/** «Fetchr Line» glyphs for the bot's pictures (source of truth for the
 *  design: design/bot-redesign/icons.mjs). 24 px grid, stroke 2, round caps
 *  and joins, one accent element and one soft tone fill per glyph; flat, in
 *  the fetchr.fun language. Plan icons are direction B «Ячейка»: one storage
 *  cell that fills to the plan's quota. */

export const INK = {
  fg: "#f3f6fb",
  accent: "#3d7dff",
  success: "#2fd49b",
  warning: "#f2a93b",
  danger: "#f0506e",
  tile: "#1f2531",
  tileLine: "rgba(243,246,251,0.14)",
};

export const GLYPHS = {
  key: {
    base: '<circle cx="7.5" cy="16.5" r="4.5"/><path d="M10.7 13.3 20.5 3.5"/><path d="m17 7 2.5 2.5"/>',
    accent: '<path d="m14 10 2 2"/>',
    dot: '<circle cx="7.5" cy="16.5" r="1.6"/>',
    tone: '<circle cx="7.5" cy="16.5" r="4.5"/>',
    emoji: "🔑", use: "Получить ключ, Мой ключ, строка ключа",
  },
  archive: {
    base: '<rect x="3" y="3.5" width="18" height="7.5" rx="2.5"/><rect x="3" y="13" width="18" height="7.5" rx="2.5"/><path d="M11 16.75h6"/>',
    accent: '<path d="M11 7.25h6"/>',
    dot: '<circle cx="7" cy="7.25" r="1.5"/><circle cx="7" cy="16.75" r="1.5"/>',
    tone: '<rect x="3" y="3.5" width="18" height="7.5" rx="2.5"/>',
    emoji: "🗄", use: "Архив VPS, тарифы",
  },
  restream: {
    base: '<path d="M16.2 7.8a6 6 0 0 1 0 8.4"/><path d="M7.8 16.2a6 6 0 0 1 0-8.4"/>',
    accent: '<path d="M19.4 4.6a10.5 10.5 0 0 1 0 14.8"/><path d="M4.6 19.4a10.5 10.5 0 0 1 0-14.8"/>',
    dot: '<circle cx="12" cy="12" r="2.4"/>',
    tone: '<circle cx="12" cy="12" r="5"/>',
    emoji: "📡", use: "Рестрим, апселл после оплаты",
  },
  card: {
    base: '<rect x="2.5" y="5" width="19" height="14" rx="2.5"/><path d="M2.5 9.5h19"/>',
    accent: '<path d="M6 15h4"/>',
    tone: '<rect x="2.5" y="5" width="19" height="4.5"/>',
    emoji: "💳", use: "Оплатить",
  },
  copy: {
    base: '<rect x="9" y="9" width="12" height="12" rx="2.5"/><path d="M15 9V5.5A2.5 2.5 0 0 0 12.5 3h-7A2.5 2.5 0 0 0 3 5.5v7A2.5 2.5 0 0 0 5.5 15H9"/>',
    accent: '<path d="M12.5 15h5"/>',
    tone: '<rect x="9" y="9" width="12" height="12" rx="2.5"/>',
    emoji: "📋", use: "Скопировать ключ (copy_text)",
  },
  check: {
    base: '<circle cx="12" cy="12" r="9"/>',
    accent: '<path d="m7.8 12.3 2.8 2.8 5.6-5.8"/>',
    tone: '<circle cx="12" cy="12" r="9"/>',
    hue: "success", emoji: "✅", use: "Ключ активен, оплачено, подписка есть",
  },
  live: {
    base: '<rect x="2.5" y="5" width="19" height="14" rx="2.5"/>',
    accent: '<path d="M6 16.5h3"/>',
    dot: '<circle cx="12" cy="11" r="3.2"/>',
    tone: '<circle cx="12" cy="11" r="5.5"/>',
    hue: "danger", emoji: "🔴", use: "Запись идёт, LIVE",
  },
  spark: {
    base: '<path d="M11 4.5 13 10l5.5 2-5.5 2-2 5.5-2-5.5-5.5-2L9 10z"/>',
    accent: '<path d="M18.5 2.5v4"/><path d="M16.5 4.5h4"/>',
    tone: '<path d="M11 4.5 13 10l5.5 2-5.5 2-2 5.5-2-5.5-5.5-2L9 10z"/>',
    emoji: "✨", use: "Популярный тариф, новое",
  },
  chat: {
    base: '<path d="M20.5 15a2.5 2.5 0 0 1-2.5 2.5H8.5l-5 4V6A2.5 2.5 0 0 1 6 3.5h12A2.5 2.5 0 0 1 20.5 6z"/><path d="M8 13h5"/>',
    accent: '<path d="M8 9h8"/>',
    tone: '<path d="M20.5 15a2.5 2.5 0 0 1-2.5 2.5H8.5l-5 4V6A2.5 2.5 0 0 1 6 3.5h12A2.5 2.5 0 0 1 20.5 6z"/>',
    emoji: "💬", use: "Поддержка, ответ поддержки",
  },
  channel: {
    base: '<path d="M21 3.5 3 10.5l6.5 2.5 2.5 6.5 3.5-4.5 4.5 3.5z"/>',
    accent: '<path d="m9.5 13 11.5-9.5"/>',
    tone: '<path d="M21 3.5 3 10.5l6.5 2.5 2.5 6.5 3.5-4.5 4.5 3.5z"/>',
    emoji: "📢", use: "Канал, подписка",
  },
  home: {
    base: '<path d="M3.5 10.5 12 3.5l8.5 7V19a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/>',
    accent: '<path d="M9.5 21v-4.5a2.5 2.5 0 0 1 5 0V21"/>',
    tone: '<path d="M3.5 10.5 12 3.5l8.5 7V19a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/>',
    emoji: "🏠", use: "Меню",
  },
  doc: {
    base: '<path d="M14 2.5H7a2.5 2.5 0 0 0-2.5 2.5v14A2.5 2.5 0 0 0 7 21.5h10a2.5 2.5 0 0 0 2.5-2.5V8z"/><path d="M14 2.5V8h5.5"/><path d="M8.5 17h4"/>',
    accent: '<path d="M8.5 13h7"/>',
    tone: '<path d="M14 2.5H7a2.5 2.5 0 0 0-2.5 2.5v14A2.5 2.5 0 0 0 7 21.5h10a2.5 2.5 0 0 0 2.5-2.5V8z"/>',
    emoji: "📄", use: "Условия, оферта",
  },
  plus: {
    base: '<circle cx="12" cy="12" r="9"/>',
    accent: '<path d="M12 8v8"/><path d="M8 12h8"/>',
    tone: '<circle cx="12" cy="12" r="9"/>',
    emoji: "➕", use: "Доп. услуги, +10 ГБ",
  },
  minus: {
    base: '<circle cx="12" cy="12" r="9"/>',
    accent: '<path d="M8 12h8"/>',
    tone: '<circle cx="12" cy="12" r="9"/>',
    emoji: "➖", use: "Счётчики допов",
  },
  play: {
    base: '<circle cx="12" cy="12" r="9"/>',
    dot: '<path d="M10 8.3v7.4a.6.6 0 0 0 .9.5l5.6-3.7a.6.6 0 0 0 0-1l-5.6-3.7a.6.6 0 0 0-.9.5z"/>',
    tone: '<circle cx="12" cy="12" r="9"/>',
    emoji: "▶️", use: "Как начать запись",
  },
  back: {
    base: '<path d="M20 12H5"/>',
    accent: '<path d="M11 5.5 4.5 12l6.5 6.5"/>',
    emoji: "⬅️", use: "Назад (только в кнопках, adaptive)",
  },
  wait: {
    base: '<circle cx="12" cy="12" r="9"/>',
    accent: '<path d="M12 7.5V12l3 2"/>',
    tone: '<circle cx="12" cy="12" r="9"/>',
    emoji: "⏳", use: "Ждём Machine ID, ждём эфир, осталось N дней",
  },
  error: {
    base: '<path d="M10.3 4.3a2 2 0 0 1 3.4 0l7.5 12.9a2 2 0 0 1-1.7 3H4.5a2 2 0 0 1-1.7-3z"/>',
    accent: '<path d="M12 9.5v4"/>',
    dot: '<circle cx="12" cy="16.8" r="1.25"/>',
    tone: '<path d="M10.3 4.3a2 2 0 0 1 3.4 0l7.5 12.9a2 2 0 0 1-1.7 3H4.5a2 2 0 0 1-1.7-3z"/>',
    hue: "warning", emoji: "⚠️", use: "Ошибка, ID не подошёл, сервер не отвечает",
  },
  gift: {
    base: '<path d="M4 11.5h16V19a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z"/><rect x="2.5" y="7.5" width="19" height="4" rx="1.5"/><path d="M12 7.5V21"/>',
    accent: '<path d="M12 7.5C10.5 4 7 3.5 7 5.8c0 1.2 1.6 1.7 5 1.7"/><path d="M12 7.5c1.5-3.5 5-4 5-1.7 0 1.2-1.6 1.7-5 1.7"/>',
    tone: '<path d="M4 11.5h16V19a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z"/>',
    emoji: "🎁", use: "Free, бонус, рефералка",
  },
  calendar: {
    base: '<rect x="3" y="4.5" width="18" height="16.5" rx="2.5"/><path d="M3 9.5h18"/><path d="M8 2.5v4"/><path d="M16 2.5v4"/>',
    dot: '<rect x="7" y="13" width="3.5" height="3.5" rx="1"/>',
    tone: '<rect x="3" y="4.5" width="18" height="5"/>',
    emoji: "🗓", use: "Срок тарифа",
  },
  device: {
    base: '<rect x="2.5" y="3.5" width="19" height="13" rx="2.5"/><path d="M12 16.5v4"/><path d="M8.5 20.5h7"/>',
    accent: '<path d="M6.5 12.5h5"/>',
    tone: '<rect x="2.5" y="3.5" width="19" height="13" rx="2.5"/>',
    emoji: "💻", use: "Machine ID, устройство",
  },
  lock: {
    base: '<rect x="4.5" y="10.5" width="15" height="11" rx="2.5"/><path d="M8 10.5v-3a4 4 0 0 1 8 0v3"/>',
    accent: '<path d="M12 14.5V17"/>',
    tone: '<rect x="4.5" y="10.5" width="15" height="11" rx="2.5"/>',
    emoji: "🔒", use: "Одно устройство, лимит",
  },
  refresh: {
    base: '<path d="M20 12a8 8 0 0 1-14.2 5"/><path d="M4 12a8 8 0 0 1 14.2-5"/>',
    accent: '<path d="M18.5 2.5V7H14"/><path d="M5.5 21.5V17H10"/>',
    emoji: "🔄", use: "Проверить оплату, Я подписался",
  },
  user: {
    base: '<circle cx="12" cy="8.5" r="4.5"/><path d="M4 21a8 8 0 0 1 16 0"/>',
    tone: '<circle cx="12" cy="8.5" r="4.5"/>',
    accent: '<path d="M10 9.5a2.5 2.5 0 0 0 4 0"/>',
    emoji: "👤", use: "Стример (доп. канал), кабинет",
  },
  memory: {
    base: '<ellipse cx="12" cy="6" rx="8" ry="3"/><path d="M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6"/>',
    accent: '<path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/>',
    tone: '<ellipse cx="12" cy="6" rx="8" ry="3"/>',
    emoji: "💾", use: "Память, +10 ГБ",
  },
  mute: {
    base: '<path d="M11 4.5 6.5 8.5h-3v7h3l4.5 4z"/>',
    accent: '<path d="m15.5 9.5 5 5"/><path d="m20.5 9.5-5 5"/>',
    tone: '<path d="M11 4.5 6.5 8.5h-3v7h3l4.5 4z"/>',
    emoji: "🔇", use: "Мат заглушён (drip, советы)",
  },
  clip: {
    base: '<circle cx="6" cy="6.5" r="3"/><circle cx="6" cy="17.5" r="3"/>',
    accent: '<path d="M8.5 8.2 20 17"/><path d="M8.5 15.8 20 7"/>',
    tone: '<circle cx="6" cy="6.5" r="3"/><circle cx="6" cy="17.5" r="3"/>',
    emoji: "✂️", use: "Клип готов, нарезка",
  },
  trash: {
    base: '<path d="M5.5 7h13l-1 12.5a2 2 0 0 1-2 1.5h-7a2 2 0 0 1-2-1.5z"/><path d="M3.5 7h17"/><path d="M9 7V4.5h6V7"/>',
    accent: '<path d="M10 11v6"/><path d="M14 11v6"/>',
    tone: '<path d="M5.5 7h13l-1 12.5a2 2 0 0 1-2 1.5h-7a2 2 0 0 1-2-1.5z"/>',
    hue: "danger", emoji: "🗑", use: "Удалить площадку",
  },
};


/** B «Ячейка»: Free 5 ГБ → Мини 20 → Старт 50 → Стример 150, a full cell. */
const PLAN_LEVEL = { free: 0, mini: 1, start: 2, streamer: 3 };

export function planGlyph(planId) {
  const level = PLAN_LEVEL[planId] ?? 1;
  const fill = [2, 4.5, 8, 14][level];
  const y = 19 - fill;
  return {
    base: '<rect x="3" y="3" width="18" height="18" rx="3.5"/>',
    dot: `<rect x="5.5" y="${y.toFixed(1)}" width="13" height="${(fill - 0.5).toFixed(1)}" rx="1.5"/>`,
    tone: '<rect x="3" y="3" width="18" height="18" rx="3.5"/>',
    accent: level === 3 ? '<path d="M8 8.5h8"/>' : "",
  };
}

export function glyphSvg(g, { mono = false, stroke = 2, color = INK.fg } = {}) {
  const fg = mono ? "#fff" : color;
  const hue = mono ? "#fff" : INK[g.hue || "accent"];
  const sw = `stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round"`;
  return [
    g.tone ? `<g fill="${hue}" fill-opacity="${mono ? 0.28 : 0.22}" stroke="none">${g.tone}</g>` : "",
    g.ghost ? `<g fill="none" stroke="${fg}" stroke-opacity="0.32" ${sw}>${g.ghost}</g>` : "",
    g.ghostFill ? `<g fill="${fg}" fill-opacity="0.2" stroke="none">${g.ghostFill}</g>` : "",
    g.base ? `<g fill="none" stroke="${fg}" ${sw}${g.ghostBase ? ' stroke-opacity="0.45"' : ""}>${g.base}</g>` : "",
    g.extra ? `<g fill="none" stroke="${fg}" ${sw}>${g.extra}</g>` : "",
    g.accent ? `<g fill="none" stroke="${hue}" ${sw}>${g.accent}</g>` : "",
    g.dot ? `<g fill="${hue}" stroke="none">${g.dot}</g>` : "",
  ].join("");
}


/** A glyph placed at (x, y), `size` px square, on a 1280×720 picture. */
export function glyphAt(glyph, x, y, size, options) {
  return `<g transform="translate(${x} ${y}) scale(${(size / 24).toFixed(3)})">${glyphSvg(glyph, options)}</g>`;
}
