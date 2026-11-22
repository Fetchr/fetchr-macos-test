import { useEffect, useRef } from "react";

import { HlsPlayer } from "@/components/hls-player";
import type { VpsClipMeta } from "@/lib/ipc";
import { cn } from "@/lib/utils";
import { RedesignIcon } from "@/ui/redesign/icons/iconMap";

import { ChannelAvatar, ChannelName } from "./ChannelAvatar";
import { fmtBytes, fmtCount, fmtDuration, fmtShortDate } from "./format";
import styles from "./ClipViewer.module.css";

/**
 * One clip on stage above the shelf: the video capped to the viewport height
 * so it never pushes its own controls off screen, and everything that can be
 * done with the clip beside it.
 */
export function ClipViewer({
  clip,
  title,
  src,
  position,
  total,
  downloading,
  canDownload,
  keepBusy,
  onDownload,
  onKeep,
  onDelete,
  onPrev,
  onNext,
  onClose,
}: {
  clip: VpsClipMeta;
  title: string;
  src: string | null;
  position: number;
  total: number;
  downloading: boolean;
  canDownload: boolean;
  keepBusy: boolean;
  onDownload: () => void;
  onKeep: () => void;
  onDelete: () => void;
  onPrev: (() => void) | null;
  onNext: (() => void) | null;
  onClose: () => void;
}) {
  const rootRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    rootRef.current?.scrollIntoView({ block: "start" });
  }, [clip.id]);

  // Escape closes the viewer, but only outside fullscreen: there the browser
  // spends the same key on leaving fullscreen first.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || document.fullscreenElement) return;
      if (document.querySelector('[aria-modal="true"]')) return;
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <section ref={rootRef} className={styles.viewer} aria-label={`Клип: ${title}`}>
      <div className={styles.stage}>
        <div className={styles.frame}>
          {src ? (
            <HlsPlayer key={clip.id} src={src} hotkeys />
          ) : (
            <div className={styles.loading}>
              <RedesignIcon name="loading" className={styles.spinning} />
              Открываю клип…
            </div>
          )}
        </div>
      </div>

      <div className={styles.info}>
        <div className={styles.top}>
          <span className={styles.counter}>
            {position} из {total}
          </span>
          <span className={styles.nav}>
            <button
              type="button"
              className={styles.navButton}
              onClick={onPrev ?? undefined}
              disabled={!onPrev}
              aria-label="Предыдущий клип"
            >
              <RedesignIcon name="chevronUp" className={styles.left} />
            </button>
            <button
              type="button"
              className={styles.navButton}
              onClick={onNext ?? undefined}
              disabled={!onNext}
              aria-label="Следующий клип"
            >
              <RedesignIcon name="chevronDown" className={styles.right} />
            </button>
            <button
              type="button"
              className={styles.navButton}
              onClick={onClose}
              aria-label="Закрыть просмотр"
              title="Закрыть (Esc)"
            >
              <RedesignIcon name="close" />
            </button>
          </span>
        </div>

        <h3 className={styles.title}>{title}</h3>
        {clip.channel && (
          <span className={styles.channel}>
            <ChannelAvatar channel={clip.channel} large />
            <ChannelName channel={clip.channel} />
          </span>
        )}

        <dl className={styles.facts}>
          <div>
            <dt>Длительность</dt>
            <dd>{fmtDuration(clip.duration)}</dd>
          </div>
          <div>
            <dt>Размер</dt>
            <dd>{fmtBytes(clip.video_size)}</dd>
          </div>
          <div>
            <dt>Из эфира</dt>
            <dd>{fmtShortDate(clip.absolute_start_at ?? clip.created_at)}</dd>
          </div>
          <div>
            <dt>Чат</dt>
            <dd>{clip.chat_messages > 0 ? fmtCount(clip.chat_messages) : "нет"}</dd>
          </div>
        </dl>

        {clip.note && <p className={styles.note}>{clip.note}</p>}
        {clip.tags && clip.tags.length > 0 && (
          <span className={styles.tags}>
            {clip.tags.map((tag) => (
              <span key={tag} className={styles.tag}>
                #{tag}
              </span>
            ))}
          </span>
        )}

        <div className={styles.actions}>
          <button
            type="button"
            className={styles.download}
            disabled={downloading || !canDownload}
            title={canDownload ? "Скачать и обработать" : "Сначала укажите папку в настройках"}
            onClick={onDownload}
          >
            <RedesignIcon
              name={downloading ? "loading" : "download"}
              className={downloading ? styles.spinning : undefined}
            />
            Скачать на компьютер
          </button>
          <span className={styles.secondaryRow}>
            <button
              type="button"
              className={cn(styles.secondary, clip.keep && styles.secondaryOn)}
              disabled={keepBusy}
              aria-pressed={Boolean(clip.keep)}
              onClick={onKeep}
              title={clip.keep ? "Снять защиту от автоочистки" : "Не удалять при нехватке места"}
            >
              <RedesignIcon name="bookmark" />
              {clip.keep ? "Закреплён" : "Закрепить"}
            </button>
            <button
              type="button"
              className={styles.secondary}
              title="Удалить клип с сервера (5 секунд можно отменить)"
              onClick={onDelete}
            >
              <RedesignIcon name="trash" />
              Удалить
            </button>
          </span>
        </div>
      </div>
    </section>
  );
}
