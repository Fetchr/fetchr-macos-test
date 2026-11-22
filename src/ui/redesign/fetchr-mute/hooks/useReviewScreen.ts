import { useMemo } from "react";

import type { FetchrMuteSettings, MuteSpan, WordHit } from "@/types/job";

import { buildReviewModel, uncertaintyThreshold } from "../reviewModel";
import type { ReviewShortcuts } from "./useEditShortcuts";
import { useHitNavigator } from "./useHitNavigator";
import { useListenRange } from "./useListenRange";
import type { MediaPlayer } from "./useMediaPlayer";
import type { MuteEdits } from "./useMuteEdits";
import type { RecordEdit } from "./usePendingEdits";
import { useReviewActions } from "./useReviewActions";
import { useReviewView } from "./useReviewView";
import type { WordLists } from "./useWordLists";

interface ReviewScreenOptions {
  words: WordHit[] | null;
  effectiveSpans: MuteSpan[];
  excludedSpans: MuteSpan[];
  currentSettings: FetchrMuteSettings;
  player: MediaPlayer;
  edits: MuteEdits;
  wordLists: WordLists;
  recordEdit: RecordEdit;
  /** Ключ файла: при смене панель проверки сбрасывается. */
  fileKey: string;
}

const EMPTY_WORDS: WordHit[] = [];

/** Слово транскрипции в фокусе клавиатуры, если фокус в транскрипте. */
function focusedWordIndex(): number | null {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement)) return null;
  const word = active.closest<HTMLElement>("[data-review-transcript] [data-index]");
  return word ? Number(word.dataset.index) : null;
}

/** Экран проверки: модель хитов, навигатор, действия, вид панели и хоткеи. */
export function useReviewScreen({
  words,
  effectiveSpans,
  excludedSpans,
  currentSettings,
  player,
  edits,
  wordLists,
  recordEdit,
  fileKey,
}: ReviewScreenOptions) {
  const transcript = words ?? EMPTY_WORDS;
  const threshold = uncertaintyThreshold(currentSettings);
  const model = useMemo(
    () => buildReviewModel({ words: transcript, effectiveSpans, excludedSpans, threshold }),
    [transcript, effectiveSpans, excludedSpans, threshold],
  );
  const navigator = useHitNavigator({
    hits: model.hits,
    currentTime: player.currentTime,
    seekTo: player.seekTo,
  });
  const listen = useListenRange(player.mediaEl, player.seekToTime);
  const actions = useReviewActions({
    words: transcript,
    marks: model.marks,
    effectiveSpans,
    edits,
    wordLists,
    recordEdit,
    listen,
  });
  const reviewView = useReviewView(fileKey);

  // M/R: слово в фокусе транскрипта, иначе текущий хит навигатора.
  const muteTarget = () => {
    const index = focusedWordIndex();
    if (index !== null) {
      if (!model.marks[index]?.muted) actions.runWordAction(index, "mute");
      return;
    }
    const hit = navigator.currentHit;
    if (hit && !hit.muted) actions.runHitAction(hit, "mute");
  };

  const restoreTarget = () => {
    const index = focusedWordIndex();
    if (index !== null) {
      const mark = model.marks[index];
      if (mark?.muted) actions.runWordAction(index, mark.manualOnly ? "delete" : "restore");
      return;
    }
    const hit = navigator.currentHit;
    if (hit?.muted) {
      actions.runHitAction(hit, hit.status === "manual" ? "delete" : "restore");
    }
  };

  const shortcuts: ReviewShortcuts = {
    onNextHit: navigator.next,
    onPrevHit: navigator.prev,
    onMute: muteTarget,
    onRestore: restoreTarget,
    onTogglePlay: player.togglePlay,
    onSeekBy: (seconds) => player.seekTo((player.mediaRef.current?.currentTime ?? 0) + seconds),
  };

  return { model, navigator, actions, reviewView, shortcuts };
}

export type ReviewScreen = ReturnType<typeof useReviewScreen>;
