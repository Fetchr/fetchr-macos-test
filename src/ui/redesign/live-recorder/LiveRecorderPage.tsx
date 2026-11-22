import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { ipc } from "@/lib/ipc";
import { notifyError } from "@/lib/notify";
import { cn } from "@/lib/utils";
import { useQueue } from "@/stores/queue";
import { useSettings } from "@/stores/settings";
import { useUI } from "@/stores/ui";
import {
  useLiveRecorderStore,
  type ArmedRecording,
} from "@/stores/liveRecorder";
import { detectPlatform } from "@/lib/url";
import { normalizeStreamUrl } from "./useScheduledRecordingWatcher";
import { ArmedRecordingCard } from "./ArmedRecordingCard";
import { LiveThumb } from "./LiveThumb";
import { PlatformIcon, RedesignIcon } from "@/ui/redesign/icons/iconMap";
import { DemoSlot, LiveDemo } from "@/ui/redesign/demos/DemoSlot";
import { fetchrThemeClassName } from "@/ui/redesign/theme";
import { staggerIn } from "@/ui/redesign/theme/gsapMotion";
import { useGSAP } from "@/ui/redesign/theme/gsapSetup";
import type { Job, JobStatus, PreviewSource } from "@/types/job";
import { HlsPlayer, type HlsPlayerHandle } from "@/components/hls-player";

import styles from "./LiveRecorderPage.module.css";
import { backdropDismiss } from "@/lib/backdrop";

// Helper to format elapsed seconds to HH:MM:SS
function formatSeconds(totalSecs: number): string {
  if (totalSecs <= 0 || !Number.isFinite(totalSecs)) return "00:00:00";
  const hrs = Math.floor(totalSecs / 3600);
  const mins = Math.floor((totalSecs % 3600) / 60);
  const secs = totalSecs % 60;
  return `${hrs.toString().padStart(2, "0")}:${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
}

// Helper to parse HH:MM:SS (or MM:SS or seconds) to seconds
function parseTimeString(val: string): number | null {
  const parts = val.trim().split(":").map(Number);
  if (parts.some(isNaN)) return null;
  if (parts.length === 3) {
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  } else if (parts.length === 2) {
    return parts[0] * 60 + parts[1];
  } else if (parts.length === 1) {
    return parts[0];
  }
  return null;
}

// Strip characters that are invalid in file names
function sanitizeFileName(raw: string): string {
  return raw
    .replace(/[\\/:*?"<>|]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit + 1 < units.length) {
    value /= 1024;
    unit += 1;
  }
  return unit === 0
    ? `${bytes} ${units[unit]}`
    : `${value.toFixed(1)} ${units[unit]}`;
}

/** Join a directory and a file name using the directory's own separator style
 *  (backslash on Windows paths, slash elsewhere). */
function joinPath(dir: string, file: string): string {
  const sep = dir.includes("\\") ? "\\" : "/";
  return `${dir.replace(/[\\/]+$/, "")}${sep}${file}`;
}

const QUICK_RANGES: { label: string; seconds: number | null }[] = [
  { label: "Всё", seconds: null },
  { label: "30 сек", seconds: 30 },
  { label: "1 мин", seconds: 60 },
  { label: "5 мин", seconds: 300 },
  { label: "15 мин", seconds: 900 },
];

/** Tiny inline sparkline of the recent download speed. */
function SpeedSparkline({ samples }: { samples: number[] }) {
  if (samples.length < 2) return null;
  const width = 96;
  const height = 22;
  const max = Math.max(...samples, 1);
  const points = samples
    .map((v, i) => {
      const x = (i / (samples.length - 1)) * width;
      const y = height - 2 - (Math.max(0, v) / max) * (height - 4);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  const last = samples[samples.length - 1] ?? 0;
  return (
    <svg
      className={cn(styles.sparkline, last <= 0 && styles.sparklineDead)}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <polyline points={points} fill="none" strokeWidth="1.5" />
    </svg>
  );
}

export function LiveRecorderPage() {
  const { t } = useTranslation();
  useGSAP(() => {
    staggerIn("[data-stagger]");
  }, []);
  const navigate = useNavigate();
  const defaultDir = useSettings((s) => s.directory);
  const integrations = useSettings((s) => s.integrations);
  const settingsProxy = useSettings((s) => s.proxy);
  const binariesDir = useSettings((s) => s.binariesDir);
  const hideTwitchTokenReminder = useSettings((s) => s.hideTwitchTokenReminder);
  const setHideTwitchTokenReminder = useSettings(
    (s) => s.setHideTwitchTokenReminder,
  );
  const setPendingSettingsTab = useUI((s) => s.setPendingSettingsTab);
  const jobs = useQueue((s) => s.jobs);
  const [showTokenReminder, setShowTokenReminder] = useState(false);

  // Get state from persistent Zustand store
  const url = useLiveRecorderStore((s) => s.url);
  const name = useLiveRecorderStore((s) => s.name);
  const splittingJobIds = useLiveRecorderStore((s) => s.splittingJobIds);
  const savedSegments = useLiveRecorderStore((s) => s.savedSegments);
  const markers = useLiveRecorderStore((s) => s.markers);
  const activePreviewJobId = useLiveRecorderStore((s) => s.activePreviewJobId);

  const activePreviewJob = useMemo(() => {
    if (!activePreviewJobId) return null;
    return jobs.find((j) => j.id === activePreviewJobId) || null;
  }, [jobs, activePreviewJobId]);

  const activePreviewJobElapsed = useMemo(() => {
    if (!activePreviewJob || !activePreviewJob.started_at) return 0;
    const end = activePreviewJob.finished_at || Date.now();
    return Math.floor((end - activePreviewJob.started_at) / 1000);
  }, [activePreviewJob]);

  // Prefer the real media duration probed from the recording file: wall-clock
  // elapsed includes connect time and stalls that are NOT in the file, so a
  // wall-clock timeline could run past the actual footage.
  const activePreviewMediaSec = useMemo(() => {
    const probed = activePreviewJob?.live_stats?.media_duration_sec;
    if (probed && Number.isFinite(probed) && probed > 0)
      return Math.floor(probed);
    return activePreviewJobElapsed;
  }, [activePreviewJob, activePreviewJobElapsed]);
  const muteSwears = useLiveRecorderStore((s) => s.muteSwears);
  const blurSponsors = useLiveRecorderStore((s) => s.blurSponsors);
  const vocalRemover = useLiveRecorderStore((s) => s.vocalRemover);
  const recordChatSeparate = useLiveRecorderStore((s) => s.recordChatSeparate);

  const setUrl = useLiveRecorderStore((s) => s.setUrl);
  const setName = useLiveRecorderStore((s) => s.setName);
  const setSplitting = useLiveRecorderStore((s) => s.setSplitting);
  const addSavedSegment = useLiveRecorderStore((s) => s.addSavedSegment);
  const addMarker = useLiveRecorderStore((s) => s.addMarker);
  const renameMarker = useLiveRecorderStore((s) => s.renameMarker);
  const removeMarker = useLiveRecorderStore((s) => s.removeMarker);
  const setActivePreviewJobId = useLiveRecorderStore(
    (s) => s.setActivePreviewJobId,
  );
  const setMuteSwears = useLiveRecorderStore((s) => s.setMuteSwears);
  const setBlurSponsors = useLiveRecorderStore((s) => s.setBlurSponsors);
  const setVocalRemover = useLiveRecorderStore((s) => s.setVocalRemover);
  const setRecordChatSeparate = useLiveRecorderStore(
    (s) => s.setRecordChatSeparate,
  );

  // Local settings override for active (running) recording cards
  const [jobSettings, setJobSettings] = useState<
    Record<
      string,
      {
        muteSwears: boolean;
        blurSponsors: boolean;
        vocalRemover: boolean;
        recordChatSeparate: boolean;
      }
    >
  >({});

  // Timeline state for active preview
  const [timelineStart, setTimelineStart] = useState<number>(0);
  const [timelineEnd, setTimelineEnd] = useState<number>(0);
  const [timelineStartInput, setTimelineStartInput] =
    useState<string>("00:00:00");
  const [timelineEndInput, setTimelineEndInput] = useState<string>("00:00:00");

  // Manual chronology: label for the segment being saved + marker input
  const [segmentLabel, setSegmentLabel] = useState<string>("");
  const [markerLabelInput, setMarkerLabelInput] = useState<string>("");
  const [editingMarkerId, setEditingMarkerId] = useState<string | null>(null);
  const [editingMarkerText, setEditingMarkerText] = useState<string>("");

  const [customDirectory, setCustomDirectory] = useState<string | null>(null);
  const [diskFreeBytes, setDiskFreeBytes] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [isClearingHistory, setIsClearingHistory] = useState(false);
  const [, setTick] = useState(0);

  // Start mode for new recordings (immediate / wait-for-online / scheduled).
  // The actual waiting/scheduling runs in a global background watcher so it keeps
  // working regardless of the active tab.
  const [scheduledTime, setScheduledTime] = useState<string>(""); // datetime-local (optional)
  const armed = useLiveRecorderStore((s) => s.armed);
  const addArmed = useLiveRecorderStore((s) => s.addArmed);
  const removeArmed = useLiveRecorderStore((s) => s.removeArmed);
  const jobDefaults = useLiveRecorderStore((s) => s.jobDefaults);

  // Auto title resolution
  const [titleLoading, setTitleLoading] = useState(false);
  const nameEditedManually = useRef(false);
  const titleFetchSeq = useRef(0);
  const lastResolvedUrl = useRef<string>("");

  // Preview state
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewSource, setPreviewSource] = useState<PreviewSource | null>(
    null,
  );
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewExpanded, setPreviewExpanded] = useState(false);
  const [reviewUrl, setReviewUrl] = useState<string | null>(null);
  const [reviewLoading, setReviewLoading] = useState(false);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const hlsPlayerRef = useRef<HlsPlayerHandle | null>(null);
  const expandedPlayerRef = useRef<HlsPlayerHandle | null>(null);
  // Job ids for which an automatic preview restart was already attempted, so a
  // failing preview does not loop forever.
  const previewAutoRetryRef = useRef<Set<string>>(new Set());

  // Rolling download-speed history per job (for the sparkline).
  const speedHistoryRef = useRef<
    Record<string, { at: number; samples: number[] }>
  >({});
  useEffect(() => {
    const now = Date.now();
    for (const job of jobs) {
      if (job.spec.mode !== "live" || job.status !== "running") continue;
      const entry = speedHistoryRef.current[job.id] || { at: 0, samples: [] };
      if (now - entry.at >= 1000) {
        const stalled = job.live_stats?.stalled ?? false;
        const v = stalled ? 0 : Math.max(0, job.progress.speed_bps || 0);
        entry.samples.push(v);
        if (entry.samples.length > 60)
          entry.samples.splice(0, entry.samples.length - 60);
        entry.at = now;
        speedHistoryRef.current[job.id] = entry;
      }
    }
  }, [jobs]);

  // Build a seekable snapshot of everything recorded so far, so the expanded
  // view can scrub back through past footage (live HLS only keeps a few seconds).
  const loadRecordingReview = useCallback(async () => {
    if (!activePreviewJobId) return;
    setReviewLoading(true);
    setReviewError(null);
    try {
      const url = await ipc.prepareRecordingReview(activePreviewJobId);
      setReviewUrl(`${url}?t=${Date.now()}`);
    } catch (err: any) {
      setReviewError(err?.toString() || "Не удалось подготовить запись");
      setReviewUrl(null);
    } finally {
      setReviewLoading(false);
    }
  }, [activePreviewJobId]);

  const openExpandedPreview = useCallback(() => {
    setPreviewExpanded(true);
    void loadRecordingReview();
  }, [loadRecordingReview]);

  // Close expanded preview when the stream goes away (but keep it open while
  // the preview is still loading, e.g. right after auto-expand on start).
  useEffect(() => {
    if (previewExpanded && !previewUrl && !previewLoading) {
      setPreviewExpanded(false);
    }
  }, [previewUrl, previewLoading, previewExpanded]);

  useEffect(() => {
    if (!previewExpanded) {
      setReviewUrl(null);
      setReviewError(null);
      setReviewLoading(false);
    }
  }, [previewExpanded]);

  useEffect(() => {
    if (!previewExpanded) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPreviewExpanded(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [previewExpanded]);

  // Helper to resolve job settings (local toggle override > defaults captured
  // when the recording was armed > job spec)
  const getJobSettings = useCallback(
    (job: any) => {
      const local = jobSettings[job.id];
      if (local) return local;
      const armedDefaults = jobDefaults[job.id];
      if (armedDefaults) return armedDefaults;
      return {
        muteSwears: job.spec.fetchr_mute_enabled ?? false,
        blurSponsors: job.spec.blur_zones && job.spec.blur_zones.length > 0,
        vocalRemover: job.spec.vocal_remover_enabled ?? false,
        recordChatSeparate: job.spec.record_chat_separate ?? false,
      };
    },
    [jobSettings, jobDefaults],
  );

  // Helper to toggle a specific job setting
  const toggleJobSetting = useCallback(
    (
      jobId: string,
      key:
        "muteSwears" | "blurSponsors" | "vocalRemover" | "recordChatSeparate",
    ) => {
      setJobSettings((prev) => {
        const foundJob = jobs.find((j) => j.id === jobId);
        const current = prev[jobId] ||
          jobDefaults[jobId] || {
            muteSwears: foundJob?.spec.fetchr_mute_enabled ?? false,
            blurSponsors: (foundJob?.spec.blur_zones?.length ?? 0) > 0,
            vocalRemover: foundJob?.spec.vocal_remover_enabled ?? false,
            recordChatSeparate: foundJob?.spec.record_chat_separate ?? false,
          };
        return {
          ...prev,
          [jobId]: {
            ...current,
            [key]: !current[key],
          },
        };
      });
    },
    [jobs, jobDefaults],
  );

  // Auto-fetch stream title when a valid URL is entered (editable afterwards)
  useEffect(() => {
    const trimmed = url.trim();
    if (!trimmed || detectPlatform(trimmed) === "unknown") {
      setTitleLoading(false);
      return;
    }
    if (trimmed === lastResolvedUrl.current) return;
    // Don't overwrite a name the user typed by hand
    if (name.trim() && nameEditedManually.current) return;

    const seq = ++titleFetchSeq.current;
    const timer = setTimeout(async () => {
      setTitleLoading(true);
      try {
        const resolved = await ipc.resolveStream(
          trimmed,
          settingsProxy,
          binariesDir,
          integrations.twitchAuthToken || null,
        );
        if (seq !== titleFetchSeq.current) return;
        lastResolvedUrl.current = trimmed;
        const title = sanitizeFileName(
          resolved.title || resolved.uploader || "",
        );
        if (title) {
          setName(title);
          nameEditedManually.current = false;
        }
      } catch {
        // Silent: auto title is best-effort
      } finally {
        if (seq === titleFetchSeq.current) setTitleLoading(false);
      }
    }, 600);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, detectPlatform, setName]);

  // Update timelineEnd as recording grows, if it was at the previous max or not modified
  const prevElapsedRef = useRef(0);
  useEffect(() => {
    if (activePreviewMediaSec > 0) {
      if (timelineEnd === 0 || timelineEnd === prevElapsedRef.current) {
        setTimelineEnd(activePreviewMediaSec);
        setTimelineEndInput(formatSeconds(activePreviewMediaSec));
      }
      prevElapsedRef.current = activePreviewMediaSec;
    } else {
      setTimelineStart(0);
      setTimelineStartInput("00:00:00");
      setTimelineEnd(0);
      setTimelineEndInput("00:00:00");
      prevElapsedRef.current = 0;
    }
  }, [activePreviewMediaSec, timelineEnd]);

  // Timeline handlers
  const handleStartChange = useCallback(
    (val: number) => {
      const clamped = Math.max(0, Math.min(val, timelineEnd));
      setTimelineStart(clamped);
      setTimelineStartInput(formatSeconds(clamped));
    },
    [timelineEnd],
  );

  const handleEndChange = useCallback(
    (val: number) => {
      const clamped = Math.max(
        timelineStart,
        Math.min(val, activePreviewMediaSec),
      );
      setTimelineEnd(clamped);
      setTimelineEndInput(formatSeconds(clamped));
    },
    [timelineStart, activePreviewMediaSec],
  );

  const applyQuickRange = useCallback(
    (seconds: number | null) => {
      const end = activePreviewMediaSec;
      const start = seconds === null ? 0 : Math.max(0, end - seconds);
      setTimelineStart(start);
      setTimelineStartInput(formatSeconds(start));
      setTimelineEnd(end);
      setTimelineEndInput(formatSeconds(end));
    },
    [activePreviewMediaSec],
  );

  const handleStartInputBlur = useCallback(() => {
    const parsed = parseTimeString(timelineStartInput);
    if (parsed !== null) {
      const clamped = Math.max(0, Math.min(parsed, timelineEnd));
      setTimelineStart(clamped);
      setTimelineStartInput(formatSeconds(clamped));
    } else {
      setTimelineStartInput(formatSeconds(timelineStart));
    }
  }, [timelineStart, timelineStartInput, timelineEnd]);

  const handleEndInputBlur = useCallback(() => {
    const parsed = parseTimeString(timelineEndInput);
    if (parsed !== null) {
      const clamped = Math.max(
        timelineStart,
        Math.min(parsed, activePreviewMediaSec),
      );
      setTimelineEnd(clamped);
      setTimelineEndInput(formatSeconds(clamped));
    } else {
      setTimelineEndInput(formatSeconds(timelineEnd));
    }
  }, [timelineEnd, timelineEndInput, timelineStart, activePreviewMediaSec]);

  const setStartFromPlayer = useCallback(() => {
    if (hlsPlayerRef.current) {
      const time = Math.floor(hlsPlayerRef.current.getCurrentTime());
      handleStartChange(time);
    }
  }, [handleStartChange]);

  const setEndFromPlayer = useCallback(() => {
    if (hlsPlayerRef.current) {
      const time = Math.floor(hlsPlayerRef.current.getCurrentTime());
      handleEndChange(time);
    }
  }, [handleEndChange]);

  // ---------- Markers (manual chronology) ----------

  const activeJobMarkers = useMemo(
    () => (activePreviewJobId ? markers[activePreviewJobId] || [] : []),
    [markers, activePreviewJobId],
  );

  const placeMarker = useCallback(
    (labelRaw?: string) => {
      if (!activePreviewJobId) return;
      const list = markers[activePreviewJobId] || [];
      const label =
        (labelRaw ?? markerLabelInput).trim() || `Метка ${list.length + 1}`;
      addMarker(activePreviewJobId, activePreviewMediaSec, label);
      setMarkerLabelInput("");
    },
    [
      activePreviewJobId,
      activePreviewMediaSec,
      addMarker,
      markerLabelInput,
      markers,
    ],
  );

  // Hotkey M — place a marker while a live preview is open.
  useEffect(() => {
    if (!activePreviewJobId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat) return;
      const key = e.key.toLowerCase();
      if (key !== "m" && key !== "ь") return;
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName?.toLowerCase();
      if (
        tag === "input" ||
        tag === "textarea" ||
        tag === "select" ||
        target?.isContentEditable
      )
        return;
      e.preventDefault();
      placeMarker("");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [activePreviewJobId, placeMarker]);

  /** Select the range "from this marker to the next one (or the live edge)". */
  const selectMarkerRange = useCallback(
    (markerId: string) => {
      if (!activePreviewJobId) return;
      const list = markers[activePreviewJobId] || [];
      const idx = list.findIndex((m) => m.id === markerId);
      if (idx < 0) return;
      const start = list[idx].t;
      const end =
        idx + 1 < list.length ? list[idx + 1].t : activePreviewMediaSec;
      handleStartChange(Math.min(start, end));
      handleEndChange(Math.max(start, end));
      setSegmentLabel(list[idx].label);
    },
    [
      activePreviewJobId,
      markers,
      activePreviewMediaSec,
      handleStartChange,
      handleEndChange,
    ],
  );

  const selectFromLastMarker = useCallback(() => {
    if (!activePreviewJobId) return;
    const list = markers[activePreviewJobId] || [];
    if (list.length === 0) return;
    const last = list[list.length - 1];
    handleStartChange(last.t);
    handleEndChange(activePreviewMediaSec);
    setSegmentLabel(last.label);
  }, [
    activePreviewJobId,
    markers,
    activePreviewMediaSec,
    handleStartChange,
    handleEndChange,
  ]);

  const startEditingMarker = useCallback(
    (markerId: string, current: string) => {
      setEditingMarkerId(markerId);
      setEditingMarkerText(current);
    },
    [],
  );

  const commitMarkerEdit = useCallback(() => {
    if (activePreviewJobId && editingMarkerId) {
      const text = editingMarkerText.trim();
      if (text) renameMarker(activePreviewJobId, editingMarkerId, text);
    }
    setEditingMarkerId(null);
    setEditingMarkerText("");
  }, [activePreviewJobId, editingMarkerId, editingMarkerText, renameMarker]);

  // Set up timer for live elapsed calculations
  useEffect(() => {
    const timer = setInterval(() => {
      setTick((t) => t + 1);
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  const clearActivePreview = useCallback(async () => {
    if (previewSource?.id) {
      try {
        await ipc.stopStreamPreview(previewSource.id);
      } catch (err) {
        console.error("Failed to stop preview on clear:", err);
      }
    }
    setPreviewSource(null);
    setPreviewUrl(null);
    setPreviewError(null);
    setPreviewLoading(false);
  }, [previewSource]);

  const startWatchingJob = useCallback(
    async (job: any) => {
      setActivePreviewJobId(job.id);
      setPreviewLoading(true);
      setPreviewError(null);
      setPreviewUrl(null);
      setSegmentLabel("");

      // Stop current preview
      if (previewSource?.id) {
        try {
          await ipc.stopStreamPreview(previewSource.id);
        } catch (err) {
          console.error("Failed to stop previous stream preview:", err);
        }
      }
      setPreviewSource(null);

      try {
        const preview = await ipc.startStreamPreview(
          job.spec.url,
          job.spec.proxy,
          job.spec.binaries_dir || null,
          job.spec.quality || null,
          job.spec.twitch_auth_token || null,
        );
        setPreviewSource(preview);
        setPreviewUrl(preview.url);
      } catch (err: any) {
        setPreviewError(err?.toString() || "Не удалось загрузить предпросмотр");
      } finally {
        setPreviewLoading(false);
      }
    },
    [previewSource, setActivePreviewJobId],
  );

  // Stop preview session when page is unmounted
  useEffect(() => {
    return () => {
      if (previewSource?.id) {
        void ipc.stopStreamPreview(previewSource.id).catch(() => undefined);
      }
    };
  }, [previewSource]);

  // If the active preview job is no longer running or no longer exists, clear preview
  useEffect(() => {
    if (activePreviewJob && activePreviewJob.status !== "running") {
      setActivePreviewJobId(null);
      void clearActivePreview();
    }
  }, [activePreviewJob, clearActivePreview, setActivePreviewJobId]);

  // Coming back to this page stops the old preview session (unmount cleanup)
  // but keeps the panel open with a dead "Нет сигнала" player — restart the
  // preview once per job instead of leaving it stuck.
  useEffect(() => {
    if (!activePreviewJob || activePreviewJob.status !== "running") return;
    if (previewUrl || previewLoading || previewSource) return;
    if (previewAutoRetryRef.current.has(activePreviewJob.id)) return;
    previewAutoRetryRef.current.add(activePreviewJob.id);
    void startWatchingJob(activePreviewJob);
  }, [
    activePreviewJob,
    previewUrl,
    previewLoading,
    previewSource,
    startWatchingJob,
  ]);

  const activeDirectory = customDirectory || defaultDir;

  // Free disk space of the target folder: hint under the folder picker and a
  // pre-flight check before arming a recording.
  useEffect(() => {
    let stale = false;
    setDiskFreeBytes(null);
    if (!activeDirectory) return;
    ipc
      .getDiskFreeSpace(activeDirectory)
      .then((bytes) => {
        if (!stale) setDiskFreeBytes(bytes);
      })
      .catch(() => {
        if (!stale) setDiskFreeBytes(null);
      });
    return () => {
      stale = true;
    };
  }, [activeDirectory]);

  // Auto-dismiss transient status messages.
  useEffect(() => {
    if (!successMsg) return;
    const t = window.setTimeout(() => setSuccessMsg(null), 6000);
    return () => window.clearTimeout(t);
  }, [successMsg]);
  useEffect(() => {
    if (!error) return;
    const t = window.setTimeout(() => setError(null), 12000);
    return () => window.clearTimeout(t);
  }, [error]);

  // Filter jobs for live stream recording
  const liveJobs = useMemo(() => {
    return jobs
      .filter((j) => j.spec.mode === "live")
      .sort((a, b) => b.created_at - a.created_at);
  }, [jobs]);

  // Auto-open the preview when a fresh live recording starts (e.g. an armed
  // recording kicked off by the background watcher).
  const knownRunningIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const running = liveJobs.filter((j) => j.status === "running");
    for (const job of running) {
      if (!knownRunningIdsRef.current.has(job.id)) {
        knownRunningIdsRef.current.add(job.id);
        if (!activePreviewJobId) {
          void startWatchingJob(job);
        }
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveJobs]);

  const historyJobs = useMemo(
    () =>
      liveJobs.filter((j) => j.status !== "running" && j.status !== "queued"),
    [liveJobs],
  );

  const clearHistory = useCallback(async () => {
    if (historyJobs.length === 0) return;
    const confirmed = window.confirm(
      `Удалить из списка ${historyJobs.length} завершённых записей? Файлы останутся на диске.`,
    );
    if (!confirmed) return;
    setIsClearingHistory(true);
    setError(null);
    try {
      for (const job of historyJobs) {
        await ipc.removeJob(job.id);
      }
      setSuccessMsg("История записей очищена.");
    } catch (err: any) {
      setError(err?.toString() || "Не удалось очистить историю");
    } finally {
      setIsClearingHistory(false);
    }
  }, [historyJobs]);

  const chooseDir = useCallback(async () => {
    try {
      const selected = await ipc.chooseDirectory();
      if (selected) {
        setCustomDirectory(selected);
      }
    } catch (err) {
      notifyError("Не удалось выбрать папку.", err);
    }
  }, []);

  // Snapshot of everything needed to start the recording later, in the background.
  const buildArmed = useCallback(
    (
      mode: "wait_online" | "scheduled",
      fireAtMs: number | null,
    ): ArmedRecording => ({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      url: url.trim(),
      name: name.trim(),
      directory: activeDirectory,
      muteSwears,
      blurSponsors,
      vocalRemover,
      recordChatSeparate,
      twitchAuthToken: integrations.twitchAuthToken || null,
      proxy: { enabled: settingsProxy.enabled, url: settingsProxy.url },
      mode,
      fireAtMs,
      status: mode === "scheduled" ? "scheduled_pending" : "waiting_online",
      info: "",
    }),
    [
      url,
      name,
      activeDirectory,
      muteSwears,
      blurSponsors,
      vocalRemover,
      recordChatSeparate,
      integrations,
      settingsProxy,
    ],
  );

  /** Clear the form after a recording was armed, so the next URL resolves fresh. */
  const resetFormAfterArm = useCallback(() => {
    setUrl("");
    setName("");
    setScheduledTime("");
    nameEditedManually.current = false;
    lastResolvedUrl.current = "";
    titleFetchSeq.current += 1;
    setTitleLoading(false);
  }, [setUrl, setName]);

  /** Actually arm the recording (wait-online / scheduled). */
  const armRecording = useCallback(() => {
    // Всегда автоматически: если указано время старта — ждём его, затем пишем
    // сразу если онлайн, иначе ждём онлайна. Если время не указано — проверяем
    // онлайн сейчас и стартуем, а если оффлайн — ждём выхода в эфир.
    if (scheduledTime) {
      const target = new Date(scheduledTime);
      if (Number.isNaN(target.getTime())) {
        setError("Некорректное время начала");
        return;
      }
      if (target.getTime() <= Date.now()) {
        setError("Время начала уже прошло — выберите время в будущем");
        return;
      }
      addArmed({
        ...buildArmed("scheduled", target.getTime()),
        info: `Запланировано на ${target.toLocaleString()}`,
      });
      resetFormAfterArm();
      return;
    }

    addArmed({ ...buildArmed("wait_online", null), info: "Проверяю онлайн…" });
    resetFormAfterArm();
  }, [scheduledTime, buildArmed, addArmed, resetFormAfterArm]);

  const startRecording = useCallback(() => {
    setSuccessMsg(null);
    if (!url.trim()) {
      setError("Укажите ссылку на онлайн стрим");
      return;
    }
    if (!name.trim()) {
      setError("Укажите название файла для записи");
      return;
    }
    if (!activeDirectory) {
      setError(
        "Укажите папку для сохранения записи в Настройках или выберите вручную",
      );
      return;
    }

    // Не даём поставить один и тот же стрим дважды: ни в ожидание, ни в запись.
    const wanted = normalizeStreamUrl(url);
    if (armed.some((a) => normalizeStreamUrl(a.url) === wanted)) {
      setError("Этот стрим уже в ожидании — карточка «ОЖИДАНИЕ» слева");
      return;
    }
    const alreadyRecording = jobs.some(
      (j) =>
        j.spec.mode === "live" &&
        (j.status === "running" || j.status === "queued") &&
        normalizeStreamUrl(j.spec.url) === wanted,
    );
    if (alreadyRecording) {
      setError("Этот стрим уже записывается");
      return;
    }

    if (diskFreeBytes !== null && diskFreeBytes < 1024 * 1024 * 1024) {
      setError(
        `На диске почти нет места (свободно ${formatBytes(diskFreeBytes)}) — освободите место или выберите другую папку`,
      );
      return;
    }
    setError(null);

    // Twitch без токена пишется максимум в 1080p — предупредим один раз.
    const platform = detectPlatform(url);
    if (
      platform === "twitch" &&
      !integrations.twitchAuthToken &&
      !hideTwitchTokenReminder
    ) {
      setShowTokenReminder(true);
      return;
    }

    armRecording();
  }, [
    url,
    name,
    activeDirectory,
    armed,
    jobs,
    diskFreeBytes,
    integrations,
    hideTwitchTokenReminder,
    armRecording,
  ]);

  const goToTokenSettings = useCallback(() => {
    setShowTokenReminder(false);
    setPendingSettingsTab("integrations");
    void navigate({ to: "/settings" });
  }, [navigate, setPendingSettingsTab]);

  const handleSplit = useCallback(
    async (jobId: string, jobName: string) => {
      setError(null);
      setSuccessMsg(null);
      setSplitting(jobId, true);

      const job = jobs.find((j) => j.id === jobId);
      if (!job) {
        setError("Задача не найдена");
        setSplitting(jobId, false);
        return;
      }

      const settings = getJobSettings(job);
      const label = segmentLabel.trim() || null;
      const startSec = timelineStart;
      const endSec = timelineEnd;

      try {
        const partName = await ipc.splitLiveRecording(
          jobId,
          settings.muteSwears,
          settings.blurSponsors,
          settings.vocalRemover,
          settings.recordChatSeparate,
          startSec,
          endSec,
          label,
        );
        addSavedSegment(jobId, {
          fileName: partName,
          label: label || "",
          startSec,
          endSec,
          savedAtMs: Date.now(),
        });
        setSegmentLabel("");
        setSuccessMsg(`Отрезок сохранён: ${partName}`);
      } catch (err: any) {
        setError(
          err?.toString() ||
            `Не удалось отделить часть записи для "${jobName}"`,
        );
      } finally {
        setSplitting(jobId, false);
      }
    },
    [
      jobs,
      getJobSettings,
      timelineStart,
      timelineEnd,
      segmentLabel,
      setSplitting,
      addSavedSegment,
    ],
  );

  const handleStopAndProcess = useCallback(
    async (jobId: string) => {
      setError(null);
      setSuccessMsg(null);
      setSplitting(jobId, true);

      const job = jobs.find((j) => j.id === jobId);
      if (!job) {
        setError("Задача не найдена");
        setSplitting(jobId, false);
        return;
      }

      const settings = getJobSettings(job);

      try {
        const partName = await ipc.stopAndProcessLiveRecording(
          jobId,
          settings.muteSwears,
          settings.blurSponsors,
          settings.vocalRemover,
          settings.recordChatSeparate,
        );
        setSuccessMsg(
          `Запись остановлена и успешно обработана. Файл: ${partName}`,
        );
      } catch (err: any) {
        setError(
          err?.toString() || "Не удалось остановить и обработать запись",
        );
      } finally {
        setSplitting(jobId, false);
      }
    },
    [jobs, getJobSettings, setSplitting],
  );

  const handleStop = useCallback(async (jobId: string) => {
    try {
      await ipc.cancelJob(jobId);
      setSuccessMsg("Запись стрима остановлена.");
    } catch (err: any) {
      setError(err?.toString() || "Не удалось остановить запись");
    }
  }, []);

  const handleStopAction = useCallback(
    async (jobId: string) => {
      const job = jobs.find((j) => j.id === jobId);
      if (!job) return;
      const settings = getJobSettings(job);
      const hasPostProcessing =
        settings.muteSwears || settings.blurSponsors || settings.vocalRemover;

      if (hasPostProcessing) {
        await handleStopAndProcess(jobId);
      } else {
        await handleStop(jobId);
      }
    },
    [jobs, getJobSettings, handleStopAndProcess, handleStop],
  );

  const getStatusLabel = (status: JobStatus) => {
    switch (status) {
      case "running":
        return "Запись";
      case "queued":
        return "В очереди";
      case "done":
        return "Запись сохранена";
      case "error":
        return "Ошибка";
      case "cancelled":
        return "Запись завершена";
      default:
        return status;
    }
  };

  /** Seconds without new data for a running live job (0 = data flowing). */
  const getStallSeconds = (job: Job): number => {
    const stats = job.live_stats;
    if (!stats?.stalled || !stats.last_data_at) return 0;
    return Math.max(0, Math.floor((Date.now() - stats.last_data_at) / 1000));
  };

  // Выбранная в левой колонке запись. Без выбора: та, что смотрим, иначе первая идущая, ждущая или готовая.
  const [pickedKey, setSelectedKey] = useState<string | null>(null);
  const [newOpen, setNewOpen] = useState(false);
  const keyExists = (key: string | null) =>
    key !== null &&
    (liveJobs.some((job) => job.id === key) ||
      armed.some((item) => `armed:${item.id}` === key));
  const selectedKey = keyExists(pickedKey)
    ? pickedKey
    : ((activePreviewJobId && keyExists(activePreviewJobId)
        ? activePreviewJobId
        : null) ??
      liveJobs.find((job) => job.status === "running")?.id ??
      (armed[0] ? `armed:${armed[0].id}` : null) ??
      liveJobs[0]?.id ??
      null);

  const selectJob = (job: Job) => {
    setSelectedKey(job.id);
    if (job.status === "running" && activePreviewJobId !== job.id)
      void startWatchingJob(job);
  };

  // Новая запись или ожидание появились: окно формы закрывается само.
  const startedCount = liveJobs.length + armed.length;
  const startedCountRef = useRef(startedCount);
  useEffect(() => {
    if (startedCount > startedCountRef.current) setNewOpen(false);
    startedCountRef.current = startedCount;
  }, [startedCount]);

  useEffect(() => {
    if (!newOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setNewOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [newOpen]);

  const timelinePct = (v: number) =>
    activePreviewMediaSec > 0 ? (v / activePreviewMediaSec) * 100 : 0;

  const renderJobStage = (job: Job) => {
    const isRunning = job.status === "running";
    const isSplitting = splittingJobIds[job.id] || false;
    const isPreviewOpen = activePreviewJobId === job.id;
    const jobSegments = savedSegments[job.id] || [];
    const stallSec = isRunning ? getStallSeconds(job) : 0;
    const isStalled = isRunning && (job.live_stats?.stalled ?? false);
    const reconnects = job.live_stats?.reconnects || 0;
    const recordedBytes = job.live_stats?.recorded_bytes ?? null;
    const detectedQuality = job.live_stats?.detected_quality || null;
    const speedSamples = speedHistoryRef.current[job.id]?.samples || [];

    // Calculate elapsed time
    let elapsedSec = 0;
    if (job.started_at) {
      const end = job.finished_at || Date.now();
      elapsedSec = Math.floor((end - job.started_at) / 1000);
    }

    const platform = job.spec.meta?.platform || detectPlatform(job.spec.url);

    return (
      <section className={styles.stage} key={job.id}>
        <header className={styles.stageHead}>
          <LiveThumb
            thumbnail={job.spec.meta?.thumbnail}
            platform={platform}
            live={isRunning}
          />
          <div className={styles.stageTitle}>
            <h2>{job.spec.name}</h2>
            <span className={styles.stageMeta}>
              <PlatformIcon platform={platform} className="size-3" />
              {platform}
              {job.spec.meta?.title && job.spec.meta.title !== job.spec.name
                ? ` · ${job.spec.meta.title}`
                : ""}
            </span>
          </div>
          <span
            className={cn(
              styles.stageTag,
              isRunning
                ? isStalled
                  ? styles.stageTagWarn
                  : styles.stageTagRec
                : job.status === "error"
                  ? styles.stageTagError
                  : styles.stageTagDone,
            )}
            title={
              isStalled
                ? "Данные не поступают — проверьте интернет. Запись возобновится автоматически."
                : undefined
            }
          >
            {isRunning && <span className={styles.recDot} aria-hidden="true" />}
            {isStalled
              ? `Нет сигнала · ${stallSec} c`
              : getStatusLabel(job.status)}
          </span>
          <div className={styles.stageActions}>
            <button
              className={styles.iconOnlyButton}
              type="button"
              title={t(
                "live_recorder.pokazat_logi_processa",
                "Показать логи процесса",
              )}
              onClick={() => void navigate({ to: "/logs" })}
            >
              <RedesignIcon name="logs" />
            </button>
            <button
              className={styles.iconOnlyButton}
              type="button"
              title={
                job.output_path
                  ? "Показать файл"
                  : t(
                      "live_recorder.otkryt_papku_s_zapisyami",
                      "Открыть папку с записями",
                    )
              }
              onClick={() => {
                if (job.output_path) void ipc.revealFile(job.output_path);
                else void ipc.openFolder(job.spec.directory);
              }}
            >
              <RedesignIcon name="folder" />
            </button>
            {isRunning && (
              <button
                className={cn(styles.actionButton, styles.stopButton)}
                type="button"
                onClick={() => handleStopAction(job.id)}
                disabled={isSplitting}
              >
                <RedesignIcon name="stop" />
                {t("live_recorder.ostanovit", "Остановить")}
              </button>
            )}
          </div>
        </header>

        <div className={styles.statsGrid}>
          <div className={styles.statPill}>
            <span className={styles.statLabel}>
              {t("live_recorder.dlitelnost", "Длительность")}
            </span>
            <span className={styles.statValue}>
              {formatSeconds(elapsedSec)}
            </span>
          </div>
          <div className={styles.statPill}>
            <span className={styles.statLabel}>
              {t("live_recorder.zapisano", "Записано")}
            </span>
            <span className={styles.statValue}>
              {recordedBytes !== null
                ? formatBytes(recordedBytes)
                : job.progress.size || "0 B"}
            </span>
          </div>
          <div className={styles.statPill}>
            <span className={styles.statLabel}>
              {t("live_recorder.skorost", "Скорость")}
            </span>
            <span className={cn(styles.statValue, styles.statValueWithSpark)}>
              {isStalled ? "0 B/s" : job.progress.speed || "—"}
              {isRunning && <SpeedSparkline samples={speedSamples} />}
            </span>
          </div>
          <div className={styles.statPill}>
            <span className={styles.statLabel}>
              {t("live_recorder.kachestvo_2", "Качество")}
            </span>
            <span
              className={styles.statValue}
              title={t(
                "live_recorder.fakticheskoe_kachestvo_opredelennoe_po_zapis",
                "Фактическое качество, определённое по записанному файлу",
              )}
            >
              {detectedQuality || (isRunning ? "Определяется…" : "—")}
            </span>
          </div>
        </div>

        {isStalled && (
          <div className={styles.stallBanner} role="alert">
            <RedesignIcon name="alert" className={styles.alertIcon} />
            <span>
              Данные не поступают уже {stallSec} c — похоже, пропал интернет или
              стрим. Файл записи цел; запись продолжится автоматически.
              {reconnects > 0 && ` Переподключений: ${reconnects}.`}
            </span>
          </div>
        )}

        {isRunning && !isStalled && (
          <div className={styles.progressContainer}>
            <div className={styles.progressLabelRow}>
              <span className={styles.progressMessage}>
                {job.progress.message || "Подключение к стриму..."}
                {reconnects > 0 && ` · переподключений: ${reconnects}`}
              </span>
            </div>
            <div className={styles.progressTrack}>
              <div
                className={cn(styles.progressFill, styles.progressFillRunning)}
                style={{ width: "100%" }}
              />
            </div>
          </div>
        )}

        {isRunning && !isPreviewOpen && (
          <button
            type="button"
            className={styles.monitorIdle}
            onClick={() => void startWatchingJob(job)}
            disabled={isSplitting}
          >
            <RedesignIcon name="preview" className="size-6" />
            <span>Смотреть эфир, ставить метки и сохранять отрезки</span>
          </button>
        )}

        {isRunning && isPreviewOpen && (
          <div className={styles.trimPanel}>
            <div className={styles.trimPlayerColumn}>
              <div className={styles.miniPlayer}>
                {previewUrl ? (
                  <>
                    <HlsPlayer
                      ref={hlsPlayerRef}
                      src={previewUrl}
                      className={styles.miniPlayerVideo}
                      clean={true}
                    />
                    <button
                      type="button"
                      className={styles.expandButton}
                      onClick={openExpandedPreview}
                      aria-label={t(
                        "live_recorder.razvernut_predprosmotr",
                        "Развернуть предпросмотр",
                      )}
                      title={t(
                        "live_recorder.razvernut_predprosmotr_zvuk_i_peremotka",
                        "Развернуть предпросмотр (звук и перемотка записи)",
                      )}
                    >
                      <RedesignIcon name="expand" />
                    </button>
                  </>
                ) : previewLoading ? (
                  <div className={styles.miniPlayerPlaceholder}>
                    <RedesignIcon
                      name="loading"
                      className={cn(styles.spinning, styles.placeholderIcon)}
                    />
                    <span>
                      {t("live_recorder.podklyuchenie", "Подключение...")}
                    </span>
                  </div>
                ) : previewError ? (
                  <div className={styles.miniPlayerPlaceholder}>
                    <RedesignIcon
                      name="alert"
                      className={cn(
                        styles.placeholderIcon,
                        styles.placeholderIconDanger,
                      )}
                    />
                    <span>{previewError}</span>
                    <button
                      type="button"
                      className={styles.quickRangeChip}
                      onClick={() =>
                        activePreviewJob &&
                        void startWatchingJob(activePreviewJob)
                      }
                    >
                      {t("live_recorder.povtorit", "Повторить")}
                    </button>
                  </div>
                ) : (
                  <div className={styles.miniPlayerPlaceholder}>
                    <span>{t("live_recorder.net_signala", "Нет сигнала")}</span>
                    <button
                      type="button"
                      className={styles.quickRangeChip}
                      onClick={() =>
                        activePreviewJob &&
                        void startWatchingJob(activePreviewJob)
                      }
                    >
                      {t("live_recorder.povtorit_2", "Повторить")}
                    </button>
                  </div>
                )}
              </div>
              <span className={styles.miniPlayerCaption}>
                <span className={styles.recDot} aria-hidden="true" />
                REC {formatSeconds(activePreviewJobElapsed)}
              </span>
            </div>

            <div className={styles.trimControls}>
              {/* ---------- Manual chronology markers ---------- */}
              <div className={styles.markersSection}>
                <div className={styles.trimHeader}>
                  <span className={styles.trimTitle}>
                    <RedesignIcon name="bookmark" className="size-3.5" />
                    {t("live_recorder.hronologiya", "Хронология")}
                  </span>
                  <span className={styles.trimSelectionInfo}>
                    {activeJobMarkers.length > 0
                      ? `${activeJobMarkers.length} мет.`
                      : "нет меток"}
                  </span>
                </div>
                <div className={styles.markerInputRow}>
                  <input
                    type="text"
                    className={styles.markerLabelInput}
                    placeholder={t(
                      "live_recorder.chto_proishodit_podpis_metki",
                      "Что происходит? (подпись метки)",
                    )}
                    value={markerLabelInput}
                    maxLength={60}
                    onChange={(e) => setMarkerLabelInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") placeMarker();
                    }}
                  />
                  <button
                    type="button"
                    className={styles.markerAddButton}
                    onClick={() => placeMarker()}
                    title={t(
                      "live_recorder.postavit_metku_na_tekuschem_momente",
                      "Поставить метку на текущем моменте эфира (клавиша M)",
                    )}
                  >
                    <RedesignIcon name="bookmark" className="size-3.5" />
                    Метка · {formatSeconds(activePreviewMediaSec)}
                    <kbd className={styles.markerKbd}>M</kbd>
                  </button>
                </div>
                {activeJobMarkers.length > 0 && (
                  <div className={styles.markerChips}>
                    {activeJobMarkers.map((m) => (
                      <span key={m.id} className={styles.markerChip}>
                        {editingMarkerId === m.id ? (
                          <input
                            type="text"
                            className={styles.markerEditInput}
                            value={editingMarkerText}
                            autoFocus
                            maxLength={60}
                            onChange={(e) =>
                              setEditingMarkerText(e.target.value)
                            }
                            onBlur={commitMarkerEdit}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") commitMarkerEdit();
                              if (e.key === "Escape") {
                                setEditingMarkerId(null);
                                setEditingMarkerText("");
                              }
                            }}
                          />
                        ) : (
                          <>
                            <button
                              type="button"
                              className={styles.markerChipMain}
                              onClick={(e) => {
                                // A double-click also fires two clicks — ignore the
                                // second one so renaming does not move the timeline twice.
                                if (e.detail > 1) return;
                                selectMarkerRange(m.id);
                              }}
                              onDoubleClick={() =>
                                startEditingMarker(m.id, m.label)
                              }
                              title={t(
                                "live_recorder.klik_vydelit_otrezok_ot_etoy",
                                "Клик — выделить отрезок от этой метки до следующей. Двойной клик — переименовать.",
                              )}
                            >
                              <span className={styles.markerChipTime}>
                                {formatSeconds(m.t)}
                              </span>
                              <span className={styles.markerChipLabel}>
                                {m.label}
                              </span>
                            </button>
                            <button
                              type="button"
                              className={styles.markerChipDelete}
                              onClick={() =>
                                activePreviewJobId &&
                                removeMarker(activePreviewJobId, m.id)
                              }
                              aria-label={t(
                                "live_recorder.udalit_metku_2",
                                "Удалить метку",
                              )}
                              title={t(
                                "live_recorder.udalit_metku",
                                "Удалить метку",
                              )}
                            >
                              <RedesignIcon name="close" className="size-3" />
                            </button>
                          </>
                        )}
                      </span>
                    ))}
                  </div>
                )}
              </div>

              <div className={styles.trimHeader}>
                <span className={styles.trimTitle}>
                  {t(
                    "live_recorder.otrezok_dlya_sohraneniya",
                    "Отрезок для сохранения",
                  )}
                </span>
                <span className={styles.trimSelectionInfo}>
                  {formatSeconds(timelineEnd - timelineStart)}
                </span>
              </div>

              <div className={styles.quickRanges}>
                {QUICK_RANGES.map((range) => (
                  <button
                    key={range.label}
                    type="button"
                    className={styles.quickRangeChip}
                    onClick={() => applyQuickRange(range.seconds)}
                    disabled={
                      range.seconds !== null &&
                      range.seconds > activePreviewMediaSec
                    }
                    title={
                      range.seconds === null
                        ? "Вся запись"
                        : `Последние ${range.label}`
                    }
                  >
                    {range.label}
                  </button>
                ))}
                <button
                  type="button"
                  className={cn(
                    styles.quickRangeChip,
                    styles.quickRangeChipAccent,
                  )}
                  onClick={selectFromLastMarker}
                  disabled={activeJobMarkers.length === 0}
                  title={t(
                    "live_recorder.vydelit_ot_posledney_metki_do",
                    "Выделить от последней метки до текущего момента",
                  )}
                >
                  <RedesignIcon name="bookmark" className="size-3" />
                  {t("live_recorder.ot_metki_seychas", "От метки → сейчас")}
                </button>
              </div>

              <div className={styles.dualSlider}>
                <div className={styles.dualTrack}>
                  <div
                    className={styles.dualFill}
                    style={{
                      left: `${timelinePct(timelineStart)}%`,
                      width: `${timelinePct(timelineEnd) - timelinePct(timelineStart)}%`,
                    }}
                  />
                </div>
                {activeJobMarkers.map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    className={styles.markerPin}
                    style={{
                      left: `${timelinePct(Math.min(m.t, activePreviewMediaSec))}%`,
                    }}
                    onClick={() => selectMarkerRange(m.id)}
                    title={`${formatSeconds(m.t)} · ${m.label}`}
                    aria-label={`Метка ${m.label}`}
                  />
                ))}
                <input
                  type="range"
                  className={styles.dualRange}
                  min={0}
                  max={activePreviewMediaSec}
                  value={timelineStart}
                  onChange={(e) => handleStartChange(Number(e.target.value))}
                  aria-label={t(
                    "live_recorder.nachalo_otrezka",
                    "Начало отрезка",
                  )}
                />
                <input
                  type="range"
                  className={styles.dualRange}
                  min={0}
                  max={activePreviewMediaSec}
                  value={timelineEnd}
                  onChange={(e) => handleEndChange(Number(e.target.value))}
                  aria-label={t("live_recorder.konec_otrezka", "Конец отрезка")}
                />
              </div>

              <div className={styles.trimTimeRow}>
                <div className={styles.trimTimeField}>
                  <label>{t("live_recorder.nachalo", "Начало")}</label>
                  <div className={styles.textInputWithGrab}>
                    <input
                      type="text"
                      value={timelineStartInput}
                      onChange={(e) => setTimelineStartInput(e.target.value)}
                      onBlur={handleStartInputBlur}
                      className={styles.timeTextInput}
                    />
                    <button
                      type="button"
                      onClick={setStartFromPlayer}
                      className={styles.grabTimeButton}
                      title={t(
                        "live_recorder.vzyat_iz_tekuschey_pozicii_pleera",
                        "Взять из текущей позиции плеера",
                      )}
                    >
                      <RedesignIcon name="preview" className="size-3.5" />
                    </button>
                  </div>
                </div>
                <span className={styles.trimTimeDash}>—</span>
                <div className={styles.trimTimeField}>
                  <label>{t("live_recorder.konec", "Конец")}</label>
                  <div className={styles.textInputWithGrab}>
                    <input
                      type="text"
                      value={timelineEndInput}
                      onChange={(e) => setTimelineEndInput(e.target.value)}
                      onBlur={handleEndInputBlur}
                      className={styles.timeTextInput}
                    />
                    <button
                      type="button"
                      onClick={setEndFromPlayer}
                      className={styles.grabTimeButton}
                      title={t(
                        "live_recorder.vzyat_iz_tekuschey_pozicii_pleera_2",
                        "Взять из текущей позиции плеера",
                      )}
                    >
                      <RedesignIcon name="preview" className="size-3.5" />
                    </button>
                  </div>
                </div>
              </div>

              <div className={styles.segmentSaveRow}>
                <input
                  type="text"
                  className={styles.segmentLabelInput}
                  placeholder={t(
                    "live_recorder.podpis_otrezka_popadet_v_imya",
                    "Подпись отрезка → попадёт в имя файла",
                  )}
                  value={segmentLabel}
                  maxLength={80}
                  onChange={(e) => setSegmentLabel(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !isSplitting) {
                      void handleSplit(job.id, job.spec.name);
                    }
                  }}
                />
                <button
                  type="button"
                  className={cn(styles.actionButton, styles.splitButton)}
                  onClick={() => handleSplit(job.id, job.spec.name)}
                  disabled={isSplitting}
                  title={t(
                    "live_recorder.sohranit_vybrannyy_otrezok_v_otdelnyy",
                    "Сохранить выбранный отрезок в отдельный файл, запись продолжится. Имя: «Название — Подпись [начало → конец].mp4»",
                  )}
                  aria-busy={isSplitting}
                >
                  <RedesignIcon
                    name={isSplitting ? "loading" : "save"}
                    className={isSplitting ? styles.spinning : undefined}
                  />
                  {isSplitting ? "Сохранение..." : "Сохранить отрезок"}
                </button>
              </div>

              {jobSegments.length > 0 && (
                <div className={styles.partsRow}>
                  <span className={styles.partsRowLabel}>
                    Сохранённые отрезки · {jobSegments.length}
                  </span>
                  <div className={styles.partsRowList}>
                    {jobSegments.map((seg) => (
                      <button
                        key={seg.fileName}
                        type="button"
                        className={cn(styles.partChip, styles.segmentChip)}
                        title={`Показать файл: ${seg.fileName}`}
                        onClick={() => {
                          void ipc.revealFile(
                            joinPath(job.spec.directory, seg.fileName),
                          );
                        }}
                      >
                        <RedesignIcon name="media" className="size-3" />
                        <span className={styles.segmentChipRange}>
                          {formatSeconds(seg.startSec)}–
                          {formatSeconds(seg.endSec)}
                        </span>
                        <span className={styles.segmentChipLabel}>
                          {seg.label || seg.fileName}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {isRunning && (
          <div className={styles.cardSettingsPanel}>
            <span className={styles.cardSettingsTitle}>
              {t(
                "live_recorder.postobrabotka_otrezka",
                "Постобработка отрезка",
              )}
            </span>
            <div className={styles.cardChipsRow}>
              <label
                className={styles.chip}
                title={t(
                  "live_recorder.udalyat_maty_s_pomoschyu_fetchr",
                  "Удалять маты с помощью Fetchr Mute",
                )}
              >
                <input
                  type="checkbox"
                  checked={getJobSettings(job).muteSwears}
                  onChange={() => toggleJobSetting(job.id, "muteSwears")}
                  disabled={isSplitting}
                />
                <span>{t("live_recorder.bez_matov", "Без матов")}</span>
              </label>

              <label
                className={styles.chip}
                title={t(
                  "live_recorder.zablyurit_reklamnye_integracii_sponsorov",
                  "Заблюрить рекламные интеграции спонсоров",
                )}
              >
                <input
                  type="checkbox"
                  checked={getJobSettings(job).blurSponsors}
                  onChange={() => toggleJobSetting(job.id, "blurSponsors")}
                  disabled={isSplitting}
                />
                <span>
                  {t("live_recorder.blyur_sponsorov", "Блюр спонсоров")}
                </span>
              </label>

              <label
                className={styles.chip}
                title={t(
                  "live_recorder.udalit_fonovuyu_muzyku_ostavit_tolko",
                  "Удалить фоновую музыку / оставить только голос",
                )}
              >
                <input
                  type="checkbox"
                  checked={getJobSettings(job).vocalRemover}
                  onChange={() => toggleJobSetting(job.id, "vocalRemover")}
                  disabled={isSplitting}
                />
                <span>{t("live_recorder.bez_muzyki", "Без музыки")}</span>
              </label>

              <label
                className={styles.chip}
                title={t(
                  "live_recorder.sohranyat_json-fayl_chata_ryadom_s",
                  "Сохранять json-файл чата рядом с отрезком (без рендера видео)",
                )}
              >
                <input
                  type="checkbox"
                  checked={getJobSettings(job).recordChatSeparate}
                  onChange={() =>
                    toggleJobSetting(job.id, "recordChatSeparate")
                  }
                  disabled={isSplitting}
                />
                <span>{t("live_recorder.chat_json", "Чат (JSON)")}</span>
              </label>
            </div>
          </div>
        )}

        {!isRunning && jobSegments.length > 0 && (
          <div className={styles.partsRow}>
            <span className={styles.partsRowLabel}>
              Сохранённые отрезки · {jobSegments.length}
            </span>
            <div className={styles.partsRowList}>
              {jobSegments.map((seg) => (
                <button
                  key={seg.fileName}
                  type="button"
                  className={cn(styles.partChip, styles.segmentChip)}
                  title={`Показать файл: ${seg.fileName}`}
                  onClick={() => {
                    void ipc.revealFile(
                      joinPath(job.spec.directory, seg.fileName),
                    );
                  }}
                >
                  <RedesignIcon name="media" className="size-3" />
                  <span className={styles.segmentChipRange}>
                    {formatSeconds(seg.startSec)}–{formatSeconds(seg.endSec)}
                  </span>
                  <span className={styles.segmentChipLabel}>
                    {seg.label || seg.fileName}
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}

        {job.error &&
          job.status !== "cancelled" &&
          !/^cancell?ed$/i.test(job.error.trim()) && (
            <div className={styles.errorBox}>
              <RedesignIcon name="alert" className={styles.alertIcon} />
              <span>Ошибка: {job.error}</span>
            </div>
          )}
      </section>
    );
  };

  const railItem = (job: Job) => {
    const running = job.status === "running";
    const elapsed = job.started_at
      ? Math.floor(((job.finished_at || Date.now()) - job.started_at) / 1000)
      : 0;
    const bytes = job.live_stats?.recorded_bytes ?? null;
    const stalled = running && (job.live_stats?.stalled ?? false);
    const platform = job.spec.meta?.platform || detectPlatform(job.spec.url);
    return (
      <button
        key={job.id}
        type="button"
        className={styles.railItem}
        aria-pressed={selectedKey === job.id}
        onClick={() => selectJob(job)}
      >
        <LiveThumb
          thumbnail={job.spec.meta?.thumbnail}
          platform={platform}
          live={running}
        />
        <span className={styles.railText}>
          <b>{job.spec.name}</b>
          <span className={cn(stalled && styles.railWarn)}>
            {running
              ? stalled
                ? "нет сигнала"
                : `${formatSeconds(elapsed)} · ${bytes !== null ? formatBytes(bytes) : job.progress.size || "0 B"}`
              : `${getStatusLabel(job.status)} · ${formatSeconds(elapsed)}`}
          </span>
        </span>
      </button>
    );
  };

  const runningJobs = liveJobs.filter(
    (job) => job.status === "running" || job.status === "queued",
  );
  const selectedArmed =
    armed.find((item) => `armed:${item.id}` === selectedKey) ?? null;
  const selectedJob = selectedArmed
    ? null
    : (liveJobs.find((job) => job.id === selectedKey) ?? null);
  // Скорость записи на диск: по ней прогноз, на сколько хватит места.
  const bytesPerSec = runningJobs.reduce((sum, job) => {
    const bytes = job.live_stats?.recorded_bytes ?? 0;
    const secs = job.started_at ? (Date.now() - job.started_at) / 1000 : 0;
    return secs > 10 ? sum + bytes / secs : sum;
  }, 0);
  const diskHours =
    diskFreeBytes !== null && bytesPerSec > 0
      ? diskFreeBytes / bytesPerSec / 3600
      : null;

  return (
    <div className={cn(fetchrThemeClassName, styles.page)}>
      <div className={styles.studioHost}>
        <div className={styles.studio}>
          <aside className={styles.rail}>
            <div className={styles.railHead}>
              <button
                type="button"
                className={styles.primaryButton}
                onClick={() => setNewOpen(true)}
              >
                <RedesignIcon name="add" />
                {t("live_recorder.novaya_zapis", "Новая запись")}
              </button>
            </div>
            <div className={styles.railList}>
              {runningJobs.length > 0 && (
                <>
                  <div className={styles.railGroup}>
                    <span className={styles.recDot} aria-hidden="true" />
                    Пишется <b>{runningJobs.length}</b>
                  </div>
                  {runningJobs.map(railItem)}
                </>
              )}
              {armed.length > 0 && (
                <>
                  <div className={styles.railGroup}>
                    <span className={styles.waitDot} aria-hidden="true" />
                    Ждём <b>{armed.length}</b>
                  </div>
                  {armed.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      className={styles.railItem}
                      aria-pressed={selectedKey === `armed:${item.id}`}
                      onClick={() => setSelectedKey(`armed:${item.id}`)}
                    >
                      <span className={styles.railWaitBox}>
                        <RedesignIcon name="time" className="size-4" />
                      </span>
                      <span className={styles.railText}>
                        <b>{item.name || item.url}</b>
                        <span>
                          {item.mode === "scheduled" && item.fireAtMs
                            ? `старт ${new Date(item.fireAtMs).toLocaleString("ru-RU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}`
                            : "ждём эфир"}
                        </span>
                      </span>
                    </button>
                  ))}
                </>
              )}
              {historyJobs.length > 0 && (
                <>
                  <div className={styles.railGroup}>
                    <span className={styles.doneDot} aria-hidden="true" />
                    Готово <b>{historyJobs.length}</b>
                    <button
                      type="button"
                      className={styles.railClear}
                      onClick={clearHistory}
                      disabled={isClearingHistory}
                      title={t(
                        "live_recorder.udalit_iz_spiska_zavershennye_i",
                        "Удалить из списка завершённые и остановленные записи (файлы останутся на диске)",
                      )}
                    >
                      {t("live_recorder.ochistit_istoriyu", "Очистить")}
                    </button>
                  </div>
                  {historyJobs.map(railItem)}
                </>
              )}
              {liveJobs.length === 0 && armed.length === 0 && (
                <p className={styles.railEmpty}>
                  {t("live_recorder.zapisey_poka_net", "Записей пока нет")}
                </p>
              )}
            </div>
            <div className={styles.railDisk}>
              <div className={styles.railDiskHead}>
                <span>Диск</span>
                <b>
                  {diskFreeBytes !== null
                    ? `${formatBytes(diskFreeBytes)} свободно`
                    : "—"}
                </b>
              </div>
              <span
                className={cn(
                  styles.railDiskHint,
                  diskFreeBytes !== null &&
                    diskFreeBytes < 5 * 1024 ** 3 &&
                    styles.railWarn,
                )}
              >
                {diskFreeBytes !== null && diskFreeBytes < 5 * 1024 ** 3
                  ? "мало места для длинной записи"
                  : diskHours !== null
                    ? `при текущей скорости хватит ~${diskHours >= 1 ? `${Math.floor(diskHours)} ч` : `${Math.max(1, Math.round(diskHours * 60))} мин`}`
                    : activeDirectory}
              </span>
            </div>
          </aside>

          <main className={styles.stageWrap}>
            {error && (
              <div className={styles.errorBox} role="alert">
                <RedesignIcon name="alert" className={styles.alertIcon} />
                <span>{error}</span>
              </div>
            )}
            {successMsg && (
              <div className={styles.successBox} role="status">
                <RedesignIcon name="check" className={styles.alertIcon} />
                <span>{successMsg}</span>
              </div>
            )}

            {selectedArmed ? (
              <section className={styles.stage}>
                <ArmedRecordingCard
                  armed={selectedArmed}
                  onCancel={removeArmed}
                />
              </section>
            ) : selectedJob ? (
              renderJobStage(selectedJob)
            ) : (
              <div className={styles.emptyState}>
                <DemoSlot demo={LiveDemo} height={190} />
                <h3>
                  {t("live_recorder.zapisey_poka_net", "Записей пока нет")}
                </h3>
                <p>
                  Вставьте ссылку на трансляцию: запись начнётся сразу или
                  дождётся выхода в эфир.
                </p>
                <button
                  type="button"
                  className={styles.primaryButton}
                  onClick={() => setNewOpen(true)}
                >
                  <RedesignIcon name="add" />
                  {t("live_recorder.novaya_zapis", "Новая запись")}
                </button>
              </div>
            )}
          </main>
        </div>
      </div>

      {newOpen && (
        <div
          className={styles.newOverlay}
          role="presentation"
          {...backdropDismiss(() => setNewOpen(false))}
        >
          <div
            className={styles.newCard}
            role="dialog"
            aria-modal="true"
            aria-label="Новая запись"
            onClick={(e) => e.stopPropagation()}
          >
            <div className={styles.newHead}>
              <div>
                <h2 className={styles.sidebarTitle}>
                  {t("live_recorder.novaya_zapis", "Новая запись")}
                </h2>
                <p className={styles.sidebarSubtitle}>
                  {t(
                    "live_recorder.strim_zapishetsya_v_fone_okno",
                    "Стрим запишется в фоне — окно можно сворачивать",
                  )}
                </p>
              </div>
              <button
                type="button"
                className={styles.iconOnlyButton}
                onClick={() => setNewOpen(false)}
                aria-label="Закрыть"
              >
                <RedesignIcon name="close" />
              </button>
            </div>
            <div className={styles.newBody}>
              <div className={styles.formGroup}>
                <label htmlFor="stream-url">
                  {t("live_recorder.ssylka_na_strim", "Ссылка на стрим")}
                </label>
                <div className={styles.inputWrapper}>
                  <RedesignIcon name="link" className={styles.inputIcon} />
                  <input
                    id="stream-url"
                    type="text"
                    placeholder="https://twitch.tv/streamer"
                    value={url}
                    onChange={(e) => setUrl(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") startRecording();
                    }}
                  />
                </div>
              </div>

              <div className={styles.formGroup}>
                <label htmlFor="file-name">
                  Название файла
                  {titleLoading && (
                    <span className={styles.labelHint}>
                      {" "}
                      {t(
                        "live_recorder.ischem_nazvanie_strima",
                        "· ищем название стрима...",
                      )}
                    </span>
                  )}
                </label>
                <div className={styles.inputWrapper}>
                  {titleLoading ? (
                    <RedesignIcon
                      name="loading"
                      className={cn(styles.inputIcon, styles.spinning)}
                    />
                  ) : (
                    <RedesignIcon name="media" className={styles.inputIcon} />
                  )}
                  <input
                    id="file-name"
                    type="text"
                    placeholder={t(
                      "live_recorder.podstavitsya_avtomaticheski_iz_ssylki",
                      "Подставится автоматически из ссылки",
                    )}
                    value={name}
                    onChange={(e) => {
                      nameEditedManually.current = true;
                      setName(e.target.value);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") startRecording();
                    }}
                  />
                </div>
              </div>

              <div className={styles.formGroup}>
                <label>
                  {t("live_recorder.papka_sohraneniya", "Папка сохранения")}
                </label>
                <div className={styles.inputWrapper}>
                  <RedesignIcon name="folder" className={styles.inputIcon} />
                  <input
                    type="text"
                    value={activeDirectory}
                    readOnly
                    title={activeDirectory}
                  />
                  <button
                    className={styles.chooseDirButton}
                    type="button"
                    onClick={chooseDir}
                    title={t("live_recorder.vybrat_papku", "Выбрать папку")}
                  >
                    <RedesignIcon name="external" />
                  </button>
                </div>
                {diskFreeBytes !== null && (
                  <p
                    className={styles.sectionHelp}
                    style={{
                      marginTop: 6,
                      color:
                        diskFreeBytes < 5 * 1024 * 1024 * 1024
                          ? "var(--fetchr-color-danger, #f87171)"
                          : undefined,
                    }}
                  >
                    Свободно на диске: {formatBytes(diskFreeBytes)}
                    {diskFreeBytes < 5 * 1024 * 1024 * 1024 &&
                      " — мало для длинной записи"}
                  </p>
                )}
              </div>

              <p className={styles.qualityHint}>
                <RedesignIcon name="sparkle" className="size-3.5" />
                {t(
                  "live_recorder.pishetsya_maksimalnoe_kachestvo_istochnika_f",
                  "Пишется максимальное качество источника. Фактическое качество\n              (например «1080p60») определяется по файлу и показывается на карточке\n              после старта.",
                )}
              </p>

              <div className={styles.postProcessingSection}>
                <h3 className={styles.sectionSubtitle}>
                  <RedesignIcon name="time" className="size-3.5" />
                  {t("live_recorder.start_zapisi", "Старт записи")}
                </h3>
                <div
                  style={{
                    marginTop: 8,
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                  }}
                >
                  <span
                    style={{
                      fontSize: 12,
                      color: "var(--fetchr-color-fg-secondary, #bbb)",
                    }}
                  >
                    {t(
                      "live_recorder.data_i_vremya_starta",
                      "Дата и время старта",
                    )}
                  </span>
                  <input
                    type="datetime-local"
                    value={scheduledTime}
                    onChange={(e) => setScheduledTime(e.target.value)}
                    style={{
                      padding: "6px 8px",
                      borderRadius: 8,
                      border:
                        "1px solid var(--fetchr-color-border-subtle, #444)",
                      background: "transparent",
                      color: "inherit",
                      fontFamily: "monospace",
                      fontSize: 13,
                      colorScheme: "dark",
                    }}
                  />
                  {scheduledTime && (
                    <button
                      type="button"
                      onClick={() => setScheduledTime("")}
                      title={t(
                        "live_recorder.bez_raspisaniya_zapuskat_srazu_pri",
                        "Без расписания — запускать сразу при онлайне",
                      )}
                      style={{
                        padding: "4px 8px",
                        borderRadius: 6,
                        border:
                          "1px solid var(--fetchr-color-border-subtle, #444)",
                        background: "transparent",
                        color: "inherit",
                        cursor: "pointer",
                        fontSize: 12,
                      }}
                    >
                      {t("live_recorder.sbrosit", "Сбросить")}
                    </button>
                  )}
                </div>
                <p className={styles.sectionHelp} style={{ marginTop: 6 }}>
                  {t(
                    "live_recorder.posle_nazhatiya_nachat_zapis_esli",
                    "После нажатия «Начать запись»: если стрим оффлайн — запись не идёт, проверка онлайна каждые 5 секунд, старт автоматически при выходе в эфир (карточка «ОЖИДАНИЕ» слева). Дата и время необязательны — если заданы, ожидание начнётся с них. Можно поставить в ожидание несколько стримов; расписание сохраняется при перезапуске приложения.",
                  )}
                </p>
              </div>

              <div className={styles.postProcessingSection}>
                <h3 className={styles.sectionSubtitle}>
                  <RedesignIcon name="sparkle" className="size-3.5" />
                  {t("live_recorder.postobrabotka", "Постобработка")}
                </h3>
                <p className={styles.sectionHelp}>
                  {t(
                    "live_recorder.primenyaetsya_pri_otdelenii_otrezkov_ili",
                    "Применяется при отделении отрезков или остановке записи",
                  )}
                </p>

                <div className={styles.toggleList}>
                  <label className={styles.toggleRow}>
                    <span className={styles.toggleText}>
                      <strong>
                        {t("live_recorder.udalyat_maty", "Удалять маты")}
                      </strong>
                      <em>Fetchr Mute</em>
                    </span>
                    <input
                      type="checkbox"
                      checked={muteSwears}
                      onChange={(e) => setMuteSwears(e.target.checked)}
                    />
                    <span className={styles.toggleTrack} aria-hidden="true" />
                  </label>

                  <label className={styles.toggleRow}>
                    <span className={styles.toggleText}>
                      <strong>
                        {t(
                          "live_recorder.zablyurit_sponsorov",
                          "Заблюрить спонсоров",
                        )}
                      </strong>
                      <em>Sponsor Blur</em>
                    </span>
                    <input
                      type="checkbox"
                      checked={blurSponsors}
                      onChange={(e) => setBlurSponsors(e.target.checked)}
                    />
                    <span className={styles.toggleTrack} aria-hidden="true" />
                  </label>

                  <label className={styles.toggleRow}>
                    <span className={styles.toggleText}>
                      <strong>
                        {t("live_recorder.udalit_muzyku", "Удалить музыку")}
                      </strong>
                      <em>Vocal Remover</em>
                    </span>
                    <input
                      type="checkbox"
                      checked={vocalRemover}
                      onChange={(e) => setVocalRemover(e.target.checked)}
                    />
                    <span className={styles.toggleTrack} aria-hidden="true" />
                  </label>

                  <label className={styles.toggleRow}>
                    <span className={styles.toggleText}>
                      <strong>
                        {t("live_recorder.chat_v_json", "Чат в JSON")}
                      </strong>
                      <em>
                        {t(
                          "live_recorder.fayl_chatjson_bez_rendera_video",
                          "файл *_chat.json, без рендера видео",
                        )}
                      </em>
                    </span>
                    <input
                      type="checkbox"
                      checked={recordChatSeparate}
                      onChange={(e) => setRecordChatSeparate(e.target.checked)}
                    />
                    <span className={styles.toggleTrack} aria-hidden="true" />
                  </label>
                </div>
              </div>

              <button
                className={styles.primaryButton}
                type="button"
                onClick={startRecording}
              >
                <RedesignIcon name="play" />
                {scheduledTime ? "Запланировать" : "Начать запись"}
              </button>
            </div>
          </div>
        </div>
      )}

      {previewExpanded && (previewUrl || previewLoading) && (
        <div
          className={styles.previewOverlay}
          role="dialog"
          aria-modal="true"
          {...backdropDismiss(() => setPreviewExpanded(false))}
        >
          <div
            className={styles.previewModal}
            onClick={(e) => e.stopPropagation()}
          >
            <div className={styles.previewModalHeader}>
              <span className={styles.previewModalTitle}>
                <span className={styles.recDot} aria-hidden="true" />
                {reviewUrl
                  ? `Просмотр записи · 0:00–${formatSeconds(activePreviewMediaSec)} · запись продолжается`
                  : `Предпросмотр · REC ${formatSeconds(activePreviewJobElapsed)} · запись продолжается`}
              </span>
              <div className={styles.previewModalHeaderActions}>
                <button
                  type="button"
                  className={styles.previewModalRefresh}
                  onClick={() => void loadRecordingReview()}
                  disabled={reviewLoading}
                  title={t(
                    "live_recorder.obnovit_podtyanut_poslednie_zapisannye_minut",
                    "Обновить — подтянуть последние записанные минуты",
                  )}
                >
                  <RedesignIcon
                    name="refresh"
                    className={reviewLoading ? styles.spinning : undefined}
                  />
                  {reviewLoading ? "Обновление..." : "Обновить запись"}
                </button>
                <button
                  type="button"
                  className={styles.previewModalClose}
                  onClick={() => setPreviewExpanded(false)}
                  aria-label={t("live_recorder.zakryt", "Закрыть")}
                  title={t("live_recorder.zakryt_esc", "Закрыть (Esc)")}
                >
                  <RedesignIcon name="close" />
                </button>
              </div>
            </div>
            <div className={styles.previewModalBody}>
              {reviewLoading && !reviewUrl ? (
                <div className={styles.miniPlayerPlaceholder}>
                  <RedesignIcon
                    name="loading"
                    className={cn(styles.spinning, styles.placeholderIcon)}
                  />
                  <span>
                    {t(
                      "live_recorder.gotovim_zapis_dlya_peremotki",
                      "Готовим запись для перемотки...",
                    )}
                  </span>
                </div>
              ) : reviewUrl ? (
                <HlsPlayer
                  ref={expandedPlayerRef}
                  src={reviewUrl}
                  className={styles.previewModalPlayer}
                  clean={false}
                  autoPlay={true}
                />
              ) : previewUrl ? (
                <div className={styles.previewModalFallback}>
                  {reviewError && (
                    <span className={styles.previewModalFallbackNote}>
                      Перемотка записи недоступна: {reviewError}. Показан живой
                      эфир.
                    </span>
                  )}
                  <HlsPlayer
                    ref={expandedPlayerRef}
                    src={previewUrl}
                    className={styles.previewModalPlayer}
                    clean={false}
                    autoPlay={true}
                  />
                </div>
              ) : (
                <div className={styles.miniPlayerPlaceholder}>
                  <RedesignIcon
                    name="loading"
                    className={cn(styles.spinning, styles.placeholderIcon)}
                  />
                  <span>
                    {t(
                      "live_recorder.podklyuchenie_k_translyacii",
                      "Подключение к трансляции...",
                    )}
                  </span>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {showTokenReminder && (
        <div
          className={styles.reminderOverlay}
          role="dialog"
          aria-modal="true"
          {...backdropDismiss(() => setShowTokenReminder(false))}
        >
          <div
            className={styles.reminderModal}
            onClick={(e) => e.stopPropagation()}
          >
            <div className={styles.reminderIcon}>
              <RedesignIcon name="key" />
            </div>
            <h3 className={styles.reminderTitle}>
              {t(
                "live_recorder.nuzhen_token_dlya_1440p_2k",
                "Нужен токен для 1440p / 2K",
              )}
            </h3>
            <p className={styles.reminderText}>
              {t(
                "live_recorder.chtoby_zapisyvat_twitch_v_1440p",
                "Чтобы записывать Twitch в 1440p / 2K и без рекламы, нужен auth-token.\n              Без него запись пойдёт в максимально доступном обычном качестве.",
              )}
            </p>
            <ol className={styles.reminderSteps}>
              <li>
                {t("live_recorder.otkroyte", "Откройте")}{" "}
                <strong>{t("live_recorder.nastroyki", "Настройки")}</strong>{" "}
                {t(
                  "live_recorder.shesterenka_v_pravom_verhnem_uglu",
                  "— шестерёнка в правом верхнем углу.",
                )}
              </li>
              <li>
                {t(
                  "live_recorder.sleva_vyberite_vkladku",
                  "Слева выберите вкладку",
                )}{" "}
                <strong>{t("live_recorder.integracii", "«Интеграции»")}</strong>
                .
              </li>
              <li>
                {t("live_recorder.naydite_blok", "Найдите блок")}{" "}
                <strong>
                  {t("live_recorder.import_cookiestxt", "«Импорт cookies.txt»")}
                </strong>{" "}
                {t(
                  "live_recorder.i_sleduyte_instrukcii_pod_nim",
                  "и следуйте инструкции под ним.",
                )}
              </li>
            </ol>
            <div className={styles.reminderActions}>
              <button
                type="button"
                className={cn(styles.actionButton, styles.splitButton)}
                onClick={goToTokenSettings}
              >
                <RedesignIcon name="settings" />
                {t(
                  "live_recorder.pereyti_k_nastroyke_tokena",
                  "Перейти к настройке токена",
                )}
              </button>
              <button
                type="button"
                className={styles.actionButton}
                onClick={() => {
                  setShowTokenReminder(false);
                  armRecording();
                }}
              >
                {t("live_recorder.zapisat_bez_tokena", "Записать без токена")}
              </button>
            </div>
            <label className={styles.reminderDontShow}>
              <input
                type="checkbox"
                checked={hideTwitchTokenReminder}
                onChange={(e) => setHideTwitchTokenReminder(e.target.checked)}
              />
              <span>
                {t("live_recorder.bolshe_ne_pokazyvat", "Больше не показывать")}
              </span>
            </label>
          </div>
        </div>
      )}
    </div>
  );
}
