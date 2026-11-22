import { useState } from "react";
import { useTranslation } from "react-i18next";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { IntegrationSettings } from "@/stores/settings";
import { useSettings } from "@/stores/settings";
import { RedesignIcon } from "@/ui/redesign/icons/iconMap";
import { ipc } from "@/lib/ipc";

import { SettingsRow } from "./GeneralSettingsCard";
import styles from "./SettingsPage.module.css";
import { Select } from "@/components/ui/select";

const COOKIE_BROWSERS = [
  "chrome",
  "edge",
  "firefox",
  "brave",
  "opera",
  "vivaldi",
  "chromium",
  "whale",
] as const;

interface PlatformIntegrationsCardProps {
  integrations: IntegrationSettings;
  onIntegrationsChange: (integrations: IntegrationSettings) => void;
  onChooseChatExportFolder: () => void;
}

export function PlatformIntegrationsCard({
  integrations,
  onIntegrationsChange,
  onChooseChatExportFolder,
}: PlatformIntegrationsCardProps) {
  const { t } = useTranslation();
  const [loginStatus, setLoginStatus] = useState<string | null>(null);
  const [isExtracting, setIsExtracting] = useState(false);
  const binariesDir = useSettings((s) => s.binariesDir);

  const update = (patch: Partial<IntegrationSettings>) => {
    onIntegrationsChange({ ...integrations, ...patch });
  };

  const handleExtractFromBrowser = async () => {
    const browser = integrations.twitchCookieBrowser?.trim();
    if (!browser) {
      setLoginStatus(t("settings.cookie_pick_browser", "Сначала выберите браузер."));
      return;
    }
    setIsExtracting(true);
    setLoginStatus(t("settings.cookie_extracting", "Чтение cookies из браузера..."));
    try {
      const token = await ipc.twitchExtractBrowserToken(browser, binariesDir);
      update({ twitchAuthToken: token, twitchAuthStatus: "configured" });
      setLoginStatus(t("settings.cookie_extract_ok", "auth-token получен из браузера!"));
    } catch (err: any) {
      setLoginStatus(err?.toString() || t("settings.cookie_extract_fail", "Не удалось получить cookies."));
    } finally {
      setIsExtracting(false);
    }
  };

  const handleImportCookiesFile = async () => {
    try {
      const path = await ipc.chooseCookiesFile();
      if (!path) return;
      setIsExtracting(true);
      setLoginStatus(t("settings.cookie_file_reading", "Чтение cookies.txt..."));
      const token = await ipc.twitchExtractTokenFromCookiesFile(path);
      update({ twitchAuthToken: token, twitchAuthStatus: "configured" });
      setLoginStatus(t("settings.cookie_extract_ok", "auth-token получен из браузера!"));
    } catch (err: any) {
      setLoginStatus(err?.toString() || t("settings.cookie_extract_fail", "Не удалось получить cookies."));
    } finally {
      setIsExtracting(false);
    }
  };

  const getLocalizedLoginStatus = (status: string) => {
    if (status === "Ожидание авторизации в браузере...") {
      return t("settings.status_waiting_browser", "Ожидание авторизации в браузере...");
    }
    if (status === "Авторизация успешно завершена!") {
      return t("settings.status_auth_success", "Авторизация успешно завершена!");
    }
    if (status === "Ошибка: токен не получен.") {
      return t("settings.status_error_no_token", "Ошибка: токен не получен.");
    }
    if (status === "Время ожидания авторизации истекло (5 мин).") {
      return t("settings.status_timeout", "Время ожидания авторизации истекло (5 мин).");
    }
    if (status.startsWith("Ошибка запуска:")) {
      const detail = status.substring("Ошибка запуска:".length);
      return `${t("settings.status_launch_error", "Ошибка запуска:")}${detail}`;
    }
    return status;
  };

  return (
    <section className={styles.card} id="settings-integrations">
      <div className={styles.cardHeader}>
        <div className={styles.cardTitle}>
          <RedesignIcon name="link" />
          {t("settings.tabs.integrations", "Интеграции")}
        </div>
        <div className={styles.cardHint}>{t("settings.integrations_hint", "Платформы, чат, изображения и emote cache")}</div>
      </div>
      <div className={styles.cardBody}>
        <SettingsRow label={t("settings.twitch_client_id_label", "Twitch Client ID")} help={t("settings.twitch_client_id_help", "Встроенный Client-ID. Менять не нужно.")}>
          <input
            className={`${styles.input} ${styles.mono}`}
            value={integrations.twitchClientId}
            placeholder={t("settings.not_set", "не задан (используется встроенный)")}
            onChange={(event) =>
              update({
                twitchClientId: event.target.value,
                twitchAuthStatus: event.target.value.trim() ? "configured" : "not_configured",
              })
            }
          />
        </SettingsRow>

        <SettingsRow label={t("settings.twitch_auth_token_label", "Twitch auth-token")} help={t("settings.twitch_auth_token_help", "Нужен для 2K/1440p и без рекламы.")}>
          <div className={styles.verticalFieldGroup}>
            <input
              type="password"
              className={`${styles.input} ${styles.mono}`}
              value={integrations.twitchAuthToken || ""}
              placeholder={t("settings.twitch_auth_token_placeholder", "Токен авторизации (генерируется при входе)")}
              onChange={(event) => {
                const val = event.target.value;
                update({
                  twitchAuthToken: val,
                  twitchAuthStatus: val.trim() ? "configured" : "not_configured",
                });
              }}
            />
            {integrations.twitchAuthToken?.trim() && (
              <div className={styles.buttonRow}>
                <button
                  className={styles.button}
                  style={{ backgroundColor: "var(--fetchr-color-danger-soft)", color: "var(--fetchr-color-danger)" }}
                  type="button"
                  onClick={() => {
                    update({ twitchAuthToken: "", twitchAuthStatus: "not_configured" });
                    setLoginStatus(null);
                  }}
                >
                  <RedesignIcon name="close" />
                  {t("settings.logout", "Выйти")}
                </button>
              </div>
            )}
          </div>
        </SettingsRow>

        <SettingsRow
          label={t("settings.twitch_cookie_browser_label", "Куки из браузера")}
          help={t("settings.twitch_cookie_browser_help", "Из браузера с входом в Twitch. Закройте его перед извлечением.")}
        >
          <div className={styles.fieldGroup}>
            <Select
              className={styles.input}
              value={integrations.twitchCookieBrowser || ""}
              onValueChange={(value) => update({ twitchCookieBrowser: value })}
            >
              <option value="">{t("settings.cookie_browser_none", "— выберите браузер —")}</option>
              {COOKIE_BROWSERS.map((b) => (
                <option key={b} value={b}>
                  {b.charAt(0).toUpperCase() + b.slice(1)}
                </option>
              ))}
            </Select>
            <button
              className={styles.button}
              type="button"
              onClick={handleExtractFromBrowser}
              disabled={isExtracting || !integrations.twitchCookieBrowser?.trim()}
             aria-busy={isExtracting}>
              <RedesignIcon name={isExtracting ? "loading" : "download"} className={isExtracting ? "animate-spin" : undefined} />
              {isExtracting ? t("settings.cookie_extracting_btn", "Чтение...") : t("settings.cookie_extract_btn", "Извлечь куки")}
            </button>
          </div>
        </SettingsRow>

        <SettingsRow
          label={t("settings.twitch_cookies_file_label", "Импорт cookies.txt")}
          help={t("settings.twitch_cookies_file_help", "Работает для всех браузеров. См. инструкцию ниже.")}
        >
          <button
            className={styles.button}
            type="button"
            onClick={handleImportCookiesFile}
            disabled={isExtracting}
           aria-busy={isExtracting}>
            <RedesignIcon name={isExtracting ? "loading" : "folder"} className={isExtracting ? "animate-spin" : undefined} />
            {t("settings.cookie_import_btn", "Выбрать cookies.txt")}
          </button>
        </SettingsRow>

        {loginStatus && (
          <SettingsRow label={t("settings.login_status_label", "Статус входа")}>
            <div style={{ fontSize: 13, color: isExtracting ? "var(--fetchr-color-text-secondary)" : (loginStatus.includes("успешно") || loginStatus.includes("получен")) ? "var(--fetchr-color-success)" : "var(--fetchr-color-danger)" }}>
              {getLocalizedLoginStatus(loginStatus)}
            </div>
          </SettingsRow>
        )}

        <SettingsRow label={t("settings.auth_status_label", "Статус авторизации")}>
          <span
            className={styles.pill}
            style={{
              color: integrations.twitchAuthToken?.trim() ? "var(--fetchr-color-success)" : "var(--fetchr-color-text-tertiary)",
              borderColor: integrations.twitchAuthToken?.trim() ? "rgba(16, 185, 129, 0.3)" : undefined,
              background: integrations.twitchAuthToken?.trim() ? "rgba(16, 185, 129, 0.06)" : undefined,
            }}
          >
            {integrations.twitchAuthToken?.trim() ? t("settings.twitch_authorized", "Авторизован в Twitch") : t("settings.twitch_anonymous", "Используется анонимный токен")}
          </span>
        </SettingsRow>

        <SettingsRow label={t("settings.login_instructions_label", "Инструкция")}>
          <div className={styles.help} style={{ fontSize: 12.5, lineHeight: "1.45", color: "var(--fetchr-color-text-secondary)" }}>
            <ol style={{ margin: 0, paddingLeft: 16, display: "flex", flexDirection: "column", gap: 2 }}>
              <li>Поставьте расширение (кнопка ниже).</li>
              <li>На <code>twitch.tv</code> войдите в аккаунт.</li>
              <li>В расширении нажмите <strong>Export</strong>.</li>
              <li>Здесь — <strong>«Выбрать cookies.txt»</strong>.</li>
            </ol>
            <button
              className={styles.button}
              type="button"
              style={{ marginTop: 8 }}
              onClick={() =>
                void openUrl(
                  "https://chromewebstore.google.com/detail/get-cookiestxt-locally/cclelndahbckbenkjhflpdbgdldlbecc",
                )
              }
            >
              <RedesignIcon name="external" />
              {t("settings.install_cookies_ext", "Установить Get cookies.txt LOCALLY")}
            </button>
          </div>
        </SettingsRow>

        <SettingsRow label={t("settings.kick_auth_label", "Kick auth status")} help={t("settings.kick_auth_help", "Kick chat — через публичные источники.")}>
          <span className={styles.pill}>{integrations.kickAuthStatus === "public" ? t("settings.kick_auth_public", "Public / без токена") : t("settings.not_configured", "Не настроено")}</span>
        </SettingsRow>

        <SettingsRow label={t("settings.chat_export_folder", "Папка экспорта чата")} help={t("settings.chat_export_folder_help", "По умолчанию для JSON чата.")}>
          <div className={styles.fieldGroup}>
            <input
              className={`${styles.input} ${styles.mono}`}
              value={integrations.chatExportFolder}
              placeholder={t("settings.use_download_folder", "Использовать папку загрузок")}
              onChange={(event) => update({ chatExportFolder: event.target.value })}
            />
            <button className={styles.button} type="button" onClick={onChooseChatExportFolder}>
              <RedesignIcon name="folder" />
              {t("settings.browse", "Обзор...")}
            </button>
          </div>
        </SettingsRow>

        <SettingsRow label="Remote images" help={t("settings.remote_images_help", "Разрешает загрузку превью, аватаров и thumbnails из metadata платформ.")}>
          <label className={styles.toggleRow}>
            <span>Remote image loading</span>
            <input type="checkbox" checked={integrations.remoteImageLoading} onChange={(event) => update({ remoteImageLoading: event.target.checked })} />
          </label>
        </SettingsRow>

        <SettingsRow label="Remote emotes" help={t("settings.remote_emotes_help", "Renderer может кешировать удалённые emote assets, когда ему нужны локальные файлы.")}>
          <label className={styles.toggleRow}>
            <span>Cache remote emotes</span>
            <input type="checkbox" checked={integrations.cacheRemoteEmotes} onChange={(event) => update({ cacheRemoteEmotes: event.target.checked })} />
          </label>
        </SettingsRow>
      </div>
    </section>
  );
}
