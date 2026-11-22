import { useEffect, useRef, useState, type CSSProperties } from "react";

import type { BlurZone } from "@/types/job";

import styles from "./SponsorBlurPage.module.css";

const DESIGN_WIDTH = 1920;
const DESIGN_HEIGHT = 1080;

interface SponsorZoneEffectProps {
  zone: BlurZone;
  /** Кадр, из которого рисуется мозаика. Для живого видео его нет. */
  frameSrc: string | null;
}

/**
 * Показывает на кадре, как зона будет выглядеть после рендера: реальный блюр,
 * мозаику, форму, мягкость краёв и непрозрачность. Слой лежит рядом с рамкой
 * зоны, а не внутри: у родителя с opacity backdrop-filter ничего не размывает.
 */
export function SponsorZoneEffect({ zone, frameSrc }: SponsorZoneEffectProps) {
  if (!zone.enabled || zone.effect === "image_overlay") return null;

  const soft = ((zone.edge_softness ?? 0) / DESIGN_WIDTH) * 100;
  const ellipse = zone.shape === "ellipse";
  const style: CSSProperties = {
    left: `${(zone.x / DESIGN_WIDTH) * 100}%`,
    top: `${(zone.y / DESIGN_HEIGHT) * 100}%`,
    width: `${(zone.width / DESIGN_WIDTH) * 100}%`,
    height: `${(zone.height / DESIGN_HEIGHT) * 100}%`,
    borderRadius: ellipse ? "50%" : undefined,
    opacity: zone.opacity ?? 1,
    ...softMask(soft, ellipse),
  };

  if (zone.effect === "mosaic" && frameSrc) {
    return (
      <div className={styles.zoneEffect} style={style} aria-hidden>
        <MosaicCanvas zone={zone} src={frameSrc} />
      </div>
    );
  }

  // Блюр: sigma в пикселях кадра 1920 переводится в долю ширины рамки.
  const radius = zone.effect === "mosaic" ? Math.max(zone.intensity, 8) : zone.intensity;
  const blur = `blur(${(radius / DESIGN_WIDTH) * 100}cqw)`;
  return (
    <div
      className={cn2(styles.zoneEffect, zone.effect === "mosaic" && styles.zoneEffectGrid)}
      style={{ ...style, backdropFilter: blur, WebkitBackdropFilter: blur }}
      aria-hidden
    />
  );
}

function cn2(...values: Array<string | false | undefined>) {
  return values.filter(Boolean).join(" ");
}

/** Мягкие края: маска гасит зону к границе, у прямоугольника по обеим осям. */
function softMask(softCqw: number, ellipse: boolean): CSSProperties {
  if (softCqw <= 0) return {};
  const s = `${softCqw}cqw`;
  if (ellipse) {
    const image = `radial-gradient(closest-side, #000 calc(100% - ${s}), transparent 100%)`;
    return { maskImage: image, WebkitMaskImage: image };
  }
  const horizontal = `linear-gradient(90deg, transparent 0, #000 ${s}, #000 calc(100% - ${s}), transparent 100%)`;
  const vertical = `linear-gradient(180deg, transparent 0, #000 ${s}, #000 calc(100% - ${s}), transparent 100%)`;
  return {
    maskImage: `${horizontal}, ${vertical}`,
    WebkitMaskImage: `${horizontal}, ${vertical}`,
    maskComposite: "intersect",
    WebkitMaskComposite: "source-in",
  };
}

/**
 * Мозаика из самого кадра: вырезанный участок сжимается до одной точки на клетку
 * и растягивается без сглаживания, поэтому видны те же квадраты, что будут в рендере.
 */
function MosaicCanvas({ zone, src }: { zone: BlurZone; src: string }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [image, setImage] = useState<HTMLImageElement | null>(null);

  useEffect(() => {
    const next = new Image();
    next.onload = () => setImage(next);
    next.onerror = () => setImage(null);
    next.src = src;
    return () => {
      next.onload = null;
      next.onerror = null;
    };
  }, [src]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !image || !image.naturalWidth) return;
    const cell = Math.max(2, Math.round(zone.intensity));
    const cols = Math.max(1, Math.ceil(zone.width / cell));
    const rows = Math.max(1, Math.ceil(zone.height / cell));
    canvas.width = cols;
    canvas.height = rows;
    const context = canvas.getContext("2d");
    if (!context) return;
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    const scaleX = image.naturalWidth / DESIGN_WIDTH;
    const scaleY = image.naturalHeight / DESIGN_HEIGHT;
    context.drawImage(image, zone.x * scaleX, zone.y * scaleY, zone.width * scaleX, zone.height * scaleY, 0, 0, cols, rows);
  }, [image, zone.x, zone.y, zone.width, zone.height, zone.intensity]);

  return <canvas ref={canvasRef} className={styles.zoneMosaic} />;
}
