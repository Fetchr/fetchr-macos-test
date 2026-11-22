import type { TwitchStreamListItem, TwitchStreamsPage } from "@/types/job";
import type { FinderStreamRow } from "@/ui/redesign/m3u8/VodResultsTable";

import type { TwitchPublicVod, TwitchPublicVodPage } from "./m3u8DiscoveryTypes";

const PUBLIC_VOD_TIME_MATCH_WINDOW_MS = 20 * 60 * 1000;
const PUBLIC_VOD_DURATION_MATCH_WINDOW_SECONDS = 45 * 60;
/**
 * Склеивает список стримов с TwitchTracker и публичные VOD Twitch в строки:
 * совпавшие качаются напрямую, остальные скрыты или удалены и требуют восстановления m3u8.
 */
export function buildStreamRows(trackerPage: TwitchStreamsPage | null, publicPage: TwitchPublicVodPage | null, pageSize: number, streamPage: number): FinderStreamRow[] {
  const publicVods = publicPage?.items ?? [];
  const publicByStreamId = new Map<string, TwitchPublicVod>();
  const publicByDateTitle = new Map<string, TwitchPublicVod>();
  for (const vod of publicVods) {
    if (vod.streamId) publicByStreamId.set(vod.streamId, vod);
    publicByDateTitle.set(normalizeMatchKey(vod.createdAt, vod.title), vod);
  }

  if (trackerPage?.items.length) {
    const usedPublicVodIds = new Set<string>();
    const rows = trackerPage.items.map((item, index) => {
      const publicVod = findMatchingPublicVod(item, publicVods, publicByStreamId, publicByDateTitle, usedPublicVodIds);
      if (publicVod) {
        usedPublicVodIds.add(publicVod.id);
        return publicVodToRow(publicVod, trackerPage.username);
      }
      return trackerItemToRow(item, trackerPage.username, index);
    });

    if (streamPage <= 1 && publicVods.length > 0) {
      const oldestTrackerTime = trackerPage.items.reduce<number | null>((min, item) => {
        const t = parseComparableTime(item.start_time || item.date);
        if (t == null) return min;
        return min == null || t < min ? t : min;
      }, null);
      const hasMoreTrackerPages = (trackerPage.total ?? 0) > trackerPage.items.length;
      const broadcasterLogin = publicPage?.broadcaster.login ?? trackerPage.username;

      for (const vod of publicVods) {
        if (!vod.public || usedPublicVodIds.has(vod.id)) continue;
        const vodTime = parseComparableTime(vod.createdAt);
        if (
          !hasMoreTrackerPages ||
          oldestTrackerTime == null ||
          vodTime == null ||
          vodTime >= oldestTrackerTime - PUBLIC_VOD_TIME_MATCH_WINDOW_MS
        ) {
          usedPublicVodIds.add(vod.id);
          rows.push(publicVodToRow(vod, broadcasterLogin));
        }
      }

      rows.sort((a, b) => (parseComparableTime(b.createdAt) ?? 0) - (parseComparableTime(a.createdAt) ?? 0));
    }

    return rows;
  }

  // Tracker unavailable: paginate the loaded public VODs locally.
  const start = (Math.max(1, streamPage) - 1) * pageSize;
  return publicVods.slice(start, start + pageSize).map((vod) => publicVodToRow(vod, publicPage?.broadcaster.login ?? "twitch"));
}

function findMatchingPublicVod(
  item: TwitchStreamListItem,
  publicVods: TwitchPublicVod[],
  publicByStreamId: Map<string, TwitchPublicVod>,
  publicByDateTitle: Map<string, TwitchPublicVod>,
  usedPublicVodIds: Set<string>,
): TwitchPublicVod | undefined {
  const exact = item.stream_id ? publicByStreamId.get(item.stream_id) : undefined;
  if (exact && !usedPublicVodIds.has(exact.id) && exact.public) return exact;

  const titled = publicByDateTitle.get(normalizeMatchKey(item.start_time || item.date, item.title));
  if (titled && !usedPublicVodIds.has(titled.id) && titled.public) return titled;

  const trackerTime = parseComparableTime(item.start_time || item.date);
  if (trackerTime == null) return undefined;

  let best: { vod: TwitchPublicVod; diff: number } | null = null;
  for (const vod of publicVods) {
    if (!vod.public || usedPublicVodIds.has(vod.id)) continue;
    const vodTime = parseComparableTime(vod.createdAt);
    if (vodTime == null) continue;
    const diff = Math.abs(vodTime - trackerTime);
    if (diff > PUBLIC_VOD_TIME_MATCH_WINDOW_MS) continue;
    if (!durationLooksCompatible(item, vod)) continue;
    if (!best || diff < best.diff) best = { vod, diff };
  }
  return best?.vod;
}

function publicVodToRow(vod: TwitchPublicVod, username: string): FinderStreamRow {
  return {
    id: `public:${vod.id}`,
    kind: "public",
    title: vod.title || `Twitch VOD ${vod.id}`,
    username,
    streamId: vod.streamId,
    createdAt: vod.createdAt,
    duration: vod.duration || "-",
    durationSeconds: vod.durationSeconds ?? null,
    thumbnailUrl: vod.thumbnailUrl,
    twitchUrl: vod.url,
    trackerUrl: vod.streamId ? `https://twitchtracker.com/${username}/streams/${vod.streamId}` : null,
    chatAvailable: vod.chatAvailable,
    publicVod: vod,
  };
}

function trackerItemToRow(item: TwitchStreamListItem, username: string, index: number): FinderStreamRow {
  return {
    id: `tracker:${item.stream_id ?? item.start_time ?? item.date ?? index}`,
    kind: "tracker",
    title: item.title || "Скрытый / удалённый стрим",
    username,
    streamId: item.stream_id,
    createdAt: item.start_time || item.date,
    duration: item.duration_minutes != null ? formatMinutes(item.duration_minutes) : "-",
    durationSeconds: item.duration_minutes != null && item.duration_minutes > 0 ? Math.round(item.duration_minutes * 60) : null,
    thumbnailUrl: null,
    twitchUrl: null,
    trackerUrl: item.url,
    chatAvailable: false,
  };
}

function normalizeMatchKey(dateValue?: string | null, title?: string | null): string {
  const time = dateValue ? Math.floor(new Date(dateValue).getTime() / 60000) : 0;
  return `${Number.isFinite(time) ? time : 0}:${(title ?? "").trim().toLowerCase()}`;
}

function parseComparableTime(value?: string | null): number | null {
  if (!value) return null;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
}

// Check duration compatibility
function durationLooksCompatible(item: TwitchStreamListItem, vod: TwitchPublicVod): boolean {
  if (item.duration_minutes == null || vod.durationSeconds == null) return true;
  const trackerSeconds = item.duration_minutes * 60;
  const diff = Math.abs(trackerSeconds - vod.durationSeconds);
  return diff <= Math.max(PUBLIC_VOD_DURATION_MATCH_WINDOW_SECONDS, trackerSeconds * 0.2);
}

function formatMinutes(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h > 0 ? `${h}ч ${m}м` : `${m}м`;
}
