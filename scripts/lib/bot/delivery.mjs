/** Puts screens into the chat: a new message, or an edit of the message the
 *  user tapped. A screen with a picture is a photo (pictures.mjs) or, without
 *  the renderer, an MP4 banner, with the screen text as its caption. Moving
 *  to another picture swaps the media in place; an unchanged picture only
 *  rewrites the caption. */

import { plainScreen } from "./premium-emoji.mjs";
import { isNotModified, isUneditable } from "./telegram-api.mjs";

const SHOWN_LIMIT = 5000;

/** `decorate` turns a screen into its premium-emoji form (premium-emoji.mjs).
 *  If Telegram refuses the decorated message (the owner's Premium lapsed),
 *  the plain screen goes out instead and decoration stays off. */
export function createDelivery({ api, banners = null, pictures = null, decorate = null, log = null }) {
  let decorating = Boolean(decorate);
  async function withEmoji(source, deliver) {
    // Named signs (<ce>, button icons) never reach Telegram unresolved.
    const screen = plainScreen(source);
    const fancy = decorating ? decorate(source) : screen;
    if (fancy === screen || JSON.stringify(fancy) === JSON.stringify(screen)) return deliver(screen);
    try {
      return await deliver(fancy);
    } catch (err) {
      if (err?.code !== 400 || isNotModified(err) || isUneditable(err)) throw err;
      decorating = false;
      log?.error(`Premium emoji refused, sending plain screens: ${err.message}`);
      return deliver(screen);
    }
  }

  // Which picture each menu message shows. Unknown after a restart, which
  // only costs one editMessageMedia instead of editMessageCaption.
  const shown = new Map();
  const key = (chatId, messageId) => `${chatId}:${messageId}`;
  const markupOf = (screen) => (screen.markup ? { reply_markup: screen.markup } : {});

  /** The old MP4 banner a picture falls back to: "register-2" → "register". */
  function bannerName(screen) {
    if (screen.card) return "home";
    const base = String(screen.media || "").split("-")[0];
    return { welcome: "home", terms: "home", rs: null }[base] ?? base;
  }

  /** What goes above the text: a rendered photo, an MP4 banner, or nothing. */
  async function visualOf(screen, chatId) {
    const picture = pictures ? await pictures.resolve(screen, chatId) : null;
    if (picture) {
      return { id: `p:${picture.key}`, type: "photo", ...picture, keep: (message) => pictures.remember(picture, message) };
    }
    const banner = bannerName(screen);
    if (!banner || !banners?.has(banner)) return null;
    return { id: `b:${banner}`, type: "animation", ...banners.source(banner), keep: (message) => banners.remember(banner, message) };
  }

  function remember(chatId, message, visual) {
    visual.keep(message);
    if (shown.size >= SHOWN_LIMIT) shown.delete(shown.keys().next().value);
    shown.set(key(chatId, message.message_id), visual.id);
  }

  function send(chatId, screen) {
    return withEmoji(screen, (ready) => sendPlain(chatId, ready));
  }

  async function sendPlain(chatId, screen) {
    const visual = await visualOf(screen, chatId);
    if (!visual) {
      return api("sendMessage", {
        chat_id: chatId,
        text: screen.text,
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
        ...markupOf(screen),
      });
    }
    const method = visual.type === "photo" ? "sendPhoto" : "sendAnimation";
    const body = { chat_id: chatId, caption: screen.text, parse_mode: "HTML", ...markupOf(screen) };
    const message = visual.fileId
      ? await api(method, { ...body, [visual.type]: visual.fileId })
      : await api(method, body, { [visual.type]: visual.upload });
    remember(chatId, message, visual);
    return message;
  }

  async function edit(chatId, messageId, screen) {
    const target = { chat_id: chatId, message_id: messageId };
    const visual = await visualOf(screen, chatId);
    if (!visual) {
      await api("editMessageText", {
        ...target,
        text: screen.text,
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
        ...markupOf(screen),
      });
      return;
    }
    if (shown.get(key(chatId, messageId)) === visual.id) {
      await api("editMessageCaption", { ...target, caption: screen.text, parse_mode: "HTML", ...markupOf(screen) });
      return;
    }
    const media = { type: visual.type, media: visual.fileId || "attach://pic", caption: screen.text, parse_mode: "HTML" };
    const message = await api(
      "editMessageMedia",
      { ...target, media, ...markupOf(screen) },
      visual.fileId ? null : { pic: visual.upload },
    );
    remember(chatId, { ...message, message_id: messageId }, visual);
  }

  return {
    send,

    /** Edits `messageId` in place, or sends a new message when there is none
     *  or it can no longer be edited. `fallback: false` keeps it an edit only:
     *  an uneditable message is then left as it is (returns null). */
    async show(chatId, messageId, screen, { fallback = true } = {}) {
      if (messageId) {
        try {
          await withEmoji(screen, (ready) => edit(chatId, messageId, ready));
          return { message_id: messageId };
        } catch (err) {
          if (isNotModified(err)) return { message_id: messageId };
          if (!isUneditable(err)) throw err;
          if (!fallback) return null;
        }
      }
      if (!fallback) return null;
      return send(chatId, screen);
    },
  };
}
