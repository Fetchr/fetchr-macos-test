import type { FetchrMuteAsrModel, FetchrMuteProcessingMode, FetchrMuteSettings } from "@/types/job";

import { FETCHR_MUTE_TIMING_SETTINGS_VERSION } from "./constants";

export const FETCHR_MUTE_SETTINGS_KEY = "fetchr-mute-settings";
export const FETCHR_MUTE_SETTINGS_VERSION_KEY = "fetchr-mute-timing-settings-version";

export const DEFAULT_FETCHR_MUTE_SETTINGS: FetchrMuteSettings = {
  language: "ru",
  mode: "normal",
  asr_model: "gigaam_v3_rnnt_int8",
  censorship_level: "standard",
  censor_method: "mute",
  mute_profile: "adaptive",
  coverage_percent: 50,
  fade_out_ms: 100,
  fade_in_ms: 5,
  min_mute_ms: 80,
  custom_words: [],
  whitelist_words: [],
  only_custom_words: false,
  smooth_mute: true,
  custom_sound_path: null,
  audio_track_index: null,
};

// Модель одна на все режимы. Режим влияет только на длину сегментов и
// предотбор речи на стороне бэкенда.
export function fetchrMuteModelForMode(_mode: FetchrMuteProcessingMode): FetchrMuteAsrModel {
  return "gigaam_v3_rnnt_int8";
}

export function splitFetchrMuteWords(value: string): string[] {
  return Array.from(
    new Set(
      value
        .split(/[\n,;]+/)
        .map((part) => part.trim())
        .filter(Boolean),
    ),
  );
}

export function fileNameFromPath(path: string | null | undefined): string {
  if (!path) return "";
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

/** Normalize a word for blacklist/whitelist comparison: lowercase, strip
 *  everything except letters/digits. Совпадает с Rust normalize_word
 *  (unicode-alphanumeric), а не только с [a-zа-я0-9]. */
export function normalizeWord(word: string): string {
  return word.toLowerCase().replaceAll("ё", "е").replace(/[^\p{L}\p{N}]/gu, "").trim();
}

/** Ключ записи списка: регистр/ё как у normalizeWord, пунктуация удаляется,
 *  пробелы схлопываются в один, но остаются — «в ахуе» ≠ «вахуе». */
export function wordKey(word: string): string {
  return word
    .toLowerCase()
    .replaceAll("ё", "е")
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

/** Форма записи для хранения в списке: регистр/ё как у ключа, но пробелы
 *  сохранены — бэкенд ищет фразу («в ахуе») только при наличии пробела. */
export function formatWordEntry(word: string): string {
  return word.toLowerCase().replaceAll("ё", "е").replace(/\s+/gu, " ").trim();
}

/** Версия схемы таймингов, с которой сохранены настройки (0 — не записана). */
export function readSavedFetchrMuteSettingsVersion(): number {
  return Number(localStorage.getItem(FETCHR_MUTE_SETTINGS_VERSION_KEY) ?? "0");
}

/**
 * Миграция сохранённых настроек на текущую схему таймингов.
 * v7 matches the supplied reference envelope: a long fade starting
 * inside the bad word, a shorter zero core and a quick return.
 * Чистая функция: в localStorage не пишет.
 */
export function migrateFetchrMuteSettings<T extends Omit<Partial<FetchrMuteSettings>, "mode">>(
  parsed: T,
  savedVersion: number,
): T {
  const needsMigration = savedVersion < FETCHR_MUTE_TIMING_SETTINGS_VERSION;
  if (!needsMigration) return parsed;
  return {
    ...parsed,
    mute_profile: "adaptive",
    coverage_percent: DEFAULT_FETCHR_MUTE_SETTINGS.coverage_percent,
    fade_out_ms: DEFAULT_FETCHR_MUTE_SETTINGS.fade_out_ms,
    fade_in_ms: DEFAULT_FETCHR_MUTE_SETTINGS.fade_in_ms,
    min_mute_ms: DEFAULT_FETCHR_MUTE_SETTINGS.min_mute_ms,
    smooth_mute: true,
  };
}

/**
 * Сохранённые настройки «Удалить маты» из страницы (с миграцией схемы);
 * без них берутся значения по умолчанию. Аудиодорожка — свойство конкретного
 * файла, а не глобальная настройка: скачивания и очередь всегда берут дорожку
 * по умолчанию (старые сохранения могли содержать индекс открытого файла).
 */
export function loadSavedFetchrMuteSettings(): FetchrMuteSettings {
  try {
    const saved = localStorage.getItem(FETCHR_MUTE_SETTINGS_KEY);
    if (saved) {
      const parsed = migrateFetchrMuteSettings(
        JSON.parse(saved) as Omit<Partial<FetchrMuteSettings>, "mode"> & { mode?: string },
        readSavedFetchrMuteSettingsVersion(),
      );
      const mode: FetchrMuteProcessingMode = parsed.mode === "precise" || parsed.mode === "irl" ? "precise" : "normal";
      return {
        ...DEFAULT_FETCHR_MUTE_SETTINGS,
        ...parsed,
        mode,
        asr_model: fetchrMuteModelForMode(mode),
        audio_track_index: null,
      };
    }
  } catch {
    // битый JSON в хранилище не должен ломать скачивание
  }
  return DEFAULT_FETCHR_MUTE_SETTINGS;
}
