/** Sliding-window hit counter per key (an address, a machine id, …).
 *
 * `allow(key)` records the hit and says whether it still fits in the window.
 * A refused hit is not recorded, so a blocked client gets back in on time.
 * At most `maxKeys` keys are tracked: expired ones go first, then the oldest. */
export function createRateLimiter({ limit, windowMs, maxKeys = 20_000, now = () => Date.now() }) {
  const hits = new Map();

  function makeRoom(stamp) {
    for (const [key, stamps] of hits) {
      if (stamps.at(-1) <= stamp - windowMs) hits.delete(key);
    }
    for (const key of hits.keys()) {
      if (hits.size < maxKeys) break;
      hits.delete(key);
    }
  }

  const allow = (key) => {
    const stamp = now();
    const recent = (hits.get(key) || []).filter((value) => stamp - value < windowMs);
    if (recent.length >= limit) {
      hits.set(key, recent);
      return false;
    }
    if (!hits.has(key) && hits.size >= maxKeys) makeRoom(stamp);
    hits.set(key, [...recent, stamp]);
    return true;
  };
  allow.size = () => hits.size;
  return allow;
}
