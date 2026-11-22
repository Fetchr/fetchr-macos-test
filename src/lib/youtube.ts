/** Ссылка YouTube в адрес встраиваемого плеера; null, если id не найден. */
export function youtubeEmbedUrl(input: string): string | null {
  try {
    const parsed = new URL(input);
    const host = parsed.hostname.replace(/^www\./, "");
    const id =
      host === "youtu.be"
        ? parsed.pathname.slice(1).split("/")[0]
        : parsed.searchParams.get("v") ??
          parsed.pathname.match(/\/(?:shorts|embed|live)\/([^/?]+)/)?.[1];
    return id ? `https://www.youtube.com/embed/${id}` : null;
  } catch {
    const id = input.match(/(?:youtu\.be\/|v=|shorts\/|embed\/|live\/)([A-Za-z0-9_-]{6,})/)?.[1];
    return id ? `https://www.youtube.com/embed/${id}` : null;
  }
}

export interface YoutubeIframePlayer {
  getCurrentTime: () => number;
  destroy?: () => void;
}

export interface YoutubeIframeApi {
  Player: new (
    element: HTMLIFrameElement,
    options: { events?: { onReady?: () => void } },
  ) => YoutubeIframePlayer;
}

declare global {
  interface Window {
    YT?: YoutubeIframeApi;
    onYouTubeIframeAPIReady?: () => void;
    fetchrYoutubeIframeApiReady?: Promise<YoutubeIframeApi>;
  }
}

/** Адрес встраивания с включённым JS API: без него время плеера не узнать. */
export function withYoutubePlayerApi(src: string): string {
  try {
    const parsed = new URL(src);
    parsed.searchParams.set("enablejsapi", "1");
    parsed.searchParams.set("playsinline", "1");
    return parsed.toString();
  } catch {
    return src;
  }
}

/** Один раз подгружает YouTube IFrame API и отдаёт его. */
export function ensureYoutubeIframeApi(): Promise<YoutubeIframeApi> {
  if (window.YT?.Player) {
    return Promise.resolve(window.YT);
  }

  const existing = window.fetchrYoutubeIframeApiReady;
  if (existing) return existing;

  window.fetchrYoutubeIframeApiReady = new Promise((resolve, reject) => {
    const previousReady = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      previousReady?.();
      if (window.YT?.Player) resolve(window.YT);
      else reject(new Error("YouTube iframe API is unavailable"));
    };

    if (!document.querySelector<HTMLScriptElement>('script[src="https://www.youtube.com/iframe_api"]')) {
      const script = document.createElement("script");
      script.src = "https://www.youtube.com/iframe_api";
      script.async = true;
      script.onerror = () => reject(new Error("YouTube iframe API failed to load"));
      document.head.appendChild(script);
    }
  });

  return window.fetchrYoutubeIframeApiReady;
}
