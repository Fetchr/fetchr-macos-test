import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { openUrl } from "@tauri-apps/plugin-opener";

import { ipc, type BetaActivationLink, type LicenseStatus } from "@/lib/ipc";
import { fetchrBetaBotUrl } from "@/lib/telegram";
import { RedesignIcon } from "@/ui/redesign/icons/iconMap";

import { SettingsRow } from "./GeneralSettingsCard";
import styles from "./SettingsPage.module.css";

interface LicenseSettingsCardProps {
  license: LicenseStatus | null;
  resetting: boolean;
  onResetLicense: () => void;
}

export function LicenseSettingsCard({ license, resetting, onResetLicense }: LicenseSettingsCardProps) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const [activationLink, setActivationLink] = useState<BetaActivationLink | null>(null);
  const active = license?.state === "active";

  useEffect(() => {
    void ipc.betaActivationLink().then(setActivationLink).catch(() => undefined);
  }, []);

  const copyMachineId = async () => {
    if (!license?.machine_id) return;
    await navigator.clipboard.writeText(license.machine_id);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1400);
  };

  const openTelegramBot = async () => {
    const startParameter = activationLink?.start_parameter || (license?.machine_id ? `fetchr_${license.machine_id}` : null);
    await openUrl(fetchrBetaBotUrl(startParameter));
  };

  return (
    <section className={styles.card} id="settings-license">
      <div className={styles.cardHeader}>
        <div className={styles.cardTitle}>
          <RedesignIcon name="secure" />
          {t("settings.tabs.license", "Лицензия и бета")}
        </div>
        <div className={styles.cardHint}>{t("settings.license.hint", "Проверка остаётся в текущем license backend")}</div>
      </div>
      <div className={styles.cardBody}>
        <SettingsRow label={t("settings.license.status", "Статус")} help={t("settings.license.status_help", "Ключ проверяется существующим механизмом лицензирования.")}>
          <div className={styles.statusLine}>
            <span className={`${styles.statusMark} ${active ? "" : styles.statusMarkDanger}`}>
              <RedesignIcon name={active ? "check" : "clear"} />
            </span>
            <span>{statusText(license, t)}</span>
          </div>
        </SettingsRow>

        <SettingsRow label={t("settings.license.machine_id", "Machine ID")} help={t("settings.license.machine_id_help", "Этот код нужен для выдачи персонального beta-ключа.")}>
          <div className={styles.fieldGroup}>
            <input className={`${styles.input} ${styles.mono}`} value={license?.machine_id ?? ""} readOnly />
            <button className={styles.button} type="button" onClick={copyMachineId} disabled={!license?.machine_id}>
              <RedesignIcon name={copied ? "check" : "copy"} />
              {copied ? t("common.ok", "ОК") : t("settings.license.copy", "Копировать")}
            </button>
            <button className={styles.button} type="button" onClick={openTelegramBot} disabled={!license?.machine_id}>
              <RedesignIcon name="external" />
              Telegram
            </button>
          </div>
        </SettingsRow>

        <SettingsRow
          label={t("settings.license.telegram_bot", "Telegram bot")}
          help={t("settings.license.telegram_bot_help", "Приложение передаёт Machine ID в Telegram-бота, а бот генерирует ключ с привязкой к железу.")}
        >
          <div className={styles.statusLine}>
            <span className={`${styles.statusMark} ${activationLink?.configured ? "" : styles.statusMarkDanger}`}>
              <RedesignIcon name={activationLink?.configured ? "check" : "alert"} />
            </span>
            <span>
              {activationLink?.configured
                ? t("settings.license.telegram_configured", "Бот настроен, можно выдавать ключи через Telegram")
                : t("settings.license.telegram_not_configured", "Для сборки задайте FETCHR_TG_BETA_BOT")}
            </span>
          </div>
        </SettingsRow>

        {license?.license && (
          <SettingsRow label={t("settings.license.issued_to", "Выдано")}>
            <div className={styles.statusLine}>
              <RedesignIcon name="key" />
              <span>{license.license.name || license.license.note || "Beta tester"}</span>
              <span className={`${styles.mono} ${styles.help}`}>{license.license.issued_at}</span>
            </div>
          </SettingsRow>
        )}

        <SettingsRow label={t("settings.license.reset", "Сброс")} help={t("settings.license.reset_help", "Удаляет сохранённый ключ. Валидация ключа не меняется.")}>
          <button className={`${styles.button} ${styles.dangerButton}`} type="button" onClick={onResetLicense} disabled={resetting} aria-busy={resetting}>
            <RedesignIcon name={resetting ? "loading" : "reset"} className={resetting ? "animate-spin" : undefined} />
            {t("settings.license.reset_button", "Сбросить ключ")}
          </button>
        </SettingsRow>
      </div>
    </section>
  );
}

function statusText(license: LicenseStatus | null, t: any) {
  if (!license) return t("settings.license.checking", "Проверяем...");
  if (license.state === "active") return t("settings.license.activated", "Активирована");
  if (license.state === "invalid") return t("settings.license.invalid_key", "Ключ повреждён или не подходит");
  return t("settings.license.no_key", "Ключ не введён");
}
