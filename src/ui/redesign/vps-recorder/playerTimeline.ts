import type { PlayerFragment } from "@/components/hls-player";

/**
 * Player time ↔ session time.
 *
 * A player lays the playlist's segments end to end from 0, so its clock knows
 * nothing about reconnect gaps or about segments rotated away after the
 * playlist loaded. The agent stamps every segment with its place on the
 * session timeline (`#EXT-X-PROGRAM-DATE-TIME` = started_at + offset); these
 * helpers read it back. They return null when the playlist carries no stamps
 * (an older agent), and the caller falls back to a fixed origin.
 */

function stamped(fragments: PlayerFragment[]): boolean {
  return fragments.length > 0 && fragments.every((f) => f.programDateTime != null);
}

function sessionStart(fragment: PlayerFragment, startedAt: number): number {
  return (fragment.programDateTime as number) / 1000 - startedAt;
}

export function playerToSession(
  seconds: number,
  fragments: PlayerFragment[],
  startedAt: number,
): number | null {
  if (!stamped(fragments) || !Number.isFinite(seconds)) return null;
  const fragment =
    fragments.find((f) => seconds < f.start + f.duration) ?? fragments[fragments.length - 1];
  return sessionStart(fragment, startedAt) + Math.max(0, seconds - fragment.start);
}

export function sessionToPlayer(
  seconds: number,
  fragments: PlayerFragment[],
  startedAt: number,
): number | null {
  if (!stamped(fragments) || !Number.isFinite(seconds)) return null;
  for (const fragment of fragments) {
    const start = sessionStart(fragment, startedAt);
    // A position inside a gap lands on the footage that follows it.
    if (seconds < start + fragment.duration) {
      return fragment.start + Math.max(0, seconds - start);
    }
  }
  const last = fragments[fragments.length - 1];
  return last.start + last.duration;
}
