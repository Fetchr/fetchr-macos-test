import { counter, cue, EASE, gsap, onFrame, swapText, typeText, type Scope, type Timeline } from "../lib/motion";
import { CANDIDATES } from "../views/FinderView";
import { cameraTo, clickCursor, cursorAt, moveCursor } from "./camera";
import { b } from "./schedule";

const T = b(56);
/** Сцена ужата под восемь долей: смещения внутри неё умножаются на K */
const K = 0.76;
const at = (offset: number) => T + offset * K;
const SCAN_FROM = at(1.95);
const SCAN_TO = at(3.85);
const TRACKER = "https://twitchtracker.com/leva2k/streams/318162780902";

export function buildFinder(tl: Timeline, $: Scope) {
  const cursor = $.one("cursor");
  const scan = $.one("fd.scan");
  const lines = $.one("fd.scan.lines");
  const spin = $.one("fd.scan.spin");
  const fills = $.all("fd.fill");
  gsap.set(fills, { opacity: 0 });

  // Лента кандидатов бежит вверх, пока идёт перебор
  const lineHeight = 24;
  const travel = (CANDIDATES.length - 7) * lineHeight;
  onFrame((time) => {
    const p = gsap.utils.clamp(0, 1, (time - SCAN_FROM) / (SCAN_TO - SCAN_FROM));
    lines.scrollTop = 0;
    (lines.firstElementChild as HTMLElement | null)?.style.setProperty("margin-top", `${-p * travel}px`);
    spin.style.transform = `rotate(${time * 400}deg)`;
  });

  // ── Выбрать удалённый VOD ──
  const vod = cursorAt($, $.one("fd.vod.b"), -40);
  tl.fromTo(cursor, { x: 520, y: 640, opacity: 0 }, { opacity: 1, duration: 0.25, immediateRender: false }, at(0.15));
  moveCursor(tl, $, at(0.2), vod, 0.55);
  clickCursor(tl, $, at(0.8));
  tl.to($.one("fd.vod.b.sel"), { opacity: 1, duration: 0.25, ease: "power1.out" }, at(0.82));

  // ── Поля заполняются из трекера ──
  cue("type", at(0.9), { dur: 0.45, n: TRACKER.length });
  cue("fill", at(1.05));
  cue("scan", SCAN_FROM, { dur: SCAN_TO - SCAN_FROM });
  cue("found", SCAN_TO + 0.05 * K);
  cue("fly", SCAN_TO + 0.85 * K, { dur: 0.85 });
  cue("land", SCAN_TO + 1.75 * K);
  tl.add(typeText($.one("fd.tracker"), TRACKER, { duration: 0.45 }), at(0.9))
    .fromTo(fills, { opacity: 0, y: 6 }, { opacity: 1, y: 0, duration: 0.35, stagger: 0.08, ease: EASE.out, immediateRender: false }, at(1.05))
    .to(scan, { opacity: 1, duration: 0.4 }, at(1.3));
  cameraTo(tl, $, at(0.3), { x: 414, y: 60, scale: 0.9, rotationY: 3, rotationX: 2 }, 1.2);

  // ── Найти m3u8 ──
  moveCursor(tl, $, at(1.35), cursorAt($, $.one("fd.find")), 0.5);
  clickCursor(tl, $, at(1.88));
  tl.fromTo($.one("fd.scan.fill"), { scaleX: 0 }, { scaleX: 1, duration: SCAN_TO - SCAN_FROM, ease: "power1.inOut", immediateRender: false }, SCAN_FROM);
  tl.add(counter($.one("fd.scan.count"), 0, 1284, (v) => Math.round(v).toLocaleString("ru-RU"), { duration: SCAN_TO - SCAN_FROM, ease: "power1.inOut" }), SCAN_FROM);
  tl.to(cursor, { x: "+=60", y: "+=90", duration: 0.8, ease: "power2.inOut" }, at(2.3));

  // ── Нашёлся ──
  swapText(tl, $.one("fd.scan.label"), $.one("fd.scan.done"), SCAN_TO);
  tl.fromTo($.one("fd.result"), { opacity: 0, y: 12 }, { opacity: 1, y: 0, duration: 0.5, ease: EASE.out, immediateRender: false }, SCAN_TO + 0.05 * K)
    .fromTo($.one("fd.result.flash"), { opacity: 0 }, { opacity: 1, duration: 0.15, immediateRender: false }, SCAN_TO + 0.1 * K)
    .to($.one("fd.result.flash"), { opacity: 0, duration: 0.9, ease: "power2.out" }, SCAN_TO + 0.3 * K);

  // ── Скачать: задача улетает во вкладку «Очередь» ──
  const get = cursorAt($, $.one("fd.get"));
  moveCursor(tl, $, SCAN_TO + 0.25 * K, get, 0.5);
  clickCursor(tl, $, SCAN_TO + 0.8 * K);
  const fly = $.one("fly");
  const tab = cursorAt($, $.one("nav.queue"));
  const from = { x: get.x - 90, y: get.y - 16 };
  const to = { x: tab.x - 40, y: tab.y - 16 };
  tl.fromTo(fly, { x: from.x, y: from.y, opacity: 0, scale: 0.9 }, { opacity: 1, scale: 1, duration: 0.2, immediateRender: false }, SCAN_TO + 0.85 * K)
    .to(fly, { x: to.x, duration: 0.75, ease: "power2.inOut" }, SCAN_TO + 1.0 * K)
    .to(fly, { y: to.y, duration: 0.75, ease: "power3.in" }, SCAN_TO + 1.0 * K)
    .to(fly, { scale: 0.5, opacity: 0, duration: 0.2, ease: "power2.in" }, SCAN_TO + 1.62 * K);
  tl.add(counter($.one("nav.queue.badge"), 4, 5, (v) => `${Math.round(v)}`, { duration: 0.01 }), SCAN_TO + 1.75 * K)
    .fromTo($.one("nav.queue.badge"), { scale: 1 }, { scale: 1.45, duration: 0.14, ease: "power2.out", yoyo: true, repeat: 1, immediateRender: false }, SCAN_TO + 1.75 * K)
    .to(cursor, { opacity: 0, duration: 0.3 }, SCAN_TO + 1.9 * K);
}
