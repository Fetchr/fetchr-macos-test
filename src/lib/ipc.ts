import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import type {
  BinaryReport,
  BlurZone,
  ChatOverlaySettings,
  FinderResult,
  Job,
  JobSpec,
  PerformanceSettings,
  PreviewSource,
  ProxyConfig,
  ResolvedStream,
  TrackerMeta,
  TwitchHint,
  TwitchStreamsPage,
  SystemFont,
  FetchrMuteSettings,
  AudioTrackInfo,
  MuteOutputTarget,
  WordHit,
  MuteSpan,
  HistoryItem,
  VocalRemoverHistoryItem,
  VocalRemoverResult,
  VocalRemoverSettings,
  CopyrightTimelineSegment,
  ChatFragment,
  ChatMessage,
  VideoCodecPolicy,
} from "@/types/job";

/** Фильтр диалога сохранения: подпись и расширения без точки. */
export interface SaveFileFilter {
  name: string;
  extensions: string[];
}

/** Что приложению разрешено отправлять на сервер. */
export interface PrivacySettings {
  statistics: boolean;
  error_reports: boolean;
  job_logs: boolean;
  notice_seen: boolean;
}

export interface HardwarePreset {
  cpu_logical_cores: number;
  gpu_names: string[];
  summary: string;
  performance: PerformanceSettings;
}

export interface LicensePayload {
  v: number;
  product: string;
  machine_id: string;
  name: string | null;
  note: string | null;
  issued_at: string;
}

export interface LicenseStatus {
  state: "missing" | "active" | "invalid";
  machine_id: string;
  license: LicensePayload | null;
  runtime_config?: {
    product: string;
    channel: string;
    features: string[];
    lease_expires_at: string | null;
  } | null;
  message: string | null;
}

export interface BetaActivationLink {
  machine_id: string;
  telegram_url: string | null;
  start_parameter: string;
  configured: boolean;
  message: string | null;
}

export interface UpdatePage {
  category: string | null;
  title: string;
  items: string[];
  media: string | null;
}

export interface UpdateStatus {
  configured: boolean;
  available: boolean;
  /** Бэкенд примет этот манифест на этой платформе — только тогда запуск ставит сам */
  installable: boolean;
  current_version: string;
  version: string | null;
  notes: string | null;
  notes_i18n: Record<string, string> | null;
  /** Страницы окна «Что нового» по языкам; нет — окно собирает их из notes. */
  pages_i18n?: Record<string, UpdatePage[]> | null;
  installer_url: string | null;
  installer_sha256: string | null;
  size_bytes: number | null;
  published_at: string | null;
  message: string | null;
}

/** Tick of `install_update`: download, then checksum, then the silent install. */
export interface UpdateProgress {
  phase: "download" | "verify" | "install";
  received: number;
  total: number | null;
  bytes_per_second: number;
}

/** Rejection text of installUpdate when the user cancelled the download. */
export const UPDATE_CANCELLED = "update-cancelled";

/** MIME type the backend used to send along with image bytes. */
export function imageMimeFromPath(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase();
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "webp") return "image/webp";
  if (ext === "gif") return "image/gif";
  return "image/png";
}

export interface VpsConfig {
  host: string;
  ssh_port: number;
  user: string;
  agent_port: number;
  token: string;
  host_key_fingerprint: string;
  key_path: string | null;
  /** Legacy override for an agent published behind https by hand. */
  base_url: string;
}

export interface VpsCredentials {
  host: string;
  port: number;
  user: string;
  /** Password, or — when keyPath is set — the private key's passphrase. */
  password: string;
  /** Private key to log in with, for servers that refuse password auth. */
  keyPath?: string | null;
}

export interface VpsPreflightReport {
  host_key_fingerprint: string;
  os: string;
  arch: string;
  has_systemd: boolean;
  has_python: boolean;
  has_ffmpeg: boolean;
  has_streamlink: boolean;
  disk_total: number;
  disk_free: number;
  missing: string[];
  auth_methods: string[];
  password_auth: boolean;
  key_auth: boolean;
}

/** What the server accepts for login, probed without sending a secret. */
export interface VpsAuthMethods {
  host_key_fingerprint: string;
  server_version: string;
  methods: string[];
  password: boolean;
  key: boolean;
}

export interface VpsProvisionReport {
  token: string;
  agent_port: number;
  host_key_fingerprint: string;
  loopback_only: boolean;
  log: string[];
}

export interface VpsTunnelState {
  phase: "disconnected" | "connecting" | "online";
  local_port: number | null;
  error: string | null;
  since: number | null;
}

export interface VpsRecordingInfo {
  session: string;
  channel: string;
  title?: string | null;
  started_at: number;
  position: number;
  duration: number;
  available_start: number;
  segments: number;
  video_size: number;
  chat_messages: number;
  status: string;
}

export interface VpsTarget {
  channel: string;
  title?: string | null;
  enabled?: boolean;
  created_at?: number | null;
}

export interface VpsStatus {
  /** Newest target/recording. Kept for callers that address just one; the
   *  plural fields below are the whole picture. */
  target_channel: string | null;
  targets?: VpsTarget[];
  recordings?: VpsRecordingInfo[];
  max_channels?: number;
  watch?: {
    channel: string;
    title?: string | null;
    enabled: boolean;
    mode: "watch";
    created_at: number;
  } | null;
  recording: VpsRecordingInfo | null;
  disk: {
    total: number;
    free: number;
    buffer_used?: number;
    /** How large the ring buffer is allowed to grow right now. */
    buffer_budget?: number;
    reserve?: number;
    bytes_per_sec?: number;
    retention_hours?: number | null;
    buffered_hours?: number | null;
  };
  clips_count: number;
  recordings_count?: number;
  schedules_count?: number;
  /** Paid plan the agent enforces. Absent on a self-hosted server with no plan. */
  subscription?: VpsSubscription | null;
}

/** The Archive VPS bought on fetchr.fun, kept apart from the own VPS. */
export interface VpsManagedState {
  available: boolean;
  active: boolean;
}

export interface VpsSubscription {
  /** Id from the plan list in `ui/redesign/vps-recorder/plans.ts`. */
  plan: string;
  /** Stacked +10 GB add-on packs. */
  packs?: number;
  /** Epoch seconds the paid period ends. */
  paid_until?: number | null;
  /** True when the server is Fetchr's own rather than the user's VPS. */
  managed?: boolean;
}

export interface VpsMarker {
  id: string;
  timestamp: number;
  label: string;
  note: string | null;
  created_at: number;
}

export interface VpsRecordingMeta {
  session: string;
  channel: string | null;
  title: string | null;
  schedule_id?: string | null;
  source_mode?: "watch" | "schedule" | null;
  started_at: number;
  ended_at: number | null;
  duration: number;
  available_start: number;
  segments: number;
  video_size: number;
  chat_messages: number;
  status: "connecting" | "recording" | "reconnecting" | "completed" | "interrupted" | string;
  available: boolean;
  markers: VpsMarker[];
  /** Stretches of the timeline lost to reconnects. */
  gaps?: VpsGap[];
  /** How many times the recorder reconnected during this session. */
  runs?: number;
  media_removed_at?: number | null;
}

export interface VpsGap {
  start: number;
  end: number;
}

/** Chat shapes are shared with the renderer — one definition, in types/job. */
export type VpsChatFragment = ChatFragment;
export type VpsChatMessage = ChatMessage;

/** Loudness envelope of a slice of a recording, 0..255 per bin. */
/** Сведения об опознанном треке из каталога обложек. */
export interface TrackArtwork {
  title: string;
  artist: string;
  album: string | null;
  year: string | null;
  artwork_url: string | null;
}

export interface VpsPeaks {
  start: number;
  end: number;
  bins: number;
  rate?: number;
  /** How far the server has finished analysing, in session seconds. */
  ready_until?: number;
  values: number[];
}

export interface VpsSchedule {
  id: string;
  channel: string;
  title: string | null;
  start_at: number;
  end_at: number | null;
  wait_until: number;
  enabled: boolean;
  status: "scheduled" | "connecting" | "waiting_online" | "completed" | "cancelled" | "expired" | string;
  created_at: number;
  updated_at: number;
  last_session: string | null;
}

export interface VpsClipMeta {
  id: string;
  channel: string | null;
  session: string | null;
  label: string | null;
  note?: string | null;
  tags?: string[];
  start: number;
  end: number;
  duration: number;
  created_at: number;
  video_size: number;
  chat_messages: number;
  recording_started_at?: number | null;
  absolute_start_at?: number | null;
  /** Pinned clips survive disk rotation. */
  keep?: boolean;
  accurate?: boolean;
  /** Re-encoded because the range crossed a reconnect. */
  crosses_gap?: boolean;
}

export interface VpsClipProcessingOptions {
  chatOverlay?: ChatOverlaySettings | null;
  performance?: PerformanceSettings | null;
  blurZones?: BlurZone[];
  fetchrMuteEnabled?: boolean;
  fetchrMuteSettings?: FetchrMuteSettings | null;
}

export const ipc = {
  // Resolve
  resolveStream: (
    url: string,
    proxy: ProxyConfig,
    binariesDir: string | null,
    twitchAuthToken?: string | null,
    codecPolicy?: VideoCodecPolicy | null,
  ) =>
    invoke<ResolvedStream>("resolve_stream", {
      url,
      proxy,
      binariesDir,
      twitchAuthToken: twitchAuthToken ?? null,
      codecPolicy: codecPolicy ?? null,
    }),
  probeDuration: (path: string, binariesDir: string | null) =>
    invoke<number | null>("probe_duration", { path, binariesDir }),

  // Queue
  enqueueJob: (spec: JobSpec) => invoke<Job>("enqueue_job", { spec }),
  startQueue: (maxConcurrent?: number | null) =>
    invoke<void>("start_queue", { maxConcurrent: maxConcurrent ?? null }),
  pauseQueue: () => invoke<void>("pause_queue"),
  cancelJob: (id: string) => invoke<void>("cancel_job", { id }),
  setQueueConcurrency: (maxConcurrent: number) =>
    invoke<void>("set_queue_concurrency", { maxConcurrent }),
  restartJob: (id: string, maxConcurrent?: number | null) =>
    invoke<boolean>("restart_job", { id, maxConcurrent: maxConcurrent ?? null }),
  removeJob: (id: string) => invoke<boolean>("remove_job", { id }),
  jobLogText: (id: string) => invoke<string | null>("job_log_text", { id }),
  moveJob: (id: string, direction: "up" | "down") =>
    invoke<boolean>("move_job", { id, direction }),
  setJobPriority: (id: string, priority: number) =>
    invoke<boolean>("set_job_priority", { id, priority }),
  listJobs: () => invoke<Job[]>("list_jobs"),
  clearCompleted: () => invoke<void>("clear_completed"),

  // VPS recorder
  vpsGetConfig: () => invoke<VpsConfig>("vps_get_config"),
  vpsSetConfig: (config: VpsConfig) => invoke<void>("vps_set_config", { config }),
  vpsStatus: () => invoke<VpsStatus>("vps_status"),
  vpsRecordingsList: () => invoke<VpsRecordingMeta[]>("vps_recordings_list"),
  vpsSchedulesList: () => invoke<VpsSchedule[]>("vps_schedules_list"),
  vpsScheduleCreate: (channel: string, title: string | null, startAt: number, endAt: number | null) =>
    invoke<VpsSchedule>("vps_schedule_create", { channel, title, startAt, endAt }),
  vpsScheduleDelete: (scheduleId: string) => invoke<void>("vps_schedule_delete", { scheduleId }),
  vpsRecordingPreviewUrl: (session: string) => invoke<string>("vps_recording_preview_url", { session }),
  vpsClipPreviewUrl: (clipId: string) => invoke<string>("vps_clip_preview_url", { clipId }),
  vpsRecordingPosterUrl: (session: string, at: number) =>
    invoke<string>("vps_recording_poster_url", { session, at }),
  vpsClipPosterUrl: (clipId: string) => invoke<string>("vps_clip_poster_url", { clipId }),
  vpsClipSetKeep: (clipId: string, keep: boolean) =>
    invoke<VpsClipMeta>("vps_clip_set_keep", { clipId, keep }),
  vpsRecordingPeaks: (session: string, start: number, end: number, bins: number) =>
    invoke<VpsPeaks>("vps_recording_peaks", { session, start, end, bins }),
  /** `channel` lets the backend load that channel's BTTV/FFZ/7TV emote sets;
   *  `proxy` is the fallback route when those APIs are blocked. */
  vpsRecordingChat: (session: string, channel: string | null, proxy?: ProxyConfig | null) =>
    invoke<VpsChatMessage[]>("vps_recording_chat", { session, channel, proxy: proxy ?? null }),
  /** Code → emote map for a channel, used by the live chat relay. */
  vpsChannelEmotes: (channel: string, proxy?: ProxyConfig | null) =>
    invoke<Record<string, VpsChatFragment>>("vps_channel_emotes", {
      channel,
      proxy: proxy ?? null,
    }),
  vpsRecordingDelete: (session: string) => invoke<number>("vps_recording_delete", { session }),
  vpsMarkerAdd: (session: string, timestamp: number, label: string, note: string | null) =>
    invoke<VpsMarker>("vps_marker_add", { session, timestamp, label, note }),
  vpsMarkerDelete: (session: string, markerId: string) =>
    invoke<void>("vps_marker_delete", { session, markerId }),
  vpsSessionStart: (channel: string, title?: string | null) =>
    invoke<string>("vps_session_start", { channel, title: title ?? null }),
  vpsSessionStop: (channel?: string | null) =>
    invoke<void>("vps_session_stop", { channel: channel ?? null }),
  vpsClipCreate: (
    session: string,
    start: number,
    end: number,
    label: string | null,
    note: string | null,
    tags: string[],
    accurate: boolean,
  ) => invoke<VpsClipMeta>("vps_clip_create", { session, start, end, label, note, tags, accurate }),
  vpsClipsList: () => invoke<VpsClipMeta[]>("vps_clips_list"),
  vpsClipDelete: (clipId: string) => invoke<void>("vps_clip_delete", { clipId }),
  vpsBufferClear: (withClips: boolean) => invoke<number>("vps_buffer_clear", { withClips }),
  vpsDownloadClip: (
    clipId: string,
    name: string,
    directory: string,
    channel: string | null,
    duration: number | null,
    processing: VpsClipProcessingOptions = {},
  ) => invoke<Job>("vps_download_clip", {
    clipId,
    session: null,
    name,
    directory,
    channel,
    duration,
    chatOverlay: processing.chatOverlay ?? null,
    performance: processing.performance ?? null,
    blurZones: processing.blurZones ?? [],
    fetchrMuteEnabled: processing.fetchrMuteEnabled ?? false,
    fetchrMuteSettings: processing.fetchrMuteSettings ?? null,
  }),
  /** Pull a whole session: its segments are fetched and muxed locally, so the
   *  VPS never has to hold a second copy of the recording. */
  vpsDownloadRecording: (
    session: string,
    name: string,
    directory: string,
    channel: string | null,
    duration: number | null,
    processing: VpsClipProcessingOptions = {},
  ) => invoke<Job>("vps_download_clip", {
    clipId: "",
    session,
    name,
    directory,
    channel,
    duration,
    chatOverlay: processing.chatOverlay ?? null,
    performance: processing.performance ?? null,
    blurZones: processing.blurZones ?? [],
    fetchrMuteEnabled: processing.fetchrMuteEnabled ?? false,
    fetchrMuteSettings: processing.fetchrMuteSettings ?? null,
  }),
  vpsUnlockStatus: () => invoke<boolean>("vps_unlock_status"),
  vpsUnlock: (password: string) => invoke<boolean>("vps_unlock", { password }),
  vpsAuthMethods: (host: string, port: number, user: string) =>
    invoke<VpsAuthMethods>("vps_auth_methods", { host, port, user }),
  vpsPreflight: (credentials: VpsCredentials) =>
    invoke<VpsPreflightReport>("vps_preflight", { credentials }),
  vpsProvision: (credentials: VpsCredentials, agentPort?: number) =>
    invoke<VpsProvisionReport>("vps_provision", { credentials, agentPort: agentPort ?? null }),
  vpsConnect: () => invoke<VpsTunnelState>("vps_connect"),
  /** Attach the Archive VPS bought on fetchr.fun; `activate` makes it the shown source. */
  vpsManagedConnect: (activate: boolean) => invoke<VpsManagedState>("vps_managed_connect", { activate }),
  vpsManagedState: () => invoke<VpsManagedState>("vps_managed_state"),
  /** Show the Fetchr archive (true) or the own VPS (false). Never touches the own VPS tunnel. */
  vpsManagedSelect: (active: boolean) => invoke<VpsManagedState>("vps_managed_select", { active }),
  vpsManagedProbe: () => invoke<void>("vps_managed_probe"),
  vpsManagedForget: () => invoke<VpsManagedState>("vps_managed_forget"),
  vpsDisconnect: () => invoke<VpsTunnelState>("vps_disconnect"),
  vpsTunnelState: () => invoke<VpsTunnelState>("vps_tunnel_state"),
  vpsForget: () => invoke<void>("vps_forget"),

  // FS
  openFolder: (path: string) => invoke<void>("open_folder", { path }),
  revealFile: (path: string) => invoke<void>("reveal_file", { path }),
  defaultDownloadDir: () => invoke<string>("default_download_dir"),
  chooseDirectory: () => invoke<string | null>("choose_directory"),
  chooseImageFile: () => invoke<string | null>("choose_image_file"),
  chooseMediaFile: () => invoke<string | null>("choose_media_file"),
  chooseMediaFiles: () => invoke<string[]>("choose_media_files"),
  mediaFileSizes: (paths: string[]) => invoke<(number | null)[]>("media_file_sizes", { paths }),
  chooseJsonFile: () => invoke<string | null>("choose_json_file"),
  pathsExist: (paths: string[]) => invoke<boolean[]>("mute_paths_exist", { paths }),
  readChatMessagesPreview: (path: string) => invoke<ChatMessage[]>("read_chat_messages_preview", { path }),
  readImageFile: (path: string) => invoke<ArrayBuffer>("read_image_file", { path }),
  readLinkFile: (path: string) => invoke<string>("read_link_file", { path }),
  /** `filter` — подпись и расширения (без точки) для диалога; без него — txt/jsonl/log. */
  saveTextFileDialog: (defaultName: string, contents: string, filter?: SaveFileFilter) =>
    invoke<string | null>("save_text_file_dialog", { defaultName, contents, filter: filter ?? null }),
  saveImageDialog: (defaultName: string, dataUrl: string) =>
    invoke<string | null>("save_image_dialog", { defaultName, dataUrl }),

  // Binaries
  detectBinaries: (overrideDir: string | null) =>
    invoke<BinaryReport[]>("detect_binaries", { overrideDir }),
  listSystemFonts: () => invoke<SystemFont[]>("list_system_fonts"),
  detectHardwarePreset: () => invoke<HardwarePreset>("detect_hardware_preset"),
  reportClientError: (kind: string, message: string, stack: string | null) =>
    invoke<void>("report_client_error", { kind, message, stack }),
  getPrivacySettings: () => invoke<PrivacySettings>("get_privacy_settings"),
  trackScreen: (screen: string) => invoke<void>("track_screen", { screen }),
  setPrivacySettings: (settings: PrivacySettings) => invoke<PrivacySettings>("set_privacy_settings", { settings }),
  getMachineId: () => invoke<string>("get_machine_id"),
  betaActivationLink: () => invoke<BetaActivationLink>("beta_activation_link"),
  licenseStatus: () => invoke<LicenseStatus>("license_status"),
  activateLicense: (key: string) => invoke<LicenseStatus>("activate_license", { key }),
  resetLicense: () => invoke<LicenseStatus>("reset_license"),
  checkForUpdate: () => invoke<UpdateStatus>("check_for_update"),
  installUpdate: (attempt: number) => invoke<void>("install_update", { attempt }),
  cancelUpdate: (attempt: number) => invoke<void>("cancel_update", { attempt }),
  setupComponentsStatus: () => invoke<SetupComponentStatus[]>("setup_components_status"),
  setupInstallComponent: (component: string) =>
    invoke<void>("setup_install_component", { component }),

  proxiedHlsUrl: (url: string, referer?: string | null) =>
    invoke<string>("proxied_hls_url", { url, referer: referer ?? null }),
  startStreamPreview: (
    url: string,
    proxy: ProxyConfig,
    binariesDir: string | null,
    quality: string | null,
    twitchAuthToken?: string | null,
  ) =>
    invoke<PreviewSource>("start_stream_preview", {
      url,
      proxy,
      binariesDir,
      quality,
      twitchAuthToken: twitchAuthToken ?? null,
    }),
  stopStreamPreview: (id: string) =>
    invoke<void>("stop_stream_preview", { id }),
  capturePreviewFrame: (req: {
    url: string;
    timeSec: number;
    outputWidth?: number | null;
    outputHeight?: number | null;
    quality?: string | null;
    proxy: ProxyConfig;
    binariesDir: string | null;
    twitchAuthToken?: string | null;
  }) =>
    invoke<{ path: string; url: string; time_sec: number; width: number; height: number }>(
      "capture_preview_frame",
      {
        url: req.url,
        timeSec: req.timeSec,
        outputWidth: req.outputWidth ?? null,
        outputHeight: req.outputHeight ?? null,
        quality: req.quality ?? null,
        proxy: req.proxy,
        binariesDir: req.binariesDir,
        twitchAuthToken: req.twitchAuthToken ?? null,
      },
    ),
  chatRenderLogAction: (action: string, input?: unknown) =>
    invoke<void>("chat_render_log_action", { action, input: input ?? null }),
  trackSponsorZone: (req: {
    url: string;
    referenceFramePath: string;
    zone: BlurZone;
    taskId?: string;
    startTimeSec: number;
    durationSec?: number | null;
    sampleIntervalSec: number;
    confidenceThreshold: number;
    /** "hybrid" = VitTrack + ZNCC (default), "correlation" = ZNCC only. */
    engine?: SponsorTrackerEngine;
    /** Internal analysis resolution in px; lower is faster. */
    analysisWidth?: number;
    useGpu?: boolean;
    hwaccel?: boolean;
    /** Keep the box at the size drawn by the user. */
    lockSize?: boolean;
    redetectAfterSec?: number;
    giveUpSec?: number;
    outputWidth?: number;
    outputHeight?: number;
    quality?: string | null;
    proxy: ProxyConfig;
    binariesDir?: string | null;
    twitchAuthToken?: string | null;
  }) =>
    invoke<SponsorTrackResult>("track_sponsor_zone", {
      req: {
        url: req.url,
        reference_frame_path: req.referenceFramePath,
        zone: req.zone,
        task_id: req.taskId ?? null,
        start_time_sec: req.startTimeSec,
        duration_sec: req.durationSec ?? null,
        sample_interval_sec: req.sampleIntervalSec,
        confidence_threshold: req.confidenceThreshold,
        engine: req.engine ?? "hybrid",
        analysis_width: req.analysisWidth ?? 960,
        use_gpu: req.useGpu ?? true,
        hwaccel: req.hwaccel ?? false,
        lock_size: req.lockSize ?? true,
        redetect_after_sec: req.redetectAfterSec ?? 1,
        give_up_sec: req.giveUpSec ?? 30,
        output_width: req.outputWidth ?? 1920,
        output_height: req.outputHeight ?? 1080,
        quality: req.quality ?? null,
        proxy: req.proxy,
        binaries_dir: req.binariesDir ?? null,
        twitch_auth_token: req.twitchAuthToken ?? null,
      },
    }),
  cancelSponsorTracker: (taskId: string) =>
    invoke<void>("cancel_sponsor_tracker", { taskId }),
  captureTimelineThumbnails: (req: {
    url: string;
    durationSec: number;
    count?: number;
    tileWidth?: number;
    taskId?: string;
    quality?: string | null;
    proxy: ProxyConfig;
    binariesDir?: string | null;
    twitchAuthToken?: string | null;
  }) =>
    invoke<SponsorTimelineThumbnails>("capture_timeline_thumbnails", {
      req: {
        url: req.url,
        duration_sec: req.durationSec,
        count: req.count ?? 48,
        tile_width: req.tileWidth ?? 160,
        task_id: req.taskId ?? null,
        quality: req.quality ?? null,
        proxy: req.proxy,
        binaries_dir: req.binariesDir ?? null,
        twitch_auth_token: req.twitchAuthToken ?? null,
      },
    }),
  cancelTimelineThumbnails: (taskId: string) =>
    invoke<void>("cancel_timeline_thumbnails", { taskId }),

  twitchValidateAuthToken: (token: string, proxy?: ProxyConfig | null) =>
    invoke<{ login: string | null; expires_in: number | null }>("twitch_validate_auth_token", { token, proxy: proxy ?? null }),

  // Twitch m3u8 helpers
  twitchParseUrl: (url: string) =>
    invoke<TwitchHint>("twitch_parse_url", { url }),
  twitchTrackerFetch: (url: string) =>
    invoke<TrackerMeta>("twitch_tracker_fetch", { url }),
  twitchTrackerStreams: (req: {
    username: string;
    page?: number | null;
    page_size?: number | null;
  }) => invoke<TwitchStreamsPage>("twitch_tracker_streams", { req }),
  twitchFindM3u8: (req: {
    username: string;
    stream_id: string;
    start_time: string;
    timezone?: string | null;
    window?: number | null;
  }) => invoke<FinderResult>("twitch_find_m3u8", { req }),
  twitchExtractBrowserToken: (browser: string, binariesDir?: string | null) =>
    invoke<string>("twitch_extract_browser_token", {
      browser,
      binariesDir: binariesDir ?? null,
    }),
  chooseCookiesFile: () => invoke<string | null>("choose_cookies_file"),
  chooseSshKeyFile: () => invoke<string | null>("choose_ssh_key_file"),
  twitchExtractTokenFromCookiesFile: (path: string) =>
    invoke<string>("twitch_extract_token_from_cookies_file", { path }),

  // Fetchr Mute in-page commands
  runMuteInPage: (
    taskId: string,
    inputPath: string,
    binariesDir: string | null,
    settings: FetchrMuteSettings,
    forceReanalysis?: boolean,
    outputTarget?: MuteOutputTarget | null,
  ) =>
    invoke<{ output_path: string; words: WordHit[]; spans: MuteSpan[] }>("run_mute_in_page", {
      taskId,
      inputPath,
      binariesDir,
      settings,
      forceReanalysis: forceReanalysis ?? false,
      outputTarget: outputTarget ?? null,
    }),
  recensorInPage: (
    taskId: string,
    inputPath: string,
    binariesDir: string | null,
    words: WordHit[],
    settings: FetchrMuteSettings,
    manualSpans?: MuteSpan[],
    excludedSpans?: MuteSpan[],
    outputTarget?: MuteOutputTarget | null,
  ) =>
    invoke<{ output_path: string; spans: MuteSpan[] }>("recensor_in_page", {
      taskId,
      inputPath,
      binariesDir,
      words,
      settings,
      manualSpans: manualSpans ?? null,
      excludedSpans: excludedSpans ?? null,
      outputTarget: outputTarget ?? null,
    }),
  cancelMuteInPage: (taskId: string) =>
    invoke<void>("cancel_mute_in_page", { taskId }),
  probeMuteAudioTracks: (inputPath: string, binariesDir: string | null) =>
    invoke<AudioTrackInfo[]>("probe_mute_audio_tracks", { inputPath, binariesDir }),
  /** Настоящая волна звука файла: `bins` значений 0..1 по всей длине. */
  lookupTrackArtwork: (query: string) => invoke<TrackArtwork | null>("lookup_track_artwork", { query }),
  audioWaveformPeaks: (inputPath: string, bins: number, binariesDir: string | null) =>
    invoke<number[]>("audio_waveform_peaks", { inputPath, bins, binariesDir }),
  getMuteHistory: () =>
    invoke<HistoryItem[]>("get_mute_history"),
  getMuteHistoryWords: (id: string) =>
    invoke<WordHit[]>("get_mute_history_words", { id }),
  deleteMuteHistoryItem: (id: string) =>
    invoke<void>("delete_mute_history_item", { id }),
  mutePathsExist: (paths: string[]) =>
    invoke<boolean[]>("mute_paths_exist", { paths }),
  getMuteRecognitionVersion: () =>
    invoke<number>("mute_recognition_version"),
  suggestMuteWords: (words: string[], machineId: string) =>
    invoke<void>("suggest_mute_words", { words, machineId }),

  // Vocal Remover in-page commands
  runVocalRemoverInPage: (
    taskId: string,
    inputPath: string,
    binariesDir: string | null,
    settings: VocalRemoverSettings,
  ) =>
    invoke<VocalRemoverResult>("run_vocal_remover_in_page", {
      taskId,
      inputPath,
      binariesDir,
      settings,
    }),
  cancelVocalRemoverInPage: (taskId: string) =>
    invoke<void>("cancel_vocal_remover_in_page", { taskId }),
  getVocalRemoverHistory: () =>
    invoke<VocalRemoverHistoryItem[]>("get_vocal_remover_history"),
  deleteVocalRemoverHistoryItem: (id: string) =>
    invoke<void>("delete_vocal_remover_history_item", { id }),
  splitLiveRecording: (
    id: string,
    fetchrMuteEnabled: boolean,
    sponsorBlurEnabled: boolean,
    vocalRemoverEnabled: boolean,
    recordChatSeparate: boolean,
    startTimeSec: number | null,
    endTimeSec: number | null,
    label: string | null = null,
  ) =>
    invoke<string>("split_live_recording", {
      id,
      fetchrMuteEnabled,
      sponsorBlurEnabled,
      vocalRemoverEnabled,
      recordChatSeparate,
      startTimeSec,
      endTimeSec,
      label,
    }),
  prepareRecordingReview: (id: string) =>
    invoke<string>("prepare_recording_review", { id }),
  getDiskFreeSpace: (path: string) =>
    invoke<number>("get_disk_free_space", { path }),
  stopAndProcessLiveRecording: (
    id: string,
    fetchrMuteEnabled: boolean,
    sponsorBlurEnabled: boolean,
    vocalRemoverEnabled: boolean,
    recordChatSeparate: boolean,
  ) =>
    invoke<string>("stop_and_process_live_recording", {
      id,
      fetchrMuteEnabled,
      sponsorBlurEnabled,
      vocalRemoverEnabled,
      recordChatSeparate,
    }),

  // Copyright Detector
  scanVideoForCopyright: (taskId: string, inputPath: string, binariesDir: string | null) =>
    invoke<CopyrightTimelineSegment[]>("scan_video_for_copyright", {
      taskId,
      inputPath,
      binariesDir,
    }),
  cancelCopyrightScan: (taskId: string) =>
    invoke<void>("cancel_copyright_scan", { taskId }),
};

/** Subscribe to queue state snapshots emitted by the Rust backend. */
export function onQueueChanged(
  cb: (jobs: Job[]) => void,
): Promise<UnlistenFn> {
  return listen<Job[]>("queue:changed", (event) => cb(event.payload));
}

/** Queue paused flag: true after `pause_queue`, false once the queue is resumed. */
export function onQueuePaused(cb: (paused: boolean) => void): Promise<UnlistenFn> {
  return listen<boolean>("queue:paused", (event) => cb(event.payload));
}

/** One job's progress, throttled by the backend (see `queue:changed` for the rest). */
export interface JobProgressUpdate {
  id: string;
  progress: Job["progress"];
  live_stats: Job["live_stats"];
}

export function onQueueProgress(
  cb: (update: JobProgressUpdate) => void,
): Promise<UnlistenFn> {
  return listen<JobProgressUpdate>("queue:progress", (event) => cb(event.payload));
}

export interface LogLine {
  id: string;
  line: string;
  ts: number;
}

/** Subscribe to raw log lines from every running job. */
export function onJobLog(
  cb: (log: LogLine) => void,
): Promise<UnlistenFn> {
  return listen<LogLine>("job:log", (event) => cb(event.payload));
}

export interface InPageProgressPayload {
  percent: number;
  message: string;
  taskId?: string;
}

/** Готовность компонента для мастера первого запуска */
export interface SetupComponentStatus {
  id: string;
  ready: boolean;
}

/** Subscribe to first-run component install progress (taskId = `setup_<component>`). */
export function onSetupProgress(cb: (payload: InPageProgressPayload) => void): Promise<UnlistenFn> {
  return listen<InPageProgressPayload>("setup:progress", (event) => cb(event.payload));
}

/** Subscribe to installer download and install progress. */
export function onUpdateProgress(cb: (payload: UpdateProgress) => void): Promise<UnlistenFn> {
  return listen<UpdateProgress>("update:progress", (event) => cb(event.payload));
}

/** Subscribe to in-page Fetchr Mute progress updates. */
export function onFetchrMuteProgress(
  cb: (payload: InPageProgressPayload) => void,
): Promise<UnlistenFn> {
  return listen<InPageProgressPayload>("fetchr_mute:progress", (event) => cb(event.payload));
}

/** Subscribe to in-page Vocal Remover progress updates. */
export function onVocalRemoverProgress(
  cb: (payload: InPageProgressPayload) => void,
): Promise<UnlistenFn> {
  return listen<InPageProgressPayload>("vocal_remover:progress", (event) => cb(event.payload));
}

/** Subscribe to in-page sponsor tracker progress updates. */
export function onSponsorTrackerProgress(
  cb: (payload: InPageProgressPayload) => void,
): Promise<UnlistenFn> {
  return listen<InPageProgressPayload>("sponsor_tracker:progress", (event) => cb(event.payload));
}

/** Tracking backend: neural VitTrack with ZNCC verification, or ZNCC alone. */
export type SponsorTrackerEngine = "hybrid" | "correlation";

/** Filmstrip for the timeline: one sprite holding `count` tiles in a row. */
export interface SponsorTimelineThumbnails {
  path: string;
  count: number;
  tile_width: number;
  tile_height: number;
  /** Timestamp at the centre of each tile. */
  times: number[];
  cached: boolean;
}

/** Subscribe to filmstrip build progress. */
export function onSponsorTimelineProgress(
  cb: (payload: InPageProgressPayload) => void,
): Promise<UnlistenFn> {
  return listen<InPageProgressPayload>("sponsor_timeline:progress", (event) => cb(event.payload));
}

export interface SponsorTrackResult {
  keyframes: NonNullable<BlurZone["tracking"]>["keyframes"];
  analyzed_frames: number;
  matched_frames: number;
  min_confidence: number;
  max_confidence: number;
  end_time_sec: number;
  truncated: boolean;
  /** Engine that actually ran, e.g. "vittrack+zncc". */
  engine: string;
  /** "gpu" when a hardware execution provider accepted the graph. */
  device: string;
  /** Times the banner had to be re-acquired with a full-frame search. */
  redetections: number;
  /** `[start, end]` ranges where the banner was not visible. */
  gaps: [number, number][];
  /** Frames analysed per wall-clock second. */
  analysis_fps: number;
}
