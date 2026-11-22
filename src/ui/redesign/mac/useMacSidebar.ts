import { useCallback, useState } from "react";

const STORAGE_KEY = "fetchr-mac-sidebar";

function readInitial(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) !== "hidden";
  } catch {
    return true;
  }
}

/** Видимость боковой панели переживает перезапуск, как в Finder. */
export function useMacSidebar(): { visible: boolean; toggle: () => void } {
  const [visible, setVisible] = useState(readInitial);

  const toggle = useCallback(() => {
    setVisible((current) => {
      const next = !current;
      try {
        localStorage.setItem(STORAGE_KEY, next ? "visible" : "hidden");
      } catch {
        // Хранилище недоступно — панель просто не запомнит состояние.
      }
      return next;
    });
  }, []);

  return { visible, toggle };
}
