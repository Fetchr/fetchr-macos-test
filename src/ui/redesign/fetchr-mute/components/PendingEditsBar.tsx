import { useTranslation } from "react-i18next";

import { formatShortcuts } from "@/lib/platform";
import { cn } from "@/lib/utils";
import { RedesignIcon } from "@/ui/redesign/icons/iconMap";

import shared from "../shared.module.css";
import styles from "./PendingEditsBar.module.css";

interface PendingEditsBarProps {
  count: number;
  canUndo: boolean;
  /** Идёт рендер «Применить». */
  applying: boolean;
  /** Прогресс рендера, 0..100. */
  percent: number;
  onUndo: () => void;
  onDiscard: () => void;
  onApply: () => void;
  onCancelApply: () => void;
}

/** Полоса неприменённых правок: превью уже звучит, файл — после «Применить». */
export function PendingEditsBar({
  count,
  canUndo,
  applying,
  percent,
  onUndo,
  onDiscard,
  onApply,
  onCancelApply,
}: PendingEditsBarProps) {
  const { t } = useTranslation();
  const progress = Math.min(100, Math.max(0, Math.round(percent)));
  return (
    <div className={styles.bar} role="status" aria-live="polite">
      <RedesignIcon
        name={applying ? "loading" : "pencil"}
        className={cn(styles.icon, applying && shared.spinning)}
      />
      <span className={styles.text}>
        {applying
          ? t("fetchr_mute.pending_applying", { percent: progress })
          : t("fetchr_mute.pending_bar_text", { count })}
      </span>
      {applying ? (
        <span className={styles.actions}>
          <button type="button" className={shared.secondaryButton} onClick={onCancelApply}>
            {t("fetchr_mute.cancel")}
          </button>
        </span>
      ) : (
        <span className={styles.actions}>
          <button
            type="button"
            className={shared.secondaryButton}
            onClick={onUndo}
            disabled={!canUndo}
            title={t("fetchr_mute.pending_undo_hint")}
          >
            <RedesignIcon name="undo" />
            {t("fetchr_mute.pending_undo")}
          </button>
          <button
            type="button"
            className={shared.quietButton}
            onClick={onDiscard}
            title={t("fetchr_mute.pending_discard_hint")}
          >
            {t("fetchr_mute.pending_discard_all", { count })}
          </button>
          <button
            type="button"
            className={cn(shared.primaryButton, styles.apply)}
            onClick={onApply}
            title={t("fetchr_mute.pending_apply_hint")}
            aria-keyshortcuts="Control+S"
          >
            <RedesignIcon name="apply" />
            {t("fetchr_mute.pending_apply")}
            <kbd className={styles.applyKey}>{formatShortcuts("Ctrl+S")}</kbd>
          </button>
        </span>
      )}
      {applying && (
        <span
          className={styles.progress}
          role="progressbar"
          aria-label={t("fetchr_mute.pending_applying_aria")}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={progress}
        >
          <i style={{ transform: `scaleX(${progress / 100})` }} />
        </span>
      )}
    </div>
  );
}
