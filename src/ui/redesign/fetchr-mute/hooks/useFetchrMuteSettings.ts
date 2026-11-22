import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type {
  FetchrMuteCensorMethod,
  FetchrMuteLanguage,
  FetchrMuteSettings,
} from "@/types/job";

import {
  DEFAULT_CUSTOM_WORDS_TEXT,
  FETCHR_MUTE_TIMING_SETTINGS_VERSION,
} from "../constants";
import {
  DEFAULT_FETCHR_MUTE_SETTINGS,
  FETCHR_MUTE_SETTINGS_KEY,
  FETCHR_MUTE_SETTINGS_VERSION_KEY,
  fetchrMuteModelForMode,
  migrateFetchrMuteSettings,
  readSavedFetchrMuteSettingsVersion,
  splitFetchrMuteWords,
} from "../fetchrMuteSettings";
import {
  getHistorySession,
  propagateUserEdit,
  setHistorySession,
  type PageSettingsValues,
} from "../settingsSession";
import type { MuteEditState } from "../editModel";

const SHARE_WORDS_KEY = "fetchr-mute-share-words";

export function clampCoverage(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_FETCHR_MUTE_SETTINGS.coverage_percent;
  return Math.min(100, Math.max(20, Math.round(value)));
}

// Load saved settings synchronously from localStorage on mount.
// Записи в localStorage здесь нет — чтение обязано оставаться чистым;
// мигрированные значения сохранит эффект автосохранения ниже.
function readSavedPageSettings(): Partial<FetchrMuteSettings> | null {
  const saved = localStorage.getItem(FETCHR_MUTE_SETTINGS_KEY);
  if (saved) {
    try {
      const parsed = JSON.parse(saved) as Partial<FetchrMuteSettings>;
      return migrateFetchrMuteSettings(parsed, readSavedFetchrMuteSettingsVersion());
    } catch (e) {
      console.error("Failed to parse saved settings", e);
    }
  }
  return null;
}

// GigaAM v3 — модель только для русской речи: сохранённый "en" от старых
// multilingual-моделей принудительно сводим к "ru".
function normalizeLanguage(language: FetchrMuteLanguage): FetchrMuteLanguage {
  return language === "en" ? "ru" : language;
}

// «Свой звук» без выбранного файла не сработает — откатываемся на тишину.
function normalizeCensorMethod(
  method: FetchrMuteCensorMethod,
  customSoundPath: string | null | undefined,
): FetchrMuteCensorMethod {
  return method === "custom" && !customSoundPath ? "mute" : method;
}

function valuesFromSaved(saved: Partial<FetchrMuteSettings> | null): PageSettingsValues {
  return {
    language: normalizeLanguage(saved?.language ?? DEFAULT_FETCHR_MUTE_SETTINGS.language),
    censorMethod: normalizeCensorMethod(
      saved?.censor_method ?? DEFAULT_FETCHR_MUTE_SETTINGS.censor_method,
      saved?.custom_sound_path,
    ),
    // По умолчанию 50%: так задумано (слышна затухающая голова слова).
    // Пользователь может поменять, но значение по умолчанию не трогаем.
    coveragePercent: clampCoverage(saved?.coverage_percent),
    customWordsText: saved?.custom_words ? saved.custom_words.join(", ") : DEFAULT_CUSTOM_WORDS_TEXT,
    whitelistWordsText: saved?.whitelist_words ? saved.whitelist_words.join(", ") : "",
    onlyCustomWords: saved?.only_custom_words ?? false,
    customSoundPath: saved?.custom_sound_path ?? null,
  };
}

/**
 * Полезная нагрузка настроек. Режим обработки и профиль глушения больше не
 * настраиваются в UI: всегда быстрая модель (normal) и «Адаптивный» профиль —
 * форма мута снята с референсных дорожек (слышимая затухающая голова слова,
 * ядро до конца слова). Тайминги фиксированы, сохранённые старые значения
 * игнорируются.
 */
function buildSettings(values: PageSettingsValues, audioTrackIndex: number | null): FetchrMuteSettings {
  const mode = "normal" as const;
  return {
    language: values.language,
    mode,
    asr_model: fetchrMuteModelForMode(mode),
    censorship_level: "standard",
    censor_method: values.censorMethod,
    mute_profile: "adaptive",
    coverage_percent: values.coveragePercent,
    fade_out_ms: DEFAULT_FETCHR_MUTE_SETTINGS.fade_out_ms,
    fade_in_ms: DEFAULT_FETCHR_MUTE_SETTINGS.fade_in_ms,
    min_mute_ms: DEFAULT_FETCHR_MUTE_SETTINGS.min_mute_ms,
    custom_words: splitFetchrMuteWords(values.customWordsText),
    whitelist_words: splitFetchrMuteWords(values.whitelistWordsText),
    only_custom_words: values.onlyCustomWords,
    smooth_mute: true,
    custom_sound_path: values.customSoundPath,
    audio_track_index: audioTrackIndex,
  };
}

// Дорожка — свойство конкретного файла: глобально её не храним, иначе
// скачивания стримов получают 0:a:N, которого у них может не быть.
function persistGlobalSettings(values: PageSettingsValues): void {
  const global = {
    ...values,
    censorMethod: normalizeCensorMethod(values.censorMethod, values.customSoundPath),
  };
  localStorage.setItem(FETCHR_MUTE_SETTINGS_KEY, JSON.stringify(buildSettings(global, null)));
  localStorage.setItem(
    FETCHR_MUTE_SETTINGS_VERSION_KEY,
    String(FETCHR_MUTE_TIMING_SETTINGS_VERSION),
  );
}

function initialPageValues(): PageSettingsValues {
  return getHistorySession()?.current ?? valuesFromSaved(readSavedPageSettings());
}

export function useFetchrMuteSettings(audioTrackIndex: number) {
  const [values, setValues] = useState<PageSettingsValues>(initialPageValues);
  // Источник правды для нескольких правок подряд в одном обработчике.
  const valuesRef = useRef<PageSettingsValues>(values);
  // Opt-in: send user-added words to the shared dictionary VPS. Off by default (privacy).
  const [shareWords, setShareWords] = useState<boolean>(
    () => localStorage.getItem(SHARE_WORDS_KEY) === "true",
  );

  const commitValues = useCallback((next: PageSettingsValues) => {
    valuesRef.current = next;
    setValues(next);
  }, []);

  // Правка пользователя. В сессии истории она переносится и в глобальные
  // настройки (это его намерение), а подставленные историей значения — нет.
  const updateUserValues = useCallback(
    (patch: Partial<PageSettingsValues>) => {
      const prev = valuesRef.current;
      const next = { ...prev, ...patch };
      const session = getHistorySession();
      if (session) {
        const global = propagateUserEdit(session.global, prev, next);
        setHistorySession({ global, current: next });
        persistGlobalSettings(global);
      } else {
        // Сразу, не дожидаясь эффекта: правка (например, сброс правок) может
        // прийти прямо перед уходом со страницы, когда эффект уже не сработает.
        persistGlobalSettings(next);
      }
      commitValues(next);
    },
    [commitValues],
  );

  const currentSettings = useMemo<FetchrMuteSettings>(
    () => buildSettings(values, audioTrackIndex),
    [values, audioTrackIndex],
  );

  // Свежие настройки прямо в обработчике (после правок в том же клике),
  // а не из последнего рендера.
  const audioTrackRef = useRef(audioTrackIndex);
  audioTrackRef.current = audioTrackIndex;
  const getSettings = useCallback(
    (): FetchrMuteSettings => buildSettings(valuesRef.current, audioTrackRef.current),
    [],
  );

  // Откат/повтор правки: вернуть словари и настройки глушения из снимка.
  // Текст словаря переписываем, только если изменился сам набор слов.
  const restoreEditValues = useCallback(
    (state: MuteEditState) => {
      const prev = valuesRef.current;
      const sameWords = (text: string, words: string[]) =>
        splitFetchrMuteWords(text).join("\n") === words.join("\n");
      updateUserValues({
        censorMethod: state.censorMethod,
        coveragePercent: state.coveragePercent,
        onlyCustomWords: state.onlyCustomWords,
        customSoundPath: state.customSoundPath,
        customWordsText: sameWords(prev.customWordsText, state.customWords)
          ? prev.customWordsText
          : state.customWords.join(", "),
        whitelistWordsText: sameWords(prev.whitelistWordsText, state.whitelistWords)
          ? prev.whitelistWordsText
          : state.whitelistWords.join(", "),
      });
    },
    [updateUserValues],
  );

  // Auto-save settings on change. Пока открыт элемент истории, его настройки
  // живут только в сессии; глобальные сохраняет updateUserValues.
  useEffect(() => {
    const session = getHistorySession();
    if (session) {
      setHistorySession({ ...session, current: values });
      return;
    }
    persistGlobalSettings(values);
  }, [values]);

  const updateShareWords = (value: boolean) => {
    setShareWords(value);
    localStorage.setItem(SHARE_WORDS_KEY, String(value));
  };

  // Apply the user-controlled settings used for a history item — только на
  // время этой сессии. Режим, профиль и тайминги глушения больше не
  // настраиваются; из истории берём словари, способ и долю глушения.
  const applyHistorySettings = useCallback(
    (settings: FetchrMuteSettings) => {
      const global = getHistorySession()?.global ?? valuesRef.current;
      const customSoundPath =
        settings.custom_sound_path !== undefined ? settings.custom_sound_path : global.customSoundPath;
      const next: PageSettingsValues = {
        language: normalizeLanguage(settings.language ?? global.language),
        censorMethod: normalizeCensorMethod(settings.censor_method ?? global.censorMethod, customSoundPath),
        coveragePercent:
          settings.coverage_percent !== undefined
            ? clampCoverage(settings.coverage_percent)
            : global.coveragePercent,
        customWordsText: settings.custom_words ? settings.custom_words.join(", ") : global.customWordsText,
        whitelistWordsText: settings.whitelist_words
          ? settings.whitelist_words.join(", ")
          : global.whitelistWordsText,
        onlyCustomWords: settings.only_custom_words ?? global.onlyCustomWords,
        customSoundPath,
      };
      setHistorySession({ global, current: next });
      commitValues(next);
    },
    [commitValues],
  );

  // Файл из истории закрыт или открыт другой — возвращаем настройки пользователя.
  const restoreGlobalSettings = useCallback(() => {
    const session = getHistorySession();
    if (!session) return;
    setHistorySession(null);
    commitValues(session.global);
  }, [commitValues]);

  return {
    censorMethod: values.censorMethod,
    setCensorMethod: (censorMethod: FetchrMuteCensorMethod) => updateUserValues({ censorMethod }),
    coveragePercent: values.coveragePercent,
    setCoveragePercent: (coveragePercent: number) => updateUserValues({ coveragePercent }),
    customWordsText: values.customWordsText,
    setCustomWordsText: (customWordsText: string) => updateUserValues({ customWordsText }),
    whitelistWordsText: values.whitelistWordsText,
    setWhitelistWordsText: (whitelistWordsText: string) => updateUserValues({ whitelistWordsText }),
    onlyCustomWords: values.onlyCustomWords,
    setOnlyCustomWords: (onlyCustomWords: boolean) => updateUserValues({ onlyCustomWords }),
    customSoundPath: values.customSoundPath,
    setCustomSoundPath: (customSoundPath: string | null) => updateUserValues({ customSoundPath }),
    shareWords,
    updateShareWords,
    /** Несколько настроек одной правкой (применение пресета). */
    applyValues: updateUserValues,
    currentSettings,
    getSettings,
    restoreEditValues,
    applyHistorySettings,
    restoreGlobalSettings,
  };
}

export type FetchrMuteSettingsState = ReturnType<typeof useFetchrMuteSettings>;
