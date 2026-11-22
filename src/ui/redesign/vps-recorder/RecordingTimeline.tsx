import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent } from "react";

import type { VpsRecordingMeta } from "@/lib/ipc";
import { cn } from "@/lib/utils";
import { RedesignIcon } from "@/ui/redesign/icons/iconMap";

import { ChatHeatLayer } from "./ChatHeatLayer";
import { nextPeak, type ChatHeat, type ChatPeak } from "./chatHeat";
import { fmtCount, fmtDuration } from "./format";

export type RangePreset = "last30" | "last300" | "all";
import {
  clampView,
  formatTick,
  minorTicksFor,
  panBy,
  tickStep,
  ticksFor,
  zoomAt,
  type View,
} from "./timelineScale";
import { ArchiveMenu, type MenuAnchor } from "./ArchiveMenu";
import { Waveform } from "./Waveform";
import styles from "./RecordingTimeline.module.css";

interface RecordingTimelineProps {
  recording: VpsRecordingMeta;
  /** End of the recorded material, in session seconds. */
  position: number;
  playhead: number;
  selection: { start: number; end: number } | null;
  /** Chat density and bursts; null while the chat loads or when there is none. */
  heat?: ChatHeat | null;
  onSeek: (seconds: number) => void;
  onSelect: (start: number, end: number) => void;
  /** Quick ranges from the right-click menu. */
  onPreset: (preset: RangePreset) => void;
}

type Drag =
  | { kind: "scrub" }
  | { kind: "select"; anchor: number }
  | { kind: "pan"; grabbed: number }
  | null;

/**
 * The main way to move around a recording — a 27-hour session is unusable
 * through a fixed-width bar, so this one zooms and pans.
 *
 * Wheel zooms around the cursor, dragging scrubs, Shift-drag (or the right
 * button) picks a clip range, and the strip above shows where the visible
 * window sits in the whole session.
 */
export function RecordingTimeline({
  recording,
  position,
  playhead,
  selection,
  heat = null,
  onSeek,
  onSelect,
  onPreset,
}: RecordingTimelineProps) {
  const total = Math.max(position, recording.duration, 1);
  const laneRef = useRef<HTMLDivElement | null>(null);
  const [view, setView] = useState<View>({ start: 0, end: total });
  const [drag, setDrag] = useState<Drag>(null);
  const [hover, setHover] = useState<number | null>(null);
  const [menu, setMenu] = useState<MenuAnchor | null>(null);
  // A right click that never moved opens the menu instead of picking a range.
  const rightDown = useRef<{ x: number; y: number; moved: boolean } | null>(null);

  // A session that is still recording keeps growing; follow the new end only
  // while the whole thing is in view, so a zoomed-in user is not yanked away.
  const wasFullRef = useRef(true);
  useEffect(() => {
    if (wasFullRef.current) setView({ start: 0, end: total });
    else setView((current) => clampView(current, total));
  }, [total]);
  useEffect(() => {
    wasFullRef.current = view.start <= 0.5 && view.end >= total - 0.5;
  }, [view, total]);

  const span = view.end - view.start;
  const step = tickStep(span, 8);
  const ticks = useMemo(() => ticksFor(view, 8), [view]);
  const minorTicks = useMemo(() => minorTicksFor(view, step), [view, step]);
  const gaps = recording.gaps ?? [];

  /** Session timecode → percentage across the visible lane. */
  const pct = useCallback(
    (value: number) => ((value - view.start) / span) * 100,
    [view.start, span],
  );
  const clip = useCallback(
    (value: number) => Math.max(-5, Math.min(105, value)),
    [],
  );

  const timeAt = useCallback(
    (clientX: number): number => {
      const rect = laneRef.current?.getBoundingClientRect();
      if (!rect) return view.start;
      const ratio = (clientX - rect.left) / Math.max(1, rect.width);
      return Math.max(0, Math.min(total, view.start + ratio * span));
    },
    [view.start, span, total],
  );

  // Native listener with `passive: false`: React routes wheel through a passive
  // root listener, where preventDefault is ignored and the page scrolls anyway.
  useEffect(() => {
    const lane = laneRef.current;
    if (!lane) return;
    const onWheel = (event: globalThis.WheelEvent) => {
      event.preventDefault();
      const rect = lane.getBoundingClientRect();
      const ratio = (event.clientX - rect.left) / Math.max(1, rect.width);
      setView((current) => {
        const width = current.end - current.start;
        // Ctrl is the zoom gesture everywhere else (and what a trackpad pinch
        // sends); Alt does the same for keyboards where Ctrl is awkward.
        if (event.ctrlKey || event.altKey || event.metaKey) {
          const anchor = current.start + ratio * width;
          return zoomAt(current, anchor, event.deltaY > 0 ? 1.25 : 0.8, total);
        }
        // Plain wheel walks along the recording. A trackpad's horizontal axis
        // means the same thing, so fold both into one delta.
        const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
        return panBy(current, (delta / 100) * width * 0.18, total);
      });
    };
    lane.addEventListener("wheel", onWheel, { passive: false });
    return () => lane.removeEventListener("wheel", onWheel);
  }, [total]);

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button === 1) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const at = timeAt(event.clientX);
    rightDown.current = event.button === 2 ? { x: event.clientX, y: event.clientY, moved: false } : null;
    if (event.shiftKey || event.button === 2) {
      setDrag({ kind: "select", anchor: at });
    } else if (event.altKey) {
      setDrag({ kind: "pan", grabbed: at });
    } else {
      setDrag({ kind: "scrub" });
      onSeek(at);
    }
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const at = timeAt(event.clientX);
    setHover(at);
    if (!drag) return;
    if (drag.kind === "scrub") onSeek(at);
    else if (drag.kind === "select") {
      const down = rightDown.current;
      if (down && Math.abs(event.clientX - down.x) < 4) return;
      if (down) rightDown.current = { ...down, moved: true };
      if (at !== drag.anchor) onSelect(Math.min(drag.anchor, at), Math.max(drag.anchor, at));
    }
    else if (drag.kind === "pan") setView((current) => panBy(current, drag.grabbed - at, total));
  };

  const endDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setDrag(null);
    const down = rightDown.current;
    rightDown.current = null;
    if (down && !down.moved) setMenu({ x: down.x, y: down.y });
  };

  const closeMenu = useCallback(() => setMenu(null), []);
  const showAll = () => setView({ start: 0, end: total });
  const zoomed = view.start > 0.5 || view.end < total - 0.5;
  const hasSelection = Boolean(selection && selection.end > selection.start);

  const zoomToSelection = () => {
    if (!selection || selection.end <= selection.start) return;
    const pad = (selection.end - selection.start) * 0.15;
    setView(clampView({ start: selection.start - pad, end: selection.end + pad }, total));
  };

  const zoomAroundPlayhead = (factor: number) =>
    setView((current) => zoomAt(current, playhead, factor, total));

  const peaks = heat?.peaks ?? [];
  // A burst outside the zoomed window brings the window along.
  const jumpTo = (peak: ChatPeak) => {
    onSeek(peak.at);
    setView((current) => {
      const width = current.end - current.start;
      if (peak.at >= current.start && peak.at <= current.end) return current;
      return clampView({ start: peak.at - width / 3, end: peak.at + (width * 2) / 3 }, total);
    });
  };
  const jumpToNextPeak = () => {
    const peak = nextPeak(peaks, playhead);
    if (peak) jumpTo(peak);
  };

  return (
    <div className={styles.timelineWrap}>
      <div
        className={styles.timelineToolbar}
        title="Колесо — листать · Ctrl+колесо — зум · тяни — перемотка · Shift+тяни — отрезок · правый клик — быстрый выбор"
      >
        <button
          type="button"
          className={styles.toolButton}
          onClick={() => zoomAroundPlayhead(0.5)}
          title="Приблизить (Ctrl+колесо)"
          aria-label="Приблизить"
        >
          <RedesignIcon name="add" />
        </button>
        <button
          type="button"
          className={styles.toolButton}
          onClick={() => zoomAroundPlayhead(2)}
          title="Отдалить (Ctrl+колесо)"
          aria-label="Отдалить"
        >
          <RedesignIcon name="minimize" />
        </button>
        {zoomed && (
          <button type="button" className={styles.toolButton} onClick={showAll} title="Показать весь эфир">
            Весь эфир
          </button>
        )}
        {hasSelection && (
          <button type="button" className={styles.toolButton} onClick={zoomToSelection} title="Приблизить к выбранному отрезку">
            К отрезку
          </button>
        )}
        {peaks.length > 0 && (
          <button
            type="button"
            className={styles.toolButton}
            onClick={jumpToNextPeak}
            title="Перейти к следующему месту, где чат резко оживился"
          >
            Всплеск чата ›<span className={styles.toolCount}>{peaks.length}</span>
          </button>
        )}
        <span className={styles.spacer} />
        <span className={cn(styles.mono, styles.timelineClock)}>{fmtDuration(playhead)}</span>
      </div>

      <div className={styles.timelineRuler}>
        {minorTicks.map((tick) => (
          <i key={`m-${tick}`} className={styles.rulerMinor} style={{ left: `${pct(tick)}%` }} />
        ))}
        {ticks.map((tick) => (
          <span key={tick} className={styles.rulerMajor} style={{ left: `${pct(tick)}%` }}>
            <i className={styles.rulerMajorMark} />
            {formatTick(tick, step)}
          </span>
        ))}
      </div>

      <div
        ref={laneRef}
        className={cn(styles.timeline, drag?.kind === "pan" && styles.timelineGrabbing)}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onPointerLeave={() => {
          // A captured drag keeps delivering moves outside the lane; dropping
          // the readout there would hide the time mid-scrub.
          if (!drag) setHover(null);
        }}
        onContextMenu={(event) => event.preventDefault()}
        role="presentation"
      >
        <Waveform session={recording.session} start={view.start} end={view.end} />
        {heat && <ChatHeatLayer heat={heat} start={view.start} end={view.end} />}
        {recording.available_start > view.start && (
          <div
            className={styles.timelineRotated}
            style={{ left: `${clip(pct(view.start))}%`, width: `${clip(pct(recording.available_start)) - clip(pct(view.start))}%` }}
            title={`Очищено ротацией: 0–${fmtDuration(recording.available_start)}`}
          />
        )}
        {ticks.map((tick) => (
          <div key={`g-${tick}`} className={styles.timelineGrid} style={{ left: `${pct(tick)}%` }} />
        ))}
        {gaps.map((gap) => (
          <div
            key={`${gap.start}-${gap.end}`}
            className={styles.timelineGap}
            style={{ left: `${clip(pct(gap.start))}%`, width: `${Math.max(0.4, clip(pct(gap.end)) - clip(pct(gap.start)))}%` }}
            title={`Разрыв связи: ${fmtDuration(gap.start)}–${fmtDuration(gap.end)}`}
          />
        ))}
        {selection && selection.end > selection.start && (
          <div
            className={styles.timelineSelection}
            style={{ left: `${clip(pct(selection.start))}%`, width: `${clip(pct(selection.end)) - clip(pct(selection.start))}%` }}
          />
        )}
        {recording.markers.map((marker) => (
          <button
            type="button"
            key={marker.id}
            className={styles.timelineMarker}
            style={{ left: `${pct(marker.timestamp)}%` }}
            title={`${marker.label} · ${fmtDuration(marker.timestamp)}`}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              onSeek(marker.timestamp);
            }}
          >
            <span
              className={cn(styles.timelineMarkerLabel, pct(marker.timestamp) > 85 && styles.timelineMarkerLabelLeft)}
            >
              {marker.label}
            </span>
          </button>
        ))}
        {peaks
          .filter((peak) => peak.at >= view.start && peak.at <= view.end)
          .map((peak) => (
            <button
              type="button"
              key={`peak-${peak.at}`}
              className={styles.timelinePeak}
              style={{ left: `${pct(peak.at)}%` }}
              title={`Всплеск чата · ${fmtDuration(peak.at)} · ${fmtCount(peak.count)} сообщений за ${fmtDuration(peak.window)}`}
              aria-label={`Всплеск чата на ${fmtDuration(peak.at)}`}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation();
                jumpTo(peak);
              }}
            />
          ))}
        {/* Readout rides the cursor: while dragging here, looking away to the
            side panel to read the time defeats the point of dragging. */}
        {hover != null && (
          <div className={styles.timelineHover} style={{ left: `${pct(hover)}%` }}>
            <span
              className={cn(
                styles.timelineHoverLabel,
                drag != null && styles.timelineHoverLabelActive,
                pct(hover) > 80 && styles.timelineHoverLabelLeft,
              )}
            >
              {drag?.kind === "select" && selection
                ? `${fmtDuration(selection.start)} – ${fmtDuration(selection.end)} · ${fmtDuration(selection.end - selection.start)}`
                : fmtDuration(hover)}
            </span>
          </div>
        )}
        <div className={styles.timelinePlayhead} style={{ left: `${pct(playhead)}%` }} />

        {/* Whole session as a band inside the lane: as a separate strip above
            it cost its own row of height for one line of information. */}
        <div
          className={styles.timelineOverview}
          onPointerDown={(event) => {
            event.stopPropagation();
            const rect = event.currentTarget.getBoundingClientRect();
            const ratio = (event.clientX - rect.left) / Math.max(1, rect.width);
            const centre = ratio * total;
            setView((current) => {
              const width = current.end - current.start;
              return clampView({ start: centre - width / 2, end: centre + width / 2 }, total);
            });
          }}
          onDoubleClick={(event) => {
            event.stopPropagation();
            showAll();
          }}
          role="presentation"
          title="Весь эфир · клик переносит окно, двойной клик — показать целиком"
        >
          {gaps.map((gap) => (
            <div
              key={`ov-${gap.start}`}
              className={styles.timelineGap}
              style={{
                left: `${(gap.start / total) * 100}%`,
                width: `${Math.max(0.3, ((gap.end - gap.start) / total) * 100)}%`,
              }}
            />
          ))}
          <div
            className={styles.timelineViewport}
            style={{ left: `${(view.start / total) * 100}%`, width: `${(span / total) * 100}%` }}
          />
          <div
            className={styles.overviewPlayhead}
            style={{ left: `${(playhead / total) * 100}%` }}
          />
        </div>
      </div>

      <ArchiveMenu
        anchor={menu}
        label="Быстрый выбор"
        onClose={closeMenu}
        items={[
          { id: "all-view", label: "Показать весь эфир", icon: "expand", disabled: !zoomed, onSelect: showAll },
          { id: "last30", label: "Последние 30 секунд", hint: "до позиции плеера", icon: "time", separated: true, onSelect: () => onPreset("last30") },
          { id: "last300", label: "Последние 5 минут", hint: "до позиции плеера", icon: "time", onSelect: () => onPreset("last300") },
          { id: "all", label: "Вся запись", hint: "всё, что есть на сервере", icon: "media", onSelect: () => onPreset("all") },
        ]}
      />
    </div>
  );
}
