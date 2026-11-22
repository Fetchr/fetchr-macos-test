import { useEffect, useMemo, useState } from "react";

import { ipc } from "@/lib/ipc";

import { EQ_BAR_COUNT, WAVE_BINS } from "../constants";

/**
 * Полоски волны для шкалы плеера и экрана анализа: стабильные между рендерами.
 * Настоящая волна исходника из ffmpeg. Пока она считается, столбики
 * ровные и низкие: лучше пустая шкала, чем выдуманная форма звука.
 */
export type WaveStatus = "idle" | "loading" | "ready" | "error";

export function useWaveform(filePath: string, binariesDir: string | null) {
  const [wavePeaks, setWavePeaks] = useState<number[] | null>(null);
  const [waveStatus, setWaveStatus] = useState<WaveStatus>("idle");
  useEffect(() => {
    if (!filePath) {
      setWavePeaks(null);
      setWaveStatus("idle");
      return;
    }
    let stale = false;
    setWavePeaks(null);
    setWaveStatus("loading");
    ipc
      .audioWaveformPeaks(filePath, WAVE_BINS, binariesDir)
      .then((peaks) => {
        if (stale) return;
        setWavePeaks(peaks);
        // Пустая волна (тишина/нет дорожки) — не ошибка: просто ровная шкала без подписи.
        setWaveStatus("ready");
      })
      .catch((err) => {
        if (stale) return;
        console.error("Waveform peaks failed:", err);
        setWavePeaks(null);
        setWaveStatus("error");
      });
    return () => {
      stale = true;
    };
  }, [filePath, binariesDir]);

  const waveBars = useMemo(
    () => (wavePeaks && wavePeaks.length > 0 ? wavePeaks.map((v) => 0.06 + 0.94 * v) : Array.from({ length: WAVE_BINS }, () => 0.08)),
    [wavePeaks],
  );
  /** Та же волна, сжатая до числа ячеек «шоу удаления». */
  const showBars = useMemo(
    () =>
      Array.from({ length: EQ_BAR_COUNT }, (_, i) => {
        const from = Math.floor((i / EQ_BAR_COUNT) * waveBars.length);
        const to = Math.max(from + 1, Math.floor(((i + 1) / EQ_BAR_COUNT) * waveBars.length));
        return Math.max(...waveBars.slice(from, to));
      }),
    [waveBars],
  );

  return { waveBars, showBars, waveStatus };
}
