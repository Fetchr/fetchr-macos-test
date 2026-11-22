import { counter, cue, EASE, onFrame, swapText, type Scope, type Timeline } from "../lib/motion";
import { cameraTo, CAM, clickCursor, cursorAt, moveCursor } from "./camera";
import { b } from "./schedule";

const T = b(64);
/** Сцена ужата под восемь долей: смещения внутри неё умножаются на K */
const K = 0.85;
const at = (offset: number) => T + offset * K;
/** Момент, когда стример вышел в эфир и запись стартовала сама */
const LIVE_AT = at(2.7);

const hms = (seconds: number) => {
  const whole = Math.max(0, Math.floor(seconds));
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const s = whole % 60;
  return [h, m, s].map((v) => String(v).padStart(2, "0")).join(":");
};

export function buildLive(tl: Timeline, $: Scope) {
  const rings = $.all("lv.wait.ring");
  const countdown = $.one("lv.wait.countdown");
  const waitTimer = $.one("lv.wait.timer");
  const waitSize = $.one("lv.wait.size");
  const recTimer = $.one("lv.rec.timer");
  const recSize = $.one("lv.rec.size");
  const recDots = [$.one("lv.wait.recDot"), $.one("lv.rec.recDot")];

  // Радар дышит, отсчёт тикает, таймеры записи идут в реальном времени
  onFrame((time) => {
    const tau = time - T;
    rings.forEach((ring, index) => {
      const phase = (((tau + index * 0.5) % 1) + 1) % 1;
      ring.style.transform = `scale(${0.7 + phase * 1.6})`;
      ring.style.opacity = tau < 2.7 ? String(0.85 * (1 - phase)) : "0";
    });
    countdown.textContent = `${Math.max(1, Math.ceil(3 - tau / 0.9))} с`;
    const recorded = time - LIVE_AT;
    waitTimer.textContent = hms(recorded > 0 ? recorded : 0);
    waitSize.textContent = `${Math.max(0, recorded * 6.2).toFixed(0)} MB`;
    recTimer.textContent = hms(4364 + Math.max(0, time - (T - 3)));
    recSize.textContent = `${(3.41 + Math.max(0, time - (T - 3)) * 0.0061).toFixed(2)} GB`;
    const blink = Math.floor(time * 1.6) % 2 === 0 ? "1" : "0.25";
    recDots.forEach((dot) => (dot.style.opacity = blink));
  });

  cue("countdown", at(0.9));
  cue("countdown", at(1.8));
  cue("live", LIVE_AT);
  cue("toast", LIVE_AT + 0.15 * K);
  cue("toggle", at(3.6));
  cue("success", at(4.45), { gain: 0.75 });

  // ── Стрим вышел в эфир ──
  tl.to($.one("lv.wait.shade"), { opacity: 0, duration: 0.6, ease: "power2.out" }, LIVE_AT)
    .to($.one("lv.wait.radar"), { opacity: 0, scale: 1.2, duration: 0.4, ease: "power2.out" }, LIVE_AT);
  swapText(tl, $.one("lv.wait.badgeWait"), $.one("lv.wait.badgeLive"), LIVE_AT);
  swapText(tl, $.one("lv.wait.check"), $.one("lv.wait.rec"), LIVE_AT + 0.05 * K);
  tl.fromTo($.one("lv.wait"), { boxShadow: "0 0 0 0 rgba(229,72,77,0)" }, { boxShadow: "0 0 0 1px rgba(229,72,77,0.55)", duration: 0.3, ease: "none", immediateRender: false }, LIVE_AT)
    .to($.one("lv.wait"), { boxShadow: "0 0 0 1px rgba(229,72,77,0)", duration: 1.2, ease: "power2.out" }, LIVE_AT + 0.4 * K)
    .fromTo($.one("lv.toast"), { opacity: 0, y: 24 }, { opacity: 1, y: 0, duration: 0.5, ease: EASE.out, immediateRender: false }, LIVE_AT + 0.15 * K)
    .to($.one("lv.toast"), { opacity: 0, y: 12, duration: 0.35, ease: "power2.in" }, LIVE_AT + 2.2 * K);
  tl.add(counter($.one("lv.liveCount"), 1, 2, (v) => `${Math.round(v)} в эфире`, { duration: 0.01 }), LIVE_AT);

  // ── Камера: сначала к карточке ожидания, потом общий план ──
  cameraTo(tl, $, at(0.1), { x: -420, y: 96, scale: 0.94, rotationY: -3, rotationX: 2 }, 1.1);
  cameraTo(tl, $, at(3.3), CAM.sideL, 1.0);

  // ── Курсор: включить блюр в постобработке, отделить отрезок ──
  const cursor = $.one("cursor");
  const toggle = cursorAt($, $.one("lv.toggle.blur"));
  const split = cursorAt($, $.one("lv.split"));
  tl.fromTo(cursor, { x: 980, y: 700, opacity: 0 }, { opacity: 1, duration: 0.25, immediateRender: false }, at(3.0));
  moveCursor(tl, $, at(3.05), toggle, 0.5);
  clickCursor(tl, $, at(3.58));
  tl.to($.one("lv.toggle.blur.on"), { opacity: 1, duration: 0.2, ease: "none" }, at(3.6))
    .to($.one("lv.toggle.blur.knob"), { x: 16, duration: 0.28, ease: EASE.out }, at(3.6));
  moveCursor(tl, $, at(3.7), split, 0.6);
  clickCursor(tl, $, at(4.35));
  tl.fromTo($.one("lv.segment"), { opacity: 0, y: 10, scale: 0.96 }, { opacity: 1, y: 0, scale: 1, duration: 0.5, ease: EASE.out, immediateRender: false }, at(4.45))
    .to(cursor, { opacity: 0, duration: 0.3 }, at(5.2));
}
