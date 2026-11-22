#!/usr/bin/env node
/** Fetchr Auth bot (@fetchr_beta_bot): registration, shop, support.
 *
 * Optional env on top of the beta-bot settings:
 *   FETCHR_BOT_ADMIN_IDS      chats that get orders and support tickets
 *                             (default: the creator of the required channel)
 *   (In the bot only Telegram Stars are sold. Robokassa orders come from the
 *   site via site-orders.jsonl and are confirmed here from ResultURL records.)
 *   FETCHR_BOT_DATA_DIR       orders and tickets (default FETCHR_VPS_DATA_DIR)
 *   FETCHR_BOT_SHOP           1 opens the shop; closed by default
 *   FETCHR_BOT_BANNERS_DIR    section banners (default ./assets/bot)
 *   FETCHR_BOT_EMOJI          premium emoji id map from bot-emoji/pick.mjs
 *                             (default ./assets/bot-emoji/ids.json; absent = plain emoji)
 *                             (default https://fetchr.fun/app/)
 */
import dns from "node:dns";
dns.setDefaultResultOrder("ipv4first");
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createBanners } from "./lib/bot/banners.mjs";
import { readFileSync } from "node:fs";

import { createBot } from "./lib/bot/bot.mjs";
import { createEmojiDecorator, loadEmojiIds, loadFetchrLine } from "./lib/bot/premium-emoji.mjs";
import { createPictures } from "./lib/bot/pictures.mjs";
import { createAvatars } from "./lib/bot/avatars.mjs";
import { createRestreamApi } from "./lib/bot/restream.mjs";
import { createLicenseBook } from "./lib/bot/registration.mjs";
import {
  createActivityLog,
  createConsentLog,
  createOrderStore,
  createRateLimiter,
  createSessions,
  createTicketStore,
  pastActivity,
  readJsonLines,
} from "./lib/bot/store.mjs";
import { createTelegramApi } from "./lib/bot/telegram-api.mjs";
import { createWebLoginBox } from "./lib/web-login.mjs";
import { createLicenseKey, normalizeMachineId } from "./license-keygen.mjs";

const env = process.env;
const log = {
  info: (message) => console.log(message),
  error: (message) => console.error(message),
};

if (!env.TELEGRAM_BOT_TOKEN) {
  log.error("TELEGRAM_BOT_TOKEN is required");
  process.exit(1);
}

const licensesPath = resolve(env.FETCHR_BETA_BOT_LOG || "beta-bot-licenses.jsonl");
const dataDir = resolve(env.FETCHR_BOT_DATA_DIR || env.FETCHR_VPS_DATA_DIR || dirname(licensesPath));
const requiredChannel = normalizeChannel(env.FETCHR_BETA_REQUIRED_CHANNEL);

/** Public-pack ids (ids.json) with the Fetchr Line pack on top: tiles in text,
 *  the needs_repainting set in buttons. Empty Fetchr Line ids keep the rest. */
function emojiDecorator() {
  const picked = loadEmojiIds(resolve(env.FETCHR_BOT_EMOJI || fileURLToPath(new URL("./assets/bot-emoji/ids.json", import.meta.url))), log);
  // Fetchr Line (upload-fetchr-line.mjs): by sign name, tiles in text, the repainted set on buttons.
  const line = loadFetchrLine(resolve(env.FETCHR_BOT_EMOJI_LINE || fileURLToPath(new URL("./assets/bot-emoji/fetchr-line.json", import.meta.url))), log);
  return createEmojiDecorator(picked, picked, line);
}

const api = createTelegramApi({ token: env.TELEGRAM_BOT_TOKEN, baseUrl: env.TELEGRAM_API_BASE });
const me = await getMeWithRetry();

const bot = createBot({
  api,
  config: {
    requiredChannel,
    requiredChannelUrl: env.FETCHR_BETA_REQUIRED_CHANNEL_URL || channelToUrl(requiredChannel),
    allowedUsers: parseList(env.FETCHR_BETA_ALLOWED_USERS),
    adminIds: [...parseList(env.FETCHR_BOT_ADMIN_IDS)].map(Number).filter(Number.isFinite),
    botUrl: `https://t.me/${me.username}`,
    shopEnabled: env.FETCHR_BOT_SHOP === "1",
  },
  banners: createBanners({
    dir: resolve(env.FETCHR_BOT_BANNERS_DIR || fileURLToPath(new URL("./assets/bot/", import.meta.url))),
    cachePath: join(dataDir, "bot-banners.json"),
    log,
  }),
  // Screen pictures drawn per user (needs @resvg/resvg-js; without it the MP4 banners are used).
  pictures: createPictures({
    fontsDir: fileURLToPath(new URL("./assets/fonts/", import.meta.url)),
    cachePath: join(dataDir, "bot-pictures.json"),
    // Animated covers (render-covers.mjs); a cover without an MP4 goes out as PNG.
    animationsDir: resolve(env.FETCHR_BOT_COVERS_DIR || fileURLToPath(new URL("./assets/bot/covers/", import.meta.url))),
    avatars: createAvatars({ api, log }),
    log,
  }),
  decorateScreen: emojiDecorator(),
  licenses: createLicenseBook({ path: licensesPath, createLicenseKey, normalizeMachineId }),
  orders: createOrderStore(join(dataDir, "bot-orders.jsonl")),
  winbackPath: join(dataDir, "bot-winback.jsonl"),
  promoPath: join(dataDir, "bot-promo.jsonl"),
  // Restream settings live on the buyer's recorder; its id and token are in
  // the account server's archive state, re-read on every call.
  restreamApi: createRestreamApi({
    base: env.FETCHR_RECORDER_BASE || "http://127.0.0.1:8480",
    readTenant: (userId) => {
      try {
        return JSON.parse(readFileSync(join(dataDir, "archive-tenants.json"), "utf8")).users?.[String(userId)] ?? null;
      } catch {
        return null;
      }
    },
  }),
  dripPath: join(dataDir, "bot-followups.jsonl"),
  channelStatsPath: join(dataDir, "channel-members.jsonl"),
  tickets: createTicketStore(join(dataDir, "bot-tickets.jsonl")),
  sessions: createSessions(),
  activity: createActivityLog(join(dataDir, "bot-activity.jsonl"), {
    seed: pastActivity({
      licensesPath,
      ordersPath: join(dataDir, "bot-orders.jsonl"),
      ticketsPath: join(dataDir, "bot-tickets.jsonl"),
    }),
    archivePath: join(dataDir, "bot-activity-archive.json"),
  }),
  // Both written by vps-api-server.mjs: orders placed on the site, and
  // Robokassa's ResultURL calls that confirm them.
  siteOrders: () => readJsonLines(join(dataDir, "site-orders.jsonl")),
  robokassaPayments: () => readJsonLines(join(dataDir, "robokassa-payments.jsonl")),
  // Bump the version when https://fetchr.fun/soglasie/ changes: everyone is asked again.
  consents: createConsentLog(join(dataDir, "bot-consents.jsonl"), { version: "2026-11-20" }),
  limiter: createRateLimiter({ limit: 6, windowMs: 10 * 60_000 }),
  // «Войти через Telegram» requests, opened by vps-api-server.mjs.
  webLogins: createWebLoginBox(join(dataDir, "web-logins")),
  log,
});

await bot.setup();
log.info(`Fetchr bot @${me.username} started · data in ${dataDir}`);

const PAYMENTS_POLL_MS = 15_000;
(async function pollPayments() {
  try {
    await bot.pollPayments();
    await bot.followUps();
    await bot.recordChannelSize();
  } catch (err) {
    log.error(`Payments poll failed: ${err instanceof Error ? err.message : err}`);
  }
  setTimeout(pollPayments, PAYMENTS_POLL_MS);
})();

let offset = Number(env.TELEGRAM_BOT_OFFSET || 0);
for (;;) {
  try {
    const updates = await api("getUpdates", {
      offset,
      timeout: 30,
      allowed_updates: ["message", "callback_query", "pre_checkout_query"],
    });
    // Telegram cancels a payment unless its pre-checkout is answered within
    // 10 s, so those never wait behind slower updates of the same batch.
    const ordered = [
      ...updates.filter((update) => update.pre_checkout_query),
      ...updates.filter((update) => !update.pre_checkout_query),
    ];
    for (const update of ordered) {
      offset = Math.max(offset, update.update_id + 1);
      await bot.handleUpdate(update);
    }
  } catch (err) {
    log.error(err instanceof Error ? err.message : String(err));
    await sleep(err?.retryAfter ? err.retryAfter * 1000 : 3000);
  }
}

/** At boot the network may come up after the service does. */
async function getMeWithRetry() {
  for (;;) {
    try {
      return await api("getMe");
    } catch (err) {
      log.error(`getMe failed, retrying: ${err instanceof Error ? err.message : err}`);
      await sleep(5000);
    }
  }
}

function parseList(value) {
  return new Set(
    String(value || "")
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean),
  );
}

function normalizeChannel(value) {
  const channel = String(value || "").trim();
  if (!channel) return "";
  if (channel.startsWith("-100")) return channel;
  return channel.startsWith("@") ? channel : `@${channel}`;
}

function channelToUrl(channel) {
  if (!channel || channel.startsWith("-100")) return "";
  return `https://t.me/${channel.replace(/^@/, "")}`;
}

function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms));
}
