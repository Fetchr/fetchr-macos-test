/**
 * Короткие системные звуки в духе macOS: синтез на Web Audio, без файлов.
 *
 * Тон — синус с мягкой атакой и экспоненциальным затуханием, лёгкий второй
 * обертон даёт «стеклянность». Громкость низкая: звук сообщает, а не зовёт.
 */

type Note = { freq: number; at: number; length: number; gain: number };

let context: AudioContext | null = null;
let lastPlayed = 0;

/** Не чаще раза в 600 мс: пачка задач, завершившихся разом, звучит одним сигналом. */
const MIN_GAP_MS = 600;

function audio(): AudioContext | null {
  try {
    context ??= new AudioContext();
    if (context.state === "suspended") void context.resume();
    return context;
  } catch {
    return null;
  }
}

function play(notes: Note[], wave: OscillatorType, volume: number) {
  const now = performance.now();
  if (now - lastPlayed < MIN_GAP_MS) return;
  lastPlayed = now;

  const ctx = audio();
  if (!ctx) return;
  const master = ctx.createGain();
  master.gain.value = volume;
  // Срезаем верх: убирает «цифровой» призвук у коротких синусов.
  const tone = ctx.createBiquadFilter();
  tone.type = "lowpass";
  tone.frequency.value = 5200;
  master.connect(tone).connect(ctx.destination);

  const start = ctx.currentTime + 0.01;
  for (const note of notes) {
    for (const [ratio, level] of [
      [1, 1],
      [2.01, 0.12],
    ] as const) {
      const osc = ctx.createOscillator();
      const env = ctx.createGain();
      osc.type = wave;
      osc.frequency.value = note.freq * ratio;
      const t0 = start + note.at;
      env.gain.setValueAtTime(0, t0);
      env.gain.linearRampToValueAtTime(note.gain * level, t0 + 0.012);
      env.gain.exponentialRampToValueAtTime(0.0001, t0 + note.length);
      osc.connect(env).connect(master);
      osc.start(t0);
      osc.stop(t0 + note.length + 0.05);
    }
  }
}

/** Успех: восходящая чистая кварта, как «готово» в macOS. */
export function playSuccessSound() {
  play(
    [
      { freq: 1318.5, at: 0, length: 0.42, gain: 0.55 },
      { freq: 1760, at: 0.09, length: 0.6, gain: 0.5 },
    ],
    "sine",
    0.16,
  );
}

/** Ошибка: два низких нисходящих тона, мягких, без резкости «бипа». */
export function playErrorSound() {
  play(
    [
      { freq: 523.25, at: 0, length: 0.22, gain: 0.6 },
      { freq: 392, at: 0.13, length: 0.38, gain: 0.55 },
    ],
    "triangle",
    0.14,
  );
}
