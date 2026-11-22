import assert from "node:assert/strict";
import test from "node:test";

import { createEmotes } from "./emotes.mjs";

function fakeFetch(routes, calls = []) {
  return async (url) => {
    calls.push(url);
    const hit = Object.entries(routes).find(([prefix]) => url.startsWith(prefix));
    if (!hit) return { ok: false, status: 404, json: async () => ({}) };
    const body = typeof hit[1] === "function" ? hit[1]() : hit[1];
    return { ok: true, status: 200, json: async () => body };
  };
}

const ROUTES = {
  "https://gql.twitch.tv/gql": { data: { user: { id: "123" } } },
  "https://api.betterttv.net/3/cached/frankerfacez/emotes/global": [{ code: "Shared", images: { "2x": "https://ffz/g2" } }],
  "https://api.betterttv.net/3/cached/emotes/global": [{ id: "b1", code: "Shared" }, { id: "b2", code: "catJAM" }],
  "https://7tv.io/v3/emote-sets/global": { emotes: [{ name: "Shared", data: { host: { url: "//cdn.7tv.app/emote/s1" } } }] },
  "https://api.betterttv.net/3/cached/frankerfacez/users/twitch/123": [{ code: "ffzOnly", images: { "1x": "https://ffz/c1" } }],
  "https://api.betterttv.net/3/cached/users/twitch/123": { channelEmotes: [{ id: "c9", code: "catJAM" }], sharedEmotes: [{ id: "s9", code: "pepeD" }] },
  "https://7tv.io/v3/users/twitch/123": { emote_set: { emotes: [{ name: "OMEGALUL", data: { host: { url: "//cdn.7tv.app/emote/o1" } } }] } },
};

test("channel emotes beat global ones and 7TV beats BTTV beats FFZ", async () => {
  const emotes = createEmotes({ fetchImpl: fakeFetch(ROUTES) });
  const map = await emotes.forChannel("Emiru");
  assert.equal(map.Shared, "https://cdn.7tv.app/emote/s1/2x.webp");
  assert.equal(map.catJAM, "https://cdn.betterttv.net/emote/c9/2x");
  assert.equal(map.pepeD, "https://cdn.betterttv.net/emote/s9/2x");
  assert.equal(map.ffzOnly, "https://ffz/c1");
  assert.equal(map.OMEGALUL, "https://cdn.7tv.app/emote/o1/2x.webp");
});

test("a provider that is down only loses its own emotes", async () => {
  const routes = { ...ROUTES };
  delete routes["https://7tv.io/v3/users/twitch/123"];
  const map = await createEmotes({ fetchImpl: fakeFetch(routes) }).forChannel("emiru");
  assert.equal(map.OMEGALUL, undefined);
  assert.equal(map.catJAM, "https://cdn.betterttv.net/emote/c9/2x");
});

test("results are cached per channel and bad names never reach the providers", async () => {
  const calls = [];
  const emotes = createEmotes({ fetchImpl: fakeFetch(ROUTES, calls) });
  await Promise.all([emotes.forChannel("emiru"), emotes.forChannel("emiru")]);
  await emotes.forChannel("emiru");
  assert.equal(calls.filter((url) => url.startsWith("https://gql")).length, 1);
  assert.deepEqual(await emotes.forChannel("../etc"), {});
  assert.equal(calls.filter((url) => url.includes("etc")).length, 0);
});
