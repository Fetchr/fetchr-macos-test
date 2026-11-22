import { memo, useLayoutEffect, useRef, useState, type MouseEvent } from "react";
import { useTranslation } from "react-i18next";
import { useGsapPresence } from "@/hooks/useGsapPresence";
import { activateOnKey } from "@/lib/a11y";
import { errorHint } from "@/lib/errorHints";
import { RedesignIcon, PlatformIcon } from "@/ui/redesign/icons/iconMap";
import { collapse, expand, rowArrivalFlash } from "@/ui/redesign/theme/gsapMotion";

import styles from "./QueuePage.module.css";
import { TaskLogPanel } from "./TaskLogPanel";
import { TaskProgressBar } from "./TaskProgressBar";
import { TaskStatusBadge } from "./TaskStatusBadge";
import { TaskThumbnail } from "./TaskThumbnail";
import type { QueueTaskActions, QueueTaskUi } from "./taskUiTypes";

export interface TaskRowProps {
  task: QueueTaskUi;
  actions?: QueueTaskActions & { onSelect?: (id: string) => void };
  selected?: boolean;
}

/** Мемоизирована: прогресс одной задачи не перерисовывает остальные строки */
export const TaskRow = memo(function TaskRow({ task, actions, selected }: TaskRowProps) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const rowRef = useRef<HTMLDivElement>(null);

  // Только что добавленная задача вспыхивает при первом показе. Порог по
  // времени создания, а не «строка появилась в списке»: переключение
  // фильтра тоже вставляет строки, но старые задачи новыми не становятся.
  useLayoutEffect(() => {
    const row = rowRef.current;
    if (!row || Date.now() - task.createdAt > FRESH_TASK_MS) return;
    const flash = rowArrivalFlash(row);
    return () => {
      flash?.kill();
      row.style.removeProperty("--row-flash");
    };
    // Вспышка — событие появления строки, пересчитывать её на обновлениях не нужно
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const { shouldRender: detailsMounted, ref: detailsRef } = useGsapPresence<HTMLDivElement>(
    expanded,
    (element, direction) => (direction === "in" ? expand(element) : collapse(element)),
  );
  const canCancel = task.status === "running" || task.status === "paused";
  const canRemove = task.status !== "running";
  const canRestart =
    task.status === "cancelled" || task.status === "error" || task.status === "queued" || task.status === "paused";
  const restartLabel =
    task.status === "queued" || task.status === "paused"
      ? t("queue.row.resume", "Возобновить")
      : t("queue.row.restart", "Перезапустить");
  const hint = errorHint(task.error);

  // Перестановку и уход строки анимирует Flip в TaskTable, здесь обычный div
  return (
    <div className="relative">
      {/* Роль кнопки строке НЕ даётся намеренно: QueuePage не передаёт ни
          onSelect, ни selectedTaskId, поэтому клик по строке ничего не делает.
          Объявить её кнопкой значило бы пообещать клавиатуре действие,
          которого нет. Когда выбор строки доведут — сюда вернутся role,
          tabIndex и aria-pressed. */}
      <div
        ref={rowRef}
        className={`${styles.row} ${task.status === "running" ? styles.rowActive : ""} ${selected ? styles.selectedRowHighlight : ""}`}
        onClick={() => actions?.onSelect?.(task.id)}
        style={{ cursor: "pointer" }}
      >
        <div className={styles.titleCell}>
          <TaskThumbnail
            thumbnailUrl={task.thumbnailUrl}
            title={task.title}
            platform={task.platform}
            durationLabel={null}
            live={task.live}
            chatOnly={task.chatOnly}
          />
          <div className={styles.taskText}>
            <div className={styles.taskTitle} title={task.title}>
              {task.title}
            </div>
            <div className={styles.taskSubtitle} title={task.subtitle}>
              {task.subtitle}
            </div>
          </div>
        </div>

        <div className={styles.metaGroup}>
          <div className={styles.sourceCell}>
            <div className={styles.sourceTop}>
              <PlatformIcon platform={task.platform} className="size-3.5" />
              <span className={styles.subtleText}>{task.sourceLabel}</span>
            </div>
            <CopyableUrl url={task.sourceUrl} />
          </div>

          <div className={styles.subtleText} title={task.presetName}>
            {task.presetName}
          </div>

          <div className={styles.statusCell}>
            <TaskStatusBadge status={task.status} label={task.statusLabel} />
            <div className={styles.statusDetail} title={task.error ?? task.statusDetail}>
              {task.error ?? task.statusDetail}
            </div>
            {task.status === "error" && hint && (
              <div className={styles.statusHint} title={hint}>
                {shortHint(hint)}
              </div>
            )}
            {task.status === "error" && actions?.onRestart && (
              <button
                className={styles.retryButton}
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  actions.onRestart?.(task.id);
                }}
              >
                <RedesignIcon name="refresh" className="size-3" />
                {t("queue.row.retry", "Повторить")}
              </button>
            )}
          </div>

          <div className={styles.monoCell} title={task.speed}>
            {task.speed}
          </div>
          <div className={styles.monoCell} title={task.eta}>
            {task.eta}
          </div>
          <div className={styles.monoCell} title={task.size}>
            {task.size}
          </div>

          <TaskProgressBar
            value={task.progress}
            status={task.status}
            downloadedLabel={task.downloadedLabel}
            totalLabel={task.totalLabel}
            stageValue={task.stagePercent}
            stageLabel={task.progressMessage}
          />

          <div className={styles.subtleText} title={task.addedLabel}>
            {task.addedLabel}
          </div>
        </div>


        <div className={styles.rowActions}>
          {task.status === "queued" && actions?.onSetPriority && (
            <button
              className={styles.iconButton}
              type="button"
              title={priorityTitle(task.priority, t)}
              aria-label={priorityTitle(task.priority, t)}
              onClick={(e) => {
                e.stopPropagation();
                actions.onSetPriority?.(task.id, nextPriority(task.priority));
              }}
            >
              <RedesignIcon name={priorityIcon(task.priority)} className="size-3.5" />
            </button>
          )}
          <RowAction label={expanded ? t("queue.row.hide_details", "Скрыть детали") : t("queue.row.more", "Подробнее")} onClick={() => setExpanded((value) => !value)} icon="more" />
          {canRestart && <RowAction label={restartLabel} onClick={() => actions?.onRestart?.(task.id)} icon="play" />}
          {canCancel && <RowAction label={t("queue.cancel", "Отменить")} onClick={() => actions?.onCancel?.(task.id)} icon="close" />}
          {task.outputPath ? (
            <RowAction label={t("queue.row.reveal_file", "Показать файл")} onClick={() => actions?.onRevealFile?.(task.outputPath!)} icon="folder" />
          ) : (
            task.status !== "queued" && (
              <RowAction label={t("queue.row.open_folder", "Открыть папку")} onClick={() => actions?.onOpenFolder?.(task.directory)} icon="folder" />
            )
          )}
          {canRemove && <RowAction label={t("common.remove", "Удалить")} onClick={() => actions?.onRemove?.(task.id)} icon="trash" />}
        </div>
      </div>
      {detailsMounted && (
        <div ref={detailsRef} style={{ overflow: "hidden" }}>
            <div className={styles.detailsRow}>
              <Detail label={t("queue.details.total_progress", "Общий прогресс")} value={`${Math.round(task.progress)}%`} />
              <Detail label={t("queue.details.stage", "Стадия")} value={task.progressMessage ?? task.statusDetail ?? "—"} wide />
              <Detail label={t("queue.details.stage_progress", "Прогресс стадии")} value={task.stagePercent != null ? `${task.stagePercent.toFixed(1)}%` : "—"} />
              <Detail label={t("queue.details.stage_range", "Диапазон стадии")} value={task.stageRange ?? "—"} />
              <Detail label={t("queue.details.stage_time", "Время стадии")} value={task.stageElapsed ?? "—"} />
              <Detail label={t("queue.columns.speed", "Скорость")} value={task.speed} />
              <Detail label={t("queue.columns.eta", "ETA")} value={task.eta} />
              <Detail label={t("queue.columns.size", "Размер")} value={task.size} />
              <Detail label={t("queue.details.segment_frame", "Сегмент/кадр")} value={task.currentSegment ?? "—"} />
              <Detail label={t("queue.details.last_log", "Последний лог")} value={task.lastLogLine ?? "—"} wide />
              {task.error && <Detail label={t("queue.status.error", "Ошибка")} value={task.error} wide />}
              {hint && <Detail label={t("queue.details.what_to_do", "Что делать")} value={hint} wide />}
              <TaskLogPanel jobId={task.id} name={task.title} running={task.status === "running"} />
          </div>
        </div>
      )}
    </div>
  );
});

/** Сколько задача считается «только что добавленной» для вспышки строки */
const FRESH_TASK_MS = 4000;

/** Первое предложение подсказки — в строку; полный текст остаётся в title и деталях */
function shortHint(hint: string): string {
  const end = hint.search(/[.!?…](\s|$)/);
  return end >= 0 ? hint.slice(0, end + 1) : hint;
}

function nextPriority(current: number): number {
  // normal (0) -> high (1) -> low (-1) -> normal (0)
  if (current > 0) return -1;
  if (current < 0) return 0;
  return 1;
}

function priorityIcon(priority: number): "priorityHigh" | "priorityLow" | "priorityNormal" {
  if (priority > 0) return "priorityHigh";
  if (priority < 0) return "priorityLow";
  return "priorityNormal";
}

function priorityLabel(priority: number, t: any): string {
  if (priority > 0) return t("queue.priority.high", "Высокий");
  if (priority < 0) return t("queue.priority.low", "Низкий");
  return t("queue.priority.normal", "Обычный");
}

function priorityTitle(priority: number, t: any): string {
  return `${t("queue.priority.label", "Приоритет")}: ${priorityLabel(priority, t)} — ${t("queue.priority.cycle", "нажмите, чтобы изменить")}`;
}

function CopyableUrl({ url }: { url: string }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const [hover, setHover] = useState(false);
  const copyUrl = () => {
    void navigator.clipboard.writeText(url);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };
  // Мышью нужно погасить всплытие, иначе клик выберет ещё и строку целиком.
  // С клавиатуры этого не требуется: activateOnKey игнорирует чужие цели.
  const copy = (e: MouseEvent) => {
    e.stopPropagation();
    copyUrl();
  };
  return (
    <div
      style={{ position: "relative", minWidth: 0 }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <div
        className={styles.sourceUrl}
        role="button"
        tabIndex={0}
        title={url}
        onClick={copy}
        onKeyDown={activateOnKey(copyUrl)}
        style={{ cursor: "pointer" }}
      >
        {url}
      </div>
      {hover ? (
        <span
          style={{
            position: "absolute",
            top: "100%",
            left: 0,
            marginTop: 2,
            zIndex: 20,
            whiteSpace: "nowrap",
            background: "var(--fetchr-color-elevated, #2a2a2a)",
            color: "var(--fetchr-color-fg-secondary, #ddd)",
            border: "1px solid var(--fetchr-color-border-subtle, #444)",
            borderRadius: 4,
            padding: "2px 6px",
            fontSize: 10,
            pointerEvents: "none",
          }}
        >
          {copied ? t("common.copied", "Скопировано") : t("common.copy", "Скопировать")}
        </span>
      ) : null}
    </div>
  );
}

function Detail({ label, value, wide }: { label: string; value: string; wide?: boolean }) {
  return (
    <div className={`${styles.detailCell} ${wide ? styles.detailCellWide : ""}`}>
      <span>{label}</span>
      <strong title={value}>{value}</strong>
    </div>
  );
}

function RowAction({
  label,
  icon,
  onClick,
}: {
  label: string;
  icon: "check" | "close" | "folder" | "more" | "move" | "play" | "trash";
  onClick: () => void;
}) {
  return (
    <button className={styles.iconButton} type="button" title={label} aria-label={label} onClick={onClick}>
      <RedesignIcon name={icon} className="size-3.5" />
    </button>
  );
}
