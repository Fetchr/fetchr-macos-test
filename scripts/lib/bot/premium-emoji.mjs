/** Premium custom emoji for the bot's screens (Bot API 9.4).
 *
 * Two sources:
 * - ids.json (scripts/bot-emoji/pick.mjs): public-pack emoji keyed by the
 *   plain emoji character; every known character in a text becomes
 *   <tg-emoji>, a button's leading one moves into icon_custom_emoji_id.
 * - fetchr-line.json (scripts/bot-emoji/upload-fetchr-line.mjs): the bot's
 *   own «Fetchr Line» sets, keyed by the sign's name: { name: { text, button } }.
 *   `text` is the tile set for <tg-emoji>, `button` the one-colour set made
 *   with needs_repainting=true, painted in the button's text colour.
 *
 * Screens name a sign where its character would be ambiguous: in text
 * `named("plan-mini")` → <ce name="plan-mini">💾</ce>, on a button
 * `{ icon: "plan-mini" }`. Signs whose character means one thing (🔑, 📡…)
 * are matched by the character too. Without an id a sign stays its plain
 * emoji (or the ids.json one); `plainScreen` removes the markers, so nothing
 * of this reaches Telegram unresolved.
 *
 * Bots may send custom emoji in private chats only while the bot's owner has
 * Telegram Premium. */

import { readFileSync } from "node:fs";

const VS16 = "️";
const stripVs = (value) => String(value).replaceAll(VS16, "");
const escapeRe = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const validId = (id) => /^\d{5,30}$/.test(String(id || ""));

/**
 * The Fetchr Line signs (design/bot-redesign/icons; plans: direction B
 * «Ячейка»). `emoji` is the sticker's base emoji and the plain fallback;
 * `char: true` — the character alone means this sign, so it is matched by
 * character as well as by name. Order is the upload order of the sets.
 */
export const FETCHR_LINE = Object.freeze([
  { name: "key", emoji: "🔑", char: true },
  { name: "archive", emoji: "💾", char: true },
  { name: "restream", emoji: "📡", char: true },
  { name: "card", emoji: "💳", char: true },
  { name: "copy", emoji: "📋", char: false },
  { name: "check", emoji: "✅", char: true },
  { name: "live", emoji: "🔴", char: true },
  { name: "spark", emoji: "🔥", char: true },
  { name: "chat", emoji: "💬", char: true },
  { name: "channel", emoji: "📢", char: true },
  { name: "home", emoji: "🏠", char: true },
  { name: "doc", emoji: "📄", char: true },
  { name: "plus", emoji: "➕", char: true },
  { name: "minus", emoji: "➖", char: true },
  { name: "play", emoji: "▶", char: true },
  { name: "back", emoji: "⬅", char: false },
  { name: "wait", emoji: "⏳", char: true },
  { name: "error", emoji: "⚠", char: true },
  { name: "gift", emoji: "🎁", char: true },
  { name: "calendar", emoji: "🗓", char: true },
  { name: "device", emoji: "💻", char: true },
  { name: "lock", emoji: "🔒", char: true },
  { name: "refresh", emoji: "🔄", char: true },
  { name: "user", emoji: "👤", char: true },
  { name: "memory", emoji: "💾", char: false },
  { name: "mute", emoji: "🔇", char: true },
  { name: "clip", emoji: "✂", char: true },
  { name: "trash", emoji: "🗑", char: true },
  { name: "plan-free", emoji: "🎉", char: false },
  { name: "plan-mini", emoji: "💾", char: false },
  { name: "plan-start", emoji: "▶", char: false },
  { name: "plan-streamer", emoji: "👑", char: true },
]);

const LINE_BY_NAME = new Map(FETCHR_LINE.map((sign) => [sign.name, sign]));

/** A named sign in text: its plain emoji, marked so the decorator can swap it. */
export function named(name, fallback = LINE_BY_NAME.get(name)?.emoji ?? "") {
  return `<ce name="${name}">${fallback}</ce>`;
}

const MARK = /<ce name="([a-z0-9-]+)">([\s\S]*?)<\/ce>/g;

/** Reads {"🔑": "5368…"} written by pick.mjs. A missing or broken
 *  file means no pack: an empty map. */
export function loadEmojiIds(path, log = null) {
  if (!path) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return Object.fromEntries(
      Object.entries(parsed)
        .filter(([char, id]) => char && validId(id))
        .map(([char, id]) => [stripVs(char), String(id)]),
    );
  } catch (err) {
    if (err?.code !== "ENOENT") log?.error(`Premium emoji map unreadable: ${err instanceof Error ? err.message : err}`);
    return {};
  }
}

/** Reads fetchr-line.json { name: { text, button } }: { text: {name: id}, button: {name: id} }.
 *  Unknown names and malformed ids are dropped; a missing file is an empty pack. */
export function loadFetchrLine(path, log = null) {
  const empty = { text: {}, button: {} };
  if (!path) return empty;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    const pick = (field) => Object.fromEntries(
      Object.entries(parsed)
        .filter(([name, ids]) => LINE_BY_NAME.has(name) && validId(ids?.[field]))
        .map(([name, ids]) => [name, String(ids[field])]),
    );
    return { text: pick("text"), button: pick("button") };
  } catch (err) {
    if (err?.code !== "ENOENT") log?.error(`Fetchr Line map unreadable: ${err instanceof Error ? err.message : err}`);
    return empty;
  }
}

/** Character maps for the signs that own their character. */
function lineChars(byName) {
  return Object.fromEntries(
    FETCHR_LINE.filter((sign) => sign.char && byName[sign.name]).map((sign) => [stripVs(sign.emoji), byName[sign.name]]),
  );
}

const withoutIcon = ({ icon, ...button }) => button;

/** The screen as plain Telegram HTML: named markers become their emoji, buttons lose `icon`. */
export function plainScreen(screen) {
  if (!screen) return screen;
  const text = screen.text != null ? String(screen.text).replace(MARK, (_m, _name, inner) => inner) : screen.text;
  const icons = screen.markup?.inline_keyboard?.some((row) => row.some((button) => "icon" in button));
  const markup = icons
    ? { ...screen.markup, inline_keyboard: screen.markup.inline_keyboard.map((row) => row.map(withoutIcon)) }
    : screen.markup;
  const changed = text !== screen.text || markup !== screen.markup;
  return changed ? { ...screen, ...(text != null ? { text } : {}), ...(markup ? { markup } : {}) } : screen;
}

/** Leading emoji (or the «←» of a back button) a button drops once it has an icon. */
const LEADING_SIGN = /^(?:\p{Extended_Pictographic}️?|←)\s+/u;

/**
 * Builds the screen transform. `ids` decorate text, `buttonIds` buttons, by
 * character (ids.json); `line` is the Fetchr Line pack from loadFetchrLine,
 * by name first, then by character for the signs that own theirs.
 */
export function createEmojiDecorator(ids = {}, buttonIds = ids, line = { text: {}, button: {} }) {
  const textIds = { ...ids, ...lineChars(line.text) };
  const buttonCharIds = { ...buttonIds, ...lineChars(line.button) };
  const chars = Object.keys(textIds).sort((a, b) => b.length - a.length);
  const buttonChars = Object.keys(buttonCharIds).sort((a, b) => b.length - a.length);
  const hasLine = Object.keys(line.text).length > 0 || Object.keys(line.button).length > 0;
  if (!chars.length && !buttonChars.length && !hasLine) return plainScreen;
  const never = /(?!)/u;
  const anyChar = chars.length ? new RegExp(`(${chars.map(escapeRe).join("|")})${VS16}?`, "gu") : never;
  const leading = buttonChars.length ? new RegExp(`^(${buttonChars.map(escapeRe).join("|")})${VS16}?\\s+`, "u") : never;

  /** Named signs first; then characters, outside <pre>, <code> and emoji already placed. */
  function decorateText(html) {
    // A named sign takes its Fetchr Line id, else the ids.json one for its emoji —
    // never another sign's id that happens to share the character.
    const marked = String(html).replace(MARK, (_m, name, inner) => {
      const id = line.text[name] || ids[stripVs(inner)];
      return id ? `<tg-emoji emoji-id="${id}">${inner}</tg-emoji>` : `<ce-plain>${inner}</ce-plain>`;
    });
    return marked
      .split(/(<(pre|code|tg-emoji|ce-plain)\b[\s\S]*?<\/\2>)/)
      .map((part, index) => {
        if (index % 3 === 2) return "";
        if (index % 3 === 1) return part.replace(/^<ce-plain>([\s\S]*)<\/ce-plain>$/, "$1");
        return part.replace(anyChar, (match, char) => `<tg-emoji emoji-id="${textIds[char]}">${match}</tg-emoji>`);
      })
      .join("");
  }

  function decorateButton(source) {
    const button = withoutIcon(source);
    if (button.icon_custom_emoji_id) return button;
    const lineId = source.icon ? line.button[source.icon] : null;
    if (lineId) return { ...button, text: String(button.text || "").replace(LEADING_SIGN, ""), icon_custom_emoji_id: lineId };
    // A named sign without its own id is never matched by character: its emoji
    // may belong to another sign (💾 is the archive, not the Мини plan).
    if (source.icon && !LINE_BY_NAME.get(source.icon)?.char) {
      const match = /^(\p{Extended_Pictographic})️?\s+/u.exec(button.text || "");
      const fallback = match ? buttonIds[stripVs(match[1])] : null;
      return fallback ? { ...button, text: button.text.slice(match[0].length), icon_custom_emoji_id: fallback } : button;
    }
    const match = leading.exec(button.text || "");
    if (!match) return button;
    return { ...button, text: button.text.slice(match[0].length), icon_custom_emoji_id: buttonCharIds[match[1]] };
  }

  return function decorateScreen(screen) {
    if (!screen) return screen;
    const markup = screen.markup?.inline_keyboard
      ? { ...screen.markup, inline_keyboard: screen.markup.inline_keyboard.map((row) => row.map(decorateButton)) }
      : screen.markup;
    return { ...screen, ...(screen.text != null ? { text: decorateText(screen.text) } : {}), ...(markup ? { markup } : {}) };
  };
}
