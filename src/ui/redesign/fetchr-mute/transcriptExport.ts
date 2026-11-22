import type { TFunction } from "i18next";

import type { MuteSpan, WordHit } from "@/types/job";

/** Пауза между словами, с которой начинаем новую строку транскрипции. */
const TRANSCRIPT_LINE_GAP_S = 1.5;
/** Максимум слов в одной строке — длинные фразы без пауз всё равно режем. */
const TRANSCRIPT_LINE_MAX_WORDS = 18;

export interface TranscriptExportMeta {
  /** Имя исходного файла (для заголовка и имени по умолчанию). */
  sourceName: string;
  /** Дата экспорта; в тестах передаётся фиксированной. */
  date?: Date;
  /** Переводчик для заголовка файла. */
  t: TFunction;
  /** Локаль для даты экспорта (например, "ru" или "en"). */
  locale: string;
}

function pad2(value: number): string {
  return value.toString().padStart(2, "0");
}

/** [mm:ss] для коротких записей, [hh:mm:ss] от часа и длиннее. */
export function formatTranscriptTimestamp(secs: number): string {
  const total = Math.max(0, Math.floor(secs));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return hours > 0
    ? `[${pad2(hours)}:${pad2(minutes)}:${pad2(seconds)}]`
    : `[${pad2(minutes)}:${pad2(seconds)}]`;
}

function isWordMuted(word: WordHit, spans: MuteSpan[]): boolean {
  return spans.some((s) => word.start < s.end - 0.01 && word.end > s.start + 0.01);
}

/** Собирает читабельную транскрипцию: строки по паузам, заглушенные слова — **так**. */
export function buildTranscriptText(
  words: WordHit[],
  spans: MuteSpan[],
  meta: TranscriptExportMeta,
): string {
  const sorted = [...words].sort((a, b) => a.start - b.start);
  const mutedCount = sorted.filter((w) => isWordMuted(w, spans)).length;

  const lines: string[] = [];
  let lineStart = 0;
  let lineWords: string[] = [];
  let previousEnd = 0;

  const flush = () => {
    if (lineWords.length === 0) return;
    lines.push(`${formatTranscriptTimestamp(lineStart)} ${lineWords.join(" ")}`);
    lineWords = [];
  };

  for (const word of sorted) {
    const raw = word.raw.trim();
    if (!raw) continue;
    const token = isWordMuted(word, spans) ? `**${raw}**` : raw;
    const gap = lineWords.length > 0 ? word.start - previousEnd : 0;
    if (
      lineWords.length > 0 &&
      (gap > TRANSCRIPT_LINE_GAP_S || lineWords.length >= TRANSCRIPT_LINE_MAX_WORDS)
    ) {
      flush();
    }
    if (lineWords.length === 0) lineStart = word.start;
    lineWords.push(token);
    previousEnd = word.end;
  }
  flush();

  const date = meta.date ?? new Date();
  const { t } = meta;
  const header = [
    t("fetchr_mute.export_header_title", { name: meta.sourceName }),
    t("fetchr_mute.export_header_date", { date: date.toLocaleString(meta.locale) }),
    t("fetchr_mute.export_header_stats", { total: sorted.length, muted: mutedCount }),
    "",
  ];
  return `${header.join("\n")}${lines.join("\n")}\n`;
}

/** Имя файла по умолчанию для диалога сохранения: «видео.mp4» + «.muted.srt» → «видео.muted.srt». */
export function exportFileName(sourcePath: string, suffix: string): string {
  const base = sourcePath.split(/[\\/]/).pop() ?? "transcript";
  const stem = base.replace(/\.[^.]+$/, "");
  const sanitized =
    stem.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").trim() || "transcript";
  return `${sanitized}${suffix}`;
}

/** «видео.mp4» → «видео.transcript.txt». */
export function transcriptFileName(sourcePath: string): string {
  return exportFileName(sourcePath, ".transcript.txt");
}
