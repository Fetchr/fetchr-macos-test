export type StreamSourceId = "twitch" | "twitchtracker" | "sullygnome";

export type StreamSourceStage = "waiting" | "started" | "cloudflare" | "done" | "failed" | "skipped";

export interface StreamSourceState {
  id: StreamSourceId;
  stage: StreamSourceStage;
  detail: string | null;
}

/** Payload of the backend `m3u8-source-progress` event. */
export interface SourceProgressEvent {
  source: string;
  stage: "started" | "cloudflare" | "done" | "failed";
  detail: string | null;
}

export const SOURCE_PROGRESS_EVENT = "m3u8-source-progress";

export const STREAM_SOURCE_LABELS: Record<StreamSourceId, { name: string; hint: string }> = {
  twitch: { name: "Twitch", hint: "публичные VOD" },
  twitchtracker: { name: "TwitchTracker", hint: "история стримов" },
  sullygnome: { name: "SullyGnome", hint: "резерв, если TwitchTracker закрыт" },
};

const FINISHED: ReadonlySet<StreamSourceStage> = new Set(["done", "failed", "skipped"]);

/** Search asks Twitch and TwitchTracker at once; pagination only the tracker. */
export function startSources(withTwitch: boolean): StreamSourceState[] {
  const ids: StreamSourceId[] = withTwitch
    ? ["twitch", "twitchtracker", "sullygnome"]
    : ["twitchtracker", "sullygnome"];
  return ids.map((id) => ({
    id,
    stage: id === "sullygnome" ? "waiting" : "started",
    detail: null,
  }));
}

export function applySourceStage(
  sources: StreamSourceState[],
  id: string,
  stage: StreamSourceStage,
  detail: string | null = null,
): StreamSourceState[] {
  return sources.map((source) => (source.id === id ? { ...source, stage, detail } : source));
}

/** The fallback that was never needed is skipped, not stuck "waiting". */
export function settleSources(sources: StreamSourceState[]): StreamSourceState[] {
  return sources.map((source) =>
    FINISHED.has(source.stage) ? source : { ...source, stage: "skipped" as const },
  );
}

export function sourcesProgress(sources: StreamSourceState[]): number {
  if (sources.length === 0) return 0;
  const finished = sources.filter((source) => FINISHED.has(source.stage)).length;
  return finished / sources.length;
}
