export type Platform =
  | "twitch"
  | "youtube"
  | "kick"
  | "wtv"
  | "rtmp"
  | "vk"
  | "hls"
  | "unknown";

export function detectPlatform(url: string): Platform {
  const u = url.toLowerCase();
  if (isWtvUrl(u)) return "wtv";
  if (u.includes("twitch.tv")) return "twitch";
  if (u.includes("youtube.com") || u.includes("youtu.be")) return "youtube";
  if (u.includes("kick.com")) return "kick";
  if (/^rtmps?:\/\//.test(u) || /^rtmp[te]:\/\//.test(u)) return "rtmp";
  if (u.includes("vkvideo.ru") || u.includes("vk.com") || u.includes("vkplay"))
    return "vk";
  if (u.includes(".m3u8")) return "hls";
  return "unknown";
}

export function platformLabel(p: Platform): string {
  switch (p) {
    case "twitch":
      return "Twitch";
    case "youtube":
      return "YouTube";
    case "kick":
      return "Kick";
    case "wtv":
      return "W.TV";
    case "rtmp":
      return "RTMP";
    case "vk":
      return "VK";
    case "hls":
      return "HLS";
    default:
      return "Unknown";
  }
}

/** w.tv и его поддомены (streams.w.tv — записи эфиров), без ложных «snow.tv». */
export function isWtvUrl(url: string): boolean {
  const match = url.trim().toLowerCase().match(/^(?:[a-z]+:\/\/)?([^/?#:]+)/);
  const host = match?.[1] ?? "";
  return host === "w.tv" || host.endsWith(".w.tv");
}

export function isLikelyUrl(s: string): boolean {
  const t = s.trim();
  if (!t) return false;
  try {
    const u = new URL(t.includes("://") ? t : `https://${t}`);
    return Boolean(u.hostname);
  } catch {
    return false;
  }
}
