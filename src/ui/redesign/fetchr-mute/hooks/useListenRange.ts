import { useCallback, useEffect, useRef } from "react";

/** Запас вокруг места при «Прослушать ±3 с». */
export const LISTEN_PAD_S = 3;
/** Насколько своя перемотка может разойтись с целью и не считаться чужой. */
const OWN_SEEK_TOLERANCE_S = 0.3;

interface ListenWindow {
  from: number;
  until: number;
}

/**
 * «Прослушать ±3 с»: перемотать на start − 3 с, играть и встать на паузу на
 * end + 3 с. Перемотка или пауза пользователем отменяет автопаузу.
 */
export function useListenRange(
  mediaEl: HTMLMediaElement | null,
  seekAndPlay: (time: number) => void,
) {
  const windowRef = useRef<ListenWindow | null>(null);

  useEffect(() => {
    if (!mediaEl) return;
    const onTimeUpdate = () => {
      const active = windowRef.current;
      if (!active || mediaEl.currentTime < active.until) return;
      windowRef.current = null;
      mediaEl.pause();
    };
    const onPause = () => {
      windowRef.current = null;
    };
    const onSeeking = () => {
      const active = windowRef.current;
      if (active && Math.abs(mediaEl.currentTime - active.from) > OWN_SEEK_TOLERANCE_S) {
        windowRef.current = null;
      }
    };
    mediaEl.addEventListener("timeupdate", onTimeUpdate);
    mediaEl.addEventListener("pause", onPause);
    mediaEl.addEventListener("seeking", onSeeking);
    return () => {
      mediaEl.removeEventListener("timeupdate", onTimeUpdate);
      mediaEl.removeEventListener("pause", onPause);
      mediaEl.removeEventListener("seeking", onSeeking);
    };
  }, [mediaEl]);

  return useCallback(
    (start: number, end: number) => {
      const from = Math.max(0, start - LISTEN_PAD_S);
      windowRef.current = { from, until: end + LISTEN_PAD_S };
      seekAndPlay(from);
    },
    [seekAndPlay],
  );
}
