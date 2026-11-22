/**
 * Pure geometry and segment maths for the sponsor timeline.
 *
 * Kept out of the component so it can be reasoned about (and tested) without a
 * DOM: every pixel the timeline draws comes from these functions.
 */

import type { BlurZone } from "@/types/job";

/** A stretch of the video where a tracked banner is (or is not) visible. */
export interface TrackSegment {
  startSec: number;
  endSec: number;
  /** Lowest keyframe confidence inside the segment, 0..1. */
  confidence: number;
}

export interface ZoneTrack {
  zoneId: string;
  name: string;
  /** Ranges where the banner was found. */
  visible: TrackSegment[];
  /** Ranges inside the tracked span where it was lost. */
  gaps: TrackSegment[];
  startSec: number;
  endSec: number;
}

/** Viewport: which slice of the video is on screen, and at what scale. */
export interface View {
  /** Timestamp at the left edge, seconds. */
  startSec: number;
  /** Visible span, seconds. */
  spanSec: number;
  /** Width of the drawing area, CSS pixels. */
  widthPx: number;
}

export function timeToX(view: View, timeSec: number): number {
  if (view.spanSec <= 0) return 0;
  return ((timeSec - view.startSec) / view.spanSec) * view.widthPx;
}

export function xToTime(view: View, x: number): number {
  if (view.widthPx <= 0) return view.startSec;
  return view.startSec + (x / view.widthPx) * view.spanSec;
}

/**
 * Zooms around a fixed point so the timestamp under the cursor stays put —
 * the behaviour every NLE has and the thing that makes wheel-zoom feel right.
 */
export function zoomAround(
  view: View,
  anchorX: number,
  factor: number,
  durationSec: number,
): View {
  const anchorTime = xToTime(view, anchorX);
  // Never zoom out past the whole video, nor in past ~0.5 s across the panel.
  const spanSec = clamp(view.spanSec * factor, Math.min(0.5, durationSec), durationSec);
  const ratio = view.widthPx > 0 ? anchorX / view.widthPx : 0;
  return clampView({ ...view, startSec: anchorTime - ratio * spanSec, spanSec }, durationSec);
}

export function panBy(view: View, deltaSec: number, durationSec: number): View {
  return clampView({ ...view, startSec: view.startSec + deltaSec }, durationSec);
}

export function clampView(view: View, durationSec: number): View {
  const spanSec = clamp(view.spanSec, Math.min(0.5, durationSec), Math.max(durationSec, 0.5));
  const startSec = clamp(view.startSec, 0, Math.max(0, durationSec - spanSec));
  return { ...view, startSec, spanSec };
}

/**
 * Tick spacing chosen from a ladder of human-readable intervals, so labels read
 * 0:30 / 1:00 / 1:30 rather than 0:37 / 1:14.
 */
const TICK_LADDER = [
  1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 21600,
];

export function chooseTickStep(view: View, minLabelPx = 78): number {
  if (view.widthPx <= 0 || view.spanSec <= 0) return TICK_LADDER[TICK_LADDER.length - 1];
  const minStepSec = (minLabelPx / view.widthPx) * view.spanSec;
  return TICK_LADDER.find((step) => step >= minStepSec) ?? TICK_LADDER[TICK_LADDER.length - 1];
}

export interface Tick {
  timeSec: number;
  x: number;
  major: boolean;
}

export function buildTicks(view: View, durationSec: number): Tick[] {
  const step = chooseTickStep(view);
  const minor = step / (step % 60 === 0 ? 4 : 5);
  const first = Math.floor(view.startSec / minor) * minor;
  const ticks: Tick[] = [];
  // Hard cap: a pathological view must not spin the main thread building ticks.
  for (let time = first; time <= view.startSec + view.spanSec && ticks.length < 400; time += minor) {
    if (time < 0 || time > durationSec) continue;
    // Floating-point accumulation drifts; snap before testing for a major tick.
    const snapped = Math.round(time / minor) * minor;
    ticks.push({
      timeSec: snapped,
      x: timeToX(view, snapped),
      major: Math.abs(snapped / step - Math.round(snapped / step)) < 1e-6,
    });
  }
  return ticks;
}

/**
 * Turns a zone's tracking result into drawable lanes.
 *
 * Keyframes are sparse — the tracker only stores one when the banner actually
 * moves — so they cannot be treated as samples. The tracked span is
 * `start_time_sec .. end_time_sec`, and `gaps` (from the tracker report) carve
 * the holes out of it.
 */
export function buildZoneTrack(
  zone: BlurZone,
  name: string,
  gaps: [number, number][] | undefined,
): ZoneTrack | null {
  const tracking = zone.tracking;
  if (!tracking || !tracking.enabled) return null;
  const keyframes = [...(tracking.keyframes ?? [])].sort((a, b) => a.time_sec - b.time_sec);
  if (keyframes.length === 0) return null;

  const startSec = Math.min(tracking.start_time_sec ?? keyframes[0].time_sec, keyframes[0].time_sec);
  const endSec = Math.max(
    tracking.end_time_sec ?? keyframes[keyframes.length - 1].time_sec,
    keyframes[keyframes.length - 1].time_sec,
  );

  const holes = (gaps ?? [])
    .map(([from, to]) => ({ from: Math.max(from, startSec), to: Math.min(to, endSec) }))
    .filter((hole) => hole.to > hole.from)
    .sort((a, b) => a.from - b.from);

  const visible: TrackSegment[] = [];
  let cursor = startSec;
  for (const hole of holes) {
    if (hole.from > cursor) {
      visible.push({ startSec: cursor, endSec: hole.from, confidence: 0 });
    }
    cursor = Math.max(cursor, hole.to);
  }
  if (endSec > cursor) visible.push({ startSec: cursor, endSec, confidence: 0 });

  for (const segment of visible) {
    segment.confidence = lowestConfidence(keyframes, segment.startSec, segment.endSec);
  }

  return {
    zoneId: zone.id,
    name,
    visible,
    gaps: holes.map((hole) => ({ startSec: hole.from, endSec: hole.to, confidence: 0 })),
    startSec,
    endSec,
  };
}

function lowestConfidence(
  keyframes: { time_sec: number; confidence?: number }[],
  startSec: number,
  endSec: number,
): number {
  let lowest = 1;
  let found = false;
  for (const frame of keyframes) {
    if (frame.time_sec < startSec || frame.time_sec > endSec) continue;
    found = true;
    lowest = Math.min(lowest, frame.confidence ?? 1);
  }
  return found ? lowest : 1;
}

/** Timecode for ruler labels: drops the hour component on short videos. */
export function formatTick(timeSec: number, durationSec: number): string {
  const total = Math.max(0, Math.round(timeSec));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (durationSec >= 3600) {
    return `${hours}:${pad(minutes)}:${pad(seconds)}`;
  }
  return `${minutes}:${pad(seconds)}`;
}

/** Precise readout next to the playhead, with fractional seconds when zoomed in. */
export function formatPlayhead(timeSec: number, spanSec: number): string {
  const total = Math.max(0, timeSec);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const showFraction = spanSec < 120;
  const secondsText = showFraction ? seconds.toFixed(2).padStart(5, "0") : pad(Math.floor(seconds));
  return `${pad(hours)}:${pad(minutes)}:${secondsText}`;
}

function pad(value: number): string {
  return String(Math.floor(value)).padStart(2, "0");
}

export function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min;
  return Math.min(Math.max(value, min), Math.max(min, max));
}
