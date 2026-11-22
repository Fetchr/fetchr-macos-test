import { useId } from "react";
import { useTranslation } from "react-i18next";

import { useOutputConflict } from "../../hooks/useOutputConflict";

import { cn } from "@/lib/utils";
import { RedesignIcon } from "@/ui/redesign/icons/iconMap";

import shared from "../../shared.module.css";
import styles from "./SettingsRail.module.css";

interface SaveAsSectionProps {
  outputDir: string | null;
  outputName: string;
  sourceDir: string | undefined;
  hasResult: boolean;
  /** Текущий файл результата: его самого конфликтом не считаем. */
  currentOutputPath: string | null;
  recensoring: boolean;
  onChooseDir: () => void;
  onResetDir: () => void;
  onNameChange: (name: string) => void;
  onSaveCopy: () => void;
}

/** «Сохранить как»: папка и имя результата, пересборка копии. */
export function SaveAsSection({
  outputDir,
  outputName,
  sourceDir,
  hasResult,
  currentOutputPath,
  recensoring,
  onChooseDir,
  onResetDir,
  onNameChange,
  onSaveCopy,
}: SaveAsSectionProps) {
  const { t } = useTranslation();
  const nameInputId = useId();
  const conflict = useOutputConflict(outputDir ?? sourceDir ?? null, outputName, currentOutputPath);
  return (
    <section className={shared.sidebarSection}>
      <h2 className={shared.sidebarTitle}>
        {t("fetchr_mute.sohranit_kak")}
      </h2>
      <div className={styles.saveRow}>
        <button
          type="button"
          className={cn(shared.secondaryButton, styles.saveDir)}
          onClick={onChooseDir}
          title={outputDir ?? t("fetchr_mute.papka_ryadom_s_ishodnikom")}
        >
          <RedesignIcon name="folder" />
          <span className={styles.saveDirText}>
            {outputDir ?? sourceDir ?? t("fetchr_mute.vybrat_papku")}
          </span>
        </button>
        {outputDir && sourceDir && outputDir !== sourceDir && (
          <button
            type="button"
            className={shared.iconButton}
            onClick={onResetDir}
            aria-label={t("fetchr_mute.sohranyat_ryadom_s_ishodnikom")}
            title={t("fetchr_mute.sohranyat_ryadom_s_ishodnikom")}
          >
            <RedesignIcon name="reset" />
          </button>
        )}
      </div>
      <div className={styles.fieldGroup}>
        <label htmlFor={nameInputId} className={styles.fieldLabel}>
          {t("fetchr_mute.imya_fayla")}
        </label>
        <input
          id={nameInputId}
          type="text"
          className={shared.input}
          value={outputName}
          onChange={(event) => onNameChange(event.target.value)}
        />
      </div>
      {hasResult && (
        <button
          type="button"
          className={shared.secondaryButton}
          onClick={onSaveCopy}
          disabled={recensoring}
          title={t("fetchr_mute.peresobrat_rezultat_v_vybrannyy_put")}
        >
          <RedesignIcon name="download" />
          {t("fetchr_mute.sohranit_kopiyu")}
        </button>
      )}
      {conflict && (
        <p className={shared.sidebarHint} role="status">
          {t("fetchr_mute.imya_zanyato_podskazka")}
        </p>
      )}
    </section>
  );
}
