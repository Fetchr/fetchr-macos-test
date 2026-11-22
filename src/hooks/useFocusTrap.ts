import { useEffect, useRef } from "react";

/**
 * Удерживает фокус внутри оверлея, пока тот открыт.
 *
 * `role="dialog"` и `aria-modal` только объявляют модальность скринридеру —
 * фокус они не держат. Без ловушки Tab уводит на элементы под оверлеем:
 * пользователь набирает в поле, которого не видит.
 *
 * Radix Dialog делает это сам, но модалки здесь собраны вручную ради
 * анимаций входа/выхода, и переписывать их ради одного поведения дорого.
 *
 * Возвращает ref, который надо повесить на корневой элемент оверлея.
 */
export function useFocusTrap<T extends HTMLElement>(active: boolean) {
  const containerRef = useRef<T | null>(null);

  useEffect(() => {
    if (!active) return;
    const container = containerRef.current;
    if (!container) return;

    // Куда вернуть фокус после закрытия
    const previouslyFocused = document.activeElement as HTMLElement | null;

    const getFocusable = (): HTMLElement[] =>
      Array.from(
        container.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
        )
      ).filter((el) => el.offsetParent !== null || el === document.activeElement);

    // Автофокус: первое поле, иначе сам контейнер
    const focusable = getFocusable();
    if (!container.contains(document.activeElement)) {
      (focusable[0] ?? container).focus?.();
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const items = getFocusable();
      if (items.length === 0) {
        event.preventDefault();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const current = document.activeElement as HTMLElement | null;

      // Фокус вне контейнера — вернуть на край, а не отдать наружу
      if (!current || !container.contains(current)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
        return;
      }
      if (event.shiftKey && current === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && current === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      // Возврат фокуса имеет смысл, только если элемент ещё в документе
      if (previouslyFocused?.isConnected) previouslyFocused.focus();
    };
  }, [active]);

  return containerRef;
}
