import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { ipc, type HardwarePreset, type LicenseStatus } from "@/lib/ipc";
import {
  defaultPerformanceSettings,
  useSettings,
} from "@/stores/settings";
import { useUI } from "@/stores/ui";
import type { BinaryReport, PerformanceSettings } from "@/types/job";
import { RedesignIcon } from "@/ui/redesign/icons/iconMap";
import { fetchrThemeClassName } from "@/ui/redesign/theme";

import { GeneralSettingsCard } from "./GeneralSettingsCard";
import { HelpSettingsCard } from "./HelpSettingsCard";
import { LicenseSettingsCard } from "./LicenseSettingsCard";
import { NetworkSettingsCard } from "./NetworkSettingsCard";
import { PerformanceSettingsCard } from "./PerformanceSettingsCard";
import { PlatformIntegrationsCard } from "./PlatformIntegrationsCard";
import { PrivacySettingsCard } from "./PrivacySettingsCard";
import styles from "./SettingsPage.module.css";
import { ToolsSettingsCard } from "./ToolsSettingsCard";
import { UpdateSettingsCard } from "./UpdateSettingsCard";

export function SettingsPage() {
  const { t } = useTranslation();
  const settings = useSettings();
  const pendingSettingsTab = useUI((s) => s.pendingSettingsTab);
  const setPendingSettingsTab = useUI((s) => s.setPendingSettingsTab);
  const [activeTab, setActiveTab] = useState<"general" | "performance" | "network" | "tools" | "integrations" | "license" | "help">(
    () => (useUI.getState().pendingSettingsTab as "general") || "general",
  );

  useEffect(() => {
    if (!pendingSettingsTab) return;
    setActiveTab(pendingSettingsTab as typeof activeTab);
    setPendingSettingsTab(null);
    setTimeout(() => {
      document
        .getElementById("settings-integrations")
        ?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 150);
  }, [pendingSettingsTab, setPendingSettingsTab]);
  const [binaries, setBinaries] = useState<BinaryReport[]>([]);
  const [hardware, setHardware] = useState<HardwarePreset | null>(null);
  const [license, setLicense] = useState<LicenseStatus | null>(null);
  const [detectingHardware, setDetectingHardware] = useState(false);
  const [resettingLicense, setResettingLicense] = useState(false);
  const performance = settings.performance ?? defaultPerformanceSettings;

  useEffect(() => {
    if (!settings.directory) {
      void ipc.defaultDownloadDir().then((directory) => {
        if (directory) settings.setDirectory(directory);
      });
    }
  }, [settings]);

  useEffect(() => {
    let cancelled = false;
    void ipc.detectBinaries(settings.binariesDir).then((reports) => {
      if (!cancelled) setBinaries(reports);
    });
    return () => {
      cancelled = true;
    };
  }, [settings.binariesDir]);

  useEffect(() => {
    void detectHardware(false);
    void ipc.licenseStatus().then(setLicense).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const chooseDirectory = async () => {
    const directory = await ipc.chooseDirectory();
    if (directory) settings.setDirectory(directory);
  };

  const chooseBinariesDir = async () => {
    const directory = await ipc.chooseDirectory();
    if (directory) settings.setBinariesDir(directory);
  };

  const chooseChatExportFolder = async () => {
    const directory = await ipc.chooseDirectory();
    if (directory) {
      settings.setIntegrations({ ...settings.integrations, chatExportFolder: directory });
    }
  };

  const detectHardware = async (apply: boolean) => {
    setDetectingHardware(true);
    try {
      const preset = await ipc.detectHardwarePreset();
      setHardware(preset);
      if (apply) applyHardwarePreset(preset);
    } finally {
      setDetectingHardware(false);
    }
  };

  const applyHardwarePreset = (preset: HardwarePreset) => {
    settings.setPerformance({
      ...defaultPerformanceSettings,
      ...preset.performance,
    });
    settings.setChatOverlay({
      ...settings.chatOverlay,
      compose_mode: "direct",
      alpha_output_format: "mov_png",
      chat_overlay_fps: 18,
      save_alpha_overlay: false,
      save_clean_video: true,
    });
  };

  const resetLicense = async () => {
    setResettingLicense(true);
    try {
      const next = await ipc.resetLicense();
      setLicense(next);
      window.setTimeout(() => window.location.reload(), 250);
    } finally {
      setResettingLicense(false);
    }
  };



  return (
    <div className={`${fetchrThemeClassName} ${styles.studioPage}`}>
      <div className={styles.settingsLayout}>
        {/* Left Sidebar */}
        <aside className={styles.settingsLeftPanel}>
          {/* Vertical Menu Tabs */}
          <div className={styles.dockTabBarVertical}>
            <button
              className={`${styles.dockTabVertical} ${activeTab === "general" ? styles.dockTabActiveVertical : ""}`}
              type="button"
              onClick={() => setActiveTab("general")}
            >
              <RedesignIcon name="settings" className="size-3.5" />
              <span>{t("settings.tabs.general", "Общие")}</span>
            </button>
            <button
              className={`${styles.dockTabVertical} ${activeTab === "performance" ? styles.dockTabActiveVertical : ""}`}
              type="button"
              onClick={() => setActiveTab("performance")}
            >
              <RedesignIcon name="performance" className="size-3.5" />
              <span>{t("settings.tabs.performance", "Производительность")}</span>
            </button>
            <button
              className={`${styles.dockTabVertical} ${activeTab === "network" ? styles.dockTabActiveVertical : ""}`}
              type="button"
              onClick={() => setActiveTab("network")}
            >
              <RedesignIcon name="source" className="size-3.5" />
              <span>{t("settings.tabs.network", "Сеть и прокси")}</span>
            </button>
            <button
              className={`${styles.dockTabVertical} ${activeTab === "tools" ? styles.dockTabActiveVertical : ""}`}
              type="button"
              onClick={() => setActiveTab("tools")}
            >
              <RedesignIcon name="folder" className="size-3.5" />
              <span>{t("settings.tabs.tools", "Инструменты")}</span>
            </button>
            <button
              className={`${styles.dockTabVertical} ${activeTab === "integrations" ? styles.dockTabActiveVertical : ""}`}
              type="button"
              onClick={() => setActiveTab("integrations")}
            >
              <RedesignIcon name="link" className="size-3.5" />
              <span>{t("settings.tabs.integrations", "Интеграции")}</span>
            </button>
            <button
              className={`${styles.dockTabVertical} ${activeTab === "license" ? styles.dockTabActiveVertical : ""}`}
              type="button"
              onClick={() => setActiveTab("license")}
            >
              <RedesignIcon name="secure" className="size-3.5" />
              <span>{t("settings.tabs.license", "Лицензия & Обновления")}</span>
            </button>
            <button
              className={`${styles.dockTabVertical} ${activeTab === "help" ? styles.dockTabActiveVertical : ""}`}
              type="button"
              onClick={() => setActiveTab("help")}
            >
              <RedesignIcon name="info" className="size-3.5" />
              <span>{t("settings.tabs.help", "Помощь & FAQ")}</span>
            </button>
          </div>

          {/* Spacer to push widgets to the bottom of the sidebar */}
          <div style={{ flex: "1 1 auto" }} />

          {/* Compact Info Widgets in Sidebar */}
          <div className={styles.infoCardsSidebarContainer}>
            <div className={styles.infoCardSidebar}>
              <div className={styles.infoCardTitle}>{t("settings.system.title", "Система & Железо")}</div>
              <div className={styles.infoGridCompact}>
                <div className={styles.infoRowCompact}>
                  <span className={styles.infoLabel}>{t("settings.system.cpu", "CPU:")}</span>
                  <span className={styles.infoValue}>{hardware?.cpu_logical_cores ?? "—"}</span>
                </div>
                <div className={styles.infoRowCompact}>
                  <span className={styles.infoLabel}>{t("settings.system.gpu", "GPU:")}</span>
                  <span
                    className={styles.infoValue}
                    style={{ maxWidth: 140, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                    title={hardware?.gpu_names.join(", ") ?? "—"}
                  >
                    {hardware?.gpu_names.join(", ") ?? "—"}
                  </span>
                </div>
                <div className={styles.infoRowCompact}>
                  <span className={styles.infoLabel}>{t("settings.system.preset", "Пресет:")}</span>
                  <span className={styles.infoValue} style={{ maxWidth: 140, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={hardware?.summary ?? "—"}>
                    {hardware?.summary ?? "—"}
                  </span>
                </div>
              </div>
            </div>

            <div className={styles.infoCardSidebar}>
              <div className={styles.infoCardTitle}>{t("settings.license.title", "Лицензия & Обновления")}</div>
              <div className={styles.infoGridCompact}>
                <div className={styles.infoRowCompact}>
                  <span className={styles.infoLabel}>{t("settings.license.status", "Статус:")}</span>
                  <span className={styles.infoValue} style={{ color: license?.state === "active" ? "var(--fetchr-color-success)" : "var(--fetchr-color-danger)" }}>
                    {license?.state === "active"
                      ? t("settings.license.active", "Активна")
                      : license?.state === "missing"
                        ? t("settings.license.missing", "Отсутствует")
                        : t("settings.license.invalid", "Недействительна")}
                  </span>
                </div>
                <div className={styles.infoRowCompact}>
                  <span className={styles.infoLabel}>{t("settings.license.id", "ID:")}</span>
                  <span className={styles.infoValue} style={{ fontFamily: "monospace" }}>{license?.machine_id ? `${license.machine_id.slice(0, 8)}...` : "—"}</span>
                </div>
              </div>
            </div>
          </div>
        </aside>

        {/* Right Settings panel */}
        <main className={styles.settingsRightPanel}>
          <div className={styles.dockPanel}>
            {activeTab === "general" && (
              <div className={styles.dockScrollable}>
                <div className={styles.stack} style={{ paddingBottom: 0 }}>
                  <GeneralSettingsCard
                    locale={settings.locale}
                    directory={settings.directory}
                    filenameTemplate={settings.filenameTemplate}
                    maxConcurrentJobs={settings.maxConcurrentJobs}
                    onLocaleChange={settings.setLocale}
                    onDirectoryChange={settings.setDirectory}
                    onChooseDirectory={() => void chooseDirectory()}
                    onFilenameTemplateChange={settings.setFilenameTemplate}
                    onMaxConcurrentJobsChange={settings.setMaxConcurrentJobs}
                  />
                  <PrivacySettingsCard />
                </div>
              </div>
            )}

            {activeTab === "performance" && (
              <div className={styles.dockScrollable}>
                <div className={styles.stack} style={{ paddingBottom: 0 }}>
                  <PerformanceSettingsCard
                    performance={performance}
                    hardware={hardware}
                    detectingHardware={detectingHardware}
                    onPerformanceChange={(next: PerformanceSettings) => settings.setPerformance(next)}
                    onDetectHardware={(apply) => void detectHardware(apply)}
                  />
                </div>
              </div>
            )}

            {activeTab === "network" && (
              <div className={styles.dockScrollable}>
                <div className={styles.stack} style={{ paddingBottom: 0 }}>
                  <NetworkSettingsCard proxy={settings.proxy} onProxyChange={settings.setProxy} />
                </div>
              </div>
            )}

            {activeTab === "tools" && (
              <div className={styles.dockScrollable}>
                <div className={styles.stack} style={{ paddingBottom: 0 }}>
                  <ToolsSettingsCard
                    binariesDir={settings.binariesDir}
                    binaries={binaries}
                    onBinariesDirChange={settings.setBinariesDir}
                    onChooseBinariesDir={() => void chooseBinariesDir()}
                  />
                </div>
              </div>
            )}

            {activeTab === "integrations" && (
              <div className={styles.dockScrollable}>
                <div className={styles.stack} style={{ paddingBottom: 0 }}>
                  <PlatformIntegrationsCard
                    integrations={settings.integrations}
                    onIntegrationsChange={settings.setIntegrations}
                    onChooseChatExportFolder={() => void chooseChatExportFolder()}
                  />
                </div>
              </div>
            )}

            {activeTab === "license" && (
              <div className={styles.dockScrollable}>
                <div className={styles.stack} style={{ paddingBottom: 0 }}>
                  <LicenseSettingsCard
                    license={license}
                    resetting={resettingLicense}
                    onResetLicense={() => void resetLicense()}
                  />
                  <UpdateSettingsCard />
                </div>
              </div>
            )}

            {activeTab === "help" && (
              <div className={styles.dockScrollable}>
                <div className={styles.stack} style={{ paddingBottom: 0 }}>
                  <HelpSettingsCard />
                </div>
              </div>
            )}
          </div>
        </main>
      </div>

      {/* Footer */}
      <footer className={styles.studioFooter}>
        <span>{t("settings.footer.working_dir", "Рабочая папка")}: {settings.directory || t("settings.footer.not_selected", "Не выбрана")}</span>
        <span className={styles.footerActions}>
          <button className={styles.button} style={{ height: 24, fontSize: 12 }} type="button" onClick={() => void detectHardware(true)} aria-busy={detectingHardware}>
            <RedesignIcon name={detectingHardware ? "loading" : "reset"} className={detectingHardware ? "animate-spin" : undefined} />
            {t("settings.footer.re-detect_hardware", "Переопределить железо")}
          </button>
        </span>
      </footer>
    </div>
  );
}

