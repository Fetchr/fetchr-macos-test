import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";

import { cn } from "@/lib/utils";
import { RedesignIcon } from "@/ui/redesign/icons/iconMap";

import shared from "../shared.module.css";
import styles from "./RerunConfirm.module.css";

interface DeleteHistoryConfirmProps {
  fileName: string;
  onConfirm: () => void;
  onCancel: () => void;
}

/** Удаление записи истории: спросить, прежде чем удалить. */
export function DeleteHistoryConfirm({ fileName, onConfirm, onCancel }: DeleteHistoryConfirmProps) {
  const { t } = useTranslation();
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    cancelRef.current?.focus();
  }, []);
  return (
    <div
      className={cn(shared.noticeBox, styles.confirm)}
      role="alertdialog"
      aria-labelledby="fetchr-mute-delete-confirm"
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        onCancel();
      }}
    >
      <RedesignIcon name="trash" />
      <span id="fetchr-mute-delete-confirm" className={styles.text}>
        {t("fetchr_mute.history_delete_confirm", { name: fileName })}
      </span>
      <span className={styles.actions}>
        <button ref={cancelRef} type="button" className={shared.ghostButton} onClick={onCancel}>
          {t("fetchr_mute.cancel")}
        </button>
        <button
          type="button"
          className={cn(shared.ghostButton, shared.ghostDanger)}
          onClick={onConfirm}
        >
          {t("fetchr_mute.udalit_iz_istorii")}
        </button>
      </span>
    </div>
  );
}
