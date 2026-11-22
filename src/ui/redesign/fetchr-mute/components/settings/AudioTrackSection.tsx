import { useTranslation } from "react-i18next";

import { cn } from "@/lib/utils";
import { RedesignIcon } from "@/ui/redesign/icons/iconMap";
import type { AudioTrackInfo } from "@/types/job";

import shared from "../../shared.module.css";
import styles from "./SettingsRail.module.css";

interface AudioTrackSectionProps {
  audioTracks: AudioTrackInfo[];
  audioTrackIndex: number;
  onSelect: (index: number) => void;
  /** Результат разобран по другой дорожке — нужен повторный анализ. */
  needsRerun: boolean;
  onRerun: () => void;
}

/** Выбор аудиодорожки исходника, если их несколько. */
export function AudioTrackSection({
  audioTracks,
  audioTrackIndex,
  onSelect,
  needsRerun,
  onRerun,
}: AudioTrackSectionProps) {
  const { t } = useTranslation();
  return (
    <section className={shared.sidebarSection}>
      <h2 className={shared.sidebarTitle}>
        {t("fetchr_mute.audiodorozhka")}
        {audioTracks.length > 1 && <span className={shared.count}>{audioTracks.length}</span>}
      </h2>
      <div
        className={styles.tracks}
        role="radiogroup"
        aria-label={t("fetchr_mute.audiodorozhka")}
      >
        {audioTracks.map((track) => {
          const parts = [
            track.language ? track.language.toUpperCase() : null,
            track.title,
          ].filter(Boolean);
          const metaParts = [
            track.codec,
            track.channels ? `${track.channels} ch` : null,
            track.is_default ? t("fetchr_mute.track_default") : null,
          ].filter(Boolean);
          const active = track.index === audioTrackIndex;
          return (
            <button
              key={track.index}
              type="button"
              role="radio"
              aria-checked={active}
              className={cn(styles.track, active && styles.trackActive)}
              onClick={() => onSelect(track.index)}
            >
              <span className={styles.trackName}>
                #{track.index + 1}
                {parts.length > 0 ? ` ${parts.join(", ")}` : ""}
              </span>
              {metaParts.length > 0 && (
                <span className={styles.trackMeta}>{metaParts.join(", ")}</span>
              )}
            </button>
          );
        })}
      </div>
      {needsRerun && (
        <div className={styles.trackRerun}>
          <p className={shared.sidebarHint}>{t("fetchr_mute.track_changed_hint")}</p>
          <button type="button" className={shared.secondaryButton} onClick={onRerun}>
            <RedesignIcon name="refresh" />
            {t("fetchr_mute.reanalyze")}
          </button>
        </div>
      )}
    </section>
  );
}
