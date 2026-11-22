import assert from "node:assert/strict";
import { test } from "node:test";

import { createDelivery } from "./delivery.mjs";
import { TelegramError } from "./telegram-api.mjs";

const uneditable = (method) => new TelegramError(method, { error_code: 400, description: "Bad Request: message can't be edited" });

test("show edits in place and falls back to a new message by default", async () => {
  const calls = [];
  const api = async (method) => {
    calls.push(method);
    if (method === "editMessageText") throw uneditable(method);
    return { message_id: 9 };
  };
  const { show } = createDelivery({ api });
  assert.deepEqual(await show(1, 5, { text: "a" }), { message_id: 9 });
  assert.deepEqual(calls, ["editMessageText", "sendMessage"]);
});

test("fallback: false keeps it an edit: an uneditable message is left alone", async () => {
  const calls = [];
  const api = async (method) => {
    calls.push(method);
    if (method === "editMessageText") throw uneditable(method);
    return { message_id: 9 };
  };
  const { show } = createDelivery({ api });
  assert.equal(await show(1, 5, { text: "a" }, { fallback: false }), null);
  assert.equal(await show(1, null, { text: "a" }, { fallback: false }), null);
  assert.deepEqual(calls, ["editMessageText"]);
});
