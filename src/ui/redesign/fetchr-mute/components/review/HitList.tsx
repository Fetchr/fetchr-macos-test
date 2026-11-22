import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";

import { cn } from "@/lib/utils";
import { RedesignIcon } from "@/ui/redesign/icons/iconMap";
import type { WordHit } from "@/types/job";

import shared from "../../shared.module.css";
import styles from "./HitList.module.css";
import type { MuteEdits } from "../../hooks/useMuteEdits";
import {
  actionsFor,
  hitTargetKind,
  hitWord,
  type ReviewActionId,
} from "../../hooks/useReviewActions";
import { hitSnippet, type HitStatus, type ReviewHit } from "../../reviewModel";
import { formatTime } from "../../timecode";
import { ManualRangeForm } from "../ManualRangeForm";
import { ACTION_ICON, useActionLabel } from "./ActionMenu";
import { revealInside } from "./reveal";

interface HitListProps {
  words: WordHit[];
  rows: ReviewHit[];
  /** Всего хитов без фильтра — пустой список объясняется по-разному. */
  totalHits: number;
  /** Что сказать, если под фильтр ничего не подошло. */
  emptyText: string;
  currentHitId: string | null;
  /** Счётчик явных переходов к хиту: прокрутка даже к той же строке. */
  navTick: number;
  /** Строка текущего совпадения поиска, -1 — нет. */
  cursorRow: number;
  edits: MuteEdits;
  onSelect: (hit: ReviewHit) => void;
  onAction: (hit: ReviewHit, action: ReviewActionId) => void;
}

const BADGE_CLASS: Record<HitStatus, string> = {
  muted: styles.badgeMuted,
  uncertain: styles.badgeUncertain,
  restored: styles.badgeRestored,
  manual: styles.badgeManual,
};

/** Вид «Список»: хиты по времени с контекстом, статусом и действиями. */
export function HitList({
  words,
  rows,
  totalHits,
  emptyText,
  currentHitId,
  navTick,
  cursorRow,
  edits,
  onSelect,
  onAction,
}: HitListProps) {
  const { t } = useTranslation();
  const scrollerRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const badgeLabel: Record<HitStatus, string> = {
    muted: t("fetchr_mute.hit_status_muted"),
    uncertain: t("fetchr_mute.hit_status_uncertain"),
    restored: t("fetchr_mute.hit_status_restored"),
    manual: t("fetchr_mute.hit_status_manual"),
  };

  useEffect(() => {
    if (cursorRow < 0) return;
    const row = listRef.current?.children[cursorRow] as HTMLElement | undefined;
    if (row && scrollerRef.current) revealInside(scrollerRef.current, row);
  }, [cursorRow]);

  // Явный переход (N/P, клик по метке или строке) — строка в зоне видимости.
  const currentRow = rows.findIndex((hit) => hit.id === currentHitId);
  useEffect(() => {
    if (navTick === 0 || currentRow < 0) return;
    const row = listRef.current?.children[currentRow] as HTMLElement | undefined;
    if (row && scrollerRef.current) revealInside(scrollerRef.current, row);
  }, [navTick]);

  return (
    <div ref={scrollerRef} className={styles.scroller}>
      {rows.length === 0 ? (
        <div className={shared.emptySearch}>
          {totalHits === 0
            ? t("fetchr_mute.nichego_ne_zaglusheno")
            : emptyText}
        </div>
      ) : (
        <ul ref={listRef} className={styles.list}>
          {rows.map((hit, index) => (
            <HitRow
              key={hit.id}
              hit={hit}
              words={words}
              current={hit.id === currentHitId}
              cursor={index === cursorRow}
              badge={badgeLabel[hit.status]}
              onSelect={onSelect}
              onAction={onAction}
            />
          ))}
        </ul>
      )}
      <div className={styles.footer}>
        <ManualRangeForm edits={edits} />
      </div>
    </div>
  );
}

interface HitRowProps {
  hit: ReviewHit;
  words: WordHit[];
  current: boolean;
  cursor: boolean;
  badge: string;
  onSelect: (hit: ReviewHit) => void;
  onAction: (hit: ReviewHit, action: ReviewActionId) => void;
}

function HitRow({ hit, words, current, cursor, badge, onSelect, onAction }: HitRowProps) {
  const { t } = useTranslation();
  const actionLabel = useActionLabel();
  const snippet = hitSnippet(words, hit);
  const word = hitWord(words, hit);
  return (
    <li
      className={cn(styles.row, current && styles.rowCurrent, cursor && styles.rowCursor)}
      aria-current={current || undefined}
    >
      <button
        type="button"
        className={styles.rowMain}
        onClick={() => onSelect(hit)}
        title={t("fetchr_mute.hit_row_seek")}
      >
        <span className={styles.time}>{formatTime(hit.start)}</span>
        <span className={styles.snippet}>
          {snippet.before && <span>{snippet.before} </span>}
          <mark
            className={cn(
              styles.focus,
              hit.muted && styles.focusMuted,
              hit.uncertain && styles.focusUncertain,
              hit.status === "restored" && styles.focusRestored,
            )}
          >
            {snippet.focus ?? t("fetchr_mute.manual_fragment")}
          </mark>
          {snippet.after && <span> {snippet.after}</span>}
        </span>
      </button>
      <span className={cn(shared.chip, styles.badge, BADGE_CLASS[hit.status])}>{badge}</span>
      <span className={styles.actions}>
        {actionsFor(hitTargetKind(hit)).map((action) => {
          const label = actionLabel(action, word);
          return (
            <button
              key={action}
              type="button"
              className={cn(shared.ghostButton, styles.actionButton)}
              onClick={() => onAction(hit, action)}
              aria-label={label}
              title={label}
            >
              <RedesignIcon name={ACTION_ICON[action]} />
            </button>
          );
        })}
      </span>
    </li>
  );
}
