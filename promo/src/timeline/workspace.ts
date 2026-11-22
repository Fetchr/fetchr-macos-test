import { caption, cue, EASE, gsap, onFrame, type Scope, type Timeline } from "../lib/motion";
import { BLOCKS } from "../views/WorkspaceView";
import { CAM, cameraTo, cursorAt, moveCursor } from "./camera";
import { b } from "./schedule";

/** Высота топбара: вид живёт ниже него, курсор — в координатах окна */
const TOPBAR = 76;

/**
 * Брейкдаун (доли 128–144): спокойно, без ударов. Два блока перетаскиваются
 * из библиотеки на холст, потом окно наклоняется и блоки расходятся слоями.
 */
export function buildWorkspace(tl: Timeline, $: Scope) {
  const cursor = $.one("cursor");
  const arrow = $.one("cursor.arrow");
  const ghost = $.one("ws.ghost");
  const ghostLabel = $.one("ws.ghost.label");
  const dragged = BLOCKS.filter((block) => block.dragged);
  gsap.set(dragged.map((block) => $.one(`ws.block.${block.id}`)), { autoAlpha: 0 });

  cameraTo(tl, $, b(127.7), { ...CAM.side, x: 420, scale: 0.82 }, 1.2, "expo.inOut");
  tl.to($.one("rig"), { x: "+=40", rotationY: 9, duration: b(137) - b(130), ease: "sine.inOut" }, b(130));
  caption(tl, $, "workspace", b(128.4), b(137));
  tl.fromTo(cursor, { x: 180, y: 520, opacity: 0 }, { opacity: 1, duration: 0.3, immediateRender: false }, b(128.4));

  dragged.forEach((block, index) => {
    const base = index === 0 ? 128.6 : 132.6;
    const item = cursorAt($, $.one(`ws.lib.${block.id}`), -40);
    const drop = cursorAt($, $.one(`ws.drop.${block.id}`));
    const press = b(base + 1);
    const release = b(base + 3.5);

    moveCursor(tl, $, b(base), item, 0.6);
    cue("press", press);
    cue("drag", press + 0.1, { dur: release - press - 0.1 });
    cue("land", release);
    tl.to(arrow, { scale: 0.88, duration: 0.1 }, press)
      .fromTo(ghost, { opacity: 0, scale: 0.9, x: item.x + 16, y: item.y - TOPBAR + 8 }, { opacity: 1, scale: 1, duration: 0.2, immediateRender: false }, press)
      .to(ghost, { x: drop.x + 16, y: drop.y - TOPBAR + 8, duration: release - press - 0.15, ease: "power2.inOut" }, press + 0.1)
      .fromTo($.one(`ws.drop.${block.id}`), { opacity: 0 }, { opacity: 1, duration: 0.3, immediateRender: false }, press + 0.6)
      .to($.one(`ws.drop.${block.id}`), { opacity: 0, duration: 0.3 }, release)
      .to(ghost, { opacity: 0, scale: 0.9, duration: 0.18 }, release)
      .to(arrow, { scale: 1, duration: 0.15 }, release)
      .fromTo(
        $.one(`ws.block.${block.id}`),
        { autoAlpha: 0, scale: 0.92 },
        { autoAlpha: 1, scale: 1, duration: 0.55, ease: "back.out(1.6)", immediateRender: false },
        release,
      );
    moveCursor(tl, $, press + 0.1, drop, release - press - 0.15);
  });
  tl.to(cursor, { opacity: 0, duration: 0.3 }, b(136.6));
  onFrame((time) => {
    ghostLabel.textContent = time < b(133.6) ? dragged[0].title : dragged[1].title;
  });

  // Разобранный вид: окно ложится на бок, блоки поднимаются слоями
  cameraTo(tl, $, b(137.2), { x: 80, y: 60, scale: 0.84, rotationX: 30, rotationY: -26, rotation: 7 }, 1.8, "expo.inOut");
  BLOCKS.forEach((block, index) => {
    const lift = 16 + index * 14;
    tl.to(
      $.one(`ws.block.${block.id}`),
      { x: -lift * 0.6, y: -lift, boxShadow: `0 ${30 + lift}px ${50 + lift}px -18px rgba(0,0,0,0.85)`, duration: 1.2, ease: EASE.cine },
      b(138 + index * 0.5),
    ).to($.one(`ws.block.${block.id}`), { x: 0, y: 0, boxShadow: "0 10px 30px -14px rgba(0,0,0,0.7)", duration: 0.7, ease: "power2.inOut" }, b(142.6));
  });
  cue("unfold", b(138), { dur: 2 });
}
