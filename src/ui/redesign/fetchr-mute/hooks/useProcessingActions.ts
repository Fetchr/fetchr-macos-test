import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "@tanstack/react-router";

import { ipc } from "@/lib/ipc";
import { notifyError } from "@/lib/notify";
import { useFetchrMuteStore } from "@/stores/fetchrMute";
import { sendFileToVocalRemover } from "@/stores/vocalRemover";
import type { MuteSpan } from "@/types/job";

import { fileNameFromPath } from "../fetchrMuteSettings";
import { buildTranscriptText, transcriptFileName } from "../transcriptExport";
import type { FetchrMuteStore, FileDetails } from "../types";
import type { FetchrMuteSettingsState } from "./useFetchrMuteSettings";

interface ProcessingActionsOptions {
  store: FetchrMuteStore;
  binariesDir: string | null;
  settings: FetchrMuteSettingsState;
  fileDetails: FileDetails | null;
  /** Что заглушено с учётом неприменённых правок — для экспорта транскрипции. */
  effectiveSpans: MuteSpan[];
  /** Собрать файл с правками перед действием с ним; false — не вышло. */
  ensureApplied: () => Promise<boolean>;
}

/** Запуск, перезапуск и отмена обработки и действия с результатом. */
export function useProcessingActions({
  store,
  binariesDir,
  settings,
  fileDetails,
  effectiveSpans,
  ensureApplied,
}: ProcessingActionsOptions) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const {
    filePath,
    outputPath,
    words,
    clearManualSpans,
    clearExcludedSpans,
    setError,
    reportError,
    setNotice,
    recensoring,
    cancelProcessing: storeCancelProcessing,
    startProcessing: storeStartProcessing,
  } = store;
  const { censorMethod, customSoundPath, currentSettings } = settings;
  // «Заново» при наличии правок сначала спрашивает, сохранить ли их.
  const [rerunConfirmOpen, setRerunConfirmOpen] = useState<boolean>(false);
  useEffect(() => {
    setRerunConfirmOpen(false);
  }, [filePath]);

  // «Свой звук» без файла не запустить: показываем ошибку и не начинаем.
  const customSoundMissing = () => {
    if (censorMethod === "custom" && !customSoundPath) {
      setError(t("purevoice.custom_sound_required"));
      return true;
    }
    return false;
  };

  // Правки (в том числе загруженные из истории) стор сохраняет и применяет
  // к результату после анализа.
  const startProcessing = async () => {
    if (!filePath || !fileDetails) return;
    if (customSoundMissing()) return;
    try {
      await storeStartProcessing(binariesDir, currentSettings, fileDetails);
    } catch (err) {
      // error handled in store
    }
  };

  const runFreshAnalysis = () => {
    storeStartProcessing(binariesDir, currentSettings, fileDetails, true).catch(
      () => {
        /* ошибка показана стором */
      },
    );
  };

  // «Заново»: свежий анализ без кэша распознавания — долгий, поэтому всегда
  // спрашиваем; при наличии правок ещё и предлагаем их сохранить.
  const rerunProcessing = () => {
    if (customSoundMissing()) return;
    setRerunConfirmOpen(true);
  };

  const confirmRerun = (keepEdits: boolean) => {
    setRerunConfirmOpen(false);
    if (customSoundMissing()) return;
    if (!keepEdits) {
      clearManualSpans();
      clearExcludedSpans();
    }
    runFreshAnalysis();
  };

  const dismissRerunConfirm = () => setRerunConfirmOpen(false);

  const cancelProcessing = () => {
    storeCancelProcessing();
  };

  const revealFile = (path: string) => {
    ipc.revealFile(path).catch((err) => {
      reportError(err, {
        message: t("fetchr_mute.error_reveal"),
        retry: () => revealFile(path),
      });
    });
  };

  // В проводнике должен лежать файл со всеми правками — сначала собираем его.
  const revealOutput = async () => {
    if (!outputPath) return;
    if (recensoring) {
      setNotice(t("fetchr_mute.notice_reveal_wait_apply"));
      return;
    }
    if (!(await ensureApplied())) return;
    const freshOutput = useFetchrMuteStore.getState().outputPath;
    if (freshOutput) revealFile(freshOutput);
  };

  // Отдаём файл в другой инструмент — сначала собираем его с правками.
  const sendToVocalRemover = async () => {
    if (!outputPath) return;
    if (!(await ensureApplied())) return;
    const freshOutput = useFetchrMuteStore.getState().outputPath;
    if (!freshOutput) return;
    if (!sendFileToVocalRemover(freshOutput)) {
      setError(t("fetchr_mute.error_vocal_remover_busy"));
      return;
    }
    void navigate({ to: "/vocal-remover" });
  };

  // Экспорт транскрипции: диалог сохранения, заглушенные слова помечены **.
  const downloadTranscript = useCallback(async () => {
    if (!words || words.length === 0 || !filePath) return;
    try {
      const text = buildTranscriptText(words, effectiveSpans, {
        sourceName: fileNameFromPath(filePath),
        t,
        locale: i18n.language,
      });
      const savedPath = await ipc.saveTextFileDialog(
        transcriptFileName(filePath),
        text,
      );
      if (savedPath) {
        setNotice(t("purevoice.transcript_saved", { path: savedPath }), {
          label: t("fetchr_mute.notice_show_in_folder"),
          run: () => revealFile(savedPath),
        });
      }
    } catch (err) {
      notifyError(t("purevoice.transcript_save_error"), err);
    }
  }, [words, effectiveSpans, filePath, t, i18n.language]);

  return {
    startProcessing,
    rerunProcessing,
    rerunConfirmOpen,
    confirmRerun,
    dismissRerunConfirm,
    cancelProcessing,
    revealOutput,
    sendToVocalRemover,
    downloadTranscript,
  };
}
