import { useId, useMemo } from "react";

import { ridge, rng } from "../lib/procedural";

/**
 * Синтетический кадр стрима: закатные горы в дымке. Настоящих записей в
 * ролике нет — чужой контент не показываем, а процедурная картинка ещё и
 * одинакова в каждом рендере.
 */
export interface FramePalette {
  sky: [string, string, string];
  sun: string;
  ridges: [string, string, string, string];
  haze: string;
}

export const PALETTES: Record<string, FramePalette> = {
  dusk: {
    sky: ["#0b1030", "#3a2f6b", "#e58a6a"],
    sun: "#ffd7a1",
    ridges: ["#6d5a9c", "#433b78", "#271f4c", "#120f26"],
    haze: "#f2a07b",
  },
  arctic: {
    sky: ["#061426", "#12406b", "#7fc4e8"],
    sun: "#e8f7ff",
    ridges: ["#5b8fb8", "#2f5f8c", "#173a5e", "#0a1c30"],
    haze: "#9ad7f0",
  },
  ember: {
    sky: ["#14070c", "#5b1d2a", "#f07b3f"],
    sun: "#ffe0a3",
    ridges: ["#8a3b3f", "#5a2330", "#33131f", "#170810"],
    haze: "#ff9a62",
  },
  forest: {
    sky: ["#04120e", "#12433a", "#b9d98a"],
    sun: "#f4ffd6",
    ridges: ["#4f7f63", "#2d5a45", "#17362a", "#0a1a14"],
    haze: "#c8e59a",
  },
  violet: {
    sky: ["#0a0820", "#33206b", "#c07ae8"],
    sun: "#ffe6ff",
    ridges: ["#7a5ab5", "#4a3488", "#2a1b56", "#120b2a"],
    haze: "#d99af2",
  },
};

function ridgePath(seed: number, base: number, amplitude: number, roughness: number) {
  const points = ridge(seed, 96, roughness);
  const step = 1920 / (points.length - 1);
  const line = points.map((value, index) => `${(index * step).toFixed(1)},${(base - value * amplitude).toFixed(1)}`);
  return `M0,1080 L${line.join(" L")} L1920,1080 Z`;
}

export function StreamFrame({
  palette = "dusk",
  seed = 7,
  className,
  children,
}: {
  palette?: keyof typeof PALETTES;
  seed?: number;
  className?: string;
  children?: React.ReactNode;
}) {
  const uid = useId().replace(/:/g, "");
  const colors = PALETTES[palette];
  const shapes = useMemo(() => {
    const random = rng(seed);
    const stars = Array.from({ length: 70 }, () => ({
      x: random() * 1920,
      y: random() * 420,
      r: 0.6 + random() * 1.6,
      o: 0.25 + random() * 0.6,
    }));
    return {
      stars,
      ridges: [
        ridgePath(seed + 1, 640, 260, 0.35),
        ridgePath(seed + 2, 760, 250, 0.5),
        ridgePath(seed + 3, 880, 230, 0.6),
        ridgePath(seed + 4, 1010, 180, 0.7),
      ],
      sunX: 700 + random() * 520,
    };
  }, [seed]);

  return (
    <svg className={className} viewBox="0 0 1920 1080" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
      <defs>
        <linearGradient id={`${uid}-sky`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={colors.sky[0]} />
          <stop offset="0.55" stopColor={colors.sky[1]} />
          <stop offset="0.82" stopColor={colors.sky[2]} />
        </linearGradient>
        <radialGradient id={`${uid}-sun`} cx="0.5" cy="0.5" r="0.5">
          <stop offset="0" stopColor={colors.sun} stopOpacity="1" />
          <stop offset="0.12" stopColor={colors.sun} stopOpacity="0.95" />
          <stop offset="0.35" stopColor={colors.haze} stopOpacity="0.35" />
          <stop offset="1" stopColor={colors.haze} stopOpacity="0" />
        </radialGradient>
        {colors.ridges.map((color, index) => (
          <linearGradient key={color} id={`${uid}-r${index}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor={color} />
            <stop offset="1" stopColor={colors.ridges[Math.min(3, index + 1)]} />
          </linearGradient>
        ))}
        <linearGradient id={`${uid}-mist`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={colors.haze} stopOpacity="0" />
          <stop offset="1" stopColor={colors.haze} stopOpacity="0.22" />
        </linearGradient>
      </defs>
      <rect width="1920" height="1080" fill={`url(#${uid}-sky)`} />
      {shapes.stars.map((star, index) => (
        <circle key={index} cx={star.x} cy={star.y} r={star.r} fill="#ffffff" opacity={star.o} />
      ))}
      <circle cx={shapes.sunX} cy="600" r="420" fill={`url(#${uid}-sun)`} />
      {shapes.ridges.map((d, index) => (
        <g key={index}>
          <path d={d} fill={`url(#${uid}-r${index})`} />
          {index < 3 && <rect y={560 + index * 120} width="1920" height="520" fill={`url(#${uid}-mist)`} opacity={0.5} />}
        </g>
      ))}
      {children}
    </svg>
  );
}
