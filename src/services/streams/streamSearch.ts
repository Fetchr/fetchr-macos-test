import { ipc } from "@/lib/ipc";
import type { TwitchPublicVodPage } from "@/services/m3u8/m3u8DiscoveryTypes";
import { recoverM3u8FromTrackerMeta } from "@/services/m3u8/m3u8RecoveryService";
import { buildStreamRows } from "@/services/m3u8/streamRows";
import { discoverTrackerMetadata } from "@/services/m3u8/trackerDiscoveryService";
import { fetchPublicTwitchVods } from "@/services/twitch/twitchVodService";
import type { ProxyConfig, Quality, ResolvedStream } from "@/types/job";

import { classifyLink, type LinkInfo } from "./linkKind";
import { titleFromStreamUrl } from "./linkTitle";

/** Эфир идёт сейчас, обычная запись, клип или удалённая запись, найденная через трекер. */
export type SearchRowKind = "live" | "vod" | "clip" | "recovered";

export interface SearchRow {
  id: string;
  kind: SearchRowKind;
  title: string;
  username: string;
  platform: string;
  /** Что передать загрузчику; у удалённой записи пусто, ссылку находит восстановление. */
  url: string | null;
  streamId: string | null;
  createdAt: string | null;
  duration: string;
  durationSeconds: number | null;
  thumbnailUrl: string | null;
  chatAvailable: boolean;
  /** Доступные качества; только у одиночной ссылки, для списка канала пусто. */
  qualities: Quality[];
  /** У идущего эфира Twitch: запись, которая пишется параллельно. Из неё
   *  можно скачать уже прошедший отрезок, не дожидаясь конца эфира. */
  liveArchive?: LiveArchive | null;
}

export interface LiveArchive {
  url: string;
  /** Сколько эфира уже записано, секунды. */
  elapsedSeconds: number | null;
}

export interface SearchOutcome {
  link: LinkInfo;
  username: string | null;
  rows: SearchRow[];
  /** Источники, которые не ответили. Не мешают показать то, что нашлось. */
  warnings: string[];
}

export interface SearchContext {
  proxy: ProxyConfig;
  binariesDir: string | null;
  twitchAuthToken: string | null;
  /** Что уже известно о ссылке со стороны (например, из TwitchTracker). */
  hint?: SearchHint | null;
}

export interface SearchHint {
  url: string;
  title: string | null;
  username: string | null;
  thumbnailUrl: string | null;
}

const TRACKER_PAGE_SIZE = 50;

/** Ник Twitch из ссылки на канал или голого логина; для остальных ссылок null. */
export function parseTwitchLogin(input: string): string | null {
  const link = classifyLink(input);
  return link.platform === "twitch" && link.type === "channel" ? link.login : null;
}

function formatSeconds(total: number | null | undefined): string {
  if (!total || total <= 0) return "-";
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  return h > 0 ? `${h}ч ${m}м` : `${m}м`;
}

/**
 * Один запрос ищет всё, что подходит ссылке. Канал Twitch даёт эфир, записи и
 * удалённые записи; ссылка на запись, клип или эфир даёт одну карточку.
 */
export async function searchStreams(query: string, context: SearchContext): Promise<SearchOutcome> {
  const input = query.trim();
  const link = classifyLink(input);
  if (link.unsupported) throw new Error(link.unsupported);
  if (link.trackerStreamId) return searchTrackerStream(input, link, context);
  if (link.listing && link.login) return searchTwitchChannel(link, context);
  return searchSingle(input, link, context);
}

async function searchTrackerStream(sourceUrl: string, link: LinkInfo, context: SearchContext): Promise<SearchOutcome> {
  const meta = await discoverTrackerMetadata({
    sourceUrl,
    username: link.login ?? undefined,
    streamId: link.trackerStreamId ?? undefined,
  });
  let recovered = await recoverM3u8FromTrackerMeta(meta);
  if (recovered.urls.length === 0 && meta.candidates.length > 0) {
    for (const candidate of meta.candidates) {
      if (candidate === meta.startTime) continue;
      try {
        const retry = await recoverM3u8FromTrackerMeta({ ...meta, startTime: candidate });
        if (retry.urls.length > 0) {
          recovered = retry;
          break;
        }
      } catch {
        // Пробуем следующий кандидат времени.
      }
    }
  }
  const foundUrl = recovered.urls[0]?.url;
  if (!foundUrl) {
    throw new Error(`Плейлист удалённой записи не найден на серверах Twitch (проверено вариантов: ${recovered.tried}).`);
  }
  return searchSingle(foundUrl, link, {
    ...context,
    hint: {
      url: foundUrl,
      title: meta.title,
      username: meta.username ?? link.login,
      thumbnailUrl: meta.thumbnailUrl,
    },
  });
}

async function searchTwitchChannel(link: LinkInfo, context: SearchContext): Promise<SearchOutcome> {
  const login = link.login ?? "";
  const warnings: string[] = [];
  const channelUrl = `https://www.twitch.tv/${login}`;
  const [publicResult, trackerResult, liveResult] = await Promise.allSettled([
    fetchPublicTwitchVods({ login, first: 100, cursor: null, proxy: context.proxy }),
    ipc.twitchTrackerStreams({ username: login, page: 1, page_size: TRACKER_PAGE_SIZE }),
    ipc.resolveStream(channelUrl, context.proxy, context.binariesDir, context.twitchAuthToken),
  ]);

  const publicPage = publicResult.status === "fulfilled" ? publicResult.value : null;
  const trackerPage = trackerResult.status === "fulfilled" ? trackerResult.value : null;
  if (!publicPage) warnings.push("Twitch не ответил: список записей может быть неполным.");
  if (!trackerPage) warnings.push("Не удалось проверить удалённые записи.");

  const username = publicPage?.broadcaster.login ?? trackerPage?.username ?? login;
  const rows: SearchRow[] = [];

  if (liveResult.status === "fulfilled" && liveResult.value.is_live) {
    rows.push(liveRow(liveResult.value, "twitch", channelUrl, username));
  }

  for (const row of buildStreamRows(trackerPage, publicPage, TRACKER_PAGE_SIZE, 1)) {
    if (row.kind === "public" && !row.publicVod?.public) continue;
    rows.push({
      id: row.id,
      kind: row.kind === "public" ? "vod" : "recovered",
      title: row.title,
      username,
      platform: "twitch",
      url: row.twitchUrl,
      streamId: row.streamId,
      createdAt: row.createdAt,
      duration: row.duration,
      durationSeconds: row.durationSeconds ?? row.publicVod?.durationSeconds ?? null,
      thumbnailUrl: row.thumbnailUrl,
      chatAvailable: row.chatAvailable,
      qualities: [],
    });
  }

  const live = rows.find((row) => row.kind === "live");
  if (live) live.liveArchive = currentArchive(publicPage);

  return { link, username, rows, warnings };
}

/**
 * Запись идущего эфира: самая свежая, чей конец почти совпадает с «сейчас»
 * (Twitch дописывает её по ходу эфира). Старые записи не подходят.
 */
function currentArchive(page: TwitchPublicVodPage | null): LiveArchive | null {
  const now = Date.now();
  for (const vod of page?.items ?? []) {
    const started = Date.parse(vod.createdAt);
    if (!Number.isFinite(started) || !vod.url) continue;
    const length = vod.durationSeconds ?? 0;
    const end = started + length * 1000;
    if (now - end < 20 * 60 * 1000) {
      return { url: vod.url, elapsedSeconds: Math.max(length, Math.round((now - started) / 1000)) };
    }
    break;
  }
  return null;
}

async function searchSingle(url: string, link: LinkInfo, context: SearchContext): Promise<SearchOutcome> {
  const resolved = await ipc.resolveStream(url, context.proxy, context.binariesDir, context.twitchAuthToken);
  const fallback = titleFromStreamUrl(url);
  const hint = context.hint?.url === url ? context.hint : null;
  const username = resolved.uploader || hint?.username || fallback.username || "";
  const warnings: string[] = [];

  // Канал Kick / W.TV: из ссылки видно только эфир. Записи — по ссылке на конкретную запись.
  if (link.type === "channel" && !resolved.is_live) {
    warnings.push(
      `Канал сейчас не в эфире. Записи ${link.platformLabel} скачиваются по ссылке на конкретную запись.`,
    );
    return { link, username, rows: [], warnings };
  }

  const kind: SearchRowKind = resolved.is_live ? "live" : link.type === "clip" ? "clip" : "vod";
  return {
    link,
    username,
    warnings,
    rows: [
      {
        id: `single:${url}`,
        kind,
        title: resolved.title || hint?.title || fallback.title,
        username,
        platform: resolved.platform || link.platform,
        url,
        streamId: null,
        createdAt: null,
        duration: resolved.is_live ? "в эфире" : formatSeconds(resolved.duration),
        durationSeconds: resolved.duration,
        thumbnailUrl: resolved.thumbnail || hint?.thumbnailUrl || null,
        chatAvailable: (link.platform === "twitch" || link.platform === "kick") && link.type === "vod",
        qualities: resolved.qualities ?? [],
      },
    ],
  };
}

function liveRow(live: ResolvedStream, platform: string, url: string, username: string): SearchRow {
  return {
    id: `live:${username}`,
    kind: "live",
    title: live.title || `${username}: эфир`,
    username,
    platform,
    url,
    streamId: null,
    createdAt: null,
    duration: "в эфире",
    durationSeconds: null,
    thumbnailUrl: live.thumbnail,
    chatAvailable: false,
    qualities: live.qualities ?? [],
  };
}
