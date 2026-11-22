/** Runs the real entry point against a local fake of the Bot API: env parsing,
 *  HTTP client with multipart uploads, long polling, banners and the real
 *  license signer, end to end. */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { generateKeyPairSync, verify } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { BANNERS } from "./banners.mjs";
import { MACHINE_ID } from "./test-harness.mjs";

const ENTRY = fileURLToPath(new URL("../../telegram-beta-bot.mjs", import.meta.url));
const TOKEN = "123:TEST";
const USER = { id: 42, first_name: "Анна", username: "anna" };

/** Just enough multipart/form-data parsing for the bot's own uploads. */
function parseMultipart(raw, contentType) {
  const boundary = /boundary=(?:"([^"]+)"|([^;]+))/.exec(contentType);
  const fields = {};
  const files = {};
  for (const part of raw.toString("latin1").split(`--${boundary[1] || boundary[2]}`)) {
    const split = part.indexOf("\r\n\r\n");
    if (split < 0) continue;
    const head = part.slice(0, split);
    const name = /name="([^"]+)"/.exec(head)?.[1];
    if (!name) continue;
    const content = part.slice(split + 4).replace(/\r\n$/, "");
    const filename = /filename="([^"]+)"/.exec(head)?.[1];
    if (filename) files[name] = { filename, size: Buffer.byteLength(content, "latin1") };
    else fields[name] = Buffer.from(content, "latin1").toString("utf8");
  }
  for (const key of ["media", "reply_markup"]) if (fields[key]) fields[key] = JSON.parse(fields[key]);
  return { body: fields, files };
}

function fakeTelegramServer(script) {
  const calls = [];
  let delivered = 0;
  let nextFile = 1;
  const animation = (ref) => {
    const fileId = ref && !String(ref).startsWith("attach://") ? ref : `srv-${nextFile++}`;
    return { file_id: fileId, file_unique_id: `u-${fileId}` };
  };
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks);
      const method = req.url.split("/").pop();
      const multipart = String(req.headers["content-type"]).startsWith("multipart/form-data");
      const { body, files } = multipart
        ? parseMultipart(raw, req.headers["content-type"])
        : { body: raw.length ? JSON.parse(raw) : {}, files: null };
      const call = { method, body, files, result: null };
      calls.push(call);
      const reply = (payload, status = 200) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(payload));
      };
      if (!req.url.startsWith(`/bot${TOKEN}/`)) return reply({ ok: false, error_code: 401, description: "Unauthorized" }, 401);
      if (method === "getUpdates") {
        const next = script[delivered];
        if (next) {
          delivered += 1;
          return reply({ ok: true, result: [{ update_id: delivered, ...next }] });
        }
        return setTimeout(() => reply({ ok: true, result: [] }), 200);
      }
      const results = {
        getMe: () => ({ id: 1, is_bot: true, username: "fetchr_beta_bot" }),
        getChatMember: () => ({ status: "member" }),
        getChatAdministrators: () => [{ status: "creator", user: { id: 999 } }],
        getMyDescription: () => ({ description: "" }),
        getMyShortDescription: () => ({ short_description: "" }),
        sendMessage: () => ({ message_id: 100 + calls.length }),
        sendAnimation: () => ({ message_id: 100 + calls.length, animation: animation(files ? null : body.animation) }),
        sendPhoto: () => ({ message_id: 100 + calls.length, photo: [animation(files ? null : body.photo)] }),
        editMessageMedia: () =>
          body.media?.type === "photo"
            ? { message_id: Number(body.message_id), photo: [animation(files ? null : body.media?.media)] }
            : { message_id: Number(body.message_id), animation: animation(files ? null : body.media?.media) },
      };
      call.result = results[method] ? results[method]() : true;
      return reply({ ok: true, result: call.result });
    });
  });
  return { server, calls };
}

function waitFor(predicate, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - started > timeoutMs) return reject(new Error("timed out"));
      setTimeout(tick, 50);
    };
    tick();
  });
}

test("the bot starts, registers a device and moves between sections", async (t) => {
  const callback = (data) => ({
    callback_query: { id: `cb-${data}`, from: USER, data, message: { message_id: 7, chat: { id: USER.id, type: "private" } } },
  });
  const { server, calls } = fakeTelegramServer([
    { message: { message_id: 1, from: USER, chat: { id: USER.id, type: "private" }, text: `/start fetchr_${MACHINE_ID}` } },
    callback("cons:ok"),
    callback("shop:rub"),
    callback("reg"),
    callback("home"),
  ]);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());

  const dir = mkdtempSync(join(tmpdir(), "fetchr-bot-e2e-"));
  const banners = mkdtempSync(join(tmpdir(), "fetchr-bot-e2e-banners-"));
  for (const name of BANNERS) writeFileSync(join(banners, `${name}.mp4`), `mp4-${name}`.repeat(50));
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const child = spawn(process.execPath, [ENTRY], {
    env: {
      ...process.env,
      TELEGRAM_BOT_TOKEN: TOKEN,
      TELEGRAM_API_BASE: `http://127.0.0.1:${server.address().port}`,
      FETCHR_BETA_BOT_LOG: join(dir, "licenses.jsonl"),
      FETCHR_BOT_DATA_DIR: dir,
      FETCHR_BOT_BANNERS_DIR: banners,
      // No prerendered animations here: the covers go out as PNG.
      FETCHR_BOT_COVERS_DIR: mkdtempSync(join(tmpdir(), "fetchr-bot-e2e-covers-")),
      FETCHR_BETA_REQUIRED_CHANNEL: "streamcutter",
      FETCHR_LICENSE_PRIVATE_KEY: privateKey.export({ type: "pkcs8", format: "pem" }),
      FETCHR_ROBOKASSA_LOGIN: "",
      FETCHR_BOT_SHOP: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  t.after(() => child.kill());

  await waitFor(() => calls.filter((call) => call.method === "answerCallbackQuery").length === 4);

  assert.match(output, /Fetchr bot @fetchr_beta_bot started/);
  assert.match(output, /Admin chats: 999/);
  assert.deepEqual(
    calls.find((call) => call.method === "setMyCommands").body.commands.map((command) => command.command),
    ["start", "register", "support"],
  );
  const getUpdates = calls.find((call) => call.method === "getUpdates").body;
  assert.deepEqual(getUpdates.allowed_updates, ["message", "callback_query", "pre_checkout_query"]);

  // No key before consent: the first screen asks for it, under a rendered cover.
  const consent = calls.find((call) => call.method === "sendPhoto");
  assert.equal(consent.files.photo.filename, "fetchr.png");
  assert.match(consent.body.caption, /Согласие на обработку данных/);
  assert.match(readFileSync(join(dir, "bot-consents.jsonl"), "utf8"), /"user_id":42/);

  const [keyMessage, closedShop, registration, home] = calls.filter((call) => call.method === "editMessageMedia");
  assert.equal(keyMessage.body.media.type, "photo");
  assert.ok(keyMessage.files.pic.size > 0);
  const licenseKey = /<pre>(.+)<\/pre>/.exec(keyMessage.body.media.caption)[1];
  const [prefix, payload, signature] = licenseKey.split(".");
  assert.equal(prefix, "FTR1");
  assert.ok(verify(null, Buffer.from(payload), publicKey, Buffer.from(signature, "base64url")));
  const record = JSON.parse(readFileSync(join(dir, "licenses.jsonl"), "utf8"));
  assert.equal(record.license_key, licenseKey);

  assert.match(closedShop.body.media.caption, /Магазин скоро откроется/);
  assert.ok(closedShop.files.pic.size > 0, "the home cover is drawn");
  assert.ok(registration.files.pic.size > 0);
  assert.equal(home.files, null, "an unchanged cover is reused by file_id");
  assert.equal(home.body.media.media, closedShop.result.photo[0].file_id);

  // Covers survive a restart; the home cover has nothing personal, so it is cached too.
  const cache = JSON.parse(readFileSync(join(dir, "bot-pictures.json"), "utf8"));
  assert.equal(Object.keys(cache).length, 4);
  assert.doesNotMatch(output, /failed/i);
});
