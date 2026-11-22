/**
 * Платформа, на которой запущено окно. WKWebView на macOS отдаёт "MacIntel"
 * в navigator.platform даже на Apple Silicon, поэтому хватает одной проверки.
 */
function detectMacOS(): boolean {
  if (typeof navigator === "undefined") return false;
  // Только для разработки: ?platform=macos показывает mac-оболочку в браузере на Windows.
  if (import.meta.env.DEV && typeof location !== "undefined") {
    const forced = new URLSearchParams(location.search).get("platform");
    if (forced) return forced === "macos";
  }
  const source = navigator.platform || navigator.userAgent || "";
  return /Mac/i.test(source) && !/iPhone|iPad|iPod/i.test(navigator.userAgent || "");
}

export const IS_MACOS = detectMacOS();

const MAC_SHORTCUT_RULES: Array<[RegExp, string]> = [
  [/Ctrl\+Shift\+/g, "⇧⌘"],
  [/Ctrl\+Alt\+/g, "⌥⌘"],
  [/Ctrl\+Enter/g, "⌘↩"],
  [/Ctrl\+(колесо|wheel)/gi, "⌘ + $1"],
  [/Ctrl\+/g, "⌘"],
];

/** HIG: на Mac сочетания пишутся символами ⌘ ⇧ ⌥, а не словами Ctrl/Shift. */
export function formatShortcuts(text: string, mac: boolean = IS_MACOS): string {
  if (!mac || !text.includes("Ctrl+")) return text;
  return MAC_SHORTCUT_RULES.reduce((result, [pattern, replacement]) => result.replace(pattern, replacement), text);
}

/** Ставит html[data-platform] до первого рендера: на нём висят mac-стили. */
export function applyPlatformAttribute(root: HTMLElement = document.documentElement): void {
  root.dataset.platform = IS_MACOS ? "macos" : "default";
  // На Mac оболочка MacOS единственная: стили нужны до первого кадра. На
  // Windows атрибут ставит AppLayout по выбранному интерфейсу.
  if (IS_MACOS) root.dataset.uiStyle = "macos";
}
