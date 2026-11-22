import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { cn } from "@/lib/utils";
import type { WordHit } from "@/types/job";

import shared from "../../shared.module.css";
import styles from "./TranscriptText.module.css";
import { useFollowScroll } from "../../hooks/useFollowScroll";
import { useMenu, type MenuCloseReason } from "../../hooks/useMenu";
import {
  actionsFor,
  wordTargetKind,
  type ReviewActionId,
} from "../../hooks/useReviewActions";
import {
  markMatchesFilter,
  type ReviewFilter,
  type ReviewHit,
  type WordMark,
} from "../../reviewModel";
import { formatTime } from "../../timecode";
import { ActionMenu } from "./ActionMenu";
import { revealInside } from "./reveal";

interface TranscriptTextProps {
  words: WordHit[];
  marks: WordMark[];
  filter: ReviewFilter;
  /** Слово под плейхедом, -1 — между словами. */
  playingIndex: number;
  currentHit: ReviewHit | null;
  /** Счётчик явных переходов к хиту (N/P, клик по метке). */
  navTick: number;
  matchSet: ReadonlySet<number>;
  /** Текущее совпадение поиска, -1 — нет. */
  cursorWord: number;
  onWordAction: (index: number, action: ReviewActionId) => void;
}

const MENU_ID = "fetchr-mute-word-menu";
const MENU_GAP_PX = 4;
const MENU_EDGE_PX = 8;

const wordSelector = (index: number) => `[data-index="${index}"]`;

/**
 * Вид «Текст»: транскрипция одним потоком. Одна остановка табуляции
 * (roving tabindex), ←/→ и Home/End по словам, Enter и клик открывают
 * меню действий под словом, пробел — пуск/пауза (глобальный хоткей).
 */
export function TranscriptText({
  words,
  marks,
  filter,
  playingIndex,
  currentHit,
  navTick,
  matchSet,
  cursorWord,
  onWordAction,
}: TranscriptTextProps) {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const anchorRef = useRef<HTMLElement | null>(null);
  const [focusIndex, setFocusIndex] = useState(0);
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null);

  const wordEl = (index: number) =>
    containerRef.current?.querySelector<HTMLElement>(wordSelector(index)) ?? null;

  const revealNow = useFollowScroll(
    containerRef,
    playingIndex >= 0 ? wordSelector(playingIndex) : null,
    openIndex !== null,
  );

  // Явный переход N/P перебивает паузу слежения после ручной прокрутки.
  const navHitWord = currentHit?.wordIndices[0] ?? -1;
  useEffect(() => {
    if (navTick === 0 || navHitWord < 0) return;
    const el = wordEl(navHitWord);
    if (el) revealNow(el);
  }, [navTick]);

  useEffect(() => {
    setFocusIndex((value) => Math.min(value, Math.max(0, words.length - 1)));
    setOpenIndex(null);
  }, [words]);

  // Переход по поиску: слово видно и с него начнётся табуляция.
  useEffect(() => {
    if (cursorWord < 0) return;
    setFocusIndex(cursorWord);
    const container = containerRef.current;
    const el = container?.querySelector<HTMLElement>(wordSelector(cursorWord));
    if (container && el) revealInside(container, el);
  }, [cursorWord]);

  const focusWord = (index: number) => {
    const clamped = Math.min(Math.max(index, 0), words.length - 1);
    setFocusIndex(clamped);
    const container = containerRef.current;
    const el = wordEl(clamped);
    if (!container || !el) return;
    el.focus({ preventScroll: true });
    revealInside(container, el);
  };

  const openMenu = (index: number) => {
    setFocusIndex(index);
    anchorRef.current = wordEl(index);
    setMenuPos(null);
    setOpenIndex(index);
  };

  const closeMenu = (reason: MenuCloseReason | "action") => {
    const index = openIndex;
    setOpenIndex(null);
    if (index === null) return;
    const el = wordEl(index);
    if (reason !== "outside") {
      el?.focus({ preventScroll: true });
      return;
    }
    // Клик в пустое место возвращает фокус слову; клик по другому
    // контролу оставляет фокус там.
    window.setTimeout(() => {
      if (document.activeElement === document.body) el?.focus({ preventScroll: true });
    }, 0);
  };

  const { onKeyDown: onMenuKeyDown } = useMenu({
    open: openIndex !== null,
    menuRef,
    anchorRef,
    focusKey: openIndex,
    onClose: closeMenu,
  });

  useLayoutEffect(() => {
    const container = containerRef.current;
    const menu = menuRef.current;
    const anchor = openIndex === null ? null : wordEl(openIndex);
    if (!container || !menu || !anchor) return;
    const top = anchor.offsetTop + anchor.offsetHeight + MENU_GAP_PX;
    const maxLeft = container.clientWidth - menu.offsetWidth - MENU_EDGE_PX;
    setMenuPos({ top, left: Math.max(MENU_EDGE_PX, Math.min(anchor.offsetLeft, maxLeft)) });
    const bottom = top + menu.offsetHeight + MENU_EDGE_PX;
    if (bottom > container.scrollTop + container.clientHeight) {
      container.scrollTop = bottom - container.clientHeight;
    }
  }, [openIndex]);

  const indexFromEvent = (event: React.SyntheticEvent) => {
    const el = (event.target as HTMLElement).closest<HTMLElement>("[data-index]");
    return el ? Number(el.dataset.index) : null;
  };

  const onClick = (event: React.MouseEvent) => {
    const index = indexFromEvent(event);
    if (index === null) return;
    if (openIndex === index) closeMenu("escape");
    else openMenu(index);
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    const index = indexFromEvent(event);
    if (index === null || event.ctrlKey || event.metaKey || event.altKey) return;
    const handlers: Record<string, () => void> = {
      ArrowRight: () => focusWord(index + 1),
      ArrowLeft: () => focusWord(index - 1),
      Home: () => focusWord(0),
      End: () => focusWord(words.length - 1),
      Enter: () => openMenu(index),
    };
    const handler = handlers[event.key];
    if (!handler) return;
    event.preventDefault();
    handler();
  };

  const statusLabels = useMemo(
    () => ({
      muted: t("fetchr_mute.word_status_muted"),
      manual: t("fetchr_mute.word_status_manual"),
      uncertain: t("fetchr_mute.word_status_uncertain"),
      restored: t("fetchr_mute.word_status_restored"),
    }),
    [t],
  );

  if (words.length === 0) {
    return <div className={shared.emptySearch}>{t("fetchr_mute.slova_ne_naydeny")}</div>;
  }

  const hitFirst = currentHit?.wordIndices[0] ?? -1;
  const hitLast = currentHit?.wordIndices[currentHit.wordIndices.length - 1] ?? -1;
  const openWord = openIndex === null ? null : words[openIndex];

  return (
    <div
      ref={containerRef}
      className={styles.scroller}
      role="group"
      aria-label={t("fetchr_mute.transcript_aria")}
      onClick={onClick}
      onKeyDown={onKeyDown}
      data-review-transcript=""
    >
      <p className={styles.paragraph}>
        {words.map((word, index) => {
          const mark = marks[index];
          const status = mark?.muted
            ? mark.manualOnly
              ? statusLabels.manual
              : statusLabels.muted
            : mark?.restored
              ? statusLabels.restored
              : null;
          const label = [word.raw, status, mark?.uncertain ? statusLabels.uncertain : null]
            .filter(Boolean)
            .join(", ");
          return (
            <React.Fragment key={index}>
              <WordToken
                index={index}
                text={word.raw}
                label={status || mark?.uncertain ? label : undefined}
                muted={Boolean(mark?.muted)}
                uncertain={Boolean(mark?.uncertain)}
                restored={Boolean(mark?.restored)}
                dimmed={filter !== "all" && !(mark && markMatchesFilter(mark, filter))}
                playing={index === playingIndex}
                currentHit={index >= hitFirst && index <= hitLast}
                match={matchSet.has(index)}
                cursor={index === cursorWord}
                tabbable={index === focusIndex}
                expanded={index === openIndex}
              />{" "}
            </React.Fragment>
          );
        })}
      </p>
      {openWord && openIndex !== null && (
        <ActionMenu
          ref={menuRef}
          id={MENU_ID}
          label={`${openWord.raw} · ${formatTime(openWord.start)}`}
          word={openWord.raw}
          actions={actionsFor(wordTargetKind(marks[openIndex]))}
          className={styles.menu}
          // До замера — прозрачное, но не visibility:hidden: скрытый пункт
          // не принимает фокус, а меню фокусирует первый пункт сразу.
          style={menuPos ? { top: menuPos.top, left: menuPos.left } : { opacity: 0 }}
          onKeyDown={onMenuKeyDown}
          onAction={(action) => {
            closeMenu("action");
            onWordAction(openIndex, action);
          }}
        />
      )}
    </div>
  );
}

interface WordTokenProps {
  index: number;
  text: string;
  label: string | undefined;
  muted: boolean;
  uncertain: boolean;
  restored: boolean;
  dimmed: boolean;
  playing: boolean;
  currentHit: boolean;
  match: boolean;
  cursor: boolean;
  tabbable: boolean;
  expanded: boolean;
}

/** Слово: перерисовывается только при смене своих флагов. */
const WordToken = React.memo(function WordToken({
  index,
  text,
  label,
  muted,
  uncertain,
  restored,
  dimmed,
  playing,
  currentHit,
  match,
  cursor,
  tabbable,
  expanded,
}: WordTokenProps) {
  return (
    <span
      role="button"
      data-index={index}
      tabIndex={tabbable ? 0 : -1}
      aria-haspopup="menu"
      aria-expanded={expanded}
      aria-controls={expanded ? MENU_ID : undefined}
      aria-label={label}
      className={cn(
        styles.word,
        muted && styles.muted,
        uncertain && styles.uncertain,
        restored && styles.restored,
        playing && styles.playing,
        match && styles.match,
        cursor && styles.cursor,
        currentHit && styles.currentHit,
        dimmed && styles.dimmed,
      )}
    >
      {text}
    </span>
  );
});
