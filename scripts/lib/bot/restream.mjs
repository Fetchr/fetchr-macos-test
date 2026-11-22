/** «📡 Рестрим» in the bot: which recorded streamers go to which platforms.
 *
 * Settings live on the buyer's recorder (GET/POST /restream on the storage
 * server); the bot only edits them. Stream keys are sent once and never shown
 * back — the recorder returns the last four characters. A message carrying a
 * key is deleted from the chat right after it is read. */

import { randomBytes } from "node:crypto";

import {
  askScreen,
  confirmOwnScreen,
  confirmRemoveScreen,
  folderScreen,
  noTenantScreen,
  notConnectedScreen,
  pickChannelScreen,
  pickPlatformScreen,
  restreamHomeScreen,
} from "./restream-screens.mjs";

const URL_RE = /^rtmps?:\/\/[A-Za-z0-9.-]{3,253}(:\d{1,5})?(\/[A-Za-z0-9._~/-]{0,200})?$/;
const KEY_RE = /^[A-Za-z0-9._~=?&-]{4,200}$/;
const CHANNEL_RE = /^[a-z0-9_]{2,40}$/;

const ERRORS = {
  "channel is not recorded": "Этого стримера нет в вашем архиве — добавьте его в приложении Fetchr.",
  "more platforms than the plan allows": "Достигнут лимит площадок по тарифу — докупите место в магазине.",
  "more streamers than the plan allows": "Достигнут лимит стримеров для рестрима — докупите место в магазине.",
  "too many platforms for one streamer": "У одного стримера может быть не больше 4 площадок.",
  "bad stream key": "Ключ выглядит неверно — скопируйте его целиком, без пробелов.",
  "bad server url": "Адрес сервера должен начинаться с rtmp:// или rtmps://.",
  "plan is not active": "Тариф не активен — продлите его в магазине.",
};

export function errorText(err) {
  const detail = String(err?.detail || err?.message || "");
  return ERRORS[detail] || "Сервер рестрима не ответил — попробуйте через минуту.";
}

/** Folders as the recorder expects them back: keys left out keep the saved ones. */
function toPayload(folders) {
  return folders.map((folder) => ({
    channel: folder.channel,
    enabled: folder.enabled,
    outputs: folder.outputs.map((o) => ({
      id: o.id,
      platform: o.platform,
      ...(o.url ? { url: o.url } : {}),
      key: o.key ?? null,
      enabled: o.enabled,
    })),
  }));
}

export function createRestream({ api, restreamApi, sessions, show, send, log }) {
  async function load(userId) {
    const client = restreamApi?.forUser(userId);
    if (!client) return { screen: noTenantScreen() };
    try {
      const view = await client.get();
      if (!view?.limits?.streamers) return { screen: notConnectedScreen() };
      return { client, view };
    } catch (err) {
      log.error(`Restream view for ${userId} failed: ${err?.message || err}`);
      return { screen: { text: `⚠️ ${errorText(err)}`, markup: { inline_keyboard: [[{ text: "‹ Меню", callback_data: "home" }]] } } };
    }
  }

  async function save(client, folders) {
    return client.save(toPayload(folders));
  }

  /** Copy of the folders with one changed by `change(folder)`; `null` removes it. */
  function edited(view, index, change) {
    return view.folders
      .map((folder, i) => (i === index ? change({ ...folder, outputs: folder.outputs.map((o) => ({ ...o })) }) : folder))
      .filter(Boolean);
  }

  async function home(chatId, messageId, from, notice = "") {
    sessions.set(from.id, { awaiting: null });
    const { view, screen } = await load(from.id);
    return show(chatId, messageId, screen || restreamHomeScreen({ view, notice }));
  }

  async function folder(chatId, messageId, from, index, notice = "") {
    const { view, screen } = await load(from.id);
    if (screen) return show(chatId, messageId, screen);
    if (!view.folders[index]) return show(chatId, messageId, restreamHomeScreen({ view }));
    return show(chatId, messageId, folderScreen({ view, index, notice }));
  }

  /** Apply a change, then show the folder (or home when it is gone). Returns a toast. */
  async function change(chatId, messageId, from, index, mutate, { toHome = false } = {}) {
    const { client, view, screen } = await load(from.id);
    if (screen) return show(chatId, messageId, screen);
    if (!view.folders[index]) return home(chatId, messageId, from);
    try {
      const next = await save(client, edited(view, index, mutate));
      if (toHome || !next.folders[index]) return show(chatId, messageId, restreamHomeScreen({ view: next }));
      return show(chatId, messageId, folderScreen({ view: next, index }));
    } catch (err) {
      return show(chatId, messageId, folderScreen({ view, index, notice: `⚠️ ${errorText(err)}` }));
    }
  }

  async function addFolder(chatId, messageId, from, channel) {
    const { client, view, screen } = await load(from.id);
    if (screen) return show(chatId, messageId, screen);
    if (!CHANNEL_RE.test(channel) || view.folders.some((f) => f.channel === channel)) return home(chatId, messageId, from);
    try {
      const next = await save(client, [...view.folders, { channel, enabled: true, outputs: [] }]);
      const index = next.folders.findIndex((f) => f.channel === channel);
      return show(chatId, messageId, pickPlatformScreen({ view: next, index }));
    } catch (err) {
      return show(chatId, messageId, restreamHomeScreen({ view, notice: `⚠️ ${errorText(err)}` }));
    }
  }

  async function askPlatform(chatId, messageId, from, index, platform) {
    const { view, screen } = await load(from.id);
    if (screen) return show(chatId, messageId, screen);
    if (!view.folders[index] || !view.platforms?.[platform]) return home(chatId, messageId, from);
    const step = view.platforms[platform].url ? "key" : "url";
    sessions.set(from.id, { awaiting: "restream", rsChannel: view.folders[index].channel, rsPlatform: platform, rsStep: step, rsUrl: null });
    return show(chatId, messageId, askScreen({ view, index, platform, step }));
  }

  /** A text message while the bot waits for a server address or a stream key. */
  async function onText(message) {
    const chatId = message.chat.id;
    const from = message.from;
    const session = sessions.get(from.id);
    const text = String(message.text || "").trim();
    const { rsChannel: channel, rsPlatform: platform, rsStep: step } = session;
    // Both answers may carry a secret (some services put the key in the server
    // address): take the message off the chat before anything else.
    await api("deleteMessage", { chat_id: chatId, message_id: message.message_id }).catch(() => {});
    const { client, view, screen } = await load(from.id);
    if (screen) {
      sessions.set(from.id, { awaiting: null });
      return send(chatId, screen);
    }
    const index = view.folders.findIndex((f) => f.channel === channel);
    if (index < 0) {
      sessions.set(from.id, { awaiting: null });
      return send(chatId, restreamHomeScreen({ view }));
    }
    if (step === "url") {
      if (!URL_RE.test(text)) return send(chatId, { text: "⚠️ Адрес сервера должен начинаться с rtmp:// или rtmps:// — пришлите его ещё раз." });
      sessions.set(from.id, { rsUrl: text, rsStep: "key" });
      return send(chatId, askScreen({ view, index, platform, step: "key" }));
    }
    if (!KEY_RE.test(text)) return send(chatId, { text: "⚠️ Ключ выглядит неверно — скопируйте его целиком, без пробелов, и пришлите ещё раз." });
    const output = {
      id: randomBytes(4).toString("hex"),
      platform,
      ...(session.rsUrl ? { url: session.rsUrl } : {}),
      key: text,
      enabled: true,
    };
    sessions.set(from.id, { awaiting: null });
    try {
      const next = await save(client, edited(view, index, (folder) => ({ ...folder, outputs: [...folder.outputs, output] })));
      return send(chatId, folderScreen({ view: next, index, notice: "✅ Площадка добавлена. Рестрим начнётся сам, когда стример выйдет в эфир." }));
    } catch (err) {
      return send(chatId, folderScreen({ view, index, notice: `⚠️ ${errorText(err)}` }));
    }
  }

  /** Callback `rs:…`. Returns a toast or null. */
  async function route([action, a, b], chatId, messageId, from) {
    const i = Number(a);
    const j = Number(b);
    switch (action) {
      case undefined:
      case "":
        return home(chatId, messageId, from);
      case "f":
        sessions.set(from.id, { awaiting: null });
        return folder(chatId, messageId, from, i);
      case "add": {
        const { view, screen } = await load(from.id);
        return show(chatId, messageId, screen || pickChannelScreen({ view }));
      }
      case "n":
        return show(chatId, messageId, confirmOwnScreen({ channel: CHANNEL_RE.test(a || "") ? a : "" }));
      case "y":
        return addFolder(chatId, messageId, from, a);
      case "p": {
        const { view, screen } = await load(from.id);
        if (screen) return show(chatId, messageId, screen);
        return show(chatId, messageId, view.folders[i] ? pickPlatformScreen({ view, index: i }) : restreamHomeScreen({ view }));
      }
      case "pp":
        return askPlatform(chatId, messageId, from, i, b);
      case "t":
        return change(chatId, messageId, from, i, (f) => ({
          ...f, outputs: f.outputs.map((o, k) => (k === j ? { ...o, enabled: !o.enabled } : o)),
        }));
      case "d":
        return change(chatId, messageId, from, i, (f) => ({ ...f, outputs: f.outputs.filter((_, k) => k !== j) }));
      case "o":
        return change(chatId, messageId, from, i, (f) => ({ ...f, enabled: !f.enabled }));
      case "rm": {
        const { view, screen } = await load(from.id);
        if (screen) return show(chatId, messageId, screen);
        return show(chatId, messageId, view.folders[i] ? confirmRemoveScreen({ view, index: i }) : restreamHomeScreen({ view }));
      }
      case "rmy":
        return change(chatId, messageId, from, i, () => null, { toHome: true });
      default:
        return home(chatId, messageId, from);
    }
  }

  return { route, onText, home };
}

/** Recorder client for the bot process: the tenant id and token come from the
 *  account server's archive state; requests go to nginx's local tenant router. */
export function createRestreamApi({ readTenant, base = "http://127.0.0.1:8480", timeoutMs = 10_000, fetchImpl = fetch }) {
  async function call(tenant, method, body) {
    const response = await fetchImpl(`${base}/t/${tenant.id}/restream`, {
      method,
      headers: { "X-Token": tenant.token, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const err = new Error(String(data?.detail || response.status));
      err.detail = data?.detail;
      throw err;
    }
    return data;
  }
  return {
    forUser(userId) {
      const tenant = readTenant(userId);
      if (!tenant?.id || !tenant?.token) return null;
      return {
        get: () => call(tenant, "GET"),
        save: (folders) => call(tenant, "POST", { folders }),
      };
    },
  };
}
