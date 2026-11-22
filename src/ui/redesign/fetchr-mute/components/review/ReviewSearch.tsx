import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";

import { cn } from "@/lib/utils";
import { RedesignIcon } from "@/ui/redesign/icons/iconMap";

import shared from "../../shared.module.css";
import styles from "./ReviewPanel.module.css";

interface ReviewSearchProps {
  open: boolean;
  query: string;
  /** Совпадений всего и текущее (0-based, -1 — нет). */
  total: number;
  cursor: number;
  onOpen: () => void;
  onClose: () => void;
  onQueryChange: (value: string) => void;
  onStep: (delta: number) => void;
}

/** Поиск: кнопка-лупа раскрывается в поле с «k из n» и ↑/↓. */
export function ReviewSearch({
  open,
  query,
  total,
  cursor,
  onOpen,
  onClose,
  onQueryChange,
  onStep,
}: ReviewSearchProps) {
  const { t } = useTranslation();
  const inputRef = useRef<HTMLInputElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const returnFocusRef = useRef(false);

  useEffect(() => {
    if (open) {
      inputRef.current?.focus();
      return;
    }
    if (returnFocusRef.current) toggleRef.current?.focus();
    returnFocusRef.current = false;
  }, [open]);

  const close = () => {
    returnFocusRef.current = true;
    onClose();
  };

  if (!open) {
    return (
      <button
        ref={toggleRef}
        type="button"
        className={shared.iconButton}
        onClick={onOpen}
        aria-label={t("fetchr_mute.search_open")}
        title={t("fetchr_mute.search_open")}
      >
        <RedesignIcon name="finder" />
      </button>
    );
  }

  const count = !query.trim()
    ? ""
    : total > 0
      ? t("fetchr_mute.search_count", { k: cursor + 1, n: total })
      : t("fetchr_mute.search_none");

  return (
    <div className={cn(shared.inputWithIcon, styles.search)} role="search">
      <RedesignIcon name="finder" />
      <input
        ref={inputRef}
        type="text"
        value={query}
        placeholder={t("fetchr_mute.search_placeholder")}
        aria-label={t("fetchr_mute.search_placeholder")}
        onChange={(event) => onQueryChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            onStep(event.shiftKey ? -1 : 1);
          } else if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            close();
          }
        }}
      />
      <span className={styles.searchCount} aria-live="polite">
        {count}
      </span>
      <button
        type="button"
        className={shared.inputAction}
        onClick={() => onStep(-1)}
        disabled={total === 0}
        aria-label={t("fetchr_mute.search_prev")}
        title={t("fetchr_mute.search_prev")}
      >
        <RedesignIcon name="arrowUp" />
      </button>
      <button
        type="button"
        className={shared.inputAction}
        onClick={() => onStep(1)}
        disabled={total === 0}
        aria-label={t("fetchr_mute.search_next")}
        title={t("fetchr_mute.search_next")}
      >
        <RedesignIcon name="arrowDown" />
      </button>
      <button
        type="button"
        className={shared.inputAction}
        onClick={close}
        aria-label={t("fetchr_mute.search_close")}
        title={t("fetchr_mute.search_close")}
      >
        <RedesignIcon name="close" />
      </button>
    </div>
  );
}
