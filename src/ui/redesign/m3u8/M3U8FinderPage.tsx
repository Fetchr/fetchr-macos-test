import { useEffect, useMemo, useState, useRef } from "react";
import { listen } from "@tauri-apps/api/event";

import { usePersistedState } from "@/hooks/usePersistedState";
import { ipc } from "@/lib/ipc";
import { useUI } from "@/stores/ui";
import type { TwitchPublicVod, TwitchPublicVodPage } from "@/services/m3u8/m3u8DiscoveryTypes";
import { recoverM3u8FromTrackerMeta } from "@/services/m3u8/m3u8RecoveryService";
import { discoverTrackerMetadata } from "@/services/m3u8/trackerDiscoveryService";
import { fetchPublicTwitchVods } from "@/services/twitch/twitchVodService";
import { defaultPerformanceSettings, useSettings } from "@/stores/settings";
import { useWorkflowPresets } from "@/stores/workflowPresets";
import type { JobSpec, TwitchStreamsPage } from "@/types/job";
import { fetchrThemeClassName } from "@/ui/redesign/theme";
import { cn } from "@/lib/utils";
import { RedesignIcon } from "@/ui/redesign/icons/iconMap";

import { type M3U8AnalysisStats } from "./M3U8AnalysisStatus";
import styles from "./M3U8FinderPage.module.css";
import { M3U8RecoveredResultsTable } from "./M3U8RecoveredResultsTable";
import { M3U8SearchParamsCard } from "./M3U8SearchParamsCard";
import { PublicVodSearchPanel } from "./PublicVodSearchPanel";
import {
  addGeneration,
  removeGeneration,
  sanitizeHistory,
  type RecoveredGeneration,
} from "./recoveredHistory";
import {
  SOURCE_PROGRESS_EVENT,
  applySourceStage,
  settleSources,
  startSources,
  type SourceProgressEvent,
  type StreamSourceState,
} from "./sourceProgress";
import { TrackerFallbackPanel } from "./TrackerFallbackPanel";
import { buildStreamRows } from "@/services/m3u8/streamRows";
import { VodResultsTable, type FinderStreamRow } from "./VodResultsTable";

const PENDING_VOD_SEARCH_KEY = "fetchr:m3u8:pendingVodSearch";

function M3U8FinderPageContent({ activePresetId }: { activePresetId: string | null }) {
  const settings = useSettings();
  const openAddDialogWith = useUI((state) => state.openAddDialogWith);
  const m3u8Presets = useWorkflowPresets((state) => state.m3u8Presets);
  const createM3u8Preset = useWorkflowPresets((state) => state.createM3u8Preset);
  const updateM3u8Preset = useWorkflowPresets((state) => state.updateM3u8Preset);
  const rememberM3u8Streamer = useWorkflowPresets((state) => state.rememberM3u8Streamer);
  const deleteM3u8Preset = useWorkflowPresets((state) => state.deleteM3u8Preset);
  const activeM3u8Preset = m3u8Presets.find((preset) => preset.id === activePresetId) ?? null;

  const suffix = activePresetId ? `:${activePresetId}` : ":default";

  const [publicVodLogin, setPublicVodLogin] = usePersistedState(`fetchr-draft:m3u8:publicVodLogin${suffix}`, "");
  const [publicVodLoading, setPublicVodLoading] = useState(false);
  const [publicVodError, setPublicVodError] = useState<string | null>(null);
  // Fetch results are NOT persisted: a 100-item VOD page per preset would blow
  // the localStorage quota. Only input drafts use usePersistedState.
  const [publicVodPage, setPublicVodPage] = useState<TwitchPublicVodPage | null>(null);
  const [publicVodLoadingMore, setPublicVodLoadingMore] = useState(false);
  const [trackerStreamsPage, setTrackerStreamsPage] = useState<TwitchStreamsPage | null>(null);
  const [trackerStreamsError, setTrackerStreamsError] = useState<string | null>(null);
  const [streamListLoading, setStreamListLoading] = useState(false);
  const [streamPage, setStreamPage] = usePersistedState(`fetchr-draft:m3u8:streamPage${suffix}`, 1);
  const [copiedStreamId, setCopiedStreamId] = useState<string | null>(null);
  const [queuedStreamId, setQueuedStreamId] = useState<string | null>(null);
  const [generatingStreamId, setGeneratingStreamId] = useState<string | null>(null);

  const [trackerUrl, setTrackerUrl] = usePersistedState(`fetchr-draft:m3u8:trackerUrl${suffix}`, "");
  const [trackerLoading, setTrackerLoading] = useState(false);
  const [trackerError, setTrackerError] = useState<string | null>(null);
  const [username, setUsername] = usePersistedState(`fetchr-draft:m3u8:username${suffix}`, "");
  const [streamId, setStreamId] = usePersistedState(`fetchr-draft:m3u8:streamId${suffix}`, "");
  const [startTime, setStartTime] = usePersistedState(`fetchr-draft:m3u8:startTime${suffix}`, "");
  const [candidates, setCandidates] = usePersistedState<string[]>(`fetchr-draft:m3u8:candidates${suffix}`, []);

  const [recoveredLoading, setRecoveredLoading] = useState(false);
  const [recoveredError, setRecoveredError] = useState<string | null>(null);
  // Every successful run is kept (small: a few URLs each), so an earlier
  // stream's playlists survive the next search.
  const [storedHistory, setRecoveredHistory] = usePersistedState<RecoveredGeneration[]>(
    `fetchr-draft:m3u8:recoveredHistory${suffix}`,
    [],
  );
  const recoveredHistory = useMemo(() => sanitizeHistory(storedHistory), [storedHistory]);
  const [lastRecoveredCount, setLastRecoveredCount] = useState(0);
  const [copiedRecoveredUrl, setCopiedRecoveredUrl] = useState<string | null>(null);
  const [previewRecoveredUrl, setPreviewRecoveredUrl] = useState<string | null>(null);
  const [streamSources, setStreamSources] = useState<StreamSourceState[]>([]);
  const [checkedCandidates, setCheckedCandidates] = useState(0);
  const [queuedRecoveredUrl, setQueuedRecoveredUrl] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  // Inline preset rename (window.prompt is unavailable in the Tauri webview).
  const [renamingPresetId, setRenamingPresetId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const commitRename = () => {
    const name = renameDraft.trim();
    if (renamingPresetId && name) updateM3u8Preset(renamingPresetId, { name });
    setRenamingPresetId(null);
  };

  // Dynamic pageSize logic
  const [pageSize, setPageSize] = useState(10);
  const tableContainerRef = useRef<HTMLDivElement>(null);

  // Race/unmount guards for async loads (see loadPublicVods / loadStreamPage).
  const mountedRef = useRef(true);
  const listRequestSeq = useRef(0);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Backend reports which tracker site it is asking; only a running lookup listens.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;
    void listen<SourceProgressEvent>(SOURCE_PROGRESS_EVENT, ({ payload }) => {
      setStreamSources((prev) =>
        prev.length === 0 ? prev : applySourceStage(prev, payload.source, payload.stage, payload.detail),
      );
    })
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  // One-time cleanup: heavy fetch results used to be persisted per preset and
  // could eat the whole localStorage quota. They are in-memory only now.
  useEffect(() => {
    try {
      const doomed: string[] = [];
      for (let i = 0; i < window.localStorage.length; i += 1) {
        const key = window.localStorage.key(i);
        if (key && /^fetchr-draft:m3u8:(publicVodPage|trackerStreamsPage|recoveredRows|checkedCandidates)/.test(key)) {
          doomed.push(key);
        }
      }
      doomed.forEach((key) => window.localStorage.removeItem(key));
    } catch {
      /* ignore */
    }
  }, []);

  // Debounced: resizing the window must not fire a network refetch per pixel.
  useEffect(() => {
    if (!tableContainerRef.current) return;
    let timer: number | undefined;
    const observer = new ResizeObserver((entries) => {
      const height = entries[0]?.contentRect.height;
      if (height == null) return;
      // Available height excluding header (42px) and footer pagination (42px)
      const rowHeight = 48;
      const availableHeight = height - 42 - 42;
      const computedPageSize = Math.max(3, Math.floor(availableHeight / rowHeight));
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        setPageSize((prev) => (prev === computedPageSize ? prev : computedPageSize));
      }, 250);
    });
    observer.observe(tableContainerRef.current);
    return () => {
      observer.disconnect();
      window.clearTimeout(timer);
    };
  }, []);

  const handleLoginChange = (value: string) => {
    // Only update the draft field. Preset creation happens on explicit search
    // (loadPublicVods), not on every keystroke — creating it here remounts the
    // whole page (key={activePresetId}) and makes the input lose focus.
    setPublicVodLogin(value);
  };

  useEffect(() => {
    if (!activeM3u8Preset) return;
    setPublicVodLogin(activeM3u8Preset.streamer);
    setUsername(activeM3u8Preset.streamer);
  }, [activeM3u8Preset?.id]);

  // After auto-creating a preset on first search, the page remounts with the new
  // preset id; pick up the deferred search here.
  useEffect(() => {
    if (!activePresetId) return;
    let pending: { presetId: string; login: string } | null = null;
    try {
      const raw = window.sessionStorage.getItem(PENDING_VOD_SEARCH_KEY);
      if (raw) pending = JSON.parse(raw) as { presetId: string; login: string };
    } catch {
      return;
    }
    if (!pending || pending.presetId !== activePresetId) return;
    try {
      window.sessionStorage.removeItem(PENDING_VOD_SEARCH_KEY);
    } catch {
      /* ignore */
    }
    void loadPublicVods(pending.login);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePresetId]);

  useEffect(() => {
    let cancelled = false;
    const value = trackerUrl.trim();
    if (!value) return;

    void (async () => {
      try {
        const hint = await ipc.twitchParseUrl(value);
        if (cancelled) return;
        // Fill only empty fields; never overwrite what the user typed.
        if (hint.username) setUsername((prev) => prev || hint.username!);
        if (hint.stream_id) setStreamId((prev) => prev || hint.stream_id!);
      } catch {
        /* best effort hint only */
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [trackerUrl]);

  const streamRows = useMemo(
    () => buildStreamRows(trackerStreamsPage, publicVodPage, pageSize, streamPage),
    [publicVodPage, trackerStreamsPage, pageSize, streamPage],
  );

  const loadPublicVods = async (loginOverride?: string) => {
    const login = (loginOverride ?? publicVodLogin).trim().replace(/^@/, "");
    if (!login) {
      setPublicVodError("Введите ник Twitch-стримера.");
      setPublicVodPage(null);
      setTrackerStreamsPage(null);
      return;
    }

    // First search without an active preset: create one named after the login.
    // Creating a preset changes the page key and remounts this component, so the
    // actual search is deferred to the pending-search effect after remount.
    if (!activePresetId) {
      const id = createM3u8Preset(null);
      updateM3u8Preset(id, { name: login, streamer: login });
      try {
        window.localStorage.setItem(`fetchr-draft:m3u8:publicVodLogin:${id}`, JSON.stringify(login));
        window.sessionStorage.setItem(PENDING_VOD_SEARCH_KEY, JSON.stringify({ presetId: id, login }));
      } catch {
        /* storage may be unavailable; the search can be repeated manually */
      }
      return;
    }

    const seq = ++listRequestSeq.current;
    setPublicVodLoading(true);
    setPublicVodError(null);
    setTrackerStreamsError(null);
    setActionError(null);
    setStreamSources(startSources(true));
    const markTwitch = (ok: boolean, detail: string | null = null) => {
      if (mountedRef.current && seq === listRequestSeq.current) {
        setStreamSources((prev) => applySourceStage(prev, "twitch", ok ? "done" : "failed", detail));
      }
    };
    try {
      const [publicResult, trackerResult] = await Promise.allSettled([
        fetchPublicTwitchVods({ login, first: 100, cursor: null, proxy: settings.proxy }).then(
          (page) => {
            markTwitch(true);
            return page;
          },
          (error: unknown) => {
            markTwitch(false, String(error));
            throw error;
          },
        ),
        ipc.twitchTrackerStreams({ username: login, page: 1, page_size: pageSize }),
      ]);

      // A newer search/pagination superseded this one, or the page remounted.
      if (!mountedRef.current || seq !== listRequestSeq.current) return;

      if (publicResult.status === "fulfilled") {
        const resolvedLogin = publicResult.value.broadcaster.login;
        setPublicVodPage(publicResult.value);
        setPublicVodLogin(resolvedLogin);
        // Updates streamer + history, but never renames an existing preset.
        rememberM3u8Streamer(activePresetId, resolvedLogin);
      } else {
        // Without Twitch's answer every tracker row would look like a hidden
        // stream (no preview, m3u8 only), so show no list rather than a wrong one.
        setPublicVodError(
          `Twitch не ответил, список не показан: без него у стримов нет превью и прямых ссылок. Нажмите «Загрузить VOD» ещё раз. (${String(publicResult.reason)})`,
        );
        setPublicVodPage(null);
        setTrackerStreamsPage(null);
        setStreamPage(1);
        return;
      }

      if (trackerResult.status === "fulfilled") {
        setTrackerStreamsPage(trackerResult.value);
        setStreamPage(trackerResult.value.page);
        setUsername(trackerResult.value.username);
      } else {
        setTrackerStreamsError(String(trackerResult.reason));
        setTrackerStreamsPage(null);
        setStreamPage(1);
      }
    } finally {
      if (mountedRef.current && seq === listRequestSeq.current) {
        setPublicVodLoading(false);
        setStreamSources((prev) => settleSources(prev));
      }
    }
  };

  const loadStreamPage = async (page: number) => {
    const login = (trackerStreamsPage?.username || publicVodLogin).trim().replace(/^@/, "");
    if (!login || page < 1) return;
    const seq = ++listRequestSeq.current;
    // Separate spinner: paginating the tracker list must not block the search button.
    setStreamListLoading(true);
    setTrackerStreamsError(null);
    setStreamSources(startSources(false));
    try {
      const data = await ipc.twitchTrackerStreams({ username: login, page, page_size: pageSize });
      if (!mountedRef.current || seq !== listRequestSeq.current) return;
      setTrackerStreamsPage(data);
      setStreamPage(data.page);
      setUsername(data.username);
    } catch (error) {
      if (mountedRef.current && seq === listRequestSeq.current) {
        setTrackerStreamsError(String(error));
      }
    } finally {
      if (mountedRef.current && seq === listRequestSeq.current) {
        setStreamListLoading(false);
        setStreamSources((prev) => settleSources(prev));
      }
    }
  };

  // Load the next page of public VODs (Twitch cursor pagination) and append.
  const loadMorePublicVods = async () => {
    const current = publicVodPage;
    if (!current?.hasNextPage || !current.cursor || publicVodLoadingMore) return;
    setPublicVodLoadingMore(true);
    try {
      const next = await fetchPublicTwitchVods({
        login: current.broadcaster.login,
        first: 100,
        cursor: current.cursor,
        proxy: settings.proxy,
      });
      if (!mountedRef.current) return;
      setPublicVodPage((prev) =>
        prev && prev.broadcaster.id === next.broadcaster.id
          ? { ...next, items: [...prev.items, ...next.items] }
          : next,
      );
    } catch (error) {
      if (mountedRef.current) setPublicVodError(String(error));
    } finally {
      if (mountedRef.current) setPublicVodLoadingMore(false);
    }
  };

  // Pagination: tracker mode fetches from the tracker API; when the tracker is
  // unavailable the public VOD list is paginated locally instead.
  const handlePageChange = (page: number) => {
    if (page < 1) return;
    if (trackerStreamsPage) {
      void loadStreamPage(page);
    } else {
      setStreamPage(page);
    }
  };

  // Re-fetch active page streams on page size changes (debounced; the initial
  // mount run is skipped — the observer settles pageSize right after mount and
  // would otherwise trigger a duplicate request on every page open).
  const pageSizeInitRef = useRef(true);
  useEffect(() => {
    if (pageSizeInitRef.current) {
      pageSizeInitRef.current = false;
      return;
    }
    const login = (trackerStreamsPage?.username || publicVodLogin).trim().replace(/^@/, "");
    if (!login || !trackerStreamsPage) return;
    const timer = window.setTimeout(() => void loadStreamPage(streamPage), 250);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageSize]);

  const copyPublicVodUrl = async (vod: TwitchPublicVod) => {
    try {
      await copyText(vod.url);
      setCopiedStreamId(`public:${vod.id}`);
      window.setTimeout(() => setCopiedStreamId(null), 1500);
      setActionError(null);
    } catch (error) {
      setActionError(`Не удалось скопировать Twitch URL: ${String(error)}`);
    }
  };

  const addPublicVodToQueue = async (vod: TwitchPublicVod) => {
    if (!vod.public) return;
    setActionError(null);
    const directory = await resolveQueueDirectory(settings.directory);
    const spec: JobSpec = {
      url: vod.url,
      chat_source_url: vod.url,
      name: vod.title || `twitch_vod_${vod.id}`,
      directory,
      job_kind: "video",
      mode: "vod",
      download_kind: "video",
      start: null,
      end: null,
      fragments: [],
      split: false,
      split_interval_minutes: null,
      quality: null,
      quality_has_audio: null,
      quality_has_video: null,
      unmute_video: false,
      proxy: settings.proxy,
      chat_overlay: { ...settings.chatOverlay, enabled: false },
      performance: settings.performance ?? defaultPerformanceSettings,
      blur_zones: [],
      binaries_dir: settings.binariesDir,
      meta: {
        platform: "twitch",
        title: vod.title,
        uploader: publicVodLogin || username || null,
        thumbnail: vod.thumbnailUrl,
        duration: vod.durationSeconds,
      },
    };
    // Open the Add Task dialog prefilled so the user can configure before download.
    openAddDialogWith({ url: spec.url, source: "twitch", name: spec.name });
    setQueuedStreamId(`public:${vod.id}`);
    window.setTimeout(() => setQueuedStreamId(null), 1500);
  };

  const copyRecoveredFromStream = async (row: FinderStreamRow) => {
    const url = await recoverFirstM3u8ForRow(row);
    if (!url) return;
    await copyText(url);
    setCopiedStreamId(row.id);
    window.setTimeout(() => setCopiedStreamId(null), 1500);
  };

  const addRecoveredStreamToQueue = async (row: FinderStreamRow) => {
    const url = await recoverFirstM3u8ForRow(row);
    if (!url) return;
    await addRecoveredToQueue(url, row);
    setQueuedStreamId(row.id);
    window.setTimeout(() => setQueuedStreamId(null), 1500);
  };

  const recoverFirstM3u8ForRow = async (row: FinderStreamRow): Promise<string | null> => {
    if (!row.streamId || !row.createdAt) {
      setActionError("Для recovered m3u8 нужен stream_id и время начала.");
      return null;
    }
    setGeneratingStreamId(row.id);
    setActionError(null);
    setRecoveredError(null);
    try {
      // row.createdAt is a UTC ISO string; the backend expects local time
      // (timezone: "local"), so convert before both display and recovery.
      const localStartTime = isoUtcToLocalInput(row.createdAt);
      setUsername(row.username);
      setStreamId(row.streamId);
      setStartTime(localStartTime);
      const recovered = await recoverM3u8FromTrackerMeta({
        username: row.username,
        streamId: row.streamId,
        startTime: localStartTime,
        title: row.title,
        thumbnailUrl: row.thumbnailUrl,
        candidates: [],
      });
      if (!mountedRef.current) return null;
      setCheckedCandidates(recovered.tried);
      const urls = recovered.urls.map((item) => item.url);
      rememberGeneration({
        username: row.username,
        streamId: row.streamId,
        startTime: localStartTime,
        title: row.title,
        thumbnailUrl: row.thumbnailUrl,
        duration: row.duration && row.duration !== "-" ? row.duration : null,
        urls,
      });
      if (!urls[0]) {
        setRecoveredError("Публично доступные recovered m3u8 не найдены.");
        return null;
      }
      return urls[0];
    } catch (error) {
      setRecoveredError(String(error));
      return null;
    } finally {
      setGeneratingStreamId(null);
    }
  };

  const pasteTrackerUrl = async () => {
    try {
      const text = await navigator.clipboard.readText();
      setTrackerUrl(text);
    } catch {
      /* clipboard may be unavailable */
    }
  };

  const fetchTrackerMetadata = async () => {
    if (!trackerUrl.trim()) return;
    setTrackerLoading(true);
    setTrackerError(null);
    setRecoveredError(null);
    try {
      const meta = await discoverTrackerMetadata({
        sourceUrl: trackerUrl,
        username,
        streamId,
        startTime,
      });
      if (meta.username) setUsername(meta.username);
      if (meta.streamId) setStreamId(meta.streamId);
      if (meta.startTime) setStartTime(isoUtcToLocalInput(meta.startTime));
      setCandidates((meta.candidates ?? []).map(isoUtcToLocalInput));
      if (!meta.startTime) {
        setTrackerError("Не удалось определить время начала. Заполните его вручную.");
      }
    } catch (error) {
      setTrackerError(String(error));
    } finally {
      setTrackerLoading(false);
    }
  };

  const findRecoveredM3u8 = async () => {
    if (!username.trim() || !streamId.trim() || !startTime.trim()) return;
    setRecoveredLoading(true);
    setRecoveredError(null);
    setLastRecoveredCount(0);
    setCheckedCandidates(0);
    try {
      // Start from the manually entered values — they're required above and make
      // recovery work even when the tracker sites are blocked by Cloudflare.
      let recoveryMeta = {
        username: username.trim(),
        streamId: streamId.trim(),
        startTime: startTime.trim(),
        title: null as string | null,
        thumbnailUrl: null as string | null,
        candidates: [] as string[],
      };

      // Tracker discovery is best-effort: it can enrich candidates / exact time,
      // but its failure (Cloudflare-protected sites) must NOT block recovery from
      // the manual values.
      try {
        const meta = await discoverTrackerMetadata({
          sourceUrl: trackerUrl.trim() || undefined,
          username: username.trim(),
          streamId: streamId.trim(),
          startTime: startTime.trim(),
        });
        // Tracker times come back as UTC ISO strings; the backend expects local
        // time (timezone: "local"), so convert once here instead of mixing zones.
        const localStartTime = meta.startTime ? isoUtcToLocalInput(meta.startTime) : null;
        const localCandidates = (meta.candidates ?? []).map(isoUtcToLocalInput);
        recoveryMeta = {
          ...recoveryMeta,
          username: meta.username ?? recoveryMeta.username,
          streamId: meta.streamId ?? recoveryMeta.streamId,
          startTime: localStartTime ?? recoveryMeta.startTime,
          candidates: localCandidates,
        };
        if (!mountedRef.current) return;
        if (recoveryMeta.username) setUsername(recoveryMeta.username);
        if (recoveryMeta.streamId) setStreamId(recoveryMeta.streamId);
        if (localStartTime && trackerUrl.trim()) setStartTime(localStartTime);
        if (localCandidates.length > 0) setCandidates(localCandidates);
      } catch {
        // Trackers unavailable (Cloudflare) — continue with manual values.
      }

      let recovered = await recoverM3u8FromTrackerMeta(recoveryMeta);
      if (!mountedRef.current) return;
      let triedTotal = recovered.tried;
      let foundStartTime = recoveryMeta.startTime;

      // Fallback: if the primary start time found nothing, walk through the
      // tracker-suggested candidate times until one yields a playlist.
      if (recovered.urls.length === 0 && recoveryMeta.candidates.length > 0) {
        for (const candidate of recoveryMeta.candidates) {
          if (candidate === recoveryMeta.startTime) continue;
          try {
            const retry = await recoverM3u8FromTrackerMeta({ ...recoveryMeta, startTime: candidate });
            triedTotal += retry.tried;
            if (retry.urls.length > 0) {
              recovered = retry;
              foundStartTime = candidate;
              // Show the time that actually worked.
              setStartTime(candidate);
              break;
            }
          } catch {
            /* try the next candidate */
          }
          if (!mountedRef.current) return;
        }
      }

      setCheckedCandidates(triedTotal);
      rememberGeneration({
        username: recoveryMeta.username,
        streamId: recoveryMeta.streamId,
        startTime: foundStartTime,
        title: recoveryMeta.title,
        thumbnailUrl: recoveryMeta.thumbnailUrl,
        duration: null,
        urls: recovered.urls.map((item) => item.url),
      });
      if (recovered.urls.length === 0) {
        setRecoveredError("Публично доступные recovered m3u8 не найдены.");
      }
    } catch (error) {
      setRecoveredError(String(error));
    } finally {
      setRecoveredLoading(false);
    }
  };

  const rememberGeneration = (generation: Omit<RecoveredGeneration, "id" | "foundAt">) => {
    setLastRecoveredCount(generation.urls.length);
    if (generation.urls.length === 0) return;
    const foundAt = Date.now();
    setRecoveredHistory((prev) =>
      addGeneration(sanitizeHistory(prev), { ...generation, id: `${generation.streamId}:${foundAt}`, foundAt }),
    );
  };

  const forgetGeneration = (id: string) => {
    const removed = recoveredHistory.find((item) => item.id === id);
    if (removed && previewRecoveredUrl && removed.urls.includes(previewRecoveredUrl)) {
      setPreviewRecoveredUrl(null);
    }
    setRecoveredHistory((prev) => removeGeneration(sanitizeHistory(prev), id));
  };

  const copyRecoveredUrl = async (url: string) => {
    try {
      await copyText(url);
      setCopiedRecoveredUrl(url);
      window.setTimeout(() => setCopiedRecoveredUrl((current) => (current === url ? null : current)), 1500);
      setActionError(null);
    } catch (error) {
      setActionError(`Не удалось скопировать m3u8 URL: ${String(error)}`);
    }
  };

  const addRecoveredToQueue = async (url: string, row?: RecoveredQueueSource) => {
    setActionError(null);
    const directory = await resolveQueueDirectory(settings.directory);
    const spec: JobSpec = {
      url,
      name: `${row?.username || username || "stream"}_${row?.streamId || streamId || Date.now()}`,
      directory,
      job_kind: "video",
      mode: "vod",
      download_kind: "video",
      start: null,
      end: null,
      fragments: [],
      split: false,
      split_interval_minutes: null,
      quality: null,
      quality_has_audio: null,
      quality_has_video: null,
      unmute_video: false,
      proxy: settings.proxy,
      chat_overlay: { ...settings.chatOverlay, enabled: false },
      performance: settings.performance ?? defaultPerformanceSettings,
      blur_zones: [],
      binaries_dir: settings.binariesDir,
      meta: {
        platform: "hls",
        title: row?.title || `${username} · ${streamId}`,
        uploader: row?.username || username || null,
        thumbnail: row?.thumbnailUrl ?? null,
      },
    };
    // Open the Add Task dialog prefilled so the user can configure before download.
    openAddDialogWith({ url: spec.url, source: "m3u8", name: spec.name });
    setQueuedRecoveredUrl(url);
    window.setTimeout(() => setQueuedRecoveredUrl(null), 1500);
  };

  const errorCount =
    Number(Boolean(publicVodError)) +
    Number(Boolean(trackerError)) +
    Number(Boolean(trackerStreamsError)) +
    Number(Boolean(recoveredError));
  const stats = useMemo<M3U8AnalysisStats>(
    () => ({
      publicVodCount: streamRows.length || publicVodPage?.items.length || 0,
      checkedCandidates,
      recoveredCount: lastRecoveredCount,
      queueReadyCount: streamRows.length + lastRecoveredCount,
      errorCount,
    }),
    [checkedCandidates, errorCount, publicVodPage?.items.length, lastRecoveredCount, streamRows.length],
  );

  return (
    <div className={`${fetchrThemeClassName} ${styles.studioPage}`}>
      <div className={styles.bookmarksBar}>
        <div className={styles.bookmarksList}>
          {m3u8Presets.map((preset) => {
            const active = preset.id === activePresetId;
            return (
              <div
                key={preset.id}
                className={cn(styles.bookmarkItem, active && styles.bookmarkItemActive)}
              >
                <button
                  type="button"
                  className={styles.bookmarkButton}
                  onClick={() => {
                    useWorkflowPresets.getState().setActiveM3u8Preset(preset.id);
                  }}
                  onDoubleClick={() => {
                    setRenamingPresetId(preset.id);
                    setRenameDraft(preset.name);
                  }}
                  title="Двойной клик для переименования"
                >
                  <RedesignIcon name="finder" className="size-3" />
                  {renamingPresetId === preset.id ? (
                    // Inline rename: window.prompt is unsupported in WebView2/Tauri.
                    <input
                      className={styles.input}
                      style={{ minWidth: 0, width: 110, height: 20, padding: "0 4px", fontSize: 11 }}
                      value={renameDraft}
                      autoFocus
                      onFocus={(e) => e.target.select()}
                      onChange={(e) => setRenameDraft(e.target.value)}
                      onClick={(e) => e.stopPropagation()}
                      onDoubleClick={(e) => e.stopPropagation()}
                      onKeyDown={(e) => {
                        e.stopPropagation();
                        if (e.key === "Enter") commitRename();
                        if (e.key === "Escape") setRenamingPresetId(null);
                      }}
                      onBlur={commitRename}
                    />
                  ) : (
                    <span>{preset.name}</span>
                  )}
                </button>
                <button
                  type="button"
                  className={styles.bookmarkDeleteButton}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (window.confirm(`Удалить пресет "${preset.name}"?`)) {
                      deleteM3u8Preset(preset.id);
                    }
                  }}
                  title="Удалить пресет"
                >
                  <RedesignIcon name="close" className="size-2.5" />
                </button>
              </div>
            );
          })}
          <button
            type="button"
            className={styles.addBookmarkButton}
            onClick={() => {
              const id = createM3u8Preset(null);
              updateM3u8Preset(id, { name: "Новый канал", streamer: "" });
            }}
            title="Создать новый пресет"
          >
            <RedesignIcon name="add" className="size-3" />
            <span>Добавить</span>
          </button>
        </div>
      </div>

      <div className={styles.splitLayout}>
        {/* Left Column: Nickname + Stream List */}
        <div className={`${styles.leftColumn} ${styles.panel}`}>
          <PublicVodSearchPanel
            login={publicVodLogin}
            loading={publicVodLoading}
            error={publicVodError}
            page={publicVodPage}
            presetHistory={activeM3u8Preset?.history ?? []}
            onLoginChange={handleLoginChange}
            onSearch={() => void loadPublicVods()}
          />
          <div ref={tableContainerRef} style={{ flex: "1 1 0", minHeight: 0, display: "flex", flexDirection: "column" }}>
            <VodResultsTable
              page={publicVodPage}
              rows={streamRows}
              loading={publicVodLoading || streamListLoading}
              sources={streamSources}
              copiedId={copiedStreamId}
              queuedId={queuedStreamId}
              generatingId={generatingStreamId}
              streamPage={streamPage}
              totalStreams={trackerStreamsPage?.total ?? publicVodPage?.items.length ?? streamRows.length}
              pageSize={pageSize}
              trackerError={trackerStreamsError}
              canLoadMorePublic={Boolean(publicVodPage?.hasNextPage && publicVodPage?.cursor)}
              loadingMorePublic={publicVodLoadingMore}
              onLoadMorePublic={() => void loadMorePublicVods()}
              onCopyPublic={(vod) => void copyPublicVodUrl(vod)}
              onAddPublicToQueue={(vod) => void addPublicVodToQueue(vod)}
              onCopyRecovered={(row) => void copyRecoveredFromStream(row)}
              onAddRecoveredToQueue={(row) => void addRecoveredStreamToQueue(row)}
              onPageChange={handlePageChange}
            />
          </div>
        </div>

        {/* Right Column: Manual Generator + Results */}
        <div className={`${styles.rightColumn} ${styles.panel}`}>
          <TrackerFallbackPanel
            sourceUrl={trackerUrl}
            loading={trackerLoading}
            error={trackerError}
            onSourceUrlChange={setTrackerUrl}
            onPaste={() => void pasteTrackerUrl()}
            onFetchMetadata={() => void fetchTrackerMetadata()}
          />
          <M3U8SearchParamsCard
            username={username}
            streamId={streamId}
            startTime={startTime}
            candidates={candidates}
            loading={recoveredLoading}
            onUsernameChange={setUsername}
            onStreamIdChange={setStreamId}
            onStartTimeChange={setStartTime}
            onSearch={() => void findRecoveredM3u8()}
          />
          <div className={styles.recoveredResultsWrapper}>
            {actionError && <div className={styles.errorBox}>{actionError}</div>}
            {recoveredError && <div className={styles.errorBox}>{recoveredError}</div>}
            <M3U8RecoveredResultsTable
              generations={recoveredHistory}
              loading={recoveredLoading || Boolean(generatingStreamId)}
              queuedUrl={queuedRecoveredUrl}
              copiedUrl={copiedRecoveredUrl}
              previewUrl={previewRecoveredUrl}
              canRefresh={Boolean(username.trim() && streamId.trim() && startTime.trim())}
              onCopy={(url) => void copyRecoveredUrl(url)}
              onAddToQueue={(url, generation) => void addRecoveredToQueue(url, generation)}
              onPreview={setPreviewRecoveredUrl}
              onRemove={forgetGeneration}
              onRefresh={() => void findRecoveredM3u8()}
            />
          </div>
        </div>
      </div>

      {/* Status Footer */}
      <footer className={styles.studioFooter}>
        <span>
          Пресет: {activeM3u8Preset?.name ?? "без пресета"} · VODs: {stats.publicVodCount} · Recovered: {stats.recoveredCount}
        </span>
        <span>
          Проверено кандидатов: {stats.checkedCandidates}
        </span>
      </footer>
    </div>
  );
}

/** What the queue dialog needs to name a recovered download. */
interface RecoveredQueueSource {
  username: string;
  streamId: string | null;
  title: string | null;
  thumbnailUrl: string | null;
}

function isoUtcToLocalInput(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (value: number) => value.toString().padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

async function copyText(value: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }

  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  document.body.appendChild(textarea);
  textarea.select();
  try {
    if (!document.execCommand("copy")) {
      throw new Error("Clipboard command rejected");
    }
  } finally {
    document.body.removeChild(textarea);
  }
}

async function resolveQueueDirectory(current: string): Promise<string> {
  const directory = current.trim();
  if (directory) return directory;
  const fallback = await ipc.defaultDownloadDir();
  if (!fallback) {
    throw new Error("Не выбрана папка сохранения.");
  }
  return fallback;
}

export function M3U8FinderPage() {
  const activeM3u8PresetId = useWorkflowPresets((state) => state.activeM3u8PresetId);
  return <M3U8FinderPageContent key={activeM3u8PresetId ?? "default"} activePresetId={activeM3u8PresetId} />;
}
