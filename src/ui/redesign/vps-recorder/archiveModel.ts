import type { VpsClipMeta, VpsRecordingMeta, VpsStatus } from "@/lib/ipc";

export type ChannelState = "live" | "waiting" | "idle";

export interface ArchiveChannel {
  name: string;
  state: ChannelState;
  recordings: number;
  /** Сервер следит за каналом и начнёт писать сам. */
  watched: boolean;
}

export function isLive(recording: VpsRecordingMeta): boolean {
  return recording.status === "recording" || recording.status === "reconnecting";
}

/** Сессия идёт, но кадров ещё нет: канал не в эфире или запись подключается. */
export function isWaiting(recording: VpsRecordingMeta): boolean {
  return isLive(recording) && recording.segments === 0 && recording.duration < 1;
}

export function isOnAir(recording: VpsRecordingMeta): boolean {
  return isLive(recording) && !isWaiting(recording);
}

const key = (name: string) => name.toLowerCase();

/** Каналы из слежения и из архива одним списком: сначала в эфире, потом ждущие, потом остальные. */
export function archiveChannels(status: VpsStatus | null, recordings: VpsRecordingMeta[]): ArchiveChannel[] {
  const map = new Map<string, ArchiveChannel>();
  const touch = (name: string) => {
    const existing = map.get(key(name));
    if (existing) return existing;
    const created: ArchiveChannel = { name, state: "idle", recordings: 0, watched: false };
    map.set(key(name), created);
    return created;
  };
  for (const target of status?.targets ?? []) {
    if (!target.channel) continue;
    const channel = touch(target.channel);
    map.set(key(target.channel), { ...channel, watched: target.enabled !== false, state: channel.state === "idle" ? "waiting" : channel.state });
  }
  for (const recording of recordings) {
    if (!recording.channel) continue;
    const channel = touch(recording.channel);
    const state: ChannelState = isOnAir(recording) ? "live" : isWaiting(recording) && channel.state !== "live" ? "waiting" : channel.state;
    map.set(key(recording.channel), { ...channel, state, recordings: channel.recordings + (isWaiting(recording) ? 0 : 1) });
  }
  const order: Record<ChannelState, number> = { live: 0, waiting: 1, idle: 2 };
  return [...map.values()].sort((a, b) => order[a.state] - order[b.state] || b.recordings - a.recordings);
}

export function clipsBySession(clips: VpsClipMeta[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const clip of clips) {
    if (clip.session) counts.set(clip.session, (counts.get(clip.session) ?? 0) + 1);
  }
  return counts;
}

/** «Сегодня», «Вчера» или дата: заголовок группы в списке записей. */
export function dayLabel(epochSeconds: number): string {
  const date = new Date(epochSeconds * 1000);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (date.getTime() >= today) return "Сегодня";
  if (date.getTime() >= today - 86_400_000) return "Вчера";
  return date.toLocaleDateString("ru-RU", {
    day: "numeric",
    month: "long",
    ...(date.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
  });
}

export function timeOf(epochSeconds: number | null | undefined): string {
  if (!epochSeconds) return "";
  return new Date(epochSeconds * 1000).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
}

export function groupByDay(recordings: VpsRecordingMeta[]): Array<{ label: string; items: VpsRecordingMeta[] }> {
  const groups: Array<{ label: string; items: VpsRecordingMeta[] }> = [];
  for (const recording of recordings) {
    const label = isLive(recording) ? "Сейчас" : dayLabel(recording.started_at);
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.items.push(recording);
    else groups.push({ label, items: [recording] });
  }
  return groups;
}

export function recordingTitle(recording: VpsRecordingMeta): string {
  return recording.title?.trim() || recording.channel || recording.session;
}
