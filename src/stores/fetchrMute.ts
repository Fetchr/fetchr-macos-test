import { create } from "zustand";
import i18n from "@/i18n";
import { ipc, onFetchrMuteProgress } from "@/lib/ipc";
import type {
  WordHit,
  MuteSpan,
  AudioTrackInfo,
  FetchrMuteSettings,
  MuteOutputTarget,
} from "@/types/job";
import {
  dedupeSpans,
  editStateFromSettings,
  hasSpan,
  type MuteEditState,
} from "@/ui/redesign/fetchr-mute/editModel";
import { friendlyMuteError, rawErrorText } from "@/ui/redesign/fetchr-mute/muteErrors";
import { useFetchrMuteEditsStore } from "./fetchrMuteEdits";

/** Итог пересборки цензуры (кнопка «Применить», «Сохранить копию»). */
export type RecensorOutcome = "applied" | "failed" | "cancelled" | "stale" | "busy" | "skipped";

/** Кнопка действия в уведомлении («Проанализировать заново», «Показать в папке»). */
export interface NoticeAction {
  label: string;
  run: () => void;
}

interface ReportErrorOptions {
  /** Понятный текст вместо автоматического по сырой ошибке. */
  message?: string;
  /** Что повторить по кнопке «Повторить». */
  retry?: () => void;
}

const NO_ERROR = { error: null, errorDetails: null, errorRetry: null } as const;

interface FetchrMuteState {
  // File & processing state
  filePath: string;
  taskId: string | null;
  processing: boolean;
  progressPercent: number;
  progressMessage: string;
  error: string | null;
  /** Исходный текст ошибки — раскрывается по «Подробнее». */
  errorDetails: string | null;
  /** Повтор действия, которое упало; null — повторять нечего. */
  errorRetry: (() => void) | null;
  /** Нейтральное информационное сообщение (отмена, уведомления) — не ошибка. */
  notice: string | null;
  noticeAction: NoticeAction | null;
  /** Идёт recensor: применение накопленных правок одним рендером. */
  recensoring: boolean;
  /** Прогресс рендера recensor'а, 0..100. */
  recensorPercent: number;

  // Scan/Mute preview animation state
  isMutingAnimation: boolean;
  currentScanTime: number;
  scanProgress: number;

  // Result state
  words: WordHit[] | null;
  spans: MuteSpan[] | null;
  // Manually added mute moments (by timecode) merged on top of detected spans.
  manualSpans: MuteSpan[];
  // Точечно удалённые пользователем спаны (панель «Правки мута»): вырезаются
  // из авто-спанов по перекрытию при каждой пересборке цензуры.
  excludedSpans: MuteSpan[];
  outputPath: string | null;
  pendingOutputPath: string | null;
  /** «Сохранить как»: папка и имя итогового файла. null — рядом с исходником. */
  outputDir: string | null;
  outputName: string;
  /** Аудиодорожки исходника и выбранная (индекс среди дорожек). */
  audioTracks: AudioTrackInfo[];
  audioTrackIndex: number;
  cacheBuster: number;
  mediaError: string | null;
  processingElapsed: number;
  finalProcessingTime: number | null;

  // Is page currently mounted/visible
  isPageActive: boolean;
  initialized: boolean;

  // Actions
  setFilePath: (path: string) => void;
  setTaskId: (id: string | null) => void;
  setProcessing: (val: boolean) => void;
  setProgressPercent: (pct: number) => void;
  setProgressMessage: (msg: string) => void;
  setIsMutingAnimation: (val: boolean) => void;
  setCurrentScanTime: (time: number) => void;
  setScanProgress: (progress: number) => void;
  setWords: (words: WordHit[] | null) => void;
  setSpans: (spans: MuteSpan[] | null) => void;
  setOutputPath: (path: string | null) => void;
  setPendingOutputPath: (path: string | null) => void;
  setOutputDir: (dir: string | null) => void;
  setOutputName: (name: string) => void;
  setAudioTracks: (tracks: AudioTrackInfo[]) => void;
  setAudioTrackIndex: (index: number) => void;
  loadAudioTracks: (binariesDir: string | null) => Promise<void>;
  setCacheBuster: (val: number) => void;
  setMediaError: (err: string | null) => void;
  setProcessingElapsed: (secs: number) => void;
  setFinalProcessingTime: (secs: number | null) => void;
  setError: (err: string | null) => void;
  /** Ошибка с понятным текстом, деталями и, если можно, повтором. */
  reportError: (err: unknown, options?: ReportErrorOptions) => void;
  setNotice: (msg: string | null, action?: NoticeAction) => void;
  cancelRecensor: () => void;

  /** false — такой фрагмент уже есть (повторный клик), состояние не менялось. */
  addManualSpan: (start: number, end: number) => boolean;
  setManualSpans: (spans: MuteSpan[]) => void;
  removeManualSpan: (index: number) => void;
  clearManualSpans: () => void;
  /** false — такое исключение уже есть, состояние не менялось. */
  addExcludedSpan: (span: MuteSpan) => boolean;
  setExcludedSpans: (spans: MuteSpan[]) => void;
  clearExcludedSpans: () => void;

  init: () => Promise<() => void>;
  clearResults: () => void;
  cancelProcessing: () => void;
  startProcessing: (
    binariesDir: string | null,
    settings: any,
    fileDetails: any,
    forceReanalysis?: boolean
  ) => Promise<any>;
  /**
   * Один рендер с полным набором правок `edit` и настройками `settings`.
   * Успех делает `edit` применённым набором; при ошибке правки остаются
   * неприменёнными. Параллельный вызов в очередь не ставится — "busy".
   */
  triggerRecensor: (
    binariesDir: string | null,
    settings: FetchrMuteSettings,
    edit: MuteEditState,
  ) => Promise<RecensorOutcome>;
}

function outputTargetFrom(state: {
  outputDir: string | null;
  outputName: string;
}): MuteOutputTarget | null {
  const directory = state.outputDir?.trim() || "";
  if (!directory) return null;
  return { directory, file_name: state.outputName.trim() || null };
}

let stopwatchInterval: number | null = null;
let recensorBusy = false;
let recensorTaskId: string | null = null;
let recensorCancelRequested = false;
/** Отмена ради нового анализа: ни ошибки, ни уведомления пользователю. */
let recensorCancelSilent = false;

/** Результат до «Заново»: отмена повторного анализа возвращает его, а не пустоту. */
interface ResultBeforeRerun {
  filePath: string;
  words: WordHit[];
  spans: MuteSpan[] | null;
  outputPath: string;
  finalProcessingTime: number | null;
  edits: Pick<ReturnType<typeof useFetchrMuteEditsStore.getState>, "applied" | "past" | "future">;
}
let resultBeforeRerun: ResultBeforeRerun | null = null;

function cancelActiveRecensor(silent: boolean) {
  if (!recensorBusy) return;
  recensorCancelRequested = true;
  recensorCancelSilent = silent;
  const id = recensorTaskId;
  if (id) {
    void ipc.cancelMuteInPage(id).catch((err) => {
      console.error("Failed to cancel FetchrMute recensor:", err);
    });
  }
}

/** Событие прогресса относится к текущей задаче? Rust шлёт taskId вида `in_page_<uuid>`. */
function isCurrentProgressTask(payloadTaskId: string | undefined, current: string | null): boolean {
  if (!current) return false;
  // Стартовое событие этапа приходит без taskId — его принимаем, пока задача идёт.
  if (!payloadTaskId) return true;
  return payloadTaskId === current || payloadTaskId.endsWith(current);
}

type MuteAnalysisResult = Awaited<ReturnType<typeof ipc.runMuteInPage>>;

/**
 * run_mute_in_page не принимает правки, поэтому сохранённые ручные фрагменты
 * и исключения применяем пересборкой сразу после анализа — тем же taskId,
 * чтобы «Отменить» обработку прерывал и этот рендер.
 */
async function applyEditsAfterAnalysis(
  taskId: string,
  filePath: string,
  binariesDir: string | null,
  settings: any,
  analysis: MuteAnalysisResult,
): Promise<MuteAnalysisResult> {
  const { manualSpans, excludedSpans } = useFetchrMuteStore.getState();
  if (manualSpans.length === 0 && excludedSpans.length === 0) return analysis;
  useFetchrMuteStore.setState({
    progressMessage: i18n.t("fetchr_mute.progress_applying_edits"),
  });
  try {
    const rendered = await ipc.recensorInPage(
      taskId,
      filePath,
      binariesDir,
      analysis.words,
      settings,
      manualSpans,
      excludedSpans,
      outputTargetFrom(useFetchrMuteStore.getState()),
    );
    return { ...analysis, output_path: rendered.output_path, spans: rendered.spans };
  } catch (err) {
    // Анализ готов — отдаём его без правок, а не теряем целиком.
    if (useFetchrMuteStore.getState().taskId === taskId) {
      useFetchrMuteStore.getState().reportError(err, {
        message: i18n.t("fetchr_mute.error_apply_edits"),
      });
    }
    return analysis;
  }
}

export const useFetchrMuteStore = create<FetchrMuteState>((set, get) => ({
  filePath: "",
  taskId: null,
  processing: false,
  progressPercent: 0,
  progressMessage: "",
  ...NO_ERROR,
  notice: null,
  noticeAction: null,
  recensoring: false,
  recensorPercent: 0,

  isMutingAnimation: false,
  currentScanTime: 0,
  scanProgress: 0,

  words: null,
  spans: null,
  manualSpans: [],
  excludedSpans: [],
  outputPath: null,
  pendingOutputPath: null,
  outputDir: null,
  outputName: "",
  audioTracks: [],
  audioTrackIndex: 0,
  cacheBuster: Date.now(),
  mediaError: null,
  processingElapsed: 0,
  finalProcessingTime: null,

  isPageActive: false,
  initialized: false,

  setFilePath: (filePath) => set({ filePath }),
  setTaskId: (taskId) => set({ taskId }),
  setProcessing: (processing) => set({ processing }),
  setProgressPercent: (progressPercent) => set({ progressPercent }),
  setProgressMessage: (progressMessage) => set({ progressMessage }),
  setIsMutingAnimation: (isMutingAnimation) => set({ isMutingAnimation }),
  setCurrentScanTime: (currentScanTime) => set({ currentScanTime }),
  setScanProgress: (scanProgress) => set({ scanProgress }),
  setWords: (words) => set({ words }),
  setSpans: (spans) => set({ spans }),
  setOutputPath: (outputPath) => set({ outputPath }),
  setPendingOutputPath: (pendingOutputPath) => set({ pendingOutputPath }),
  setOutputDir: (outputDir) => set({ outputDir }),
  setOutputName: (outputName) => set({ outputName }),
  setAudioTracks: (audioTracks) => set({ audioTracks }),
  setAudioTrackIndex: (audioTrackIndex) => set({ audioTrackIndex }),

  async loadAudioTracks(binariesDir) {
    const { filePath } = get();
    if (!filePath) {
      set({ audioTracks: [], audioTrackIndex: 0 });
      return;
    }
    try {
      const tracks = await ipc.probeMuteAudioTracks(filePath, binariesDir);
      // Файл мог смениться, пока шёл ffprobe.
      if (get().filePath !== filePath) return;
      const index = get().audioTrackIndex;
      set({
        audioTracks: tracks,
        audioTrackIndex: tracks.some((track) => track.index === index) ? index : 0,
      });
    } catch (err) {
      // Отсутствие ffprobe не должно ломать страницу: работает первая дорожка.
      console.error("Failed to probe audio tracks:", err);
      set({ audioTracks: [], audioTrackIndex: 0 });
    }
  },
  setCacheBuster: (cacheBuster) => set({ cacheBuster }),
  setMediaError: (mediaError) => set({ mediaError }),
  setProcessingElapsed: (processingElapsed) => set({ processingElapsed }),
  setFinalProcessingTime: (finalProcessingTime) => set({ finalProcessingTime }),
  setError: (error) => set({ ...NO_ERROR, error }),
  reportError: (err, options = {}) => {
    const details = rawErrorText(err);
    set({
      error: options.message ?? friendlyMuteError(details),
      errorDetails: details || null,
      errorRetry: options.retry ?? null,
    });
  },
  setNotice: (notice, action) => set({ notice, noticeAction: notice ? action ?? null : null }),

  cancelRecensor() {
    cancelActiveRecensor(false);
  },

  addManualSpan: (start, end) => {
    if (!(end > start)) return false;
    const span: MuteSpan = { word: "manual", start, end };
    if (hasSpan(get().manualSpans, span)) return false;
    set((state) => ({
      manualSpans: [...state.manualSpans, span].sort((a, b) => a.start - b.start),
    }));
    return true;
  },
  setManualSpans: (manualSpans) => set({ manualSpans: dedupeSpans(manualSpans) }),
  removeManualSpan: (index) =>
    set((state) => ({ manualSpans: state.manualSpans.filter((_, i) => i !== index) })),
  clearManualSpans: () => set({ manualSpans: [] }),
  addExcludedSpan: (span) => {
    if (hasSpan(get().excludedSpans, span)) return false;
    set((state) => ({ excludedSpans: [...state.excludedSpans, span] }));
    return true;
  },
  setExcludedSpans: (excludedSpans) => set({ excludedSpans: dedupeSpans(excludedSpans) }),
  clearExcludedSpans: () => set({ excludedSpans: [] }),

  async init() {
    if (get().initialized) return () => {};
    set({ initialized: true });

    const unlisten = await onFetchrMuteProgress((payload) => {
      // Рендер «Применить» идёт своей задачей — его прогресс отдельно.
      if (recensorTaskId && payload.taskId?.endsWith(recensorTaskId)) {
        set({ recensorPercent: payload.percent });
        return;
      }
      // После отмены и перезапуска старая задача ещё шлёт прогресс —
      // без фильтра проценты прыгают между двумя задачами.
      if (!isCurrentProgressTask(payload.taskId, get().taskId)) return;
      set({
        progressPercent: payload.percent,
        progressMessage: payload.message,
      });
    });

    return unlisten;
  },

  clearResults() {
    useFetchrMuteEditsStore.getState().reset();
    set({
      words: null,
      spans: null,
      manualSpans: [],
      excludedSpans: [],
      outputPath: null,
      pendingOutputPath: null,
      processingElapsed: 0,
      finalProcessingTime: null,
      mediaError: null,
      isMutingAnimation: false,
      scanProgress: 0,
      currentScanTime: 0,
      notice: null,
      noticeAction: null,
    });
  },

  cancelProcessing() {
    const { taskId } = get();
    if (taskId) {
      void ipc.cancelMuteInPage(taskId).catch((err) => {
        console.error("Failed to send FetchrMute cancellation:", err);
      });
    }
    if (stopwatchInterval) {
      clearInterval(stopwatchInterval);
      stopwatchInterval = null;
    }
    set({
      processing: false,
      isMutingAnimation: false,
      scanProgress: 0,
      currentScanTime: 0,
      taskId: null,
      pendingOutputPath: null,
      processingElapsed: 0,
      finalProcessingTime: null,
      // Отмена — штатное действие пользователя, а не сбой: показываем
      // нейтральное уведомление вместо красного блока ошибки.
      ...NO_ERROR,
      notice: i18n.t("fetchr_mute.notice_processing_cancelled"),
      noticeAction: null,
    });
    const previous = resultBeforeRerun;
    resultBeforeRerun = null;
    if (previous && previous.filePath === get().filePath) {
      set({
        words: previous.words,
        spans: previous.spans,
        outputPath: previous.outputPath,
        pendingOutputPath: previous.outputPath,
        finalProcessingTime: previous.finalProcessingTime,
        cacheBuster: Date.now(),
        notice: i18n.t("fetchr_mute.notice_rerun_cancelled"),
      });
      useFetchrMuteEditsStore.setState(previous.edits);
    }
  },

  async startProcessing(binariesDir, settings, fileDetails, forceReanalysis = false) {
    const { filePath } = get();
    if (!filePath || !fileDetails) return;

    // run_mute_in_page отменяет все in-page задачи, включая идущий recensor.
    // Гасим его сами и молча, иначе вылезает красная ошибка обновления цензуры.
    cancelActiveRecensor(true);

    const previousTaskId = get().taskId;
    if (previousTaskId) {
      await ipc.cancelMuteInPage(previousTaskId).catch((err) => {
        console.error("Failed to cancel previous FetchrMute task:", err);
      });
    }

    const nextTaskId = crypto.randomUUID();
    // Правки (ручные фрагменты и исключения) переживают перезапуск: их
    // применяем к свежему результату после анализа. Сбросить их — решение
    // вызывающего (например, «Заново» со сбросом правок).
    const { manualSpans, excludedSpans, words: prevWords, outputPath: prevOutput } = get();
    const prevEdits = useFetchrMuteEditsStore.getState();
    resultBeforeRerun =
      forceReanalysis && prevWords && prevOutput
        ? {
            filePath,
            words: prevWords,
            spans: get().spans,
            outputPath: prevOutput,
            finalProcessingTime: get().finalProcessingTime,
            edits: { applied: prevEdits.applied, past: prevEdits.past, future: prevEdits.future },
          }
        : null;
    get().clearResults();

    set({
      manualSpans,
      excludedSpans,
      taskId: nextTaskId,
      processing: true,
      ...NO_ERROR,
      notice: null,
      noticeAction: null,
      progressPercent: 0,
      progressMessage: forceReanalysis
        ? i18n.t("fetchr_mute.progress_reanalysis")
        : i18n.t("fetchr_mute.progress_starting"),
    });

    // Start stopwatch
    if (stopwatchInterval) clearInterval(stopwatchInterval);
    const start = Date.now();
    set({ processingElapsed: 0 });
    stopwatchInterval = window.setInterval(() => {
      set({ processingElapsed: Math.round((Date.now() - start) / 1000) });
    }, 1000);

    const processStart = Date.now();
    try {
      const analysis = await ipc.runMuteInPage(
        nextTaskId,
        filePath,
        binariesDir,
        settings,
        forceReanalysis,
        outputTargetFrom(get())
      );

      // Cancellation or a newer task makes this response stale.
      if (get().taskId !== nextTaskId) return analysis;
      resultBeforeRerun = null;

      const result = await applyEditsAfterAnalysis(nextTaskId, filePath, binariesDir, settings, analysis);
      if (get().taskId !== nextTaskId) return result;
      // Правки не легли (ошибка рендера) — файл собран без них, и они
      // остаются неприменёнными.
      const editsApplied = result !== analysis;
      useFetchrMuteEditsStore
        .getState()
        .setApplied(
          editStateFromSettings(
            settings,
            editsApplied ? manualSpans : [],
            editsApplied ? excludedSpans : [],
          ),
        );

      // Stop stopwatch
      if (stopwatchInterval) {
        clearInterval(stopwatchInterval);
        stopwatchInterval = null;
      }

      const elapsed = Math.round((Date.now() - processStart) / 1000);

      const { isPageActive } = get();

      if (isPageActive) {
        set({
          finalProcessingTime: elapsed,
          words: result.words,
          spans: result.spans,
          pendingOutputPath: result.output_path,
          cacheBuster: Date.now(),
          isMutingAnimation: true,
        });
      } else {
        set({
          finalProcessingTime: elapsed,
          words: result.words,
          spans: result.spans,
          outputPath: result.output_path,
          pendingOutputPath: result.output_path,
          cacheBuster: Date.now(),
          processing: false,
          isMutingAnimation: false,
        });
      }

      return result;
    } catch (err) {
      if (get().taskId === nextTaskId) {
        resultBeforeRerun = null;
        if (stopwatchInterval) {
          clearInterval(stopwatchInterval);
          stopwatchInterval = null;
        }
        set({ processing: false, taskId: null });
        get().reportError(err, {
          retry: () => {
            get()
              .startProcessing(binariesDir, settings, fileDetails, forceReanalysis)
              .catch(() => {
                /* ошибка показана стором */
              });
          },
        });
      }
      throw err;
    } finally {
      if (get().taskId === nextTaskId) set({ taskId: null });
    }
  },

  async triggerRecensor(binariesDir, settings, edit) {
    const startedFor = get().filePath;
    const words = get().words;
    if (!startedFor || !words) return "skipped";
    // Один рендер за раз: конкурирующие ffmpeg-рендеры гоняются за имя
    // выходного файла, а поздний ответ перетирает свежие спаны.
    if (recensorBusy) return "busy";
    recensorBusy = true;
    recensorCancelRequested = false;
    recensorCancelSilent = false;
    const taskId = crypto.randomUUID();
    recensorTaskId = taskId;
    set({ ...NO_ERROR, recensoring: true, recensorPercent: 0 });
    try {
      const result = await ipc.recensorInPage(
        taskId,
        startedFor,
        binariesDir,
        words,
        settings,
        edit.manualSpans,
        edit.excludedSpans,
        outputTargetFrom(get()),
      );
      if (recensorCancelRequested) return "cancelled";
      // Файл сменили или запустили новый анализ — результат неактуален.
      if (get().filePath !== startedFor || get().words !== words) return "stale";
      set({
        spans: result.spans,
        outputPath: result.output_path,
        cacheBuster: Date.now(),
        mediaError: null,
        ...NO_ERROR,
      });
      useFetchrMuteEditsStore.getState().setApplied(edit);
      return "applied";
    } catch (err) {
      if (recensorCancelRequested) {
        // Штатная отмена recensor'а — не ошибка. Отмена ради нового
        // анализа — вовсе без сообщений.
        if (!recensorCancelSilent) {
          get().setNotice(i18n.t("fetchr_mute.notice_recensor_cancelled"));
        }
        return "cancelled";
      }
      get().reportError(err, {
        message: i18n.t("fetchr_mute.error_recensor"),
        retry: () => void get().triggerRecensor(binariesDir, settings, edit),
      });
      return "failed";
    } finally {
      recensorBusy = false;
      if (recensorTaskId === taskId) recensorTaskId = null;
      set({ recensoring: false, recensorPercent: 0 });
    }
  },
}));
