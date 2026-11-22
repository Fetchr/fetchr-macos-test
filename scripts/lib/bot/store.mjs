/** Append-only JSONL persistence. Each write appends a full snapshot, so a
 *  replay where the last line per id wins rebuilds state after a restart, and
 *  a crash mid-write loses at most the line being written. */

import { randomBytes } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
} from "node:fs";
import { dirname } from "node:path";

export function readJsonLines(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
}

/** False when the file ends mid-line, as after a crash during a write. */
function endsCleanly(path) {
  if (!existsSync(path)) return true;
  const { size } = statSync(path);
  if (size === 0) return true;
  const last = Buffer.alloc(1);
  const fd = openSync(path, "r");
  try {
    readSync(fd, last, 0, 1, size - 1);
  } finally {
    closeSync(fd);
  }
  return last[0] === 0x0a;
}

export function appendJsonLine(path, record) {
  mkdirSync(dirname(path), { recursive: true });
  // Close a torn last line first, or it would swallow this record on replay.
  const lead = endsCleanly(path) ? "" : "\n";
  appendFileSync(path, `${lead}${JSON.stringify(record)}\n`, "utf8");
}

// No 0/O or 1/I: order numbers get read out loud and typed back to support.
const ORDER_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function newOrderId(taken) {
  for (;;) {
    const id = [...randomBytes(6)].map((byte) => ORDER_ALPHABET[byte % ORDER_ALPHABET.length]).join("");
    if (!taken.has(id)) return id;
  }
}

/** Fields older orders held. Dropped on load, or the next update of such an
 *  order would write them back. */
function withoutProfile({ username, first_name: firstName, chat_id: chatId, ...order }) {
  return order;
}

export function createOrderStore(path, { now = () => Date.now() } = {}) {
  const orders = new Map();
  for (const snapshot of readJsonLines(path)) {
    if (snapshot?.id) orders.set(snapshot.id, withoutProfile(snapshot));
  }

  function save(order) {
    appendJsonLine(path, order);
    orders.set(order.id, order);
    return order;
  }

  return {
    get: (id) => orders.get(id) ?? null,
    create(fields) {
      const stamp = new Date(now()).toISOString();
      return save({ id: newOrderId(orders), status: "pending", created_at: stamp, ...fields });
    },
    update(id, patch) {
      const current = orders.get(id);
      if (!current) return null;
      return save({ ...current, ...patch, updated_at: new Date(now()).toISOString() });
    },
    all: () => [...orders.values()],
    /** Newest order matching the predicate. */
    find(predicate) {
      return [...orders.values()].reverse().find(predicate) ?? null;
    },
    pendingCrypto() {
      return [...orders.values()].filter(
        (order) => order.method === "crypto" && order.status === "pending" && order.invoice_id,
      );
    },
    countForUser(userId) {
      return [...orders.values()].filter(
        (order) => order.user_id === userId && order.status === "paid",
      ).length;
    },
  };
}

/** Support threads. A ticket is linked to every message that belongs to it on
 *  either side, so a reply to any of them lands in the right conversation. */
export function createTicketStore(path, { now = () => Date.now() } = {}) {
  const tickets = new Map();
  const links = new Map();
  let lastId = 0;
  const key = (chatId, messageId) => `${chatId}:${messageId}`;

  for (const event of readJsonLines(path)) {
    if (event?.type === "ticket") {
      tickets.set(event.id, event);
      lastId = Math.max(lastId, event.id);
    } else if (event?.type === "link") {
      links.set(key(event.chat_id, event.message_id), event.ticket_id);
    } else if (event?.type === "seq") {
      // Expired tickets leave this behind, so numbers are never reused.
      lastId = Math.max(lastId, event.last_id);
    }
  }

  return {
    get: (id) => tickets.get(Number(id)) ?? null,
    open(fields) {
      lastId += 1;
      const ticket = { type: "ticket", id: lastId, created_at: new Date(now()).toISOString(), ...fields };
      appendJsonLine(path, ticket);
      tickets.set(ticket.id, ticket);
      return ticket;
    },
    link(ticketId, chatId, messageId) {
      if (!messageId) return;
      appendJsonLine(path, {
        type: "link",
        ticket_id: ticketId,
        chat_id: chatId,
        message_id: messageId,
        at: new Date(now()).toISOString(),
      });
      links.set(key(chatId, messageId), ticketId);
    },
    find(chatId, messageId) {
      const id = links.get(key(chatId, messageId));
      return id ? (tickets.get(id) ?? null) : null;
    },
  };
}

/** Per-user UI state that only matters for a few minutes: what the next free
 *  text message means. Lost on restart by design — every screen can be
 *  reopened from its button. */
export function createSessions({ ttlMs = 30 * 60_000, now = () => Date.now() } = {}) {
  const sessions = new Map();
  const get = (userId) => {
    const session = sessions.get(userId);
    if (!session || session.expiresAt < now()) return {};
    return session;
  };
  return {
    get,
    set(userId, patch) {
      const next = { ...get(userId), ...patch, expiresAt: now() + ttlMs };
      sessions.set(userId, next);
      return next;
    },
    clear(userId) {
      sessions.delete(userId);
    },
  };
}

/** Sliding-window limit, so a stuck client or a spammer cannot flood the
 *  admins' chat through the support relay. */
export function createRateLimiter({ limit, windowMs, now = () => Date.now() }) {
  const hits = new Map();
  return (userId) => {
    const recent = (hits.get(userId) || []).filter((stamp) => now() - stamp < windowMs);
    if (recent.length >= limit) {
      hits.set(userId, recent);
      return false;
    }
    hits.set(userId, [...recent, now()]);
    return true;
  };
}

const monthOf = (stamp) => new Date(stamp).toISOString().slice(0, 7);

/** Users seen outside the activity log: registrations, orders, tickets. */
export function pastActivity({ licensesPath, ordersPath, ticketsPath }) {
  return [
    ...readJsonLines(licensesPath).map((record) => ({ user_id: record.telegram_user_id, at: record.issued_at })),
    ...readJsonLines(ordersPath),
    ...readJsonLines(ticketsPath).filter((event) => event.type === "ticket"),
  ].map((record) => ({ user_id: record.user_id, at: record.at ?? record.created_at }));
}

/** Counts the cleanup job kept when it deleted expired lines. */
export function readActivityArchive(path) {
  try {
    return { months: {}, dropped_total: 0, ...JSON.parse(readFileSync(path, "utf8")) };
  } catch {
    return { months: {}, dropped_total: 0 };
  }
}

/** Who used the bot in which calendar month (UTC). One line per user per
 *  month, written the first time they show up in it. `seed` adds older
 *  history (registrations, orders, tickets) that predates this log, and
 *  `archivePath` the bare counts left after lines expired. */
export function createActivityLog(path, { seed = [], archivePath = null, now = () => Date.now() } = {}) {
  const months = new Map();
  const add = (month, userId) => {
    const users = months.get(month) ?? new Set();
    const fresh = !users.has(userId);
    months.set(month, users.add(userId));
    return fresh;
  };

  for (const { user_id: userId, at } of [...seed, ...readJsonLines(path)]) {
    const time = Date.parse(at);
    if (Number.isFinite(userId) && Number.isFinite(time)) add(monthOf(time), userId);
  }

  return {
    touch(userId) {
      if (!Number.isFinite(userId)) return;
      const stamp = now();
      if (add(monthOf(stamp), userId)) appendJsonLine(path, { user_id: userId, at: new Date(stamp).toISOString() });
    },
    /** Newest month first, `count` months back from the current one. */
    monthly(count = 6) {
      const current = new Date(now());
      return Array.from({ length: count }, (_, back) => {
        const month = monthOf(Date.UTC(current.getUTCFullYear(), current.getUTCMonth() - back, 1));
        const archived = archivePath ? readActivityArchive(archivePath).months[month] ?? 0 : 0;
        return { month, users: Math.max(months.get(month)?.size ?? 0, archived) };
      });
    },
    /** Every Telegram id still in the log or the seed. */
    users() {
      return [...new Set([...months.values()].flatMap((users) => [...users]))];
    },
    total() {
      const live = new Set([...months.values()].flatMap((users) => [...users])).size;
      return live + (archivePath ? readActivityArchive(archivePath).dropped_total : 0);
    },
  };
}

/** Consent to process personal data (152-ФЗ, ст. 9): one line per consent,
 *  with the document version the user saw. Only the newest line per user
 *  counts, so a withdrawal is a later line with `withdrawn: true`. */
export function createConsentLog(path, { version, now = () => Date.now() }) {
  // Read each time: the cleanup job deletes consents of deleted accounts.
  const latest = (userId) =>
    readJsonLines(path).filter((record) => record?.user_id === userId).at(-1);
  return {
    has(userId) {
      const record = latest(userId);
      return Boolean(record && !record.withdrawn && record.version === version);
    },
    give(userId) {
      appendJsonLine(path, { user_id: userId, version, at: new Date(now()).toISOString() });
    },
  };
}
