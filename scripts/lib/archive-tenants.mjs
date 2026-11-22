/** Archive VPS for buyers: every paid subscription gets its own recorder on the
 *  shared storage server, sized by the plan, with no manual step.
 *
 *   POST /archive/connect { machine_id, license_key } -> { ok, base_url, token, subscription }
 *
 * The app proves who it is with the same Machine ID + licence key pair it
 * already checks at start-up; the key's Telegram owner is the buyer whose
 * orders decide the plan. `reconcile` runs on a timer so a payment turns into
 * a recorder within a minute and an expired plan stops recording, whether or
 * not the app is open. The storage side is `fetchr-tenant` behind `provision`.
 */

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { isFreeOrder, largerQuota, subscriptionOf, userOrders } from "./account-subscription.mjs";

export class ArchiveError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const normalizeKey = (value) => String(value || "").replace(/\s+/g, "");

/** What the storage server should run for a subscription; null = nothing. */
export function desiredTenant(subscription) {
  if (!subscription) return null;
  return {
    active: subscription.active,
    plan: subscription.plan_id,
    quota_gb: subscription.quota_gb,
    channels: subscription.channels,
    packs: subscription.packs,
    paid_until: subscription.paid_until ? Math.floor(Date.parse(subscription.paid_until) / 1000) : null,
    ...restreamOf(subscription),
  };
}

/** Restream allowance, only when there is one: older tenants keep their exact
 *  applied state, so no ensure is re-run for them. */
function restreamOf(source, now = Date.now()) {
  // A grant may give restream for a while only (a trial): `restream_until`.
  if (source?.restream_until && !(Date.parse(source.restream_until) > now)) return {};
  const streamers = Math.max(0, Math.trunc(Number(source?.restream_streamers) || 0));
  const extra = Math.max(0, Math.trunc(Number(source?.restream_extra) || 0));
  return streamers ? { restream_streamers: streamers, restream_extra: extra } : {};
}

/** `fetchr-tenant ensure` arguments for a desired tenant. */
export function ensureArgs(id, desired) {
  return ["ensure", id, "--plan", desired.plan, "--quota-gb", String(desired.quota_gb),
    "--channels", String(desired.channels), "--packs", String(desired.packs),
    ...(desired.paid_until === null ? [] : ["--paid-until", String(desired.paid_until)]),
    ...(desired.restream_streamers ? ["--restream", String(desired.restream_streamers), "--restream-extra", String(desired.restream_extra || 0)] : [])];
}

const sameTenant = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** Telegram owner of a machine's current, unrevoked key. */
function machineOwner(licenses, machineId) {
  const id = String(machineId || "").toUpperCase();
  const latest = licenses.filter((record) => String(record.machine_id || "").toUpperCase() === id).at(-1);
  return latest && !latest.revoked_at ? latest.telegram_user_id ?? null : null;
}

/** A hand-issued plan (test access, friends, own use), keyed by Telegram user
 *  or Machine ID. No `until` = never expires. */
export function grantTenant(grant, now) {
  const until = grant.until ? Date.parse(grant.until) : null;
  return {
    active: until === null || until > now,
    plan: grant.plan,
    quota_gb: grant.quota_gb,
    channels: grant.channels,
    packs: grant.packs ?? 0,
    paid_until: until === null ? null : Math.floor(until / 1000),
    ...restreamOf(grant, now),
  };
}

export function createArchiveTenants({
  statePath,
  readLicenses,
  readOrders,
  readGrants = async () => [],
  provision,
  publicBase,
  now = () => Date.now(),
  newId = () => randomBytes(6).toString("hex"),
  log = () => {},
}) {
  const state = loadState();
  let queue = Promise.resolve();

  function loadState() {
    if (!statePath || !existsSync(statePath)) return { users: {} };
    try {
      const parsed = JSON.parse(readFileSync(statePath, "utf8"));
      return { users: parsed.users || {} };
    } catch (err) {
      // Losing this file would hand buyers new, empty recorders: refuse to guess.
      throw new Error(`archive tenants state unreadable: ${err.message}`);
    }
  }

  function saveState() {
    if (!statePath) return;
    mkdirSync(dirname(statePath), { recursive: true });
    const tmp = `${statePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
    renameSync(tmp, statePath);
  }

  /** One storage call at a time: two ensures for one user must not race. */
  function serial(task) {
    const run = queue.then(task, task);
    queue = run.catch(() => {});
    return run;
  }

  async function applyUser(userId, desired) {
    const key = String(userId);
    const current = state.users[key];
    if (!desired) return current || null;
    if (current && sameTenant(current.applied, desired)) return current;
    if (!current && !desired.active) return null;

    const id = current?.id || newId();
    const result = desired.active
      ? await provision(ensureArgs(id, desired))
      : await provision(["suspend", id]);
    if (!result?.ok) throw new Error(`storage refused ${desired.active ? "ensure" : "suspend"} for ${id}: ${result?.error || "no answer"}`);

    const next = {
      id,
      token: result.token || current?.token,
      applied: desired,
      updated_at: new Date(now()).toISOString(),
    };
    state.users[key] = next;
    saveState();
    log(`archive: ${desired.active ? "ensured" : "suspended"} tenant ${id} for user ${key} (${desired.plan}, ${desired.quota_gb} GB)`);
    return next;
  }

  async function snapshot() {
    const [orders, licenses, grants] = await Promise.all([readOrders(), readLicenses(), readGrants()]);
    return { orders, licenses, grants: Array.isArray(grants) ? grants : [] };
  }

  const grantOwner = (grant, licenses) =>
    grant.telegram_user_id ?? (grant.machine_id ? machineOwner(licenses, grant.machine_id) : null);

  /** A running paid plan wins unless a running grant is bigger; a grant
   *  covers the rest. */
  function desiredFor(userId, { orders, licenses, grants }) {
    const fromOrders = desiredTenant(subscriptionOf(userOrders(orders, userId), now()));
    const grant = grants.find((item) => grantOwner(item, licenses) === userId);
    const fromGrant = grant ? grantTenant(grant, now()) : null;
    if (fromOrders?.active && fromGrant?.active) return largerQuota(fromOrders, fromGrant);
    if (fromOrders?.active) return fromOrders;
    if (fromGrant?.active) return fromGrant;
    return fromOrders || fromGrant;
  }

  /** Bring the storage server in line with every buyer's orders and grants. */
  function reconcile() {
    return serial(async () => {
      const snap = await snapshot();
      const users = new Set(snap.orders
        .filter((order) => order?.status === "paid" || (isFreeOrder(order) && order?.status === "requested"))
        .map((order) => order.user_id));
      for (const grant of snap.grants) {
        const owner = grantOwner(grant, snap.licenses);
        if (owner != null) users.add(owner);
      }
      for (const known of Object.keys(state.users)) users.add(Number.isNaN(Number(known)) ? known : Number(known));
      let failures = 0;
      for (const userId of users) {
        try {
          await applyUser(userId, desiredFor(userId, snap));
        } catch (err) {
          failures += 1;
          log(`archive: reconcile user ${userId} failed: ${err.message}`);
        }
      }
      return { users: users.size, failures };
    });
  }

  async function ownerOf(machineId, licenseKey) {
    const id = String(machineId || "").trim().toUpperCase();
    const key = normalizeKey(licenseKey);
    if (!/^[A-F0-9]{32}$/.test(id) || !key) throw new ArchiveError(400, "invalid_request", "Неизвестное устройство.");
    // Same rule as /license/status at start-up: the newest record of this key
    // decides, so a reset (a revoked copy appended) locks it out.
    const latest = (await readLicenses())
      .filter((record) => String(record.machine_id || "").toUpperCase() === id)
      .filter((record) => normalizeKey(record.license_key) === key)
      .at(-1);
    if (!latest || latest.revoked_at || !latest.telegram_user_id) {
      throw new ArchiveError(403, "not_licensed", "Ключ этого устройства не найден или отозван.");
    }
    return latest.telegram_user_id;
  }

  async function connect(body) {
    const userId = await ownerOf(body?.machine_id, body?.license_key);
    return serial(async () => {
      const desired = desiredFor(userId, await snapshot());
      const tenant = await applyUser(userId, desired);
      if (!desired || !tenant) {
        throw new ArchiveError(404, "no_subscription", "На вашем аккаунте нет оплаченного тарифа «Архив VPS».");
      }
      const until = desired.paid_until === null ? null : desired.paid_until * 1000;
      return {
        ok: true,
        base_url: `${publicBase.replace(/\/+$/, "")}/${tenant.id}`,
        token: tenant.token,
        subscription: {
          active: desired.active,
          plan: desired.plan,
          quota_gb: desired.quota_gb,
          channels: desired.channels,
          paid_until: until === null ? null : new Date(until).toISOString(),
          days_left: until === null ? null : Math.max(0, Math.ceil((until - now()) / 86_400_000)),
        },
      };
    });
  }

  async function handle(req, res, url, { json, readJson }) {
    if (url.pathname !== "/archive/connect") return false;
    if (req.method !== "POST") {
      json(res, 405, { ok: false, error: "method_not_allowed" });
      return true;
    }
    try {
      json(res, 200, await connect(await readJson(req, 16 * 1024)));
    } catch (err) {
      if (err instanceof ArchiveError) {
        json(res, err.status, { ok: false, error: err.code, message: err.message });
      } else {
        log(`archive: connect failed: ${err.message}`);
        json(res, 502, { ok: false, error: "storage_unavailable", message: "Сервер архива временно недоступен, попробуйте через минуту." });
      }
    }
    return true;
  }

  /** This user's recorder on the storage server, for the site's archive page. */
  function tenantOf(userId) {
    const tenant = state.users[String(userId)];
    return tenant?.id && tenant.token ? { id: tenant.id, token: tenant.token } : null;
  }

  return { handle, reconcile, connect, tenantOf };
}
