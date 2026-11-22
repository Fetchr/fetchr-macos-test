export type SpringName = "snappy" | "bouncy" | "soft" | "wobbly";
export type Segment = [to: string, timing: SpringName | [ms: number, easing: string]];
export type Target = SVGElement | undefined | null | ReadonlyArray<SVGElement | undefined | null>;

interface ChainOptions {
  delay?: number;
  origin?: string;
}

const SPRINGS: Record<SpringName, [stiffness: number, damping: number]> = {
  snappy: [520, 32],
  bouncy: [380, 15],
  soft: [190, 19],
  wobbly: [260, 8],
};

export const EASE = {
  out: "cubic-bezier(.2,.8,.2,1)",
  in: "cubic-bezier(.55,0,.85,.35)",
  inOut: "cubic-bezier(.65,0,.35,1)",
} as const;

const springCache = new Map<SpringName, { duration: number; easing: string }>();

/** Simulates a damped spring from 0 to 1 and encodes it as a CSS linear() easing, so overshoot is physical. */
export function spring(name: SpringName): { duration: number; easing: string } {
  const cached = springCache.get(name);
  if (cached) return cached;
  const [k, c] = SPRINGS[name];
  const dt = 1 / 240;
  const samples = [0];
  let x = 0;
  let v = 0;
  let t = 0;
  let sinceSample = 0;
  while (t < 2.2) {
    v += (-k * (x - 1) - c * v) * dt;
    x += v * dt;
    t += dt;
    sinceSample += dt;
    if (sinceSample >= 1 / 60) {
      samples.push(x);
      sinceSample = 0;
    }
    if (t > 0.12 && Math.abs(x - 1) < 0.0012 && Math.abs(v) < 0.012) break;
  }
  samples.push(1);
  const result = { duration: Math.round(t * 1000), easing: `linear(${samples.map((s) => +s.toFixed(4)).join(",")})` };
  springCache.set(name, result);
  return result;
}

export const reducedMotion = (): boolean =>
  typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;

const list = (target: Target): SVGElement[] =>
  (Array.isArray(target) ? target : [target]).filter((el): el is SVGElement => el != null);

export function setOrigin(el: SVGElement, origin?: string): void {
  if (!origin) return;
  if (origin.startsWith("vb ")) {
    const [x, y] = origin.slice(3).split(" ");
    el.style.transformBox = "view-box";
    el.style.transformOrigin = `${x}px ${y}px`;
    return;
  }
  el.style.transformBox = "fill-box";
  el.style.transformOrigin = origin;
}

/** One additive animation per element: a chain of transforms where each segment has its own spring or bezier. */
export function chain(target: Target, start: string, segments: Segment[], options: ChainOptions = {}): void {
  if (reducedMotion()) return;
  const frames: Keyframe[] = [{ transform: start }];
  const durations: number[] = [];
  for (const [to, timing] of segments) {
    const { duration, easing } = typeof timing === "string" ? spring(timing) : { duration: timing[0], easing: timing[1] };
    frames[frames.length - 1].easing = easing;
    durations.push(duration);
    frames.push({ transform: to });
  }
  const total = durations.reduce((a, b) => a + b, 0);
  let elapsed = 0;
  frames.forEach((frame, i) => {
    if (i === 0) frame.offset = 0;
    else if (i === frames.length - 1) frame.offset = 1;
    else frame.offset = (elapsed += durations[i - 1]) / total;
  });
  for (const el of list(target)) {
    setOrigin(el, options.origin);
    el.animate(frames, { duration: total, delay: options.delay ?? 0, composite: "add" });
  }
}

export const q = (ms: number, easing: string = EASE.out): [number, string] => [ms, easing];
export const T = (x: number, y: number): string => `translate(${x}px,${y}px)`;

interface MotionOptions extends ChainOptions {
  in?: number;
  s?: SpringName;
  out?: number;
}

export const pulse = (t: Target, amount: number, o: MotionOptions = {}) =>
  chain(t, "none", [[`scale(${amount})`, q(o.in ?? 110)], ["none", o.s ?? "bouncy"]], o);
export const squash = (t: Target, sx: number, sy: number, o: MotionOptions = {}) =>
  chain(t, "none", [[`scale(${sx},${sy})`, q(o.in ?? 100)], ["none", o.s ?? "bouncy"]], o);
export const rotate = (t: Target, deg: number, o: MotionOptions = {}) =>
  chain(t, "none", [[`rotate(${deg}deg)`, q(o.in ?? 120)], ["none", o.s ?? "wobbly"]], o);
export const nudge = (t: Target, x: number, y: number, o: MotionOptions = {}) =>
  chain(t, "none", [[T(x, y), q(o.in ?? 130)], ["none", o.s ?? "bouncy"]], o);
export const through = (t: Target, dx: number, dy: number, o: MotionOptions = {}) =>
  chain(t, "none", [[T(dx, dy), q(o.out ?? 180, EASE.in)], [T(-dx, -dy), [1, "linear"]], ["none", o.s ?? "snappy"]], o);
export const popIn = (t: Target, o: MotionOptions = {}) =>
  chain(t, "none", [["scale(0)", q(o.in ?? 90, EASE.in)], ["none", o.s ?? "bouncy"]], o);
export const growX = (t: Target, from: number, origin: string, delay = 0) =>
  chain(t, "none", [[`scaleX(${from})`, q(100)], ["none", "bouncy"]], { origin, delay });

export function draw(target: Target, duration = 360, delay = 0): void {
  if (reducedMotion()) return;
  for (const el of list(target)) {
    el.animate(
      [
        { strokeDasharray: "1", strokeDashoffset: 1 },
        { strokeDasharray: "1", strokeDashoffset: 0 },
      ],
      { duration, delay, easing: EASE.inOut, fill: "backwards" },
    );
  }
}

export function wave(target: Target, delay = 0, low = 0.14, duration = 620): void {
  if (reducedMotion()) return;
  for (const el of list(target)) {
    el.animate([{ opacity: 1 }, { opacity: low, offset: 0.28 }, { opacity: 1 }], { duration, delay, easing: "ease-in-out" });
  }
}

/** Moves a slider knob and stretches the two track segments with it, so the track stays connected. */
export function slider(
  knob: SVGElement | undefined,
  left: SVGElement | undefined,
  right: SVGElement | undefined,
  dx: number,
  leftLength: number,
  rightLength: number,
  delay: number,
): void {
  const move = (el: SVGElement | undefined, to: string, origin?: string) =>
    chain(el, "none", [[to, q(240, EASE.inOut)], ["none", "bouncy"]], { delay, origin });
  move(knob, T(dx, 0));
  move(left, `scaleX(${(leftLength + dx) / leftLength})`, "left center");
  move(right, `scaleX(${(rightLength - dx) / rightLength})`, "right center");
}
