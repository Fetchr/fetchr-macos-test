/** "Войти через Telegram" on fetchr.fun: the site and @fetchr_beta_bot are
 *  separate processes sharing the data dir, so a sign-in is handed over as a
 *  small file per request.
 *
 *   site  -> open(id, info)          pending request, what the bot shows the user
 *   bot   -> decide(id, user, ok)    the user tapped «Войти» or «Отмена»
 *   site  -> read(id), close(id)     poll until decided, then drop the file
 *
 * The file name is a hash of the id, so a directory listing never yields an id
 * that could be replayed. Expired requests are swept by the site.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const WEB_LOGIN_TTL_MS = 5 * 60_000;
export const WEB_LOGIN_PREFIX = "web_";
const ID_PATTERN = /^[A-Za-z0-9_-]{32}$/;

export const isWebLoginId = (value) => ID_PATTERN.test(String(value || ""));

/** `/start web_<id>` payload -> id, or null. */
export function webLoginIdFromStart(arg) {
  const value = String(arg || "");
  if (!value.startsWith(WEB_LOGIN_PREFIX)) return null;
  const id = value.slice(WEB_LOGIN_PREFIX.length);
  return isWebLoginId(id) ? id : null;
}

/** "Chrome · Windows" from a User-Agent; good enough to recognise your own browser. */
export function describeBrowser(userAgent) {
  const ua = String(userAgent || "");
  const browser =
    [
      [/YaBrowser\//, "Яндекс Браузер"],
      [/Edg\//, "Edge"],
      [/OPR\/|Opera/, "Opera"],
      [/Firefox\//, "Firefox"],
      [/Chrome\//, "Chrome"],
      [/Safari\//, "Safari"],
    ].find(([pattern]) => pattern.test(ua))?.[1] || "Браузер";
  const os =
    [
      [/Windows/, "Windows"],
      [/Android/, "Android"],
      [/iPhone|iPad|iPod/, "iOS"],
      [/Mac OS X|Macintosh/, "macOS"],
      [/Linux/, "Linux"],
    ].find(([pattern]) => pattern.test(ua))?.[1] || "";
  return [browser, os].filter(Boolean).join(" · ");
}

export function createWebLoginBox(dir, { now = () => Date.now() } = {}) {
  const fileOf = (id) => join(dir, `${createHash("sha256").update(String(id)).digest("hex")}.json`);

  function write(id, record) {
    mkdirSync(dir, { recursive: true });
    const path = fileOf(id);
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(record), { mode: 0o600 });
    renameSync(tmp, path);
  }

  /** The request, or null when unknown, malformed or expired. */
  function read(id) {
    if (!isWebLoginId(id)) return null;
    const path = fileOf(id);
    if (!existsSync(path)) return null;
    try {
      const record = JSON.parse(readFileSync(path, "utf8"));
      return record.expires_at > now() ? record : null;
    } catch {
      return null;
    }
  }

  function open(id, info = {}) {
    const stamp = now();
    const record = { status: "pending", created_at: stamp, expires_at: stamp + WEB_LOGIN_TTL_MS, browser: info.browser || "", ip: info.ip || "" };
    write(id, record);
    return record;
  }

  /** Only a pending, live request can be decided, and only once. */
  function decide(id, user, approved) {
    const record = read(id);
    if (!record || record.status !== "pending") return null;
    const next = {
      ...record,
      status: approved ? "approved" : "denied",
      user_id: Number(user?.id) || null,
      decided_at: now(),
    };
    write(id, next);
    return next;
  }

  function close(id) {
    if (!isWebLoginId(id)) return;
    try {
      unlinkSync(fileOf(id));
    } catch {}
  }

  function sweep() {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".json")) continue;
      const path = join(dir, name);
      try {
        if (JSON.parse(readFileSync(path, "utf8")).expires_at <= now()) unlinkSync(path);
      } catch {
        try {
          unlinkSync(path);
        } catch {}
      }
    }
  }

  return { open, read, decide, close, sweep };
}
