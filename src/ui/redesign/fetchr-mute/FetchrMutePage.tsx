import type React from "react";
import { useTranslation } from "react-i18next";

// shared.module.css — первым: единственный модуль с composes из AudioTool и
// примитивов, его CSS должен идти в бандле раньше стилей компонентов.
import shared from "./shared.module.css";
import styles from "./FetchrMutePage.module.css";
import { fetchrThemeClassName } from "@/ui/redesign/theme";
import { useSettings } from "@/stores/settings";
import { useFetchrMuteStore } from "@/stores/fetchrMute";
import { cn } from "@/lib/utils";
import type { MuteSpan } from "@/types/job";

import { BatchCard } from "./components/BatchCard";
import { EmptyState } from "./components/EmptyState";
import { ErrorBanner } from "./components/ErrorBanner";
import { NoticeBanner } from "./components/NoticeBanner";
import { PendingConfirm } from "./components/PendingConfirm";
import { PendingEditsBar } from "./components/PendingEditsBar";
import { PlayerCard } from "./components/PlayerCard";
import { RerunConfirm } from "./components/RerunConfirm";
import { RunCard } from "./components/RunCard";
import { SourceBar } from "./components/SourceBar";
import { ReviewPanel } from "./components/review/ReviewPanel";
import { SettingsRail } from "./components/settings/SettingsRail";
import { useBatchFiles } from "./hooks/useBatchFiles";
import { useFetchrMuteSettings } from "./hooks/useFetchrMuteSettings";
import { useMediaPlayer } from "./hooks/useMediaPlayer";
import { useMuteEdits } from "./hooks/useMuteEdits";
import { useMuteHistory } from "./hooks/useMuteHistory";
import { useMutePresets } from "./hooks/useMutePresets";
import { useMuteShow } from "./hooks/useMuteShow";
import { useMomentExport } from "./hooks/useMomentExport";
import { usePageLifecycle } from "./hooks/usePageLifecycle";
import { useProcessingActions } from "./hooks/useProcessingActions";
import { useReviewScreen } from "./hooks/useReviewScreen";
import { useSettingsActions } from "./hooks/useSettingsActions";
import { useSourceFile } from "./hooks/useSourceFile";
import { useTranscriptView } from "./hooks/useTranscriptView";
import { useWaveform } from "./hooks/useWaveform";
import { useWordLists } from "./hooks/useWordLists";
import { useEditShortcuts } from "./hooks/useEditShortcuts";
import { usePendingEdits } from "./hooks/usePendingEdits";
import { usePendingGuard } from "./hooks/usePendingGuard";
import { usePreviewAudio } from "./hooks/usePreviewAudio";
import type { SpanGroup } from "./types";

export function FetchrMutePage() {
  const { t } = useTranslation();
  const { binariesDir } = useSettings();
  // Selected state and actions from global Zustand store
  const store = useFetchrMuteStore();
  const { filePath, processing, outputPath, words, mediaError } = store;

  const settings = useFetchrMuteSettings(store.audioTrackIndex);
  // Несколько файлов сразу — пакет задач очереди вместо одиночной обработки.
  const batch = useBatchFiles({ store, binariesDir });
  const source = useSourceFile(store, binariesDir, settings.restoreGlobalSettings, batch);
  const lifecycle = usePageLifecycle(store.notice, Boolean(store.noticeAction), store.setNotice);
  // Правки результата копятся неприменёнными; файл пересобирается по «Применить».
  const pending = usePendingEdits({ store, settings, binariesDir });
  const { effectiveSpans, recordEdit } = pending;
  const presets = useMutePresets({ settings, recordEdit });
  const actions = useProcessingActions({
    store,
    binariesDir,
    settings,
    fileDetails: source.fileDetails,
    effectiveSpans,
    ensureApplied: pending.ensureApplied,
  });
  const momentExport = useMomentExport({
    filePath,
    words,
    effectiveSpans,
    setNotice: store.setNotice,
  });
  const player = useMediaPlayer({
    filePath,
    outputPath,
    cacheBuster: store.cacheBuster,
    mediaError,
    processing,
    hasPendingEdits: pending.pendingCount > 0,
    setError: store.setError,
    setMediaError: store.setMediaError,
  });
  usePreviewAudio({
    mediaEl: player.mediaEl,
    active: player.previewing,
    spans: effectiveSpans,
    method: settings.censorMethod,
    volume: player.volume,
    muted: player.isMuted,
  });
  const history = useMuteHistory(
    store,
    settings.applyHistorySettings,
    settings.restoreGlobalSettings,
  );
  const wordLists = useWordLists({
    settings,
    recordEdit,
    setError: store.setError,
  });
  const edits = useMuteEdits({
    store,
    fileStem: source.fileDetails?.stem,
    currentSettings: settings.currentSettings,
    effectiveSpans,
    recordEdit,
    ensureApplied: pending.ensureApplied,
    currentTime: player.currentTime,
    duration: player.duration,
  });
  const settingsActions = useSettingsActions({
    store,
    settings,
    fileDetails: source.fileDetails,
    recordEdit,
    apply: pending.apply,
    onRerun: actions.rerunProcessing,
  });
  const show = useMuteShow({
    store,
    mediaRef: player.mediaRef,
    duration: player.duration,
    setCurrentTime: player.setCurrentTime,
    reviewSpans: effectiveSpans,
  });
  const transcript = useTranscriptView(words, effectiveSpans, player.currentTime);
  const review = useReviewScreen({
    words,
    effectiveSpans,
    excludedSpans: store.excludedSpans,
    currentSettings: settings.currentSettings,
    player,
    edits,
    wordLists,
    recordEdit,
    fileKey: filePath,
  });
  const guard = usePendingGuard({ pending, closeFile: source.clearFile });
  const applyPending = () => void pending.apply();
  // Готовый результат: транскрипт становится главным, плеер сжимается сверху.
  const reviewMode = Boolean(outputPath && words && !processing);
  useEditShortcuts({
    enabled: pending.hasResult,
    onUndo: pending.undo,
    onRedo: pending.redo,
    onApply: applyPending,
    review: reviewMode ? review.shortcuts : null,
  });
  const waveform = useWaveform(filePath, binariesDir);

  const methodLabels = {
    beep: t("purevoice.method_beep"),
    custom: t("purevoice.method_custom"),
    mute: t("purevoice.method_mute"),
  } as const;

  // Дорожку показываем в сводке, только если выбирать было из чего.
  const selectedTrack = store.audioTracks.find((track) => track.index === store.audioTrackIndex);
  const trackLabel =
    store.audioTracks.length > 1 && selectedTrack
      ? [
          `#${selectedTrack.index + 1}`,
          [selectedTrack.language?.toUpperCase(), selectedTrack.title].filter(Boolean).join(", "),
        ]
          .filter(Boolean)
          .join(" ")
      : null;

  const controlsDisabled = processing || !outputPath || !!mediaError;
  const showPendingBar =
    Boolean(outputPath && words) &&
    (pending.pendingCount > 0 || store.recensoring) &&
    !guard.confirmOpen;

  const handleMarkerClick = (e: React.MouseEvent, span: MuteSpan) => {
    e.stopPropagation();
    player.seekToTime(Math.max(0, span.start - 0.8));
  };

  // Частое слово в правой колонке: ручные отрезки — списком, слово — поиском.
  const showSpanGroup = (group: SpanGroup) => {
    if (group.isManual) {
      review.reviewView.setFilter("manual");
      review.reviewView.setView("list");
      return;
    }
    review.reviewView.searchWord(group.label);
  };

  return (
    <div
      className={cn(fetchrThemeClassName, shared.page)}
      data-fetchr-mute-page=""
      data-review={reviewMode || undefined}
    >
      <div className={shared.mainLayout}>
        <div className={cn(shared.content, styles.content)}>
          <div className={cn(shared.workspace, styles.workspace)}>
            {store.error && (
              <ErrorBanner
                message={store.error}
                details={store.errorDetails}
                onRetry={store.errorRetry}
                onDismiss={() => store.setError(null)}
              />
            )}
            {store.notice && (
              <NoticeBanner
                message={store.notice}
                action={store.noticeAction}
                onDismiss={() => store.setNotice(null)}
                onHoverChange={lifecycle.setNoticeHovered}
              />
            )}

            {!filePath && batch.size > 0 && (
              <BatchCard
                files={batch.files}
                presets={presets}
                outputDir={batch.outputDir}
                queuing={batch.queuing}
                dragActive={source.dragActive}
                onRemove={batch.remove}
                onChooseDir={() => void batch.chooseOutputDir()}
                onResetDir={batch.resetOutputDir}
                onCancel={batch.clear}
                onEnqueue={() => void batch.enqueueAll(settings.getSettings())}
              />
            )}

            {!filePath && batch.size === 0 && (
              <EmptyState
                dragActive={source.dragActive}
                onDrag={source.handleDrag}
                onDrop={source.handleDrop}
                onChooseFile={() => void source.chooseLocalFiles()}
                history={history.history}
                historyMissing={history.historyMissing}
                currentRecognitionVersion={history.currentRecognitionVersion}
                onOpenHistoryItem={history.loadHistoryItem}
                onDeleteHistoryItem={(id) => void history.deleteHistoryItem(id)}
              />
            )}

            {filePath && (
              <>
                <SourceBar
                  fileDetails={source.fileDetails}
                  isVideo={source.isVideo}
                  duration={player.duration}
                  hasResult={Boolean(outputPath && !processing)}
                  processing={processing}
                  onReveal={() => void actions.revealOutput()}
                  onSendToVocalRemover={() => void actions.sendToVocalRemover()}
                  onRerun={actions.rerunProcessing}
                  onExportEdits={() => void edits.exportMuteEdits()}
                  onImportEdits={(event) => void edits.importMuteEdits(event)}
                  hasSpanEdits={store.manualSpans.length > 0 || store.excludedSpans.length > 0}
                  onResetEdits={pending.resetSpanEdits}
                  onExportSrt={() => void momentExport.exportSrt()}
                  onExportEdl={() => void momentExport.exportEdl()}
                  onExportTxt={() => void actions.downloadTranscript()}
                  onClose={guard.requestClose}
                />

                {guard.confirmOpen && (
                  <PendingConfirm
                    count={pending.pendingCount}
                    onApply={() => void guard.confirmApply()}
                    onDiscard={guard.confirmDiscard}
                    onCancel={guard.confirmCancel}
                  />
                )}

                {actions.rerunConfirmOpen && !processing && (
                  <RerunConfirm
                    hasEdits={store.manualSpans.length > 0 || store.excludedSpans.length > 0}
                    onKeepEdits={() => actions.confirmRerun(true)}
                    onResetEdits={() => actions.confirmRerun(false)}
                    onCancel={actions.dismissRerunConfirm}
                  />
                )}

                {!outputPath && !processing && (
                  <RunCard
                    methodLabel={methodLabels[settings.censorMethod]}
                    coveragePercent={settings.coveragePercent}
                    trackLabel={trackLabel}
                    blacklistCount={wordLists.blacklist.length}
                    onlyCustomWords={settings.onlyCustomWords}
                    outputDir={store.outputDir}
                    outputName={store.outputName}
                    onStart={actions.startProcessing}
                  />
                )}

                {(outputPath || processing) && (
                  <PlayerCard
                    store={store}
                    player={player}
                    fileDetails={source.fileDetails}
                    isVideo={source.isVideo}
                    reviewMode={reviewMode}
                    controlsDisabled={controlsDisabled}
                    waveBars={waveform.waveBars}
                    waveStatus={waveform.waveStatus}
                    showBars={waveform.showBars}
                    muteSummary={show.muteSummary}
                    visibleSpans={show.visibleSpans}
                    activeProfaneSpan={show.activeProfaneSpan}
                    hits={reviewMode ? review.model.hits : null}
                    navigator={reviewMode ? review.navigator : null}
                    onCancelProcessing={actions.cancelProcessing}
                    onSkipShow={show.skip}
                    onMarkerClick={handleMarkerClick}
                  />
                )}

                {showPendingBar && (
                  <PendingEditsBar
                    count={pending.pendingCount}
                    canUndo={pending.canUndo}
                    applying={store.recensoring}
                    percent={store.recensorPercent}
                    onUndo={pending.undo}
                    onDiscard={pending.discardPendingWithUndo}
                    onApply={applyPending}
                    onCancelApply={store.cancelRecensor}
                  />
                )}

                {reviewMode && words && (
                  <ReviewPanel
                    words={words}
                    model={review.model}
                    reviewView={review.reviewView}
                    playingIndex={transcript.activeWordIdx}
                    navigator={review.navigator}
                    edits={edits}
                    actions={review.actions}
                  />
                )}
              </>
            )}
          </div>
        </div>

        <SettingsRail
          store={store}
          settings={settings}
          actions={settingsActions}
          wordLists={wordLists}
          presets={presets}
          fileDetails={source.fileDetails}
          summary={
            reviewMode
              ? {
                  mutedCount: effectiveSpans.length,
                  uncertainCount: review.model.counts.uncertain,
                }
              : null
          }
          spanGroups={transcript.spanGroups}
          onShowGroup={showSpanGroup}
        />
      </div>
    </div>
  );
}
