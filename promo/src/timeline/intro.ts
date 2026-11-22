import { NAV } from "../content";
import { VERB_TILES } from "../components/Opening";
import { cue, EASE, flash, gsap, hideLines, revealLines, type Scope, type Timeline } from "../lib/motion";
import { placeNav } from "./camera";
import { buildLockup } from "./opening";
import { b } from "./schedule";

/**
 * Холодное открытие. Пока трек идёт через фильтр, стена стримов стоит в
 * расфокусе и под ней звучит «боль». На входе хэтов стена резко
 * фокусируется, глаголы бьют по долям, а на 32-й доле всё схлопывается в знак.
 */
export function buildWall(tl: Timeline, $: Scope) {
  const plane = $.one("sw.plane");
  const tiles = $.all("sw.tile");
  const glows = $.all("sw.glow");

  gsap.set(plane, { rotationX: 24, rotationY: -26, rotation: -9, z: -900, x: 260, y: 40 });
  tl.fromTo($.one("sw"), { opacity: 0 }, { opacity: 1, duration: 2.4, ease: "power1.out" }, 0)
    .fromTo(plane, { filter: "blur(16px) brightness(0.45) saturate(0.4)" }, { filter: "blur(6px) brightness(0.6) saturate(0.7)", duration: b(16) - 0.4, ease: "none" }, 0)
    .to(plane, { z: -520, x: 120, rotationY: -20, duration: b(16), ease: "none" }, 0);

  // Экраны всплывают по одному, как будто включаются
  tiles.forEach((tile, index) => {
    tl.fromTo(tile, { opacity: 0, z: -200 }, { opacity: 1, z: 0, duration: 1.4, ease: EASE.out }, 0.3 + index * 0.32);
  });

  // Вход хэтов: резкость, ближе, поворот к зрителю
  cue("rise", b(15), { dur: b(16) - b(15) });
  tl.to(plane, { filter: "blur(0px) brightness(0.85) saturate(1)", duration: 0.35, ease: "power2.out" }, b(16))
    .to(plane, { z: -160, x: 0, y: 0, rotationX: 16, rotationY: -12, rotation: -5, duration: b(30) - b(16), ease: "sine.inOut" }, b(16));
  flash(tl, $, b(16), 0.35, 0.4);

  // Под каждый глагол вспыхивает свой экран
  VERB_TILES.forEach((tileIndex, index) => {
    const at = b(16 + index * 2);
    tl.fromTo(tiles[tileIndex], { z: 0, scale: 1 }, { z: 140, scale: 1.06, duration: 0.3, ease: EASE.out, immediateRender: false }, at)
      .to(tiles[tileIndex], { z: 0, scale: 1, duration: 0.7, ease: "power2.inOut" }, at + 0.75)
      .fromTo(glows[tileIndex], { opacity: 0 }, { opacity: 1, duration: 0.12, immediateRender: false }, at)
      .to(glows[tileIndex], { opacity: 0, duration: 0.6 }, at + 0.7);
  });

  // Схлопывание в точку перед знаком
  cue("recede", b(30), { dur: b(32) - b(30) });
  tl.to(plane, { z: -2600, rotation: 25, rotationY: 0, rotationX: 0, duration: b(32) - b(30), ease: "power4.in" }, b(30))
    .to(tiles, { opacity: 0, duration: 0.35, ease: "power2.in", stagger: { each: 0.02, from: "center" } }, b(31.2))
    .set($.one("sw"), { autoAlpha: 0 }, b(32));
  flash(tl, $, b(32), 0.9, 0.7);
}

export function buildOpeningWords(tl: Timeline, $: Scope) {
  const problems = $.all("ow.problem");
  const verbs = $.all("ow.verb");

  // Боль: строка на четыре доли, мягко и медленно — трек ещё в фильтре
  problems.forEach((line, index) => {
    const at = b(1.5 + index * 4);
    cue("word", at, { n: index, gain: 0.6 });
    tl.fromTo(line, { opacity: 0, y: 26, filter: "blur(14px)" }, { opacity: 1, y: 0, filter: "blur(0px)", duration: 0.9, ease: EASE.out }, at).to(
      line,
      { opacity: 0, y: -18, filter: "blur(10px)", duration: 0.5, ease: "power2.in" },
      b(1.5 + index * 4 + 3.1),
    );
  });

  // Глаголы: удар на долю, каждый влетает из-за камеры
  verbs.forEach((word, index) => {
    const at = b(16 + index * 2);
    cue("word", at, { n: index });
    tl.fromTo(word, { opacity: 0, scale: 1.45, filter: "blur(18px)" }, { opacity: 1, scale: 1, filter: "blur(0px)", duration: 0.32, ease: "expo.out" }, at).to(
      word,
      { opacity: 0, scale: 0.88, filter: "blur(10px)", duration: 0.22, ease: "power2.in" },
      b(16 + index * 2 + 1.55),
    );
  });
}

/** Знак на 32-й доле; на 35.5 он улетает в камеру, из глубины выходит окно */
export function buildHeroV2(tl: Timeline, $: Scope) {
  const at = b(32);
  gsap.set($.one("hero"), { opacity: 1 });
  buildLockup(tl, $, "hero.lockup", at);
  revealLines(tl, $.one("hero.tagline.line"), b(34));
  tl.to($.one("hero.lockup"), { scale: 2.6, opacity: 0, filter: "blur(18px)", duration: 0.6, ease: "power3.in" }, b(35.3));
  hideLines(tl, $.one("hero.tagline.line"), b(35.2));
}

/** Окно выезжает из макро-плана: сначала вкладки во весь кадр, потом общий план */
export function buildRevealV2(tl: Timeline, $: Scope) {
  const rig = $.one("rig");
  gsap.set(rig, { x: 0, y: 380, scale: 2.4, rotationX: 0, rotationY: 0, rotation: 0, opacity: 0 });
  gsap.set($.one("nav.pill"), placeNav($, "queue"));
  gsap.set($.one("nav.queue"), { color: "#e9edf2" });
  gsap.set($.one("view.queue"), { autoAlpha: 1 });

  const at = b(35.5);
  cue("rise", at, { dur: 1.4 });
  tl.to(rig, { opacity: 1, duration: 0.35, ease: "power1.out" }, at)
    .fromTo($.one("win"), { filter: "blur(22px)" }, { filter: "blur(0px)", duration: 0.9, ease: "power2.out", immediateRender: false }, at)
    .set($.one("win"), { filter: "none" }, at + 0.95)
    .to(rig, { x: 330, y: 24, scale: 0.8, rotationX: 4, rotationY: -8, duration: b(37.5) - at, ease: "expo.out" }, at)
    .fromTo($.one("bd.floor"), { opacity: 0 }, { opacity: 0.6, duration: 1.6, ease: "power2.out" }, at + 0.2)
    .fromTo($.one("win.status"), { opacity: 0 }, { opacity: 1, duration: 0.5, ease: "power1.out" }, at + 0.6);

  // Пробег света по вкладкам: все разделы одним взглядом
  const tabs = NAV.slice(1).map((item) => $.one(`nav.${item.id}`));
  cue("sweep", b(36.5), { n: tabs.length, dur: 0.06 * tabs.length });
  tl.to(tabs, { color: "#ffffff", duration: 0.14, stagger: 0.06, ease: "none" }, b(36.5)).to(
    tabs,
    { color: "#9aa4b1", duration: 0.3, stagger: 0.06, ease: "none" },
    b(36.5) + 0.18,
  );
}
