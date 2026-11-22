import { useTranslation } from "react-i18next";

import { useSettings, type NavPosition } from "@/stores/settings";

import styles from "./NavPositionPicker.module.css";

const POSITIONS: NavPosition[] = ["top", "bottom", "left", "right"];

/**
 * Выбор стороны, у которой стоит панель разделов. Применяется сразу: в
 * мастере первого запуска и в Настройках меню переезжает на глазах.
 */
export function NavPositionPicker() {
  const { t } = useTranslation();
  const position = useSettings((s) => s.navPosition);
  const setPosition = useSettings((s) => s.setNavPosition);

  return (
    <div className={styles.group} role="radiogroup" aria-label={t("settings.nav_position", "Положение панели")}>
      {POSITIONS.map((item) => (
        <button
          key={item}
          type="button"
          role="radio"
          aria-checked={position === item}
          className={styles.option}
          data-active={position === item || undefined}
          onClick={() => setPosition(item)}
        >
          <span className={styles.preview} data-pos={item} aria-hidden>
            <span className={styles.bar} />
            <span className={styles.page} />
          </span>
          <span className={styles.label}>{t(`navpos.${item}`)}</span>
        </button>
      ))}
    </div>
  );
}
