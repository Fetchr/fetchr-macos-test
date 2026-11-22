import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { cn } from "@/lib/utils";
import { formatYtdlpError } from "@/lib/ytdlpErrors";
import { queueSelection } from "@/services/streams/streamDownload";
import { searchStreams } from "@/services/streams/streamSearch";
import { useSettings } from "@/stores/settings";
import { RedesignIcon } from "@/ui/redesign/icons/iconMap";

import styles from "./DownloadOverlay.module.css";
import { shortUrl } from "./linkInput";

type ItemStatus = "wait" | "search" | "ok" | "channel" | "error";

interface BatchItem {
  url: string;
  status: ItemStatus;
  note?: string;
}

interface Props {
  urls: readonly string[];
  directory: string;
  onDone: (jobIds: string[]) => void;
  onCancel: () => void;
  onOpen: (url: string) => void;
}

/**
 * Несколько ссылок разом: каждая ищется и ставится в очередь с лучшим
 * качеством и общей папкой. Каналы не раскрываются, их открывают по одному.
 */
export function BatchQueue({ urls, directory, onDone, onCancel, onOpen }: Props) {
  const { t } = useTranslation();
  const [items, setItems] = useState<BatchItem[]>(() => urls.map((url) => ({ url, status: "wait" })));
  const [running, setRunning] = useState(false);
  const [finished, setFinished] = useState(false);
  const cancelled = useRef(false);

  const setItem = (index: number, next: Partial<BatchItem>) =>
    setItems((list) => list.map((item, i) => (i === index ? { ...item, ...next } : item)));

  const remove = (index: number) => setItems((list) => list.filter((_, i) => i !== index));

  const queueOne = async (url: string): Promise<{ status: ItemStatus; note?: string; jobIds: string[] }> => {
    const state = useSettings.getState();
    const outcome = await searchStreams(url, {
      proxy: state.proxy,
      binariesDir: state.binariesDir,
      twitchAuthToken: state.integrations.twitchAuthToken || null,
      hint: null,
    });
    if (outcome.link.listing) {
      return { status: "channel", note: t("simple.batch_channel", "Канал: открой его, чтобы выбрать записи"), jobIds: [] };
    }
    const row = outcome.rows[0];
    if (!row) return { status: "error", note: outcome.warnings[0] ?? t("simple.nothing_found", "Ничего не нашлось."), jobIds: [] };
    const result = await queueSelection([row], { withChat: false, directory });
    if (result.failed.length > 0) {
      return { status: "error", note: formatYtdlpError(result.failed[0].reason).message, jobIds: result.jobIds };
    }
    return { status: "ok", note: row.title, jobIds: result.jobIds };
  };

  const run = async () => {
    cancelled.current = false;
    setRunning(true);
    const jobIds: string[] = [];
    for (const [index, item] of items.entries()) {
      if (cancelled.current) break;
      if (item.status === "ok") continue;
      setItem(index, { status: "search", note: undefined });
      try {
        const result = await queueOne(item.url);
        jobIds.push(...result.jobIds);
        setItem(index, { status: result.status, note: result.note });
      } catch (reason) {
        setItem(index, { status: "error", note: formatYtdlpError(reason).message });
      }
    }
    setRunning(false);
    setFinished(true);
    onDone(jobIds);
  };

  const pending = items.filter((item) => item.status !== "ok").length;

  return (
    <section className={styles.batch} aria-labelledby="batch-title">
      <header className={styles.batchHead}>
        <h2 id="batch-title" className={styles.introTitle}>
          {t("simple.batch_title", "Ссылок: {{count}}", { count: items.length })}
        </h2>
        <p className={styles.introText}>
          {t("simple.batch_hint", "Каждая запись встанет в очередь в лучшем качестве, в папку по умолчанию.")}
        </p>
      </header>

      <ol className={styles.batchList} aria-live="polite">
        {items.map((item, index) => (
          <li key={item.url} className={styles.batchItem} data-status={item.status}>
            <BatchStatusIcon status={item.status} />
            <span className={styles.batchText}>
              <span className={styles.batchUrl} title={item.url}>
                {shortUrl(item.url, 64)}
              </span>
              {item.note && <span className={styles.batchNote}>{item.note}</span>}
            </span>
            {item.status === "channel" && (
              <button type="button" className={styles.ghost} onClick={() => onOpen(item.url)}>
                {t("simple.batch_open", "Открыть")}
              </button>
            )}
            {!running && item.status === "wait" && (
              <button
                type="button"
                className={styles.clearButton}
                onClick={() => remove(index)}
                aria-label={t("simple.batch_remove", "Убрать ссылку")}
                title={t("simple.batch_remove", "Убрать ссылку")}
              >
                <RedesignIcon name="close" className="size-3.5" />
              </button>
            )}
          </li>
        ))}
      </ol>

      <div className={styles.batchActions}>
        {running ? (
          <button type="button" className={styles.secondary} onClick={() => (cancelled.current = true)}>
            {t("simple.batch_stop", "Остановить")}
          </button>
        ) : (
          <button type="button" className={styles.secondary} onClick={onCancel}>
            {finished ? t("simple.new_search", "Новый поиск") : t("common.cancel", "Отмена")}
          </button>
        )}
        {!finished && (
          <button
            type="button"
            className={styles.primary}
            disabled={running || items.length === 0}
            onClick={() => void run()}
          >
            <RedesignIcon name={running ? "loading" : "download"} className={cn("size-4", running && styles.spin)} />
            {running
              ? t("simple.batch_running", "Ставлю в очередь…")
              : t("simple.batch_queue_all", "Добавить все: {{count}}", { count: pending })}
          </button>
        )}
      </div>
    </section>
  );
}

function BatchStatusIcon({ status }: { status: ItemStatus }) {
  const name = status === "ok" ? "check" : status === "search" ? "loading" : status === "error" ? "alert" : status === "channel" ? "finder" : "link";
  return (
    <span className={styles.batchIcon} aria-hidden>
      <RedesignIcon name={name} className={cn("size-3.5", status === "search" && styles.spin)} />
    </span>
  );
}
