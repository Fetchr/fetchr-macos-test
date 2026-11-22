import { ipc } from "@/lib/ipc";

import type { TrackerDiscoveryInput, TrackerDiscoveryMeta } from "./m3u8DiscoveryTypes";

export async function discoverTrackerMetadata(input: TrackerDiscoveryInput): Promise<TrackerDiscoveryMeta> {
  const sourceUrl = input.sourceUrl?.trim();

  if (sourceUrl) {
    const meta = await ipc.twitchTrackerFetch(sourceUrl);
    // URL is the source of truth for identity; stale form values must not win.
    const inputStreamId = input.streamId?.trim() || null;
    const urlChanged = Boolean(meta.stream_id && inputStreamId && meta.stream_id !== inputStreamId);
    return {
      username: meta.username || input.username?.trim() || null,
      streamId: meta.stream_id || inputStreamId,
      // Keep a manually edited time only while it's still the same stream.
      startTime: urlChanged
        ? meta.start_time || null
        : input.startTime?.trim() || meta.start_time || null,
      title: meta.title ?? null,
      thumbnailUrl: meta.thumbnail ?? null,
      candidates: meta.candidates ?? [],
    };
  }

  return {
    username: input.username?.trim() || null,
    streamId: input.streamId?.trim() || null,
    startTime: input.startTime?.trim() || null,
    title: null,
    thumbnailUrl: null,
    candidates: [],
  };
}
