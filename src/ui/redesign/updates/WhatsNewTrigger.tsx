import { useEffect, useState } from "react";

import { useBoot } from "@/stores/boot";
import { useUI } from "@/stores/ui";

import { bundledWhatsNew } from "./bundledNotes";

const SHOWN_KEY = "fetchr-whats-new";
/** Сколько после обновления в шапке висит кнопка «Что нового». */
const BUTTON_TTL_MS = 24 * 60 * 60 * 1000;

interface ShownRecord {
  version: string;
  from: string;
  at: number;
}

function readShown(): ShownRecord | null {
  try {
    const record = JSON.parse(localStorage.getItem(SHOWN_KEY) ?? "null") as ShownRecord | null;
    return record?.version === __APP_VERSION__ ? record : null;
  } catch {
    return null;
  }
}

/** С какой версии обновились: в первый запуск — из заставки, потом — из записи. */
export function whatsNewFromVersion(updatedFrom: string | null): string | null {
  return updatedFrom ?? readShown()?.from ?? null;
}

/**
 * После установки обновления один раз открывает «Что нового»: когда
 * заставка ушла и версия отличается от прошлого запуска. Свежей установке
 * (прошлой версии нет) окно не показывается.
 */
export function WhatsNewTrigger() {
  const settled = useBoot((s) => s.settled);
  const updatedFrom = useBoot((s) => s.updatedFrom);
  const openWhatsNew = useUI((s) => s.openWhatsNew);

  useEffect(() => {
    if (!settled || !updatedFrom || !bundledWhatsNew(updatedFrom)) return;
    if (readShown()) return;
    try {
      const record: ShownRecord = { version: __APP_VERSION__, from: updatedFrom, at: Date.now() };
      localStorage.setItem(SHOWN_KEY, JSON.stringify(record));
    } catch {
      // Без хранилища окно просто покажется ещё раз при следующем запуске.
    }
    const timer = window.setTimeout(openWhatsNew, 600);
    return () => window.clearTimeout(timer);
  }, [settled, updatedFrom, openWhatsNew]);

  return null;
}

/** Кнопка «Что нового» в шапке: первые сутки после обновления. */
export function useWhatsNewButton(): boolean {
  const [now, setNow] = useState(() => Date.now());
  // Запись появляется вместе с открытием окна — подписка перечитывает её.
  useUI((s) => s.whatsNewOpen);
  const shown = readShown();
  const expiresAt = shown ? shown.at + BUTTON_TTL_MS : 0;

  useEffect(() => {
    if (expiresAt <= now) return;
    const timer = window.setTimeout(() => setNow(Date.now()), Math.min(expiresAt - now, 2 ** 31 - 1));
    return () => window.clearTimeout(timer);
  }, [expiresAt, now]);

  return expiresAt > now;
}
