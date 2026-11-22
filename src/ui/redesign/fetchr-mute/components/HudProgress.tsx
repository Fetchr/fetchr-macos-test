import React from "react";

import { cn } from "@/lib/utils";
import { RedesignIcon } from "@/ui/redesign/icons/iconMap";

import styles from "./AnalysisHud.module.css";
import { useSmoothNumber } from "../hooks/useSmoothNumber";
import type { AnalysisStep } from "../types";

interface HudProgressProps {
  target: number;
  steps: AnalysisStep[];
  label: string;
  valueText: string;
  /** Аудио: вместо дорожки этапов волна, которая проявляется по ходу анализа. */
  wave?: number[];
}

/**
 * Проценты и полоса HUD. Плавность крутится здесь, а не в странице: каждый
 * rAF-кадр перерисовывает только этот узел, а не всю страницу на 3000 строк
 * (раньше — до 60 полных рендеров в секунду во время обработки).
 */
export const HudProgress = React.memo(function HudProgress({
  target,
  steps,
  label,
  valueText,
  wave,
}: HudProgressProps) {
  const value = useSmoothNumber(target);
  const rounded = Math.round(value);
  if (wave) {
    return (
      <HudWaveProgress
        value={value}
        rounded={rounded}
        steps={steps}
        label={label}
        valueText={valueText}
        wave={wave}
      />
    );
  }
  return (
    <HudLaneProgress
      value={value}
      rounded={rounded}
      steps={steps}
      label={label}
      valueText={valueText}
    />
  );
});

interface ProgressViewProps {
  value: number;
  rounded: number;
  steps: AnalysisStep[];
  label: string;
  valueText: string;
}

function HudPercent({ rounded }: { rounded: number }) {
  return (
    <span className={styles.hudPercent}>
      {rounded}
      <small>%</small>
    </span>
  );
}

function HudWaveProgress({
  value,
  rounded,
  steps,
  label,
  valueText,
  wave,
}: ProgressViewProps & { wave: number[] }) {
  const reached = value / 100;
  return (
    <>
      <HudPercent rounded={rounded} />
      <div
        className={styles.hudWave}
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={rounded}
        aria-valuetext={valueText}
      >
        {wave.map((height, index) => (
          <i
            key={index}
            className={index / wave.length < reached ? styles.hudWaveOn : undefined}
            style={{ height: `${Math.round(height * 100)}%` }}
          />
        ))}
        <span className={styles.hudWaveHead} style={{ left: `${Math.min(100, value)}%` }} />
      </div>
      <span className={styles.hudStage}>
        {steps.map((step) => (
          <span key={step.label} className={cn(step.done && styles.hudStageDone, step.active && styles.hudStageActive)}>
            {step.done && <RedesignIcon name="check" className="size-3" strokeWidth={3} />}
            {step.label}
          </span>
        ))}
      </span>
    </>
  );
}

function HudLaneProgress({ value, rounded, steps, label, valueText }: ProgressViewProps) {
  return (
    <>
      <HudPercent rounded={rounded} />
      <div
        className={styles.hudLane}
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={rounded}
        aria-valuetext={valueText}
      >
        {steps.map((step, index) => {
          const from = index === 0 ? 0 : steps[index - 1].at;
          const fill = step.done ? 1 : step.active ? Math.max(0, Math.min(1, (value - from) / Math.max(1, step.at - from))) : 0;
          return (
            <span
              key={step.label}
              title={step.label}
              className={cn(styles.hudSeg, step.done && styles.hudSegDone, step.active && styles.hudSegActive)}
              style={{ flexGrow: Math.max(4, step.at - from) }}
            >
              <i style={{ transform: `scaleX(${fill})` }} />
            </span>
          );
        })}
      </div>
      <span className={styles.hudSteps}>
        {steps.map((step) => (
          <span key={step.label} className={cn(step.done && styles.hudStepsDone, step.active && styles.hudStepsActive)}>
            {step.label}
          </span>
        ))}
      </span>
    </>
  );
}
