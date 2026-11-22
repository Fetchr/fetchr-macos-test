import type { VpsClipMeta, VpsRecordingMeta } from "@/lib/ipc";

function stampName(epochSeconds: number): string {
  const stamp = new Date(epochSeconds * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${stamp.getFullYear()}-${pad(stamp.getMonth() + 1)}-${pad(stamp.getDate())}_${pad(stamp.getHours())}-${pad(stamp.getMinutes())}`;
}

/** File name a downloaded clip lands under. */
export function clipName(clip: VpsClipMeta): string {
  const channel = clip.channel ?? "vps";
  const label = (clip.label ?? "").trim();
  const date = stampName(clip.created_at);
  return label ? `${channel}_${label}_${date}` : `${channel}_clip_${date}`;
}

/** File name a downloaded recording lands under. */
export function recordingName(recording: VpsRecordingMeta): string {
  const channel = recording.channel ?? "vps";
  const title = (recording.title ?? "").trim().replace(/[\\/:*?"<>|]/g, "").slice(0, 80);
  const date = stampName(recording.started_at);
  return title ? `${channel}_${title}_${date}` : `${channel}_stream_${date}`;
}

/** Freed disk space as the server reports it, in Russian units. */
export function fmtFreed(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} ГБ`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(0)} МБ`;
  return `${Math.round(bytes / 1e3)} КБ`;
}
