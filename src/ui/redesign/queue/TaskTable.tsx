import { useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { useFlipList } from "@/hooks/useFlipList";
import { useScrolledHeader } from "@/hooks/useScrolledHeader";

import { cn } from "@/lib/utils";

import styles from "./QueuePage.module.css";
import { TaskRow } from "./TaskRow";
import { RedesignIcon } from "@/ui/redesign/icons/iconMap";
import { DemoSlot, QueueDemo } from "@/ui/redesign/demos/DemoSlot";
import { useUI } from "@/stores/ui";
import type { QueueSummary, QueueTaskActions, QueueTaskUi } from "./taskUiTypes";

export interface TaskTableProps {
  tasks: QueueTaskUi[];
  summary: QueueSummary;
  autoscroll: boolean;
  onAutoscrollChange: (value: boolean) => void;
  actions?: QueueTaskActions & { onSelect?: (id: string) => void };
  selectedTaskId?: string | null;
}

/** Колонки, по которым есть чем сортировать. Остальные — форматированные
 *  строки вроде ETA, где порядок строк не совпадает с порядком значений. */
type SortKey = "title" | "status" | "speed" | "progress" | "added";

const STATUS_ORDER: Record<string, number> = {
  running: 0, queued: 1, paused: 2, error: 3, cancelled: 4, done: 5,
};

export function TaskTable({ tasks, summary, autoscroll, onAutoscrollChange, actions, selectedTaskId }: TaskTableProps) {
  const { t } = useTranslation();
  const openAddDialog = useUI((s) => s.openAddDialog);
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean } | null>(null);

  const columns: Array<{ label: string; sortKey?: SortKey }> = [
    { label: t("queue.columns.name", "Название"), sortKey: "title" },
    { label: t("queue.columns.source", "Источник") },
    { label: t("queue.columns.preset", "Пресет") },
    { label: t("queue.columns.status", "Статус"), sortKey: "status" },
    { label: t("queue.columns.speed", "Скорость"), sortKey: "speed" },
    { label: t("queue.columns.eta", "ETA") },
    { label: t("queue.columns.size", "Размер") },
    { label: t("queue.columns.progress", "Прогресс"), sortKey: "progress" },
    { label: t("queue.columns.added", "Добавлен"), sortKey: "added" },
    { label: "" },
  ];

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const headerRef = useRef<HTMLDivElement | null>(null);

  const sortedTasks = useMemo(() => {
    if (!sort) return tasks;
    const compare = (a: QueueTaskUi, b: QueueTaskUi): number => {
      switch (sort.key) {
        case "title": return a.title.localeCompare(b.title);
        case "status": return (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9);
        case "speed": return (a.speedBps ?? -1) - (b.speedBps ?? -1);
        case "progress": return a.progress - b.progress;
        case "added": return a.createdAt - b.createdAt;
      }
    };
    return [...tasks].sort((a, b) => (sort.desc ? -compare(a, b) : compare(a, b)));
  }, [tasks, sort]);

  // Состав и порядок строк одной строкой — сигнал к перестановке для Flip
  useFlipList(sortedTasks.map((task) => task.id).join(","), '[data-flip-row="queue"]');
  useScrolledHeader(scrollRef, headerRef, styles.tableHeaderScrolled);

  // Клик по той же колонке переворачивает порядок, третий — снимает сортировку
  const toggleSort = (key: SortKey) =>
    setSort((prev) =>
      prev?.key !== key ? { key, desc: false } : prev.desc ? null : { key, desc: true }
    );

  return (
    <section className={styles.tablePanel} aria-label={t("nav.queue", "Очередь")}>
      <div className={styles.tableScroll} ref={scrollRef}>
        <div className={styles.table}>
          <div className={styles.tableHeader} ref={headerRef}>
            {columns.map((column, idx) => {
              if (!column.sortKey) return <div key={idx}>{column.label}</div>;
              const active = sort?.key === column.sortKey;
              return (
                <div key={idx}>
                  <button
                    className={cn(styles.sortButton, active && styles.sortButtonActive)}
                    type="button"
                    onClick={() => toggleSort(column.sortKey!)}
                    aria-sort={active ? (sort!.desc ? "descending" : "ascending") : "none"}
                  >
                    {column.label}
                    <RedesignIcon
                      name="chevronUp"
                      className={cn(
                        styles.sortArrow,
                        active && styles.sortArrowActive,
                        active && sort!.desc && styles.sortArrowDesc
                      )}
                    />
                  </button>
                </div>
              );
            })}
          </div>

          {tasks.length === 0 ? (
            <div className={styles.empty}>
              <DemoSlot demo={QueueDemo} height={276} />
              <div className={styles.emptyTitle}>{t("queue.empty", "Очередь пуста")}</div>
              <div className={styles.emptyText}>{t("queue.empty_hint", "Добавьте stream, VOD или HLS-источник, чтобы поставить загрузку в очередь.")}</div>
              <button className={styles.emptyAction} type="button" onClick={openAddDialog}>
                <RedesignIcon name="add" className="size-4" />
                {t("queue.add_task", "Добавить задачу")}
              </button>
            </div>
          ) : (
            sortedTasks.map((task) => (
              <div key={task.id} data-flip-row="queue" data-flip-id={task.id}>
                <TaskRow
                  task={task}
                  actions={actions}
                  selected={selectedTaskId === task.id}
                />
              </div>
            ))
          )}
        </div>
      </div>

      <div className={styles.summary}>
        <div className={styles.summaryStats}>
          <span>{t("queue.stats.task_count", "{{count}} задач", { count: summary.taskCount })}</span>
          <span>
            {t("queue.stats.active_label", "Активные загрузки")}: <b className={styles.summaryValue}>{summary.activeDownloads}</b>
          </span>
          <span>
            {t("queue.stats.speed_label", "Скорость")}: <b className={styles.summaryValue}>{summary.speed}</b>
          </span>
          <span>
            {t("queue.stats.threads_label", "Одновременных потоков")}: <b className={styles.summaryValue}>{summary.threads}</b>
          </span>
        </div>
        <label className={styles.toggle}>
          {t("logs.autoscroll", "Автопрокрутка")}
          <input
            type="checkbox"
            checked={autoscroll}
            onChange={(event) => onAutoscrollChange(event.currentTarget.checked)}
          />
        </label>
      </div>
    </section>
  );
}
