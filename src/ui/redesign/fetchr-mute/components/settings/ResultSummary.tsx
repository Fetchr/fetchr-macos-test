import { useState } from "react";
import { useTranslation } from "react-i18next";

import shared from "../../shared.module.css";
import styles from "./ResultSummary.module.css";
import type { SpanGroup } from "../../types";

interface ResultSummaryProps {
  mutedCount: number;
  uncertainCount: number;
  spanGroups: SpanGroup[];
  onShowGroup: (group: SpanGroup) => void;
}

const WORD_LIST_LIMIT = 8;

/** Итог проверки в правой колонке: две плитки и частые слова. */
export function ResultSummary({
  mutedCount,
  uncertainCount,
  spanGroups,
  onShowGroup,
}: ResultSummaryProps) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const hiddenCount = Math.max(0, spanGroups.length - WORD_LIST_LIMIT);
  const visibleGroups = expanded ? spanGroups : spanGroups.slice(0, WORD_LIST_LIMIT);
  return (
    <section className={shared.sidebarSection}>
      <div className={styles.summaryTiles}>
        <div>
          <span>{t("fetchr_mute.zaglusheno")}</span>
          <b className={styles.summaryDanger}>{mutedCount}</b>
        </div>
        <div>
          <span>{t("fetchr_mute.filter_uncertain")}</span>
          <b className={styles.summaryWarning}>{uncertainCount}</b>
        </div>
      </div>
      {spanGroups.length > 0 && (
        <div className={styles.wordList}>
          {visibleGroups.map((group) => (
            <button
              key={group.key}
              type="button"
              className={styles.wordListItem}
              onClick={() => onShowGroup(group)}
              title={t("fetchr_mute.show_all_occurrences")}
            >
              <span className={styles.wordListLabel}>{group.label}</span>
              <span className={styles.wordListCount}>{group.items.length}</span>
            </button>
          ))}
          {hiddenCount > 0 && (
            <button
              type="button"
              className={styles.wordListMore}
              aria-expanded={expanded}
              onClick={() => setExpanded((value) => !value)}
            >
              {expanded
                ? t("fetchr_mute.summary_words_less")
                : t("fetchr_mute.summary_words_more", { count: hiddenCount })}
            </button>
          )}
        </div>
      )}
    </section>
  );
}
