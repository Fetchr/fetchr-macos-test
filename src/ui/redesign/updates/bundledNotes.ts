import type { UpdatePage, UpdateStatus } from "@/lib/ipc";

interface ReleaseNotesFile {
  ru?: string;
  en?: string;
  pages?: Record<string, UpdatePage[]>;
}

/** `__APP_VERSION__` приходит как «v0.8.1», заметки подписаны «0.8.1»: из-за
 *  этой разницы окно «Что нового» не открывалось ни в одной версии. */
export const bareVersion = (version: string) => version.trim().replace(/^v/i, "");
export const APP_VERSION = bareVersion(__APP_VERSION__);

// Заметки к релизам вшиваются в сборку: после обновления окно «Что нового»
// показывает их без сервера, даже офлайн.
const files = import.meta.glob<ReleaseNotesFile>("/release-notes/v*.json", { eager: true, import: "default" });

/**
 * Данные для окна «Что нового» после обновления: заметки текущей версии в
 * том же виде, что и статус обновления с сервера. Нет заметок — null.
 */
export function bundledWhatsNew(previousVersion: string | null): UpdateStatus | null {
  const notes = files[`/release-notes/v${APP_VERSION}.json`];
  if (!notes) return null;
  return {
    configured: true,
    available: false,
    installable: false,
    current_version: previousVersion ? bareVersion(previousVersion) : "",
    version: APP_VERSION,
    notes: notes.ru ?? null,
    notes_i18n: { ru: notes.ru ?? "", en: notes.en ?? notes.ru ?? "" },
    pages_i18n: notes.pages ?? null,
    installer_url: null,
    installer_sha256: null,
    size_bytes: null,
    published_at: null,
    message: null,
  } as UpdateStatus;
}
