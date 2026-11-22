import { useEffect, useRef } from "react";
import type React from "react";

export type MenuCloseReason = "escape" | "outside" | "tab";

interface MenuOptions {
  open: boolean;
  menuRef: React.RefObject<HTMLElement | null>;
  /** Клик по якорю — не «снаружи»: якорь сам переключает меню. */
  anchorRef?: React.RefObject<HTMLElement | null>;
  /** Меню переоткрыли для другого якоря — снова фокус на первый пункт. */
  focusKey?: unknown;
  onClose: (reason: MenuCloseReason) => void;
}

const ITEM_SELECTOR = '[role="menuitem"]:not(:disabled), [role="menuitemradio"]:not(:disabled)';

function menuItems(menu: HTMLElement | null): HTMLElement[] {
  return menu ? Array.from(menu.querySelectorAll<HTMLElement>(ITEM_SELECTOR)) : [];
}

/**
 * Поведение меню (role=menu): фокус на первый пункт при открытии, стрелки,
 * Home/End, Escape и Tab закрывают, клик снаружи закрывает.
 */
export function useMenu({ open, menuRef, anchorRef, focusKey, onClose }: MenuOptions) {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (open) menuItems(menuRef.current)[0]?.focus({ preventScroll: true });
  }, [open, focusKey, menuRef]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (menuRef.current?.contains(target) || anchorRef?.current?.contains(target)) return;
      onCloseRef.current("outside");
    };
    // Escape, пока фокус не в меню (меню открыли мышью и увели фокус).
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      onCloseRef.current("escape");
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, menuRef, anchorRef]);

  const onKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    const items = menuItems(menuRef.current);
    const index = items.indexOf(document.activeElement as HTMLElement);
    const focusAt = (next: number) => items[(next + items.length) % items.length]?.focus();
    const handlers: Record<string, () => void> = {
      ArrowDown: () => focusAt(index + 1),
      ArrowUp: () => focusAt(index - 1),
      Home: () => focusAt(0),
      End: () => focusAt(items.length - 1),
      Escape: () => onCloseRef.current("escape"),
    };
    if (event.key === "Tab") {
      onCloseRef.current("tab");
      return;
    }
    const handler = handlers[event.key];
    // Буквенные хоткеи страницы внутри меню не срабатывают.
    event.stopPropagation();
    if (!handler) return;
    event.preventDefault();
    handler();
  };

  return { onKeyDown };
}
