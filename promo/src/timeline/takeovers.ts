import { BLUR_ZONES } from "../components/Takeovers";
import { caption, counter, cue, EASE, flash, gsap, onFrame, swapText, type Scope, type Timeline } from "../lib/motion";
import { noise1d } from "../lib/procedural";
import { b } from "./schedule";

/** Показ полноэкранной сцены: удар вспышкой и наезд с расфокуса */
function enter(tl: Timeline, $: Scope, id: string, at: number) {
  flash(tl, $, at, 0.75, 0.45);
  tl.set($.one(id), { autoAlpha: 1 }, at).fromTo(
    $.one(`${id}.scene`),
    { scale: 1.22, filter: "blur(14px)" },
    { scale: 1.04, filter: "blur(0px)", duration: 0.9, ease: "expo.out", immediateRender: false },
    at,
  );
  tl.set($.one(`${id}.scene`), { filter: "none" }, at + 0.95);
}

function leave(tl: Timeline, $: Scope, id: string, at: number) {
  tl.set($.one(id), { autoAlpha: 0 }, at);
}

function shade(tl: Timeline, $: Scope, from: number, to: number) {
  const layer = $.one("cap.shade.bottom");
  tl.fromTo(layer, { opacity: 0 }, { opacity: 1, duration: 0.4, ease: "power1.out", immediateRender: false }, from).to(layer, { opacity: 0, duration: 0.3 }, to);
}

/**
 * Блюр на весь кадр (доли 96–104): реклама въезжает в стрим, луч ИИ
 * проходит по кадру, зоны ложатся на баннер и два оверлея, трекер ведёт
 * баннер, и на сильную долю всё размывается.
 */
export function buildBlurTakeover(tl: Timeline, $: Scope) {
  const T = b(96);
  enter(tl, $, "tb", T);
  tl.to($.one("tb.scene"), { scale: 1.1, x: -30, duration: b(104) - T - 0.9, ease: "none" }, T + 0.9);

  // Интеграция появляется поверх стрима
  cue("toast", b(96.5));
  tl.fromTo($.one("tb.bannerMove"), { x: 260, opacity: 0, rotationY: -30 }, { x: 0, opacity: 1, rotationY: 0, duration: 0.6, ease: "back.out(1.4)" }, b(96.5));

  // Луч ИИ по кадру
  cue("scan", b(97.5), { dur: b(98.5) - b(97.5) });
  tl.fromTo($.one("tb.scan"), { x: -240, opacity: 1 }, { x: 1940, duration: b(98.5) - b(97.5), ease: "power1.inOut", immediateRender: false }, b(97.5)).to(
    $.one("tb.scan"),
    { opacity: 0, duration: 0.15 },
    b(98.5),
  );

  // Зоны ложатся одна за другой — на доли
  BLUR_ZONES.forEach((zone, index) => {
    const at = b(98.5 + index * 0.5);
    cue("detect", at, { n: index });
    tl.fromTo(
      $.one(`tb.zone.${zone.id}`),
      { opacity: 0, scale: 1.35 },
      { opacity: 1, scale: 1, duration: 0.4, ease: "back.out(2)", immediateRender: false },
      at,
    );
  });

  // Трекинг: баннер плывёт, зона держится за ним, кадры считаются
  const track = { from: b(99.5), to: b(102) };
  cue("track", track.from, { dur: track.to - track.from });
  tl.to([$.one("tb.bannerMove"), $.one("tb.zone.banner")], { x: 110, y: -36, duration: track.to - track.from, ease: "sine.inOut" }, track.from);
  BLUR_ZONES.forEach((zone, index) => {
    const frames = [3380, 2140, 2140][index];
    tl.add(counter($.one(`tb.zone.${zone.id}.frames`), 0, frames, (v) => `${Math.round(v).toLocaleString("ru-RU")} кадров`, { duration: track.to - track.from, ease: "power1.inOut" }), track.from);
  });
  tl.fromTo($.one("tb.hud"), { opacity: 0, y: -16 }, { opacity: 1, y: 0, duration: 0.5, ease: EASE.out }, b(98))
    .fromTo($.one("tb.hud.fill"), { scaleX: 0 }, { scaleX: 1, duration: track.to - track.from, ease: "power1.inOut", immediateRender: false }, track.from);

  // Удар: всё размыто, звук интеграции заглушён
  const blurAt = b(102);
  cue("blur", blurAt);
  cue("muteCut", blurAt + 0.1);
  tl.to($.one("tb.banner"), { filter: "blur(26px) saturate(0.7)", duration: 0.5, ease: "power2.out" }, blurAt)
    .to(BLUR_ZONES.slice(1).map((zone) => $.one(`tb.frost.${zone.id}`)), { opacity: 1, duration: 0.4, ease: "power2.out" }, blurAt)
    .to(BLUR_ZONES.map((zone) => $.one(`tb.zone.${zone.id}`)), { borderStyle: "dashed", backgroundColor: "rgba(167,139,250,0.02)", duration: 0.01 }, blurAt)
    .fromTo($.one("tb.muted"), { opacity: 0, y: 6 }, { opacity: 1, y: 0, duration: 0.4, ease: EASE.out, immediateRender: false }, blurAt + 0.2)
    .fromTo($.one("tb.scene"), { x: -30 }, { x: -18, duration: 0.12, ease: "power2.out", yoyo: true, repeat: 1, immediateRender: false }, blurAt);
  const state = $.one("tb.hud.state");
  onFrame((time) => {
    state.textContent = time < blurAt ? "ИИ-трекер" : "Готово";
  });

  caption(tl, $, "blur", b(97), b(103.4));
  shade(tl, $, b(96.6), b(103.7));
  leave(tl, $, "tb", b(104));
}

/**
 * Чат на весь кадр (доли 104–112): стрим xQc, справа сообщения каждые
 * полдоли, внизу плашка рендера добегает до «готово».
 */
export function buildChatTakeover(tl: Timeline, $: Scope) {
  const T = b(104);
  enter(tl, $, "tc", T);
  tl.to($.one("tc.scene"), { scale: 1.1, x: -70, duration: b(112) - T - 0.9, ease: "none" }, T + 0.9);

  const feed = $.one("tc.feed");
  const messages = $.all("tc.msg");
  const panel = $.one("tc.panel");
  // Лента растёт снизу: последнее сообщение прижато к низу панели
  gsap.set(feed, { y: 0 });
  messages.forEach((message, index) => {
    const at = b(104.5 + index * 0.5);
    cue("message", at, { n: index });
    tl.fromTo(message, { opacity: 0, x: 40, scale: 0.9 }, { opacity: 1, x: 0, scale: 1, duration: 0.35, ease: EASE.out, immediateRender: false }, at);
  });
  // Сообщения, которые ещё не пришли, не занимают место: лента сдвигается на высоту пришедших
  const hidden = messages.map((message) => message.offsetHeight + 12);
  onFrame((time) => {
    let offset = 0;
    messages.forEach((_, index) => {
      const at = b(104.5 + index * 0.5);
      const p = gsap.utils.clamp(0, 1, (time - at) / 0.3);
      offset += hidden[index] * (1 - (1 - p) ** 3);
    });
    const total = hidden.reduce((sum, value) => sum + value, 0);
    feed.style.transform = `translateY(${total - offset}px)`;
    panel.style.opacity = time < T ? "0" : "1";
  });

  // Плашка рендера
  const from = b(106);
  const to = b(110.5);
  tl.fromTo($.one("tc.hud"), { opacity: 0, y: 20 }, { opacity: 1, y: 0, duration: 0.5, ease: EASE.out }, b(105.5))
    .fromTo($.one("tc.hud.fill"), { scaleX: 0 }, { scaleX: 1, duration: to - from, ease: "power1.inOut", immediateRender: false }, from);
  tl.add(counter($.one("tc.hud.pct"), 0, 100, (v) => `${Math.floor(v)}%`, { duration: to - from, ease: "power1.inOut" }), from);
  const fps = $.one("tc.hud.fps");
  const wobble = noise1d(91, 64);
  onFrame((time) => {
    fps.textContent = time < from ? "0 fps" : `${Math.round(236 + 30 * wobble(time * 1.4))} fps`;
  });
  cue("render", from, { dur: to - from });
  cue("success", to);
  swapText(tl, fps, $.one("tc.hud.done"), to);

  caption(tl, $, "chat", b(104.8), b(111.4));
  shade(tl, $, b(104.4), b(111.7));
  leave(tl, $, "tc", b(112));
}
