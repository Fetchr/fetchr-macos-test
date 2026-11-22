import { useCallback, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { notifyError } from "@/lib/notify";

import {
  BUILT_IN_PRESET,
  BUILT_IN_PRESET_ID,
  addPreset,
  createPresetId,
  loadStoredPresets,
  presetFromValues,
  presetToValues,
  removePreset,
  resolvePresetStatus,
  saveStoredPresets,
  selectPreset,
  updatePreset,
  validatePresetName,
  type FetchrMutePreset,
  type PresetNameError,
  type PresetValues,
  type StoredPresets,
} from "../presets";
import type { FetchrMuteSettingsState } from "./useFetchrMuteSettings";
import type { RecordEdit } from "./usePendingEdits";

interface MutePresetsOptions {
  settings: FetchrMuteSettingsState;
  recordEdit: RecordEdit;
}

/**
 * Пресеты настроек глушения: встроенный «По умолчанию» и свои. Применение
 * пресета — обычная правка настроек: при открытом результате она становится
 * неприменённой правкой (recordEdit), как смена способа или списков.
 */
export function useMutePresets({ settings, recordEdit }: MutePresetsOptions) {
  const { t } = useTranslation();
  const [stored, setStored] = useState<StoredPresets>(loadStoredPresets);
  const storedRef = useRef(stored);

  const values: PresetValues = {
    censorMethod: settings.censorMethod,
    coveragePercent: settings.coveragePercent,
    customWordsText: settings.customWordsText,
    whitelistWordsText: settings.whitelistWordsText,
    onlyCustomWords: settings.onlyCustomWords,
    customSoundPath: settings.customSoundPath,
  };

  const presets = useMemo<FetchrMutePreset[]>(
    () => [{ ...BUILT_IN_PRESET, name: t("fetchr_mute.preset_default") }, ...stored.presets],
    [stored.presets, t],
  );
  const status = resolvePresetStatus(presets, stored.selectedId, values);
  const active = presets.find((preset) => preset.id === status.activeId) ?? null;
  const targetPreset = presets.find((preset) => preset.id === status.targetId) ?? null;
  /** Пользовательский пресет, к которому относятся обновление, переименование и удаление. */
  const userTarget = targetPreset && targetPreset.id !== BUILT_IN_PRESET_ID ? targetPreset : null;

  const commit = useCallback(
    (next: StoredPresets) => {
      storedRef.current = next;
      setStored(next);
      try {
        saveStoredPresets(next);
      } catch (err) {
        notifyError(t("fetchr_mute.preset_save_error"), err);
      }
    },
    [t],
  );

  const takenNames = (excludeId?: string) =>
    presets.filter((preset) => preset.id !== excludeId).map((preset) => preset.name);

  const apply = (id: string) => {
    const preset = presets.find((item) => item.id === id);
    if (!preset) return;
    recordEdit(() => settings.applyValues(presetToValues(preset)));
    commit(selectPreset(storedRef.current, id));
  };

  const saveAs = (name: string): PresetNameError | null => {
    const error = validatePresetName(name, takenNames());
    if (error) return error;
    commit(addPreset(storedRef.current, presetFromValues(values, createPresetId(), name)));
    return null;
  };

  const updateTarget = () => {
    if (!userTarget) return;
    const fresh = presetFromValues(values, userTarget.id, userTarget.name);
    commit(selectPreset(updatePreset(storedRef.current, userTarget.id, fresh), userTarget.id));
  };

  const renameTarget = (name: string): PresetNameError | null => {
    if (!userTarget) return null;
    const error = validatePresetName(name, takenNames(userTarget.id));
    if (error) return error;
    commit(updatePreset(storedRef.current, userTarget.id, { name: name.trim() }));
    return null;
  };

  const deleteTarget = () => {
    if (userTarget) commit(removePreset(storedRef.current, userTarget.id));
  };

  return {
    presets,
    activeId: status.activeId,
    /** Подпись кнопки: имя пресета или «Свои настройки». */
    label: active?.name ?? t("fetchr_mute.preset_custom"),
    userTarget,
    canUpdate: Boolean(userTarget) && status.modified,
    apply,
    saveAs,
    updateTarget,
    renameTarget,
    deleteTarget,
  };
}

export type MutePresets = ReturnType<typeof useMutePresets>;
