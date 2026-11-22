import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { openUrl } from "@tauri-apps/plugin-opener";

import { PRIVACY_CONSENT_URL, PRIVACY_POLICY_URL } from "@/components/privacy-notice";
import { Switch } from "@/components/ui/switch";
import { ipc, type PrivacySettings } from "@/lib/ipc";
import { RedesignIcon } from "@/ui/redesign/icons/iconMap";

import { SettingsRow } from "./GeneralSettingsCard";
import styles from "./SettingsPage.module.css";

type PrivacyKey = "statistics" | "error_reports" | "job_logs";

export function PrivacySettingsCard() {
  const { t } = useTranslation();
  const [settings, setSettings] = useState<PrivacySettings | null>(null);

  useEffect(() => {
    void ipc.getPrivacySettings().then(setSettings).catch(() => undefined);
  }, []);

  const toggle = (key: PrivacyKey) => async (checked: boolean) => {
    if (!settings) return;
    const previous = settings;
    setSettings({ ...settings, [key]: checked });
    try {
      setSettings(await ipc.setPrivacySettings({ ...settings, [key]: checked }));
    } catch (err) {
      setSettings(previous);
      toast.error(t("privacy.save_failed", "Не удалось сохранить настройку"), { description: String(err) });
    }
  };

  const row = (key: PrivacyKey, label: string, help: string) => (
    <SettingsRow label={label} help={help}>
      <Switch checked={settings?.[key] ?? false} disabled={!settings} onCheckedChange={(checked) => void toggle(key)(checked)} aria-label={label} />
    </SettingsRow>
  );

  return (
    <section className={styles.card} id="settings-privacy">
      <div className={styles.cardHeader}>
        <div className={styles.cardTitle}>
          <RedesignIcon name="secure" />
          {t("privacy.title", "Конфиденциальность")}
        </div>
        <div className={styles.cardHint}>{t("privacy.hint", "Что приложение отправляет на сервер")}</div>
      </div>
      <div className={styles.cardBody}>
        {row(
          "statistics",
          t("privacy.statistics", "Отправлять анонимную статистику"),
          t(
            "privacy.statistics_help",
            "Какие стримы скачивают: стример, платформа, название, размер, длительность. Без привязки к вам и вашему устройству. Из этого строится статистика на сайте.",
          ),
        )}
        {row(
          "error_reports",
          t("privacy.error_reports", "Отправлять отчёты об ошибках"),
          t("privacy.error_reports_help", "Текст ошибки и версия приложения. Пути к файлам, ссылки и токены удаляются до отправки."),
        )}
        {row(
          "job_logs",
          t("privacy.job_logs", "Отправлять логи задач"),
          t("privacy.job_logs_help", "Журнал завершённой задачи, тоже без путей, ссылок и токенов. Помогает чинить сбои без вашего участия."),
        )}
        <SettingsRow label={t("privacy.policy", "Политика конфиденциальности")}>
          <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
            <button className={styles.button} type="button" onClick={() => void openUrl(PRIVACY_POLICY_URL)}>
              <RedesignIcon name="external" />
              {t("privacy.open_policy", "Политика")}
            </button>
            <button className={styles.button} type="button" onClick={() => void openUrl(PRIVACY_CONSENT_URL)}>
              <RedesignIcon name="external" />
              {t("privacy.open_consent", "Согласие")}
            </button>
          </div>
        </SettingsRow>
      </div>
    </section>
  );
}
