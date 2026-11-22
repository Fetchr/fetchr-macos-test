/** Длительность «шоу удаления матов» и финальной карточки-итога */
export const MUTE_SHOW_MS = 4200;
export const MUTE_SHOW_FAST_MS = 1600; // когда матов не найдено
export const MUTE_SUMMARY_HOLD_MS = 1200;
export const EQ_BAR_COUNT = 72;
/** Столбиков в волне шкалы плеера и экрана анализа. */
export const WAVE_BINS = 140;
export const FETCHR_MUTE_TIMING_SETTINGS_VERSION = 7;

export const VIDEO_EXTENSIONS = [
  "mp4",
  "mkv",
  "webm",
  "avi",
  "mov",
  "m4v",
  "flv",
  "3gp",
  "ts",
];

/** Аудио, которое принимает выбор файлов и drag&drop (как фильтр диалога в Rust). */
export const AUDIO_EXTENSIONS = ["mp3", "wav", "flac", "ogg", "m4a", "aac", "opus"];

/** Чёрный список по умолчанию, пока пользователь не сохранил свой. */
export const DEFAULT_CUSTOM_WORDS_TEXT =
  "пиздюк, пенис, долбоеб, ебанный, ахуеть, ебанутая, пидорас, гандон, похуй, ебнутые, дауны, вахуе, в ахуе, очко, пиздец";

export const DROP_FORMATS = ["MP4", "MKV", "WebM", "MP3", "WAV", "FLAC"];

/** Доли глушения слова; подписи — в CoverageSection (i18n). */
export const COVERAGE_OPTIONS = [30, 50, 75, 100] as const;
export type CoverageOption = (typeof COVERAGE_OPTIONS)[number];

/** Фазы анализа для кинематографичного HUD; подписи — в AnalysisHud (i18n). */
export const ANALYSIS_STEP_DEFS = [
  { id: "models", at: 30 },
  { id: "audio", at: 34 },
  { id: "speech", at: 90 },
  { id: "render", at: 100 },
] as const;
export type AnalysisStepId = (typeof ANALYSIS_STEP_DEFS)[number]["id"];

export function isVideoExtension(ext: string): boolean {
  return VIDEO_EXTENSIONS.includes(ext.toLowerCase());
}

// Helper to check if history path is video
export function isVideoFile(path: string): boolean {
  const ext = path.split(".").pop()?.toLowerCase() || "";
  return VIDEO_EXTENSIONS.includes(ext);
}

/** Видео или аудио, которое можно обработать (по расширению). */
export function isSupportedMediaPath(path: string): boolean {
  const name = path.split(/[\\/]/).pop() ?? "";
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return false;
  const ext = name.slice(dot + 1).toLowerCase();
  return VIDEO_EXTENSIONS.includes(ext) || AUDIO_EXTENSIONS.includes(ext);
}
