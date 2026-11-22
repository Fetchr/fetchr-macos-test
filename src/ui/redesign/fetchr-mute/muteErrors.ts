import i18n from "@/i18n";

/** Текст исходной ошибки — для «Подробнее» и «Копировать ошибку». */
export function rawErrorText(err: unknown): string {
  if (err instanceof Error) return err.message || err.name;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

// Известные сырые ошибки бэкенда и ОС → понятная причина. Порядок важен:
// первое совпадение выигрывает. Паттерны узкие: случайное слово в пути или
// stderr не должно давать неверный совет.
const KNOWN_ERRORS: ReadonlyArray<{ pattern: RegExp; key: string }> = [
  { pattern: /нет звуковой дорожки|no audio (stream|track)/i, key: "fetchr_mute.err_no_audio" },
  { pattern: /\bffmpeg(\.exe)?\b|\bffprobe(\.exe)?\b/i, key: "fetchr_mute.err_ffmpeg" },
  {
    pattern: /no space left|not enough space|os error 112\b|недостаточно места|disk full/i,
    key: "fetchr_mute.err_disk_full",
  },
  {
    pattern: /access is denied|permission denied|os error 5\b|отказано в доступе|used by another process|os error 32\b/i,
    key: "fetchr_mute.err_access",
  },
  // Сеть раньше среды распознавания: сбой pip/скачивания модели приходит
  // вместе с упоминанием Python, но лечится интернетом, а не переустановкой.
  {
    pattern:
      /error sending request|failed to download|download failed|connection (refused|reset|aborted|closed|timed out)|connect(ion)?(timeout)?error|network is unreachable|could not resolve host|getaddrinfo|dns error|operation timed out|\bhttp (status )?[45]\d\d\b|status code:? [45]\d\d\b|нет подключения к интернету|ошибка сети/i,
    key: "fetchr_mute.err_network",
  },
  {
    pattern: /asr python environment|asr dependencies|asr server|asr failed|\bvenv\b|virtual environment|onnx asr|onnxruntime|fetchr_python/i,
    key: "fetchr_mute.err_asr_runtime",
  },
  {
    pattern: /os error [23]\b|cannot find the (file|path)|no such file|(file|path|directory) not found|файл не найден/i,
    key: "fetchr_mute.err_not_found",
  },
];

/** Понятное пользователю описание сырой ошибки. */
export function friendlyMuteError(raw: string): string {
  const known = KNOWN_ERRORS.find(({ pattern }) => pattern.test(raw));
  return i18n.t(known?.key ?? "fetchr_mute.err_unknown");
}
