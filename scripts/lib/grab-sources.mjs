/** Link parsing for the fetchr.fun online downloader.
 *
 * yt-dlp only ever sees URLs rebuilt here from validated ids on known hosts,
 * never the visitor's raw text: no generic extractor, no internal addresses.
 */

export const PLATFORMS = ["youtube", "vk", "soundcloud", "twitch", "kick", "tiktok", "rutube", "pinterest"];

const parseUrl = (raw) => {
  const text = String(raw || "").trim();
  if (!text || text.length > 2048 || /\s/.test(text)) return null;
  try {
    const url = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(text) ? text : `https://${text}`);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (!url.hostname.includes(".")) return null;
    return url;
  } catch {
    return null;
  }
};

const hostOf = (url) => url.hostname.toLowerCase().replace(/^(www|m|music)\./, "");

function youtube(url, host) {
  let id = "";
  if (host === "youtu.be") id = url.pathname.split("/")[1] || "";
  else if (host === "youtube.com") {
    id = url.searchParams.get("v") || url.pathname.match(/^\/(?:shorts|live|embed)\/([^/?#]+)/)?.[1] || "";
  } else return null;
  return /^[\w-]{11}$/.test(id) ? { platform: "youtube", id, url: `https://www.youtube.com/watch?v=${id}` } : "bad";
}

function vk(url, host) {
  if (!["vk.com", "vk.ru", "vkvideo.ru"].includes(host)) return null;
  const from = `${url.pathname}?${url.searchParams.get("z") || ""}`;
  const id = from.match(/video(-?\d{1,12}_\d{1,12})/)?.[1];
  return id ? { platform: "vk", id, url: `https://vk.com/video${id}` } : "bad";
}

function soundcloud(url, host) {
  if (host !== "soundcloud.com") return null;
  const [user, track, extra] = url.pathname.split("/").filter(Boolean);
  const ok = /^[\w-]{1,100}$/;
  if (!user || !track || extra || !ok.test(user) || !ok.test(track) || ["sets", "tracks", "likes", "reposts", "albums"].includes(track)) {
    return "bad";
  }
  return { platform: "soundcloud", id: `${user}/${track}`, url: `https://soundcloud.com/${user}/${track}` };
}

function twitch(url, host) {
  if (host === "clips.twitch.tv") {
    const slug = url.pathname.split("/")[1] || "";
    return /^[\w-]{3,120}$/.test(slug) ? { platform: "twitch", id: `clip:${slug}`, url: `https://clips.twitch.tv/${slug}` } : "bad";
  }
  if (host !== "twitch.tv") return null;
  const vod = url.pathname.match(/^\/videos\/(\d{5,14})/)?.[1];
  if (vod) return { platform: "twitch", id: vod, url: `https://www.twitch.tv/videos/${vod}` };
  const clip = url.pathname.match(/^\/[\w]{2,40}\/clip\/([\w-]{3,120})/)?.[1];
  if (clip) return { platform: "twitch", id: `clip:${clip}`, url: `https://clips.twitch.tv/${clip}` };
  return "bad";
}

function kick(url, host) {
  if (host !== "kick.com") return null;
  const [channel, kind, id] = url.pathname.split("/").filter(Boolean);
  if (!channel || !/^[\w-]{2,40}$/.test(channel)) return "bad";
  if (kind === "videos" && /^[0-9a-f-]{36}$/i.test(id || "")) {
    return { platform: "kick", id, url: `https://kick.com/${channel}/videos/${id}` };
  }
  const clip = kind === "clips" ? id : url.searchParams.get("clip");
  if (clip && /^clip_[\w-]{6,60}$/.test(clip)) {
    return { platform: "kick", id: clip, url: `https://kick.com/${channel}/clips/${clip}` };
  }
  return "bad";
}

function tiktok(url, host) {
  if (["vm.tiktok.com", "vt.tiktok.com"].includes(host) || (host === "tiktok.com" && url.pathname.startsWith("/t/"))) {
    // Share links redirect to the real video; grab.mjs expands them before yt-dlp sees anything.
    const code = url.pathname.split("/").filter(Boolean).pop() || "";
    return /^[\w-]{5,20}$/.test(code) ? { platform: "tiktok", id: `short:${code}`, url: `https://vm.tiktok.com/${code}/`, short: true } : "bad";
  }
  if (host !== "tiktok.com") return null;
  const match = url.pathname.match(/^\/(?:@([\w.]{0,30})\/video|v|embed(?:\/v2)?)\/(\d{15,21})(?:\.html)?\/?$/);
  if (!match) return "bad";
  const [, user = "", id] = match;
  return { platform: "tiktok", id, url: `https://www.tiktok.com/@${user}/video/${id}` };
}

function rutube(url, host) {
  if (host !== "rutube.ru") return null;
  const id = url.pathname.match(/^\/(?:video|shorts|play\/embed)\/([0-9a-f]{32})\/?$/)?.[1];
  return id ? { platform: "rutube", id, url: `https://rutube.ru/video/${id}/` } : "bad";
}

const PINTEREST_HOST = /^([a-z]{2}\.)?pinterest\.(com|ru|de|fr|it|es|ca|jp|co\.uk|com\.au|com\.mx)$/;

function pinterest(url, host) {
  if (host === "pin.it") {
    const code = url.pathname.split("/").filter(Boolean)[0] || "";
    return /^[\w-]{5,20}$/.test(code) ? { platform: "pinterest", id: `short:${code}`, url: `https://pin.it/${code}`, short: true } : "bad";
  }
  if (!PINTEREST_HOST.test(host)) return null;
  const id = url.pathname.match(/^\/pin\/(?:[\w-]*--)?(\d{6,25})\/?$/)?.[1];
  return id ? { platform: "pinterest", id, url: `https://www.pinterest.com/pin/${id}/` } : "bad";
}

/** Hosts a share link of `platform` may redirect through before landing on the video. */
export const SHORT_LINK_HOSTS = {
  tiktok: (host) => host === "tiktok.com" || host.endsWith(".tiktok.com"),
  pinterest: (host) => PINTEREST_HOST.test(host.replace(/^www\./, "")),
};

function spotify(url, host) {
  if (host !== "open.spotify.com") return null;
  const id = url.pathname.match(/^\/(?:intl-[a-z-]+\/)?track\/([A-Za-z0-9]{22})/)?.[1];
  return id ? { platform: "spotify", id, url: `https://open.spotify.com/track/${id}` } : "bad";
}

/**
 * Returns { platform, id, url } for a supported link, { query } for plain text
 * when `allowQuery`, or { error } with a message for the page.
 */
export function resolveSource(raw, { allowQuery = false } = {}) {
  const url = parseUrl(raw);
  if (!url) {
    const text = String(raw || "").trim().replace(/\s+/g, " ");
    if (allowQuery && text.length >= 2 && text.length <= 120 && !/^[a-z]+:\/\//i.test(text)) return { query: text };
    return { error: allowQuery ? "Вставьте ссылку или название трека" : "Вставьте ссылку на видео" };
  }
  const host = hostOf(url);
  for (const parse of [youtube, vk, soundcloud, twitch, kick, tiktok, rutube, pinterest, spotify]) {
    const result = parse(url, host);
    if (result === "bad") return { error: "В ссылке нет видео или трека — откройте его и скопируйте адрес ещё раз" };
    if (result) return result;
  }
  return { error: "Поддерживаются YouTube, VK, TikTok, Rutube, Pinterest, SoundCloud, Twitch, Kick и Spotify" };
}
