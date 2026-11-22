/** Minimal Bot API client. The token lives only in the request URL, which is
 *  never logged: errors carry the method and Telegram's description only. */

import { openAsBlob } from "node:fs";

export class TelegramError extends Error {
  constructor(method, payload) {
    super(`Telegram ${method} failed: ${payload?.error_code ?? "?"} ${payload?.description ?? ""}`.trim());
    this.name = "TelegramError";
    this.method = method;
    this.code = payload?.error_code ?? 0;
    this.description = String(payload?.description ?? "");
    this.retryAfter = payload?.parameters?.retry_after ?? 0;
  }
}

/** Edits that change nothing are a no-op, not a failure. */
export function isNotModified(err) {
  return err instanceof TelegramError && err.description.includes("message is not modified");
}

/** A message the bot can no longer edit: too old, deleted, or not a text one. */
export function isUneditable(err) {
  return (
    err instanceof TelegramError &&
    err.code === 400 &&
    /message (to edit not found|can't be edited)|no text in the message|no media in the message|message_id_invalid/i.test(
      err.description,
    )
  );
}

export function createTelegramApi({
  token,
  baseUrl = "https://api.telegram.org",
  fetchImpl = fetch,
}) {
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN is required");
  const root = `${baseUrl.replace(/\/+$/, "")}/bot${token}`;

  /** `files` maps a form field to { path | buffer, filename, type }; with it the call
   *  goes out as multipart/form-data, objects in `body` JSON-encoded. */
  async function encode(body, files) {
    if (!files) {
      return { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
    }
    const form = new FormData();
    for (const [key, value] of Object.entries(body)) {
      if (value !== undefined) form.append(key, typeof value === "object" ? JSON.stringify(value) : String(value));
    }
    for (const [field, file] of Object.entries(files)) {
      const blob = file.buffer ? new Blob([file.buffer], { type: file.type }) : await openAsBlob(file.path, { type: file.type });
      form.append(field, blob, file.filename);
    }
    return { headers: {}, body: form };
  }

  const fileRoot = `${baseUrl.replace(/\/+$/, "")}/file/bot${token}`;

  /** Bytes of a file from getFile, capped at `maxBytes`; the token stays in the URL only. */
  async function download(filePath, maxBytes = 2 * 1024 * 1024) {
    if (!/^[\w./-]+$/.test(String(filePath || ""))) throw new TelegramError("download", { description: "bad file path" });
    let response;
    try {
      response = await fetchImpl(`${fileRoot}/${filePath}`, { signal: AbortSignal.timeout(20_000) });
    } catch (err) {
      throw new TelegramError("download", { error_code: 0, description: `network: ${err instanceof Error ? err.message : String(err)}` });
    }
    if (!response.ok) throw new TelegramError("download", { error_code: response.status, description: "file not served" });
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > maxBytes) throw new TelegramError("download", { description: "file too large" });
    return bytes;
  }

  async function call(method, body = {}, files = null) {
    // Long polling holds the request open for `timeout` seconds; uploads get
    // a minute; everything else should answer quickly or be retried.
    const timeoutMs =
      method === "getUpdates" ? (Number(body.timeout || 0) + 15) * 1000 : files ? 60_000 : 20_000;
    let response;
    try {
      response = await fetchImpl(`${root}/${method}`, {
        method: "POST",
        ...(await encode(body, files)),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new TelegramError(method, {
        error_code: 0,
        description: `network: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new TelegramError(method, { error_code: response.status, description: "invalid JSON" });
    }
    if (!response.ok || !payload?.ok) throw new TelegramError(method, payload);
    return payload.result;
  }

  return Object.assign(call, { download });
}
