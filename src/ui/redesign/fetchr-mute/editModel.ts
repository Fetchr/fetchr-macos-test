import type {
  FetchrMuteCensorMethod,
  FetchrMuteSettings,
  MuteSpan,
  WordHit,
} from "@/types/job";

import { normalizeWord, wordKey } from "./fetchrMuteSettings";

/**
 * Набор правок, с которым рендерится результат: точечные правки спанов,
 * словари и настройки глушения. «Применённый» набор — то, с чем собран
 * текущий файл; «текущий» — то, что пользователь видит и правит сейчас.
 */
export interface MuteEditState {
  manualSpans: MuteSpan[];
  excludedSpans: MuteSpan[];
  customWords: string[];
  whitelistWords: string[];
  onlyCustomWords: boolean;
  censorMethod: FetchrMuteCensorMethod;
  coveragePercent: number;
  customSoundPath: string | null;
}

/** Стек отмены: снимки набора правок до каждой правки и после отмены. */
export interface EditHistory {
  past: MuteEditState[];
  future: MuteEditState[];
}

export const UNDO_LIMIT = 100;
export const EMPTY_HISTORY: EditHistory = { past: [], future: [] };

/** Допуск совпадения границ при дедупликации спанов (повторные клики). */
const SPAN_EPS_S = 0.01 + 1e-9;
/** Бэкенд добивает ручной спан минимум до 50 мс. */
const MIN_MANUAL_SPAN_S = 0.05;
const MANUAL_WORD = "manual";

// Форма мута «Адаптивного» профиля (src-tauri/src/jobs/fetchr_mute.rs):
// рампа вниз 55 мс внутри слова, ядро — доля слова, слышимый хвост 35% слова
// в пределах 85–480 мс, минимальное ядро 80 мс.
const ADAPTIVE_FADE_OUT_S = 0.055;
const ADAPTIVE_TAIL_SHARE = 0.35;
const ADAPTIVE_TAIL_MIN_S = 0.085;
const ADAPTIVE_TAIL_MAX_S = 0.48;
const ADAPTIVE_MIN_MUTE_S = 0.08;
const MIN_WORD_SPAN_S = 0.05;
/** Фраза — слова подряд с паузой меньше этой (как phrase_hits в бэкенде). */
const PHRASE_MAX_GAP_S = 0.6;

export function isSameSpan(a: MuteSpan, b: MuteSpan): boolean {
  return (
    a.word === b.word &&
    Math.abs(a.start - b.start) <= SPAN_EPS_S &&
    Math.abs(a.end - b.end) <= SPAN_EPS_S
  );
}

export function hasSpan(list: MuteSpan[], span: MuteSpan): boolean {
  return list.some((existing) => isSameSpan(existing, span));
}

export function dedupeSpans(list: MuteSpan[]): MuteSpan[] {
  return list.reduce<MuteSpan[]>(
    (acc, span) => (hasSpan(acc, span) ? acc : [...acc, span]),
    [],
  );
}

/** Спаны из `a`, которых нет в `b`. */
function spanDiff(a: MuteSpan[], b: MuteSpan[]): MuteSpan[] {
  return a.filter((span) => !hasSpan(b, span));
}

function wordKeys(list: string[]): Set<string> {
  return new Set(list.map(wordKey).filter(Boolean));
}

/** Ключи из `a`, которых нет в `b`. */
function keyDiff(a: Set<string>, b: Set<string>): string[] {
  return Array.from(a).filter((key) => !b.has(key));
}

function sameKeys(a: string[], b: string[]): boolean {
  const left = wordKeys(a);
  const right = wordKeys(b);
  return left.size === right.size && keyDiff(left, right).length === 0;
}

function sameSpanSet(a: MuteSpan[], b: MuteSpan[]): boolean {
  return spanDiff(a, b).length === 0 && spanDiff(b, a).length === 0;
}

export function editStateFromSettings(
  settings: FetchrMuteSettings,
  manualSpans: MuteSpan[],
  excludedSpans: MuteSpan[],
): MuteEditState {
  return {
    manualSpans,
    excludedSpans,
    customWords: settings.custom_words,
    whitelistWords: settings.whitelist_words,
    onlyCustomWords: settings.only_custom_words,
    censorMethod: settings.censor_method,
    coveragePercent: settings.coverage_percent,
    customSoundPath: settings.custom_sound_path ?? null,
  };
}

/** Структурное равенство наборов: порядок спанов и слов не важен. */
export function editStatesEqual(a: MuteEditState, b: MuteEditState): boolean {
  return (
    sameSpanSet(a.manualSpans, b.manualSpans) &&
    sameSpanSet(a.excludedSpans, b.excludedSpans) &&
    sameKeys(a.customWords, b.customWords) &&
    sameKeys(a.whitelistWords, b.whitelistWords) &&
    a.onlyCustomWords === b.onlyCustomWords &&
    a.censorMethod === b.censorMethod &&
    a.coveragePercent === b.coveragePercent &&
    (a.customSoundPath ?? null) === (b.customSoundPath ?? null)
  );
}

/** Число неприменённых правок: каждое добавленное/убранное слово или спан и
 *  каждая сменённая настройка — одна правка. */
export function pendingEditCount(applied: MuteEditState, current: MuteEditState): number {
  const spanChanges = (a: MuteSpan[], b: MuteSpan[]) =>
    spanDiff(a, b).length + spanDiff(b, a).length;
  const wordChanges = (a: string[], b: string[]) => {
    const left = wordKeys(a);
    const right = wordKeys(b);
    return keyDiff(left, right).length + keyDiff(right, left).length;
  };
  const soundChanged =
    current.censorMethod === "custom" &&
    applied.censorMethod === "custom" &&
    (applied.customSoundPath ?? null) !== (current.customSoundPath ?? null);
  return (
    spanChanges(applied.manualSpans, current.manualSpans) +
    spanChanges(applied.excludedSpans, current.excludedSpans) +
    wordChanges(applied.customWords, current.customWords) +
    wordChanges(applied.whitelistWords, current.whitelistWords) +
    Number(applied.onlyCustomWords !== current.onlyCustomWords) +
    Number(applied.censorMethod !== current.censorMethod) +
    Number(soundChanged) +
    Number(applied.coveragePercent !== current.coveragePercent)
  );
}

// ── Стек отмены ─────────────────────────────────────────────────────

export function pushEdit(history: EditHistory, before: MuteEditState): EditHistory {
  return { past: [...history.past, before].slice(-UNDO_LIMIT), future: [] };
}

export function undoEdit(
  history: EditHistory,
  current: MuteEditState,
): { history: EditHistory; state: MuteEditState } | null {
  if (history.past.length === 0) return null;
  const state = history.past[history.past.length - 1];
  return {
    state,
    history: {
      past: history.past.slice(0, -1),
      future: [current, ...history.future].slice(0, UNDO_LIMIT),
    },
  };
}

export function redoEdit(
  history: EditHistory,
  current: MuteEditState,
): { history: EditHistory; state: MuteEditState } | null {
  if (history.future.length === 0) return null;
  const [state, ...future] = history.future;
  return {
    state,
    history: { past: [...history.past, current].slice(-UNDO_LIMIT), future },
  };
}

// ── Эффективные спаны: применённые + неприменённые правки ───────────

interface TimeRange {
  start: number;
  end: number;
}

const overlap = (a: TimeRange, b: TimeRange) =>
  Math.min(a.end, b.end) - Math.max(a.start, b.start);
const center = (r: TimeRange) => (r.start + r.end) / 2;
const contains = (r: TimeRange, time: number) => time >= r.start && time <= r.end;

/** Похоже ли исключение на спан: перекрытие ≥ половины короткого или центр
 *  одного внутри другого (как exclusion_overlaps_candidate в бэкенде). */
function exclusionMatches(span: TimeRange, exclusion: TimeRange): boolean {
  const shared = overlap(span, exclusion);
  const shorter = Math.min(span.end - span.start, exclusion.end - exclusion.start);
  return (
    (shared > 0 && shared >= shorter * 0.5) ||
    contains(span, center(exclusion)) ||
    contains(exclusion, center(span))
  );
}

/** Подписи слов спана: слитый спан хранит их через запятую. */
function spanLabels(span: MuteSpan): string[] {
  return span.word
    .split(",")
    .map(wordKey)
    .filter((label) => label && label !== MANUAL_WORD);
}

/** Подпись склейки CTC-осколков («ху й») совпадает и по слитной форме. */
function labelIn(label: string, keys: Set<string>): boolean {
  return keys.has(label) || keys.has(label.replaceAll(" ", ""));
}

function wordMatches(word: WordHit, keys: Set<string>): boolean {
  return keys.has(normalizeWord(word.raw)) || keys.has(normalizeWord(word.normalized));
}

interface WordRange extends TimeRange {
  raw: string;
}

/** Вхождения фраз из нескольких слов: окно по последовательным словам. */
function phraseRanges(words: WordHit[], keys: Set<string>): WordRange[] {
  const phrases = Array.from(keys)
    .map((key) => key.split(" ").map(normalizeWord).filter(Boolean))
    .filter((tokens) => tokens.length >= 2);
  if (phrases.length === 0) return [];
  const forms = words.map((word) => [normalizeWord(word.raw), normalizeWord(word.normalized)]);
  return phrases.flatMap((tokens) =>
    words.flatMap((_, i) => {
      const window = words.slice(i, i + tokens.length);
      if (window.length < tokens.length) return [];
      const matches = tokens.every((token, j) => forms[i + j].includes(token));
      const contiguous = window.every(
        (word, j) => j === 0 || word.start - window[j - 1].end < PHRASE_MAX_GAP_S,
      );
      if (!matches || !contiguous) return [];
      return [
        {
          raw: window.map((word) => word.raw).join(" "),
          start: window[0].start,
          end: window[window.length - 1].end,
        },
      ];
    }),
  );
}

/**
 * Ядро мута одного слова в «Адаптивном» профиле — приближение
 * covered_word_span_for_timing: рампа вниз 55 мс от начала слова, ядро —
 * доля слова, слышимый хвост в конце.
 */
export function adaptiveWordCore(word: TimeRange, coveragePercent: number): TimeRange {
  const coverage = Math.min(1, Math.max(0.2, coveragePercent / 100));
  const wordStart = Math.max(0, word.start);
  const wordEnd = Math.max(word.end, wordStart + MIN_WORD_SPAN_S);
  const duration = wordEnd - wordStart;
  const covered = Math.min(Math.max(duration * coverage, ADAPTIVE_MIN_MUTE_S), duration);
  const minimumCore = Math.min(ADAPTIVE_MIN_MUTE_S, duration);
  const coreStart = Math.min(wordStart + ADAPTIVE_FADE_OUT_S, wordEnd - minimumCore);
  const tail = Math.min(
    Math.max(duration * ADAPTIVE_TAIL_SHARE, ADAPTIVE_TAIL_MIN_S),
    ADAPTIVE_TAIL_MAX_S,
  );
  const desired = Math.min(covered, wordEnd - coreStart);
  const coreEnd = Math.min(Math.max(coreStart + desired, wordEnd - tail), wordEnd);
  return { start: coreStart, end: Math.max(coreEnd, coreStart + 0.005) };
}

function removeManual(spans: MuteSpan[], manual: MuteSpan): MuteSpan[] {
  let index = -1;
  let best = 0;
  spans.forEach((span, i) => {
    if (span.word !== MANUAL_WORD) return;
    const shared = overlap(span, manual);
    if (shared > best) {
      best = shared;
      index = i;
    }
  });
  return index === -1 ? spans : spans.filter((_, i) => i !== index);
}

function removeExcluded(spans: MuteSpan[], exclusion: MuteSpan): MuteSpan[] {
  const exact = spans.findIndex(
    (span) => span.word !== MANUAL_WORD && isSameSpan(span, exclusion),
  );
  if (exact !== -1) return spans.filter((_, i) => i !== exact);
  const target = center(exclusion);
  const nearest = spans
    .map((span, index) => ({ span, index }))
    .filter(({ span }) => span.word !== MANUAL_WORD && exclusionMatches(span, exclusion))
    .sort((a, b) => Math.abs(center(a.span) - target) - Math.abs(center(b.span) - target))[0];
  return nearest ? spans.filter((_, i) => i !== nearest.index) : spans;
}

/** «Никогда не глушить»: снять спаны слова; слитый спан пересобрать из
 *  оставшихся слов транскрипции. */
function applyNeverMute(
  spans: MuteSpan[],
  neverMute: Set<string>,
  words: WordHit[],
  coverage: number,
): MuteSpan[] {
  if (neverMute.size === 0) return spans;
  return spans.flatMap((span) => {
    const labels = spanLabels(span);
    if (span.word === MANUAL_WORD || !labels.some((label) => labelIn(label, neverMute))) {
      return [span];
    }
    const remaining = new Set(labels.filter((label) => !labelIn(label, neverMute)));
    if (remaining.size === 0) return [];
    const parts = words
      .filter((word) => wordMatches(word, remaining) && overlap(word, span) > 0)
      .map((word) => ({ word: word.raw, ...adaptiveWordCore(word, coverage) }));
    return parts.length > 0 ? parts : [span];
  });
}

/** «Всегда глушить»: добавить ядра всех вхождений слова, кроме уже
 *  заглушённых и точечно снятых пользователем. */
function applyAlwaysMute(
  spans: MuteSpan[],
  alwaysMute: Set<string>,
  words: WordHit[],
  coverage: number,
  exclusions: MuteSpan[],
): MuteSpan[] {
  if (alwaysMute.size === 0) return spans;
  // Фраза приоритетна: слова внутри неё отдельно не глушим (двойные спаны).
  // Бэкенд глушит фразу всем окном слов, без ядра adaptiveWordCore.
  const phrases = phraseRanges(words, alwaysMute);
  const singles = words.filter(
    (word) => wordMatches(word, alwaysMute) && !phrases.some((phrase) => overlap(phrase, word) > 0),
  );
  const matched: { range: WordRange; span: MuteSpan }[] = [
    ...singles.map((word) => ({
      range: word,
      span: { word: word.raw, ...adaptiveWordCore(word, coverage) },
    })),
    ...phrases.map((phrase) => ({
      range: phrase,
      span: { word: phrase.raw, start: Math.max(0, phrase.start), end: phrase.end },
    })),
  ];
  const added = matched
    .filter(({ range }) => !spans.some((span) => overlap(span, range) > 0.01))
    .map(({ span }) => span)
    .filter((span) => !exclusions.some((exclusion) => exclusionMatches(span, exclusion)));
  return [...spans, ...added];
}

export interface EffectiveSpansInput {
  /** Спаны, с которыми собран текущий файл. */
  appliedSpans: MuteSpan[];
  applied: MuteEditState;
  current: MuteEditState;
  words: WordHit[] | null;
}

/**
 * Что будет заглушено после «Применить» — приближение без ffmpeg: применённые
 * спаны минус снятые места плюс новые ручные фрагменты плюс эффект правок
 * словарей. Смену доли и способа глушения точно не предсказать — она
 * отражается только на новых словах из словаря.
 */
export function deriveEffectiveSpans({
  appliedSpans,
  applied,
  current,
  words,
}: EffectiveSpansInput): MuteSpan[] {
  if (editStatesEqual(applied, current)) return appliedSpans;
  const transcript = words ?? [];
  const coverage = current.coveragePercent;
  const appliedBlack = wordKeys(applied.customWords);
  const currentBlack = wordKeys(current.customWords);
  const appliedWhite = wordKeys(applied.whitelistWords);
  const currentWhite = wordKeys(current.whitelistWords);
  const neverMute = new Set(keyDiff(currentWhite, appliedWhite));
  const alwaysMute = new Set([
    ...keyDiff(currentBlack, appliedBlack),
    ...keyDiff(appliedWhite, currentWhite).filter((key) => currentBlack.has(key)),
  ]);

  let spans = spanDiff(applied.manualSpans, current.manualSpans).reduce(
    removeManual,
    appliedSpans,
  );
  spans = [...spans, ...spanDiff(applied.excludedSpans, current.excludedSpans)];
  spans = applyNeverMute(spans, neverMute, transcript, coverage);
  if (current.onlyCustomWords && !applied.onlyCustomWords) {
    spans = spans.filter(
      (span) =>
        span.word === MANUAL_WORD || spanLabels(span).some((label) => labelIn(label, currentBlack)),
    );
  }
  spans = applyAlwaysMute(spans, alwaysMute, transcript, coverage, current.excludedSpans);
  spans = [
    ...spans,
    ...spanDiff(current.manualSpans, applied.manualSpans).map((span) => ({
      word: MANUAL_WORD,
      start: Math.max(0, span.start),
      end: Math.max(span.end, span.start + MIN_MANUAL_SPAN_S),
    })),
  ];
  spans = spanDiff(current.excludedSpans, applied.excludedSpans).reduce(removeExcluded, spans);
  return dedupeSpans([...spans].sort((a, b) => a.start - b.start || a.end - b.end));
}
