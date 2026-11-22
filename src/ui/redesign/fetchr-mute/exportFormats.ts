import type { MuteSpan, WordHit } from "@/types/job";

/** Кадровая частота EDL, когда настоящая неизвестна. */
export const DEFAULT_EDL_FPS = 30;
/** Спаны ближе этого считаем одним заглушённым моментом. */
const MERGE_GAP_S = 0.01;
const MANUAL_WORD = "manual";
const LETTER = /\p{L}/u;

/** Заглушённый момент для экспорта: слитые спаны и их подпись. */
export interface ExportMoment {
  start: number;
  end: number;
  /** Слова с замаскированной серединой, через пробел. */
  text: string;
}

/** Маскирует середину слова: «блять» → «б***ь», «хуй» → «х*й», «ёб» → «ё*». */
export function maskWord(word: string): string {
  const chars = Array.from(word);
  const first = chars.findIndex((ch) => LETTER.test(ch));
  if (first < 0) return word;
  const last = chars.length - 1 - [...chars].reverse().findIndex((ch) => LETTER.test(ch));
  const core = chars.slice(first, last + 1);
  const masked =
    core.length === 1
      ? ["*"]
      : core.length === 2
        ? [core[0], "*"]
        : [core[0], ...core.slice(1, -1).map(() => "*"), core[core.length - 1]];
  return [...chars.slice(0, first), ...masked, ...chars.slice(last + 1)].join("");
}

function spanOverlapsWord(span: MuteSpan, word: WordHit): boolean {
  return word.start < span.end - MERGE_GAP_S && word.end > span.start + MERGE_GAP_S;
}

function spanLabels(span: MuteSpan): string[] {
  return span.word
    .split(",")
    .map((label) => label.trim())
    .filter((label) => label && label !== MANUAL_WORD);
}

function mergeSpans(spans: MuteSpan[]): MuteSpan[][] {
  const sorted = [...spans].sort((a, b) => a.start - b.start || a.end - b.end);
  return sorted.reduce<MuteSpan[][]>((groups, span) => {
    const last = groups[groups.length - 1];
    const lastEnd = last ? Math.max(...last.map((s) => s.end)) : -Infinity;
    return last && span.start <= lastEnd + MERGE_GAP_S
      ? [...groups.slice(0, -1), [...last, span]]
      : [...groups, [span]];
  }, []);
}

function momentText(group: MuteSpan[], words: WordHit[], fallback: string): string {
  const covered = words
    .filter((word) => group.some((span) => spanOverlapsWord(span, word)))
    .map((word) => word.raw.trim())
    .filter(Boolean);
  const labels = covered.length > 0 ? covered : Array.from(new Set(group.flatMap(spanLabels)));
  return labels.length > 0 ? labels.map(maskWord).join(" ") : fallback;
}

/**
 * Сливает пересекающиеся и смежные спаны в моменты по времени. Подпись —
 * слова транскрипции под моментом, без них — метки спанов, иначе `fallback`
 * (ручной отрезок без слов).
 */
export function buildExportMoments(
  spans: MuteSpan[],
  words: WordHit[],
  fallback: string,
): ExportMoment[] {
  const sortedWords = [...words].sort((a, b) => a.start - b.start);
  return mergeSpans(spans).map((group) => ({
    start: Math.min(...group.map((s) => s.start)),
    end: Math.max(...group.map((s) => s.end)),
    text: momentText(group, sortedWords, fallback),
  }));
}

const pad = (value: number, size = 2) => value.toString().padStart(size, "0");

/** SRT-таймкод hh:mm:ss,mmm с округлением до миллисекунды. */
export function formatSrtTimecode(secs: number): string {
  const totalMs = Math.round(Math.max(0, secs) * 1000);
  const hours = Math.floor(totalMs / 3_600_000);
  const minutes = Math.floor((totalMs % 3_600_000) / 60_000);
  const seconds = Math.floor((totalMs % 60_000) / 1000);
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)},${pad(totalMs % 1000, 3)}`;
}

/** Субтитры: одна реплика на заглушённый момент. */
export function buildSrt(moments: ExportMoment[]): string {
  return moments
    .map(
      (m, i) =>
        `${i + 1}\n${formatSrtTimecode(m.start)} --> ${formatSrtTimecode(m.end)}\n${m.text}\n`,
    )
    .join("\n");
}

function framesAt(secs: number, fps: number): number {
  return Math.round(Math.max(0, secs) * fps);
}

/** Таймкод SMPTE non-drop hh:mm:ss:ff. */
export function formatEdlTimecode(frames: number, fps: number = DEFAULT_EDL_FPS): string {
  const base = Math.max(1, Math.round(fps));
  const total = Math.max(0, Math.round(frames));
  const ff = total % base;
  const totalSecs = Math.floor(total / base);
  const hh = Math.floor(totalSecs / 3600);
  const mm = Math.floor((totalSecs % 3600) / 60);
  return `${pad(hh)}:${pad(mm)}:${pad(totalSecs % 60)}:${pad(ff)}`;
}

export interface EdlOptions {
  title: string;
  fps?: number;
}

/** Строка заголовка EDL без переводов строк, которые сломали бы формат. */
function edlTitle(title: string): string {
  return title.replace(/[\r\n]+/g, " ").trim() || "FetchrMute";
}

/**
 * Список маркеров CMX3600 в том виде, как его экспортирует DaVinci Resolve:
 * событие длиной в кадр и строка-локатор с цветом, подписью и длительностью.
 */
export function buildEdl(moments: ExportMoment[], { title, fps = DEFAULT_EDL_FPS }: EdlOptions): string {
  const header = `TITLE: ${edlTitle(title)}\nFCM: NON-DROP FRAME\n\n`;
  const events = moments.map((m, i) => {
    const inFrame = framesAt(m.start, fps);
    const duration = Math.max(1, framesAt(m.end, fps) - inFrame);
    const tcIn = formatEdlTimecode(inFrame, fps);
    const tcOut = formatEdlTimecode(inFrame + 1, fps);
    const num = pad(i + 1, 3);
    const label = m.text.replace(/\|/g, "/").replace(/[\r\n]+/g, " ");
    return (
      `${num}  001      V     C        ${tcIn} ${tcOut} ${tcIn} ${tcOut}  \n` +
      ` |C:ResolveColorRed |M:${label} |D:${duration}\n`
    );
  });
  return header + events.join("\n");
}
