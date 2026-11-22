/** One "Найти m3u8" run that found playlists, kept so earlier results survive. */
export interface RecoveredGeneration {
  id: string;
  username: string;
  streamId: string;
  /** Local "YYYY-MM-DD HH:mm", as the search fields hold it. */
  startTime: string;
  title: string | null;
  thumbnailUrl: string | null;
  duration: string | null;
  urls: string[];
  /** Epoch ms of the run. */
  foundAt: number;
}

export const MAX_RECOVERED_GENERATIONS = 20;

/** Newest first; a repeat of the same stream and start replaces the old entry. */
export function addGeneration(
  history: RecoveredGeneration[],
  generation: RecoveredGeneration,
): RecoveredGeneration[] {
  const others = history.filter(
    (item) => !(item.streamId === generation.streamId && item.startTime === generation.startTime),
  );
  return [generation, ...others].slice(0, MAX_RECOVERED_GENERATIONS);
}

export function removeGeneration(history: RecoveredGeneration[], id: string): RecoveredGeneration[] {
  return history.filter((item) => item.id !== id);
}

/** Drops malformed entries a stale localStorage value could carry. */
export function sanitizeHistory(value: unknown): RecoveredGeneration[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is RecoveredGeneration =>
      typeof item === "object" &&
      item !== null &&
      typeof item.id === "string" &&
      typeof item.streamId === "string" &&
      Array.isArray(item.urls) &&
      item.urls.every((url: unknown) => typeof url === "string"),
  );
}
