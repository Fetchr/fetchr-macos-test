import { useEffect, useMemo, useState, useRef } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";

import { usePersistedState } from "@/hooks/usePersistedState";
import { ipc } from "@/lib/ipc";
import { StreamDownloader } from "@/lib/stream-downloader";
import { detectPlatform } from "@/lib/url";
import { defaultChatOverlaySettings, useSettings } from "@/stores/settings";
import { useWorkflowPresets } from "@/stores/workflowPresets";
import type {
  AlphaOutputFormat,
  ChatComposeMode,
  ChatFontStyle,
  ChatMessageAnimation,
  ChatOverlayMode,
  ChatOverlaySettings,
  ChatRenderCodec,
  ChatRenderQuality,
  SystemFont,
  ChatMessage,
} from "@/types/job";
import { fetchrThemeClassName } from "@/ui/redesign/theme";
import { cn } from "@/lib/utils";
import { PlatformIcon, RedesignIcon } from "@/ui/redesign/icons/iconMap";
import { launchQueueFlight } from "@/ui/redesign/layout";

import styles from "./ChatRenderPage.module.css";
import { ChatFontSettings } from "./ChatExportSettings";
import { ChatOnlyExportPanel, type ExportStatus } from "./ChatOnlyExportPanel";
import { CHAT_PLATFORMS, type ChatPlatform } from "./ChatPlatformSelector";
import { ChatPlacementFields, ChatPositionPanel } from "./ChatPositionPanel";
import { ChatPositionGrid } from "./ChatPositionGrid";
import { ChatRangeBar, ChatSourceBar } from "./ChatSourceBar";
import { ChatStyleToggles } from "./ChatStyleToggles";
import studio from "./ChatStudio.module.css";
import {
  MAX_PREVIEW_MESSAGES,
  normalizeChatPlacement,
  type ChatPlacement,
} from "./ChatPreviewPlacement";

const AUTOSAVE_DELAY_MS = 500;
const JSON_PREVIEW_DEBOUNCE_MS = 300;

export function ChatRenderPage() {
  const settings = useSettings();
  const chatPresets = useWorkflowPresets((state) => state.chatPresets);
  const activeChatPresetId = useWorkflowPresets((state) => state.activeChatPresetId);
  const setActiveChatPreset = useWorkflowPresets((state) => state.setActiveChatPreset);
  const createChatPreset = useWorkflowPresets((state) => state.createChatPreset);
  const saveChatPreset = useWorkflowPresets((state) => state.saveChatPreset);
  const renameChatPreset = useWorkflowPresets((state) => state.renameChatPreset);
  const deleteChatPreset = useWorkflowPresets((state) => state.deleteChatPreset);
  const chat = useMemo(
    () => ({ ...defaultChatOverlaySettings, ...settings.chatOverlay }),
    [settings.chatOverlay],
  );

  const [draftPresetId, setDraftPresetId] = usePersistedState("fetchr-draft:chatRender:presetId", "");
  const [platform, setPlatform] = usePersistedState<ChatPlatform>("fetchr-draft:chatRender:platform", "twitch");
  const [sourceUrl, setSourceUrl] = usePersistedState("fetchr-draft:chatRender:sourceUrl", "");
  // A saved chat JSON usually does not name its channel, and without the channel the render
  // has nowhere to load 7TV/BTTV/FFZ emotes from — they stay plain text.
  const [channelHint, setChannelHint] = usePersistedState("fetchr-draft:chatRender:channelHint", "");
  const [start, setStart] = usePersistedState("fetchr-draft:chatRender:start", "");
  const [end, setEnd] = usePersistedState("fetchr-draft:chatRender:end", "");
  const [fileName, setFileName] = usePersistedState("fetchr-draft:chatRender:fileName", "stream_chat");
  const [directory, setDirectory] = usePersistedState("fetchr-draft:chatRender:directory", settings.directory);
  // frameUrl is intentionally NOT persisted: temp preview frames are deleted between
  // sessions, so a persisted URL used to restore a broken image on the next launch.
  const [frameUrl, setFrameUrl] = useState<string | null>(null);
  const [frameLoading, setFrameLoading] = useState(false);
  const [frameError, setFrameError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"json" | "render" | "queue" | null>(null);
  const [status, setStatus] = useState<ExportStatus | null>(null);
  const [codec, setCodecState] = usePersistedState<ChatRenderCodec>("fetchr-draft:chatRender:codec", "raw_rgba_pipe");
  const [overlayMode, setOverlayMode] = usePersistedState<ChatOverlayMode>("fetchr-draft:chatRender:overlayMode", (chat.mode ?? "direct_render") as ChatOverlayMode);
  const [composeMode, setComposeMode] = usePersistedState<ChatComposeMode>("fetchr-draft:chatRender:composeMode", "direct");
  const [alphaOutputFormat, setAlphaOutputFormat] = usePersistedState<AlphaOutputFormat>("fetchr-draft:chatRender:alphaOutputFormat", "mov_png");
  const [solidBackgroundColor, setSolidBackgroundColor] = usePersistedState("fetchr-draft:chatRender:solidBackgroundColor", chat.solid_background_color ?? "#212121");
  const [alphaBackground, setAlphaBackground] = usePersistedState("fetchr-draft:chatRender:alphaBackground", Boolean(chat.save_alpha_overlay ?? true));
  const [renderQuality, setRenderQuality] = usePersistedState<ChatRenderQuality>("fetchr-draft:chatRender:renderQuality", chat.render_quality ?? "standard");
  const [messageAnimation, setMessageAnimation] = usePersistedState<ChatMessageAnimation>("fetchr-draft:chatRender:messageAnimation", chat.message_animation ?? "none");
  const [fontFamily, setFontFamily] = usePersistedState("fetchr-draft:chatRender:fontFamily", chat.font_family ?? "Inter");
  const [fontStyle, setFontStyle] = usePersistedState<ChatFontStyle>("fetchr-draft:chatRender:fontStyle", "normal");
  const [fontSize, setFontSize] = usePersistedState("fetchr-draft:chatRender:fontSize", chat.font_size ?? 24);
  const [fontWeight, setFontWeight] = usePersistedState("fetchr-draft:chatRender:fontWeight", chat.font_weight ?? 400);
  const [usernameFontWeight, setUsernameFontWeight] = usePersistedState("fetchr-draft:chatRender:usernameFontWeight", chat.username_font_weight ?? 700);
  const [textColor, setTextColor] = usePersistedState("fetchr-draft:chatRender:textColor", chat.text_color ?? "#FFFFFF");
  const [outlineEnabled, setOutlineEnabled] = usePersistedState("fetchr-draft:chatRender:outlineEnabled", Boolean(chat.outline_enabled ?? true));
  const [outlineColor, setOutlineColor] = usePersistedState("fetchr-draft:chatRender:outlineColor", chat.outline_color ?? "#000000");
  const [outlineThickness, setOutlineThickness] = usePersistedState("fetchr-draft:chatRender:outlineThickness", chat.outline_thickness ?? 2);
  const [backgroundEnabled, setBackgroundEnabled] = usePersistedState("fetchr-draft:chatRender:backgroundEnabled", Boolean(chat.background_enabled ?? false));
  const [backgroundOpacity, setBackgroundOpacity] = usePersistedState("fetchr-draft:chatRender:backgroundOpacity", chat.background_opacity ?? 0.15);
  const [backgroundBlurEnabled, setBackgroundBlurEnabled] = usePersistedState("fetchr-draft:chatRender:backgroundBlurEnabled", Boolean(chat.background_blur_enabled ?? true));
  const [showBadges, setShowBadges] = usePersistedState("fetchr-draft:chatRender:showBadges", Boolean(chat.show_badges ?? true));
  const [showTimestamps, setShowTimestamps] = usePersistedState("fetchr-draft:chatRender:showTimestamps", Boolean(chat.show_timestamps ?? false));
  const [showAvatars, setShowAvatars] = usePersistedState("fetchr-draft:chatRender:showAvatars", Boolean(chat.show_avatars ?? false));
  const [showBttv, setShowBttv] = usePersistedState("fetchr-draft:chatRender:showBttv", Boolean(chat.show_bttv ?? true));
  const [showFfz, setShowFfz] = usePersistedState("fetchr-draft:chatRender:showFfz", Boolean(chat.show_ffz ?? true));
  const [show7tv, setShow7tv] = usePersistedState("fetchr-draft:chatRender:show7tv", Boolean(chat.show_7tv ?? true));
  const [saveCleanVideo, setSaveCleanVideo] = usePersistedState("fetchr-draft:chatRender:saveCleanVideo", Boolean(chat.save_clean_video ?? true));
  const [systemFonts, setSystemFonts] = useState<SystemFont[]>([]);
  const [placement, setPlacement] = usePersistedState<ChatPlacement>("fetchr-draft:chatRender:placement", {
    x: chat.chat_x ?? 80,
    y: chat.chat_y ?? 760,
    width: chat.chat_width ?? 1760,
    height: chat.chat_height ?? 260,
    outputWidth: chat.output_width ?? 1920,
    outputHeight: chat.output_height ?? 1080,
  });

  // Inline preset rename / delete-confirm state (window.prompt/confirm are not
  // reliably supported inside the Tauri webview).
  const [editingPresetId, setEditingPresetId] = useState<string | null>(null);
  const [editingPresetName, setEditingPresetName] = useState("");
  const [confirmDeletePresetId, setConfirmDeletePresetId] = useState<string | null>(null);

  const updatePlacement = (next: ChatPlacement) => {
    setPlacement(normalizePlacement(next));
  };

  const [localJsonMessages, setLocalJsonMessages] = useState<ChatMessage[] | null>(null);
  const jsonPreviewRequestRef = useRef(0);

  const loadLocalJsonPreview = async (path: string) => {
    const requestId = ++jsonPreviewRequestRef.current;
    setFrameError(null);
    try {
      const msgs = await ipc.readChatMessagesPreview(path);
      if (requestId !== jsonPreviewRequestRef.current) return; // superseded by a newer request
      setLocalJsonMessages(msgs);
    } catch (err) {
      if (requestId !== jsonPreviewRequestRef.current) return;
      setFrameError(`Не удалось загрузить JSON для предпросмотра: ${String(err)}`);
      setLocalJsonMessages(null);
    }
  };

  const chooseBgImage = async () => {
    try {
      const path = await ipc.chooseImageFile();
      if (path) {
        setFrameUrl(convertFileSrc(path));
      }
    } catch (err) {
      setStatus({ kind: "error", text: `Не удалось выбрать изображение: ${String(err)}` });
    }
  };

  useEffect(() => {
    if (!sourceUrl.toLowerCase().endsWith(".json")) {
      jsonPreviewRequestRef.current++;
      setLocalJsonMessages(null);
      return;
    }
    const timer = window.setTimeout(() => {
      void loadLocalJsonPreview(sourceUrl);
    }, JSON_PREVIEW_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceUrl]);

  const mappedPreviewMessages = useMemo(() => {
    if (!localJsonMessages) return null;
    // Only the tail is mapped/rendered — full chat JSONs can hold 100k+ messages.
    return localJsonMessages.slice(-MAX_PREVIEW_MESSAGES).map((m, idx) => {
      const user = m.display_name || m.username || "User";
      const color = m.user_color || "#FFFFFF";

      const badge = m.badges && m.badges.length > 0
        ? (m.badges[0].title || m.badges[0].id || "")
        : "";

      let text = "";
      let emote = "";
      if (m.fragments) {
        for (const f of m.fragments) {
          if (f.type === "text") {
            text += f.text;
          } else if (f.type === "emote") {
            if (f.text) {
              text += f.text;
            }
            if (!emote) {
              emote = f.text || "Emote";
            }
          }
        }
      }

      return {
        id: idx,
        user,
        color,
        badge,
        text: text || " ",
        emote,
        // Real parts win over the flattened text: emotes render as images
        // instead of their names.
        fragments: m.fragments,
      };
    });
  }, [localJsonMessages]);

  const previewMessages = mappedPreviewMessages;

  useEffect(() => {
    let cancelled = false;
    void ipc.listSystemFonts()
      .then((fonts) => {
        if (cancelled) return;
        setSystemFonts(fonts);
        setFontFamily((current) => {
          if (fonts.length === 0 || fonts.some((font) => font.family === current)) return current;
          const fallback = fonts.find((font) => font.family === "Segoe UI") ?? fonts[0];
          return fallback ? fallback.family : current;
        });
      })
      .catch(() => {
        if (!cancelled) setSystemFonts([]);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const lastSavedRef = useRef<string>("");
  const autosaveTimerRef = useRef<number | null>(null);

  useEffect(() => {
    if (draftPresetId === activeChatPresetId) return;
    const presets = useWorkflowPresets.getState().chatPresets;
    const preset = presets.find((item) => item.id === activeChatPresetId) ?? presets[0] ?? null;
    if (!preset) return;
    setDraftPresetId(activeChatPresetId);
    const overlay = { ...defaultChatOverlaySettings, ...preset.overlay };
    // Restore every persisted render option — previously codec/alpha format/font style
    // were hard-reset on preset load, silently discarding the user's choice.
    setCodecState(overlay.render_codec ?? "raw_rgba_pipe");
    setOverlayMode((overlay.mode ?? "direct_render") as ChatOverlayMode);
    setComposeMode((overlay.compose_mode ?? "direct") as ChatComposeMode);
    setAlphaOutputFormat(overlay.alpha_output_format ?? "mov_png");
    setSolidBackgroundColor(overlay.solid_background_color ?? "#212121");
    setAlphaBackground(Boolean(overlay.save_alpha_overlay ?? true));
    setRenderQuality(overlay.render_quality ?? "standard");
    setMessageAnimation(overlay.message_animation ?? "none");
    setFontFamily(overlay.font_family ?? "Inter");
    setFontStyle((overlay.font_style ?? "normal") as ChatFontStyle);
    setFontSize(overlay.font_size ?? 24);
    setFontWeight(overlay.font_weight ?? 400);
    setUsernameFontWeight(overlay.username_font_weight ?? 700);
    setTextColor(overlay.text_color ?? "#FFFFFF");
    setOutlineEnabled(Boolean(overlay.outline_enabled ?? true));
    setOutlineColor(overlay.outline_color ?? "#000000");
    setOutlineThickness(overlay.outline_thickness ?? 2);
    setBackgroundEnabled(Boolean(overlay.background_enabled ?? false));
    setBackgroundOpacity(overlay.background_opacity ?? 0.15);
    setBackgroundBlurEnabled(Boolean(overlay.background_blur_enabled ?? true));
    setShowBadges(Boolean(overlay.show_badges ?? true));
    setShowTimestamps(Boolean(overlay.show_timestamps ?? false));
    setShowAvatars(Boolean(overlay.show_avatars ?? false));
    setShowBttv(Boolean(overlay.show_bttv ?? true));
    setShowFfz(Boolean(overlay.show_ffz ?? true));
    setShow7tv(Boolean(overlay.show_7tv ?? true));
    setSaveCleanVideo(Boolean(overlay.save_clean_video ?? true));
    const nextPlacement = normalizePlacement({
      ...placement,
      x: overlay.chat_x ?? placement.x,
      y: overlay.chat_y ?? placement.y,
      width: overlay.chat_width ?? placement.width,
      height: overlay.chat_height ?? placement.height,
      outputWidth: overlay.output_width ?? placement.outputWidth,
      outputHeight: overlay.output_height ?? placement.outputHeight,
    });
    setPlacement(nextPlacement);

    // Baseline for the autosave guard: build through the same builder as the memo
    // below so a single field list can't drift apart.
    lastSavedRef.current = JSON.stringify(
      buildChatOverlay(chat, nextPlacement, {
        overlayMode: (overlay.mode ?? "direct_render") as ChatOverlayMode,
        composeMode: (overlay.compose_mode ?? "direct") as ChatComposeMode,
        codec: overlay.render_codec ?? "raw_rgba_pipe",
        alphaOutputFormat: overlay.alpha_output_format ?? "mov_png",
        solidBackgroundColor: overlay.solid_background_color ?? "#212121",
        alphaBackground: Boolean(overlay.save_alpha_overlay ?? true),
        saveCleanVideo: Boolean(overlay.save_clean_video ?? true),
        fontFamily: overlay.font_family ?? "Inter",
        fontStyle: (overlay.font_style ?? "normal") as ChatFontStyle,
        fontSize: overlay.font_size ?? 24,
        fontWeight: overlay.font_weight ?? 400,
        usernameFontWeight: overlay.username_font_weight ?? 700,
        textColor: overlay.text_color ?? "#FFFFFF",
        outlineEnabled: Boolean(overlay.outline_enabled ?? true),
        outlineColor: overlay.outline_color ?? "#000000",
        outlineThickness: overlay.outline_thickness ?? 2,
        backgroundEnabled: Boolean(overlay.background_enabled ?? false),
        backgroundOpacity: overlay.background_opacity ?? 0.15,
        backgroundBlurEnabled: Boolean(overlay.background_blur_enabled ?? true),
        showBadges: Boolean(overlay.show_badges ?? true),
        showTimestamps: Boolean(overlay.show_timestamps ?? false),
        showAvatars: Boolean(overlay.show_avatars ?? false),
        showBttv: Boolean(overlay.show_bttv ?? true),
        showFfz: Boolean(overlay.show_ffz ?? true),
        show7tv: Boolean(overlay.show_7tv ?? true),
        renderQuality: overlay.render_quality ?? "standard",
        messageAnimation: overlay.message_animation ?? "none",
      }),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeChatPresetId, draftPresetId]);

  const chatOverlay = useMemo(
    () =>
      buildChatOverlay(chat, placement, {
        overlayMode,
        composeMode,
        codec,
        alphaOutputFormat,
        solidBackgroundColor,
        alphaBackground,
        saveCleanVideo,
        fontFamily,
        fontStyle,
        fontSize,
        fontWeight,
        usernameFontWeight,
        textColor,
        outlineEnabled,
        outlineColor,
        outlineThickness,
        backgroundEnabled,
        backgroundOpacity,
        backgroundBlurEnabled,
        showBadges,
        showTimestamps,
        showAvatars,
        showBttv,
        showFfz,
        show7tv,
        renderQuality,
        messageAnimation,
      }),
    [
      messageAnimation,
      alphaBackground,
      alphaOutputFormat,
      backgroundEnabled,
      backgroundOpacity,
      backgroundBlurEnabled,
      chat,
      codec,
      composeMode,
      fontFamily,
      fontSize,
      fontStyle,
      fontWeight,
      overlayMode,
      outlineColor,
      outlineEnabled,
      outlineThickness,
      placement,
      renderQuality,
      saveCleanVideo,
      show7tv,
      showAvatars,
      showBadges,
      showBttv,
      showFfz,
      showTimestamps,
      solidBackgroundColor,
      textColor,
      usernameFontWeight,
    ],
  );

  // Debounced autosave: drags and slider moves produce dozens of updates per second,
  // so the preset/global settings write happens only after the user pauses.
  useEffect(() => {
    if (!activeChatPresetId) return;
    if (draftPresetId !== activeChatPresetId) return;
    const serialized = JSON.stringify(chatOverlay);
    if (lastSavedRef.current === serialized) return;

    if (autosaveTimerRef.current !== null) {
      window.clearTimeout(autosaveTimerRef.current);
    }
    autosaveTimerRef.current = window.setTimeout(() => {
      autosaveTimerRef.current = null;
      lastSavedRef.current = serialized;
      saveChatPreset(activeChatPresetId, chatOverlay);
      useSettings.getState().setChatOverlay(chatOverlay);
    }, AUTOSAVE_DELAY_MS);

    return () => {
      if (autosaveTimerRef.current !== null) {
        window.clearTimeout(autosaveTimerRef.current);
        autosaveTimerRef.current = null;
      }
    };
  }, [chatOverlay, activeChatPresetId, draftPresetId, saveChatPreset]);

  const chooseDirectory = async () => {
    const path = await ipc.chooseDirectory();
    if (path) {
      setDirectory(path);
      settings.setDirectory(path);
    }
  };

  const startError = useMemo(() => validateTimeField(start), [start]);
  const endError = useMemo(() => {
    const fieldError = validateTimeField(end);
    if (fieldError) return fieldError;
    const startSec = parseTime(start);
    const endSec = parseTime(end);
    if (startSec != null && endSec != null && endSec <= startSec) {
      return "Конец должен быть позже начала";
    }
    return null;
  }, [start, end]);

  const updatePreview = async () => {
    setFrameLoading(true);
    setFrameError(null);
    try {
      if (!sourceUrl.trim()) throw new Error("Укажите ссылку на запись Twitch или Kick.");
      if (startError) throw new Error(`Начало: ${startError}`);
      const timeSec = parseTime(start) ?? 0;
      const frame = await ipc.capturePreviewFrame({
        url: sourceUrl.trim(),
        timeSec,
        outputWidth: placement.outputWidth,
        outputHeight: placement.outputHeight,
        quality: null,
        proxy: settings.proxy,
        binariesDir: settings.binariesDir,
        twitchAuthToken: settings.integrations.twitchAuthToken || null,
      });
      setFrameUrl(frame.url || convertFileSrc(frame.path));
    } catch (err) {
      setFrameError(String(err));
    } finally {
      setFrameLoading(false);
    }
  };

  // Kick and W.TV go through the same backend queue as Twitch: it pulls Kick VOD chat
  // from Kick's own history API and reads Kick/W.TV json exports.
  const downloadJson = async (origin?: HTMLElement) => {
    await addExportToQueue("json", origin);
  };

  const renderOnly = async (origin?: HTMLElement) => {
    await addExportToQueue("render", origin);
  };

  const chooseJsonFile = async () => {
    try {
      const path = await ipc.chooseJsonFile();
      if (path) {
        setSourceUrl(path);
        const fileBase = path.split(/[/\\]/).pop();
        if (fileBase && !channelHint.trim()) {
          // Our own exports are named "<channel>_<title>_<date>", so the first segment is a
          // usable first guess — shown in an editable field, never applied silently.
          const guess = fileBase.match(/^([A-Za-z0-9_]{3,25})_/)?.[1];
          if (guess) setChannelHint(guess);
        }
        if (fileBase) {
          const nameWithoutExt = fileBase.replace(/\.json$/i, "");
          setFileName(nameWithoutExt);
        }
      }
    } catch (err) {
      setStatus({ kind: "error", text: `Не удалось выбрать JSON файл: ${String(err)}` });
    }
  };

  /**
   * The channel hint as a URL the backend can resolve. Only sent for a local JSON: for a real
   * VOD the backend reads `chat_source_url` as the VOD to pull chat from.
   */
  const channelSourceUrl = useMemo(() => {
    if (!sourceUrl.toLowerCase().trim().endsWith(".json")) return null;
    const value = channelHint.trim().replace(/^@/, "");
    if (!value) return null;
    if (/^https?:\/\//i.test(value)) return value;
    if (platform === "wtv") return null;
    return platform === "kick"
      ? `https://kick.com/${value}`
      : `https://www.twitch.tv/${value}`;
  }, [channelHint, platform, sourceUrl]);

  const addExportToQueue = async (mode: "json" | "render" | "queue" = "render", origin?: HTMLElement) => {
    if (!sourceUrl.trim() || !fileName.trim() || !directory.trim()) return;
    if (isTwitchChannelUrl(sourceUrl)) {
      setStatus({
        kind: "error",
        text: "Нужна ссылка на запись (twitch.tv/videos/<id>), а не на канал.",
      });
      return;
    }
    setBusy(mode);
    setStatus(null);
    try {
      const isLocalJson = sourceUrl.trim().toLowerCase().endsWith(".json");
      const queueTarget = {
        url: sourceUrl.trim(),
        meta: { platform: isLocalJson ? platform : detectPlatform(sourceUrl) },
      };

      // The backend parses start/end strictly as H:MM:SS — normalize so "10:00"
      // and bare seconds are not silently dropped.
      const startSec = parseTime(start);
      const endSec = parseTime(end);

      await StreamDownloader.enqueueChatOnly(
        {
          url: queueTarget.url,
          chat_source_url: channelSourceUrl,
          name: fileName.trim(),
          directory: directory.trim(),
          job_kind: "chat",
          mode: "vod",
          download_kind: "video",
          start: startSec == null ? null : formatHms(startSec),
          end: endSec == null ? null : formatHms(endSec),
          fragments: [],
          split: false,
          split_interval_minutes: null,
          quality: null,
          quality_has_audio: null,
          quality_has_video: null,
          proxy: settings.proxy,
          chat_overlay: chatOverlay,
          performance: settings.performance,
          blur_zones: [],
          binaries_dir: settings.binariesDir,
          twitch_auth_token: settings.integrations.twitchAuthToken || null,
          meta: queueTarget.meta,
        },
        chatOverlay,
        mode === "json" ? "json" : "render",
      );
      launchQueueFlight(origin, fileName.trim());
      setStatus({
        kind: "success",
        text: mode === "json" ? "Скачивание JSON чата добавлено в очередь." : "Экспорт чата добавлен в очередь.",
      });
    } catch (err) {
      setStatus({ kind: "error", text: `Не удалось добавить экспорт в очередь: ${String(err)}` });
    } finally {
      setBusy(null);
    }
  };

  const commitRenamePreset = () => {
    const name = editingPresetName.trim();
    if (editingPresetId && name) {
      renameChatPreset(editingPresetId, name);
    }
    setEditingPresetId(null);
    setEditingPresetName("");
  };

  const fontSettings = (
      <ChatFontSettings
        fontFamily={fontFamily}
        fontSize={fontSize}
        fontWeight={fontWeight}
        usernameFontWeight={usernameFontWeight}
        outlineEnabled={outlineEnabled}
        outlineThickness={outlineThickness}
        backgroundEnabled={backgroundEnabled}
        backgroundOpacity={backgroundOpacity}
        backgroundBlurEnabled={backgroundBlurEnabled}
        systemFonts={systemFonts}
        onFontFamilyChange={setFontFamily}
        onFontSizeChange={(value) => setFontSize(clampDimension(value, 10, 72))}
        onFontWeightChange={(value) => setFontWeight(clampDimension(Math.round(value / 100) * 100, 100, 900))}
        onUsernameFontWeightChange={(value) => setUsernameFontWeight(clampDimension(Math.round(value / 100) * 100, 100, 900))}
        onOutlineEnabledChange={setOutlineEnabled}
        onOutlineThicknessChange={(value) => setOutlineThickness(clampDimension(value, 0, 12))}
        onBackgroundEnabledChange={setBackgroundEnabled}
        onBackgroundOpacityChange={(value) => setBackgroundOpacity(Math.max(0, Math.min(1, value)))}
        onBackgroundBlurEnabledChange={setBackgroundBlurEnabled}
      />
  );

  const [inspectorTab, setInspectorTab] = usePersistedState<"style" | "place" | "output">("fetchr-chat-render-tab", "style");

  // Кадр для превью подтягивается сам, как только вставлена ссылка.
  useEffect(() => {
    if (!sourceUrl.trim().toLowerCase().startsWith("http")) return;
    const timer = window.setTimeout(() => void updatePreview(), 900);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceUrl]);

  const actionsDisabled = !sourceUrl.trim() || !fileName.trim() || !directory.trim() || Boolean(busy) || Boolean(startError || endError);
  const messageCount = localJsonMessages?.length ?? null;
  const qualityLabel = renderQuality === "standard" ? "720p" : renderQuality;
  const outputSummary = `${alphaBackground ? "с альфа-каналом" : "на фоне"} · ${placement.outputWidth}×${placement.outputHeight} · ${qualityLabel}`;

  // Вид чата как на самой платформе: шрифт, веса, обводка и подложка.
  const applyPlatformLook = (id: ChatPlatform) => {
    const look = PLATFORM_LOOKS[id];
    setFontFamily(look.fontFamily);
    setFontStyle("normal");
    setFontWeight(look.fontWeight);
    setUsernameFontWeight(look.usernameFontWeight);
    setTextColor(look.textColor);
    setOutlineEnabled(look.outline > 0);
    setOutlineColor("#000000");
    if (look.outline > 0) setOutlineThickness(look.outline);
    setBackgroundEnabled(look.backgroundOpacity > 0);
    if (look.backgroundOpacity > 0) setBackgroundOpacity(look.backgroundOpacity);
    setBackgroundBlurEnabled(false);
    setShowBadges(true);
  };

  const platformLooks = (
    <div className={studio.section}>
      <span className={studio.label}>Вид платформы</span>
      <div className={cn(studio.segment, studio.segmentWide)} role="group" aria-label="Вид платформы">
        {CHAT_PLATFORMS.map(({ id, label }) => (
          <button
            key={id}
            type="button"
            className={studio.segmentItem}
            onClick={() => applyPlatformLook(id)}
            title={`Оформить чат как на ${label}: шрифт, обводка, подложка. Значки ролей и цвета ников берутся из самого чата.`}
          >
            <PlatformIcon platform={id} className="size-3.5" />
            {label}
          </button>
        ))}
      </div>
    </div>
  );

  const presetList = (
    <div className={studio.presets}>
      {chatPresets.map((preset) => {
        const active = preset.id === activeChatPresetId;
        const editing = preset.id === editingPresetId;
        const armed = confirmDeletePresetId === preset.id;
        return (
          <div key={preset.id} className={cn(studio.preset, active && studio.presetActive)}>
            {editing ? (
              <input
                className={studio.presetInput}
                value={editingPresetName}
                autoFocus
                onChange={(event) => setEditingPresetName(event.target.value)}
                onBlur={commitRenamePreset}
                onKeyDown={(event) => {
                  if (event.key === "Enter") commitRenamePreset();
                  if (event.key === "Escape") {
                    setEditingPresetId(null);
                    setEditingPresetName("");
                  }
                }}
              />
            ) : (
              <button
                type="button"
                className={studio.presetMain}
                onClick={() => setActiveChatPreset(preset.id)}
                onDoubleClick={() => {
                  setEditingPresetId(preset.id);
                  setEditingPresetName(preset.name);
                }}
                title="Двойной клик для переименования"
                aria-pressed={active}
              >
                <span className={studio.presetDot} aria-hidden />
                <span className={studio.presetName}>{preset.name}</span>
              </button>
            )}
            {preset.id !== "chat-default" && !editing && (
              <button
                type="button"
                className={cn(studio.presetDelete, armed && studio.presetDeleteArmed)}
                onClick={() => {
                  if (armed) {
                    deleteChatPreset(preset.id);
                    setConfirmDeletePresetId(null);
                    return;
                  }
                  setConfirmDeletePresetId(preset.id);
                  window.setTimeout(() => {
                    setConfirmDeletePresetId((current) => (current === preset.id ? null : current));
                  }, 3000);
                }}
                title={armed ? "Нажмите ещё раз для подтверждения" : "Удалить пресет"}
                aria-label={armed ? "Подтвердить удаление пресета" : "Удалить пресет"}
              >
                <RedesignIcon name={armed ? "check" : "close"} className="size-3" />
              </button>
            )}
          </div>
        );
      })}
      <button type="button" className={studio.presetAdd} onClick={() => createChatPreset(activeChatPresetId)} title="Сохранить текущий вид как новый пресет">
        <RedesignIcon name="add" className="size-3.5" />
        Новый пресет
      </button>
    </div>
  );

  return (
    <div className={`${fetchrThemeClassName} ${styles.studioPage}`}>
      <div className={studio.host}>
        <div className={studio.editor}>
          <main className={studio.main}>
            <ChatSourceBar
              platform={platform}
              sourceUrl={sourceUrl}
              messageCount={messageCount}
              frameLoading={frameLoading}
              status={status}
              frameError={frameError}
              onSourceUrlChange={setSourceUrl}
              onPlatformChange={setPlatform}
              onChooseJsonFile={() => void chooseJsonFile()}
              onUpdatePreview={() => void updatePreview()}
              onChooseBgImage={chooseBgImage}
            />

            <div className={studio.canvas}>
              <ChatPositionPanel
                placement={placement}
                frameUrl={frameUrl}
                onPlacementChange={updatePlacement}
                platform={platform}
                fontFamily={fontFamily}
                fontStyle={fontStyle}
                fontSize={fontSize}
                fontWeight={fontWeight}
                usernameFontWeight={usernameFontWeight}
                textColor={textColor}
                outlineEnabled={outlineEnabled}
                outlineColor={outlineColor}
                outlineThickness={outlineThickness}
                backgroundEnabled={backgroundEnabled}
                backgroundOpacity={backgroundOpacity}
                backgroundBlurEnabled={backgroundBlurEnabled}
                showBadges={showBadges}
                showTimestamps={showTimestamps}
                showAvatars={showAvatars}
                showEmotes={showBttv || showFfz || show7tv}
                customMessages={previewMessages}
                messageAnimation={messageAnimation}
              />
            </div>

            <ChatRangeBar
              start={start}
              end={end}
              startError={startError}
              endError={endError}
              onStartChange={setStart}
              onEndChange={setEnd}
            />
          </main>

          <aside className={studio.inspector}>
            <div className={studio.inspectorHead}>
              <div className={cn(studio.segment, studio.segmentWide)} role="tablist" aria-label="Настройки">
                {(
                  [
                    ["style", "Стиль"],
                    ["place", "Место"],
                    ["output", "Вывод"],
                  ] as const
                ).map(([id, label]) => (
                  <button
                    key={id}
                    type="button"
                    role="tab"
                    aria-selected={inspectorTab === id}
                    aria-checked={inspectorTab === id}
                    className={studio.segmentItem}
                    onClick={() => setInspectorTab(id)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            <div className={studio.inspectorBody} key={inspectorTab}>
              {inspectorTab === "style" && (
                <>
                  <div className={studio.section}>
                    <span className={studio.label}>Пресет</span>
                    {presetList}
                  </div>
                  {platformLooks}
                  <div className={studio.dockSettings}>{fontSettings}</div>
                  <ChatStyleToggles
                    showBadges={showBadges}
                    showTimestamps={showTimestamps}
                    showAvatars={showAvatars}
                    showBttv={showBttv}
                    showFfz={showFfz}
                    show7tv={show7tv}
                    saveCleanVideo={saveCleanVideo}
                    alphaBackground={alphaBackground}
                    onShowBadgesChange={setShowBadges}
                    onShowTimestampsChange={setShowTimestamps}
                    onShowAvatarsChange={setShowAvatars}
                    onShowBttvChange={setShowBttv}
                    onShowFfzChange={setShowFfz}
                    onShow7tvChange={setShow7tv}
                    onSaveCleanVideoChange={setSaveCleanVideo}
                    onAlphaBackgroundChange={setAlphaBackground}
                  />
                </>
              )}
              {inspectorTab === "place" && (
                <>
                  <div className={studio.section}>
                    <span className={studio.label}>Позиция</span>
                    <div className={studio.posRow}>
                      <ChatPositionGrid placement={placement} onChange={updatePlacement} />
                      <span className={studio.hint}>Или тяните рамку на кадре. Стрелки двигают её точно.</span>
                    </div>
                  </div>
                  <ChatPlacementFields placement={placement} onPlacementChange={updatePlacement} />
                </>
              )}
              {inspectorTab === "output" && (
                <div className={studio.outputPanel}>
                  <ChatOnlyExportPanel
                    simple
                    compact
                    platform={platform}
                    sourceUrl={sourceUrl}
                    channelHint={channelHint}
                    start={start}
                    end={end}
                    fileName={fileName}
                    directory={directory}
                    busy={busy}
                    status={status}
                    startError={startError}
                    endError={endError}
                    renderQuality={renderQuality}
                    onRenderQualityChange={setRenderQuality}
                    messageAnimation={messageAnimation}
                    onMessageAnimationChange={setMessageAnimation}
                    previewLoading={frameLoading}
                    frameError={frameError}
                    onPlatformChange={setPlatform}
                    onSourceUrlChange={setSourceUrl}
                    onChannelHintChange={setChannelHint}
                    onStartChange={setStart}
                    onEndChange={setEnd}
                    onFileNameChange={setFileName}
                    onDirectoryChange={setDirectory}
                    onChooseDirectory={() => void chooseDirectory()}
                    onDownloadJson={(origin) => void downloadJson(origin)}
                    onRenderOnly={(origin) => void renderOnly(origin)}
                    onChooseJsonFile={() => void chooseJsonFile()}
                    onAddToQueue={(origin) => void addExportToQueue("queue", origin)}
                    onUpdatePreview={() => void updatePreview()}
                    onChooseBgImage={chooseBgImage}
                    loadedPreviewCount={localJsonMessages?.length}
                  />
                </div>
              )}
            </div>

            <div className={studio.inspectorFoot}>
              <span className={studio.summary}>{outputSummary}</span>
              <div className={studio.footActions}>
                <button
                  type="button"
                  className={studio.secondary}
                  onClick={(event) => void downloadJson(event.currentTarget)}
                  disabled={actionsDisabled || sourceUrl.toLowerCase().endsWith(".json")}
                  title="Скачать только JSON чата"
                  aria-busy={busy === "json"}
                >
                  <RedesignIcon name={busy === "json" ? "loading" : "exportJson"} className={busy === "json" ? "animate-spin" : undefined} />
                  JSON
                </button>
                <button
                  type="button"
                  className={studio.secondary}
                  onClick={(event) => void addExportToQueue("queue", event.currentTarget)}
                  disabled={actionsDisabled}
                  aria-busy={busy === "queue"}
                >
                  <RedesignIcon name={busy === "queue" ? "loading" : "add"} className={busy === "queue" ? "animate-spin" : undefined} />
                  В очередь
                </button>
                <button
                  type="button"
                  className={studio.primary}
                  onClick={(event) => void renderOnly(event.currentTarget)}
                  disabled={actionsDisabled}
                  aria-busy={busy === "render"}
                >
                  <RedesignIcon name={busy === "render" ? "loading" : "play"} className={busy === "render" ? "animate-spin" : undefined} />
                  Рендер
                </button>
              </div>
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
}

interface ChatOverlayDraftValues {
  overlayMode: ChatOverlayMode;
  composeMode: ChatComposeMode;
  codec: ChatRenderCodec;
  alphaOutputFormat: AlphaOutputFormat;
  solidBackgroundColor: string;
  alphaBackground: boolean;
  saveCleanVideo: boolean;
  fontFamily: string;
  fontStyle: ChatFontStyle;
  fontSize: number;
  fontWeight: number;
  usernameFontWeight: number;
  textColor: string;
  outlineEnabled: boolean;
  outlineColor: string;
  outlineThickness: number;
  backgroundEnabled: boolean;
  backgroundOpacity: number;
  backgroundBlurEnabled: boolean;
  showBadges: boolean;
  showTimestamps: boolean;
  showAvatars: boolean;
  showBttv: boolean;
  showFfz: boolean;
  show7tv: boolean;
  renderQuality: ChatRenderQuality;
  messageAnimation: ChatMessageAnimation;
}

/** Single builder for the overlay payload — used by the memo, the preset-load
 * baseline and the autosave guard, so the field list can't drift apart. */
function buildChatOverlay(
  chat: ChatOverlaySettings,
  placement: ChatPlacement,
  values: ChatOverlayDraftValues,
): ChatOverlaySettings {
  return {
    ...chat,
    enabled: true,
    output_width: placement.outputWidth,
    output_height: placement.outputHeight,
    fps: chat.fps ?? 60,
    chat_overlay_fps: chat.chat_overlay_fps ?? 18,
    chat_x: placement.x,
    chat_y: placement.y,
    chat_width: placement.width,
    chat_height: placement.height,
    mode: values.overlayMode,
    compose_mode: values.composeMode,
    render_codec: values.codec,
    alpha_output_format: values.alphaOutputFormat,
    solid_background_color: values.solidBackgroundColor,
    save_alpha_overlay: values.alphaBackground,
    save_clean_video: values.saveCleanVideo,
    font_family: values.fontFamily,
    font_style: values.fontStyle,
    font_size: values.fontSize,
    font_weight: values.fontWeight,
    username_font_weight: values.usernameFontWeight,
    username_font_style: values.fontStyle,
    text_color: values.textColor,
    outline_enabled: values.outlineEnabled,
    outline_color: values.outlineColor,
    outline_thickness: values.outlineThickness,
    background_enabled: values.backgroundEnabled,
    background_opacity: values.backgroundOpacity,
    background_blur_enabled: values.backgroundBlurEnabled,
    max_visible_messages: 999,
    message_lifetime_sec: 86400,
    show_badges: values.showBadges,
    show_timestamps: values.showTimestamps,
    show_avatars: values.showAvatars,
    show_bttv: values.showBttv,
    show_ffz: values.showFfz,
    show_7tv: values.show7tv,
    render_quality: values.renderQuality,
    message_animation: values.messageAnimation,
    message_animation_ms: 280,
  };
}

interface PlatformLook {
  fontFamily: string;
  fontWeight: number;
  usernameFontWeight: number;
  textColor: string;
  outline: number;
  backgroundOpacity: number;
}

const PLATFORM_LOOKS: Record<ChatPlatform, PlatformLook> = {
  twitch: { fontFamily: "Inter", fontWeight: 400, usernameFontWeight: 700, textColor: "#EFEFF1", outline: 2, backgroundOpacity: 0 },
  kick: { fontFamily: "Inter", fontWeight: 500, usernameFontWeight: 700, textColor: "#FFFFFF", outline: 0, backgroundOpacity: 0.85 },
  wtv: { fontFamily: "Inter", fontWeight: 400, usernameFontWeight: 600, textColor: "#ECEEF1", outline: 0, backgroundOpacity: 0.8 },
};

const TIME_FULL = /^\d{1,4}:[0-5]\d:[0-5]\d$/;
const TIME_MIN_SEC = /^\d{1,3}:[0-5]\d$/;
const TIME_SECONDS = /^\d+$/;

/** Strict time parsing: accepts SS, MM:SS or HH:MM:SS with sane minute/second ranges. */
function parseTime(value: string): number | null {
  const raw = value.trim();
  if (!raw) return null;
  if (TIME_SECONDS.test(raw)) return Number(raw);
  const parts = raw.split(":").map(Number);
  if (TIME_FULL.test(raw)) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (TIME_MIN_SEC.test(raw)) return parts[0] * 60 + parts[1];
  return null;
}

function validateTimeField(value: string): string | null {
  const raw = value.trim();
  if (!raw) return null;
  return parseTime(raw) == null ? "Формат: ЧЧ:ММ:СС, ММ:СС или секунды" : null;
}

/** Backend parse_hms accepts only H:MM:SS — always serialize in that shape. */
function formatHms(totalSeconds: number): string {
  const total = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${hours}:${pad(minutes)}:${pad(seconds)}`;
}

function normalizePlacement(placement: ChatPlacement): ChatPlacement {
  const outputWidth = clampDimension(placement.outputWidth, 320, 7680);
  const outputHeight = clampDimension(placement.outputHeight, 180, 4320);
  const normalized = normalizeChatPlacement({ ...placement, outputWidth, outputHeight });
  return { ...normalized, outputWidth, outputHeight };
}

function clampDimension(value: number, min: number, max: number): number {
  const normalized = Number.isFinite(value) ? Math.round(value) : min;
  return Math.max(min, Math.min(max, normalized));
}

function isTwitchChannelUrl(input: string): boolean {
  return /^(?:https?:\/\/)?(?:www\.|m\.)?twitch\.tv\/[A-Za-z0-9_]+\/?(?:[?#].*)?$/i.test(input.trim());
}
