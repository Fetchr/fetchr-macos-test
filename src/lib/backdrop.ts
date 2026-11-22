import type { MouseEvent } from "react";

/**
 * Закрытие по клику на фон модалки.
 *
 * Обычный onClick на фоне срабатывает и тогда, когда кнопку зажали внутри
 * карточки (например, выделяя текст в поле), а отпустили на фоне или за
 * пределами окна: click уходит общему предку — фону. Закрываем, только если
 * и нажатие, и отпускание пришлись на сам фон.
 */
export function backdropDismiss(onDismiss: () => void) {
  return {
    onMouseDown: (event: MouseEvent<HTMLElement>) => {
      event.currentTarget.dataset.pressOnBackdrop = String(event.target === event.currentTarget);
    },
    onClick: (event: MouseEvent<HTMLElement>) => {
      const pressedOnBackdrop = event.currentTarget.dataset.pressOnBackdrop !== "false";
      delete event.currentTarget.dataset.pressOnBackdrop;
      if (event.target === event.currentTarget && pressedOnBackdrop) onDismiss();
    },
  };
}
