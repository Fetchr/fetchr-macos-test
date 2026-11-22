import { SHEEN_FROM, SHEEN_TO } from "@/ui/redesign/intro/IntroMark";

import { cue, EASE, gsap, type Scope, type Timeline } from "../lib/motion";
import { END } from "./schedule";

/** Атмосфера живёт весь ролик: пятна света медленно дрейфуют */
export function buildBackdrop(tl: Timeline, $: Scope) {
  tl.fromTo($.one("bd.a"), { opacity: 0 }, { opacity: 1, duration: 2.2, ease: "power1.out" }, 0)
    .fromTo($.one("bd.b"), { opacity: 0 }, { opacity: 1, duration: 2.6, ease: "power1.out" }, 0.4)
    .fromTo($.one("bd.a"), { x: 0, y: 0 }, { x: 420, y: 160, duration: END, ease: "sine.inOut", immediateRender: false }, 0)
    .fromTo($.one("bd.b"), { x: 0, y: 0 }, { x: -380, y: -120, duration: END, ease: "sine.inOut", immediateRender: false }, 0);
}

/**
 * Сборка логотипа — та же хореография, что в интро приложения, но крупнее
 * и с подписью. Зритель видит знак, который потом встретит в топбаре.
 */
export function buildLockup(tl: Timeline, $: Scope, id: string, at: number) {
  const root = $.one(id);
  const markWrap = $.one(`${id}.markWrap`);
  const glow = $.one(`${id}.glow`);
  const mark = $.one(`${id}.mark`);
  const word = $.one(`${id}.word`);
  const wordWrap = $.one(`${id}.wordWrap`);
  const stem = root.querySelector('[data-intro-part="stemStroke"]');
  const bar = root.querySelector('[data-intro-part="barStroke"]');
  const sheen = root.querySelector('[data-intro-part="sheen"]');
  if (!stem || !bar || !sheen) throw new Error(`promo: lockup ${id} is missing its mark parts`);

  // Пока слова нет, плитка стоит по центру локапа. Замер по раскладке, а не
  // по экрану: так он не зависит от масштаба предпросмотра.
  const centreShift =
    root.offsetLeft + root.offsetWidth / 2 - (markWrap.offsetLeft + markWrap.offsetWidth / 2);
  gsap.set(markWrap, { x: centreShift });

  cue("impact", at, { gain: id === "hero.lockup" ? 1 : 0.85 });
  cue("draw", at + 0.14, { dur: 0.62 });
  cue("drawBar", at + 0.52, { dur: 0.32 });
  cue("glow", at + 0.82);
  cue("unfold", at + 0.86, { dur: 0.75 });
  cue("sheen", at + 1.45, { dur: 0.7 });

  tl.fromTo(glow, { opacity: 0, scale: 0.35 }, { opacity: 0.8, scale: 1, duration: 1.4, ease: EASE.cine }, at)
    .fromTo(
      mark,
      { opacity: 0, scale: 0.84, filter: "blur(12px)" },
      { opacity: 1, scale: 1, filter: "blur(0px)", duration: 0.8, ease: EASE.cine },
      at + 0.04,
    )
    .set(mark, { filter: "none" }, at + 0.86)
    .fromTo(stem, { attr: { "stroke-dashoffset": 1 } }, { attr: { "stroke-dashoffset": 0 }, duration: 0.62, ease: "power2.inOut" }, at + 0.14)
    .fromTo(bar, { attr: { "stroke-dashoffset": 1 } }, { attr: { "stroke-dashoffset": 0 }, duration: 0.32, ease: EASE.out }, at + 0.52)
    .to(glow, { opacity: 1, scale: 1.08, duration: 0.3, ease: EASE.out }, at + 0.82)
    .to(glow, { opacity: 0.85, scale: 1, duration: 0.9, ease: "power2.out" }, at + 1.12)
    .to(markWrap, { x: 0, duration: 0.75, ease: "power3.inOut" }, at + 0.86)
    .fromTo(wordWrap, { "--wipe": "100%" }, { "--wipe": "0%", duration: 0.95, ease: EASE.cine }, at + 1.08)
    .fromTo(
      word,
      { xPercent: -8, opacity: 0, filter: "blur(10px)" },
      { xPercent: 0, opacity: 1, filter: "blur(0px)", duration: 0.85, ease: EASE.cine },
      at + 1.08,
    )
    .set(word, { filter: "none" }, at + 1.95)
    .fromTo(sheen, { attr: { gradientTransform: SHEEN_FROM } }, { attr: { gradientTransform: SHEEN_TO }, duration: 0.7, ease: "power2.inOut" }, at + 1.45);
}
