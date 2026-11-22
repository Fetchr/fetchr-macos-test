import type { FetchrMuteCensorMethod, FetchrMuteLanguage } from "@/types/job";

import { splitFetchrMuteWords, wordKey } from "./fetchrMuteSettings";

/** Настройки страницы, которые пользователь меняет в правой колонке. */
export interface PageSettingsValues {
  language: FetchrMuteLanguage;
  censorMethod: FetchrMuteCensorMethod;
  coveragePercent: number;
  customWordsText: string;
  whitelistWordsText: string;
  onlyCustomWords: boolean;
  customSoundPath: string | null;
}

/**
 * Открытый элемент истории подставляет свои настройки только на эту сессию.
 * `global` — настройки пользователя, которые продолжают сохраняться;
 * `current` — то, что видно на странице сейчас (переживает размонтирование
 * страницы, пока файл из истории остаётся открытым).
 */
export interface HistorySettingsSession {
  global: PageSettingsValues;
  current: PageSettingsValues;
}

let historySession: HistorySettingsSession | null = null;

export function getHistorySession(): HistorySettingsSession | null {
  return historySession;
}

export function setHistorySession(session: HistorySettingsSession | null): void {
  historySession = session;
}

/**
 * Переносит правку списка слов, сделанную в сессии истории, на глобальный
 * список: добавленные слова добавляются, удалённые — удаляются. Остальные
 * слова пользователя не трогаются.
 */
export function applyWordDelta(globalText: string, prevText: string, nextText: string): string {
  if (prevText === nextText) return globalText;
  const prev = splitFetchrMuteWords(prevText);
  const next = splitFetchrMuteWords(nextText);
  const prevKeys = new Set(prev.map(wordKey));
  const nextKeys = new Set(next.map(wordKey));
  const removed = new Set(prev.filter((w) => !nextKeys.has(wordKey(w))).map(wordKey));
  const added = next.filter((w) => !prevKeys.has(wordKey(w)));
  const kept = splitFetchrMuteWords(globalText).filter((w) => !removed.has(wordKey(w)));
  const keptKeys = new Set(kept.map(wordKey));
  return [...kept, ...added.filter((w) => !keptKeys.has(wordKey(w)))].join(", ");
}

/**
 * Явная правка пользователя в сессии истории. Словари — его намерение, они
 * сохраняются глобально (как дельта). Способ, доля и прочее остаются
 * настройками этой сессии и откатываются при закрытии файла.
 */
export function propagateUserEdit(
  global: PageSettingsValues,
  prev: PageSettingsValues,
  next: PageSettingsValues,
): PageSettingsValues {
  return {
    ...global,
    customWordsText: applyWordDelta(global.customWordsText, prev.customWordsText, next.customWordsText),
    whitelistWordsText: applyWordDelta(
      global.whitelistWordsText,
      prev.whitelistWordsText,
      next.whitelistWordsText,
    ),
  };
}
