import { useEffect, useRef } from "react";

/** Хоткеи экрана проверки: буквенные, без модификаторов. */
export interface ReviewShortcuts {
  onNextHit: () => void;
  onPrevHit: () => void;
  onMute: () => void;
  onRestore: () => void;
  onTogglePlay: () => void;
  onSeekBy: (seconds: number) => void;
}

interface EditShortcutsOptions {
  enabled: boolean;
  onUndo: () => void;
  onRedo: () => void;
  onApply: () => void;
  /** null — хоткеи проверки выключены (результата нет). */
  review: ReviewShortcuts | null;
}

/** Шаг перемотки ←/→. */
export const SEEK_STEP_S = 5;

/** Текстовые поля сами обрабатывают Ctrl+Z — их не перехватываем. */
const TEXT_INPUT_TYPES = new Set([
  "text",
  "search",
  "email",
  "number",
  "password",
  "tel",
  "url",
  "",
]);

function isTextTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable || target.tagName === "TEXTAREA") return true;
  if (target instanceof HTMLInputElement) return TEXT_INPUT_TYPES.has(target.type);
  const role = target.getAttribute("role");
  return role === "textbox" || role === "searchbox" || role === "combobox";
}

/** Элементы со своей реакцией на пробел и стрелки. */
const OWN_KEYS_SELECTOR =
  'input, select, textarea, button, a[href], [role="button"], [role="slider"], [role="menu"], [data-review-transcript]';

function ownsKeys(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && target.closest(OWN_KEYS_SELECTOR) !== null;
}

/** Контролы формы: буквы там — ввод/выбор, а не хоткей. Ползунок (громкость
 * в поповере) буквы не читает — N/P/M/R на нём работают. */
const FORM_CONTROL_SELECTOR = 'input:not([type="range"]), select, textarea';

function dialogOpen(): boolean {
  return document.querySelector('[role="alertdialog"]') !== null;
}

function inTranscript(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && target.closest("[data-review-transcript]") !== null;
}

/** Шкала плеера: пробел на ней — пуск/пауза. */
export const TIMELINE_ATTR = "data-player-timeline";

/** Поле списка слов: пустое — Ctrl+Z/Y отменяют правку списка, а не ввод. */
export const LIST_INPUT_ATTR = "data-word-list-input";

/** В текстовом поле Ctrl+S применяет всегда, Ctrl+Z/Y — только в пустом поле списка. */
function textAllowsEditKey(event: KeyboardEvent): boolean {
  if (!(event.ctrlKey || event.metaKey)) return false;
  if (event.code === "KeyS") return true;
  if (event.code !== "KeyZ" && event.code !== "KeyY") return false;
  const target = event.target;
  return (
    target instanceof HTMLInputElement && target.hasAttribute(LIST_INPUT_ATTR) && target.value === ""
  );
}

function onTimeline(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && target.closest(`[${TIMELINE_ATTR}]`) !== null;
}

function editAction(event: KeyboardEvent, handlers: EditShortcutsOptions) {
  if (dialogOpen()) return null;
  if (event.code === "KeyZ") return event.shiftKey ? handlers.onRedo : handlers.onUndo;
  if (event.code === "KeyY" && !event.shiftKey) return handlers.onRedo;
  if (event.code === "KeyS" && !event.shiftKey) return handlers.onApply;
  return null;
}

function reviewAction(event: KeyboardEvent, review: ReviewShortcuts) {
  if (event.target instanceof HTMLElement && event.target.closest('[role="menu"]')) return null;
  if (dialogOpen()) return null;
  const letters: Record<string, () => void> = {
    KeyN: review.onNextHit,
    KeyP: review.onPrevHit,
    KeyM: review.onMute,
    KeyR: review.onRestore,
  };
  if (letters[event.code]) {
    if (event.target instanceof HTMLElement && event.target.closest(FORM_CONTROL_SELECTOR)) {
      return null;
    }
    return event.shiftKey || event.repeat ? null : letters[event.code];
  }
  // В транскрипте пробел — пуск/пауза (меню слова — по Enter), стрелки — по словам.
  // На шкале (role=slider) пробел тоже пуск/пауза: своей реакции у неё нет.
  const spaceOwnedByUs =
    event.code === "Space" && (inTranscript(event.target) || onTimeline(event.target));
  if (ownsKeys(event.target) && !spaceOwnedByUs) return null;
  if (event.code === "Space" && !event.repeat) return review.onTogglePlay;
  // Автоповтор не переключает, но и не прокручивает страницу со шкалы/транскрипта.
  if (event.code === "Space") return spaceOwnedByUs ? () => undefined : null;
  if (event.code === "ArrowLeft") return () => review.onSeekBy(-SEEK_STEP_S);
  if (event.code === "ArrowRight") return () => review.onSeekBy(SEEK_STEP_S);
  return null;
}

/**
 * Ctrl+Z — отменить правку, Ctrl+Shift+Z / Ctrl+Y — повторить, Ctrl+S —
 * применить. На экране проверки ещё N/P — к хиту, M — заглушить, R — вернуть,
 * пробел — пуск/пауза (и в транскрипте), ←/→ — ±5 с (в транскрипте ←/→ ходят по словам). По физической клавише
 * (event.code): в русской раскладке event.key для Z — «я».
 */
export function useEditShortcuts(options: EditShortcutsOptions) {
  const handlersRef = useRef(options);
  handlersRef.current = options;
  const { enabled } = options;

  useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.altKey) return;
      if (isTextTarget(event.target) && !textAllowsEditKey(event)) return;
      const handlers = handlersRef.current;
      const action =
        event.ctrlKey || event.metaKey
          ? editAction(event, handlers)
          : handlers.review && reviewAction(event, handlers.review);
      if (!action) return;
      event.preventDefault();
      action();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [enabled]);
}
