import { useRef, useState } from "react";

import { cn } from "@/lib/utils";
import { RedesignIcon, type RedesignIconName } from "@/ui/redesign/icons/iconMap";

import shared from "../shared.module.css";
import menu from "./Menu.module.css";
import styles from "./SourceBar.module.css";
import { useMenu, type MenuCloseReason } from "../hooks/useMenu";

export interface OverflowItem {
  id: string;
  label: string;
  icon: RedesignIconName;
  onSelect: () => void;
  danger?: boolean;
  /** Линия-разделитель перед пунктом. */
  separated?: boolean;
  /** Выглядит недоступным, но нажимается — объясняет, почему делать нечего. */
  inactive?: boolean;
  /** Пояснение второй строкой: что это за формат и зачем он. */
  hint?: string;
}

interface OverflowMenuProps {
  label: string;
  items: OverflowItem[];
  disabled?: boolean;
  /** Кнопка с подписью («Экспорт ▾») вместо «⋯». */
  trigger?: { text: string; icon: RedesignIconName };
}

/** Кнопка «⋯» (или с подписью) с меню действий. */
export function OverflowMenu({ label, items, disabled, trigger }: OverflowMenuProps) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const close = (reason: MenuCloseReason) => {
    setOpen(false);
    if (reason !== "outside") buttonRef.current?.focus();
  };
  const { onKeyDown } = useMenu({ open, menuRef, anchorRef: buttonRef, onClose: close });

  const select = (item: OverflowItem) => {
    setOpen(false);
    buttonRef.current?.focus();
    item.onSelect();
  };

  return (
    <div className={styles.overflow}>
      <button
        ref={buttonRef}
        type="button"
        className={trigger ? shared.secondaryButton : shared.iconButton}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={trigger ? undefined : label}
        title={label}
        disabled={disabled || items.length === 0}
        onClick={() => setOpen((value) => !value)}
      >
        {trigger ? (
          <>
            <RedesignIcon name={trigger.icon} />
            {trigger.text}
            <RedesignIcon name="chevronDown" />
          </>
        ) : (
          <RedesignIcon name="more" />
        )}
      </button>
      {open && (
        <div
          ref={menuRef}
          role="menu"
          aria-label={label}
          className={cn(menu.menu, styles.overflowMenu)}
          onKeyDown={onKeyDown}
        >
          {items.map((item) => (
            <div key={item.id} role="none">
              {item.separated && <div className={menu.separator} role="separator" />}
              <button
                type="button"
                role="menuitem"
                tabIndex={-1}
                aria-disabled={item.inactive || undefined}
                className={cn(
                  menu.item,
                  item.hint && menu.itemWithHint,
                  item.danger && menu.itemDanger,
                )}
                onClick={() => select(item)}
              >
                <RedesignIcon name={item.icon} />
                {item.hint ? (
                  <span className={menu.itemText}>
                    <span className={menu.itemLabel}>{item.label}</span>
                    <span className={menu.itemHint}>{item.hint}</span>
                  </span>
                ) : (
                  <span className={menu.itemLabel}>{item.label}</span>
                )}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
