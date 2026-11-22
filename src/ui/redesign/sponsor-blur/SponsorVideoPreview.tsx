import { useEffect, useState, type ReactNode, type Ref } from "react";
import { useTranslation } from "react-i18next";
import { LocalImage } from "@/components/local-image";
import { BlurDemo, DemoSlot } from "@/ui/redesign/demos/DemoSlot";
import { EditorPlayer } from "@/components/editor-player";
import type { HlsPlayerHandle } from "@/components/hls-player";
import { convertFileSrc } from "@tauri-apps/api/core";

import type { BlurShape, BlurZone } from "@/types/job";
import { RedesignIcon } from "@/ui/redesign/icons/iconMap";
import { RemoteImage } from "@/ui/redesign/media/RemoteImage";

import styles from "./SponsorBlurPage.module.css";
import { SponsorZoneOverlay } from "./SponsorZoneOverlay";
import { ZoomViewport } from "./ZoomViewport";

export interface SponsorPreviewSource {
  kind: "local" | "url";
  src: string;
}

export type SponsorPreviewMode = "frame" | "video";

interface SponsorVideoPreviewProps {
  preview: SponsorPreviewSource | null;
  zones: BlurZone[];
  selectedId: string | null;
  showZones: boolean;
  showGrid: boolean;
  drawingEnabled: boolean;
  frameTime: number | null;
  loading: boolean;
  error: string | null;
  mode: SponsorPreviewMode;
  /** True when a source is configured - gates the video tab. */
  hasSource: boolean;
  /** Resolved playable URL; `null` while the preview session is starting. */
  videoSrc: string | null;
  videoLoading?: boolean;
  playerRef?: Ref<HlsPlayerHandle>;
  onChangeMode: (mode: SponsorPreviewMode) => void;
  /** Pull a full-resolution reference frame at the player's current position. */
  onUseCurrentMoment: () => void;
  /** Drives the timeline playhead while the video plays. */
  onPlayerTime?: (seconds: number) => void;
  /** The player often knows the real duration before the resolver does. */
  onPlayerDuration?: (seconds: number) => void;
  getZoneName: (zone: BlurZone, index: number) => string;
  onSelectZone: (id: string) => void;
  onChangeZone: (id: string, patch: Partial<BlurZone>) => void;
  onCreateZone: (rect: Pick<BlurZone, "x" | "y" | "width" | "height">) => void;
  onAddZone?: (shape: BlurShape) => void;
  onToggleDrawing?: () => void;
  onDeleteZone?: (id: string) => void;
  onDuplicateZone?: (id: string) => void;
}

export function SponsorVideoPreview({
  preview,
  zones,
  selectedId,
  showZones,
  showGrid,
  drawingEnabled,
  frameTime,
  loading,
  error,
  mode,
  hasSource,
  videoSrc,
  videoLoading = false,
  playerRef,
  onChangeMode,
  onUseCurrentMoment,
  onPlayerTime,
  onPlayerDuration,
  getZoneName,
  onSelectZone,
  onChangeZone,
  onCreateZone,
  onAddZone,
  onToggleDrawing,
  onDeleteZone,
  onDuplicateZone,
}: SponsorVideoPreviewProps) {
  const { t } = useTranslation();
  const showVideo = mode === "video" && hasSource;
  const [addOpen, setAddOpen] = useState(false);

  // Меню добавления закрывается по Esc и после выбора, чтобы не висеть над кадром.
  useEffect(() => {
    if (!addOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setAddOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [addOpen]);
  // Мозаику можно нарисовать только по неподвижному кадру.
  const frameSrc = preview ? (preview.kind === "local" ? convertFileSrc(preview.src) : preview.src) : null;

  const zoneLayer = (absolute: boolean, children?: ReactNode) => (
    <SponsorZoneOverlay
      zones={zones}
      selectedId={selectedId}
      showZones={showZones}
      showGrid={showGrid}
      drawingEnabled={drawingEnabled}
      absolute={absolute}
      getZoneName={getZoneName}
      onSelectZone={onSelectZone}
      onChangeZone={onChangeZone}
      onCreateZone={onCreateZone}
      frameSrc={absolute ? null : frameSrc}
      onDeleteZone={onDeleteZone}
      onDuplicateZone={onDuplicateZone}
    >
      {children}
    </SponsorZoneOverlay>
  );

  return (
    <section className={`${styles.panel} ${styles.previewPanel}`}>
      {/* The panel header is hidden by `.previewPanel .panelHeader`, so the
          mode switch floats over the preview instead of living in it. */}
      <div className={styles.panelBody}>
        <div className={styles.previewStack}>
        <div className={styles.previewModeSwitch}>
          <button
            type="button"
            className={`${styles.previewModeButton} ${mode === "frame" ? styles.previewModeButtonActive : ""}`}
            onClick={() => onChangeMode("frame")}
            title={t("sponsor_blur.mode_frame_hint", "Статичный reference-кадр")}
          >
            {t("sponsor_blur.mode_frame", "Кадр")}
          </button>
          <button
            type="button"
            className={`${styles.previewModeButton} ${mode === "video" ? styles.previewModeButtonActive : ""}`}
            onClick={() => onChangeMode("video")}
            disabled={!hasSource}
            title={
              hasSource
                ? t("sponsor_blur.mode_video_hint_on", "Живое видео: скраб, покадрово, горячие клавиши")
                : t("sponsor_blur.mode_video_hint", "Укажите видео, чтобы включить плеер")
            }
          >
            {t("sponsor_blur.mode_video", "Видео")}
          </button>
        </div>
        <ZoomViewport panWithLeft={!drawingEnabled}>
        {showVideo ? (
          videoSrc ? (
            <div className={styles.previewVideoStack}>
              <EditorPlayer
                ref={playerRef}
                src={videoSrc}
                overlay={zoneLayer(true)}
                onTimeUpdate={onPlayerTime}
                onDurationChange={onPlayerDuration}
                onUseMoment={onUseCurrentMoment}
                usingMoment={loading}
              />
            </div>
          ) : (
            <div className={styles.previewFrame}>
              <div className={styles.emptyPreview}>
                {videoLoading
                  ? t("sponsor_blur.preparing_player", "Готовим плеер...")
                  : t("sponsor_blur.mode_video_hint", "Укажите видео, чтобы включить плеер")}
              </div>
            </div>
          )
        ) : (
          zoneLayer(
            false,
            <>
              {preview ? (
                preview.kind === "local" ? (
                  <LocalImage path={preview.src} className={styles.previewImage} draggable={false} />
                ) : (
                  <RemoteImage
                    src={preview.src}
                    alt="Reference frame"
                    fallbackLabel={t("sponsor_blur.frame", "Кадр")}
                    className={styles.previewImage}
                  />
                )
              ) : (
                <div className={styles.emptyPreview}>
                  {!loading && !videoLoading && <DemoSlot demo={BlurDemo} height={268} className={styles.emptyPreviewDemo} />}
                  {loading
                    ? t("sponsor_blur.extracting_frame", "Извлекаем кадр...")
                    : videoLoading
                      ? t("sponsor_blur.loading", "Загрузка")
                      : t("sponsor_blur.preview_hint", "Выберите видео, извлеките кадр или укажите reference URL")}
                </div>
              )}
              <div className={styles.frameMeta}>
                <span>
                  {loading
                    ? t("sponsor_blur.loading", "Загрузка")
                    : frameTime == null
                      ? "00:00:00"
                      : formatTime(frameTime)}
                </span>
                <span>
                  {t("sponsor_blur.blur_zones_count", {
                    count: zones.filter((zone) => zone.enabled).length,
                    defaultValue: `${zones.filter((zone) => zone.enabled).length} blur zones`,
                  })}
                </span>
              </div>
            </>,
          )
        )}
        </ZoomViewport>
        {onAddZone && (
          <div className={styles.addMenu}>
            <button
              type="button"
              className={`${styles.addToggle} ${addOpen ? styles.toolbarOn : ""}`}
              aria-expanded={addOpen}
              onClick={() => setAddOpen((value) => !value)}
            >
              ＋ Зона
            </button>
            {addOpen && (
              <div className={styles.addList} role="menu">
                <button type="button" role="menuitem" className={styles.toolbarButton} onClick={() => { onAddZone("rectangle"); setAddOpen(false); }}>▭ Прямоугольник</button>
                <button type="button" role="menuitem" className={styles.toolbarButton} onClick={() => { onAddZone("ellipse"); setAddOpen(false); }}>◯ Эллипс</button>
                {onToggleDrawing && (
                  <button type="button" role="menuitem" className={`${styles.toolbarButton} ${drawingEnabled ? styles.toolbarOn : ""}`} onClick={() => { onToggleDrawing(); setAddOpen(false); }} title="Обвести область мышкой">
                    <RedesignIcon name="move" className="size-3.5" /> Нарисовать
                  </button>
                )}
              </div>
            )}
          </div>
        )}
        </div>
        {error && <div className={styles.error}>{error}</div>}
      </div>
    </section>
  );
}

function formatTime(value: number) {
  const total = Math.max(0, Math.floor(value));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}
