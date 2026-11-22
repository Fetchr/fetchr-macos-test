import { invoke } from "@tauri-apps/api/core";
import { useSyncExternalStore } from "react";

type AvatarMap = Readonly<Record<string, string | null>>;

const STORAGE_KEY = "fetchr.vps.channelAvatars.v1";
const BATCH_DELAY_MS = 30;

function readStored(): AvatarMap {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    if (!parsed || typeof parsed !== "object") return {};
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).filter(
        ([, url]) => typeof url === "string" && url.startsWith("https://"),
      ),
    ) as AvatarMap;
  } catch {
    return {};
  }
}

let avatars: AvatarMap = readStored();
const requested = new Set<string>(Object.keys(avatars));
const listeners = new Set<() => void>();
let pending: ReadonlySet<string> = new Set();
let timer: ReturnType<typeof setTimeout> | null = null;

function publish(next: AvatarMap) {
  avatars = next;
  try {
    const found = Object.fromEntries(Object.entries(next).filter(([, url]) => url));
    localStorage.setItem(STORAGE_KEY, JSON.stringify(found));
  } catch {
    // storage is a convenience; avatars still show for this session
  }
  listeners.forEach((listener) => listener());
}

async function flush() {
  timer = null;
  const channels = [...pending];
  pending = new Set();
  if (channels.length === 0) return;
  try {
    const result = await invoke<Record<string, string | null>>("channel_avatars", { channels });
    publish({ ...avatars, ...result });
  } catch {
    channels.forEach((channel) => requested.delete(channel));
  }
}

function request(channel: string) {
  if (!channel || requested.has(channel)) return;
  requested.add(channel);
  pending = new Set([...pending, channel]);
  if (!timer) timer = setTimeout(() => void flush(), BATCH_DELAY_MS);
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Profile picture URL for a channel, or null while unknown or missing. */
export function useChannelAvatar(channel: string): string | null {
  request(channel);
  return useSyncExternalStore(subscribe, () => avatars[channel] ?? null);
}
