import { caption, gsap, runFrameHooks, scoped, type Scope, type Timeline } from "../lib/motion";
import { buildBuild } from "./build";
import { cameraTo, CAM, moveNav, switchView, whip } from "./camera";
import { buildDrop2, buildGap, buildOutroV2 } from "./drop2";
import { buildFinder } from "./finder";
import { buildHeroV2, buildOpeningWords, buildRevealV2, buildWall } from "./intro";
import { buildLive } from "./live";
import { buildMute } from "./mute";
import { buildBackdrop } from "./opening";
import { buildQueue } from "./queue";
import { b, END } from "./schedule";
import { buildBlurTakeover, buildChatTakeover } from "./takeovers";
import { buildVocal } from "./vocal";
import { buildVps } from "./vps";
import { buildWorkspace } from "./workspace";

export const FPS = 60;

/** Склейки между разделами окна: вкладка переезжает, вид сменяется */
function buildTabCuts(tl: Timeline, $: Scope) {
  // Очередь → Finder: вжух влево
  whip(tl, $, b(55.6), -260);
  moveNav(tl, $, "queue", "finder", b(55.8), 0.35);
  switchView(tl, $, "queue", "finder", b(55.8));
  cameraTo(tl, $, b(55.9), { ...CAM.side, x: 560 }, 0.01);
  cameraTo(tl, $, b(55.95), CAM.side, 0.6, "expo.out");
  caption(tl, $, "finder", b(56.3), b(63.3));

  // Finder → Запись стримов: вжух вправо, окно перелетает налево
  whip(tl, $, b(63.6), 300);
  moveNav(tl, $, "finder", "live", b(63.8), 0.35);
  switchView(tl, $, "finder", "live", b(63.8));
  cameraTo(tl, $, b(63.9), { ...CAM.sideL, x: -700 }, 0.01);
  cameraTo(tl, $, b(63.95), CAM.sideL, 0.6, "expo.out");
  caption(tl, $, "live", b(64.3), b(71.3));

  // Запись → Архив VPS
  moveNav(tl, $, "live", "vps", b(71.5), 0.4);
  switchView(tl, $, "live", "vps", b(71.6));

  // Архив → в камеру → блюр на весь кадр
  cameraTo(tl, $, b(95.3), { x: 0, y: 0, scale: 3, rotationX: 0, rotationY: 0, opacity: 0 }, b(96) - b(95.3), "power4.in");

  // После чата: окно врезается снизу уже на вкладке «Удалить маты»
  const views = ["queue", "live", "vps", "finder", "chat", "blur", "mute", "vocal"];
  const rig = $.one("rig");
  tl.set(views.map((id) => $.one(`view.${id}`)), { autoAlpha: 0 }, b(111.9))
    .set($.one("view.mute"), { autoAlpha: 1, y: 0 }, b(111.9))
    .set($.one("nav.pill"), { opacity: 1 }, b(111.9));
  moveNav(tl, $, "vps", "mute", b(111.9), 0.01);
  tl.fromTo(rig, { x: 0, y: 700, scale: 0.9, rotationX: 50, rotationY: 0, rotation: 0, opacity: 0 }, { y: 150, rotationX: 24, opacity: 1, duration: 0.7, ease: "expo.out", immediateRender: false }, b(112));
  caption(tl, $, "mute", b(112.4), b(119.3));

  // Мат → Вокал
  moveNav(tl, $, "mute", "vocal", b(119.7), 0.35);
  switchView(tl, $, "mute", "vocal", b(119.8));
  caption(tl, $, "vocal", b(120.3), b(127.2));

  // Вокал → Воркспейс: пилюля уходит, вкладки ни при чём
  tl.to($.one("nav.pill"), { opacity: 0, duration: 0.25 }, b(127.5)).to($.one("nav.vocal"), { color: "#9aa4b1", duration: 0.25 }, b(127.5));
  switchView(tl, $, "vocal", "ws", b(127.6));
}

/**
 * Весь ролик — один приостановленный таймлайн. Рендер не проигрывает его,
 * а перематывает на время каждого кадра, поэтому кадры одинаковы при любой
 * скорости машины.
 */
export function buildMaster(stage: HTMLElement) {
  const $ = scoped(stage);
  const tl = gsap.timeline({ paused: true });
  const seek = (time: number) => {
    tl.seek(time, false);
    runFrameHooks(time);
  };

  buildBackdrop(tl, $);
  buildWall(tl, $);
  buildOpeningWords(tl, $);
  buildHeroV2(tl, $);
  buildRevealV2(tl, $);
  buildQueue(tl, $);
  buildFinder(tl, $);
  buildLive(tl, $);
  buildVps(tl, $);
  buildTabCuts(tl, $);
  buildBlurTakeover(tl, $);
  buildChatTakeover(tl, $);
  buildMute(tl, $);
  buildVocal(tl, $);
  buildWorkspace(tl, $);
  buildBuild(tl, $);
  buildGap(tl, $);
  buildDrop2(tl, $, seek);
  buildOutroV2(tl, $);

  // Хвост: длительность ролика задаётся расписанием, а не последним твином
  tl.set({}, {}, END);
  return tl;
}
