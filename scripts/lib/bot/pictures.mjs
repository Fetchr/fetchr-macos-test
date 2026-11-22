/** Turns a screen's picture (cards.mjs) into a Telegram photo.
 *
 * `screen.card` is the home dashboard, drawn per user; `screen.media` names
 * a static cover. The SVG is rendered to PNG with resvg and uploaded once:
 * the file_id Telegram returns is cached by the SVG's hash, so an unchanged
 * picture is never uploaded twice. Covers stay in the cache file across
 * restarts; per-user cards only in memory.
 *
 * Animated covers: scripts/bot-banners/render-covers.mjs renders each common
 * cover to a looping MP4 named by the hash of its still SVG (no avatar), in
 * `animationsDir`. When that file exists the screen goes out as an
 * animation (first frame = the still); otherwise as the PNG, with the
 * user's photo on it. Animations are cached by file_id like photos.
 *
 * Without @resvg/resvg-js installed and without an MP4 `resolve` returns
 * null and delivery falls back to the old MP4 banners. */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { homeCardSvg } from "./cards.mjs";
import { coverSvg } from "./covers.mjs";

const MEMORY_LIMIT = 2000;

async function loadResvg(log) {
  try {
    const { Resvg } = await import("@resvg/resvg-js");
    return Resvg;
  } catch (err) {
    log?.error(`Bot pictures off, @resvg/resvg-js not installed: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

export function svgOf(screen, avatar = null) {
  if (screen?.card) return homeCardSvg({ ...screen.card, avatar });
  if (screen?.media) return coverSvg(screen.media, screen.art, avatar);
  return null;
}

/** The name of a cover's animated MP4: the hash of its still SVG. */
export const animationKey = (svg) => createHash("sha1").update(svg).digest("hex");

export function createPictures({ fontsDir, cachePath = null, log = null, render = null, avatars = null, animationsDir = null }) {
  let renderer = render ? Promise.resolve(render) : null;
  const fileIds = new Map();
  const pngs = new Map();
  let saved = {};
  if (cachePath) {
    try {
      saved = JSON.parse(readFileSync(cachePath, "utf8"));
    } catch {
      saved = {};
    }
  }

  function getRenderer() {
    renderer ??= loadResvg(log).then((Resvg) =>
      Resvg
        ? (svg) =>
            new Resvg(svg, { font: { fontDirs: [fontsDir], loadSystemFonts: false, defaultFontFamily: "Inter" } })
              .render()
              .asPng()
        : null,
    );
    return renderer;
  }

  /** A prerendered MP4 for this cover, if there is one. */
  function animationOf(screen, still) {
    if (!animationsDir || !screen?.media) return null;
    const key = `a:${animationKey(still)}`;
    const fileId = fileIds.get(key) ?? saved[key];
    if (fileId) return { key, type: "animation", fileId };
    const path = join(animationsDir, `${key.slice(2)}.mp4`);
    if (!existsSync(path)) return null;
    return { key, type: "animation", upload: { path, filename: "fetchr.mp4", type: "video/mp4" }, persist: true };
  }

  const bounded = (map, key, value) => {
    if (map.size >= MEMORY_LIMIT) map.delete(map.keys().next().value);
    map.set(key, value);
  };

  return {
    /** { key, fileId } or { key, upload } for the screen's picture, or null. */
    /** `chatId` is the user in a private chat: their photo goes on the picture. */
    async resolve(screen, chatId = null) {
      const still = svgOf(screen);
      if (!still) return null;
      const animation = animationOf(screen, still);
      if (animation) return animation;
      const avatar = avatars && chatId ? await avatars.get(Number(chatId)) : null;
      const svg = svgOf(screen, avatar);
      if (!svg) return null;
      const draw = await getRenderer();
      if (!draw) return null;
      const key = createHash("sha1").update(svg).digest("hex");
      const fileId = fileIds.get(key) ?? saved[key];
      if (fileId) return { key, fileId };
      let png = pngs.get(key);
      if (!png) {
        try {
          png = Buffer.from(draw(svg));
        } catch (err) {
          log?.error(`Picture render failed: ${err instanceof Error ? err.message : err}`);
          return null;
        }
        bounded(pngs, key, png);
      }
      return { key, upload: { buffer: png, filename: "fetchr.png", type: "image/png" }, persist: !screen.card && !screen.art?.id && !avatar };
    },

    /** Keeps the file_id of an uploaded photo (the largest size). */
    remember(picture, message) {
      const fileId = message?.photo?.at(-1)?.file_id ?? message?.animation?.file_id ?? message?.document?.file_id;
      if (!fileId || !picture?.key || picture.fileId) return;
      bounded(fileIds, picture.key, fileId);
      pngs.delete(picture.key);
      if (!picture.persist || !cachePath) return;
      saved = { ...saved, [picture.key]: fileId };
      try {
        writeFileSync(cachePath, `${JSON.stringify(saved, null, 2)}\n`, "utf8");
      } catch (err) {
        log?.error(`Picture cache not saved: ${err instanceof Error ? err.message : err}`);
      }
    },
  };
}
