import { ipc } from "@/lib/ipc";
import { StreamDownloader } from "@/lib/stream-downloader";
import { recoverM3u8FromTrackerMeta } from "@/services/m3u8/m3u8RecoveryService";
import { defaultPerformanceSettings, useSettings } from "@/stores/settings";
import { useWorkflowPresets } from "@/stores/workflowPresets";
import type { BlurZone, JobSpec, Quality } from "@/types/job";
import { fetchrMuteModelForMode, loadSavedFetchrMuteSettings } from "@/ui/redesign/fetchr-mute/fetchrMuteSettings";

import type { SearchRow } from "./streamSearch";

export interface QueueSelectionResult {
  queued: number;
  /** Id поставленных задач, чтобы «Отменить» мог убрать их из очереди. */
  jobIds: string[];
  failed: Array<{ row: SearchRow; reason: string }>;
}

/** Время начала в формате, который ждёт восстановление: местное, до минуты. */
function localStartTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (value: number) => value.toString().padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Ссылка на скачивание строки. Для удалённой записи сначала ищет живой m3u8. */
async function downloadUrlFor(row: SearchRow): Promise<string> {
  if (row.url) return row.url;
  if (!row.streamId || !row.createdAt) {
    throw new Error("У записи нет номера или времени начала, восстановить её нельзя.");
  }
  const result = await recoverM3u8FromTrackerMeta({
    username: row.username,
    streamId: row.streamId,
    startTime: localStartTime(row.createdAt),
    title: row.title,
    thumbnailUrl: row.thumbnailUrl,
    candidates: [],
  });
  const found = result.urls[0]?.url;
  if (!found) throw new Error("Запись удалена с серверов Twitch, живую ссылку найти не удалось.");
  return found;
}

function safeName(row: SearchRow): string {
  const base = row.title.replace(/[<>:"/\\|?*]+/g, "_").trim() || `${row.username}_${row.streamId ?? Date.now()}`;
  return base.slice(0, 90);
}

/**
 * Ставит выбранные записи в очередь одним действием и запускает её.
 * Качество, кодек, папка и прокси берутся из общих настроек.
 */
export type LiveCapture = "record" | "range";

export interface QueueOptions {
  withChat: boolean;
  /** Id качества из карточки одной записи; пусто — лучшее. */
  quality?: Quality | null;
  audioOnly?: boolean;
  /** Имя файла; только для одной записи. */
  name?: string;
  directory?: string;
  /** Диапазон записи, ЧЧ:ММ:СС; пусто — целиком. */
  start?: string;
  end?: string;
  /** Дополнительные фрагменты записи; каждый ставится отдельной задачей. */
  extraRanges?: Array<{ start: string; end: string }>;
  /** Эфир: писать с текущего момента или скачать уже прошедший отрезок. */
  liveCapture?: LiveCapture;
  /** Вернуть звук в заглушённых местах записи Twitch. */
  unmute?: boolean;
  /** Заглушить маты после скачивания. */
  muteProfanity?: boolean;
  /** Закрыть спонсоров зонами из активного пресета блюра. */
  blurSponsors?: boolean;
  /** Пресет рендера чата; пусто — общие настройки чата. */
  chatPresetId?: string | null;
  /** Пресет блюра спонсоров; пусто — активный. */
  sponsorPresetId?: string | null;
  /** Свои настройки отдельных записей по id строки; важнее общих. */
  perRow?: Record<string, Partial<Omit<QueueOptions, "perRow" | "directory">>>;
}

function clock(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/**
 * Ползунок отрезка оставляет край пустым, когда тот совпадает с началом или
 * концом записи. Загрузчик режет только по паре «начало–конец», и с одним
 * краем качал запись целиком, поэтому пустой край закрываем здесь.
 */
export function closedRange(
  start: string | undefined,
  end: string | undefined,
  durationSeconds: number | null | undefined,
): { start: string | null; end: string | null } {
  const from = start?.trim() || null;
  const to = end?.trim() || null;
  if (!from && !to) return { start: null, end: null };
  const length = durationSeconds && durationSeconds > 0 ? clock(durationSeconds) : null;
  return { start: from ?? "0:00:00", end: to ?? length };
}

/** Зоны блюра, которые реально применятся: из выбранного или активного пресета, иначе из общих настроек. */
export function activeBlurZones(presetId?: string | null): BlurZone[] {
  const presets = useWorkflowPresets.getState();
  const wanted = presetId || presets.activeSponsorPresetId;
  const preset = presets.sponsorPresets.find((item) => item.id === wanted) ?? presets.sponsorPresets[0] ?? null;
  const zones = preset?.zones.length ? preset.zones : useSettings.getState().blurZones;
  return zones.filter((zone) => zone.enabled);
}

/** С этой высоты Twitch отдаёт поток только авторизованным. */
export const TWITCH_AUTH_MIN_HEIGHT = 1440;

function rowNeedsTwitchAuth(row: SearchRow, opts: QueueOptions): boolean {
  if (row.platform !== "twitch" || opts.audioOnly) return false;
  if (opts.quality) {
    return (opts.quality.height ?? 0) >= TWITCH_AUTH_MIN_HEIGHT;
  }
  const hasToken = Boolean(useSettings.getState().integrations.twitchAuthToken?.trim());
  const maxHeight = Math.max(0, ...row.qualities.map((item) => item.height ?? 0));
  if (maxHeight >= TWITCH_AUTH_MIN_HEIGHT) {
    const hasStandardFallback = row.qualities.some(
      (item) => item.has_video && (item.height ?? 0) > 0 && (item.height ?? 0) < TWITCH_AUTH_MIN_HEIGHT,
    );
    return hasToken || !hasStandardFallback;
  }
  return hasToken && row.qualities.length === 0;
}

/**
 * Перед каждой постановкой 1440p+ с Twitch проверяет auth-token у самого Twitch.
 * Без него Twitch молча отдаёт 1080p, поэтому лучше упасть сразу.
 */
export async function ensureTwitchAuth(height: number | null | undefined, platform: string | null | undefined): Promise<void> {
  if (platform !== "twitch" || (height ?? 0) < TWITCH_AUTH_MIN_HEIGHT) return;
  const settings = useSettings.getState();
  await ipc.twitchValidateAuthToken(settings.integrations.twitchAuthToken ?? "", settings.proxy).catch((reason: unknown) => {
    throw new Error(reason instanceof Error ? reason.message : String(reason));
  });
}

function chatOverlayFor(presetId: string | null | undefined) {
  const presets = useWorkflowPresets.getState();
  const wanted = presetId || presets.activeChatPresetId;
  return presets.chatPresets.find((item) => item.id === wanted)?.overlay ?? useSettings.getState().chatOverlay;
}

export async function queueSelection(rows: SearchRow[], options: QueueOptions): Promise<QueueSelectionResult> {
  const settings = useSettings.getState();
  const needsAuth = rows.some((row) => rowNeedsTwitchAuth(row, { ...options, ...(options.perRow?.[row.id] ?? {}) }));
  if (needsAuth) await ensureTwitchAuth(TWITCH_AUTH_MIN_HEIGHT, "twitch");
  const directory = options.directory?.trim() || settings.directory.trim() || (await ipc.defaultDownloadDir()) || "";
  const failed: QueueSelectionResult["failed"] = [];
  let queued = 0;
  const jobIds: string[] = [];

  for (const row of rows) {
    const own = options.perRow?.[row.id] ?? {};
    const opts: QueueOptions = { ...options, ...own };
    const muteSettings = opts.muteProfanity ? loadSavedFetchrMuteSettings() : null;
    const blurZones = opts.blurSponsors ? activeBlurZones(opts.sponsorPresetId) : [];
    try {
      // Отрезок идущего эфира качается из его записи, как обычный VOD.
      const fromArchive = row.kind === "live" && opts.liveCapture === "range" && row.liveArchive;
      const source: SearchRow = fromArchive
        ? { ...row, kind: "vod", url: row.liveArchive!.url, durationSeconds: row.liveArchive!.elapsedSeconds, chatAvailable: true }
        : row;
      const url = await downloadUrlFor(source);
      const baseName = ((rows.length === 1 || own.name !== undefined) && opts.name?.trim()) || safeName(source);
      const validExtras =
        source.kind !== "live"
          ? (opts.extraRanges ?? [])
              .map((r) => closedRange(r.start, r.end, source.durationSeconds))
              .filter((r) => r.start !== null || r.end !== null)
          : [];
      const rangesToQueue =
        validExtras.length > 0
          ? [closedRange(opts.start, opts.end, source.durationSeconds), ...validExtras]
          : [closedRange(opts.start, opts.end, source.durationSeconds)];
      const wantsChat = opts.withChat && source.chatAvailable;

      for (const [idx, range] of rangesToQueue.entries()) {
        const spec: JobSpec = {
          url,
          chat_source_url: source.kind === "vod" && source.platform === "twitch" ? url : null,
          name: rangesToQueue.length > 1 ? `${baseName}_clip${String(idx + 1).padStart(2, "0")}` : baseName,
          directory,
          job_kind: "video",
          mode: source.kind === "live" ? "live" : "vod",
          download_kind: opts.audioOnly ? "audio" : "video",
          ...range,
          fragments: [],
          split: false,
          split_interval_minutes: null,
          quality: opts.quality?.id ?? null,
          quality_has_audio: opts.quality?.has_audio ?? null,
          quality_has_video: opts.quality?.has_video ?? null,
          quality_height: opts.quality?.height ?? null,
          audio_format: opts.audioOnly ? "m4a" : null,
          unmute_video: Boolean(opts.unmute),
          proxy: settings.proxy,
          chat_overlay: { ...settings.chatOverlay, enabled: false },
          performance: settings.performance ?? defaultPerformanceSettings,
          blur_zones: blurZones,
          fetchr_mute_enabled: Boolean(muteSettings),
          fetchr_mute_model: muteSettings ? fetchrMuteModelForMode(muteSettings.mode) : null,
          fetchr_mute_settings: muteSettings,
          binaries_dir: settings.binariesDir,
          twitch_auth_token: settings.integrations.twitchAuthToken || null,
          meta: {
            platform: source.kind === "recovered" ? "hls" : source.platform,
            title: source.title,
            uploader: source.username || null,
            thumbnail: source.thumbnailUrl,
            duration: source.durationSeconds,
          },
        };
        const job = await StreamDownloader.enqueueWithChat(spec, chatOverlayFor(opts.chatPresetId), wantsChat);
        jobIds.push(job.id);
        queued += 1;
      }
    } catch (reason) {
      failed.push({ row, reason: reason instanceof Error ? reason.message : String(reason) });
    }
  }

  if (queued > 0) await ipc.startQueue(settings.maxConcurrentJobs).catch(() => undefined);
  return { queued, failed, jobIds };
}
