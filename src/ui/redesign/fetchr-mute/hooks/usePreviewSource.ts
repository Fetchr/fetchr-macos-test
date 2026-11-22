import { useEffect, useRef, useState } from "react";
import type React from "react";

import { hasAudioGraph } from "../previewAudioGraph";

interface PreviewSourceOptions {
  filePath: string;
  outputPath: string | null;
  showOriginal: boolean;
  processing: boolean;
  hasPendingEdits: boolean;
  mediaRef: React.MutableRefObject<HTMLMediaElement | null>;
  setMediaError: (err: string | null) => void;
}

/**
 * Режим превью плеера: при неприменённых правках «Результат» играет исходник.
 * Первое превью переводит элемент в CORS-режим (нужен WebAudio-графу) — и
 * больше не выводит: заведённый в граф элемент без CORS замолчал бы. Если
 * CORS-загрузка не удалась, режим выключается до конца жизни страницы, и
 * превью работает через media.volume.
 */
export function usePreviewSource({
  filePath,
  outputPath,
  showOriginal,
  processing,
  hasPendingEdits,
  mediaRef,
  setMediaError,
}: PreviewSourceOptions) {
  // Исходник не открылся (кодек) — превью невозможно, играем старый результат.
  const [previewFailed, setPreviewFailed] = useState<boolean>(false);
  const [corsBroken, setCorsBroken] = useState<boolean>(false);
  const corsArmedRef = useRef<boolean>(false);

  useEffect(() => {
    setPreviewFailed(false);
  }, [filePath]);
  useEffect(() => {
    if (!hasPendingEdits) setPreviewFailed(false);
  }, [hasPendingEdits]);

  const previewing =
    hasPendingEdits && Boolean(outputPath) && !showOriginal && !processing && !previewFailed;
  // Флаг ставится во время рендера: crossorigin обязан появиться вместе с
  // новым src превью, до начала загрузки.
  if (previewing && !corsBroken) corsArmedRef.current = true;
  const crossOrigin: "anonymous" | undefined =
    corsArmedRef.current && !corsBroken ? "anonymous" : undefined;

  const handleMediaError = (message: string) => {
    const el = mediaRef.current;
    // CORS-загрузка не прошла, а граф ещё не заведён — повторяем без CORS
    // (смена метки в адресе перезагрузит элемент).
    if (crossOrigin && el && !hasAudioGraph(el)) {
      setCorsBroken(true);
      return;
    }
    if (previewing) {
      setPreviewFailed(true);
      return;
    }
    setMediaError(message);
  };

  return { previewing, crossOrigin, handleMediaError };
}
