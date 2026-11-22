import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";

import { errorHint } from "@/lib/errorHints";
import { ipc } from "@/lib/ipc";
import { formatShortcuts } from "@/lib/platform";
import { cn } from "@/lib/utils";
import { RedesignIcon, type RedesignIconName } from "@/ui/redesign/icons/iconMap";
import { DemoSlot, QueueDemo } from "@/ui/redesign/demos/DemoSlot";
import { RemoteImage } from "@/ui/redesign/media/RemoteImage";
import { fetchrThemeClassName } from "@/ui/redesign/theme";

import styles from "./DownloadsTracks.module.css";
import { currentStage, stageFill, stagesFor, type TaskStage } from "./taskStages";
import type { QueueCounts, QueueFilter, QueueSummary, QueueTaskActions, QueueTaskUi } from "./taskUiTypes";

interface DownloadsTracksProps {
  tasks: QueueTaskUi[];
  counts: QueueCounts;
  summary: QueueSummary;
  filter: QueueFilter;
  onFilterChange: (filter: QueueFilter) => void;
  running: boolean;
  actions: QueueTaskActions;
  onStart: () => void;
  onPause: () => void;
  onClearDone: () => void;
  onAdd: () => void;
}

const TABS: Array<{ id: QueueFilter; label: string }> = [
  { id: "all", label: "Все" },
  { id: "active", label: "Идут" },
  { id: "queued", label: "В очереди" },
  { id: "done", label: "Сохранено" },
  { id: "error", label: "Ошибки" },
];

type GroupId = "active" | "queued" | "done" | "error";

const GROUPS: Array<{ id: GroupId; label: string; match: (task: QueueTaskUi) => boolean }> = [
  { id: "active", label: "Идут", match: (task) => task.status === "running" || task.status === "paused" },
  { id: "queued", label: "В очереди", match: (task) => task.status === "queued" },
  { id: "done", label: "Сохранено", match: (task) => task.status === "done" },
  { id: "error", label: "Ошибки и отменённые", match: (task) => task.status === "error" || task.status === "cancelled" },
];

/**
 * Загрузки в простом режиме, вид «дорожки»: каждая задача как дорожка
 * монтажки, отрезки этапов заполняются по очереди. Задачи разложены по
 * группам, переход между группами и между этапами анимирован.
 */
export function DownloadsTracks({
  tasks,
  counts,
  summary,
  filter,
  onFilterChange,
  running,
  actions,
  onStart,
  onPause,
  onClearDone,
  onAdd,
}: DownloadsTracksProps) {
  const groups = useMemo(
    () =>
      GROUPS.filter((group) => filter === "all" || group.id === filter).map((group) => ({
        ...group,
        items: tasks.filter(group.match),
      })),
    [tasks, filter],
  );

  const freeIn = useMemo(() => {
    const seconds = tasks
      .filter((task) => task.status === "running" && !task.live)
      .map((task) => parseClock(task.eta))
      .filter((value): value is number => value != null);
    return seconds.length ? formatClock(Math.max(...seconds)) : null;
  }, [tasks]);

  const legend = useMemo(() => {
    const seen = new Map<string, TaskStage>();
    tasks
      .filter((task) => task.status !== "done")
      .forEach((task) => stagesFor(task).forEach((stage) => seen.set(stage.id, stage)));
    return [...seen.values()];
  }, [tasks]);

  const latestSpeed = useRef(0);
  latestSpeed.current = tasks.reduce((sum, task) => sum + (task.status === "running" ? (task.speedBps ?? 0) : 0), 0);
  const [history, setHistory] = useState<number[]>(() => Array(40).fill(0));
  useEffect(() => {
    const timer = window.setInterval(() => setHistory((current) => [...current.slice(1), latestSpeed.current]), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const listRef = useRef<HTMLDivElement | null>(null);
  useFlip(listRef, tasks);

  const speedHint = "Общая скорость";

  return (
    <div className={cn(fetchrThemeClassName, styles.page)}>
      <div className={styles.content}>
        <header className={styles.statusLine}>
          <div className={styles.counts} role="tablist" aria-label="Категории загрузок">
            {TABS.map((tab) => (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={filter === tab.id}
                className={cn(styles.count, styles[`tone_${tab.id}`])}
                onClick={() => onFilterChange(tab.id)}
              >
                {tab.label}
                <b>{counts[tab.id]}</b>
              </button>
            ))}
          </div>
          <div className={styles.speed} title={speedHint}>
            <Spark history={history} />
            <b>{summary.speed}</b>
          </div>
          {counts.active > 0 && (
            <div
              className={styles.eta}
              title={counts.queued > 0 ? "Время текущих загрузок; очередь пойдёт после них" : "Время до конца текущих загрузок"}
            >
              <span>Осталось</span>
              <b>{freeIn ? `~${freeIn}` : "считаю…"}</b>
              {counts.queued > 0 && <small>+{counts.queued} в очереди</small>}
            </div>
          )}
          <div className={styles.headActions}>
            {running ? (
              <IconButton icon="pause" label="Остановить очередь" onClick={onPause} />
            ) : (
              <IconButton icon="play" label="Запустить очередь" onClick={onStart} disabled={counts.queued === 0} />
            )}
            <IconButton icon="trash" label="Убрать сохранённые из списка" onClick={onClearDone} disabled={counts.done === 0} />
            <button type="button" className={styles.primary} onClick={onAdd}>
              <RedesignIcon name="add" className="size-4" strokeWidth={2.2} />
              Скачать
            </button>
          </div>
        </header>

        {legend.length > 0 && (
          <div className={styles.legend} aria-hidden>
            {legend.map((stage) => (
              <span key={stage.id} style={{ "--c": stage.color } as CSSProperties}>
                <i />
                {stage.label}
              </span>
            ))}
          </div>
        )}

        <div className={styles.scroll} ref={listRef}>
          {tasks.length === 0 && (
            <div className={styles.empty}>
              <DemoSlot demo={QueueDemo} height={276} />
              <h2>Загрузок пока нет</h2>
              <p>{formatShortcuts("Нажми «Скачать» или Ctrl+N и вставь ссылку на канал, запись или клип.")}</p>
            </div>
          )}
          {tasks.length > 0 && groups.every((group) => group.items.length === 0) && (
            <p className={styles.emptyTab}>В этой категории пока ничего нет</p>
          )}
          {groups
            .filter((group) => group.items.length > 0)
            .map((group) => (
              <section key={group.id} className={cn(styles.group, styles[`tone_${group.id}`])} aria-label={group.label}>
                <h3 className={styles.groupTitle}>
                  <i />
                  {group.label}
                  <em>{group.items.length}</em>
                </h3>
                {group.items.map((task) => (
                  <TrackRow key={task.id} task={task} actions={actions} />
                ))}
              </section>
            ))}
        </div>
      </div>
    </div>
  );
}

/**
 * Плавный переезд строк: когда задача меняет группу или место, строка
 * едет из старой позиции в новую, а не прыгает.
 */
function useFlip(containerRef: React.RefObject<HTMLDivElement | null>, deps: unknown) {
  const previous = useRef(new Map<string, DOMRect>());
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const next = new Map<string, DOMRect>();
    container.querySelectorAll<HTMLElement>("[data-flip]").forEach((element) => {
      const key = element.dataset.flip ?? "";
      // Если строка ещё едет, продолжаем с того места, где она видна сейчас.
      const visual = element.getBoundingClientRect();
      let moving = false;
      element.getAnimations().forEach((animation) => {
        if (animation.id === "flip") {
          moving = true;
          animation.cancel();
        }
      });
      const rect = moving ? element.getBoundingClientRect() : visual;
      next.set(key, rect);
      const before = moving ? visual : previous.current.get(key);
      if (reduce || !before) return;
      const dx = before.left - rect.left;
      const dy = before.top - rect.top;
      if (Math.abs(dx) < 2 && Math.abs(dy) < 2) return;
      element.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }], {
        id: "flip",
        duration: 520,
        easing: "cubic-bezier(0.32, 0.72, 0, 1)",
      });
    });
    previous.current = next;
  }, [containerRef, deps]);
}

const TrackRow = memo(function TrackRow({ task, actions }: { task: QueueTaskUi; actions: QueueTaskActions }) {
  const stages = useMemo(() => stagesFor(task), [task.live, task.audioJob, task.chatOnly, task.withChat, task.withBlur]);
  const active = task.status === "running" || task.status === "paused";
  const failed = task.status === "error" || task.status === "cancelled";
  const done = task.status === "done";
  const current = active || failed ? currentStage(task, stages) : -1;
  const total = stages.reduce((sum, stage) => sum + stage.weight, 0);

  // Только что закрытый этап на секунду вспыхивает, а сохранённый файл — всей дорожкой.
  const lastStage = useRef(current);
  const lastStatus = useRef(task.status);
  const [justDone, setJustDone] = useState<number | null>(null);
  const [justSaved, setJustSaved] = useState(false);
  useEffect(() => {
    if (active && lastStage.current >= 0 && current > lastStage.current) {
      setJustDone(lastStage.current);
      const timer = window.setTimeout(() => setJustDone(null), 1100);
      lastStage.current = current;
      return () => window.clearTimeout(timer);
    }
    lastStage.current = current;
  }, [active, current]);
  useEffect(() => {
    if (task.status === "done" && lastStatus.current !== "done") {
      setJustSaved(true);
      const timer = window.setTimeout(() => setJustSaved(false), 1500);
      lastStatus.current = task.status;
      return () => window.clearTimeout(timer);
    }
    lastStatus.current = task.status;
  }, [task.status]);

  const fileName = task.outputPath ? task.outputPath.split(/[\\/]/).pop() : null;

  const running = task.status === "running";
  // Идущая задача показывает, что именно сейчас делается, а не откуда она.
  const stageLine = running
    ? [task.progressMessage, task.currentSegment].filter((part): part is string => Boolean(part && part.trim())).join(" · ")
    : "";
  // Коротко и без скорости: «927 МБ / 1,4 ГБ · 4:12».
  const volume = running && !task.live && task.downloadedLabel !== "—"
    ? [
        task.totalLabel !== "—"
          ? `${compactSize(task.downloadedLabel)} / ${compactSize(task.totalLabel)}`
          : compactSize(task.downloadedLabel),
        task.eta !== "—" ? task.eta : null,
      ].filter(Boolean).join(" · ")
    : null;

  return (
    <article data-flip={task.id} className={cn(styles.track, styles[`s_${task.status}`], justSaved && styles.justSaved)} aria-label={task.title}>
      <div className={styles.who}>
        <span className={styles.thumbWrap}>
          <RemoteImage className={styles.thumb} src={task.thumbnailUrl} alt="" fallbackLabel={task.sourceLabel} platform={task.platform} aspectRatio="16 / 10" />
          {(done || failed) && (
            <span className={cn(styles.badge, done ? styles.badgeOk : styles.badgeErr)} aria-hidden>
              {done ? <RedesignIcon name="check" className="size-2.5" strokeWidth={3.4} /> : <b>!</b>}
            </span>
          )}
        </span>
        <span className={styles.whoText}>
          <b title={task.title}>{task.title}</b>
          <span className={cn(failed && task.error && styles.errorText)} title={failed && task.error ? [task.error, errorHint(task.error)].filter(Boolean).join("\n\n") : undefined}>
            {failed && task.error ? task.error : stageLine || `${task.sourceLabel} · ${task.subtitle}`}
          </span>
        </span>
      </div>

      <div className={styles.lane}>
        {done ? (
          <div className={cn(styles.seg, styles.segSaved)} title={task.outputPath ?? undefined}>
            <i style={{ width: "100%" }} />
            <span>
              <RedesignIcon name="check" className="size-3.5" strokeWidth={2.6} />
              Сохранено{fileName ? ` · ${fileName}` : ""}
            </span>
          </div>
        ) : task.live && active ? (
          <div className={cn(styles.seg, styles.segLive)}>
            <span>
              <span className={styles.recDot} />
              Идёт запись
            </span>
          </div>
        ) : (
          stages.map((stage, index) => {
            const isDone = active && index < current;
            const isCurrent = active && index === current;
            const isBad = failed && index === current;
            const fill = isDone ? 100 : isCurrent || isBad ? stageFill(task, index, stages) : 0;
            return (
              <div
                key={stage.id}
                className={cn(
                  styles.seg,
                  isDone && styles.segDone,
                  isCurrent && styles.segCur,
                  isBad && styles.segBad,
                  justDone === index && styles.segFlash,
                )}
                // Идущий отрезок шире остальных: подпись видна целиком, а не обрезается.
                style={{ flexGrow: stage.weight / total + (isCurrent || isBad ? 0.35 : 0), "--c": stage.color } as CSSProperties}
                title={`${stage.label}: ${Math.round(fill)}%`}
              >
                <i style={{ width: `${fill}%` }} />
                <span>
                  {isDone && <RedesignIcon name="check" className="size-3" strokeWidth={3} />}
                  {stage.label}
                </span>
              </div>
            );
          })
        )}
      </div>

      <div className={styles.nums}>
        <b>{task.live && active ? "REC" : done ? "100%" : `${Math.round(task.progress)}%`}</b>
        <span>
          {task.status === "running"
            ? volume || (task.eta !== "—" ? task.eta : "идёт")
            : task.status === "queued"
              ? task.queuePosition
                ? `№${task.queuePosition} в очереди`
                : "ждёт слот"
              : done
                ? task.size !== "—"
                  ? `сохранено · ${task.size}`
                  : "сохранено"
                : task.status === "cancelled"
                  ? "отменено"
                  : failed
                    ? "ошибка"
                    : "пауза"}
        </span>
      </div>

      <div className={styles.acts}>
        {task.sourceUrl && <CopyLinkButton url={task.sourceUrl} />}
        {task.status !== "queued" && <IconButton icon="logs" label="Сохранить лог задачи" onClick={() => void saveTaskLog(task)} />}
        {active && <IconButton icon="close" label="Отменить" onClick={() => actions.onCancel?.(task.id)} />}
        {(failed || task.status === "queued" || task.status === "paused") && (
          <IconButton icon={failed ? "refresh" : "play"} label={failed ? "Повторить" : "Запустить"} onClick={() => actions.onRestart?.(task.id)} />
        )}
        {done && task.outputPath && <IconButton icon="folder" label="Показать файл в папке" onClick={() => actions.onRevealFile?.(task.outputPath ?? "")} />}
        {!active && <IconButton icon="trash" label="Убрать из списка" onClick={() => actions.onRemove?.(task.id)} />}
      </div>
    </article>
  );
});

function Spark({ history }: { history: number[] }) {
  const { line, area } = useMemo(() => {
    const max = Math.max(1, ...history);
    const points = history.map((value, index) => `${(index / (history.length - 1)) * 100},${22 - (value / max) * 18}`);
    return { line: `M${points.join(" L")}`, area: `M0,24 L${points.join(" L")} L100,24Z` };
  }, [history]);
  return (
    <svg className={styles.spark} viewBox="0 0 100 24" preserveAspectRatio="none" aria-hidden>
      <path d={area} className={styles.sparkArea} />
      <path d={line} className={styles.sparkLine} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

async function saveTaskLog(task: QueueTaskUi) {
  const text = (await ipc.jobLogText(task.id).catch(() => null)) ?? "";
  const safe = task.title.replace(/[\\/:*?"<>|]+/g, "_").slice(0, 80) || "job";
  await ipc.saveTextFileDialog(`${safe}.log.txt`, text || "Лог пуст");
}

function CopyLinkButton({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1400);
    return () => window.clearTimeout(timer);
  }, [copied]);
  return (
    <IconButton
      icon={copied ? "check" : "link"}
      label={copied ? "Ссылка скопирована" : "Скопировать ссылку"}
      onClick={() => void navigator.clipboard.writeText(url).then(() => setCopied(true))}
    />
  );
}

function IconButton({ icon, label, onClick, disabled }: { icon: RedesignIconName; label: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button type="button" className={styles.iconButton} onClick={onClick} title={label} aria-label={label} disabled={disabled}>
      <RedesignIcon name={icon} className="size-4" />
    </button>
  );
}

/** «926.66 MiB» → «927 МБ», «1.41 GiB» → «1,4 ГБ»: меньше цифр в строке. */
function compactSize(label: string): string {
  const match = label.trim().match(/^([\d.,]+)\s*([KMGT]i?B|B)$/i);
  if (!match) return label;
  const value = Number.parseFloat(match[1].replace(",", "."));
  const unit = { B: "Б", K: "КБ", M: "МБ", G: "ГБ", T: "ТБ" }[match[2][0].toUpperCase() as "B" | "K" | "M" | "G" | "T"];
  if (!Number.isFinite(value) || !unit) return label;
  const digits = value >= 100 ? 0 : value >= 10 ? 0 : 1;
  return `${value.toFixed(digits).replace(".", ",")} ${unit}`;
}

/** «01:02:03» или «02:03» в секунды; всё остальное (например «—») пропускаем. */
function parseClock(value: string): number | null {
  const parts = value.trim().split(":").map(Number);
  if (parts.length < 2 || parts.length > 3 || parts.some((part) => !Number.isFinite(part))) return null;
  return parts.reduce((total, part) => total * 60 + part, 0);
}

function formatClock(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}
