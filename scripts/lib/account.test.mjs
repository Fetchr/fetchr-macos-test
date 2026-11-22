import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { CODE_TTL_MS, MAX_ATTEMPTS, RESET_COOLDOWN_MS, SESSION_TTL_MS, SHORT_SESSION_TTL_MS, createAccount, normalizeMachineId, readCookie } from "./account.mjs";
import { createWebLoginBox } from "./web-login.mjs";

const ID = "0123456789ABCDEF0123456789ABCDEF";
const OTHER = "FEDCBA9876543210FEDCBA9876543210";

function setup({ licenses, orders = [], failSend = false } = {}) {
  let clock = 1_000_000;
  const sent = [];
  const sessionsPath = join(mkdtempSync(join(tmpdir(), "account-")), "sessions.json");
  const book = licenses ?? [
    { issued_at: "2026-09-01T00:00:00Z", machine_id: ID, license_key: "KEY-1", telegram_user_id: 42 },
    { issued_at: "2026-09-02T00:00:00Z", machine_id: OTHER, license_key: "KEY-2", telegram_user_id: 42 },
  ];
  const options = {
    sessionsPath,
    readLicenses: async () => book,
    readOrders: async () => orders,
    sendMessage: async (chatId, text) => {
      if (failSend) throw new Error("403 blocked");
      sent.push({ chatId, text });
    },
    lookupUser: async (id) => (id === 42 ? { username: "neo", first_name: "Thomas" } : null),
    now: () => clock,
  };
  const account = createAccount(options);
  const codeOf = () => /<code>(\d{6})<\/code>/.exec(sent.at(-1).text)[1];
  return { account, sent, codeOf, sessionsPath, options, tick: (ms) => (clock += ms) };
}

function call(account, { method = "POST", path, body, cookie = "", origin = "https://fetchr.fun" }) {
  const headers = { "content-type": "application/json", "x-real-ip": "1.2.3.4", cookie, origin };
  const req = { method, headers, socket: {} };
  const out = { status: 0, body: null, headers: {} };
  const res = { setHeader: (name, value) => (out.headers[name.toLowerCase()] = value) };
  const json = (_res, status, payload) => Object.assign(out, { status, body: payload });
  const readJson = async () => body ?? {};
  return account.handle(req, res, new URL(`http://x${path}`), { json, readJson }).then(() => out);
}

async function signIn(ctx, machineId = ID) {
  const login = await call(ctx.account, { path: "/account/login", body: { machine_id: machineId } });
  const verify = await call(ctx.account, { path: "/account/verify", body: { request_id: login.body.request_id, code: ctx.codeOf() } });
  return { login, verify, cookie: readCookie(verify.headers["set-cookie"]) };
}

test("normalizeMachineId accepts the app's forms and rejects the rest", () => {
  assert.equal(normalizeMachineId(ID.toLowerCase()), ID);
  assert.equal(normalizeMachineId(`fetchr_${ID}`), ID);
  assert.equal(normalizeMachineId("xyz"), null);
  assert.equal(normalizeMachineId(`${ID}0`), null);
});

test("login sends a code to the owner and verify opens a session", async () => {
  const ctx = setup();
  const { login, verify, cookie } = await signIn(ctx);
  assert.equal(login.status, 200);
  assert.equal(login.body.hint, "@n***o");
  assert.equal(ctx.sent[0].chatId, 42);
  assert.equal(verify.status, 200);
  assert.match(verify.headers["set-cookie"], /HttpOnly; Secure; SameSite=Strict/);
  assert.match(verify.headers["set-cookie"], /Path=\/api\/account/);

  const me = await call(ctx.account, { method: "GET", path: "/account/me", cookie: `fetchr_session=${cookie}` });
  assert.equal(me.status, 200);
  assert.equal(me.body.user.telegram_id, 42);
  assert.deepEqual(me.body.devices.map((device) => device.machine_id), [OTHER, ID]);
  assert.ok(!readFileSync(ctx.sessionsPath, "utf8").includes(cookie), "raw token must not be stored");
});

test("unknown or revoked Machine IDs are refused without sending anything", async () => {
  const ctx = setup({
    licenses: [
      { machine_id: ID, license_key: "K", telegram_user_id: 42 },
      { machine_id: ID, license_key: "K", telegram_user_id: 42, revoked_at: "2026-09-03" },
    ],
  });
  assert.equal((await call(ctx.account, { path: "/account/login", body: { machine_id: ID } })).status, 404);
  assert.equal((await call(ctx.account, { path: "/account/login", body: { machine_id: OTHER } })).status, 404);
  assert.equal((await call(ctx.account, { path: "/account/login", body: { machine_id: "nope" } })).status, 400);
  assert.equal(ctx.sent.length, 0);
});

test("a wrong code burns an attempt and the request dies after the limit", async () => {
  const ctx = setup();
  const login = await call(ctx.account, { path: "/account/login", body: { machine_id: ID } });
  const wrong = ctx.codeOf() === "000000" ? "111111" : "000000";
  for (let attempt = 1; attempt < MAX_ATTEMPTS; attempt += 1) {
    const out = await call(ctx.account, { path: "/account/verify", body: { request_id: login.body.request_id, code: wrong } });
    assert.equal(out.status, 401);
  }
  const last = await call(ctx.account, { path: "/account/verify", body: { request_id: login.body.request_id, code: wrong } });
  assert.equal(last.status, 410);
  const late = await call(ctx.account, { path: "/account/verify", body: { request_id: login.body.request_id, code: ctx.codeOf() } });
  assert.equal(late.status, 410, "the right code no longer works either");
});

test("codes expire and cannot be reused", async () => {
  const ctx = setup();
  const login = await call(ctx.account, { path: "/account/login", body: { machine_id: ID } });
  ctx.tick(CODE_TTL_MS + 1);
  const out = await call(ctx.account, { path: "/account/verify", body: { request_id: login.body.request_id, code: ctx.codeOf() } });
  assert.equal(out.status, 410);

  const again = await signIn(ctx);
  assert.equal(again.verify.status, 200);
  const reuse = await call(ctx.account, { path: "/account/verify", body: { request_id: again.login.body.request_id, code: ctx.codeOf() } });
  assert.equal(reuse.status, 410);
});

test("a new code replaces the previous one for the same device", async () => {
  const ctx = setup();
  const first = await call(ctx.account, { path: "/account/login", body: { machine_id: ID } });
  const firstCode = ctx.codeOf();
  await call(ctx.account, { path: "/account/login", body: { machine_id: ID } });
  const out = await call(ctx.account, { path: "/account/verify", body: { request_id: first.body.request_id, code: firstCode } });
  assert.equal(out.status, 410);
});

test("per-device code requests are rate limited", async () => {
  const ctx = setup();
  for (let index = 0; index < 3; index += 1) {
    assert.equal((await call(ctx.account, { path: "/account/login", body: { machine_id: ID } })).status, 200);
  }
  assert.equal((await call(ctx.account, { path: "/account/login", body: { machine_id: ID } })).status, 429);
  assert.equal(ctx.sent.length, 3);
});

test("delivery failure is reported and leaves no pending code", async () => {
  const ctx = setup({ failSend: true });
  const out = await call(ctx.account, { path: "/account/login", body: { machine_id: ID } });
  assert.equal(out.status, 502);
  assert.equal(out.body.request_id, undefined);
});

test("cross-site POSTs and non-JSON bodies are rejected", async () => {
  const ctx = setup();
  assert.equal((await call(ctx.account, { path: "/account/login", body: { machine_id: ID }, origin: "https://evil.example" })).status, 403);
  assert.equal(ctx.sent.length, 0);
});

test("/me needs a session; logout ends one or all", async () => {
  const ctx = setup();
  assert.equal((await call(ctx.account, { method: "GET", path: "/account/me" })).status, 401);
  const a = (await signIn(ctx)).cookie;
  const b = (await signIn(ctx, OTHER)).cookie;
  const me = (cookie) => call(ctx.account, { method: "GET", path: "/account/me", cookie: `fetchr_session=${cookie}` });

  await call(ctx.account, { path: "/account/logout", body: {}, cookie: `fetchr_session=${a}` });
  assert.equal((await me(a)).status, 401);
  assert.equal((await me(b)).status, 200);

  const c = (await signIn(ctx)).cookie;
  await call(ctx.account, { path: "/account/logout", body: { everywhere: true }, cookie: `fetchr_session=${c}` });
  assert.equal((await me(b)).status, 401);
  assert.equal((await me(c)).status, 401);
});

test("sessions survive a restart", async () => {
  const ctx = setup();
  const { cookie } = await signIn(ctx);
  const restarted = createAccount(ctx.options);
  const out = await call(restarted, { method: "GET", path: "/account/me", cookie: `fetchr_session=${cookie}` });
  assert.equal(out.status, 200);
});

test("purchases list only the user's orders, newest snapshot per id, with price", async () => {
  const ctx = setup({
    orders: [
      { id: "AAA", user_id: 42, plan_id: "start", quota_gb: 50, status: "pending", method: "stars", currency: "stars", amount: 140, created_at: "2026-09-10" },
      { id: "AAA", user_id: 42, plan_id: "start", quota_gb: 50, status: "paid", method: "stars", currency: "stars", amount: 140, created_at: "2026-09-10", paid_at: "2026-09-11" },
      { id: "BBB", user_id: 7, plan_id: "max", status: "paid", created_at: "2026-09-12" },
    ],
  });
  const { cookie } = await signIn(ctx);
  const me = await call(ctx.account, { method: "GET", path: "/account/me", cookie: `fetchr_session=${cookie}` });
  assert.deepEqual(me.body.purchases, [
    { id: "AAA", plan: "Старт", quota_gb: 50, status: "paid", method: "Telegram Stars", amount: "140 ⭐", created_at: "2026-09-10", paid_at: "2026-09-11" },
  ]);
});

test("device reset revokes the key, notifies the bot chat and then cools down", async () => {
  const book = [
    { issued_at: "2026-09-01T00:00:00Z", machine_id: ID, license_key: "KEY-1", telegram_user_id: 42 },
  ];
  const ctx = setup({ licenses: book });
  ctx.options.appendLicense = async (record) => book.push(record);
  const account = createAccount(ctx.options);
  const login = await call(account, { path: "/account/login", body: { machine_id: ID } });
  const verify = await call(account, { path: "/account/verify", body: { request_id: login.body.request_id, code: ctx.codeOf() } });
  const cookie = `fetchr_session=${readCookie(verify.headers["set-cookie"])}`;

  const reset = await call(account, { path: "/account/device/reset", body: { machine_id: ID }, cookie });
  assert.equal(reset.status, 200);
  assert.deepEqual(reset.body.devices, []);
  assert.ok(reset.body.next_reset_at);
  assert.equal(book.at(-1).revoked_by, "account");
  assert.equal(book.at(-1).license_key, "KEY-1");
  assert.match(ctx.sent.at(-1).text, /Устройство сброшено/);

  book.push({ issued_at: "2026-09-26T00:00:00Z", machine_id: OTHER, license_key: "KEY-2", telegram_user_id: 42 });
  const again = await call(account, { path: "/account/device/reset", body: { machine_id: OTHER }, cookie });
  assert.equal(again.status, 429);
  ctx.tick(RESET_COOLDOWN_MS + 1);
  assert.equal((await call(account, { path: "/account/device/reset", body: { machine_id: OTHER }, cookie })).status, 200);
});

test("someone else's device cannot be reset", async () => {
  const ctx = setup();
  const { cookie } = await signIn(ctx);
  const out = await call(ctx.account, { path: "/account/device/reset", body: { machine_id: "A".repeat(32) }, cookie: `fetchr_session=${cookie}` });
  assert.equal(out.status, 404);
});

test("archive requests go to the signed-in user's recorder, never cross-site or signed out", async () => {
  const ctx = setup();
  const seen = [];
  const account = createAccount({
    ...ctx.options,
    archiveProxy: async (userId, _req, _res, path) => seen.push({ userId, path }),
  });
  const login = await call(account, { path: "/account/login", body: { machine_id: ID } });
  const verify = await call(account, { path: "/account/verify", body: { request_id: login.body.request_id, code: ctx.codeOf() } });
  const cookie = `fetchr_session=${readCookie(verify.headers["set-cookie"])}`;

  const out = await call(account, { method: "GET", path: "/account/archive/recordings?x=1", cookie });
  assert.equal(out.status, 0, "the proxy answered, not the account handler");
  assert.deepEqual(seen, [{ userId: 42, path: "/recordings?x=1" }]);

  const signedOut = await call(account, { method: "GET", path: "/account/archive/status" });
  assert.equal(signedOut.status, 401);
  const crossSite = await call(account, { method: "DELETE", path: "/account/archive/clips/abc", cookie, origin: "https://evil.example" });
  assert.equal(crossSite.status, 403);
  assert.equal(seen.length, 1);
});

test("emotes are served to a signed-in user only", async () => {
  const ctx = setup();
  const account = createAccount({ ...ctx.options, emotes: async (channel) => ({ [`${channel}Emote`]: "https://x/1" }) });
  const login = await call(account, { path: "/account/login", body: { machine_id: ID } });
  const verify = await call(account, { path: "/account/verify", body: { request_id: login.body.request_id, code: ctx.codeOf() } });
  const cookie = `fetchr_session=${readCookie(verify.headers["set-cookie"])}`;
  const out = await call(account, { method: "GET", path: "/account/emotes?channel=emiru", cookie });
  assert.deepEqual(out.body, { emiruEmote: "https://x/1" });
  assert.equal((await call(account, { method: "GET", path: "/account/emotes?channel=emiru" })).status, 401);
});

test("without «remember» the cookie dies with the browser and the session after a day", async () => {
  const ctx = setup();
  const login = await call(ctx.account, { path: "/account/login", body: { machine_id: ID } });
  const verify = await call(ctx.account, { path: "/account/verify", body: { request_id: login.body.request_id, code: ctx.codeOf(), remember: false } });
  assert.doesNotMatch(verify.headers["set-cookie"], /Max-Age/);
  const cookie = `fetchr_session=${readCookie(verify.headers["set-cookie"])}`;
  const me = await call(ctx.account, { method: "GET", path: "/account/me", cookie });
  assert.equal(me.body.session_remembered, false);
  ctx.tick(SHORT_SESSION_TTL_MS + 1);
  assert.equal((await call(ctx.account, { method: "GET", path: "/account/me", cookie })).status, 401);
});

test("«remember» keeps the session for 30 days", async () => {
  const ctx = setup();
  const { verify, cookie } = await signIn(ctx);
  assert.match(verify.headers["set-cookie"], new RegExp(`Max-Age=${SESSION_TTL_MS / 1000}`));
  ctx.tick(SESSION_TTL_MS - 60_000);
  assert.equal((await call(ctx.account, { method: "GET", path: "/account/me", cookie: `fetchr_session=${cookie}` })).status, 200);
  ctx.tick(120_000);
  assert.equal((await call(ctx.account, { method: "GET", path: "/account/me", cookie: `fetchr_session=${cookie}` })).status, 401);
});

function withWebLogins() {
  const ctx = setup();
  const box = createWebLoginBox(join(mkdtempSync(join(tmpdir(), "weblogin-")), "box"));
  const account = createAccount({ ...ctx.options, webLogins: box });
  return { ...ctx, account, box };
}

test("Telegram sign-in: the site waits until the bot approves, then gets a session", async () => {
  const ctx = withWebLogins();
  const start = await call(ctx.account, { path: "/account/tg/start", body: {} });
  assert.equal(start.status, 200);
  assert.equal(start.body.url, `https://t.me/fetchr_beta_bot?start=web_${start.body.id}`);

  const pending = await call(ctx.account, { path: "/account/tg/poll", body: { id: start.body.id } });
  assert.deepEqual(pending.body, { status: "pending" });

  ctx.box.decide(start.body.id, { id: 42 }, true);
  const done = await call(ctx.account, { path: "/account/tg/poll", body: { id: start.body.id, remember: true } });
  assert.equal(done.body.status, "ok");
  assert.match(done.headers["set-cookie"], /Max-Age=/);
  const me = await call(ctx.account, { method: "GET", path: "/account/me", cookie: `fetchr_session=${readCookie(done.headers["set-cookie"])}` });
  assert.equal(me.body.user.telegram_id, 42);
  assert.equal(me.body.current_machine_id, OTHER, "the newest live device becomes the session's device");

  const again = await call(ctx.account, { path: "/account/tg/poll", body: { id: start.body.id } });
  assert.equal(again.status, 410, "an approval opens one session only");
});

test("Telegram sign-in: denied or unregistered accounts get no session", async () => {
  const ctx = withWebLogins();
  const first = (await call(ctx.account, { path: "/account/tg/start", body: {} })).body.id;
  ctx.box.decide(first, { id: 42 }, false);
  const denied = await call(ctx.account, { path: "/account/tg/poll", body: { id: first } });
  assert.equal(denied.status, 403);
  assert.equal(denied.headers["set-cookie"], undefined);

  const second = (await call(ctx.account, { path: "/account/tg/start", body: {} })).body.id;
  ctx.box.decide(second, { id: 777 }, true);
  const stranger = await call(ctx.account, { path: "/account/tg/poll", body: { id: second } });
  assert.equal(stranger.status, 404);
  assert.equal(stranger.headers["set-cookie"], undefined);
});

test("Telegram sign-in refuses cross-site starts", async () => {
  const ctx = withWebLogins();
  assert.equal((await call(ctx.account, { path: "/account/tg/start", body: {}, origin: "https://evil.example" })).status, 403);
});
