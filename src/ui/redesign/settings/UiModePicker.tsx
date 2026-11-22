import { useTranslation } from "react-i18next";

import { useSettings, type UiMode } from "@/stores/settings";
import { RedesignIcon, type RedesignIconName } from "@/ui/redesign/icons/iconMap";

import styles from "./UiModePicker.module.css";

const MODES: Array<{ id: UiMode; icon: RedesignIconName }> = [
  { id: "simple", icon: "sparkle" },
  { id: "macos", icon: "sidebar" },
];

/**
 * Выбор между простым интерфейсом (поиск и мультивыбор, остальное автоматом)
 * и расширенным (все формы и настройки). Применяется сразу.
 */
export function UiModePicker() {
  const { t } = useTranslation();
  const mode = useSettings((s) => s.uiMode);
  const setMode = useSettings((s) => s.setUiMode);

  return (
    <div className={styles.group} role="radiogroup" aria-label={t("settings.ui_mode", "Интерфейс")}>
      {MODES.map((item) => (
        <button
          key={item.id}
          type="button"
          role="radio"
          aria-checked={mode === item.id}
          className={styles.option}
          data-active={mode === item.id || undefined}
          onClick={() => setMode(item.id)}
        >
          <span className={styles.icon} aria-hidden>
            <RedesignIcon name={item.icon} className="size-5" />
          </span>
          <span className={styles.name}>{t(`uimode.${item.id}`)}</span>
          <span className={styles.desc}>{t(`uimode.${item.id}_desc`)}</span>
        </button>
      ))}
    </div>
  );
}
