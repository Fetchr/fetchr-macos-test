import { useTranslation } from "react-i18next";

import shared from "../../shared.module.css";
import styles from "./SettingsRail.module.css";

interface TogglesSectionProps {
  onlyCustomWords: boolean;
  onOnlyCustomWordsChange: (value: boolean) => void;
  /** Список «Всегда глушить» пуст: с «Только свои слова» искать будет нечего. */
  customWordsEmpty: boolean;
  shareWords: boolean;
  onShareWordsChange: (value: boolean) => void;
}

/** Переключатели: только свои слова и отправка новых слов в общий словарь. */
export function TogglesSection({
  onlyCustomWords,
  onOnlyCustomWordsChange,
  customWordsEmpty,
  shareWords,
  onShareWordsChange,
}: TogglesSectionProps) {
  const { t } = useTranslation();
  // Две разные по смыслу настройки — разными секциями: первая меняет, что
  // ищем в файле, вторая — что уходит на сервер.
  return (
    <>
      <section className={shared.sidebarSection}>
        <ToggleRow
          title={t("fetchr_mute.tolko_svoi_slova")}
          hint={t("fetchr_mute.ispolzovat_tolko_slova_iz_chernogo")}
          checked={onlyCustomWords}
          onChange={onOnlyCustomWordsChange}
        />
        {onlyCustomWords && customWordsEmpty && (
          <p className={styles.toggleWarning} role="status">
            {t("fetchr_mute.only_custom_words_empty")}
          </p>
        )}
      </section>
      <section className={shared.sidebarSection}>
        <h2 className={shared.sidebarTitle}>{t("fetchr_mute.share_section_title")}</h2>
        <ToggleRow
          title={t("fetchr_mute.uluchshat_slovar")}
          checked={shareWords}
          onChange={onShareWordsChange}
        />
        <p className={shared.sidebarHint}>{t("fetchr_mute.share_words_privacy")}</p>
      </section>
    </>
  );
}

interface ToggleRowProps {
  title: string;
  hint?: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}

function ToggleRow({ title, hint, checked, onChange }: ToggleRowProps) {
  return (
    <label className={styles.toggleRow}>
      <span className={styles.toggleText}>
        <strong>{title}</strong>
        {hint && <em>{hint}</em>}
      </span>
      <span className={shared.switch}>
        <input
          type="checkbox"
          checked={checked}
          onChange={(event) => onChange(event.currentTarget.checked)}
        />
        <span className={shared.switchTrack} aria-hidden="true" />
      </span>
    </label>
  );
}
