import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import { useUI } from "@/stores/ui";
import { RedesignIcon } from "@/ui/redesign/icons/iconMap";
import { APP_VERSION, bundledWhatsNew } from "@/ui/redesign/updates/bundledNotes";

import { SettingsRow } from "./GeneralSettingsCard";
import styles from "./SettingsPage.module.css";

/**
 * Обновления ставятся сами при каждом запуске, поэтому ручных «Проверить» и
 * «Установить» здесь больше нет — только версия и новости к ней.
 */
export function UpdateSettingsCard() {
  const { t } = useTranslation();
  const openWhatsNew = useUI((s) => s.openWhatsNew);
  const hasNotes = useMemo(() => Boolean(bundledWhatsNew(null)), []);

  return (
    <section className={styles.card} id="settings-updates">
      <div className={styles.cardHeader}>
        <div className={styles.cardTitle}>
          <RedesignIcon name="download" />
          {t("settings.updates.title", "Онлайн-обновления")}
        </div>
        <div className={styles.cardHint}>{t("settings.updates.auto_hint", "Новая версия ставится сама при запуске")}</div>
      </div>
      <div className={styles.cardBody}>
        <SettingsRow
          label={t("settings.updates.version", "Версия")}
          help={t(
            "settings.updates.auto_help",
            "Fetchr проверяет обновления при каждом запуске, устанавливает их и перезапускается. Ничего нажимать не нужно.",
          )}
        >
          <div className={styles.statusLine}>
            <span className={styles.statusMark}>
              <RedesignIcon name="check" />
            </span>
            <span>{t("settings.updates.version_current", "Текущая версия v{{version}}", { version: APP_VERSION })}</span>
          </div>
        </SettingsRow>

        {hasNotes && (
          <SettingsRow label={t("settings.updates.whats_new", "Что нового")}>
            <div className={styles.fieldGroup}>
              <button className={styles.button} type="button" onClick={openWhatsNew}>
                <RedesignIcon name="sparkle" />
                {t("settings.updates.whats_new_open", "Новости версии {{version}}", { version: APP_VERSION })}
              </button>
            </div>
          </SettingsRow>
        )}
      </div>
    </section>
  );
}
