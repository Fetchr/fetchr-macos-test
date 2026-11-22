import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent, type ReactNode } from "react";

import { cn } from "@/lib/utils";
import { RedesignIcon } from "@/ui/redesign/icons/iconMap";

import styles from "./ZoomViewport.module.css";
import { Select } from "@/components/ui/select";

/** Ширина эталонного кадра: 100% масштаба значит один пиксель кадра на пиксель экрана. */
const REFERENCE_WIDTH = 1920;
const MIN_PERCENT = 5;
const MAX_PERCENT = 800;
const PRESETS = [10, 25, 50, 75, 100, 150, 200, 400];

interface View {
  /** Масштаб относительно «Вписать». */
  scale: number;
  x: number;
  y: number;
}

const FIT: View = { scale: 1, x: 0, y: 0 };

interface ZoomViewportProps {
  children: ReactNode;
  /** Плавающие кнопки зума нужны не везде: например, пока нет кадра. */
  controls?: boolean;
  /** Левая кнопка двигает кадр по пустому месту. Выключается, пока рисуется зона. */
  panWithLeft?: boolean;
}

/**
 * Приближение и отдаление предпросмотра, как в мониторе Premiere Pro:
 * колесо мыши масштабирует вокруг курсора, двигать кадр можно левой кнопкой по
 * пустому месту, средней кнопкой или Alt с левой, а готовые пресеты 10–400% и «Вписать»
 * лежат в списке справа сверху.
 */
export function ZoomViewport({ children, controls = true, panWithLeft = true }: ZoomViewportProps) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const [view, setView] = useState<View>(FIT);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [panning, setPanning] = useState(false);
  const panRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    originX: number;
    originY: number;
    /** Левая кнопка начинает тянуть кадр только после небольшого сдвига, чтобы клики проходили. */
    active: boolean;
  } | null>(null);
  const suppressClickRef = useRef(false);
  const viewRef = useRef(view);
  viewRef.current = view;

  // Размер сцены без масштаба: transform его не меняет.
  useLayoutEffect(() => {
    const stage = stageRef.current;
    if (!stage || typeof ResizeObserver === "undefined") return;
    const measure = () => setSize({ width: stage.offsetWidth, height: stage.offsetHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(stage);
    return () => observer.disconnect();
  }, []);

  const fitPercent = size.width > 0 ? (size.width / REFERENCE_WIDTH) * 100 : 100;
  const percent = view.scale * fitPercent;

  /** Держит кадр в пределах окна: приближенный не уезжает целиком, отдалённый стоит по центру. */
  const clamp = useCallback(
    (next: View): View => {
      const scaledW = size.width * next.scale;
      const scaledH = size.height * next.scale;
      const x = scaledW <= size.width ? (size.width - scaledW) / 2 : Math.min(0, Math.max(size.width - scaledW, next.x));
      const y = scaledH <= size.height ? (size.height - scaledH) / 2 : Math.min(0, Math.max(size.height - scaledH, next.y));
      return { scale: next.scale, x, y };
    },
    [size.width, size.height],
  );

  const zoomTo = useCallback(
    (targetPercent: number, anchor?: { x: number; y: number }) => {
      const current = viewRef.current;
      const scale = Math.min(MAX_PERCENT, Math.max(MIN_PERCENT, targetPercent)) / fitPercent;
      const point = anchor ?? { x: size.width / 2, y: size.height / 2 };
      // Точка под курсором остаётся на месте.
      const stageX = (point.x - current.x) / current.scale;
      const stageY = (point.y - current.y) / current.scale;
      setView(clamp({ scale, x: point.x - stageX * scale, y: point.y - stageY * scale }));
    },
    [clamp, fitPercent, size.height, size.width],
  );

  // Колесо должно гасить прокрутку страницы, а пассивные слушатели этого не умеют.
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = viewport.getBoundingClientRect();
      const factor = Math.exp(-event.deltaY * 0.0015);
      const current = viewRef.current.scale * fitPercent;
      zoomTo(current * factor, { x: event.clientX - rect.left, y: event.clientY - rect.top });
    };
    viewport.addEventListener("wheel", onWheel, { passive: false });
    return () => viewport.removeEventListener("wheel", onWheel);
  }, [fitPercent, zoomTo]);

  const onPointerDownCapture = (event: PointerEvent<HTMLDivElement>) => {
    const forced = event.button === 1 || (event.button === 0 && event.altKey);
    const target = event.target as HTMLElement;
    // Зоны, их ручки, панели и кнопки управляют собой сами.
    const onInteractive = Boolean(target.closest("[data-no-pan], button, input, select, a"));
    const plainLeft = event.button === 0 && panWithLeft && !onInteractive;
    if (!forced && !plainLeft) return;
    if (forced) {
      event.preventDefault();
      event.stopPropagation();
      event.currentTarget.setPointerCapture(event.pointerId);
      setPanning(true);
    }
    panRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: viewRef.current.x,
      originY: viewRef.current.y,
      active: forced,
    };
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const pan = panRef.current;
    if (!pan || pan.pointerId !== event.pointerId) return;
    const dx = event.clientX - pan.startX;
    const dy = event.clientY - pan.startY;
    if (!pan.active) {
      if (Math.hypot(dx, dy) < 4) return;
      pan.active = true;
      event.currentTarget.setPointerCapture(event.pointerId);
      setPanning(true);
    }
    setView((current) => clamp({ scale: current.scale, x: pan.originX + dx, y: pan.originY + dy }));
  };

  const endPan = (event: PointerEvent<HTMLDivElement>) => {
    const pan = panRef.current;
    if (pan?.pointerId !== event.pointerId) return;
    // Сдвинутый кадр не должен ещё и «кликнуть» по тому, что под курсором.
    if (pan.active) suppressClickRef.current = true;
    panRef.current = null;
    setPanning(false);
  };

  const identity = view.scale === 1 && view.x === 0 && view.y === 0;
  const stageStyle = {
    // В покое трансформации нет совсем: видео и backdrop-filter под ней рисуются хуже.
    transform: identity ? undefined : `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
    // Ручки и панели на кадре не растут вместе с картинкой.
    "--zoom": view.scale,
  } as CSSProperties;

  const rounded = Math.round(percent);
  const presetValue = PRESETS.includes(rounded) && Math.abs(percent - rounded) < 0.6 ? String(rounded) : "custom";
  const isFit = view.scale === 1 && view.x === 0 && view.y === 0;

  return (
    <div
      ref={viewportRef}
      className={cn(
        styles.viewport,
        (panning || (panWithLeft && view.scale !== 1)) && styles.hand,
        panning && styles.grabbing,
      )}
      onPointerDownCapture={onPointerDownCapture}
      onPointerMove={onPointerMove}
      onPointerUp={endPan}
      onPointerCancel={endPan}
      onClickCapture={(event) => {
        if (!suppressClickRef.current) return;
        suppressClickRef.current = false;
        event.stopPropagation();
      }}
      onDoubleClick={(event) => {
        if (event.altKey) setView(FIT);
      }}
    >
      <div ref={stageRef} className={styles.stage} style={stageStyle}>
        {children}
      </div>

      {controls && (
        <div className={styles.controls} data-no-pan onPointerDown={(event) => event.stopPropagation()}>
          <button
            type="button"
            className={styles.zoomButton}
            onClick={() => zoomTo(percent / 1.25)}
            aria-label="Отдалить"
            title="Отдалить (колесо вниз)"
          >
            −
          </button>
          <Select
            className={styles.zoomSelect}
            value={isFit ? "fit" : presetValue}
            aria-label="Масштаб предпросмотра"
            onValueChange={(value) => {
              if (value === "fit") setView(FIT);
              else if (value !== "custom") zoomTo(Number(value));
            }}
          >
            <option value="fit">Вписать · {Math.round(fitPercent)}%</option>
            {PRESETS.map((preset) => (
              <option key={preset} value={preset}>
                {preset}%
              </option>
            ))}
            {!isFit && presetValue === "custom" && <option value="custom">{rounded}%</option>}
          </Select>
          <button
            type="button"
            className={styles.zoomButton}
            onClick={() => zoomTo(percent * 1.25)}
            aria-label="Приблизить"
            title="Приблизить (колесо вверх)"
          >
            +
          </button>
          <button
            type="button"
            className={styles.zoomButton}
            onClick={() => setView(FIT)}
            disabled={isFit}
            aria-label="Вписать в окно"
            title="Вписать в окно"
          >
            <RedesignIcon name="reset" className="size-3.5" />
          </button>
        </div>
      )}
    </div>
  );
}
