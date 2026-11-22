import type { ChatFragment, ChatMessage } from "@/types/job";

export type EmoteFragment = Extract<ChatFragment, { type: "emote" }>;

export type RenderPart =
  | { kind: "text"; text: string }
  | { kind: "emote"; fragment: EmoteFragment; overlays: EmoteFragment[] };

/** Fold 7TV zero-width emotes onto the emote they decorate; drawn in sequence
 *  they would show up as unrelated extra images. */
export function toRenderParts(fragments: ChatFragment[]): RenderPart[] {
  const parts: RenderPart[] = [];
  for (const fragment of fragments) {
    if (fragment.type !== "emote" || !fragment.url) {
      parts.push({ kind: "text", text: fragment.type === "text" ? fragment.text : "" });
      continue;
    }
    const previous = parts[parts.length - 1];
    if (fragment.zero_width && previous?.kind === "emote") {
      previous.overlays.push(fragment);
    } else {
      parts.push({ kind: "emote", fragment, overlays: [] });
    }
  }
  return parts;
}

/** Twitch's own emotes, from the `emotes` IRC tag: `id:start-end,start-end/...`
 *  where the offsets index codepoints, not UTF-16 units. */
function twitchEmoteFragments(content: string, tag: string | undefined): ChatFragment[] {
  const chars = Array.from(content);
  if (!tag) return [{ type: "text", text: content }];
  const spans: { start: number; end: number; id: string }[] = [];
  for (const group of tag.split("/")) {
    const [id, positions] = group.split(":");
    if (!id || !positions) continue;
    for (const range of positions.split(",")) {
      const [from, to] = range.split("-").map(Number);
      if (Number.isInteger(from) && Number.isInteger(to)) spans.push({ start: from, end: to, id });
    }
  }
  spans.sort((a, b) => a.start - b.start);

  const fragments: ChatFragment[] = [];
  let cursor = 0;
  for (const span of spans) {
    if (span.start < cursor || span.end >= chars.length) continue;
    if (span.start > cursor) {
      fragments.push({ type: "text", text: chars.slice(cursor, span.start).join("") });
    }
    fragments.push({
      type: "emote",
      provider: "twitch",
      id: span.id,
      url: `https://static-cdn.jtvnw.net/emoticons/v2/${span.id}/default/dark/2.0`,
      text: chars.slice(span.start, span.end + 1).join(""),
    });
    cursor = span.end + 1;
  }
  if (cursor < chars.length) fragments.push({ type: "text", text: chars.slice(cursor).join("") });
  return fragments.length > 0 ? fragments : [{ type: "text", text: content }];
}

/** Replace whole words with BTTV/FFZ/7TV emotes, mirroring what the backend
 *  does for recorded chat so both look the same. */
function applyThirdParty(
  fragments: ChatFragment[],
  emotes: Record<string, ChatFragment>,
): ChatFragment[] {
  if (Object.keys(emotes).length === 0) return fragments;
  const out: ChatFragment[] = [];
  for (const fragment of fragments) {
    if (fragment.type !== "text") {
      out.push(fragment);
      continue;
    }
    // Keep the separators so spacing survives the round trip.
    for (const part of fragment.text.split(/(\s+)/)) {
      if (!part) continue;
      const emote = part.trim() ? emotes[part] : undefined;
      out.push(emote ?? { type: "text", text: part });
    }
  }
  return out;
}

/** One line of Twitch IRC. Returns null for anything that is not a chat message. */
export function parseIrcMessage(
  line: string,
  emotes: Record<string, ChatFragment>,
  timestamp: number,
): ChatMessage | null {
  let rest = line;
  const tags: Record<string, string> = {};
  if (rest.startsWith("@")) {
    const end = rest.indexOf(" ");
    if (end < 0) return null;
    for (const pair of rest.slice(1, end).split(";")) {
      const eq = pair.indexOf("=");
      if (eq > 0) tags[pair.slice(0, eq)] = pair.slice(eq + 1);
    }
    rest = rest.slice(end + 1);
  }
  if (!rest.startsWith(":")) return null;
  const prefixEnd = rest.indexOf(" ");
  if (prefixEnd < 0) return null;
  const prefix = rest.slice(1, prefixEnd);
  rest = rest.slice(prefixEnd + 1);
  if (!rest.startsWith("PRIVMSG ")) return null;

  const contentAt = rest.indexOf(" :");
  if (contentAt < 0) return null;
  const content = rest.slice(contentAt + 2).replace(/[\r\n]+$/, "");
  const username = prefix.split("!")[0] ?? "";
  if (!username) return null;

  return {
    timestamp,
    username,
    display_name: tags["display-name"] || username,
    user_color: tags.color || null,
    badges: [],
    fragments: applyThirdParty(twitchEmoteFragments(content, tags.emotes), emotes),
    source_platform: "twitch",
  };
}
