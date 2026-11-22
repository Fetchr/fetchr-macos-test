import { create } from "zustand";
import { persist } from "zustand/middleware";

export interface RecentLink {
  query: string;
  platform: string;
  /** Короткая подпись: канал или название записи. */
  label: string;
  typeLabel: string;
  at: number;
}

export const RECENT_LIMIT = 6;

interface DownloadHistoryState {
  recent: RecentLink[];
  remember: (entry: Omit<RecentLink, "at">) => void;
  forget: (query: string) => void;
  clear: () => void;
}

export function withRecent(list: readonly RecentLink[], entry: RecentLink, limit = RECENT_LIMIT): RecentLink[] {
  const key = entry.query.trim().toLowerCase();
  return [entry, ...list.filter((item) => item.query.trim().toLowerCase() !== key)].slice(0, limit);
}

export const useDownloadHistory = create<DownloadHistoryState>()(
  persist(
    (set) => ({
      recent: [],
      remember: (entry) => set((state) => ({ recent: withRecent(state.recent, { ...entry, at: Date.now() }) })),
      forget: (query) => set((state) => ({ recent: state.recent.filter((item) => item.query !== query) })),
      clear: () => set({ recent: [] }),
    }),
    { name: "fetchr-download-history", version: 1 },
  ),
);
