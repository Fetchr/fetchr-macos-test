/**
 * ASCII-фон заставки: поле яркости переводится в символы с упорядоченным
 * дизерингом и фосфорным свечением. В поле плывёт «сияние» и ленты света,
 * вдоль ленты записи идёт луч потока (ярче на перемотке), от удара по отрезку
 * расходится волна. Центр под логотипом спокойный, кадр накрыт затенением.
 *
 * Фон живёт только пока открыта заставка: рисует сам себя в requestAnimationFrame,
 * а таймлайн интро двигает его состояние (перемотку, волну, затухание).
 */

export interface AsciiState {
  /** Пройденный путь ленты: поле течёт вместе с ней */
  scroll: number;
  /** 0…1 — проявление фона */
  fade: number;
  /** 0…1 — затихание луча после удара */
  calm: number;
  /** Радиус и сила волны от удара */
  ring: number;
  ringA: number;
}

export interface AsciiBackdrop {
  state: AsciiState;
  start(): void;
  stop(): void;
}

const ROWS = 58;
/** Ширина клетки к высоте — как у моноширинного глифа */
const CELL_ASPECT = 0.614;
const RAMP = " .:-=+*#%@";
const BAYER = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
];
/** Ночной синий → фирменный → ледяной */
const PALETTE = [
  [16, 28, 58],
  [32, 64, 150],
  [61, 125, 255],
  [150, 190, 255],
  [225, 238, 255],
] as const;
const CANVAS_BG = "#06070A";
const FONT_STACK = '"JetBrains Mono Variable", "JetBrains Mono", ui-monospace, monospace';

export function palette(value: number): [number, number, number] {
  const x = Math.max(0, Math.min(0.999, value)) * (PALETTE.length - 1);
  const i = Math.floor(x);
  const f = x - i;
  const a = PALETTE[i];
  const b = PALETTE[i + 1];
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}

function hash(x: number, y: number) {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return s - Math.floor(s);
}

function noise(x: number, y: number) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const a = hash(xi, yi);
  const b = hash(xi + 1, yi);
  const c = hash(xi, yi + 1);
  const d = hash(xi + 1, yi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

function fbm(x: number, y: number) {
  return 0.55 * noise(x, y) + 0.3 * noise(x * 2.1 + 3.7, y * 2.1 - 1.3) + 0.15 * noise(x * 4.3 - 2.2, y * 4.3 + 5.1);
}

export interface AsciiOptions {
  /** Яркость символов, 0…1 */
  intensity?: number;
  /** Сила фосфорного свечения, 0…1 */
  glow?: number;
}

export function createAsciiBackdrop(
  canvas: HTMLCanvasElement,
  { intensity = 0.55, glow = 0.3 }: AsciiOptions = {},
): AsciiBackdrop {
  const state: AsciiState = { scroll: 0, fade: 0, calm: 0, ring: 0, ringA: 0 };
  const ctx = canvas.getContext("2d");
  const glowCanvas = document.createElement("canvas");
  const glowCtx = glowCanvas.getContext("2d");
  let frame = 0;
  let startedAt = 0;
  let lastScroll = 0;
  let lastTime = 0;
  let speed = 0;

  const render = (time: number) => {
    if (!ctx || !glowCtx) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const width = Math.max(1, Math.round(canvas.clientWidth * dpr));
    const height = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
      glowCanvas.width = Math.max(1, Math.round(width / 4));
      glowCanvas.height = Math.max(1, Math.round(height / 4));
    }
    const aspect = width / height;
    const cols = Math.max(40, Math.round((ROWS * aspect) / CELL_ASPECT));
    const cellW = width / cols;
    const cellH = height / ROWS;

    const dt = time - lastTime;
    const velocity = dt > 0 ? Math.abs(state.scroll - lastScroll) / dt : 0;
    speed += (Math.min(1, velocity / 600) - speed) * 0.25;
    lastScroll = state.scroll;
    lastTime = time;

    ctx.fillStyle = CANVAS_BG;
    ctx.fillRect(0, 0, width, height);
    if (state.fade <= 0.001) return;

    ctx.font = `600 ${Math.round(cellH * 0.82)}px ${FONT_STACK}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const drift = time * 0.05 + state.scroll * 0.0016;

    for (let r = 0; r < ROWS; r++) {
      const ny = ((r + 0.5) / ROWS) * 2 - 1;
      for (let c = 0; c < cols; c++) {
        const ax = (((c + 0.5) / cols) * 2 - 1) * aspect;
        const n = fbm(ax * 1.1 + drift, ny * 1.4 - time * 0.03);
        let light = Math.pow(n, 1.7) * 0.75;
        // Ленты сияния
        const ribbon = Math.sin(ax * 1.4 + ny * 2.6 + time * 0.22 + state.scroll * 0.0012 + n * 3.2);
        light += Math.pow(Math.max(0, ribbon), 6) * 0.42 * (0.6 + 0.4 * n);
        // Луч потока вдоль ленты
        const beam =
          Math.exp(-Math.pow(ny / (0.05 + 0.03 * speed), 2)) *
          (0.25 + 0.75 * speed) *
          (0.6 + 0.4 * noise(ax * 6 + state.scroll * 0.05, 3.3));
        light += beam * (1 - 0.6 * state.calm);
        // Волна от удара
        if (state.ringA > 0.001) {
          const d = Math.hypot(ax * 0.62, ny * 1.25) + (noise(ax * 3, ny * 3) - 0.5) * 0.08;
          light += Math.exp(-Math.pow((d - state.ring) / 0.09, 2)) * state.ringA * 0.55;
        }
        // Спокойный центр под логотипом
        const dist = Math.hypot(ax / 1.5, ny / 0.8);
        const mask = Math.max(0, Math.min(1, (dist - 0.18) / 0.38));
        light *= (0.22 + 0.78 * mask) * state.fade * intensity;
        // Упорядоченный дизеринг
        light += (BAYER[r & 3][c & 3] / 16 - 0.5) / RAMP.length;
        const index = Math.floor(light * RAMP.length);
        if (index <= 0) continue;
        const [cr, cg, cb] = palette(light * 1.05);
        ctx.fillStyle = `rgba(${cr | 0},${cg | 0},${cb | 0},${Math.min(1, 0.18 + light).toFixed(2)})`;
        ctx.fillText(RAMP[Math.min(RAMP.length - 1, index)], (c + 0.5) * cellW, (r + 0.5) * cellH);
      }
    }

    // Фосфорное свечение: размытая уменьшенная копия поверх
    glowCtx.clearRect(0, 0, glowCanvas.width, glowCanvas.height);
    glowCtx.filter = "blur(3px)";
    glowCtx.drawImage(canvas, 0, 0, glowCanvas.width, glowCanvas.height);
    glowCtx.filter = "none";
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.globalAlpha = glow;
    ctx.drawImage(glowCanvas, 0, 0, width, height);
    ctx.restore();

    // Глобальное затенение
    const vignette = ctx.createRadialGradient(
      width / 2, height / 2, Math.min(width, height) * 0.12,
      width / 2, height / 2, Math.max(width, height) * 0.6,
    );
    vignette.addColorStop(0, "rgba(6,7,10,0.1)");
    vignette.addColorStop(0.65, "rgba(6,7,10,0.55)");
    vignette.addColorStop(1, "rgba(2,3,4,0.9)");
    ctx.fillStyle = vignette;
    ctx.fillRect(0, 0, width, height);
  };

  const loop = () => {
    render((performance.now() - startedAt) / 1000);
    frame = requestAnimationFrame(loop);
  };

  return {
    state,
    start() {
      if (frame) return;
      startedAt = performance.now();
      frame = requestAnimationFrame(loop);
    },
    stop() {
      cancelAnimationFrame(frame);
      frame = 0;
    },
  };
}
