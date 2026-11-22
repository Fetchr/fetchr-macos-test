import type { VpsClipMeta, VpsRecordingMeta } from "@/lib/ipc";

import { recordingTitle, timeOf } from "./archiveModel";
import { channelLabel, fmtDuration, fmtShortDate } from "./format";

export type SearchHitKind = "recording" | "clip" | "marker";

export interface SearchHit {
  id: string;
  kind: SearchHitKind;
  title: string;
  meta: string;
  /** Запись, которую открыть; null — клип без записи в архиве. */
  session: string | null;
  /** Момент для перемотки, секунды сессии; null — просто открыть. */
  at: number | null;
}

export const SEARCH_GROUPS: { kind: SearchHitKind; label: string }[] = [
  { kind: "recording", label: "Записи" },
  { kind: "clip", label: "Клипы" },
  { kind: "marker", label: "Метки" },
];

const LIMIT: Record<SearchHitKind, number> = { recording: 5, clip: 5, marker: 6 };

const matches = (needle: string, ...parts: Array<string | null | undefined>) =>
  parts.some((part) => part?.toLowerCase().includes(needle));

function recordingHits(needle: string, recordings: readonly VpsRecordingMeta[]): SearchHit[] {
  return recordings
    .filter((recording) => matches(needle, recordingTitle(recording), recording.channel))
    .slice(0, LIMIT.recording)
    .map((recording) => ({
      id: `rec-${recording.session}`,
      kind: "recording",
      title: recordingTitle(recording),
      meta: [recording.channel ? channelLabel(recording.channel) : null, fmtShortDate(recording.started_at), timeOf(recording.started_at)]
        .filter(Boolean)
        .join(" · "),
      session: recording.session,
      at: null,
    }));
}

function clipHits(needle: string, clips: readonly VpsClipMeta[], known: ReadonlySet<string>): SearchHit[] {
  return clips
    .filter((clip) => matches(needle, clip.label, clip.note, clip.channel, ...(clip.tags ?? [])))
    .slice(0, LIMIT.clip)
    .map((clip) => {
      const inArchive = clip.session != null && known.has(clip.session);
      return {
        id: `clip-${clip.id}`,
        kind: "clip",
        title: clip.label?.trim() || "Клип без названия",
        meta: [clip.channel ? channelLabel(clip.channel) : null, `${fmtDuration(clip.start)} · ${fmtDuration(clip.duration)}`]
          .filter(Boolean)
          .join(" · "),
        session: inArchive ? clip.session : null,
        at: inArchive ? clip.start : null,
      };
    });
}

function markerHits(needle: string, recordings: readonly VpsRecordingMeta[]): SearchHit[] {
  return recordings
    .flatMap((recording) =>
      recording.markers
        .filter((marker) => matches(needle, marker.label, marker.note))
        .map((marker) => ({
          id: `mark-${recording.session}-${marker.id}`,
          kind: "marker" as const,
          title: marker.label,
          meta: `${fmtDuration(marker.timestamp)} · ${recordingTitle(recording)}`,
          session: recording.session,
          at: marker.timestamp,
        })),
    )
    .slice(0, LIMIT.marker);
}

/** Записи, клипы и метки по подстроке; порядок групп — как в SEARCH_GROUPS. */
export function searchArchive(
  query: string,
  recordings: readonly VpsRecordingMeta[],
  clips: readonly VpsClipMeta[],
): SearchHit[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const known = new Set(recordings.map((recording) => recording.session));
  return [...recordingHits(needle, recordings), ...clipHits(needle, clips, known), ...markerHits(needle, recordings)];
}
