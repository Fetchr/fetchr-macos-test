import { useCallback, useEffect } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { toast } from "sonner";

import type { UpdateStatus } from "@/lib/ipc";
import { IS_MACOS } from "@/lib/platform";
import { useBoot } from "@/stores/boot";
import { useUpdater } from "@/stores/updater";

/**
 * Сервер отдаёт один манифест на все платформы, и ссылка в нём ведёт на
 * установщик Windows. На Mac нового .dmg по ней нет — ведём на сайт.
 */
export const MANUAL_UPDATE_URL = "https://fetchr.fun";
const SEEN_KEY = "fetchr-update-notice-seen";

/** Показать уведомление: обновление есть, но поставить его сам Fetchr не может. */
export function needsManualNotice(status: UpdateStatus | null, seenVersion: string | null): boolean {
  if (!status?.available || status.installable || !status.version) return false;
  return status.version !== seenVersion;
}

function readSeen(): string | null {
  try {
    return localStorage.getItem(SEEN_KEY);
  } catch {
    return null;
  }
}

function markSeen(version: string): void {
  try {
    localStorage.setItem(SEEN_KEY, version);
  } catch {
    // Без хранилища уведомление просто повторится при следующем запуске.
  }
}

function openDownloadPage(): void {
  openUrl(MANUAL_UPDATE_URL).catch((error: unknown) => {
    console.warn("Failed to open download page:", error);
    toast.error(`Откройте ${MANUAL_UPDATE_URL} в браузере`);
  });
}

function showNotice(version: string): void {
  toast(`Вышла версия ${version}`, {
    description: IS_MACOS
      ? "Автоматически на Mac она не ставится. Скачайте новую версию с сайта."
      : "Скачайте новую версию с сайта.",
    duration: 15000,
    action: { label: "Скачать", onClick: openDownloadPage },
  });
}

/**
 * Уведомление о новой версии там, где автоустановки нет (macOS, Linux).
 * Показывается один раз на версию. `checkNow` — для пункта меню
 * «Проверить обновления…»: отвечает всегда, даже если версия последняя.
 */
export function useManualUpdateNotice(): { checkNow: () => void } {
  const settled = useBoot((s) => s.settled);
  const status = useUpdater((s) => s.status);

  useEffect(() => {
    if (!settled || !status?.version || !needsManualNotice(status, readSeen())) return;
    markSeen(status.version);
    showNotice(status.version);
  }, [settled, status]);

  const checkNow = useCallback(() => {
    void useUpdater
      .getState()
      .check()
      .then((next) => {
        if (!next) {
          toast.error("Не удалось проверить обновления. Проверьте интернет и попробуйте ещё раз.");
          return;
        }
        if (next.available && next.version && !next.installable) {
          markSeen(next.version);
          showNotice(next.version);
          return;
        }
        if (!next.available) toast.success(`У вас последняя версия ${next.current_version}`);
      });
  }, []);

  return { checkNow };
}
