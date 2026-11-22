import { useTranslation } from "react-i18next";

import { cn } from "@/lib/utils";
import type { NoticeAction } from "@/stores/fetchrMute";
import { RedesignIcon } from "@/ui/redesign/icons/iconMap";

import shared from "../shared.module.css";
import styles from "./Banner.module.css";

interface NoticeBannerProps {
  message: string;
  action: NoticeAction | null;
  onDismiss: () => void;
  /** Наведение/фокус: автоскрытие на паузе, пока пользователь читает. */
  onHoverChange?: (hovered: boolean) => void;
}

/** Нейтральное уведомление; с кнопкой действия, если оно есть. */
export function NoticeBanner({ message, action, onDismiss, onHoverChange }: NoticeBannerProps) {
  const { t } = useTranslation();
  const run = () => {
    onDismiss();
    action?.run();
  };
  return (
    <div
      className={cn(shared.noticeBox, styles.banner)}
      role="status"
      onMouseEnter={() => onHoverChange?.(true)}
      onMouseLeave={() => onHoverChange?.(false)}
      onFocus={() => onHoverChange?.(true)}
      onBlur={() => onHoverChange?.(false)}
    >
      <RedesignIcon name="info" />
      <div className={styles.body}>
        <span className={styles.message}>{message}</span>
        {action && (
          <span className={styles.actions}>
            <button type="button" className={shared.secondaryButton} onClick={run}>
              {action.label}
            </button>
          </span>
        )}
      </div>
      <button
        type="button"
        className={cn(shared.inputAction, styles.dismiss)}
        onClick={onDismiss}
        aria-label={t("fetchr_mute.dismiss_notice")}
        title={t("fetchr_mute.dismiss_notice")}
      >
        <RedesignIcon name="close" />
      </button>
    </div>
  );
}
