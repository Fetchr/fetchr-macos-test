import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { HlsPlayer, type HlsPlayerHandle } from "@/components/hls-player";
import { formatDuration } from "@/lib/format";
import { PlatformIcon, RedesignIcon } from "@/ui/redesign/icons/iconMap";
import { RemoteImage } from "@/ui/redesign/media/RemoteImage";
import type { ResolvedStream } from "@/types/job";
import { cn } from "@/lib/utils";
import { ensureYoutubeIframeApi, withYoutubePlayerApi, type YoutubeIframePlayer } from "@/lib/youtube";

import styles from "./AddTaskModal.module.css";

export interface AddTaskPresetSummaryProps {
  sourcePlatform: string;
  sourceLabel: string;
  qualityLabel: string;
  transportLabel?: string | null;
  folder: string;
  sponsorBlurEnabled: boolean;
  rangeCount: number;
  resolved: ResolvedStream | null;
  previewUrl: string | null;
  previewEmbedUrl: string | null;
  previewLoading: boolean;
  previewError: string | null;
  onMarkStart: (value: string) => void;
  onMarkEnd: (value: string) => void;
}

interface YoutubePlayerHandle {
  getCurrentTime: () => number;
}

export function AddTaskPresetSummary({
  sourcePlatform,
  sourceLabel,
  qualityLabel,
  transportLabel,
  folder,
  sponsorBlurEnabled,
  rangeCount,
  resolved,
  previewUrl,
  previewEmbedUrl,
  previewLoading,
  previewError,
  onMarkStart,
  onMarkEnd,
}: AddTaskPresetSummaryProps) {
  const { t } = useTranslation();
  const hlsPlayerRef = useRef<HlsPlayerHandle | null>(null);
  const youtubePlayerRef = useRef<YoutubePlayerHandle | null>(null);
  const [youtubePreviewReady, setYoutubePreviewReady] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const canMarkTime = Boolean(previewUrl || (previewEmbedUrl && youtubePreviewReady));
  const previewPlatform = resolved?.platform || sourcePlatform;

  const mark = (target: "start" | "end") => {
    const seconds = previewEmbedUrl
      ? youtubePlayerRef.current?.getCurrentTime() ?? 0
      : hlsPlayerRef.current?.getCurrentTime() ?? 0;
    const value = formatTimecode(seconds);
    if (target === "start") onMarkStart(value);
    else onMarkEnd(value);
  };

  return (
    <>
      <div className={styles.mediaPreview}>
        {previewEmbedUrl ? (
          <YoutubeEmbedPreview
            ref={youtubePlayerRef}
            src={previewEmbedUrl}
            title={resolved?.title ?? "Preview"}
            onReadyChange={setYoutubePreviewReady}
          />
        ) : previewUrl ? (
          <HlsPlayer ref={hlsPlayerRef} src={previewUrl} className={styles.previewPlayerLarge} />
        ) : resolved?.thumbnail ? (
          <RemoteImage
            src={resolved?.thumbnail}
            alt={resolved?.title ?? sourceLabel}
            platform={previewPlatform}
            aspectRatio="16 / 9"
          />
        ) : (
          <div className={styles.previewCategoryPlaceholder} data-platform={previewPlatform} role="img" aria-label={sourceLabel}>
            <PlatformIcon platform={previewPlatform} className={styles.previewCategoryIcon} strokeWidth={1.6} />
          </div>
        )}
        {previewLoading && (
          <div className={styles.previewOverlay}>
            <RedesignIcon name="loading" className="size-4" />
            {t("add.preview_loading_status", "Загрузка предпросмотра...")}
          </div>
        )}
      </div>

      <div className={styles.rightDetailsGroup}>
        <div className={styles.markButtons}>
          <button className={styles.button} type="button" onClick={() => mark("start")} disabled={!canMarkTime}>
            <RedesignIcon name="time" className="size-4" />
            {t("add.start_btn", "Начало")}
          </button>
          <button className={styles.button} type="button" onClick={() => mark("end")} disabled={!canMarkTime}>
            <RedesignIcon name="time" className="size-4" />
            {t("add.end_btn", "Конец")}
          </button>
        </div>

        {previewError && <div className={styles.previewError}>{previewError}</div>}

        <div className={styles.summaryList}>
          <SummaryRow label={t("add.streamer", "Стример")} value={resolved?.uploader || "—"} />
          <SummaryRow
            label={t("add.duration", "Длительность")}
            value={resolved?.duration ? formatDuration(resolved.duration) : "—"}
            mono
          />
          <SummaryRow label={t("add.source", "Источник")} value={`${sourceLabel} · ${qualityLabel}`} />
          {expanded && (
            <>
              {transportLabel && <SummaryRow label={t("add.threads", "Потоки")} value={transportLabel} />}
              <SummaryRow label={t("add.directory", "Папка")} value={folder || t("settings.footer.not_selected", "Не выбрана")} />
              <SummaryRow
                label={t("add.sponsor_blur", "Блюр спонсоров")}
                value={sponsorBlurEnabled ? t("settings.enabled", "Включен") : t("settings.disabled", "Отключен")}
              />
              <SummaryRow
                label={t("add.clips_timecodes", "Клипы")}
                value={
                  rangeCount > 0
                    ? t("add.clips_count", { count: rangeCount, defaultValue: "{{count}} диапаз." })
                    : t("add.single_range", "single range")
                }
              />
            </>
          )}
        </div>

        <button
          type="button"
          className={styles.expandBtn}
          onClick={() => setExpanded(!expanded)}
        >
          <span>{expanded ? t("add.collapse", "Свернуть") : t("add.expand", "Развернуть")}</span>
          <RedesignIcon name="chevronDown" className={cn("size-3 transition-transform duration-200", expanded && "rotate-180")} />
        </button>
      </div>
    </>
  );
}

const YoutubeEmbedPreview = forwardRef<
  YoutubePlayerHandle,
  { src: string; title: string; onReadyChange: (ready: boolean) => void }
>(function YoutubeEmbedPreview({ src, title, onReadyChange }, ref) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const playerRef = useRef<YoutubeIframePlayer | null>(null);
  const apiSrc = useMemo(() => withYoutubePlayerApi(src), [src]);

  useImperativeHandle(ref, () => ({
    getCurrentTime: () => {
      try {
        return playerRef.current?.getCurrentTime() ?? 0;
      } catch {
        return 0;
      }
    },
  }), []);

  useEffect(() => {
    let cancelled = false;
    onReadyChange(false);
    playerRef.current = null;

    ensureYoutubeIframeApi()
      .then((YT) => {
        if (cancelled || !iframeRef.current) return;
        playerRef.current = new YT.Player(iframeRef.current, {
          events: {
            onReady: () => {
              if (!cancelled) onReadyChange(true);
            },
          },
        });
      })
      .catch(() => {
        if (!cancelled) onReadyChange(false);
      });

    return () => {
      cancelled = true;
      onReadyChange(false);
      try {
        playerRef.current?.destroy?.();
      } catch {
        // YouTube API cleanup is best-effort when the WebView unloads the iframe.
      }
      playerRef.current = null;
    };
  }, [apiSrc, onReadyChange]);

  return (
    <iframe
      ref={iframeRef}
      className={styles.previewFrame}
      src={apiSrc}
      title={title}
      allow="autoplay; encrypted-media; picture-in-picture"
      allowFullScreen
    />
  );
});

function SummaryRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className={styles.summaryRow}>
      <span>{label}</span>
      <span className={cn(styles.summaryValue, mono && styles.summaryValueMono)} title={value}>
        {value}
      </span>
    </div>
  );
}

function formatTimecode(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  const h = Math.floor(safe / 3600);
  const m = Math.floor((safe % 3600) / 60);
  const s = safe % 60;
  return [h, m, s].map((part) => String(part).padStart(2, "0")).join(":");
}
