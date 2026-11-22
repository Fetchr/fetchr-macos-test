/** Section banners and the closed shop. */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

import { BANNERS, createBanners } from "./banners.mjs";
import { botProfile } from "./profile.mjs";
import { USER, buttons, callbackUpdate, fakeApi, makeBot, textUpdate } from "./test-harness.mjs";

function bannerDir(names = BANNERS) {
  const dir = mkdtempSync(join(tmpdir(), "fetchr-banners-"));
  for (const name of names) writeFileSync(join(dir, `${name}.mp4`), `fake-${name}`);
  return dir;
}

function setup({ names, shop = true, cachePath } = {}) {
  const dir = bannerDir(names);
  const logs = [];
  const banners = createBanners({
    dir,
    cachePath: cachePath || join(dir, "cache.json"),
    log: { error: (line) => logs.push(line) },
  });
  const telegram = fakeApi();
  const harness = makeBot({ api: telegram.api, banners, shop });
  return { ...harness, telegram, banners, bannerDir: dir, bannerLogs: logs };
}

const media = (telegram) =>
  telegram.calls.filter((call) => ["sendAnimation", "editMessageMedia", "editMessageCaption"].includes(call.method));

describe("banners", () => {
  test("the first screen uploads its banner, later ones reuse the file_id", async () => {
    const { telegram, bot, bannerDir: dir } = setup();
    await bot.handleUpdate(textUpdate("/start"));
    const [first] = media(telegram);
    assert.equal(first.method, "sendAnimation");
    assert.equal(first.files.animation.path, join(dir, "home.mp4"));
    assert.equal(first.body.parse_mode, "HTML");
    assert.match(first.body.caption, /Ключ — <b>бесплатно<\/b>/);
    assert.ok(first.body.reply_markup);

    await bot.handleUpdate(textUpdate("/start"));
    const second = media(telegram).at(-1);
    assert.equal(second.files, null);
    assert.equal(second.body.animation, first.result.animation.file_id);
  });

  test("inside a section only the caption changes; another section swaps the GIF", async () => {
    const { telegram, bot } = setup();
    await bot.handleUpdate(textUpdate("/support"));
    const menuId = telegram.last("sendAnimation") && media(telegram).at(-1).result.message_id;

    await bot.handleUpdate(callbackUpdate("sup:write", { messageId: menuId }));
    assert.equal(media(telegram).at(-1).method, "editMessageCaption");
    assert.match(media(telegram).at(-1).body.caption, /Жду ваше сообщение/);

    await bot.handleUpdate(callbackUpdate("home", { messageId: menuId }));
    const swap = media(telegram).at(-1);
    assert.equal(swap.method, "editMessageMedia");
    assert.equal(swap.body.media.type, "animation");
    assert.equal(swap.body.media.media, "attach://pic");
    assert.ok(swap.files.pic.path.endsWith("home.mp4"));

    await bot.handleUpdate(callbackUpdate("reg", { messageId: menuId }));
    await bot.handleUpdate(callbackUpdate("home", { messageId: menuId }));
    const cachedSwap = media(telegram).at(-1);
    assert.equal(cachedSwap.files, null);
    assert.equal(cachedSwap.body.media.media, swap.result.animation.file_id);
  });

  test("file_ids survive a restart and a re-rendered banner is uploaded again", async () => {
    const cachePath = join(mkdtempSync(join(tmpdir(), "fetchr-banner-cache-")), "cache.json");
    const first = setup({ cachePath });
    await first.bot.handleUpdate(textUpdate("/start"));
    const fileId = media(first.telegram)[0].result.animation.file_id;
    assert.equal(JSON.parse(readFileSync(cachePath, "utf8")).home.file_id, fileId);

    const reopened = createBanners({ dir: first.bannerDir, cachePath, log: { error() {} } });
    assert.deepEqual(reopened.source("home"), { fileId, upload: null });

    writeFileSync(join(first.bannerDir, "home.mp4"), "re-rendered");
    const changed = createBanners({ dir: first.bannerDir, cachePath, log: { error() {} } });
    assert.equal(changed.source("home").fileId, null);
  });

  test("a missing banner falls back to a text message", async () => {
    const { telegram, bot, bannerLogs } = setup({ names: ["register", "support", "shop"] });
    assert.ok(bannerLogs.some((line) => line.includes("home.mp4")));
    await bot.handleUpdate(textUpdate("/start"));
    assert.equal(media(telegram).length, 0);
    assert.match(telegram.last("sendMessage").text, /Ключ — <b>бесплатно<\/b>/);
  });
});

describe("closed shop", () => {
  test("the menu offers registration and support only", async () => {
    const { telegram, bot } = setup({ shop: false });
    await bot.handleUpdate(textUpdate("/start"));
    const screen = media(telegram).at(-1).body;
    assert.doesNotMatch(screen.caption, /Магазин/);
    const data = buttons(screen.reply_markup).map((button) => button.callback_data || button.url);
    assert.deepEqual(data, ["reg", "sup", "https://t.me/streamcutter"]);
  });

  test("shop links, commands and buttons land on the menu with a note", async () => {
    const { telegram, bot } = setup({ shop: false });
    for (const update of [
      textUpdate("/shop"),
      textUpdate("/start buy_streamer_p2_usd"),
      callbackUpdate("pay:mini:stars:0"),
      callbackUpdate("plan:max:rub:3"),
    ]) {
      await bot.handleUpdate(update);
      assert.match(media(telegram).at(-1).body.caption ?? media(telegram).at(-1).body.media.caption, /Магазин скоро откроется/);
    }
    assert.equal(telegram.of("sendInvoice").length, 0);
  });

  test("key and support screens drop their shop buttons", async () => {
    const { telegram, bot } = setup({ shop: false });
    await bot.handleUpdate(textUpdate("0123456789ABCDEF0123456789ABCDEF"));
    assert.ok(!buttons(media(telegram).at(-1).body.reply_markup).some((button) => button.callback_data === "shop"));
    await bot.handleUpdate(textUpdate("/support"));
    assert.ok(!buttons(media(telegram).at(-1).body.reply_markup).some((button) => button.callback_data === "sup:pay"));
  });

  test("a leftover Stars invoice is declined", async () => {
    const { telegram, bot } = setup({ shop: false });
    await bot.handleUpdate({
      update_id: 1,
      pre_checkout_query: { id: "q", from: USER, currency: "XTR", total_amount: 70, invoice_payload: "ord:ABCDEF" },
    });
    assert.equal(telegram.last("answerPreCheckoutQuery").ok, false);
  });

  test("the profile follows the shop, replacing only the bot's own texts", async () => {
    const telegram = fakeApi();
    const previous = botProfile({ shop: true });
    const api = async (method, body) =>
      method === "getMyDescription"
        ? { description: previous.description }
        : method === "getMyShortDescription"
          ? { short_description: "Написано руками" }
          : telegram.api(method, body);
    const { bot } = makeBot({ api, shop: false });
    await bot.setup();
    assert.deepEqual(
      telegram.last("setMyCommands").commands.map((command) => command.command),
      ["start", "register", "support"],
    );
    assert.doesNotMatch(telegram.last("setMyDescription").description, /Архив VPS/);
    assert.equal(telegram.of("setMyShortDescription").length, 0);
  });
});
