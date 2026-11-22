import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { createPortal } from "react-dom";
import { useShallow } from "zustand/react/shallow";

import { formatBytes } from "@/lib/format";
import { useQueue } from "@/stores/queue";
import type { Job } from "@/types/job";
import { RedesignIcon } from "@/ui/redesign/icons/iconMap";
import { fetchrThemeClassName } from "@/ui/redesign/theme";
import { DUR, EASE, gsap, prefersReducedMotion } from "@/ui/redesign/theme/gsapSetup";

import { ActivityJobCard } from "./ActivityJobCard";
import styles from "./ActivityPanel.module.css";
import { Sparkline } from "./Sparkline";
import { useSpeedHistory } from "./useSpeedHistory";

/**
 * Подробные загрузки поверх окна, по клику на индикатор скорости в шапке.
 * Больше, чем страница «Загрузки»: график скорости, пик, хвост лога, отрезок.
 */
export function ActivityPanel({
  anchor,
  onClose,
  onOpenQueue,
}: {
  anchor: HTMLElement | null;
  onClose: () => void;
  onOpenQueue: () => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const jobs = useQueue(useShallow((state) => state.jobs));
  const history = useSpeedHistory(true);

  const { running, queued } = useMemo(() => splitJobs(jobs), [jobs]);
  const totalBps = running.reduce((sum, job) => sum + (job.progress.speed_bps ?? 0), 0);
  const peakBps = history.total.length ? Math.max(...history.total) : 0;

  // Позиция: под индикатором, правым краем к нему.
  const position = anchorPosition(anchor);

  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!panel || prefersReducedMotion()) return;
    const tween = gsap.fromTo(
      panel,
      { opacity: 0, y: -8, scale: 0.97, transformOrigin: "top right" },
      { opacity: 1, y: 0, scale: 1, duration: DUR.slow, ease: EASE.out },
    );
    return () => void tween.kill();
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (panelRef.current?.contains(target) || anchor?.contains(target)) return;
      onClose();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onPointer, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onPointer, true);
    };
  }, [anchor, onClose]);

  return createPortal(
    <div
      ref={panelRef}
      className={`${fetchrThemeClassName} ${styles.panel}`}
      style={position}
      role="dialog"
      aria-label="Подробные загрузки"
    >
      <header className={styles.head}>
        <div className={styles.headNumbers}>
          <span>Сейчас</span>
          <b>{totalBps > 0 ? `${formatBytes(totalBps)}/с` : running.length > 0 ? "Обработка" : "—"}</b>
          <small>
            {totalBps > 0 ? `${((totalBps * 8) / 1_000_000).toFixed(1)} Мбит/с` : running.length > 0 ? "сеть не используется" : "ничего не выполняется"}
            {peakBps > 0 ? ` · пик ${formatBytes(peakBps)}/с` : ""}
          </small>
        </div>
        <div className={styles.counts}>
          <span>
            <b>{running.length}</b> идёт
          </span>
          <span>
            <b>{queued.length}</b> в очереди
          </span>
        </div>
      </header>
      {history.total.some((value) => value > 0) && <Sparkline values={history.total} className={styles.headSpark} />}

      <div className={styles.list}>
        {running.length === 0 && <p className={styles.empty}>Сейчас ничего не выполняется.</p>}
        {running.map((job) => (
          <ActivityJobCard key={job.id} job={job} speeds={history.byJob[job.id] ?? []} />
        ))}
      </div>

      <footer className={styles.foot}>
        <button
          type="button"
          onClick={() => {
            onClose();
            onOpenQueue();
          }}
        >
          Открыть все загрузки
          <RedesignIcon name="chevronDown" className="size-3.5 -rotate-90" />
        </button>
      </footer>
    </div>,
    document.body,
  );
}

function splitJobs(jobs: Job[]) {
  const running = jobs.filter((job) => job.status === "running" || job.status === "paused");
  const queued = jobs.filter((job) => job.status === "queued");
  return { running, queued };
}

function anchorPosition(anchor: HTMLElement | null): { top: number; right: number } {
  if (!anchor) return { top: 64, right: 12 };
  const rect = anchor.getBoundingClientRect();
  return { top: rect.bottom + 8, right: Math.max(8, window.innerWidth - rect.right) };
}
