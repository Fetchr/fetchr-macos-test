import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { HlsPlayer, type HlsPlayerHandle } from "@/components/hls-player";
import { useFocusTrap } from "@/hooks/useFocusTrap";
import { backdropDismiss } from "@/lib/backdrop";
import { ipc } from "@/lib/ipc";
import { formatHms } from "@/lib/timecode";
import { ensureYoutubeIframeApi, withYoutubePlayerApi, youtubeEmbedUrl, type YoutubeIframePlayer } from "@/lib/youtube";
import { useSettings } from "@/stores/settings";
import type { PreviewSource } from "@/types/job";
import { RedesignIcon } from "@/ui/redesign/icons/iconMap";
import { fetchrThemeClassName } from "@/ui/redesign/theme";
import { mediaZoomIn, mediaZoomOut } from "@/ui/redesign/theme/gsapMotion";

import styles from "./MediaPreviewOverlay.module.css";

export interface MediaPreviewTarget {
  url: string;
  platform: string;
  title: string;
  subtitle?: string;
  thumbnailUrl?: string | null;
  live?: boolean;
  /** Элемент миниатюры: из него плеер вырастает и в него же сворачивается. */
  origin?: HTMLElement | null;
}

type Media = { kind: "embed"; src: string } | { kind: "hls"; src: string } | null;

interface MediaPreviewOverlayProps {
  target: MediaPreviewTarget;
  onClose: () => void;
  /** Поставить начало фрагмента в текущую позицию плеера, секунды. */
  onMarkStart?: (seconds: number) => void;
  /** Поставить конец фрагмента в текущую позицию плеера, секунды. */
  onMarkEnd?: (seconds: number) => void;
  /** Текущее начало фрагмента (ЧЧ:ММ:СС). */
  currentStart?: string;
  /** Текущий конец фрагмента (ЧЧ:ММ:СС). */
  currentEnd?: string;
  /** Количество уже добавленных доп. фрагментов. */
  extraCount?: number;
  /** Сохранить текущий отрезок в список фрагментов и начать разметку нового. */
  onAddExtraRange?: () => void;
}

/** Просмотр записи поверх окна, не уходя со списка. */
export function MediaPreviewOverlay({
  target,
  onClose,
  onMarkStart,
  onMarkEnd,
  currentStart,
  currentEnd,
  extraCount,
  onAddExtraRange,
}: MediaPreviewOverlayProps) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const trapRef = useFocusTrap<HTMLDivElement>(true);
  const [media, setMedia] = useState<Media>(null);
  const [error, setError] = useState<string | null>(null);
  const closing = useRef(false);
  const hlsRef = useRef<HlsPlayerHandle | null>(null);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const youtubeRef = useRef<YoutubeIframePlayer | null>(null);
  const [youtubeReady, setYoutubeReady] = useState(false);
  const [marked, setMarked] = useState<string | null>(null);
  const canMark = Boolean(onMarkStart || onMarkEnd) && !target.live;
  const markReady = media?.kind === "hls" || (media?.kind === "embed" && youtubeReady);

  // Время встроенного YouTube доступно только через его IFrame API.
  useEffect(() => {
    if (!canMark || media?.kind !== "embed" || !iframeRef.current) return;
    let cancelled = false;
    ensureYoutubeIframeApi()
      .then((YT) => {
        if (cancelled || !iframeRef.current) return;
        youtubeRef.current = new YT.Player(iframeRef.current, {
          events: { onReady: () => !cancelled && setYoutubeReady(true) },
        });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      setYoutubeReady(false);
      try {
        youtubeRef.current?.destroy?.();
      } catch {
        // Плеер мог уже выгрузиться вместе с iframe.
      }
      youtubeRef.current = null;
    };
  }, [canMark, media]);

  const currentTime = (): number => {
    try {
      return media?.kind === "embed" ? (youtubeRef.current?.getCurrentTime() ?? 0) : (hlsRef.current?.getCurrentTime() ?? 0);
    } catch {
      return 0;
    }
  };

  const mark = (which: "start" | "end") => {
    const seconds = Math.max(0, Math.floor(currentTime()));
    if (which === "start") onMarkStart?.(seconds);
    else onMarkEnd?.(seconds);
    setMarked(`${which === "start" ? "Начало" : "Конец"}: ${formatHms(seconds)}`);
  };

  useLayoutEffect(() => {
    if (!overlayRef.current || !cardRef.current) return;
    const timeline = mediaZoomIn(overlayRef.current, cardRef.current, visibleRect(target.origin));
    return () => void timeline.kill();
  }, [target.origin]);

  useEffect(() => {
    const embed = target.platform === "youtube" ? youtubeEmbedUrl(target.url) : null;
    if (embed) {
      const src = `${embed}?autoplay=1&rel=0`;
      setMedia({ kind: "embed", src: canMark ? withYoutubePlayerApi(src) : src });
      return;
    }
    let alive = true;
    let session: PreviewSource | null = null;
    const settings = useSettings.getState();
    ipc
      .startStreamPreview(target.url, settings.proxy, settings.binariesDir, null, settings.integrations.twitchAuthToken || null)
      .then((source) => {
        session = source;
        if (alive) setMedia({ kind: "hls", src: source.url });
        else if (source.id) void ipc.stopStreamPreview(source.id).catch(() => undefined);
      })
      .catch((reason) => {
        if (alive) setError(String(reason));
      });
    return () => {
      alive = false;
      if (session?.id) void ipc.stopStreamPreview(session.id).catch(() => undefined);
    };
  }, [target.url, target.platform]);

  const close = () => {
    if (closing.current) return;
    closing.current = true;
    const overlay = overlayRef.current;
    const card = cardRef.current;
    if (!overlay || !card) {
      onClose();
      return;
    }
    mediaZoomOut(overlay, card, visibleRect(target.origin)).eventCallback("onComplete", onClose);
  };

  // Захват на window: Esc закрывает только плеер, а не окно поиска под ним; I/O ([/]) ставят метки.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopImmediatePropagation();
        close();
        return;
      }
      if (!canMark || !markReady || event.ctrlKey || event.metaKey || event.altKey) return;
      const el = event.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
      if (event.code === "KeyI" || event.key === "[") {
        if (onMarkStart) {
          event.preventDefault();
          mark("start");
        }
      } else if (event.code === "KeyO" || event.key === "]") {
        if (onMarkEnd) {
          event.preventDefault();
          mark("end");
        }
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  return createPortal(
    <div ref={overlayRef} className={`${fetchrThemeClassName} ${styles.overlay}`} role="presentation" {...backdropDismiss(close)}>
      <div
        ref={(node) => {
          cardRef.current = node;
          trapRef.current = node;
        }}
        className={styles.card}
        role="dialog"
        aria-modal="true"
        aria-label={target.title}
      >
        <div className={styles.stage}>
          {media?.kind === "embed" && (
            <iframe
              ref={iframeRef}
              className={styles.frame}
              src={media.src}
              title={target.title}
              allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
              allowFullScreen
            />
          )}
          {media?.kind === "hls" && (
            <HlsPlayer ref={hlsRef} src={media.src} className={styles.player} autoPlay hotkeys overlayControls />
          )}
          {!media && (
            <div className={styles.poster}>
              {target.thumbnailUrl && <img src={target.thumbnailUrl} alt="" />}
              <span className={styles.status}>
                {error ? (
                  <>
                    <RedesignIcon name="alert" className="size-4" />
                    {error}
                  </>
                ) : (
                  <>
                    <span className={styles.spinner} />
                    Загружаю превью…
                  </>
                )}
              </span>
            </div>
          )}
        </div>
        <div className={styles.bar}>
          <div className={styles.caption}>
            <b title={target.title}>
              {target.live && <i className={styles.liveDot} />}
              {target.title}
            </b>
            {(marked ?? target.subtitle) && <span>{marked ?? target.subtitle}</span>}
          </div>
          {canMark && (
            <div className={styles.marks}>
              {onMarkStart && (
                <button
                  type="button"
                  className={styles.mark}
                  onClick={() => mark("start")}
                  disabled={!markReady}
                  title="Начало фрагмента — текущая позиция (клавиша I или [)"
                >
                  <RedesignIcon name="time" className="size-3.5" />
                  {currentStart ? `Начало: ${currentStart}` : "Начало"}
                  <kbd className={styles.markKbd}>I</kbd>
                </button>
              )}
              {onMarkEnd && (
                <button
                  type="button"
                  className={styles.mark}
                  onClick={() => mark("end")}
                  disabled={!markReady}
                  title="Конец фрагмента — текущая позиция (клавиша O или ])"
                >
                  <RedesignIcon name="time" className="size-3.5" />
                  {currentEnd ? `Конец: ${currentEnd}` : "Конец"}
                  <kbd className={styles.markKbd}>O</kbd>
                </button>
              )}
              {onAddExtraRange && Boolean(currentStart || currentEnd) && (
                <button
                  type="button"
                  className={styles.mark}
                  onClick={() => {
                    onAddExtraRange();
                    setMarked("Фрагмент сохранён — отметь следующий");
                  }}
                  title="Сохранить этот отрезок и разметить ещё один фрагмент"
                >
                  + Фрагмент{extraCount ? ` (${extraCount})` : ""}
                </button>
              )}
            </div>
          )}
          <button type="button" className={styles.close} onClick={close} aria-label="Закрыть">
            <RedesignIcon name="close" className="size-4" />
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** Прямоугольник миниатюры, если она ещё видна на экране. */
function visibleRect(element: HTMLElement | null | undefined): DOMRect | null {
  if (!element || !element.isConnected) return null;
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0 ? rect : null;
}
