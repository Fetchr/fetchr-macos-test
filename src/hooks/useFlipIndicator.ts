import { useCallback, useEffect, useLayoutEffect, useRef } from "react";

import { Flip } from "@/ui/redesign/theme/gsapSetup";
import { LAYOUT } from "@/ui/redesign/theme/gsapMotion";

/**
 * Плавающая подложка активной вкладки — замена layoutId из framer-motion.
 *
 * Подложка рендерится внутри активной кнопки, поэтому при смене вкладки
 * старый узел удаляется, а новый появляется в другом родителе. Flip
 * сопоставляет их по data-flip-id и анимирует переезд.
 *
 * Тонкость: Flip.getState нужно снимать до того, как DOM изменится, а
 * эффекты React выполняются уже после. Поэтому состояние снимается на
 * каждый коммит и хранится до следующего: когда activeKey сменился,
 * «откуда» берётся из прошлого снимка. Новый снимок делается до вызова
 * Flip.from — тот сразу сдвигает элемент трансформом, и снимок после него
 * зафиксировал бы промежуточное положение, а не конечное.
 *
 * Снимок с прошлого коммита устаревает, если контейнер с тех пор двигался:
 * модалка, открытая с анимацией масштаба, снимает пилюлю ещё в середине
 * въезда, и первый переезд стартовал из неверной точки. Для этого хук
 * отдаёт capture — вызвать его в обработчике клика до смены вкладки.
 *
 * Коммит без смены вкладки снимает состояние не сразу, а в ближайшем кадре:
 * топбар коммитит на каждое событие прогресса, и синхронный getState каждый
 * раз форсировал раскладку всей страницы. В кадре она и так считается перед
 * отрисовкой, а несколько коммитов за кадр дают один снимок.
 */
export function useFlipIndicator(activeKey: string, flipId: string) {
  const stateRef = useRef<ReturnType<typeof Flip.getState> | null>(null);
  const keyRef = useRef(activeKey);
  const frameRef = useRef(0);
  const flightRef = useRef<gsap.core.Timeline | null>(null);

  useEffect(
    () => () => {
      cancelAnimationFrame(frameRef.current);
      frameRef.current = 0;
    },
    [],
  );

  useLayoutEffect(() => {
    const selector = `[data-flip-id="${flipId}"]`;
    const changed = keyRef.current !== activeKey;
    keyRef.current = activeKey;

    if (!changed) {
      if (!frameRef.current) {
        frameRef.current = requestAnimationFrame(() => {
          frameRef.current = 0;
          // Посреди перелёта снимок поймал бы промежуточное положение;
          // перелёт сам снимет состояние, когда закончится.
          if (flightRef.current?.isActive()) return;
          stateRef.current = Flip.getState(selector);
        });
      }
      return;
    }
    // Отложенный снимок после Flip.from поймал бы промежуточное положение
    cancelAnimationFrame(frameRef.current);
    frameRef.current = 0;

    const next = Flip.getState(selector);
    if (stateRef.current) {
      // targets обязателен: узел из прошлого снимка уже удалён из DOM, и без
      // явной цели Flip анимировал бы открепившийся элемент — то есть ничего.
      // С targets он сопоставляет снимок с новым узлом по data-flip-id.
      flightRef.current = Flip.from(stateRef.current, {
        targets: selector,
        duration: LAYOUT.duration,
        ease: LAYOUT.ease,
        absolute: true,
        onComplete: () => {
          stateRef.current = Flip.getState(selector);
        },
      });
    }
    stateRef.current = next;
    // Без зависимостей: снимок обновляется после каждого коммита, а не только
    // при смене вкладки, иначе он так и оставался бы снятым при монтировании
  });

  return useCallback(() => {
    stateRef.current = Flip.getState(`[data-flip-id="${flipId}"]`);
  }, [flipId]);
}
