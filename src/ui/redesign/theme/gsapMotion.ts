/**
 * Fetchr motion spec на GSAP.
 *
 * Философия прежняя: интерфейс отвечает мгновенно и предсказуемо, одна
 * основная кривая, короткие длительности. Отличие от прежнего слоя на
 * framer-motion — здесь не объекты пропсов, а билдеры таймлайнов: место
 * вызова получает готовый gsap.core.Timeline и решает, когда его играть.
 *
 * Пружин в GSAP нет. Прежние modalSpring (damping 26 / stiffness 380) и
 * layoutSpring (380 / 32) заменены длительностью с кривой back/power:
 * ощущение близкое, но не тождественное — это цена перехода, а не дефект.
 *
 * Значения зеркалят fetchrTokens.css через DUR и EASE из gsapSetup.
 */
import { DUR, EASE, gsap, prefersReducedMotion } from "./gsapSetup";

type Target = gsap.TweenTarget;

/** Пружина модалок: заметный, но не пружинящий доводчик */
const MODAL = { duration: 0.32, ease: "back.out(1.2)" } as const;

/** Пружина перестановок и плавающих индикаторов */
export const LAYOUT = { duration: 0.3, ease: "power3.out" } as const;

// ── Модалки ───────────────────────────────────────────────────────────

export function modalIn(overlay: Target, content: Target) {
  return gsap
    .timeline()
    .fromTo(overlay, { opacity: 0 }, { opacity: 1, duration: DUR.base, ease: EASE.out }, 0)
    .fromTo(
      content,
      { opacity: 0, scale: 0.97, y: 12 },
      { opacity: 1, scale: 1, y: 0, ...MODAL },
      0,
    );
}

export function modalOut(overlay: Target, content: Target) {
  return gsap
    .timeline()
    .to(content, { opacity: 0, scale: 0.98, y: 8, duration: DUR.base, ease: EASE.out }, 0)
    .to(overlay, { opacity: 0, duration: DUR.base, ease: EASE.out }, 0);
}

// ── Переход между страницами ──────────────────────────────────────────

/* Выход короче входа: уходящую страницу читать уже не нужно. Прежний
   AnimatePresence mode="wait" складывал обе длительности, здесь сумма та же
   — 0.14 + 0.18 — но порядком управляет вызывающая сторона. */

export function pageOut(el: Target) {
  return gsap.timeline().to(el, { opacity: 0, y: -8, duration: 0.14, ease: EASE.out });
}

export function pageIn(el: Target) {
  return gsap
    .timeline()
    .fromTo(el, { opacity: 0, y: 8 }, { opacity: 1, y: 0, duration: DUR.base, ease: EASE.out });
}

// ── Списки ────────────────────────────────────────────────────────────

export function listItemIn(el: Target) {
  return gsap
    .timeline()
    .fromTo(el, { opacity: 0, y: 12, scale: 0.98 }, { opacity: 1, y: 0, scale: 1, ...LAYOUT });
}

/** Уход строки: сдвиг влево и схлопывание высоты, чтобы соседи подтянулись */
export function listItemOut(el: Target) {
  return gsap
    .timeline()
    .to(el, { opacity: 0, x: -48, duration: DUR.slow, ease: EASE.out })
    .to(el, { height: 0, marginBottom: 0, duration: DUR.base, ease: EASE.out }, "-=0.08");
}

/** Раскрытие по высоте: GSAP умеет "auto" сам, промежуточный замер не нужен */
export function expand(el: Target) {
  return gsap
    .timeline()
    .fromTo(
      el,
      { height: 0, opacity: 0 },
      { height: "auto", opacity: 1, duration: 0.22, ease: EASE.out },
    );
}

export function collapse(el: Target) {
  return gsap.timeline().to(el, { height: 0, opacity: 0, duration: 0.22, ease: EASE.out });
}

/** Каскадное появление секций — то, ради чего раньше вручную считался индекс */
export const staggerDelay = 0.03;

export function staggerIn(targets: Target) {
  return gsap
    .timeline()
    .fromTo(
      targets,
      { opacity: 0, y: 6 },
      { opacity: 1, y: 0, duration: 0.22, ease: EASE.out, stagger: staggerDelay },
    );
}

// ── Сигнатурный момент ────────────────────────────────────────────────

/**
 * Завершение длинной операции.
 *
 * Структура снята с cine-HUD в fetchr-mute: слои входят лесенкой, и чем
 * дальше слой от фона, тем позже и дольше он идёт. Раньше это имитировали
 * два массива duration/delay — шаги не были связаны, и вставка нового слоя
 * требовала пересчёта всех задержек вручную. Здесь это настоящий таймлайн:
 * позиции заданы относительно предыдущего слоя.
 *
 * Порядок слоёв: подложка, рамка, контент, акцент.
 */
export function signatureTimeline(layers: Element[]) {
  const durations = [0.6, 0.9, 0.7, 0.8];
  const overlaps = ["0", "-=0.52", "-=0.75", "-=0.55"];
  const tl = gsap.timeline();
  layers.forEach((layer, i) => {
    const step = Math.min(i, durations.length - 1);
    tl.fromTo(
      layer,
      { opacity: 0, scale: 0.98 },
      { opacity: 1, scale: 1, duration: durations[step], ease: EASE.cine },
      overlaps[step],
    );
  });
  return tl;
}

/** Вспышка на завершении: прогресс доехал, задача готова */
export function completionFlash(el: Target) {
  return gsap
    .timeline()
    .fromTo(el, { opacity: 0 }, { opacity: 1, duration: DUR.base, ease: EASE.pop })
    .to(el, { opacity: 0, duration: 0.22, ease: EASE.out });
}

// ── Задача уходит в очередь ───────────────────────────────────────────

/**
 * Новая строка очереди вспыхивает и медленно гаснет — тот же ритм, что у
 * строки в промо-ролике: короткий вход, долгий хвост. Анимируется только
 * переменная --row-flash, картинку из неё собирает CSS строки.
 */
export function rowArrivalFlash(row: HTMLElement) {
  if (prefersReducedMotion()) return null;
  return gsap
    .timeline()
    .fromTo(row, { "--row-flash": 0 }, { "--row-flash": 1, duration: 0.2, ease: "none" }, 0.1)
    .to(row, { "--row-flash": 0, duration: 1.1, ease: "power2.out" }, 0.4);
}

interface FlightPoint {
  x: number;
  y: number;
}

/**
 * Полёт пилюли задачи к вкладке «Очередь».
 *
 * Дуга без MotionPath: x и y едут одинаковое время, но на разных кривых —
 * горизонталь разгоняется и тормозит плавно, вертикаль набирает скорость к
 * концу. Так пилюля сначала уходит вбок, а к цели «падает», как в ролике.
 * Координаты — центры точек в системе окна; сама пилюля центрируется через
 * xPercent/yPercent, поэтому её ширину знать не нужно.
 */
export function queueFlight(chip: Element, from: FlightPoint, to: FlightPoint) {
  const travel = Math.min(0.9, Math.max(0.55, Math.hypot(to.x - from.x, to.y - from.y) / 1400));
  return gsap
    .timeline()
    .set(chip, { xPercent: -50, yPercent: -50, x: from.x, y: from.y })
    .fromTo(chip, { opacity: 0, scale: 0.9 }, { opacity: 1, scale: 1, duration: 0.2, ease: EASE.out }, 0)
    .to(chip, { x: to.x, duration: travel, ease: "power2.inOut" }, 0.12)
    .to(chip, { y: to.y, duration: travel, ease: "power3.in" }, 0.12)
    // Сжимается уже на подлёте: вкладка «Очередь» стоит у левого края окна,
    // и пилюля в полный размер вылезала бы за него
    .to(chip, { scale: 0.5, duration: travel * 0.55, ease: "power2.in" }, 0.12 + travel * 0.45)
    .to(chip, { opacity: 0, duration: 0.16, ease: "power2.in" }, 0.12 + travel - 0.1);
}

/** Счётчик на вкладке принимает задачу: короткий толчок и возврат */
export function badgeBump(badge: Element) {
  return gsap.fromTo(
    badge,
    { scale: 1 },
    { scale: 1.45, duration: 0.14, ease: "power2.out", yoyo: true, repeat: 1, clearProps: "scale" },
  );
}

// ── Медиаплеер поверх окна ────────────────────────────────────────────

/** Сдвиг и масштаб, при которых `content` ложится ровно на `from`. */
function flipFrom(content: HTMLElement, from: DOMRect) {
  const to = content.getBoundingClientRect();
  if (to.width === 0 || to.height === 0) return { x: 0, y: 24, scale: 0.94 };
  return {
    x: from.left + from.width / 2 - (to.left + to.width / 2),
    y: from.top + from.height / 2 - (to.top + to.height / 2),
    scale: Math.max(0.1, from.width / to.width),
  };
}

/** Плеер вырастает из миниатюры, по которой кликнули; без неё — обычный вход. */
export function mediaZoomIn(overlay: HTMLElement, content: HTMLElement, from: DOMRect | null) {
  if (prefersReducedMotion() || !from) return modalIn(overlay, content);
  return gsap
    .timeline()
    .fromTo(overlay, { opacity: 0 }, { opacity: 1, duration: DUR.slow, ease: EASE.out }, 0)
    .fromTo(
      content,
      { ...flipFrom(content, from), opacity: 0.4, borderRadius: 8 },
      { x: 0, y: 0, scale: 1, opacity: 1, borderRadius: 18, duration: 0.5, ease: EASE.cine },
      0,
    );
}

/** Обратно в миниатюру, если она ещё на экране. */
export function mediaZoomOut(overlay: HTMLElement, content: HTMLElement, to: DOMRect | null) {
  if (prefersReducedMotion() || !to) return modalOut(overlay, content);
  return gsap
    .timeline()
    .to(content, { ...flipFrom(content, to), opacity: 0, duration: 0.34, ease: EASE.standard }, 0)
    .to(overlay, { opacity: 0, duration: 0.3, ease: EASE.out }, 0.04);
}
