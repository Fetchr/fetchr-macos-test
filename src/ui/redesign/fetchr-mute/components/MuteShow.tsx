import { useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";

import { cn } from "@/lib/utils";
import type { MuteSpan } from "@/types/job";

import shared from "../shared.module.css";
import styles from "./MuteShow.module.css";
import { EQ_BAR_COUNT } from "../constants";
import { formatProcessingTime } from "../timecode";

interface MuteShowProps {
  isVideo: boolean;
  spans: MuteSpan[] | null;
  visibleSpans: MuteSpan[];
  activeProfaneSpan: MuteSpan | null;
  muteSummary: boolean;
  duration: number;
  currentScanTime: number;
  scanProgress: number;
  finalProcessingTime: number | null;
  showBars: number[];
  /** Пропустить показ: клик по нему или Esc. */
  onSkip: () => void;
}

/** «Шоу удаления» после обработки: аудио — прогоном по волне, видео — карточкой. */
export function MuteShow(props: MuteShowProps) {
  const { t } = useTranslation();
  const { isVideo, muteSummary, activeProfaneSpan, onSkip } = props;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      onSkip();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onSkip]);

  return (
    <div className={styles.show} onClick={onSkip} title={t("fetchr_mute.show_skip_hint")}>
      {!isVideo && <ShowStrip {...props} />}

      {isVideo && <ShowVideoCard {...props} />}

      {!isVideo && activeProfaneSpan && !muteSummary && (
        <div key={activeProfaneSpan.start} className={styles.showChip}>
          <span className={styles.showChipWord}>
            {activeProfaneSpan.word.split(",")[0]}
          </span>
        </div>
      )}

      {!isVideo && !muteSummary && <ShowCounter {...props} />}

      {!isVideo && muteSummary && <ShowSummary {...props} />}

      <button
        type="button"
        className={cn(shared.ghostButton, styles.showSkip)}
        onClick={(event) => {
          event.stopPropagation();
          onSkip();
        }}
      >
        {t("fetchr_mute.show_skip")}
        <kbd className={styles.showSkipKey}>Esc</kbd>
      </button>
    </div>
  );
}

// Полоса времени для аудио: ячейка — отрезок файла, красные — где нашёлся мат.
function ShowStrip({ spans, duration, currentScanTime, showBars }: MuteShowProps) {
  // Детерминированные псевдослучайные высоты EQ-баров (стабильны между рендерами)
  const eqBars = useMemo(() => {
    return Array.from({ length: EQ_BAR_COUNT }, (_, i) => {
      const x = Math.sin(i * 12.9898 + 78.233) * 43758.5453;
      return 0.22 + 0.78 * Math.abs(x - Math.floor(x));
    });
  }, []);

  // Бары «шоу удаления» для аудио: какие содержат мат (по позиции на таймлайне)
  const muteBarProfane = useMemo(() => {
    if (!spans || duration === 0) return eqBars.map(() => false);
    return eqBars.map((_, i) => {
      const t0 = (i / EQ_BAR_COUNT) * duration;
      const t1 = ((i + 1) / EQ_BAR_COUNT) * duration;
      return spans.some((s) => s.start < t1 && s.end > t0);
    });
  }, [spans, duration, eqBars]);

  return (
    <div className={styles.showStrip} aria-hidden="true">
      {muteBarProfane.map((profane, i) => {
        const barTime = ((i + 0.5) / EQ_BAR_COUNT) * duration;
        const passed = currentScanTime >= barTime;
        return (
          <span
            key={i}
            style={{ height: `${Math.round(showBars[i] * 100)}%` }}
            className={cn(
              styles.showSlot,
              passed && styles.showSlotPassed,
              profane && styles.showSlotProfane,
              profane && passed && styles.showSlotCleaned,
            )}
          />
        );
      })}
      <span
        className={styles.showPlayhead}
        style={{
          left: `${duration > 0 ? (currentScanTime / duration) * 100 : 0}%`,
        }}
      />
    </div>
  );
}

function ShowVideoCard({
  spans,
  visibleSpans,
  muteSummary,
  scanProgress,
  finalProcessingTime,
}: MuteShowProps) {
  const { t } = useTranslation();
  const total = spans?.length ?? 0;
  return (
    <div className={styles.showCardWrap} data-stage-card="">
      <div className={cn(styles.showCard, muteSummary && styles.showCardDone)}>
        {muteSummary ? (
          <>
            <strong>
              {t("fetchr_mute.show_removed_count", { count: total })}
            </strong>
            <span>
              {finalProcessingTime !== null
                ? t("fetchr_mute.show_saved_in", {
                    time: formatProcessingTime(finalProcessingTime, t),
                  })
                : t("fetchr_mute.show_video_saved")}
            </span>
          </>
        ) : (
          <>
            <span className={styles.showCardState}>
              {t("fetchr_mute.show_removing")}
            </span>
            <strong>
              {visibleSpans.length}{" "}
              <small>{t("fetchr_mute.show_of_total", { total })}</small>
            </strong>
            <span className={styles.showCardTrack}>
              <i style={{ transform: `scaleX(${Math.max(0.02, scanProgress / 100)})` }} />
            </span>
          </>
        )}
      </div>
    </div>
  );
}

function ShowCounter({ spans, visibleSpans, scanProgress }: MuteShowProps) {
  const { t } = useTranslation();
  return (
    <div className={styles.showCounter}>
      <strong>{visibleSpans.length}</strong>
      <span>
        {t("fetchr_mute.show_of_total_removed", { total: spans?.length ?? 0 })}
      </span>
      <span className={styles.showCounterPct}>
        {Math.round(scanProgress)}%
      </span>
    </div>
  );
}

function ShowSummary({ spans }: MuteShowProps) {
  const { t } = useTranslation();
  return (
    <div className={styles.showSummary}>
      <strong>{t("fetchr_mute.maty_udaleny")}</strong>
      <span>
        {t("fetchr_mute.fragments_count", { count: spans?.length ?? 0 })}
      </span>
    </div>
  );
}
