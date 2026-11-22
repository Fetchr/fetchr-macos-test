import { useEffect, useMemo, useRef, useState } from "react";
import { ask } from "@tauri-apps/plugin-dialog";
import { useTranslation } from "react-i18next";

import { usePersistedState } from "@/hooks/usePersistedState";
import {
  ipc,
  onSponsorTimelineProgress,
  onSponsorTrackerProgress,
  type SponsorTimelineThumbnails,
  type SponsorTrackerEngine,
} from "@/lib/ipc";
import { useSettings } from "@/stores/settings";
import { useWorkflowPresets } from "@/stores/workflowPresets";
import type { BlurShape, BlurZone, PreviewSource } from "@/types/job";
import type { HlsPlayerHandle } from "@/components/hls-player";
import { RedesignIcon } from "@/ui/redesign/icons/iconMap";
import { fetchrThemeClassName } from "@/ui/redesign/theme";
import { cn } from "@/lib/utils";

import studio from "../chat-render/ChatStudio.module.css";
import styles from "./SponsorBlurPage.module.css";
import { SponsorTimeline } from "./SponsorTimeline";
import {
  SponsorVideoPreview,
  type SponsorPreviewMode,
  type SponsorPreviewSource,
} from "./SponsorVideoPreview";
import { SponsorZoneList } from "./SponsorZoneList";
import { clampSponsorZone } from "./SponsorZoneOverlay";
import {
  SponsorZoneProperties,
  type SponsorZoneUiSettings,
} from "./SponsorZoneProperties";

const DEFAULT_FRAME_TIME = 0;

interface SponsorTrackReport {
  matched: number;
  analyzed: number;
  minConfidence: number;
  maxConfidence: number;
  endTimeSec: number;
  truncated: boolean;
  engine: string;
  device: string;
  redetections: number;
  gaps: [number, number][];
  fps: number;
}

export function SponsorBlurPage() {
  const { t } = useTranslation();
  const settings = useSettings();
  const sponsorPresets = useWorkflowPresets((state) => state.sponsorPresets);
  const activeSponsorPresetId = useWorkflowPresets((state) => state.activeSponsorPresetId);
  const setActiveSponsorPreset = useWorkflowPresets((state) => state.setActiveSponsorPreset);
  const createSponsorPreset = useWorkflowPresets((state) => state.createSponsorPreset);
  const saveSponsorPreset = useWorkflowPresets((state) => state.saveSponsorPreset);
  const renameSponsorPreset = useWorkflowPresets((state) => state.renameSponsorPreset);
  const deleteSponsorPreset = useWorkflowPresets((state) => state.deleteSponsorPreset);
  const activeSponsorPreset = sponsorPresets.find((preset) => preset.id === activeSponsorPresetId) ?? sponsorPresets[0] ?? null;
  const effectiveSponsorPresetId = activeSponsorPreset?.id ?? "";

  const zoneLabel = (index: number) =>
    t("sponsor_blur.zone_default_name", { index: index + 1, defaultValue: `Zone ${index + 1}` });

  const [draftPresetId, setDraftPresetId] = usePersistedState("fetchr-draft:sponsorBlur:presetId", "");
  const [videoUrl, setVideoUrl] = usePersistedState("fetchr-draft:sponsorBlur:videoUrl", "");
  const [frameTimeInput, setFrameTimeInput] = usePersistedState("fetchr-draft:sponsorBlur:frameTimeInput", "00:00:00");
  const [frameTime, setFrameTime] = usePersistedState<number | null>("fetchr-draft:sponsorBlur:frameTime", null);
  const [draftZones, setDraftZones] = usePersistedState<BlurZone[]>("fetchr-draft:sponsorBlur:draftZones", () => settings.blurZones.map(clampSponsorZone));
  const [selectedId, setSelectedId] = usePersistedState<string | null>("fetchr-draft:sponsorBlur:selectedId", () => settings.blurZones[0]?.id ?? null);
  const [zoneUi, setZoneUi] = usePersistedState<Record<string, SponsorZoneUiSettings>>("fetchr-draft:sponsorBlur:zoneUi", () =>
    buildZoneUi(settings.blurZones, zoneLabel),
  );
  const [previewMode, setPreviewMode] = usePersistedState<SponsorPreviewMode>("fetchr-draft:sponsorBlur:previewMode", "frame");
  const [showZones, setShowZones] = usePersistedState("fetchr-draft:sponsorBlur:showZones", true);
  const [showGrid, setShowGrid] = usePersistedState("fetchr-draft:sponsorBlur:showGrid", true);
  const [drawingMode, setDrawingMode] = usePersistedState("fetchr-draft:sponsorBlur:drawingMode", false);
  const [duration, setDuration] = usePersistedState<number | null>("fetchr-draft:sponsorBlur:duration", null);
  const [trackStart, setTrackStart] = usePersistedState("fetchr-draft:sponsorBlur:trackStart", "");
  const [trackEnd, setTrackEnd] = usePersistedState("fetchr-draft:sponsorBlur:trackEnd", "");
  // Defaults are the new-pipeline ones: 5 fps sampling (the neural tracker is
  // causal and likes dense samples) and a ZNCC similarity threshold, not the
  // old MSE score — hence the fresh storage keys, so stale drafts do not
  // resurrect values that mean something different now.
  const [sampleIntervalInput, setSampleIntervalInput] = usePersistedState("fetchr-draft:sponsorBlur:sampleInterval2", "0.2");
  const [confidenceInput, setConfidenceInput] = usePersistedState("fetchr-draft:sponsorBlur:confidence2", "0.45");
  const [analysisWidthInput, setAnalysisWidthInput] = usePersistedState("fetchr-draft:sponsorBlur:analysisWidth", "960");
  const [trackerEngine, setTrackerEngine] = usePersistedState<SponsorTrackerEngine>("fetchr-draft:sponsorBlur:engine", "hybrid");
  const [useGpu, setUseGpu] = usePersistedState("fetchr-draft:sponsorBlur:useGpu", true);
  const [lockSize, setLockSize] = usePersistedState("fetchr-draft:sponsorBlur:lockSize", true);
  // Where the tracker lost each zone's banner — drawn as gaps on the timeline.
  const [zoneGaps, setZoneGaps] = usePersistedState<Record<string, [number, number][]>>("fetchr-draft:sponsorBlur:zoneGaps", {});

  // Volatile UI state (not persisted: it reflects the current session only).
  const [saved, setSaved] = useState(true);
  const [loadingFrame, setLoadingFrame] = useState(false);
  const [trackingZone, setTrackingZone] = useState(false);
  const [trackingProgress, setTrackingProgress] = useState<{ percent: number; message: string } | null>(null);
  const [trackReport, setTrackReport] = useState<SponsorTrackReport | null>(null);
  const [frameError, setFrameError] = useState<string | null>(null);
  const [renamingPresetId, setRenamingPresetId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [referenceMissing, setReferenceMissing] = useState(false);
  const [missingImageIds, setMissingImageIds] = useState<Record<string, boolean>>({});
  const [thumbnails, setThumbnails] = useState<SponsorTimelineThumbnails | null>(null);
  const [thumbnailsLoading, setThumbnailsLoading] = useState(false);
  const [thumbnailsMessage, setThumbnailsMessage] = useState<string | null>(null);
  const [playerUrl, setPlayerUrl] = useState<string | null>(null);
  const [playerLoading, setPlayerLoading] = useState(false);
  const [playerTime, setPlayerTime] = useState(0);
  const [playerPlaying, setPlayerPlaying] = useState(false);

  const lastSavedRef = useRef<string>("");
  const skipAutosaveRef = useRef(false);
  const captureRequestRef = useRef(0);
  const sliderDebounceRef = useRef<number | null>(null);
  const trackTaskIdRef = useRef<string | null>(null);
  const thumbsTaskIdRef = useRef<string | null>(null);
  const playerRef = useRef<HlsPlayerHandle | null>(null);
  const previewSessionRef = useRef<PreviewSource | null>(null);
  const scrubbingRef = useRef(false);
  const lastSeekRef = useRef(0);
  const lastScrubRef = useRef(0);
  const seekedOnOpenRef = useRef(false);

  useEffect(() => {
    if (draftPresetId || draftZones.length > 0 || settings.blurZones.length === 0) return;
    const zones = settings.blurZones.map(clampSponsorZone);
    setDraftZones(zones);
    setSelectedId((current) => current ?? zones[0]?.id ?? null);
    setZoneUi((current) => ({ ...buildZoneUi(zones, zoneLabel), ...current }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftPresetId, draftZones.length, settings.blurZones, setDraftZones, setSelectedId, setZoneUi]);

  // Import preset -> draft. Depends only on the preset ID, reads fresh state
  // via getState() so it never re-runs from store object identity changes.
  useEffect(() => {
    if (!effectiveSponsorPresetId) return;
    if (draftPresetId === effectiveSponsorPresetId) return;
    const preset = useWorkflowPresets
      .getState()
      .sponsorPresets.find((item) => item.id === effectiveSponsorPresetId);
    if (!preset) return;

    skipAutosaveRef.current = true;
    setDraftPresetId(effectiveSponsorPresetId);
    const zones = preset.zones.map(clampSponsorZone);
    setDraftZones(zones);
    setSelectedId(zones[0]?.id ?? null);
    setZoneUi(buildZoneUi(zones, zoneLabel));
    const current = useSettings.getState();
    if (current.sponsorBlurEnabled !== preset.enabled) {
      current.setSponsorBlurEnabled(preset.enabled);
    }
    if (current.sponsorBlurReferencePath !== preset.referencePath) {
      current.setSponsorBlurReferencePath(preset.referencePath);
    }
    setSaved(true);
    lastSavedRef.current = JSON.stringify({
      zones,
      enabled: preset.enabled,
      referencePath: preset.referencePath,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveSponsorPresetId, draftPresetId]);

  // Autosave draft -> preset. Skipped during the import commit and when the
  // draft still belongs to a different preset (prevents overwriting the newly
  // selected preset with stale draft data and the resulting update loop).
  useEffect(() => {
    if (!activeSponsorPresetId) return;
    if (skipAutosaveRef.current) {
      skipAutosaveRef.current = false;
      return;
    }
    if (draftPresetId !== activeSponsorPresetId) return;
    const serialized = JSON.stringify({
      zones: draftZones,
      enabled: settings.sponsorBlurEnabled,
      referencePath: settings.sponsorBlurReferencePath,
    });
    if (lastSavedRef.current === serialized) return;
    lastSavedRef.current = serialized;

    const zones = draftZones.map(clampSponsorZone);
    const current = useSettings.getState();
    current.setBlurZones(zones);
    saveSponsorPreset(activeSponsorPresetId, zones, current.sponsorBlurEnabled, current.sponsorBlurReferencePath);
    setSaved(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    draftZones,
    settings.sponsorBlurEnabled,
    settings.sponsorBlurReferencePath,
    activeSponsorPresetId,
    draftPresetId,
    saveSponsorPreset,
  ]);

  // Validate the persisted reference frame path: it points into a temp folder
  // and the OS may have cleaned it between sessions.
  useEffect(() => {
    const path = settings.sponsorBlurReferencePath;
    if (!path) {
      setReferenceMissing(false);
      return;
    }
    let cancelled = false;
    ipc.pathsExist([path])
      .then(([exists]) => {
        if (!cancelled) setReferenceMissing(!exists);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [settings.sponsorBlurReferencePath]);

  // Validate image_overlay paths so the UI can warn before the render silently
  // skips the zone.
  const zoneImagePathsKey = useMemo(
    () =>
      JSON.stringify(
        draftZones
          .filter((zone) => zone.effect === "image_overlay" && zone.image_path)
          .map((zone) => [zone.id, zone.image_path]),
      ),
    [draftZones],
  );
  useEffect(() => {
    const entries = JSON.parse(zoneImagePathsKey) as [string, string][];
    if (entries.length === 0) {
      setMissingImageIds({});
      return;
    }
    let cancelled = false;
    ipc.pathsExist(entries.map(([, path]) => path))
      .then((results) => {
        if (cancelled) return;
        const map: Record<string, boolean> = {};
        entries.forEach(([id], index) => {
          map[id] = !results[index];
        });
        setMissingImageIds(map);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [zoneImagePathsKey]);

  // Subscribe to tracker progress events while a tracking run is active.
  useEffect(() => {
    if (!trackingZone) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    onSponsorTrackerProgress((payload) => {
      if (!disposed) setTrackingProgress(payload);
    })
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch(() => {});
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [trackingZone]);

  // Subscribe to filmstrip progress while it is being built.
  useEffect(() => {
    if (!thumbnailsLoading) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    onSponsorTimelineProgress((payload) => {
      if (!disposed) setThumbnailsMessage(payload.message || null);
    })
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch(() => {});
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [thumbnailsLoading]);

  // A different video invalidates the filmstrip.
  useEffect(() => {
    setThumbnails(null);
    setThumbnailsMessage(null);
  }, [videoUrl]);

  // Pending slider capture is cancelled on unmount, and so is a running
  // filmstrip build — otherwise it keeps spawning FFmpeg after the page is gone.
  useEffect(() => {
    return () => {
      if (sliderDebounceRef.current !== null) {
        window.clearTimeout(sliderDebounceRef.current);
      }
      if (thumbsTaskIdRef.current) {
        void ipc.cancelTimelineThumbnails(thumbsTaskIdRef.current).catch(() => {});
      }
    };
  }, []);

  // A playable preview URL is only resolved once the user actually opens the
  // video tab: for non-HLS sources it spawns an FFmpeg remux, too expensive to
  // start for everyone who merely lands on the page.
  useEffect(() => {
    const inputUrl = videoUrl.trim();
    if (previewMode !== "video" || !inputUrl) {
      return;
    }
    let cancelled = false;
    seekedOnOpenRef.current = false;
    setPlayerLoading(true);
    void ipc
      .startStreamPreview(
        inputUrl,
        settings.proxy,
        settings.binariesDir,
        null,
        settings.integrations.twitchAuthToken || null,
      )
      .then((preview) => {
        if (cancelled) {
          if (preview.id) void ipc.stopStreamPreview(preview.id).catch(() => {});
          return;
        }
        previewSessionRef.current = preview;
        setPlayerUrl(preview.url);
        setFrameError(null);
      })
      .catch((err) => {
        if (!cancelled) setFrameError(String(err));
      })
      .finally(() => {
        if (!cancelled) setPlayerLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [previewMode, videoUrl, settings.proxy, settings.binariesDir, settings.integrations.twitchAuthToken]);

  // Tear the FFmpeg-backed preview session down on unmount and whenever the
  // source changes; leaking it keeps a transcode running in the background.
  useEffect(() => {
    return () => {
      const session = previewSessionRef.current;
      previewSessionRef.current = null;
      if (session?.id) {
        void ipc.stopStreamPreview(session.id).catch(() => {});
      }
    };
  }, [videoUrl]);

  const selectedZone = useMemo(
    () => draftZones.find((zone) => zone.id === selectedId) ?? draftZones[0] ?? null,
    [draftZones, selectedId],
  );
  const selectedUi = selectedZone ? zoneUi[selectedZone.id] ?? defaultZoneUi(zoneLabel(draftZones.indexOf(selectedZone))) : null;
  const reference = useMemo<SponsorPreviewSource | null>(() => {
    if (settings.sponsorBlurReferencePath) return { kind: "local", src: settings.sponsorBlurReferencePath };
    return null;
  }, [settings.sponsorBlurReferencePath]);

  const changeZone = (id: string, patch: Partial<BlurZone>) => {
    setDraftZones((zones) =>
      zones.map((zone) => (zone.id === id ? clampSponsorZone({ ...zone, ...patch }) : zone)),
    );
    setSaved(false);
  };

  const changeZoneUi = (id: string, patch: Partial<SponsorZoneUiSettings>) => {
    setZoneUi((current) => ({
      ...current,
      [id]: { ...(current[id] ?? defaultZoneUi(zoneLabel(0))), ...patch },
    }));
    setSaved(false);
  };

  const addZone = (shape?: unknown) => {
    const zoneShape: BlurShape = shape === "ellipse" ? "ellipse" : "rectangle";
    const id = crypto.randomUUID?.() ?? String(Date.now());
    const zone = clampSponsorZone({
      id,
      enabled: true,
      x: 120 + (draftZones.length % 12) * 36,
      y: 120 + (draftZones.length % 12) * 28,
      width: 420,
      height: 140,
      effect: "mosaic",
      intensity: 12,
      image_path: null,
      image_fit: "contain",
      tracking: null,
      shape: zoneShape,
      edge_softness: 0,
      quality: "balanced",
      opacity: 1,
    });
    setDraftZones((zones) => [...zones, zone]);
    setZoneUi((current) => ({ ...current, [id]: defaultZoneUi(zoneLabel(draftZones.length)) }));
    setSelectedId(id);
    setSaved(false);
  };

  const createZoneFromRect = (rect: Pick<BlurZone, "x" | "y" | "width" | "height">) => {
    const id = crypto.randomUUID?.() ?? String(Date.now());
    const zone = clampSponsorZone({
      id,
      enabled: true,
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
      effect: "mosaic",
      intensity: 12,
      image_path: null,
      image_fit: "contain",
      tracking: null,
      shape: "rectangle",
      edge_softness: 0,
      quality: "balanced",
      opacity: 1,
    });
    setDraftZones((zones) => [...zones, zone]);
    setZoneUi((current) => ({
      ...current,
      [id]: defaultZoneUi(t("sponsor_blur.tracker_zone_name", "Трекер")),
    }));
    setSelectedId(id);
    setDrawingMode(false);
    setSaved(false);
  };

  const deleteZone = (id: string) => {
    setDraftZones((zones) => zones.filter((zone) => zone.id !== id));
    setZoneUi((current) => {
      const next = { ...current };
      delete next[id];
      return next;
    });
    setSelectedId((current) => (current === id ? null : current));
    setSaved(false);
  };

  const duplicateZone = () => {
    if (!selectedZone) return;
    const id = crypto.randomUUID?.() ?? String(Date.now());
    const zone = clampSponsorZone({
      ...selectedZone,
      id,
      x: selectedZone.x + 32,
      y: selectedZone.y + 32,
    });
    setDraftZones((zones) => [...zones, zone]);
    setZoneUi((current) => ({
      ...current,
      [id]: {
        ...(selectedUi ?? defaultZoneUi(zoneLabel(draftZones.length))),
        name: `${selectedUi?.name ?? getZoneName(selectedZone, 0)} ${t("sponsor_blur.copy_suffix", "копия")}`,
      },
    }));
    setSelectedId(id);
    setSaved(false);
  };

  const clearZones = () => {
    setDraftZones([]);
    setZoneUi({});
    setSelectedId(null);
    setSaved(false);
  };

  const chooseZoneImage = async (id: string) => {
    const path = await ipc.chooseImageFile();
    if (path) changeZone(id, { image_path: path, effect: "image_overlay" });
  };

  const captureFrame = async (targetTimeSec?: number, random = false) => {
    const inputUrl = videoUrl.trim();
    if (!inputUrl) {
      setFrameError(t("sponsor_blur.error_specify_video", "Укажите URL или путь к видео."));
      return;
    }

    // Last request wins: rapid slider moves fire several captures, and only the
    // newest one is allowed to touch the preview state.
    const requestId = ++captureRequestRef.current;
    setLoadingFrame(true);
    setFrameError(null);
    try {
      let currentDuration = duration;
      if (currentDuration === null) {
        const resolved = await ipc.resolveStream(inputUrl, settings.proxy, settings.binariesDir, settings.integrations.twitchAuthToken || null);
        currentDuration = resolved.is_live ? 0 : Math.max(1, resolved.duration ?? 3600);
        setDuration(currentDuration);
      }

      let timeSec = targetTimeSec ?? parseTime(frameTimeInput) ?? DEFAULT_FRAME_TIME;
      if (random && currentDuration) {
        timeSec = Math.random() * currentDuration;
      }

      if (currentDuration) {
        timeSec = Math.max(0, Math.min(currentDuration, timeSec));
      }

      const frame = await ipc.capturePreviewFrame({
        url: inputUrl,
        timeSec,
        outputWidth: 1920,
        outputHeight: 1080,
        quality: null,
        proxy: settings.proxy,
        binariesDir: settings.binariesDir,
        twitchAuthToken: settings.integrations.twitchAuthToken || null,
      });
      if (requestId !== captureRequestRef.current) return;
      settings.setSponsorBlurReferencePath(frame.path);
      setFrameTime(frame.time_sec);
      setFrameTimeInput(formatTime(frame.time_sec));
      void ipc.chatRenderLogAction("sponsor_blur_reference_frame_selected", {
        source: inputUrl,
        time_sec: frame.time_sec,
        path: frame.path,
      }).catch(() => {});
    } catch (err) {
      if (requestId !== captureRequestRef.current) return;
      const message = String(err);
      setFrameError(message);
      void ipc.chatRenderLogAction("sponsor_blur_reference_frame_failed", {
        source: inputUrl,
        error: message,
      }).catch(() => {});
    } finally {
      if (requestId === captureRequestRef.current) {
        setLoadingFrame(false);
      }
    }
  };

  // Scrubbing in the player is free, but the reference frame still comes from
  // FFmpeg at full 1920x1080: zones are authored in that design space, and a
  // canvas grab of a 720p rendition would be a blurry stand-in.
  const useCurrentPlayerMoment = () => {
    const at = playerRef.current?.getCurrentTime() ?? playerTime;
    if (at == null) return;
    setFrameTimeInput(formatTime(at));
    void captureFrame(at);
  };

  // Leaving the video tab carries the playback position over, so "Извлечь кадр"
  // in frame mode continues from wherever the user stopped watching.
  useEffect(() => {
    if (previewMode === "video" || playerTime <= 0) return;
    setFrameTimeInput(formatTime(playerTime));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewMode]);

  // Playback drives the playhead, except while the user is dragging it - then
  // the drag wins, or the two would fight each other every timeupdate. The
  // one-second escape hatch matters: a pointer released outside the window
  // never fires pointerup here, and the playhead would freeze for good.
  const handlePlayerTime = (value: number) => {
    setPlayerPlaying(playerRef.current?.isPaused() === false);
    if (scrubbingRef.current) {
      if (Date.now() - lastScrubRef.current < 1000) return;
      scrubbingRef.current = false;
    }
    setPlayerTime(value);
  };

  const handlePlayerDuration = (value: number) => {
    if (value > 0 && (duration === null || Math.abs(duration - value) > 1)) {
      setDuration(value);
    }
    // First metadata after opening the video tab: jump to where the reference
    // frame was taken, so both modes show the same moment.
    if (!seekedOnOpenRef.current) {
      seekedOnOpenRef.current = true;
      const start = frameTime ?? 0;
      if (start > 0) {
        playerRef.current?.seek(start);
        setPlayerTime(start);
      }
    }
  };

  // Seeking an HLS stream outside the buffer costs a segment fetch, so pointer
  // moves are throttled; the exact position is applied on release.
  const seekPlayerThrottled = (value: number) => {
    const now = Date.now();
    if (now - lastSeekRef.current < 150) return;
    lastSeekRef.current = now;
    playerRef.current?.seek(value);
  };

  // Timeline scrubbing. In video mode the playhead drives the player directly.
  // In frame mode dragging only moves the playhead and the frame is pulled once
  // on release - extraction is a network seek plus an FFmpeg spawn, far too
  // expensive to fire per pointer move.
  const handleTimelineScrub = (value: number) => {
    scrubbingRef.current = true;
    lastScrubRef.current = Date.now();
    if (previewMode === "video") {
      setPlayerTime(value);
      seekPlayerThrottled(value);
      return;
    }
    setFrameTime(value);
    setFrameTimeInput(formatTime(value));
  };

  const handleTimelineScrubCommit = (value: number) => {
    scrubbingRef.current = false;
    if (previewMode === "video") {
      setPlayerTime(value);
      lastSeekRef.current = 0;
      playerRef.current?.seek(value);
      return;
    }
    setFrameTime(value);
    setFrameTimeInput(formatTime(value));
    if (sliderDebounceRef.current !== null) {
      window.clearTimeout(sliderDebounceRef.current);
      sliderDebounceRef.current = null;
    }
    void captureFrame(value);
  };

  const togglePlayback = () => {
    const player = playerRef.current;
    if (!player) return;
    if (player.isPaused()) {
      player.play();
      setPlayerPlaying(true);
    } else {
      player.pause();
      setPlayerPlaying(false);
    }
  };

  const stepPlayback = (deltaSec: number) => {
    const player = playerRef.current;
    if (!player) return;
    const next = Math.max(0, (player.getCurrentTime() || 0) + deltaSec);
    player.seek(next);
    setPlayerTime(next);
  };

  const handleTimelineRange = (start: number | null, end: number | null) => {
    if (start !== null) setTrackStart(formatTime(start));
    if (end !== null) setTrackEnd(formatTime(end));
  };

  const buildTimelineThumbnails = async () => {
    const inputUrl = videoUrl.trim();
    if (!inputUrl || !duration || duration <= 0) return;
    const previous = thumbsTaskIdRef.current;
    if (previous) void ipc.cancelTimelineThumbnails(previous).catch(() => {});
    const taskId = crypto.randomUUID?.() ?? String(Date.now());
    thumbsTaskIdRef.current = taskId;
    setThumbnailsLoading(true);
    setThumbnailsMessage(null);
    try {
      const strip = await ipc.captureTimelineThumbnails({
        url: inputUrl,
        durationSec: duration,
        taskId,
        quality: null,
        proxy: settings.proxy,
        binariesDir: settings.binariesDir,
        twitchAuthToken: settings.integrations.twitchAuthToken || null,
      });
      if (thumbsTaskIdRef.current !== taskId) return;
      setThumbnails(strip);
    } catch (err) {
      const message = String(err);
      if (!message.includes("cancelled")) setFrameError(message);
    } finally {
      if (thumbsTaskIdRef.current === taskId) {
        thumbsTaskIdRef.current = null;
        setThumbnailsLoading(false);
        setThumbnailsMessage(null);
      }
    }
  };

  const trackSelectedZone = async () => {
    const zone = selectedZone;
    const inputUrl = videoUrl.trim();
    const referencePath = settings.sponsorBlurReferencePath;
    if (!zone || !inputUrl || !referencePath) {
      setFrameError(t("sponsor_blur.error_specify_tracking", "Выберите видео, кадр и прямоугольник для трекинга."));
      return;
    }

    const startTime = parseTime(trackStart) ?? 0;
    const endTime = parseTime(trackEnd);
    const durationSec = (endTime !== null && endTime > startTime) ? (endTime - startTime) : null;

    const sampleInterval = Number(sampleIntervalInput) > 0 ? Number(sampleIntervalInput) : 0.2;
    const confidenceThreshold = Number(confidenceInput) > 0 ? Number(confidenceInput) : 0.45;
    const analysisWidth = Number(analysisWidthInput) > 0 ? Math.round(Number(analysisWidthInput)) : 960;
    const taskId = crypto.randomUUID?.() ?? String(Date.now());
    trackTaskIdRef.current = taskId;
    setTrackingZone(true);
    setTrackingProgress({ percent: 0, message: "" });
    setTrackReport(null);
    setFrameError(null);
    try {
      const result = await ipc.trackSponsorZone({
        url: inputUrl,
        referenceFramePath: referencePath,
        zone,
        taskId,
        startTimeSec: startTime,
        durationSec,
        sampleIntervalSec: sampleInterval,
        confidenceThreshold,
        engine: trackerEngine,
        analysisWidth,
        useGpu,
        lockSize,
        outputWidth: 1920,
        outputHeight: 1080,
        quality: null,
        proxy: settings.proxy,
        binariesDir: settings.binariesDir,
        twitchAuthToken: settings.integrations.twitchAuthToken || null,
      });
      changeZone(zone.id, {
        tracking: {
          enabled: true,
          start_time_sec: startTime,
          end_time_sec: result.end_time_sec,
          sample_interval_sec: sampleInterval,
          search_radius: 0,
          confidence_threshold: confidenceThreshold,
          keyframes: result.keyframes,
          gaps: result.gaps,
        },
      });
      settings.setSponsorBlurEnabled(true);
      setZoneGaps((current) => ({ ...current, [zone.id]: result.gaps }));
      setTrackReport({
        matched: result.matched_frames,
        analyzed: result.analyzed_frames,
        minConfidence: result.min_confidence,
        maxConfidence: result.max_confidence,
        endTimeSec: result.end_time_sec,
        truncated: result.truncated,
        engine: result.engine,
        device: result.device,
        redetections: result.redetections,
        gaps: result.gaps,
        fps: result.analysis_fps,
      });
      setFrameError(null);
    } catch (err) {
      const message = String(err);
      if (message.includes("cancelled")) {
        // Cancel is a user action, not an error.
        setFrameError(null);
      } else if (message.includes("tracker found no matches")) {
        setFrameError(t("sponsor_blur.error_tracking_failed", "Трекер не нашёл совпадений по хронометражу видео."));
      } else if (message.includes("not visible at the start")) {
        setFrameError(t("sponsor_blur.error_not_at_start", "Баннер не виден в начале диапазона. Укажите «От» равным времени захваченного кадра или захватите кадр заново."));
      } else if (message.includes("almost no contrast")) {
        setFrameError(t("sponsor_blur.error_flat_zone", "В выделенной области почти нет деталей — выделите участок с контрастным содержимым."));
      } else if (message.includes("model")) {
        setFrameError(t("sponsor_blur.error_model", "Не удалось загрузить модель трекера (~0,7 МБ). Проверьте интернет или переключитесь на режим «Корреляция»."));
      } else {
        setFrameError(message);
      }
    } finally {
      setTrackingZone(false);
      setTrackingProgress(null);
      trackTaskIdRef.current = null;
    }
  };

  const cancelTracking = () => {
    const taskId = trackTaskIdRef.current;
    if (taskId) void ipc.cancelSponsorTracker(taskId).catch(() => {});
  };

  const commitRename = (presetId: string) => {
    const name = renameValue.trim();
    if (name) renameSponsorPreset(presetId, name);
    setRenamingPresetId(null);
  };

  const confirmDeletePreset = async (presetId: string, presetName: string) => {
    const confirmed = await ask(
      t("sponsor_blur.preset_delete_confirm", { name: presetName, defaultValue: `Удалить пресет "${presetName}"?` }),
      { title: t("sponsor_blur.preset_delete_tooltip", "Удалить пресет"), kind: "warning" },
    );
    if (confirmed) deleteSponsorPreset(presetId);
  };

  const canTrackSelected = Boolean(videoUrl.trim() && settings.sponsorBlurReferencePath && selectedZone && !loadingFrame);

  const [inspectorTab, setInspectorTab] = usePersistedState<"zones" | "tracker" | "presets">("fetchr-sponsor-blur-tab", "zones");

  // Кадр для разметки зон извлекается сам после вставки ссылки.
  useEffect(() => {
    if (!videoUrl.trim()) return;
    const timer = window.setTimeout(() => void captureFrame(undefined), 900);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoUrl]);

  // Всё про трекер: диапазон, движок, параметры, запуск и отчёт. В простом режиме
  // это окошко за иконкой в таймлайне, в расширенном остаётся в боковой панели.
  const trackerPanel = (
    <>
      <div style={{ height: 1, background: "var(--fetchr-color-border-subtle)", margin: "8px 0" }} />
    
      <div className={styles.twoColumn} style={{ gap: 4 }}>
        <label className={styles.fieldCompact}>
          <span className={styles.label}>{t("sponsor_blur.from", "От")}</span>
          <input
            className={`${styles.input} ${styles.mono}`}
            style={{ height: 30, fontSize: "12px", padding: "0 6px" }}
            value={trackStart}
            placeholder="00:00:00"
            onChange={(e) => setTrackStart(e.target.value)}
          />
        </label>
        <label className={styles.fieldCompact}>
          <span className={styles.label}>{t("sponsor_blur.to", "До")}</span>
          <input
            className={`${styles.input} ${styles.mono}`}
            style={{ height: 30, fontSize: "12px", padding: "0 6px" }}
            value={trackEnd}
            placeholder="00:00:00"
            onChange={(e) => setTrackEnd(e.target.value)}
          />
        </label>
      </div>
    
      <div style={{ display: "flex", gap: 4, marginTop: 6 }}>
        <button
          className={`${styles.button} ${trackerEngine === "hybrid" ? styles.segmentActive : ""}`}
          style={{ flex: 1, height: 30, fontSize: "12px" }}
          type="button"
          onClick={() => setTrackerEngine("hybrid")}
          title={t("sponsor_blur.engine_hybrid_tooltip", "Нейросетевой трекер VitTrack (ONNX) + проверка по ZNCC. Лучшее качество, модель ~0,7 МБ скачивается один раз.")}
        >
          {t("sponsor_blur.engine_hybrid", "ИИ-трекер")}
        </button>
        <button
          className={`${styles.button} ${trackerEngine === "correlation" ? styles.segmentActive : ""}`}
          style={{ flex: 1, height: 30, fontSize: "12px" }}
          type="button"
          onClick={() => setTrackerEngine("correlation")}
          title={t("sponsor_blur.engine_zncc_tooltip", "Только нормализованная корреляция. Без модели и интернета, хуже при перекрытии баннера.")}
        >
          {t("sponsor_blur.engine_zncc", "Корреляция")}
        </button>
      </div>
    
      <div className={styles.twoColumn} style={{ gap: 4, gridTemplateColumns: "repeat(3, minmax(0, 1fr))", marginTop: 4 }}>
        <label className={styles.fieldCompact}>
          <span className={styles.label} title={t("sponsor_blur.sample_interval_tooltip", "Шаг анализа, сек. Меньше — точнее сопровождение при быстром движении.")}>{t("sponsor_blur.sample_interval", "Шаг, с")}</span>
          <input
            className={`${styles.input} ${styles.mono}`}
            style={{ height: 30, fontSize: "12px", padding: "0 6px" }}
            value={sampleIntervalInput}
            placeholder="0.2"
            onChange={(e) => setSampleIntervalInput(e.target.value)}
          />
        </label>
        <label className={styles.fieldCompact}>
          <span className={styles.label} title={t("sponsor_blur.analysis_width_tooltip", "Разрешение анализа по ширине, px. Меньше — быстрее; на точность влияет слабо.")}>{t("sponsor_blur.analysis_width", "Анализ")}</span>
          <input
            className={`${styles.input} ${styles.mono}`}
            style={{ height: 30, fontSize: "12px", padding: "0 6px" }}
            value={analysisWidthInput}
            placeholder="960"
            onChange={(e) => setAnalysisWidthInput(e.target.value)}
          />
        </label>
        <label className={styles.fieldCompact}>
          <span className={styles.label} title={t("sponsor_blur.confidence_tooltip", "Порог сходства ZNCC 0..1. Выше — строже, ниже — терпимее к перекрытиям.")}>{t("sponsor_blur.confidence", "Порог")}</span>
          <input
            className={`${styles.input} ${styles.mono}`}
            style={{ height: 30, fontSize: "12px", padding: "0 6px" }}
            value={confidenceInput}
            placeholder="0.45"
            onChange={(e) => setConfidenceInput(e.target.value)}
          />
        </label>
      </div>
    
      <div style={{ display: "flex", gap: 4, marginTop: 4 }}>
        <button
          className={`${styles.button} ${lockSize ? styles.segmentActive : ""}`}
          style={{ flex: 1, height: 28, fontSize: "11px" }}
          type="button"
          onClick={() => setLockSize(!lockSize)}
          title={t("sponsor_blur.lock_size_tooltip", "Держать размер рамки таким, каким вы его нарисовали. Баннеры спонсоров обычно не меняют размер.")}
        >
          {t("sponsor_blur.lock_size", "Фикс. размер")}
        </button>
        <button
          className={`${styles.button} ${useGpu ? styles.segmentActive : ""}`}
          style={{ flex: 1, height: 28, fontSize: "11px" }}
          type="button"
          onClick={() => setUseGpu(!useGpu)}
          disabled={trackerEngine !== "hybrid"}
          title={t("sponsor_blur.use_gpu_tooltip", "Использовать DirectML/CoreML, если доступно. При отказе автоматически считает на CPU.")}
        >
          {t("sponsor_blur.use_gpu", "GPU")}
        </button>
      </div>
    
      <div style={{ display: "flex", gap: 4, marginTop: 8 }}>
        <button
          className={`${styles.button} ${drawingMode ? styles.segmentActive : ""}`}
          style={{ flex: "0 0 38px", width: 38, height: 38, padding: 0 }}
          type="button"
          onClick={() => setDrawingMode(!drawingMode)}
          title={t("sponsor_blur.select_area_tooltip", "Выделить область на кадре для трекинга")}
        >
          <RedesignIcon name="move" />
        </button>
        <button
          className={`${styles.button} ${styles.primaryButton}`}
          style={{ flex: "1 1 auto", height: 38 }}
          type="button"
          onClick={() => void trackSelectedZone()}
          disabled={!canTrackSelected || trackingZone}
         aria-busy={trackingZone}>
          <RedesignIcon name={trackingZone ? "loading" : "sparkle"} className={trackingZone ? "animate-spin" : undefined} />
          <span>{t("sponsor_blur.track_zone_btn", "Трекинг зоны")}</span>
        </button>
        {trackingZone && (
          <button
            className={styles.button}
            style={{ flex: "0 0 38px", width: 38, height: 38, padding: 0 }}
            type="button"
            onClick={cancelTracking}
            title={t("sponsor_blur.cancel_tracking", "Отменить трекинг")}
          >
            <RedesignIcon name="close" />
          </button>
        )}
      </div>
    
      {trackingProgress && (
        <div style={{ marginTop: 8 }}>
          <div style={{ height: 4, borderRadius: 2, background: "var(--fetchr-color-border-subtle)", overflow: "hidden" }}>
            <div
              style={{
                height: "100%",
                width: `${Math.round(trackingProgress.percent)}%`,
                background: "var(--fetchr-color-accent)",
                transition: "width 0.3s",
              }}
            />
          </div>
          <div className={styles.mono} style={{ fontSize: "11px", color: "var(--fetchr-color-text-secondary)", marginTop: 4 }}>
            {trackingProgress.message || `${Math.round(trackingProgress.percent)}%`}
          </div>
        </div>
      )}
    
      {trackReport && (
        <div className={styles.statusBox} style={{ marginTop: 8 }}>
          <div>
            {t("sponsor_blur.tracking_report", {
              matched: trackReport.matched,
              analyzed: trackReport.analyzed,
              min: Math.round(trackReport.minConfidence * 100),
              max: Math.round(trackReport.maxConfidence * 100),
              time: formatTime(trackReport.endTimeSec),
              defaultValue: `Трекинг: ${trackReport.matched}/${trackReport.analyzed} кадров · сходство ${Math.round(trackReport.minConfidence * 100)}–${Math.round(trackReport.maxConfidence * 100)}% · до ${formatTime(trackReport.endTimeSec)}`,
            })}
            {trackReport.truncated ? ` · ${t("sponsor_blur.tracking_truncated", "лимит keyframes")}` : ""}
          </div>
          <div className={styles.mono} style={{ fontSize: "11px", color: "var(--fetchr-color-text-secondary)", marginTop: 4 }}>
            {trackReport.engine} · {trackReport.device.toUpperCase()} · {Math.round(trackReport.fps)} {t("sponsor_blur.fps_unit", "кадр/с")}
            {trackReport.redetections > 0 ? ` · ${t("sponsor_blur.redetections", "перезахватов")}: ${trackReport.redetections}` : ""}
          </div>
          {trackReport.gaps.length > 0 && (
            <div style={{ fontSize: "11px", color: "var(--fetchr-color-text-secondary)", marginTop: 4 }}>
              {t("sponsor_blur.gaps_label", "Баннер не виден")}:{" "}
              <span className={styles.mono}>
                {trackReport.gaps
                  .slice(0, 6)
                  .map(([from, to]) => `${formatTime(from)}–${formatTime(to)}`)
                  .join(", ")}
                {trackReport.gaps.length > 6 ? ` +${trackReport.gaps.length - 6}` : ""}
              </span>
            </div>
          )}
        </div>
      )}
    </>
  );

  const notice = frameError
    ? { kind: "error" as const, text: frameError }
    : referenceMissing
      ? { kind: "error" as const, text: t("sponsor_blur.reference_missing", "Reference-кадр не найден на диске — извлеките кадр заново.") }
      : draftZones.length === 0 && reference
        ? { kind: "info" as const, text: t("sponsor_blur.no_zones_hint", "Зон пока нет. Добавьте область поверх кадра.") }
        : null;

  const presetList = (
    <div className={studio.presets}>
      {sponsorPresets.map((preset) => {
        const active = preset.id === activeSponsorPresetId;
        const renaming = renamingPresetId === preset.id;
        return (
          <div key={preset.id} className={cn(studio.preset, active && studio.presetActive)}>
            {renaming ? (
              <input
                className={studio.presetInput}
                autoFocus
                value={renameValue}
                onChange={(event) => setRenameValue(event.target.value)}
                onBlur={() => commitRename(preset.id)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") commitRename(preset.id);
                  if (event.key === "Escape") setRenamingPresetId(null);
                }}
              />
            ) : (
              <button
                type="button"
                className={studio.presetMain}
                aria-pressed={active}
                onClick={() => setActiveSponsorPreset(preset.id)}
                onDoubleClick={() => {
                  setRenamingPresetId(preset.id);
                  setRenameValue(preset.name);
                }}
                title={t("sponsor_blur.preset_rename_tooltip", "Двойной клик для переименования")}
              >
                <span className={studio.presetDot} aria-hidden />
                <span className={studio.presetName}>{preset.name}</span>
              </button>
            )}
            {preset.id !== "sponsor-default" && !renaming && (
              <button
                type="button"
                className={studio.presetDelete}
                onClick={() => void confirmDeletePreset(preset.id, preset.name)}
                title={t("sponsor_blur.preset_delete_tooltip", "Удалить пресет")}
                aria-label={t("sponsor_blur.preset_delete_tooltip", "Удалить пресет")}
              >
                <RedesignIcon name="close" className="size-3" />
              </button>
            )}
          </div>
        );
      })}
      <button type="button" className={studio.presetAdd} onClick={() => createSponsorPreset(activeSponsorPresetId)}>
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
            <div className={studio.source}>
              <div className={studio.sourceRow}>
                <div className={studio.field}>
                  <RedesignIcon name="link" className={studio.fieldIcon} />
                  <input
                    className={studio.fieldInput}
                    value={videoUrl}
                    placeholder={t("sponsor_blur.video_placeholder", "https://www.twitch.tv/videos/... или путь к файлу")}
                    onChange={(event) => {
                      setVideoUrl(event.target.value);
                      setDuration(null);
                    }}
                    spellCheck={false}
                    aria-label="Ссылка на видео или путь к файлу"
                  />
                  {duration !== null && duration > 0 ? (
                    <span className={cn(studio.chip, studio.chipOk)}>
                      {formatTime(frameTime ?? 0)} / {formatTime(duration)}
                    </span>
                  ) : loadingFrame ? (
                    <span className={studio.chip}>Загружаю…</span>
                  ) : null}
                </div>
                <button
                  type="button"
                  className={studio.iconButton}
                  onClick={() => void captureFrame(undefined)}
                  disabled={loadingFrame || !videoUrl.trim()}
                  title={t("sponsor_blur.load_video_tooltip", "Загрузить видео и извлечь кадр")}
                  aria-busy={loadingFrame}
                >
                  <RedesignIcon name={loadingFrame ? "loading" : "download"} className={loadingFrame ? "animate-spin" : undefined} />
                </button>
                <button
                  type="button"
                  className={studio.iconButton}
                  onClick={() => void captureFrame(undefined, true)}
                  disabled={loadingFrame || !videoUrl.trim()}
                  title={t("sponsor_blur.random_frame_tooltip", "Извлечь кадр из случайного момента")}
                >
                  <RedesignIcon name="refresh" />
                </button>
                <div className={studio.segment} role="group" aria-label="Что показывать на кадре">
                  <button
                    type="button"
                    role="switch"
                    aria-checked={showZones}
                    className={studio.segmentItem}
                    onClick={() => setShowZones(!showZones)}
                    title={showZones ? t("sponsor_blur.hide_zones_tooltip", "Скрыть зоны") : t("sponsor_blur.show_zones_tooltip", "Показать зоны")}
                  >
                    <RedesignIcon name={showZones ? "visible" : "hidden"} className="size-3.5" />
                    Рамки
                  </button>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={showGrid}
                    className={studio.segmentItem}
                    onClick={() => setShowGrid(!showGrid)}
                    title={showGrid ? t("sponsor_blur.hide_grid_tooltip", "Скрыть сетку") : t("sponsor_blur.show_grid_tooltip", "Показать сетку")}
                  >
                    <RedesignIcon name="preset" className="size-3.5" />
                    Сетка
                  </button>
                </div>
              </div>
              {notice && (
                <p className={cn(studio.notice, notice.kind === "error" && studio.noticeError)} role={notice.kind === "error" ? "alert" : "status"}>
                  {notice.text}
                </p>
              )}
            </div>

            <div className={cn(studio.canvas, styles.previewContainer, styles.fitPreview)}>
              <SponsorVideoPreview
                preview={reference}
                zones={draftZones}
                selectedId={selectedZone?.id ?? null}
                showZones={showZones}
                showGrid={showGrid}
                drawingEnabled={drawingMode}
                frameTime={frameTime}
                loading={loadingFrame}
                error={frameError}
                mode={previewMode}
                hasSource={videoUrl.trim() !== ""}
                videoSrc={playerUrl}
                videoLoading={playerLoading}
                playerRef={playerRef}
                onChangeMode={setPreviewMode}
                onUseCurrentMoment={useCurrentPlayerMoment}
                onPlayerTime={handlePlayerTime}
                onPlayerDuration={handlePlayerDuration}
                getZoneName={getZoneName}
                onSelectZone={setSelectedId}
                onChangeZone={changeZone}
                onCreateZone={createZoneFromRect}
                onAddZone={(shape) => addZone(shape)}
                onToggleDrawing={() => setDrawingMode(!drawingMode)}
                onDeleteZone={deleteZone}
                onDuplicateZone={duplicateZone}
              />
            </div>

            {videoUrl.trim() !== "" && (
              <SponsorTimeline
                durationSec={duration ?? 0}
                currentTimeSec={previewMode === "video" ? playerTime : frameTime ?? 0}
                onScrub={handleTimelineScrub}
                onScrubCommit={handleTimelineScrubCommit}
                rangeStartSec={parseTime(trackStart)}
                rangeEndSec={parseTime(trackEnd)}
                onRangeChange={handleTimelineRange}
                zones={draftZones}
                getZoneName={getZoneName}
                selectedZoneId={selectedZone?.id ?? null}
                onSelectZone={setSelectedId}
                zoneGaps={zoneGaps}
                thumbnails={thumbnails}
                thumbnailsLoading={thumbnailsLoading}
                thumbnailsMessage={thumbnailsMessage}
                onBuildThumbnails={() => void buildTimelineThumbnails()}
                busy={loadingFrame}
                trackerBusy={trackingZone}
                playing={playerPlaying}
                onTogglePlay={previewMode === "video" && playerUrl ? togglePlayback : undefined}
                onStep={stepPlayback}
              />
            )}
          </main>

          <aside className={studio.inspector}>
            <div className={studio.inspectorHead}>
              <div className={cn(studio.segment, studio.segmentWide)} role="tablist" aria-label="Настройки блюра">
                {(
                  [
                    ["zones", "Зоны"],
                    ["tracker", "Трекер"],
                    ["presets", "Пресеты"],
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
                    {id === "tracker" && trackingZone && <RedesignIcon name="loading" className="size-3 animate-spin" />}
                  </button>
                ))}
              </div>
            </div>

            <div className={cn(studio.inspectorBody, styles.inspectorLegacy)} key={inspectorTab}>
              {inspectorTab === "zones" && (
                <>
                  <SponsorZoneList
                    zones={draftZones}
                    selectedId={selectedZone?.id ?? null}
                    getZoneName={getZoneName}
                    onSelectZone={setSelectedId}
                    onChangeZone={changeZone}
                    hideHeader
                  />
                  <SponsorZoneProperties
                    zone={selectedZone}
                    ui={selectedUi}
                    imageMissing={selectedZone ? (missingImageIds[selectedZone.id] ?? false) : false}
                    onChangeZone={changeZone}
                    onChangeUi={changeZoneUi}
                    onDeleteZone={deleteZone}
                    onChooseZoneImage={(id) => void chooseZoneImage(id)}
                  />
                </>
              )}
              {inspectorTab === "tracker" && (
                <div className={studio.section}>
                  <span className={studio.hint}>
                    Выберите зону и диапазон, трекер пройдёт запись и сам сдвинет рамку за баннером.
                    {selectedZone ? ` Зона: ${getZoneName(selectedZone, draftZones.indexOf(selectedZone))}.` : " Сначала выберите зону."}
                  </span>
                  {trackerPanel}
                </div>
              )}
              {inspectorTab === "presets" && (
                <div className={studio.section}>
                  <span className={studio.label}>Пресет зон</span>
                  {presetList}
                  <span className={studio.hint}>Активный пресет применяется, когда в «Скачать» включён «Блюр спонсоров».</span>
                </div>
              )}
            </div>

            <div className={studio.inspectorFoot}>
              <span className={studio.summary}>
                {activeSponsorPreset?.name ?? "Default Blur"} · зон: {draftZones.length} ·{" "}
                {saved ? t("sponsor_blur.saved", "Сохранено") : t("sponsor_blur.unsaved_changes", "Есть несохранённые изменения")}
              </span>
              <div className={styles.inspectorActions}>
                <button type="button" className={studio.secondary} onClick={duplicateZone} disabled={!selectedZone} title={t("sponsor_blur.duplicate", "Дублировать")}>
                  <RedesignIcon name="copy" />
                </button>
                <button type="button" className={studio.secondary} onClick={clearZones} disabled={draftZones.length === 0} title={t("sponsor_blur.clear", "Очистить")}>
                  <RedesignIcon name="trash" />
                </button>
                <button type="button" className={studio.primary} onClick={() => addZone()}>
                  <RedesignIcon name="add" />
                  {t("sponsor_blur.add_zone", "Добавить зону")}
                </button>
              </div>
            </div>
          </aside>
        </div>
      </div>
    </div>
  );


  function getZoneName(zone: BlurZone, index: number) {
    return zoneUi[zone.id]?.name?.trim() || zoneLabel(index);
  }
}

function buildZoneUi(zones: BlurZone[], nameFor: (index: number) => string): Record<string, SponsorZoneUiSettings> {
  return Object.fromEntries(zones.map((zone, index) => [zone.id, defaultZoneUi(nameFor(index))]));
}

function defaultZoneUi(name: string): SponsorZoneUiSettings {
  return {
    name,
    padding: 8,
    adaptiveSize: true,
  };
}

function parseTime(value: string): number | null {
  const raw = value.trim();
  if (!raw) return null;
  const parts = raw.split(":").map(Number);
  if (parts.some((part) => !Number.isFinite(part))) return null;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 1) return parts[0];
  return null;
}

function formatTime(value: number) {
  const total = Math.max(0, Math.floor(value));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}
