import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { cn } from "@/lib/utils";
import type { WordHit } from "@/types/job";

import { RedesignIcon } from "@/ui/redesign/icons/iconMap";

import shared from "../../shared.module.css";
import styles from "./ReviewPanel.module.css";
import type { HitNavigator } from "../../hooks/useHitNavigator";
import type { MuteEdits } from "../../hooks/useMuteEdits";
import type { ReviewActions } from "../../hooks/useReviewActions";
import type { ReviewView, ReviewViewState } from "../../hooks/useReviewView";
import {
  hitMatchesFilter,
  markMatchesFilter,
  searchWordMatches,
  type ReviewFilter,
  type ReviewModel,
} from "../../reviewModel";
import { ManualRangeForm } from "../ManualRangeForm";
import { HitList } from "./HitList";
import { ReviewSearch } from "./ReviewSearch";
import { TranscriptText } from "./TranscriptText";

interface ReviewPanelProps {
  words: WordHit[];
  model: ReviewModel;
  reviewView: ReviewViewState;
  /** Слово под плейхедом, -1 — между словами. */
  playingIndex: number;
  navigator: HitNavigator;
  edits: MuteEdits;
  actions: ReviewActions;
}

const FILTERS: ReviewFilter[] = ["all", "uncertain", "restored", "manual"];

/** Проверка результата: фильтры, «Текст | Список» и поиск. */
export function ReviewPanel({
  words,
  model,
  reviewView,
  playingIndex,
  navigator,
  edits,
  actions,
}: ReviewPanelProps) {
  const { t } = useTranslation();
  const { filter, view, query, cursor } = reviewView;
  const [keysOpen, setKeysOpen] = useState(false);
  const filterLabels: Record<ReviewFilter, string> = {
    all: t("fetchr_mute.filter_all"),
    uncertain: t("fetchr_mute.filter_uncertain"),
    restored: t("fetchr_mute.filter_restored"),
    manual: t("fetchr_mute.filter_manual"),
  };
  const filterHints: Record<ReviewFilter, string> = {
    all: t("fetchr_mute.filter_all_hint"),
    uncertain: t("fetchr_mute.filter_uncertain_hint"),
    restored: t("fetchr_mute.filter_restored_hint"),
    manual: t("fetchr_mute.filter_manual_hint"),
  };
  const emptyTexts: Record<ReviewFilter, string> = {
    all: t("fetchr_mute.review_list_empty"),
    uncertain: t("fetchr_mute.filter_uncertain_empty"),
    restored: t("fetchr_mute.filter_restored_empty"),
    manual: t("fetchr_mute.filter_manual_empty"),
  };
  const viewLabels: Record<ReviewView, string> = {
    text: t("fetchr_mute.view_text"),
    list: t("fetchr_mute.view_list"),
  };

  // В тексте фильтр приглушает остальные слова — счётчик считает только видимые.
  const allMatches = useMemo(() => searchWordMatches(words, query), [words, query]);
  const wordMatches = useMemo(() => {
    if (filter === "all") return allMatches;
    return allMatches.filter((index) => {
      const mark = model.marks[index];
      return Boolean(mark && markMatchesFilter(mark, filter));
    });
  }, [allMatches, filter, model.marks]);
  const matchSet = useMemo(() => new Set(wordMatches), [wordMatches]);
  const allMatchSet = useMemo(() => new Set(allMatches), [allMatches]);
  const rows = useMemo(() => {
    const filtered = model.hits.filter((hit) => hitMatchesFilter(hit, filter));
    if (!query.trim()) return filtered;
    return filtered.filter((hit) => hit.wordIndices.some((index) => allMatchSet.has(index)));
  }, [model.hits, filter, query, allMatchSet]);

  const total = view === "text" ? wordMatches.length : query.trim() ? rows.length : 0;
  const safeCursor = total > 0 ? Math.min(cursor, total - 1) : -1;

  return (
    <section className={styles.review} aria-label={t("fetchr_mute.review_aria")}>
      <div className={styles.head}>
        <div className={styles.chips} role="group" aria-label={t("fetchr_mute.filter_aria")}>
          {FILTERS.map((key) => (
            <button
              key={key}
              type="button"
              className={cn(shared.chip, styles.chip, filter === key && styles.chipActive)}
              aria-pressed={filter === key}
              title={filterHints[key]}
              onClick={() => reviewView.setFilter(key)}
            >
              {filterLabels[key]}
              <span
                className={cn(
                  styles.chipCount,
                  key === "uncertain" && model.counts[key] > 0 && styles.chipWarn,
                )}
              >
                {model.counts[key]}
              </span>
            </button>
          ))}
        </div>
        <span className={shared.controlsSpacer} />
        {view === "text" && (
          <button
            type="button"
            className={cn(shared.chip, styles.chip, edits.manualRangeOpen && styles.chipActive)}
            aria-expanded={edits.manualRangeOpen}
            aria-controls="fetchr-mute-text-manual"
            onClick={() => edits.setManualRangeOpen(!edits.manualRangeOpen)}
          >
            <RedesignIcon name="add" />
            {t("fetchr_mute.manual_add_short")}
          </button>
        )}
        <div
          className={cn(shared.segmented, styles.viewSwitch)}
          role="group"
          aria-label={t("fetchr_mute.view_aria")}
        >
          {(["text", "list"] as const).map((key) => (
            <button
              key={key}
              type="button"
              className={cn(
                shared.segmentedItem,
                styles.viewOption,
                view === key && shared.segmentedItemActive,
              )}
              aria-pressed={view === key}
              onClick={() => reviewView.setView(key)}
            >
              {viewLabels[key]}
            </button>
          ))}
        </div>
        <ReviewSearch
          open={reviewView.searchOpen}
          query={query}
          total={total}
          cursor={safeCursor}
          onOpen={() => reviewView.setSearchOpen(true)}
          onClose={reviewView.closeSearch}
          onQueryChange={reviewView.setQuery}
          onStep={(delta) => reviewView.stepCursor(delta, total)}
        />
      </div>

      <div className={styles.body}>
        {view === "text" ? (
          <TranscriptText
            words={words}
            marks={model.marks}
            filter={filter}
            playingIndex={playingIndex}
            currentHit={navigator.currentHit}
            navTick={navigator.navTick}
            matchSet={matchSet}
            cursorWord={safeCursor >= 0 ? wordMatches[safeCursor] : -1}
            onWordAction={actions.runWordAction}
          />
        ) : (
          <HitList
            words={words}
            rows={rows}
            totalHits={model.hits.length}
            emptyText={query.trim() ? t("fetchr_mute.search_none") : emptyTexts[filter]}
            currentHitId={navigator.currentHit?.id ?? null}
            navTick={navigator.navTick}
            cursorRow={safeCursor}
            edits={edits}
            onSelect={(hit) => navigator.goTo(model.hits.indexOf(hit))}
            onAction={actions.runHitAction}
          />
        )}
      </div>
      {view === "text" && (
        <div id="fetchr-mute-text-manual" className={styles.manualPanel}>
          <ManualRangeForm edits={edits} showToggle={false} />
        </div>
      )}
      <div className={styles.keysHint}>
        <p className={styles.keysText}>
          {keysOpen ? t("fetchr_mute.review_keys_full") : t("fetchr_mute.review_keys_hint")}
        </p>
        <button
          type="button"
          className={styles.keysMore}
          aria-expanded={keysOpen}
          aria-label={t("fetchr_mute.review_keys_more")}
          title={t("fetchr_mute.review_keys_more")}
          onClick={() => setKeysOpen((open) => !open)}
        >
          ?
        </button>
      </div>
    </section>
  );
}
