import { useEffect, useState } from "react";

import { ipc } from "@/lib/ipc";

const CHECK_DELAY_MS = 300;

/** Разделитель как в самой папке: на macOS «/», на Windows «\». */
function joinPath(dir: string, name: string): string {
  if (/[\\/]$/.test(dir)) return `${dir}${name}`;
  const separator = /^[A-Za-z]:|^\\\\/.test(dir) ? "\\" : "/";
  return `${dir}${separator}${name}`;
}

function samePath(a: string, b: string): boolean {
  return a.replace(/\//g, "\\").toLowerCase() === b.replace(/\//g, "\\").toLowerCase();
}

/**
 * Файл с выбранным именем уже есть в папке — бэкенд добавит к имени номер.
 * Свой же результат (текущий outputPath) конфликтом не считается.
 */
export function useOutputConflict(
  dir: string | null,
  name: string,
  currentOutputPath: string | null,
): boolean {
  const [conflict, setConflict] = useState(false);

  useEffect(() => {
    const trimmed = name.trim();
    if (!dir || !trimmed) {
      setConflict(false);
      return;
    }
    const target = joinPath(dir, trimmed);
    if (currentOutputPath && samePath(target, currentOutputPath)) {
      setConflict(false);
      return;
    }
    let active = true;
    const timer = window.setTimeout(() => {
      ipc
        .mutePathsExist([target])
        .then(([exists]) => {
          if (active) setConflict(Boolean(exists));
        })
        .catch(() => {
          if (active) setConflict(false);
        });
    }, CHECK_DELAY_MS);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [dir, name, currentOutputPath]);

  return conflict;
}
