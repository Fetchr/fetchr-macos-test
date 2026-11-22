import { useRef, useState, type CSSProperties, type PointerEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { LocalImage } from "@/components/local-image";
import { cn } from "@/lib/utils";
import type { BlurZone, ImageFit } from "@/types/job";
import { RedesignIcon } from "@/ui/redesign/icons/iconMap";

import styles from "./SponsorBlurPage.module.css";
import { SponsorZoneEffect } from "./SponsorZoneEffect";

const DESIGN_WIDTH = 1920;
const DESIGN_HEIGHT = 1080;
const MIN_ZONE_SIZE = 24;

type DragMode = "move" | "resize";
type Edge = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";
const EDGES: Edge[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];

interface DragState {
  mode: DragMode;
  edge: Edge;
  pointerId: number;
  zoneId: string;
  startClientX: number;
  startClientY: number;
  startX: number;
  startY: number;
  startWidth: number;
  startHeight: number;
  /** Сдвинули ли зону: просто клик без сдвига открывает её панель. */
  moved: boolean;
}

interface DrawState {
  pointerId: number;
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
}

interface SponsorZoneOverlayProps {
  zones: BlurZone[];
  selectedId: string | null;
  showZones: boolean;
  showGrid: boolean;
  drawingEnabled?: boolean;
  /** Stretch over the parent instead of owning a 16:9 box of its own - used
   *  when the overlay sits on top of the video player surface. */
  absolute?: boolean;
  children?: ReactNode;
  getZoneName: (zone: BlurZone, index: number) => string;
  onSelectZone: (id: string) => void;
  onChangeZone: (id: string, patch: Partial<BlurZone>) => void;
  onCreateZone?: (rect: Pick<BlurZone, "x" | "y" | "width" | "height">) => void;
  /** Кадр для живой мозаики; для видео его нет. */
  frameSrc?: string | null;
  onDeleteZone?: (id: string) => void;
  onDuplicateZone?: (id: string) => void;
}

const ZONE_COLORS = ["#a78bfa", "#2fd49b", "#f2a93b", "#3d7dff", "#f0506e", "#31d0c5"];

export function SponsorZoneOverlay({
  zones,
  selectedId,
  showZones,
  showGrid,
  drawingEnabled = false,
  absolute = false,
  children,
  onSelectZone,
  onChangeZone,
  onCreateZone,
  frameSrc = null,
  onDeleteZone,
  onDuplicateZone,
}: SponsorZoneOverlayProps) {
  const { t } = useTranslation();
  const frameRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const [draw, setDraw] = useState<DrawState | null>(null);
  // Панель формы и эффекта открывается кликом по зоне, а не висит поверх кадра всё время.
  const [toolbarFor, setToolbarFor] = useState<string | null>(null);

  const startDrag = (event: PointerEvent, zone: BlurZone, mode: DragMode, edge: Edge = "se") => {
    if (drawingEnabled) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    onSelectZone(zone.id);
    dragRef.current = {
      mode,
      edge,
      pointerId: event.pointerId,
      zoneId: zone.id,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startX: zone.x,
      startY: zone.y,
      startWidth: zone.width,
      startHeight: zone.height,
      moved: false,
    };
  };

  const startDraw = (event: PointerEvent<HTMLDivElement>) => {
    if (!drawingEnabled || !onCreateZone) return;
    const point = clientToDesignPoint(event);
    if (!point) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    setDraw({
      pointerId: event.pointerId,
      startX: point.x,
      startY: point.y,
      currentX: point.x,
      currentY: point.y,
    });
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (draw?.pointerId === event.pointerId) {
      const point = clientToDesignPoint(event);
      if (point) {
        setDraw((current) => current && { ...current, currentX: point.x, currentY: point.y });
      }
      return;
    }

    const drag = dragRef.current;
    const frame = frameRef.current;
    if (!drag || !frame || drag.pointerId !== event.pointerId) return;

    if (Math.hypot(event.clientX - drag.startClientX, event.clientY - drag.startClientY) > 3) drag.moved = true;
    const scale = DESIGN_WIDTH / frame.getBoundingClientRect().width;
    const dx = Math.round((event.clientX - drag.startClientX) * scale);
    const dy = Math.round((event.clientY - drag.startClientY) * scale);

    if (drag.mode === "move") {
      onChangeZone(drag.zoneId, { x: drag.startX + dx, y: drag.startY + dy });
      return;
    }

    // Тянем за любую из восьми точек: противоположная сторона остаётся на месте.
    let { startX: x, startY: y, startWidth: width, startHeight: height } = drag;
    if (drag.edge.includes("e")) width = Math.max(MIN_ZONE_SIZE, drag.startWidth + dx);
    if (drag.edge.includes("s")) height = Math.max(MIN_ZONE_SIZE, drag.startHeight + dy);
    if (drag.edge.includes("w")) {
      width = Math.max(MIN_ZONE_SIZE, drag.startWidth - dx);
      x = drag.startX + (drag.startWidth - width);
    }
    if (drag.edge.includes("n")) {
      height = Math.max(MIN_ZONE_SIZE, drag.startHeight - dy);
      y = drag.startY + (drag.startHeight - height);
    }
    onChangeZone(drag.zoneId, { x, y, width, height });
  };

  const stopDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (draw?.pointerId === event.pointerId) {
      const rect = drawToRect(draw);
      setDraw(null);
      try {
        event.currentTarget.releasePointerCapture(event.pointerId);
      } catch {
        /* pointer capture may already be released */
      }
      if (rect.width >= MIN_ZONE_SIZE && rect.height >= MIN_ZONE_SIZE) {
        onCreateZone?.(rect);
      }
      return;
    }

    const drag = dragRef.current;
    if (drag?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    if (drag.mode === "move") {
      setToolbarFor((current) => (drag.moved ? null : current === drag.zoneId ? null : drag.zoneId));
    }
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      /* pointer capture may already be released */
    }
  };

  const drawRect = draw ? drawToRect(draw) : null;
  const selected = zones.find((zone) => zone.id === selectedId) ?? null;

  return (
    <div
      ref={frameRef}
      className={cn(
        styles.previewFrame,
        absolute && styles.previewFrameOverlay,
        drawingEnabled && styles.previewFrameDrawing,
      )}
      style={{ containerType: "inline-size" }}
      onPointerDown={(event) => {
        if (!(event.target as HTMLElement).closest("[data-no-pan]")) setToolbarFor(null);
        startDraw(event);
      }}
      onPointerMove={onPointerMove}
      onPointerUp={stopDrag}
      onPointerCancel={stopDrag}
    >
      {children}
      {showGrid && <div className={styles.gridOverlay} />}
      {showZones && zones.map((zone) => <SponsorZoneEffect key={`fx-${zone.id}`} zone={zone} frameSrc={frameSrc} />)}
      {showZones &&
        zones.map((zone, index) => {
          const color = ZONE_COLORS[index % ZONE_COLORS.length];
          return (
            <div
              key={zone.id}
              className={cn(
                styles.zone,
                selectedId === zone.id && styles.zoneSelected,
                !zone.enabled && styles.zoneHidden,
                drawingEnabled && styles.zoneDrawingDisabled,
              )}
              style={{
                "--zone-color": color,
                left: `${(zone.x / DESIGN_WIDTH) * 100}%`,
                top: `${(zone.y / DESIGN_HEIGHT) * 100}%`,
                width: `${(zone.width / DESIGN_WIDTH) * 100}%`,
                height: `${(zone.height / DESIGN_HEIGHT) * 100}%`,
                // Mirror the rendered mask so the editor shows the real
                // silhouette rather than always a hard rectangle.
                borderRadius: zone.shape === "ellipse" ? "50%" : undefined,
                opacity: zone.enabled ? Math.max(0.35, zone.opacity ?? 1) : undefined,
              } as CSSProperties}
              data-no-pan
              onPointerDown={(event) => startDrag(event, zone, "move")}
            >
              {zone.effect === "image_overlay" && zone.image_path ? (
                <LocalImage
                  path={zone.image_path}
                  className={cn(styles.zoneImage, imageFitClass(zone.image_fit))}
                  draggable={false}
                />
              ) : null}
              {selectedId === zone.id &&
                !drawingEnabled &&
                EDGES.map((edge) => (
                  <button
                    key={edge}
                    type="button"
                    aria-label={`${t("sponsor_blur.resize_zone", "Изменить размер зоны")} (${edge})`}
                    className={cn(styles.zoneHandle, styles[`handle_${edge}`])}
                    onPointerDown={(event) => {
                      event.stopPropagation();
                      startDrag(event, zone, "resize", edge);
                    }}
                  />
                ))}
            </div>
          );
        })}
      {showZones && selected && toolbarFor === selected.id && (
        <div
          className={styles.zoneToolbar}
          data-no-pan
          style={{
            left: `${(Math.min(selected.x, DESIGN_WIDTH - 360) / DESIGN_WIDTH) * 100}%`,
            top: `${((selected.y < 130 ? selected.y + selected.height : selected.y) / DESIGN_HEIGHT) * 100}%`,
            transform: selected.y < 130 ? "translateY(8px)" : "translateY(calc(-100% - 8px))",
          }}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <button type="button" className={cn(styles.toolbarButton, (selected.shape ?? "rectangle") === "rectangle" && styles.toolbarOn)} onClick={() => onChangeZone(selected.id, { shape: "rectangle" })} title="Прямоугольник">▭</button>
          <button type="button" className={cn(styles.toolbarButton, selected.shape === "ellipse" && styles.toolbarOn)} onClick={() => onChangeZone(selected.id, { shape: "ellipse" })} title="Эллипс">◯</button>
          <span className={styles.toolbarDivider} />
          <button type="button" className={cn(styles.toolbarButton, selected.effect === "gaussian_blur" && styles.toolbarOn)} onClick={() => onChangeZone(selected.id, { effect: "gaussian_blur" })}>Блюр</button>
          <button type="button" className={cn(styles.toolbarButton, selected.effect === "mosaic" && styles.toolbarOn)} onClick={() => onChangeZone(selected.id, { effect: "mosaic" })}>Мозаика</button>
          {(onDuplicateZone || onDeleteZone) && <span className={styles.toolbarDivider} />}
          {onDuplicateZone && <button type="button" className={styles.toolbarButton} onClick={() => onDuplicateZone(selected.id)} title="Дублировать"><RedesignIcon name="copy" className="size-3.5" /></button>}
          {onDeleteZone && <button type="button" className={styles.toolbarButton} onClick={() => onDeleteZone(selected.id)} title="Удалить зону"><RedesignIcon name="trash" className="size-3.5" /></button>}
        </div>
      )}
      {drawRect && (
        <div
          className={styles.drawSelection}
          style={{
            left: `${(drawRect.x / DESIGN_WIDTH) * 100}%`,
            top: `${(drawRect.y / DESIGN_HEIGHT) * 100}%`,
            width: `${(drawRect.width / DESIGN_WIDTH) * 100}%`,
            height: `${(drawRect.height / DESIGN_HEIGHT) * 100}%`,
          }}
        />
      )}
    </div>
  );

  function clientToDesignPoint(event: PointerEvent<HTMLDivElement>) {
    const frame = frameRef.current;
    if (!frame) return null;
    const rect = frame.getBoundingClientRect();
    const x = Math.round(((event.clientX - rect.left) / rect.width) * DESIGN_WIDTH);
    const y = Math.round(((event.clientY - rect.top) / rect.height) * DESIGN_HEIGHT);
    return {
      x: Math.min(DESIGN_WIDTH, Math.max(0, x)),
      y: Math.min(DESIGN_HEIGHT, Math.max(0, y)),
    };
  }
}

function drawToRect(draw: DrawState): Pick<BlurZone, "x" | "y" | "width" | "height"> {
  const x1 = Math.min(draw.startX, draw.currentX);
  const y1 = Math.min(draw.startY, draw.currentY);
  const x2 = Math.max(draw.startX, draw.currentX);
  const y2 = Math.max(draw.startY, draw.currentY);
  return {
    x: Math.min(DESIGN_WIDTH - MIN_ZONE_SIZE, Math.max(0, x1)),
    y: Math.min(DESIGN_HEIGHT - MIN_ZONE_SIZE, Math.max(0, y1)),
    width: Math.min(DESIGN_WIDTH - x1, Math.max(0, x2 - x1)),
    height: Math.min(DESIGN_HEIGHT - y1, Math.max(0, y2 - y1)),
  };
}

export function clampSponsorZone(zone: BlurZone): BlurZone {
  const width = Math.min(DESIGN_WIDTH, Math.max(MIN_ZONE_SIZE, Math.round(zone.width)));
  const height = Math.min(DESIGN_HEIGHT, Math.max(MIN_ZONE_SIZE, Math.round(zone.height)));
  const x = Math.min(DESIGN_WIDTH - width, Math.max(0, Math.round(zone.x)));
  const y = Math.min(DESIGN_HEIGHT - height, Math.max(0, Math.round(zone.y)));
  return {
    ...zone,
    x,
    y,
    width,
    height,
    intensity: Math.max(1, Math.min(100, Number(zone.intensity) || 1)),
    image_fit: zone.image_fit ?? "contain",
  };
}

function imageFitClass(value: ImageFit | null | undefined) {
  if (value === "cover") return styles.fitCover;
  if (value === "stretch") return styles.fitStretch;
  return styles.fitContain;
}
