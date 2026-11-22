/** Разбор того, что пользователь вставил, перетащил или держит в буфере. */

const SCHEME_URL = /^[a-z][a-z0-9+.-]*:\/\/\S+$/i;
const BARE_URL = /^(www\.)?[a-z0-9-]+(\.[a-z0-9-]+)+\/\S*$/i;
const URL_IN_TEXT = /\bhttps?:\/\/[^\s"'<>]+/gi;
const TRAILING_PUNCT = /[),.;:!?\]]+$/;

export const BATCH_LIMIT = 20;

export function looksLikeUrl(text: string): boolean {
  if (!text || /\s/.test(text)) return false;
  return SCHEME_URL.test(text) || BARE_URL.test(text);
}

/** Все http(s)-ссылки из текста, без повторов, в исходном порядке. */
export function extractUrls(text: string, limit = BATCH_LIMIT): string[] {
  const found = (text.match(URL_IN_TEXT) ?? []).map((url) => url.replace(TRAILING_PUNCT, ""));
  return [...new Set(found)].slice(0, limit);
}

/** Ссылки из перетащенного файла: .url и .webloc несут одну, .txt и .m3u8 — список. */
export function urlsFromLinkFile(name: string, contents: string): string[] {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "url") {
    const line = contents.split(/\r?\n/).find((row) => /^URL=/i.test(row.trim()));
    const url = line?.trim().slice(4).trim();
    return url && looksLikeUrl(url) ? [url] : [];
  }
  if (ext === "webloc") {
    const match = contents.match(/<string>\s*(https?:\/\/[^<\s]+)\s*<\/string>/i);
    return match ? [match[1]] : [];
  }
  return extractUrls(contents);
}

/** Короткая подпись ссылки для чипа: без схемы и www, обрезана. */
export function shortUrl(url: string, max = 38): string {
  const bare = url.replace(/^[a-z]+:\/\//i, "").replace(/^www\./i, "").replace(/\/$/, "");
  return bare.length > max ? `${bare.slice(0, max - 1)}…` : bare;
}
