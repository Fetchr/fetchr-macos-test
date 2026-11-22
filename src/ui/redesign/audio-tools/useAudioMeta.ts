import { useEffect, useState } from "react";

import { ipc, type TrackArtwork } from "@/lib/ipc";
import { useSettings } from "@/stores/settings";

const peaksCache = new Map<string, number[]>();
const artworkCache = new Map<string, TrackArtwork | null>();

/** Настоящая волна файла из ffmpeg. Пока считается — null, без выдуманной формы. */
export function useAudioPeaks(path: string | null | undefined, bins = 160): number[] | null {
  const binariesDir = useSettings((s) => s.binariesDir);
  const key = path ? `${path}|${bins}` : "";
  const [peaks, setPeaks] = useState<number[] | null>(() => (key ? (peaksCache.get(key) ?? null) : null));

  useEffect(() => {
    if (!path) {
      setPeaks(null);
      return;
    }
    const cached = peaksCache.get(key);
    if (cached) {
      setPeaks(cached);
      return;
    }
    let stale = false;
    setPeaks(null);
    ipc
      .audioWaveformPeaks(path, bins, binariesDir)
      .then((value) => {
        peaksCache.set(key, value);
        if (!stale) setPeaks(value);
      })
      .catch(() => {
        if (!stale) setPeaks(null);
      });
    return () => {
      stale = true;
    };
  }, [path, bins, key, binariesDir]);

  return peaks;
}

/** Обложка и сведения о треке по названию; результат кэшируется на сессию. */
export function useTrackArtwork(title: string | null | undefined): TrackArtwork | null {
  const query = title?.trim() ?? "";
  const [artwork, setArtwork] = useState<TrackArtwork | null>(() => (query ? (artworkCache.get(query) ?? null) : null));

  useEffect(() => {
    if (!query) {
      setArtwork(null);
      return;
    }
    if (artworkCache.has(query)) {
      setArtwork(artworkCache.get(query) ?? null);
      return;
    }
    let stale = false;
    ipc
      .lookupTrackArtwork(query)
      .then((value) => {
        artworkCache.set(query, value);
        if (!stale) setArtwork(value);
      })
      .catch(() => {
        if (!stale) setArtwork(null);
      });
    return () => {
      stale = true;
    };
  }, [query]);

  return artwork;
}
