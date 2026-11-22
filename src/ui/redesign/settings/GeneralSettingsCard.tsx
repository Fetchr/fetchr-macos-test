import { useTranslation } from "react-i18next";
import type { ReactNode } from "react";

import { IS_MACOS } from "@/lib/platform";
import { playErrorSound, playSuccessSound } from "@/lib/sfx";
import { useSettings } from "@/stores/settings";
import { RedesignIcon } from "@/ui/redesign/icons/iconMap";

import styles from "./SettingsPage.module.css";
import { NavPositionPicker } from "./NavPositionPicker";
import { UiModePicker } from "./UiModePicker";
import { Select } from "@/components/ui/select";

interface GeneralSettingsCardProps {
  locale: "ru" | "en";
  directory: string;
  filenameTemplate: string;
  maxConcurrentJobs: number;
  onLocaleChange: (value: "ru" | "en") => void;
  onDirectoryChange: (value: string) => void;
  onChooseDirectory: () => void;
  onFilenameTemplateChange: (value: string) => void;
  onMaxConcurrentJobsChange: (value: number) => void;
}

export function GeneralSettingsCard({
  locale,
  directory,
  filenameTemplate,
  maxConcurrentJobs,
  onLocaleChange,
  onDirectoryChange,
  onChooseDirectory,
  onFilenameTemplateChange,
  onMaxConcurrentJobsChange,
}: GeneralSettingsCardProps) {
  const { t, i18n } = useTranslation();
  const uiMode = useSettings((s) => s.uiMode);

  const setLocale = (value: "ru" | "en") => {
    onLocaleChange(value);
    void i18n.changeLanguage(value);
    localStorage.setItem("fetchr-locale", value);
  };

  return (
    <section className={styles.card} id="settings-general">
      <div className={styles.cardHeader}>
        <div className={styles.cardTitle}>
          <RedesignIcon name="settings" />
          {t("settings.tabs.general", "Общие")}
        </div>
        <div className={styles.cardHint}>{t("settings.general_hint", "Базовые параметры новых задач")}</div>
      </div>
      <div className={styles.cardBody}>
        <SettingsRow label={t("settings.language", "Язык")} help={t("settings.language_help", "Язык интерфейса. На скачивание и обработку не влияет.")}>
          <Select className={styles.select} value={locale} disabled onValueChange={(value) => setLocale(value as "ru" | "en")}>
            <option value="ru">{t("settings.lang_ru", "Русский")}</option>
            {/* English UI re-enabled once redesign strings are moved into i18n dictionaries */}
          </Select>
        </SettingsRow>

        {/* На Mac выбирать нечего: там только интерфейс MacOS. */}
        {!IS_MACOS && (
          <SettingsRow label={t("settings.ui_mode", "Интерфейс")} help={t("settings.ui_mode_help")}>
            <UiModePicker />
          </SettingsRow>
        )}

        {/* В интерфейсе MacOS разделы всегда в боковой панели, как требует HIG. */}
        {uiMode === "simple" && (
          <SettingsRow label={t("settings.nav_position", "Положение панели")} help={t("settings.nav_position_help", "Где стоит меню разделов: сверху, снизу, слева или справа.")}>
            <NavPositionPicker />
          </SettingsRow>
        )}

        <SettingsRow label={t("settings.default_directory", "Папка по умолчанию")} help={t("settings.default_directory_help", "Куда сохраняются скачанные VOD, чат и результаты обработки.")}>
          <div className={styles.fieldGroup}>
            <input className={`${styles.input} ${styles.mono}`} value={directory} onChange={(event) => onDirectoryChange(event.target.value)} />
            <button className={styles.button} type="button" onClick={onChooseDirectory}>
              <RedesignIcon name="folder" />
              {t("settings.browse", "Обзор...")}
            </button>
          </div>
        </SettingsRow>

        <SettingsRow label={t("settings.filename_template", "Шаблон имени")} help={t("settings.filename_template_help", "Используется при создании новых задач.")}>
          <input className={`${styles.input} ${styles.mono}`} value={filenameTemplate} onChange={(event) => onFilenameTemplateChange(event.target.value)} />
        </SettingsRow>

        <SettingsRow label="Звуки" help="Мягкий сигнал, когда задача готова, и другой — при ошибке.">
          <SoundEffectsToggle />
        </SettingsRow>

        <SettingsRow label={t("settings.parallel_downloads", "Одновременные задачи")} help={t("settings.parallel_downloads_help", "Сколько задач выполнять параллельно (1–8). Например: скачка стрима + рендер чата + запись лайва.")}>
          <input
            className={`${styles.input} ${styles.mono}`}
            type="number"
            min={1}
            max={8}
            value={maxConcurrentJobs}
            onChange={(event) => onMaxConcurrentJobsChange(Number(event.target.value))}
          />
        </SettingsRow>
      </div>
    </section>
  );
}

function SoundEffectsToggle() {
  const enabled = useSettings((state) => state.soundEffects);
  const setEnabled = useSettings((state) => state.setSoundEffects);
  return (
    <div className={styles.fieldGroup}>
      <label className={styles.checkboxLabel}>
        <input
          type="checkbox"
          checked={enabled}
          onChange={(event) => {
            setEnabled(event.target.checked);
            if (event.target.checked) playSuccessSound();
          }}
        />
        Включены
      </label>
      <button className={styles.button} type="button" onClick={playSuccessSound}>
        Готово
      </button>
      <button className={styles.button} type="button" onClick={playErrorSound}>
        Ошибка
      </button>
    </div>
  );
}

export function SettingsRow({
  label,
  help,
  children,
  top,
}: {
  label: string;
  help?: string;
  children: ReactNode;
  top?: boolean;
}) {
  return (
    <div className={`${styles.row} ${top ? styles.rowTop : ""}`}>
      <div className={styles.label}>
        <span>{label}</span>
        {help && <span className={styles.help}>{help}</span>}
      </div>
      <div>{children}</div>
    </div>
  );
}
