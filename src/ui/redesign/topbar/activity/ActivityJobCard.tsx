import { memo, useEffect, useState } from "react";
import { useShallow } from "zustand/react/shallow";

import { ipc } from "@/lib/ipc";
import { errorHint } from "@/lib/errorHints";
import { formatBytes, formatDuration } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useLogs } from "@/stores/logs";
import type { Job } from "@/types/job";
import { PlatformIcon, RedesignIcon, type RedesignIconName } from "@/ui/redesign/icons/iconMap";

import styles from "./ActivityPanel.module.css";
import { Sparkline } from "./Sparkline";

const STATUS_LABEL: Record<string, string> = {
  running: "Идёт",
  queued: "В очереди",
  paused: "Пауза",
  done: "Готово",
  error: "Ошибка",
  cancelled: "Отменено",
};

/** Подробная карточка одной задачи: всё, что известно о ней прямо сейчас. */
export const ActivityJobCard = memo(function ActivityJobCard({ job, speeds }: { job: Job; speeds: number[] }) {
  const progress = job.progress;
  const live = job.spec.mode === "live";
  const running = job.status === "running";
  const percent = clamp(progress.percent);
  const stagePercent = progress.stage_percent == null ? null : clamp(progress.stage_percent);
  const title = job.spec.meta?.title || job.spec.name;
  const platform = job.spec.meta?.platform ?? "unknown";
  const peak = speeds.length ? Math.max(...speeds) : 0;
  const tail = useJobTail(job.id, 2);
  const elapsed = useElapsed(job.started_at, running ? null : job.finished_at);

  const rows: Array<[string, string | null]> = [
    ["Скорость", running && progress.speed_bps ? `${formatBytes(progress.speed_bps)}/с` : progress.speed || null],
    ["Пик", peak > 0 ? `${formatBytes(peak)}/с` : null],
    [
      "Скачано",
      progress.downloaded_bytes != null
        ? progress.total_bytes
          ? `${formatBytes(progress.downloaded_bytes)} из ${formatBytes(progress.total_bytes)}`
          : formatBytes(progress.downloaded_bytes)
        : progress.size || null,
    ],
    ["Осталось", running ? progress.eta || null : null],
    ["Идёт", elapsed],
    ["Сегмент", progress.current_segment || null],
    ["Отрезок", job.spec.start || job.spec.end ? `${job.spec.start || "0:00:00"} – ${job.spec.end || "конец"}` : null],
    ["Качество", job.live_stats?.detected_quality || (job.spec.quality_height ? `${job.spec.quality_height}p` : null)],
    ["Записано", live && job.live_stats?.media_duration_sec ? formatDuration(job.live_stats.media_duration_sec) : null],
    ["Файл записи", live && job.live_stats?.recorded_bytes ? formatBytes(job.live_stats.recorded_bytes) : null],
    ["Переподключения", live && job.live_stats?.reconnects ? String(job.live_stats.reconnects) : null],
  ];
  const shown = rows.filter((row): row is [string, string] => Boolean(row[1]));

  return (
    <article className={cn(styles.job, styles[`job_${job.status}`])}>
      <header className={styles.jobHead}>
        <PlatformIcon platform={platform} className="size-4" />
        <b title={title}>{title}</b>
        <span className={styles.jobStatus}>
          {live && running ? (job.live_stats?.stalled ? "Нет данных" : "REC") : STATUS_LABEL[job.status] ?? job.status}
        </span>
      </header>

      {progress.message && running && <p className={styles.jobStage}>{progress.message}</p>}
      {job.error && <p className={styles.jobError}>{job.error}</p>}
      {job.status === "error" && errorHint(job.error) && <p className={styles.jobHint}>{errorHint(job.error)}</p>}

      {!live && (
        <div className={styles.bar} title={`${percent.toFixed(1)}%`}>
          <i style={{ width: `${percent}%` }} />
          {stagePercent != null && running && <i className={styles.barStage} style={{ width: `${stagePercent}%` }} />}
          <span>{percent.toFixed(percent < 10 ? 1 : 0)}%</span>
        </div>
      )}

      {running && speeds.some((value) => value > 0) && <Sparkline values={speeds} className={styles.jobSpark} />}

      {shown.length > 0 && (
        <dl className={styles.stats}>
          {shown.map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd title={value}>{value}</dd>
            </div>
          ))}
        </dl>
      )}

      {tail.length > 0 && (
        <pre className={styles.tail}>
          {tail.map((line, index) => (
            <span key={index}>{line}</span>
          ))}
        </pre>
      )}

      <footer className={styles.jobActions}>
        <Action icon="link" label="Ссылка" onClick={() => void navigator.clipboard.writeText(job.spec.url)} />
        {job.output_path ? (
          <Action icon="folder" label="Файл" onClick={() => void ipc.revealFile(job.output_path ?? "")} />
        ) : (
          <Action icon="folder" label="Папка" onClick={() => void ipc.openFolder(job.spec.directory)} />
        )}
        {(running || job.status === "queued") && <Action icon="close" label="Отменить" onClick={() => void ipc.cancelJob(job.id)} />}
      </footer>
    </article>
  );
});

function Action({ icon, label, onClick }: { icon: RedesignIconName; label: string; onClick: () => void }) {
  return (
    <button type="button" className={styles.action} onClick={onClick}>
      <RedesignIcon name={icon} className="size-3.5" />
      {label}
    </button>
  );
}

function useJobTail(jobId: string, count: number): string[] {
  return useLogs(
    useShallow((state) => {
      const out: string[] = [];
      for (let index = state.lines.length - 1; index >= 0 && out.length < count; index -= 1) {
        const line = state.lines[index];
        // Служебный вывод ffmpeg (метаданные, «!!»-строки) читать незачем.
      if (line.id === jobId && isReadableLogLine(line.line)) out.unshift(line.line.trim());
      }
      return out;
    }),
  );
}

function isReadableLogLine(line: string): boolean {
  const text = line.trim();
  if (!text || text.startsWith("!!") || text.startsWith("$")) return false;
  return !/^(Metadata:|Stream #|Side data:|CPB properties|handler_name|encoder\s|major_brand|minor_version|compatible_brands|Duration:|Input #|Output #)/i.test(text);
}

function useElapsed(startedAt: number | null, finishedAt: number | null): string | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!startedAt || finishedAt) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [startedAt, finishedAt]);
  if (!startedAt) return null;
  return formatDuration(Math.max(0, ((finishedAt ?? now) - startedAt) / 1000));
}

function clamp(value: number | null | undefined): number {
  return Math.max(0, Math.min(100, Number.isFinite(value) ? (value as number) : 0));
}
