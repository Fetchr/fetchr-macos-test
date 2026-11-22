import { useEffect, useRef, type CSSProperties } from "react";
import { ChevronLeft, Minus, Plus } from "lucide-react";

import { cn } from "@/lib/utils";
import styles from "./playback-speed-panel.module.css";

export const SPEED_MIN = 0.25;
export const SPEED_MAX = 4;
export const SPEED_STEP = 0.05;
/** Quick picks, mirroring the ones YouTube surfaces under its speed slider. */
export const SPEED_PRESETS = [0.5, 1, 1.25, 1.5, 2, 3] as const;

export function clampSpeed(value: number): number {
  if (!Number.isFinite(value)) return 1;
  const snapped = Math.round(value / SPEED_STEP) * SPEED_STEP;
  return Number(Math.min(SPEED_MAX, Math.max(SPEED_MIN, snapped)).toFixed(2));
}

export function formatSpeed(value: number): string {
  return `${value.toFixed(2)}x`;
}

/** `1` reads as `1,0` and `1.25` as `1,25`, the way the chips look on YouTube. */
function presetLabel(value: number): string {
  const text = Math.round(value * 100) % 10 === 0 ? value.toFixed(1) : value.toFixed(2);
  return text.replace(".", ",");
}

function speedCaption(value: number): string {
  if (value === 1) return "Обычная";
  return value < 1 ? "Замедленная" : "Ускоренная";
}

interface PlaybackSpeedPanelProps {
  value: number;
  onChange: (value: number) => void;
  /** Renders the back chevron; omit for a panel that is not a sub-menu. */
  onBack?: () => void;
  /** Move focus here on mount, so keyboard users land on the slider. */
  autoFocus?: boolean;
  className?: string;
}

export function PlaybackSpeedPanel({
  value,
  onChange,
  onBack,
  autoFocus,
  className,
}: PlaybackSpeedPanelProps) {
  const sliderRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (autoFocus) {
      sliderRef.current?.focus();
    }
  }, [autoFocus]);

  const fill = ((value - SPEED_MIN) / (SPEED_MAX - SPEED_MIN)) * 100;

  return (
    <div className={cn(styles.panel, className)}>
      <div className={styles.header}>
        {onBack && (
          <button type="button" className={styles.back} onClick={onBack} aria-label="Назад">
            <ChevronLeft className="size-4" />
          </button>
        )}
        <span className={styles.title}>Скорость воспроизведения</span>
      </div>

      <div className={styles.value}>{formatSpeed(value)}</div>

      <div className={styles.sliderRow}>
        <button
          type="button"
          className={styles.step}
          onClick={() => onChange(clampSpeed(value - SPEED_STEP))}
          disabled={value <= SPEED_MIN}
          aria-label="Медленнее"
        >
          <Minus className="size-3.5" />
        </button>
        <input
          ref={sliderRef}
          type="range"
          className={styles.slider}
          min={SPEED_MIN}
          max={SPEED_MAX}
          step={SPEED_STEP}
          value={value}
          onChange={(event) => onChange(clampSpeed(Number(event.target.value)))}
          style={{ "--fill": `${fill}%` } as CSSProperties}
          aria-label="Скорость воспроизведения"
          aria-valuetext={formatSpeed(value)}
        />
        <button
          type="button"
          className={styles.step}
          onClick={() => onChange(clampSpeed(value + SPEED_STEP))}
          disabled={value >= SPEED_MAX}
          aria-label="Быстрее"
        >
          <Plus className="size-3.5" />
        </button>
      </div>

      <div className={styles.presets}>
        {SPEED_PRESETS.map((preset) => (
          <button
            key={preset}
            type="button"
            className={cn(styles.preset, preset === value && styles.presetActive)}
            onClick={() => onChange(preset)}
            aria-pressed={preset === value}
          >
            {presetLabel(preset)}
          </button>
        ))}
      </div>

      <div className={styles.caption}>{speedCaption(value)}</div>
    </div>
  );
}
