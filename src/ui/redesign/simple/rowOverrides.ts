import { parseTimeInput } from "@/lib/timecode";
import type { QueueOptions } from "@/services/streams/streamDownload";
import type { SearchRow } from "@/services/streams/streamSearch";

import type { DownloadDraft } from "./downloadOptions";

/** Свои настройки записи: только поля, которые отличаются от общих. */
export type RowOverride = Partial<Omit<DownloadDraft, "directory">>;
export type RowOverrides = Readonly<Record<string, RowOverride>>;

/** «1:02:03», «62:03», «01h02m03s» или «3723» в секунды; пусто или мусор даёт null. */
export function parseClock(value: string | undefined): number | null {
  return parseTimeInput(value);
}

export function formatClock(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export function formatTotal(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return h > 0 ? `${h} ч ${m} мин` : `${m} мин`;
}

/** Общие настройки с наложенными своими настройками записи. */
export function effectiveDraft(common: DownloadDraft, row: SearchRow, own: RowOverride | undefined): DownloadDraft {
  return { ...common, name: row.title, start: "", end: "", extraRanges: [], ...own };
}

/** Фрагмент записи в секундах; без длины записи только то, что введено. */
export function clipWindow(row: SearchRow, own: RowOverride | undefined): { from: number; to: number } | null {
  const length = row.durationSeconds;
  if (!length) return null;
  const from = Math.min(parseClock(own?.start) ?? 0, length);
  const to = Math.min(parseClock(own?.end) ?? length, length);
  return { from, to: Math.max(from, to) };
}

export function clipSeconds(row: SearchRow, own: RowOverride | undefined): number {
  const length = row.durationSeconds;
  const window = clipWindow(row, own);
  const mainSec = window ? window.to - window.from : (length ?? 0);
  const extras = own?.extraRanges?.filter((r) => r.start.trim() || r.end.trim()) ?? [];
  if (extras.length === 0 || !length) return mainSec;
  const extraSec = extras.reduce((sum, r) => {
    const from = Math.min(parseClock(r.start) ?? 0, length);
    const to = Math.min(parseClock(r.end) ?? length, length);
    return sum + Math.max(0, to - from);
  }, 0);
  return mainSec + extraSec;
}

const SWITCH_LABEL: Record<"withChat" | "unmute" | "muteProfanity" | "blurSponsors", string> = {
  withChat: "чат",
  unmute: "вернуть звук",
  muteProfanity: "убрать маты",
  blurSponsors: "блюр",
};

/** Короткая сводка своих настроек для строки списка: «0:41:00–4:00:00 · 720p60 · без чата». */
export function overrideSummary(common: DownloadDraft, row: SearchRow, own: RowOverride): string {
  const parts: string[] = [];
  const window = clipWindow(row, own);
  if (window && (window.from > 0 || window.to < (row.durationSeconds ?? 0))) {
    parts.push(`${formatClock(window.from)}–${formatClock(window.to)}`);
  } else if (own.start || own.end) {
    parts.push(`${own.start || "начало"}–${own.end || "конец"}`);
  }
  const extraCount = own.extraRanges?.filter((r) => r.start.trim() || r.end.trim()).length ?? 0;
  if (extraCount > 0) {
    parts.push(`+${extraCount} фрагм.`);
  }
  if (own.audioOnly !== undefined && own.audioOnly !== common.audioOnly) parts.push(own.audioOnly ? "аудио" : "видео");
  else if (own.quality !== undefined && own.quality?.id !== common.quality?.id) parts.push(own.quality?.label ?? "лучшее");
  for (const key of Object.keys(SWITCH_LABEL) as Array<keyof typeof SWITCH_LABEL>) {
    if (own[key] !== undefined && own[key] !== common[key]) parts.push(own[key] ? SWITCH_LABEL[key] : `без: ${SWITCH_LABEL[key]}`);
  }
  if (own.name !== undefined && own.name !== row.title) parts.push("своё имя");
  return parts.join(" · ") || "как у всех";
}

/** Свои настройки строк в виде, который понимает очередь. */
export function toPerRow(rows: SearchRow[], overrides: RowOverrides): NonNullable<QueueOptions["perRow"]> {
  const result: NonNullable<QueueOptions["perRow"]> = {};
  for (const row of rows) {
    const own = overrides[row.id];
    if (!own) continue;
    const { withChat, ...rest } = own;
    result[row.id] = withChat === undefined ? rest : { ...rest, withChat: withChat && row.chatAvailable };
  }
  return result;
}
