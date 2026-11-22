import { useTranslation } from "react-i18next";
import type { ProxyConfig } from "@/types/job";
import { RedesignIcon } from "@/ui/redesign/icons/iconMap";

import { SettingsRow } from "./GeneralSettingsCard";
import styles from "./SettingsPage.module.css";

interface NetworkSettingsCardProps {
  proxy: ProxyConfig;
  onProxyChange: (proxy: ProxyConfig) => void;
}

export function NetworkSettingsCard({ proxy, onProxyChange }: NetworkSettingsCardProps) {
  const { t } = useTranslation();
  return (
    <section className={styles.card} id="settings-network">
      <div className={styles.cardHeader}>
        <div className={styles.cardTitle}>
          <RedesignIcon name="source" />
          {t("settings.tabs.network", "Сеть")}
        </div>
        <div className={styles.cardHint}>{t("settings.network_hint", "Прокси для загрузок и анализа источников")}</div>
      </div>
      <div className={styles.cardBody}>
        <SettingsRow label={t("settings.use_proxy", "Использовать прокси")} help={t("settings.use_proxy_help", "Включайте только если сервис не открывается или блокирует загрузку.")}>
          <label className={styles.toggleRow}>
            <span>{proxy.enabled ? t("settings.enabled", "Включено") : t("settings.disabled", "Выключено")}</span>
            <input type="checkbox" checked={proxy.enabled} onChange={(event) => onProxyChange({ ...proxy, enabled: event.target.checked })} />
          </label>
        </SettingsRow>
        <SettingsRow label={t("settings.proxy_url", "Адрес прокси")} help={t("settings.proxy_url_help", "Неверный или медленный прокси может замедлить очередь.")}>
          <input
            className={`${styles.input} ${styles.mono}`}
            value={proxy.url}
            placeholder={t("add.proxy_placeholder", "http://127.0.0.1:2080 или socks5://...")}
            onChange={(event) => onProxyChange({ ...proxy, url: event.target.value })}
          />
        </SettingsRow>
      </div>
    </section>
  );
}
