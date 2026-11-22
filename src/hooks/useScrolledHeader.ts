import { useLayoutEffect, type RefObject } from "react";

import { ScrollTrigger } from "@/ui/redesign/theme/gsapSetup";

/**
 * Отмечает липкую шапку таблицы, когда под ней уехало содержимое.
 *
 * Шапка приклеена к верху контейнера и на нетронутом списке визуально
 * сливается с первой строкой. Класс включается ровно с первого пикселя
 * прокрутки — граница становится плотнее, и видно, что список сдвинут.
 *
 * scroller обязателен: сквозного скролла документа в приложении нет, всё
 * прокручивается внутри панелей. Без него триггер повесился бы на window,
 * который никогда не двигается, и класс не включился бы никогда.
 */
export function useScrolledHeader(
  scrollerRef: RefObject<HTMLElement | null>,
  headerRef: RefObject<HTMLElement | null>,
  scrolledClass: string,
) {
  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    const header = headerRef.current;
    if (!scroller || !header) return;

    // composes: в CSS-модуле отдаёт не один класс, а список через пробел.
    // classList принимает только отдельные токены — строка с пробелом валит
    // весь компонент через InvalidCharacterError.
    const tokens = scrolledClass.split(/\s+/).filter(Boolean);

    const trigger = ScrollTrigger.create({
      scroller,
      start: 1,
      end: "max",
      onToggle: (self) =>
        self.isActive ? header.classList.add(...tokens) : header.classList.remove(...tokens),
    });

    return () => {
      trigger.kill();
      header.classList.remove(...tokens);
    };
  }, [scrollerRef, headerRef, scrolledClass]);
}
