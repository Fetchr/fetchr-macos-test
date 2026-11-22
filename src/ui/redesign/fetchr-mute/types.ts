import type { MuteSpan } from "@/types/job";
import type { useFetchrMuteStore } from "@/stores/fetchrMute";

/** Снимок стора «Удалить маты» вместе с экшенами — то, что отдаёт useFetchrMuteStore(). */
export type FetchrMuteStore = ReturnType<typeof useFetchrMuteStore.getState>;

export interface FileDetails {
  name: string;
  parent: string;
  stem: string;
  ext: string;
}

export interface SpanGroup {
  key: string;
  label: string;
  isManual: boolean;
  items: MuteSpan[];
}

export interface AnalysisStep {
  label: string;
  at: number;
  done: boolean;
  active: boolean;
}

export type HistoryMissing = Record<string, { source: boolean; output: boolean }>;
