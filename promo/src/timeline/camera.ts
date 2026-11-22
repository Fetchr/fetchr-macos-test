import { cue, EASE, localRect, type Scope, type Timeline } from "../lib/motion";

/**
 * Позы камеры — это трансформация «рига» с окном приложения.
 * Сдвиги в пикселях сцены, повороты в градусах.
 */
export const CAM = {
  hidden: { x: 0, y: 820, scale: 0.84, rotationX: 48, rotationY: 0, opacity: 0 },
  reveal: { x: 0, y: 96, scale: 0.8, rotationX: 14, rotationY: 0, opacity: 1 },
  // Окно справа от текста, левым краем ровно за колонкой текста.
  side: { x: 396, y: 18, scale: 0.84, rotationX: 3, rotationY: 6, opacity: 1 },
  // Зеркально: окно слева, подпись справа
  sideL: { x: -396, y: 18, scale: 0.84, rotationX: 3, rotationY: -6, opacity: 1 },
  // Окно ниже центра, подпись над ним
  low: { x: 0, y: 110, scale: 0.8, rotationX: 8, rotationY: 0, opacity: 1 },
} as const;

export type Pose = Partial<Record<"x" | "y" | "scale" | "rotationX" | "rotationY" | "rotation" | "opacity", number>>;

/** Размер окна и его центр на сцене: риг крутится вокруг этой точки */
const WIN = { width: 1320, height: 860, cx: 960, cy: 540 };

/**
 * Поза камеры, при которой центр элемента окна встаёт в точку сцены
 * (по умолчанию — в центр кадра). Для крупных планов: «наехать на превью».
 */
export function focusPose($: Scope, el: HTMLElement, scale: number, extra: Pose = {}, screen = { x: 960, y: 540 }): Pose {
  const rect = localRect(el, $.one("win"));
  return {
    rotationX: 0,
    rotationY: 0,
    rotation: 0,
    ...extra,
    scale,
    x: screen.x - WIN.cx - scale * (rect.cx - WIN.width / 2),
    y: screen.y - WIN.cy - scale * (rect.cy - WIN.height / 2),
  };
}

/** Резкий «вжух»-переход: окно уезжает вбок с размытием движения */
export function whip(tl: Timeline, $: Scope, at: number, dx: number, duration = 0.28) {
  cue("sweep", at, { n: 1, dur: duration });
  const content = $.one("win");
  tl.to($.one("rig"), { x: `+=${dx}`, duration, ease: "power3.in" }, at).fromTo(
    content,
    { filter: "blur(0px)" },
    { filter: "blur(18px)", duration, ease: "power2.in", immediateRender: false },
    at,
  );
  tl.set(content, { filter: "none" }, at + duration + 0.02);
}

export function cameraTo(tl: Timeline, $: Scope, at: number, pose: Pose, duration = 1.1, ease = "power3.inOut") {
  cue("cam", at, { dur: duration, gain: (pose.scale ?? 0.84) > 0.9 ? 1 : 0.7 });
  // Позы без явного поворота в плоскости выпрямляют окно
  const next = pose.rotation === undefined ? { rotation: 0, ...pose } : pose;
  return tl.to($.one("rig"), { ...next, duration, ease }, at);
}

/** Смена вида: уходящий гаснет вверх, новый приходит снизу — как в приложении */
export function switchView(tl: Timeline, $: Scope, from: string | null, to: string, at: number) {
  // Новый вид входит, только когда старый почти погас: без двоения интерфейса
  if (from) {
    tl.to($.one(`view.${from}`), { autoAlpha: 0, y: -10, duration: 0.18, ease: "power2.in" }, at);
  }
  tl.fromTo(
    $.one(`view.${to}`),
    { autoAlpha: 0, y: 12 },
    { autoAlpha: 1, y: 0, duration: 0.42, ease: EASE.out, immediateRender: false },
    at + (from ? 0.17 : 0),
  );
}

/** Пилюля активной вкладки переезжает на новую вкладку, подписи меняют цвет */
export function moveNav(tl: Timeline, $: Scope, from: string | null, to: string, at: number, duration = 0.5) {
  const nav = $.one("nav.pill").parentElement as HTMLElement;
  const target = localRect($.one(`nav.${to}`), nav);
  const pill = $.one("nav.pill");
  cue("tab", at);
  tl.to(pill, { x: target.x, width: target.width, duration, ease: EASE.cine }, at);
  if (from) tl.to($.one(`nav.${from}`), { color: "#9aa4b1", duration: 0.25, ease: "none" }, at);
  tl.to($.one(`nav.${to}`), { color: "#e9edf2", duration: 0.25, ease: "none" }, at + 0.1);
}

export function placeNav($: Scope, id: string) {
  const nav = $.one("nav.pill").parentElement as HTMLElement;
  const target = localRect($.one(`nav.${id}`), nav);
  return { x: target.x, width: target.width };
}

/** Курсор живёт в координатах окна: цели меряются без учёта камеры */
export function cursorAt($: Scope, target: HTMLElement, dx = 0, dy = 0) {
  const rect = localRect(target, $.one("win"));
  return { x: rect.cx + dx, y: rect.cy + dy };
}

export function moveCursor(tl: Timeline, $: Scope, at: number, point: { x: number; y: number }, duration = 0.62) {
  return tl.to($.one("cursor"), { x: point.x, y: point.y, duration, ease: "power3.inOut" }, at);
}

export function clickCursor(tl: Timeline, $: Scope, at: number) {
  cue("click", at);
  const arrow = $.one("cursor.arrow");
  const ripple = $.one("cursor.ripple");
  return tl
    .to(arrow, { scale: 0.84, duration: 0.08, ease: "power2.out" }, at)
    .to(arrow, { scale: 1, duration: 0.22, ease: EASE.out }, at + 0.08)
    .fromTo(ripple, { scale: 0.3, opacity: 0.7 }, { scale: 1.6, opacity: 0, duration: 0.5, ease: EASE.out, immediateRender: false }, at);
}
