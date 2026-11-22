/** Daily counters for the admin dashboard: `{ days: { "YYYY-MM-DD": { key: n } } }`.
 *
 * Only counts are stored — no addresses, ids or user agents — so the file
 * needs no retention. Writes are batched: a bump marks the store dirty and a
 * timer saves it (tmp file + rename, so a crash never leaves half a file). */

import { existsSync, readFileSync } from "node:fs";
import { rename, writeFile } from "node:fs/promises";

export const dayKey = (stamp) => new Date(stamp).toISOString().slice(0, 10);

const MAX_KEYS_PER_DAY = 5_000;
const MAX_KEYS_PER_GROUP = 300;

export function createCounters({ path, now = () => Date.now(), flushMs = 10_000, log = () => {} }) {
  let days = load(path, log);
  let dirty = false;
  let saving = null;

  const timer = flushMs > 0 ? setInterval(() => flush().catch(() => {}), flushMs) : null;
  timer?.unref?.();

  /** The group is everything up to the last colon (`page:`, `ev:bot_click:`).
   *  A key past its group's daily limit is counted as `<group>:(other)`, so
   *  junk paths or referrers cannot crowd out the rest of the day. */
  function bump(key, amount = 1, day = dayKey(now())) {
    if (!key || !Number.isFinite(amount) || amount === 0) return;
    const current = days[day] || {};
    const target = key in current ? key : roomFor(current, key);
    if (!target) return;
    days = { ...days, [day]: { ...current, [target]: (current[target] || 0) + amount } };
    dirty = true;
  }

  function roomFor(current, key) {
    const cut = key.lastIndexOf(":");
    const group = cut > 0 ? key.slice(0, cut + 1) : "";
    const keys = Object.keys(current);
    if (keys.length >= MAX_KEYS_PER_DAY) return null;
    const sameGroup = (name) => name.startsWith(group) && name.lastIndexOf(":") === cut;
    if (!group || keys.filter(sameGroup).length < MAX_KEYS_PER_GROUP) return key;
    return `${group}(other)`;
  }

  /** Removes the keys of `day` that `drop` selects (used to redo an import). */
  function remove(day, drop) {
    const current = days[day];
    if (!current) return;
    days = { ...days, [day]: Object.fromEntries(Object.entries(current).filter(([key]) => !drop(key))) };
    dirty = true;
  }

  /** Days from `from` through `to` (inclusive, "YYYY-MM-DD"), oldest first. */
  function range(from, to) {
    return Object.keys(days)
      .filter((day) => day >= from && day <= to)
      .sort()
      .map((day) => ({ day, counts: { ...days[day] } }));
  }

  async function flush() {
    if (!dirty) return;
    if (saving) return saving;
    dirty = false;
    const text = JSON.stringify({ version: 1, days });
    saving = writeFile(`${path}.tmp`, text, "utf8")
      .then(() => rename(`${path}.tmp`, path))
      .catch((err) => {
        dirty = true;
        log(`analytics: counters not saved: ${err.message}`);
      })
      .finally(() => {
        saving = null;
      });
    return saving;
  }

  function stop() {
    if (timer) clearInterval(timer);
    return flush();
  }

  return { bump, remove, range, flush, stop };
}

function load(path, log) {
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed.days === "object" ? parsed.days : {};
  } catch (err) {
    log(`analytics: counters unreadable, starting empty: ${err.message}`);
    return {};
  }
}
