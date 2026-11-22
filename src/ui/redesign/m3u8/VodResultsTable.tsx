import { useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import { DemoSlot, FinderDemo } from "@/ui/redesign/demos/DemoSlot";
import type { TwitchPublicVod, TwitchPublicVodPage } from "@/services/m3u8/m3u8DiscoveryTypes";
import { RedesignIcon } from "@/ui/redesign/icons/iconMap";
import { RemoteImage } from "@/ui/redesign/media/RemoteImage";

import styles from "./M3U8FinderPage.module.css";
import { SourceProgressPanel } from "./SourceProgressPanel";
import type { StreamSourceState } from "./sourceProgress";

export interface FinderStreamRow {
  id: string;
  kind: "public" | "tracker";
  title: string;
  username: string;
  streamId: string | null;
  createdAt: string | null;
  duration: string;
  durationSeconds?: number | null;
  thumbnailUrl: string | null;
  twitchUrl: string | null;
  trackerUrl: string | null;
  chatAvailable: boolean;
  publicVod?: TwitchPublicVod;
}

interface VodResultsTableProps {
  page?: TwitchPublicVodPage | null;
  rows?: FinderStreamRow[];
  loading: boolean;
  /** Per-site state of the running lookup; empty when nothing is loading. */
  sources?: StreamSourceState[];
  copiedId?: string | null;
  queuedId?: string | null;
  generatingId?: string | null;
  streamPage: number;
  totalStreams: number;
  pageSize: number;
  trackerError?: string | null;
  canLoadMorePublic?: boolean;
  loadingMorePublic?: boolean;
  onLoadMorePublic?: () => void;
  onCopyPublic: (vod: TwitchPublicVod) => void;
  onAddPublicToQueue: (vod: TwitchPublicVod) => void;
  onCopyRecovered: (row: FinderStreamRow) => void;
  onAddRecoveredToQueue: (row: FinderStreamRow) => void;
  onPageChange: (page: number) => void;
}

export function VodResultsTable({
  page,
  rows,
  loading,
  sources = [],
  copiedId,
  queuedId,
  generatingId,
  streamPage,
  totalStreams,
  pageSize,
  trackerError,
  canLoadMorePublic,
  loadingMorePublic,
  onLoadMorePublic,
  onCopyPublic,
  onAddPublicToQueue,
  onCopyRecovered,
  onAddRecoveredToQueue,
  onPageChange,
}: VodResultsTableProps) {
  const unsorted = rows ?? (page?.items ?? []).slice(0, pageSize).map(publicVodToRow);
  const [sort, setSort] = useState<{ key: "title" | "date"; desc: boolean } | null>(null);

  const items = useMemo(() => {
    if (!sort) return unsorted;
    const compare = (a: FinderStreamRow, b: FinderStreamRow) =>
      sort.key === "title"
        ? a.title.localeCompare(b.title)
        // createdAt может отсутствовать — такие строки уходят вниз
        : (a.createdAt ? Date.parse(a.createdAt) : 0) - (b.createdAt ? Date.parse(b.createdAt) : 0);
    return [...unsorted].sort((a, b) => (sort.desc ? -compare(a, b) : compare(a, b)));
  }, [unsorted, sort]);

  const toggleSort = (key: "title" | "date") =>
    setSort((prev) =>
      prev?.key !== key ? { key, desc: false } : prev.desc ? null : { key, desc: true }
    );

  const totalPages = Math.max(1, Math.ceil(Math.max(totalStreams || items.length, items.length) / pageSize));
  const canPrev = streamPage > 1 && !loading;
  const canNext = streamPage < totalPages && !loading;

  return (
    <section className={styles.tablePanel}>
      {trackerError && <div className={styles.tableNotice}>Tracker список недоступен: {trackerError}</div>}
      {loading && items.length > 0 && sources.length > 0 && <SourceProgressPanel sources={sources} compact />}

      <div className={styles.tableScroll}>
        <div className={styles.vodTable}>
          <div className={styles.vodHeader}>
            <span>Превью</span>
            <div className={styles.vodHeaderSorts}>
            <button
              className={cn(styles.sortButton, sort?.key === "title" && styles.sortButtonActive)}
              type="button"
              onClick={() => toggleSort("title")}
              aria-sort={sort?.key === "title" ? (sort.desc ? "descending" : "ascending") : "none"}
            >
              Стрим
              <RedesignIcon
                name="chevronUp"
                className={cn(
                  styles.sortArrow,
                  sort?.key === "title" && styles.sortArrowActive,
                  sort?.key === "title" && sort.desc && styles.sortArrowDesc
                )}
              />
            </button>
            <button
              className={cn(styles.sortButton, sort?.key === "date" && styles.sortButtonActive)}
              type="button"
              onClick={() => toggleSort("date")}
              aria-sort={sort?.key === "date" ? (sort.desc ? "descending" : "ascending") : "none"}
            >
              Дата / длит.
              <RedesignIcon
                name="chevronUp"
                className={cn(
                  styles.sortArrow,
                  sort?.key === "date" && styles.sortArrowActive,
                  sort?.key === "date" && sort.desc && styles.sortArrowDesc
                )}
              />
            </button>
            </div>
            <span>Тип</span>
            <span>Действия</span>
          </div>

          {items.length === 0 ? (
            <div className={styles.empty}>
              {loading ? (
                sources.length > 0 ? <SourceProgressPanel sources={sources} /> : "Загружаем список стримов..."
              ) : (
                <>
                  <DemoSlot demo={FinderDemo} height={252} />
                  <div className={styles.emptyTitle}>Стримы пока не загружены</div>
                  <div className={styles.emptyHint}>
                    Введите никнейм в поле выше и нажмите «Загрузить VOD».
                  </div>
                </>
              )}
            </div>
          ) : (
            items.map((row) => {
              const isPublic = row.kind === "public" && Boolean(row.publicVod?.public);
              const busy = generatingId === row.id;
              // Public-kind rows can still be unlisted/private — show that and
              // disable actions instead of silently doing nothing.
              const unavailable = row.kind === "public" && !isPublic;
              const badgeLabel =
                row.kind === "tracker"
                  ? "m3u8"
                  : isPublic
                    ? "Public"
                    : row.publicVod?.viewable === "unlisted"
                      ? "Unlisted"
                      : "Private";
              const actionsDisabled = unavailable || (!isPublic && (!row.streamId || busy));

              return (
                <div className={styles.vodRow} key={row.id}>
                  <RemoteImage
                    className={styles.thumbnail}
                    src={row.thumbnailUrl}
                    alt={row.title}
                    fallbackLabel={row.kind === "public" ? "Twitch VOD" : "Hidden VOD"}
                    platform="twitch"
                    aspectRatio="16 / 9"
                  />
                  <div className={styles.titleCell}>
                    <div className={styles.mainText} title={row.title}>{row.title}</div>
                    <div className={styles.vodMeta}>
                      {formatVodDate(row.createdAt)} · {row.duration || "—"}
                    </div>
                  </div>
                  <span
                    className={cn(
                      styles.badge,
                      row.kind === "tracker" ? styles.accentBadge : isPublic ? styles.neutralBadge : styles.dangerBadge,
                    )}
                  >
                    {badgeLabel}
                  </span>
                  <div className={styles.rowActions}>
                    <button
                      className={`${styles.button} ${styles.smallButton}`}
                      type="button"
                      onClick={() => isPublic ? onCopyPublic(row.publicVod!) : onCopyRecovered(row)}
                      disabled={actionsDisabled}
                      title={unavailable ? "VOD не является публичным" : isPublic ? "Скопировать Twitch VOD URL" : "Найти и скопировать recovered m3u8"}
                      aria-busy={busy}
                    >
                      <RedesignIcon name={copiedId === row.id ? "check" : busy ? "loading" : "copy"} className={busy ? "animate-spin" : undefined} />
                      <span className={styles.buttonText}>
                        {copiedId === row.id ? "Готово" : isPublic ? "Twitch URL" : "m3u8"}
                      </span>
                    </button>
                    <button
                      className={`${styles.button} ${styles.smallButton} ${styles.primaryButton}`}
                      type="button"
                      onClick={() => isPublic ? onAddPublicToQueue(row.publicVod!) : onAddRecoveredToQueue(row)}
                      disabled={actionsDisabled}
                      title={unavailable ? "VOD не является публичным" : queuedId === row.id ? "Диалог добавления открыт" : "Добавить в очередь"}
                      aria-busy={busy}
                    >
                      <RedesignIcon name={queuedId === row.id ? "check" : busy ? "loading" : "add"} className={busy ? "animate-spin" : undefined} />
                      <span className={styles.buttonText}>
                        {queuedId === row.id ? "Открыто" : "Добавить"}
                      </span>
                    </button>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>

      <div className={styles.tableFooter} style={{ justifyContent: canLoadMorePublic || loadingMorePublic ? "space-between" : "flex-end" }}>
        {(canLoadMorePublic || loadingMorePublic) && onLoadMorePublic && (
          <button
            className={`${styles.button} ${styles.smallButton}`}
            type="button"
            onClick={onLoadMorePublic}
            disabled={!canLoadMorePublic || loadingMorePublic}
            title="Загрузить следующие 100 публичных VOD"
           aria-busy={loadingMorePublic}>
            <RedesignIcon name={loadingMorePublic ? "loading" : "download"} className={loadingMorePublic ? "animate-spin" : undefined} />
            <span className={styles.buttonText}>{loadingMorePublic ? "Загружаем..." : "Ещё VOD"}</span>
          </button>
        )}
        <div className={styles.pagination}>
          <button className={`${styles.button} ${styles.iconButton}`} type="button" onClick={() => onPageChange(streamPage - 1)} disabled={!canPrev}>
            <RedesignIcon name="chevronDown" className={styles.prevIcon} />
          </button>
          <span className={styles.pageCounter}>{streamPage} / {totalPages}</span>
          <button className={`${styles.button} ${styles.iconButton}`} type="button" onClick={() => onPageChange(streamPage + 1)} disabled={!canNext}>
            <RedesignIcon name="chevronDown" className={styles.nextIcon} />
          </button>
        </div>
      </div>
    </section>
  );
}

function publicVodToRow(vod: TwitchPublicVod): FinderStreamRow {
  return {
    id: `public:${vod.id}`,
    kind: "public",
    title: vod.title || `Twitch VOD ${vod.id}`,
    username: "twitch",
    streamId: vod.streamId,
    createdAt: vod.createdAt,
    duration: vod.duration || "-",
    thumbnailUrl: vod.thumbnailUrl,
    twitchUrl: vod.url,
    trackerUrl: null,
    chatAvailable: vod.chatAvailable,
    publicVod: vod,
  };
}

function formatVodDate(value: string | null): string {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  // Короткая дата, как в промо: «22.09 · 06:12:40», год только для прошлых лет
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return new Intl.DateTimeFormat("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    ...(sameYear ? {} : { year: "numeric" as const }),
  }).format(date);
}
