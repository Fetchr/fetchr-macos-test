import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { cn } from "@/lib/utils";
import { RedesignIcon } from "@/ui/redesign/icons/iconMap";

import shared from "../shared.module.css";
import styles from "./Banner.module.css";

interface ErrorBannerProps {
  message: string;
  details: string | null;
  onRetry: (() => void) | null;
  onDismiss: () => void;
}

type CopyState = "idle" | "copied" | "failed";

/** Ошибка: понятный текст, «Повторить», раскрываемые детали и их копирование. */
export function ErrorBanner({ message, details, onRetry, onDismiss }: ErrorBannerProps) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const [copyState, setCopyState] = useState<CopyState>("idle");
  const showDetails = Boolean(details && details !== message);

  useEffect(() => {
    setExpanded(false);
    setCopyState("idle");
  }, [message, details]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(details ? `${message}\n\n${details}` : message);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
      // Не скопировалось — раскрываем текст, чтобы его можно было выделить вручную.
      setExpanded(true);
    }
  };

  const retry = () => {
    onDismiss();
    onRetry?.();
  };

  return (
    <div className={cn(shared.errorBox, styles.banner)} role="alert">
      <RedesignIcon name="alert" />
      <div className={styles.body}>
        <span className={styles.message}>{message}</span>
        <span className={styles.actions}>
          {onRetry && (
            <button type="button" className={shared.ghostButton} onClick={retry}>
              <RedesignIcon name="refresh" />
              {t("fetchr_mute.error_retry")}
            </button>
          )}
          {showDetails && (
            <button
              type="button"
              className={shared.ghostButton}
              aria-expanded={expanded}
              onClick={() => setExpanded((value) => !value)}
            >
              <RedesignIcon name={expanded ? "chevronUp" : "chevronDown"} />
              {t("fetchr_mute.error_details")}
            </button>
          )}
          <button type="button" className={shared.ghostButton} onClick={() => void copy()}>
            <RedesignIcon name={copyState === "copied" ? "check" : "copy"} />
            {copyState === "copied"
              ? t("fetchr_mute.error_copied")
              : copyState === "failed"
                ? t("fetchr_mute.error_copy_failed")
                : t("fetchr_mute.error_copy")}
          </button>
        </span>
        {showDetails && expanded && <pre className={styles.details}>{details}</pre>}
      </div>
      <button
        type="button"
        className={cn(shared.inputAction, styles.dismiss)}
        onClick={onDismiss}
        aria-label={t("fetchr_mute.dismiss_error")}
        title={t("fetchr_mute.dismiss_error")}
      >
        <RedesignIcon name="close" />
      </button>
    </div>
  );
}
