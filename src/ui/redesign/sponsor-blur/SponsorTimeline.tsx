import {
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useTranslation } from "react-i18next";

import { useLocalImageSrc } from "@/components/local-image";
import { cn } from "@/lib/utils";
import { useSettings, usesSimpleContent } from "@/stores/settings";
import type { SponsorTimelineThumbnails } from "@/lib/ipc";
import type { BlurZone } from "@/types/job";
import { RedesignIcon } from "@/ui/redesign/icons/iconMap";

import styles from "./SponsorTimeline.module.css";
import {
  buildTicks,
  buildZoneTrack,
  clamp,
  clampView,
  formatPlayhead,
  formatTick,
  panBy,
  timeToX,
  xToTime,
  zoomAround,
  type View,
  type ZoneTrack,
} from "./timeline-model";

/** Width of the fixed label column, kept in sync with the CSS. */
const GUTTER_PX = 116;
const GUTTER_COMPACT_PX = 88;
const COLLAPSED_KEY = "fetchr-sponsor-timeline-collapsed";
/** Never draw more filmstrip tiles than this, however far out the user zooms. */
const MAX_VISIBLE_TILES = 240;

type DragKind = "playhead" | "rangeStart" | "rangeEnd" | "pan";

interface DragState {
  kind: DragKind;
  pointerId: number;
  /** Pan only: view/pointer position when the drag started. */
  originX: number;
  originStartSec: number;
}

export interface SponsorTimelineProps {
  /** Окошко ИИ-трекера за иконкой в шапке; получает функцию закрытия. Только в простом режиме. */
  trackerSlot?: (close: () => void) => ReactNode;
  trackerBusy?: boolean;
  durationSec: number;
  currentTimeSec: number;
  /** Fired continuously while scrubbing — cheap updates only. */
  onScrub: (timeSec: number) => void;
  /** Fired once on release — this is where a frame capture belongs. */
  onScrubCommit: (timeSec: number) => void;
  rangeStartSec: number | null;
  rangeEndSec: number | null;
  onRangeChange: (startSec: number | null, endSec: number | null) => void;
  zones: BlurZone[];
  getZoneName: (zone: BlurZone, index: number) => string;
  selectedZoneId: string | null;
  onSelectZone: (id: string) => void;
  /** Per zone: ranges where the tracker lost the banner. */
  zoneGaps: Record<string, [number, number][]>;
  thumbnails: SponsorTimelineThumbnails | null;
  thumbnailsLoading: boolean;
  thumbnailsMessage: string | null;
  onBuildThumbnails: () => void;
  busy: boolean;
  /** Playback transport - only rendered when the video player is driving. */
  playing?: boolean;
  onTogglePlay?: () => void;
  onStep?: (deltaSec: number) => void;
}

export function SponsorTimeline({
  durationSec,
  currentTimeSec,
  onScrub,
  onScrubCommit,
  rangeStartSec,
  rangeEndSec,
  onRangeChange,
  zones,
  getZoneName,
  selectedZoneId,
  onSelectZone,
  zoneGaps,
  thumbnails,
  thumbnailsLoading,
  thumbnailsMessage,
  onBuildThumbnails,
  busy,
  trackerSlot,
  trackerBusy = false,
  playing,
  onTogglePlay,
  onStep,
}: SponsorTimelineProps) {
  const { t } = useTranslation();
  const simple = usesSimpleContent(useSettings((state) => state.uiMode));
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(COLLAPSED_KEY) === "1";
    } catch {
      return false;
    }
  });
  const [trackerOpen, setTrackerOpen] = useState(false);
  const folded = simple && collapsed;
  const panelClass = cn(styles.panel, simple && styles.compact, folded && styles.folded);
  const toggleCollapsed = () =>
    setCollapsed((value) => {
      try {
        localStorage.setItem(COLLAPSED_KEY, value ? "0" : "1");
      } catch {
        // без хранилища свёрнутость просто не запоминается
      }
      return !value;
    });
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  const [view, setView] = useState<View>({ startSec: 0, spanSec: durationSec, widthPx: 0 });
  const dragRef = useRef<DragState | null>(null);
  const spriteSrc = useLocalImageSrc(thumbnails?.path);

  // Track the drawing area's width; every coordinate below depends on it.
  useLayoutEffect(() => {
    const element = canvasRef.current;
    if (!element) return;
    const observer = new ResizeObserver((entries) => {
      const next = entries[0]?.contentRect.width ?? 0;
      setWidth(next);
    });
    observer.observe(element);
    setWidth(element.clientWidth);
    return () => observer.disconnect();
  }, []);

  // A new video resets the viewport to "whole timeline".
  useEffect(() => {
    setView((current) => clampView({ ...current, startSec: 0, spanSec: durationSec }, durationSec));
  }, [durationSec]);

  const activeView = useMemo<View>(
    () => clampView({ ...view, widthPx: width }, durationSec),
    [view, width, durationSec],
  );

  const tracks = useMemo<ZoneTrack[]>(() => {
    return zones
      .map((zone, index) => buildZoneTrack(zone, getZoneName(zone, index), zoneGaps[zone.id]))
      .filter((track): track is ZoneTrack => track !== null);
  }, [zones, getZoneName, zoneGaps]);

  const ticks = useMemo(() => buildTicks(activeView, durationSec), [activeView, durationSec]);

  const applyView = useCallback(
    (next: View) => setView(clampView(next, durationSec)),
    [durationSec],
  );

  const localX = useCallback((clientX: number) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    return rect ? clientX - rect.left : 0;
  }, []);

  const timeAt = useCallback(
    (clientX: number) => clamp(xToTime(activeView, localX(clientX)), 0, durationSec),
    [activeView, durationSec, localX],
  );

  // ---- wheel: zoom at the cursor, or pan with shift ----
  useEffect(() => {
    const element = canvasRef.current;
    if (!element) return;
    // Registered natively because React's onWheel is passive and cannot
    // preventDefault, which would let the page scroll while zooming.
    const onWheel = (event: WheelEvent) => {
      if (durationSec <= 0) return;
      event.preventDefault();
      const rect = element.getBoundingClientRect();
      const x = event.clientX - rect.left;
      if (event.shiftKey) {
        const delta = (event.deltaY || event.deltaX) / rect.width;
        applyView(panBy(activeView, delta * activeView.spanSec, durationSec));
        return;
      }
      applyView(zoomAround(activeView, x, event.deltaY > 0 ? 1.2 : 1 / 1.2, durationSec));
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, [activeView, applyView, durationSec]);

  // ---- pointer drags ----
  const beginDrag = (event: ReactPointerEvent<HTMLElement>, kind: DragKind) => {
    if (durationSec <= 0) return;
    event.preventDefault();
    event.stopPropagation();
    (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
    dragRef.current = {
      kind,
      pointerId: event.pointerId,
      originX: localX(event.clientX),
      originStartSec: activeView.startSec,
    };
    if (kind === "playhead") onScrub(timeAt(event.clientX));
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.preventDefault();
    const time = timeAt(event.clientX);
    switch (drag.kind) {
      case "playhead":
        onScrub(time);
        break;
      case "rangeStart":
        onRangeChange(Math.min(time, rangeEndSec ?? durationSec), rangeEndSec);
        break;
      case "rangeEnd":
        onRangeChange(rangeStartSec, Math.max(time, rangeStartSec ?? 0));
        break;
      case "pan": {
        const moved = localX(event.clientX) - drag.originX;
        const seconds = (moved / Math.max(activeView.widthPx, 1)) * activeView.spanSec;
        applyView({ ...activeView, startSec: drag.originStartSec - seconds });
        break;
      }
    }
  };

  const endDrag = (event: ReactPointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    (event.currentTarget as HTMLElement).releasePointerCapture?.(event.pointerId);
    // Frame extraction is expensive, so it happens once, here — not per move.
    if (drag.kind === "playhead") onScrubCommit(timeAt(event.clientX));
  };

  const onCanvasPointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    // Middle button or alt+drag pans, like most editors.
    const pan = event.button === 1 || event.altKey;
    beginDrag(event, pan ? "pan" : "playhead");
  };

  const zoomFit = () => applyView({ ...activeView, startSec: 0, spanSec: durationSec });
  const zoomStep = (factor: number) =>
    applyView(zoomAround(activeView, activeView.widthPx / 2, factor, durationSec));

  const playheadX = timeToX(activeView, currentTimeSec);
  const playheadVisible = playheadX >= -1 && playheadX <= activeView.widthPx + 1;
  const hasRange = rangeStartSec !== null || rangeEndSec !== null;

  if (durationSec <= 0) {
    return (
      <section className={panelClass}>
        <div className={styles.emptyState}>
          <RedesignIcon name="time" />
          <span>
            {t(
              "sponsor_blur.timeline_needs_duration",
              "Таймлайн появится после загрузки видео с известной длительностью (для live недоступен).",
            )}
          </span>
        </div>
      </section>
    );
  }

  return (
    <section className={panelClass}>
      <header className={styles.header}>
        <div className={styles.title}>
          {simple && (
            <button
              type="button"
              className={styles.iconButton}
              onClick={toggleCollapsed}
              aria-expanded={!collapsed}
              title={collapsed ? "Развернуть таймлайн" : "Свернуть таймлайн"}
              aria-label={collapsed ? "Развернуть таймлайн" : "Свернуть таймлайн"}
            >
              <RedesignIcon name={collapsed ? "chevronUp" : "chevronDown"} className="size-4" />
            </button>
          )}
          <RedesignIcon name="time" />
          <span>{t("sponsor_blur.timeline_title", "Таймлайн")}</span>
        </div>
        <div className={styles.headerRight}>
          {trackerSlot && (
            <button
              type="button"
              className={cn(styles.trackerButton, (trackerOpen || trackerBusy) && styles.trackerButtonActive)}
              onClick={() => setTrackerOpen((value) => !value)}
              aria-expanded={trackerOpen}
              aria-label="ИИ-трекер"
              title="ИИ-трекер: настройки и запуск"
            >
              <RedesignIcon name={trackerBusy ? "loading" : "sparkle"} className={cn("size-4", trackerBusy && "animate-spin")} />
            </button>
          )}
          {onTogglePlay && (
            <div className={styles.zoomGroup}>
              <button
                type="button"
                className={styles.iconButton}
                onClick={() => onStep?.(-5)}
                title={t("sponsor_blur.timeline_back", "Назад 5 с (←)")}
              >
                −5s
              </button>
              <button
                type="button"
                className={styles.iconButton}
                onClick={onTogglePlay}
                title={t("sponsor_blur.timeline_play", "Воспроизведение / пауза (Space)")}
              >
                <RedesignIcon name={playing ? "pause" : "play"} />
              </button>
              <button
                type="button"
                className={styles.iconButton}
                onClick={() => onStep?.(5)}
                title={t("sponsor_blur.timeline_forward", "Вперёд 5 с (→)")}
              >
                +5s
              </button>
            </div>
          )}
          <div className={styles.zoomGroup}>
            <button
              type="button"
              className={styles.iconButton}
              onClick={() => onRangeChange(currentTimeSec, rangeEndSec)}
              title={t("sponsor_blur.timeline_mark_start", "Отметить начало диапазона по плейхеду")}
            >
              {t("sponsor_blur.timeline_mark_start_short", "От")}
            </button>
            <button
              type="button"
              className={styles.iconButton}
              onClick={() => onRangeChange(rangeStartSec, currentTimeSec)}
              title={t("sponsor_blur.timeline_mark_end", "Отметить конец диапазона по плейхеду")}
            >
              {t("sponsor_blur.timeline_mark_end_short", "До")}
            </button>
          </div>
          <span className={styles.readout}>
            {formatPlayhead(currentTimeSec, activeView.spanSec)}
            <span className={styles.readoutDim}> / {formatPlayhead(durationSec, durationSec)}</span>
          </span>
          <div className={styles.zoomGroup}>
            <button
              type="button"
              className={styles.iconButton}
              onClick={() => zoomStep(1.5)}
              title={t("sponsor_blur.timeline_zoom_out", "Отдалить (колесо вниз)")}
            >
              −
            </button>
            <button
              type="button"
              className={styles.iconButton}
              onClick={zoomFit}
              title={t("sponsor_blur.timeline_fit", "Вписать весь стрим")}
            >
              <RedesignIcon name="expand" />
            </button>
            <button
              type="button"
              className={styles.iconButton}
              onClick={() => zoomStep(1 / 1.5)}
              title={t("sponsor_blur.timeline_zoom_in", "Приблизить (колесо вверх)")}
            >
              +
            </button>
          </div>
          <button
            type="button"
            className={styles.textButton}
            onClick={onBuildThumbnails}
            disabled={thumbnailsLoading}
            title={t("sponsor_blur.timeline_thumbs_tooltip", "Построить ленту кадров по всему видео")}
           aria-busy={thumbnailsLoading}>
            <RedesignIcon
              name={thumbnailsLoading ? "loading" : "image"}
              className={thumbnailsLoading ? "animate-spin" : undefined}
            />
            <span>
              {thumbnails
                ? t("sponsor_blur.timeline_thumbs_refresh", "Обновить ленту")
                : t("sponsor_blur.timeline_thumbs", "Лента кадров")}
            </span>
          </button>
        </div>
      </header>

      <div className={styles.body}>
        <div className={styles.gutter} style={{ width: simple ? GUTTER_COMPACT_PX : GUTTER_PX }}>
          <div className={`${styles.gutterCell} ${styles.gutterRuler}`}>
            {t("sponsor_blur.timeline_time", "Время")}
          </div>
          <div className={`${styles.gutterCell} ${styles.gutterFilm}`}>
            {t("sponsor_blur.timeline_film", "Кадры")}
          </div>
          {tracks.map((track) => (
            <button
              key={track.zoneId}
              type="button"
              className={`${styles.gutterCell} ${styles.gutterZone} ${
                track.zoneId === selectedZoneId ? styles.gutterZoneActive : ""
              }`}
              onClick={() => onSelectZone(track.zoneId)}
              title={track.name}
            >
              <span className={styles.zoneDot} />
              <span className={styles.zoneName}>{track.name}</span>
            </button>
          ))}
          {tracks.length === 0 && (
            <div className={`${styles.gutterCell} ${styles.gutterZone} ${styles.gutterMuted}`}>
              {t("sponsor_blur.timeline_no_tracks", "Нет трекинга")}
            </div>
          )}
          <div className={`${styles.gutterCell} ${styles.gutterRange}`}>
            {t("sponsor_blur.timeline_range", "Диапазон")}
          </div>
        </div>

        <div
          ref={canvasRef}
          className={styles.canvas}
          onPointerDown={onCanvasPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onDoubleClick={zoomFit}
        >
          {/* ---- ruler ---- */}
          <div className={`${styles.row} ${styles.ruler}`}>
            {ticks.map((tick) => (
              <div
                key={`${tick.timeSec}-${tick.major}`}
                className={tick.major ? styles.tickMajor : styles.tickMinor}
                style={{ left: tick.x }}
              >
                {tick.major && (
                  <span className={styles.tickLabel}>{formatTick(tick.timeSec, durationSec)}</span>
                )}
              </div>
            ))}
          </div>

          {/* ---- filmstrip ---- */}
          <div className={`${styles.row} ${styles.filmRow}`}>
            <FilmStrip
              thumbnails={thumbnails}
              spriteSrc={spriteSrc}
              view={activeView}
              durationSec={durationSec}
            />
            {!thumbnails && (
              <div className={styles.filmPlaceholder}>
                {thumbnailsLoading
                  ? (thumbnailsMessage ??
                    t("sponsor_blur.timeline_thumbs_loading", "Строим ленту кадров..."))
                  : t("sponsor_blur.timeline_thumbs_hint", "Нажмите «Лента кадров»")}
              </div>
            )}
          </div>

          {/* ---- one lane per tracked zone ---- */}
          {tracks.map((track) => (
            <div
              key={track.zoneId}
              className={`${styles.row} ${styles.zoneRow} ${
                track.zoneId === selectedZoneId ? styles.zoneRowActive : ""
              }`}
            >
              <div
                className={styles.trackSpan}
                style={{
                  left: timeToX(activeView, track.startSec),
                  width: Math.max(
                    1,
                    timeToX(activeView, track.endSec) - timeToX(activeView, track.startSec),
                  ),
                }}
              />
              {track.visible.map((segment) => {
                const left = timeToX(activeView, segment.startSec);
                const right = timeToX(activeView, segment.endSec);
                if (right < -4 || left > activeView.widthPx + 4) return null;
                return (
                  <div
                    key={`v-${segment.startSec}`}
                    className={styles.segment}
                    style={{
                      left,
                      width: Math.max(2, right - left),
                      // Weak matches read as washed out, strong ones as solid.
                      opacity: 0.45 + 0.55 * clamp(segment.confidence, 0, 1),
                    }}
                    onPointerDown={(event) => {
                      event.stopPropagation();
                      onSelectZone(track.zoneId);
                    }}
                    title={`${formatTick(segment.startSec, durationSec)} – ${formatTick(
                      segment.endSec,
                      durationSec,
                    )} · ${Math.round(segment.confidence * 100)}%`}
                  />
                );
              })}
              {track.gaps.map((segment) => {
                const left = timeToX(activeView, segment.startSec);
                const right = timeToX(activeView, segment.endSec);
                if (right < -4 || left > activeView.widthPx + 4) return null;
                return (
                  <div
                    key={`g-${segment.startSec}`}
                    className={styles.gap}
                    style={{ left, width: Math.max(2, right - left) }}
                    title={t("sponsor_blur.timeline_gap_tooltip", {
                      from: formatTick(segment.startSec, durationSec),
                      to: formatTick(segment.endSec, durationSec),
                      defaultValue: `Баннер не найден: ${formatTick(
                        segment.startSec,
                        durationSec,
                      )} – ${formatTick(segment.endSec, durationSec)}`,
                    })}
                  />
                );
              })}
            </div>
          ))}
          {tracks.length === 0 && <div className={`${styles.row} ${styles.zoneRow}`} />}

          {/* ---- tracking range ---- */}
          <div className={`${styles.row} ${styles.rangeRow}`}>
            {hasRange && (
              <div
                className={styles.rangeFill}
                style={{
                  left: timeToX(activeView, rangeStartSec ?? 0),
                  width: Math.max(
                    2,
                    timeToX(activeView, rangeEndSec ?? durationSec) -
                      timeToX(activeView, rangeStartSec ?? 0),
                  ),
                }}
              />
            )}
            <div
              className={`${styles.rangeHandle} ${styles.rangeHandleStart}`}
              style={{ left: timeToX(activeView, rangeStartSec ?? 0) }}
              onPointerDown={(event) => beginDrag(event, "rangeStart")}
              onPointerMove={onPointerMove}
              onPointerUp={endDrag}
              title={t("sponsor_blur.timeline_range_start", "Начало трекинга")}
            />
            <div
              className={`${styles.rangeHandle} ${styles.rangeHandleEnd}`}
              style={{ left: timeToX(activeView, rangeEndSec ?? durationSec) }}
              onPointerDown={(event) => beginDrag(event, "rangeEnd")}
              onPointerMove={onPointerMove}
              onPointerUp={endDrag}
              title={t("sponsor_blur.timeline_range_end", "Конец трекинга")}
            />
          </div>

          {/* ---- playhead ---- */}
          {playheadVisible && (
            <div
              className={`${styles.playhead} ${busy ? styles.playheadBusy : ""}`}
              style={{ left: playheadX }}
            >
              <div className={styles.playheadGrip} onPointerDown={(event: ReactPointerEvent<HTMLElement>) => beginDrag(event, "playhead")} />
            </div>
          )}
        </div>
      </div>

      {trackerSlot && trackerOpen && (
        <div className={styles.trackerPop} role="dialog" aria-label="ИИ-трекер">
          {trackerSlot(() => setTrackerOpen(false))}
        </div>
      )}

      <footer className={styles.footer}>
        <span className={styles.legend}>
          <i className={styles.legendVisible} />
          {t("sponsor_blur.timeline_legend_visible", "баннер найден")}
        </span>
        <span className={styles.legend}>
          <i className={styles.legendGap} />
          {t("sponsor_blur.timeline_legend_gap", "потерян")}
        </span>
        <span className={styles.hint}>
          {t(
            "sponsor_blur.timeline_hint",
            "колесо — зум · shift+колесо — прокрутка · alt+перетаскивание — панорама · двойной клик — весь стрим",
          )}
        </span>
      </footer>
    </section>
  );
}

/**
 * Draws the sprite one tile at a time.
 *
 * Stretching the whole sprite across the timeline in a single element would be
 * simpler, but at high zoom that element becomes millions of pixels wide and
 * the browser's background scaling falls apart. Only the tiles inside the
 * viewport are rendered instead, so cost is bounded by screen width.
 */
function FilmStrip({
  thumbnails,
  spriteSrc,
  view,
  durationSec,
}: {
  thumbnails: SponsorTimelineThumbnails | null;
  spriteSrc: string | null;
  view: View;
  durationSec: number;
}) {
  if (!thumbnails || !spriteSrc || thumbnails.count <= 0 || view.widthPx <= 0) return null;
  const slotSec = durationSec / thumbnails.count;
  const slotPx = (slotSec / view.spanSec) * view.widthPx;
  if (!Number.isFinite(slotPx) || slotPx <= 0) return null;

  const first = Math.max(0, Math.floor(view.startSec / slotSec));
  const last = Math.min(
    thumbnails.count - 1,
    Math.ceil((view.startSec + view.spanSec) / slotSec),
    first + MAX_VISIBLE_TILES,
  );

  const tiles = [];
  for (let index = first; index <= last; index += 1) {
    tiles.push(
      <div
        key={index}
        className={styles.filmTile}
        style={{
          left: timeToX(view, index * slotSec),
          width: Math.ceil(slotPx) + 1,
          backgroundImage: `url(${spriteSrc})`,
          // Scale the strip so one tile is exactly `slotPx` wide, then shift it
          // so tile `index` lands in this slot.
          backgroundSize: `${thumbnails.count * slotPx}px 100%`,
          backgroundPosition: `${-index * slotPx}px 0`,
        }}
      />,
    );
  }
  return <>{tiles}</>;
}
