import { useTranslation } from "react-i18next";

import { cn } from "@/lib/utils";
import { RedesignIcon } from "@/ui/redesign/icons/iconMap";

import shared from "../shared.module.css";
import styles from "./RerunConfirm.module.css";

interface PendingConfirmProps {
  count: number;
  onApply: () => void;
  onDiscard: () => void;
  onCancel: () => void;
}

/** Закрытие файла или уход со страницы при неприменённых правках. */
export function PendingConfirm({ count, onApply, onDiscard, onCancel }: PendingConfirmProps) {
  const { t } = useTranslation();
  return (
    <div
      className={cn(shared.noticeBox, styles.confirm)}
      role="alertdialog"
      aria-labelledby="fetchr-mute-pending-confirm"
    >
      <RedesignIcon name="info" />
      <span id="fetchr-mute-pending-confirm" className={styles.text}>
        {t("fetchr_mute.pending_confirm_title", { count })}
      </span>
      <span className={styles.actions}>
        <button type="button" className={shared.ghostButton} onClick={onCancel}>
          {t("fetchr_mute.cancel")}
        </button>
        <button
          type="button"
          className={cn(shared.ghostButton, shared.ghostDanger)}
          onClick={onDiscard}
        >
          {t("fetchr_mute.pending_discard")}
        </button>
        <button type="button" className={shared.primaryButton} onClick={onApply}>
          {t("fetchr_mute.pending_apply")}
        </button>
      </span>
    </div>
  );
}
