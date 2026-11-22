import { useEffect, useRef, useState } from "react";

import { useQueue } from "@/stores/queue";
import type { Job } from "@/types/job";

const SAMPLES = 60;

export interface SpeedHistory {
  /** Байт/с по каждой задаче, последние SAMPLES секунд. */
  byJob: Record<string, number[]>;
  total: number[];
}

export function jobSpeedBps(job: Job): number {
  return job.status === "running" ? job.progress.speed_bps ?? 0 : 0;
}

/** Раз в секунду снимает скорость задач: из этого рисуются графики панели. */
export function useSpeedHistory(active: boolean): SpeedHistory {
  const history = useRef<SpeedHistory>({ byJob: {}, total: [] });
  const [snapshot, setSnapshot] = useState<SpeedHistory>(history.current);

  useEffect(() => {
    if (!active) return;
    const sample = () => {
      const jobs = useQueue.getState().jobs.filter((job) => job.status === "running");
      const byJob: Record<string, number[]> = {};
      let total = 0;
      for (const job of jobs) {
        const speed = jobSpeedBps(job);
        total += speed;
        byJob[job.id] = [...(history.current.byJob[job.id] ?? []), speed].slice(-SAMPLES);
      }
      history.current = { byJob, total: [...history.current.total, total].slice(-SAMPLES) };
      setSnapshot(history.current);
    };
    sample();
    const timer = window.setInterval(sample, 1000);
    return () => window.clearInterval(timer);
  }, [active]);

  return snapshot;
}
