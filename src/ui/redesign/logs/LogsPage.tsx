import { useCallback, useMemo, useRef, useState } from "react";
import { useFocusTrap } from "@/hooks/useFocusTrap";

import { ipc } from "@/lib/ipc";
import { useLogs } from "@/stores/logs";
import { fetchrThemeClassName } from "@/ui/redesign/theme";
import { RedesignIcon } from "@/ui/redesign/icons/iconMap";

import { LogDetailsPanel } from "./LogDetailsPanel";
import { parseLogLineCached, type ParsedLogLine } from "./LogRow";
import { LogTable, logKey } from "./LogTable";
import styles from "./LogsPage.module.css";
import { backdropDismiss } from "@/lib/backdrop";

interface LogFilterState {
  job: string;
  source: string;
  text: string;
}

export function LogsPage() {
  const lines = useLogs((state) => state.lines);
  const [filters] = useState<LogFilterState>({ job: "", source: "", text: "" });
  const [autoScroll] = useState(true);
  const [newestFirst] = useState(true);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const trapRef = useFocusTrap<HTMLDivElement>(isModalOpen);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const parsed = useMemo(() => lines.map(parseLogLineCached), [lines]);
  const filtered = useMemo(() => {
    const next = filterLogs(parsed, filters);
    return newestFirst ? next.slice().reverse() : next;
  }, [parsed, filters, newestFirst]);
  const selected = useMemo(
    () => filtered.find((line) => logKey(line) === selectedKey) ?? null,
    [filtered, selectedKey],
  );

  // Стабильная ссылка: иначе мемоизированные строки перерисовывались бы все
  const selectLog = useCallback((log: ParsedLogLine) => {
    setSelectedKey(logKey(log));
    setIsModalOpen(true);
  }, []);

  const jumpLatest = () => {
    const latest = newestFirst ? filtered[0] : filtered[filtered.length - 1];
    if (latest) {
      setSelectedKey(logKey(latest));
      setIsModalOpen(true);
    }
  };
  const jumpErrors = () => {
    const error = filtered.find((line) => line.level === "error" || line.level === "warning");
    if (error) {
      setSelectedKey(logKey(error));
      setIsModalOpen(true);
    }
  };
  const saveLogs = async () => {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const txt = formatLogsForExport(filtered);
    await ipc.saveTextFileDialog(`fetchr-log-${stamp}.txt`, txt);
  };

  return (
    <div className={`${fetchrThemeClassName} ${styles.studioPage}`}>
      {/* Bottom Section */}
      <div className={styles.bottomSection}>
        <div className={styles.dockPanel} style={{ background: "transparent" }}>
          <div ref={scrollRef} className={styles.dockScrollable} style={{ padding: 0 }}>
            <LogTable
              scrollRef={scrollRef}
              logs={filtered}
              selectedId={selectedKey}
              autoScroll={autoScroll}
              newestFirst={newestFirst}
              onSelectLog={selectLog}
            />
          </div>
        </div>
      </div>

      {/* Modal log details inspector overlay */}
      {isModalOpen && selected && (
        <div className={styles.modalOverlay} {...backdropDismiss(() => setIsModalOpen(false))} role="presentation">
          <div
            ref={trapRef}
            className={styles.modalContent}
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
          >
            <button
              className={styles.modalCloseButton}
              type="button"
              onClick={() => setIsModalOpen(false)}
              title="Закрыть"
            >
              <RedesignIcon name="close" className="size-3.5" />
            </button>
            <LogDetailsPanel log={selected} />
          </div>
        </div>
      )}

      {/* Status Footer */}
      <footer className={styles.studioFooter}>
        <span>Показано {filtered.length} из {parsed.length} событий</span>
        <span className={styles.footerActions}>
          <button className={styles.button} style={{ height: 24, fontSize: 12 }} type="button" onClick={jumpLatest} disabled={filtered.length === 0}>
            <RedesignIcon name="move" className="size-3" />
            К последнему
          </button>
          <button className={styles.button} style={{ height: 24, fontSize: 12 }} type="button" onClick={jumpErrors} disabled={filtered.length === 0}>
            <RedesignIcon name="alert" className="size-3" />
            К ошибкам
          </button>
          <button className={styles.button} style={{ height: 24, fontSize: 12 }} type="button" onClick={saveLogs} disabled={filtered.length === 0}>
            <RedesignIcon name="exportJson" className="size-3" />
            Сохранить лог
          </button>
        </span>
      </footer>
    </div>
  );
}

function formatLogsForExport(logs: ParsedLogLine[]) {
  if (!logs || logs.length === 0) {
    return [
      "Fetchr logs",
      `Exported: ${new Date().toISOString()}`,
      "Rows: 0",
      "",
      "No logs to export.",
    ].join("\n");
  }

  const lines = logs.map((log) => {
    let timeStr = "UNKNOWN";
    if (log && log.ts) {
      try {
        timeStr = new Date(log.ts).toISOString();
      } catch (e) {
        timeStr = String(log.ts);
      }
    }
    const levelStr = String(log?.level ?? "info").toUpperCase();
    const sourceStr = String(log?.source ?? log?.id ?? "system");
    const statusStr = String(log?.status ?? "idle");
    const messageStr = String(log?.message ?? log?.line ?? "");
    return [timeStr, levelStr, sourceStr, statusStr, messageStr].join(" | ");
  });

  const jsonl = logs.map((log) => {
    try {
      return JSON.stringify(log);
    } catch (e) {
      return `{"error": "Failed to stringify log line", "line": ${JSON.stringify(log?.line)}}`;
    }
  });

  return [
    "Fetchr logs",
    `Exported: ${new Date().toISOString()}`,
    `Rows: ${logs.length}`,
    "",
    "Text view",
    ...lines,
    "",
    "JSONL",
    ...jsonl,
    "",
  ].join("\n");
}

function filterLogs(logs: ParsedLogLine[], filters: LogFilterState) {
  const job = filters.job.trim().toLowerCase();
  const source = filters.source.trim().toLowerCase();
  const text = filters.text.trim().toLowerCase();

  return logs.filter((line) => {
    if (job && !line.id.toLowerCase().includes(job)) return false;
    if (source && !line.source.toLowerCase().includes(source)) return false;
    if (text) {
      const haystack = `${line.message} ${line.line} ${line.status} ${line.level}`.toLowerCase();
      if (!haystack.includes(text)) return false;
    }
    return true;
  });
}
