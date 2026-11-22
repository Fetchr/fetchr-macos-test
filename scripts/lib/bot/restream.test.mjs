import assert from "node:assert/strict";
import { describe, test } from "node:test";

// Prices here are list prices; the sale has its own tests in catalog.test.mjs.
process.env.FETCHR_BOT_PROMO = "off";
const { USER, buttons, callbackUpdate, fakeApi, makeBot, textUpdate } = await import("./test-harness.mjs");
const { addonsTotal, planById } = await import("./catalog.mjs");

const YT_KEY = "abcd-efgh-ijkl-mnop";

/** A recorder that keeps settings like the real one: limits, kept keys, masked view. */
function fakeRecorder({ streamers = 1, extra = 1, channels = ["mafanyaking", "rachelr"] } = {}) {
  const store = { folders: [] };
  const platforms = {
    youtube: { name: "YouTube", url: "rtmp://a.rtmp.youtube.com/live2" },
    kick: { name: "Kick", url: null },
  };
  const fail = (detail) => Object.assign(new Error(detail), { detail });
  const view = () => ({
    limits: { streamers, extra, outputs: streamers + extra, extra_per_streamer: 3 },
    platforms,
    channels,
    folders: store.folders.map((folder) => ({
      ...folder,
      outputs: folder.outputs.map(({ key, ...rest }) => ({ ...rest, key_hint: `•••${key.slice(-4)}` })),
    })),
    status: {},
  });
  const client = {
    get: async () => view(),
    async save(folders) {
      if (folders.length > streamers) throw fail("more streamers than the plan allows");
      if (folders.reduce((sum, f) => sum + f.outputs.length, 0) > streamers + extra) throw fail("more platforms than the plan allows");
      const old = new Map(store.folders.flatMap((f) => f.outputs).map((o) => [o.id, o]));
      store.folders = folders.map((f) => ({
        channel: f.channel,
        enabled: f.enabled ?? true,
        outputs: f.outputs.map((o) => ({
          ...o,
          url: o.url ?? old.get(o.id)?.url ?? platforms[o.platform].url,
          key: o.key ?? old.get(o.id)?.key,
        })),
      }));
      return view();
    },
  };
  return { restreamApi: { forUser: (id) => (id === USER.id ? client : null) }, store };
}

async function setup(recorder = fakeRecorder()) {
  const telegram = fakeApi();
  const { bot, dir } = makeBot({ api: telegram.api, restreamApi: recorder.restreamApi });
  await bot.setup();
  telegram.reset();
  return { telegram, bot, recorder, dir };
}

const allText = (telegram) => telegram.calls.map((call) => JSON.stringify(call.body)).join("\n");

describe("restream section", () => {
  test("without a recorder or without restream the section sells it", async () => {
    const none = await setup({ restreamApi: { forUser: () => null } });
    await none.bot.handleUpdate(callbackUpdate("rs"));
    assert.match(none.telegram.lastScreen().text ?? none.telegram.last("editMessageCaption").caption, /Архива VPS|Рестрим/);

    const unpaid = await setup(fakeRecorder({ streamers: 0, extra: 0 }));
    await unpaid.bot.handleUpdate(callbackUpdate("rs"));
    const screen = unpaid.telegram.last("editMessageText") || unpaid.telegram.last("editMessageCaption");
    assert.match(screen.text ?? screen.caption, /От 100 ₽/);
  });

  test("a streamer from the archive gets a platform; the key leaves the chat at once", async () => {
    const { telegram, bot, recorder } = await setup();
    for (const data of ["rs", "rs:add", "rs:n:mafanyaking", "rs:y:mafanyaking", "rs:pp:0:youtube"]) {
      await bot.handleUpdate(callbackUpdate(data));
    }
    assert.deepEqual(recorder.store.folders.map((f) => f.channel), ["mafanyaking"]);
    const keyMessage = textUpdate(YT_KEY);
    await bot.handleUpdate(keyMessage);
    assert.ok(telegram.of("deleteMessage").some((call) => call.body.message_id === keyMessage.message.message_id));
    const [output] = recorder.store.folders[0].outputs;
    assert.equal(output.platform, "youtube");
    assert.equal(output.key, YT_KEY);
    assert.match(telegram.last("sendMessage").text, /Площадка добавлена/);
    assert.ok(!allText(telegram).includes(YT_KEY), "the key is never sent back");
  });

  test("a platform without a fixed server asks for the address first; bad input is refused", async () => {
    const { telegram, bot, recorder } = await setup();
    for (const data of ["rs:y:mafanyaking", "rs:pp:0:kick"]) await bot.handleUpdate(callbackUpdate(data));
    await bot.handleUpdate(textUpdate("http://not-rtmp.example/app"));
    assert.match(telegram.last("sendMessage").text, /rtmp:\/\//);
    await bot.handleUpdate(textUpdate("rtmps://fa723fc1b171.global-contribute.live-video.net/app"));
    await bot.handleUpdate(textUpdate("bad key with spaces"));
    assert.match(telegram.last("sendMessage").text, /Ключ выглядит неверно/);
    assert.equal(recorder.store.folders[0].outputs.length, 0);
    await bot.handleUpdate(textUpdate("sk_us-west-2_XYZ123"));
    const [output] = recorder.store.folders[0].outputs;
    assert.equal(output.url, "rtmps://fa723fc1b171.global-contribute.live-video.net/app");
    assert.equal(output.key, "sk_us-west-2_XYZ123");
  });

  test("the plan's limit is explained, toggles and removal keep saved keys", async () => {
    const { telegram, bot, recorder } = await setup(fakeRecorder({ streamers: 1, extra: 0 }));
    for (const data of ["rs:y:mafanyaking", "rs:pp:0:youtube"]) await bot.handleUpdate(callbackUpdate(data));
    await bot.handleUpdate(textUpdate(YT_KEY));
    await bot.handleUpdate(callbackUpdate("rs:f:0"));
    const folderButtons = buttons((telegram.last("editMessageText") || {}).reply_markup).map((b) => b.callback_data);
    assert.ok(!folderButtons.includes("rs:p:0"), "no «add platform» once the plan is used up");

    await bot.handleUpdate(callbackUpdate("rs:t:0:0"));
    assert.equal(recorder.store.folders[0].outputs[0].enabled, false);
    assert.equal(recorder.store.folders[0].outputs[0].key, YT_KEY, "toggling keeps the key");

    await bot.handleUpdate(callbackUpdate("rs:rmy:0"));
    assert.deepEqual(recorder.store.folders, []);
  });

  test("/restream opens the section", async () => {
    const { telegram, bot } = await setup();
    await bot.handleUpdate(textUpdate("/restream"));
    assert.ok(allText(telegram).includes("Рестрим"));
  });
});

describe("add-ons product", () => {
  const paidPlan = (userId, plan = "start", months = 1, ago = 86_400_000) => {
    const at = new Date(Date.now() - ago).toISOString();
    return {
      id: `P${userId}${plan}`.slice(0, 6).toUpperCase(), user_id: userId, plan_id: plan, packs: 0, quota_gb: planById(plan).quotaGb,
      months, status: "paid", paid_at: at, created_at: at, amount: 200,
    };
  };

  async function withOrders(lines) {
    const { appendFileSync, mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "fetchr-bot-"));
    if (lines.length) appendFileSync(`${dir}/orders.jsonl`, lines.map((line) => `${JSON.stringify(line)}\n`).join(""));
    const telegram = fakeApi();
    const toasts = [];
    const { bot } = makeBot({ dir, api: async (method, body) => {
      if (method === "answerCallbackQuery") toasts.push(body.text);
      return telegram.api(method, body);
    } });
    await bot.setup();
    telegram.reset();
    return { bot, telegram, toasts, dir };
  }

  const screenOf = (telegram) => telegram.last("editMessageText") || telegram.last("editMessageCaption");
  const readOrders = async (dir) => {
    const { readFileSync } = await import("node:fs");
    return readFileSync(`${dir}/orders.jsonl`, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  };

  test("without a paid plan the add-ons send you to pick one", async () => {
    const { bot, telegram } = await withOrders([]);
    await bot.handleUpdate(callbackUpdate("ad:rub"));
    assert.match(screenOf(telegram).text, /поверх платного тарифа/);
  });

  test("add-ons are picked, priced for their own term and ordered on their own", async () => {
    const { bot, telegram, dir } = await withOrders([paidPlan(USER.id)]);
    await bot.handleUpdate(callbackUpdate("ad:rub"));
    const data = buttons(screenOf(telegram).reply_markup).map((b) => b.callback_data);
    assert.ok(data.includes("ad:rub:c1r0e0:1"));
    assert.ok(data.includes("ad:rub:c0r1e0:1"));
    assert.ok(!data.some((d) => d?.startsWith("astar:")), "nothing to pay before something is picked");

    await bot.handleUpdate(callbackUpdate("ad:rub:c1r1e1:3"));
    const pay = buttons(screenOf(telegram).reply_markup).find((b) => b.callback_data?.startsWith("astar:"));
    assert.equal(pay.callback_data, "astar:c1r1e1:3");
    assert.equal(pay.style, "success");

    await bot.handleUpdate(callbackUpdate(pay.callback_data));
    const order = (await readOrders(dir)).at(-1);
    assert.equal(order.kind, "addon");
    assert.equal(order.plan_id, "addons");
    assert.equal(order.extra_channels, 1);
    assert.equal(order.restream_streamers, 1);
    assert.equal(order.restream_extra, 1);
    assert.equal(order.amount, addonsTotal({ channels: 1, restream: 1, restreamExtra: 1 }, 3));
  });

  test("a paid add-on adds up with the plan for its own term", async () => {
    const { subscriptionOf } = await import("../account-subscription.mjs");
    const plan = paidPlan(7, "start", 1);
    const addon = { id: "AD0001", user_id: 7, kind: "addon", plan_id: "addons", months: 1, status: "paid", paid_at: plan.paid_at, amount: 249, extra_channels: 1, restream_streamers: 1, restream_extra: 0 };
    const sub = subscriptionOf([plan, addon], Date.now());
    assert.equal(sub.plan_id, "start");
    assert.equal(sub.channels, 2);
    assert.equal(sub.restream_streamers, 1);
    const later = subscriptionOf([plan, addon], Date.parse(plan.paid_at) + 31 * 86_400_000);
    assert.equal(later.restream_streamers, 0);
  });

  test("restream cannot be bought for more streamers than are recorded", async () => {
    const { bot, toasts } = await withOrders([paidPlan(USER.id)]);
    await bot.handleUpdate(callbackUpdate("apay:c0r2e0:1"));
    assert.match(toasts.join(" "), /Свободных мест|максимум/);
  });

  test("a long prepaid term cannot be upgraded by a cheap short order", async () => {
    const { bot, toasts } = await withOrders([{ ...paidPlan(USER.id, "mini", 12), amount: 960 }]);
    await bot.handleUpdate(callbackUpdate("pay:streamer:rub:0:1"));
    assert.match(toasts.join(" "), /выберите срок длиннее/);
    toasts.length = 0;
    await bot.handleUpdate(callbackUpdate("pay:mini:rub:0:1"));
    assert.doesNotMatch(toasts.join(" "), /срок длиннее/, "renewing the same plan stays possible");
  });

  test("open checkouts and running plans hold restream places", async () => {
    const created = new Date(Date.now() - 10 * 60_000).toISOString();
    const pending = (id, user, streamers, extra) => ({
      id, user_id: user, kind: "addon", plan_id: "addons", months: 1, status: "pending", method: "robokassa",
      created_at: created, amount: 500, restream_streamers: streamers, restream_extra: extra,
    });
    const { bot, toasts } = await withOrders([
      paidPlan(USER.id),
      pending("PP0001", 701, 2, 6), pending("PP0002", 702, 2, 6),
      { ...paidPlan(703, "streamer"), restream_streamers: 2, restream_extra: 2 },
    ]);
    await bot.handleUpdate(callbackUpdate("apay:c0r1e0:1"));
    assert.match(toasts.join(" "), /Свободных мест для рестрима/);
  });
});
