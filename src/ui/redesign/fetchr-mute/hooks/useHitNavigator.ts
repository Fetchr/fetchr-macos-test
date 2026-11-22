import { useCallback, useEffect, useMemo, useState } from "react";

import { currentHitIndex, HIT_SEEK_LEAD_S, type ReviewHit } from "../reviewModel";

/** Плейхед уже у хита: «следующий» ведёт дальше, а не к нему же. */
const REACHED_EPS_S = 0.05;

interface HitNavigatorOptions {
  hits: ReviewHit[];
  currentTime: number;
  seekTo: (time: number) => void;
}

/** Навигатор «‹ мат N из M ›»: текущий хит и переходы между хитами. */
export function useHitNavigator({ hits, currentTime, seekTo }: HitNavigatorOptions) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  /** Счётчик явных переходов (N/P, клик): панели прокручивают к хиту даже на паузе слежения. */
  const [navTick, setNavTick] = useState(0);

  // Хит пропал (правка, новый результат) — выбор ничего не держит.
  useEffect(() => {
    if (selectedId && !hits.some((hit) => hit.id === selectedId)) setSelectedId(null);
  }, [hits, selectedId]);

  const current = useMemo(
    () => currentHitIndex(hits, currentTime, selectedId),
    [hits, currentTime, selectedId],
  );

  const goTo = useCallback(
    (index: number) => {
      const hit = hits[index];
      if (!hit) return;
      setSelectedId(hit.id);
      setNavTick((value) => value + 1);
      seekTo(Math.max(0, hit.start - HIT_SEEK_LEAD_S));
    },
    [hits, seekTo],
  );

  const currentHit = current === -1 ? null : hits[current];
  const reached =
    currentHit !== null && currentTime >= currentHit.start - HIT_SEEK_LEAD_S - REACHED_EPS_S;
  const nextIndex = current === -1 ? -1 : reached ? current + 1 : current;
  const prevIndex = current === -1 ? hits.length - 1 : current - 1;

  return {
    current,
    currentHit,
    total: hits.length,
    navTick,
    selectHit: (hit: ReviewHit) => setSelectedId(hit.id),
    goTo,
    canNext: nextIndex >= 0 && nextIndex < hits.length,
    canPrev: prevIndex >= 0,
    next: () => goTo(nextIndex),
    prev: () => goTo(prevIndex),
  };
}

export type HitNavigator = ReturnType<typeof useHitNavigator>;
