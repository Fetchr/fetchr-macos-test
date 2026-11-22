import { isWtvUrl } from "@/lib/url";
import { isDirectTwitchVodUrl } from "@/services/twitch/twitchVodService";

export type LinkPlatform = "twitch" | "kick" | "wtv" | "youtube" | "vk" | "hls" | "rtmp" | "unknown";
export type LinkType = "channel" | "vod" | "clip" | "video" | "stream" | "playlist";

/** Что за ссылка вставлена и как под неё подстраивается результат. */
export interface LinkInfo {
  platform: LinkPlatform;
  type: LinkType;
  platformLabel: string;
  /** Подпись типа в шапке результата: «Канал», «Запись», «Клип». */
  typeLabel: string;
  /** Текст главной кнопки. Для эфира его уточняет вид результата. */
  actionLabel: string;
  /** Список записей канала, а не одна запись. */
  listing: boolean;
  supportsChat: boolean;
  supportsAudioOnly: boolean;
  /** Ник канала для Twitch: по нему ищутся записи. */
  login: string | null;
  /** ID стрима из ссылки TwitchTracker (twitchtracker.com/<login>/streams/<id>). */
  trackerStreamId?: string | null;
  /** Нельзя обработать: объясняем, что вставить вместо этого. */
  unsupported: string | null;
}

const PLATFORM_LABEL: Record<LinkPlatform, string> = {
  twitch: "Twitch",
  kick: "Kick",
  wtv: "W.TV",
  youtube: "YouTube",
  vk: "VK",
  hls: "HLS",
  rtmp: "RTMP",
  unknown: "Ссылка",
};

function info(
  platform: LinkPlatform,
  type: LinkType,
  typeLabel: string,
  actionLabel: string,
  extra: Partial<LinkInfo> = {},
): LinkInfo {
  return {
    platform,
    type,
    platformLabel: PLATFORM_LABEL[platform],
    typeLabel,
    actionLabel,
    listing: false,
    supportsChat: false,
    supportsAudioOnly: false,
    login: null,
    unsupported: null,
    ...extra,
  };
}

/**
 * Определяет платформу и тип по тексту, не обращаясь к сети. От результата
 * зависит, что покажет окно: список записей канала, карточка одной записи,
 * клипа или эфира, и какие опции к ней предложить.
 */
export function classifyLink(raw: string): LinkInfo {
  const input = raw.trim();
  const lower = input.toLowerCase();

  if (/^@?[a-z0-9_]{3,25}$/i.test(input)) {
    return info("twitch", "channel", "Канал", "Скачать", {
      listing: true,
      supportsChat: true,
      supportsAudioOnly: true,
      login: input.replace(/^@/, "").toLowerCase(),
    });
  }

  if (/^rtmps?:\/\//.test(lower)) return info("rtmp", "stream", "Поток", "Записать поток");
  if (isWtvUrl(lower)) {
    if (lower.includes(".m3u8") || /w\.tv\/[^/?#]+\/videos\/[0-9a-f-]{8,}/.test(lower)) {
      return info("wtv", "vod", "Запись", "Скачать запись", { supportsAudioOnly: true });
    }
    return info("wtv", "channel", "Канал", "Записать эфир", { supportsChat: true, supportsAudioOnly: true });
  }
  if (lower.includes(".m3u8")) return info("hls", "stream", "Поток", "Скачать поток");

  if (lower.includes("twitchtracker.com")) {
    const streamMatch = input.match(/twitchtracker\.com\/([A-Za-z0-9_]{3,25})\/streams\/(\d+)/i);
    if (streamMatch) {
      return info("twitch", "vod", "Удалённая запись", "Скачать запись", {
        supportsAudioOnly: true,
        login: streamMatch[1].toLowerCase(),
        trackerStreamId: streamMatch[2],
      });
    }
    const channelMatch = input.match(/twitchtracker\.com\/(?!streams\b|channels\b|games\b|statistics\b|subscribers\b)([A-Za-z0-9_]{3,25})(?:[/?#]|$)/i);
    if (channelMatch) {
      return info("twitch", "channel", "Канал", "Скачать", {
        listing: true,
        supportsChat: true,
        supportsAudioOnly: true,
        login: channelMatch[1].toLowerCase(),
      });
    }
  }

  if (lower.includes("twitch.tv") || lower.includes("clips.twitch.tv")) {
    if (isDirectTwitchVodUrl(input)) {
      return info("twitch", "vod", "Запись", "Скачать запись", { supportsChat: true, supportsAudioOnly: true });
    }
    if (lower.includes("clips.twitch.tv") || /twitch\.tv\/[^/]+\/clip\//.test(lower)) {
      return info("twitch", "clip", "Клип", "Скачать клип", { supportsAudioOnly: true });
    }
    const login = input.match(/twitch\.tv\/(?!videos\b|directory\b)@?([A-Za-z0-9_]{3,25})/i)?.[1]?.toLowerCase() ?? null;
    if (login) return info("twitch", "channel", "Канал", "Скачать", { listing: true, supportsChat: true, supportsAudioOnly: true, login });
    return info("twitch", "video", "Ссылка", "Скачать", {
      unsupported: "Не получилось понять ссылку Twitch. Вставь ссылку на канал, запись или клип.",
    });
  }

  if (lower.includes("kick.com")) {
    if (/kick\.com\/(?:video\/|[^/]+\/videos\/)/.test(lower)) {
      return info("kick", "vod", "Запись", "Скачать запись", { supportsChat: true, supportsAudioOnly: true });
    }
    if (/kick\.com\/[^/]+\/clips\//.test(lower) || lower.includes("?clip=")) {
      return info("kick", "clip", "Клип", "Скачать клип", { supportsAudioOnly: true });
    }
    return info("kick", "channel", "Канал", "Записать эфир", { supportsChat: true, supportsAudioOnly: true });
  }

  if (lower.includes("youtube.com") || lower.includes("youtu.be")) {
    const isPlaylistOrChannel =
      /youtube\.com\/(@|channel\/|c\/|user\/)/.test(lower) || (lower.includes("list=") && !lower.includes("v="));
    if (isPlaylistOrChannel) {
      return info("youtube", "playlist", "Канал или плейлист", "Скачать", {
        unsupported:
          "Каналы и плейлисты YouTube пока не разбираю. Вставь ссылку на конкретное видео или трансляцию.",
      });
    }
    return info("youtube", "video", "Видео", "Скачать видео", { supportsAudioOnly: true });
  }

  if (lower.includes("vkvideo.ru") || lower.includes("vk.com") || lower.includes("vkplay")) {
    return info("vk", "video", "Видео", "Скачать видео", { supportsAudioOnly: true });
  }

  return info("unknown", "video", "Ссылка", "Скачать", {
    unsupported: "Не похоже на ссылку Twitch, Kick, W.TV или YouTube. Проверь, что вставил её целиком.",
  });
}
