import { useCallback, useEffect, useState } from "react";

import type { ReviewFilter } from "../reviewModel";

export type ReviewView = "text" | "list";

/**
 * Состояние панели проверки: фильтр-чип, вид «Текст | Список» и поиск.
 * Живёт на уровне страницы — правая колонка открывает поиск по слову.
 */
export function useReviewView(fileKey: string) {
  const [filter, setFilter] = useState<ReviewFilter>("all");
  const [view, setView] = useState<ReviewView>("text");
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQueryState] = useState("");
  const [cursor, setCursor] = useState(0);

  // Новый файл — чистая панель.
  useEffect(() => {
    setFilter("all");
    setView("text");
    setSearchOpen(false);
    setQueryState("");
    setCursor(0);
  }, [fileKey]);

  const changeFilter = useCallback((next: ReviewFilter) => {
    setFilter(next);
    setCursor(0);
  }, []);

  const setQuery = useCallback((value: string) => {
    setQueryState(value);
    setCursor(0);
  }, []);

  const changeView = useCallback((next: ReviewView) => {
    setView(next);
    setCursor(0);
  }, []);

  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    setQueryState("");
    setCursor(0);
  }, []);

  /** Открыть поиск по слову (из правой колонки): в тексте, с первого совпадения. */
  const searchWord = useCallback((word: string) => {
    setView("text");
    setFilter("all");
    setSearchOpen(true);
    setQueryState(word);
    setCursor(0);
  }, []);

  const stepCursor = useCallback((delta: number, total: number) => {
    if (total <= 0) return;
    setCursor((value) => (((value + delta) % total) + total) % total);
  }, []);

  return {
    filter,
    setFilter: changeFilter,
    view,
    setView: changeView,
    searchOpen,
    setSearchOpen,
    query,
    setQuery,
    cursor,
    stepCursor,
    closeSearch,
    searchWord,
  };
}

export type ReviewViewState = ReturnType<typeof useReviewView>;
