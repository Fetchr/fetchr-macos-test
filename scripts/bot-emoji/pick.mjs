#!/usr/bin/env node
/** Checks the chosen public custom emoji (picks.mjs) against Telegram and
 *  writes the emoji → custom_emoji_id map the bot reads at start.
 *
 *   TELEGRAM_BOT_TOKEN=… node scripts/bot-emoji/pick.mjs
 *
 * Output: scripts/assets/bot-emoji/ids.json (override with FETCHR_BOT_EMOJI).
 * Ids Telegram does not know are left out and listed. */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createTelegramApi } from "../lib/bot/telegram-api.mjs";
import { PICKS } from "./picks.mjs";

const OUT = resolve(
  process.env.FETCHR_BOT_EMOJI || fileURLToPath(new URL("../assets/bot-emoji/ids.json", import.meta.url)),
);

if (!process.env.TELEGRAM_BOT_TOKEN) {
  console.error("Set TELEGRAM_BOT_TOKEN");
  process.exit(1);
}

const api = createTelegramApi({ token: process.env.TELEGRAM_BOT_TOKEN, baseUrl: process.env.TELEGRAM_API_BASE });
const unique = [...new Set(PICKS.map((pick) => pick.id))];
const stickers = await api("getCustomEmojiStickers", { custom_emoji_ids: unique });
const known = new Map(stickers.map((sticker) => [sticker.custom_emoji_id, sticker]));

const ids = Object.fromEntries(PICKS.filter((pick) => known.has(pick.id)).map((pick) => [pick.char, pick.id]));
for (const pick of PICKS) {
  const sticker = known.get(pick.id);
  console.log(`${sticker ? "ok  " : "MISS"} ${pick.char}  ${pick.note}${sticker ? `  (${sticker.set_name} ${sticker.emoji})` : ""}`);
}

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, `${JSON.stringify(ids, null, 2)}\n`);
console.log(`${Object.keys(ids).length}/${PICKS.length} → ${OUT}`);
