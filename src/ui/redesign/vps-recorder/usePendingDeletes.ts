import { useMemo } from "react";

import type { VpsClipMeta, VpsRecordingMeta } from "@/lib/ipc";
import { useVpsRecorderStore } from "@/stores/vpsRecorder";

import { deleteKey, pendingKeys } from "./deleteQueue";

/** Keys (`recording:<session>`, `clip:<id>`) hidden while their delete can still be undone. */
export function usePendingDeleteKeys(): ReadonlySet<string> {
  const pending = useVpsRecorderStore((s) => s.pendingDeletes);
  return useMemo(() => pendingKeys(pending), [pending]);
}

export function useVisibleRecordings(recordings: VpsRecordingMeta[]): VpsRecordingMeta[] {
  const hidden = usePendingDeleteKeys();
  return useMemo(
    () => (hidden.size === 0 ? recordings : recordings.filter((item) => !hidden.has(deleteKey("recording", item.session)))),
    [recordings, hidden],
  );
}

export function useVisibleClips(clips: VpsClipMeta[]): VpsClipMeta[] {
  const hidden = usePendingDeleteKeys();
  return useMemo(
    () => (hidden.size === 0 ? clips : clips.filter((clip) => !hidden.has(deleteKey("clip", clip.id)))),
    [clips, hidden],
  );
}
