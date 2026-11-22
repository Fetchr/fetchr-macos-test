import { create } from "zustand";

import { onVocalRemoverProgress } from "@/lib/ipc";
import type { CopyrightTimelineSegment, VocalRemoverResult } from "@/types/job";

interface VocalRemoverPageState {
  filePath: string | null;
  processing: boolean;
  taskId: string | null;
  progressPercent: number;
  progressMessage: string;
  result: VocalRemoverResult | null;
  error: string | null;
  cacheBuster: number;
  copyrightSegments: CopyrightTimelineSegment[] | null;
  scanningCopyright: boolean;
  scanTaskId: string | null;
  scanProgressPercent: number;
  scanProgressMessage: string;
  mediaDuration: number | null;
  excludedSegments: Set<number>;
  update: (
    patch: Partial<Omit<VocalRemoverPageState, "update" | "toggleExcluded">>,
  ) => void;
  toggleExcluded: (index: number) => void;
}

export const useVocalRemoverStore = create<VocalRemoverPageState>((set) => ({
  filePath: null,
  processing: false,
  taskId: null,
  progressPercent: 0,
  progressMessage: "Ожидание файла",
  result: null,
  error: null,
  cacheBuster: Date.now(),
  copyrightSegments: null,
  scanningCopyright: false,
  scanTaskId: null,
  scanProgressPercent: 0,
  scanProgressMessage: "",
  mediaDuration: null,
  excludedSegments: new Set<number>(),
  update: (patch) => set(patch),
  toggleExcluded: (index) =>
    set((s) => {
      const next = new Set(s.excludedSegments);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return { excludedSegments: next };
    }),
}));

/**
 * Открыть файл в «Вокал ремувере» с чистого листа: прошлый результат и разметка
 * АП относятся к другому файлу. Пока там идёт обработка, файл не подменяем.
 */
export function sendFileToVocalRemover(filePath: string): boolean {
  const state = useVocalRemoverStore.getState();
  if (state.processing || state.scanningCopyright) return false;
  state.update({
    filePath,
    result: null,
    error: null,
    progressPercent: 0,
    progressMessage: "Ожидание файла",
    copyrightSegments: null,
    mediaDuration: null,
    excludedSegments: new Set<number>(),
    cacheBuster: Date.now(),
  });
  return true;
}

let progressListenerStarted = false;

/** Module-level listener: keeps progress flowing into the store even when the
 * Vocal Remover page is unmounted (user switched to another page). */
export function ensureVocalRemoverProgressListener() {
  if (progressListenerStarted) return;
  progressListenerStarted = true;
  void onVocalRemoverProgress((payload) => {
    const state = useVocalRemoverStore.getState();
    // Events from concurrent/stale tasks (e.g. a scan overlapping a separation)
    // carry a task id; drop everything that does not belong to an active task.
    if (payload.taskId) {
      const matchesScan = state.scanTaskId !== null && payload.taskId === state.scanTaskId;
      const matchesRun =
        state.taskId !== null &&
        (payload.taskId === state.taskId ||
          payload.taskId === `vocal_remover_in_page_${state.taskId}`);
      if (!matchesScan && !matchesRun) return;
    }
    const percent = Math.max(0, Math.min(100, payload.percent));
    if (payload.taskId && payload.taskId === state.scanTaskId) {
      state.update({
        scanProgressPercent: percent,
        scanProgressMessage: payload.message || "ИИ-сканирование",
      });
    } else if (!payload.taskId && state.scanningCopyright) {
      state.update({
        scanProgressPercent: percent,
        scanProgressMessage: payload.message || "ИИ-сканирование",
      });
    } else {
      state.update({
        progressPercent: percent,
        progressMessage: payload.message || "Обработка аудио",
      });
    }
  });
}
