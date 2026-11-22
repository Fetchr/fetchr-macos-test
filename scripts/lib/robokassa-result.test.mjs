import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createRobokassaResult } from "./robokassa-result.mjs";

const md5 = (value) => createHash("md5").update(value).digest("hex");

async function serve(t, options = {}) {
  const paymentsPath = join(mkdtempSync(join(tmpdir(), "rk-")), "robokassa-payments.jsonl");
  const logs = [];
  const handler = createRobokassaResult({
    login: "fetchr",
    password1: "p1",
    password2: "p2",
    paymentsPath,
    botUrl: "https://t.me/fetchr_beta_bot",
    log: (line) => logs.push(line),
    ...options,
  });
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    if (!(await handler.handle(req, res, url))) res.writeHead(404).end();
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, paymentsPath, logs };
}

const form = (fields) => ({
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams(fields).toString(),
});

test("a signed ResultURL call is recorded and answered OK<InvId>", async (t) => {
  const { base, paymentsPath } = await serve(t);
  const fields = { OutSum: "230.000000", InvId: "1001", Shp_order: "AB12CD", EMail: "buyer@example.com" };
  const response = await fetch(`${base}/robokassa/result`, form({ ...fields, SignatureValue: md5("230.000000:1001:p2:Shp_order=AB12CD") }));
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "OK1001");
  const record = JSON.parse(readFileSync(paymentsPath, "utf8"));
  assert.deepEqual({ ...record, received_at: undefined }, {
    inv_id: 1001,
    order_id: "AB12CD",
    out_sum: 230,
    status: "paid",
    received_at: undefined,
  });
});

test("a forged call is refused and nothing is recorded", async (t) => {
  const { base, paymentsPath, logs } = await serve(t);
  const response = await fetch(
    `${base}/robokassa/result`,
    form({ OutSum: "1.00", InvId: "1001", Shp_order: "AB12CD", SignatureValue: md5("1.00:1001:wrong:Shp_order=AB12CD") }),
  );
  assert.equal(response.status, 400);
  assert.throws(() => readFileSync(paymentsPath));
  assert.match(logs[0], /bad signature/);
});

test("success and fail send the buyer back to the bot", async (t) => {
  const { base } = await serve(t);
  for (const path of ["success", "fail"]) {
    const response = await fetch(`${base}/robokassa/${path}?InvId=1`, { redirect: "manual" });
    assert.equal(response.status, 302);
    assert.equal(response.headers.get("location"), "https://t.me/fetchr_beta_bot");
  }
});

test("without passwords the result endpoint says so, other paths are not ours", async (t) => {
  const { base } = await serve(t, { password2: "" });
  assert.equal((await fetch(`${base}/robokassa/result`, form({}))).status, 503);
  assert.equal((await fetch(`${base}/other`)).status, 404);
});
