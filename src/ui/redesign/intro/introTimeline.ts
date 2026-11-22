/**
 * Таймлайны заставки запуска — «Вырезка».
 *
 * Вход: точка набухает и выстреливает линией, лента записи проматывается и
 * тормозит точно на нужном отрезке, триммеры с замахом бьют по нему. Триммеры
 * становятся рамкой выделения: раскрывают F, правая скобка едет по краю слова,
 * пока «etchr» собирается из разреженного набора, затем рамка растворяется.
 * Уход: буквы по дугам собираются в отрезок, знак приседает и по дуге прыгает
 * на своё место в топбаре. Все величины сцены — в единицах сетки знака (96).
 */
import {
  BRAND_ACCENT,
  WORDMARK_LETTER_LEFT,
  WORDMARK_LETTER_RIGHT,
} from "@/ui/redesign/brand/FetchrBrand";
import { EASE, Flip, gsap } from "@/ui/redesign/theme/gsapSetup";

import type { AsciiBackdrop } from "./asciiBackdrop";

/** К этой метке вход доигран; дальше заставкой управляет фаза запуска */
export const EXIT_LABEL = "exit";

/** Перелёт в топбар, с */
const FLIGHT = 0.66;
/** Начало перемотки ленты, с */
const SCROLL_FROM = 0.12;
/** Разгон ленты до крейсерской скорости, с */
const ACCEL_TIME = 0.44;
/** Крейсерская скорость ленты, единиц сетки в секунду */
const CRUISE_SPEED = 3600;
/** Здесь лента едет, пока не закончатся проверки запуска */
const CRUISE_AT = SCROLL_FROM + ACCEL_TIME;
/** Торможение до нужного отрезка: начальная скорость power3.out = крейсерской */
const BRAKE_TIME = 0.75;
const BRAKE_DIST = (CRUISE_SPEED * BRAKE_TIME) / 3;
/** Зазор перед торможением, чтобы оно не стартовало раньше паузы */
const BRAKE_GAP = 0.05;
/** Удар по отрезку, с от начала входа (без учёта времени проверок) */
const IMPACT = CRUISE_AT + BRAKE_GAP + BRAKE_TIME;
/** Период повторения ленты, единиц сетки */
const PERIOD = 2400;
/** Отрезок и средняя линия ленты */
const CHIP = { x: 79, y: 57.5 } as const;
const LANE = { y: 48, h: 19 } as const;
export const TEXT = "#F3F6FB";

const SVG_NS = "http://www.w3.org/2000/svg";

export interface IntroParts {
  backdrop: HTMLElement;
  titleBar: HTMLElement;
  lockup: HTMLElement;
  markWrap: HTMLElement;
  glow: HTMLElement;
  mark: SVGSVGElement;
  fx: SVGGElement;
  fxTop: SVGGElement;
  body: SVGPathElement;
  bodyMaskRect: SVGRectElement;
  chip: SVGRectElement;
  letters: SVGGElement;
  wordClip: SVGRectElement;
  wordWrap: HTMLElement;
  word: HTMLElement;
  status: HTMLElement;
  /** ASCII-фон заставки; задаётся снаружи после сборки частей */
  ascii?: AsciiBackdrop;
}

export interface IntroAnchors {
  mark: HTMLElement;
  name: HTMLElement | null;
}

const PART_NAMES = [
  "backdrop",
  "titleBar",
  "lockup",
  "markWrap",
  "glow",
  "mark",
  "fx",
  "fxTop",
  "body",
  "bodyMaskRect",
  "chip",
  "letters",
  "wordClip",
  "wordWrap",
  "word",
  "status",
] as const satisfies ReadonlyArray<Exclude<keyof IntroParts, "ascii">>;

export function collectParts(root: HTMLElement): IntroParts {
  const entries = PART_NAMES.map((name) => {
    const element = root.querySelector(`[data-intro-part="${name}"]`);
    if (!element) throw new Error(`Intro splash is missing its "${name}" part`);
    return [name, element] as const;
  });
  return Object.fromEntries(entries) as unknown as IntroParts;
}

/**
 * Места посадки в топбаре. Нет знака или он схлопнут (топбар ещё не
 * отрисован) — вместо перелёта будет растворение.
 */
export function findAnchors(): IntroAnchors | null {
  const mark = document.querySelector<HTMLElement>('[data-intro-anchor="mark"]');
  if (!mark) return null;
  const box = mark.getBoundingClientRect();
  if (box.width < 1 || box.height < 1) return null;
  return {
    mark,
    name: document.querySelector<HTMLElement>('[data-intro-anchor="name"]'),
  };
}

/** Приложение монтируется только после проверки лицензии: ждём, пока топбар встанет */
export function waitForAnchors(timeoutMs: number): Promise<IntroAnchors | null> {
  return new Promise((resolve) => {
    const deadline = performance.now() + timeoutMs;
    const poll = () => {
      const anchors = findAnchors();
      if (anchors || performance.now() >= deadline) resolve(anchors);
      else window.setTimeout(poll, 40);
    };
    poll();
  });
}

// ---------- Вспомогательное ----------

export function svgEl<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number>,
  parent: Element,
): SVGElementTagNameMap[K] {
  const element = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) element.setAttribute(key, String(value));
  parent.appendChild(element);
  return element;
}

export const letterEls = (p: IntroParts) => Array.from(p.letters.children) as SVGPathElement[];

/** Пикселей на единицу сетки знака: рамка знака — 75 единиц в высоту */
export const unitPx = (p: IntroParts) => {
  const height = p.mark.getBoundingClientRect().height;
  return height > 0 ? height / 75 : 1;
};

export interface Selection {
  l: number;
  r: number;
  t: number;
  b: number;
  hk: number;
  bw: number;
}

/** Рамка выделения из квадратных скобок, геометрия — объект Selection */
export function makeFrame(parent: Element) {
  const g = svgEl("g", { opacity: 0, fill: TEXT }, parent);
  const rects = Array.from({ length: 6 }, () => svgEl("rect", { rx: 0.8 }, g));
  const set = (el: SVGRectElement, x: number, y: number, w: number, h: number) => {
    el.setAttribute("x", String(x));
    el.setAttribute("y", String(y));
    el.setAttribute("width", String(Math.max(0, w)));
    el.setAttribute("height", String(Math.max(0, h)));
  };
  return {
    g,
    draw({ l, r, t, b, hk, bw }: Selection) {
      const th = Math.min(bw, Math.max(0, b - t));
      set(rects[0], l, t, bw, b - t);
      set(rects[1], l, t, hk, th);
      set(rects[2], l, b - th, hk, th);
      set(rects[3], r - bw, t, bw, b - t);
      set(rects[4], r - hk, t, hk, th);
      set(rects[5], r - hk, b - th, hk, th);
    },
  };
}

/** Триммер для удара: вертикаль и два уголка */
function makeBracket(parent: Element, dir: -1 | 1) {
  const g = svgEl("g", { opacity: 0 }, parent);
  const bx = dir < 0 ? 62 : 93;
  const hx = dir < 0 ? bx : bx - 2;
  svgEl("rect", { x: bx, y: 41, width: 3, height: 33, rx: 1, fill: TEXT }, g);
  svgEl("rect", { x: hx, y: 41, width: 5, height: 3, fill: TEXT }, g);
  svgEl("rect", { x: hx, y: 71, width: 5, height: 3, fill: TEXT }, g);
  return g;
}

/** Сбрасывает сцену к итоговому кадру: знак целиком, слово на месте */
export function resetScene(p: IntroParts) {
  p.fx.replaceChildren();
  p.fxTop.replaceChildren();
  gsap.set([p.chip, p.mark, ...letterEls(p)], { clearProps: "all" });
  p.bodyMaskRect.setAttribute("x", "-20");
  p.bodyMaskRect.setAttribute("y", "-20");
  p.bodyMaskRect.setAttribute("width", "160");
  p.bodyMaskRect.setAttribute("height", "140");
  p.wordClip.setAttribute("x", "91");
  p.wordClip.setAttribute("width", "300");
}

// ---------- Вход ----------

/**
 * checksDone: true — проверки уже прошли; промис — лента едет, пока он не
 * выполнится. Без него лента сразу тормозит.
 */
export function buildEntrance(p: IntroParts, checksDone?: () => true | Promise<void>) {
  resetScene(p);
  const u = unitPx(p);
  const letters = letterEls(p);

  // Постановка: пока слова нет, знак стоит по центру экрана, а не на своём месте в локапе
  const lockup = p.lockup.getBoundingClientRect();
  const markBox = p.markWrap.getBoundingClientRect();
  const centreShift = lockup.left + lockup.width / 2 - (markBox.left + markBox.width / 2);
  gsap.set(p.markWrap, { x: centreShift });
  gsap.set(p.mark, { opacity: 1 });
  gsap.set(p.chip, { opacity: 0, transformOrigin: "50% 50%" });
  // Знак скрыт: маска открыта только на месте отрезка
  p.bodyMaskRect.setAttribute("x", "65");
  p.bodyMaskRect.setAttribute("y", "41");
  p.bodyMaskRect.setAttribute("width", "28");
  p.bodyMaskRect.setAttribute("height", "33");
  // Буквы приходят разреженными
  gsap.set(letters, { opacity: 0, x: (i: number) => 26 + i * 30, transformOrigin: "0% 100%" });

  // Лента записи
  const line = svgEl("rect", { x: CHIP.x, y: CHIP.y - 0.75, width: 0, height: 1.5, fill: BRAND_ACCENT, opacity: 0.4 }, p.fx);
  const seed = svgEl("rect", { x: CHIP.x - 3, y: CHIP.y - 3, width: 6, height: 6, rx: 3, fill: BRAND_ACCENT }, p.fx);
  // Лента повторяется с периодом PERIOD: пока идут проверки, она может ехать
  // сколько угодно. Каждый отрезок нарисован в трёх копиях, чтобы перекрыть кадр.
  const streamWrap = svgEl("g", { opacity: 0 }, p.fx);
  const stream = svgEl("g", {}, streamWrap);
  const segs: Array<{ el: SVGRectElement; x: number; w: number; d: number }> = [];
  let rand = 11;
  const rnd = () => (rand = (rand * 9301 + 49297) % 233280) / 233280;
  for (let x = 0; x < PERIOD - 40; ) {
    const w = 8 + Math.round(rnd() * 34);
    const opacity = (0.1 + rnd() * 0.16).toFixed(2);
    for (const copy of [-PERIOD, 0, PERIOD]) {
      const el = svgEl("rect", { x: x + copy, y: LANE.y, width: w, height: LANE.h, rx: 4, fill: BRAND_ACCENT, opacity }, stream);
      segs.push({ el, x: x + copy, w, d: 9999 });
    }
    x += w + 6 + Math.round(rnd() * 22);
  }
  // Нужный отрезок едет отдельно: его место считается в момент торможения
  const target = svgEl("rect", { x: 9999, y: LANE.y, width: 24, height: LANE.h, rx: 4, fill: BRAND_ACCENT, opacity: 0 }, streamWrap);
  const all = [...segs.map((s) => ({ el: s.el, w: s.w })), { el: target, w: 24 }];

  const tl = gsap.timeline();

  // Пройденный путь ленты; на торможении — где он закончится
  const trip = { d: 0 };
  let tripEnd = 0;
  let braking = false;
  const wrapShift = (d: number) => -(((d % PERIOD) + PERIOD) % PERIOD);

  // Перемотка: растяжение и сжатие отрезков по скорости
  let last = 0;
  let lastT = -1;
  let kS = 0;
  const moveStream = () => {
    const t = performance.now() / 1000;
    const vel = t > lastT && lastT >= 0 ? (trip.d - last) / (t - lastT) : 0;
    last = trip.d;
    lastT = t;
    if (p.ascii) p.ascii.state.scroll = trip.d;
    if (braking) target.setAttribute("x", String(67 + (tripEnd - trip.d)));
    const k = Math.max(0, Math.min(Math.abs(vel) / 5200, 1));
    kS += (k - kS) * 0.6;
    const stretch = 1 + kS * 11;
    const h = LANE.h * (1 - 0.6 * kS);
    for (const s of all) {
      s.el.setAttribute("width", String(s.w * stretch));
      s.el.setAttribute("height", String(h));
      s.el.setAttribute("y", String(CHIP.y - h / 2));
      s.el.setAttribute("rx", String(Math.min(4, h / 2)));
    }
    line.setAttribute("opacity", (0.4 + kS * 0.5).toFixed(2));
    line.setAttribute("height", String(1.5 + kS * 2));
    line.setAttribute("y", String(CHIP.y - (1.5 + kS * 2) / 2));
    stream.setAttribute("transform", `translate(${wrapShift(trip.d)} 0)`);
  };

  /** Начало торможения: где встанет лента, какие отрезки уберутся с места знака */
  const startBrake = () => {
    braking = true;
    tripEnd = trip.d + BRAKE_DIST;
    const shiftEnd = wrapShift(tripEnd);
    for (const s of segs) {
      const finalX = s.x + shiftEnd;
      s.d = Math.abs(finalX + s.w / 2 - CHIP.x);
      // Эти отрезки встали бы на место знака — они ещё за краем кадра, гасим их
      if (finalX + s.w > 36 && finalX < 112) s.el.setAttribute("opacity", "0");
    }
    target.setAttribute("opacity", "0.34");
  };

  // Крейсерская скорость, пока идут проверки: путь растёт сам, без таймлайна
  let cruiseLast = 0;
  const cruiseTick = () => {
    const now = performance.now() / 1000;
    if (cruiseLast) trip.d += CRUISE_SPEED * Math.min(0.1, now - cruiseLast);
    cruiseLast = now;
    moveStream();
  };
  const stopCruise = () => {
    gsap.ticker.remove(cruiseTick);
    cruiseLast = 0;
  };
  const cruise = () => {
    if (!checksDone) return;
    const ready = checksDone();
    if (ready === true) return;
    tl.pause();
    gsap.ticker.add(cruiseTick);
    void ready.then(() => {
      stopCruise();
      // Торможение считается от того места, где лента оказалась сейчас
      brake.invalidate();
      startBrake();
      tl.resume();
    });
  };
  tl.eventCallback("onInterrupt", stopCruise);
  const brake = gsap.to(trip, {
    d: () => trip.d + BRAKE_DIST,
    duration: BRAKE_TIME,
    ease: "power3.out",
    onStart: startBrake,
    onUpdate: moveStream,
  });

  const bl = makeBracket(p.fxTop, -1);
  const br = makeBracket(p.fxTop, 1);
  gsap.set([bl, br], { transformOrigin: "50% 50%" });

  const bg = p.ascii?.state;
  if (bg) {
    tl.fromTo(bg, { fade: 0 }, { fade: 1, duration: 1.4, ease: "sine.inOut" }, 0)
      .fromTo(bg, { ring: 0.05, ringA: 0 }, { ring: 1.35, duration: 1.3, ease: "power2.out" }, IMPACT)
      .to(bg, { ringA: 1, duration: 0.08 }, IMPACT)
      .to(bg, { ringA: 0, duration: 1.1, ease: "sine.inOut" }, IMPACT + 0.08)
      .fromTo(bg, { calm: 0 }, { calm: 1, duration: 1.2, ease: "sine.inOut" }, IMPACT);
  }

  tl
    // 1. Предвосхищение: точка набухает и сплющивается, затем выстреливает линией
    .fromTo(seed, { scale: 0, transformOrigin: "50% 50%" }, { scale: 1.25, duration: 0.1, ease: "back.out(3)" }, 0)
    .to(seed, { scaleX: 2.1, scaleY: 0.4, duration: 0.05, ease: "power2.in" }, 0.1)
    .to(seed, { opacity: 0, duration: 0.06 }, 0.15)
    .fromTo(line, { attr: { x: CHIP.x, width: 0 } }, { attr: { x: CHIP.x - 2400, width: 4800 }, duration: 0.32, ease: "expo.out" }, 0.15)
    .fromTo(p.glow, { opacity: 0, scale: 0.5 }, { opacity: 0.5, scale: 1, duration: 0.6, ease: "power2.out" }, 0.05)
    // 2. Перемотка до нужного отрезка
    //    Разгон до крейсерской скорости, затем лента едет, пока идут проверки,
    //    и тормозит точно на отрезке. Длина интро зависит от проверок, скорость — нет.
    .to(streamWrap, { attr: { opacity: 1 }, duration: 0.12 }, SCROLL_FROM)
    .fromTo(trip, { d: 0 }, { d: (CRUISE_SPEED * ACCEL_TIME) / 2, duration: ACCEL_TIME, ease: "power2.in", onUpdate: moveStream }, SCROLL_FROM)
    .call(cruise, undefined, CRUISE_AT)
    .add(brake, CRUISE_AT + BRAKE_GAP)
    // 3. Триммеры: появляются на торможении, замах наружу, удар с разгоном
    .fromTo(bl, { x: -150, opacity: 0 }, { x: -170, opacity: 1, duration: 0.14, ease: "power2.out" }, IMPACT - 0.38)
    .fromTo(br, { x: 150, opacity: 0 }, { x: 170, opacity: 1, duration: 0.14, ease: "power2.out" }, IMPACT - 0.38)
    .to(bl, { x: 3, duration: 0.24, ease: "expo.in" }, IMPACT - 0.24)
    .to(br, { x: -3, duration: 0.24, ease: "expo.in" }, IMPACT - 0.24)
    .to([bl, br], { scaleY: 1.32, scaleX: 0.5, duration: 0.04, ease: "power1.out" }, IMPACT)
    .to(bl, { x: 0, duration: 0.3, ease: "elastic.out(1, 0.4)" }, IMPACT + 0.04)
    .to(br, { x: 0, duration: 0.3, ease: "elastic.out(1, 0.4)" }, IMPACT + 0.04)
    .to([bl, br], { scaleY: 1, scaleX: 1, duration: 0.3, ease: "elastic.out(1, 0.4)" }, IMPACT + 0.04)
    // 4. Удар: отрезок пойман — сплющивается, растягивается и пружинит
    .set(p.chip, { opacity: 1 }, IMPACT)
    .set(target, { attr: { opacity: 0 } }, IMPACT)
    .fromTo(p.chip, { scaleX: 1.42, scaleY: 0.62 }, { scaleX: 0.84, scaleY: 1.22, duration: 0.06, ease: "power2.out", immediateRender: false }, IMPACT)
    .to(p.chip, { scaleX: 1, scaleY: 1, duration: 0.34, ease: "elastic.out(1, 0.5)" }, IMPACT + 0.06)
    .to(p.glow, { opacity: 1, scale: 1.14, duration: 0.08, ease: "power2.out" }, IMPACT)
    .to(p.glow, { opacity: 0.72, scale: 1, duration: 0.6, ease: "power2.out" }, IMPACT + 0.08)
    // 5. Вторичное действие: лента осыпается от центра, линия втягивается в отрезок
    .to(line, { attr: { x: 67, width: 24 }, opacity: 0, duration: 0.2, ease: "power3.in" }, IMPACT + 0.02);
  // Лента осыпается от центра наружу: задержка каждого отрезка — от его расстояния до знака
  const fallEase = gsap.parseEase("power2.in");
  const fall = { t: 0 };
  tl.to(fall, {
    t: 0.45,
    duration: 0.45,
    ease: "none",
    onStart() {
      for (const s of segs) s.el.dataset.o = s.el.getAttribute("opacity") ?? "0";
    },
    onUpdate() {
      for (const s of segs) {
        if (s.d > 1400) continue;
        const k = fallEase(Math.max(0, Math.min(1, (fall.t - Math.min(s.d / 4000, 0.14)) / 0.28)));
        s.el.setAttribute("transform", `translate(0 ${(8 + (s.d % 17)) * k})`);
        s.el.setAttribute("opacity", String(Number(s.el.dataset.o) * (1 - k)));
      }
    },
  }, IMPACT + 0.02)
    .to(streamWrap, { attr: { opacity: 0 }, duration: 0.2 }, IMPACT + 0.4);

  // 6–8. Рамка выделения: раскрывает F, едет по краю слова, растворяется
  const at = IMPACT + 0.3;
  addSelection(tl, p, { at, centreShift, u, reveal: true, start: { l: 62, r: 96, t: 41, b: 74 } });
  tl.set([bl, br], { opacity: 0 }, at)
    // Проверки идут с первой секунды — рейка встаёт, как только есть знак
    .fromTo([p.status, p.titleBar], { opacity: 0, y: 8 }, { opacity: 1, y: 0, duration: 0.6, ease: EASE.out }, 0.6)
    .addLabel(EXIT_LABEL, at + 2.1);
  return tl;
}

interface SelectionOptions {
  /** Момент появления рамки, с */
  at: number;
  /** Сдвиг знака к центру экрана, px */
  centreShift: number;
  /** Пикселей на единицу сетки */
  u: number;
  /** true — рамка на раскрытии открывает тело F маской */
  reveal: boolean;
  /** Откуда рамка раскрывается на весь знак */
  start: Pick<Selection, "l" | "r" | "t" | "b">;
}

/**
 * Общий финал входа: рамка выделения встаёт на знак, локап проезжает на место,
 * «etchr» трекингом собирается из разреженного набора, правая скобка едет за
 * последней буквой, затем рамка растворяется. Конец — at + 2.1.
 */
export function addSelection(
  tl: gsap.core.Timeline,
  p: IntroParts,
  { at, centreShift, u, reveal, start }: SelectionOptions,
) {
  const letters = letterEls(p);
  const sel: Selection = { ...start, hk: 7, bw: 3 };
  const frame = makeFrame(p.fxTop);
  let revealing = reveal;
  const draw = () => {
    frame.draw(sel);
    if (!revealing) return;
    p.bodyMaskRect.setAttribute("x", String(sel.l + 3));
    p.bodyMaskRect.setAttribute("width", String(Math.max(0, sel.r - sel.l - 6)));
    p.bodyMaskRect.setAttribute("y", String(sel.t));
    p.bodyMaskRect.setAttribute("height", String(sel.b - sel.t));
  };
  tl.call(draw, undefined, at)
    .set(frame.g, { attr: { opacity: 1 } }, at)
    .to(sel, { l: 5, r: 100, t: 5, b: 93, duration: 0.5, ease: "power3.out", onUpdate: draw }, at)
    .call(() => {
      revealing = false;
      p.bodyMaskRect.setAttribute("x", "-20");
      p.bodyMaskRect.setAttribute("y", "-20");
      p.bodyMaskRect.setAttribute("width", "160");
      p.bodyMaskRect.setAttribute("height", "140");
    }, undefined, at + 0.5)
    .fromTo(p.mark, { scale: 0.97, transformOrigin: "50% 50%" }, { scale: 1, duration: 0.6, ease: "power2.out", immediateRender: false }, at + 0.05)
    .to(p.glow, { opacity: 0.95, scale: 1.1, duration: 0.12 }, at + 0.05)
    .to(p.glow, { opacity: 0.72, scale: 1, duration: 0.6, ease: "power2.out" }, at + 0.17)
    // Проезд локапа: мягкий замах вправо и переход на место
    .to(p.markWrap, { x: centreShift + 5 * u, duration: 0.18, ease: "sine.inOut" }, at + 0.45)
    .to(p.markWrap, { x: 0, duration: 0.62, ease: "power3.inOut" }, at + 0.63);

  // Трекинг: буквы трогаются по очереди, на скорости вытянуты, проскакивают место и возвращаются
  letters.forEach((letter, i) => {
    const t = at + 0.68 + i * 0.03;
    tl.fromTo(letter, { scaleX: 1.28 }, { scaleX: 1, duration: 0.6, ease: "power3.out" }, t)
      .to(letter, { x: -3, duration: 0.72, ease: "expo.out" }, t)
      .to(letter, { x: 0, duration: 0.42, ease: "sine.inOut" }, t + 0.72)
      .to(letter, { opacity: 1, duration: 0.32, ease: "power1.out" }, t);
  });
  // Правая скобка вылетает к последней букве и едет вместе с ней
  const lastLetter = letters[letters.length - 1];
  const out = gsap.parseEase("power3.out");
  const follow = { t: 0 };
  tl.to(follow, {
    t: 1,
    duration: 0.8,
    ease: "none",
    onUpdate() {
      const k = out(Math.min(1, (follow.t * 0.8) / 0.32));
      const edge = WORDMARK_LETTER_RIGHT[4] + 9 + Number(gsap.getProperty(lastLetter, "x"));
      sel.r = 100 + (edge - 100) * k;
      draw();
    },
  }, at + 0.68);
  // Скобки растворяются: расходятся, истончаются, уголки втягиваются
  tl.to(sel, { l: "-=8", r: "+=8", t: "-=3", b: "+=3", bw: 0.6, hk: 0, duration: 0.6, ease: "sine.inOut", onUpdate: draw }, at + 1.5)
    .to(frame.g, { attr: { opacity: 0 }, duration: 0.55, ease: "sine.inOut" }, at + 1.55);
}

/**
 * Повторный показ поверх открытого приложения (обновление из настроек):
 * знак уже собран и слетает из топбара в центр — обратный перелёт.
 */
export function buildReentry(p: IntroParts, anchors: IntroAnchors | null) {
  resetScene(p);
  gsap.set(p.mark, { opacity: 1 });
  if (p.ascii) gsap.set(p.ascii.state, { fade: 1, calm: 1 });

  const tl = gsap
    .timeline()
    .fromTo(p.backdrop, { opacity: 0 }, { opacity: 1, duration: 0.45, ease: "power2.inOut" }, 0)
    .fromTo(p.glow, { opacity: 0, scale: 0.6 }, { opacity: 0.8, scale: 1, duration: 1, ease: EASE.cine }, 0.3)
    .fromTo([p.status, p.titleBar], { opacity: 0, y: 8 }, { opacity: 1, y: 0, duration: 0.5, ease: EASE.out }, 0.5);

  const flight = anchors && flightTo(p, anchors);
  if (!flight) {
    return tl.fromTo(p.lockup, { opacity: 0, scale: 0.96 }, { opacity: 1, scale: 1, duration: 0.55, ease: EASE.out }, 0.15);
  }
  gsap.set(p.lockup, { transformOrigin: flight.origin });
  return tl
    .from(p.lockup, { x: flight.x, y: flight.y, scale: flight.scale, duration: 0.9, ease: "power3.inOut" }, 0)
    .fromTo(letterEls(p), { opacity: 0 }, { opacity: 1, duration: 0.5, ease: EASE.out, stagger: 0.04 }, 0.5);
}

/** Пока фаза не решена, свечение дышит: заставка не выглядит зависшей */
export function buildIdle(p: IntroParts) {
  return gsap.to(p.glow, {
    opacity: 0.55,
    scale: 0.94,
    duration: 1.8,
    ease: "sine.inOut",
    yoyo: true,
    repeat: -1,
  });
}

/**
 * Подъём к активации. Вызывается после того, как React отрисовал табличку:
 * локап уже стоит на новом месте и в новом размере, Flip возвращает его
 * в снятое до перерисовки состояние и ведёт оттуда.
 */
export function buildRise(p: IntroParts, before: Flip.FlipState, card: HTMLElement) {
  const items = card.querySelectorAll("[data-activation-part='item']");
  return gsap
    .timeline()
    .add(Flip.from(before, { duration: 1, ease: "power3.inOut", scale: true }), 0)
    .to(p.status, { opacity: 0, y: 8, duration: 0.3, ease: EASE.out }, 0)
    .to(p.glow, { opacity: 0.5, scale: 1, duration: 0.8, ease: EASE.out }, 0)
    .fromTo(
      card,
      { opacity: 0, y: 32, scale: 0.98, filter: "blur(8px)" },
      { opacity: 1, y: 0, scale: 1, filter: "blur(0px)", duration: 0.85, ease: EASE.cine },
      0.32,
    )
    .set(card, { clearProps: "filter,transform" }, 1.2)
    .fromTo(
      items,
      { opacity: 0, y: 10 },
      { opacity: 1, y: 0, duration: 0.55, ease: EASE.out, stagger: 0.06, clearProps: "transform" },
      0.46,
    );
}

/** Табличка уходит, локап гаснет на месте — перед возвратом в центр */
export function buildCardOut(p: IntroParts, card: HTMLElement | null) {
  const tl = gsap.timeline().to(p.lockup, { opacity: 0, scale: 0.96, duration: 0.3, ease: EASE.out }, 0);
  return card ? tl.to(card, { opacity: 0, y: 16, duration: 0.3, ease: EASE.out }, 0) : tl;
}

/** Локап снова в центре после ухода таблички: проявляется, рейка возвращается */
export function buildSettle(p: IntroParts) {
  return gsap
    .timeline()
    .fromTo(p.lockup, { opacity: 0, scale: 0.96 }, { opacity: 1, scale: 1, duration: 0.5, ease: EASE.out }, 0)
    .to(p.glow, { opacity: 0.8, scale: 1, duration: 0.6, ease: EASE.out }, 0)
    .fromTo(p.status, { opacity: 0, y: 8 }, { opacity: 1, y: 0, duration: 0.45, ease: EASE.out }, 0.1)
    .set(p.lockup, { clearProps: "transform" });
}

/**
 * Уход: буквы по дугам собираются в отрезок (он пружинит на каждой), знак
 * приседает перед прыжком и по дуге летит на своё место в топбаре — с
 * растяжкой в полёте и мягкой посадкой. Фон гаснет, пока знак летит.
 */
export function buildExit(
  p: IntroParts,
  anchors: IntroAnchors | null,
  extra: Element | null,
  onLanded: () => void,
) {
  const fading = extra ? [p.status, p.titleBar, extra] : [p.status, p.titleBar];
  const tl = gsap.timeline().to(fading, { opacity: 0, duration: 0.22, ease: EASE.out }, 0);

  const flight = anchors && flightTo(p, anchors);
  if (!flight) {
    return tl
      .add(onLanded, 0)
      .to(p.lockup, { opacity: 0, scale: 0.96, filter: "blur(8px)", duration: 0.45, ease: EASE.out }, 0)
      .to(p.backdrop, { opacity: 0, duration: 0.55, ease: "power2.inOut" }, 0.1);
  }

  // Буквы собираются в отрезок по дугам
  const letters = letterEls(p);
  const FLY = 0.46;
  const STEP = 0.07;
  p.wordClip.setAttribute("x", "-200");
  p.wordClip.setAttribute("width", "700");
  gsap.set(p.chip, { transformOrigin: "50% 50%" });
  letters.forEach((letter, i) => {
    const cx = (WORDMARK_LETTER_LEFT[i] + WORDMARK_LETTER_RIGHT[i]) / 2;
    const t0 = i * STEP;
    const t = t0 + 0.09;
    const lift = -14 - i * 4;
    tl.to(letter, { x: 4, duration: 0.09, ease: "sine.out" }, t0)
      .to(letter, { x: CHIP.x - cx, duration: FLY, ease: "power2.in" }, t)
      .to(letter, { y: lift, duration: FLY * 0.45, ease: "sine.out" }, t)
      .to(letter, { y: CHIP.y - 58, duration: FLY * 0.55, ease: "sine.in" }, t + FLY * 0.45)
      .to(letter, { scale: 0.12, transformOrigin: "50% 50%", duration: FLY, ease: "power3.in" }, t)
      .to(letter, { opacity: 0, duration: FLY * 0.3, ease: "power1.in" }, t + FLY * 0.7)
      .to(p.chip, { scaleX: 1.1, scaleY: 0.9, duration: 0.06, ease: "sine.out" }, t + FLY - 0.03)
      .to(p.chip, { scaleX: 1, scaleY: 1, duration: 0.22, ease: "back.out(2)" }, t + FLY + 0.03)
      .to(p.glow, { opacity: 0.72 + 0.05 * (i + 1), scale: 1 + 0.02 * (i + 1), duration: 0.08, ease: "power2.out" }, t + FLY - 0.02);
  });

  // Предвосхищение прыжка: присесть и отойти против направления полёта
  const u = unitPx(p);
  const go = (letters.length - 1) * STEP + 0.09 + FLY + 0.06;
  gsap.set(p.lockup, { transformOrigin: flight.origin });
  tl.to(p.lockup, { x: 6 * u, y: 5 * u, duration: 0.2, ease: "sine.inOut" }, go - 0.04)
    .to(p.mark, { scaleX: 1.08, scaleY: 0.9, transformOrigin: "50% 50%", duration: 0.2, ease: "sine.inOut" }, go - 0.04);

  // Прыжок по дуге: по x быстрый старт, по y набор к концу; растяжка на разгоне, мягкая посадка
  const F = go + 0.16;
  tl.to(p.lockup, { x: flight.x, duration: FLIGHT, ease: "power3.inOut" }, F)
    .to(p.lockup, { y: flight.y, duration: FLIGHT * 0.82, ease: "power2.inOut" }, F + FLIGHT * 0.18)
    .to(p.lockup, { scale: flight.scale, duration: FLIGHT, ease: "expo.inOut" }, F)
    .to(p.mark, { scaleX: 1.24, scaleY: 0.84, duration: FLIGHT * 0.45, ease: "power2.in" }, F)
    .to(p.mark, { scaleX: 1, scaleY: 1, duration: FLIGHT * 0.55, ease: "power2.out" }, F + FLIGHT * 0.45)
    .to(p.glow, { opacity: 0, scale: 0.8, duration: 0.5, ease: "power2.in" }, F)
    .to(p.backdrop, { opacity: 0, duration: 0.7, ease: "power2.inOut" }, F + 0.12);

  // Настоящий знак появляется сразу и целиком, а копия гаснет поверх —
  // так на стыке нет провала прозрачности, как при встречном кроссфейде.
  return tl
    .add(onLanded, F + FLIGHT)
    .to(p.lockup, { opacity: 0, duration: 0.18, ease: "none" }, F + FLIGHT);
}

/**
 * Сдвиг и масштаб, которые сажают знак локапа на знак топбара. Считается от
 * локапа без трансформаций — и для вылета, и для обратного влёта.
 */
function flightTo(p: IntroParts, anchors: IntroAnchors) {
  const from = p.mark.getBoundingClientRect();
  const box = p.lockup.getBoundingClientRect();
  const to = anchors.mark.getBoundingClientRect();
  if (from.width < 1) return null;
  return {
    origin: `${from.left - box.left}px ${from.top - box.top}px`,
    x: to.left - from.left,
    y: to.top - from.top,
    scale: to.width / from.width,
  };
}
