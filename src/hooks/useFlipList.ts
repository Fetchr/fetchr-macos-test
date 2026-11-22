import { useLayoutEffect, useRef } from "react";

import { DUR, EASE, Flip, gsap } from "@/ui/redesign/theme/gsapSetup";
import { LAYOUT } from "@/ui/redesign/theme/gsapMotion";

/**
 * Список, который сам анимирует появление, уход и перестановку строк.
 *
 * Заменяет связку AnimatePresence + layout из framer-motion. Flip умеет всё
 * три случая одним вызовом: элементы, которых не было в снимке, приходят
 * через onEnter, исчезнувшие — через onLeave (Flip временно возвращает их в
 * DOM, чтобы было что анимировать), а оставшиеся переезжают трансформом.
 *
 * Снимок делается на каждый коммит и хранится до следующего — эффекты React
 * выполняются уже после изменения DOM, снять состояние «до» иначе негде.
 * Тот же приём, что в useFlipIndicator.
 *
 * @param key      состав и порядок списка одной строкой: его смена и есть сигнал
 * @param selector что считать строками, например '[data-flip-row="queue"]'
 */
export function useFlipList(key: string, selector: string) {
  const stateRef = useRef<ReturnType<typeof Flip.getState> | null>(null);
  const keyRef = useRef(key);

  useLayoutEffect(() => {
    const changed = keyRef.current !== key;
    keyRef.current = key;

    const next = Flip.getState(selector);
    if (changed && stateRef.current) {
      Flip.from(stateRef.current, {
        targets: selector,
        duration: LAYOUT.duration,
        ease: LAYOUT.ease,
        // Только уходящие строки вынимаются из потока: иначе соседи дважды
        // дёрнутся — сначала под абсолютное позиционирование, потом обратно.
        absoluteOnLeave: true,
        onEnter: (elements) =>
          gsap.fromTo(
            elements,
            { opacity: 0, y: 12, scale: 0.98 },
            { opacity: 1, y: 0, scale: 1, duration: LAYOUT.duration, ease: LAYOUT.ease },
          ),
        onLeave: (elements) =>
          gsap.to(elements, { opacity: 0, x: -48, duration: DUR.slow, ease: EASE.out }),
      });
    }
    stateRef.current = next;
  }, [key, selector]);
}
