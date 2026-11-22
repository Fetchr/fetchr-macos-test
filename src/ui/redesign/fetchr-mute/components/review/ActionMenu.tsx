import { forwardRef } from "react";
import type React from "react";
import { useTranslation } from "react-i18next";

import { cn } from "@/lib/utils";
import { RedesignIcon, type RedesignIconName } from "@/ui/redesign/icons/iconMap";

import menu from "../Menu.module.css";
import type { ReviewActionId } from "../../hooks/useReviewActions";

export const ACTION_ICON: Record<ReviewActionId, RedesignIconName> = {
  restore: "audio",
  never: "check",
  mute: "mute",
  always: "close",
  delete: "trash",
  listen: "play",
};

/** Подпись действия над словом или хитом. */
export function useActionLabel() {
  const { t } = useTranslation();
  return (action: ReviewActionId, word: string) => {
    const labels: Record<ReviewActionId, () => string> = {
      restore: () => t("fetchr_mute.review_action_restore"),
      never: () => t("fetchr_mute.review_action_never", { word }),
      mute: () => t("fetchr_mute.review_action_mute"),
      always: () => t("fetchr_mute.review_action_always", { word }),
      delete: () => t("fetchr_mute.review_action_delete"),
      listen: () => t("fetchr_mute.review_action_listen"),
    };
    return labels[action]();
  };
}

interface ActionMenuProps {
  id: string;
  label: string;
  word: string;
  actions: ReviewActionId[];
  style?: React.CSSProperties;
  className?: string;
  onKeyDown: (event: React.KeyboardEvent<HTMLElement>) => void;
  onAction: (action: ReviewActionId) => void;
}

/** Меню действий над словом транскрипции (role=menu). */
export const ActionMenu = forwardRef<HTMLDivElement, ActionMenuProps>(function ActionMenu(
  { id, label, word, actions, style, className, onKeyDown, onAction },
  ref,
) {
  const actionLabel = useActionLabel();
  return (
    <div
      ref={ref}
      id={id}
      role="menu"
      aria-label={label}
      className={cn(menu.menu, className)}
      style={style}
      onKeyDown={onKeyDown}
    >
      {actions.map((action) => (
        <button
          key={action}
          type="button"
          role="menuitem"
          tabIndex={-1}
          className={menu.item}
          onClick={() => onAction(action)}
        >
          <RedesignIcon name={ACTION_ICON[action]} />
          <span className={menu.itemLabel}>{actionLabel(action, word)}</span>
        </button>
      ))}
    </div>
  );
});
