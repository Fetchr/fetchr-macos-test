import { create, type StoreApi } from "zustand";

import { onJobLog, type LogLine } from "@/lib/ipc";

interface LogsState {
  lines: LogLine[];
  /** Последняя строка каждой задачи: очереди нужна только она, а не все 10k строк */
  lastLineByJob: Record<string, string>;
  initialized: boolean;
  clear: (id?: string) => void;
  init: () => Promise<() => void>;
}

const MAX_LINES = 10000;
const MAX_BATCH = 250;

let pending: LogLine[] = [];
let flushHandle: number | null = null;

type SetLogsState = StoreApi<LogsState>["setState"];

function scheduleFlush(set: SetLogsState) {
  if (flushHandle !== null) return;
  flushHandle = window.setTimeout(() => {
    flushHandle = null;
    const batch = pending.splice(0, MAX_BATCH);
    if (pending.length > 0) {
      scheduleFlush(set);
    }
    if (batch.length === 0) return;
    set((s) => {
      const next = s.lines.concat(batch);
      if (next.length > MAX_LINES) next.splice(0, next.length - MAX_LINES);
      const lastLineByJob = { ...s.lastLineByJob };
      for (const line of batch) lastLineByJob[line.id] = line.line;
      return { lines: next, lastLineByJob };
    });
  }, 50);
}

export const useLogs = create<LogsState>((set, get) => ({
  lines: [],
  lastLineByJob: {},
  initialized: false,
  clear: (id) =>
    set((s) => {
      if (!id) return { lines: [], lastLineByJob: {} };
      const lastLineByJob = { ...s.lastLineByJob };
      delete lastLineByJob[id];
      return { lines: s.lines.filter((l) => l.id !== id), lastLineByJob };
    }),
  async init() {
    if (get().initialized) return () => {};
    set({ initialized: true });
    const unlisten = await onJobLog((line) => {
      pending.push(line);
      if (pending.length > MAX_LINES) {
        pending.splice(0, pending.length - MAX_LINES);
      }
      scheduleFlush(set);
    });
    return () => {
      if (flushHandle !== null) {
        window.clearTimeout(flushHandle);
        flushHandle = null;
      }
      pending = [];
      unlisten();
    };
  },
}));
