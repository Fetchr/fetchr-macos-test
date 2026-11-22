import { useEffect, useRef } from "react";

import type { FetchrMuteCensorMethod, MuteSpan } from "@/types/job";

import {
  attachAudioGraph,
  getAudioContext,
  getAudioGraph,
} from "../previewAudioGraph";
import {
  BEEP_FREQUENCY_HZ,
  BEEP_GAIN,
  envelopePoints,
  gainAt,
} from "../previewEnvelope";

interface PreviewAudioOptions {
  mediaEl: HTMLMediaElement | null;
  /** Плеер играет исходник вместо устаревшего результата. */
  active: boolean;
  spans: MuteSpan[];
  method: FetchrMuteCensorMethod;
  volume: number;
  muted: boolean;
}

/** На сколько вперёд (в секундах медиа) расписывается огибающая. */
const SCHEDULE_HORIZON_S = 1.2;
const RESCHEDULE_MS = 300;
/** Сглаживание громкости писка в режиме media.volume. */
const TONE_SMOOTHING_S = 0.004;

interface Tone {
  context: AudioContext;
  oscillator: OscillatorNode;
  gain: GainNode;
}

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

function holdAt(param: AudioParam, time: number) {
  if (typeof param.cancelAndHoldAtTime === "function") param.cancelAndHoldAtTime(time);
  else param.cancelScheduledValues(time);
}

/** Расписать огибающую на AudioParam от текущей позиции медиа. */
function scheduleParam(
  param: AudioParam,
  context: AudioContext,
  el: HTMLMediaElement,
  spans: MuteSpan[],
  map: (gain: number) => number,
) {
  const now = context.currentTime;
  const mediaNow = el.currentTime;
  holdAt(param, now);
  param.setValueAtTime(map(gainAt(mediaNow, spans)), now);
  if (el.paused) return;
  const rate = el.playbackRate > 0 ? el.playbackRate : 1;
  envelopePoints(spans, mediaNow, mediaNow + SCHEDULE_HORIZON_S * rate)
    .filter((point) => point.time > mediaNow)
    .forEach((point) => {
      param.linearRampToValueAtTime(map(point.gain), now + (point.time - mediaNow) / rate);
    });
}

function createTone(): Tone | null {
  const context = getAudioContext();
  if (!context) return null;
  const oscillator = context.createOscillator();
  oscillator.type = "sine";
  oscillator.frequency.value = BEEP_FREQUENCY_HZ;
  const gain = context.createGain();
  gain.gain.value = 0;
  oscillator.connect(gain);
  gain.connect(context.destination);
  oscillator.start();
  return { context, oscillator, gain };
}

function disposeTone(tone: Tone | null) {
  if (!tone) return;
  try {
    tone.oscillator.stop();
  } catch {
    /* уже остановлен */
  }
  tone.oscillator.disconnect();
  tone.gain.disconnect();
}

/**
 * Приблизительное превью неприменённых правок поверх исходника.
 * WebAudio: громкость элемента расписывается на GainNode по огибающей мута
 * (точно по времени аудиоконтекста). Без CORS-графа — запасной путь:
 * media.volume из requestAnimationFrame (~16 мс). Писк — отдельный
 * осциллятор 1 кГц (ему доступ к медиа не нужен); «Свой звук» в превью
 * тоже звучит писком.
 */
export function usePreviewAudio({
  mediaEl,
  active,
  spans,
  method,
  volume,
  muted,
}: PreviewAudioOptions) {
  const spansRef = useRef(spans);
  spansRef.current = spans;
  const volumeRef = useRef(volume);
  volumeRef.current = volume;
  const levelRef = useRef(0);
  levelRef.current = muted ? 0 : volume;
  const rescheduleRef = useRef<() => void>(() => {});

  useEffect(() => {
    if (!active || !mediaEl) return;
    const el = mediaEl;
    const tone = method === "mute" ? null : createTone();
    const toneLevel = (gain: number) =>
      el.paused ? 0 : BEEP_GAIN * levelRef.current * (1 - gain);

    const reschedule = () => {
      const graph = getAudioGraph(el);
      if (graph) {
        scheduleParam(graph.gain.gain, graph.context, el, spansRef.current, (gain) => gain);
      }
      if (tone && graph) {
        scheduleParam(tone.gain.gain, tone.context, el, spansRef.current, toneLevel);
      }
    };
    rescheduleRef.current = reschedule;

    // Граф заводим только в работающем контексте: play почти всегда
    // вызван жестом пользователя, и resume() здесь разрешён.
    const tryAttach = () => {
      const context = getAudioContext();
      if (!context || getAudioGraph(el)) return;
      void context
        .resume()
        .then(() => {
          if (el.paused || getAudioGraph(el)) return;
          if (attachAudioGraph(el)) {
            el.volume = volumeRef.current;
            reschedule();
          }
        })
        .catch(() => {
          /* контекст не запустился — остаёмся на media.volume */
        });
    };

    // Запасной путь: громкость элемента и писк по кадрам.
    let frame = 0;
    const tick = () => {
      frame = requestAnimationFrame(tick);
      if (getAudioGraph(el)) return;
      const gain = gainAt(el.currentTime, spansRef.current);
      el.volume = clamp01(volumeRef.current * gain);
      tone?.gain.gain.setTargetAtTime(toneLevel(gain), tone.context.currentTime, TONE_SMOOTHING_S);
    };
    frame = requestAnimationFrame(tick);

    const onPlay = () => {
      tryAttach();
      reschedule();
    };
    const events = ["playing", "pause", "seeked", "ratechange", "loadedmetadata"] as const;
    el.addEventListener("play", onPlay);
    events.forEach((name) => el.addEventListener(name, reschedule));
    const timer = window.setInterval(reschedule, RESCHEDULE_MS);
    if (!el.paused) tryAttach();
    reschedule();

    return () => {
      cancelAnimationFrame(frame);
      window.clearInterval(timer);
      el.removeEventListener("play", onPlay);
      events.forEach((name) => el.removeEventListener(name, reschedule));
      rescheduleRef.current = () => {};
      const graph = getAudioGraph(el);
      if (graph) {
        const now = graph.context.currentTime;
        holdAt(graph.gain.gain, now);
        graph.gain.gain.setValueAtTime(1, now);
      }
      el.volume = volumeRef.current;
      disposeTone(tone);
    };
  }, [active, mediaEl, method]);

  // Новые правки, громкость и mute — перерасписать огибающую сразу.
  useEffect(() => {
    rescheduleRef.current();
  }, [spans, volume, muted]);
}
