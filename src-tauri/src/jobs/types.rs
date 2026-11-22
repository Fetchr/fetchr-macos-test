use serde::{Deserialize, Deserializer, Serialize};

use crate::proxy::ProxyConfig;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum JobStatus {
    Queued,
    Running,
    Paused,
    Done,
    Error,
    Cancelled,
}

impl JobStatus {
    pub fn is_terminal(&self) -> bool {
        matches!(
            self,
            JobStatus::Done | JobStatus::Error | JobStatus::Cancelled
        )
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    /// VOD — use yt-dlp for end-to-end.
    Vod,
    /// Live stream — resolve URL through yt-dlp, then record via N_m3u8DL-RE
    /// with the "ENDLIST" trick.
    Live,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum JobKind {
    Video,
    Chat,
    FetchrMute,
    VpsDownload,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DownloadKind {
    Video,
    Audio,
}

/// Which video/audio codecs the finished file is allowed to carry.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum VideoCodecPolicy {
    /// H.264 + AAC. Editors like Premiere Pro cannot decode VP9/AV1 in MP4
    /// and cannot read Opus at all, so prefer avc1/m4a while downloading and
    /// re-encode afterwards when YouTube offers nothing else (above 1080p).
    Compatible,
    /// Whatever yt-dlp considers best, container untouched (AV1/VP9/Opus).
    Best,
}

impl Default for VideoCodecPolicy {
    fn default() -> Self {
        Self::Compatible
    }
}

/// Audio container for [`DownloadKind::Audio`] jobs.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AudioFormat {
    /// AAC copied straight out of the source — no re-encode.
    M4a,
    /// Opus copied straight out of the source — no re-encode.
    Opus,
    /// Re-encoded for players that still only understand MP3.
    Mp3,
}

impl Default for AudioFormat {
    fn default() -> Self {
        Self::M4a
    }
}

impl AudioFormat {
    /// Extension yt-dlp leaves on disk for this format.
    pub fn extension(self) -> &'static str {
        match self {
            Self::M4a => "m4a",
            Self::Opus => "opus",
            Self::Mp3 => "mp3",
        }
    }

    /// True when yt-dlp has to run an encoder instead of copying the stream.
    pub fn needs_reencode(self) -> bool {
        matches!(self, Self::Mp3)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FetchrMuteLanguage {
    Ru,
    En,
}

impl Default for FetchrMuteLanguage {
    fn default() -> Self {
        Self::Ru
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FetchrMuteProcessingMode {
    Normal,
    Precise,
}

impl Default for FetchrMuteProcessingMode {
    fn default() -> Self {
        Self::Normal
    }
}

/// Единственная модель распознавания: GigaAM v3 RNN-T int8 (WER 8.3 против
/// 9.1 у v3 CTC и 11.2 у v3 E2E RNN-T). Символьный словарь на 34 токена — тот
/// же, что был у CTC, поэтому склейка фрагментов и тайминги спанов работают
/// одинаково во всех режимах. Прежние значения остаются алиасами, чтобы
/// сохранённые настройки и история читались без миграции.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum FetchrMuteAsrModel {
    #[serde(
        rename = "gigaam_v3_rnnt_int8",
        alias = "gigaam_v3_ctc_int8",
        alias = "gigaam_v3_e2e_rnnt_int8",
        alias = "gigaam_v3_rnnt_onnx",
        alias = "gigaam_multilingual_ctc_int8",
        alias = "gigaam_multilingual_large_ctc_int8",
        alias = "parakeet_tdt_0_6b_v3",
        alias = "qwen3_asr_0_6b"
    )]
    GigaAmV3RnntInt8,
}

impl Default for FetchrMuteAsrModel {
    fn default() -> Self {
        Self::GigaAmV3RnntInt8
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FetchrMuteCensorshipLevel {
    Soft,
    Standard,
    Strict,
    Maximum,
}

impl Default for FetchrMuteCensorshipLevel {
    fn default() -> Self {
        Self::Standard
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FetchrMuteCensorMethod {
    Beep,
    Mute,
    Custom,
}

impl Default for FetchrMuteCensorMethod {
    fn default() -> Self {
        Self::Mute
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FetchrMuteProfile {
    Reference,
    Classic,
    /// «Герметичный»: нулевое ядро накрывает слово целиком плюс запас по
    /// краям, а затухание/возврат выносятся за пределы слова в паузы.
    /// Отдельная настройка, добавленная после разбора утечек мата: профиль
    /// Reference оставлял слышимыми первые ~50–100 мс и хвост ~75–80 мс слова,
    /// чего ASR (и уху) хватало для узнавания мата.
    Sealed,
    /// «Адаптивный»: форма мута снята с референсных дорожек и подстроена на
    /// слух — рампа вниз 55 мс внутри слова, слышимый хвост 55 мс, возврат
    /// 15 мс. Слово НЕ вырезается целиком. Границы уточняются по энергетике,
    /// систематический сдвиг таймкодов ASR компенсируется, матчинг агрессивнее
    /// (fuzzy/фонетика на любом уровне цензуры, склейки до 4 фрагментов).
    Adaptive,
}

impl Default for FetchrMuteProfile {
    fn default() -> Self {
        Self::Adaptive
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum VocalRemoverMode {
    FastHtdemucs,
    StudioHtdemucsFt,
    UltraMelband,
}

impl Default for VocalRemoverMode {
    fn default() -> Self {
        Self::FastHtdemucs
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum VocalRemoverWorkflow {
    Stems,
    AntiCopyright,
}

impl Default for VocalRemoverWorkflow {
    fn default() -> Self {
        Self::Stems
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VocalRemoverSettings {
    #[serde(default)]
    pub mode: VocalRemoverMode,
    #[serde(default)]
    pub workflow: VocalRemoverWorkflow,
    #[serde(default)]
    pub custom_segments: Option<Vec<super::vocal_remover::AudioSegment>>,
}

impl Default for VocalRemoverSettings {
    fn default() -> Self {
        Self {
            mode: VocalRemoverMode::FastHtdemucs,
            workflow: VocalRemoverWorkflow::Stems,
            custom_segments: None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ChatOverlayMode {
    TransparentOverlay,
    DirectRender,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PerformanceProfile {
    Auto,
    Maximum,
    Turbo,
    Custom,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GpuEncoderMode {
    Auto,
    IntelXeQsv,
    Nvenc,
    Qsv,
    Amf,
    Vulkan,
    Cpu,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PerformanceSettings {
    #[serde(default)]
    pub profile: Option<PerformanceProfile>,
    #[serde(default)]
    pub network_concurrent_fragments: Option<u32>,
    #[serde(default)]
    pub cpu_threads: Option<u32>,
    #[serde(default)]
    pub render_workers: Option<u32>,
    #[serde(default)]
    pub gpu_encoder_mode: Option<GpuEncoderMode>,
    #[serde(default)]
    pub ffmpeg_preset: Option<String>,
}

impl Default for PerformanceSettings {
    fn default() -> Self {
        Self {
            profile: Some(PerformanceProfile::Auto),
            network_concurrent_fragments: Some(16),
            cpu_threads: None,
            render_workers: None,
            gpu_encoder_mode: Some(GpuEncoderMode::Auto),
            ffmpeg_preset: None,
        }
    }
}

impl PerformanceSettings {
    pub fn with_defaults(mut self) -> Self {
        self.profile.get_or_insert(PerformanceProfile::Auto);
        let logical_cores = std::thread::available_parallelism()
            .map(|cores| cores.get() as u32)
            .unwrap_or(4);
        match self.profile {
            Some(PerformanceProfile::Turbo) => {
                self.network_concurrent_fragments.get_or_insert(64);
                self.cpu_threads.get_or_insert(logical_cores);
                self.render_workers.get_or_insert(logical_cores);
            }
            Some(PerformanceProfile::Maximum) => {
                self.network_concurrent_fragments.get_or_insert(32);
                if self.gpu_encoder_mode.is_none() {
                    self.gpu_encoder_mode = Some(GpuEncoderMode::IntelXeQsv);
                }
            }
            _ => {}
        }
        self.network_concurrent_fragments.get_or_insert(16);
        self.gpu_encoder_mode.get_or_insert(GpuEncoderMode::Auto);
        self
    }

    pub fn network_threads(&self) -> u32 {
        self.network_concurrent_fragments.unwrap_or(16).clamp(1, 64)
    }

    pub fn cpu_threads(&self) -> Option<u32> {
        self.cpu_threads.filter(|v| *v > 0).map(|v| v.clamp(1, 128))
    }

    pub fn is_turbo(&self) -> bool {
        self.profile == Some(PerformanceProfile::Turbo)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BlurEffect {
    Mosaic,
    GaussianBlur,
    ImageOverlay,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ImageFit {
    Contain,
    Cover,
    Stretch,
}

/// Geometry of the masked region. `Rectangle` keeps the legacy behaviour (a hard
/// crop/overlay rectangle) and stays on the cheap no-mask filter path.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum BlurShape {
    #[default]
    Rectangle,
    Ellipse,
}

/// Speed/quality trade-off for the blur kernel itself.
///
/// * `Fast` — downscale the cropped region by `sigma`, `avgblur` on the tiny
///   image, bilinear upscale. Cost is ~O(area/sigma^2) instead of O(area), so
///   large radii become nearly free.
/// * `Balanced` — same downscale trick with a smaller factor plus a 2-pass
///   `avgblur` (two box passes approximate a gaussian).
/// * `High` — true `gblur` at full resolution (the old behaviour).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum BlurQuality {
    Fast,
    #[default]
    Balanced,
    High,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BlurZoneKeyframe {
    pub time_sec: f64,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    #[serde(default)]
    pub confidence: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BlurZoneTracking {
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default)]
    pub start_time_sec: f64,
    #[serde(default)]
    pub end_time_sec: Option<f64>,
    #[serde(default = "default_tracking_sample_interval")]
    pub sample_interval_sec: f64,
    #[serde(default = "default_tracking_search_radius")]
    pub search_radius: u32,
    #[serde(default = "default_tracking_confidence_threshold")]
    pub confidence_threshold: f32,
    #[serde(default)]
    pub keyframes: Vec<BlurZoneKeyframe>,
    /// `[start, end]` spans, on the same timeline as `keyframes`, where the
    /// tracker lost the banner. Long ones are left unblurred at render time.
    #[serde(default)]
    pub gaps: Vec<[f64; 2]>,
}

fn default_tracking_sample_interval() -> f64 {
    0.5
}

fn default_tracking_search_radius() -> u32 {
    220
}

fn default_tracking_confidence_threshold() -> f32 {
    0.72
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ChatRenderCodec {
    RawRgbaPipe,
    Ffv1MkvAlpha,
    QtrleMovRle,
    Prores4444,
    Vp9WebmAlpha,
    LagarithAvi,
    SolidBgFast,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FinalRenderMode {
    Full,
    BlurOnly,
    ChatOnly,
    SeparateChat,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ChatFontStyle {
    Normal,
    Italic,
    Oblique,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BlurZone {
    pub id: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub effect: BlurEffect,
    #[serde(default = "default_blur_intensity")]
    pub intensity: f32,
    #[serde(default)]
    pub image_path: Option<String>,
    #[serde(default)]
    pub image_fit: Option<ImageFit>,
    #[serde(default)]
    pub tracking: Option<BlurZoneTracking>,
    /// Rectangle (default, fastest) or ellipse. Anything other than a hard
    /// rectangle needs an alpha mask, which costs one extra filter input.
    #[serde(default)]
    pub shape: Option<BlurShape>,
    /// Feather width in design-space pixels. 0 = hard edge (no mask needed).
    #[serde(default)]
    pub edge_softness: Option<u32>,
    /// Blur kernel speed/quality trade-off. Ignored by `ImageOverlay`.
    #[serde(default)]
    pub quality: Option<BlurQuality>,
    /// Overlay opacity, 0.0..=1.0. 1.0 = fully replaces the region.
    #[serde(default)]
    pub opacity: Option<f32>,
}

fn default_true() -> bool {
    true
}

fn default_blur_intensity() -> f32 {
    8.0
}

impl BlurZone {
    pub fn shape_or_default(&self) -> BlurShape {
        self.shape.unwrap_or_default()
    }

    pub fn quality_or_default(&self) -> BlurQuality {
        self.quality.unwrap_or_default()
    }

    /// Feather width clamped so it can never eat more than half of the shorter
    /// side (a wider feather would leave nothing fully blurred).
    pub fn edge_softness_px(&self) -> u32 {
        let limit = self.width.min(self.height) / 2;
        self.edge_softness.unwrap_or(0).min(limit)
    }

    pub fn opacity_clamped(&self) -> f32 {
        self.opacity.unwrap_or(1.0).clamp(0.0, 1.0)
    }

    /// True when the zone can use the cheap crop+overlay path with no alpha mask.
    pub fn is_hard_rectangle(&self) -> bool {
        self.shape_or_default() == BlurShape::Rectangle
            && self.edge_softness_px() == 0
            && self.opacity_clamped() >= 0.999
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ChatOverlaySettings {
    #[serde(default)]
    pub enabled: Option<bool>,
    #[serde(default)]
    pub mode: Option<ChatOverlayMode>,
    #[serde(default)]
    pub output_width: Option<u32>,
    #[serde(default)]
    pub output_height: Option<u32>,
    #[serde(default)]
    pub fps: Option<u32>,
    #[serde(default)]
    pub chat_x: Option<i32>,
    #[serde(default)]
    pub chat_y: Option<i32>,
    #[serde(default)]
    pub chat_width: Option<u32>,
    #[serde(default)]
    pub chat_height: Option<u32>,
    #[serde(default)]
    pub font_family: Option<String>,
    #[serde(default)]
    pub font_weight: Option<u16>,
    #[serde(default)]
    pub font_style: Option<ChatFontStyle>,
    #[serde(default)]
    pub username_font_weight: Option<u16>,
    #[serde(default)]
    pub username_font_style: Option<ChatFontStyle>,
    #[serde(default)]
    pub font_size: Option<f32>,
    #[serde(default)]
    pub text_color: Option<String>,
    #[serde(default)]
    pub outline_enabled: Option<bool>,
    #[serde(default)]
    pub outline_color: Option<String>,
    #[serde(default)]
    pub outline_thickness: Option<u32>,
    #[serde(default)]
    pub background_enabled: Option<bool>,
    #[serde(default)]
    pub background_opacity: Option<f32>,
    /// Frosted-glass look: blur the video region behind the chat background.
    #[serde(default)]
    pub background_blur_enabled: Option<bool>,
    #[serde(default)]
    pub show_badges: Option<bool>,
    #[serde(default)]
    pub show_timestamps: Option<bool>,
    #[serde(default)]
    pub show_avatars: Option<bool>,
    #[serde(default)]
    pub show_bttv: Option<bool>,
    #[serde(default)]
    pub show_ffz: Option<bool>,
    #[serde(default)]
    pub show_7tv: Option<bool>,
    #[serde(default)]
    pub max_visible_messages: Option<u32>,
    #[serde(default)]
    pub message_lifetime_sec: Option<f64>,
    #[serde(default)]
    pub chat_update_rate_sec: Option<f64>,
    #[serde(default)]
    pub direction: Option<String>,
    #[serde(default)]
    pub alpha_output_format: Option<AlphaOutputFormat>,
    #[serde(default)]
    pub chat_overlay_fps: Option<u32>,
    #[serde(default)]
    pub save_alpha_overlay: Option<bool>,
    #[serde(default)]
    pub save_clean_video: Option<bool>,
    #[serde(default)]
    pub compose_mode: Option<ChatComposeMode>,
    #[serde(default)]
    pub render_codec: Option<ChatRenderCodec>,
    #[serde(default)]
    pub final_render_mode: Option<FinalRenderMode>,
    #[serde(default)]
    pub solid_background_color: Option<String>,
    #[serde(default)]
    pub render_quality: Option<ChatRenderQuality>,
    /// Chat-only jobs: stop after downloading/writing the chat JSON, skip rendering.
    #[serde(default)]
    pub json_only: Option<bool>,
    /// How a new message enters the overlay.
    #[serde(default)]
    pub message_animation: Option<ChatMessageAnimation>,
    #[serde(default)]
    pub message_animation_ms: Option<u32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ChatMessageAnimation {
    #[default]
    None,
    Fade,
    SlideUp,
    SlideLeft,
    Pop,
}

/// Chat raster quality. Standard keeps the current 1:1 raster (~720p-class), High/Ultra
/// rasterize the chat at 1.5x/2x (1080p/1440p-class) — sharper text and emotes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ChatRenderQuality {
    Standard,
    High,
    Ultra,
}

impl ChatRenderQuality {
    pub fn supersample_factor(&self) -> f32 {
        match self {
            ChatRenderQuality::Standard => 1.0,
            ChatRenderQuality::High => 1.5,
            ChatRenderQuality::Ultra => 2.0,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AlphaOutputFormat {
    /// PNG-in-MOV: lossless RGBA, frame-threaded encode (uses all cores, ~N× faster than
    /// single-threaded qtrle), imports into Premiere/Resolve with alpha.
    MovPng,
    MovQtrle,
    WebmVp9,
    WebmVp8,
    Ffv1Mkv,
    Prores4444,
    LagarithAvi,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ChatComposeMode {
    // Aliases keep settings saved by older builds (SegmentedDirect mode) loading as Direct.
    #[serde(alias = "segmented_direct", alias = "segmenteddirect")]
    Direct,
    Intermediate,
}

impl ChatOverlaySettings {
    pub fn with_defaults(mut self) -> Self {
        self.enabled.get_or_insert(false);
        self.mode.get_or_insert(ChatOverlayMode::TransparentOverlay);
        self.output_width.get_or_insert(1920);
        self.output_height.get_or_insert(1080);
        self.fps.get_or_insert(60);
        self.chat_x.get_or_insert(80);
        self.chat_y.get_or_insert(760);
        self.chat_width.get_or_insert(1760);
        self.chat_height.get_or_insert(260);
        self.font_family.get_or_insert_with(|| "Inter".to_string());
        self.font_weight.get_or_insert(400);
        self.font_style.get_or_insert(ChatFontStyle::Normal);
        self.username_font_weight.get_or_insert(700);
        self.username_font_style
            .get_or_insert(ChatFontStyle::Normal);
        self.font_size.get_or_insert(24.0);
        self.text_color.get_or_insert_with(|| "#FFFFFF".to_string());
        self.outline_enabled.get_or_insert(true);
        self.outline_color
            .get_or_insert_with(|| "#000000".to_string());
        self.outline_thickness.get_or_insert(2);
        self.background_enabled.get_or_insert(false);
        self.background_opacity.get_or_insert(0.15);
        self.background_blur_enabled.get_or_insert(true);
        self.show_badges.get_or_insert(true);
        self.show_timestamps.get_or_insert(false);
        self.show_avatars.get_or_insert(false);
        self.show_bttv.get_or_insert(true);
        self.show_ffz.get_or_insert(true);
        self.show_7tv.get_or_insert(true);
        self.max_visible_messages.get_or_insert(14);
        self.message_lifetime_sec.get_or_insert(86400.0);
        self.chat_update_rate_sec.get_or_insert(0.2);
        self.direction
            .get_or_insert_with(|| "bottom-up".to_string());
        self.alpha_output_format
            .get_or_insert(AlphaOutputFormat::MovPng);
        self.chat_overlay_fps
            .get_or_insert_with(|| self.fps.unwrap_or(60));
        self.save_alpha_overlay.get_or_insert(false);
        self.save_clean_video.get_or_insert(true);
        self.compose_mode.get_or_insert(ChatComposeMode::Direct);
        self.render_codec
            .get_or_insert(ChatRenderCodec::RawRgbaPipe);
        self.final_render_mode.get_or_insert(FinalRenderMode::Full);
        self.solid_background_color
            .get_or_insert_with(|| "#212121".to_string());
        self.render_quality
            .get_or_insert(ChatRenderQuality::Standard);
        self
    }
}

/// Metadata collected during stream resolution (shown in the UI).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct JobMeta {
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub uploader: Option<String>,
    #[serde(default)]
    pub platform: Option<String>,
    #[serde(default)]
    pub thumbnail: Option<String>,
    #[serde(default)]
    pub duration: Option<f64>,
    /// Final absolute path of the saved file (populated when job finishes).
    #[serde(default)]
    pub output_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TimeFragment {
    pub start: String,
    pub end: String,
}

/// Payload for downloading from the VPS recorder agent: either a finished clip
/// or a whole session.
///
/// A session is fetched segment by segment and concatenated here, never cut
/// into a full-length mp4 on the server — the VPS has no room to hold a second
/// copy of a multi-hour recording.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VpsDownloadSpec {
    pub base_url: String,
    pub token: String,
    #[serde(default)]
    pub clip_id: String,
    /// Set instead of `clip_id` to pull the whole recording.
    #[serde(default)]
    pub session: Option<String>,
    #[serde(default = "default_true")]
    pub include_chat: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FetchrMuteSettings {
    #[serde(default)]
    pub language: FetchrMuteLanguage,
    #[serde(default)]
    pub mode: FetchrMuteProcessingMode,
    #[serde(default)]
    pub asr_model: FetchrMuteAsrModel,
    #[serde(default)]
    pub censorship_level: FetchrMuteCensorshipLevel,
    #[serde(default)]
    pub censor_method: FetchrMuteCensorMethod,
    #[serde(default)]
    pub mute_profile: FetchrMuteProfile,
    #[serde(default = "default_fetchr_mute_coverage_percent")]
    pub coverage_percent: u8,
    #[serde(default = "default_fetchr_mute_fade_out_ms")]
    pub fade_out_ms: u16,
    #[serde(default = "default_fetchr_mute_fade_in_ms")]
    pub fade_in_ms: u16,
    #[serde(default = "default_fetchr_mute_min_mute_ms")]
    pub min_mute_ms: u16,
    #[serde(default)]
    pub custom_words: Vec<String>,
    #[serde(default)]
    pub whitelist_words: Vec<String>,
    #[serde(default)]
    pub only_custom_words: bool,
    #[serde(default = "default_fetchr_mute_smooth_mute")]
    pub smooth_mute: bool,
    #[serde(default)]
    pub custom_sound_path: Option<String>,
    /// Индекс аудиодорожки источника (0 = первая). None — первая дорожка.
    #[serde(default)]
    pub audio_track_index: Option<u32>,
}

impl Default for FetchrMuteSettings {
    fn default() -> Self {
        Self {
            language: FetchrMuteLanguage::Ru,
            mode: FetchrMuteProcessingMode::Normal,
            asr_model: FetchrMuteAsrModel::GigaAmV3RnntInt8,
            censorship_level: FetchrMuteCensorshipLevel::Standard,
            censor_method: FetchrMuteCensorMethod::Mute,
            mute_profile: FetchrMuteProfile::Adaptive,
            coverage_percent: default_fetchr_mute_coverage_percent(),
            fade_out_ms: default_fetchr_mute_fade_out_ms(),
            fade_in_ms: default_fetchr_mute_fade_in_ms(),
            min_mute_ms: default_fetchr_mute_min_mute_ms(),
            custom_words: Vec::new(),
            whitelist_words: Vec::new(),
            only_custom_words: false,
            smooth_mute: default_fetchr_mute_smooth_mute(),
            custom_sound_path: None,
            audio_track_index: None,
        }
    }
}

fn default_fetchr_mute_coverage_percent() -> u8 {
    50
}

fn default_fetchr_mute_fade_out_ms() -> u16 {
    100
}

fn default_fetchr_mute_fade_in_ms() -> u16 {
    5
}

fn default_fetchr_mute_min_mute_ms() -> u16 {
    80
}

fn default_fetchr_mute_smooth_mute() -> bool {
    true
}

fn deserialize_fetchr_mute_settings<'de, D>(deserializer: D) -> Result<FetchrMuteSettings, D::Error>
where
    D: Deserializer<'de>,
{
    Ok(Option::<FetchrMuteSettings>::deserialize(deserializer)?.unwrap_or_default())
}

#[cfg(test)]
mod tests {
    use super::{ChatComposeMode, GpuEncoderMode, PerformanceProfile, PerformanceSettings};

    #[test]
    fn chat_compose_mode_legacy_segmented_direct_maps_to_direct() {
        assert_eq!(
            serde_json::from_str::<ChatComposeMode>("\"segmented_direct\"").unwrap(),
            ChatComposeMode::Direct
        );
        assert_eq!(
            serde_json::from_str::<ChatComposeMode>("\"segmenteddirect\"").unwrap(),
            ChatComposeMode::Direct
        );
        assert_eq!(
            serde_json::from_str::<ChatComposeMode>("\"direct\"").unwrap(),
            ChatComposeMode::Direct
        );
    }

    #[test]
    fn turbo_profile_defaults_use_more_threads() {
        let performance = PerformanceSettings {
            profile: Some(PerformanceProfile::Turbo),
            network_concurrent_fragments: None,
            cpu_threads: None,
            render_workers: None,
            gpu_encoder_mode: Some(GpuEncoderMode::Auto),
            ffmpeg_preset: None,
        }
        .with_defaults();

        assert_eq!(performance.network_concurrent_fragments, Some(32));
        assert!(performance.cpu_threads.unwrap_or(0) >= 1);
        assert!(performance.render_workers.unwrap_or(0) >= 1);
        assert!(performance.is_turbo());
    }
}

/// Job specification coming in from the UI.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JobSpec {
    pub url: String,
    /// Optional source URL used only for chat replay extraction.
    /// This lets Twitch video download use a resolved HLS/m3u8 URL while
    /// chat still uses the original public Twitch VOD URL.
    #[serde(default)]
    pub chat_source_url: Option<String>,
    pub name: String,
    pub directory: String,
    #[serde(default)]
    pub job_kind: Option<JobKind>,
    pub mode: Mode,
    #[serde(default)]
    pub download_kind: Option<DownloadKind>,
    #[serde(default)]
    pub start: Option<String>,
    #[serde(default)]
    pub end: Option<String>,
    #[serde(default)]
    pub fragments: Vec<TimeFragment>,
    #[serde(default)]
    pub split: bool,
    #[serde(default)]
    pub split_interval_minutes: Option<u32>,
    #[serde(default)]
    pub quality: Option<String>,
    #[serde(default)]
    pub quality_has_audio: Option<bool>,
    #[serde(default)]
    pub quality_has_video: Option<bool>,
    #[serde(default)]
    pub quality_height: Option<u32>,
    #[serde(default)]
    pub video_codec_policy: Option<VideoCodecPolicy>,
    #[serde(default)]
    pub audio_format: Option<AudioFormat>,
    #[serde(default)]
    pub unmute_video: bool,
    #[serde(default)]
    pub proxy: ProxyConfig,
    #[serde(default)]
    pub chat_overlay: Option<ChatOverlaySettings>,
    #[serde(default)]
    pub performance: Option<PerformanceSettings>,
    #[serde(default)]
    pub blur_zones: Vec<BlurZone>,
    /// Optional override for the directory containing external binaries
    /// (yt-dlp.exe / N_m3u8DL-RE.exe / ffmpeg.exe).
    #[serde(default)]
    pub binaries_dir: Option<String>,
    #[serde(default)]
    pub fetchr_mute_enabled: bool,
    #[serde(default)]
    pub fetchr_mute_model: Option<String>,
    #[serde(default, deserialize_with = "deserialize_fetchr_mute_settings")]
    pub fetchr_mute_settings: FetchrMuteSettings,
    /// Папка результата задачи FetchrMute над локальным файлом (пакетная
    /// обработка). Нет — результат рядом с исходником, как раньше.
    #[serde(default)]
    pub fetchr_mute_output_dir: Option<String>,
    #[serde(default)]
    pub vocal_remover_enabled: bool,
    #[serde(default)]
    pub vocal_remover_settings: Option<VocalRemoverSettings>,
    #[serde(default)]
    pub record_chat_separate: bool,
    #[serde(default)]
    pub meta: JobMeta,
    #[serde(default)]
    pub twitch_auth_token: Option<String>,
    #[serde(default)]
    pub vps_download: Option<VpsDownloadSpec>,
    /// Queue priority. Higher runs first (high=1, normal=0, low=-1).
    #[serde(default)]
    pub priority: i32,
}

/// Runtime progress snapshot emitted to the frontend.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JobProgress {
    pub percent: f32,
    #[serde(default)]
    pub stage_percent: Option<f32>,
    #[serde(default)]
    pub stage_start: Option<f32>,
    #[serde(default)]
    pub stage_end: Option<f32>,
    #[serde(default)]
    pub stage_started_at: Option<i64>,
    #[serde(default)]
    pub download_elapsed_ms: Option<i64>,
    #[serde(default)]
    pub downloaded_bytes: Option<u64>,
    #[serde(default)]
    pub total_bytes: Option<u64>,
    #[serde(default)]
    pub speed_bps: Option<f64>,
    #[serde(default)]
    pub current_segment: Option<String>,
    pub speed: Option<String>,
    pub eta: Option<String>,
    pub size: Option<String>,
    pub message: Option<String>,
}

impl Default for JobProgress {
    fn default() -> Self {
        Self {
            percent: 0.0,
            stage_percent: None,
            stage_start: None,
            stage_end: None,
            stage_started_at: None,
            download_elapsed_ms: None,
            downloaded_bytes: None,
            total_bytes: None,
            speed_bps: None,
            current_segment: None,
            speed: None,
            eta: None,
            size: None,
            message: None,
        }
    }
}

/// Live-recording health snapshot: what is ACTUALLY happening with the
/// recording file on disk (independent from the downloader's stdout).
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct LiveStats {
    /// Real quality of the recorded stream, probed from the local file
    /// (e.g. "1920x1080 · 60 fps").
    #[serde(default)]
    pub detected_quality: Option<String>,
    /// Epoch ms when the recording file last grew.
    #[serde(default)]
    pub last_data_at: Option<i64>,
    /// Current recording file size in bytes.
    #[serde(default)]
    pub recorded_bytes: Option<u64>,
    /// True when no new data has been written for a while (network drop).
    #[serde(default)]
    pub stalled: bool,
    /// How many times the recorder was automatically restarted after a drop.
    #[serde(default)]
    pub reconnects: u32,
    /// Real media duration of the recording file in seconds, probed by ffprobe
    /// (unlike wall-clock time, this matches the actual footage on disk).
    #[serde(default)]
    pub media_duration_sec: Option<f64>,
}

/// Full job state as stored in memory and sent to the UI.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Job {
    pub id: String,
    pub spec: JobSpec,
    pub status: JobStatus,
    pub progress: JobProgress,
    pub created_at: i64,
    pub started_at: Option<i64>,
    pub finished_at: Option<i64>,
    pub error: Option<String>,
    #[serde(default)]
    pub output_path: Option<String>,
    #[serde(default)]
    pub live_stats: Option<LiveStats>,
}
