import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";

/**
 * Черновик пишется с задержкой, а не на каждое изменение: перетаскивание зоны
 * блюра меняет значение на каждое движение мыши, и JSON.stringify всех зон
 * (с ключевыми кадрами трекинга) плюс синхронный localStorage.setItem на
 * каждое движение давали рывки. Недописанное значение дописывается при уходе.
 *
 * Пишет только экземпляр, который сам менял значение: два проигрывателя с
 * одним ключом громкости не должны затирать друг друга при закрытии.
 */
const WRITE_DELAY_MS = 400;

function writeDraft(key: string, value: unknown) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Draft persistence is best-effort; UI state must still work if storage is full or blocked.
  }
}

export function usePersistedState<T>(
  key: string,
  initialValue: T | (() => T),
): [T, Dispatch<SetStateAction<T>>] {
  const [value, setValue] = useState<T>(() => {
    const fallback = typeof initialValue === "function" ? (initialValue as () => T)() : initialValue;
    if (typeof window === "undefined") return fallback;
    try {
      const raw = window.localStorage.getItem(key);
      return raw ? (JSON.parse(raw) as T) : fallback;
    } catch {
      return fallback;
    }
  });
  const latest = useRef({ key, value });
  latest.current = { key, value };
  const dirty = useRef(false);
  const mounted = useRef(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    dirty.current = true;
    const timer = window.setTimeout(() => {
      writeDraft(key, value);
      dirty.current = false;
    }, WRITE_DELAY_MS);
    return () => {
      window.clearTimeout(timer);
      // Ключ сменился до записи: последнее значение уходит под старый ключ.
      if (dirty.current && latest.current.key !== key) {
        writeDraft(key, value);
        dirty.current = false;
      }
    };
  }, [key, value]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const flush = () => {
      if (!dirty.current) return;
      writeDraft(latest.current.key, latest.current.value);
      dirty.current = false;
    };
    window.addEventListener("pagehide", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      flush();
    };
  }, []);

  return [value, setValue];
}
