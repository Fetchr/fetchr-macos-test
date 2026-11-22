import { useEffect, useRef, useState } from "react";

import { ipc } from "@/lib/ipc";

import styles from "./RecordingTimeline.module.css";

interface WaveformProps {
  session: string;
  /** Visible window on the session timeline. */
  start: number;
  end: number;
}

/** Roughly one bar per two device pixels — finer than that is invisible. */
const BINS_PER_PX = 0.5;
const MAX_BINS = 2000;

/**
 * Mirrored loudness envelope behind the timeline, the way a video editor
 * draws an audio track: silence, speech and shouting are distinguishable at a
 * glance, which is how you find the moment worth clipping in a long stream.
 *
 * Peaks come precomputed from the server, so redrawing on every zoom step
 * costs one small request rather than decoding hours of audio.
 */
export function Waveform({ session, start, end }: WaveformProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [values, setValues] = useState<number[]>([]);
  const [span, setSpan] = useState<{ start: number; end: number } | null>(null);
  const requestRef = useRef(0);
  // Canvas pixels follow the lane: without this a resized window or a DPI
  // change kept the old bitmap, stretched or cut off.
  const [size, setSize] = useState(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setSize(canvas.clientWidth * (window.devicePixelRatio || 1)));
    observer.observe(canvas);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (end <= start) return;
    const width = canvasRef.current?.clientWidth ?? 800;
    const bins = Math.max(64, Math.min(MAX_BINS, Math.round(width * BINS_PER_PX)));
    const seq = ++requestRef.current;
    // Zooming fires a burst of view changes; only the last one is worth asking
    // the server about.
    const timer = window.setTimeout(() => {
      void ipc
        .vpsRecordingPeaks(session, start, end, bins)
        .then((peaks) => {
          if (seq !== requestRef.current) return;
          setValues(peaks.values ?? []);
          setSpan({ start: peaks.start, end: peaks.end });
        })
        .catch(() => {
          if (seq === requestRef.current) setValues([]);
        });
    }, 180);
    return () => window.clearTimeout(timer);
  }, [session, start, end]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ratio = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.round(canvas.clientWidth * ratio));
    const height = Math.max(1, Math.round(canvas.clientHeight * ratio));
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, width, height);
    if (values.length === 0 || !span) return;

    // The server answers for the range it actually has; if rotation cut the
    // window short, draw the answer where it belongs instead of stretching it.
    const visible = end - start;
    const left = ((span.start - start) / visible) * width;
    const right = ((span.end - start) / visible) * width;
    const drawWidth = Math.max(1, right - left);
    // Leave the overview band along the top clear of the waveform.
    const topInset = 13 * ratio;
    const mid = topInset + (height - topInset) / 2;
    const barWidth = drawWidth / values.length;

    ctx.fillStyle = "rgba(90, 160, 255, 0.55)";
    for (let i = 0; i < values.length; i += 1) {
      // Stored peaks are linear amplitude. Drawn linearly, ordinary speech —
      // which sits well below full scale — collapses into a flat line, so lift
      // the quiet end with a mild curve while leaving loud parts alone.
      const amplitude = Math.pow(values[i] / 255, 0.6) * ((height - topInset) / 2);
      const x = left + i * barWidth;
      ctx.fillRect(x, mid - amplitude, Math.max(0.6, barWidth * 0.9), amplitude * 2);
    }
    ctx.strokeStyle = "rgba(140, 195, 255, 0.5)";
    ctx.lineWidth = Math.max(1, ratio * 0.5);
    ctx.beginPath();
    ctx.moveTo(left, mid);
    ctx.lineTo(right, mid);
    ctx.stroke();
  }, [values, span, start, end, size]);

  return <canvas ref={canvasRef} className={styles.waveform} aria-hidden="true" />;
}
