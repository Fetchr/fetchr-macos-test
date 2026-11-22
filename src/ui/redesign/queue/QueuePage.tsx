import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { ipc } from "@/lib/ipc";
import { useLogs } from "@/stores/logs";
import { usePresets } from "@/stores/presets";
import { useQueue } from "@/stores/queue";
import { useSettings, usesSimpleContent } from "@/stores/settings";
import { useUI } from "@/stores/ui";
import type { Job, JobStatus } from "@/types/job";
import { fetchrThemeClassName } from "@/ui/redesign/theme";
import { RedesignIcon } from "@/ui/redesign/icons/iconMap";

import styles from "./QueuePage.module.css";
import { DownloadsTracks } from "./DownloadsTracks";
import { speedBpsFromLogLine } from "./progressSpeed";
import { TaskTable } from "./TaskTable";
import type { QueueCounts, QueueFilter, QueueSummary, QueueTaskActions, QueueTaskUi } from "./taskUiTypes";

export function QueuePage() {
  const { t, i18n } = useTranslation();
  const jobs = useQueue((state) => state.jobs);
  const paused = useQueue((state) => state.paused);
  const lastLineByJob = useLogs((state) => state.lastLineByJob);
  const openAddDialog = useUI((state) => state.openAddDialog);
  const openDownload = useUI((state) => state.openDownload);
  const simple = usesSimpleContent(useSettings((state) => state.uiMode));
  const maxConcurrentJobs = useSettings((state) => state.maxConcurrentJobs);
  const presets = usePresets((state) => state.presets);
  const activePresetId = usePresets((state) => state.activePresetId);
  const activePreset = presets.find((preset) => preset.id === activePresetId) ?? presets[0];
  const presetName = activePreset?.name ?? "Fast Save";
  const [activeFilter, setActiveFilter] = useState<QueueFilter>("all");
  const [autoscroll, setAutoscroll] = useState(true);

  const allTasks = useMemo(
    () => {
      const positions = queuePositions(jobs);
      return jobs.map((job, index) =>
        adaptJobCached(job, presetName, positions[index], lastLineByJob[job.id] ?? null, t, i18n.language),
      );
    },
    [jobs, presetName, lastLineByJob, t, i18n.language],
  );
  const counts = useMemo(() => getQueueCounts(allTasks), [allTasks]);
  const filteredTasks = useMemo(() => filterTasks(allTasks, activeFilter), [activeFilter, allTasks]);
  const running = counts.active > 0;
  const summary = useMemo(() => getQueueSummary(allTasks, maxConcurrentJobs), [allTasks, maxConcurrentJobs]);

  // Стабильный объект: иначе мемоизированные строки перерисовывались бы все
  const actions = useMemo<QueueTaskActions>(
    () => ({
      onMoveUp: (id) => void ipc.moveJob(id, "up"),
      onMoveDown: (id) => void ipc.moveJob(id, "down"),
      onSetPriority: (id, priority) => void ipc.setJobPriority(id, priority),
      onCancel: (id) => void ipc.cancelJob(id),
      onRestart: (id) => void ipc.restartJob(id, maxConcurrentJobs),
      onRemove: (id) => void ipc.removeJob(id),
      onOpenFolder: (path) => void ipc.openFolder(path),
      onRevealFile: (path) => void ipc.revealFile(path),
    }),
    [maxConcurrentJobs],
  );

  if (simple) {
    return (
      <DownloadsTracks
        tasks={allTasks}
        counts={counts}
        summary={summary}
        filter={activeFilter}
        onFilterChange={setActiveFilter}
        running={running}
        actions={actions}
        onStart={() => void ipc.startQueue(maxConcurrentJobs)}
        onPause={() => void ipc.pauseQueue()}
        onClearDone={() => void ipc.clearCompleted()}
        onAdd={openDownload}
      />
    );
  }

  return (
    <div className={`${fetchrThemeClassName} ${styles.studioPage}`}>
      <div className={styles.bottomSection}>
        <div className={styles.dockPanel}>
          <div className={styles.tableToolbar}>
            <div data-tour="queue-filters" className={styles.tabs} role="tablist">
              {[
                { id: "all" as const, label: t("queue.tabs.all", "Все") },
                { id: "active" as const, label: t("queue.tabs.active", "Активные") },
                { id: "queued" as const, label: t("queue.tabs.queued", "В очереди") },
                { id: "done" as const, label: t("queue.tabs.completed", "Завершены") },
                { id: "error" as const, label: t("queue.tabs.errors", "Ошибки") },
              ].map((filter) => (
                <button
                  className={`${styles.tab} ${activeFilter === filter.id ? styles.tabActive : ""}`}
                  key={filter.id}
                  type="button"
                  onClick={() => setActiveFilter(filter.id)}
                >
                  {filter.label}
                  <span className={styles.tabCount}>{counts[filter.id]}</span>
                </button>
              ))}
            </div>

            <div className={styles.headerActions}>
              <button
                data-tour="queue-clear"
                className={styles.button}
                type="button"
                onClick={() => void ipc.clearCompleted()}
                disabled={counts.done === 0}
                title={t("palette.clear_completed", "Очистить завершенные")}
              >
                <RedesignIcon name="trash" className="size-4" />
              </button>
              <button data-tour="queue-add" className={`${styles.button} ${styles.primaryButton}`} type="button" onClick={openAddDialog}>
                <RedesignIcon name="add" className="size-4" />
                {t("queue.add_task", "Добавить задачу")}
              </button>
              {paused && (
                <span className={`${styles.statusBadge} ${styles.statusPaused}`} role="status">
                  <span className={styles.statusDot} />
                  {t("queue.paused_indicator", "Очередь на паузе")}
                </span>
              )}
              {paused ? (
                <button
                  className={`${styles.button} ${styles.primaryButton}`}
                  type="button"
                  onClick={() => void ipc.startQueue(maxConcurrentJobs)}
                >
                  <RedesignIcon name="play" className="size-4" />
                  {t("queue.resume", "Продолжить")}
                </button>
              ) : running ? (
                <button
                  className={styles.button}
                  type="button"
                  onClick={() => void ipc.pauseQueue()}
                  title={t("queue.pause_hint", "Новые задачи не будут запускаться; идущие загрузки доделаются")}
                >
                  <RedesignIcon name="pause" className="size-4" />
                  {t("queue.pause", "Пауза")}
                </button>
              ) : (
                <button
                  data-tour="queue-run"
                  className={`${styles.button} ${styles.primaryButton}`}
                  type="button"
                  onClick={() => void ipc.startQueue(maxConcurrentJobs)}
                  disabled={counts.queued === 0}
                >
                  <RedesignIcon name="play" className="size-4" />
                  {t("queue.start", "Запустить")}
                </button>
              )}
            </div>
          </div>
          <div className={styles.dockScrollable}>
            <TaskTable
              tasks={filteredTasks}
              summary={summary}
              autoscroll={autoscroll}
              onAutoscrollChange={setAutoscroll}
              actions={actions}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Адаптированная строка на объект Job. Прогресс приходит по одной задаче, и
 * store меняет только её объект: остальные строки получают прежний task, и
 * мемоизированный TaskRow их не перерисовывает.
 */
const adaptedTasks = new WeakMap<Job, { key: string; task: QueueTaskUi }>();

function adaptJobCached(job: Job, presetName: string, queuePosition: number | null, lastLogLine: string | null, t: any, lang: string): QueueTaskUi {
  // «Время стадии» считается от Date.now(): у идущей задачи ключ меняется раз
  // в секунду, чтобы оно не застывало, пока сама задача молчит.
  const clock =
    job.status === "running" && job.progress.stage_started_at != null ? Math.floor(Date.now() / 1000) : "";
  const key = `${presetName}\u0000${queuePosition ?? ""}\u0000${lastLogLine ?? ""}\u0000${lang}\u0000${clock}`;
  const cached = adaptedTasks.get(job);
  if (cached && cached.key === key) return cached.task;
  const task = adaptJobToTask(job, presetName, queuePosition, lastLogLine, t, lang);
  adaptedTasks.set(job, { key, task });
  return task;
}

function adaptJobToTask(job: Job, presetName: string, queuePosition: number | null, lastLogLine: string | null, t: any, lang: string): QueueTaskUi {
  const meta = job.spec.meta;
  const platform = meta?.platform || "unknown";
  const live = job.spec.mode === "live";
  // A stopped/ended live recording still produced a saved file — show it as a
  // completed recording, not a cancelled/error one.
  const effectiveStatus: JobStatus = live && job.status === "cancelled" ? "done" : job.status;
  const percent = effectiveStatus === "done" ? 100 : job.progress.percent;
  const progress = Math.max(0, Math.min(100, Number.isFinite(percent) ? percent : 0));
  const chatOnly = job.spec.job_kind === "chat";
  const muteJob = job.spec.job_kind === "fetchrmute";
  const rawTitle = job.spec.name || meta?.title || job.spec.url;
  const title = `${getTaskPrefix(job, t)} ${rawTitle}`;
  // «Удалить маты» над файлом ничего не скачивает — идёт обработка.
  const statusLabel =
    muteJob && effectiveStatus === "running"
      ? t("queue.status.processing", "Обрабатывается")
      : getStatusLabel(effectiveStatus, t);
  const totalBytes = job.progress.total_bytes ?? parseSizeToBytes(job.progress.size);
  const downloadedBytes =
    job.progress.downloaded_bytes ??
    (job.status === "done" && totalBytes != null ? totalBytes : totalBytes != null ? Math.round((totalBytes * progress) / 100) : null);
  const dl = parseProgressLine(lastLogLine);
  const speedBps = job.progress.speed_bps ?? parseSpeedToBps(job.progress.speed) ?? speedBpsFromLogLine(lastLogLine);
  const currentSegment = job.progress.current_segment ?? extractCurrentSegment(job.progress.message, t);
  const segmentLabel = currentSegment ?? (dl?.segment ? `${t("queue.segment", "Сегмент")}: ${dl.segment}` : null);
  const stagePercent = job.progress.stage_percent ?? null;
  const stageRange =
    job.progress.stage_start != null && job.progress.stage_end != null
      ? `${job.progress.stage_start.toFixed(0)}-${job.progress.stage_end.toFixed(0)}%`
      : null;
  const stageElapsed =
    job.progress.stage_started_at != null
      ? formatDurationLabel(Math.max(0, Date.now() - job.progress.stage_started_at))
      : null;
  const totalLabel = totalBytes != null ? formatBytes(totalBytes) : job.progress.size || "—";
  const downloadedLabel = downloadedBytes != null ? formatBytes(downloadedBytes) : "—";
  const sizeLabel =
    job.status === "running" && totalBytes != null
      ? downloadedLabel
      : job.status === "done" && totalBytes != null
        ? totalLabel
        : job.progress.size || "—";

  const start = job.spec.start?.trim();
  const end = job.spec.end?.trim();
  const timing = start && end ? `${start}-${end}` : "";
  const subtitleBase = meta?.uploader || (live ? t("queue.subtitle.live_stream", "Live stream") : chatOnly ? t("queue.subtitle.chat_export", "Chat export") : muteJob ? t("queue.subtitle.local_file", "Локальный файл") : "VOD");
  const subtitle = timing ? `${subtitleBase} • ${timing}` : subtitleBase;

  return {
    id: job.id,
    title,
    subtitle,
    sourceUrl: job.spec.url,
    sourceLabel: platform === "local" ? t("queue.source_local", "Файл") : getPlatformLabel(platform),
    platform,
    presetName,
    status: effectiveStatus,
    statusLabel,
    statusDetail: humanizeStage(getStatusDetail(job, queuePosition, currentSegment, t)) ?? "",
    speed: job.status === "running" ? job.progress.speed || dl?.speed || "—" : "—",
    speedBps,
    eta: job.progress.eta || dl?.eta || (job.status === "queued" ? t("queue.queued", "В очереди") : "—"),
    size: job.status === "running" ? (dl?.downloaded || downloadedLabel || job.progress.size || "—") : (job.progress.size || (dl ? dl.downloaded ?? "—" : sizeLabel)),
    downloadedLabel,
    totalLabel,
    currentSegment: segmentLabel,
    stagePercent,
    stageRange,
    stageElapsed,
    progressMessage: humanizeStage(job.progress.message),
    lastLogLine: humanizeLog(lastLogLine),
    queuePosition,
    priority: job.spec.priority ?? 0,
    progress,
    addedLabel: formatAdded(job.created_at, lang),
    createdAt: new Date(job.created_at).getTime() || 0,
    thumbnailUrl: meta?.thumbnail ?? null,
    duration: meta?.duration,
    live,
    chatOnly,
    withChat: Boolean(job.spec.chat_overlay?.enabled) && !chatOnly,
    withBlur: (job.spec.blur_zones?.length ?? 0) > 0,
    audioJob: muteJob ? "mute" : job.spec.vocal_remover_enabled ? "vocal" : null,
    outputPath: job.output_path || meta?.output_path || null,
    directory: job.spec.directory,
    error: job.error,
  };
}

/** Номер в очереди для каждой ожидающей задачи, за один проход */
function queuePositions(jobs: Job[]): (number | null)[] {
  let queued = 0;
  return jobs.map((job) => (job.status === "queued" ? ++queued : null));
}

function getQueueCounts(tasks: QueueTaskUi[]): QueueCounts {
  return {
    all: tasks.length,
    active: tasks.filter((task) => task.status === "running" || task.status === "paused").length,
    queued: tasks.filter((task) => task.status === "queued").length,
    done: tasks.filter((task) => task.status === "done").length,
    error: tasks.filter((task) => task.status === "error" || task.status === "cancelled").length,
  };
}

function getQueueSummary(tasks: QueueTaskUi[], maxConcurrentJobs: number): QueueSummary {
  const running = tasks.filter((task) => task.status === "running");
  const aggregateSpeedBps = running.reduce((total, task) => total + (task.speedBps ?? 0), 0);

  return {
    taskCount: tasks.length,
    activeDownloads: running.length,
    speed: aggregateSpeedBps > 0 ? `${formatBytes(aggregateSpeedBps)}/s` : "—",
    threads: `${running.length} / ${maxConcurrentJobs}`,
  };
}

function filterTasks(tasks: QueueTaskUi[], filter: QueueFilter): QueueTaskUi[] {
  if (filter === "all") return tasks;
  if (filter === "active") return tasks.filter((task) => task.status === "running" || task.status === "paused");
  if (filter === "queued") return tasks.filter((task) => task.status === "queued");
  if (filter === "done") return tasks.filter((task) => task.status === "done");
  return tasks.filter((task) => task.status === "error" || task.status === "cancelled");
}

function getTaskPrefix(job: Job, t: any): string {
  if (job.spec.job_kind === "chat") return t("queue.prefix.chat", "Чат:");
  if (job.spec.job_kind === "fetchrmute") return t("queue.prefix.fetchr_mute", "Удалить маты:");
  if (job.spec.mode === "live") return t("queue.prefix.stream", "Стрим:");
  return t("queue.prefix.vod", "VOD:");
}

function getStatusLabel(status: JobStatus, t: any): string {
  switch (status) {
    case "running":
      return t("queue.status.running", "Скачивается");
    case "queued":
      return t("queue.status.queued", "В очереди");
    case "paused":
      return t("queue.status.paused", "Пауза");
    case "done":
      return t("queue.status.done", "Завершено");
    case "cancelled":
      return t("queue.status.cancelled", "Отменено");
    case "error":
      return t("queue.status.error", "Ошибка");
  }
}

function getStatusDetail(job: Job, queuePosition: number | null, currentSegment: string | null | undefined, t: any): string {
  if (job.error) return job.error;
  if (currentSegment) return currentSegment;
  if (job.progress.message) return job.progress.message;
  if (job.status === "queued") {
    return queuePosition
      ? `${t("queue.details.queue_position", "Позиция в очереди")}: ${queuePosition}`
      : t("queue.details.waiting_stream", "Ожидает свободного потока");
  }
  if (job.status === "done") return t("queue.status.ready_view", "Готово к просмотру");
  if (job.status === "running" && job.progress.stage_percent != null) {
    return `${t("queue.status.stage", "Этап")} ${Math.round(job.progress.stage_percent)}%`;
  }
  return "";
}

function parseSizeToBytes(value?: string | null): number | null {
  if (!value) return null;
  const match = value.match(/(\d+(?:[.,]\d+)?)\s*([KMGT]?i?B|[KMGT]?B)/i);
  if (!match) return null;
  const amount = Number.parseFloat(match[1].replace(",", "."));
  if (!Number.isFinite(amount)) return null;
  return Math.round(amount * unitMultiplier(match[2]));
}

function parseSpeedToBps(value?: string | null): number | null {
  if (!value) return null;
  const normalized = value.replace(/ps$/i, "/s");
  const match = normalized.match(/(\d+(?:[.,]\d+)?)\s*([KMGT]?i?B|[KMGT]?B)\/s/i);
  if (!match) return null;
  const amount = Number.parseFloat(match[1].replace(",", "."));
  if (!Number.isFinite(amount)) return null;
  return amount * unitMultiplier(match[2]);
}

function unitMultiplier(unit: string): number {
  const normalized = unit.toLowerCase();
  if (normalized.startsWith("k")) return 1024;
  if (normalized.startsWith("m")) return 1024 ** 2;
  if (normalized.startsWith("g")) return 1024 ** 3;
  if (normalized.startsWith("t")) return 1024 ** 4;
  return 1;
}

function formatBytes(bytes: number): string {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let value = Math.max(0, bytes);
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return unitIndex === 0 ? `${Math.round(value)} ${units[unitIndex]}` : `${value.toFixed(2)} ${units[unitIndex]}`;
}

function extractCurrentSegment(message: string | null | undefined, t: any): string | null {
  if (!message) return null;
  const fragment = message.match(/fragment\s+([^\s]+(?:\s*-\s*[^\s]+)?)/i);
  if (fragment) return `${t("queue.segment", "Сегмент")}: ${fragment[1]}`;
  const step = message.match(/(?:segment|frag(?:ment)?)\D+(\d+\s*\/\s*\d+)/i);
  return step ? `${t("queue.segment", "Сегмент")}: ${step[1].replace(/\s+/g, "")}` : null;
}

function getPlatformLabel(platform: string): string {
  switch (platform.toLowerCase()) {
    case "twitch":
      return "Twitch";
    case "youtube":
      return "YouTube";
    case "kick":
      return "Kick";
    case "hls":
      return "HLS";
    case "rtmp":
      return "RTMP";
    case "vk":
      return "VK";
    default:
      return "Unknown";
  }
}

function formatAdded(timestamp: number, lang: string): string {
  const date = new Date(timestamp);
  const sameDay = date.toDateString() === new Date().toDateString();
  const isEn = lang.startsWith("en");
  const locale = isEn ? "en-US" : "ru-RU";
  const time = new Intl.DateTimeFormat(locale, {
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
  if (sameDay) return isEn ? `Today ${time}` : `Сегодня ${time}`;
  return new Intl.DateTimeFormat(locale, {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function formatDurationLabel(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}

const STAGE_MAP: Record<string, string> = {
  "Downloading source": "Скачивание видео",
  "Downloading source video": "Скачивание видео",
  "Downloading chat replay": "Скачивание чата",
  "Preparing chat source": "Подготовка чата",
  "Preparing chat task": "Подготовка чата",
  "Normalizing chat timestamps": "Синхронизация времени чата",
  "Rendering chat overlay": "Отрисовка чата",
  "Rendering chat frames": "Отрисовка чата",
  "Rendering chat alpha overlay": "Отрисовка чата",
  "Compositing chat overlay": "Наложение чата на видео",
  "Compositing final video": "Сборка итогового видео",
  "Chat overlay ready": "Чат готов",
  "Transparent chat overlay encoded": "Прозрачный слой чата готов",
  "Rendering sponsor blur": "Размытие спонсорских вставок",
  "Sponsor blur rendered": "Размытие готово",
  "Direct render: video + blur + chat": "Рендер: видео + размытие + чат",
  "Splitting output file": "Разделение файла",
  "Separating vocals and instrumental...": "Разделение голоса и музыки…",
  "Saving separated stems...": "Сохранение дорожек…",
  "Extracting 44.1 kHz stereo audio...": "Извлечение аудио…",
  "Audio detection: voice-only and music regions...": "Анализ аудио: голос и музыка…",
  "Checking ONNX models for selected regions...": "Проверка моделей…",
  "Checking Vocal Remover models...": "Проверка моделей удаления голоса…",
  "Selective ONNX inference on music regions...": "Обработка музыкальных участков…",
  "Seamless recomposition finished.": "Пересборка завершена",
  "Cancel requested": "Запрошена отмена…",
  "Job queued": "В очереди",
  "Job re-queued": "Снова в очереди",
  "Job removed from queue": "Удалено из очереди",
  "Job started": "Запущено",
  "Queue paused": "Очередь на паузе",
  "Resolved stream is playable directly by the WebView.": "Поток воспроизводится напрямую",
  "Resolved stream is playable as proxied HLS.": "Поток воспроизводится как прокси-HLS",
  "Direct HLS is routed through the local preview proxy.": "Прямой HLS через локальный прокси предпросмотра",
  "RTMP is bridged to low-latency local HLS for preview.": "RTMP перенаправлен в локальный HLS для предпросмотра",
};

function humanizeStage(message?: string | null): string | null {
  if (!message) return message ?? null;
  const exact = STAGE_MAP[message];
  if (exact) return exact;
  let m: RegExpMatchArray | null;
  if ((m = message.match(/^Downloading chat replay \(([\d.,]+)%\)$/))) return `Скачивание чата (${m[1]}%)`;
  if ((m = message.match(/^Downloading chat replay \((\d+)\/(\d+) ranges\)$/))) return `Скачивание чата (${m[1]}/${m[2]})`;
  if ((m = message.match(/^Preparing emotes\/badges: (\d+)\/(\d+)$/))) return `Загрузка эмодзи и значков: ${m[1]}/${m[2]}`;
  return message;
}

function parseProgressLine(line?: string | null) {
  if (!line) return null;
  const seg = line.match(/(\d+)\/(\d+)/);
  const size = line.match(/([\d.]+\s?[KMGT]?i?B)\s*\/\s*([\d.]+\s?[KMGT]?i?B)/i);
  const speed = line.match(/([\d.]+)\s?([KMGT]?i?B)(?:ps|\/s)/i);
  const time = line.match(/(\d{1,2}:\d{2}:\d{2})/);
  if (!seg && !size && !speed) return null;
  return {
    segment: seg ? `${seg[1]}/${seg[2]}` : null,
    downloaded: size ? size[1].replace(/\s+/g, "") : null,
    total: size ? size[2].replace(/\s+/g, "") : null,
    speed: speed ? `${speed[1]}${speed[2]}/s` : null,
    eta: time ? time[1] : null,
  };
}

function humanizeLog(line?: string | null): string | null {
  if (!line) return line ?? null;
  let s = line.trim();
  // strip "01:48:47.734 WARN :" / "INFO :" / "ERROR :" prefix
  s = s.replace(/^\d{1,2}:\d{2}:\d{2}(?:\.\d+)?\s+(?:INFO|WARN|WARNING|ERROR|DEBUG)\s*:\s*/i, "");
  s = s.replace(/^(?:INFO|WARN|WARNING|ERROR|DEBUG)\s*:\s*/i, "");
  s = s.replace(/^!!\s*/, "");

  const dl = parseProgressLine(s);
  if (s.startsWith("Vid Kbps") || s.startsWith("Start downloading") || /^Vid\b/.test(s)) {
    if (dl) {
      const parts = [
        dl.segment ? `сегмент ${dl.segment}` : null,
        dl.downloaded && dl.total ? `${dl.downloaded} из ${dl.total}` : null,
        dl.speed ? dl.speed : null,
        dl.eta ? `осталось ${dl.eta}` : null,
      ].filter(Boolean);
      return `Скачивание видео${parts.length ? ": " + parts.join(" · ") : "…"}`;
    }
    return "Скачивание видео…";
  }

  const rules: [RegExp, (m: RegExpMatchArray) => string][] = [
    [/^Muxing to /i, () => "Объединение видео и звука…"],
    [/^MuxAfterDone/i, () => "Объединение после загрузки включено"],
    [/^Binary merging/i, () => "Склейка сегментов…"],
    [/^Cleaning files/i, () => "Очистка временных файлов…"],
    [/^Reading media info/i, () => "Чтение сведений о медиа…"],
    [/^Writing meta json/i, () => "Запись метаданных…"],
    [/^Rename to /i, () => "Переименование файла…"],
    [/^Parsing streams/i, () => "Разбор потоков…"],
    [/^Selected streams/i, () => "Выбраны потоки"],
    [/^Start downloading/i, () => "Начало загрузки…"],
    [/^Save Name:\s*(.+)$/i, (m) => `Имя файла: ${m[1]}`],
    [/^Save Dir:\s*(.+)$/i, (m) => `Папка: ${m[1]}`],
    [/^User customed range:\s*(.+)$/i, (m) => `Выбранный диапазон: ${m[1]}`],
    [/^Content Matched:/i, () => "Определён тип потока: HLS"],
    [/^Extracted, there are (\d+) streams/i, (m) => `Найдено потоков: ${m[1]}`],
    [/^Output is redirected/i, () => "Цвета консоли отключены"],
    [/^Done\.?$/i, () => "Готово"],
    [/^\[\d+x\d+\]:\s*Video,\s*([^\s,]+)/i, (m) => `Видеодорожка (${m[1]})`],
    [/^\[?\d*x?\d*\]?:?\s*Audio,\s*([^\s,]+)/i, (m) => `Аудиодорожка (${m[1]})`],
    [/^\[?\d*x?\d*\]?:?\s*Data,/i, () => "Служебная дорожка"],
    [/^Please note that custom range/i, () => "Внимание: при произвольном диапазоне возможна рассинхронизация видео и звука"],
    [/^Multiple #EXT-X-MAP/i, () => "Внимание: несколько сегментов-заголовков, проверьте целостность файла"],
    [/^Loading URL:/i, () => "Открытие источника…"],
    [/^Downloading fragment/i, () => "Скачивание фрагмента…"],
    [/^Source download time:/i, () => "Видео скачано"],
    [/^saved:\s*(.+)$/i, (m) => `Сохранено: ${m[1]}`],
    [/(Beta version)/i, () => "Запуск загрузчика…"],
  ];
  for (const [re, fmt] of rules) {
    const m = s.match(re);
    if (m) return fmt(m);
  }
  return s;
}
