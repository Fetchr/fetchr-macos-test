import { convertFileSrc } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { PointerEvent as ReactPointerEvent } from "react";

import { activateOnKey } from "@/lib/a11y";
import { DemoSlot, VocalDemo } from "@/ui/redesign/demos/DemoSlot";
import { ipc } from "@/lib/ipc";
import { notifyError } from "@/lib/notify";
import { cn } from "@/lib/utils";
import { useSettings } from "@/stores/settings";
import {
  ensureVocalRemoverProgressListener,
  useVocalRemoverStore,
} from "@/stores/vocalRemover";
import type {
  VocalRemoverAudioSegment,
  VocalRemoverHistoryItem,
  VocalRemoverMode,
  VocalRemoverResult,
  VocalRemoverWorkflow,
  CopyrightTimelineSegment,
} from "@/types/job";
import { useAudioPeaks, useTrackArtwork } from "@/ui/redesign/audio-tools/useAudioMeta";
import { RedesignIcon } from "@/ui/redesign/icons/iconMap";
import { fetchrThemeClassName } from "@/ui/redesign/theme";
import { staggerIn } from "@/ui/redesign/theme/gsapMotion";
import { useGSAP } from "@/ui/redesign/theme/gsapSetup";

import styles from "./VocalRemoverPage.module.css";

const SETTINGS_STORAGE_KEY = "vocal-remover-settings";

const MODE_COPY: Record<
  VocalRemoverMode,
  { title: string; meta: string; description: string }
> = {
  fast_htdemucs: {
    title: "Быстрый",
    meta: "скорость",
    description:
      "MDX-Net Kim Inst: модель предсказывает музыку и вычитает её, поэтому в голосе остаётся заметно меньше следов трека, чем у Kim Vocal 2. Скорость на CPU та же.",
  },
  studio_htdemucs_ft: {
    title: "Студийный",
    meta: "качество",
    description:
      "Windowed RoFormer (Smule, MIT): разделяет речь и музыку не хуже BS-Roformer, но считает примерно вдвое быстрее за счёт блочного внимания. Работает на CPU; ориентирован на чистый результат для публикации и монетизации. Модель весит ~950 МБ и скачивается один раз.",
  },
  ultra_melband: {
    title: "Максимум",
    meta: "лучшее качество, нужна видеокарта",
    description:
      "Mel-Band RoFormer SYHFT — линейка Kim Vocal 2 нового поколения (лидер по качеству вокала). Модель fp16: на видеокарте (DirectML/CoreML) летает, на CPU может быть медленной или недоступной.",
  },
};

const WORKFLOW_COPY: Record<
  VocalRemoverWorkflow,
  { title: string; meta: string; description: string }
> = {
  stems: {
    title: "Разделить на стемы",
    meta: "vocals.wav + instrumental.wav",
    description: "Два WAV: голос и музыка отдельно",
  },
  anti_copyright: {
    title: "Убрать музыку с АП",
    meta: "поиск → очистка → сборка",
    description: "Найдём музыку, уберём только её, голос останется",
  },
};

export function VocalRemoverPage() {
  const [pickedSegment, setFocusedSegment] = useState(0);
  const { t } = useTranslation();
  // Каскад секций боковой панели на монтировании. Селектор глобальный
  // намеренно: маршрут в приложении всегда один, двух страниц с
  // data-stagger одновременно в DOM не бывает.
  useGSAP(() => {
    staggerIn("[data-stagger]");
  }, []);
  const binariesDir = useSettings((s) => s.binariesDir);
  const [mode, setMode] = useState<VocalRemoverMode>(() => readSavedMode());
  const [workflow, setWorkflow] = useState<VocalRemoverWorkflow>(() =>
    readSavedWorkflow(),
  );
  const [history, setHistory] = useState<VocalRemoverHistoryItem[]>([]);
  const [dragActive, setDragActive] = useState(false);
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);
  const [previewTime, setPreviewTime] = useState<number | null>(null);
  const previewRef = useRef<HTMLAudioElement | null>(null);
  const cancelledRef = useRef(false);

  // Transient processing state lives in a zustand store so it survives page
  // switches; progress events are routed into the store at module level.
  const {
    filePath,
    processing,
    taskId,
    progressPercent,
    progressMessage,
    result,
    error,
    cacheBuster,
    copyrightSegments,
    scanningCopyright,
    scanTaskId,
    scanProgressPercent,
    scanProgressMessage,
    mediaDuration,
    excludedSegments,
    update,
    toggleExcluded,
  } = useVocalRemoverStore();

  const setFilePath = (filePath: string | null) => update({ filePath });
  const setProcessing = (processing: boolean) => update({ processing });
  const setTaskId = (taskId: string | null) => update({ taskId });
  const setProgressPercent = (progressPercent: number) =>
    update({ progressPercent });
  const setProgressMessage = (progressMessage: string) =>
    update({ progressMessage });
  const setResult = (result: VocalRemoverResult | null) => update({ result });
  const setError = (error: string | null) => update({ error });
  const setCacheBuster = (cacheBuster: number) => update({ cacheBuster });
  const setCopyrightSegments = (
    copyrightSegments: CopyrightTimelineSegment[] | null,
  ) => update({ copyrightSegments });
  const setScanningCopyright = (scanningCopyright: boolean) =>
    update({ scanningCopyright });
  const setScanTaskId = (scanTaskId: string | null) => update({ scanTaskId });
  const setScanProgressPercent = (scanProgressPercent: number) =>
    update({ scanProgressPercent });
  const setScanProgressMessage = (scanProgressMessage: string) =>
    update({ scanProgressMessage });
  const setMediaDuration = (mediaDuration: number | null) =>
    update({ mediaDuration });
  const setExcludedSegments = (excludedSegments: Set<number>) =>
    update({ excludedSegments });

  const fileDetails = useMemo(() => getFileDetails(filePath), [filePath]);
  const busy = processing || scanningCopyright;
  const canStart = Boolean(filePath) && !busy;

  const refreshHistory = useCallback(() => {
    ipc
      .getVocalRemoverHistory()
      .then(setHistory)
      .catch((err) => notifyError("Не удалось загрузить историю.", err));
  }, []);

  useEffect(() => {
    refreshHistory();
  }, [refreshHistory]);

  useEffect(() => {
    localStorage.setItem(
      SETTINGS_STORAGE_KEY,
      JSON.stringify({ mode, workflow }),
    );
  }, [mode, workflow]);

  useEffect(() => {
    ensureVocalRemoverProgressListener();
  }, []);

  const chooseFile = useCallback(async () => {
    if (processing || scanningCopyright) return;
    const selected = await ipc.chooseMediaFile();
    if (!selected) return;
    loadInputFile(selected);
  }, [processing, scanningCopyright]);

  const loadInputFile = useCallback(
    (path: string) => {
      if (processing || scanningCopyright) {
        setError(
          "Дождитесь завершения текущей обработки, прежде чем загружать новый файл.",
        );
        return;
      }
      const preview = previewRef.current;
      if (preview) preview.pause();
      setPreviewIndex(null);
      setExcludedSegments(new Set());
      setFilePath(path);
      setResult(null);
      setError(null);
      setProgressPercent(0);
      setProgressMessage("Файл выбран");
      setCacheBuster(Date.now());

      setCopyrightSegments(null);
      setScanningCopyright(false);
      setScanTaskId(null);
      setScanProgressPercent(0);
      setScanProgressMessage("");
      setMediaDuration(null);

      ipc
        .probeDuration(path, binariesDir)
        .then((dur) => {
          if (dur) setMediaDuration(dur);
        })
        .catch((err) => console.error("Failed to probe duration:", err));
    },
    [binariesDir, processing, scanningCopyright],
  );

  // Native Tauri drag&drop — HTML5 File objects have no .path in Tauri v2,
  // so real filesystem paths come from the webview onDragDrop event.
  const loadInputFileRef = useRef(loadInputFile);
  loadInputFileRef.current = loadInputFile;

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let active = true;
    getCurrentWebview()
      .onDragDropEvent((event) => {
        const p = event.payload;
        if (p.type === "enter" || p.type === "over") {
          setDragActive(true);
        } else if (p.type === "leave") {
          setDragActive(false);
        } else if (p.type === "drop") {
          setDragActive(false);
          const state = useVocalRemoverStore.getState();
          if (state.processing || state.scanningCopyright) {
            state.update({
              error:
                "Дождитесь завершения текущей обработки, прежде чем загружать новый файл.",
            });
            return;
          }
          const path = p.paths?.[0];
          if (path) loadInputFileRef.current(path);
        }
      })
      .then((fn) => {
        if (active) unlisten = fn;
        else fn();
      })
      .catch((err) =>
        console.error("Failed to attach drag&drop listener:", err),
      );
    return () => {
      active = false;
      unlisten?.();
    };
  }, []);

  const startProcessing = useCallback(async () => {
    if (!filePath || processing || scanningCopyright) return;

    const id = makeTaskId();
    cancelledRef.current = false;
    setTaskId(id);
    setProcessing(true);
    setError(null);
    setResult(null);
    setProgressPercent(0);
    setProgressMessage(
      workflow === "anti_copyright"
        ? "Готовим аудио-детекцию"
        : "Проверяем модель",
    );

    try {
      const output = await ipc.runVocalRemoverInPage(
        id,
        filePath,
        binariesDir,
        { mode, workflow },
      );
      setResult(output);
      setCacheBuster(Date.now());
      setProgressPercent(100);
      setProgressMessage("Готово");
      refreshHistory();
    } catch (err) {
      setError(
        cancelledRef.current ? "Обработка отменена." : errorToMessage(err),
      );
    } finally {
      setProcessing(false);
      setTaskId(null);
    }
  }, [
    binariesDir,
    filePath,
    mode,
    processing,
    refreshHistory,
    scanningCopyright,
    workflow,
  ]);

  const cancelProcessing = useCallback(async () => {
    if (!taskId) return;
    cancelledRef.current = true;
    setProgressMessage("Отменяем обработку");
    try {
      await ipc.cancelVocalRemoverInPage(taskId);
    } catch (err) {
      console.error("Failed to cancel vocal remover task:", err);
    }
  }, [taskId]);

  const stopPreview = useCallback(() => {
    const el = previewRef.current;
    if (el) el.pause();
    setPreviewIndex(null);
    setPreviewTime(null);
  }, []);

  const togglePreview = useCallback(
    (index: number) => {
      if (!copyrightSegments) return;
      if (previewIndex === index) {
        stopPreview();
        return;
      }
      const el = previewRef.current;
      const seg = copyrightSegments[index];
      if (!el || !seg) return;
      el.currentTime = seg.start_sec;
      void el.play().catch((err) => {
        setPreviewIndex(null);
        notifyError(
          "Не удалось воспроизвести фрагмент (формат не поддерживается предпросмотром).",
          err,
        );
      });
      setPreviewIndex(index);
    },
    [copyrightSegments, previewIndex, stopPreview],
  );

  const toggleSegmentExcluded = useCallback(
    (index: number) => {
      toggleExcluded(index);
    },
    [toggleExcluded],
  );

  const startCopyrightScan = useCallback(async () => {
    if (!filePath || scanningCopyright || processing) return;
    stopPreview();
    setExcludedSegments(new Set());

    const id = makeTaskId();
    setScanTaskId(id);
    setScanningCopyright(true);
    setScanProgressPercent(0);
    setScanProgressMessage("Готовим сканирование");
    setError(null);

    try {
      const segments = await ipc.scanVideoForCopyright(
        id,
        filePath,
        binariesDir,
      );
      setCopyrightSegments(segments);
      setScanProgressPercent(100);
      setScanProgressMessage("Сканирование завершено");
    } catch (err) {
      if (err !== "Scanning cancelled") {
        setError(errorToMessage(err));
      }
      setScanProgressPercent(0);
      setScanProgressMessage("");
    } finally {
      setScanningCopyright(false);
      setScanTaskId(null);
    }
  }, [binariesDir, filePath, processing, scanningCopyright, stopPreview]);

  const cancelCopyrightScanCall = useCallback(async () => {
    if (!scanTaskId) return;
    setScanProgressMessage("Отмена сканирования");
    try {
      await ipc.cancelCopyrightScan(scanTaskId);
    } catch (err) {
      console.error("Failed to cancel copyright scan:", err);
    }
  }, [scanTaskId]);

  const removeCopyrightMusic = useCallback(async () => {
    if (!filePath || !copyrightSegments || processing) return;

    const custom_segments = copyrightSegments
      .filter((_, index) => !excludedSegments.has(index))
      .map((seg) => ({
        start_sec: seg.start_sec,
        end_sec: seg.end_sec,
      }));
    if (custom_segments.length === 0) {
      setError("Все фрагменты исключены: нечего удалять.");
      return;
    }

    stopPreview();
    const id = makeTaskId();
    cancelledRef.current = false;
    setTaskId(id);
    setProcessing(true);
    setError(null);
    setResult(null);
    setProgressPercent(0);
    setProgressMessage("Запуск удаления музыки с АП");

    try {
      const output = await ipc.runVocalRemoverInPage(
        id,
        filePath,
        binariesDir,
        {
          mode,
          workflow: "anti_copyright",
          custom_segments,
        },
      );
      setResult(output);
      setCacheBuster(Date.now());
      setProgressPercent(100);
      setProgressMessage("Готово");
      refreshHistory();
    } catch (err) {
      setError(
        cancelledRef.current ? "Обработка отменена." : errorToMessage(err),
      );
    } finally {
      setProcessing(false);
      setTaskId(null);
    }
  }, [
    binariesDir,
    filePath,
    copyrightSegments,
    excludedSegments,
    mode,
    processing,
    refreshHistory,
    stopPreview,
  ]);

  const selectHistoryItem = useCallback(
    (item: VocalRemoverHistoryItem) => {
      stopPreview();
      setFilePath(item.filePath);
      setMode(item.mode in MODE_COPY ? item.mode : "fast_htdemucs");
      setWorkflow(item.workflow ?? "stems");
      setResult(resultFromHistory(item));
      setError(null);
      setProgressPercent(100);
      setProgressMessage("Результат открыт из истории");
      setCacheBuster(Date.now());

      // Reset any stale anti-copyright scan state from a previous file.
      setCopyrightSegments(null);
      setExcludedSegments(new Set());
      setScanningCopyright(false);
      setScanTaskId(null);
      setScanProgressPercent(0);
      setScanProgressMessage("");
      setMediaDuration(null);
      ipc
        .probeDuration(item.filePath, binariesDir)
        .then((dur) => {
          if (dur) setMediaDuration(dur);
        })
        .catch((err) => console.error("Failed to probe duration:", err));
    },
    [binariesDir, stopPreview],
  );

  const deleteHistoryItem = useCallback(async (id: string) => {
    try {
      await ipc.deleteVocalRemoverHistoryItem(id);
      setHistory((items) => items.filter((item) => item.id !== id));
    } catch (err) {
      setError(errorToMessage(err));
    }
  }, []);

  const selectedCount = copyrightSegments
    ? copyrightSegments.length - excludedSegments.size
    : 0;
  const action =
    workflow !== "anti_copyright"
      ? {
          label: processing ? "Разделяем…" : "Разделить на стемы",
          icon: processing ? ("loading" as const) : ("play" as const),
          onClick: startProcessing,
          disabled: !canStart,
        }
      : copyrightSegments
        ? {
            label: processing ? "Очищаем…" : `Убрать музыку · ${selectedCount}`,
            icon: processing ? ("loading" as const) : ("vocal" as const),
            onClick: removeCopyrightMusic,
            disabled: processing || selectedCount === 0,
          }
        : {
            label: scanningCopyright ? "Сканируем…" : "Найти музыку",
            icon: scanningCopyright
              ? ("loading" as const)
              : ("finder" as const),
            onClick: startCopyrightScan,
            disabled: scanningCopyright || processing,
          };

  const activeProgress = processing
    ? {
        percent: progressPercent,
        message: progressMessage,
        cancel: cancelProcessing,
      }
    : scanningCopyright
      ? {
          percent: scanProgressPercent,
          message: scanProgressMessage,
          cancel: cancelCopyrightScanCall,
        }
      : null;

  const sourcePeaks = useAudioPeaks(filePath || null, 180);
  // Какой трек показан крупно: тот, что слушают, иначе выбранный в списке.
  const focusedSegment = previewIndex ?? pickedSegment;

  return (
    <div className={cn(fetchrThemeClassName, styles.page)}>
      <main className={styles.mainLayout}>
        <section className={styles.content}>
          <div className={styles.workspace}>
            <header className={styles.pageHead}>
              <div
                className={styles.taskSwitch}
                role="radiogroup"
                aria-label="Задача"
              >
                {(["stems", "anti_copyright"] as VocalRemoverWorkflow[]).map(
                  (item) => {
                    const copy = WORKFLOW_COPY[item];
                    const active = item === workflow;
                    return (
                      <button
                        key={item}
                        type="button"
                        role="radio"
                        aria-checked={active}
                        className={cn(
                          styles.taskOption,
                          active && styles.taskOptionActive,
                        )}
                        onClick={() => setWorkflow(item)}
                        disabled={busy}
                      >
                        <span className={styles.taskIcon} aria-hidden="true">
                          <RedesignIcon
                            name={item === "stems" ? "media" : "secure"}
                          />
                        </span>
                        <span className={styles.taskText}>
                          <span className={styles.taskTitle}>{copy.title}</span>
                          <span className={styles.taskMeta}>
                            {copy.description}
                          </span>
                        </span>
                      </button>
                    );
                  },
                )}
              </div>
            </header>

            {fileDetails ? (
              <section
                className={cn(styles.source, dragActive && styles.sourceDrag)}
                aria-label="Исходный файл"
              >
                <span className={styles.sourceIcon} aria-hidden="true">
                  <RedesignIcon
                    name={isVideoPath(fileDetails.name) ? "video" : "audio"}
                  />
                </span>
                <span className={styles.sourceText}>
                  <span className={styles.sourceName} title={fileDetails.name}>
                    {fileDetails.name}
                  </span>
                  <span className={styles.sourceMeta}>
                    {mediaDuration
                      ? `${formatTimestamp(mediaDuration)} · `
                      : ""}
                    {fileDetails.parent || filePath}
                  </span>
                </span>
                <button
                  type="button"
                  className={styles.secondaryButton}
                  onClick={chooseFile}
                  disabled={busy}
                >
                  <RedesignIcon name="folder" />
                  {t("vocal_remover.zamenit", "Заменить")}
                </button>
              </section>
            ) : (
              <section
                className={cn(
                  styles.dropZone,
                  dragActive && styles.dropZoneActive,
                )}
                onClick={chooseFile}
                role="button"
                aria-disabled={busy}
                tabIndex={0}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    void chooseFile();
                  }
                }}
              >
                <DemoSlot demo={VocalDemo} height={232} />
                <span className={styles.dropTitle}>
                  {dragActive
                    ? t("vocal_remover.otpustite_fayl", "Отпустите файл")
                    : t(
                        "vocal_remover.peretaschite_mp3_wav_ili_video",
                        "Перетащите MP3, WAV или видео",
                      )}
                </span>
                <span className={styles.dropHint}>
                  {t(
                    "vocal_remover.ili_nazhmite_chtoby_vybrat_lokalnyy",
                    "Или нажмите, чтобы выбрать локальный медиафайл",
                  )}
                </span>
                <span className={styles.formats} aria-hidden="true">
                  {["MP3", "WAV", "FLAC", "MP4", "MKV"].map((format) => (
                    <span key={format} className={styles.format}>
                      {format}
                    </span>
                  ))}
                </span>
              </section>
            )}

            {error && (
              <div className={styles.errorBox} role="alert">
                <RedesignIcon name="alert" />
                <span>{error}</span>
              </div>
            )}

            {filePath && workflow === "anti_copyright" && copyrightSegments && (
              <section className={styles.scan} aria-label="Найденная музыка">
                <header className={styles.sectionHead}>
                  <h2 className={styles.sectionTitle}>
                    {t("vocal_remover.naydennaya_muzyka", "Найденная музыка")}
                    <span className={styles.count}>
                      {copyrightSegments.length}
                    </span>
                  </h2>
                  <button
                    className={styles.ghostButton}
                    type="button"
                    onClick={() => {
                      stopPreview();
                      setCopyrightSegments(null);
                      setExcludedSegments(new Set());
                      setScanProgressPercent(0);
                    }}
                    disabled={processing}
                  >
                    <RedesignIcon name="reset" />
                    {t("vocal_remover.skanirovat_zanovo", "Сканировать заново")}
                  </button>
                </header>

                <div className={styles.timeline}>
                  <div className={styles.timelineTrack}>
                    {sourcePeaks && (
                      <span className={styles.timelineWave} aria-hidden="true">
                        {sourcePeaks.map((value, index) => (
                          <i key={index} style={{ height: `${Math.round(8 + value * 92)}%` }} />
                        ))}
                      </span>
                    )}
                    {mediaDuration && mediaDuration > 0 ? (
                      <>
                        {copyrightSegments.map((seg, index) => {
                          const left = (seg.start_sec / mediaDuration) * 100;
                          const width =
                            ((seg.end_sec - seg.start_sec) / mediaDuration) *
                            100;
                          const playing = previewIndex === index;
                          const excluded = excludedSegments.has(index);
                          const baseTitle = seg.is_commercial
                            ? `Коммерческий трек: ${seg.track_title || "Неизвестно"} (${formatTimestamp(seg.start_sec)}-${formatTimestamp(seg.end_sec)})`
                            : `Найденная музыка (${formatTimestamp(seg.start_sec)}-${formatTimestamp(seg.end_sec)})`;
                          return (
                            <div
                              key={index}
                              className={cn(
                                styles.timelineBlock,
                                seg.is_commercial
                                  ? styles.blockCommercial
                                  : styles.blockMusic,
                                excluded && styles.blockExcluded,
                                playing && styles.blockPlaying,
                              )}
                              style={{
                                left: `${left}%`,
                                width: `${Math.max(0.4, width)}%`,
                              }}
                              role="button"
                              tabIndex={0}
                              aria-label={baseTitle}
                              aria-pressed={playing}
                              title={`${baseTitle}: клик, чтобы ${playing ? "остановить" : "прослушать"}`}
                              onClick={() => togglePreview(index)}
                              onKeyDown={activateOnKey(() =>
                                togglePreview(index),
                              )}
                            />
                          );
                        })}
                        {previewTime !== null && (
                          <div
                            className={styles.playhead}
                            style={{
                              left: `${Math.min(100, (previewTime / mediaDuration) * 100)}%`,
                            }}
                          />
                        )}
                      </>
                    ) : (
                      <div className={styles.timelineEmpty}>
                        {t(
                          "vocal_remover.taymlayn_nedostupen_net_dlitelnosti",
                          "Таймлайн недоступен (нет длительности)",
                        )}
                      </div>
                    )}
                  </div>
                  {mediaDuration && mediaDuration > 0 ? (
                    <div className={styles.ruler} aria-hidden="true">
                      {[0, 0.25, 0.5, 0.75, 1].map((f) => (
                        <span key={f}>
                          {formatTimestamp(mediaDuration * f)}
                        </span>
                      ))}
                    </div>
                  ) : null}
                  {copyrightSegments.length > 0 && (
                    <div className={styles.legend}>
                      <span className={styles.legendItem}>
                        <i
                          className={cn(
                            styles.legendDot,
                            styles.blockCommercial,
                          )}
                        />
                        {t(
                          "vocal_remover.kommercheskiy_trek",
                          "Коммерческий трек",
                        )}
                      </span>
                      <span className={styles.legendItem}>
                        <i
                          className={cn(styles.legendDot, styles.blockMusic)}
                        />
                        {t(
                          "vocal_remover.muzyka_lokalnyy_ii",
                          "Музыка (локальный ИИ)",
                        )}
                      </span>
                      <span className={styles.legendItem}>
                        <i
                          className={cn(styles.legendDot, styles.blockExcluded)}
                        />
                        {t(
                          "vocal_remover.ostavit_kak_est",
                          "Оставить как есть",
                        )}
                      </span>
                    </div>
                  )}
                </div>

                {copyrightSegments.length > 0 && (
                  <TrackNowCard
                    segment={copyrightSegments[focusedSegment] ?? copyrightSegments[0]}
                    playing={previewIndex === focusedSegment}
                    excluded={excludedSegments.has(focusedSegment)}
                    disabled={processing}
                    onPreview={() => togglePreview(focusedSegment)}
                    onToggle={() => toggleSegmentExcluded(focusedSegment)}
                  />
                )}

                {copyrightSegments.length > 0 ? (
                  <ul className={styles.segmentTable}>
                    {copyrightSegments.map((seg, index) => {
                      const excluded = excludedSegments.has(index);
                      const playing = previewIndex === index;
                      return (
                        <li
                          key={index}
                          className={cn(
                            styles.segmentRow,
                            excluded && styles.segmentRowExcluded,
                            playing && styles.segmentRowPlaying,
                          )}
                        >
                          <button
                            className={styles.iconButton}
                            type="button"
                            aria-label={
                              playing ? "Остановить" : "Прослушать фрагмент"
                            }
                            title={
                              playing ? "Остановить" : "Прослушать фрагмент"
                            }
                            onClick={() => togglePreview(index)}
                          >
                            <RedesignIcon name={playing ? "stop" : "play"} />
                          </button>
                          <SegmentInfo
                            segment={seg}
                            onSelect={() => setFocusedSegment(index)}
                          />
                          <span
                            className={cn(
                              styles.badge,
                              excluded
                                ? styles.badgeSkipped
                                : seg.is_commercial
                                  ? styles.badgeCommercial
                                  : styles.badgeMusic,
                            )}
                          >
                            {excluded
                              ? "Оставить"
                              : seg.is_commercial
                                ? "Точно АП"
                                : "Вероятно АП"}
                          </span>
                          <label
                            className={styles.switch}
                            title={excluded ? "Не очищать" : "Очистить"}
                          >
                            <input
                              type="checkbox"
                              checked={!excluded}
                              onChange={() => toggleSegmentExcluded(index)}
                              disabled={processing}
                              aria-label={`Очищать фрагмент ${formatTimestamp(seg.start_sec)}`}
                            />
                            <span
                              className={styles.switchTrack}
                              aria-hidden="true"
                            />
                          </label>
                        </li>
                      );
                    })}
                  </ul>
                ) : (
                  <div className={styles.cleanNotice}>
                    <RedesignIcon name="check" />
                    {t(
                      "vocal_remover.muzyka_i_kommercheskie_treki_ne",
                      "Музыка и коммерческие треки не обнаружены — файл чист.",
                    )}
                  </div>
                )}

                <audio
                  ref={previewRef}
                  src={filePath ? convertFileSrc(filePath) : undefined}
                  preload="none"
                  style={{ display: "none" }}
                  onTimeUpdate={() => {
                    const el = previewRef.current;
                    if (!el || previewIndex === null || !copyrightSegments)
                      return;
                    setPreviewTime(el.currentTime);
                    const seg = copyrightSegments[previewIndex];
                    if (seg && el.currentTime >= seg.end_sec) stopPreview();
                  }}
                  onEnded={stopPreview}
                  onPause={() => {
                    if (previewRef.current && previewRef.current.ended)
                      setPreviewIndex(null);
                  }}
                />
              </section>
            )}

            {result && (
              <ResultPreview result={result} cacheBuster={cacheBuster} />
            )}
          </div>
        </section>

        <aside className={styles.sidebar}>
          <section className={styles.sidebarSection} data-stagger>
            <h2 className={styles.sidebarTitle}>
              {t("vocal_remover.model", "Модель")}
            </h2>
            <div
              className={styles.modeList}
              role="radiogroup"
              aria-label="Модель"
            >
              {(
                [
                  "fast_htdemucs",
                  "studio_htdemucs_ft",
                  "ultra_melband",
                ] as VocalRemoverMode[]
              ).map((item) => {
                const copy = MODE_COPY[item];
                const active = item === mode;
                return (
                  <button
                    className={cn(
                      styles.modeButton,
                      active && styles.modeButtonActive,
                    )}
                    key={item}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    onClick={() => setMode(item)}
                    disabled={busy}
                  >
                    <span className={styles.modeRadio} aria-hidden="true" />
                    <span className={styles.modeText}>
                      <span className={styles.modeName}>{copy.title}</span>
                      <span className={styles.modeMeta}>{copy.meta}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          </section>

          <section
            className={cn(styles.sidebarSection, styles.historySection)}
            data-stagger
          >
            <h2 className={styles.sidebarTitle}>
              {t("vocal_remover.istoriya", "История")}
              {history.length > 0 && (
                <span className={styles.count}>{history.length}</span>
              )}
            </h2>
            {history.length > 0 ? (
              <ul className={styles.historyList}>
                {history.map((item) => (
                  <li className={styles.historyItem} key={item.id}>
                    <button
                      className={styles.historyOpen}
                      type="button"
                      onClick={() => selectHistoryItem(item)}
                      disabled={busy}
                    >
                      <span className={styles.historyName}>
                        {item.fileName}
                      </span>
                      <span className={styles.historyMeta}>
                        {historyWorkflowLabel(item)} · {formatDate(item.date)} ·{" "}
                        {formatElapsed(item.elapsedMs)}
                      </span>
                    </button>
                    <button
                      className={styles.historyDelete}
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation();
                        void deleteHistoryItem(item.id);
                      }}
                      aria-label={t(
                        "vocal_remover.udalit_iz_istorii",
                        "Удалить из истории",
                      )}
                      title={t(
                        "vocal_remover.udalit_iz_istorii",
                        "Удалить из истории",
                      )}
                    >
                      <RedesignIcon name="trash" />
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className={styles.sidebarHint}>
                {t(
                  "vocal_remover.zdes_poyavyatsya_poslednie_razdelennye_fayly",
                  "Здесь появятся последние разделенные файлы.",
                )}
              </p>
            )}
          </section>
          <div className={styles.sidebarFoot}>
          {filePath && (
            <section className={styles.runCard} aria-live="polite">
              {activeProgress ? (
                <div className={styles.progress}>
                  <div className={styles.progressHead}>
                    <span className={styles.progressLabel}>
                      <RedesignIcon
                        name="loading"
                        className={styles.spinning}
                      />
                      {activeProgress.message || "Обработка"}
                    </span>
                    <span className={styles.progressValue}>
                      {Math.round(activeProgress.percent)}%
                    </span>
                  </div>
                  <div
                    className={styles.progressTrack}
                    role="progressbar"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={Math.round(activeProgress.percent)}
                  >
                    <div
                      className={styles.progressFill}
                      style={{
                        transform: `scaleX(${Math.max(0.02, activeProgress.percent / 100)})`,
                      }}
                    />
                  </div>
                  <button
                    className={styles.secondaryButton}
                    type="button"
                    onClick={activeProgress.cancel}
                  >
                    <RedesignIcon name="stop" />
                    {t("vocal_remover.otmenit", "Отменить")}
                  </button>
                </div>
              ) : (
                <>
                  <div className={styles.runSummary}>
                    <span className={styles.runLabel}>Модель</span>
                    <span className={styles.runValue}>
                      {MODE_COPY[mode].title}
                    </span>
                    <span className={styles.runHint}>
                      {workflow === "anti_copyright"
                        ? copyrightSegments
                          ? `Очистим ${selectedCount} из ${copyrightSegments.length} найденных участков, остальное оставим как есть.`
                          : "Сначала найдём участки с музыкой, потом вы решите, какие из них чистить."
                        : "На выходе два WAV: голос и музыка отдельно."}
                    </span>
                  </div>
                  <button
                    className={styles.primaryButton}
                    type="button"
                    disabled={action.disabled}
                    onClick={action.onClick}
                  >
                    <RedesignIcon
                      name={action.icon}
                      className={
                        action.icon === "loading"
                          ? styles.spinning
                          : undefined
                      }
                    />
                    {action.label}
                  </button>
                </>
              )}
            </section>
          )}

          </div>
        </aside>
      </main>
    </div>
  );
}

function AudioPlayer({ src, path, tone }: { src: string; path: string; tone: StemTone }) {
  const peaks = useAudioPeaks(path, 160);
  const { t } = useTranslation();
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const trackRef = useRef<HTMLDivElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);

  const ratio = duration > 0 ? Math.min(1, time / duration) : 0;

  const seekTo = useCallback((clientX: number) => {
    const track = trackRef.current;
    const audio = audioRef.current;
    if (
      !track ||
      !audio ||
      !Number.isFinite(audio.duration) ||
      audio.duration <= 0
    )
      return;
    const rect = track.getBoundingClientRect();
    const next =
      Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)) *
      audio.duration;
    audio.currentTime = next;
    setTime(next);
  }, []);

  const seekBy = useCallback((seconds: number) => {
    const audio = audioRef.current;
    if (!audio || !Number.isFinite(audio.duration)) return;
    audio.currentTime = Math.min(
      audio.duration,
      Math.max(0, audio.currentTime + seconds),
    );
    setTime(audio.currentTime);
  }, []);

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      seekTo(event.clientX);
      const move = (e: PointerEvent) => seekTo(e.clientX);
      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    },
    [seekTo],
  );

  const toggle = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) void audio.play().catch(() => setPlaying(false));
    else audio.pause();
  }, []);

  return (
    <div className={styles.player} data-tone={tone}>
      <audio
        ref={audioRef}
        src={src}
        preload="metadata"
        onLoadedMetadata={(e) => setDuration(e.currentTarget.duration || 0)}
        onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
      />
      <button
        className={styles.playButton}
        type="button"
        onClick={toggle}
        aria-label={playing ? "Пауза" : "Воспроизвести"}
        title={playing ? "Пауза" : "Воспроизвести"}
      >
        <RedesignIcon name={playing ? "pause" : "play"} />
      </button>
      <div
        className={styles.wave}
        ref={trackRef}
        onPointerDown={onPointerDown}
        onKeyDown={(event) => {
          if (event.key === "ArrowRight") seekBy(5);
          else if (event.key === "ArrowLeft") seekBy(-5);
          else if (event.key === " ") toggle();
          else return;
          event.preventDefault();
        }}
        role="slider"
        aria-label={t("vocal_remover.poziciya", "Позиция")}
        aria-valuenow={Math.round(ratio * 100)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuetext={`${formatClock(time)} из ${formatClock(duration)}`}
        tabIndex={0}
      >
        {peaks ? (
          <span className={styles.waveBars} aria-hidden="true">
            {peaks.map((value, index) => (
              <i
                key={index}
                className={(index + 0.5) / peaks.length <= ratio ? styles.waveBarPlayed : undefined}
                style={{ height: `${Math.round(10 + value * 90)}%` }}
              />
            ))}
          </span>
        ) : (
          <span
            className={styles.waveFill}
            style={{ transform: `scaleX(${ratio})` }}
          />
        )}
        <span
          className={styles.waveThumb}
          style={{ left: `${ratio * 100}%` }}
        />
      </div>
      <span className={styles.playerTime}>
        {formatClock(time)} / {formatClock(duration)}
      </span>
      <button
        className={styles.iconButton}
        type="button"
        aria-label={muted ? "Включить звук" : "Выключить звук"}
        title={muted ? "Включить звук" : "Выключить звук"}
        onClick={() => {
          const audio = audioRef.current;
          if (!audio) return;
          audio.muted = !audio.muted;
          setMuted(audio.muted);
        }}
      >
        <RedesignIcon name={muted ? "mute" : "audio"} />
      </button>
    </div>
  );
}

type StemTone = "vocals" | "music" | "mix";

const STEM_COPY: Record<
  StemTone,
  { icon: "vocal" | "media" | "audio"; hint: string }
> = {
  vocals: { icon: "vocal", hint: "Голос без музыки" },
  music: { icon: "media", hint: "Музыка без голоса" },
  mix: { icon: "audio", hint: "Голос сохранён, музыка с АП убрана" },
};

function StemPreview({
  cacheBuster,
  label,
  path,
  tone = "mix",
}: {
  cacheBuster: number;
  label: string;
  path: string;
  tone?: StemTone;
}) {
  const { t } = useTranslation();
  const src = `${convertFileSrc(path)}?v=${cacheBuster}`;
  const copy = STEM_COPY[tone];
  return (
    <article className={styles.stemCard} data-tone={tone}>
      <header className={styles.stemHeader}>
        <span className={styles.stemIcon} aria-hidden="true">
          <RedesignIcon name={copy.icon} />
        </span>
        <span className={styles.stemText}>
          <span className={styles.stemTitle}>{label}</span>
          <span className={styles.stemHint} title={path}>
            {copy.hint} · {fileNameFromPath(path)}
          </span>
        </span>
        <span className={styles.stemActions}>
          <button
            className={styles.iconButton}
            type="button"
            aria-label={t("vocal_remover.pokazat_v_papke", "Показать в папке")}
            title={t("vocal_remover.pokazat_v_papke", "Показать в папке")}
            onClick={() => void ipc.revealFile(path)}
          >
            <RedesignIcon name="folder" />
          </button>
          <button
            className={styles.iconButton}
            type="button"
            aria-label={t("vocal_remover.otkryt_fayl", "Открыть файл")}
            title={t("vocal_remover.otkryt_fayl", "Открыть файл")}
            onClick={() => void ipc.openFolder(path)}
          >
            <RedesignIcon name="external" />
          </button>
        </span>
      </header>
      <AudioPlayer src={src} path={path} tone={tone} />
    </article>
  );
}

function ResultPreview({
  result,
  cacheBuster,
}: {
  result: VocalRemoverResult;
  cacheBuster: number;
}) {
  const { t } = useTranslation();
  const workflow = result.workflow ?? "stems";

  return (
    <section className={styles.results} aria-label="Результат">
      <header className={styles.sectionHead}>
        <h2 className={styles.sectionTitle}>
          <span className={styles.doneDot} aria-hidden="true">
            <RedesignIcon name="check" />
          </span>
          {t("vocal_remover.gotovo", "Готово")}
        </h2>
        <span className={styles.sectionMeta}>
          {MODE_COPY[result.mode]?.title ?? result.mode} ·{" "}
          {formatElapsed(result.elapsed_ms)}
        </span>
      </header>

      {workflow === "anti_copyright" ? (
        <>
          <StemPreview
            cacheBuster={cacheBuster}
            label="Чистая дорожка"
            path={result.antiCopyrightPath || result.vocals_path}
          />
          <dl className={styles.stats}>
            <div>
              <dt>Участков с музыкой</dt>
              <dd>{result.musicSegments?.length ?? 0}</dd>
            </div>
            <div>
              <dt>Очищено музыки</dt>
              <dd>{formatElapsed(result.processedMs ?? 0)}</dd>
            </div>
            <div>
              <dt>Вся обработка</dt>
              <dd>{formatElapsed(result.elapsed_ms)}</dd>
            </div>
          </dl>
          {result.musicSegments && result.musicSegments.length > 0 ? (
            <div className={styles.chips}>
              {result.musicSegments
                .slice(0, 12)
                .map((segment: VocalRemoverAudioSegment, index: number) => (
                  <span
                    className={styles.chip}
                    key={`${segment.start_sec}-${segment.end_sec}-${index}`}
                  >
                    {formatSegment(segment)}
                  </span>
                ))}
              {result.musicSegments.length > 12 && (
                <span className={styles.chip}>
                  +{result.musicSegments.length - 12}
                </span>
              )}
            </div>
          ) : (
            <p className={styles.sidebarHint}>
              {t(
                "vocal_remover.muzyka_ne_naydena_itogovyy_wav",
                "Музыка не найдена: итоговый WAV сохранен из оригинальной дорожки.",
              )}
            </p>
          )}
        </>
      ) : (
        <div className={styles.stemGrid}>
          <StemPreview
            cacheBuster={cacheBuster}
            label="Вокал"
            path={result.vocals_path}
            tone="vocals"
          />
          <StemPreview
            cacheBuster={cacheBuster}
            label="Инструментал"
            path={result.instrumental_path}
            tone="music"
          />
        </div>
      )}
    </section>
  );
}

/** Обложка трека: из каталога, иначе плашка с нотой. */
function TrackCover({ url, size, title }: { url: string | null | undefined; size: number; title: string }) {
  const [failed, setFailed] = useState(false);
  if (!url || failed) {
    return (
      <span className={styles.cover} style={{ width: size, height: size }} aria-hidden="true">
        <RedesignIcon name="audio" />
      </span>
    );
  }
  return (
    <img
      className={styles.cover}
      src={url}
      alt={title}
      width={size}
      height={size}
      loading="lazy"
      onError={() => setFailed(true)}
    />
  );
}

function segmentTitle(segment: CopyrightTimelineSegment): string {
  return segment.track_title || (segment.is_commercial ? "Коммерческий трек" : "Музыка без названия");
}

/** Строка найденной музыки: обложка, трек, исполнитель и время. */
function SegmentInfo({ segment, onSelect }: { segment: CopyrightTimelineSegment; onSelect: () => void }) {
  const artwork = useTrackArtwork(segment.track_title);
  return (
    <button type="button" className={styles.segmentInfo} onClick={onSelect}>
      <TrackCover url={artwork?.artwork_url} size={36} title={artwork?.title ?? segmentTitle(segment)} />
      <span className={styles.segmentText}>
        <b>{artwork?.title ?? segmentTitle(segment)}</b>
        <span>
          {artwork?.artist ? `${artwork.artist} · ` : ""}
          {formatTimestamp(segment.start_sec)} – {formatTimestamp(segment.end_sec)}
        </span>
      </span>
    </button>
  );
}

/** Выбранный трек крупно: обложка, исполнитель, альбом, прослушать и решение. */
function TrackNowCard({
  segment,
  playing,
  excluded,
  disabled,
  onPreview,
  onToggle,
}: {
  segment: CopyrightTimelineSegment;
  playing: boolean;
  excluded: boolean;
  disabled: boolean;
  onPreview: () => void;
  onToggle: () => void;
}) {
  const artwork = useTrackArtwork(segment.track_title);
  const title = artwork?.title ?? segmentTitle(segment);
  return (
    <div className={styles.nowCard} key={`${segment.start_sec}-${title}`}>
      <TrackCover url={artwork?.artwork_url} size={112} title={title} />
      <div className={styles.nowText}>
        <span className={cn(styles.badge, segment.is_commercial ? styles.badgeCommercial : styles.badgeMusic)}>
          {segment.is_commercial ? "Точно АП" : "Вероятно АП"}
        </span>
        <h3>{title}</h3>
        {artwork?.artist && <span className={styles.nowMeta}>{artwork.artist}</span>}
        {!segment.track_title && (
          <span className={styles.nowMeta}>Трек не опознан: музыку слышно, но названия нет, поэтому и обложки нет.</span>
        )}
        <span className={styles.nowMeta}>
          {artwork?.album ? `${artwork.album}${artwork.year ? ` · ${artwork.year}` : ""} · ` : ""}в записи{" "}
          {formatTimestamp(segment.start_sec)} – {formatTimestamp(segment.end_sec)}
        </span>
        <div className={styles.nowActions}>
          <button type="button" className={styles.secondaryButton} onClick={onPreview}>
            <RedesignIcon name={playing ? "stop" : "play"} />
            {playing ? "Остановить" : "Прослушать фрагмент"}
          </button>
          <button
            type="button"
            className={excluded ? styles.secondaryButton : styles.primaryButton}
            onClick={onToggle}
            disabled={disabled}
          >
            {excluded ? "Оставить как есть" : "Будет очищено"}
          </button>
        </div>
      </div>
    </div>
  );
}

function isVideoPath(name: string): boolean {
  return /\.(mp4|mkv|webm|avi|mov|m4v|flv|ts)$/i.test(name);
}

function formatClock(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0:00";
  const seconds = Math.floor(value);
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${(seconds % 60).toString().padStart(2, "0")}`;
}

function readSavedMode(): VocalRemoverMode {
  try {
    const saved = JSON.parse(
      localStorage.getItem(SETTINGS_STORAGE_KEY) ?? "{}",
    ) as { mode?: unknown };
    if (
      saved.mode === "studio_htdemucs_ft" ||
      saved.mode === "fast_htdemucs" ||
      saved.mode === "ultra_melband"
    )
      return saved.mode;
  } catch {
    return "fast_htdemucs";
  }
  return "fast_htdemucs";
}

function readSavedWorkflow(): VocalRemoverWorkflow {
  try {
    const saved = JSON.parse(
      localStorage.getItem(SETTINGS_STORAGE_KEY) ?? "{}",
    ) as { workflow?: unknown };
    if (saved.workflow === "anti_copyright" || saved.workflow === "stems")
      return saved.workflow;
  } catch {
    return "stems";
  }
  return "stems";
}

function getFileDetails(
  path: string | null,
): { name: string; parent: string } | null {
  if (!path) return null;
  const parts = path.split(/[\\/]/);
  const name = parts.at(-1) || path;
  const separator = path.includes("\\") ? "\\" : "/";
  return {
    name,
    parent: parts.slice(0, -1).join(separator),
  };
}

function makeTaskId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto)
    return crypto.randomUUID();
  return `${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function resultFromHistory(item: VocalRemoverHistoryItem): VocalRemoverResult {
  return {
    vocals_path: item.vocalsPath,
    instrumental_path: item.instrumentalPath,
    mode: item.mode,
    workflow: item.workflow ?? "stems",
    antiCopyrightPath: item.antiCopyrightPath ?? null,
    musicSegments: item.musicSegments ?? [],
    processedMs: item.processedMs ?? 0,
    elapsed_ms: item.elapsedMs,
  };
}

function historyWorkflowLabel(item: VocalRemoverHistoryItem): string {
  if ((item.workflow ?? "stems") === "anti_copyright") return "Очистка от АП";
  return MODE_COPY[item.mode]?.title ?? item.mode;
}

function formatSegment(segment: VocalRemoverAudioSegment): string {
  return `${formatTimestamp(segment.start_sec)}-${formatTimestamp(segment.end_sec)}`;
}

function formatTimestamp(value: number): string {
  const seconds = Math.max(0, Math.round(value));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  const pad = (part: number) => part.toString().padStart(2, "0");
  return hours > 0
    ? `${hours}:${pad(minutes)}:${pad(rest)}`
    : `${minutes}:${pad(rest)}`;
}

function fileNameFromPath(path: string): string {
  return path.split(/[\\/]/).at(-1) || path;
}

function formatElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0 сек";
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} сек`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minutes} мин ${rest} сек`;
}

function formatDate(value: number): string {
  return new Date(value).toLocaleDateString(undefined, {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function errorToMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return "Не удалось разделить аудио.";
}
