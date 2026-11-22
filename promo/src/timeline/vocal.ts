import { counter, cue, EASE, gsap, swapText, type Scope, type Timeline } from "../lib/motion";
import { MUSIC_ZONES } from "../views/VocalView";
import { CAM, cameraTo, clickCursor, cursorAt, moveCursor } from "./camera";
import { b } from "./schedule";

const T = b(120);
/** Сцена ужата под восемь долей: смещения внутри неё умножаются на K */
const K = 0.74;
const at = (offset: number) => T + offset * K;
const SPLIT_FROM = at(0.3);
const SPLIT_TO = at(1.7);
const SCAN_FROM = at(3.15);
const SCAN_TO = at(4.35);

export function buildVocal(tl: Timeline, $: Scope) {
  const select = $.one("vc.task.pill");
  const stemsCard = $.one("vc.task.stems");
  const copyCard = $.one("vc.task.copy");
  gsap.set(select, { y: stemsCard.offsetTop, height: stemsCard.offsetHeight });

  // ── Разделение: луч проходит по миксу, из него выходят два стема ──
  cameraTo(tl, $, at(0.05), { x: 0, y: 150, scale: 1.02, rotationY: 14, rotationX: -8 }, 1.1, "expo.out");
  cue("scan", SPLIT_FROM, { dur: SPLIT_TO - SPLIT_FROM, gain: 0.8 });
  cue("split", SPLIT_TO + 0.05 * K);
  cue("scan", SCAN_FROM, { dur: SCAN_TO - SCAN_FROM });
  MUSIC_ZONES.forEach((zone) => cue("detect", SCAN_FROM + zone.from * (SCAN_TO - SCAN_FROM)));
  cue("alert", SCAN_TO + 0.1 * K);
  cue("success", SCAN_TO + 0.75 * K);
  const mixRow = $.one("vc.row.mix");
  const sweep = $.one("vc.sweep");
  const sweepTravel = mixRow.offsetWidth - sweep.offsetLeft - sweep.offsetWidth;
  tl.fromTo(sweep, { x: 0, opacity: 0 }, { x: sweepTravel, opacity: 1, duration: SPLIT_TO - SPLIT_FROM, ease: "power1.inOut", immediateRender: false }, SPLIT_FROM)
    .to(sweep, { opacity: 0, duration: 0.2 }, SPLIT_TO);
  tl.add(counter($.one("vc.split.pct"), 0, 100, (v) => `${Math.floor(v)}%`, { duration: SPLIT_TO - SPLIT_FROM, ease: "power1.inOut" }), SPLIT_FROM);
  tl.to($.one("vc.wave.mix"), { opacity: 0.35, duration: 0.4 }, SPLIT_TO);

  ["voice", "music"].forEach((stem, index) => {
    const at = SPLIT_TO + 0.05 * K + index * 0.15;
    tl.fromTo($.one(`vc.row.${stem}`), { opacity: 0, y: 16 }, { opacity: 1, y: 0, duration: 0.5, ease: EASE.out, immediateRender: false }, at).fromTo(
      $.one(`vc.wave.${stem}`),
      { clipPath: "inset(0 100% 0 0)" },
      { clipPath: "inset(0 0% 0 0)", duration: 0.85, ease: EASE.cine, immediateRender: false },
      at + 0.05,
    );
  });

  // ── Анти-Copyright ──
  cameraTo(tl, $, at(2.35), CAM.low, 0.9);
  const cursor = $.one("cursor");
  tl.fromTo(cursor, { x: 980, y: 640, opacity: 0 }, { opacity: 1, duration: 0.25, immediateRender: false }, at(2.45));
  moveCursor(tl, $, at(2.5), cursorAt($, copyCard), 0.5);
  clickCursor(tl, $, at(3.02));
  tl.to(select, { y: copyCard.offsetTop, height: copyCard.offsetHeight, duration: 0.45, ease: EASE.cine }, at(3.05))
    .to(cursor, { opacity: 0, duration: 0.3 }, at(3.6));

  const scan = $.one("vc.scan");
  const zones = $.all("vc.zone");
  const track = scan.parentElement as HTMLElement;
  tl.fromTo(scan, { x: 0, opacity: 0 }, { x: track.offsetWidth - 2, opacity: 1, duration: SCAN_TO - SCAN_FROM, ease: "none", immediateRender: false }, SCAN_FROM)
    .to(scan, { opacity: 0, duration: 0.2 }, SCAN_TO);
  MUSIC_ZONES.forEach((zone, index) => {
    const at = SCAN_FROM + zone.from * (SCAN_TO - SCAN_FROM);
    tl.fromTo(zones[index], { opacity: 0, scaleY: 0.5 }, { opacity: 1, scaleY: 1, duration: 0.3, ease: EASE.out, immediateRender: false }, at);
  });
  cameraTo(tl, $, SCAN_FROM - 0.1, { x: 0, y: 40, scale: 1.08, rotationY: 0, rotationX: 10, rotation: 2 }, 1.0);

  const found = $.one("vc.found");
  tl.fromTo(found, { opacity: 0, y: 14, scale: 0.98 }, { opacity: 1, y: 0, scale: 1, duration: 0.5, ease: EASE.out, immediateRender: false }, SCAN_TO + 0.1 * K);
  swapText(tl, $.one("vc.found.warn"), $.one("vc.found.ok"), SCAN_TO + 0.75 * K);
  tl.to(zones, { backgroundColor: "rgba(47,212,155,0.2)", boxShadow: "inset 0 0 0 1.5px rgba(47,212,155,0.85)", duration: 0.4 }, SCAN_TO + 0.8 * K);
}
