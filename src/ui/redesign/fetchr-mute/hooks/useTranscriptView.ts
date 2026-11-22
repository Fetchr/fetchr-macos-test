import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import type { MuteSpan, WordHit } from "@/types/job";

import { normalizeWord } from "../fetchrMuteSettings";
import type { SpanGroup } from "../types";

// Активное слово: бинарный поиск по отсортированным start (O(log n) вместо
// O(n) findIndex на каждый timeupdate — заметно на длинных транскрипциях)
function findActiveWordIndex(words: WordHit[] | null, currentTime: number): number {
  if (!words || words.length === 0) return -1;
  let lo = 0;
  let hi = words.length - 1;
  let candidate = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (words[mid].start <= currentTime) {
      candidate = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (candidate === -1) return -1;
  return currentTime <= words[candidate].end ? candidate : -1;
}

// Заглушённые фрагменты, свёрнутые по слову: частые слова в правой колонке.
function groupSpans(spans: MuteSpan[] | null, manualLabel: string): SpanGroup[] {
  const groups = new Map<string, SpanGroup>();
  (spans ?? []).forEach((span) => {
    const isManual = span.word === "manual";
    const label = isManual ? manualLabel : span.word.split(",")[0] || "?";
    const key = isManual ? "__manual__" : normalizeWord(label) || label;
    const group = groups.get(key) ?? { key, label, isManual, items: [] };
    groups.set(key, { ...group, items: [...group.items, span] });
  });
  return Array.from(groups.values()).sort(
    (a, b) => b.items.length - a.items.length || a.label.localeCompare(b.label),
  );
}

/** Транскрипция для проверки: слово под плейхедом и частые заглушённые слова. */
export function useTranscriptView(
  words: WordHit[] | null,
  spans: MuteSpan[] | null,
  currentTime: number,
) {
  const { t } = useTranslation();

  const activeWordIdx = useMemo(
    () => findActiveWordIndex(words, currentTime),
    [words, currentTime],
  );

  const manualLabel = t("fetchr_mute.manual_fragment");
  const spanGroups = useMemo(() => groupSpans(spans, manualLabel), [spans, manualLabel]);

  return { activeWordIdx, spanGroups };
}
