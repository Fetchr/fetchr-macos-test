import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type React from "react";
import { convertFileSrc } from "@tauri-apps/api/core";

import { CORS_SRC_MARK } from "../previewAudioGraph";
import { usePreviewSource } from "./usePreviewSource";

interface MediaPlayerOptions {
  filePath: string;
  outputPath: string | null;
  cacheBuster: number;
  mediaError: string | null;
  /** Идёт обработка: позицией управляет «шоу удаления», снимок не применяем. */
  processing: boolean;
  /** Есть неприменённые правки: «Результат» играет исходник с превью мута. */
  hasPendingEdits: boolean;
  setError: (err: string | null) => void;
  setMediaError: (err: string | null) => void;
}

/** Позиция и состояние плеера перед сменой src — возвращаются после loadedmetadata. */
interface PlaybackSnapshot {
  time: number;
  playing: boolean;
}

// Смена src прерывает отложенный play() — это не ошибка для пользователя.
const isAbortError = (err: unknown) =>
  err instanceof DOMException && err.name === "AbortError";

function buildMediaSrc(
  filePath: string,
  outputPath: string | null,
  showOriginal: boolean,
  cacheBuster: number,
  cors: boolean,
): string {
  // A/B-прослушивание: можно сравнить исходник с обработанным результатом.
  const activePath = showOriginal && outputPath ? filePath : outputPath || filePath;
  if (!activePath) return "";
  // Метка CORS в адресе: смена режима обязана перезагрузить ресурс.
  const corsMark = cors ? `&${CORS_SRC_MARK}` : "";
  return `${convertFileSrc(activePath)}?t=${cacheBuster}${corsMark}`;
}

/** Плеер результата: элемент, позиция, громкость, скорость и A/B-прослушивание. */
export function useMediaPlayer({
  filePath,
  outputPath,
  cacheBuster,
  mediaError,
  processing,
  hasPendingEdits,
  setError,
  setMediaError,
}: MediaPlayerOptions) {
  const mediaRef = useRef<HTMLMediaElement | null>(null);
  // Сам элемент — состоянием: превью вешает на него слушатели и аудиограф.
  const [mediaEl, setMediaEl] = useState<HTMLMediaElement | null>(null);
  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const [currentTime, setCurrentTime] = useState<number>(0);
  const [duration, setDuration] = useState<number>(0);
  const [volume, setVolume] = useState<number>(1.0);
  /** Последняя ненулевая громкость: unmute после ползунка на 0 возвращает её. */
  const lastVolumeRef = useRef<number>(1.0);
  const [isMuted, setIsMuted] = useState<boolean>(false);
  const [playbackRate, setPlaybackRate] = useState<number>(1);
  const [speedOpen, setSpeedOpen] = useState<boolean>(false);
  const speedRef = useRef<HTMLDivElement | null>(null);
  // A/B-прослушивание: исходник против обработанного результата.
  const [showOriginal, setShowOriginal] = useState<boolean>(false);
  // Снимок позиции до смены src (пересборка цензуры, A/B, новый результат).
  const restoreRef = useRef<PlaybackSnapshot | null>(null);
  const lastSrcRef = useRef<{ src: string; filePath: string }>({ src: "", filePath: "" });

  // При смене файла A/B-прослушивание возвращается на результат, а длина и
  // позиция — к нулю: иначе до загрузки метаданных видна длина прошлого файла.
  // Layout-эффект: сброс обязан успеть до loadedmetadata нового файла.
  useLayoutEffect(() => {
    setShowOriginal(false);
    setDuration(0);
    setCurrentTime(0);
    setIsPlaying(false);
    restoreRef.current = null;
  }, [filePath]);

  useEffect(() => {
    if (!speedOpen) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!speedRef.current?.contains(event.target as Node)) {
        setSpeedOpen(false);
      }
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [speedOpen]);

  // Ref-колбэк медиаэлемента: запоминает его и следит за play/pause.
  // Стабильный: иначе React перевызывает его на каждом рендере.
  const attachMedia = useCallback((el: HTMLMediaElement | null) => {
    mediaRef.current = el;
    setMediaEl(el);
    if (el) {
      el.onplay = () => setIsPlaying(true);
      el.onpause = () => setIsPlaying(false);
    }
  }, []);

  const preview = usePreviewSource({
    filePath,
    outputPath,
    showOriginal,
    processing,
    hasPendingEdits,
    mediaRef,
    setMediaError,
  });

  const playMedia = useCallback(
    (el: HTMLMediaElement) => {
      el.play().catch((err) => {
        if (!isAbortError(err)) setError(String(err));
      });
    },
    [setError],
  );

  // Player controls
  const togglePlay = () => {
    if (!mediaRef.current || mediaError) return;
    if (isPlaying) {
      mediaRef.current.pause();
    } else {
      playMedia(mediaRef.current);
    }
  };

  const handleTimeUpdate = () => {
    if (mediaRef.current) {
      setCurrentTime(mediaRef.current.currentTime);
    }
  };

  const handleLoadedMetadata = () => {
    const el = mediaRef.current;
    if (!el) return;
    const total = Number.isFinite(el.duration) ? el.duration : 0;
    setDuration(total);
    el.playbackRate = playbackRate;
    // Любая смена src (пересборка цензуры, A/B, новый результат) сбрасывает
    // позицию на 0 и ставит паузу — возвращаем и то и другое.
    // Во время обработки позицией управляет «шоу удаления» — не вмешиваемся.
    const snapshot = restoreRef.current;
    restoreRef.current = null;
    if (!snapshot || processing) return;
    const target = total > 0 ? Math.min(snapshot.time, total) : snapshot.time;
    if (target > 0) {
      el.currentTime = target;
      setCurrentTime(target);
    }
    if (snapshot.playing) playMedia(el);
  };

  const toggleOriginalResult = () => {
    setShowOriginal((value) => !value);
  };

  const handleVolumeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const vol = parseFloat(e.target.value);
    setVolume(vol);
    if (vol > 0) lastVolumeRef.current = vol;
    if (mediaRef.current) {
      mediaRef.current.volume = vol;
      mediaRef.current.muted = vol === 0;
      setIsMuted(vol === 0);
    }
  };

  const changePlaybackRate = (value: number) => {
    setPlaybackRate(value);
    if (mediaRef.current) {
      mediaRef.current.playbackRate = value;
    }
  };

  const toggleMute = () => {
    if (mediaRef.current) {
      const nextMute = !isMuted;
      if (!nextMute && volume === 0) {
        const restored = lastVolumeRef.current > 0 ? lastVolumeRef.current : 1;
        setVolume(restored);
        mediaRef.current.volume = restored;
      }
      setIsMuted(nextMute);
      mediaRef.current.muted = nextMute;
    }
  };

  // Клик по таймлайну: позиция — доля ширины дорожки под курсором.
  const seekToRatio = (percent: number) => {
    if (duration === 0 || !mediaRef.current || mediaError) return;
    const targetTime = percent * duration;
    mediaRef.current.currentTime = targetTime;
    setCurrentTime(targetTime);
  };

  // Клавиатурный эквивалент клика по таймлайну: мышью позицию задаёт координата
  // курсора, с клавиатуры — шаг от текущей.
  const seekTo = (seconds: number) => {
    if (!mediaRef.current || duration === 0 || mediaError) return;
    const clamped = Math.min(Math.max(seconds, 0), duration);
    mediaRef.current.currentTime = clamped;
    setCurrentTime(clamped);
  };

  // Seek helper
  const seekToTime = useCallback(
    (time: number) => {
      if (mediaRef.current && !mediaError) {
        mediaRef.current.currentTime = time;
        playMedia(mediaRef.current);
      }
    },
    [mediaError, playMedia],
  );

  // Render media converted source
  // Превью неприменённых правок играет исходник: файл результата им уже не
  // соответствует, мут имитирует огибающая (usePreviewAudio).
  const playOriginal = showOriginal || preview.previewing;
  const corsSrc = preview.crossOrigin === "anonymous";
  const mediaSrc = useMemo(
    () => buildMediaSrc(filePath, outputPath, playOriginal, cacheBuster, corsSrc),
    [playOriginal, outputPath, filePath, cacheBuster, corsSrc],
  );

  // Снимок берётся во время рендера, до коммита: как только React выставит
  // новый src, элемент уже сбросит currentTime в 0 и встанет на паузу.
  // Смена файла — не повод переносить позицию. Несработавший снимок не
  // перезаписываем: при двух сменах подряд элемент уже стоит на нуле.
  if (lastSrcRef.current.src !== mediaSrc) {
    const el = mediaRef.current;
    const sameFile = lastSrcRef.current.filePath === filePath;
    if (!sameFile || !mediaSrc) {
      restoreRef.current = null;
    } else if (el && lastSrcRef.current.src && !restoreRef.current) {
      restoreRef.current = { time: el.currentTime, playing: !el.paused };
    }
    lastSrcRef.current = { src: mediaSrc, filePath };
  }

  return {
    mediaRef,
    mediaEl,
    attachMedia,
    mediaSrc,
    previewing: preview.previewing,
    crossOrigin: preview.crossOrigin,
    handleMediaError: preview.handleMediaError,
    isPlaying,
    currentTime,
    setCurrentTime,
    duration,
    volume,
    isMuted,
    playbackRate,
    speedOpen,
    setSpeedOpen,
    speedRef,
    showOriginal,
    togglePlay,
    handleTimeUpdate,
    handleLoadedMetadata,
    toggleOriginalResult,
    handleVolumeChange,
    changePlaybackRate,
    toggleMute,
    seekToRatio,
    seekTo,
    seekToTime,
  };
}

export type MediaPlayer = ReturnType<typeof useMediaPlayer>;
