import { useLayoutEffect, useRef, useState } from "react";

// gsap.core.Timeline берётся из глобального неймспейса пакета gsap —
// импорт значения здесь не нужен, хук ничего не анимирует сам.

type Direction = "in" | "out";

/**
 * Аналог AnimatePresence для GSAP.
 *
 * React размонтирует узел сразу, как условие рендера стало ложным, поэтому
 * анимации выхода видно не бывает: узла уже нет в DOM. Хук разводит два
 * состояния — «должно быть открыто» (isOpen, приходит снаружи) и «есть в
 * DOM» (shouldRender). Второе гаснет не по isOpen, а по onComplete
 * таймлайна выхода.
 *
 *   const { shouldRender, ref } = useGsapPresence<HTMLDivElement>(
 *     isOpen,
 *     (el, dir) => (dir === "in" ? modalIn(overlay, el) : modalOut(overlay, el)),
 *   );
 *   if (!shouldRender) return null;
 *   return <div ref={ref}>…</div>;
 *
 * build вызывается на каждую смену направления, поэтому замыкать в нём
 * актуальные узлы безопасно.
 */
export function useGsapPresence<T extends HTMLElement>(
  isOpen: boolean,
  build: (el: T, direction: Direction) => gsap.core.Timeline,
) {
  const ref = useRef<T | null>(null);
  const timelineRef = useRef<gsap.core.Timeline | null>(null);
  const [shouldRender, setShouldRender] = useState(isOpen);

  // Открытие обрабатывается в фазе рендера, а не в эффекте: иначе между
  // isOpen = true и первым рендером узла проходит кадр с пустым экраном.
  if (isOpen && !shouldRender) setShouldRender(true);

  // Свежий build без перезапуска анимации на каждый рендер родителя.
  const buildRef = useRef(build);
  buildRef.current = build;

  useLayoutEffect(() => {
    if (!shouldRender) return;
    const element = ref.current;
    if (!element) return;

    // Смена направления на полпути: старый таймлайн убиваем, стили
    // остаются там, где остановились, и новый доводит их до места.
    timelineRef.current?.kill();

    const timeline = buildRef.current(element, isOpen ? "in" : "out");
    timelineRef.current = timeline;

    if (!isOpen) timeline.eventCallback("onComplete", () => setShouldRender(false));

    return () => {
      timeline.kill();
    };
  }, [isOpen, shouldRender]);

  return { shouldRender, ref };
}
