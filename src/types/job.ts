export type JobStatus =
  | "queued"
  | "running"
  | "paused"
  | "done"
  | "error"
  | "cancelled";

export type Mode = "vod" | "live";
export type JobKind = "video" | "chat" | "fetchrmute" | "vpsdownload";
export type DownloadKind = "video" | "audio";
export type VideoCodecPolicy = "compatible" | "best";
export type AudioFormat = "m4a" | "opus" | "mp3";
export type FetchrMuteLanguage = "ru" | "en";
export type FetchrMuteProcessingMode = "normal" | "precise";
export type FetchrMuteAsrModel = "gigaam_v3_rnnt_int8";
export type FetchrMuteCensorshipLevel = "soft" | "standard" | "strict" | "maximum";
export type FetchrMuteCensorMethod = "beep" | "mute" | "custom";
export type FetchrMuteProfile = "reference" | "classic" | "sealed" | "adaptive";
export type VocalRemoverMode = "fast_htdemucs" | "studio_htdemucs_ft" | "ultra_melband";
export type VocalRemoverWorkflow = "stems" | "anti_copyright";
export type ChatOverlayMode = "transparent_overlay" | "direct_render";
export type AlphaOutputFormat =
  | "mov_png"
  | "mov_qtrle"
  | "webm_vp9"
  | "webm_vp8"
  | "ffv1_mkv"
  | "prores_4444"
  | "lagarith_avi";
export type ChatComposeMode = "direct" | "intermediate";

export type ChatRenderQuality = "standard" | "high" | "ultra";
export type ChatMessageAnimation = "none" | "fade" | "slide_up" | "slide_left" | "pop";
export type ChatFontStyle = "normal" | "italic" | "oblique";
export type ChatRenderCodec =
  | "raw_rgba_pipe"
  | "ffv1_mkv_alpha"
  | "qtrle_mov_rle"
  | "prores_4444"
  | "vp9_webm_alpha"
  | "lagarith_avi"
  | "solid_bg_fast";
export type FinalRenderMode = "full" | "blur_only" | "chat_only" | "separate_chat";
export type PerformanceProfile = "auto" | "maximum" | "turbo" | "custom";
export type GpuEncoderMode = "auto" | "intel_xe_qsv" | "nvenc" | "qsv" | "amf" | "vulkan" | "cpu";
export type BlurEffect = "mosaic" | "gaussian_blur" | "image_overlay";
export type ImageFit = "contain" | "cover" | "stretch";
export type BlurShape = "rectangle" | "ellipse";
export type BlurQuality = "fast" | "balanced" | "high";
export type ScreenshotSource = "player" | "ffmpeg";

export interface ProxyConfig {
  enabled: boolean;
  url: string;
}

export interface JobMeta {
  title?: string | null;
  uploader?: string | null;
  platform?: string | null;
  thumbnail?: string | null;
  duration?: number | null;
  output_path?: string | null;
}

export interface TimeFragment {
  start: string;
  end: string;
}

export interface FetchrMuteSettings {
  language: FetchrMuteLanguage;
  mode: FetchrMuteProcessingMode;
  asr_model: FetchrMuteAsrModel;
  censorship_level: FetchrMuteCensorshipLevel;
  censor_method: FetchrMuteCensorMethod;
  mute_profile: FetchrMuteProfile;
  coverage_percent: number;
  fade_out_ms: number;
  fade_in_ms: number;
  min_mute_ms: number;
  custom_words: string[];
  whitelist_words: string[];
  only_custom_words: boolean;
  smooth_mute: boolean;
  custom_sound_path?: string | null;
  /** Индекс аудиодорожки источника (0 = первая). null — первая. */
  audio_track_index?: number | null;
}

/** Аудиодорожка исходного файла (ffprobe). */
export interface AudioTrackInfo {
  index: number;
  codec: string;
  channels: number;
  sample_rate: number;
  language?: string | null;
  title?: string | null;
  is_default: boolean;
}

/** Куда сохранять результат («Сохранить как»). */
export interface MuteOutputTarget {
  directory?: string | null;
  file_name?: string | null;
}

export interface VocalRemoverSettings {
  mode: VocalRemoverMode;
  workflow?: VocalRemoverWorkflow;
  custom_segments?: VocalRemoverAudioSegment[];
}

export interface ChatOverlaySettings {
  enabled?: boolean | null;
  mode?: ChatOverlayMode | null;
  output_width?: number | null;
  output_height?: number | null;
  fps?: number | null;
  chat_x?: number | null;
  chat_y?: number | null;
  chat_width?: number | null;
  chat_height?: number | null;
  font_family?: string | null;
  font_weight?: number | null;
  font_style?: ChatFontStyle | null;
  username_font_weight?: number | null;
  username_font_style?: ChatFontStyle | null;
  font_size?: number | null;
  text_color?: string | null;
  outline_enabled?: boolean | null;
  outline_color?: string | null;
  outline_thickness?: number | null;
  background_enabled?: boolean | null;
  background_opacity?: number | null;
  /** Frosted-glass look: blur the video region behind the chat background. */
  background_blur_enabled?: boolean | null;
  show_badges?: boolean | null;
  show_timestamps?: boolean | null;
  show_avatars?: boolean | null;
  show_bttv?: boolean | null;
  show_ffz?: boolean | null;
  show_7tv?: boolean | null;
  max_visible_messages?: number | null;
  message_lifetime_sec?: number | null;
  direction?: "bottom-up" | "top-down" | null;
  alpha_output_format?: AlphaOutputFormat | null;
  chat_overlay_fps?: number | null;
  save_alpha_overlay?: boolean | null;
  save_clean_video?: boolean | null;
  compose_mode?: ChatComposeMode | null;
  render_codec?: ChatRenderCodec | null;
  final_render_mode?: FinalRenderMode | null;
  solid_background_color?: string | null;
  render_quality?: ChatRenderQuality | null;
  /** Chat-only jobs: download/write chat JSON and skip rendering. */
  json_only?: boolean | null;
  /** How a new message enters the overlay. */
  message_animation?: ChatMessageAnimation | null;
  message_animation_ms?: number | null;
}

export interface PerformanceSettings {
  profile: PerformanceProfile;
  network_concurrent_fragments: number;
  cpu_threads: number | null;
  render_workers: number | null;
  gpu_encoder_mode: GpuEncoderMode;
  ffmpeg_preset: string | null;
}

export interface BlurZone {
  id: string;
  enabled: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
  effect: BlurEffect;
  intensity: number;
  image_path?: string | null;
  image_fit?: ImageFit | null;
  tracking?: BlurZoneTracking | null;
  shape?: BlurShape | null;
  edge_softness?: number | null;
  quality?: BlurQuality | null;
  opacity?: number | null;
}

export interface BlurZoneKeyframe {
  time_sec: number;
  x: number;
  y: number;
  width: number;
  height: number;
  confidence: number;
}

export interface BlurZoneTracking {
  enabled: boolean;
  start_time_sec: number;
  end_time_sec?: number | null;
  sample_interval_sec: number;
  search_radius: number;
  confidence_threshold: number;
  keyframes: BlurZoneKeyframe[];
  /** `[start, end]` spans where the tracker lost the banner. */
  gaps?: [number, number][];
}

export interface PreviewLayoutSettings {
  screenshot_source: ScreenshotSource;
  screenshot_time_sec: number | null;
  screenshot_path: string | null;
}

export interface VpsDownloadSpec {
  base_url: string;
  token: string;
  clip_id: string;
  include_chat: boolean;
}

export interface JobSpec {
  url: string;
  chat_source_url?: string | null;
  name: string;
  directory: string;
  job_kind?: JobKind | null;
  mode: Mode;
  download_kind?: DownloadKind | null;
  start?: string | null;
  end?: string | null;
  fragments?: TimeFragment[];
  split?: boolean;
  split_interval_minutes?: number | null;
  quality?: string | null;
  quality_has_audio?: boolean | null;
  quality_has_video?: boolean | null;
  quality_height?: number | null;
  video_codec_policy?: VideoCodecPolicy | null;
  audio_format?: AudioFormat | null;
  unmute_video?: boolean;
  proxy: ProxyConfig;
  chat_overlay?: ChatOverlaySettings | null;
  performance?: PerformanceSettings | null;
  blur_zones?: BlurZone[];
  binaries_dir?: string | null;
  fetchr_mute_enabled?: boolean;
  fetchr_mute_model?: string | null;
  fetchr_mute_settings?: FetchrMuteSettings | null;
  /** Папка результата FetchrMute над локальным файлом; нет — рядом с исходником. */
  fetchr_mute_output_dir?: string | null;
  vocal_remover_enabled?: boolean;
  vocal_remover_settings?: VocalRemoverSettings | null;
  record_chat_separate?: boolean;
  vps_download?: VpsDownloadSpec | null;
  meta?: JobMeta;
  twitch_auth_token?: string | null;
  /** Queue priority. Higher runs first (high=1, normal=0, low=-1). */
  priority?: number;
}

export interface JobProgress {
  percent: number;
  stage_percent?: number | null;
  stage_start?: number | null;
  stage_end?: number | null;
  stage_started_at?: number | null;
  download_elapsed_ms?: number | null;
  downloaded_bytes?: number | null;
  total_bytes?: number | null;
  speed_bps?: number | null;
  current_segment?: string | null;
  speed?: string | null;
  eta?: string | null;
  size?: string | null;
  message?: string | null;
}

/** Live-recording health: what is actually happening with the file on disk. */
export interface LiveStats {
  /** Real probed quality, e.g. "1080p60 · 1920×1080". */
  detected_quality?: string | null;
  /** Epoch ms when the recording file last grew. */
  last_data_at?: number | null;
  /** Current recording file size in bytes. */
  recorded_bytes?: number | null;
  /** True when no new data has been written for a while (network drop). */
  stalled?: boolean;
  /** Automatic recorder restarts after drops. */
  reconnects?: number;
  /** Real media duration of the recording file in seconds (probed by ffprobe),
   *  as opposed to wall-clock time since the job started. */
  media_duration_sec?: number | null;
}

export interface Job {
  id: string;
  spec: JobSpec;
  status: JobStatus;
  progress: JobProgress;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
  error: string | null;
  output_path?: string | null;
  live_stats?: LiveStats | null;
}

export interface TwitchHint {
  username: string | null;
  stream_id: string | null;
  source: string;
}

export interface FinderResult {
  urls: string[];
  tried: number;
  timestamp_utc: number;
}

export interface TrackerMeta {
  username: string | null;
  stream_id: string | null;
  start_time: string | null;
  title: string | null;
  thumbnail: string | null;
  candidates: string[];
}

export interface TwitchStreamListItem {
  date: string | null;
  start_time: string | null;
  title: string | null;
  duration_minutes: number | null;
  game: string | null;
  url: string | null;
  stream_id: string | null;
}

export interface TwitchStreamsPage {
  username: string;
  page: number;
  page_size: number;
  total: number;
  items: TwitchStreamListItem[];
}

export type CodecFamily = "h264" | "h265" | "vp9" | "av1" | "aac" | "opus" | "mp3" | "other";

export interface Quality {
  id: string;
  label: string;
  group?: "combined" | "video" | "audio" | null;
  height: number | null;
  fps: number | null;
  ext: string | null;
  has_audio: boolean;
  has_video: boolean;
  abr: number | null;
  /** Normalized video codec family, not the raw yt-dlp string. */
  vcodec: CodecFamily | null;
  /** Normalized audio codec family, not the raw yt-dlp string. */
  acodec: CodecFamily | null;
  /** Exact size when yt-dlp knows it, otherwise its estimate. */
  filesize: number | null;
  tbr: number | null;
  /** H.264 video with AAC (or no) audio — plays in Premiere Pro as-is. */
  compatible: boolean;
}

export interface ResolvedStream {
  platform: string;
  title: string | null;
  uploader: string | null;
  is_live: boolean;
  duration: number | null;
  qualities: Quality[];
  direct_url: string | null;
  thumbnail: string | null;
}

export interface PreviewSource {
  id: string | null;
  url: string;
  input_url: string;
  platform: string;
  transport: string;
  mode: string;
  message: string | null;
}

export interface BinaryReport {
  name: string;
  path: string | null;
  found: boolean;
}

export interface SystemFont {
  family: string;
  weights: number[];
  styles: ChatFontStyle[];
}

export interface WordHit {
  raw: string;
  normalized: string;
  start: number;
  end: number;
  confidence: number;
  /** Начальная форма из морфословаря; есть только у известных ему слов. */
  lemma?: string | null;
  /** Итог CTC-перепроверки сомнительного кандидата в мат. */
  verified?: boolean | null;
}

export interface MuteSpan {
  word: string;
  start: number;
  end: number;
}

export interface HistoryItem {
  id: string;
  fileName: string;
  filePath: string;
  outputPath: string;
  date: number;
  /** Транскрипция больше не приходит со списком истории (sidecar на бэкенде);
   *  загружается лениво через getMuteHistoryWords. */
  words?: WordHit[];
  spans: MuteSpan[];
  manualSpans?: MuteSpan[];
  excludedSpans?: MuteSpan[];
  sourceFingerprint?: string | null;
  recognitionVersion?: number | null;
  settings: FetchrMuteSettings;
}

export interface VocalRemoverResult {
  vocals_path: string;
  instrumental_path: string;
  mode: VocalRemoverMode;
  workflow?: VocalRemoverWorkflow;
  antiCopyrightPath?: string | null;
  musicSegments?: VocalRemoverAudioSegment[];
  processedMs?: number;
  elapsed_ms: number;
}

export interface VocalRemoverAudioSegment {
  start_sec: number;
  end_sec: number;
}

export interface VocalRemoverHistoryItem {
  id: string;
  fileName: string;
  filePath: string;
  vocalsPath: string;
  instrumentalPath: string;
  date: number;
  mode: VocalRemoverMode;
  workflow?: VocalRemoverWorkflow;
  antiCopyrightPath?: string | null;
  musicSegments?: VocalRemoverAudioSegment[];
  processedMs?: number;
  elapsedMs: number;
}

export interface CopyrightTimelineSegment {
  start_sec: number;
  end_sec: number;
  confidence: number;
  is_commercial: boolean;
  track_title: string | null;
}

export interface ChatBadge {
  provider: string;
  id: string;
  version?: string | null;
  url?: string | null;
  title?: string | null;
}

export type ChatFragment =
  | { type: "text"; text: string }
  | { type: "emote"; provider: string; id: string; url: string; text?: string | null; zero_width?: boolean };

export interface ChatMessage {
  timestamp: number;
  created_at?: string | null;
  username: string;
  display_name: string;
  user_color?: string | null;
  badges: ChatBadge[];
  fragments: ChatFragment[];
  source_platform: string;
}
