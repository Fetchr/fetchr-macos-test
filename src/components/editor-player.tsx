import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";

import { ipc } from "@/lib/ipc";
import { cn } from "@/lib/utils";
import { usePersistedState } from "@/hooks/usePersistedState";
import { RedesignIcon } from "@/ui/redesign/icons/iconMap";

import { isHlsUrl, isLocalPreviewUrl, loadHlsJs, twitchReferer, type HlsPlayerHandle } from "./hls-player";
import styles from "./editor-player.module.css";
import { Select } from "@/components/ui/select";

/** Тот же набор методов, что у HlsPlayer: страница блюра подменяет плеер, не меняя остального. */
export type EditorPlayerHandle = HlsPlayerHandle;

interface EditorPlayerProps {
  src: string | null;
  className?: string;
  /** Рисуется поверх картинки: зоны блюра, сетка. */
  overlay?: ReactNode;
  onTimeUpdate?: (seconds: number) => void;
  onDurationChange?: (seconds: number) => void;
  /** Кнопка «Взять кадр» в панели: забрать текущий момент как эталон. */
  onUseMoment?: () => void;
  usingMoment?: boolean;
}

interface HlsLevel {
  height?: number;
}

/** Часть hls.js, которой пользуется плеер. */
interface HlsController {
  levels: HlsLevel[];
  currentLevel: number;
  loadSource: (url: string) => void;
  attachMedia: (media: HTMLMediaElement) => void;
  recoverMediaError: () => void;
  destroy: () => void;
  on: (event: string, cb: (event: string, data: { fatal?: boolean; type?: string; details?: string }) => void) => void;
}

const RATES = [0.25, 0.5, 1, 1.5, 2, 4];
const FRAME_STEP = 1 / 30;

/**
 * Плеер для разметки видео: чистая картинка, зоны поверх и одна панель
 * управления в стиле приложения. Хватает того, что нужно при работе с кадром:
 * покадровый шаг, скорость, качество и «Взять кадр». Видео идёт через hls.js,
 * поэтому открывает и HEVC из записей Twitch в 1440p.
 */
export const EditorPlayer = forwardRef<EditorPlayerHandle, EditorPlayerProps>(
  ({ src, className, overlay, onTimeUpdate, onDurationChange, onUseMoment, usingMoment = false }, ref) => {
    const rootRef = useRef<HTMLDivElement | null>(null);
    const videoRef = useRef<HTMLVideoElement | null>(null);
    const hlsRef = useRef<HlsController | null>(null);
    const [playerSrc, setPlayerSrc] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);
    const [playing, setPlaying] = useState(false);
    const [current, setCurrent] = useState(0);
    const [duration, setDuration] = useState(0);
    const [rate, setRate] = useState(1);
    const [levels, setLevels] = useState<number[]>([]);
    const [level, setLevel] = useState(-1);
    const [muted, setMuted] = usePersistedState("fetchr-editor-player:muted", true);
    const [volume, setVolume] = usePersistedState("fetchr-editor-player:volume", 0.6);

    const captureFrame = useCallback((): string | null => {
      const video = videoRef.current;
      if (!video || video.videoWidth <= 0 || video.videoHeight <= 0) return null;
      const canvas = document.createElement("canvas");
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const context = canvas.getContext("2d");
      if (!context) return null;
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      return canvas.toDataURL("image/png");
    }, []);

    useImperativeHandle(ref, () => ({
      getCurrentTime: () => videoRef.current?.currentTime ?? 0,
      seek: (seconds) => {
        if (videoRef.current) videoRef.current.currentTime = Math.max(0, seconds);
      },
      captureFrame,
      play: () => void videoRef.current?.play().catch(() => undefined),
      pause: () => videoRef.current?.pause(),
      isPaused: () => videoRef.current?.paused ?? true,
    }));

    // Ссылки HLS идут через локальный прокси приложения: у Twitch нужен реферер.
    useEffect(() => {
      let cancelled = false;
      setError(null);
      setPlayerSrc(null);
      if (!src) return;
      if (!isHlsUrl(src) || isLocalPreviewUrl(src)) {
        setPlayerSrc(src);
        return;
      }
      void ipc
        .proxiedHlsUrl(src, twitchReferer(src))
        .then((proxied) => {
          if (!cancelled) setPlayerSrc(proxied);
        })
        .catch((reason) => {
          if (!cancelled) setError(`Не удалось открыть поток: ${String(reason)}`);
        });
      return () => {
        cancelled = true;
      };
    }, [src]);

    useEffect(() => {
      const video = videoRef.current;
      if (!video || !playerSrc) return;
      let disposed = false;
      setError(null);
      setLoading(true);
      setLevels([]);
      setLevel(-1);

      if (!isHlsUrl(playerSrc)) {
        video.src = playerSrc;
      } else {
        void loadHlsJs()
          .then((Hls) => {
            if (disposed) return;
            if (!Hls.isSupported()) {
              video.src = playerSrc;
              return;
            }
            const hls = new Hls({ maxBufferLength: 30, backBufferLength: 60 }) as unknown as HlsController;
            hlsRef.current = hls;
            let recovered = false;
            hls.on(Hls.Events.ERROR, (_event, data) => {
              if (!data.fatal) return;
              if (data.type === Hls.ErrorTypes.MEDIA_ERROR && !recovered) {
                recovered = true;
                hls.recoverMediaError();
                return;
              }
              setLoading(false);
              setError(
                data.type === Hls.ErrorTypes.MEDIA_ERROR
                  ? "Видео не декодируется. Для 1440p (HEVC) нужны «Расширения для видео HEVC» из Microsoft Store."
                  : `Поток не загрузился: ${data.details ?? "ошибка сети"}`,
              );
            });
            hls.on(Hls.Events.MANIFEST_PARSED, () => {
              setLevels(hls.levels.map((item) => item.height ?? 0));
            });
            hls.loadSource(playerSrc);
            hls.attachMedia(video);
          })
          .catch((reason) => {
            setLoading(false);
            setError(String(reason));
          });
      }

      return () => {
        disposed = true;
        hlsRef.current?.destroy();
        hlsRef.current = null;
        video.removeAttribute("src");
        video.load();
      };
    }, [playerSrc]);

    useEffect(() => {
      const video = videoRef.current;
      if (!video) return;
      video.muted = muted;
      video.volume = volume;
    }, [muted, volume, playerSrc]);

    // Горячие клавиши, пока курсор над плеером: так не мешаем полям ввода на странице.
    useEffect(() => {
      const onKey = (event: KeyboardEvent) => {
        const target = event.target as HTMLElement | null;
        if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
        if (!rootRef.current?.matches(":hover")) return;
        const video = videoRef.current;
        if (!video) return;
        const step = event.shiftKey ? 1 : FRAME_STEP;
        switch (event.key) {
          case " ":
          case "k":
            event.preventDefault();
            if (video.paused) void video.play().catch(() => undefined);
            else video.pause();
            break;
          case "ArrowLeft":
            event.preventDefault();
            video.pause();
            video.currentTime = Math.max(0, video.currentTime - step);
            break;
          case "ArrowRight":
            event.preventDefault();
            video.pause();
            video.currentTime = Math.min(video.duration || Infinity, video.currentTime + step);
            break;
          case "j":
            video.currentTime = Math.max(0, video.currentTime - 5);
            break;
          case "l":
            video.currentTime = Math.min(video.duration || Infinity, video.currentTime + 5);
            break;
          case "m":
            setMuted((value) => !value);
            break;
          default:
        }
      };
      document.addEventListener("keydown", onKey);
      return () => document.removeEventListener("keydown", onKey);
    }, [setMuted]);

    const togglePlay = () => {
      const video = videoRef.current;
      if (!video) return;
      if (video.paused) void video.play().catch(() => undefined);
      else video.pause();
    };

    const step = (seconds: number) => {
      const video = videoRef.current;
      if (!video) return;
      video.pause();
      video.currentTime = Math.min(video.duration || Infinity, Math.max(0, video.currentTime + seconds));
    };

    // Клик по пустой картинке запускает и останавливает, а зоны и ручки управляют собой.
    const onSurfaceClick = (event: ReactMouseEvent<HTMLDivElement>) => {
      if ((event.target as HTMLElement).closest("[data-no-pan], button, input, select")) return;
      togglePlay();
    };

    const selectLevel = (index: number) => {
      setLevel(index);
      if (hlsRef.current) hlsRef.current.currentLevel = index;
    };

    return (
      <div ref={rootRef} className={cn(styles.player, className)}>
        <div className={styles.surface} onClick={onSurfaceClick}>
          <video
            ref={videoRef}
            className={styles.video}
            playsInline
            preload="auto"
            onLoadedMetadata={(event) => {
              setLoading(false);
              const value = event.currentTarget.duration || 0;
              setDuration(value);
              onDurationChange?.(value);
            }}
            onDurationChange={(event) => {
              const value = event.currentTarget.duration || 0;
              setDuration(value);
              onDurationChange?.(value);
            }}
            onTimeUpdate={(event) => {
              const value = event.currentTarget.currentTime || 0;
              setCurrent(value);
              onTimeUpdate?.(value);
            }}
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
            onWaiting={() => setLoading(true)}
            onPlaying={() => setLoading(false)}
            onCanPlay={() => setLoading(false)}
            onRateChange={(event) => setRate(event.currentTarget.playbackRate)}
            onError={() => {
              if (!hlsRef.current) setError("Видео не открылось. Проверь ссылку и соединение.");
            }}
          />
          {overlay}
          {loading && !error && (
            <div className={styles.status} aria-live="polite">
              <RedesignIcon name="loading" className="size-5 animate-spin" />
              Готовлю видео…
            </div>
          )}
          {error && (
            <div className={cn(styles.status, styles.statusError)} role="alert">
              <RedesignIcon name="alert" className="size-5" />
              {error}
            </div>
          )}
        </div>

        <div className={styles.bar}>
          <input
            type="range"
            className={styles.seek}
            min={0}
            max={duration || 1}
            step={0.01}
            value={Math.min(current, duration || 1)}
            disabled={!duration}
            aria-label="Положение в видео"
            style={{ ["--fill" as string]: `${duration ? (current / duration) * 100 : 0}%` }}
            onChange={(event) => {
              if (videoRef.current) videoRef.current.currentTime = Number(event.target.value);
            }}
          />
          <div className={styles.row}>
            <div className={styles.group}>
              <button type="button" className={styles.iconButton} onClick={() => step(-FRAME_STEP)} aria-label="Кадр назад" title="Кадр назад (←)">
                ‹
              </button>
              <button type="button" className={cn(styles.iconButton, styles.playButton)} onClick={togglePlay} aria-label={playing ? "Пауза" : "Воспроизвести"} title="Пауза или воспроизведение (пробел)">
                <RedesignIcon name={playing ? "pause" : "play"} className="size-4" />
              </button>
              <button type="button" className={styles.iconButton} onClick={() => step(FRAME_STEP)} aria-label="Кадр вперёд" title="Кадр вперёд (→)">
                ›
              </button>
              <span className={styles.time}>
                {formatClock(current)} <i>/</i> {formatClock(duration)}
              </span>
            </div>

            <div className={styles.group}>
              <Select
                className={styles.select}
                value={rate}
                aria-label="Скорость"
                onValueChange={(value) => {
                  if (videoRef.current) videoRef.current.playbackRate = Number(value);
                }}
              >
                {RATES.map((value) => (
                  <option key={value} value={value}>
                    {value}×
                  </option>
                ))}
              </Select>
              {levels.length > 1 && (
                <Select className={styles.select} value={level} aria-label="Качество" onValueChange={(value) => selectLevel(Number(value))}>
                  <option value={-1}>Авто</option>
                  {levels.map((height, index) => ({ height, index }))
                    .sort((a, b) => b.height - a.height)
                    .map(({ height, index }) => (
                      <option key={index} value={index}>
                        {height ? `${height}p` : `Уровень ${index + 1}`}
                      </option>
                    ))}
                </Select>
              )}
              <button type="button" className={styles.iconButton} onClick={() => setMuted((value) => !value)} aria-label={muted ? "Включить звук" : "Выключить звук"} title="Звук (M)">
                <RedesignIcon name={muted || volume === 0 ? "mute" : "audio"} className="size-4" />
              </button>
              <input
                type="range"
                className={styles.volume}
                min={0}
                max={1}
                step={0.05}
                value={muted ? 0 : volume}
                aria-label="Громкость"
                onChange={(event) => {
                  const value = Number(event.target.value);
                  setVolume(value);
                  setMuted(value === 0);
                }}
              />
              {onUseMoment && (
                <button type="button" className={styles.momentButton} onClick={onUseMoment} disabled={usingMoment || !duration}>
                  <RedesignIcon name={usingMoment ? "loading" : "preview"} className={cn("size-4", usingMoment && "animate-spin")} />
                  {usingMoment ? "Беру…" : "Взять кадр"}
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  },
);

EditorPlayer.displayName = "EditorPlayer";

function formatClock(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}
