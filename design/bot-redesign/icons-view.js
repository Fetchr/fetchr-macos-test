/* «Иконки» tab of the mock: the Fetchr Line pack at 20 / 32 / 100 px on dark and
   light chats, the three plan-icon directions and the icons in context
   (shop keyboard 2×2, plan card, shop cover), «Сейчас / Предлагаю». */
(function () {
  "use strict";

  const PACK = window.FETCHR_ICONS;
  const COVERS = window.FETCHR_COVERS || {};
  const view = document.getElementById("view-icons");
  if (!PACK || !view) return;

  const PLAN_IDS = ["free", "mini", "start", "streamer"];
  const PLAN_NAME = { free: "Free · 5 ГБ", mini: "Мини · 20 ГБ", start: "Старт · 50 ГБ", streamer: "Стример · 150 ГБ" };
  const NOW_ICON = { free: "🌱", mini: "🔹", start: "🔷", streamer: "🔥" };
  let dir = "B";

  const sized = (svg, px) => svg.replace(/width="100" height="100"/, `width="${px}" height="${px}"`);
  const mono = (inner, px) => `<svg viewBox="0 0 24 24" width="${px}" height="${px}">${inner}</svg>`;
  const tileInline = (svg) => `<span class="ce2">${svg}</span>`;

  /* 24-grid overlay for a 100 px tile: the glyph sits at 14 px offset, 3 px per unit */
  const GRID = (() => {
    const lines = [];
    for (let i = 0; i <= 24; i += 1) {
      const p = 14 + i * 3;
      const strong = i % 12 === 0 ? 0.5 : i === 2 || i === 22 ? 0.4 : 0.14;
      lines.push(`<path d="M${p} 14V86M14 ${p}H86" stroke="#ff4fd8" stroke-opacity="${strong}" stroke-width="0.5"/>`);
    }
    return `<svg class="ic-gridov" viewBox="0 0 100 100" width="100" height="100">${lines.join("")}</svg>`;
  })();

  function side(theme, tile, glyphMono, label, big = 100) {
    return `<div class="ic-side ${theme}">
      <div class="ic-sizes">${sized(tile, 20)}${sized(tile, 32)}<span class="t100" style="width:${big}px;height:${big}px">${sized(tile, big)}${GRID.replace(/width="100" height="100"/, `width="${big}" height="${big}"`)}</span></div>
      <div class="ic-line">${label ? `${tileInline(tile)} ${label}` : ""}</div>
      <span class="ic-btn">${mono(glyphMono, 18)}Кнопка</span>
    </div>`;
  }

  /* Construction: four glyphs at 168 px with the 24 grid, keylines and live area */
  function construct() {
    const keylines = '<rect x="2" y="2" width="20" height="20" fill="none" stroke="#ff4fd8" stroke-opacity=".55" stroke-width=".08" stroke-dasharray=".4 .4"/>' +
      '<circle cx="12" cy="12" r="9" fill="none" stroke="#ff4fd8" stroke-opacity=".35" stroke-width=".08"/>' +
      '<rect x="3" y="3" width="18" height="18" rx="2.5" fill="none" stroke="#ff4fd8" stroke-opacity=".35" stroke-width=".08"/>';
    const grid = Array.from({ length: 25 }, (_, i) => `<path d="M${i} 0V24M0 ${i}H24" stroke="#f3f6fb" stroke-opacity="${i % 12 === 0 ? 0.12 : 0.05}" stroke-width=".05"/>`).join("");
    const items = [["key", PACK.service.key.glyph], ["archive", PACK.service.archive.glyph], ["chat", PACK.service.chat.glyph], ["live", PACK.service.live.glyph], ["plan B · Стример", PACK.plans["B-streamer"].glyph]];
    document.getElementById("ic-construct").innerHTML = items.map(([name, g]) => `<figure><svg viewBox="-1 -1 26 26">${grid}${keylines}${g}</svg><figcaption>${name}</figcaption></figure>`).join("") +
      '<p style="flex-basis:100%;margin:0;color:var(--text-3);font-size:13px">Розовым: поле 2 px (пунктир), круг Ø18 и квадрат 18 с радиусом 2,5 — общие опорные фигуры, по ним выравнивается оптический вес.</p>';
  }

  function serviceTable() {
    const sample = { key: "Ключ готов", archive: "Архив VPS", check: "Оплачено", live: "Запись идёт", error: "ID не подошёл", chat: "Поддержка" };
    document.getElementById("ic-service").innerHTML = Object.entries(PACK.service).map(([name, icon], i) => `
      <div class="ic-cell" style="--i:${i}">
        <header><b>${name} ${icon.emoji}</b><span title="${icon.use}">${icon.use}</span></header>
        ${side("dark", icon.tile, icon.mono, sample[name] || "")}
        ${side("light", icon.tile, icon.mono, sample[name] || "")}
      </div>`).join("");
  }

  function directions() {
    document.getElementById("ic-dirs").innerHTML = ["B", "A", "C"].map((d) => {
      const info = PACK.directions[d];
      const plans = PLAN_IDS.map((id, i) => {
        const p = PACK.plans[`${d}-${id}`];
        return `<div class="ic-plan" style="--i:${i}"><b>${PLAN_NAME[id]}</b>${side("dark", p.tile, p.mono, "", 48)}${side("light", p.tile, p.mono, "", 48)}</div>`;
      }).join("");
      return `<section class="ic-dir ${d === dir ? "on" : ""}"><h4>${d} · ${info.name}${d === "B" ? " — рекомендую" : ""}</h4><p>${info.idea}</p><div class="row4">${plans}</div></section>`;
    }).join("");
    document.getElementById("ic-terms").innerHTML = Object.entries(PACK.terms).map(([m, t]) => `<figure>${sized(t.tile, 64)}${sized(t.tile, 20)}<figcaption>${m} мес</figcaption></figure>`).join("") +
      '<p style="flex-basis:100%;margin:0;color:var(--text-3);font-size:13px">Кольцо заполняется долей года; 12 мес — полный круг с галочкой. В кнопках срока текст «1 / 3 / 6 / 12 мес» и так понятен: иконки сроков — для обложек и чипов, не обязательны.</p>';
  }

  /* ── context ── */
  function kb(rows) {
    return `<div class="kb">${rows.map((row) => `<div class="row">${row.map(([label, cls = "", icon = ""]) =>
      `<button type="button" class="${cls}">${icon ? `<span class="ce ce-mono">${mono(icon, 18)}</span>` : ""}<span class="t">${label}</span></button>`).join("")}</div>`).join("")}</div>`;
  }
  function bubble(cover, caption, rows) {
    const coverHtml = cover.startsWith("svg:")
      ? `<div class="cover"><div>${(COVERS[cover.slice(4)] || "").replace(/id="(grid|gridFade|gridMask)"/g, `id="$1-ic${cover.length}"`).replace(/url\(#(grid|gridFade|gridMask)\)/g, `url(#$1-ic${cover.length})`)}</div></div>`
      : `<div class="cover"><img src="${cover}" alt=""></div>`;
    return `<div class="msg"><div class="bubble">${coverHtml}<div class="caption">${caption}<span class="time">12:04</span></div></div>${kb(rows)}</div>`;
  }

  function context() {
    const p = (id) => PACK.plans[`${dir}-${id}`];
    const s = (name) => PACK.service[name];
    const now = bubble("current/shop-1.png", "🛒 <b>Магазин</b>\n\nСервер записывает эфиры, пока компьютер выключен.\n<i>Цены за 30 дней.</i>",
      [[["🌱 Free · 5 ГБ · бесплатно"]], [["🔹 Мини · 20 ГБ · 100 ₽"]], [["🔷 Старт · 50 ГБ · 200 ₽"]], [["🔥 Стример · 150 ГБ · 500 ₽", "primary"]], [["➕ Доп. услуги · память, стримеры, рестрим", "success"]], [["‹ Назад"]]]) +
      bubble("current/shop-3.png", '🔥 <b>Стример</b>\n\n💾 <b>150 ГБ</b> · ≈ 52 ч эфира · 2 стримера разом\n🗓 1 месяц — <b>500 ₽</b>\n\n<i>Карта, СБП, Яндекс Пэй, T-Pay или звёзды Telegram. <a href="#">Оферта</a></i>',
        [[["🗓 1 месяц · сменить срок"]], [["💳 Оплатить 500 ₽", "success"]], [["⭐ Звёздами · 313"]], [["‹ Тарифы"], ["📄 Условия"]]]);
    const next = bubble(`svg:shop-${dir}`, `${tileInline(s("archive").tile)} <b>Архив VPS</b> — сервер пишет эфир с чатом, даже когда ПК выключен.\n<i>Цены за 30 дней, в рублях. За год — −20%.</i>`,
      [[["Free · 0 ₽", "", p("free").mono], ["Мини · 100 ₽", "", p("mini").mono]], [["Старт · 200 ₽", "", p("start").mono], ["Стример · 500 ₽", "primary", p("streamer").mono]], [["Память, стримеры, рестрим", "", s("plus").mono]], [["Назад", "", s("back").mono]]]) +
      bubble(`svg:plan-1-${dir}`, `${tileInline(p("streamer").tile)} <b>Стример</b> · 150 ГБ · ≈ 52 ч эфира · 2 стримера\n\nСрок: <b>1 месяц — 500 ₽</b>\n<i>3 мес −5% · 6 мес −10% · 12 мес −20%.</i>`,
        [[["✓ 1 мес", "", PACK.terms[1].mono], ["3 мес", "", PACK.terms[3].mono], ["6 мес", "", PACK.terms[6].mono], ["12 мес", "", PACK.terms[12].mono]], [["+10 ГБ · 30 ₽/мес", "", s("memory").mono]], [["Оплатить 500 ₽", "success url", s("card").mono]], [["Тарифы", "", s("back").mono], ["Условия", "", s("doc").mono]]]);
    document.getElementById("ic-context").innerHTML = `<section><h3>Сейчас</h3><div class="ic-chat">${now}</div></section><section><h3>Предлагаю · ${dir} ${PACK.directions[dir].name}</h3><div class="ic-chat">${next}</div></section>`;
  }

  function render() {
    directions();
    context();
  }

  /* ── wiring ── */
  function seg(id, onPick) {
    const node = document.getElementById(id);
    node.addEventListener("click", (event) => {
      const button = event.target.closest("button");
      if (!button) return;
      node.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(b === button)));
      onPick(button.dataset.v);
    });
    return node;
  }
  const flows = document.getElementById("view-flows");
  seg("seg-view", (v) => {
    flows.hidden = v !== "flows";
    view.hidden = v !== "icons";
  });
  seg("seg-ibg", (v) => view.classList.toggle("grid", v === "grid"));
  seg("seg-dir", (v) => { dir = v; render(); });

  construct();
  serviceTable();
  render();

  const wanted = new URLSearchParams(location.hash.slice(1)).get("view");
  if (wanted === "icons") document.querySelector('#seg-view button[data-v="icons"]').click();
  const wantedDir = new URLSearchParams(location.hash.slice(1)).get("dir");
  if (wantedDir) document.querySelector(`#seg-dir button[data-v="${wantedDir}"]`)?.click();
})();
