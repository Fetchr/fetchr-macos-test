import { getCurrentWebview } from "@tauri-apps/api/webview";
import { useEffect, useRef } from "react";

import { ipc } from "@/lib/ipc";

import { urlsFromLinkFile } from "./linkInput";

const LINK_FILE = /\.(url|txt|webloc|m3u8)$/i;

/**
 * Файл со ссылкой (.url из браузера, .txt со списком), брошенный на окно,
 * открывает «Скачать». Остальные файлы не трогаем: их ловят страницы
 * «Удалить маты» и «Vocal Remover».
 */
export function useLinkFileDrop(onUrls: (urls: string[]) => void): void {
  const handlerRef = useRef(onUrls);
  handlerRef.current = onUrls;

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let active = true;
    const handlePaths = async (paths: readonly string[]) => {
      const files = paths.filter((path) => LINK_FILE.test(path));
      if (files.length === 0) return;
      const lists = await Promise.all(
        files.map((path) =>
          ipc
            .readLinkFile(path)
            .then((text) => urlsFromLinkFile(path, text))
            .catch(() => [] as string[]),
        ),
      );
      const urls = [...new Set(lists.flat())];
      if (urls.length > 0) handlerRef.current(urls);
    };
    try {
      getCurrentWebview()
        .onDragDropEvent((event) => {
          if (event.payload.type === "drop") void handlePaths(event.payload.paths ?? []);
        })
        .then((fn) => {
          if (active) unlisten = fn;
          else fn();
        })
        .catch(() => undefined);
    } catch {
      // Вне Tauri (vite в браузере) нативного drop нет.
    }
    return () => {
      active = false;
      unlisten?.();
    };
  }, []);
}
