/** Test doubles for the bot: a recording Bot API, a test Robokassa and a bot
 *  wired to temp files. Not shipped to the server. */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { normalizeMachineId } from "../../license-keygen.mjs";
import { createBot } from "./bot.mjs";
import { createLicenseBook } from "./registration.mjs";
import { createRobokassa } from "./robokassa.mjs";
import {
  createActivityLog,
  createConsentLog,
  createOrderStore,
  createRateLimiter,
  createSessions,
  createTicketStore,
  readJsonLines,
} from "./store.mjs";
import { TelegramError } from "./telegram-api.mjs";
import { createWebLoginBox } from "../web-login.mjs";

export const ADMIN_ID = 999;
export const USER = { id: 42, first_name: "Анна", username: "anna" };
export const MACHINE_ID = "0123456789ABCDEF0123456789ABCDEF";

export function fakeApi({ member = "member", failEdit = false, failChats = [], rateLimitChats = [] } = {}) {
  const calls = [];
  let nextMessageId = 500;
  const state = { member, failChats: new Set(failChats), rateLimited: new Set(rateLimitChats) };
  let nextFileId = 1;
  async function api(method, body = {}, files = null) {
    const call = { method, body, files, result: null };
    calls.push(call);
    call.result = await respond(method, body, files);
    return call.result;
  }
  /** An upload gets a fresh file_id; a resend by file_id keeps it. */
  function animation(ref) {
    const fileId = ref && !String(ref).startsWith("attach://") ? ref : `anim-${nextFileId++}`;
    return { file_id: fileId, file_unique_id: `u-${fileId}` };
  }
  async function respond(method, body, files) {
    switch (method) {
      case "sendAnimation":
        return { message_id: ++nextMessageId, chat: { id: body.chat_id }, animation: animation(files ? null : body.animation) };
      case "editMessageMedia":
        if (failEdit) throw new TelegramError(method, { error_code: 400, description: "Bad Request: message can't be edited" });
        return { message_id: body.message_id, animation: animation(files ? null : body.media.media) };
      case "editMessageCaption":
        if (failEdit) throw new TelegramError(method, { error_code: 400, description: "Bad Request: message can't be edited" });
        return true;
      case "sendMessage":
      case "sendInvoice":
        if (state.failChats.has(body.chat_id)) {
          throw new TelegramError(method, { error_code: 403, description: "Forbidden: bot was blocked by the user" });
        }
        if (state.rateLimited.delete(body.chat_id)) {
          throw new TelegramError(method, { error_code: 429, description: "Too Many Requests: retry after 0", parameters: { retry_after: 0 } });
        }
        return { message_id: ++nextMessageId, chat: { id: body.chat_id }, text: body.text };
      case "copyMessage":
        return { message_id: ++nextMessageId };
      case "editMessageText":
        if (failEdit) throw new TelegramError(method, { error_code: 400, description: "Bad Request: message can't be edited" });
        return true;
      case "getChatMember":
        return { status: state.member };
      case "getChatMemberCount":
        return 1234;
      case "getChatAdministrators":
        return [{ status: "administrator", user: { id: 7 } }, { status: "creator", user: { id: ADMIN_ID } }];
      case "getMyDescription":
        return { description: "" };
      case "getMyShortDescription":
        return { short_description: "" };
      default:
        return true;
    }
  }
  const of = (method) => calls.filter((call) => call.method === method);
  return {
    api,
    calls,
    state,
    of,
    last: (method) => of(method).at(-1)?.body,
    /** Whatever the user saw last: a fresh message or an edit. */
    lastScreen: () => calls.filter((call) => ["sendMessage", "editMessageText"].includes(call.method)).at(-1)?.body,
    reset: () => calls.splice(0, calls.length),
  };
}

/** Robokassa with fixed passwords; `payments` stands in for the JSONL the
 *  API server writes on ResultURL. */
export function fakeRobokassa() {
  return { kassa: createRobokassa({ login: "fetchr", password1: "p1", password2: "p2" }), payments: [], siteOrders: [] };
}

export function makeBot({
  api,
  robokassa = null,
  consentVersion = null,
  allowedUsers = [],
  limit = 6,
  shop = true,
  banners = null,
  dir = mkdtempSync(join(tmpdir(), "fetchr-bot-")),
  createLicenseKey = ({ machine_id }) => `FTR1.test.${machine_id}`,
  restreamApi = null,
  now = undefined,
} = {}) {
  const licensesPath = join(dir, "licenses.jsonl");
  const logs = [];
  const bot = createBot({
    api,
    config: {
      requiredChannel: "@streamcutter",
      requiredChannelUrl: "https://t.me/streamcutter",
      allowedUsers: new Set(allowedUsers.map(String)),
      adminIds: [],
      botUrl: "https://t.me/fetchr_beta_bot",
      shopEnabled: shop,
    },
    banners,
    restreamApi,
    ...(now ? { now } : {}),
    licenses: createLicenseBook({
      path: licensesPath,
      createLicenseKey,
      normalizeMachineId,
    }),
    orders: createOrderStore(join(dir, "orders.jsonl")),
    winbackPath: join(dir, "winback.jsonl"),
    promoPath: join(dir, "promo.jsonl"),
    dripPath: join(dir, "followups.jsonl"),
    channelStatsPath: join(dir, "channel-members.jsonl"),
    sleep: async () => {},
    tickets: createTicketStore(join(dir, "tickets.jsonl")),
    sessions: createSessions(),
    activity: createActivityLog(join(dir, "activity.jsonl")),
    robokassaPayments: () => robokassa?.payments ?? [],
    siteOrders: () => [...(robokassa?.siteOrders ?? []), ...readJsonLines(join(dir, "site-orders.jsonl"))],
    consents: consentVersion ? createConsentLog(join(dir, "consents.jsonl"), { version: consentVersion }) : null,
    limiter: createRateLimiter({ limit, windowMs: 60_000 }),
    webLogins: createWebLoginBox(join(dir, "web-logins")),
    log: { info: (line) => logs.push(line), error: (line) => logs.push(`ERROR ${line}`) },
  });
  return { bot, dir, licensesPath, logs };
}

let updateId = 1;

export function textUpdate(text, { from = USER, chatId = from.id, replyTo = null } = {}) {
  return {
    update_id: updateId++,
    message: {
      message_id: 10_000 + updateId,
      from,
      chat: { id: chatId, type: "private" },
      text,
      ...(replyTo ? { reply_to_message: { message_id: replyTo } } : {}),
    },
  };
}

export function callbackUpdate(data, { from = USER, messageId = 77 } = {}) {
  return {
    update_id: updateId++,
    callback_query: {
      id: `cb${updateId}`,
      from,
      data,
      message: { message_id: messageId, chat: { id: from.id, type: "private" } },
    },
  };
}

/** All callback_data and URL buttons of a reply_markup, flattened. */
export function buttons(markup) {
  return (markup?.inline_keyboard || []).flat();
}
