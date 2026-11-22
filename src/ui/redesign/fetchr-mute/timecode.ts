import type { TFunction } from "i18next";

const TIMECODE_PART = /^\d+(\.\d+)?$/;

// Manual mute moment by timecode (accepts seconds or mm:ss / hh:mm:ss;
// десятичная запятая — как точка: «1,5»).
export function parseTimecode(value: string): number | null {
  const v = value.trim().replaceAll(",", ".");
  if (!v) return null;
  const raw = v.split(":").map((p) => p.trim());
  if (raw.length > 3 || raw.some((p) => !TIMECODE_PART.test(p))) return null;
  const parts = raw.map((p) => Number(p));
  // Младшие части (секунды, минуты при наличии часов) — меньше 60.
  if (parts.slice(1).some((n) => n >= 60)) return null;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

// «Правки мута»: пометить начало/конец фрагмента текущей позицией плеера
// (mm:ss.d — parseTimecode понимает дробные секунды)
export function formatTimecodeInput(secs: number): string {
  // Округление до разбиения: иначе 59.97 → «00:60.0».
  const tenths = Math.round(Math.max(0, secs) * 10);
  const m = Math.floor(tenths / 600);
  const s = ((tenths % 600) / 10).toFixed(1).padStart(4, "0");
  return `${m.toString().padStart(2, "0")}:${s}`;
}

const pad2 = (value: number) => value.toString().padStart(2, "0");

/** Единый формат времени страницы: mm:ss, от часа — h:mm:ss («65:03» → «1:05:03»). NaN/Infinity — «00:00». */
export function formatTime(secs: number): string {
  if (!Number.isFinite(secs) || secs < 0) return "00:00";
  const total = Math.floor(secs);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return hours > 0
    ? `${hours}:${pad2(minutes)}:${pad2(seconds)}`
    : `${pad2(minutes)}:${pad2(seconds)}`;
}

export function formatStopwatch(totalSecs: number): string {
  const mins = Math.floor(totalSecs / 60);
  const secs = totalSecs % 60;
  return `${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
}

export function formatProcessingTime(totalSecs: number, t: TFunction): string {
  if (totalSecs < 60) {
    return t("fetchr_mute.duration_seconds", { seconds: totalSecs });
  }
  const mins = Math.floor(totalSecs / 60);
  const secs = totalSecs % 60;
  return t("fetchr_mute.duration_minutes_seconds", { minutes: mins, seconds: secs });
}

/** «1 272» с узким пробелом: обычный неразрывный в цифрах выглядит дырой. */
export function formatThousands(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}
