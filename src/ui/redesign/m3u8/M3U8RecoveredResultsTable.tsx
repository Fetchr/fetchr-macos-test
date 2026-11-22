import { HlsPlayer } from "@/components/hls-player";
import { cn } from "@/lib/utils";
import { RECOVERED_M3U8_CHAT_WARNING } from "@/services/m3u8/m3u8DiscoveryTypes";
import { RedesignIcon } from "@/ui/redesign/icons/iconMap";

import styles from "./M3U8FinderPage.module.css";
import type { RecoveredGeneration } from "./recoveredHistory";

interface M3U8RecoveredResultsTableProps {
  generations: RecoveredGeneration[];
  loading: boolean;
  queuedUrl?: string | null;
  copiedUrl?: string | null;
  previewUrl?: string | null;
  onCopy: (url: string) => void;
  onAddToQueue: (url: string, generation: RecoveredGeneration) => void;
  onPreview: (url: string | null) => void;
  onRemove: (generationId: string) => void;
  onRefresh: () => void;
  canRefresh: boolean;
}

export function M3U8RecoveredResultsTable({
  generations,
  loading,
  queuedUrl,
  copiedUrl,
  previewUrl,
  onCopy,
  onAddToQueue,
  onPreview,
  onRemove,
  onRefresh,
  canRefresh,
}: M3U8RecoveredResultsTableProps) {
  const latestCount = generations[0]?.urls.length ?? 0;
  return (
    <section className={styles.tablePanel}>
      <div className={styles.tableScroll}>
        <div className={styles.recoveredTable}>
          <div className={styles.recoveredHeader}>
            <span>m3u8 URL</span>
            <span>Параметры</span>
            <span>Статус</span>
            <span>Действия</span>
          </div>

          {loading && <ScanState />}

          {generations.length === 0 && !loading ? (
            <div className={styles.empty}>
              <div className={styles.emptyIconRing}>
                <RedesignIcon name="finder" className={styles.emptyIcon} />
              </div>
              <div className={styles.emptyTitle}>Пока ничего не найдено</div>
              <div className={styles.emptyHint}>
                Заполните никнейм, stream ID и время начала, затем нажмите «Найти m3u8».
              </div>
            </div>
          ) : (
            generations.map((generation, index) => (
              <div key={generation.id} className={cn(styles.recoveredGroup, index > 0 && styles.recoveredGroupPast)}>
                <div className={styles.recoveredGroupHeader}>
                  <div className={styles.recoveredGroupTitle}>
                    <span className={styles.mainText}>
                      {generation.username} · {generation.streamId}
                    </span>
                    <span className={styles.subText}>
                      {generation.startTime}
                      {index === 0 ? " · последний поиск" : ` · найдено ${formatFoundAt(generation.foundAt)}`}
                    </span>
                  </div>
                  <button
                    type="button"
                    className={cn(styles.button, styles.iconButton, styles.smallButton)}
                    onClick={() => onRemove(generation.id)}
                    title="Убрать из истории"
                    aria-label="Убрать из истории"
                  >
                    <RedesignIcon name="close" />
                  </button>
                </div>
                {generation.urls.map((url, urlIndex) => (
                  <RecoveredRow
                    key={url}
                    url={url}
                    label={`HLS плейлист №${urlIndex + 1}`}
                    duration={generation.duration}
                    copied={copiedUrl === url}
                    queued={queuedUrl === url}
                    previewing={previewUrl === url}
                    onCopy={() => onCopy(url)}
                    onAdd={() => onAddToQueue(url, generation)}
                    onTogglePreview={() => onPreview(previewUrl === url ? null : url)}
                  />
                ))}
              </div>
            ))
          )}
        </div>
      </div>

      <div className={styles.warningBox} style={{ margin: "8px 16px 0 16px" }}>
        Recovered m3u8 не содержит чат. {RECOVERED_M3U8_CHAT_WARNING}
      </div>

      <div className={styles.tableFooter}>
        <span>
          Найдено плейлистов: {latestCount}
          {generations.length > 1 && ` · в истории: ${generations.length}`}
        </span>
        <button
          className={`${styles.button} ${styles.iconButton} ${styles.smallButton}`}
          type="button"
          onClick={onRefresh}
          disabled={!canRefresh || loading}
          title="Обновить"
          style={{ width: "26px", height: "26px" }}
          aria-busy={loading}
        >
          <RedesignIcon name={loading ? "loading" : "refresh"} className={loading ? "animate-spin" : undefined} />
        </button>
      </div>
    </section>
  );
}

interface RecoveredRowProps {
  url: string;
  label: string;
  duration: string | null;
  copied: boolean;
  queued: boolean;
  previewing: boolean;
  onCopy: () => void;
  onAdd: () => void;
  onTogglePreview: () => void;
}

function RecoveredRow({ url, label, duration, copied, queued, previewing, onCopy, onAdd, onTogglePreview }: RecoveredRowProps) {
  return (
    <>
      <div className={styles.recoveredRow}>
        <div className={styles.urlCell}>
          <div className={styles.mainText}>{label}</div>
          <div className={styles.subText}>{url}</div>
        </div>
        <div className={styles.compactMetaCell}>
          <span>{duration || "Не определено"}</span>
        </div>
        <span className={`${styles.badge} ${styles.successBadge}`}>Доступен</span>
        <div className={styles.rowActions}>
          <button
            className={cn(styles.button, styles.smallButton, previewing && styles.primaryButton)}
            type="button"
            onClick={onTogglePreview}
            title={previewing ? "Закрыть предпросмотр" : "Предпросмотр записи"}
            aria-pressed={previewing}
          >
            <RedesignIcon name={previewing ? "close" : "play"} />
          </button>
          <button
            className={`${styles.button} ${styles.smallButton}`}
            type="button"
            onClick={onCopy}
            title={copied ? "Скопировано" : "Скопировать m3u8"}
          >
            <RedesignIcon name={copied ? "check" : "copy"} />
            <span className={styles.buttonText}>{copied ? "Готово" : "m3u8"}</span>
          </button>
          <button
            className={`${styles.button} ${styles.smallButton} ${styles.primaryButton}`}
            type="button"
            onClick={onAdd}
            title={queued ? "Диалог добавления открыт" : "Добавить в очередь"}
          >
            <RedesignIcon name={queued ? "check" : "add"} />
            <span className={styles.buttonText}>{queued ? "Открыто" : "Добавить"}</span>
          </button>
        </div>
      </div>
      {previewing && (
        <div className={styles.recoveredPreview}>
          <HlsPlayer src={url} />
        </div>
      )}
    </>
  );
}

function ScanState() {
  return (
    <div className={styles.recoveredScan} role="status">
      <span className={styles.scanTitle}>
        <RedesignIcon name="loading" className="animate-spin" />
        Ищем публично доступные HLS плейлисты…
      </span>
      <span className={styles.scanBar} aria-hidden>
        <span className={styles.scanSweep} />
      </span>
      <span className={styles.emptyHint}>Перебираем CDN-адреса по stream ID и времени начала</span>
    </div>
  );
}

function formatFoundAt(epochMs: number): string {
  const date = new Date(epochMs);
  if (Number.isNaN(date.getTime())) return "раньше";
  return date.toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}
