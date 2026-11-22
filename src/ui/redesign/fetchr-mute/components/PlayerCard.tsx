import type React from "react";
import { useTranslation } from "react-i18next";

import { cn } from "@/lib/utils";
import { RedesignIcon } from "@/ui/redesign/icons/iconMap";
import type { MuteSpan } from "@/types/job";

import styles from "./PlayerCard.module.css";
import type { HitNavigator } from "../hooks/useHitNavigator";
import type { MediaPlayer } from "../hooks/useMediaPlayer";
import type { WaveStatus } from "../hooks/useWaveform";
import type { ReviewHit } from "../reviewModel";
import type { FetchrMuteStore, FileDetails } from "../types";
import { AnalysisHud } from "./AnalysisHud";
import { MuteShow } from "./MuteShow";
import { PlayerControls } from "./PlayerControls";
import { Timeline } from "./Timeline";

interface PlayerCardProps {
  store: FetchrMuteStore;
  player: MediaPlayer;
  fileDetails: FileDetails | null;
  isVideo: boolean;
  reviewMode: boolean;
  controlsDisabled: boolean;
  waveBars: number[];
  waveStatus: WaveStatus;
  showBars: number[];
  muteSummary: boolean;
  visibleSpans: MuteSpan[];
  activeProfaneSpan: MuteSpan | null;
  /** Хиты проверки и навигатор — только на экране проверки. */
  hits: ReviewHit[] | null;
  navigator: HitNavigator | null;
  onCancelProcessing: () => void;
  onSkipShow: () => void;
  onMarkerClick: (e: React.MouseEvent, span: MuteSpan) => void;
}

/** Плеер: кадр или аудиосцена, экран анализа, «шоу удаления» и управление. */
export function PlayerCard({
  store,
  player,
  fileDetails,
  isVideo,
  reviewMode,
  controlsDisabled,
  waveBars,
  waveStatus,
  showBars,
  muteSummary,
  visibleSpans,
  activeProfaneSpan,
  hits,
  navigator,
  onCancelProcessing,
  onSkipShow,
  onMarkerClick,
}: PlayerCardProps) {
  const { t } = useTranslation();
  const { processing, isMutingAnimation, outputPath, mediaError } = store;
  const playRatio = player.duration > 0 ? player.currentTime / player.duration : 0;

  return (
    <section className={styles.playerCard} aria-label={t("fetchr_mute.player")}>
      <div className={cn(styles.stage, !isVideo && styles.stageAudio)}>
        <PlayerMedia
          store={store}
          player={player}
          fileDetails={fileDetails}
          isVideo={isVideo}
        />

        {processing && !isMutingAnimation && (
          <AnalysisHud
            isVideo={isVideo}
            progressPercent={store.progressPercent}
            progressMessage={store.progressMessage}
            processingElapsed={store.processingElapsed}
            waveBars={waveBars}
            onCancel={onCancelProcessing}
          />
        )}

        {processing && isMutingAnimation && (
          <MuteShow
            isVideo={isVideo}
            spans={store.spans}
            visibleSpans={visibleSpans}
            activeProfaneSpan={activeProfaneSpan}
            muteSummary={muteSummary}
            duration={player.duration}
            currentScanTime={store.currentScanTime}
            scanProgress={store.scanProgress}
            finalProcessingTime={store.finalProcessingTime}
            showBars={showBars}
            onSkip={onSkipShow}
          />
        )}
      </div>

      <div className={cn(styles.controls, processing && !isMutingAnimation && styles.controlsHidden)}>
        <Timeline
          isVideo={isVideo}
          processing={processing}
          reviewMode={reviewMode}
          isMutingAnimation={isMutingAnimation}
          duration={player.duration}
          currentTime={player.currentTime}
          playRatio={playRatio}
          currentScanTime={store.currentScanTime}
          waveBars={waveBars}
          waveStatus={waveStatus}
          visibleSpans={visibleSpans}
          activeProfaneSpan={activeProfaneSpan}
          hits={hits}
          currentHitIndex={navigator?.current ?? -1}
          onSeekRatio={player.seekToRatio}
          onSeekTo={player.seekTo}
          onMarkerClick={onMarkerClick}
          onHitClick={(index) => navigator?.goTo(index)}
        />
        <PlayerControls
          player={player}
          hasResult={Boolean(outputPath && !processing)}
          mediaError={mediaError}
          controlsDisabled={controlsDisabled}
          navigator={navigator}
        />
      </div>
    </section>
  );
}

interface PlayerMediaProps {
  store: FetchrMuteStore;
  player: MediaPlayer;
  fileDetails: FileDetails | null;
  isVideo: boolean;
}

// Сам медиаэлемент: видео, аудиосцена с диском или сообщение об ошибке кодека.
function PlayerMedia({ store, player, fileDetails, isVideo }: PlayerMediaProps) {
  const { t } = useTranslation();
  const { processing, outputPath, mediaError } = store;

  if (mediaError) {
    return (
      <div className={styles.mediaError}>
        <RedesignIcon name="alert" />
        <strong>
          {t("fetchr_mute.pleer_ne_podderzhivaet")}
        </strong>
        <span>{mediaError}</span>
        {outputPath && (
          <code className={styles.mediaErrorPath}>{outputPath}</code>
        )}
      </div>
    );
  }

  if (isVideo) {
    return (
      <video
        ref={player.attachMedia}
        src={player.mediaSrc}
        className={styles.video}
        onTimeUpdate={player.handleTimeUpdate}
        onLoadedMetadata={player.handleLoadedMetadata}
        onClick={processing ? undefined : player.togglePlay}
        onError={() =>
          player.handleMediaError(t("fetchr_mute.error_media_video_unsupported"))
        }
        crossOrigin={player.crossOrigin}
        muted={processing || player.isMuted}
      />
    );
  }

  return (
    <div className={styles.audioStage}>
      <span className={styles.audioLabel}>
        {player.isPlaying ? t("fetchr_mute.playing") : fileDetails?.name}
      </span>
      <audio
        ref={player.attachMedia}
        src={player.mediaSrc}
        onTimeUpdate={player.handleTimeUpdate}
        onLoadedMetadata={player.handleLoadedMetadata}
        onError={() =>
          player.handleMediaError(t("fetchr_mute.error_media_audio_unsupported"))
        }
        crossOrigin={player.crossOrigin}
        muted={processing || player.isMuted}
      />
    </div>
  );
}
