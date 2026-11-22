import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createArchiveTenants, desiredTenant, ensureArgs, grantTenant } from "./archive-tenants.mjs";
import { subscriptionOf } from "./account-subscription.mjs";

const MACHINE = "0123456789ABCDEF0123456789ABCDEF";
const KEY = "FTR1.payload.sig";
const at = (iso) => () => Date.parse(iso);

function setup({ orders = [], licenses, now = at("2026-09-26T12:00:00Z"), provision } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "archive-"));
  const calls = [];
  let ids = 0;
  const archive = createArchiveTenants({
    statePath: join(dir, "state.json"),
    readLicenses: async () => licenses ?? [{ machine_id: MACHINE, license_key: KEY, telegram_user_id: 42 }],
    readOrders: async () => orders,
    provision: provision ?? (async (args) => {
      calls.push(args);
      return { ok: true, token: `tok-${args[1]}` };
    }),
    publicBase: "https://fetchr.fun/rec/",
    now,
    newId: () => `tenant${String(++ids).padStart(6, "0")}`,
  });
  return { archive, calls, dir };
}

const paid = (user_id, plan_id, paid_at, extra = {}) => ({ id: `${user_id}${paid_at}`, user_id, plan_id, status: "paid", paid_at, ...extra });

test("a paid order becomes a recorder sized by the plan", async () => {
  const { archive, calls, dir } = setup({ orders: [paid(42, "streamer", "2026-09-20T00:00:00Z", { quota_gb: 170, packs: 2 })] });
  await archive.reconcile();
  assert.deepEqual(calls, [[
    "ensure", "tenant000001", "--plan", "streamer", "--quota-gb", "170",
    "--channels", "2", "--packs", "2", "--paid-until", String(Date.parse("2026-10-20T00:00:00Z") / 1000),
  ]]);
  const state = JSON.parse(readFileSync(join(dir, "state.json"), "utf8"));
  assert.equal(state.users["42"].token, "tok-tenant000001");
});

test("reconcile is idempotent", async () => {
  const { archive, calls } = setup({ orders: [paid(42, "start", "2026-09-20T00:00:00Z")] });
  await archive.reconcile();
  await archive.reconcile();
  assert.equal(calls.length, 1);
});

test("an expired plan is suspended once, and a renewal resumes the same tenant", async () => {
  const orders = [paid(42, "start", "2026-08-01T00:00:00Z")];
  const clock = { now: Date.parse("2026-08-10T00:00:00Z") };
  const { archive, calls } = setup({ orders, now: () => clock.now });
  await archive.reconcile();
  clock.now = Date.parse("2026-09-05T00:00:00Z");
  await archive.reconcile();
  await archive.reconcile();
  assert.deepEqual(calls.map((args) => args[0]), ["ensure", "suspend"]);
  orders.push(paid(42, "start", "2026-09-05T00:00:00Z"));
  await archive.reconcile();
  assert.deepEqual(calls.map((args) => args.slice(0, 2)), [["ensure", "tenant000001"], ["suspend", "tenant000001"], ["ensure", "tenant000001"]]);
});

test("a buyer whose plan expired before any recorder existed gets none", async () => {
  const { archive, calls } = setup({ orders: [paid(42, "start", "2026-01-01T00:00:00Z")] });
  await archive.reconcile();
  assert.equal(calls.length, 0);
});

test("connect hands the app its recorder address and token", async () => {
  const { archive } = setup({ orders: [paid(42, "archive", "2026-09-20T00:00:00Z")] });
  const out = await archive.connect({ machine_id: MACHINE.toLowerCase(), license_key: ` ${KEY} ` });
  assert.equal(out.base_url, "https://fetchr.fun/rec/tenant000001");
  assert.equal(out.token, "tok-tenant000001");
  assert.equal(out.subscription.plan, "archive");
  assert.equal(out.subscription.quota_gb, 500);
  assert.equal(out.subscription.channels, 5);
});

test("connect refuses a wrong or revoked key and a buyer without a plan", async () => {
  const { archive } = setup({ orders: [] });
  await assert.rejects(archive.connect({ machine_id: MACHINE, license_key: "FTR1.other" }), { code: "not_licensed" });
  await assert.rejects(archive.connect({ machine_id: "nope", license_key: KEY }), { code: "invalid_request" });
  await assert.rejects(archive.connect({ machine_id: MACHINE, license_key: KEY }), { code: "no_subscription" });

  const revoked = setup({
    orders: [paid(42, "start", "2026-09-20T00:00:00Z")],
    licenses: [
      { machine_id: MACHINE, license_key: KEY, telegram_user_id: 42 },
      { machine_id: MACHINE, license_key: KEY, telegram_user_id: 42, revoked_at: "2026-09-21T00:00:00Z" },
    ],
  });
  await assert.rejects(revoked.archive.connect({ machine_id: MACHINE, license_key: KEY }), { code: "not_licensed" });
});

test("a grant by Machine ID gives a recorder without an order, and expires on its date", async () => {
  const grants = [{ machine_id: MACHINE.toLowerCase(), plan: "streamer", quota_gb: 200, channels: 2, packs: 5, until: "2026-10-26T12:00:00Z" }];
  const clock = { now: Date.parse("2026-09-26T12:00:00Z") };
  const dir = mkdtempSync(join(tmpdir(), "archive-"));
  const calls = [];
  const archive = createArchiveTenants({
    statePath: join(dir, "state.json"),
    readLicenses: async () => [{ machine_id: MACHINE, license_key: KEY, telegram_user_id: 42 }],
    readOrders: async () => [],
    readGrants: async () => grants,
    provision: async (args) => {
      calls.push(args);
      return { ok: true, token: "tok" };
    },
    publicBase: "https://fetchr.fun/rec",
    now: () => clock.now,
    newId: () => "granted00001",
  });
  const out = await archive.connect({ machine_id: MACHINE, license_key: KEY });
  assert.equal(out.subscription.quota_gb, 200);
  assert.equal(out.subscription.days_left, 30);
  assert.deepEqual(calls[0].slice(0, 8), ["ensure", "granted00001", "--plan", "streamer", "--quota-gb", "200", "--channels", "2"]);
  clock.now = Date.parse("2026-10-27T00:00:00Z");
  await archive.reconcile();
  assert.deepEqual(calls.at(-1), ["suspend", "granted00001"]);
});

test("a bigger grant upgrades a running paid plan; when it lapses the paid plan returns", async () => {
  const grants = [{ machine_id: MACHINE, plan: "streamer", quota_gb: 1000, channels: 2, until: "2026-10-10T00:00:00Z" }];
  const clock = { now: Date.parse("2026-09-26T12:00:00Z") };
  const dir = mkdtempSync(join(tmpdir(), "archive-"));
  const calls = [];
  const archive = createArchiveTenants({
    statePath: join(dir, "state.json"),
    readLicenses: async () => [{ machine_id: MACHINE, license_key: KEY, telegram_user_id: 42 }],
    readOrders: async () => [paid(42, "streamer", "2026-09-20T00:00:00Z")],
    readGrants: async () => grants,
    provision: async (args) => {
      calls.push(args);
      return { ok: true, token: "tok" };
    },
    publicBase: "https://fetchr.fun/rec",
    now: () => clock.now,
    newId: () => "upgraded0001",
  });
  await archive.reconcile();
  assert.equal(calls.at(-1)[5], "1000");
  clock.now = Date.parse("2026-10-11T00:00:00Z");
  await archive.reconcile();
  assert.equal(calls.at(-1)[0], "ensure");
  assert.notEqual(calls.at(-1)[5], "1000");
});

test("a grant without an end date never expires and sends no paid-until", async () => {
  const { dir } = setup();
  const calls = [];
  const archive = createArchiveTenants({
    statePath: join(dir, "forever.json"),
    readLicenses: async () => [],
    readOrders: async () => [],
    readGrants: async () => [{ telegram_user_id: 7, plan: "max", quota_gb: 1000, channels: 5 }],
    provision: async (args) => {
      calls.push(args);
      return { ok: true, token: "t" };
    },
    publicBase: "x",
    now: at("2030-01-01T00:00:00Z"),
  });
  await archive.reconcile();
  assert.equal(calls.length, 1);
  assert.ok(!calls[0].includes("--paid-until"));
});

test("a storage failure for one buyer does not block the others", async () => {
  const calls = [];
  const { archive } = setup({
    orders: [paid(1, "start", "2026-09-20T00:00:00Z"), paid(2, "start", "2026-09-20T00:00:00Z")],
    provision: async (args) => {
      calls.push(args[1]);
      return calls.length === 1 ? { ok: false, error: "disk full" } : { ok: true, token: "t" };
    },
  });
  const result = await archive.reconcile();
  assert.deepEqual(result, { users: 2, failures: 1 });
  await archive.reconcile();
  assert.equal(calls.length, 3, "the failed buyer is retried on the next pass");
});

test("an unreadable state file stops start-up instead of re-issuing empty recorders", async () => {
  const { dir } = setup();
  const path = join(dir, "broken.json");
  (await import("node:fs")).writeFileSync(path, "{nope");
  assert.throws(() => createArchiveTenants({ statePath: path, readLicenses: async () => [], readOrders: async () => [], provision: async () => ({}), publicBase: "x" }), /unreadable/);
});

test("a Free subscription asks the server for a recorder with no end date", async () => {
  const { desiredTenant } = await import("./archive-tenants.mjs");
  const { subscriptionOf } = await import("./account-subscription.mjs");
  const desired = desiredTenant(subscriptionOf([{ id: "f", plan_id: "free", method: "free", status: "paid", created_at: "2026-11-01T00:00:00Z", paid_at: "2026-11-01T00:00:00Z", quota_gb: 5 }]));
  assert.equal(desired.active, true);
  assert.equal(desired.plan, "free");
  assert.equal(desired.quota_gb, 5);
  assert.equal(desired.paid_until, null);
});

test("restream and extra streamers bought with a plan reach the storage server", () => {
  const order = {
    id: "R1", user_id: 7, plan_id: "start", packs: 0, quota_gb: 50, months: 1, status: "paid",
    paid_at: "2026-11-09T10:00:00Z", amount: 647, extra_channels: 1, restream_streamers: 2, restream_extra: 1,
  };
  const desired = desiredTenant(subscriptionOf([order], Date.parse("2026-11-10T00:00:00Z")));
  assert.equal(desired.channels, 2);
  assert.equal(desired.restream_streamers, 2);
  assert.equal(desired.restream_extra, 1);
  const args = ensureArgs("abcdefabcdef", desired);
  assert.deepEqual(args.slice(-4), ["--restream", "2", "--restream-extra", "1"]);
});

test("a plan without restream keeps the old ensure call", () => {
  const order = { id: "R2", user_id: 8, plan_id: "start", packs: 0, quota_gb: 50, months: 1, status: "paid", paid_at: "2026-11-09T10:00:00Z", amount: 200 };
  const desired = desiredTenant(subscriptionOf([order], Date.parse("2026-11-10T00:00:00Z")));
  assert.equal("restream_streamers" in desired, false);
  assert.ok(!ensureArgs("abcdefabcdef", desired).includes("--restream"));
});

test("a grant can carry a restream trial that ends on its own", () => {
  const grant = { machine_id: "A".repeat(32), plan: "streamer", quota_gb: 1000, channels: 2, until: null,
    restream_streamers: 1, restream_extra: 1, restream_until: "2026-12-10T00:00:00Z" };
  const during = grantTenant(grant, Date.parse("2026-11-20T00:00:00Z"));
  assert.equal(during.restream_streamers, 1);
  assert.equal(during.restream_extra, 1);
  assert.deepEqual(ensureArgs("abcdefabcdef", during).slice(-4), ["--restream", "1", "--restream-extra", "1"]);
  const after = grantTenant(grant, Date.parse("2026-12-11T00:00:00Z"));
  assert.equal("restream_streamers" in after, false);
  assert.equal(after.quota_gb, 1000, "the plan itself stays");
});
