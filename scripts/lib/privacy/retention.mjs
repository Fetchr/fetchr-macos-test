/** What each data file may keep. Pure rules over parsed records, so they can be
 *  tested without touching files; `data-cleanup.mjs` applies them.
 *
 * Paid orders and Robokassa payments are kept for tax accounting (4 years,
 * пп. 8 п. 1 ст. 23 НК РФ), never indefinitely (ч. 7 ст. 5 152-ФЗ). */

const DAY_MS = 86_400_000;

export const RETENTION_DAYS = {
  telemetry: 90,
  botActivity: 90,
  tickets: 90,
  consentGrace: 90,
  revokedLicense: 30,
  errors: 30,
  jobLogs: 30,
  unpaidOrders: 90,
  payClicks: 90,
  broadcastLogs: 90,
  taxRecords: 4 * 365,
};

const olderThan = (stamp, days, now) => {
  const time = Date.parse(stamp);
  return Number.isFinite(time) && now - time > days * DAY_MS;
};

const pairOf = (record) =>
  `${String(record?.machine_id || "").toUpperCase()}|${String(record?.license_key || "").replace(/\s+/g, "")}`;

/** A revocation is a later line for the same machine and key, and the newest
 *  line decides whether a key is live. Lines up to and including a revocation
 *  past its term go: the first line of a key is as personal as the last. */
export function purgeLicenses(records, now = Date.now()) {
  const expiredUpTo = new Map();
  records.forEach((record, index) => {
    if (record?.revoked_at && olderThan(record.revoked_at, RETENTION_DAYS.revokedLicense, now)) {
      expiredUpTo.set(pairOf(record), index);
    }
  });
  return records.filter((record, index) => {
    const limit = expiredUpTo.get(pairOf(record));
    return limit === undefined || index > limit;
  });
}

/** Revocation lines for a release that moves everyone to new keys. Only a
 *  machine's newest line counts, and one already holding a key from after
 *  `cutoff` is skipped: for this machine a later line would revoke that key. */
export function releaseRevocations(records, cutoff, now = Date.now()) {
  const newest = new Map();
  for (const record of records) {
    if (record?.machine_id && record.license_key) newest.set(String(record.machine_id).toUpperCase(), record);
  }
  const revokedAt = new Date(now).toISOString();
  return [...newest.values()]
    .filter((record) => !record.revoked_at && Date.parse(record.issued_at) < cutoff)
    .map((record) => ({ ...record, revoked_at: revokedAt, revoked_by: "release" }));
}

/** Unknown dates go too: a line that can never expire is the worse failure. */
export const purgeTelemetry = (records, now = Date.now()) =>
  records.filter((event) => {
    const time = Date.parse(event?.received_at);
    return Number.isFinite(time) && now - time <= RETENTION_DAYS.telemetry * DAY_MS;
  });

export const purgeActivity = (records, now = Date.now()) =>
  records.filter((record) => !olderThan(record?.at, RETENTION_DAYS.botActivity, now));

export const purgeErrors = (records, now = Date.now()) =>
  records.filter((row) => !olderThan(row?.received_at, RETENTION_DAYS.errors, now));

/** Tickets have no closed state, so the clock runs from the last message on one.
 *  Links written before they carried a date count from the ticket's creation.
 *  A `seq` line keeps the highest number once old tickets are gone. */
export function purgeTickets(records, now = Date.now()) {
  const lastActive = new Map();
  for (const event of records) {
    const id = event?.type === "ticket" ? event.id : event?.type === "link" ? event.ticket_id : null;
    const stamp = event?.type === "ticket" ? event.created_at : event?.at;
    if (id !== null && stamp && String(stamp) > String(lastActive.get(id) ?? "")) lastActive.set(id, stamp);
  }
  const expired = (id) => {
    const stamp = lastActive.get(id);
    return stamp ? olderThan(stamp, RETENTION_DAYS.tickets, now) : false;
  };
  const kept = records.filter((event) => {
    if (event?.type === "ticket") return !expired(event.id);
    if (event?.type === "link") return !expired(event.ticket_id);
    return event?.type !== "seq";
  });
  const highest = Math.max(
    0,
    ...records.filter((event) => event?.type === "ticket").map((event) => event.id),
    ...records.filter((event) => event?.type === "seq").map((event) => event.last_id),
  );
  return highest > 0 ? [{ type: "seq", last_id: highest }, ...kept] : kept;
}

/** A consent is the proof of consent: it stays while the account exists (a
 *  license line or an order) and goes with it. The grace period covers someone
 *  who has just agreed and is still registering. */
export function purgeConsents(records, accountUserIds, now = Date.now()) {
  const newest = new Map();
  for (const record of records) newest.set(record?.user_id, record?.at);
  return records.filter(({ user_id: userId }) =>
    accountUserIds.has(userId) || !olderThan(newest.get(userId), RETENTION_DAYS.consentGrace, now),
  );
}

export const purgeSessions = (sessions, now = Date.now()) =>
  sessions.filter((session) => session?.expires_at > now);

const SETTLED_ORDER = new Set(["paid", "refunded", "underpaid"]);

/** Paid/refunded orders stay for the 4-year tax window; unpaid drafts expire in 90 days. */
export function purgeOrders(records, now = Date.now()) {
  const latest = new Map();
  for (const record of records) if (record?.id) latest.set(record.id, record);
  return records.filter((record) => {
    const state = record?.id ? latest.get(record.id) : record;
    const settled = SETTLED_ORDER.has(state?.status);
    const stamp = state?.paid_at || state?.updated_at || state?.created_at || record?.created_at;
    return !olderThan(stamp, settled ? RETENTION_DAYS.taxRecords : RETENTION_DAYS.unpaidOrders, now);
  });
}

export const purgePayments = (records, now = Date.now()) =>
  records.filter((record) => !olderThan(record?.received_at, RETENTION_DAYS.taxRecords, now));

export const purgePayClicks = (records, now = Date.now()) =>
  records.filter((record) => !olderThan(record?.at, RETENTION_DAYS.payClicks, now));

export const purgeBroadcastLog = (records, now = Date.now()) =>
  records.filter((record) => !record?.at || !olderThan(record.at, RETENTION_DAYS.broadcastLogs, now));

/** Month -> number of distinct users, for what `/stats` keeps after lines expire. */
export function usersPerMonth(records) {
  const months = new Map();
  for (const { user_id: userId, at } of records) {
    const time = Date.parse(at);
    if (!Number.isFinite(userId) || !Number.isFinite(time)) continue;
    const month = new Date(time).toISOString().slice(0, 7);
    months.set(month, (months.get(month) ?? new Set()).add(userId));
  }
  return Object.fromEntries([...months].map(([month, users]) => [month, users.size]));
}
