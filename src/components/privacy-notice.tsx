import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { openUrl } from "@tauri-apps/plugin-opener";

import { Switch } from "@/components/ui/switch";
import { ipc, type PrivacySettings } from "@/lib/ipc";

import styles from "./privacy-notice.module.css";

export const PRIVACY_POLICY_URL = "https://fetchr.fun/privacy/";
export const PRIVACY_CONSENT_URL = "https://fetchr.fun/soglasie/";

/** Первый запуск: приложение ничего не отправляет, пока здесь не ответили. */
export function PrivacyNotice() {
  const { t } = useTranslation();
  const [settings, setSettings] = useState<PrivacySettings | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void ipc.getPrivacySettings().then(setSettings).catch(() => undefined);
  }, []);

  if (!settings || settings.notice_seen) return null;

  const toggle = (key: "statistics" | "error_reports" | "job_logs") => (checked: boolean) =>
    setSettings({ ...settings, [key]: checked });

  const confirm = async () => {
    setSaving(true);
    try {
      setSettings(await ipc.setPrivacySettings({ ...settings, notice_seen: true }));
    } catch {
      // Не удалось записать файл настроек: окно спросит снова при следующем запуске.
      setSettings({ ...settings, notice_seen: true });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className={styles.backdrop} role="dialog" aria-modal="true" aria-labelledby="privacy-notice-title">
      <div className={styles.panel}>
        <h2 className={styles.title} id="privacy-notice-title">
          {t("privacy.notice.title", "Что Fetchr отправляет на сервер")}
        </h2>
        <p className={styles.lead}>
          {t(
            "privacy.notice.lead",
            "Пока вы не нажмёте «Продолжить», ничего не отправляется. Выбор можно изменить в любой момент: Настройки → Общие.",
          )}
        </p>
        <div className={styles.options}>
          <PrivacyOption
            label={t("privacy.statistics", "Отправлять анонимную статистику")}
            help={t(
              "privacy.statistics_help",
              "Какие стримы скачивают: стример, платформа, название, размер, длительность. Без привязки к вам и вашему устройству. Из этого строится статистика на сайте.",
            )}
            checked={settings.statistics}
            onChange={toggle("statistics")}
          />
          <PrivacyOption
            label={t("privacy.error_reports", "Отправлять отчёты об ошибках")}
            help={t("privacy.error_reports_help", "Текст ошибки и версия приложения. Пути к файлам, ссылки и токены удаляются до отправки.")}
            checked={settings.error_reports}
            onChange={toggle("error_reports")}
          />
          <PrivacyOption
            label={t("privacy.job_logs", "Отправлять логи задач")}
            help={t("privacy.job_logs_help", "Журнал завершённой задачи, тоже без путей, ссылок и токенов. Помогает чинить сбои без вашего участия.")}
            checked={settings.job_logs}
            onChange={toggle("job_logs")}
          />
        </div>
        <div className={styles.actions}>
          <button className={styles.link} type="button" onClick={() => void openUrl(PRIVACY_POLICY_URL)}>
            {t("privacy.policy", "Политика конфиденциальности")}
          </button>
          <button className={styles.link} type="button" onClick={() => void openUrl(PRIVACY_CONSENT_URL)}>
            {t("privacy.consent", "Согласие на обработку ПДн")}
          </button>
          <button className={styles.confirm} type="button" disabled={saving} onClick={() => void confirm()}>
            {t("privacy.notice.confirm", "Продолжить")}
          </button>
        </div>
      </div>
    </div>
  );
}

function PrivacyOption({
  label,
  help,
  checked,
  onChange,
}: {
  label: string;
  help: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className={styles.option}>
      <span className={styles.optionText}>
        <span className={styles.optionLabel}>{label}</span>
        <span className={styles.optionHelp}>{help}</span>
      </span>
      <Switch checked={checked} onCheckedChange={onChange} aria-label={label} />
    </label>
  );
}
