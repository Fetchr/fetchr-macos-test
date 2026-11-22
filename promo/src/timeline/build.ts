import { cue, EASE, flash, hideLines, onFrame, revealLines, typeText, type Scope, type Timeline } from "../lib/motion";
import { cameraTo, placeNav } from "./camera";
import { b } from "./schedule";

/** Центры карточек «И ещё» на сцене: пресеты, палитра, логи */
const CARD_CENTERS = { presets: 410, palette: 960, logs: 1510 };
const CARD_CY = 520;

/** Наезд слоя карточек так, чтобы карточка встала в центр кадра */
function focusCard(tl: Timeline, $: Scope, cx: number, at: number, scale = 1.32, rotationY = 0) {
  cue("cam", at, { dur: 0.8 });
  tl.to($.one("pc"), { x: (960 - cx) * scale, y: (540 - CARD_CY) * scale, scale, rotationY, duration: 0.85, ease: "expo.inOut" }, at);
}

/**
 * Подъём (доли 144–160): окно уходит в глубину, вперёд выходят палитра,
 * пресеты и логи — камера перескакивает между ними всё быстрее. Последние
 * четыре доли — нарезка всех вкладок по полдоли под нарастающий подъём.
 */
export function buildBuild(tl: Timeline, $: Scope) {
  const T = b(144);
  const cards = $.all("pc.card");
  const [palette, presets, logs] = cards;

  cue("recede", b(143.4), { dur: 0.9 });
  cameraTo(tl, $, b(143.4), { x: 0, y: 60, scale: 0.5, rotationX: 18, rotationY: 0, rotation: 0, opacity: 0 }, 0.9, "power3.in");
  tl.to($.one("bd.floor"), { opacity: 0, duration: 0.6 }, b(143.5));
  revealLines(tl, $.all("pw.line"), T + 0.1);

  // Веер карточек
  const poses = [
    { card: presets, rotationY: 16, z: -60, order: 1 },
    { card: palette, rotationY: 0, z: 40, order: 0 },
    { card: logs, rotationY: -16, z: -60, order: 2 },
  ];
  poses.forEach(({ card, rotationY, z, order }, index) => {
    const at = T + 0.1 + order * 0.12;
    cue("card", at, { n: index });
    tl.fromTo(card, { opacity: 0, y: 140, rotationX: 26, rotationY, z: z - 260 }, { opacity: 1, y: 0, rotationX: 0, rotationY, z, duration: 1.1, ease: EASE.cine, immediateRender: false }, at);
  });
  onFrame((time) => {
    if (time < T + 1.3 || time > b(155)) return;
    cards.forEach((card, index) => {
      card.style.translate = `0 ${Math.sin((time - T) * 1.6 + index * 1.9) * 6}px`;
    });
  });

  // Палитра: «блюр» — лишнее схлопывается
  focusCard(tl, $, CARD_CENTERS.palette, b(146));
  tl.add(typeText($.one("pc.query"), "блюр", { duration: 0.45 }), b(146.8));
  cue("type", b(146.8), { dur: 0.45, n: 4 });
  cue("filter", b(147.5));
  cue("select", b(148));
  const drops = [...$.all("pc.drop"), $.one("pc.dropGroup")];
  tl.to(drops, { opacity: 0, height: 0, paddingTop: 0, paddingBottom: 0, duration: 0.45, ease: EASE.cine, stagger: 0.03 }, b(147.5))
    .to($.one("pc.match.hi"), { opacity: 1, duration: 0.25 }, b(148));

  // Пресеты
  focusCard(tl, $, CARD_CENTERS.presets, b(148.6), 1.32, 10);
  tl.fromTo($.all("pc.preset"), { opacity: 0, scale: 0.9 }, { opacity: 1, scale: 1, duration: 0.35, stagger: 0.07, ease: "back.out(1.8)", immediateRender: false }, b(149.2));
  $.all("pc.preset").forEach((_, index) => cue("check", b(149.2) + index * 0.07, { n: index, gain: 0.6 }));

  // Логи
  focusCard(tl, $, CARD_CENTERS.logs, b(151.2), 1.32, -10);
  const logLines = $.all("pc.log");
  tl.fromTo(logLines, { opacity: 0, y: 10 }, { opacity: 1, y: 0, duration: 0.3, stagger: 0.2, ease: EASE.out, immediateRender: false }, b(151.6));
  logLines.forEach((_, index) => cue("log", b(151.6) + index * 0.2, { n: index }));

  // Общий план и уход
  focusCard(tl, $, 960, b(153.6), 1);
  tl.fromTo($.all("pw.item"), { opacity: 0, y: 14 }, { opacity: 1, y: 0, duration: 0.5, stagger: 0.1, ease: EASE.out, immediateRender: false }, b(153.8));
  hideLines(tl, $.all("pw.line"), b(155.2));
  tl.to(cards, { opacity: 0, y: -60, scale: 0.9, duration: 0.45, stagger: 0.05, ease: "power2.in" }, b(155.2)).to(
    $.all("pw.item"),
    { opacity: 0, y: -8, duration: 0.35, stagger: 0.03, ease: "power2.in" },
    b(155.3),
  );

  buildTabStutter(tl, $);
}

/** Вкладки нарезкой: каждая полдоли — новый раздел, камера всё ближе */
const STUTTER = ["queue", "live", "vps", "finder", "chat", "blur", "mute", "vocal"] as const;

function buildTabStutter(tl: Timeline, $: Scope) {
  const rig = $.one("rig");
  const pill = $.one("nav.pill");
  const views = ["queue", "live", "vps", "finder", "chat", "blur", "mute", "vocal", "ws"].map((id) => $.one(`view.${id}`));

  STUTTER.forEach((id, index) => {
    const at = b(156 + index * 0.5);
    const scale = 0.86 + index * 0.035;
    cue("tab", at, { gain: 0.6 + index * 0.05 });
    flash(tl, $, at, 0.18 + index * 0.03, 0.22);
    tl.set(views, { autoAlpha: 0 }, at)
      .set($.one(`view.${id}`), { autoAlpha: 1, y: 0 }, at)
      .set(pill, { ...placeNav($, id), opacity: 1 }, at)
      .fromTo(
        rig,
        { x: 0, y: 24, scale: scale + 0.05, rotationX: 0, rotationY: 0, rotation: index % 2 ? 1.4 : -1.4, opacity: 1 },
        { scale, rotation: index % 2 ? 0.6 : -0.6, duration: 0.28, ease: "expo.out", immediateRender: false },
        at,
      );
  });
  // Все подписи вкладок гаснут, кроме активной
  const tabs = STUTTER.map((id) => $.one(`nav.${id}`));
  STUTTER.forEach((id, index) => {
    const at = b(156 + index * 0.5);
    tl.set(tabs, { color: "#9aa4b1" }, at).set($.one(`nav.${id}`), { color: "#e9edf2" }, at);
  });

  // Тишина перед дропом: всё гаснет в чёрный
  tl.set(rig, { opacity: 0 }, b(160));
  tl.to([$.one("bd.a"), $.one("bd.b")], { opacity: 0.25, duration: 0.3 }, b(160));
}
