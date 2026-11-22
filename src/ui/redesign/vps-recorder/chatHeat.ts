import type { VpsChatMessage } from "@/lib/ipc";

/** Chat reacts a few seconds after the moment; a jump lands a little before the burst. */
const LEAD_SECONDS = 10;
const MAX_PEAKS = 8;
const MIN_PEAK_MESSAGES = 10;

export interface ChatPeak {
  /** Where a jump lands, in session seconds. */
  at: number;
  /** Messages in the busiest window around it. */
  count: number;
  /** Width of that window, seconds. */
  window: number;
}

export interface ChatHeat {
  binSeconds: number;
  /** prefix[i] = messages before bin i; one extra slot at the end. */
  prefix: number[];
  /** Busiest coarse window as messages per second; floor for the bar scale. */
  maxDensity: number;
  peaks: ChatPeak[];
}

function countBins(messages: readonly VpsChatMessage[], binSeconds: number, bins: number): number[] {
  const counts = new Array<number>(bins).fill(0);
  for (const message of messages) {
    const index = Math.floor(message.timestamp / binSeconds);
    if (index >= 0 && index < bins) counts[index] += 1;
  }
  return counts;
}

function prefixOf(counts: readonly number[]): number[] {
  const prefix = new Array<number>(counts.length + 1).fill(0);
  counts.forEach((count, index) => {
    prefix[index + 1] = prefix[index] + count;
  });
  return prefix;
}

function coarseCounts(prefix: readonly number[], step: number): number[] {
  const last = prefix.length - 1;
  const size = Math.ceil(last / step);
  return Array.from({ length: size }, (_, i) => prefix[Math.min(last, (i + 1) * step)] - prefix[i * step]);
}

function pickPeaks(coarse: readonly number[], windowSeconds: number, minGapBins: number): ChatPeak[] {
  const nonEmpty = coarse.filter((count) => count > 0);
  if (nonEmpty.length < 3) return [];
  const mean = nonEmpty.reduce((sum, count) => sum + count, 0) / nonEmpty.length;
  const spread = Math.sqrt(nonEmpty.reduce((sum, count) => sum + (count - mean) ** 2, 0) / nonEmpty.length);
  const threshold = Math.max(mean + 2 * spread, mean * 2, MIN_PEAK_MESSAGES);
  const candidates = coarse
    .map((count, index) => ({ count, index }))
    .filter(({ count, index }) => count >= threshold && count >= (coarse[index - 1] ?? 0) && count >= (coarse[index + 1] ?? 0))
    .sort((a, b) => b.count - a.count);
  const kept = candidates.reduce<Array<{ count: number; index: number }>>(
    (acc, candidate) =>
      acc.length < MAX_PEAKS && acc.every((other) => Math.abs(other.index - candidate.index) >= minGapBins)
        ? [...acc, candidate]
        : acc,
    [],
  );
  return kept
    .map(({ count, index }) => ({ at: Math.max(0, index * windowSeconds - LEAD_SECONDS), count, window: windowSeconds }))
    .sort((a, b) => a.at - b.at);
}

/** Message density over the session and its bursts. Runs once per loaded chat. */
export function buildChatHeat(messages: readonly VpsChatMessage[], total: number): ChatHeat | null {
  if (messages.length === 0 || total <= 0) return null;
  const binSeconds = Math.max(5, Math.ceil(total / 4000));
  const bins = Math.ceil(total / binSeconds) + 1;
  const prefix = prefixOf(countBins(messages, binSeconds, bins));
  // Bursts are judged by the minute (longer on a multi-day session).
  const step = Math.max(1, Math.round(Math.max(60, total / 400) / binSeconds));
  const windowSeconds = step * binSeconds;
  const coarse = coarseCounts(prefix, step);
  const maxDensity = Math.max(1, ...coarse) / windowSeconds;
  const minGapBins = Math.max(3, Math.ceil(total / 40 / windowSeconds));
  return { binSeconds, prefix, maxDensity, peaks: pickPeaks(coarse, windowSeconds, minGapBins) };
}

function messagesBefore(heat: ChatHeat, seconds: number): number {
  const last = heat.prefix.length - 1;
  const position = Math.max(0, Math.min(last, seconds / heat.binSeconds));
  const index = Math.floor(position);
  const next = heat.prefix[Math.min(last, index + 1)];
  return heat.prefix[index] + (next - heat.prefix[index]) * (position - index);
}

/** Bar heights 0..1 for the visible window. */
export function heatBars(heat: ChatHeat, start: number, end: number, count: number): number[] {
  const width = (end - start) / count;
  if (width <= 0) return [];
  const densities = Array.from({ length: count }, (_, i) => {
    const from = start + i * width;
    return (messagesBefore(heat, from + width) - messagesBefore(heat, from)) / width;
  });
  // Scaled to the busiest bar in view, so the shape reads at any zoom; the
  // floor keeps a quiet stretch from being blown up into fake bursts.
  const scale = Math.max(...densities, heat.maxDensity * 0.15);
  return densities.map((density) => Math.min(1, density / scale));
}

/** First burst after `playhead`; wraps to the first one at the end. */
export function nextPeak(peaks: readonly ChatPeak[], playhead: number): ChatPeak | null {
  return peaks.find((peak) => peak.at > playhead + 1) ?? peaks[0] ?? null;
}
