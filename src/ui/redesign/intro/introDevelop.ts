/**
 * Вход «Проявка» — первый запуск после установки или обновления.
 *
 * Знак проступает из символов ASCII-поля: клетки внутри F перебирают глифы
 * и набирают яркость, пока идут проверки запуска; снаружи вспыхивают и гаснут
 * редкие искры. На ударе символы белеют и разлетаются, остаётся вектор, от
 * удара по фону расходится волна. Финал — общая рамка выделения и трекинг
 * слова, как у «Вырезки». Все величины сцены — в единицах сетки знака (96).
 */
import { EASE, gsap } from "@/ui/redesign/theme/gsapSetup";

import { palette } from "./asciiBackdrop";
import {
  addSelection,
  EXIT_LABEL,
  letterEls,
  resetScene,
  svgEl,
  TEXT,
  unitPx,
  type IntroParts,
} from "./introTimeline";

const RAMP = " .:-=+*#%@";
/** Глифы, на которых клетка внутри знака успокаивается */
const SETTLED = "@#%";
const FONT_STACK = '"JetBrains Mono Variable", "JetBrains Mono", ui-monospace, monospace';
/** Рамка знака в сетке и разбивка её на клетки */
const MARK = { x: 14, y: 14, w: 77, h: 70 } as const;
const COLS = 24;
const ROWS = 15;
/** Доля клеток вне знака, которые вспыхивают искрами */
const SPARK_SHARE = 0.22;
/** Перебор глифов: клетка зажигается в окне APPEAR и успокаивается за SETTLE */
const APPEAR_FROM = 0.15;
const APPEAR_SPAN = 0.75;
const SETTLE = 0.35;
/** Здесь перебор ждёт, пока не закончатся проверки запуска */
const HOLD_AT = 0.55;
const SCRAMBLE = APPEAR_FROM + APPEAR_SPAN + SETTLE;
const IMPACT = SCRAMBLE + 0.15;
/** Центр знака в сетке: отсюда символы разлетаются */
const CENTRE = { x: MARK.x + MARK.w / 2, y: MARK.y + MARK.h / 2 } as const;

interface Cell {
  el: SVGTextElement;
  inside: boolean;
  at: number;
  settled: string;
}

const pick = (from: number, to: number) => RAMP[from + Math.floor(Math.random() * (to - from))];

function buildCells(p: IntroParts, parent: SVGGElement): Cell[] {
  const cw = MARK.w / COLS;
  const ch = MARK.h / ROWS;
  let seed = 5;
  const rnd = () => (seed = (seed * 9301 + 49297) % 233280) / 233280;
  const cells: Cell[] = [];
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const point = new DOMPoint(MARK.x + (c + 0.5) * cw, MARK.y + (r + 0.5) * ch);
      const inside = p.body.isPointInFill(point) || p.chip.isPointInFill(point);
      if (!inside && rnd() > SPARK_SHARE) continue;
      const el = svgEl("text", { x: point.x, y: point.y, opacity: 0 }, parent);
      const at = APPEAR_FROM + rnd() * APPEAR_SPAN;
      cells.push({ el, inside, at, settled: SETTLED[Math.floor(at * 100) % SETTLED.length] });
    }
  }
  return cells;
}

/** Кадр перебора: t — секунды сцены; hold — перебор стоит, клетки не успокаиваются */
function drawCells(cells: Cell[], t: number, hold: boolean) {
  for (const cell of cells) {
    const k = (t - cell.at) / SETTLE;
    if (k <= 0) {
      cell.el.setAttribute("opacity", "0");
      continue;
    }
    if (!cell.inside) {
      const life = Math.max(0, 1 - Math.abs(k - 0.6) * 1.4);
      cell.el.setAttribute("opacity", (life * 0.35).toFixed(2));
      cell.el.textContent = pick(1, 5);
      continue;
    }
    const s = Math.min(1, k);
    const [r, g, b] = palette(0.35 + s * 0.45);
    cell.el.setAttribute("fill", `rgb(${r | 0},${g | 0},${b | 0})`);
    cell.el.setAttribute("opacity", (0.3 + s * 0.7).toFixed(2));
    cell.el.textContent = s < 1 || hold ? pick(2, 9) : cell.settled;
  }
}

/**
 * checksDone: true — проверки уже прошли; промис — перебор идёт, пока он не
 * выполнится. Без него сцена играет подряд.
 */
export function buildDevelop(p: IntroParts, checksDone?: () => true | Promise<void>) {
  resetScene(p);
  const u = unitPx(p);
  const letters = letterEls(p);
  const markGroup = p.mark.querySelector<SVGGElement>('[data-intro-part="markGroup"]');
  if (!markGroup) throw new Error('Intro splash is missing its "markGroup" part');

  const lockup = p.lockup.getBoundingClientRect();
  const markBox = p.markWrap.getBoundingClientRect();
  const centreShift = lockup.left + lockup.width / 2 - (markBox.left + markBox.width / 2);
  gsap.set(p.markWrap, { x: centreShift });
  gsap.set(p.mark, { opacity: 1 });
  gsap.set(markGroup, { opacity: 0 });
  gsap.set(letters, { opacity: 0, x: (i: number) => 26 + i * 30, transformOrigin: "0% 100%" });

  const grid = svgEl("g", {
    "font-family": FONT_STACK,
    "font-weight": 600,
    "font-size": 5.4,
    "text-anchor": "middle",
    "dominant-baseline": "central",
  }, p.fx);
  const cells = buildCells(p, grid);

  const tl = gsap.timeline();
  const scene = { t: 0 };
  let holding = false;
  const holdTick = () => drawCells(cells, HOLD_AT, true);
  const stopHold = () => {
    gsap.ticker.remove(holdTick);
    holding = false;
  };
  const hold = () => {
    if (!checksDone) return;
    const ready = checksDone();
    if (ready === true) return;
    tl.pause();
    holding = true;
    gsap.ticker.add(holdTick);
    void ready.then(() => {
      stopHold();
      tl.resume();
    });
  };
  tl.eventCallback("onInterrupt", stopHold);

  const bg = p.ascii?.state;
  if (bg) {
    tl.fromTo(bg, { fade: 0 }, { fade: 1, duration: 1.4, ease: "sine.inOut" }, 0)
      .fromTo(bg, { scroll: 0 }, { scroll: 600, duration: SCRAMBLE, ease: "power1.inOut" }, 0)
      .fromTo(bg, { ring: 0.05, ringA: 0 }, { ring: 1.35, duration: 1.3, ease: "power2.out" }, IMPACT)
      .to(bg, { ringA: 1, duration: 0.08 }, IMPACT)
      .to(bg, { ringA: 0, duration: 1.1, ease: "sine.inOut" }, IMPACT + 0.08)
      .fromTo(bg, { calm: 0 }, { calm: 1, duration: 1.2, ease: "sine.inOut" }, IMPACT);
  }

  tl
    // 1. Перебор: клетки знака проступают из шума и успокаиваются
    .fromTo(p.glow, { opacity: 0, scale: 0.5 }, { opacity: 0.45, scale: 1, duration: 0.8, ease: "power2.out" }, 0)
    .fromTo(scene, { t: 0 }, {
      t: SCRAMBLE,
      duration: SCRAMBLE,
      ease: "none",
      onUpdate: () => {
        if (!holding) drawCells(cells, scene.t, false);
      },
    }, 0)
    .call(hold, undefined, HOLD_AT)
    // 2. Удар: символы белеют, вектор встаёт с пружиной, свечение вспыхивает
    .call(() => cells.forEach((cell) => cell.inside && cell.el.setAttribute("fill", TEXT)), undefined, IMPACT)
    .to(markGroup, { opacity: 1, duration: 0.18, ease: "power2.out" }, IMPACT + 0.02)
    .fromTo(markGroup, { scaleX: 1.08, scaleY: 0.9, transformOrigin: "50% 50%" }, { scaleX: 1, scaleY: 1, duration: 0.5, ease: "elastic.out(1, 0.5)", immediateRender: false }, IMPACT + 0.02)
    .to(p.glow, { opacity: 1, scale: 1.14, duration: 0.08, ease: "power2.out" }, IMPACT)
    .to(p.glow, { opacity: 0.72, scale: 1, duration: 0.6, ease: "power2.out" }, IMPACT + 0.08);

  // 3. Символы разлетаются от центра знака
  for (const cell of cells) {
    const angle = Math.atan2(Number(cell.el.getAttribute("y")) - CENTRE.y, Number(cell.el.getAttribute("x")) - CENTRE.x);
    tl.to(cell.el, { x: Math.cos(angle) * 10, y: Math.sin(angle) * 10, opacity: 0, duration: 0.45, ease: "power2.out" }, IMPACT + 0.04);
  }

  // 4. Рамка схлопывается на знак, дальше общий финал со словом
  const at = IMPACT + 0.1;
  addSelection(tl, p, { at, centreShift, u, reveal: false, start: { l: -4, r: 109, t: -2, b: 100 } });
  tl.fromTo([p.status, p.titleBar], { opacity: 0, y: 8 }, { opacity: 1, y: 0, duration: 0.6, ease: EASE.out }, 0.6)
    .addLabel(EXIT_LABEL, at + 2.1);
  return tl;
}
