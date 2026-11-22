import { useTranslation } from "react-i18next";
import type { BinaryReport } from "@/types/job";
import { RedesignIcon } from "@/ui/redesign/icons/iconMap";

import { SettingsRow } from "./GeneralSettingsCard";
import styles from "./SettingsPage.module.css";

interface ToolsSettingsCardProps {
  binariesDir: string | null;
  binaries: BinaryReport[];
  onBinariesDirChange: (value: string | null) => void;
  onChooseBinariesDir: () => void;
}

export function ToolsSettingsCard({
  binariesDir,
  binaries,
  onBinariesDirChange,
  onChooseBinariesDir,
}: ToolsSettingsCardProps) {
  const { t } = useTranslation();

  return (
    <section className={styles.card} id="settings-tools">
      <div className={styles.cardHeader}>
        <div className={styles.cardTitle}>
          <RedesignIcon name="install" />
          {t("settings.tabs.tools", "Инструменты")}
        </div>
        <div className={styles.cardHint}>{t("settings.tools_hint", "yt-dlp, N_m3u8DL-RE, FFmpeg и FFprobe")}</div>
      </div>
      <div className={styles.cardBody}>
        <SettingsRow label={t("settings.binaries_dir", "Папка инструментов")} help={t("settings.binaries_dir_help", "Если пусто, Fetchr ищет бинарники автоматически.")}>
          <div className={styles.fieldGroup}>
            <input
              className={`${styles.input} ${styles.mono}`}
              value={binariesDir ?? ""}
              placeholder={t("settings.binaries_auto", "Автоопределение")}
              onChange={(event) => onBinariesDirChange(event.target.value || null)}
            />
            <button className={styles.button} type="button" onClick={onChooseBinariesDir}>
              <RedesignIcon name="folder" />
              {t("settings.browse", "Обзор...")}
            </button>
          </div>
        </SettingsRow>

        <div className={styles.toolList}>
          {binaries.map((binary) => (
            <div className={styles.toolRow} key={binary.name}>
              <span className={`${styles.statusMark} ${binary.found ? "" : styles.statusMarkDanger}`}>
                <RedesignIcon name={binary.found ? "check" : "clear"} />
              </span>
              <span className={styles.mono}>{binary.name}</span>
              <span className={`${styles.toolPath} ${styles.mono}`} title={binary.path ?? t("settings.binaries_missing", "Не найдено")}>
                {binary.path ?? t("settings.binaries_missing", "Не найдено")}
              </span>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
