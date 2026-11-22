import { useEffect, useState } from "react";

import { ipc, type VpsChatMessage } from "@/lib/ipc";
import { useSettings } from "@/stores/settings";
import type { ProxyConfig } from "@/types/job";

import { friendlyVpsError } from "./vpsErrors";

/** A whole broadcast's chat is tens of thousands of lines: keep only a few. */
const MAX_ENTRIES = 4;
/** A session still recording keeps adding lines; reuse its chat only briefly. */
const LIVE_MAX_AGE_MS = 30_000;

interface Entry {
  key: string;
  at: number;
  promise: Promise<VpsChatMessage[]>;
}

// Newest last. Shared by the chat panel and the timeline heatmap, so one
// recording's chat is fetched once rather than once per consumer.
let entries: readonly Entry[] = [];

function cacheKey(session: string, channel: string | null, proxy: ProxyConfig | null): string {
  return JSON.stringify([session, channel, proxy]);
}

function loadChat(
  session: string,
  channel: string | null,
  proxy: ProxyConfig | null,
  live: boolean,
): Promise<VpsChatMessage[]> {
  const key = cacheKey(session, channel, proxy);
  const maxAge = live ? LIVE_MAX_AGE_MS : Number.POSITIVE_INFINITY;
  const cached = entries.find((entry) => entry.key === key && Date.now() - entry.at < maxAge);
  if (cached) {
    entries = [...entries.filter((entry) => entry !== cached), cached];
    return cached.promise;
  }
  const promise = ipc.vpsRecordingChat(session, channel, proxy);
  const entry: Entry = { key, at: Date.now(), promise };
  entries = [...entries.filter((item) => item.key !== key), entry].slice(-MAX_ENTRIES);
  // A failed load must not stick: the next attempt asks the server again.
  promise.catch(() => {
    entries = entries.filter((item) => item !== entry);
  });
  return promise;
}

export interface RecordingChatState {
  messages: VpsChatMessage[] | null;
  error: string | null;
  retry: () => void;
}

/** Chat of one recording, loaded once and cached; `enabled: false` skips the request. */
export function useRecordingChat(
  session: string,
  channel: string | null,
  { enabled = true, live = false }: { enabled?: boolean; live?: boolean } = {},
): RecordingChatState {
  const proxy = useSettings((state) => state.proxy);
  const [messages, setMessages] = useState<VpsChatMessage[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    setMessages(null);
    setError(null);
    loadChat(session, channel, proxy, live)
      .then((loaded) => {
        if (!cancelled) setMessages(loaded);
      })
      .catch((err) => {
        if (!cancelled) setError(friendlyVpsError(err).message);
      });
    return () => {
      cancelled = true;
    };
  }, [session, channel, proxy, live, enabled, attempt]);

  return { messages, error, retry: () => setAttempt((value) => value + 1) };
}
