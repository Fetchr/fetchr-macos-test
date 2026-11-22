import { useTranslation } from "react-i18next";

import { cn } from "@/lib/utils";
import { RedesignIcon } from "@/ui/redesign/icons/iconMap";

import shared from "../shared.module.css";
import styles from "./PlayerControls.module.css";
import type { HitNavigator as HitNavigatorState } from "../hooks/useHitNavigator";
import type { MediaPlayer } from "../hooks/useMediaPlayer";
import { formatTime } from "../timecode";
import { HitNavigator } from "./HitNavigator";
import { SpeedMenu } from "./SpeedMenu";
import { VolumeControl } from "./VolumeControl";

interface PlayerControlsProps {
  player: MediaPlayer;
  /** Готовый результат есть и обработка не идёт — можно сравнить с исходником. */
  hasResult: boolean;
  mediaError: string | null;
  controlsDisabled: boolean;
  /** Навигатор хитов — только на экране проверки. */
  navigator: HitNavigatorState | null;
}

/** Строка плеера: пуск и «Слушать», время, навигатор матов, скорость, звук (поповер). */
export function PlayerControls({
  player,
  hasResult,
  mediaError,
  controlsDisabled,
  navigator,
}: PlayerControlsProps) {
  const { t } = useTranslation();
  const { isPlaying } = player;
  const playLabel = isPlaying ? t("fetchr_mute.pause") : t("fetchr_mute.play");
  return (
    <div className={styles.controlsRow}>
      <button
        type="button"
        className={styles.playButton}
        onClick={player.togglePlay}
        disabled={controlsDisabled}
        aria-label={playLabel}
        title={playLabel}
      >
        <RedesignIcon name={isPlaying ? "pause" : "play"} />
      </button>
      {hasResult && <ListenSwitch player={player} mediaError={mediaError} />}
      <span className={styles.clock}>
        {formatTime(player.currentTime)}
        <span className={styles.clockTotal}> / {formatTime(player.duration)}</span>
      </span>

      <span className={shared.controlsSpacer} />

      {navigator && <HitNavigator navigator={navigator} disabled={controlsDisabled} />}
      {navigator && <span className={styles.divider} aria-hidden="true" />}

      <SpeedMenu
        speedRef={player.speedRef}
        open={player.speedOpen}
        setOpen={player.setSpeedOpen}
        playbackRate={player.playbackRate}
        onChangeRate={player.changePlaybackRate}
        disabled={controlsDisabled}
      />
      <VolumeControl player={player} disabled={controlsDisabled} />
    </div>
  );
}

interface ListenSwitchProps {
  player: MediaPlayer;
  mediaError: string | null;
}

// «Слушать: Результат | Исходник»; при неприменённых правках «Результат» — превью.
function ListenSwitch({ player, mediaError }: ListenSwitchProps) {
  const { t } = useTranslation();
  const { showOriginal, toggleOriginalResult, previewing } = player;
  return (
    <div className={styles.listen}>
      <span className={styles.listenLabel} id="fetchr-mute-listen-label">
        {t("fetchr_mute.listen_label")}
      </span>
      <div
        className={cn(shared.segmented, styles.abSwitch)}
        role="group"
        aria-labelledby="fetchr-mute-listen-label"
      >
        <button
          type="button"
          className={cn(
            shared.segmentedItem,
            styles.abOption,
            !showOriginal && shared.segmentedItemAccent,
          )}
          aria-pressed={!showOriginal}
          disabled={!!mediaError}
          title={previewing ? t("fetchr_mute.ab_preview_hint") : undefined}
          onClick={() => {
            if (showOriginal) toggleOriginalResult();
          }}
        >
          {previewing ? t("fetchr_mute.ab_preview") : t("fetchr_mute.ab_result")}
        </button>
        <button
          type="button"
          className={cn(
            shared.segmentedItem,
            styles.abOption,
            showOriginal && shared.segmentedItemAccent,
          )}
          aria-pressed={showOriginal}
          disabled={!!mediaError}
          title={t("fetchr_mute.ab_sravnit_ishodnik_i_obrabotannyy")}
          onClick={() => {
            if (!showOriginal) toggleOriginalResult();
          }}
        >
          {t("fetchr_mute.ab_original")}
        </button>
      </div>
    </div>
  );
}
