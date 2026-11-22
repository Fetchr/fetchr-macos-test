import type { FetchrMuteCensorMethod } from "@/types/job";

import { DEFAULT_FETCHR_MUTE_SETTINGS, splitFetchrMuteWords, wordKey } from "./fetchrMuteSettings";
import { DEFAULT_CUSTOM_WORDS_TEXT } from "./constants";
import type { PageSettingsValues } from "./settingsSession";

/** Пресеты хранятся рядом с настройками страницы: тот же localStorage и своя версия схемы. */
export const FETCHR_MUTE_PRESETS_KEY = "fetchr-mute-presets";
export const FETCHR_MUTE_PRESETS_VERSION_KEY = "fetchr-mute-presets-version";
export const FETCHR_MUTE_PRESETS_VERSION = 1;

export const BUILT_IN_PRESET_ID = "builtin-default";
export const PRESET_NAME_MAX = 40;

export interface FetchrMutePreset {
  id: string;
  name: string;
  blacklist: string[];
  whitelist: string[];
  onlyCustomWords: boolean;
  censorMethod: FetchrMuteCensorMethod;
  coveragePercent: number;
  /** Только для способа «Свой звук». */
  customSoundPath?: string | null;
}

/** Пользовательские пресеты и последний выбранный (встроенный не хранится). */
export interface StoredPresets {
  presets: FetchrMutePreset[];
  selectedId: string | null;
}

/** То, что пресет меняет на странице. */
export type PresetValues = Pick<
  PageSettingsValues,
  | "censorMethod"
  | "coveragePercent"
  | "customWordsText"
  | "whitelistWordsText"
  | "onlyCustomWords"
  | "customSoundPath"
>;

export type PresetNameError = "empty" | "too_long" | "duplicate";

export const EMPTY_STORED_PRESETS: StoredPresets = { presets: [], selectedId: null };

/** «По умолчанию»: значения DEFAULT_FETCHR_MUTE_SETTINGS; имя подставляет UI (i18n). */
export const BUILT_IN_PRESET: FetchrMutePreset = {
  id: BUILT_IN_PRESET_ID,
  name: "",
  blacklist: splitFetchrMuteWords(DEFAULT_CUSTOM_WORDS_TEXT),
  whitelist: [...DEFAULT_FETCHR_MUTE_SETTINGS.whitelist_words],
  onlyCustomWords: DEFAULT_FETCHR_MUTE_SETTINGS.only_custom_words,
  censorMethod: DEFAULT_FETCHR_MUTE_SETTINGS.censor_method,
  coveragePercent: DEFAULT_FETCHR_MUTE_SETTINGS.coverage_percent,
  customSoundPath: null,
};

const METHODS: readonly FetchrMuteCensorMethod[] = ["mute", "beep", "custom"];

function clampPresetCoverage(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_FETCHR_MUTE_SETTINGS.coverage_percent;
  }
  return Math.min(100, Math.max(20, Math.round(value)));
}

function cleanWords(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const words = value.filter((word): word is string => typeof word === "string");
  return splitFetchrMuteWords(words.join("\n"));
}

const nameKey = (name: string) => name.trim().toLowerCase();

function sanitizePreset(raw: unknown): FetchrMutePreset | null {
  if (!raw || typeof raw !== "object") return null;
  const item = raw as Record<string, unknown>;
  const id = typeof item.id === "string" ? item.id.trim() : "";
  const name = typeof item.name === "string" ? item.name.trim().slice(0, PRESET_NAME_MAX) : "";
  if (!id || !name || id === BUILT_IN_PRESET_ID) return null;
  const method = METHODS.find((m) => m === item.censorMethod) ?? "mute";
  const soundPath =
    typeof item.customSoundPath === "string" && item.customSoundPath ? item.customSoundPath : null;
  return {
    id,
    name,
    blacklist: cleanWords(item.blacklist),
    whitelist: cleanWords(item.whitelist),
    onlyCustomWords: item.onlyCustomWords === true,
    // «Свой звук» без файла не сработает — как и в настройках страницы.
    censorMethod: method === "custom" && !soundPath ? "mute" : method,
    coveragePercent: clampPresetCoverage(item.coveragePercent),
    customSoundPath: method === "custom" ? soundPath : null,
  };
}

/**
 * Миграция сохранённых пресетов на текущую схему. Чистая функция: битые
 * записи и повторы (по id и по имени) отбрасываются, выбор без пресета — null.
 * v1 — первая схема; следующие версии добавляют шаги здесь.
 */
export function migratePresets(parsed: unknown, _savedVersion: number): StoredPresets {
  if (!parsed || typeof parsed !== "object") return EMPTY_STORED_PRESETS;
  const source = parsed as Record<string, unknown>;
  const rawList = Array.isArray(source.presets) ? source.presets : [];
  const presets = rawList
    .map(sanitizePreset)
    .filter((preset): preset is FetchrMutePreset => preset !== null)
    .filter(
      (preset, index, list) =>
        list.findIndex((other) => other.id === preset.id || nameKey(other.name) === nameKey(preset.name)) ===
        index,
    );
  const selected = typeof source.selectedId === "string" ? source.selectedId : null;
  const selectedId =
    selected === BUILT_IN_PRESET_ID || presets.some((preset) => preset.id === selected) ? selected : null;
  return { presets, selectedId };
}

type ReadStorage = Pick<Storage, "getItem">;
type WriteStorage = Pick<Storage, "setItem">;

export function loadStoredPresets(storage: ReadStorage = localStorage): StoredPresets {
  try {
    const saved = storage.getItem(FETCHR_MUTE_PRESETS_KEY);
    if (!saved) return EMPTY_STORED_PRESETS;
    const version = Number(storage.getItem(FETCHR_MUTE_PRESETS_VERSION_KEY) ?? "0");
    return migratePresets(JSON.parse(saved), Number.isFinite(version) ? version : 0);
  } catch {
    // битый JSON не должен ломать страницу
    return EMPTY_STORED_PRESETS;
  }
}

export function saveStoredPresets(stored: StoredPresets, storage: WriteStorage = localStorage): void {
  storage.setItem(FETCHR_MUTE_PRESETS_KEY, JSON.stringify(stored));
  storage.setItem(FETCHR_MUTE_PRESETS_VERSION_KEY, String(FETCHR_MUTE_PRESETS_VERSION));
}

export function presetFromValues(values: PresetValues, id: string, name: string): FetchrMutePreset {
  const custom = values.censorMethod === "custom" && Boolean(values.customSoundPath);
  return {
    id,
    name: name.trim().slice(0, PRESET_NAME_MAX),
    blacklist: splitFetchrMuteWords(values.customWordsText),
    whitelist: splitFetchrMuteWords(values.whitelistWordsText),
    onlyCustomWords: values.onlyCustomWords,
    censorMethod: values.censorMethod === "custom" && !custom ? "mute" : values.censorMethod,
    coveragePercent: clampPresetCoverage(values.coveragePercent),
    customSoundPath: custom ? values.customSoundPath : null,
  };
}

/** Что записать в настройки страницы. Звук пресета без своего звука не трогаем. */
export function presetToValues(preset: FetchrMutePreset): Partial<PresetValues> {
  const base: Partial<PresetValues> = {
    censorMethod: preset.censorMethod,
    coveragePercent: preset.coveragePercent,
    customWordsText: preset.blacklist.join(", "),
    whitelistWordsText: preset.whitelist.join(", "),
    onlyCustomWords: preset.onlyCustomWords,
  };
  return preset.customSoundPath ? { ...base, customSoundPath: preset.customSoundPath } : base;
}

const wordSetKey = (words: string[]) =>
  Array.from(new Set(words.map(wordKey).filter(Boolean)))
    .sort()
    .join("\n");

/** Совпадают ли настройки страницы с пресетом (порядок и регистр слов не важны). */
export function presetMatchesValues(preset: FetchrMutePreset, values: PresetValues): boolean {
  if (preset.censorMethod !== values.censorMethod) return false;
  if (preset.coveragePercent !== values.coveragePercent) return false;
  if (preset.onlyCustomWords !== values.onlyCustomWords) return false;
  if (wordSetKey(preset.blacklist) !== wordSetKey(splitFetchrMuteWords(values.customWordsText))) return false;
  if (wordSetKey(preset.whitelist) !== wordSetKey(splitFetchrMuteWords(values.whitelistWordsText))) return false;
  return preset.censorMethod !== "custom" || (preset.customSoundPath ?? null) === (values.customSoundPath ?? null);
}

export interface PresetStatus {
  /** Пресет, с которым совпадают текущие настройки; null — «Свои настройки». */
  activeId: string | null;
  /** К какому пресету относятся «Обновить», «Переименовать», «Удалить». */
  targetId: string | null;
  /** Выбранный пресет изменён и настройки не совпадают ни с одним пресетом. */
  modified: boolean;
}

export function resolvePresetStatus(
  presets: FetchrMutePreset[],
  selectedId: string | null,
  values: PresetValues,
): PresetStatus {
  const selected = presets.find((preset) => preset.id === selectedId) ?? null;
  const activeId =
    selected && presetMatchesValues(selected, values)
      ? selected.id
      : (presets.find((preset) => presetMatchesValues(preset, values))?.id ?? null);
  return {
    activeId,
    targetId: activeId ?? selected?.id ?? null,
    modified: activeId === null && selected !== null,
  };
}

export function validatePresetName(raw: string, takenNames: string[]): PresetNameError | null {
  const name = raw.trim();
  if (!name) return "empty";
  if (name.length > PRESET_NAME_MAX) return "too_long";
  if (takenNames.some((taken) => nameKey(taken) === nameKey(name))) return "duplicate";
  return null;
}

export function createPresetId(): string {
  const random = globalThis.crypto?.randomUUID?.();
  return random ?? `preset-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function addPreset(stored: StoredPresets, preset: FetchrMutePreset): StoredPresets {
  return { presets: [...stored.presets, preset], selectedId: preset.id };
}

export function updatePreset(
  stored: StoredPresets,
  id: string,
  patch: Partial<Omit<FetchrMutePreset, "id">>,
): StoredPresets {
  return {
    ...stored,
    presets: stored.presets.map((preset) => (preset.id === id ? { ...preset, ...patch } : preset)),
  };
}

export function removePreset(stored: StoredPresets, id: string): StoredPresets {
  return {
    presets: stored.presets.filter((preset) => preset.id !== id),
    selectedId: stored.selectedId === id ? null : stored.selectedId,
  };
}

export function selectPreset(stored: StoredPresets, id: string): StoredPresets {
  return { ...stored, selectedId: id };
}
