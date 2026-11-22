import { counter, cue, EASE, gsap, onFrame, type Scope, type Timeline } from "../lib/motion";
import { MUTE_BARS, MUTED_REGIONS } from "../views/MuteView";
import { CAM, cameraTo, clickCursor, cursorAt, moveCursor } from "./camera";
import { b } from "./schedule";

const T = b(112);
/** Сцена ужата под восемь долей: смещения внутри неё умножаются на K */
const K = 0.74;
const at = (offset: number) => T + offset * K;
const LISTEN_FROM = at(0.25);
const LISTEN_TO = at(3.3);
const METHOD_AT = at(3.9);

export function buildMute(tl: Timeline, $: Scope) {
  const words = $.all("mu.word");
  const bars = $.all("mu.bar");
  const regions = $.all("mu.region");
  const playhead = $.one("mu.playhead");
  const wave = $.one("mu.wave");

  // Слова «распознаются» по одному: серые становятся белыми, мат — красной плашкой
  const step = (LISTEN_TO - LISTEN_FROM) / words.length;
  words.forEach((word, index) => {
    const at = LISTEN_FROM + index * step;
    const kind = word.dataset.kind;
    if (kind === "bad") {
      tl.fromTo(
        word,
        { color: "#444c57", backgroundColor: "rgba(240,80,110,0)", scale: 0.86 },
        { color: "#ff8ba0", backgroundColor: "rgba(240,80,110,0.2)", scale: 1, duration: 0.35, ease: "back.out(2.2)", immediateRender: false },
        at,
      );
    } else {
      tl.to(word, { color: kind === "white" ? "#2fd49b" : "#e9edf2", duration: 0.18, ease: "none" }, at);
    }
  });

  // Плейхед идёт по волне; пройденные столбики светлеют, в зонах мата — гаснут
  const badTimes = words
    .map((word, index) => ({ kind: word.dataset.kind, at: LISTEN_FROM + index * step }))
    .filter((item) => item.kind === "bad")
    .map((item) => item.at);
  onFrame((time) => {
    const p = gsap.utils.clamp(0, 1, (time - LISTEN_FROM) / (LISTEN_TO - LISTEN_FROM + 0.4 * K));
    playhead.style.left = `${10 + p * (wave.offsetWidth - 22)}px`;
    bars.forEach((bar, index) => {
      const x = index / bars.length;
      const region = MUTED_REGIONS.findIndex((r) => x >= r.from && x <= r.to);
      const muted = region >= 0 && time >= badTimes[region];
      bar.style.opacity = x <= p ? "1" : "0.35";
      bar.style.height = muted ? "4%" : `${8 + MUTE_BARS[index] * 88}%`;
    });
  });

  // Пока выбран способ «Запикать», мат действительно запикивается
  badTimes.forEach((at, index) => cue("beep", at, { n: index }));
  cue("toggle", METHOD_AT);
  regions.forEach((region, index) => {
    tl.fromTo(region, { opacity: 0, scaleY: 0.6 }, { opacity: 1, scaleY: 1, duration: 0.3, ease: EASE.out, immediateRender: false }, badTimes[index]);
    tl.add(counter($.one("mu.count"), index, index + 1, (v) => `${Math.round(v)}`, { duration: 0.01 }), badTimes[index]);
  });

  // ── Камера: крупно расшифровка ──
  cameraTo(tl, $, at(0.05), { x: 0, y: 150, scale: 1.02, rotationY: 0, rotationX: 24 }, 1.1, "expo.out");
  cameraTo(tl, $, at(3.0), CAM.low, 0.9);

  // ── Пик → тишина ──
  const cursor = $.one("cursor");
  const target = $.one("mu.m.mute");
  tl.fromTo(cursor, { x: 1000, y: 620, opacity: 0 }, { opacity: 1, duration: 0.25, immediateRender: false }, at(3.2));
  moveCursor(tl, $, at(3.25), cursorAt($, target), 0.55);
  clickCursor(tl, $, METHOD_AT - 0.04);
  tl.to($.one("mu.method.pill"), { x: target.offsetLeft - 3, duration: 0.4, ease: EASE.cine }, METHOD_AT)
    .to($.all("mu.beep"), { opacity: 0, duration: 0.25 }, METHOD_AT + 0.05 * K)
    .to($.all("mu.flat"), { opacity: 1, duration: 0.3 }, METHOD_AT + 0.15 * K)
    .to(cursor, { opacity: 0, duration: 0.3 }, METHOD_AT + 0.6 * K);

  // ── Крупно дорожка с тишиной на месте мата ──
  cameraTo(tl, $, METHOD_AT + 0.35 * K, { x: 0, y: 40, scale: 1.08, rotationY: 0, rotationX: 12, rotation: -2 }, 1.0);
}
