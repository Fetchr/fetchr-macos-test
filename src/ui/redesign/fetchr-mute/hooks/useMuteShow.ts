import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type React from "react";

import type { MuteSpan } from "@/types/job";

import {
  MUTE_SHOW_FAST_MS,
  MUTE_SHOW_MS,
  MUTE_SUMMARY_HOLD_MS,
} from "../constants";
import type { FetchrMuteStore } from "../types";

interface MuteShowOptions {
  store: FetchrMuteStore;
  mediaRef: React.MutableRefObject<HTMLMediaElement | null>;
  duration: number;
  setCurrentTime: (time: number) => void;
  /** Метки шкалы вне «шоу»: заглушённое с учётом неприменённых правок. */
  reviewSpans: MuteSpan[];
}

/** «Шоу удаления матов» после обработки и его фолбэк при ошибке плеера. */
export function useMuteShow({
  store,
  mediaRef,
  duration,
  setCurrentTime,
  reviewSpans,
}: MuteShowOptions) {
  const {
    isMutingAnimation,
    spans,
    pendingOutputPath,
    mediaError,
    currentScanTime,
    setIsMutingAnimation,
    setProcessing,
    setOutputPath,
    setScanProgress,
    setCurrentScanTime,
    setMediaError,
  } = store;
  const scanIntervalRef = useRef<number | null>(null);
  // Финальная карточка-итог в конце «шоу удаления»
  const [muteSummary, setMuteSummary] = useState<boolean>(false);
  const summaryTimeoutRef = useRef<number | null>(null);
  // Завершение текущего показа — его зовёт и «пропустить».
  const finishRef = useRef<(() => void) | null>(null);

  const stopTimers = () => {
    if (scanIntervalRef.current) {
      cancelAnimationFrame(scanIntervalRef.current);
      scanIntervalRef.current = null;
    }
    if (summaryTimeoutRef.current) {
      window.clearTimeout(summaryTimeoutRef.current);
      summaryTimeoutRef.current = null;
    }
  };

  // «Шоу удаления матов»: плейхед проезжает файл, каждый мат подсвечивается
  // чипом и плавно гасится; в конце — карточка-итог, затем переключение на результат.
  useEffect(() => {
    if (isMutingAnimation && duration > 0 && mediaRef.current) {
      const spanCount = spans?.length ?? 0;
      const scanDurationMs = spanCount > 0 ? MUTE_SHOW_MS : MUTE_SHOW_FAST_MS;
      const startTime = performance.now();
      let lastSeekTime = 0;
      const seekThrottleMs = 150; // seek at most once every 150ms to keep video player decoding smoothly

      const wasMuted = mediaRef.current.muted;
      mediaRef.current.muted = true; // ensure preview is muted during scan
      setMuteSummary(false);

      const finish = () => {
        finishRef.current = null;
        stopTimers();
        setMuteSummary(false);
        setIsMutingAnimation(false);
        setProcessing(false);
        // Set the final censored outputPath now so the player switches to the censored version
        setOutputPath(pendingOutputPath);
        // Seek back to start and restore mute state
        if (mediaRef.current) {
          mediaRef.current.currentTime = 0;
          setCurrentTime(0);
          mediaRef.current.muted = wasMuted;
        }
      };

      const updateScan = () => {
        const elapsed = performance.now() - startTime;
        // easeInOutSine — плейхед мягко разгоняется и тормозит
        const linear = Math.min(elapsed / scanDurationMs, 1);
        const pct = 0.5 - 0.5 * Math.cos(Math.PI * linear);

        setScanProgress(pct * 100);

        const targetTime = pct * duration;
        setCurrentScanTime(targetTime);
        setCurrentTime(targetTime);

        const now = performance.now();
        if (
          mediaRef.current &&
          (now - lastSeekTime >= seekThrottleMs || linear === 1)
        ) {
          mediaRef.current.currentTime = targetTime;
          lastSeekTime = now;
        }

        if (linear < 1) {
          scanIntervalRef.current = requestAnimationFrame(updateScan);
        } else if (spanCount > 0) {
          // Держим карточку-итог, затем плавно отдаём результат
          setMuteSummary(true);
          summaryTimeoutRef.current = window.setTimeout(
            finish,
            MUTE_SUMMARY_HOLD_MS,
          );
        } else {
          finish();
        }
      };

      finishRef.current = finish;
      scanIntervalRef.current = requestAnimationFrame(updateScan);
    }

    return () => {
      finishRef.current = null;
      stopTimers();
    };
  }, [isMutingAnimation, duration, pendingOutputPath, spans]);

  /** Пропустить показ: сразу отдать результат. */
  const skip = useCallback(() => {
    finishRef.current?.();
  }, []);

  // Плеер не смог открыть исходник (MKV/DTS и т.п.): duration навсегда 0,
  // анимация не запустится и finish() не вызовется — без этого фолбэка
  // processing зависает навсегда, а готовый файл не отдаётся.
  useEffect(() => {
    if (isMutingAnimation && mediaError) {
      setMuteSummary(false);
      setIsMutingAnimation(false);
      setProcessing(false);
      setOutputPath(pendingOutputPath);
      // Retry with the processed output: the original container/audio codec
      // may be unsupported while the newly rendered AAC result is playable.
      setMediaError(null);
    }
  }, [isMutingAnimation, mediaError, pendingOutputPath]);

  // Active profane span during scanning (process of muting)
  const activeProfaneSpan = useMemo(() => {
    if (!spans || duration === 0 || !isMutingAnimation) return null;

    // Чип слова должен жить ~1.1с реального времени: доля от MUTE_SHOW_MS.
    const displayWindow = (1100 / MUTE_SHOW_MS) * duration;

    // Filter spans that the playhead has crossed and are within the window
    const candidates = spans.filter(
      (s) =>
        currentScanTime >= s.start &&
        currentScanTime <= s.start + displayWindow,
    );

    if (candidates.length === 0) return null;

    // Return the one closest to currentScanTime (the most recently crossed one)
    return candidates.reduce((prev, curr) =>
      currentScanTime - curr.start < currentScanTime - prev.start ? curr : prev,
    );
  }, [spans, currentScanTime, duration, isMutingAnimation]);

  // Spans filtered by the scanning playhead to appear one-by-one
  const visibleSpans = useMemo(() => {
    if (!isMutingAnimation) return reviewSpans;
    if (!spans) return [];
    return spans.filter((s) => s.start <= currentScanTime);
  }, [spans, reviewSpans, isMutingAnimation, currentScanTime]);

  return { muteSummary, activeProfaneSpan, visibleSpans, skip };
}
