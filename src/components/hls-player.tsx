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
import {
  AlertTriangle,
  Camera,
  Copy,
  Loader2,
  Maximize2,
  Pause,
  PictureInPicture2,
  Play,
  RotateCcw,
  ChevronRight,
  Settings,
  Volume2,
  VolumeX,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  PlaybackSpeedPanel,
  clampSpeed,
  formatSpeed,
} from "@/components/playback-speed-panel";
import { cn } from "@/lib/utils";
import { formatDuration } from "@/lib/format";
import { ipc } from "@/lib/ipc";
import { usePersistedState } from "@/hooks/usePersistedState";
import "@/lib/video-js/video-js.min.css";
import "./hls-player.css";
import videoJsScriptUrl from "@/lib/video-js/video.min.js?url";
import hlsJsScriptUrl from "@/lib/hls-js/hls.min.js?url";
import { Select } from "@/components/ui/select";

declare global {
  interface Window {
    videojs?: VideoJsFactory;
    Hls?: HlsJsFactory;
  }
}

/** A loaded HLS segment: where the player puts it, and its playlist date (ms). */
export interface PlayerFragment {
  start: number;
  duration: number;
  programDateTime: number | null;
}

/** The slice of hls.js used here. */
interface HlsJsInstance {
  levels?: Array<{ details?: { fragments?: PlayerFragment[] } }>;
  currentLevel?: number;
  loadSource: (url: string) => void;
  attachMedia: (media: HTMLMediaElement) => void;
  recoverMediaError: () => void;
  destroy: () => void;
  on: (event: string, cb: (event: string, data: { fatal?: boolean; type?: string; details?: string }) => void) => void;
}

interface HlsJsFactory {
  new (config?: Record<string, unknown>): HlsJsInstance;
  isSupported: () => boolean;
  Events: { ERROR: string; MANIFEST_PARSED: string };
  ErrorTypes: { MEDIA_ERROR: string };
}

let hlsJsPromise: Promise<HlsJsFactory> | null = null;

/** hls.js 1.6+, vendored like Video.js. Its TS demuxer handles HEVC, which
 *  Video.js's mux.js does not — 1440p Twitch recordings are HEVC in MPEG-TS. */
export function loadHlsJs(): Promise<HlsJsFactory> {
  if (window.Hls) return Promise.resolve(window.Hls);
  hlsJsPromise ??= new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = hlsJsScriptUrl;
    script.async = true;
    script.onload = () => (window.Hls ? resolve(window.Hls) : reject(new Error("hls.js loaded without global Hls")));
    script.onerror = () => {
      hlsJsPromise = null;
      reject(new Error("Failed to load local hls.js"));
    };
    document.head.appendChild(script);
  });
  return hlsJsPromise;
}

interface QualityLevel {
  id: string;
  width?: number;
  height?: number;
  bitrate?: number;
  enabled: boolean;
}

interface QualityLevelList {
  length: number;
  selectedIndex: number;
  [index: number]: QualityLevel;
  on: (event: string, cb: () => void) => void;
  off: (event: string, cb: () => void) => void;
}

type VideoJsPlayer = {
  dispose: () => void;
  src: (source?: { src: string; type: string }) => void;
  ready: (cb: () => void) => void;
  on: (event: string, cb: () => void) => void;
  off: (event: string, cb: () => void) => void;
  currentTime: (value?: number) => number;
  duration: () => number;
  bufferedEnd: () => number;
  paused: () => boolean;
  play: () => Promise<void> | void;
  pause: () => void;
  muted: (value?: boolean) => boolean;
  volume: (value?: number) => number;
  playbackRate: (value?: number) => number;
  error: () => { code?: number; message?: string } | null;
  qualityLevels?: () => QualityLevelList;
};

type VideoJsFactory = (
  element: HTMLVideoElement,
  options: Record<string, unknown>,
) => VideoJsPlayer;

let videoJsPromise: Promise<VideoJsFactory> | null = null;

function loadVideoJs(): Promise<VideoJsFactory> {
  if (window.videojs) {
    return Promise.resolve(window.videojs);
  }
  if (videoJsPromise) {
    return videoJsPromise;
  }

  videoJsPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = videoJsScriptUrl;
    script.async = true;
    script.onload = () => {
      if (window.videojs) {
        resolve(window.videojs);
      } else {
        reject(new Error("Video.js loaded without global videojs"));
      }
    };
    script.onerror = () => reject(new Error("Failed to load local Video.js"));
    document.head.appendChild(script);
  });

  return videoJsPromise;
}

/** `0` means "no cap - let the ABR pick whatever fits". */
export const QUALITY_CAPS = [
  { height: 360, label: "360p" },
  { height: 480, label: "480p" },
  { height: 720, label: "720p" },
  { height: 1080, label: "1080p" },
  { height: 0, label: "Auto" },
] as const;

/**
 * Capping at 720p by default: a 1080p60 rendition costs several times the
 * bandwidth for a preview that is rendered a few hundred pixels wide, and the
 * first segment is what the user waits on.
 */
const DEFAULT_MAX_HEIGHT = 720;
/**
 * Deliberately pessimistic starting estimate (≈2 Mbps). Video.js otherwise
 * assumes a fast link and opens on the top rendition, which is exactly the
 * slow first segment we are trying to avoid.
 */
const INITIAL_BANDWIDTH = 2_000_000;
const FRAME_STEP_SEC = 1 / 30;
const PLAYBACK_RATES = [0.25, 0.5, 1, 1.5, 2, 4];
const MAX_AUTO_RETRIES = 3;

export interface HlsPlayerHandle {
  getCurrentTime: () => number;
  seek: (seconds: number) => void;
  /** Segments of the playing rendition (hls.js engine only; [] otherwise). */
  getFragments?: () => PlayerFragment[];
  captureFrame: () => string | null;
  play: () => void;
  pause: () => void;
  isPaused: () => boolean;
}

interface HlsPlayerProps {
  src: string | null;
  className?: string;
  audioInfo?: {
    hasAudio: boolean;
    qualityLabel?: string | null;
  } | null;
  clean?: boolean;
  autoPlay?: boolean;
  /** Drop the built-in position slider, for pages that scrub from their own
   *  timeline. The rest of the transport (play, frame step, volume) stays. */
  hideSeekBar?: boolean;
  /** Enable keyboard control while the player is hovered or focused. */
  hotkeys?: boolean;
  /** Rendered on top of the video surface (blur zone overlays, grids, ...). */
  overlay?: ReactNode;
  onTimeUpdate?: (seconds: number) => void;
  onDurationChange?: (seconds: number) => void;
  /** "hlsjs" feeds the stream through hls.js while Video.js keeps the
   *  controls: needed for HEVC in MPEG-TS (1440p Twitch recordings). */
  engine?: "vhs" | "hlsjs";
  /** Panel over the bottom of the frame and hiding when idle, as in fullscreen. */
  overlayControls?: boolean;
}

export function isHlsUrl(src: string): boolean {
  return src.toLowerCase().split("?")[0]?.includes(".m3u8") ?? false;
}

export function isLocalPreviewUrl(src: string): boolean {
  try {
    const url = new URL(src);
    return (
      (url.hostname === "127.0.0.1" || url.hostname === "localhost") &&
      (url.pathname.startsWith("/hls") || url.pathname.startsWith("/preview/"))
    );
  } catch {
    return false;
  }
}

export function twitchReferer(src: string): string | null {
  return src.includes("twitch.tv") || src.includes("ttvnw.net") || src.includes("cloudfront.net")
    ? "https://www.twitch.tv/"
    : null;
}

function formatBitrate(bitrate?: number): string {
  if (!bitrate || !Number.isFinite(bitrate)) return "-";
  return bitrate >= 1_000_000
    ? `${(bitrate / 1_000_000).toFixed(1)} Mbps`
    : `${Math.round(bitrate / 1000)} kbps`;
}

export const HlsPlayer = forwardRef<HlsPlayerHandle, HlsPlayerProps>(
  (
    {
      src,
      className,
      audioInfo,
      clean,
      autoPlay,
      hideSeekBar,
      hotkeys,
      overlay,
      onTimeUpdate,
      onDurationChange,
      overlayControls,
      engine = "vhs",
    },
    ref,
  ) => {
    // An autoplaying or chrome-less player must stay muted regardless of the
    // stored preference, otherwise the browser blocks playback outright.
    const forceMuted = Boolean(clean || autoPlay);
    const containerRef = useRef<HTMLDivElement | null>(null);
    const surfaceRef = useRef<HTMLDivElement | null>(null);
    const videoRef = useRef<HTMLVideoElement | null>(null);
    const playerRef = useRef<VideoJsPlayer | null>(null);
    const levelsRef = useRef<QualityLevelList | null>(null);
    const retriesRef = useRef(0);
    const hlsRef = useRef<HlsJsInstance | null>(null);
    const retryTimerRef = useRef<number | null>(null);
    const activeRef = useRef(false);

    const [playerSrc, setPlayerSrc] = useState<string | null>(null);
    const [playing, setPlaying] = useState(false);
    // Значок по центру кадра при паузе/старте; key перезапускает анимацию
    const [flash, setFlash] = useState<{ icon: "play" | "pause"; key: number } | null>(null);
    const [fullscreen, setFullscreen] = useState(false);
    const [idle, setIdle] = useState(false);
    const idleTimerRef = useRef<number | null>(null);
    const [current, setCurrent] = useState(0);
    const [duration, setDuration] = useState(0);
    const [error, setError] = useState<string | null>(null);
    const [retrying, setRetrying] = useState(false);
    const [ready, setReady] = useState(false);
    const [storedMuted, setMuted] = usePersistedState("fetchr:player:muted", false);
    const muted = forceMuted || storedMuted;
    const [volume, setVolume] = usePersistedState("fetchr:player:volume", 0.85);
    const [maxHeight, setMaxHeight] = usePersistedState("fetchr:player:maxHeight", DEFAULT_MAX_HEIGHT);
    const [rate, setRate] = useState(1);
    const [stats, setStats] = useState({ height: 0, bitrate: 0, buffer: 0, dropped: 0 });
    const [savedPath, setSavedPath] = useState<string | null>(null);
    const [settingsOpen, setSettingsOpen] = useState(false);
    const [settingsView, setSettingsView] = useState<"main" | "speed">("main");

    // Read by the video.js effect without making it re-run on every change.
    const mutedRef = useRef(muted);
    const volumeRef = useRef(volume);
    useEffect(() => {
      mutedRef.current = muted;
      volumeRef.current = volume;
    }, [muted, volume]);

    const captureFrame = useCallback((): string | null => {
      const video = videoRef.current;
      if (!video || video.videoWidth <= 0 || video.videoHeight <= 0) {
        return null;
      }
      const canvas = document.createElement("canvas");
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const ctx = canvas.getContext("2d");
      if (!ctx) return null;
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      return canvas.toDataURL("image/png");
    }, []);

    useImperativeHandle(ref, () => ({
      getCurrentTime: () => playerRef.current?.currentTime() ?? videoRef.current?.currentTime ?? 0,
      seek: (seconds) => {
        if (playerRef.current) {
          playerRef.current.currentTime(seconds);
        } else if (videoRef.current) {
          videoRef.current.currentTime = seconds;
        }
      },
      getFragments: () => {
        const hls = hlsRef.current;
        const levels = hls?.levels ?? [];
        const level = levels[Math.max(0, hls?.currentLevel ?? 0)] ?? levels[0];
        return level?.details?.fragments ?? [];
      },
      captureFrame,
      play: () => void Promise.resolve(playerRef.current?.play()).catch(() => undefined),
      pause: () => playerRef.current?.pause(),
      isPaused: () => playerRef.current?.paused() ?? true,
    }));

    useEffect(() => {
      let cancelled = false;
      setError(null);
      setReady(false);
      setPlayerSrc(null);
      retriesRef.current = 0;

      if (!src) {
        return;
      }

      if (!isHlsUrl(src) || isLocalPreviewUrl(src)) {
        setPlayerSrc(src);
        return;
      }

      void ipc
        .proxiedHlsUrl(src, twitchReferer(src))
        .then((proxied) => {
          if (!cancelled) {
            setPlayerSrc(proxied);
          }
        })
        .catch((err) => {
          if (!cancelled) {
            setError(`HLS proxy: ${String(err)}`);
          }
        });

      return () => {
        cancelled = true;
      };
    }, [src]);

    useEffect(() => {
      const video = videoRef.current;
      if (!video || !playerSrc) {
        return;
      }

      let disposed = false;
      setError(null);
      setReady(false);

      void loadVideoJs()
        .then((videojs) => {
          if (disposed) {
            return;
          }
          playerRef.current?.dispose();
          const player = videojs(video, {
            controls: false,
            autoplay: clean || autoPlay ? "any" : false,
            muted: forceMuted || mutedRef.current,
            preload: "auto",
            fluid: true,
            playbackRates: PLAYBACK_RATES,
            html5: {
              vhs: {
                overrideNative: true,
                withCredentials: false,
                // Start on the smallest rendition and climb: the first segment
                // is what the user actually waits for.
                enableLowInitialPlaylist: true,
                bandwidth: INITIAL_BANDWIDTH,
                // We cap by height ourselves; letting VHS also cap by the
                // element size fights the manual selector.
                limitRenditionByPlayerDimensions: false,
              },
              nativeAudioTracks: false,
              nativeVideoTracks: false,
            },
          });
          playerRef.current = player;
          player.muted(forceMuted || mutedRef.current);
          player.volume(volumeRef.current);

          const sourceType = (src && isHlsUrl(src)) || isHlsUrl(playerSrc)
            ? "application/x-mpegURL"
            : "video/mp4";
          const useHlsJs = engine === "hlsjs" && sourceType === "application/x-mpegURL";
          if (useHlsJs) {
            // Video.js stays the shell (controls, events, time); hls.js feeds
            // the same <video> through MSE.
            void loadHlsJs()
              .then((Hls) => {
                if (disposed) return;
                if (!Hls.isSupported()) {
                  player.src({ src: playerSrc, type: sourceType });
                  return;
                }
                const hls = new Hls({ maxBufferLength: 40, backBufferLength: 60 });
                hlsRef.current = hls;
                let recovered = false;
                hls.on(Hls.Events.ERROR, (_event, data) => {
                  if (!data.fatal) return;
                  if (data.type === Hls.ErrorTypes.MEDIA_ERROR && !recovered) {
                    recovered = true;
                    hls.recoverMediaError();
                    return;
                  }
                  setError(
                    data.type === Hls.ErrorTypes.MEDIA_ERROR
                      ? "Видео не декодируется: для 1440p (HEVC) нужны «Расширения для видео HEVC» из Microsoft Store"
                      : `HLS: ${data.details ?? "ошибка загрузки"}`,
                  );
                });
                hls.on(Hls.Events.MANIFEST_PARSED, () => {
                  if (clean || autoPlay) void Promise.resolve(player.play()).catch(() => undefined);
                });
                hls.loadSource(playerSrc);
                hls.attachMedia(video);
              })
              .catch((err) => setError(String(err)));
          } else {
            player.src({ src: playerSrc, type: sourceType });
          }

          const levels = player.qualityLevels?.() ?? null;
          levelsRef.current = levels;

          const applyCap = () => {
            const list = levelsRef.current;
            if (!list || list.length === 0) return;
            const cap = maxHeight;
            let anyEnabled = false;
            for (let i = 0; i < list.length; i += 1) {
              const level = list[i];
              const fits = cap === 0 || (level.height ?? 0) <= cap;
              level.enabled = fits;
              anyEnabled = anyEnabled || fits;
            }
            if (!anyEnabled) {
              // Every rendition is above the cap - keep the smallest rather
              // than disabling the stream entirely.
              let smallest = 0;
              for (let i = 1; i < list.length; i += 1) {
                if ((list[i].height ?? 0) < (list[smallest].height ?? 0)) smallest = i;
              }
              list[smallest].enabled = true;
            }
          };

          const readStats = () => {
            const list = levelsRef.current;
            const level = list && list.selectedIndex >= 0 ? list[list.selectedIndex] : null;
            const quality = videoRef.current?.getVideoPlaybackQuality?.();
            setStats({
              height: level?.height ?? videoRef.current?.videoHeight ?? 0,
              bitrate: level?.bitrate ?? 0,
              buffer: Math.max(0, (player.bufferedEnd() || 0) - (player.currentTime() || 0)),
              dropped: quality?.droppedVideoFrames ?? 0,
            });
          };

          levels?.on("addqualitylevel", applyCap);
          levels?.on("change", readStats);

          const onTime = () => {
            const value = player.currentTime() || 0;
            setCurrent(value);
            onTimeUpdate?.(value);
            readStats();
          };
          const onDuration = () => {
            const value = player.duration() || 0;
            setDuration(value);
            onDurationChange?.(value);
          };
          const onPlay = () => setPlaying(true);
          const onPause = () => setPlaying(false);
          const onRate = () => setRate(player.playbackRate() || 1);
          const onError = () => {
            // hls.js reports and recovers its own failures.
            if (hlsRef.current) return;
            const err = player.error();
            const message = `Video.js: ${err?.message ?? err?.code ?? "unknown error"}`;
            // Live HLS drops segments all the time; a silent reconnect beats a
            // red error box the user has to dismiss.
            if (retriesRef.current < MAX_AUTO_RETRIES) {
              retriesRef.current += 1;
              setRetrying(true);
              const delay = 800 * retriesRef.current;
              retryTimerRef.current = window.setTimeout(() => {
                if (disposed) return;
                player.src({ src: playerSrc, type: sourceType });
                void Promise.resolve(player.play()).catch(() => undefined);
                setRetrying(false);
              }, delay);
              return;
            }
            setRetrying(false);
            setError(message);
          };

          player.ready(() => {
            setReady(true);
            applyCap();
            retriesRef.current = 0;
          });
          player.on("timeupdate", onTime);
          player.on("durationchange", onDuration);
          player.on("loadedmetadata", onDuration);
          player.on("progress", readStats);
          player.on("play", onPlay);
          player.on("pause", onPause);
          player.on("ratechange", onRate);
          player.on("error", onError);
        })
        .catch((err) => setError(String(err)));

      return () => {
        disposed = true;
        if (retryTimerRef.current !== null) {
          window.clearTimeout(retryTimerRef.current);
          retryTimerRef.current = null;
        }
        levelsRef.current = null;
        hlsRef.current?.destroy();
        hlsRef.current = null;
        playerRef.current?.dispose();
        playerRef.current = null;
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [playerSrc]);

    // Re-apply the cap when the user changes it without rebuilding the player.
    useEffect(() => {
      const list = levelsRef.current;
      if (!list || list.length === 0) return;
      let anyEnabled = false;
      for (let i = 0; i < list.length; i += 1) {
        const fits = maxHeight === 0 || (list[i].height ?? 0) <= maxHeight;
        list[i].enabled = fits;
        anyEnabled = anyEnabled || fits;
      }
      if (!anyEnabled && list.length > 0) {
        let smallest = 0;
        for (let i = 1; i < list.length; i += 1) {
          if ((list[i].height ?? 0) < (list[smallest].height ?? 0)) smallest = i;
        }
        list[smallest].enabled = true;
      }
    }, [maxHeight]);

    useEffect(() => {
      const player = playerRef.current;
      if (!player) {
        return;
      }
      player.muted(muted);
      player.volume(volume);
    }, [muted, volume]);

    const toggle = useCallback(() => {
      const player = playerRef.current;
      if (!player) {
        return;
      }
      setFlash({ icon: player.paused() ? "play" : "pause", key: Date.now() });
      if (player.paused()) {
        void Promise.resolve(player.play()).catch((err) =>
          setError(`play(): ${err?.message ?? err}`),
        );
      } else {
        player.pause();
      }
    }, []);

    const skip = useCallback((delta: number) => {
      const player = playerRef.current;
      if (!player) {
        return;
      }
      player.currentTime(Math.max(0, (player.currentTime() || 0) + delta));
    }, []);

    /** Nudge by a single frame; paused first, otherwise playback swallows it. */
    const stepFrame = useCallback((direction: 1 | -1) => {
      const player = playerRef.current;
      if (!player) return;
      player.pause();
      player.currentTime(Math.max(0, (player.currentTime() || 0) + direction * FRAME_STEP_SEC));
    }, []);

    const changeRate = useCallback((value: number) => {
      playerRef.current?.playbackRate(value);
      setRate(value);
    }, []);

    const changeVolume = useCallback(
      (value: number) => {
        const next = Math.max(0, Math.min(1, value));
        setVolume(next);
        setMuted(next === 0);
      },
      [setMuted, setVolume],
    );

    const togglePip = useCallback(async () => {
      const video = videoRef.current;
      if (!video) return;
      try {
        if (document.pictureInPictureElement) {
          await document.exitPictureInPicture();
        } else {
          await video.requestPictureInPicture();
        }
      } catch (err) {
        setError(`PiP: ${String(err)}`);
      }
    }, []);

    // На весь экран разворачивается плеер целиком, а не только кадр:
    // иначе в полноэкранном режиме пропадала панель управления
    const toggleFullscreen = useCallback(async () => {
      const container = containerRef.current;
      if (!container) return;
      try {
        if (document.fullscreenElement) {
          await document.exitFullscreen();
        } else {
          await container.requestFullscreen();
        }
      } catch (err) {
        setError(`Fullscreen: ${String(err)}`);
      }
    }, []);

    const saveFrame = useCallback(async () => {
      const dataUrl = captureFrame();
      if (!dataUrl) return;
      // Clipboard images are a bonus: unsupported in some webviews, and a
      // failure here must not stop the save dialog.
      try {
        if (typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
          const blob = await (await fetch(dataUrl)).blob();
          await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
        }
      } catch {
        /* ignored */
      }
      try {
        const stamp = formatDuration(playerRef.current?.currentTime() ?? 0).replace(/:/g, "-");
        const path = await ipc.saveImageDialog(`frame_${stamp}.png`, dataUrl);
        if (path) {
          setSavedPath(path);
          window.setTimeout(() => setSavedPath(null), 2500);
        }
      } catch (err) {
        setError(`Save frame: ${String(err)}`);
      }
    }, [captureFrame]);

    const copyUrl = useCallback(async () => {
      if (!playerSrc) {
        return;
      }
      try {
        await navigator.clipboard.writeText(playerSrc);
      } catch {
        /* noop */
      }
    }, [playerSrc]);

    useEffect(() => {
      const onChange = () => {
        const active = document.fullscreenElement === containerRef.current;
        setFullscreen(active);
        setIdle(false);
        if (idleTimerRef.current !== null) window.clearTimeout(idleTimerRef.current);
        if (active) idleTimerRef.current = window.setTimeout(() => setIdle(true), 2500);
      };
      document.addEventListener("fullscreenchange", onChange);
      return () => document.removeEventListener("fullscreenchange", onChange);
    }, []);

    useEffect(
      () => () => {
        if (idleTimerRef.current !== null) window.clearTimeout(idleTimerRef.current);
      },
      [],
    );

    // В полноэкранном режиме панель ложится поверх кадра и прячется, пока
    // мышь неподвижна; любое движение возвращает её
    const chromeOverVideo = fullscreen || Boolean(overlayControls);
    const wakeControls = useCallback(() => {
      if (!chromeOverVideo) return;
      setIdle(false);
      if (idleTimerRef.current !== null) window.clearTimeout(idleTimerRef.current);
      idleTimerRef.current = window.setTimeout(() => setIdle(true), 2500);
    }, [chromeOverVideo]);

    const onSurfaceClick = useCallback(
      (event: ReactMouseEvent<HTMLDivElement>) => {
        if (clean || error) return;
        const target = event.target as HTMLElement;
        // Клик по оверлею (зоны блюра и т.п.) остаётся за ним
        if (target !== event.currentTarget && !target.closest(".video-js")) return;
        toggle();
      },
      [clean, error, toggle],
    );

    const onSurfaceDoubleClick = useCallback(
      (event: ReactMouseEvent<HTMLDivElement>) => {
        if (clean) return;
        const target = event.target as HTMLElement;
        if (target !== event.currentTarget && !target.closest(".video-js")) return;
        void toggleFullscreen();
      },
      [clean, toggleFullscreen],
    );

    const hideChrome = chromeOverVideo && idle && playing && !settingsOpen;

    // Keyboard control, scoped to a hovered or focused player so two players on
    // one page never both react to the same keypress.
    useEffect(() => {
      if (!hotkeys) return;
      const onKeyDown = (event: KeyboardEvent) => {
        const container = containerRef.current;
        if (!container) return;
        const focused = container.contains(document.activeElement);
        if (!activeRef.current && !focused) return;
        const target = event.target as HTMLElement | null;
        if (
          target &&
          (target.isContentEditable ||
            ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))
        ) {
          return;
        }
        switch (event.key) {
          case " ":
          case "k":
          case "K":
            toggle();
            break;
          case "ArrowLeft":
            skip(event.shiftKey ? -30 : -5);
            break;
          case "ArrowRight":
            skip(event.shiftKey ? 30 : 5);
            break;
          case "j":
          case "J":
            skip(-10);
            break;
          case "l":
          case "L":
            skip(10);
            break;
          case ",":
            stepFrame(-1);
            break;
          case ".":
            stepFrame(1);
            break;
          case "ArrowUp":
            changeVolume(volume + 0.05);
            break;
          case "ArrowDown":
            changeVolume(volume - 0.05);
            break;
          case "m":
          case "M":
            setMuted((value) => !value);
            break;
          case "f":
          case "F":
            void toggleFullscreen();
            break;
          case "p":
          case "P":
            void togglePip();
            break;
          case "s":
          case "S":
            void saveFrame();
            break;
          case "<":
            changeRate(clampSpeed(rate - 0.25));
            break;
          case ">":
            changeRate(clampSpeed(rate + 0.25));
            break;
          default:
            return;
        }
        event.preventDefault();
      };
      document.addEventListener("keydown", onKeyDown);
      return () => document.removeEventListener("keydown", onKeyDown);
    }, [
      hotkeys,
      rate,
      volume,
      toggle,
      skip,
      stepFrame,
      changeVolume,
      changeRate,
      setMuted,
      toggleFullscreen,
      togglePip,
      saveFrame,
    ]);

    const audioLabel = audioInfo?.qualityLabel
      ? `Audio ${audioInfo.qualityLabel}`
      : audioInfo?.hasAudio
        ? "Audio detected"
        : "Audio status";

    return (
      <div
        ref={containerRef}
        tabIndex={hotkeys ? 0 : undefined}
        onMouseEnter={() => {
          activeRef.current = true;
        }}
        onMouseLeave={() => {
          activeRef.current = false;
          // Мышь ушла с кадра — панель поверх него больше не нужна.
          if (overlayControls && !fullscreen) setIdle(true);
        }}
        onMouseMove={wakeControls}
        data-fullscreen={fullscreen || undefined}
        data-overlay-controls={(overlayControls && !fullscreen) || undefined}
        data-idle={hideChrome || undefined}
        className={cn(
          "hls-player flex flex-col overflow-hidden rounded border border-border-default bg-black outline-none",
          className,
        )}
      >
        <div
          ref={surfaceRef}
          className={cn("hls-surface relative aspect-video w-full bg-black", !clean && "hls-surface-interactive")}
          onClick={onSurfaceClick}
          onDoubleClick={onSurfaceDoubleClick}
        >
          <video
            ref={videoRef}
            className="video-js h-full w-full"
            playsInline
            crossOrigin="anonymous"
          />
          {overlay}
          {flash && (
            <div key={flash.key} className="hls-flash" aria-hidden onAnimationEnd={() => setFlash(null)}>
              {flash.icon === "play" ? <Play /> : <Pause />}
            </div>
          )}
          {!src && (
            <div className="absolute inset-0 flex items-center justify-center text-[12px] text-fg-tertiary">
              No source
            </div>
          )}
          {src && !ready && !error && (
            <div className="absolute inset-0 flex items-center justify-center gap-2 bg-black/40 text-[12px] text-fg-secondary">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading stream...
            </div>
          )}
          {retrying && (
            <div className="absolute inset-x-0 top-0 flex items-center justify-center gap-2 bg-black/70 py-1 text-[11px] text-warning">
              <Loader2 className="h-3 w-3 animate-spin" />
              Reconnecting...
            </div>
          )}
          {error && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/70 p-4 text-center text-[12px] text-danger">
              <AlertTriangle className="h-5 w-5" />
              <div className="max-w-[90%] break-words">{error}</div>
              {playerSrc && (
                <Button size="md" variant="secondary" onClick={copyUrl}>
                  <Copy className="h-3.5 w-3.5" />
                  Copy URL
                </Button>
              )}
            </div>
          )}
        </div>
        {!clean && (
          <div className="hls-controls">
            {/* Полоса перемотки — отдельной строкой: в одном ряду с кнопками
                она не помещалась в узкий плеер и выталкивала их за край */}
            {!hideSeekBar && (
              <div className="flex h-7 items-center border-t border-border-default bg-surface px-3 pt-1">
                <input
                  type="range"
                  min={0}
                  max={duration || 0}
                  step={0.5}
                  value={current}
                  onChange={(event) => playerRef.current?.currentTime(Number(event.target.value))}
                  className="h-4 w-full min-w-0 cursor-pointer accent-accent"
                  aria-label="Seek"
                />
              </div>
            )}
            <div
              className={cn(
                "flex min-w-0 items-center gap-1 bg-surface px-2 pb-1.5 pt-1.5 [&>*]:shrink-0",
                hideSeekBar && "border-t border-border-default",
              )}
            >
              <Button size="icon-sm" variant="ghost" onClick={() => skip(-5)} aria-label="-5s" title="-5s (←)">
                <RotateCcw className="h-3.5 w-3.5" />
              </Button>
              <Button size="icon-sm" variant="secondary" onClick={toggle} aria-label="Play/Pause" title="Play/Pause (Space)">
                {playing ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
              </Button>
              <Button size="icon-sm" variant="ghost" onClick={() => skip(5)} aria-label="+5s" title="+5s (→)">
                <RotateCcw className="h-3.5 w-3.5 scale-x-[-1]" />
              </Button>
              <Button size="icon-sm" variant="ghost" onClick={() => stepFrame(-1)} aria-label="Previous frame" title="Previous frame (,)">
                <span className="font-mono text-[11px]">◀|</span>
              </Button>
              <Button size="icon-sm" variant="ghost" onClick={() => stepFrame(1)} aria-label="Next frame" title="Next frame (.)">
                <span className="font-mono text-[11px]">|▶</span>
              </Button>
              <span className="ml-1 whitespace-nowrap font-mono text-[11px] text-fg-secondary tabular">
                {formatDuration(current)} / {formatDuration(duration)}
              </span>
              <span className="min-w-0 flex-1 !shrink" />
              <Button
                size="icon-sm"
                variant="ghost"
                onClick={() => setMuted((value) => !value)}
                aria-label={muted ? "Unmute" : "Mute"}
                title={muted ? "Unmute (M)" : "Mute (M)"}
              >
                {muted ? <VolumeX className="h-3.5 w-3.5" /> : <Volume2 className="h-3.5 w-3.5" />}
              </Button>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={muted ? 0 : volume}
                onChange={(event) => changeVolume(Number(event.target.value))}
                className="h-1 w-16 min-w-0 !shrink accent-accent"
                aria-label="Volume"
                title="Volume (↑/↓)"
              />
              <Button size="icon-sm" variant="ghost" onClick={saveFrame} aria-label="Save frame" title="Save frame (S)">
                <Camera className="h-3.5 w-3.5" />
              </Button>
              <Button size="icon-sm" variant="ghost" onClick={togglePip} aria-label="Picture in picture" title="Picture in picture (P)">
                <PictureInPicture2 className="h-3.5 w-3.5" />
              </Button>
              <Button size="icon-sm" variant="ghost" onClick={toggleFullscreen} aria-label="Fullscreen" title="Fullscreen (F)">
                <Maximize2 className="h-3.5 w-3.5" />
              </Button>
              <Button size="icon-sm" variant="ghost" onClick={copyUrl} aria-label="Copy URL" title="Copy URL">
                <Copy className="h-3.5 w-3.5" />
              </Button>
              {/* Quality, speed and the playback stats live behind the gear:
                  they are consulted rarely and a permanent row for them costs
                  height on every page that embeds a player. */}
              <div className="relative">
                  <Button
                    size="icon-sm"
                    variant={settingsOpen ? "secondary" : "ghost"}
                    onClick={() =>
                      setSettingsOpen((open) => {
                        if (open) setSettingsView("main");
                        return !open;
                      })
                    }
                    aria-label="Настройки воспроизведения"
                    aria-expanded={settingsOpen}
                    title="Качество и скорость"
                  >
                    <Settings className="h-3.5 w-3.5" />
                  </Button>
                  {settingsOpen && (
                    <div className="absolute bottom-full right-0 z-20 mb-1">
                      {settingsView === "speed" ? (
                        <PlaybackSpeedPanel
                          value={rate}
                          onChange={changeRate}
                          onBack={() => setSettingsView("main")}
                          autoFocus
                        />
                      ) : (
                        <div className="flex flex-col gap-1.5 rounded border border-border-default bg-elevated p-2 shadow-lg">
                          <label className="flex items-center justify-between gap-3 whitespace-nowrap text-[11px] text-fg-secondary">
                            <span>Качество</span>
                            <Select
                              value={maxHeight}
                              onValueChange={(value) => setMaxHeight(Number(value))}
                              className="rounded border border-border-default bg-transparent px-1 py-0.5 text-[11px]"
                            >
                              {QUALITY_CAPS.map((cap) => (
                                <option key={cap.height} value={cap.height}>
                                  {cap.label}
                                </option>
                              ))}
                            </Select>
                          </label>
                          <button
                            type="button"
                            onClick={() => setSettingsView("speed")}
                            className="flex items-center justify-between gap-3 whitespace-nowrap rounded px-1 py-0.5 text-left text-2xs text-fg-secondary hover:bg-surface hover:text-fg-primary"
                          >
                            <span>Скорость воспроизведения</span>
                            <span className="flex items-center gap-1 font-mono tabular-nums text-fg-primary">
                              {formatSpeed(rate)}
                              <ChevronRight className="h-3 w-3" />
                            </span>
                          </button>
                          <div className="flex items-center gap-2 border-t border-border-default pt-1.5 font-mono text-[10.5px] text-fg-tertiary">
                            <span
                              className={audioInfo?.hasAudio ? "text-success" : undefined}
                              title={audioLabel}
                            >
                              <Volume2 className="inline h-3 w-3" />
                            </span>
                            <span title="Активное качество потока">
                              {stats.height ? `${stats.height}p` : "-"}
                            </span>
                            <span title="Битрейт">{formatBitrate(stats.bitrate)}</span>
                            <span title="Буфер">buf {stats.buffer.toFixed(1)}s</span>
                            <span title="Пропущено кадров">drop {stats.dropped}</span>
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
            </div>
            {savedPath && (
              <div className="truncate border-t border-border-default bg-surface px-2 py-1 font-mono text-[10.5px] text-success">
                Saved: {savedPath}
              </div>
            )}
          </div>
        )}
      </div>
    );
  },
);
HlsPlayer.displayName = "HlsPlayer";
