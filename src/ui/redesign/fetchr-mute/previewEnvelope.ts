import type { MuteSpan } from "@/types/job";

/**
 * Огибающая приблизительного превью — числовой двойник reference_gain_at из
 * бэкенда (src-tauri/src/jobs/fetchr_mute.rs) для «Адаптивного» профиля:
 * косинусная рампа вниз 55 мс ДО начала спана, тишина внутри, косинусный
 * возврат 15 мс ПОСЛЕ конца. Спаны — уже ядра (доля слова в них учтена).
 */
export const PREVIEW_FADE_OUT_S = 0.055;
export const PREVIEW_FADE_IN_S = 0.015;
/** Писк: синус 1 кГц с громкостью 0.28, как в рендере ffmpeg. */
export const BEEP_FREQUENCY_HZ = 1000;
export const BEEP_GAIN = 0.28;

/** Точек на одну косинусную рампу при кусочно-линейном приближении. */
const RAMP_STEPS = 6;
const TIME_EPS = 1e-6;

export interface EnvelopePoint {
  time: number;
  gain: number;
}

function spanGain(time: number, span: MuteSpan): number {
  const fadeStart = Math.max(0, span.start - PREVIEW_FADE_OUT_S);
  const rampDown = Math.max(span.start - fadeStart, 0.001);
  const fadeEnd = span.end + PREVIEW_FADE_IN_S;
  if (time < fadeStart || time >= fadeEnd) return 1;
  if (time < span.start) {
    return 0.5 * (1 + Math.cos((Math.PI * (time - fadeStart)) / rampDown));
  }
  if (time < span.end) return 0;
  return 0.5 * (1 - Math.cos((Math.PI * (time - span.end)) / PREVIEW_FADE_IN_S));
}

/** Громкость исходника в момент `time`: минимум по всем спанам. */
export function gainAt(time: number, spans: MuteSpan[]): number {
  let gain = 1;
  for (const span of spans) {
    if (time < span.start - PREVIEW_FADE_OUT_S || time >= span.end + PREVIEW_FADE_IN_S) {
      continue;
    }
    gain = Math.min(gain, spanGain(time, span));
    if (gain === 0) return 0;
  }
  return Math.min(1, Math.max(0, gain));
}

function rampTimes(from: number, to: number): number[] {
  return Array.from({ length: RAMP_STEPS + 1 }, (_, k) => from + ((to - from) * k) / RAMP_STEPS);
}

/**
 * Кусочно-линейная огибающая на отрезке [from, to] для планирования
 * AudioParam: первая точка — `from`, дальше изломы рамп и границы ядер.
 * Лишние точки на плато единицы/нуля выброшены.
 */
export function envelopePoints(spans: MuteSpan[], from: number, to: number): EnvelopePoint[] {
  if (!(to > from)) return [{ time: from, gain: gainAt(from, spans) }];
  const relevant = spans.filter(
    (span) => span.start - PREVIEW_FADE_OUT_S < to && span.end + PREVIEW_FADE_IN_S > from,
  );
  const times = relevant.flatMap((span) => [
    ...rampTimes(Math.max(0, span.start - PREVIEW_FADE_OUT_S), span.start),
    ...rampTimes(span.end, span.end + PREVIEW_FADE_IN_S),
  ]);
  const sorted = [from, to, ...times]
    .filter((time) => time >= from && time <= to)
    .sort((a, b) => a - b)
    .filter((time, i, all) => i === 0 || time - all[i - 1] > TIME_EPS);
  const points = sorted.map((time) => ({ time, gain: gainAt(time, relevant) }));
  return points.filter(
    (point, i) =>
      i === 0 ||
      i === points.length - 1 ||
      !(points[i - 1].gain === point.gain && points[i + 1].gain === point.gain),
  );
}
