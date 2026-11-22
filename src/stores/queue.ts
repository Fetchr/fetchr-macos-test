import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";

import { ipc, onQueueChanged, onQueuePaused, onQueueProgress } from "@/lib/ipc";
import { playErrorSound, playSuccessSound } from "@/lib/sfx";
import type { Job } from "@/types/job";

import { useBoot } from "./boot";
import { useSettings } from "./settings";

interface QueueState {
  jobs: Job[];
  /** Очередь на паузе: новые задачи не стартуют, идущие доделываются */
  paused: boolean;
  initialized: boolean;
  setJobs: (jobs: Job[]) => void;
  init: () => Promise<() => void>;
}

export const useQueue = create<QueueState>((set, get) => ({
  jobs: [],
  paused: false,
  initialized: false,
  setJobs: (jobs) => set({ jobs }),
  async init() {
    if (get().initialized) return () => {};
    set({ initialized: true });
    try {
      const jobs = await ipc.listJobs();
      set({ jobs });
    } catch {
      // ignore until backend is ready
    }
    const unlistenChanged = await onQueueChanged((jobs) => {
      announceFinished(get().jobs, jobs);
      if (justFinished(get().jobs, jobs)) useBoot.getState().noteJobDone();
      set({ jobs });
    });
    // Прогресс приходит по одной задаче: меняем только её объект, остальные
    // сохраняют идентичность, и мемоизированные строки не перерисовываются.
    const unlistenProgress = await onQueueProgress((update) =>
      set((state) => {
        const index = state.jobs.findIndex((job) => job.id === update.id);
        if (index < 0) return state;
        const jobs = state.jobs.slice();
        jobs[index] = { ...jobs[index], progress: update.progress, live_stats: update.live_stats };
        return { jobs };
      }),
    );
    const unlistenPaused = await onQueuePaused((paused) => set({ paused }));
    return () => {
      unlistenChanged();
      unlistenProgress();
      unlistenPaused();
    };
  },
}));

/** Какая-то задача только что дошла до «готово» (не была такой в прошлом снимке). */
function justFinished(previous: Job[], next: Job[]): boolean {
  const before = new Map(previous.map((job) => [job.id, job.status]));
  return next.some((job) => job.status === "done" && before.has(job.id) && before.get(job.id) !== "done");
}

/** Звук, когда задача только что завершилась; старые задачи при запуске молчат. */
function announceFinished(previous: Job[], next: Job[]) {
  if (!useSettings.getState().soundEffects) return;
  const before = new Map(previous.map((job) => [job.id, job.status]));
  let failed = false;
  let finished = false;
  for (const job of next) {
    const was = before.get(job.id);
    if (was === undefined || was === job.status) continue;
    if (job.status === "error") failed = true;
    else if (job.status === "done") finished = true;
  }
  // Ошибка важнее: если в одной пачке есть и то и другое, звучит она.
  if (failed) playErrorSound();
  else if (finished) playSuccessSound();
}

export function useJobCounts() {
  return useQueue(
    useShallow((s) => {
      const counts = { queued: 0, running: 0, done: 0, error: 0, paused: 0 };
      for (const j of s.jobs) {
        if (j.status === "queued") counts.queued += 1;
        else if (j.status === "running") counts.running += 1;
        else if (j.status === "done") counts.done += 1;
        else if (j.status === "error") counts.error += 1;
        else if (j.status === "paused") counts.paused += 1;
      }
      return counts;
    }),
  );
}
