import { useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

import { IS_MACOS } from "@/lib/platform";

/** Число активных задач на значке в Dock, как у Safari и App Store. */
export function useDockBadge(count: number): void {
  useEffect(() => {
    if (!IS_MACOS) return;
    const value = count > 0 ? count : undefined;
    const warn = (error: unknown) => console.warn("Dock badge unavailable:", error);
    try {
      // getCurrentWindow бросает синхронно, если окна Tauri нет (браузер, тесты).
      getCurrentWindow().setBadgeCount(value).catch(warn);
    } catch (error) {
      warn(error);
    }
  }, [count]);
}
