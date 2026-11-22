/** Section banners: looping MP4s that Telegram shows as GIFs above a screen's
 *  text. Rendered by scripts/bot-banners/render.mjs into scripts/assets/bot.
 *
 * Each banner is uploaded once. Its file_id is cached next to the other bot
 * data, keyed by a hash of the file, so every later screen reuses it without
 * an upload and a re-rendered banner is uploaded again on first use. A
 * missing file only costs that section its picture: the screen goes out as
 * plain text.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const BANNERS = ["home", "register", "support", "shop"];

export function createBanners({ dir, cachePath, log }) {
  const hashes = new Map();
  for (const name of BANNERS) {
    const path = join(dir, `${name}.mp4`);
    if (existsSync(path)) hashes.set(name, createHash("sha1").update(readFileSync(path)).digest("hex"));
    else log.error(`Banner ${path} is missing: that section is sent as text`);
  }

  let cache = {};
  try {
    cache = JSON.parse(readFileSync(cachePath, "utf8"));
  } catch {
    cache = {};
  }

  const cached = (name) => (cache[name]?.hash === hashes.get(name) ? cache[name] : null);

  return {
    has: (name) => hashes.has(name),

    /** Either a cached file_id or the file to upload. */
    source(name) {
      const entry = cached(name);
      if (entry) return { fileId: entry.file_id, upload: null };
      return { fileId: null, upload: { path: join(dir, `${name}.mp4`), filename: `${name}.mp4`, type: "video/mp4" } };
    },

    /** Keeps the file_id Telegram assigned to an upload. */
    remember(name, message) {
      const file = message?.animation || message?.document || message?.video;
      if (!file?.file_id || !hashes.has(name) || cached(name)) return;
      cache = { ...cache, [name]: { hash: hashes.get(name), file_id: file.file_id } };
      try {
        writeFileSync(cachePath, `${JSON.stringify(cache, null, 2)}\n`, "utf8");
      } catch (err) {
        log.error(`Banner cache not saved: ${err instanceof Error ? err.message : err}`);
      }
    },
  };
}
