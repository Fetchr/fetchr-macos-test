/** Formatting shared across the VPS recorder page. */

export function fmtDuration(seconds: number): string {
  const value = Math.max(0, Math.round(seconds));
  const h = Math.floor(value / 3600);
  const m = Math.floor((value % 3600) / 60);
  const s = value % 60;
  const pad = (part: number) => String(part).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

export function parseTimecode(value: string): number | null {
  if (!value.trim()) return null;
  const parts = value.trim().split(":");
  if (parts.length < 1 || parts.length > 3) return null;
  const numbers = parts.map(Number);
  if (numbers.some((part) => !Number.isFinite(part) || part < 0)) return null;
  if (parts.length === 1) return numbers[0];
  if (parts.length === 2) return numbers[0] * 60 + numbers[1];
  return numbers[0] * 3600 + numbers[1] * 60 + numbers[2];
}

export function fmtBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 КБ";
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} ГБ`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} МБ`;
  return `${Math.round(bytes / 1e3)} КБ`;
}

export function fmtDate(epochSeconds: number | null | undefined): string {
  if (!epochSeconds) return "—";
  return new Date(epochSeconds * 1000).toLocaleString();
}

export function fmtHours(hours: number | null | undefined): string {
  if (hours == null || !Number.isFinite(hours) || hours <= 0) return "—";
  if (hours < 1) return `${Math.round(hours * 60)} мин`;
  return `${hours.toFixed(1)} ч`;
}

export type VpsPlatform = "twitch" | "kick" | "wtv";

export const VPS_PLATFORMS: ReadonlyArray<{ id: VpsPlatform; label: string; placeholder: string }> = [
  { id: "twitch", label: "Twitch", placeholder: "ник или twitch.tv/ник" },
  { id: "kick", label: "Kick", placeholder: "ник или kick.com/ник" },
  { id: "wtv", label: "W.TV", placeholder: "ник или w.tv/ник" },
];

const NAME_RE: Record<VpsPlatform, RegExp> = {
  twitch: /^[a-z0-9_]{2,25}$/,
  kick: /^[a-z0-9_][a-z0-9_-]{1,29}$/,
  wtv: /^[a-z0-9_][a-z0-9_.-]{1,31}$/,
};

const HOST_PLATFORM: Record<string, VpsPlatform> = {
  "twitch.tv": "twitch",
  "www.twitch.tv": "twitch",
  "m.twitch.tv": "twitch",
  "kick.com": "kick",
  "www.kick.com": "kick",
  "w.tv": "wtv",
  "www.w.tv": "wtv",
};

const RESERVED = ["videos", "directory", "clips", "settings", "p", "search", "categories", "navigation"];

/**
 * Recorder channel from a link or a bare name: a Twitch login as before, or
 * `kick:<slug>` / `wtv:<nick>` (the agent keys everything on this one string).
 * `platform` applies to a bare name; a link names its own. Null when invalid.
 */
export function normalizeChannel(raw: string, platform: VpsPlatform = "twitch"): string | null {
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) return null;
  let chosen = platform;
  let name = trimmed;
  const link = trimmed.match(/^(?:[a-z]+:\/\/)?([^/?#]+)\/([^/?#]*)/);
  const prefixed = trimmed.match(/^(twitch|kick|wtv):(.+)$/);
  if (link && trimmed.includes("/")) {
    const host = HOST_PLATFORM[link[1]];
    if (!host) return null;
    chosen = host;
    name = link[2];
  } else if (prefixed) {
    chosen = prefixed[1] as VpsPlatform;
    name = prefixed[2];
  }
  name = name.replace(/^@/, "");
  if (!NAME_RE[chosen].test(name) || RESERVED.includes(name)) return null;
  return chosen === "twitch" ? name : `${chosen}:${name}`;
}

/** Platform and bare name of a recorder channel. */
export function channelParts(channel: string): { platform: VpsPlatform; name: string } {
  const match = channel.match(/^(kick|wtv):(.+)$/);
  return match ? { platform: match[1] as VpsPlatform, name: match[2] } : { platform: "twitch", name: channel };
}

/** "xqc", "xqc (Kick)" — for plain-text places. */
export function channelLabel(channel: string): string {
  const { platform, name } = channelParts(channel);
  if (platform === "twitch") return name;
  return `${name} (${platform === "kick" ? "Kick" : "W.TV"})`;
}

/** A span in words rather than a clock reading: "44 ч 30 мин" instead of
 *  "44:31:37", which reads as a timecode and is unusable for "how long will
 *  this download take". */
export function fmtSpan(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "—";
  if (seconds < 60) return `${Math.round(seconds)} с`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} мин`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours < 24) return rest ? `${hours} ч ${rest} мин` : `${hours} ч`;
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours ? `${days} д ${restHours} ч` : `${days} д`;
}

/** A plan's size, without the decimals a measured size needs: "220 ГБ",
 *  "1.4 ТБ". `fmtBytes` stays for real file sizes, where the fraction matters. */
export function fmtQuota(bytes: number): string {
  if (bytes >= 1e12) {
    const tb = bytes / 1e12;
    return `${Number.isInteger(tb) ? tb : tb.toFixed(1)} ТБ`;
  }
  return `${Math.round(bytes / 1e9)} ГБ`;
}

/** "сегодня, 20:14", "вчера, 09:03", "23 сент., 20:14": short enough for a card. */
export function fmtShortDate(epochSeconds: number | null | undefined): string {
  if (!epochSeconds) return "—";
  const date = new Date(epochSeconds * 1000);
  const time = date.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
  const today = new Date();
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  const dayMs = 86_400_000;
  if (date.getTime() >= startOfToday) return `сегодня, ${time}`;
  if (date.getTime() >= startOfToday - dayMs) return `вчера, ${time}`;
  const sameYear = date.getFullYear() === today.getFullYear();
  const day = date.toLocaleDateString("ru-RU", {
    day: "numeric",
    month: "short",
    ...(sameYear ? {} : { year: "numeric" }),
  });
  return `${day}, ${time}`;
}

/** Stable hue for a channel name, so its avatar keeps one colour everywhere. */
export function channelHue(channel: string): number {
  let hash = 0;
  for (const char of channel) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return hash % 360;
}

/** "18 234" with a thin space, the way Russian groups thousands. */
export function fmtCount(value: number): string {
  return value.toLocaleString("ru-RU");
}
