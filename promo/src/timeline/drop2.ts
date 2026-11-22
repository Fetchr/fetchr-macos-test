import { SHOT_COUNT } from "../components/Finale";
import { cue, EASE, flash, gsap, revealLines, type Scope, type Timeline } from "../lib/motion";
import { placeNav } from "./camera";
import { buildLockup } from "./opening";
import { b, END } from "./schedule";

type Seek = (time: number) => void;

/** Что лежит на стене второго дропа: чья копия и в какой момент ролика */
const SHOTS: Array<{ source: "win" | "tb" | "tc"; time: number }> = [
  { source: "win", time: b(50) }, // очередь
  { source: "win", time: b(43.6) }, // добавить задачу
  { source: "win", time: b(69.5) }, // запись эфира
  { source: "win", time: b(75.4) }, // архив VPS
  { source: "win", time: b(61) }, // M3U8 Finder
  { source: "tb", time: b(102.9) }, // блюр
  { source: "tc", time: b(110.8) }, // чат
  { source: "win", time: b(87) }, // тарифы
  { source: "win", time: b(117.2) }, // мат
  { source: "win", time: b(125.5) }, // вокал
  { source: "win", time: b(136.9) }, // воркспейс
  { source: "win", time: b(66.5) }, // запись до эфира
];

const TILE = { width: 560, height: 365 };

/** Копия элемента без data-p: чужие твины и поиск по имени её не заденут */
function frozenCopy(source: HTMLElement) {
  const copy = source.cloneNode(true) as HTMLElement;
  copy.removeAttribute("data-p");
  copy.querySelectorAll("[data-p]").forEach((node) => node.removeAttribute("data-p"));
  copy.querySelectorAll("[id]").forEach((node) => node.removeAttribute("id"));
  return copy;
}

/** Заполняет стену снимками живого интерфейса, перематывая ролик туда и обратно */
function fillWall($: Scope, seek: Seek) {
  const slots = $.all("sh.slot");
  SHOTS.forEach((shot, index) => {
    seek(shot.time);
    const source = shot.source === "win" ? $.one("win") : $.one(shot.source);
    const copy = frozenCopy(source);
    const width = shot.source === "win" ? 1320 : 1920;
    const height = shot.source === "win" ? 860 : 1080;
    const scale = shot.source === "win" ? TILE.width / width : TILE.height / height;
    const dx = (TILE.width - width * scale) / 2;
    copy.style.width = `${width}px`;
    copy.style.height = `${height}px`;
    copy.style.right = "auto";
    copy.style.bottom = "auto";
    copy.style.filter = "none";
    copy.style.opacity = "1";
    copy.style.visibility = "visible";
    copy.style.transform = `translate(${dx}px, 0) scale(${scale})`;
    copy.style.boxShadow = "none";
    slots[index].appendChild(copy);
  });
  seek(0);
}

/** Пауза (160–164): бочка бьёт, слова встают на удары, потом тишина */
export function buildGap(tl: Timeline, $: Scope) {
  const words = $.all("gw.word");
  [b(161), b(162)].forEach((at, index) => {
    cue("word", at, { n: index });
    tl.fromTo(words[index], { opacity: 0, scale: 1.5, filter: "blur(16px)" }, { opacity: 1, scale: 1, filter: "blur(0px)", duration: 0.3, ease: "expo.out", immediateRender: false }, at);
  });
  tl.to(words, { opacity: 0, scale: 0.92, filter: "blur(8px)", duration: 0.2, ease: "power2.in" }, b(163.6));

  // Удар дропа: «одно окно.»
  const one = $.one("gw.one");
  flash(tl, $, b(164), 0.6, 0.7);
  tl.fromTo(one, { opacity: 0, scale: 2.4, filter: "blur(24px)" }, { opacity: 1, scale: 1, filter: "blur(0px)", duration: 0.55, ease: "expo.out", immediateRender: false }, b(164)).to(
    one,
    { opacity: 0, scale: 0.7, filter: "blur(14px)", duration: 0.4, ease: "power3.in" },
    b(167.2),
  );
}

/**
 * Второй дроп (164–196): стена из копий всего, что было в ролике, летит
 * в 3D; на каждый такт — цифра. Потом стена сходится в одно окно, и
 * вкладки пробегают по полдоли.
 */
export function buildDrop2(tl: Timeline, $: Scope, seek: Seek) {
  fillWall($, seek);

  const wall = $.one("sh");
  const plane = $.one("sh.plane");
  const tiles = $.all("sh.tile");
  const glows = $.all("sh.glow");
  const shade = $.one("sh.shade");

  gsap.set(plane, { z: -1700, rotationX: 50, rotationY: 0, rotation: -14, x: 0, y: 0 });
  tl.set(wall, { autoAlpha: 1 }, b(164))
    .fromTo(tiles, { opacity: 0, z: -400 }, { opacity: 1, z: 0, duration: 0.8, ease: "expo.out", stagger: { each: 0.03, from: "center" }, immediateRender: false }, b(164))
    .to(plane, { z: -900, rotationX: 28, rotationY: -16, rotation: -8, duration: 1.8, ease: "expo.out" }, b(164));

  // Проезды камеры по стене — по одному на цифру
  const poses = [
    { at: 168, pose: { x: 320, y: 0, z: -700, rotationX: 18, rotationY: -24, rotation: -4 } },
    { at: 172, pose: { x: -320, y: 120, z: -700, rotationX: 24, rotationY: 20, rotation: 5 } },
    { at: 176, pose: { x: 0, y: -150, z: -620, rotationX: -14, rotationY: -10, rotation: -3 } },
    { at: 180, pose: { x: 220, y: 0, z: -520, rotationX: 10, rotationY: 28, rotation: 0 } },
    { at: 184, pose: { x: 0, y: 0, z: -560, rotationX: 0, rotationY: 0, rotation: 0 } },
  ];
  poses.forEach(({ at, pose }) => {
    cue("cam", b(at) - 0.3, { dur: 1.2, gain: 1 });
    tl.to(plane, { ...pose, duration: 1.4, ease: "expo.inOut" }, b(at) - 0.35);
  });

  // Цифры: удар на сильную долю каждого такта
  const stats = $.all("st.item");
  const glowFor = [0, 3, 6, 5];
  tl.to(shade, { opacity: 0.8, duration: 0.5 }, b(167.5)).to(shade, { opacity: 0, duration: 0.6 }, b(183.6));
  stats.forEach((item, index) => {
    const at = b(168 + index * 4);
    cue("impact", at, { gain: 0.8 });
    tl.fromTo(item, { opacity: 0, scale: 1.6, filter: "blur(20px)" }, { opacity: 1, scale: 1, filter: "blur(0px)", duration: 0.4, ease: "expo.out", immediateRender: false }, at)
      .to(item, { opacity: 0, scale: 0.9, filter: "blur(10px)", duration: 0.3, ease: "power2.in" }, b(168 + index * 4 + 3.4))
      .fromTo(glows[glowFor[index]], { opacity: 0 }, { opacity: 1, duration: 0.15, immediateRender: false }, at)
      .to(glows[glowFor[index]], { opacity: 0, duration: 0.8 }, b(168 + index * 4 + 3));
  });

  // Прямой план: подсветка бежит по всем экранам
  tiles.forEach((_, index) => {
    const at = b(184 + (index * 4) / SHOT_COUNT);
    tl.fromTo(glows[index], { opacity: 0 }, { opacity: 1, duration: 0.1, immediateRender: false }, at).to(glows[index], { opacity: 0, duration: 0.5 }, at + 0.15);
  });
  cue("sweep", b(184), { n: SHOT_COUNT, dur: (b(188) - b(184)) / SHOT_COUNT });

  // Схождение: экраны слетаются в центр, из них выходит окно
  cue("recede", b(187.4), { dur: 0.8 });
  tiles.forEach((tile, index) => {
    const column = index % 4;
    const row = Math.floor(index / 4);
    tl.to(tile, { x: (1.5 - column) * 600, y: (1 - row) * 405, scale: 0.5, opacity: 0, duration: 0.7, ease: "power3.in" }, b(187.6));
  });
  tl.set(wall, { autoAlpha: 0 }, b(189));
  buildOneWindow(tl, $);
}

/** Одно окно: пилюля вкладок бежит по разделам по полдоли */
const RACE = ["queue", "live", "vps", "finder", "chat", "blur", "mute", "vocal"] as const;

function buildOneWindow(tl: Timeline, $: Scope) {
  const rig = $.one("rig");
  const pill = $.one("nav.pill");
  const views = ["queue", "live", "vps", "finder", "chat", "blur", "mute", "vocal", "ws"].map((id) => $.one(`view.${id}`));
  const tabs = RACE.map((id) => $.one(`nav.${id}`));
  flash(tl, $, b(188.4), 0.6, 0.5);
  tl.fromTo(rig, { x: 0, y: 30, scale: 0.35, rotationX: 0, rotationY: 0, rotation: 0, opacity: 0 }, { scale: 0.86, opacity: 1, duration: 1.0, ease: "expo.out", immediateRender: false }, b(188.4))
    .to(rig, { scale: 0.96, rotationX: 4, duration: b(194.4) - b(189.4), ease: "sine.inOut" }, b(189.4));

  RACE.forEach((id, index) => {
    const at = b(189.5 + index * 0.6);
    cue("tab", at, { gain: 0.8 });
    tl.to(pill, { ...placeNav($, id), opacity: 1, duration: 0.3, ease: EASE.cine }, at)
      .set(views, { autoAlpha: 0 }, at + 0.05)
      .set($.one(`view.${id}`), { autoAlpha: 1, y: 0 }, at + 0.05)
      .set(tabs, { color: "#9aa4b1" }, at)
      .set($.one(`nav.${id}`), { color: "#e9edf2" }, at);
  });

  // Окно уходит — освобождает место знаку
  cue("recede", b(194.4), { dur: 0.8 });
  tl.to(rig, { scale: 0.55, y: 60, rotationX: 16, opacity: 0, duration: 0.75, ease: "power3.in" }, b(194.4));
}

/** Финал: знак на 196-й доле, обещание, кнопка; последний удар — на 212-й */
export function buildOutroV2(tl: Timeline, $: Scope) {
  const T = b(196);
  tl.to([$.one("bd.a"), $.one("bd.b")], { opacity: 1, duration: 1.2 }, T - 0.2);
  buildLockup(tl, $, "ou.lockup", T);
  revealLines(tl, $.all("ou.line"), b(198), 0.1);
  cue("title", b(198), { gain: 1.2 });
  cue("cta", b(200));
  cue("sparkle", b(202), { dur: 1.1 });
  tl.fromTo($.one("ou.button"), { opacity: 0, scale: 0.9, y: 12 }, { opacity: 1, scale: 1, y: 0, duration: 0.8, ease: EASE.out }, b(200))
    .fromTo($.one("ou.buttonSheen"), { x: -160 }, { x: 560, duration: 1.1, ease: "power2.inOut", immediateRender: false }, b(202))
    .fromTo($.one("ou.meta"), { opacity: 0, y: 8 }, { opacity: 1, y: 0, duration: 0.7, ease: EASE.out }, b(201))
    .fromTo($.one("bd.floor"), { opacity: 0 }, { opacity: 0.7, x: 0, y: -40, duration: 1.4, ease: "power2.out", immediateRender: false }, b(198));

  // Последний удар трека: знак вспыхивает, по кнопке пробегает блик
  const hit = b(212);
  flash(tl, $, hit, 0.3, 0.6);
  tl.to($.one("ou.lockup.glow"), { opacity: 1, scale: 1.25, duration: 0.18, ease: "power2.out" }, hit)
    .to($.one("ou.lockup.glow"), { opacity: 0.85, scale: 1, duration: 1.2, ease: "power2.out" }, hit + 0.18)
    .fromTo($.one("ou.lockup"), { scale: 1.04 }, { scale: 1, duration: 0.8, ease: EASE.out, immediateRender: false }, hit)
    .fromTo($.one("ou.buttonSheen"), { x: -160 }, { x: 560, duration: 1.0, ease: "power2.inOut", immediateRender: false }, hit + 0.1);

  // Затемнение в конце: последний кадр совпадает с первым
  const fade = $.one("fade");
  gsap.set(fade, { opacity: 0 });
  tl.fromTo(fade, { opacity: 0 }, { opacity: 1, duration: 1.6, ease: "power1.in" }, END - 1.6);
}
