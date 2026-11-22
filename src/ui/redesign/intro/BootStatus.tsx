import { useLayoutEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";

import { cn } from "@/lib/utils";
import { useBoot, type BootTaskState } from "@/stores/boot";
import { useUpdater } from "@/stores/updater";
import { RedesignIcon } from "@/ui/redesign/icons/iconMap";
import { gsap } from "@/ui/redesign/theme/gsapSetup";

import styles from "./BootStatus.module.css";
import { describeStatus } from "./bootStatusView";

type ChipState = "pending" | "ok" | "warn";

/**
 * Рейка под логотипом: проверки лицензии и обновлений, затем загрузка и
 * установка обновления — процент, этап и скорость, как в лаунчере.
 */
export function BootStatus() {
  const { t, i18n } = useTranslation();
  const boot = useBoot(
    useShallow((s) => ({
      phase: s.phase,
      unlocked: s.unlocked,
      licenseTask: s.licenseTask,
      updateTask: s.updateTask,
      licenseActive: s.license?.state === "active",
      updatedFrom: s.updatedFrom,
      startUpdate: s.startUpdate,
      leaveUpdate: s.leaveUpdate,
    })),
  );
  const update = useUpdater(
    useShallow((s) => ({
      stage: s.stage,
      version: s.status?.version ?? null,
      received: s.received,
      total: s.total,
      bytesPerSecond: s.bytesPerSecond,
      installError: s.installError,
      cancelling: s.cancelling,
      cancel: s.cancel,
    })),
  );

  const view = describeStatus({ ...boot, ...update }, t, i18n.language);
  const percent = view.progress === null ? undefined : Math.round(view.progress * 100);
  const fillRef = useRef<HTMLDivElement>(null);

  // Тики загрузки приходят несколько раз в секунду: заливка догоняет
  // каждый новый процент, а не прыгает на него.
  useLayoutEffect(() => {
    const fill = fillRef.current;
    if (!fill) return;
    const tween = gsap.to(fill, {
      "--progress": (percent ?? 0) / 100,
      duration: 0.45,
      ease: "power3.out",
      overwrite: true,
    });
    return () => {
      tween.kill();
    };
  }, [percent, view.track]);

  const title = view.version ? `${view.label} ${view.version}` : view.label;

  return (
    <div className={styles.status} data-intro-part="status" data-tone={view.tone}>
      <div
        key={view.track}
        className={styles.rail}
        data-busy={view.busy || undefined}
        role="progressbar"
        aria-label={title}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
      >
        <div ref={fillRef} className={styles.fill} />
      </div>

      <div className={styles.row} aria-live="polite">
        <span className={styles.edge}>{view.start}</span>
        <span className={styles.label}>
          {view.label}
          {view.version && <span className={styles.version}>{view.version}</span>}
        </span>
        <span className={cn(styles.edge, styles.edgeEnd)}>{view.end}</span>
      </div>

      {view.track === "checks" ? (
        <ul className={styles.checklist}>
          <Chip
            state={chipState(boot.licenseTask, boot.licenseActive)}
            label={t("boot.task.license")}
          />
          <Chip
            state={chipState(boot.updateTask, true)}
            label={
              boot.updatedFrom
                ? t("boot.task.updated", { version: __APP_VERSION__ })
                : t("boot.task.updates")
            }
          />
        </ul>
      ) : (
        <p className={styles.detail} title={view.detail ?? undefined}>
          {view.detail}
        </p>
      )}

      {view.actions === "later" && (
        <div className={styles.actions}>
          <button
            className={styles.ghost}
            type="button"
            onClick={update.cancel}
            disabled={update.cancelling}
          >
            {t("boot.action.later")}
          </button>
        </div>
      )}

      {view.actions === "failed" && (
        <div className={styles.actions}>
          <button className={styles.primary} type="button" onClick={boot.startUpdate}>
            <RedesignIcon name="refresh" className="size-3.5" />
            {t("boot.action.retry")}
          </button>
          <button className={styles.ghost} type="button" onClick={boot.leaveUpdate}>
            {boot.unlocked ? t("boot.action.back") : t("boot.action.continue")}
          </button>
        </div>
      )}
    </div>
  );
}

function chipState(task: BootTaskState, healthy: boolean): ChipState {
  if (task === "pending") return "pending";
  return task === "done" && healthy ? "ok" : "warn";
}

function Chip({ state, label }: { state: ChipState; label: string }) {
  return (
    <li className={styles.chip} data-state={state}>
      <span className={styles.dot} aria-hidden />
      {label}
    </li>
  );
}
