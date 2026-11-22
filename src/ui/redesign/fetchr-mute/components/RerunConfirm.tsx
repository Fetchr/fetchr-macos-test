import { useTranslation } from "react-i18next";

import { cn } from "@/lib/utils";
import { RedesignIcon } from "@/ui/redesign/icons/iconMap";

import shared from "../shared.module.css";
import styles from "./RerunConfirm.module.css";

interface RerunConfirmProps {
  /** Есть ручные или исключённые отрезки — предлагаем оставить или сбросить их. */
  hasEdits: boolean;
  onKeepEdits: () => void;
  onResetEdits: () => void;
  onCancel: () => void;
}

/** «Заново»: предупреждение о долгом анализе; при правках — оставить их или сбросить. */
export function RerunConfirm({ hasEdits, onKeepEdits, onResetEdits, onCancel }: RerunConfirmProps) {
  const { t } = useTranslation();
  return (
    <div
      className={cn(shared.noticeBox, styles.confirm)}
      role="alertdialog"
      aria-labelledby="fetchr-mute-rerun-confirm"
    >
      <RedesignIcon name="info" />
      <span id="fetchr-mute-rerun-confirm" className={styles.text}>
        {hasEdits ? t("fetchr_mute.rerun_confirm_title") : t("fetchr_mute.rerun_fresh_confirm_title")}
      </span>
      <span className={styles.actions}>
        <button type="button" className={shared.ghostButton} onClick={onCancel}>
          {t("fetchr_mute.cancel")}
        </button>
        {hasEdits && (
          <button
            type="button"
            className={cn(shared.ghostButton, shared.ghostDanger)}
            onClick={onResetEdits}
          >
            {t("fetchr_mute.reset_edits")}
          </button>
        )}
        <button type="button" className={shared.secondaryButton} onClick={onKeepEdits}>
          {hasEdits ? t("fetchr_mute.rerun_keep_edits") : t("fetchr_mute.rerun_fresh_start")}
        </button>
      </span>
    </div>
  );
}
