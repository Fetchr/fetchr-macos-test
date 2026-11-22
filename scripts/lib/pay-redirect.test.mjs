import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { PAY_LINK_TTL_MS, createPayRedirect, isPaymentPage } from "./pay-redirect.mjs";
import { createRateLimiter } from "./rate-limit.mjs";

const NOW = Date.parse("2026-11-18T12:00:00Z");
const BOT = "https://t.me/fetchr_beta_bot";
const TOKEN = "Q2xpY2tUb2tlbkFCQ0RFRkdISUo"; // 27 base64url chars
const PAY = "https://auth.robokassa.ru/Merchant/Index.aspx?MerchantLogin=fetchr&InvId=1001&OutSum=500.00";

const baseOrder = {
  id: "ORD001", user_id: 5, method: "robokassa", source: "card", status: "pending",
  pay_url: PAY, pay_token: TOKEN, created_at: "2026-11-18T11:00:00Z",
};

function setup({ orders = [baseOrder], limit = 30 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pay-redirect-"));
  const clicksPath = join(dir, "pay-clicks.jsonl");
  const redirect = createPayRedirect({
    readOrders: () => orders,
    clicksPath,
    botUrl: BOT,
    allow: createRateLimiter({ limit, windowMs: 60_000, now: () => NOW }),
    now: () => NOW,
  });
  const clicks = () => {
    try {
      return readFileSync(clicksPath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    } catch {
      return [];
    }
  };
  return { redirect, clicks };
}

async function hit(redirect, path, { method = "GET", ip = "203.0.113.7" } = {}) {
  const res = {
    status: 0,
    headers: {},
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
    },
    end() {},
  };
  const handled = await redirect.handle({ method }, res, new URL(`http://x${path}`), ip);
  return { handled, ...res };
}

test("a valid token redirects to that order's payment page and logs the click without ip or agent", async () => {
  const { redirect, clicks } = setup();
  const res = await hit(redirect, `/pay/${TOKEN}`);
  assert.equal(res.status, 302);
  assert.equal(res.headers.Location, PAY);
  assert.equal(res.headers["Cache-Control"], "no-store");
  assert.equal(res.headers["Referrer-Policy"], "no-referrer");
  assert.deepEqual(clicks(), [{ order_id: "ORD001", at: new Date(NOW).toISOString() }]);
  assert.doesNotMatch(JSON.stringify(clicks()), /203\.0\.113|agent/i);
});

test("unknown, expired, paid or foreign-target orders go to the bot", async () => {
  const cases = [
    [setup(), "/pay/AAAAAAAAAAAAAAAAAAAAAAAAAA"],
    [setup({ orders: [{ ...baseOrder, created_at: new Date(NOW - PAY_LINK_TTL_MS - 1000).toISOString() }] }), `/pay/${TOKEN}`],
    [setup({ orders: [baseOrder, { id: "ORD001", status: "paid" }] }), `/pay/${TOKEN}`],
    [setup({ orders: [{ ...baseOrder, pay_url: "https://evil.example/pay" }] }), `/pay/${TOKEN}`],
    [setup({ orders: [{ ...baseOrder, pay_url: "http://auth.robokassa.ru/x" }] }), `/pay/${TOKEN}`],
  ];
  for (const [{ redirect, clicks }, path] of cases) {
    const res = await hit(redirect, path);
    assert.equal(res.status, 302, path);
    assert.equal(res.headers.Location, BOT, path);
    assert.deepEqual(clicks(), [], "no click for a refused link");
  }
});

test("there is no open redirect: query parameters and odd paths never choose the target", async () => {
  const { redirect } = setup();
  for (const path of [`/pay/${TOKEN}?url=https://evil.example`, `/pay/${TOKEN}/https://evil.example`, "/pay/..%2F..%2Fevil", "/pay/"]) {
    const res = await hit(redirect, path);
    assert.ok([PAY, BOT].includes(res.headers.Location), path);
  }
  assert.equal((await hit(redirect, "/robokassa/result")).handled, false);
  assert.equal(isPaymentPage("javascript:alert(1)"), false);
  assert.equal(isPaymentPage("https://auth.robokassa.ru.evil.example/"), false);
});

test("requests are limited per address", async () => {
  const { redirect } = setup({ limit: 2 });
  assert.equal((await hit(redirect, `/pay/${TOKEN}`)).status, 302);
  assert.equal((await hit(redirect, `/pay/${TOKEN}`)).status, 302);
  const third = await hit(redirect, `/pay/${TOKEN}`);
  assert.equal(third.status, 429);
  assert.equal(third.headers["Cache-Control"], "no-store");
  assert.equal((await hit(redirect, `/pay/${TOKEN}`, { ip: "198.51.100.1" })).status, 302, "another address is not blocked");
});

test("HEAD does not count as a click; other methods are refused", async () => {
  const { redirect, clicks } = setup();
  assert.equal((await hit(redirect, `/pay/${TOKEN}`, { method: "HEAD" })).status, 302);
  assert.deepEqual(clicks(), []);
  assert.equal((await hit(redirect, `/pay/${TOKEN}`, { method: "POST" })).status, 405);
});
