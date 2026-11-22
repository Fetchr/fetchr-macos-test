import { useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";

import { DemoSlot, LogsDemo } from "@/ui/redesign/demos/DemoSlot";

import { LogRow, type ParsedLogLine } from "./LogRow";
import styles from "./LogsPage.module.css";

interface LogTableProps {
  /** Контейнер, который реально прокручивается (панель страницы, не тело таблицы) */
  scrollRef: RefObject<HTMLDivElement | null>;
  logs: ParsedLogLine[];
  selectedId: string | null;
  autoScroll: boolean;
  newestFirst: boolean;
  onSelectLog: (log: ParsedLogLine) => void;
}

/** Высота строки журнала (min-height в .row); точную меряет measureElement */
const ROW_HEIGHT = 34;

export function LogTable({ scrollRef, logs, selectedId, autoScroll, newestFirst, onSelectLog }: LogTableProps) {
  const bodyRef = useRef<HTMLDivElement | null>(null);
  // Строки начинаются ниже шапки таблицы: сдвиг тела внутри прокрутки
  const [scrollMargin, setScrollMargin] = useState(0);
  useLayoutEffect(() => {
    const body = bodyRef.current;
    const scroller = scrollRef.current;
    if (!body || !scroller) return;
    setScrollMargin(
      body.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop,
    );
  }, [scrollRef]);
  // В журнале до 10k строк, а видно несколько десятков: в DOM только они.
  // Раньше каждый флаш логов (до 20 раз в секунду) перестраивал тысячи кнопок.
  const virtualizer = useVirtualizer({
    count: logs.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
    scrollMargin,
  });

  useEffect(() => {
    if (!autoScroll || !bodyRef.current) return;
    bodyRef.current.scrollTop = newestFirst ? 0 : bodyRef.current.scrollHeight;
  }, [logs.length, autoScroll, newestFirst]);

  useEffect(() => {
    if (!selectedId) return;
    // Выбранная строка может быть вне отрисованного окна: прокрутка по индексу
    const index = logs.findIndex((log) => logKey(log) === selectedId);
    if (index >= 0) virtualizer.scrollToIndex(index, { align: "auto" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  return (
    <section className={styles.tablePanel}>
      <div className={styles.tableHeader}>
        <span>Время</span>
        <span>Уровень</span>
        <span>Задача / источник</span>
        <span>Сообщение</span>
        <span>Статус</span>
      </div>
      <div ref={bodyRef} className={styles.tableBody}>
        {logs.length === 0 ? (
          <div className={styles.empty}>
            <DemoSlot demo={LogsDemo} height={196} />
            <div className={styles.emptyTitle}>Логи пусты</div>
            <div className={styles.emptyHint}>
              Здесь появится каждый шаг пайплайна: загрузка, рендер чата, блюр и обработка звука.
            </div>
          </div>
        ) : (
          <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
            {virtualizer.getVirtualItems().map((item) => {
              const log = logs[item.index];
              return (
                <div
                  key={item.key}
                  data-index={item.index}
                  ref={virtualizer.measureElement}
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    width: "100%",
                    transform: `translateY(${item.start - scrollMargin}px)`,
                  }}
                >
                  <LogRow log={log} selected={selectedId === logKey(log)} onSelect={onSelectLog} />
                </div>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}

export function logKey(log: ParsedLogLine) {
  return `${log.id}:${log.ts}:${log.line}`;
}
