import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { homeCardSvg } from "./cards.mjs";
import { COVER_NAMES, coverSvg } from "./covers.mjs";
import { createPictures } from "./pictures.mjs";
import { homeScreen } from "./screens.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));

test("every media name a screen uses has a cover", () => {
  const used = new Set();
  for (const file of readdirSync(here).filter((name) => name.endsWith("screens.mjs"))) {
    for (const [, names] of readFileSync(`${here}${file}`, "utf8").matchAll(/media: ([^,\n]+),/g)) {
      for (const [, name] of names.matchAll(/"([a-z0-9-]+)"/g)) used.add(name);
    }
  }
  assert.ok(used.size > 5);
  for (const name of used) assert.ok(COVER_NAMES.includes(name), `no cover for ${name}`);
  for (const name of COVER_NAMES) assert.match(coverSvg(name), /^<svg/);
  assert.equal(coverSvg("nope"), null);
});

test("the dashboard escapes the user's name and clips a long one", () => {
  const svg = homeCardSvg({ name: "<a href='x'>&", shop: true });
  assert.match(svg, /Привет, &lt;/);
  assert.doesNotMatch(svg, /<a href/);
  assert.match(homeCardSvg({ name: "Я".repeat(80) }), /…/);
});

test("the dashboard shows the plan, days left and the sale", () => {
  const svg = homeCardSvg({
    name: "Анна",
    devices: 1,
    shop: true,
    promo: { percent: 40, until: "1 декабря" },
    subscription: { active: true, plan: "Стример", quota_gb: 200, hours_1080p: 61, days_left: 18, period_days: 30, paid_until: "2026-12-06T00:00:00Z" },
  });
  for (const part of ["Активен", "АРХИВ VPS · СТРИМЕР", "200 ГБ", "ещё 18 дн.", "−40% до 1 декабря"]) assert.ok(svg.includes(part), part);
});

test("home screen passes the dashboard data and picks one main action", () => {
  const fresh = homeScreen({ user: { first_name: "Анна" }, shop: true });
  assert.deepEqual(fresh.art, { state: "new", shop: true, promo: null }, "the cover has nothing personal");
  assert.match(fresh.text, /Привет, <b>Анна<\/b>/);
  assert.equal(fresh.markup.inline_keyboard[0][0].callback_data, "reg");

  const paid = homeScreen({
    user: { first_name: "Анна" },
    deviceCount: 1,
    machineId: "F".repeat(32),
    shop: true,
    subscription: { active: true, plan: "Стример" },
  });
  assert.equal(paid.art.state, "paid");
  assert.match(paid.text, /FFFF…FFFF/);
  assert.equal(paid.markup.inline_keyboard[0][0].callback_data, "shop");
  const second = paid.markup.inline_keyboard[1].map((button) => button.callback_data);
  assert.deepEqual(second, ["reg", "rs"]);
  assert.deepEqual(paid.markup.inline_keyboard[2].map((button) => button.callback_data), ["sup"]);
});

test("pictures render once and reuse the file_id; dashboards stay out of the cache file", async () => {
  let renders = 0;
  const pictures = createPictures({ fontsDir: ".", render: () => (renders += 1, new Uint8Array([1, 2, 3])) });
  const cover = await pictures.resolve({ media: "support" });
  assert.ok(cover.upload.buffer.length === 3 && cover.persist);
  pictures.remember(cover, { photo: [{ file_id: "small" }, { file_id: "big" }] });
  assert.deepEqual(await pictures.resolve({ media: "support" }), { key: cover.key, fileId: "big" });
  const card = await pictures.resolve({ card: { name: "Анна" } });
  assert.equal(card.persist, false);
  assert.equal(renders, 2);
  assert.equal(await pictures.resolve({ text: "no picture" }), null);
});

test("avatars: the user's photo goes on every picture and is fetched once", async () => {
  const { createAvatars } = await import("./avatars.mjs");
  const calls = [];
  const api = async (method, body) => {
    calls.push(method);
    if (method === "getUserProfilePhotos") return { photos: [[{ file_id: "s", width: 80 }, { file_id: "m", width: 320 }]] };
    if (method === "getFile") return { file_path: `photos/${body.file_id}.jpg` };
    throw new Error(method);
  };
  api.download = async () => Buffer.from("jpg");
  const avatars = createAvatars({ api });
  const [a, b] = await Promise.all([avatars.get(7), avatars.get(7)]);
  assert.equal(a, `data:image/jpeg;base64,${Buffer.from("jpg").toString("base64")}`);
  assert.equal(b, a);
  assert.deepEqual(calls, ["getUserProfilePhotos", "getFile"]);
  assert.equal(await avatars.get(-100), null);

  const pictures = createPictures({ fontsDir: ".", render: () => new Uint8Array([1]), avatars });
  const cover = await pictures.resolve({ media: "support" }, 7);
  assert.equal(cover.persist, false, "a picture with someone's photo is never written to disk");
  assert.match(coverSvg("support", null, a), /clip-path="url\(#avatar\)"/);
  assert.match(homeCardSvg({ name: "Анна", devices: 1 }), />А</);
});

test("avatars: no photo or a failed lookup gives null", async () => {
  const { createAvatars } = await import("./avatars.mjs");
  const none = createAvatars({ api: async () => ({ photos: [] }) });
  assert.equal(await none.get(1), null);
  const broken = createAvatars({ api: async () => { throw new Error("403"); }, log: { error() {} } });
  assert.equal(await broken.get(1), null);
});

test("pictures use the site language: grid, no glow, no Stars, the shop shows real plans", () => {
  for (const name of COVER_NAMES) {
    const svg = coverSvg(name);
    assert.match(svg, /id="grid"/, name);
    assert.doesNotMatch(svg, /id="glow"|звёзд/i, name);
  }
  const shop = coverSvg("shop-1");
  assert.doesNotMatch(shop, /1 ТБ/);
  for (const part of ["20 ГБ", "50 ГБ", "150 ГБ", "500 ₽"]) assert.ok(shop.includes(part), part);
});

test("animated covers: frame 0 is the still picture, later frames move", async () => {
  const { grow, rise, pulse, LOOP_S } = await import("./cards.mjs");
  assert.equal(grow(0), 1);
  assert.equal(grow(LOOP_S - 0.01), 1, "the loop ends where it starts");
  assert.ok(grow(1) < 1);
  assert.deepEqual(rise(0, 3), { dy: 0, opacity: 1 });
  assert.equal(pulse(0), 1);
  for (const name of COVER_NAMES) {
    assert.equal(coverSvg(name, {}, null, 0), coverSvg(name, {}), name);
    assert.notEqual(coverSvg(name, {}, null, 1.1), coverSvg(name, {}), `${name} has no motion`);
  }
});

test("a cover with a prerendered MP4 goes out as an animation, others as PNG", async () => {
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { animationKey } = await import("./pictures.mjs");
  const dir = mkdtempSync(join(tmpdir(), "covers-"));
  writeFileSync(join(dir, `${animationKey(coverSvg("support", {}))}.mp4`), "mp4");
  const pictures = createPictures({ fontsDir: ".", render: () => new Uint8Array([1]), animationsDir: dir });
  const animated = await pictures.resolve({ media: "support" });
  assert.equal(animated.type, "animation");
  assert.equal(animated.upload.type, "video/mp4");
  pictures.remember(animated, { animation: { file_id: "anim" } });
  assert.deepEqual(await pictures.resolve({ media: "support" }), { key: animated.key, type: "animation", fileId: "anim" });
  const still = await pictures.resolve({ media: "support-pay" });
  assert.equal(still.type, undefined);
  assert.equal(still.upload.type, "image/png");
});
