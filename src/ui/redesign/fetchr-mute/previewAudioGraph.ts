/**
 * WebAudio-граф превью: медиаэлемент → GainNode → выход. Элемент можно
 * завести в граф только один раз и навсегда, поэтому граф создаётся лишь для
 * загрузки, полученной в CORS-режиме (crossorigin="anonymous" и метка
 * `cors=1` в адресе): asset-протокол Tauri отвечает с
 * Access-Control-Allow-Origin, и звук не «отравлен». Без CORS
 * createMediaElementSource отдал бы тишину — тогда превью работает через
 * media.volume (см. usePreviewAudio).
 */
export interface PreviewAudioGraph {
  context: AudioContext;
  gain: GainNode;
}

/** Метка в адресе медиа: ресурс загружен в CORS-режиме. */
export const CORS_SRC_MARK = "cors=1";

const graphs = new WeakMap<HTMLMediaElement, PreviewAudioGraph>();
let sharedContext: AudioContext | null = null;

type AudioContextCtor = typeof AudioContext;

export function getAudioContext(): AudioContext | null {
  if (sharedContext) return sharedContext;
  const Ctor: AudioContextCtor | undefined =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: AudioContextCtor }).webkitAudioContext;
  if (!Ctor) return null;
  try {
    sharedContext = new Ctor();
  } catch (err) {
    console.error("FetchrMute preview: AudioContext unavailable", err);
    return null;
  }
  return sharedContext;
}

export function getAudioGraph(el: HTMLMediaElement): PreviewAudioGraph | null {
  return graphs.get(el) ?? null;
}

export function hasAudioGraph(el: HTMLMediaElement): boolean {
  return graphs.has(el);
}

/** Текущий ресурс элемента загружен в CORS-режиме и уже открыт. */
function loadedWithCors(el: HTMLMediaElement): boolean {
  return (
    el.crossOrigin === "anonymous" &&
    el.currentSrc.includes(CORS_SRC_MARK) &&
    el.readyState >= HTMLMediaElement.HAVE_METADATA
  );
}

/**
 * Заводит элемент в граф, если это безопасно: CORS-загрузка и работающий
 * AudioContext (в приостановленном контексте элемент замолчал бы).
 */
export function attachAudioGraph(el: HTMLMediaElement): PreviewAudioGraph | null {
  const existing = graphs.get(el);
  if (existing) return existing;
  if (!loadedWithCors(el)) return null;
  const context = getAudioContext();
  if (!context || context.state !== "running") return null;
  try {
    const source = context.createMediaElementSource(el);
    const gain = context.createGain();
    source.connect(gain);
    gain.connect(context.destination);
    const graph = { context, gain };
    graphs.set(el, graph);
    return graph;
  } catch (err) {
    console.error("FetchrMute preview: media element source failed", err);
    return null;
  }
}
