import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";

import { cn } from "@/lib/utils";

import shared from "../shared.module.css";
import styles from "./AnalysisHud.module.css";
import { ANALYSIS_STEP_DEFS, type AnalysisStepId } from "../constants";
import { formatStopwatch } from "../timecode";
import type { AnalysisStep } from "../types";
import { HudProgress } from "./HudProgress";

function analysisStepLabels(t: TFunction): Record<AnalysisStepId, string> {
  return {
    models: t("fetchr_mute.step_prepare_models"),
    audio: t("fetchr_mute.step_prepare_audio"),
    speech: t("fetchr_mute.step_recognize_speech"),
    render: t("fetchr_mute.step_mute_and_save"),
  };
}

// Префикс «Этап N из M · » в сообщениях бэкенда: этап и так виден в шапке HUD.
const BACKEND_STEP_PREFIX = /^\S+ \d+ \S+ \d+ · /u;

// Фазы анализа для кинематографичного HUD: первый незавершённый этап — текущий.
function buildAnalysisSteps(progressPercent: number, t: TFunction): AnalysisStep[] {
  const labels = analysisStepLabels(t);
  const activeIndex = ANALYSIS_STEP_DEFS.findIndex((d) => !(progressPercent >= d.at));
  return ANALYSIS_STEP_DEFS.map((d, index) => ({
    label: labels[d.id],
    at: d.at,
    done: progressPercent >= d.at,
    active: index === activeIndex,
  }));
}

interface AnalysisHudProps {
  isVideo: boolean;
  progressPercent: number;
  progressMessage: string;
  processingElapsed: number;
  waveBars: number[];
  onCancel: () => void;
}

/** Экран анализа поверх кадра плеера, пока идёт обработка. */
export function AnalysisHud({
  isVideo,
  progressPercent,
  progressMessage,
  processingElapsed,
  waveBars,
  onCancel,
}: AnalysisHudProps) {
  const { t } = useTranslation();
  const analysisSteps = useMemo(
    () => buildAnalysisSteps(progressPercent, t),
    [progressPercent, t],
  );
  const activeAnalysisStep = analysisSteps.findIndex((step) => step.active);
  const totalSteps = analysisSteps.length;
  const currentAnalysisStep =
    activeAnalysisStep >= 0 ? activeAnalysisStep + 1 : totalSteps;
  const continuing = t("fetchr_mute.hud_processing_continues");
  // Отмена теряет весь прогресс распознавания — сначала переспрашиваем.
  const [confirmCancel, setConfirmCancel] = useState(false);

  return (
    <div className={styles.hud} data-stage-card="">
      <div className={styles.hudCard}>
        <span className={styles.hudState}>
          <span className={shared.hudDot} aria-hidden="true" />
          {isVideo
            ? t("fetchr_mute.hud_analyzing_video")
            : t("fetchr_mute.hud_analyzing_audio")}
          <span className={styles.hudStepCount}>
            {t("fetchr_mute.hud_step_of", {
              current: currentAnalysisStep,
              total: totalSteps,
            })}
          </span>
          <span className={styles.hudClock}>
            {formatStopwatch(processingElapsed)}
          </span>
        </span>
        <HudProgress
          target={Math.min(progressPercent, 100)}
          steps={analysisSteps}
          wave={isVideo ? undefined : waveBars}
          label={t("fetchr_mute.progress_udaleniya_matov")}
          valueText={progressMessage || continuing}
        />
        <span className={styles.hudFooter}>
          <span className={styles.hudMessage}>
            {progressMessage
              ? progressMessage.replace(BACKEND_STEP_PREFIX, "")
              : `${continuing}…`}
          </span>
          {!confirmCancel && (
            <button
              type="button"
              className={shared.ghostButton}
              onClick={() => setConfirmCancel(true)}
            >
              {t("fetchr_mute.cancel")}
            </button>
          )}
        </span>
        {confirmCancel && (
          <span className={styles.hudConfirm} role="alertdialog" aria-label={t("fetchr_mute.hud_cancel_confirm")}>
            <span className={styles.hudConfirmText}>{t("fetchr_mute.hud_cancel_confirm")}</span>
            <button
              type="button"
              className={shared.ghostButton}
              onClick={() => setConfirmCancel(false)}
            >
              {t("fetchr_mute.hud_cancel_keep")}
            </button>
            <button
              type="button"
              className={cn(shared.ghostButton, shared.ghostDanger)}
              onClick={onCancel}
            >
              {t("fetchr_mute.hud_cancel_stop")}
            </button>
          </span>
        )}
      </div>
    </div>
  );
}
