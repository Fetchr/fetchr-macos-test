import { useTranslation } from "react-i18next";

import { cn } from "@/lib/utils";
import { RedesignIcon } from "@/ui/redesign/icons/iconMap";

import shared from "../shared.module.css";
import styles from "./RunCard.module.css";

interface RunCardProps {
  methodLabel: string;
  coveragePercent: number;
  /** Подпись выбранной дорожки; null — дорожка одна или неизвестна. */
  trackLabel: string | null;
  blacklistCount: number;
  onlyCustomWords: boolean;
  outputDir: string | null;
  outputName: string;
  onStart: () => void;
}

/** Файл выбран, обработки ещё не было: сводка настроек теми же словами, что справа, и запуск. */
export function RunCard({
  methodLabel,
  coveragePercent,
  trackLabel,
  blacklistCount,
  onlyCustomWords,
  outputDir,
  outputName,
  onStart,
}: RunCardProps) {
  const { t } = useTranslation();
  const words = onlyCustomWords
    ? t("fetchr_mute.run_words_only_custom", { count: blacklistCount })
    : t("fetchr_mute.run_words_default", { count: blacklistCount });
  return (
    <section className={styles.runCard}>
      <dl className={styles.runFacts}>
        <div>
          <dt>{t("fetchr_mute.run_method")}</dt>
          <dd>{methodLabel}</dd>
        </div>
        <div>
          <dt>{t("fetchr_mute.coverage_title")}</dt>
          <dd title={t("fetchr_mute.coverage_hint")}>{coveragePercent}%</dd>
        </div>
        {trackLabel && (
          <div>
            <dt>{t("fetchr_mute.audiodorozhka")}</dt>
            <dd title={trackLabel}>{trackLabel}</dd>
          </div>
        )}
        <div>
          <dt title={t("fetchr_mute.run_words_hint")}>{t("fetchr_mute.run_words")}</dt>
          <dd title={words}>{words}</dd>
        </div>
        <div className={styles.runTarget}>
          <dt>{t("fetchr_mute.run_save_as")}</dt>
          <dd title={outputDir ? `${outputDir} · ${outputName}` : outputName}>
            {outputName || "—"}
            {outputDir && <span className={styles.runDir}>{outputDir}</span>}
          </dd>
        </div>
      </dl>
      <button
        className={cn(shared.primaryButton, styles.primaryButton)}
        type="button"
        onClick={onStart}
      >
        <RedesignIcon name="play" />
        {t("fetchr_mute.nayti_i_ubrat_maty")}
      </button>
    </section>
  );
}
