import type {
  FetchrMuteCensorshipLevel,
  FetchrMuteSettings,
  MuteSpan,
  WordHit,
} from "@/types/job";

/**
 * Модель экрана проверки: «попадания» (что заглушено, что под вопросом, где
 * вернули звук, что добавлено вручную) и разметка каждого слова транскрипции.
 * Всё считается из эффективного состояния — с учётом неприменённых правок.
 */

export type ReviewFilter = "all" | "uncertain" | "restored" | "manual";
export type HitStatus = "muted" | "uncertain" | "restored" | "manual";

export interface ReviewHit {
  id: string;
  status: HitStatus;
  start: number;
  end: number;
  /** Заглушено в эффективном состоянии. */
  muted: boolean;
  uncertain: boolean;
  /** Спан, из которого вырос хит: эффективный, снятый или синтетический по слову. */
  span: MuteSpan;
  /** Индексы слов транскрипции под хитом (может быть пусто у ручного отрезка). */
  wordIndices: number[];
}

export interface WordMark {
  muted: boolean;
  /** Слово накрыто только ручными отрезками. */
  manualOnly: boolean;
  restored: boolean;
  uncertain: boolean;
}

export interface ReviewModel {
  /** Все хиты по времени: навигатор, метки шкалы и список. */
  hits: ReviewHit[];
  marks: WordMark[];
  counts: Record<ReviewFilter, number>;
}

const MANUAL_WORD = "manual";
const OVERLAP_EPS_S = 0.01;

// Общий порог уверенности бэкенда (censor_confidence_threshold в
// src-tauri/src/jobs/fetchr_mute.rs): ниже него слово считается сомнительным.
const GENERIC_THRESHOLD: Record<FetchrMuteCensorshipLevel, number> = {
  soft: 0.65,
  standard: 0.38,
  strict: 0.25,
  maximum: 0,
};
const ADAPTIVE_THRESHOLD: Record<FetchrMuteCensorshipLevel, number> = {
  soft: 0.45,
  standard: 0.22,
  strict: 0.15,
  maximum: 0,
};

export function uncertaintyThreshold(settings: FetchrMuteSettings): number {
  const table = settings.mute_profile === "adaptive" ? ADAPTIVE_THRESHOLD : GENERIC_THRESHOLD;
  return table[settings.censorship_level] ?? GENERIC_THRESHOLD.standard;
}

/** Сомнительное слово: вторая модель его не подтвердила или ASR не уверен. */
export function isDoubtfulWord(word: WordHit, threshold: number): boolean {
  if (word.verified === false) return true;
  return word.verified !== true && word.confidence < threshold;
}

export const isManualSpan = (span: MuteSpan) => span.word === MANUAL_WORD;

const overlaps = (word: WordHit, span: MuteSpan) =>
  word.start < span.end - OVERLAP_EPS_S && word.end > span.start + OVERLAP_EPS_S;

/** Первое слово, которое может пересечь момент `time` (слова отсортированы по start). */
function firstWordEndingAfter(words: WordHit[], time: number): number {
  let lo = 0;
  let hi = words.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (words[mid].end <= time) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function coveredWordIndices(words: WordHit[], span: MuteSpan): number[] {
  const result: number[] = [];
  for (let i = firstWordEndingAfter(words, span.start); i < words.length; i += 1) {
    if (words[i].start >= span.end) break;
    if (overlaps(words[i], span)) result.push(i);
  }
  return result;
}

// Ключ по времени: вернуть звук и заглушить снова — тот же хит, выбор
// навигатора на нём остаётся.
const timeKey = (span: MuteSpan) => `${span.start.toFixed(3)}-${span.end.toFixed(3)}`;

function withUniqueIds(hits: ReviewHit[]): ReviewHit[] {
  const seen = new Map<string, number>();
  return hits.map((hit) => {
    const count = seen.get(hit.id) ?? 0;
    seen.set(hit.id, count + 1);
    return count === 0 ? hit : { ...hit, id: `${hit.id}#${count}` };
  });
}

function hitFromSpan(
  span: MuteSpan,
  words: WordHit[],
  doubtful: boolean[],
  muted: boolean,
): ReviewHit {
  const wordIndices = coveredWordIndices(words, span);
  const uncertain = !isManualSpan(span) && wordIndices.some((i) => doubtful[i]);
  const status: HitStatus = !muted
    ? "restored"
    : isManualSpan(span)
      ? "manual"
      : uncertain
        ? "uncertain"
        : "muted";
  return {
    id: timeKey(span),
    status,
    start: span.start,
    end: span.end,
    muted,
    uncertain,
    span,
    wordIndices,
  };
}

function emptyMarks(count: number): WordMark[] {
  return Array.from({ length: count }, () => ({
    muted: false,
    manualOnly: false,
    restored: false,
    uncertain: false,
  }));
}

function markWords(marks: WordMark[], hits: ReviewHit[], doubtful: boolean[]): WordMark[] {
  const autoMuted = new Set<number>();
  const manual = new Set<number>();
  const restored = new Set<number>();
  hits.forEach((hit) => {
    const target = !hit.muted ? restored : isManualSpan(hit.span) ? manual : autoMuted;
    hit.wordIndices.forEach((i) => target.add(i));
  });
  return marks.map((mark, i) => {
    const muted = autoMuted.has(i) || manual.has(i);
    return {
      muted,
      manualOnly: manual.has(i) && !autoMuted.has(i),
      restored: !muted && restored.has(i),
      // Сомнительными помечаем только кандидатов в мат, а не любое тихое слово.
      uncertain: doubtful[i] && (muted || restored.has(i) || mark.uncertain),
    };
  });
}

export interface ReviewModelInput {
  words: WordHit[];
  effectiveSpans: MuteSpan[];
  excludedSpans: MuteSpan[];
  threshold: number;
}

export function buildReviewModel({
  words,
  effectiveSpans,
  excludedSpans,
  threshold,
}: ReviewModelInput): ReviewModel {
  const doubtful = words.map((word) => isDoubtfulWord(word, threshold));
  const mutedHits = effectiveSpans.map((span) => hitFromSpan(span, words, doubtful, true));
  const restoredHits = excludedSpans.map((span) => hitFromSpan(span, words, doubtful, false));
  const covered = new Set<number>(
    [...mutedHits, ...restoredHits].flatMap((hit) => hit.wordIndices),
  );
  // Кандидаты, которых перепроверка не подтвердила: не заглушены, но их
  // стоит послушать.
  const rejectedHits = words.flatMap((word, index): ReviewHit[] => {
    if (word.verified !== false || covered.has(index)) return [];
    const span = { word: word.raw, start: word.start, end: word.end };
    return [
      {
        id: timeKey(span),
        status: "uncertain",
        start: word.start,
        end: word.end,
        muted: false,
        uncertain: true,
        span,
        wordIndices: [index],
      },
    ];
  });
  const hits = withUniqueIds(
    [...mutedHits, ...restoredHits, ...rejectedHits].sort(
      (a, b) => a.start - b.start || a.end - b.end,
    ),
  );
  const baseMarks = emptyMarks(words.length).map((mark, i) => ({
    ...mark,
    uncertain: words[i].verified === false,
  }));
  return {
    hits,
    marks: markWords(baseMarks, hits, doubtful),
    counts: {
      all: hits.length,
      uncertain: hits.filter((hit) => hit.uncertain).length,
      restored: hits.filter((hit) => hit.status === "restored").length,
      manual: hits.filter((hit) => hit.status === "manual").length,
    },
  };
}

export function hitMatchesFilter(hit: ReviewHit, filter: ReviewFilter): boolean {
  if (filter === "all") return true;
  if (filter === "uncertain") return hit.uncertain;
  return hit.status === filter;
}

export function markMatchesFilter(mark: WordMark, filter: ReviewFilter): boolean {
  if (filter === "all") return true;
  if (filter === "uncertain") return mark.uncertain;
  if (filter === "restored") return mark.restored;
  return mark.manualOnly;
}

/**
 * Текущий хит: тот, что под плейхедом, или ближайший следующий; -1 — после
 * последнего. Выбранный навигатором хит держится, пока плейхед подходит к нему.
 */
export function currentHitIndex(
  hits: ReviewHit[],
  time: number,
  selectedId: string | null,
): number {
  const selected = selectedId ? hits.findIndex((hit) => hit.id === selectedId) : -1;
  if (selected !== -1) {
    const hit = hits[selected];
    if (time >= hit.start - SELECTION_LEAD_S && time <= hit.end + OVERLAP_EPS_S) return selected;
  }
  return hits.findIndex((hit) => hit.end >= time);
}

/** Насколько раньше хита встаёт плейхед при переходе к нему. */
export const HIT_SEEK_LEAD_S = 0.8;
const SELECTION_LEAD_S = HIT_SEEK_LEAD_S + 0.7;

export interface HitSnippet {
  before: string;
  focus: string | null;
  after: string;
}

/** Контекст хита: по `radius` слов до и после, слово хита — отдельно. */
export function hitSnippet(words: WordHit[], hit: ReviewHit, radius = 4): HitSnippet {
  const join = (from: number, to: number) =>
    words
      .slice(Math.max(0, from), Math.max(0, to))
      .map((word) => word.raw)
      .join(" ");
  if (hit.wordIndices.length === 0) {
    const at = firstWordEndingAfter(words, hit.start);
    return { before: join(at - radius, at), focus: null, after: join(at, at + radius) };
  }
  const first = hit.wordIndices[0];
  const last = hit.wordIndices[hit.wordIndices.length - 1];
  return {
    before: join(first - radius, first),
    focus: join(first, last + 1),
    after: join(last + 1, last + 1 + radius),
  };
}

/** Индексы слов, где встречается запрос (без учёта регистра). */
export function searchWordMatches(words: WordHit[], query: string): number[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  return words.flatMap((word, index) =>
    word.raw.toLowerCase().includes(needle) || word.normalized.toLowerCase().includes(needle)
      ? [index]
      : [],
  );
}
