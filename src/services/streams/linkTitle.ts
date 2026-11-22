/**
 * Человеческое название для голой ссылки на поток, у которой нет своего title.
 *
 * Плейлист Twitch на CDN несёт ник и время старта прямо в пути:
 * `/<hash>_<login>_<streamId>_<unix>/chunked/index-dvr.m3u8`.
 */
export function titleFromStreamUrl(url: string): { title: string; username: string | null } {
  try {
    const parsed = new URL(url);
    const segments = parsed.pathname.split("/").filter(Boolean);
    for (const segment of segments) {
      const match = segment.match(/^[0-9a-f]{20}_([a-z0-9_]+)_(\d{8,})_(\d{10})$/i);
      if (match) {
        const [, login, , unix] = match;
        const started = new Date(Number(unix) * 1000);
        const date = started.toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
        return { title: `${login} · ${date}`, username: login };
      }
    }
    const last = segments[segments.length - 1]?.replace(/\.(m3u8|mp4|ts)$/i, "");
    const name = last && last !== "index" && last !== "index-dvr" && last !== "playlist" ? last : parsed.hostname;
    return { title: decodeURIComponent(name), username: null };
  } catch {
    return { title: url, username: null };
  }
}
