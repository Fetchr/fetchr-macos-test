/** Server-side safety net for client logs and error reports. Current clients
 *  scrub before sending (src-tauri/src/error_reports/scrub.rs, whose rules this
 *  follows); this catches old clients and forged bodies, and cleans logs stored
 *  before it existed. Placeholders the client already put there (`<path>.mp4`,
 *  `<url:host>`) stay. */

const URL_WITH_SCHEME = /\b[a-z][a-z0-9+.-]{1,15}:\/\/[^\s"'<>()]+/gi;
const HEADER_SECRET = /\b(proxy-authorization|authorization|set-cookie|cookie)\b\s*[:=]\s*[^\r\n"']*/gi;
const BEARER = /\bbearer\s+[a-z0-9._~+/=-]+/gi;
const KEY_VALUE_SECRET =
  /\b(access[_-]?token|refresh[_-]?token|auth[_-]?token|client[_-]?secret|api[_-]?key|x-api-key|password|passwd|pwd|secret|signature|sig|token)\b(["']?\s*[:=]\s*["']?)(?!<)[^\s"'&,;]+/gi;
// "session: started" is a log line; "session=abc" is a value.
const SESSION_VALUE = /\b(session(?:_?id)?|sid)=[^\s"'&,;<][^\s"'&,;]*/gi;
const QUERY_WITHOUT_SCHEME = /\b((?:[a-z0-9-]+\.)+[a-z]{2,}\/[^\s"'<>?]*)\?[^\s"'<>]+/gi;
const LICENSE_KEY = /\b(?:FTR1|SCB1)\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g;
const CREDENTIALS = /[^\s:@/"'<>]+:[^\s@/"'<>]+@(\[[0-9a-f:]+\]|[a-z0-9.-]+)/gi;
const WINDOWS_PATH_START = /(?:\\\\\?\\)?\b[a-z]:[\\/]+|\\\\[^\\\s]+\\+|\\+(?:users|documents and settings)\\+/gi;
const NEXT_DRIVE = /\b[a-z]:[\\/]+/i;
// An apostrophe closes a quote only before a break: O'Brien is part of a path.
const PATH_STOP = /["<>|*?`«»\r\n]|'(?=[\s,;:)\]]|$)/;
const FILE_EXTENSION = /\.[A-Za-z][A-Za-z0-9]{0,4}/g;
const UNIX_PATH = /(^|[\s"'(=])(\/(?:[^/\s"'<>]+\/)+[^/\s"'<>]*)/gm;
const EMAIL = /\b[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}\b/gi;
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const IPV6 = /\b(?:[0-9a-f]{1,4}:){1,7}:(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4}){0,6})?|\b(?:[0-9a-f]{1,4}:){3,7}[0-9a-f]{1,4}\b/gi;
const IPV4 = /\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b/g;
const EXTRACTOR_ID = /\[([A-Za-z0-9:_ -]{2,30})\]\s+([^\s:[\]]+):/g;
const TOKEN_CANDIDATE = /[A-Za-z0-9_+=/-]{20,}/g;

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

/** `<path>.mp4`: the extension says what kind of file, the rest could name someone. */
function maskedPath(path) {
  const trimmed = path.replace(/[,;:)\].\s]+$/, "");
  const file = trimmed.split(/[\\/]/).pop() || "";
  const extension = /\.([A-Za-z][A-Za-z0-9]{0,4})$/.exec(file);
  return extension ? `<path>.${extension[1].toLowerCase()}` : "<path>";
}

/** Folder names may hold spaces, so a path runs to its last separator on the
 *  line; the file name ends with its extension, or at the first space. */
function pathEnd(text, from) {
  const rest = text.slice(from);
  const stop = rest.search(PATH_STOP);
  let region = stop < 0 ? rest : rest.slice(0, stop);
  const drive = region.search(NEXT_DRIVE);
  if (drive >= 0) region = region.slice(0, drive);
  const nameStart = Math.max(region.lastIndexOf("\\"), region.lastIndexOf("/")) + 1;
  const name = region.slice(nameStart);
  for (const match of name.matchAll(FILE_EXTENSION)) {
    const after = name[match.index + match[0].length];
    if (after === undefined || /[\s,;:)\]]/.test(after)) return from + nameStart + match.index + match[0].length;
  }
  const space = name.search(/\s/);
  return from + nameStart + (space < 0 ? name.length : space);
}

function maskWindowsPaths(text) {
  let out = "";
  let cursor = 0;
  const start = new RegExp(WINDOWS_PATH_START);
  for (;;) {
    start.lastIndex = cursor;
    const found = start.exec(text);
    if (!found) return out + text.slice(cursor);
    const end = pathEnd(text, found.index + found[0].length);
    out += text.slice(cursor, found.index) + maskedPath(text.slice(found.index, end));
    cursor = end;
  }
}

function looksLikeToken(candidate) {
  const digits = candidate.replace(/\D/g, "").length;
  const letters = candidate.replace(/[^a-z]/gi, "").length;
  return (digits >= 2 && letters >= 2) || candidate.length >= 40;
}

export function maskSensitiveText(value) {
  const masked = String(value ?? "")
    .replace(URL_WITH_SCHEME, (url) => (hostOf(url) ? `<url:${hostOf(url)}>` : "<url>"))
    .replace(HEADER_SECRET, "$1: <secret>")
    .replace(BEARER, "<secret>")
    .replace(KEY_VALUE_SECRET, "$1$2<secret>")
    .replace(SESSION_VALUE, "$1=<secret>")
    .replace(QUERY_WITHOUT_SCHEME, "$1?<query>")
    .replace(LICENSE_KEY, "<license>")
    .replace(CREDENTIALS, "<credentials>@$1");
  return maskWindowsPaths(masked)
    .replace(UNIX_PATH, (_, lead, path) => `${lead}${maskedPath(path)}`)
    .replace(EMAIL, "<email>")
    .replace(UUID, "<id>")
    .replace(IPV6, (found) => (/\d/.test(found) ? "<ip>" : found))
    .replace(IPV4, "<ip>")
    // yt-dlp's own words ("[download] Destination:") are not ids.
    .replace(EXTRACTOR_ID, (whole, label, id) => (/^\p{Lu}\p{L}*$/u.test(id) ? whole : `[${label}] <id>:`))
    .replace(TOKEN_CANDIDATE, (found) => (looksLikeToken(found) ? "<token>" : found));
}

/** The same over every string inside a report's context. */
export function maskDeep(value) {
  if (typeof value === "string") return maskSensitiveText(value);
  if (Array.isArray(value)) return value.map(maskDeep);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, maskDeep(item)]));
  }
  return value;
}
