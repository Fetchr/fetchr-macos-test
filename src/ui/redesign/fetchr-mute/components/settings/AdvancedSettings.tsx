import { useEffect, useId, useState } from "react";
import type React from "react";
import { useTranslation } from "react-i18next";

import { cn } from "@/lib/utils";
import { RedesignIcon } from "@/ui/redesign/icons/iconMap";

import shared from "../../shared.module.css";
import styles from "./SettingsRail.module.css";

const ADVANCED_OPEN_KEY = "fetchr-mute-advanced-open";

function readStoredOpen(): boolean {
  try {
    return localStorage.getItem(ADVANCED_OPEN_KEY) === "true";
  } catch {
    return false;
  }
}

function writeStoredOpen(open: boolean) {
  try {
    localStorage.setItem(ADVANCED_OPEN_KEY, String(open));
  } catch {
    // Хранилище недоступно — состояние живёт до перезагрузки страницы.
  }
}

/** Раскрыт ли блок: из localStorage; значение не по умолчанию раскрывает его само. */
function useAdvancedOpen(modified: boolean) {
  const [open, setOpen] = useState<boolean>(() => modified || readStoredOpen());
  useEffect(() => {
    if (modified) setOpen(true);
  }, [modified]);
  const toggle = () => {
    const next = !open;
    setOpen(next);
    writeStoredOpen(next);
  };
  return { open, toggle };
}

interface AdvancedSettingsProps {
  /** Сколько настроек внутри отличается от значений по умолчанию. */
  modifiedCount: number;
  /** Предупреждения из блока: в свёрнутом виде показываются под заголовком. */
  warnings: React.ReactNode;
  children: React.ReactNode;
}

/** «Дополнительно»: редкие настройки свёрнуты, чтобы новичок видел только «что глушить». */
export function AdvancedSettings({ modifiedCount, warnings, children }: AdvancedSettingsProps) {
  const { t } = useTranslation();
  const { open, toggle } = useAdvancedOpen(modifiedCount > 0);
  const regionId = useId();
  return (
    <>
      <section className={cn(shared.sidebarSection, styles.advancedHead)}>
        <button
          type="button"
          className={styles.advancedToggle}
          aria-expanded={open}
          aria-controls={regionId}
          onClick={toggle}
        >
          <RedesignIcon
            name="chevronRight"
            className={cn(styles.advancedChevron, open && styles.advancedChevronOpen)}
          />
          <span className={styles.advancedText}>
            <span className={shared.sidebarTitle}>{t("fetchr_mute.advanced_title")}</span>
            {!open && <span className={styles.advancedHint}>{t("fetchr_mute.advanced_hint")}</span>}
          </span>
          {modifiedCount > 0 && (
            <span
              className={styles.advancedBadge}
              title={t("fetchr_mute.advanced_modified_aria", { count: modifiedCount })}
            >
              {t("fetchr_mute.advanced_modified")}
            </span>
          )}
        </button>
        {!open && warnings}
      </section>
      <div id={regionId} className={styles.advancedBody} hidden={!open}>
        {children}
      </div>
    </>
  );
}
