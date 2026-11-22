import { useTranslation } from "react-i18next";
import type { HardwarePreset } from "@/lib/ipc";
import { defaultPerformanceSettings } from "@/stores/settings";
import type { PerformanceSettings } from "@/types/job";
import { RedesignIcon } from "@/ui/redesign/icons/iconMap";

import { SettingsRow } from "./GeneralSettingsCard";
import styles from "./SettingsPage.module.css";
import { Select } from "@/components/ui/select";

interface PerformanceSettingsCardProps {
  performance: PerformanceSettings;
  hardware: HardwarePreset | null;
  detectingHardware: boolean;
  onPerformanceChange: (performance: PerformanceSettings) => void;
  onDetectHardware: (apply: boolean) => void;
}

export function PerformanceSettingsCard({
  performance,
  hardware,
  detectingHardware,
  onPerformanceChange,
  onDetectHardware,
}: PerformanceSettingsCardProps) {
  const { t } = useTranslation();

  const update = (patch: Partial<PerformanceSettings>) => {
    onPerformanceChange({ ...defaultPerformanceSettings, ...performance, ...patch });
  };

  const updateProfile = (profile: PerformanceSettings["profile"]) => {
    if (profile === "turbo") {
      const cores = navigator.hardwareConcurrency || 8;
      update({
        profile,
        network_concurrent_fragments: 64,
        cpu_threads: cores,
        render_workers: cores,
      });
      return;
    }
    update({ profile });
  };

  return (
    <section className={styles.card} id="settings-performance">
      <div className={styles.cardHeader}>
        <div className={styles.cardTitle}>
          <RedesignIcon name="performance" />
          {t("settings.tabs.performance", "Производительность")}
        </div>
        <div className={styles.cardHint}>{t("settings.performance_hint", "Параллельность, CPU/GPU и FFmpeg preset")}</div>
      </div>
      <div className={styles.cardBody}>
        <SettingsRow label={t("settings.auto_preset", "Автопресет")} help={t("settings.auto_preset_help", "Определяет CPU/GPU и может применить безопасный быстрый профиль.")}>
          <div className={styles.fieldGroup}>
            <span className={styles.pill}>{hardware ? hardwareSummary(hardware, t) : t("settings.hardware_not_detected", "Железо пока не определено")}</span>
            <button className={styles.button} type="button" onClick={() => onDetectHardware(false)} disabled={detectingHardware} aria-busy={detectingHardware}>
              <RedesignIcon name={detectingHardware ? "loading" : "refresh"} className={detectingHardware ? "animate-spin" : undefined} />
              {t("settings.update", "Обновить")}
            </button>
            <button className={`${styles.button} ${styles.primaryButton}`} type="button" onClick={() => onDetectHardware(true)} disabled={detectingHardware}>
              {t("settings.best_preset", "Лучший пресет")}
            </button>
          </div>
        </SettingsRow>

        <SettingsRow label={t("settings.profile", "Профиль")}>
          <Select
            className={styles.select}
            value={performance.profile}
            onValueChange={(value) => updateProfile(value as PerformanceSettings["profile"])}
          >
            <option value="auto">{t("settings.profile_auto", "Авто")}</option>
            <option value="maximum">{t("settings.profile_max", "Максимум")}</option>
            <option value="turbo">{t("settings.profile_turbo", "Турбо")}</option>
            <option value="custom">{t("settings.profile_custom", "Пользовательский")}</option>
          </Select>
          {performance.profile === "turbo" && (
            <div className={styles.help}>
              {t("settings.turbo_warning", "Турбо сильнее грузит CPU/GPU, диск и сеть.")}
            </div>
          )}
        </SettingsRow>

        <SettingsRow label={t("settings.net_cpu", "Сеть / CPU")} help={t("settings.net_cpu_help", "CPU и Render = 0 означает автоматический режим.")}>
          <div className={styles.numberGrid}>
            <NumberField label="Net" value={performance.network_concurrent_fragments} onChange={(value) => update({ profile: "custom", network_concurrent_fragments: clamp(value, 1, 64) })} />
            <NumberField label="CPU" value={performance.cpu_threads ?? 0} onChange={(value) => update({ profile: "custom", cpu_threads: value > 0 ? Math.max(1, value) : null })} />
            <NumberField label="Render" value={performance.render_workers ?? 0} onChange={(value) => update({ profile: "custom", render_workers: value > 0 ? Math.max(1, value) : null })} />
          </div>
        </SettingsRow>

        <SettingsRow label={t("settings.gpu_encoder", "GPU encoder")} help={t("settings.gpu_encoder_help", "Backend уже содержит fallback, если выбранный кодер не стартует.")}>
          <div className={styles.fieldGroup}>
            <Select
              className={styles.select}
              value={performance.gpu_encoder_mode}
              onValueChange={(value) => update({ profile: "custom", gpu_encoder_mode: value as PerformanceSettings["gpu_encoder_mode"] })}
            >
              <option value="auto">Auto detect</option>
              <option value="intel_xe_qsv">Intel Xe QSV</option>
              <option value="nvenc">NVIDIA NVENC</option>
              <option value="qsv">Intel QSV</option>
              <option value="amf">AMD AMF</option>
              <option value="vulkan">Vulkan GPU</option>
              <option value="cpu">CPU libx264</option>
            </Select>
            <input
              className={`${styles.input} ${styles.mono}`}
              value={performance.ffmpeg_preset ?? ""}
              placeholder="preset: p4 / veryfast / speed"
              onChange={(event) => update({ profile: "custom", ffmpeg_preset: event.target.value || null })}
            />
          </div>
        </SettingsRow>
      </div>
    </section>
  );
}

interface NumberFieldProps {
  label: string;
  value: number;
  onChange: (value: number) => void;
}

function NumberField({ label, value, onChange }: NumberFieldProps) {
  return (
    <label className={styles.fieldGroup}>
      <span className={styles.help}>{label}</span>
      <input className={`${styles.input} ${styles.mono}`} type="number" value={value} onChange={(event) => onChange(Number(event.target.value) || 0)} />
    </label>
  );
}

function hardwareSummary(hardware: HardwarePreset, t: any) {
  const gpu = hardware.gpu_names.length ? hardware.gpu_names.join(" / ") : t("settings.gpu_not_found", "GPU не найден");
  return `${hardware.cpu_logical_cores} CPU threads · ${encoderLabel(hardware.performance.gpu_encoder_mode)} · ${gpu}`;
}

function encoderLabel(value: string) {
  if (value === "intel_xe_qsv") return "Intel Xe QSV";
  if (value === "qsv") return "Intel QSV";
  if (value === "nvenc") return "NVIDIA NVENC";
  if (value === "amf") return "AMD AMF";
  if (value === "vulkan") return "Vulkan GPU";
  if (value === "cpu") return "CPU";
  return "Auto";
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, Math.floor(value) || min));
}
