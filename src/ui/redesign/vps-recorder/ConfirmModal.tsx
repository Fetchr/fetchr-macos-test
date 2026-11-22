import { useEffect, useId, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { useFocusTrap } from "@/hooks/useFocusTrap";
import { backdropDismiss } from "@/lib/backdrop";
import { cn } from "@/lib/utils";
import { RedesignIcon } from "@/ui/redesign/icons/iconMap";
import { fetchrThemeClassName } from "@/ui/redesign/theme";

import styles from "./VpsRecorderPage.module.css";

interface ConfirmModalProps {
  open: boolean;
  title: string;
  /** What exactly happens, and what stays. */
  children: ReactNode;
  confirmLabel: string;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/** Destructive actions on the archive page ask here, with the consequences spelled out. */
export function ConfirmModal({ open, title, children, confirmLabel, busy = false, onConfirm, onCancel }: ConfirmModalProps) {
  const trapRef = useFocusTrap<HTMLDivElement>(open);
  const titleId = useId();

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onCancel]);

  if (!open) return null;
  return createPortal(
    <div className={cn(fetchrThemeClassName, styles.modalBackdrop)} {...backdropDismiss(onCancel)}>
      <div ref={trapRef} className={styles.modal} role="alertdialog" aria-modal="true" aria-labelledby={titleId}>
        <h2 id={titleId} className={styles.panelTitle}>
          {title}
        </h2>
        <div className={styles.panelHelp}>{children}</div>
        <div className={styles.modalActions}>
          <button type="button" className={styles.ghostButton} onClick={onCancel}>
            Отмена
          </button>
          <button type="button" className={styles.dangerButton} disabled={busy} onClick={onConfirm}>
            <RedesignIcon name={busy ? "loading" : "trash"} className={busy ? styles.spinning : undefined} />
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
