/**
 * Общие приёмы движения для ролика.
 *
 * Всё, что меняется во времени, живёт в одном мастер-таймлайне, который
 * рендер перематывает кадр за кадром через seek(t, false). Поэтому текст
 * счётчиков и печать строк сделаны твинами прокси-объектов с onUpdate:
 * при перемотке вперёд и назад они дают одно и то же состояние кадра.
 */
import { EASE, gsap } from "@/ui/redesign/theme/gsapSetup";

export { EASE, gsap };

export type Timeline = gsap.core.Timeline;
type Target = gsap.TweenTarget;

/**
 * Звуковые события. Анимация сама объявляет, где у неё клик, печать или
 * вспышка, а генератор саундтрека ставит звуки ровно на эти моменты —
 * при любой перестройке таймлайна звук не разъезжается с картинкой.
 */
export interface Cue {
  t: number;
  kind: string;
  /** Длительность для протяжных звуков: печать, свипы, сканирование */
  dur?: number;
  /** Порядковый номер или число событий — например, символов при печати */
  n?: number;
  /** Громкость относительно базовой для этого вида, 1 — как есть */
  gain?: number;
}

const cues: Cue[] = [];

export function cue(kind: string, t: number, extra: Omit<Cue, "t" | "kind"> = {}) {
  cues.push({ t: Math.round(t * 1000) / 1000, kind, ...extra });
}

export function allCues() {
  return [...cues].sort((a, b) => a.t - b.t);
}

/** Покадровые обновления, которые проще посчитать от времени, чем твинить */
const frameHooks: Array<(time: number) => void> = [];

export function onFrame(hook: (time: number) => void) {
  frameHooks.push(hook);
}

export function runFrameHooks(time: number) {
  for (const hook of frameHooks) hook(time);
}

/** Поиск по data-p внутри корня; промах — ошибка, а не тихо пустой кадр */
export function scoped(root: ParentNode) {
  const one = <T extends Element = HTMLElement>(name: string) => {
    const element = root.querySelector<T>(`[data-p="${name}"]`);
    if (!element) throw new Error(`promo: no element [data-p="${name}"]`);
    return element;
  };
  const all = <T extends Element = HTMLElement>(name: string) => {
    const list = Array.from(root.querySelectorAll<T>(`[data-p="${name}"]`));
    if (list.length === 0) throw new Error(`promo: no elements [data-p="${name}"]`);
    return list;
  };
  return { one, all };
}

export type Scope = ReturnType<typeof scoped>;

/** Строки под масками въезжают снизу, из расфокуса */
export function revealLines(tl: Timeline, lines: Target, at: number | string, stagger = 0.08) {
  return tl.fromTo(
    lines,
    { yPercent: 115, opacity: 0, filter: "blur(10px)" },
    {
      yPercent: 0,
      opacity: 1,
      filter: "blur(0px)",
      duration: 1,
      ease: EASE.out,
      stagger,
    },
    at,
  );
}

/** Уход строк: вверх и в расфокус, короче входа */
export function hideLines(tl: Timeline, lines: Target, at: number | string, stagger = 0.04) {
  return tl.to(
    lines,
    { yPercent: -110, opacity: 0, filter: "blur(8px)", duration: 0.5, ease: "power2.in", stagger },
    at,
  );
}

/** Число, которое перетекает от from к to */
export function counter(
  el: Element,
  from: number,
  to: number,
  format: (value: number) => string,
  vars: gsap.TweenVars,
) {
  const proxy = { value: from };
  return gsap.fromTo(
    proxy,
    { value: from },
    {
      value: to,
      ...vars,
      onUpdate: () => {
        el.textContent = format(proxy.value);
      },
    },
  );
}

/** Печать строки посимвольно */
export function typeText(el: Element, text: string, vars: gsap.TweenVars) {
  const proxy = { count: 0 };
  return gsap.fromTo(
    proxy,
    { count: 0 },
    {
      count: text.length,
      ease: "none",
      ...vars,
      onUpdate: () => {
        el.textContent = text.slice(0, Math.round(proxy.count));
      },
    },
  );
}

/** Смена надписи: старая уходит вверх, новая приходит снизу */
export function swapText(tl: Timeline, from: Element, to: Element, at: number) {
  return tl
    .to(from, { yPercent: -60, opacity: 0, duration: 0.22, ease: "power2.in" }, at)
    .fromTo(to, { yPercent: 60, opacity: 0 }, { yPercent: 0, opacity: 1, duration: 0.35, ease: EASE.out }, at + 0.12);
}

/** Координаты элемента в системе контейнера без учёта transform предков */
export function localRect(el: HTMLElement, container: HTMLElement) {
  let x = 0;
  let y = 0;
  let node: HTMLElement | null = el;
  while (node && node !== container) {
    x += node.offsetLeft;
    y += node.offsetTop;
    node = node.offsetParent as HTMLElement | null;
  }
  if (node !== container) throw new Error("promo: element is not inside the container");
  return { x, y, width: el.offsetWidth, height: el.offsetHeight, cx: x + el.offsetWidth / 2, cy: y + el.offsetHeight / 2 };
}

/** Подпись сцены: строки въезжают на from и уходят на to */
export function caption(tl: Timeline, $: Scope, id: string, from: number, to: number) {
  const lines = $.all(`cap.${id}.line`);
  revealLines(tl, lines, from, 0.07);
  cue("title", from);
  hideLines(tl, lines, to, 0.03);
}

/** Вспышка на склейке: мгновенный пик и мягкий спад */
export function flash(tl: Timeline, $: Scope, at: number, peak = 0.85, duration = 0.55) {
  cue("impact", at, { gain: peak });
  tl.fromTo($.one("flash"), { opacity: peak }, { opacity: 0, duration, ease: "power2.out", immediateRender: false }, at);
}
