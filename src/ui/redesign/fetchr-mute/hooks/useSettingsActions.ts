import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { ipc } from "@/lib/ipc";
import type { RecensorOutcome } from "@/stores/fetchrMute";
import type { FetchrMuteCensorMethod } from "@/types/job";

import type { FetchrMuteStore, FileDetails } from "../types";
import type { FetchrMuteSettingsState } from "./useFetchrMuteSettings";
import type { RecordEdit } from "./usePendingEdits";

interface SettingsActionsOptions {
  store: FetchrMuteStore;
  settings: FetchrMuteSettingsState;
  fileDetails: FileDetails | null;
  recordEdit: RecordEdit;
  /** Пересборка с текущими правками; force — даже без правок. */
  apply: (force?: boolean) => Promise<RecensorOutcome>;
  /** «Проанализировать заново» — нужен после смены аудиодорожки. */
  onRerun: () => void;
}

/**
 * Действия правой колонки. Смена способа, доли и списков при готовом
 * результате — неприменённая правка: файл пересобирается по «Применить».
 */
export function useSettingsActions({
  store,
  settings,
  fileDetails,
  recordEdit,
  apply,
  onRerun,
}: SettingsActionsOptions) {
  const { t } = useTranslation();
  const {
    outputPath,
    words,
    audioTrackIndex,
    setAudioTrackIndex,
    setOutputDir,
    setError,
    reportError,
    setNotice,
  } = store;
  const {
    setCensorMethod,
    setCoveragePercent,
    setOnlyCustomWords,
    setCustomSoundPath,
  } = settings;

  const selectMethod = (method: FetchrMuteCensorMethod) => {
    recordEdit(() => setCensorMethod(method));
  };

  const chooseCustomSound = async () => {
    setError(null);
    try {
      const file = await ipc.chooseMediaFile();
      if (file) {
        recordEdit(() => {
          setCustomSoundPath(file);
          setCensorMethod("custom");
        });
      }
    } catch (err) {
      reportError(err, {
        message: t("fetchr_mute.error_file_dialog"),
        retry: () => void chooseCustomSound(),
      });
    }
  };

  const selectCoverage = (value: number) => {
    recordEdit(() => setCoveragePercent(value));
  };

  // Дорожка, по которой разобран текущий результат: при отличии от выбранной
  // результат устарел и нужен повторный анализ.
  const trackRef = useRef(audioTrackIndex);
  trackRef.current = audioTrackIndex;
  const [resultTrack, setResultTrack] = useState<number | null>(null);
  useEffect(() => {
    setResultTrack(words ? trackRef.current : null);
  }, [words]);
  const trackNeedsRerun = resultTrack !== null && resultTrack !== audioTrackIndex;

  // Смена аудиодорожки меняет распознавание целиком, поэтому она требует
  // повторного анализа — пересборка цензуры здесь не поможет.
  const selectAudioTrack = (index: number) => {
    if (index === audioTrackIndex) return;
    setAudioTrackIndex(index);
    if ((words || outputPath) && index !== resultTrack) {
      setNotice(t("fetchr_mute.notice_audio_track_changed"), {
        label: t("fetchr_mute.reanalyze"),
        run: onRerun,
      });
    }
  };

  // Куда сохранять результат («Сохранить как»).
  const chooseOutputDir = async () => {
    try {
      const dir = await ipc.chooseDirectory();
      if (dir) setOutputDir(dir);
    } catch (err) {
      reportError(err, {
        message: t("fetchr_mute.error_folder_dialog"),
        retry: () => void chooseOutputDir(),
      });
    }
  };

  const resetOutputDir = () => setOutputDir(fileDetails?.parent || null);

  // Копия в выбранный путь — рендер со всеми текущими правками.
  const saveToTarget = () => {
    if (!outputPath) return;
    void apply(true);
  };

  const toggleOnlyCustomWords = (value: boolean) => {
    recordEdit(() => setOnlyCustomWords(value));
  };

  return {
    selectMethod,
    chooseCustomSound,
    selectCoverage,
    selectAudioTrack,
    trackNeedsRerun,
    rerun: onRerun,
    chooseOutputDir,
    resetOutputDir,
    saveToTarget,
    toggleOnlyCustomWords,
  };
}

export type SettingsActions = ReturnType<typeof useSettingsActions>;
