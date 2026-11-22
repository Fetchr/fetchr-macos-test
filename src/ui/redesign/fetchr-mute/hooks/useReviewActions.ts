import { useCallback } from "react";

import { useFetchrMuteStore } from "@/stores/fetchrMute";
import type { MuteSpan, WordHit } from "@/types/job";

import { isSameSpan } from "../editModel";
import { isManualSpan, type ReviewHit, type WordMark } from "../reviewModel";
import type { MuteEdits } from "./useMuteEdits";
import type { RecordEdit } from "./usePendingEdits";
import type { WordLists } from "./useWordLists";

export type ReviewActionId = "restore" | "never" | "mute" | "always" | "delete" | "listen";
export type ReviewTargetKind = "muted" | "manual" | "normal";

const ACTIONS: Record<ReviewTargetKind, ReviewActionId[]> = {
  muted: ["restore", "never", "listen"],
  normal: ["mute", "always", "listen"],
  manual: ["delete", "listen"],
};

export const actionsFor = (kind: ReviewTargetKind) => ACTIONS[kind];

export function wordTargetKind(mark: WordMark | undefined): ReviewTargetKind {
  if (!mark?.muted) return "normal";
  return mark.manualOnly ? "manual" : "muted";
}

export function hitTargetKind(hit: ReviewHit): ReviewTargetKind {
  if (!hit.muted) return "normal";
  return isManualSpan(hit.span) ? "manual" : "muted";
}

/** Слово хита для «Никогда/Всегда глушить» и подписи. */
export function hitWord(words: WordHit[], hit: ReviewHit): string {
  const covered = hit.wordIndices.map((index) => words[index]?.raw).filter(Boolean);
  if (covered.length > 0) return covered.join(" ");
  return isManualSpan(hit.span) ? "" : hit.span.word.split(",")[0] ?? "";
}

const overlapsWord = (word: WordHit, span: MuteSpan) =>
  word.start < span.end - 0.01 && word.end > span.start + 0.01;

interface ReviewActionsOptions {
  words: WordHit[];
  marks: WordMark[];
  effectiveSpans: MuteSpan[];
  edits: MuteEdits;
  wordLists: WordLists;
  recordEdit: RecordEdit;
  listen: (start: number, end: number) => void;
}

/**
 * Действия экрана проверки над словом и хитом. Все правки идут через
 * recordEdit — копятся неприменёнными и попадают в стек отмены.
 */
export function useReviewActions({
  words,
  marks,
  effectiveSpans,
  edits,
  wordLists,
  recordEdit,
  listen,
}: ReviewActionsOptions) {
  const { muteWordOccurrence, unmuteWordOccurrence, deleteSpan } = edits;
  const { addWordToBlacklist, removeWordFromBlacklist } = wordLists;

  // Снятое место заглушить снова — убрать исключение, а не добавлять ручной
  // отрезок: вернётся исходная форма мута.
  const dropExclusions = useCallback(
    (matches: (span: MuteSpan) => boolean) => {
      recordEdit(() => {
        const { excludedSpans, setExcludedSpans } = useFetchrMuteStore.getState();
        setExcludedSpans(excludedSpans.filter((span) => !matches(span)));
      });
    },
    [recordEdit],
  );

  const runWordAction = useCallback(
    (index: number, action: ReviewActionId) => {
      const word = words[index];
      if (!word) return;
      const handlers: Record<ReviewActionId, () => void> = {
        restore: () => unmuteWordOccurrence(word),
        never: () => removeWordFromBlacklist(word.raw),
        mute: () =>
          marks[index]?.restored
            ? dropExclusions((span) => overlapsWord(word, span))
            : muteWordOccurrence(word),
        always: () => addWordToBlacklist(word.raw),
        delete: () => {
          const manual = effectiveSpans.find(
            (span) => isManualSpan(span) && overlapsWord(word, span),
          );
          if (manual) deleteSpan(manual);
        },
        listen: () => listen(word.start, word.end),
      };
      handlers[action]();
    },
    [
      words,
      marks,
      effectiveSpans,
      unmuteWordOccurrence,
      muteWordOccurrence,
      removeWordFromBlacklist,
      addWordToBlacklist,
      deleteSpan,
      dropExclusions,
      listen,
    ],
  );

  const runHitAction = useCallback(
    (hit: ReviewHit, action: ReviewActionId) => {
      const label = hitWord(words, hit);
      const firstWord = words[hit.wordIndices[0] ?? -1];
      const handlers: Record<ReviewActionId, () => void> = {
        restore: () => deleteSpan(hit.span),
        never: () => label && removeWordFromBlacklist(label),
        mute: () => {
          if (hit.status === "restored") dropExclusions((span) => isSameSpan(span, hit.span));
          else if (firstWord) muteWordOccurrence(firstWord);
        },
        always: () => label && addWordToBlacklist(label),
        delete: () => deleteSpan(hit.span),
        listen: () => listen(hit.start, hit.end),
      };
      handlers[action]();
    },
    [
      words,
      deleteSpan,
      removeWordFromBlacklist,
      addWordToBlacklist,
      muteWordOccurrence,
      dropExclusions,
      listen,
    ],
  );

  return { runWordAction, runHitAction };
}

export type ReviewActions = ReturnType<typeof useReviewActions>;
