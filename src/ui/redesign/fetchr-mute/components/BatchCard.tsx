import { useTranslation } from "react-i18next";

import { formatBytes } from "@/lib/format";
import { cn } from "@/lib/utils";
import { RedesignIcon } from "@/ui/redesign/icons/iconMap";

import shared from "../shared.module.css";
import recent from "./RecentFiles.module.css";
import styles from "./BatchCard.module.css";
import type { BatchFile } from "../batchFiles";
import { isVideoFile } from "../constants";
import type { MutePresets } from "../hooks/useMutePresets";
import { PresetSelect } from "./settings/PresetSelect";

interface BatchCardProps {
  files: BatchFile[];
  presets: MutePresets;
  /** Своя папка результатов; null — рядом с каждым исходником. */
  outputDir: string | null;
  queuing: boolean;
  /** Файлы тащат над окном: подсветить, что их можно добавить в пачку. */
  dragActive: boolean;
  onRemove: (path: string) => void;
  onChooseDir: () => void;
  onResetDir: () => void;
  onCancel: () => void;
  onEnqueue: () => void;
}

/** Несколько файлов: список, пресет, папка и постановка всех в очередь. */
export function BatchCard({
  files,
  presets,
  outputDir,
  queuing,
  dragActive,
  onRemove,
  onChooseDir,
  onResetDir,
  onCancel,
  onEnqueue,
}: BatchCardProps) {
  const { t } = useTranslation();
  const dirLabel = outputDir ?? t("fetchr_mute.papka_ryadom_s_ishodnikom");
  return (
    <section
      className={cn(shared.card, dragActive && styles.dragActive)}
      aria-label={t("fetchr_mute.batch_aria")}
    >
      <header className={shared.sectionHead}>
        <h2 className={shared.sectionTitle}>
          {t("fetchr_mute.batch_title")}
          <span className={shared.count}>{files.length}</span>
        </h2>
      </header>

      <ul className={recent.recentList}>
        {files.map((file) => (
          <li key={file.path} className={recent.recentItem}>
            <div className={styles.file} title={file.path}>
              <span className={recent.recentIcon} aria-hidden="true">
                <RedesignIcon name={isVideoFile(file.path) ? "video" : "audio"} />
              </span>
              <span className={recent.recentText}>
                <span className={recent.recentName}>{file.name}</span>
                <span className={recent.recentMeta}>
                  {file.size != null ? formatBytes(file.size) : "—"}
                </span>
              </span>
            </div>
            <button
              type="button"
              className={shared.iconButton}
              onClick={() => onRemove(file.path)}
              disabled={queuing}
              aria-label={t("fetchr_mute.batch_remove", { name: file.name })}
              title={t("fetchr_mute.batch_remove", { name: file.name })}
            >
              <RedesignIcon name="close" />
            </button>
          </li>
        ))}
      </ul>

      <div className={styles.options}>
        <div className={styles.option}>
          <span className={styles.optionLabel}>{t("fetchr_mute.preset_title")}</span>
          <PresetSelect presets={presets} disabled={queuing} />
        </div>
        <div className={styles.option}>
          <span className={styles.optionLabel}>{t("fetchr_mute.batch_output_dir")}</span>
          <div className={styles.dirRow}>
            <button
              type="button"
              className={cn(shared.secondaryButton, styles.dirButton)}
              onClick={onChooseDir}
              disabled={queuing}
              title={dirLabel}
            >
              <RedesignIcon name="folder" />
              <span className={styles.dirText}>{dirLabel}</span>
            </button>
            {outputDir && (
              <button
                type="button"
                className={shared.iconButton}
                onClick={onResetDir}
                disabled={queuing}
                aria-label={t("fetchr_mute.sohranyat_ryadom_s_ishodnikom")}
                title={t("fetchr_mute.sohranyat_ryadom_s_ishodnikom")}
              >
                <RedesignIcon name="reset" />
              </button>
            )}
          </div>
        </div>
      </div>

      <footer className={styles.actions}>
        <button type="button" className={shared.secondaryButton} onClick={onCancel} disabled={queuing}>
          {t("fetchr_mute.cancel")}
        </button>
        <button
          type="button"
          className={cn(shared.primaryButton, styles.enqueue)}
          onClick={onEnqueue}
          disabled={queuing || files.length === 0}
        >
          <RedesignIcon name={queuing ? "loading" : "queue"} className={queuing ? shared.spinning : undefined} />
          {t("fetchr_mute.batch_enqueue", { count: files.length })}
        </button>
      </footer>
    </section>
  );
}
