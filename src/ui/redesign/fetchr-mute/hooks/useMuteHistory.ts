import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { ipc } from "@/lib/ipc";
import { notifyError } from "@/lib/notify";
import { useFetchrMuteStore } from "@/stores/fetchrMute";
import { useQueue } from "@/stores/queue";
import type { FetchrMuteSettings, HistoryItem, WordHit } from "@/types/job";

import type { FetchrMuteStore, HistoryMissing } from "../types";

// Best-effort валидация: помечаем элементы с удалёнными файлами,
// чтобы не открывать их вслепую.
async function validateHistoryPaths(items: HistoryItem[]): Promise<HistoryMissing> {
  const paths = items.flatMap((item) => [item.filePath, item.outputPath]);
  const flags = await ipc.mutePathsExist(paths);
  return Object.fromEntries(
    items.map((item, index) => [
      item.id,
      { source: !flags[index * 2], output: !flags[index * 2 + 1] },
    ]),
  );
}

// Транскрипция хранится sidecar-файлом и грузится лениво.
async function loadHistoryWords(item: HistoryItem): Promise<WordHit[]> {
  const itemWords: WordHit[] = item.words ?? [];
  if (itemWords.length > 0) return itemWords;
  try {
    return await ipc.getMuteHistoryWords(item.id);
  } catch {
    return [];
  }
}

/** История обработок: загрузка, валидация путей, открытие и удаление. */
export function useMuteHistory(
  store: FetchrMuteStore,
  applyHistorySettings: (settings: FetchrMuteSettings) => void,
  restoreGlobalSettings: () => void,
) {
  const { t } = useTranslation();
  // Токен запроса: быстрый двойной клик по разным элементам не смешивает
  // файл одного с транскрипцией/правками другого — побеждает последний.
  const loadTokenRef = useRef(0);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  // Валидация путей истории: помечаем элементы с удалённым исходником/результатом.
  const [historyMissing, setHistoryMissing] = useState<HistoryMissing>({});
  const [currentRecognitionVersion, setCurrentRecognitionVersion] = useState<
    number | null
  >(null);

  // Текущая версия кэша распознавания — помечаем историю от старого анализа.
  useEffect(() => {
    ipc
      .getMuteRecognitionVersion()
      .then(setCurrentRecognitionVersion)
      .catch(() => {});
  }, []);

  // Fetch history from backend helper
  const refreshHistory = () => {
    ipc
      .getMuteHistory()
      .then(async (items) => {
        setHistory(items);
        try {
          setHistoryMissing(await validateHistoryPaths(items));
        } catch {
          /* валидация необязательна */
        }
      })
      .catch((err) =>
        notifyError(t("purevoice.history_load_error"), err),
      );
  };

  // Initial history load
  useEffect(() => {
    refreshHistory();
  }, []);

  // Watch queue mute jobs done count, and reload history when background tasks finish
  const doneMuteJobsCount = useQueue(
    (s) =>
      s.jobs.filter((j) => j.status === "done" && j.spec.fetchr_mute_enabled)
        .length,
  );
  useEffect(() => {
    refreshHistory();
  }, [doneMuteJobsCount]);

  // Reload history when inline task starts/finishes or recensors
  const cacheBusterVal = useFetchrMuteStore((s) => s.cacheBuster);
  useEffect(() => {
    refreshHistory();
  }, [cacheBusterVal]);

  const loadHistoryItem = async (item: HistoryItem) => {
    const token = loadTokenRef.current + 1;
    loadTokenRef.current = token;
    const isStale = () => loadTokenRef.current !== token;
    store.setError(null);
    store.setNotice(null);

    // Не открываем вслепую: исходник мог быть перемещён, результат — удалён.
    let outputExists = true;
    try {
      const [sourceExists, outExists] = await ipc.mutePathsExist([
        item.filePath,
        item.outputPath,
      ]);
      if (isStale()) return;
      outputExists = outExists;
      if (!sourceExists) {
        store.setError(t("fetchr_mute.error_history_source_missing", { path: item.filePath }));
        return;
      }
    } catch {
      // Проверка недоступна — грузим как раньше.
    }
    // Транскрипция грузится до первых записей в стор: так второй клик,
    // пришедший во время загрузки, не застанет полусобранный элемент.
    const itemWords = await loadHistoryWords(item);
    if (isStale()) return;

    // Сброс правок (manualSpans/excludedSpans/pendingOutputPath) предыдущего
    // файла — иначе recensor нового файла применит чужие ручные фрагменты.
    store.clearResults();
    store.setFilePath(item.filePath);
    store.setWords(itemWords.length > 0 ? itemWords : null);
    store.setSpans(item.spans);
    store.setManualSpans(item.manualSpans ?? []);
    store.setExcludedSpans(item.excludedSpans ?? []);
    if (outputExists) {
      store.setOutputPath(item.outputPath);
    } else {
      // Результат удалён с диска: отдаём транскрипцию и настройки,
      // но не подсовываем плееру несуществующий файл.
      store.setOutputPath(null);
      store.setNotice(t("fetchr_mute.notice_history_output_missing"));
    }
    store.setCacheBuster(Date.now());
    store.setMediaError(null);

    // Настройки элемента истории действуют только в этой сессии и не
    // перезаписывают словари и способ пользователя.
    if (item.settings) {
      applyHistorySettings(item.settings);
      store.setAudioTrackIndex(item.settings.audio_track_index ?? 0);
    } else {
      restoreGlobalSettings();
      store.setAudioTrackIndex(0);
    }
    store.setError(null);
  };

  const deleteHistoryItem = async (id: string) => {
    try {
      await ipc.deleteMuteHistoryItem(id);
      refreshHistory();
    } catch (err) {
      notifyError(t("purevoice.history_delete_error"), err);
    }
  };

  return {
    history,
    historyMissing,
    currentRecognitionVersion,
    loadHistoryItem,
    deleteHistoryItem,
  };
}
