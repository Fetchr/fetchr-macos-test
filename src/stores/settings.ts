import { create } from "zustand";
import { persist } from "zustand/middleware";

import { IS_MACOS } from "@/lib/platform";

import type {
  BlurZone,
  ChatOverlaySettings,
  PerformanceSettings,
  PreviewLayoutSettings,
  ProxyConfig,
} from "@/types/job";

export const defaultChatOverlaySettings: ChatOverlaySettings = {
  enabled: false,
  mode: "transparent_overlay",
  output_width: 1920,
  output_height: 1080,
  fps: 60,
  chat_x: 80,
  chat_y: 760,
  chat_width: 1760,
  chat_height: 260,
  font_family: "Inter",
  font_weight: 400,
  font_style: "normal",
  username_font_weight: 700,
  username_font_style: "normal",
  font_size: 24,
  text_color: "#FFFFFF",
  outline_enabled: true,
  outline_color: "#000000",
  outline_thickness: 2,
  background_enabled: false,
  background_opacity: 0.15,
  background_blur_enabled: true,
  show_badges: true,
  show_timestamps: false,
  show_avatars: false,
  show_bttv: true,
  show_ffz: true,
  show_7tv: true,
  max_visible_messages: 14,
  message_lifetime_sec: 86400,
  direction: "bottom-up",
  alpha_output_format: "mov_png",
  chat_overlay_fps: 18,
  save_alpha_overlay: false,
  save_clean_video: true,
  compose_mode: "direct",
  render_codec: "raw_rgba_pipe",
  final_render_mode: "full",
  solid_background_color: "#212121",
  render_quality: "standard",
};

export const defaultPerformanceSettings: PerformanceSettings = {
  profile: "auto",
  network_concurrent_fragments: 16,
  cpu_threads: null,
  render_workers: null,
  gpu_encoder_mode: "auto",
  ffmpeg_preset: null,
};

export const defaultPreviewLayoutSettings: PreviewLayoutSettings = {
  screenshot_source: "ffmpeg",
  screenshot_time_sec: null,
  screenshot_path: null,
};

export interface IntegrationSettings {
  twitchClientId: string;
  twitchAuthStatus: "not_configured" | "configured";
  twitchAuthToken: string;
  twitchCookieBrowser: string;
  kickAuthStatus: "not_configured" | "public";
  chatExportFolder: string;
  remoteImageLoading: boolean;
  cacheRemoteEmotes: boolean;
}

export const defaultIntegrationSettings: IntegrationSettings = {
  twitchClientId: "",
  twitchAuthStatus: "not_configured",
  twitchAuthToken: "",
  twitchCookieBrowser: "",
  kickAuthStatus: "public",
  chatExportFolder: "",
  remoteImageLoading: true,
  cacheRemoteEmotes: true,
};

export type NavPosition = "top" | "bottom" | "left" | "right";

/**
 * simple («Fetchr»): новый интерфейс, разделы вкладками сверху.
 * macos («MacOS»): тот же интерфейс в оболочке macOS — боковая панель и
 * Liquid Glass. На Mac доступен только он.
 */
export type UiMode = "simple" | "macos";

/**
 * Содержимое страниц из нового интерфейса (поиск, мультивыбор, «Скачать»).
 * Оба режима его показывают: MacOS меняет только оболочку окна. Прежние
 * формы («Старый») убраны.
 */
export function usesSimpleContent(mode: UiMode): boolean {
  return mode === "simple" || mode === "macos";
}

/** На Mac режим всегда macos: другой оболочки там нет. */
export function normalizeUiMode(value: unknown): UiMode {
  if (IS_MACOS) return "macos";
  if (value === "macos") return "macos";
  // «Старый» (advanced) убран вместе с прежними формами: такие установки
  // переходят на новый интерфейс.
  return "simple";
}

interface SettingsState {
  directory: string;
  filenameTemplate: string;
  binariesDir: string | null;
  maxConcurrentJobs: number;
  proxy: ProxyConfig;
  chatOverlay: ChatOverlaySettings;
  performance: PerformanceSettings;
  blurZones: BlurZone[];
  sponsorBlurEnabled: boolean;
  sponsorBlurReferencePath: string | null;
  previewLayout: PreviewLayoutSettings;
  integrations: IntegrationSettings;
  locale: "ru" | "en";
  onboardingCompleted: boolean;
  /** Мастер первого запуска пройден: инструменты выбраны, нужное ПО поставлено */
  setupCompleted: boolean;
  /** Инструменты в навигации; null — все */
  enabledTools: string[] | null;
  /** Где стоит панель навигации */
  navPosition: NavPosition;
  uiMode: UiMode;
  setUiMode: (v: UiMode) => void;
  setNavPosition: (v: NavPosition) => void;
  hideTwitchTokenReminder: boolean;
  setHideTwitchTokenReminder: (v: boolean) => void;
  /** Звук при завершении задачи и при ошибке */
  soundEffects: boolean;
  setSoundEffects: (v: boolean) => void;
  setOnboardingCompleted: (v: boolean) => void;
  setSetupCompleted: (v: boolean) => void;
  setEnabledTools: (v: string[] | null) => void;
  setDirectory: (v: string) => void;
  setFilenameTemplate: (v: string) => void;
  setBinariesDir: (v: string | null) => void;
  setMaxConcurrentJobs: (v: number) => void;
  setProxy: (v: ProxyConfig) => void;
  setChatOverlay: (v: ChatOverlaySettings) => void;
  setPerformance: (v: PerformanceSettings) => void;
  setBlurZones: (v: BlurZone[]) => void;
  setSponsorBlurEnabled: (v: boolean) => void;
  setSponsorBlurReferencePath: (v: string | null) => void;
  setPreviewLayout: (v: PreviewLayoutSettings) => void;
  setIntegrations: (v: IntegrationSettings) => void;
  setLocale: (v: "ru" | "en") => void;
}

export const useSettings = create<SettingsState>()(
  persist(
    (set) => ({
      directory: "",
      filenameTemplate: "Stream_{title}",
      binariesDir: null,
      maxConcurrentJobs: 3,
      proxy: { enabled: false, url: "http://127.0.0.1:2080" },
      chatOverlay: defaultChatOverlaySettings,
      performance: defaultPerformanceSettings,
      blurZones: [],
      sponsorBlurEnabled: false,
      sponsorBlurReferencePath: null,
      previewLayout: defaultPreviewLayoutSettings,
      integrations: defaultIntegrationSettings,
      locale: "ru",
      onboardingCompleted: false,
      setupCompleted: false,
      enabledTools: null,
      navPosition: "top",
      uiMode: normalizeUiMode(undefined),
      setUiMode: (v) => set({ uiMode: normalizeUiMode(v) }),
      setNavPosition: (v) => set({ navPosition: v }),
      hideTwitchTokenReminder: false,
      setHideTwitchTokenReminder: (v) => set({ hideTwitchTokenReminder: v }),
      soundEffects: true,
      setSoundEffects: (v) => set({ soundEffects: v }),
      setDirectory: (v) => set({ directory: v }),
      setFilenameTemplate: (v) => set({ filenameTemplate: v }),
      setBinariesDir: (v) => set({ binariesDir: v }),
      setMaxConcurrentJobs: (v) =>
        set({ maxConcurrentJobs: Math.max(1, Math.min(8, Math.floor(v) || 1)) }),
      setProxy: (v) => set({ proxy: v }),
      setChatOverlay: (v) => set({ chatOverlay: { ...defaultChatOverlaySettings, ...v } }),
      setPerformance: (v) => set({ performance: { ...defaultPerformanceSettings, ...v } }),
      setBlurZones: (v) => set({ blurZones: v }),
      setSponsorBlurEnabled: (v) => set({ sponsorBlurEnabled: v }),
      setSponsorBlurReferencePath: (v) => set({ sponsorBlurReferencePath: v }),
      setPreviewLayout: (v) => set({ previewLayout: { ...defaultPreviewLayoutSettings, ...v } }),
      setIntegrations: (v) =>
        set({ integrations: { ...defaultIntegrationSettings, ...v } }),
      setLocale: (v) => set({ locale: v }),
      setOnboardingCompleted: (v) => set({ onboardingCompleted: v }),
      setSetupCompleted: (v) => set({ setupCompleted: v }),
      setEnabledTools: (v) => set({ enabledTools: v }),
    }),
    {
      name: "fetchr-settings",
      version: 14,
      // Режим интерфейса проверяется при каждом чтении, а не миграцией: так
      // «Старый» переезжает в Fetchr, а на Mac режим всегда MacOS.
      merge: (persisted, current) => {
        const saved = (persisted ?? {}) as Partial<SettingsState>;
        return { ...current, ...saved, uiMode: normalizeUiMode(saved.uiMode) };
      },
      migrate: (persisted, version) => {
        const state = persisted as Partial<SettingsState>;
        if (version < 14) {
          // Старое значение по умолчанию (1) отключало параллельные задачи.
          if (state.maxConcurrentJobs === 1) state.maxConcurrentJobs = 3;
          if (state.performance?.network_concurrent_fragments === 8) {
            state.performance = { ...state.performance, network_concurrent_fragments: 16 };
          }
        }
        if (version < 13) {
          // Мастер первого запуска — для новых установок. Кто уже прошёл
          // обучение, пользуется приложением: всплывать ему незачем.
          state.setupCompleted = state.onboardingCompleted ?? false;
        }
        if (version < 12) {
          // The TUN/VLESS feature is gone; drop its subscription key so the
          // credential stops sitting in localStorage on existing installs.
          delete (state as Record<string, unknown>).subscriptionKey;
        }
        if (version < 11) {
          if (typeof state.maxConcurrentJobs === "number") {
            state.maxConcurrentJobs = Math.max(1, Math.min(5, Math.floor(state.maxConcurrentJobs) || 1));
          }
        }
        if (version < 2) {
          state.chatOverlay = {
            ...defaultChatOverlaySettings,
            ...state.chatOverlay,
            alpha_output_format: "mov_png",
            chat_overlay_fps: 18,
            save_alpha_overlay: true,
            compose_mode: "intermediate",
          };
        }
        if (version < 3 && state.chatOverlay) {
          const oldVerticalDefault =
            (state.chatOverlay.chat_x ?? 1600) === 1600 &&
            (state.chatOverlay.chat_y ?? 260) === 260 &&
            (state.chatOverlay.chat_width ?? 290) === 290 &&
            (state.chatOverlay.chat_height ?? 640) === 640;
          state.chatOverlay = {
            ...defaultChatOverlaySettings,
            ...state.chatOverlay,
            ...(oldVerticalDefault
              ? {
                  chat_x: defaultChatOverlaySettings.chat_x,
                  chat_y: defaultChatOverlaySettings.chat_y,
                  chat_width: defaultChatOverlaySettings.chat_width,
                  chat_height: defaultChatOverlaySettings.chat_height,
                }
              : {}),
          };
        }
        if (version < 4) {
          state.sponsorBlurEnabled = false;
          state.sponsorBlurReferencePath = null;
        }
        if (version < 5) {
          state.chatOverlay = {
            ...defaultChatOverlaySettings,
            ...state.chatOverlay,
            compose_mode: "direct",
            save_alpha_overlay: false,
          };
        }
        if (version < 6) {
          state.chatOverlay = {
            ...defaultChatOverlaySettings,
            ...state.chatOverlay,
            render_codec: state.chatOverlay?.render_codec ?? "raw_rgba_pipe",
            final_render_mode: state.chatOverlay?.final_render_mode ?? "full",
            solid_background_color: state.chatOverlay?.solid_background_color ?? "#212121",
          };
        }
        if (version < 7) {
          state.chatOverlay = {
            ...defaultChatOverlaySettings,
            ...state.chatOverlay,
            message_lifetime_sec: 86400,
          };
        }
        if (version < 8) {
          state.integrations = {
            ...defaultIntegrationSettings,
            chatExportFolder: state.directory ?? "",
          };
        }
        if (version < 9) {
          state.integrations = {
            ...defaultIntegrationSettings,
            ...state.integrations,
            twitchAuthToken: "",
          };
        }
        state.integrations = {
          ...defaultIntegrationSettings,
          ...state.integrations,
        };
        return state;
      },
    },
  ),
);
