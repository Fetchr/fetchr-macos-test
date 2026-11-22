import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { cn } from "@/lib/utils";
import { RedesignIcon, type RedesignIconName } from "@/ui/redesign/icons/iconMap";
import { fetchrThemeClassName } from "@/ui/redesign/theme";

import styles from "./ArchiveMenu.module.css";

export interface ArchiveMenuItem {
  id: string;
  label: string;
  icon: RedesignIconName;
  hint?: string;
  disabled?: boolean;
  /** Линия-разделитель перед пунктом. */
  separated?: boolean;
  onSelect: () => void;
}

/** Куда прижать меню, в координатах окна. `above` — верх якоря, если снизу не влезает. */
export interface MenuAnchor {
  x: number;
  y: number;
  above?: number;
  align?: "start" | "end";
}

interface ArchiveMenuProps {
  anchor: MenuAnchor | null;
  label: string;
  items: ArchiveMenuItem[];
  /** Справка без действия над пунктами. */
  info?: ReactNode;
  /** `restoreFocus` — вернуть фокус на кнопку, открывшую меню. */
  onClose: (restoreFocus: boolean) => void;
}

const EDGE = 8;

/** Всплывающее меню страницы архива: «…» в шапке записи и правый клик по таймлайну. */
export function ArchiveMenu({ anchor, label, items, info, onClose }: ArchiveMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  // Меню не вылезает за окно: прижимается к краю или открывается вверх.
  useLayoutEffect(() => {
    const node = ref.current;
    if (!anchor || !node) {
      setPos(null);
      return;
    }
    const rect = node.getBoundingClientRect();
    const wantLeft = anchor.align === "end" ? anchor.x - rect.width : anchor.x;
    const left = Math.max(EDGE, Math.min(wantLeft, window.innerWidth - rect.width - EDGE));
    const fitsBelow = anchor.y + rect.height + EDGE <= window.innerHeight;
    const top = fitsBelow ? anchor.y : Math.max(EDGE, (anchor.above ?? anchor.y) - rect.height);
    setPos({ left, top });
  }, [anchor]);

  useEffect(() => {
    if (!anchor) return;
    ref.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
    const onPointer = (event: PointerEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) onClose(false);
    };
    const onLeave = () => onClose(false);
    document.addEventListener("pointerdown", onPointer, true);
    window.addEventListener("resize", onLeave);
    window.addEventListener("blur", onLeave);
    return () => {
      document.removeEventListener("pointerdown", onPointer, true);
      window.removeEventListener("resize", onLeave);
      window.removeEventListener("blur", onLeave);
    };
  }, [anchor, onClose]);

  if (!anchor) return null;

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose(true);
      return;
    }
    if (event.key === "Tab") {
      onClose(false);
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const buttons = Array.from(ref.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []);
    if (buttons.length === 0) return;
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const step = event.key === "ArrowDown" ? 1 : -1;
    buttons[(current + step + buttons.length) % buttons.length]?.focus();
  };

  return createPortal(
    <div
      ref={ref}
      role="menu"
      aria-label={label}
      className={cn(fetchrThemeClassName, styles.menu, pos && styles.menuShown)}
      style={pos ? { left: pos.left, top: pos.top } : { left: 0, top: 0 }}
      onKeyDown={onKeyDown}
      onContextMenu={(event) => event.preventDefault()}
    >
      {info && <div className={styles.info}>{info}</div>}
      {items.map((item) => (
        <div key={item.id} role="none">
          {item.separated && <div className={styles.separator} role="separator" />}
          <button
            type="button"
            role="menuitem"
            className={styles.item}
            disabled={item.disabled}
            onClick={() => {
              onClose(true);
              item.onSelect();
            }}
          >
            <RedesignIcon name={item.icon} />
            <span className={styles.itemText}>
              <span className={styles.itemLabel}>{item.label}</span>
              {item.hint && <span className={styles.itemHint}>{item.hint}</span>}
            </span>
          </button>
        </div>
      ))}
    </div>,
    document.body,
  );
}
