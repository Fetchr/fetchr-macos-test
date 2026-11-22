import { useEffect, useMemo, useRef, useState } from "react";
import type React from "react";
import { useTranslation } from "react-i18next";
import { getCurrentWebview } from "@tauri-apps/api/webview";

import i18n from "@/i18n";
import { ipc } from "@/lib/ipc";
import { useFetchrMuteStore } from "@/stores/fetchrMute";

import { partitionMediaPaths, routeMediaPaths } from "../batchFiles";
import { isVideoExtension } from "../constants";
import type { FetchrMuteStore, FileDetails } from "../types";

/** Пакет файлов: сколько в нём сейчас и как добавить новые. */
interface BatchTarget {
  size: number;
  add: (paths: string[]) => void;
}

/**
 * Имя файла и папка. Разделитель берётся из самого пути: на macOS и Linux
 * обратный слэш давал «\Users\…\Downloads», и туда нельзя было сохранить.
 */
export function parseFileDetails(filePath: string): FileDetails | null {
  if (!filePath) return null;
  const windowsPath = /^[A-Za-z]:[\\/]/.test(filePath) || filePath.startsWith("\\\\");
  const separator = windowsPath ? "\\" : "/";
  const parts = filePath.split(windowsPath ? /[\\/]/ : "/");
  const name = parts[parts.length - 1] || "";
  const joined = parts.slice(0, parts.length - 1).join(separator);
  // Корень диска: «C:» без слэша — это текущая папка диска, а не корень.
  // Корень Unix: «/file.mp4» даёт пустую папку, а нужен «/».
  const parent = /^[A-Za-z]:$/.test(joined) ? `${joined}\\` : joined === "" && !windowsPath ? "/" : joined;
  const dotIndex = name.lastIndexOf(".");
  const stem = dotIndex !== -1 ? name.slice(0, dotIndex) : name;
  const ext = dotIndex !== -1 ? name.slice(dotIndex + 1) : "";
  return { name, parent, stem, ext };
}

/**
 * Исходный файл: выбор, drag&drop, закрытие и путь сохранения по умолчанию.
 * `onFileReset` вызывается, когда текущий файл закрыт или заменён новым
 * (например, чтобы вернуть настройки пользователя после файла из истории).
 * Несколько файлов (или новые файлы при открытом пакете) уходят в `batch`.
 */
export function useSourceFile(
  store: FetchrMuteStore,
  binariesDir: string | null,
  onFileReset: () => void,
  batch: BatchTarget,
) {
  const { t } = useTranslation();
  const {
    filePath,
    setFilePath,
    setError,
    reportError,
    setNotice,
    clearResults,
    loadAudioTracks,
    setAudioTracks,
    setAudioTrackIndex,
    setOutputDir,
    setOutputName,
  } = store;
  const [dragActive, setDragActive] = useState<boolean>(false);
  // Слушатель drag&drop живёт весь срок страницы — свежий колбэк берём из ref.
  const onFileResetRef = useRef(onFileReset);
  onFileResetRef.current = onFileReset;

  // Новый файл: прежние результаты, правки, дорожка и настройки истории не переносятся.
  const openNewFile = (path: string) => {
    setError(null);
    clearResults();
    setAudioTrackIndex(0);
    onFileResetRef.current();
    setFilePath(path);
  };

  // Выбор и drag&drop: неподдерживаемые файлы отбрасываются с уведомлением,
  // один файл — одиночный сценарий, несколько — пакет.
  const acceptPaths = (paths: string[]) => {
    const { supported, skipped } = partitionMediaPaths(paths);
    if (skipped > 0) setNotice(t("fetchr_mute.batch_skipped", { count: skipped }));
    const route = routeMediaPaths(supported.length, batch.size);
    if (route === "single") openNewFile(supported[0]);
    if (route === "batch") batch.add(supported);
  };
  const acceptPathsRef = useRef(acceptPaths);
  acceptPathsRef.current = acceptPaths;

  const fileDetails = useMemo(() => parseFileDetails(filePath), [filePath]);

  // Determine media type
  const isVideo = useMemo(() => {
    if (!fileDetails) return false;
    return isVideoExtension(fileDetails.ext);
  }, [fileDetails]);

  // Аудиодорожки исходника для селектора: перечитываем при смене файла.
  useEffect(() => {
    if (!filePath) return;
    void loadAudioTracks(binariesDir);
  }, [filePath, binariesDir, loadAudioTracks]);

  // Куда и как сохранять по умолчанию: папка исходника и прежний суффикс.
  // Пользователь меняет и то и другое, но поля никогда не пустые.
  useEffect(() => {
    if (!fileDetails) return;
    setOutputDir(fileDetails.parent || null);
    setOutputName(
      `${fileDetails.stem}_fetchr_mute${fileDetails.ext ? `.${fileDetails.ext}` : ""}`,
    );
  }, [fileDetails, setOutputDir, setOutputName]);

  // Native Tauri drag&drop — HTML5 File objects have no .path in Tauri v2,
  // so real filesystem paths come from the webview onDragDrop event.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let active = true;
    getCurrentWebview()
      .onDragDropEvent((event) => {
        const { isPageActive, filePath: currentFilePath } =
          useFetchrMuteStore.getState();
        if (!isPageActive) return;
        const p = event.payload;
        // Файл уже открыт: молча не игнорируем, а объясняем, что сделать.
        if (currentFilePath) {
          if (p.type === "drop" && p.paths?.length) {
            useFetchrMuteStore
              .getState()
              .setNotice(i18n.t("fetchr_mute.notice_drop_file_open"));
          }
          return;
        }
        if (p.type === "enter" || p.type === "over") {
          setDragActive(true);
        } else if (p.type === "leave") {
          setDragActive(false);
        } else if (p.type === "drop") {
          setDragActive(false);
          if (p.paths?.length) acceptPathsRef.current(p.paths);
        }
      })
      .then((fn) => {
        if (active) unlisten = fn;
        else fn();
      })
      .catch((err) =>
        console.error("Failed to attach drag&drop listener:", err),
      );
    return () => {
      active = false;
      unlisten?.();
    };
  }, []);

  // Выбор файлов: можно сразу несколько.
  const chooseLocalFiles = async () => {
    setError(null);
    try {
      const files = await ipc.chooseMediaFiles();
      if (files.length > 0) acceptPaths(files);
    } catch (err) {
      reportError(err, {
        message: t("fetchr_mute.error_file_dialog"),
        retry: () => void chooseLocalFiles(),
      });
    }
  };

  // Подсветку зоны ведут события webview выше: HTML5 dragleave приходит и при
  // переходе на дочерние элементы, из-за чего зона мигала.
  const handleDrag = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };

  // Real path handling is done by the webview onDragDrop listener above.
  // This only suppresses the browser default (which would open the file).
  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
  };

  const clearFile = () => {
    setFilePath("");
    setError(null);
    clearResults();
    setAudioTracks([]);
    setAudioTrackIndex(0);
    setOutputDir(null);
    setOutputName("");
    onFileResetRef.current();
  };

  return {
    fileDetails,
    isVideo,
    dragActive,
    chooseLocalFiles,
    handleDrag,
    handleDrop,
    clearFile,
  };
}
