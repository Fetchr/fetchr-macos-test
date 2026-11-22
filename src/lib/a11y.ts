import type { KeyboardEvent } from "react";

/**
 * Активация Enter/Space для элементов, которые несут onClick, но не являются
 * <button> — строка таблицы, зона перетаскивания, элемент списка.
 *
 * Проверка target === currentTarget обязательна: внутри таких элементов часто
 * лежат настоящие кнопки, и Enter на вложенной кнопке всплывает наверх. Без
 * неё одно нажатие срабатывало бы дважды — и на кнопке, и на строке.
 */
export function activateOnKey(handler: () => void) {
  return (event: KeyboardEvent<HTMLElement>) => {
    if (event.target !== event.currentTarget) return;
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    handler();
  };
}
