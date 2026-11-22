/** Structural equality for the JSON-shaped data the archive API returns. */
export function sameData(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, index) => sameData(item, b[index]));
  }
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  return keys.every((key) => Object.prototype.hasOwnProperty.call(right, key) && sameData(left[key], right[key]));
}

/** Keeps the previous object when the fresh one carries the same data. */
export function keepIfSame<T>(previous: T, next: T): T {
  return sameData(previous, next) ? previous : next;
}

/**
 * Fresh list with every unchanged item swapped for its previous reference, so
 * memoised rows skip re-rendering. Returns the previous array itself when
 * nothing changed at all.
 */
export function reconcileList<T>(previous: readonly T[], next: readonly T[], keyOf: (item: T) => string): T[] {
  const byKey = new Map(previous.map((item) => [keyOf(item), item] as const));
  const merged = next.map((item) => {
    const old = byKey.get(keyOf(item));
    return old !== undefined && sameData(old, item) ? old : item;
  });
  const unchanged = merged.length === previous.length && merged.every((item, index) => item === previous[index]);
  return unchanged ? (previous as T[]) : merged;
}
