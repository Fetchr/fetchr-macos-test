import { useCallback, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "@tanstack/react-router";

import { ipc } from "@/lib/ipc";
import type { FetchrMuteSettings } from "@/types/job";

import { buildBatchJobSpec, newBatchFiles, type BatchFile } from "../batchFiles";
import type { FetchrMuteStore } from "../types";

interface BatchFilesOptions {
  store: FetchrMuteStore;
  binariesDir: string | null;
}

/**
 * Пакетная обработка: список файлов, папка результатов и постановка каждой
 * обработки отдельной задачей в очередь.
 */
export function useBatchFiles({ store, binariesDir }: BatchFilesOptions) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { setError } = store;
  const [files, setFiles] = useState<BatchFile[]>([]);
  const [outputDir, setOutputDir] = useState<string | null>(null);
  const [queuing, setQueuing] = useState(false);
  // Источник правды для слушателя drag&drop и нескольких правок подряд.
  const filesRef = useRef(files);

  const commitFiles = useCallback((update: (prev: BatchFile[]) => BatchFile[]) => {
    const next = update(filesRef.current);
    filesRef.current = next;
    setFiles(next);
  }, []);

  const add = useCallback(
    (paths: string[]) => {
      const fresh = newBatchFiles(filesRef.current, paths);
      if (fresh.length === 0) return;
      commitFiles((prev) => [...prev, ...fresh]);
      // Размер — подсказка в списке: не узнали, значит «—».
      ipc
        .mediaFileSizes(fresh.map((file) => file.path))
        .then((sizes) => {
          const byPath = new Map(fresh.map((file, index) => [file.path, sizes[index] ?? null]));
          commitFiles((prev) =>
            prev.map((file) => (byPath.has(file.path) ? { ...file, size: byPath.get(file.path) ?? null } : file)),
          );
        })
        .catch(() => {});
    },
    [commitFiles],
  );

  const remove = (path: string) => commitFiles((prev) => prev.filter((file) => file.path !== path));

  const clear = () => {
    commitFiles(() => []);
    setOutputDir(null);
  };

  const chooseOutputDir = async () => {
    try {
      const dir = await ipc.chooseDirectory();
      if (dir) setOutputDir(dir);
    } catch (err) {
      setError(String(err));
    }
  };

  const resetOutputDir = () => setOutputDir(null);

  /** По задаче на файл; поставленные убираются из списка, даже если дальше ошибка. */
  const enqueueAll = async (settings: FetchrMuteSettings) => {
    if (settings.censor_method === "custom" && !settings.custom_sound_path) {
      setError(t("purevoice.custom_sound_required"));
      return;
    }
    setError(null);
    setQueuing(true);
    const queued = new Set<string>();
    try {
      for (const file of filesRef.current) {
        await ipc.enqueueJob(buildBatchJobSpec({ path: file.path, settings, outputDir, binariesDir }));
        queued.add(file.path);
      }
      clear();
      void navigate({ to: "/queue" });
    } catch (err) {
      commitFiles((prev) => prev.filter((file) => !queued.has(file.path)));
      setError(t("fetchr_mute.batch_enqueue_error", { error: String(err) }));
    } finally {
      setQueuing(false);
    }
  };

  return {
    files,
    size: files.length,
    outputDir,
    queuing,
    add,
    remove,
    clear,
    chooseOutputDir,
    resetOutputDir,
    enqueueAll,
  };
}

export type BatchFiles = ReturnType<typeof useBatchFiles>;
