import assert from "node:assert/strict";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { WEB_LOGIN_TTL_MS, createWebLoginBox, describeBrowser, webLoginIdFromStart } from "./web-login.mjs";

const ID = "abcdefghijklmnopqrstuvwxyz012345";

function setup() {
  let clock = 1_000_000;
  const dir = join(mkdtempSync(join(tmpdir(), "web-login-")), "box");
  return { dir, box: createWebLoginBox(dir, { now: () => clock }), tick: (ms) => (clock += ms) };
}

test("start payloads carry a 32-char id and nothing else", () => {
  assert.equal(webLoginIdFromStart(`web_${ID}`), ID);
  assert.equal(webLoginIdFromStart(ID), null);
  assert.equal(webLoginIdFromStart("web_short"), null);
  assert.equal(webLoginIdFromStart(`web_${ID}x`), null);
});

test("browsers are named the way people know them", () => {
  assert.equal(describeBrowser("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 Edg/130.0"), "Edge · Windows");
  assert.equal(describeBrowser("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1"), "Safari · iOS");
  assert.equal(describeBrowser(""), "Браузер");
});

test("a request is decided once, then closed; the file name never holds the id", () => {
  const { box, dir } = setup();
  box.open(ID, { browser: "Chrome · Windows", ip: "1.2.3.4" });
  assert.equal(box.read(ID).status, "pending");
  assert.ok(!readdirSync(dir).some((name) => name.includes(ID)));

  assert.equal(box.decide(ID, { id: 42, username: "neo" }, true).status, "approved");
  assert.equal(box.decide(ID, { id: 7 }, true), null, "a second tap cannot switch the account");
  assert.equal(box.read(ID).user_id, 42);

  box.close(ID);
  assert.equal(box.read(ID), null);
});

test("requests expire and are swept", () => {
  const { box, dir, tick } = setup();
  box.open(ID);
  tick(WEB_LOGIN_TTL_MS + 1);
  assert.equal(box.read(ID), null);
  assert.equal(box.decide(ID, { id: 42 }, true), null);
  box.sweep();
  assert.deepEqual(readdirSync(dir), []);
});

test("unknown and malformed ids read as nothing", () => {
  const { box } = setup();
  assert.equal(box.read(ID), null);
  assert.equal(box.read("../../etc/passwd"), null);
});
