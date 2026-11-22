import { useRef } from "react";
import type React from "react";
import { useTranslation } from "react-i18next";

import { cn } from "@/lib/utils";
import type { MuteSpan } from "@/types/job";

import styles from "./Timeline.module.css";
import { TIMELINE_ATTR } from "../hooks/useEditShortcuts";
import type { WaveStatus } from "../hooks/useWaveform";
import type { ReviewHit } from "../reviewModel";
import { formatTime } from "../timecode";

interface TimelineProps {
  isVideo: boolean;
  processing: boolean;
  reviewMode: boolean;
  isMutingAnimation: boolean;
  duration: number;
  currentTime: number;
  playRatio: number;
  currentScanTime: number;
  waveBars: number[];
  waveStatus: WaveStatus;
  visibleSpans: MuteSpan[];
  activeProfaneSpan: MuteSpan | null;
  /** Хиты проверки: метки по статусу, текущий — с кольцом. */
  hits: ReviewHit[] | null;
  currentHitIndex: number;
  onSeekRatio: (ratio: number) => void;
  onSeekTo: (seconds: number) => void;
  onMarkerClick: (e: React.MouseEvent, span: MuteSpan) => void;
  onHitClick: (index: number) => void;
}

const HIT_TONE: Record<ReviewHit["status"], string> = {
  muted: styles.markerMuted,
  manual: styles.markerManual,
  uncertain: styles.markerUncertain,
  restored: styles.markerRestored,
};

/** Шкала плеера: дорожка или волна, метки матов, позиция и пузырь «шоу». */
export function Timeline({
  isVideo,
  processing,
  reviewMode,
  isMutingAnimation,
  duration,
  currentTime,
  playRatio,
  currentScanTime,
  waveBars,
  waveStatus,
  visibleSpans,
  activeProfaneSpan,
  hits,
  currentHitIndex,
  onSeekRatio,
  onSeekTo,
  onMarkerClick,
  onHitClick,
}: TimelineProps) {
  const { t } = useTranslation();
  const timelineRef = useRef<HTMLDivElement | null>(null);

  const handleTimelineClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!timelineRef.current) return;
    const rect = timelineRef.current.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    onSeekRatio(clickX / rect.width);
  };

  const handleTimelineKeyDown = (
    event: React.KeyboardEvent<HTMLDivElement>,
  ) => {
    const step = event.shiftKey ? 30 : 5;
    const actions: Record<string, () => void> = {
      ArrowLeft: () => onSeekTo(currentTime - step),
      ArrowRight: () => onSeekTo(currentTime + step),
      Home: () => onSeekTo(0),
      End: () => onSeekTo(duration),
    };
    const action = actions[event.key];
    if (!action) return;
    event.preventDefault();
    action();
  };

  return (
    <div
      ref={timelineRef}
      className={cn(styles.timeline, !isVideo && styles.timelineAudio)}
      role="slider"
      {...{ [TIMELINE_ATTR]: "" }}
      tabIndex={processing ? -1 : 0}
      aria-label={t("fetchr_mute.timeline")}
      aria-valuemin={0}
      aria-valuemax={Math.round(duration)}
      aria-valuenow={Math.round(currentTime)}
      aria-valuetext={formatTime(currentTime)}
      onClick={processing ? undefined : handleTimelineClick}
      onKeyDown={processing ? undefined : handleTimelineKeyDown}
    >
      <span className={styles.timelineRail} aria-hidden="true">
        <span
          className={styles.timelineFill}
          style={{ transform: `scaleX(${playRatio})` }}
        />
      </span>
      {reviewMode && (
        <span className={styles.timelineWave} aria-hidden="true">
          {waveBars.map((height, index) => (
            <i
              key={index}
              className={(index + 0.5) / waveBars.length <= playRatio ? styles.timelineWavePlayed : undefined}
              style={{ height: `${Math.round(height * 100)}%` }}
            />
          ))}
        </span>
      )}
      {reviewMode && (waveStatus === "loading" || waveStatus === "error") && (
        <span
          className={cn(styles.timelineWaveStatus, waveStatus === "error" && styles.timelineWaveError)}
          role="status"
        >
          {waveStatus === "loading" ? t("fetchr_mute.wave_loading") : t("fetchr_mute.wave_unavailable")}
        </span>
      )}
      {isMutingAnimation && activeProfaneSpan && (
        <span
          className={styles.timelineBubble}
          style={{
            left: `${duration > 0 ? (currentScanTime / duration) * 100 : 0}%`,
          }}
        >
          {activeProfaneSpan.word}
        </span>
      )}
      {duration > 0 &&
        hits?.map((hit, index) => (
          <span
            key={hit.id}
            className={cn(
              styles.marker,
              HIT_TONE[hit.status],
              index === currentHitIndex && styles.markerCurrent,
            )}
            style={{ left: `${(hit.start / duration) * 100}%` }}
            title={`${
              hit.status === "manual" ? t("fetchr_mute.manual_fragment") : hit.span.word
            } (${formatTime(hit.start)})`}
            onClick={(e) => {
              e.stopPropagation();
              onHitClick(index);
            }}
          />
        ))}
      {duration > 0 &&
        !hits &&
        visibleSpans.map((span, idx) => (
          <span
            key={idx}
            className={styles.marker}
            style={{
              left: `${(span.start / duration) * 100}%`,
            }}
            title={`${span.word} (${formatTime(span.start)})`}
            onClick={processing ? undefined : (e) => onMarkerClick(e, span)}
          />
        ))}
      <span
        className={styles.knob}
        style={{ left: `${playRatio * 100}%` }}
        aria-hidden="true"
      />
    </div>
  );
}
