/**
 * Детерминированная «природа» для ролика: шум, волны, горные хребты.
 * Одинаковое зерно — одинаковая картинка в каждом рендере.
 */

export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Гладкий одномерный шум: интерполяция между случайными узлами */
export function noise1d(seed: number, nodes = 64) {
  const random = rng(seed);
  const values = Array.from({ length: nodes + 1 }, () => random());
  return (x: number) => {
    const wrapped = ((x % nodes) + nodes) % nodes;
    const i = Math.floor(wrapped);
    const f = wrapped - i;
    const s = f * f * (3 - 2 * f);
    return values[i] * (1 - s) + values[i + 1] * s;
  };
}

/** Огибающая звуковой волны: речь с паузами, музыка — плотнее */
export function waveform(seed: number, count: number, kind: "speech" | "music" | "mix" = "mix") {
  const random = rng(seed);
  const slow = noise1d(seed + 1, 32);
  const fast = noise1d(seed + 2, 128);
  return Array.from({ length: count }, (_, i) => {
    const x = i / count;
    const body = kind === "music" ? 0.55 + 0.3 * slow(x * 24) : 0.25 + 0.6 * slow(x * 18);
    const gate = kind === "speech" ? (slow(x * 40 + 7) > 0.38 ? 1 : 0.12) : 1;
    const grain = 0.55 + 0.45 * fast(x * 110) * (0.6 + 0.4 * random());
    return Math.min(1, body * grain * gate);
  });
}

/** Линия хребта для гор: сумма октав шума */
export function ridge(seed: number, points: number, roughness = 0.5) {
  const octaves = [noise1d(seed, 16), noise1d(seed + 11, 32), noise1d(seed + 23, 64)];
  return Array.from({ length: points + 1 }, (_, i) => {
    const x = i / points;
    return (
      octaves[0](x * 5) * 0.62 + octaves[1](x * 13) * 0.28 * roughness * 2 + octaves[2](x * 31) * 0.1 * roughness * 2
    );
  });
}

export const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
