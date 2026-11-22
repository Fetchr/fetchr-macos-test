import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { VpsRecordingMeta } from "@/lib/ipc";

export interface RecordingSelection {
  /** Selected recordings still on screen, in list order. */
  chosen: VpsRecordingMeta[];
  isChosen: (session: string) => boolean;
  /** `range` (Shift) selects everything between the last click and this one. */
  toggle: (session: string, range: boolean) => void;
  selectAll: () => void;
  clear: () => void;
}

function rangeBetween(order: readonly string[], from: string, to: string): string[] {
  const start = order.indexOf(from);
  const end = order.indexOf(to);
  if (start < 0 || end < 0) return [to];
  return order.slice(Math.min(start, end), Math.max(start, end) + 1);
}

function withToggled(current: ReadonlySet<string>, sessions: readonly string[], on: boolean): Set<string> {
  const next = new Set(current);
  sessions.forEach((session) => (on ? next.add(session) : next.delete(session)));
  return next;
}

/** Checkbox selection over the list as shown; vanished rows drop out by themselves. */
export function useRecordingSelection(selectable: readonly VpsRecordingMeta[]): RecordingSelection {
  const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set());
  const anchor = useRef<string | null>(null);
  const order = useMemo(() => selectable.map((recording) => recording.session), [selectable]);
  const orderRef = useRef(order);
  useEffect(() => {
    orderRef.current = order;
  }, [order]);

  const chosen = useMemo(() => selectable.filter((recording) => picked.has(recording.session)), [selectable, picked]);
  const isChosen = useCallback((session: string) => picked.has(session), [picked]);

  const toggle = useCallback((session: string, range: boolean) => {
    // Read before the updater runs: React may call it after the anchor moved.
    const from = anchor.current;
    const sessions = range && from ? rangeBetween(orderRef.current, from, session) : [session];
    setPicked((current) => withToggled(current, sessions, !current.has(session)));
    anchor.current = session;
  }, []);

  const selectAll = useCallback(() => setPicked(new Set(orderRef.current)), []);
  const clear = useCallback(() => {
    anchor.current = null;
    setPicked(new Set());
  }, []);

  return { chosen, isChosen, toggle, selectAll, clear };
}
