import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { buildReceipt, createRobokassa, formatSum } from "./robokassa.mjs";

const md5 = (value) => createHash("md5").update(value).digest("hex");
const kassa = createRobokassa({ login: "fetchr", password1: "p1", password2: "p2" });

test("disabled until login and both passwords are set", () => {
  assert.equal(createRobokassa({ login: "fetchr", password1: "p1" }), null);
});

test("payment link is signed over login, sum, id, receipt, password1 and Shp", () => {
  const url = new URL(kassa.paymentUrl({ invId: 1001, amount: 500, description: "Fetchr · Стример", shp: { order: "AB12CD" } }));
  const p = url.searchParams;
  assert.equal(url.origin + url.pathname, "https://auth.robokassa.ru/Merchant/Index.aspx");
  assert.equal(p.get("OutSum"), "500.00");
  assert.equal(p.get("InvId"), "1001");
  assert.equal(p.get("Shp_order"), "AB12CD");
  assert.equal(p.get("IsTest"), null);
  // Receipt is URL-encoded once for the signature and once more in the query.
  const receipt = p.get("Receipt");
  assert.deepEqual(JSON.parse(decodeURIComponent(receipt)).items[0].tax, "none");
  assert.equal(p.get("SignatureValue"), md5(`fetchr:500.00:1001:${receipt}:p1:Shp_order=AB12CD`));
});

test("test mode adds IsTest", () => {
  const test = createRobokassa({ login: "l", password1: "a", password2: "b", test: true });
  assert.equal(new URL(test.paymentUrl({ invId: 1, amount: 100, description: "x" })).searchParams.get("IsTest"), "1");
});

test("ResultURL passes with password2 and fails when anything is changed", () => {
  const fields = { OutSum: "500.000000", InvId: "1001", Shp_order: "AB12CD" };
  const SignatureValue = md5("500.000000:1001:p2:Shp_order=AB12CD").toUpperCase();
  assert.deepEqual(kassa.verifyResult({ ...fields, SignatureValue }), { invId: 1001, outSum: 500, shp: { order: "AB12CD" } });
  assert.equal(kassa.verifyResult({ ...fields, OutSum: "1.000000", SignatureValue }), null);
  assert.equal(kassa.verifyResult({ ...fields, Shp_order: "ZZZZZZ", SignatureValue }), null);
  assert.equal(kassa.verifyResult({ ...fields, SignatureValue: "nope" }), null);
});

test("ResultURL accepts URLSearchParams too", () => {
  const params = new URLSearchParams({ OutSum: "100.00", InvId: "7", SignatureValue: md5("100.00:7:p2") });
  assert.equal(kassa.verifyResult(params)?.invId, 7);
});

test("receipt is one full-payment service line without VAT", () => {
  assert.deepEqual(buildReceipt({ name: "Fetchr", sum: 1290 }).items, [
    { name: "Fetchr", quantity: 1, sum: 1290, payment_method: "full_payment", payment_object: "service", tax: "none" },
  ]);
  assert.equal(formatSum(0.1 + 0.2), "0.30");
});
