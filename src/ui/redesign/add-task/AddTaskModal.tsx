import { useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { useFocusTrap } from "@/hooks/useFocusTrap";
import { backdropDismiss } from "@/lib/backdrop";
import { ipc } from "@/lib/ipc";
import { StreamDownloader } from "@/lib/stream-downloader";
import { formatHms, parseTimeInput, parseUrlStartTime } from "@/lib/timecode";
import { useUI } from "@/stores/ui";
import { defaultPerformanceSettings, useSettings } from "@/stores/settings";
import { defaultPresetRuntimeSettings, usePresets } from "@/stores/presets";
import { useWorkflowPresets } from "@/stores/workflowPresets";
import type { AudioFormat, DownloadKind, JobSpec, PreviewSource, ResolvedStream, VideoCodecPolicy } from "@/types/job";
import { RedesignIcon } from "@/ui/redesign/icons/iconMap";
import { fetchrThemeClassName } from "@/ui/redesign/theme";
import { modalIn, modalOut } from "@/ui/redesign/theme/gsapMotion";
import { launchQueueFlight } from "@/ui/redesign/layout";
import { useGsapPresence } from "@/hooks/useGsapPresence";
import {
  fetchrMuteModelForMode,
  loadSavedFetchrMuteSettings,
} from "@/ui/redesign/fetchr-mute/fetchrMuteSettings";
import { detectPlatform, type Platform } from "@/lib/url";

import { AddTaskForm } from "./AddTaskForm";
import styles from "./AddTaskModal.module.css";
import { SourceTabs, sourceTabId, type AddTaskSource } from "./SourceTabs";
import type { TimecodeRange } from "./TimecodeRangeList";
import { closedRange, ensureTwitchAuth } from "@/services/streams/streamDownload";
import { youtubeEmbedUrl } from "@/lib/youtube";

const PANEL_ID = "add-task-panel";
const SUBMIT_HINT_ID = "add-task-submit-hint";

export interface AddTaskModalProps {
  open: boolean;
  onClose: () => void;
  onConfigureBlur?: () => void;
  onQueued?: () => void;
}

export function AddTaskModal({ open, onClose, onConfigureBlur, onQueued }: AddTaskModalProps) {
  const navigate = useNavigate();
  const trapRef = useFocusTrap<HTMLDivElement>(open);
  const backdropRef = useRef<HTMLDivElement | null>(null);
  const submitRef = useRef<HTMLButtonElement | null>(null);
  const { shouldRender, ref: modalRef } = useGsapPresence<HTMLDivElement>(open, (element, direction) =>
    direction === "in" ? modalIn(backdropRef.current, element) : modalOut(backdropRef.current, element),
  );
  const { t } = useTranslation();
  const settings = useSettings();
  const consumeAddDialogPrefill = useUI((state) => state.consumeAddDialogPrefill);
  const presets = usePresets((state) => state.presets);
  const chatPresets = useWorkflowPresets((state) => state.chatPresets);
  const activeChatPresetId = useWorkflowPresets((state) => state.activeChatPresetId);
  const setActiveChatPreset = useWorkflowPresets((state) => state.setActiveChatPreset);
  const sponsorPresets = useWorkflowPresets((state) => state.sponsorPresets);
  const activeSponsorPresetId = useWorkflowPresets((state) => state.activeSponsorPresetId);
  const setActiveSponsorPreset = useWorkflowPresets((state) => state.setActiveSponsorPreset);
  const activePresetId = usePresets((state) => state.activePresetId);
  const activePreset = presets.find((preset) => preset.id === activePresetId) ?? presets[0];
  const runtime = { ...defaultPresetRuntimeSettings, ...activePreset?.runtime };
  const [source, setSource] = useState<AddTaskSource>("twitch");
  const [sourceUrls, setSourceUrls] = useState<Record<AddTaskSource, string>>(() => createEmptySourceUrls());
  const [fileName, setFileName] = useState("");
  const fileNameTouchedRef = useRef(false);
  const [quality, setQuality] = useState(runtime.quality || "best");
  const codecPolicy: VideoCodecPolicy = runtime.codecPolicy ?? "compatible";
  const [downloadFolder, setDownloadFolder] = useState(runtime.directory || settings.directory);
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [ranges, setRanges] = useState<TimecodeRange[]>([]);
  const [downloadChatEnabled, setDownloadChatEnabled] = useState(Boolean(runtime.downloadChat));
  const [sponsorBlurEnabled, setSponsorBlurEnabled] = useState(Boolean(runtime.blurSponsors));
  const [unmuteVideoEnabled, setUnmuteVideoEnabled] = useState(Boolean(runtime.unmuteVideo));
  const [fetchrMuteEnabled, setFetchrMuteEnabled] = useState(false);
  const [resolved, setResolved] = useState<ResolvedStream | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewEmbedUrl, setPreviewEmbedUrl] = useState<string | null>(null);
  const [previewSource, setPreviewSource] = useState<PreviewSource | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastAnalyzedUrl, setLastAnalyzedUrl] = useState("");

  const activeSource = source;
  const sourceUrl = sourceUrls[activeSource] ?? "";
  const sourceLabel = getSourceLabel(activeSource);
  const m3u8VideoOnly = activeSource === "m3u8";
  const forceVodMode = isTwitchVodUrl(sourceUrl);
  // Audio-only renditions stay in the list: picking one is what switches the
  // job to an audio download, so there is no separate mode control.
  const qualityOptions = useMemo(() => resolved?.qualities ?? [], [resolved?.qualities]);
  const activeSponsorPreset = sponsorPresets.find((preset) => preset.id === activeSponsorPresetId) ?? sponsorPresets[0] ?? null;
  const activeChatPreset = chatPresets.find((preset) => preset.id === activeChatPresetId) ?? chatPresets[0] ?? null;
  const selectedQualityMeta =
    quality !== "best"
      ? qualityOptions.find((item) => item.id === quality) ?? null
      : null;
  // Mirrors the toggles AddTaskForm renders: a hidden switch must not keep
  // acting on whatever the active preset left enabled.
  const chatToggleVisible = activeSource !== "youtube" && activeSource !== "m3u8";
  const extraSettingsVisible = activeSource !== "youtube";
  const downloadKind: DownloadKind =
    selectedQualityMeta && selectedQualityMeta.has_audio && !selectedQualityMeta.has_video
      ? "audio"
      : "video";
  // Keep the source codec so the extraction is a stream copy, never a transcode.
  const audioFormat: AudioFormat =
    selectedQualityMeta?.acodec === "opus" ? "opus" : "m4a";

  const analyze = async (targetUrl?: string) => {
    const urlToAnalyze = (targetUrl ?? sourceUrl).trim();
    if (!urlToAnalyze) return;

    const detected = detectPlatform(urlToAnalyze);
    const expected = getExpectedPlatform(activeSource);
    if (detected !== "unknown" && detected !== expected) {
      const nextSource = normalizeSource(detected);
      setSource(nextSource);
      setSourceUrls((items) => ({ ...items, [activeSource]: "", [nextSource]: urlToAnalyze }));
    }

    setAnalyzing(true);
    setError(null);
    setLastAnalyzedUrl(urlToAnalyze);
    try {
      const result = await ipc.resolveStream(
        urlToAnalyze,
        { enabled: runtime.useProxy, url: runtime.proxyUrl || settings.proxy.url },
        settings.binariesDir,
        settings.integrations.twitchAuthToken || null,
        codecPolicy,
      );
      setResolved(result);
      setSource(normalizeSource(result.platform));
      setQuality((current) => {
        const hasExactQuality = result.qualities.some((item) => item.id === current);
        return current === "best" || hasExactQuality ? current : "best";
      });
      if (!fileNameTouchedRef.current && result.title) {
        setFileName(result.title.slice(0, 90));
      }
      void loadPreview(result, urlToAnalyze);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setAnalyzing(false);
    }
  };

  useEffect(() => {
    if (!open) return;
    setError(null);
    // Prefill from external triggers (e.g. "add to queue" in the m3u8 finder):
    // set the source + URL so the form opens ready to configure before download.
    const prefill = consumeAddDialogPrefill();
    if (prefill?.url) {
      const detected = detectPlatform(prefill.url);
      const nextSource =
        normalizeSourceId(prefill.source) ?? (detected !== "unknown" ? normalizeSource(detected) : source);
      setSource(nextSource);
      setSourceUrls((items) => ({ ...items, [nextSource]: prefill.url }));
      const urlStart = parseUrlStartTime(prefill.url);
      if (urlStart) setStart(formatHms(urlStart));
      if (prefill.name) {
        fileNameTouchedRef.current = true;
        setFileName(prefill.name.slice(0, 90));
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (open) return;
    resetDraft();
  }, [open]);

  useEffect(() => {
    if (!open) {
      stopPreviewSession(previewSource);
    }
    return () => stopPreviewSession(previewSource);
  }, [open, previewSource]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        // Поверх может стоять другое модальное окно (обновление, плеер): Esc закрывает только его.
        if (event.defaultPrevented) return;
        if (document.querySelectorAll('[role="dialog"][aria-modal="true"]').length > 1) return;
        onClose();
      } else if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
        const canSubmit =
          Boolean(sourceUrl.trim()) &&
          (activeSource === "local" || (Boolean(downloadFolder.trim()) && Boolean(resolved))) &&
          !submitting;
        if (canSubmit) {
          event.preventDefault();
          void submit();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  useEffect(() => {
    if (activeSource === "local") {
      return;
    }
    const trimmed = sourceUrl.trim();
    if (!trimmed || trimmed === lastAnalyzedUrl) {
      return;
    }

    if (trimmed.length < 4) {
      return;
    }

    const detected = detectPlatform(trimmed);
    const expected = getExpectedPlatform(activeSource);

    if (detected !== "unknown" && detected !== expected) {
      const nextSource = normalizeSource(detected);
      setSource(nextSource);
      setSourceUrls((items) => ({ ...items, [activeSource]: "", [nextSource]: trimmed }));
      return;
    }

    setError(null);

    const timer = setTimeout(() => {
      void analyze(trimmed);
    }, 750);

    return () => clearTimeout(timer);
  }, [sourceUrl, activeSource, lastAnalyzedUrl, t]);


  const chooseLocalFile = async () => {
    const file = await ipc.chooseMediaFile();
    if (file) {
      setSourceUrls((items) => ({ ...items, local: file }));
      if (!fileName.trim()) {
        const parts = file.split(/[\\/]/);
        const base = parts[parts.length - 1];
        const dotIndex = base.lastIndexOf(".");
        const nameWithoutExt = dotIndex !== -1 ? base.slice(0, dotIndex) : base;
        setFileName(nameWithoutExt.slice(0, 90));
      }
    }
  };

  const submit = async () => {
    if (!sourceUrl.trim() || !downloadFolder.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      await ensureTwitchAuth(selectedQualityMeta?.height, resolved?.platform ?? activeSource);
      const baseName = fileName.trim() || resolved?.title?.trim() || "Stream";
      const activeBlurZones = extraSettingsVisible && sponsorBlurEnabled
        ? (activeSponsorPreset?.zones.length ? activeSponsorPreset.zones : settings.blurZones).filter((zone) => zone.enabled)
        : [];
      const cleanRanges = ranges
        .filter((range) => hasRangeInput(range.start, range.end))
        .map((range) => ({
          ...range,
          ...closedRange(
            hasNonZeroTime(range.start) ? range.start : "",
            hasNonZeroTime(range.end) ? range.end : "",
            resolved?.duration,
          ),
        }))
        .filter((range): range is typeof range & { start: string; end: string } => Boolean(range.start && range.end));

      if (cleanRanges.length > 0 && hasRangeInput(start, end)) {
        const draftClosed = closedRange(
          hasNonZeroTime(start) ? start : "",
          hasNonZeroTime(end) ? end : "",
          resolved?.duration,
        );
        if (
          draftClosed.start &&
          draftClosed.end &&
          !cleanRanges.some((r) => r.start === draftClosed.start && r.end === draftClosed.end)
        ) {
          cleanRanges.push({ id: "draft", start: draftClosed.start, end: draftClosed.end });
        }
      }

      const shouldDownloadChat = chatToggleVisible && downloadChatEnabled;
      const chatOverlay = activeChatPreset?.overlay ?? settings.chatOverlay;
      if (activeSource === "local") {
        await ipc.enqueueJob({
          url: sourceUrl.trim(),
          name: baseName,
          directory: downloadFolder.trim(),
          job_kind: "fetchrmute",
          mode: "vod",
          proxy: { enabled: false, url: "" },
          fetchr_mute_enabled: true,
          fetchr_mute_model: fetchrMuteModelForMode(loadSavedFetchrMuteSettings().mode),
          fetchr_mute_settings: {
            ...loadSavedFetchrMuteSettings(),
            asr_model: fetchrMuteModelForMode(loadSavedFetchrMuteSettings().mode)
          },
          meta: {
            title: baseName,
            platform: "local",
          },
        });
      } else if (cleanRanges.length > 0) {
        for (const [index, range] of cleanRanges.entries()) {
          await StreamDownloader.enqueueWithChat(
            buildSpec({
              name: `${baseName}_clip${String(index + 1).padStart(2, "0")}`,
              start: range.start,
              end: range.end,
              blurZones: activeBlurZones,
            }),
            chatOverlay,
            shouldDownloadChat,
          );
        }
      } else {
        const singleRange = hasRangeInput(start, end)
          ? closedRange(
              hasNonZeroTime(start) ? start : "",
              hasNonZeroTime(end) ? end : "",
              resolved?.duration,
            )
          : { start: null, end: null };
        await StreamDownloader.enqueueWithChat(
          buildSpec({
            name: baseName,
            ...singleRange,
            blurZones: activeBlurZones,
          }),
          chatOverlay,
          shouldDownloadChat,
        );
      }

      // Пилюля стартует до закрытия: координаты кнопки нужны, пока она на экране
      launchQueueFlight(
        submitRef.current,
        cleanRanges.length > 1 && activeSource !== "local" ? `${baseName} ×${cleanRanges.length}` : baseName,
      );
      onQueued?.();
      resetAfterSubmit();
      onClose();
    } catch (reason) {
      setError(String(reason));
    } finally {
      setSubmitting(false);
    }
  };

  const buildSpec = ({
    name,
    start,
    end,
    blurZones,
  }: {
    name: string;
    start: string | null;
    end: string | null;
    blurZones: JobSpec["blur_zones"];
  }): JobSpec => ({
    url: sourceUrl.trim(),
    chat_source_url: twitchVodChatSourceUrl(sourceUrl),
    name,
    directory: downloadFolder.trim(),
    job_kind: "video",
    mode: (activeSource === "rtmp" || resolved?.is_live) && !forceVodMode ? "live" : "vod",
    download_kind: downloadKind,
    start,
    end,
    fragments: [],
    split: false,
    split_interval_minutes: null,
    quality: quality !== "best" ? quality : null,
    quality_has_audio: selectedQualityMeta?.has_audio ?? null,
    quality_has_video: selectedQualityMeta?.has_video ?? null,
    quality_height: selectedQualityMeta?.height ?? null,
    video_codec_policy: codecPolicy,
    audio_format: audioFormat,
    unmute_video: extraSettingsVisible && unmuteVideoEnabled,
    proxy: { enabled: runtime.useProxy, url: runtime.proxyUrl || settings.proxy.url },
    chat_overlay: { ...settings.chatOverlay, enabled: false },
    performance: settings.performance ?? defaultPerformanceSettings,
    blur_zones: blurZones,
    binaries_dir: settings.binariesDir,
    fetchr_mute_enabled: extraSettingsVisible && fetchrMuteEnabled,
    fetchr_mute_model: fetchrMuteEnabled
      ? fetchrMuteModelForMode(loadSavedFetchrMuteSettings().mode)
      : null,
    fetchr_mute_settings: {
      ...loadSavedFetchrMuteSettings(),
      asr_model: fetchrMuteModelForMode(loadSavedFetchrMuteSettings().mode)
    },
    twitch_auth_token: settings.integrations.twitchAuthToken || null,
    meta: resolved
      ? {
          title: resolved.title,
          uploader: resolved.uploader,
          platform: resolved.platform,
          thumbnail: resolved.thumbnail,
          duration: resolved.duration,
        }
      : {
          platform: activeSource === "m3u8" ? "hls" : activeSource,
        },
  });

  // Узел держится в DOM, пока играет выход, — иначе анимации закрытия не видно.
  if (!shouldRender) return null;

  const submitBlocker = getSubmitBlocker({
    hasUrl: Boolean(sourceUrl.trim()),
    local: activeSource === "local",
    hasFolder: Boolean(downloadFolder.trim()),
    analyzing,
    resolved: Boolean(resolved),
  });
  const submitHint = submitBlocker
    ? {
        url: t("add.hint_need_url", "Вставь ссылку на запись или эфир."),
        folder: t("add.hint_need_folder", "Выбери папку для сохранения."),
        analyzing: t("add.hint_analyzing", "Проверяю ссылку…"),
        unchecked: t("add.hint_unchecked", "Ссылка ещё не проверена: нажми «Проанализировать» у поля или исправь адрес."),
      }[submitBlocker]
    : null;

  return (
    <div
      ref={backdropRef}
      className={`${fetchrThemeClassName} ${styles.backdrop}`}
      role="presentation"
      {...backdropDismiss(onClose)}
    >
      <div
        ref={(node) => {
          modalRef.current = node;
          trapRef.current = node;
        }}
        className={styles.modal}
        data-active-source={activeSource}
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="add-task-title"
      >
             <header className={styles.header}>
              <div>
                <h2 className={styles.title} id="add-task-title">
                  {t("add.modal_title", "Добавить задачу")}
                </h2>
              </div>
              <button className={styles.closeButton} type="button" aria-label={t("common.close", "Закрыть")} title={t("common.close", "Закрыть")} onClick={onClose}>
                <RedesignIcon name="close" className="size-4" />
              </button>
            </header>

            <SourceTabs
              panelId={PANEL_ID}
              activeSource={activeSource}
              onSourceChange={(nextSource) => {
                setSource(nextSource);
                fileNameTouchedRef.current = false;
                setFileName("");
                setResolved(null);
                setQuality("best");
                setError(null);
                clearPreview();
                setLastAnalyzedUrl("");
              }}
            />

            <main id={PANEL_ID} className={styles.content} role="tabpanel" aria-labelledby={sourceTabId(activeSource)}>
              <AddTaskForm
                activeSource={activeSource}
                sourceUrl={sourceUrl}
                fileName={fileName}
                quality={quality}
                codecPolicy={codecPolicy}
                downloadFolder={downloadFolder}
                start={start}
                end={end}
                ranges={ranges}
                downloadChatEnabled={downloadChatEnabled}
                sponsorBlurEnabled={extraSettingsVisible && sponsorBlurEnabled}
                fetchrMuteEnabled={fetchrMuteEnabled}
                unmuteVideoEnabled={unmuteVideoEnabled}
                analyzing={analyzing}
                error={error}
                resolved={resolved}
                previewUrl={previewUrl}
                previewEmbedUrl={previewEmbedUrl}
                previewLoading={previewLoading}
                previewError={previewError}
                sourceLabel={sourceLabel}
                qualityOptions={qualityOptions}
                m3u8VideoOnly={m3u8VideoOnly}
                chatPresets={chatPresets.map((preset) => ({ id: preset.id, name: preset.name }))}
                activeChatPresetId={activeChatPreset?.id ?? ""}
                sponsorBlurPresets={sponsorPresets.map((preset) => ({ id: preset.id, name: preset.name }))}
                activeSponsorPresetId={activeSponsorPreset?.id ?? ""}
                onSourceUrlChange={(value) => {
                  const trimmed = value.trim();
                  const detected = detectPlatform(trimmed);
                  const expected = getExpectedPlatform(activeSource);
                  if (detected !== "unknown" && activeSource !== "local" && detected !== expected) {
                    const nextSource = normalizeSource(detected);
                    setSource(nextSource);
                    setSourceUrls((items) => ({ ...items, [activeSource]: "", [nextSource]: value }));
                  } else {
                    setSourceUrlForActive(value);
                  }
                  const urlStart = parseUrlStartTime(trimmed);
                  if (urlStart && (!start || start === "00:00:00")) {
                    setStart(formatHms(urlStart));
                  }
                  fileNameTouchedRef.current = false;
                  setFileName("");
                  setResolved(null);
                  setError(null);
                  clearPreview();
                }}
                onOpenChannelVods={() => {
                  const targetUrl = sourceUrl.trim();
                  onClose();
                  if (targetUrl) useUI.getState().openDownloadWith(targetUrl);
                  else useUI.getState().openDownload();
                }}
                onOpenLiveRecorder={() => {
                  onClose();
                  void navigate({ to: "/live-recorder" });
                }}
                onFileNameChange={(value) => {
                  fileNameTouchedRef.current = Boolean(value.trim());
                  setFileName(value);
                }}
                onQualityChange={setQuality}
                onDownloadFolderChange={setDownloadFolder}
                onChooseFolder={() => void chooseFolder((directory) => {
                  setDownloadFolder(directory);
                  settings.setDirectory(directory);
                })}
                onAnalyze={() => void analyze()}
                onDownloadChatChange={setDownloadChatEnabled}
                onChatPresetChange={setActiveChatPreset}
                onSponsorBlurChange={setSponsorBlurEnabled}
                onSponsorPresetChange={setActiveSponsorPreset}
                onConfigureBlur={onConfigureBlur ?? (() => undefined)}
                onFetchrMuteChange={setFetchrMuteEnabled}
                onUnmuteVideoChange={setUnmuteVideoEnabled}
                onChooseLocalFile={() => void chooseLocalFile()}
                onStartChange={setStart}
                onEndChange={setEnd}
                onAddRange={() => {
                  setRanges((items) => [...items, { id: crypto.randomUUID(), start, end }]);
                  setStart("");
                  setEnd("");
                }}
                onUpdateRange={(id, patch) =>
                  setRanges((items) => items.map((item) => (item.id === id ? { ...item, ...patch } : item)))
                }
                onRemoveRange={(id) => setRanges((items) => items.filter((item) => item.id !== id))}
              />
            </main>

             <footer className={styles.footer}>
              {submitHint && !submitting && (
                <p id={SUBMIT_HINT_ID} className={styles.footerHint} role="status">
                  {submitHint}
                </p>
              )}
              <div className={styles.footerActions}>
                <button className={styles.button} type="button" onClick={onClose}>
                  {t("add.cancel", "Отмена")}
                </button>
                <button
                  ref={submitRef}
                  className={styles.primaryButton}
                  type="button"
                  onClick={() => void submit()}
                  disabled={submitBlocker !== null || submitting}
                  aria-describedby={submitHint && !submitting ? SUBMIT_HINT_ID : undefined}
                  aria-busy={submitting}>
                  <RedesignIcon name={submitting ? "loading" : "download"} className={submitting ? "size-4 animate-spin" : "size-4"} />
                  {t("add.download", "Скачать")}
                </button>
              </div>
            </footer>
      </div>
    </div>
  );

  function resetAfterSubmit() {
    resetDraft();
  }

  function resetDraft() {
    setSource("twitch");
    setSourceUrls(createEmptySourceUrls());
    fileNameTouchedRef.current = false;
    setFileName("");
    setQuality(runtime.quality || "best");
    setDownloadFolder(runtime.directory || settings.directory);
    setStart("");
    setEnd("");
    setRanges([]);
    setDownloadChatEnabled(Boolean(runtime.downloadChat));
    setSponsorBlurEnabled(Boolean(runtime.blurSponsors));
    setUnmuteVideoEnabled(Boolean(runtime.unmuteVideo));
    setFetchrMuteEnabled(false);
    setResolved(null);
    setError(null);
    clearPreview();
    setLastAnalyzedUrl("");
  }

  function setSourceUrlForActive(value: string) {
    setSourceUrls((items) => ({ ...items, [activeSource]: value }));
  }

  function clearPreview() {
    stopPreviewSession(previewSource);
    setPreviewUrl(null);
    setPreviewEmbedUrl(null);
    setPreviewSource(null);
    setPreviewLoading(false);
    setPreviewError(null);
  }

  async function loadPreview(result: ResolvedStream, urlToAnalyze?: string) {
    const targetUrl = (urlToAnalyze ?? sourceUrl).trim();
    clearPreview();
    setPreviewLoading(true);
    setPreviewError(null);
    try {
      if (result.platform === "youtube") {
        const embed = youtubeEmbedUrl(targetUrl);
        if (embed) {
          setPreviewEmbedUrl(embed);
          return;
        }
      }
      const preview = await ipc.startStreamPreview(
        targetUrl,
        { enabled: runtime.useProxy, url: runtime.proxyUrl || settings.proxy.url },
        settings.binariesDir,
        quality !== "best" ? quality : null,
      );
      setPreviewSource(preview);
      setPreviewUrl(preview.url);
    } catch (reason) {
      setPreviewError(String(reason));
    } finally {
      setPreviewLoading(false);
    }
  }
}

type SubmitBlocker = "url" | "folder" | "analyzing" | "unchecked";

/** Первая причина, по которой «Скачать» пока неактивна; null — можно жать. */
function getSubmitBlocker(state: {
  hasUrl: boolean;
  local: boolean;
  hasFolder: boolean;
  analyzing: boolean;
  resolved: boolean;
}): SubmitBlocker | null {
  if (!state.hasUrl) return "url";
  if (state.local) return null;
  if (!state.hasFolder) return "folder";
  if (state.resolved) return null;
  return state.analyzing ? "analyzing" : "unchecked";
}

function stopPreviewSession(previewSource: PreviewSource | null) {
  if (previewSource?.id) {
    void ipc.stopStreamPreview(previewSource.id).catch(() => undefined);
  }
}

async function chooseFolder(onSelected: (value: string) => void) {
  const directory = await ipc.chooseDirectory();
  if (directory) onSelected(directory);
}


function normalizeSourceId(source?: string): AddTaskSource | undefined {
  const valid: AddTaskSource[] = ["twitch", "youtube", "kick", "wtv", "m3u8", "rtmp", "local"];
  return source && (valid as string[]).includes(source) ? (source as AddTaskSource) : undefined;
}

function normalizeSource(platform: string): AddTaskSource {
  if (platform === "youtube") return "youtube";
  if (platform === "kick") return "kick";
  if (platform === "wtv") return "wtv";
  if (platform === "hls") return "m3u8";
  if (platform === "rtmp") return "rtmp";
  return "twitch";
}

function getSourceLabel(source: AddTaskSource): string {
  switch (source) {
    case "youtube":
      return "YouTube";
    case "kick":
      return "Kick";
    case "wtv":
      return "W.TV";
    case "m3u8":
      return "HLS / m3u8";
    case "rtmp":
      return "RTMP";
    case "twitch":
      return "Twitch";
    case "local":
      return "Локальный файл";
  }
}

function twitchVodChatSourceUrl(input: string): string | null {
  const trimmed = input.trim();
  return /(?:^https?:\/\/)?(?:www\.)?twitch\.tv\/(?:videos|video|v)\/\d+/i.test(trimmed) ? trimmed : null;
}

function isTwitchVodUrl(input: string): boolean {
  return twitchVodChatSourceUrl(input) != null;
}

function createEmptySourceUrls(): Record<AddTaskSource, string> {
  return {
    twitch: "",
    youtube: "",
    kick: "",
    wtv: "",
    m3u8: "",
    rtmp: "",
    local: "",
  };
}

function hasNonZeroTime(value: string): boolean {
  const sec = parseTimeInput(value);
  return sec !== null && sec > 0;
}

function hasRangeInput(start: string, end: string): boolean {
  return hasNonZeroTime(start) || hasNonZeroTime(end);
}

function getExpectedPlatform(source: AddTaskSource): Platform {
  switch (source) {
    case "twitch":
      return "twitch";
    case "youtube":
      return "youtube";
    case "kick":
      return "kick";
    case "wtv":
      return "wtv";
    case "m3u8":
      return "hls";
    case "rtmp":
      return "rtmp";
    default:
      return "unknown";
  }
}
