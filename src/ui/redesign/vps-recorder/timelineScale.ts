/** Zoom/pan maths for the recording timeline. */

/** Smallest window the user can zoom into, in seconds. */
export const MIN_VIEW_SPAN = 5;

export interface View {
  start: number;
  end: number;
}

export function clampView(view: View, total: number): View {
  const span = Math.min(Math.max(view.end - view.start, MIN_VIEW_SPAN), Math.max(total, MIN_VIEW_SPAN));
  let start = Math.max(0, Math.min(view.start, total - span));
  if (!Number.isFinite(start)) start = 0;
  return { start, end: start + span };
}

/** Zoom by `factor` keeping `anchor` (a session timecode) under the cursor. */
export function zoomAt(view: View, anchor: number, factor: number, total: number): View {
  const span = view.end - view.start;
  const nextSpan = Math.min(Math.max(span * factor, MIN_VIEW_SPAN), Math.max(total, MIN_VIEW_SPAN));
  const ratio = span > 0 ? (anchor - view.start) / span : 0.5;
  return clampView({ start: anchor - ratio * nextSpan, end: anchor - ratio * nextSpan + nextSpan }, total);
}

export function panBy(view: View, seconds: number, total: number): View {
  return clampView({ start: view.start + seconds, end: view.end + seconds }, total);
}

/** Steps that read naturally as time, unlike a plain 1-2-5 decimal ladder. */
const STEPS = [
  1, 2, 5, 10, 15, 30,
  60, 120, 300, 600, 900, 1800,
  3600, 7200, 10800, 21600, 43200, 86400,
];

export function tickStep(spanSeconds: number, targetCount: number): number {
  const rough = spanSeconds / Math.max(1, targetCount);
  return STEPS.find((step) => step >= rough) ?? STEPS[STEPS.length - 1];
}

function ticksEvery(view: View, step: number): number[] {
  const first = Math.ceil(view.start / step) * step;
  const out: number[] = [];
  for (let at = first; at <= view.end; at += step) out.push(at);
  return out;
}

export function ticksFor(view: View, targetCount: number): number[] {
  return ticksEvery(view, tickStep(view.end - view.start, targetCount));
}

/** Spacing of the unlabelled hatches between two labels.
 *
 * The largest step that divides the major one evenly and still yields at least
 * four subdivisions: simply stepping one rung down the ladder often halves the
 * major step, and a single hatch between labels is not a ruler.
 */
export function minorStepFor(majorStep: number): number {
  const fits = STEPS.filter((step) => step <= majorStep / 4 && majorStep % step === 0);
  return fits.length > 0 ? fits[fits.length - 1] : majorStep / 5;
}

export function minorTicksFor(view: View, majorStep: number, maxTicks = 400): number[] {
  const minor = minorStepFor(majorStep);
  if (minor <= 0 || (view.end - view.start) / minor > maxTicks) return [];
  return ticksEvery(view, minor).filter(
    (at) => Math.abs(at % majorStep) > 1e-6 && Math.abs((at % majorStep) - majorStep) > 1e-6,
  );
}

/** Drop the seconds once ticks are minutes apart — the digits stop carrying
 *  information and only add clutter. */
export function formatTick(seconds: number, step: number): string {
  const value = Math.max(0, Math.round(seconds));
  const h = Math.floor(value / 3600);
  const m = Math.floor((value % 3600) / 60);
  const s = value % 60;
  const pad = (part: number) => String(part).padStart(2, "0");
  if (step >= 60) return `${h}:${pad(m)}`;
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}
