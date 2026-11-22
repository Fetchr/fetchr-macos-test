import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";

import type { HlsPlayerHandle } from "@/components/hls-player";
import { ipc, type VpsRecordingMeta } from "@/lib/ipc";
import { useVpsRecorderStore } from "@/stores/vpsRecorder";

import { fmtDuration } from "./format";
import { sessionToPlayer } from "./playerTimeline";
import { friendlyVpsError } from "./vpsErrors";

/** The agent has no playlist until the first segment closes — a few seconds
 *  into a fresh recording, not a failure worth a red box. */
const PENDING_PLAYLIST = /409|first segment/i;
const MEDIA_GONE = /410|no longer available/i;

export type PreviewState = "loading" | "ready" | "pending" | "gone" | "error";

/** Playlist URL of a recording, with a quiet retry while the first segment is still being written. */
export function usePreview(recording: VpsRecordingMeta) {
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewState, setPreviewState] = useState<PreviewState>("loading");
  const [previewError, setPreviewError] = useState<string | null>(null);
  // Where the loaded playlist begins on the session timeline, frozen when it
  // loads. `recording.available_start` keeps moving as rotation frees old
  // segments, while the player still counts from the playlist it opened —
  // reading the live value shifted every cut by however much was rotated away.
  // Only a fallback: a stamped playlist maps exactly (see playerTimeline).
  const originRef = useRef(recording.available_start);

  const openPreview = useCallback(async () => {
    if (!recording.available) {
      setPreviewUrl(null);
      setPreviewState("gone");
      return;
    }
    setPreviewState("loading");
    try {
      const url = await ipc.vpsRecordingPreviewUrl(recording.session);
      originRef.current =
        useVpsRecorderStore.getState().recordings.find((item) => item.session === recording.session)?.available_start ??
        recording.available_start;
      setPreviewUrl(url);
      setPreviewState("ready");
    } catch (error) {
      const message = String(error);
      setPreviewUrl(null);
      setPreviewError(friendlyVpsError(error).message);
      setPreviewState(PENDING_PLAYLIST.test(message) ? "pending" : MEDIA_GONE.test(message) ? "gone" : "error");
    }
  }, [recording.available, recording.session]);

  useEffect(() => {
    void openPreview();
  }, [openPreview]);

  // A recording that just started has no playable segment yet; retry quietly
  // instead of leaving the user on an error they cannot act on.
  useEffect(() => {
    if (previewState !== "pending") return;
    const timer = window.setTimeout(() => void openPreview(), 4000);
    return () => window.clearTimeout(timer);
  }, [previewState, openPreview]);

  return { previewUrl, previewState, previewError, originRef, openPreview };
}

/**
 * Dragging the timeline emits a position on every pointer move. The marker
 * follows instantly, but the player is seeked at most ~8 times a second —
 * an HLS source cannot keep up with a raw drag and stalls if you try.
 */
export function useThrottledSeek(
  playerRef: MutableRefObject<HlsPlayerHandle | null>,
  originRef: MutableRefObject<number>,
  startedAt: number,
  setPlayhead: (seconds: number) => void,
) {
  const seekTimer = useRef<number | null>(null);
  const pendingSeek = useRef<number | null>(null);
  const lastSeekAt = useRef(0);

  const flush = useCallback(
    (target: number) => {
      lastSeekAt.current = Date.now();
      pendingSeek.current = null;
      seekTimer.current = null;
      playerRef.current?.seek(target);
    },
    [playerRef],
  );

  const seek = useCallback(
    (seconds: number) => {
      setPlayhead(seconds);
      const target =
        sessionToPlayer(seconds, playerRef.current?.getFragments?.() ?? [], startedAt) ??
        Math.max(0, seconds - originRef.current);
      const elapsed = Date.now() - lastSeekAt.current;
      if (elapsed >= 120) {
        flush(target);
        return;
      }
      pendingSeek.current = target;
      if (seekTimer.current != null) return;
      seekTimer.current = window.setTimeout(() => {
        const value = pendingSeek.current;
        seekTimer.current = null;
        if (value != null) flush(value);
      }, 120 - elapsed);
    },
    [flush, originRef, playerRef, setPlayhead, startedAt],
  );

  useEffect(
    () => () => {
      if (seekTimer.current != null) window.clearTimeout(seekTimer.current);
    },
    [],
  );

  /** While a scrub is in flight the player still reports the old position. */
  const scrubbing = useCallback(() => pendingSeek.current != null || Date.now() - lastSeekAt.current < 400, []);

  return { seek, scrubbing };
}

const isTyping = (target: EventTarget | null) => {
  const element = target as HTMLElement | null;
  const tag = element?.tagName?.toLowerCase();
  return tag === "input" || tag === "textarea" || tag === "select" || Boolean(element?.isContentEditable);
};

/**
 * I / O set the clip range, M drops a marker — the whole point of watching
 * here rather than downloading first. Listened in the capture phase and
 * stopped there: the player's own M (mute) would otherwise fire as well.
 */
export function useClipHotkeys(options: {
  session: string;
  currentTime: () => number;
  onRangeStart: (value: string) => void;
  onRangeEnd: (value: string) => void;
  onMarker: (session: string, seconds: number) => void;
}) {
  const { session, currentTime, onRangeStart, onRangeEnd, onMarker } = options;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.repeat || event.ctrlKey || event.metaKey || event.altKey) return;
      if (isTyping(event.target)) return;
      // An open confirmation (e.g. «Освободить место») owns the keyboard: M must
      // not drop a marker behind it.
      if (document.querySelector('[aria-modal="true"]')) return;
      const key = event.key.toLowerCase();
      if (key === "i" || key === "ш") onRangeStart(fmtDuration(currentTime()));
      else if (key === "o" || key === "щ") onRangeEnd(fmtDuration(currentTime()));
      else if (key === "m" || key === "ь") onMarker(session, currentTime());
      else return;
      event.preventDefault();
      event.stopPropagation();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [currentTime, session, onMarker, onRangeStart, onRangeEnd]);
}
