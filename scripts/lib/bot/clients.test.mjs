import assert from "node:assert/strict";
import { test } from "node:test";

import { TelegramError, createTelegramApi, isNotModified, isUneditable } from "./telegram-api.mjs";

function fakeFetch(respond) {
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url, init, body: JSON.parse(init.body) });
    return respond(url, init);
  };
  return { fetchImpl, requests };
}

const json = (payload, status = 200) => ({
  ok: status < 400,
  status,
  json: async () => payload,
});

test("telegram client returns result and keeps the token out of errors", async () => {
  const { fetchImpl, requests } = fakeFetch(() => json({ ok: true, result: { id: 1 } }));
  const api = createTelegramApi({ token: "123:SECRET", baseUrl: "http://x/", fetchImpl });
  assert.deepEqual(await api("getMe"), { id: 1 });
  assert.equal(requests[0].url, "http://x/bot123:SECRET/getMe");

  const failing = createTelegramApi({
    token: "123:SECRET",
    fetchImpl: async () => json({ ok: false, error_code: 429, description: "Too Many Requests", parameters: { retry_after: 7 } }, 429),
  });
  const err = await failing("sendMessage", {}).catch((error) => error);
  assert.ok(err instanceof TelegramError);
  assert.equal(err.retryAfter, 7);
  assert.doesNotMatch(err.message, /SECRET/);
});

test("telegram client turns network and parse failures into TelegramError", async () => {
  const offline = createTelegramApi({ token: "t", fetchImpl: async () => { throw new Error("ECONNRESET"); } });
  const network = await offline("getUpdates", { timeout: 1 }).catch((error) => error);
  assert.equal(network.code, 0);
  assert.match(network.description, /ECONNRESET/);

  const garbage = createTelegramApi({
    token: "t",
    fetchImpl: async () => ({ ok: false, status: 502, json: async () => { throw new SyntaxError("x"); } }),
  });
  const parse = await garbage("getMe").catch((error) => error);
  assert.equal(parse.code, 502);
  assert.throws(() => createTelegramApi({ token: "" }), /TELEGRAM_BOT_TOKEN/);
});

test("edit errors are classified", () => {
  const notModified = new TelegramError("editMessageText", { error_code: 400, description: "Bad Request: message is not modified: specified new message content..." });
  const gone = new TelegramError("editMessageText", { error_code: 400, description: "Bad Request: message to edit not found" });
  const other = new TelegramError("editMessageText", { error_code: 400, description: "Bad Request: can't parse entities" });
  assert.ok(isNotModified(notModified));
  assert.ok(isUneditable(gone));
  assert.ok(!isUneditable(other) && !isNotModified(other));
});
