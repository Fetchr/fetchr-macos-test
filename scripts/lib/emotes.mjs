/** Third-party chat emotes (7TV, BetterTTV, FrankerFaceZ) for a Twitch channel,
 *  as one { name: url } map for the site's chat replay. Same sources and
 *  precedence as the app (chat_overlay/providers.rs): channel sets beat global
 *  ones, and 7TV beats BTTV beats FFZ. Built on the server and cached per
 *  channel, so a page load costs the providers nothing; images still come
 *  straight from their CDNs. */

const TWITCH_WEB_CLIENT_ID = "kimne78kx3ncx6brgo4mv6wki5h1ko";
const LOGIN_RE = /^[a-z0-9_]{2,25}$/;

export function createEmotes({ fetchImpl = globalThis.fetch, now = () => Date.now(), ttlMs = 60 * 60_000, log = () => {} } = {}) {
  const cache = new Map();

  async function getJson(url, init = {}) {
    const response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error(`${new URL(url).host} ${response.status}`);
    return response.json();
  }

  async function twitchId(login) {
    const body = await getJson("https://gql.twitch.tv/gql", {
      method: "POST",
      headers: { "Client-Id": TWITCH_WEB_CLIENT_ID, "Content-Type": "application/json" },
      body: JSON.stringify({ query: "query($login:String!){user(login:$login){id}}", variables: { login } }),
    });
    return body?.data?.user?.id || null;
  }

  const sevenTv = (emotes) =>
    (emotes || []).flatMap((emote) => {
      const host = emote?.data?.host?.url;
      return emote?.name && host ? [[emote.name, `https:${host}/2x.webp`]] : [];
    });
  const bttv = (emotes) => (emotes || []).flatMap((e) => (e?.code && e?.id ? [[e.code, `https://cdn.betterttv.net/emote/${e.id}/2x`]] : []));
  const ffz = (emotes) =>
    (emotes || []).flatMap((e) => {
      const url = e?.images?.["2x"] || e?.images?.["1x"];
      return e?.code && url ? [[e.code, url]] : [];
    });

  /** Each source on its own: one provider being down only loses its emotes. */
  async function source(name, load) {
    try {
      return await load();
    } catch (err) {
      log(`emotes: ${name} failed: ${err.message}`);
      return [];
    }
  }

  async function build(login) {
    const id = await source("twitch id", async () => [await twitchId(login)]).then((list) => list[0] || null);
    const layers = await Promise.all([
      source("ffz global", async () => ffz(await getJson("https://api.betterttv.net/3/cached/frankerfacez/emotes/global"))),
      source("bttv global", async () => bttv(await getJson("https://api.betterttv.net/3/cached/emotes/global"))),
      source("7tv global", async () => sevenTv((await getJson("https://7tv.io/v3/emote-sets/global")).emotes)),
      id ? source("ffz channel", async () => ffz(await getJson(`https://api.betterttv.net/3/cached/frankerfacez/users/twitch/${id}`))) : [],
      id ? source("bttv channel", async () => {
        const body = await getJson(`https://api.betterttv.net/3/cached/users/twitch/${id}`);
        return bttv([...(body.channelEmotes || []), ...(body.sharedEmotes || [])]);
      }) : [],
      id ? source("7tv channel", async () => sevenTv((await getJson(`https://7tv.io/v3/users/twitch/${id}`)).emote_set?.emotes)) : [],
    ]);
    return Object.fromEntries(layers.flat());
  }

  /** { name: url } for `channel`; {} for a name that cannot be a Twitch login. */
  async function forChannel(channel) {
    const login = String(channel || "").trim().toLowerCase();
    if (!LOGIN_RE.test(login)) return {};
    const hit = cache.get(login);
    if (hit && now() - hit.at < ttlMs) return hit.value;
    const pending = hit?.pending ?? build(login).then((value) => {
      cache.set(login, { at: now(), value });
      if (cache.size > 500) cache.delete(cache.keys().next().value);
      return value;
    });
    if (!hit?.pending) cache.set(login, { ...(hit || { at: 0, value: {} }), pending });
    try {
      return await pending;
    } finally {
      const entry = cache.get(login);
      if (entry?.pending === pending) delete entry.pending;
    }
  }

  return { forChannel };
}
