import { useEffect } from "react";

import { EASE, gsap } from "@/ui/redesign/theme/gsapSetup";

/**
 * Тактильный отклик на нажатие кнопки.
 *
 * Раньше это делало глобальное CSS-правило `button:active { scale(.985) }` —
 * без кривой и без возможности догнать отпускание, если курсор ушёл с кнопки.
 *
 * Слушатели вешаются один раз на документ, а не на каждую из 248 кнопок:
 * делегирование дешевле и не требует править разметку. Отпускание слушается
 * на window, иначе кнопка залипает нажатой, когда палец/курсор уехал за её
 * пределы до pointerup.
 *
 * Системное «уменьшить движение» отрабатывает само: gsap.matchMedia в
 * gsapSetup гонит глобальный таймлайн на timeScale(1000).
 */
const PRESSED = 0.96;
/** Сколько пикселей с каждой стороны кнопка может «уйти» при нажатии. У широких
 *  строк списка 4% это 10–20px: строка заметно дёргается и съезжает, поэтому
 *  сжатие ограничено парой пикселей, как у системных списков. */
const MAX_SHRINK_PX = 2;

function pressedScale(element: HTMLElement): number {
  const { width, height } = element.getBoundingClientRect();
  const largest = Math.max(width, height, 1);
  return Math.max(PRESSED, 1 - (MAX_SHRINK_PX * 2) / largest);
}

export function usePressFeedback() {
  useEffect(() => {
    let pressed: HTMLElement | null = null;

    const release = () => {
      if (!pressed) return;
      // clearProps убирает инлайновый transform: иначе он перебивал бы
      // трансформации из CSS у кнопок, которые ими пользуются.
      gsap.to(pressed, { scale: 1, duration: 0.12, ease: EASE.out, clearProps: "scale" });
      pressed = null;
    };

    const onPointerDown = (event: PointerEvent) => {
      const target = (event.target as HTMLElement | null)?.closest?.("button");
      if (!target || target.disabled || target.closest("[data-no-press]")) return;
      pressed = target;
      gsap.to(target, { scale: pressedScale(target), duration: 0.1, ease: EASE.out });
    };

    document.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("pointerup", release, true);
    window.addEventListener("pointercancel", release, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("pointerup", release, true);
      window.removeEventListener("pointercancel", release, true);
    };
  }, []);
}
