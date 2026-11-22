use std::collections::{HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use ab_glyph::{Font, FontArc, PxScale};
use anyhow::{anyhow, Context, Result};
use image::{imageops, DynamicImage, Rgba, RgbaImage};
use imageproc::drawing::draw_text_mut;
use crate::chat_overlay::appear::{appear_state, AppearState, SETTLED};
use crate::chat_overlay::fast_blend::{overlay_fast, overlay_fast_alpha};
use rayon::prelude::*;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;

use crate::chat_overlay::blur_filter::{
    append_blur_zone_filters, gaussian_chain, normalized_blur_zones,
};
use crate::chat_overlay::badge_art::badge_render_url;
use crate::chat_overlay::cache::{BadgeCache, EmoteCache, ScaledAnimatedImage};
use crate::chat_overlay::diagnostics;
use crate::chat_overlay::emit_log;
use crate::jobs::types::BlurQuality;
use crate::chat_overlay::fonts::{FontStack, FALLBACK_FAMILIES};
use crate::chat_overlay::ffmpeg_metrics::{
    cbr_rate_args, format_optional_fps, format_optional_speed, format_speed_value,
    is_ffmpeg_progress_line, probe_source, render_progress_message, ChatPipeMetrics,
    DirectRenderMetrics, FfmpegEncodeMetrics,
};

use crate::chat_overlay::layout::{
    image_dimension_key, ChatLayoutEngine, LayoutMessage, LayoutRunKind, TextRole,
};
use crate::chat_overlay::model::{ChatFragment, ChatMessage};
use crate::chat_overlay::settings::{parse_color, EffectiveChatOverlaySettings};
use crate::jobs::queue::QueueManager;
use crate::jobs::types::{
    AlphaOutputFormat, BlurEffect, BlurZone, ChatFontStyle, ChatRenderCodec, GpuEncoderMode,
    JobProgress, PerformanceProfile, PerformanceSettings,
};

pub struct ChatOverlayRenderer {
    settings: EffectiveChatOverlaySettings,
    ffmpeg: PathBuf,
    work_dir: PathBuf,
    layout: ChatLayoutEngine,
    emotes: EmoteCache,
    badges: BadgeCache,
    text_font: FontStack,
    username_font: FontStack,
    render_workers: usize,
    asset_workers: usize,
    turbo: bool,
    gpu_encoder_mode: Option<GpuEncoderMode>,
    /// Source video size from ffprobe; lets the filter graph skip a no-op scale+pad.
    source_size: Option<(u32, u32)>,
    /// Source frame rate, set only when the video starts after the audio.
    late_video_start: Option<f64>,
    glyph_cache: GlyphCache,
    /// Supersampling factor from the render-quality setting (1.0 / 1.5 / 2.0). The chat is
    /// rasterized at this scale; when overlaying onto a video it is scaled back down to
    /// `overlay_target_*`, so the on-video size stays identical but text/emotes get crisper.
    /// Chat-only outputs keep the higher resolution.
    supersample: f32,
    overlay_target_width: u32,
    overlay_target_height: u32,
    // Memoized per-size rescales. Without these every chat message re-rescaled its
    // badges and ALL frames of its animated emotes during timeline preparation, which
    // made "Preparing chat timeline" take minutes on emote-heavy chats.
    scaled_emotes: HashMap<(String, String, i32, i32), (Arc<ScaledAnimatedImage>, bool)>,
    scaled_badges: HashMap<(String, String, i32, i32), Arc<RgbaImage>>,
}

struct CachedGlyph {
    width: u32,
    height: u32,
    bounds_min_x: i32,
    bounds_min_y: i32,
    clean_mask: Vec<u8>,
    outline_width: u32,
    outline_height: u32,
    outline_mask: Vec<u8>,
}

#[derive(Default)]
struct GlyphCache {
    text_glyphs: HashMap<char, CachedGlyph>,
    username_glyphs: HashMap<char, CachedGlyph>,
}

struct TimelineMessage {
    start: f64,
    end: f64,
    stable_key: String,
    prepared: PreparedMessage,
}

#[derive(Clone)]
struct PreparedMessage {
    height: u32,
    static_image: RgbaImage,
    animated_runs: Vec<PreparedAnimatedRun>,
}

#[derive(Clone)]
struct PreparedAnimatedRun {
    x: i32,
    y: i32,
    height: i32,
    // Arc: the same emote at the same size is shared by every message that uses it,
    // instead of each message owning its own full set of rescaled frames.
    frames: Arc<ScaledAnimatedImage>,
}

/// Per-frame render descriptor precomputed sequentially (cheap), then consumed by the
/// parallel renderer. Keeps the active-window sweep serial while allowing the expensive
/// rasterization to fan out across all cores.
struct FramePlan {
    t: f64,
    static_sig: String,
    combined_sig: String,
    visible: Vec<usize>,
}

/// Carries the last emitted frame across chunk boundaries so consecutive identical
/// frames are not re-rendered when they straddle two chunks.
#[derive(Default)]
struct FrameCarry {
    sig: Option<String>,
    image: Option<Arc<RgbaImage>>,
}

/// Active-window sweep state carried across chunks so the per-frame plan is produced
/// incrementally instead of materializing the entire timeline up front.
#[derive(Default)]
struct SweepState {
    next_index: usize,
    active: VecDeque<usize>,
}

/// Self-contained, `'static` frame renderer that can run on a background blocking thread.
/// It only needs the (cloned) overlay settings and the prepared timeline — never the fonts
/// or asset caches — so it can rasterize frames in parallel via rayon and stream them to a
/// bounded channel while the async consumer keeps ffmpeg's encoder continuously fed. This
/// overlaps CPU rasterization with GPU/CPU encoding instead of serializing the two.
struct FrameProducer {
    settings: EffectiveChatOverlaySettings,
    timeline: Arc<Vec<TimelineMessage>>,
    render_workers: usize,
    /// Dedicated pool so rasterization leaves cores free for ffmpeg instead of
    /// competing with it through rayon's global (all-cores) pool.
    pool: Option<rayon::ThreadPool>,
}

/// Profiling counters shared between producer and consumer to attribute the pipeline
/// bottleneck to either chat rasterization or ffmpeg without guessing.
#[derive(Clone, Default)]
struct ProducerStats {
    /// Pure rasterization time (sum of `render_chunk`), in nanoseconds.
    render_nanos: Arc<AtomicU64>,
    /// Number of frames rasterized (distinct work; copy-frames share an Arc).
    frames: Arc<AtomicU64>,
    /// Time the producer spent blocked because the channel was full (ffmpeg too slow), ns.
    send_block_nanos: Arc<AtomicU64>,
    /// Number of times blocking_send blocked for > 1ms.
    send_blocks_count: Arc<AtomicU64>,
    /// Number of times the channel was full when checked.
    channel_full_count: Arc<AtomicU64>,
}

impl ProducerStats {
    fn render_fps(&self) -> f64 {
        let secs = self.render_nanos.load(Ordering::Relaxed) as f64 / 1e9;
        if secs > 0.0 {
            self.frames.load(Ordering::Relaxed) as f64 / secs
        } else {
            0.0
        }
    }
}

impl FrameProducer {
    /// Spawn the producer on the blocking pool and return the receiving end of the frame
    /// channel. The channel capacity bounds how far rendering may run ahead of encoding,
    /// which both provides pipeline slack and caps memory.
    fn spawn(
        self: Arc<Self>,
        fps: u32,
        frames: std::ops::Range<usize>,
        cancel: Arc<AtomicBool>,
    ) -> (tokio::sync::mpsc::Receiver<Arc<RgbaImage>>, ProducerStats) {
        // Capacity of ~2 chunks: while ffmpeg drains chunk N from the channel, the producer
        // can already rasterize chunk N+1 (double buffering); with capacity == chunk size the
        // encoder starved during every render_chunk burst.
        let capacity = (self.render_workers * 4).clamp(8, 128);
        let (tx, rx) = tokio::sync::mpsc::channel(capacity);
        let me = self.clone();
        let stats = ProducerStats::default();
        let stats_for_task = stats.clone();
        tokio::task::spawn_blocking(move || {
            me.produce(fps, frames, cancel, tx, stats_for_task)
        });
        (rx, stats)
    }

    fn produce(
        &self,
        fps: u32,
        frames: std::ops::Range<usize>,
        cancel: Arc<AtomicBool>,
        tx: tokio::sync::mpsc::Sender<Arc<RgbaImage>>,
        stats: ProducerStats,
    ) {
        let total_frames = frames.end;
        let chunk = self.frame_chunk_size();
        let mut sweep = SweepState::default();
        let mut carry = FrameCarry::default();
        // Starting mid-timeline is fine: the sweep admits every message that began
        // earlier and drops the expired ones on the first planned frame.
        let mut start = frames.start;
        while start < total_frames {
            if cancel.load(Ordering::SeqCst) {
                return;
            }
            let end = (start + chunk).min(total_frames);
            let plan = self.plan_chunk(fps, start, end, &mut sweep);
            let render_started = Instant::now();
            let frames = match &self.pool {
                Some(pool) => pool.install(|| self.render_chunk(&plan, &mut carry)),
                None => self.render_chunk(&plan, &mut carry),
            };
            stats.render_nanos.fetch_add(
                render_started.elapsed().as_nanos() as u64,
                Ordering::Relaxed,
            );
            stats
                .frames
                .fetch_add(frames.len() as u64, Ordering::Relaxed);
            for frame in frames {
                let send_started = Instant::now();
                if tx.capacity() == 0 {
                    stats.channel_full_count.fetch_add(1, Ordering::Relaxed);
                }
                // Errors here mean the consumer is gone (cancelled / ffmpeg died); stop.
                let res = tx.blocking_send(frame);
                let elapsed = send_started.elapsed();
                stats
                    .send_block_nanos
                    .fetch_add(elapsed.as_nanos() as u64, Ordering::Relaxed);
                if elapsed > std::time::Duration::from_millis(1) {
                    stats.send_blocks_count.fetch_add(1, Ordering::Relaxed);
                }
                if res.is_err() {
                    return;
                }
            }
            start = end;
        }
    }

    /// Frames per parallel batch, bounded by worker count and a ~128 MB in-flight memory
    /// budget so high-resolution overlays never accumulate gigabytes of frames.
    fn frame_chunk_size(&self) -> usize {
        let frame_bytes = (self.settings.chat_width as usize).max(1)
            * (self.settings.chat_height as usize).max(1)
            * 4;
        let by_mem = ((128 * 1024 * 1024) / frame_bytes.max(1)).max(1);
        (self.render_workers.max(1) * 2).min(by_mem).clamp(1, 64)
    }

    fn plan_chunk(
        &self,
        fps: u32,
        start: usize,
        end: usize,
        state: &mut SweepState,
    ) -> Vec<FramePlan> {
        let timeline = self.timeline.as_slice();
        let mut plan = Vec::with_capacity(end.saturating_sub(start));
        for frame_idx in start..end {
            let t = frame_idx as f64 / fps as f64;
            while state.next_index < timeline.len() && timeline[state.next_index].start <= t {
                state.active.push_back(state.next_index);
                state.next_index += 1;
            }
            while state
                .active
                .front()
                .map(|idx| timeline[*idx].end < t)
                .unwrap_or(false)
            {
                state.active.pop_front();
            }
            let visible = drawn_timeline_indices(
                visible_timeline_indices(&state.active, timeline, &self.settings),
                timeline,
                &self.settings,
            );
            let static_sig = format!(
                "{}{}",
                static_timeline_signature(&visible, timeline),
                appear_signature(&visible, timeline, &self.settings, t)
            );
            let animated_sig = animated_timeline_signature(&visible, timeline, t);
            let combined_sig = combined_timeline_signature(&static_sig, &animated_sig);
            plan.push(FramePlan {
                t,
                static_sig,
                combined_sig,
                visible,
            });
        }
        plan
    }

    /// Rasterize the distinct frames of a chunk in parallel (rayon), deduplicating by
    /// signature within the chunk and against the previous chunk via `carry`. Frames that
    /// only differ in their animated layer share a single static base. Returns the chunk's
    /// frames in order; identical frames share an `Arc`.
    fn render_chunk(&self, plan: &[FramePlan], carry: &mut FrameCarry) -> Vec<Arc<RgbaImage>> {
        let timeline = self.timeline.as_slice();

        let mut static_seen: HashSet<&str> = HashSet::new();
        let mut static_keys: Vec<(&str, usize)> = Vec::new();
        for (i, frame) in plan.iter().enumerate() {
            if static_seen.insert(frame.static_sig.as_str()) {
                static_keys.push((frame.static_sig.as_str(), i));
            }
        }
        let static_bases: HashMap<&str, Arc<RgbaImage>> = static_keys
            .par_iter()
            .map(|(sig, i)| (*sig, Arc::new(self.render_static_frame(&plan[*i].visible, plan[*i].t))))
            .collect();

        let mut combined_seen: HashSet<&str> = HashSet::new();
        let mut combined_keys: Vec<(&str, usize)> = Vec::new();
        for (i, frame) in plan.iter().enumerate() {
            let sig = frame.combined_sig.as_str();
            if carry.sig.as_deref() == Some(sig) {
                continue;
            }
            if combined_seen.insert(sig) {
                combined_keys.push((sig, i));
            }
        }
        let rendered: HashMap<&str, Arc<RgbaImage>> = combined_keys
            .par_iter()
            .map(|(sig, i)| {
                let base = static_bases
                    .get(plan[*i].static_sig.as_str())
                    .expect("static base must be rendered");
                let has_anim = plan[*i]
                    .visible
                    .iter()
                    .any(|&idx| !timeline[idx].prepared.animated_runs.is_empty());
                if !has_anim {
                    return (*sig, base.clone());
                }
                let mut frame = base.as_ref().clone();
                self.draw_animated(&mut frame, &plan[*i].visible, plan[*i].t);
                (*sig, Arc::new(frame))
            })
            .collect();

        let mut out = Vec::with_capacity(plan.len());
        // The carried frame is skipped at render time, but its signature can
        // come back later in the chunk after other frames: keep every produced
        // image by signature so such a repeat still finds its image.
        let mut produced: HashMap<String, Arc<RgbaImage>> = HashMap::new();
        if let (Some(sig), Some(image)) = (carry.sig.clone(), carry.image.clone()) {
            produced.insert(sig, image);
        }
        for frame in plan {
            let sig = frame.combined_sig.as_str();
            let image = produced
                .get(sig)
                .cloned()
                .or_else(|| rendered.get(sig).cloned())
                .expect("frame must be rendered for its signature");
            produced.insert(sig.to_string(), image.clone());
            carry.sig = Some(sig.to_string());
            carry.image = Some(image.clone());
            out.push(image);
        }
        out
    }

    fn render_static_frame(&self, visible: &[usize], t: f64) -> RgbaImage {
        let timeline = self.timeline.as_slice();
        let mut canvas = RgbaImage::from_pixel(
            self.settings.chat_width,
            self.settings.chat_height,
            Rgba([0, 0, 0, 0]),
        );

        if self.settings.render_codec == ChatRenderCodec::SolidBgFast {
            let color = parse_color(&self.settings.solid_background_color, [33, 33, 33, 255]);
            fill_canvas(&mut canvas, [color[0], color[1], color[2], 255]);
        } else if self.settings.background_enabled {
            let alpha = (self.settings.background_opacity.clamp(0.0, 1.0) * 255.0) as u8;
            fill_canvas(&mut canvas, [0, 0, 0, alpha]);
        }

        for placed in placed_messages(visible, timeline, &self.settings, t) {
            let image = &timeline[placed.idx].prepared.static_image;
            if placed.appear.is_settled() {
                overlay_clipped(&mut canvas, image, placed.y);
            } else {
                overlay_fast_alpha(
                    &mut canvas,
                    image,
                    placed.appear.dx as i64,
                    (placed.y + placed.appear.dy) as i64,
                    placed.appear.alpha,
                );
            }
        }

        canvas
    }

    fn draw_animated(&self, canvas: &mut RgbaImage, visible: &[usize], t: f64) {
        let timeline = self.timeline.as_slice();
        for placed in placed_messages(visible, timeline, &self.settings, t) {
            let message_elapsed = t - timeline[placed.idx].start;
            let appear = placed.appear;
            for run in &timeline[placed.idx].prepared.animated_runs {
                let frame = run.frames.frame_at(message_elapsed);
                if appear.is_settled() {
                    draw_rgba_image(canvas, frame, run.x, placed.y + run.y, run.height);
                } else {
                    let centered_y =
                        placed.y + appear.dy + run.y + ((run.height - frame.height() as i32) / 2).max(0);
                    overlay_fast_alpha(
                        canvas,
                        frame,
                        (run.x + appear.dx).max(0) as i64,
                        centered_y as i64,
                        appear.alpha,
                    );
                }
            }
        }
    }
}

impl ChatOverlayRenderer {
    pub fn new(
        settings: EffectiveChatOverlaySettings,
        ffmpeg: PathBuf,
        work_dir: PathBuf,
        render_workers: Option<u32>,
        performance_profile: Option<PerformanceProfile>,
        network_workers: Option<u32>,
        gpu_encoder_mode: Option<GpuEncoderMode>,
        emote_proxy_url: Option<String>,
    ) -> Result<Self> {
        let cache_root = dirs::cache_dir()
            .unwrap_or_else(std::env::temp_dir)
            .join("fetchr")
            .join("chat-assets");
        let text_font = load_font(
            &settings.font_family,
            settings.font_weight,
            settings.font_style,
        )
        .or_else(|| load_font("Segoe UI", 400, ChatFontStyle::Normal))
        .ok_or_else(|| anyhow!("No usable system font found for chat overlay"))?;
        let username_font = load_font(
            &settings.font_family,
            settings.username_font_weight,
            settings.username_font_style,
        )
        .or_else(|| load_font(&settings.font_family, 700, settings.font_style))
        .or_else(|| load_font("Segoe UI", 700, ChatFontStyle::Normal))
        .unwrap_or_else(|| text_font.clone());
        // Chat is not limited to what the chosen font covers — Braille art, box drawing and CJK
        // all show up, and without these a missing character draws as an empty box.
        // Families missing on this machine are skipped rather than replaced by
        // the hard-coded Segoe UI chain: that chain only repeated the first
        // fallback and cost a font file read per missing family.
        let mut fallback_fonts = FALLBACK_FAMILIES
            .iter()
            .filter_map(|family| load_fontdb(family, settings.font_weight, settings.font_style))
            .collect::<Vec<_>>();
        if fallback_fonts.is_empty() {
            fallback_fonts.extend(load_font("Segoe UI", settings.font_weight, settings.font_style));
        }
        let text_font = FontStack::new(text_font, fallback_fonts.clone());
        let username_font = FontStack::new(username_font, fallback_fonts);
        let supersample = settings.supersample_factor().clamp(1.0, 4.0);
        let overlay_target_width = settings.chat_width;
        let overlay_target_height = settings.chat_height;
        let mut settings = settings;
        if supersample > 1.0 {
            settings.chat_width =
                ((settings.chat_width as f32 * supersample).round() as u32).max(1);
            settings.chat_height =
                ((settings.chat_height as f32 * supersample).round() as u32).max(1);
            settings.font_size *= supersample;
            settings.outline_thickness =
                ((settings.outline_thickness as f32 * supersample).round() as u32).max(1);
        }
        Ok(Self {
            layout: ChatLayoutEngine::new(settings.clone()),
            emotes: EmoteCache::new(cache_root.join("emotes"), emote_proxy_url.as_deref()),
            badges: BadgeCache::new(cache_root.join("badges"), emote_proxy_url.as_deref()),
            settings,
            ffmpeg,
            work_dir,
            text_font,
            username_font,
            render_workers: effective_render_workers(render_workers, performance_profile),
            asset_workers: effective_asset_workers(performance_profile, network_workers),
            turbo: performance_profile == Some(PerformanceProfile::Turbo),
            gpu_encoder_mode,
            source_size: None,
            late_video_start: None,
            glyph_cache: GlyphCache::default(),
            supersample,
            overlay_target_width,
            overlay_target_height,
            scaled_emotes: HashMap::new(),
            scaled_badges: HashMap::new(),
        })
    }

    pub async fn render_to_mov(
        &mut self,
        messages: &[ChatMessage],
        duration: f64,
        output: &Path,
        queue: &Arc<QueueManager>,
        job_id: &str,
        cancel: Arc<AtomicBool>,
    ) -> Result<ChatPipeMetrics> {
        self.prepare_assets(messages, queue, job_id).await;
        match self
            .render_to_mov_pipe_parallel(messages, duration, output, queue, job_id, cancel.clone())
            .await
        {
            Ok(metrics) => Ok(metrics),
            Err(err) if !cancel.load(Ordering::SeqCst) => {
                emit_log(
                    queue,
                    job_id,
                    &format!(
                        "Chat overlay: pipe renderer failed ({err:#}); falling back to PNG sequence..."
                    ),
                );
                self.render_to_mov_png_sequence(messages, duration, output, queue, job_id, cancel)
                    .await
            }
            Err(err) => Err(err),
        }
    }

    pub async fn render_direct_outputs(
        &mut self,
        messages: &[ChatMessage],
        duration: f64,
        input_video: &Path,
        alpha_output: Option<&Path>,
        final_output: &Path,
        performance: PerformanceSettings,
        blur_zones: &[BlurZone],
        queue: &Arc<QueueManager>,
        job_id: &str,
        cancel: Arc<AtomicBool>,
    ) -> Result<DirectRenderMetrics> {
        self.render_direct_outputs_inner(
            messages,
            duration,
            input_video,
            alpha_output,
            final_output,
            performance,
            blur_zones,
            queue,
            job_id,
            cancel,
        )
        .await
    }

    async fn render_direct_outputs_inner(
        &mut self,
        messages: &[ChatMessage],
        duration: f64,
        input_video: &Path,
        alpha_output: Option<&Path>,
        final_output: &Path,
        performance: PerformanceSettings,
        blur_zones: &[BlurZone],
        queue: &Arc<QueueManager>,
        job_id: &str,
        cancel: Arc<AtomicBool>,
    ) -> Result<DirectRenderMetrics> {
        // ffprobe startup alone costs seconds on some machines: overlap it with asset
        // loading and timeline preparation instead of running it afterwards.
        let probe_task = {
            let ffmpeg = self.ffmpeg.clone();
            let input = input_video.to_path_buf();
            tokio::spawn(async move { probe_source(&ffmpeg, &input).await })
        };
        self.prepare_assets(messages, queue, job_id).await;
        let prep_started = Instant::now();
        let timeline = Arc::new(
            self.build_timeline(messages, Some(queue), Some(job_id))
                .await,
        );
        emit_log(
            queue,
            job_id,
            &format!(
                "Chat overlay: message preparation time {}",
                format_duration(prep_started.elapsed().as_secs_f64())
            ),
        );
        let performance = performance.with_defaults();
        let source = probe_task.await.unwrap_or_default();
        let target_bitrate = source.bitrate;
        if let Some(b) = target_bitrate {
            emit_log(
                queue,
                job_id,
                &format!("Chat overlay: целевой битрейт видео {b} бит/с (как у исходника)"),
            );
        }
        self.source_size = source.size;
        self.late_video_start = match (source.fps, source.video_offset) {
            (Some(fps), Some(offset)) if offset > 0.001 => Some(fps),
            _ => None,
        };
        if diagnostics::enabled() {
            let summary = format!(
                "источник {:?}, выход {}x{}, чат {}x{} (supersample {:.1}), {} fps чата, render_workers {}, сообщений в таймлайне {}, турбо {}",
                self.source_size,
                self.settings.output_width,
                self.settings.output_height,
                self.overlay_target_width,
                self.overlay_target_height,
                self.supersample,
                self.effective_fps(),
                self.render_workers,
                timeline.len(),
                self.turbo,
            );
            diagnostics::log_environment(queue, job_id, &self.ffmpeg, &summary).await;
        }
        let mut last_error: Option<anyhow::Error> = None;
        let mut attempts = direct_encoder_attempts(&performance, target_bitrate);
        // NVENC can take CUDA frames straight from NVDEC when nothing needs CPU pixels:
        // no backdrop blur, no zones, no alpha side output and no rescale. Tried first;
        // a failure falls through to the regular CPU-overlay NVENC attempt.
        let gpu_overlay_ok = blur_zones.is_empty()
            && alpha_output.is_none()
            && !self.chat_background_blur_active()
            && self.source_matches_output();
        if gpu_overlay_ok {
            if let Some(pos) = attempts.iter().position(|a| a.mode == GpuEncoderMode::Nvenc) {
                let mut gpu = attempts[pos].clone();
                gpu.gpu_overlay = true;
                gpu.label = "NVIDIA NVENC (GPU overlay)";
                gpu.args = strip_pix_fmt(&gpu.args);
                attempts.insert(pos, gpu);
            }
        }
        // Start with the encoder that finished a render last time: avoids re-discovering a
        // broken first candidate on every job.
        if let Ok(guard) = LAST_GOOD_DIRECT_ENCODER.lock() {
            if let Some(last_good) = *guard {
                if let Some(pos) = attempts.iter().position(|a| a.mode == last_good) {
                    let preferred = attempts.remove(pos);
                    attempts.insert(0, preferred);
                }
            }
        }
        let total_attempts = attempts.len();
        for (attempt_idx, encoder) in attempts.iter().enumerate() {
            if cancel.load(Ordering::SeqCst) {
                return Err(anyhow!("cancelled"));
            }
            // Fail fast: a 1-second synthetic encode catches broken encoders in seconds
            // instead of failing a full render pass minutes (or hours) in.
            // Each probe is one more ffmpeg launch (seconds on some machines), so an
            // encoder that already passed in this app session is not probed again.
            if encoder.mode != GpuEncoderMode::Cpu && !encoder_probe_passed(encoder.label) {
                let probe_started = Instant::now();
                if let Err(err) = probe_direct_encoder(&self.ffmpeg, encoder)
                    .await
                    .inspect(|_| remember_encoder_probe(encoder.label))
                {
                    emit_log(
                        queue,
                        job_id,
                        &format!(
                            "Chat overlay: {} probe failed in {:.1}s ({err:#}); skipping...",
                            encoder.label,
                            probe_started.elapsed().as_secs_f64()
                        ),
                    );
                    last_error = Some(err);
                    continue;
                }
            }
            emit_log(
                queue,
                job_id,
                &format!(
                    "Chat overlay: direct compose with {} (attempt {}/{})...",
                    encoder.label,
                    attempt_idx + 1,
                    total_attempts
                ),
            );
            queue.set_progress(
                job_id,
                JobProgress {
                    message: Some(format!(
                        "Рендер (попытка {}/{}): {}",
                        attempt_idx + 1,
                        total_attempts,
                        encoder.label
                    )),
                    ..JobProgress::default()
                },
            );
            match self
                .render_direct_with_encoder(
                    timeline.clone(),
                    duration,
                    input_video,
                    alpha_output,
                    final_output,
                    &performance,
                    blur_zones,
                    queue,
                    job_id,
                    cancel.clone(),
                    encoder,
                )
                .await
            {
                Ok(metrics) => {
                    if let Ok(mut guard) = LAST_GOOD_DIRECT_ENCODER.lock() {
                        *guard = Some(encoder.mode);
                    }
                    return Ok(metrics);
                }
                Err(err)
                    if encoder.mode != GpuEncoderMode::Cpu && !cancel.load(Ordering::SeqCst) =>
                {
                    emit_log(
                        queue,
                        job_id,
                        &format!(
                            "Chat overlay: {} failed ({err:#}); trying next encoder...",
                            encoder.label
                        ),
                    );
                    last_error = Some(err);
                }
                Err(err) => return Err(err),
            }
        }
        Err(last_error.unwrap_or_else(|| anyhow!("no direct encoder attempts configured")))
    }

    async fn render_direct_with_encoder(
        &mut self,
        timeline: Arc<Vec<TimelineMessage>>,
        duration: f64,
        input_video: &Path,
        alpha_output: Option<&Path>,
        final_output: &Path,
        performance: &PerformanceSettings,
        blur_zones: &[BlurZone],
        queue: &Arc<QueueManager>,
        job_id: &str,
        cancel: Arc<AtomicBool>,
        encoder: &DirectEncoderAttempt,
    ) -> Result<DirectRenderMetrics> {
        let fps = self.effective_fps();
        let total_frames = (duration.max(0.1) * fps as f64).ceil().max(1.0) as usize;
        let zones = normalized_blur_zones(
            blur_zones,
            self.settings.output_width,
            self.settings.output_height,
        );
        let filter = if encoder.gpu_overlay {
            format!(
                "[1:v]format=yuva420p,hwupload_cuda[chat_gpu];[0:v][chat_gpu]overlay_cuda=x={x}:y={y}[v]",
                x = self.settings.chat_x,
                y = self.settings.chat_y,
            )
        } else {
            self.align_video_start(
                self.build_direct_filter(&zones, alpha_output.is_some(), encoder.mode),
            )
        };
        let mut cmd = Command::new(&self.ffmpeg);
        cmd.kill_on_drop(true)
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .args(["-y", "-hide_banner", "-nostats", "-benchmark", "-progress", "pipe:2"]);

        // Overlay is always composited on CPU (cheap for a chat region); the GPU is used only
        // for the final encode (h264_qsv/nvenc/amf). The previous GPU-overlay path
        // (overlay_qsv + per-frame rgba hwupload) caused heavy CPU-side format conversion and
        // a large throughput regression on Intel iGPUs, so it is intentionally not used.
        // HW-decode the source so software decode of 1080p60 doesn't bottleneck the CPU;
        // `auto` falls back to software decode if no HW decoder is available (no failure).
        // d3d11va is the faster DirectX path on Windows (auto picked legacy dxva2).
        if encoder.gpu_overlay {
            cmd.args(["-hwaccel", "cuda", "-hwaccel_output_format", "cuda"]);
        } else {
            if let Some(hwaccel) = self.cpu_path_hwaccel() {
                cmd.args(["-hwaccel", hwaccel]);
            }
        }
        cmd.arg("-i").arg(input_video);

        cmd.args([
            "-f",
            "rawvideo",
            "-pix_fmt",
            "rgba",
            "-s",
            &format!("{}x{}", self.settings.chat_width, self.settings.chat_height),
            "-framerate",
            &fps.to_string(),
            "-i",
            "pipe:0",
        ]);

        for zone in zones
            .iter()
            .filter(|zone| zone.effect == BlurEffect::ImageOverlay)
        {
            if let Some(path) = zone
                .image_path
                .as_deref()
                .filter(|path| Path::new(path).is_file())
            {
                cmd.args(["-loop", "1", "-i"]).arg(path);
            }
        }

        cmd.args(["-filter_complex", &filter, "-map", "[v]", "-map", "0:a?"]);
        if let Some(threads) = performance.cpu_threads() {
            cmd.args(["-threads", &threads.to_string()]);
        }
        cmd.args(&encoder.args);
        cmd.args(["-c:a", "copy", "-movflags", "+faststart", "-shortest"]);
        cmd.arg(final_output);

        if let Some(alpha) = alpha_output {
            cmd.args(["-map", "[chat_alpha]", "-an"]);
            cmd.args(alpha_encoder_args(
                self.settings.alpha_output_format,
                self.gpu_encoder_mode,
            ));
            cmd.arg(alpha);
        }

        #[cfg(windows)]
        {
            cmd.creation_flags(0x0800_0000);
        }

        emit_log(
            queue,
            job_id,
            &format!("$ {}", debug_cmd(&self.ffmpeg, &cmd)),
        );
        if diagnostics::stage_bench_enabled()
            && !encoder.gpu_overlay
            && zones.iter().all(|zone| zone.effect != BlurEffect::ImageOverlay)
        {
            diagnostics::run_stage_benchmarks(
                queue,
                job_id,
                &diagnostics::StageContext {
                    ffmpeg: &self.ffmpeg,
                    input: input_video,
                    hwaccel: self.cpu_path_hwaccel(),
                    alt_hwaccel: if cfg!(windows) { "d3d11va" } else { "auto" },
                    filter: &filter,
                    encoder_args: &encoder.args,
                    chat_width: self.settings.chat_width,
                    chat_height: self.settings.chat_height,
                    chat_fps: fps,
                    output_width: self.settings.output_width,
                    output_height: self.settings.output_height,
                    clip_seconds: duration,
                },
            )
            .await;
        }
        let mut child = cmd.spawn().context("spawn ffmpeg direct composer")?;
        crate::win_power::disable_for_pid(child.id());
        let mut stdin = tokio::io::BufWriter::with_capacity(
            8 * 1024 * 1024,
            child.stdin.take().context("ffmpeg stdin handle")?,
        );
        let stderr = child.stderr.take().context("ffmpeg stderr handle")?;
        let q = queue.clone();
        let id = job_id.to_string();
        let ffmpeg_metrics = Arc::new(Mutex::new(FfmpegEncodeMetrics::default()));
        let stderr_metrics = ffmpeg_metrics.clone();
        let stderr_task = tokio::spawn(async move {
            let mut metrics = FfmpegEncodeMetrics::default();
            let mut reader = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = reader.next_line().await {
                if metrics.update_from_line(&line) {
                    if let Ok(mut guard) = stderr_metrics.lock() {
                        *guard = metrics.clone();
                    }
                }
                if is_ffmpeg_progress_line(&line) {
                    continue;
                }
                emit_log(&q, &id, &format!("!! {line}"));
            }
            metrics
        });

        let started = Instant::now();
        emit_log(
            queue,
            job_id,
            &format!(
                "Начало прохода рендеринга:\n\
                 - Режим компоновки (compose mode): Direct\n\
                 - Видеокодек (encoder): {}\n\
                 - Оверлей (overlay): {}\n\
                 - Декодер (decode hwaccel): {}",
                encoder.label,
                if encoder.gpu_overlay {
                    "GPU (overlay_cuda)"
                } else {
                    "CPU"
                },
                if encoder.gpu_overlay {
                    "cuda"
                } else {
                    self.cpu_path_hwaccel().unwrap_or("none (CPU)")
                },
            ),
        );
        let producer = Arc::new(FrameProducer {
            settings: self.settings.clone(),
            timeline,
            render_workers: self.render_workers,
            pool: render_pool(self.render_workers),
        });
        let (mut rx, prod_stats) = producer.spawn(fps, 0..total_frames, cancel.clone());
        let mut done = 0_usize;
        let mut wait_recv = std::time::Duration::ZERO;
        let mut wait_write = std::time::Duration::ZERO;
        let mut pipe_closed_early = false;
        let mut max_write = std::time::Duration::ZERO;
        let mut bytes_written = 0_u64;
        let timeline_step = (total_frames / 10).max(1);
        let mut window_started = Instant::now();
        let mut window_frames = 0_usize;
        loop {
            let recv_started = Instant::now();
            let Some(frame) = rx.recv().await else { break };
            wait_recv += recv_started.elapsed();
            let write_started = Instant::now();
            if let Err(err) = stdin.write_all(frame.as_raw()).await {
                // With `-shortest` ffmpeg legitimately closes stdin once the video input
                // ends, even if the chat timeline runs a few seconds longer. That is a
                // normal completion, not an encoder failure: stop feeding and let the
                // exit status decide. (Previously this re-rendered the whole video on a
                // fallback encoder after a fully successful pass.)
                let broken = err.kind() == std::io::ErrorKind::BrokenPipe
                    || matches!(err.raw_os_error(), Some(109) | Some(232));
                if broken {
                    emit_log(
                        queue,
                        job_id,
                        "Chat overlay: ffmpeg закрыл вход чата раньше конца таймлайна (видео короче, -shortest) — завершаем нормально...",
                    );
                    pipe_closed_early = true;
                    break;
                }
                return Err(anyhow::Error::from(err).context("write direct chat frame to ffmpeg"));
            }
            let write_elapsed = write_started.elapsed();
            wait_write += write_elapsed;
            max_write = max_write.max(write_elapsed);
            bytes_written += frame.as_raw().len() as u64;
            done += 1;
            window_frames += 1;
            if diagnostics::enabled() && done % timeline_step == 0 {
                let window = window_started.elapsed().as_secs_f64().max(0.001);
                let snapshot = snapshot_ffmpeg_metrics(&ffmpeg_metrics);
                emit_log(
                    queue,
                    job_id,
                    &format!(
                        "Диагностика: {:>3}% — chat pipe {:.1} fps за последнее окно, video output {} fps, speed {}",
                        done * 100 / total_frames.max(1),
                        window_frames as f64 / window,
                        format_optional_fps(snapshot.video_output_fps),
                        format_optional_speed(snapshot.speed),
                    ),
                );
                window_started = Instant::now();
                window_frames = 0;
            }
            if done % fps as usize == 0 || done == total_frames {
                let elapsed = started.elapsed().as_secs_f64().max(0.001);
                let current_chat_pipe_metrics = ChatPipeMetrics::new(done, elapsed, fps);
                let eta = if current_chat_pipe_metrics.fps > 0.01 {
                    Some(format_duration(
                        (total_frames - done) as f64 / current_chat_pipe_metrics.fps,
                    ))
                } else {
                    None
                };
                let metrics = snapshot_ffmpeg_metrics(&ffmpeg_metrics);
                queue.set_progress(
                    job_id,
                    JobProgress {
                        percent: (done as f32 / total_frames as f32) * 90.0,
                        stage_percent: None,
                        stage_start: None,
                        stage_end: None,
                        stage_started_at: None,
                        download_elapsed_ms: None,
                        speed: metrics.speed.map(format_speed_value),
                        eta: eta.clone(),
                        size: None,
                        message: Some(render_progress_message(
                            &metrics,
                            Some(current_chat_pipe_metrics.fps),
                        )),
                        ..JobProgress::default()
                    },
                );
            }
        }
        // Stop the producer immediately (it blocks on a full channel otherwise and would
        // keep rasterizing during ffmpeg finalization, e.g. the faststart moov pass).
        drop(rx);
        if cancel.load(Ordering::SeqCst) {
            let _ = child.kill().await;
            return Err(anyhow!("cancelled"));
        }
        if !pipe_closed_early {
            let _ = stdin.flush().await;
        }
        let chat_pipe_metrics = ChatPipeMetrics::new(done, started.elapsed().as_secs_f64(), fps);
        if diagnostics::enabled() && done > 0 {
            emit_log(
                queue,
                job_id,
                &format!(
                    "Диагностика: пайп чата {:.0} МБ ({:.2} МБ/кадр, {:.1} МБ/с), запись в ffmpeg: среднее {:.2} мс/кадр, максимум {:.0} мс; растеризовано уникальных кадров {} из {} ({:.0}% дедуп)",
                    bytes_written as f64 / 1_048_576.0,
                    bytes_written as f64 / done as f64 / 1_048_576.0,
                    bytes_written as f64 / 1_048_576.0 / started.elapsed().as_secs_f64().max(0.001),
                    wait_write.as_secs_f64() * 1000.0 / done as f64,
                    max_write.as_secs_f64() * 1000.0,
                    prod_stats.frames.load(Ordering::Relaxed),
                    done,
                    100.0 - prod_stats.frames.load(Ordering::Relaxed) as f64 * 100.0 / done as f64,
                ),
            );
        }
        drop(stdin);

        let mut final_ffmpeg_metrics = loop {
            if cancel.load(Ordering::SeqCst) {
                let _ = child.kill().await;
                return Err(anyhow!("cancelled"));
            }
            match child.try_wait()? {
                Some(status) => {
                    let metrics = stderr_task.await.unwrap_or_default();
                    if !status.success() {
                        return Err(anyhow!("ffmpeg direct composer exited with {status}"));
                    }
                    break metrics;
                }
                None => {
                    let metrics = snapshot_ffmpeg_metrics(&ffmpeg_metrics);
                    queue.set_progress(
                        job_id,
                        JobProgress {
                            percent: 95.0,
                            stage_percent: None,
                            stage_start: None,
                            stage_end: None,
                            stage_started_at: None,
                            download_elapsed_ms: None,
                            speed: metrics.speed.map(format_speed_value),
                            eta: None,
                            size: None,
                            message: Some(render_progress_message(
                                &metrics,
                                Some(chat_pipe_metrics.fps),
                            )),
                            ..JobProgress::default()
                        },
                    );
                    tokio::time::sleep(std::time::Duration::from_millis(1000)).await;
                }
            }
        };

        let total_elapsed = started.elapsed().as_secs_f64().max(0.001);
        if final_ffmpeg_metrics.video_output_fps.is_none() {
            final_ffmpeg_metrics.video_output_fps = final_ffmpeg_metrics
                .frame
                .map(|frame| frame as f64 / total_elapsed);
        }
        let wall_speed = duration.max(0.001) / total_elapsed;
        emit_log(
            queue,
            job_id,
            &format!(
                "Итог прохода (Direct): video output {} кадров за {:.1}s ({} video-fps, ffmpeg speed {}, total wall-clock speed {}); chat pipe {} кадров за {:.1}s ({:.1} chat pipe fps, pipe speed {:.2}x)",
                final_ffmpeg_metrics
                    .frame
                    .map(|frame| frame.to_string())
                    .unwrap_or_else(|| "n/a".to_string()),
                total_elapsed,
                format_optional_fps(final_ffmpeg_metrics.video_output_fps),
                format_optional_speed(final_ffmpeg_metrics.speed),
                format_speed_value(wall_speed),
                chat_pipe_metrics.frames,
                chat_pipe_metrics.elapsed_seconds,
                chat_pipe_metrics.fps,
                chat_pipe_metrics.speed_ratio(),
            ),
        );
        emit_profile(
            queue,
            job_id,
            wait_recv,
            wait_write,
            &prod_stats,
            final_ffmpeg_metrics.video_output_fps,
        );

        queue.set_progress(
            job_id,
            JobProgress {
                percent: 100.0,
                stage_percent: None,
                stage_start: None,
                stage_end: None,
                stage_started_at: None,
                download_elapsed_ms: None,
                speed: Some(format!("wall {}", format_speed_value(wall_speed))),
                eta: None,
                size: None,
                message: Some(render_progress_message(
                    &final_ffmpeg_metrics,
                    Some(chat_pipe_metrics.fps),
                )),
                ..JobProgress::default()
            },
        );
        Ok(DirectRenderMetrics {
            frame: final_ffmpeg_metrics.frame,
            video_output_fps: final_ffmpeg_metrics.video_output_fps,
            ffmpeg_speed: final_ffmpeg_metrics.speed,
            chat_pipe_fps: chat_pipe_metrics.fps,
            elapsed_seconds: total_elapsed,
            wall_speed,
        })
    }

    fn build_direct_filter(
        &self,
        zones: &[BlurZone],
        save_alpha: bool,
        _mode: GpuEncoderMode,
    ) -> String {
        // No blur zones and no chat-backdrop blur: overlay the chat directly on the source
        // (no rescale) using the CPU `overlay` filter. The selected HW encoder still encodes.
        let chat_in = self.direct_chat_input_filter();
        let blur_bg = self.chat_background_blur_active();
        if zones.is_empty() && !blur_bg {
            return if save_alpha {
                format!(
                    "{chat_in},split[chat_for_overlay][chat_alpha];\
                    [0:v][chat_for_overlay]overlay={x}:{y}:format=yuv420[v]",
                    x = self.settings.chat_x,
                    y = self.settings.chat_y,
                )
            } else {
                format!(
                    "{chat_in}[chat_for_overlay];\
                    [0:v][chat_for_overlay]overlay={x}:{y}:format=yuv420[v]",
                    x = self.settings.chat_x,
                    y = self.settings.chat_y,
                )
            };
        }

        {
            // No fps= here: the whole video is re-encoded anyway, and forcing the
            // settings rate (60 by default) doubled every frame of a 30 fps source
            // through blur, overlay and encoder. The no-blur graph keeps the source
            // rate too.
            let mut filter = if self.source_matches_output() {
                "[0:v]setsar=1[base0];".to_string()
            } else {
                format!(
                    "[0:v]scale={w}:{h}:force_original_aspect_ratio=decrease,\
pad={w}:{h}:(ow-iw)/2:(oh-ih)/2,setsar=1[base0];",
                    w = self.settings.output_width,
                    h = self.settings.output_height,
                )
            };
            let mut current = "base0".to_string();
            let mut image_input = 2;
            append_blur_zone_filters(&mut filter, &mut current, zones, &mut image_input);
            if blur_bg {
                // Blur and chat are composed on the small crop first, so the full frame
                // is overlaid once instead of twice (one fewer 1080p pass per frame).
                let (w, h) = (
                    self.overlay_target_width.max(1),
                    self.overlay_target_height.max(1),
                );
                let (x, y) = (self.settings.chat_x, self.settings.chat_y);
                let chain = gaussian_chain(BlurQuality::Balanced, 18.0, w, h);
                let chat_tail = if save_alpha {
                    ",split[chat_for_overlay][chat_alpha]"
                } else {
                    "[chat_for_overlay]"
                };
                filter.push_str(&format!(
                    "[{current}]split=2[{current}m][{current}c];[{current}c]crop=w={w}:h={h}:x={x}:y={y},{chain}[chat_backdrop];{chat_in}{chat_tail};[chat_backdrop][chat_for_overlay]overlay=0:0:format=yuv420[chat_patch];[{current}m][chat_patch]overlay={x}:{y}:format=yuv420[v]",
                ));
                return filter;
            }
            if save_alpha {
                filter.push_str(&format!(
                    "{chat_in},split[chat_for_overlay][chat_alpha];[{current}][chat_for_overlay]overlay={x}:{y}:format=yuv420[v]",
                    x = self.settings.chat_x,
                    y = self.settings.chat_y,
                ));
            } else {
                filter.push_str(&format!(
                    "{chat_in}[chat_for_overlay];[{current}][chat_for_overlay]overlay={x}:{y}:format=yuv420[v]",
                    x = self.settings.chat_x,
                    y = self.settings.chat_y,
                ));
            }
            filter
        }
    }

    /// Frosted-glass chat backdrop: blur the video region behind the chat box before the
    /// chat (with its semi-transparent background) is overlaid. Skipped for the opaque
    /// solid-background codec, where a blurred underlay would be invisible.
    /// Decoder for the CPU-overlay path. Frames must end up in system memory for the
    /// CPU filters, and the stage benchmark showed multithreaded software decode beating
    /// d3d11va + download (≈25% faster, less kernel time) up to 1440p. Heavier sources
    /// (4K, unknown size) keep hardware decode to spare the CPU.
    fn cpu_path_hwaccel(&self) -> Option<&'static str> {
        match self.source_size {
            Some((_, h)) if h <= 1440 => None,
            _ => Some(if cfg!(windows) { "d3d11va" } else { "auto" }),
        }
    }

    /// Twitch clips start their video ~1 s after the audio. mp4 stores that gap as an
    /// edit list, which many players ignore and then run the picture a second early for
    /// the whole video. Filling the gap with the first frame (`fps` + `start_time=0`)
    /// makes the video start at 0 like the audio, so every player stays in sync.
    fn align_video_start(&self, filter: String) -> String {
        let Some(fps) = self.late_video_start else {
            return filter;
        };
        if !filter.contains("[0:v]") {
            return filter;
        }
        format!(
            "[0:v]fps=fps={fps:.6}:start_time=0[main_aligned];{}",
            filter.replacen("[0:v]", "[main_aligned]", 1)
        )
    }

    fn source_matches_output(&self) -> bool {
        self.source_size == Some((self.settings.output_width, self.settings.output_height))
    }

    fn chat_background_blur_active(&self) -> bool {
        self.settings.background_enabled
            && self.settings.background_blur_enabled
            && self.settings.render_codec != ChatRenderCodec::SolidBgFast
    }

    /// `[1:v]` (the raw chat pipe) prefix for the direct filter graph. With supersampling
    /// the chat is piped in at N× resolution and scaled back down here before the overlay,
    /// so its on-video size is unchanged while glyph/emote edges stay crisp.
    fn direct_chat_input_filter(&self) -> String {
        if self.supersample > 1.0 {
            format!(
                "[1:v]format=rgba,scale={w}:{h}:flags=lanczos",
                w = self.overlay_target_width,
                h = self.overlay_target_height,
            )
        } else {
            "[1:v]format=rgba".to_string()
        }
    }

    async fn render_to_mov_pipe_parallel(
        &mut self,
        messages: &[ChatMessage],
        duration: f64,
        output: &Path,
        queue: &Arc<QueueManager>,
        job_id: &str,
        cancel: Arc<AtomicBool>,
    ) -> Result<ChatPipeMetrics> {
        let fps = self.effective_fps();
        let total_frames = (duration.max(0.1) * fps as f64).ceil().max(1.0) as usize;
        let prep_started = Instant::now();
        let timeline = Arc::new(
            self.build_timeline(messages, Some(queue), Some(job_id))
                .await,
        );
        emit_log(
            queue,
            job_id,
            &format!(
                "Chat overlay: message preparation time {}",
                format_duration(prep_started.elapsed().as_secs_f64())
            ),
        );
        let mut child = self
            .spawn_raw_overlay_encoder(output, fps, queue, job_id)
            .await?;
        let mut stdin = tokio::io::BufWriter::with_capacity(
            8 * 1024 * 1024,
            child.stdin.take().context("ffmpeg stdin handle")?,
        );
        let stderr = child.stderr.take().context("ffmpeg stderr handle")?;
        let q = queue.clone();
        let id = job_id.to_string();
        let stderr_task = tokio::spawn(async move {
            let mut reader = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = reader.next_line().await {
                emit_log(&q, &id, &format!("!! {line}"));
            }
        });

        let started = Instant::now();
        emit_log(
            queue,
            job_id,
            &format!(
                "Начало прохода рендеринга:\n\
                 - Режим компоновки (compose mode): Intermediate (Pass 1 - render chat only)\n\
                 - Видеокодек (encoder): {}\n\
                 - Оверлей (overlay): CPU\n\
                 - Декодер (decode hwaccel): none",
                match self.settings.alpha_output_format {
                    AlphaOutputFormat::MovPng => "png (MOV, multithreaded)",
                    AlphaOutputFormat::MovQtrle => "qtrle (MOV animation)",
                    AlphaOutputFormat::WebmVp9 => "vp9 (WebM)",
                    AlphaOutputFormat::WebmVp8 => "vp8 (WebM)",
                    AlphaOutputFormat::Ffv1Mkv => "ffv1 (MKV)",
                    AlphaOutputFormat::Prores4444 => "prores_ks",
                    AlphaOutputFormat::LagarithAvi => "lagarith",
                }
            ),
        );
        let producer = Arc::new(FrameProducer {
            settings: self.settings.clone(),
            timeline,
            render_workers: self.render_workers,
            pool: render_pool(self.render_workers),
        });
        let (mut rx, prod_stats) = producer.spawn(fps, 0..total_frames, cancel.clone());
        let mut done = 0_usize;
        let mut wait_recv = std::time::Duration::ZERO;
        let mut wait_write = std::time::Duration::ZERO;
        loop {
            let recv_started = Instant::now();
            let Some(frame) = rx.recv().await else { break };
            wait_recv += recv_started.elapsed();
            let write_started = Instant::now();
            stdin
                .write_all(frame.as_raw())
                .await
                .context("write chat overlay frame to ffmpeg")?;
            wait_write += write_started.elapsed();
            done += 1;
            if done % fps as usize == 0 || done == total_frames {
                let percent = (done as f32 / total_frames as f32) * 75.0;
                let elapsed = started.elapsed().as_secs_f64().max(0.001);
                let chat_pipe_fps = done as f64 / elapsed;
                let avg_ms = elapsed * 1000.0 / done as f64;
                let eta = if chat_pipe_fps > 0.01 {
                    Some(format_duration(
                        (total_frames - done) as f64 / chat_pipe_fps,
                    ))
                } else {
                    None
                };
                queue.set_progress(
                    job_id,
                    JobProgress {
                        percent,
                        stage_percent: None,
                        stage_start: None,
                        stage_end: None,
                        stage_started_at: None,
                        download_elapsed_ms: None,
                        speed: None,
                        eta: eta.clone(),
                        size: None,
                        message: Some(format!(
                            "Рендер MOV альфа чата: {done}/{total_frames} кадров, {chat_pipe_fps:.1} chat-fps, {avg_ms:.1} ms/frame{}",
                            eta.as_deref()
                                .map(|value| format!(", осталось {value}"))
                                .unwrap_or_default()
                        )),
                        ..JobProgress::default()
                    },
                );
            }
        }
        if cancel.load(Ordering::SeqCst) {
            let _ = child.kill().await;
            return Err(anyhow!("cancelled"));
        }
        let elapsed = started.elapsed().as_secs_f64().max(0.001);
        let chat_pipe_metrics = ChatPipeMetrics::new(done, elapsed, fps);
        emit_log(
            queue,
            job_id,
            &format!(
                "Итог прохода (Intermediate Pass 1): {} chat pipe кадров отправлено за {:.1}s ({:.1} chat pipe fps, pipe speed {:.2}x)",
                chat_pipe_metrics.frames,
                chat_pipe_metrics.elapsed_seconds,
                chat_pipe_metrics.fps,
                chat_pipe_metrics.speed_ratio()
            ),
        );
        emit_profile(queue, job_id, wait_recv, wait_write, &prod_stats, None);

        drop(stdin);

        loop {
            if cancel.load(Ordering::SeqCst) {
                let _ = child.kill().await;
                return Err(anyhow!("cancelled"));
            }
            match child.try_wait()? {
                Some(status) => {
                    let _ = stderr_task.await;
                    if !status.success() {
                        return Err(anyhow!("ffmpeg overlay encoder exited with {status}"));
                    }
                    break;
                }
                None => tokio::time::sleep(std::time::Duration::from_millis(200)).await,
            }
        }

        queue.set_progress(
            job_id,
            JobProgress {
                percent: 75.0,
                stage_percent: None,
                stage_start: None,
                stage_end: None,
                stage_started_at: None,
                download_elapsed_ms: None,
                speed: None,
                eta: None,
                size: None,
                message: Some("MOV RLE чат отрендерен".to_string()),
                ..JobProgress::default()
            },
        );
        emit_log(
            queue,
            job_id,
            &format!(
                "Chat overlay: overlay render time {}",
                format_duration(started.elapsed().as_secs_f64())
            ),
        );
        Ok(chat_pipe_metrics)
    }

    async fn render_to_mov_png_sequence(
        &mut self,
        messages: &[ChatMessage],
        duration: f64,
        output: &Path,
        queue: &Arc<QueueManager>,
        job_id: &str,
        cancel: Arc<AtomicBool>,
    ) -> Result<ChatPipeMetrics> {
        let frames_dir = self.work_dir.join("frames");
        if frames_dir.is_dir() {
            let _ = std::fs::remove_dir_all(&frames_dir);
        }
        std::fs::create_dir_all(&frames_dir)
            .with_context(|| format!("create {}", frames_dir.display()))?;

        let fps = self.effective_fps();
        let total_frames = (duration.max(0.1) * fps as f64).ceil().max(1.0) as usize;
        let prep_started = Instant::now();
        let timeline = Arc::new(
            self.build_timeline(messages, Some(queue), Some(job_id))
                .await,
        );
        emit_log(
            queue,
            job_id,
            &format!(
                "Chat overlay: message preparation time {}",
                format_duration(prep_started.elapsed().as_secs_f64())
            ),
        );
        let started = Instant::now();
        let producer = Arc::new(FrameProducer {
            settings: self.settings.clone(),
            timeline,
            render_workers: self.render_workers,
            pool: render_pool(self.render_workers),
        });
        let (mut rx, _prod_stats) = producer.spawn(fps, 0..total_frames, cancel.clone());
        let mut done = 0_usize;
        while let Some(frame) = rx.recv().await {
            let path = frames_dir.join(format!("frame_{done:06}.png"));
            frame
                .save(&path)
                .with_context(|| format!("save {}", path.display()))?;
            done += 1;
            if done % fps as usize == 0 || done == total_frames {
                let elapsed = started.elapsed().as_secs_f64().max(0.001);
                let render_fps = done as f64 / elapsed;
                let avg_ms = elapsed * 1000.0 / done as f64;
                let eta = if render_fps > 0.01 {
                    Some(format_duration((total_frames - done) as f64 / render_fps))
                } else {
                    None
                };
                queue.set_progress(
                    job_id,
                    JobProgress {
                        percent: (done as f32 / total_frames as f32) * 70.0,
                        stage_percent: None,
                        stage_start: None,
                        stage_end: None,
                        stage_started_at: None,
                        download_elapsed_ms: None,
                        speed: None,
                        eta: eta.clone(),
                        size: None,
                        message: Some(format!(
                            "Rendering chat PNG frames: {done}/{total_frames}, {render_fps:.1} fps, {avg_ms:.1} ms/frame{}",
                            eta.as_deref()
                                .map(|value| format!(", ETA {value}"))
                                .unwrap_or_default()
                        )),
                        ..JobProgress::default()
                    },
                );
            }
        }
        if cancel.load(Ordering::SeqCst) {
            return Err(anyhow!("cancelled"));
        }

        let elapsed = started.elapsed().as_secs_f64().max(0.001);
        let chat_pipe_metrics = ChatPipeMetrics::new(done, elapsed, fps);
        self.encode_mov_from_frames(&frames_dir, output, queue, job_id, cancel)
            .await?;
        Ok(chat_pipe_metrics)
    }

    pub(crate) async fn prepare_assets(
        &mut self,
        messages: &[ChatMessage],
        queue: &Arc<QueueManager>,
        job_id: &str,
    ) {
        let mut unique_badges = HashSet::new();
        let mut unique_emotes = HashSet::new();
        for message in messages {
            if self.settings.show_badges {
                for badge in &message.badges {
                    if let Some(url) = badge_render_url(badge) {
                        unique_badges.insert((badge.provider.clone(), badge.id.clone(), url));
                    }
                }
            }
            for fragment in &message.fragments {
                if let ChatFragment::Emote {
                    provider, id, url, ..
                } = fragment
                {
                    unique_emotes.insert((provider.clone(), id.clone(), url.clone()));
                }
            }
        }

        let total_assets = unique_badges.len() + unique_emotes.len();
        if total_assets > 0 {
            queue.set_progress(
                job_id,
                JobProgress {
                    percent: 0.0,
                    stage_percent: None,
                    stage_start: None,
                    stage_end: None,
                    stage_started_at: None,
                    download_elapsed_ms: None,
                    speed: None,
                    eta: None,
                    size: None,
                    message: Some(format!("Preparing emotes/badges: 0/{total_assets}")),
                    ..JobProgress::default()
                },
            );
        }
        let started = Instant::now();
        let preload_limit = self.asset_workers;
        if total_assets > 0 {
            emit_log(
                queue,
                job_id,
                &format!(
                    "Chat overlay: preloading {total_assets} emote/badge assets with {preload_limit} worker(s)"
                ),
            );
        }
        let loaded_assets = self
            .badges
            .preload_many(
                unique_badges.into_iter().collect(),
                preload_limit,
                queue,
                job_id,
                0,
                total_assets,
            )
            .await;
        self.emotes
            .preload_many(
                unique_emotes.into_iter().collect(),
                preload_limit,
                queue,
                job_id,
                loaded_assets,
                total_assets,
            )
            .await;
        self.layout
            .set_image_dimensions(self.loaded_image_dimensions(messages));
        if total_assets > 0 {
            update_asset_progress(queue, job_id, total_assets, total_assets);
            emit_log(
                queue,
                job_id,
                &format!(
                    "Chat overlay: asset preload time {}",
                    format_duration(started.elapsed().as_secs_f64())
                ),
            );
        }
    }

    fn loaded_image_dimensions(&self, messages: &[ChatMessage]) -> HashMap<String, (u32, u32)> {
        let mut dimensions = HashMap::new();
        for message in messages {
            if self.settings.show_badges {
                for badge in &message.badges {
                    let Some(url) = badge_render_url(badge) else {
                        continue;
                    };
                    if let Some(image) = self.badges.get(&badge.provider, &badge.id, &url) {
                        dimensions.insert(
                            image_dimension_key(&badge.provider, &badge.id, &url, true),
                            (image.width(), image.height()),
                        );
                    }
                }
            }
            for fragment in &message.fragments {
                let ChatFragment::Emote {
                    provider, id, url, ..
                } = fragment
                else {
                    continue;
                };
                if let Some(image) = self.emotes.get(provider, id, url) {
                    dimensions.insert(
                        image_dimension_key(provider, id, url, false),
                        image.dimensions(),
                    );
                }
            }
        }
        dimensions
    }

    async fn build_timeline(
        &mut self,
        messages: &[ChatMessage],
        queue: Option<&Arc<QueueManager>>,
        job_id: Option<&str>,
    ) -> Vec<TimelineMessage> {
        let total = messages.len();
        let mut timeline = Vec::with_capacity(total);
        for (idx, message) in messages.iter().enumerate() {
            let layout = self
                .layout
                .layout_message(message, &self.text_font, &self.username_font);
            let prepared = self.prepare_message_bitmap(&layout);
            timeline.push(TimelineMessage {
                start: message.timestamp,
                end: message.timestamp + self.settings.message_lifetime_sec,
                stable_key: message.stable_key(),
                prepared,
            });

            if let (Some(queue), Some(job_id)) = (queue, job_id) {
                if total > 0 && (idx + 1 == total || (idx + 1) % 200 == 0) {
                    let done = idx + 1;
                    let pct = (done as f32 / total as f32) * 100.0;
                    queue.set_progress(
                        job_id,
                        JobProgress {
                            percent: pct,
                            message: Some(format!(
                                "Preparing chat timeline: {done}/{total} messages ({pct:.1}%)"
                            )),
                            ..JobProgress::default()
                        },
                    );
                }
            }

            if idx % 100 == 0 {
                tokio::task::yield_now().await;
            }
        }
        timeline.sort_by(|a, b| a.start.total_cmp(&b.start));
        timeline
    }

    fn prepare_message_bitmap(&mut self, layout: &LayoutMessage) -> PreparedMessage {
        let mut static_image =
            RgbaImage::from_pixel(self.settings.chat_width, layout.height, Rgba([0, 0, 0, 0]));
        let mut animated_runs = Vec::new();
        self.draw_layout_static_prepared(&mut static_image, layout, &mut animated_runs);
        PreparedMessage {
            height: layout.height,
            static_image: crop_to_drawn_width(static_image),
            animated_runs,
        }
    }

    /// Effective chat overlay frame rate. The overlay filter repeats the lower-rate chat
    /// input to match the source video fps, so a lower chat fps cuts rasterization cost
    /// proportionally without touching output video quality. Turbo trades smoothness for speed.
    fn effective_fps(&self) -> u32 {
        let fps = self.settings.chat_overlay_fps.max(1);
        if self.turbo {
            fps.min(15)
        } else {
            fps
        }
    }

    fn draw_layout_static_prepared(
        &mut self,
        canvas: &mut RgbaImage,
        layout: &LayoutMessage,
        animated_runs: &mut Vec<PreparedAnimatedRun>,
    ) {
        let username_font = self.username_font.clone();
        let text_font = self.text_font.clone();
        let font_size = self.settings.font_size;
        let scale = PxScale::from(font_size);

        let outline_thickness = if self.settings.outline_enabled {
            self.settings.outline_thickness as i32
        } else {
            0
        };
        let outline_color = parse_color(&self.settings.outline_color, [0, 0, 0, 255]);

        for run in &layout.runs {
            let x = run.x;
            let y = run.y;
            match &run.kind {
                LayoutRunKind::Text { text, role } => {
                    let is_username = *role == TextRole::Username;
                    let fonts = if is_username {
                        &username_font
                    } else {
                        &text_font
                    };
                    let ascent = fonts.ascent(scale).round() as i32;
                    let baseline_y = y + ascent;

                    // 1. Draw outlines
                    if outline_thickness > 0 {
                        let mut curr_x = x;
                        for ch in text.chars() {
                            let h_adv = fonts.h_advance(scale, ch).round() as i32;
                            {
                                let cached = self.get_or_create_glyph(ch, is_username);
                                if cached.outline_width > 0 && cached.outline_height > 0 {
                                    let start_x = curr_x + cached.bounds_min_x - outline_thickness;
                                    let start_y =
                                        baseline_y + cached.bounds_min_y - outline_thickness;
                                    for y_idx in 0..cached.outline_height {
                                        for x_idx in 0..cached.outline_width {
                                            let val = cached.outline_mask
                                                [(y_idx * cached.outline_width + x_idx) as usize];
                                            if val > 0 {
                                                blend_pixel(
                                                    canvas,
                                                    start_x + x_idx as i32,
                                                    start_y + y_idx as i32,
                                                    Rgba(outline_color),
                                                    val,
                                                );
                                            }
                                        }
                                    }
                                }
                            }
                            curr_x += h_adv;
                        }
                    }

                    // 2. Draw clean text
                    let mut curr_x = x;
                    for ch in text.chars() {
                        let h_adv = fonts.h_advance(scale, ch).round() as i32;
                        {
                            let cached = self.get_or_create_glyph(ch, is_username);
                            if cached.width > 0 && cached.height > 0 {
                                let start_x = curr_x + cached.bounds_min_x;
                                let start_y = baseline_y + cached.bounds_min_y;
                                for y_idx in 0..cached.height {
                                    for x_idx in 0..cached.width {
                                        let val = cached.clean_mask
                                            [(y_idx * cached.width + x_idx) as usize];
                                        if val > 0 {
                                            blend_pixel(
                                                canvas,
                                                start_x + x_idx as i32,
                                                start_y + y_idx as i32,
                                                Rgba(run.color),
                                                val,
                                            );
                                        }
                                    }
                                }
                            }
                        }
                        curr_x += h_adv;
                    }
                }
                LayoutRunKind::Image {
                    provider,
                    id,
                    url,
                    placeholder,
                    is_badge,
                    ..
                } => {
                    if *is_badge {
                        let key = (provider.clone(), id.clone(), run.width, run.height);
                        let resolved = match self.scaled_badges.get(&key).cloned() {
                            Some(img) => Some(img),
                            None => {
                                let computed = self.badges.get(provider, id, url).map(|img| {
                                    Arc::new(resize_image_to_rgba(img, run.width, run.height))
                                });
                                if let Some(img) = &computed {
                                    self.scaled_badges.insert(key, img.clone());
                                }
                                computed
                            }
                        };
                        if let Some(img) = resolved {
                            draw_rgba_image(canvas, &img, x, y, run.height);
                        } else {
                            self.draw_placeholder(canvas, placeholder, x, y, font_size);
                        }
                    } else {
                        let key = (provider.clone(), id.clone(), run.width, run.height);
                        let resolved = match self.scaled_emotes.get(&key).cloned() {
                            Some(entry) => Some(entry),
                            None => {
                                let computed = self.emotes.get(provider, id, url).map(|animated| {
                                    (
                                        Arc::new(animated.scaled_rgba(run.width, run.height)),
                                        animated.is_animated(),
                                    )
                                });
                                if let Some(entry) = &computed {
                                    self.scaled_emotes.insert(key, entry.clone());
                                }
                                computed
                            }
                        };
                        match resolved {
                            Some((frames, true)) => animated_runs.push(PreparedAnimatedRun {
                                x,
                                y,
                                height: run.height,
                                frames,
                            }),
                            Some((frames, false)) => {
                                draw_rgba_image(canvas, frames.frame_at(0.0), x, y, run.height);
                            }
                            None => self.draw_placeholder(canvas, placeholder, x, y, font_size),
                        }
                    }
                }
            }
        }
    }

    fn draw_placeholder(
        &self,
        canvas: &mut RgbaImage,
        placeholder: &str,
        x: i32,
        y: i32,
        scale: f32,
    ) {
        let text = format!("[{placeholder}]");
        draw_text_mut(
            canvas,
            Rgba([255, 255, 255, 255]),
            x,
            y,
            scale,
            self.text_font.primary(),
            &text,
        );
    }

    async fn spawn_raw_overlay_encoder(
        &self,
        output: &Path,
        fps: u32,
        queue: &Arc<QueueManager>,
        job_id: &str,
    ) -> Result<tokio::process::Child> {
        let size = format!("{}x{}", self.settings.chat_width, self.settings.chat_height);
        let mut cmd = Command::new(&self.ffmpeg);
        cmd.kill_on_drop(true)
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .args([
                "-y",
                "-hide_banner",
                "-f",
                "rawvideo",
                "-pix_fmt",
                "rgba",
                "-s",
                &size,
                "-framerate",
                &fps.to_string(),
                "-i",
                "pipe:0",
            ])
            .args(alpha_encoder_args(
                self.settings.alpha_output_format,
                self.gpu_encoder_mode,
            ))
            .arg(output);

        #[cfg(windows)]
        {
            cmd.creation_flags(0x0800_0000);
        }

        emit_log(
            queue,
            job_id,
            &format!("$ {}", debug_cmd(&self.ffmpeg, &cmd)),
        );
        cmd.spawn().context("spawn ffmpeg overlay encoder")
    }

    async fn encode_mov_from_frames(
        &self,
        frames_dir: &Path,
        output: &Path,
        queue: &Arc<QueueManager>,
        job_id: &str,
        cancel: Arc<AtomicBool>,
    ) -> Result<()> {
        let pattern = frames_dir.join("frame_%06d.png");
        let mut cmd = Command::new(&self.ffmpeg);
        cmd.kill_on_drop(true)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .args([
                "-y",
                "-hide_banner",
                "-framerate",
                &self.settings.chat_overlay_fps.to_string(),
                "-i",
            ])
            .arg(&pattern)
            .args(alpha_encoder_args(
                self.settings.alpha_output_format,
                self.gpu_encoder_mode,
            ))
            .arg(output);

        #[cfg(windows)]
        {
            cmd.creation_flags(0x0800_0000);
        }

        emit_log(
            queue,
            job_id,
            &format!("$ {}", debug_cmd(&self.ffmpeg, &cmd)),
        );
        let mut child = cmd.spawn().context("spawn ffmpeg overlay encoder")?;
        crate::win_power::disable_for_pid(child.id());
        let stderr = child.stderr.take().context("stderr handle")?;
        let q = queue.clone();
        let id = job_id.to_string();
        let stderr_task = tokio::spawn(async move {
            let mut reader = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = reader.next_line().await {
                emit_log(&q, &id, &format!("!! {line}"));
            }
        });

        loop {
            if cancel.load(Ordering::SeqCst) {
                let _ = child.kill().await;
                return Err(anyhow!("cancelled"));
            }
            match child.try_wait()? {
                Some(status) => {
                    let _ = stderr_task.await;
                    if !status.success() {
                        return Err(anyhow!("ffmpeg overlay encoder exited with {status}"));
                    }
                    break;
                }
                None => tokio::time::sleep(std::time::Duration::from_millis(200)).await,
            }
        }

        queue.set_progress(
            job_id,
            JobProgress {
                percent: 75.0,
                stage_percent: None,
                stage_start: None,
                stage_end: None,
                stage_started_at: None,
                download_elapsed_ms: None,
                speed: None,
                eta: None,
                size: None,
                message: Some("Transparent chat overlay encoded".to_string()),
                ..JobProgress::default()
            },
        );
        Ok(())
    }

    fn get_or_create_glyph(&mut self, ch: char, is_username: bool) -> &CachedGlyph {
        let cache = if is_username {
            &mut self.glyph_cache.username_glyphs
        } else {
            &mut self.glyph_cache.text_glyphs
        };

        cache.entry(ch).or_insert_with(|| {
            let fonts = if is_username {
                &self.username_font
            } else {
                &self.text_font
            };
            // The character may not exist in the chosen font: draw it from the font that has it,
            // or it comes out as the empty .notdef box.
            let font = fonts.font_for(ch);
            let scale = PxScale::from(self.settings.font_size);
            let glyph = font
                .glyph_id(ch)
                .with_scale_and_position(scale, ab_glyph::point(0.0, 0.0));

            let outline_thickness = if self.settings.outline_enabled {
                self.settings.outline_thickness as i32
            } else {
                0
            };

            if let Some(outlined) = font.outline_glyph(glyph) {
                let bounds = outlined.px_bounds();
                let width = (bounds.max.x - bounds.min.x).max(0.0) as u32;
                let height = (bounds.max.y - bounds.min.y).max(0.0) as u32;
                let mut clean_mask = vec![0u8; (width * height) as usize];
                outlined.draw(|x, y, coverage| {
                    if x < width && y < height {
                        let idx = (y * width + x) as usize;
                        clean_mask[idx] = (coverage * 255.0).round().clamp(0.0, 255.0) as u8;
                    }
                });

                let (outline_width, outline_height, outline_mask) =
                    if outline_thickness > 0 && width > 0 && height > 0 {
                        let out_w = width + 2 * outline_thickness as u32;
                        let out_h = height + 2 * outline_thickness as u32;
                        let out_mask = dilate_mask(&clean_mask, width, height, outline_thickness);
                        (out_w, out_h, out_mask)
                    } else {
                        (0, 0, Vec::new())
                    };

                CachedGlyph {
                    width,
                    height,
                    bounds_min_x: bounds.min.x.round() as i32,
                    bounds_min_y: bounds.min.y.round() as i32,
                    clean_mask,
                    outline_width,
                    outline_height,
                    outline_mask,
                }
            } else {
                CachedGlyph {
                    width: 0,
                    height: 0,
                    bounds_min_x: 0,
                    bounds_min_y: 0,
                    clean_mask: Vec::new(),
                    outline_width: 0,
                    outline_height: 0,
                    outline_mask: Vec::new(),
                }
            }
        })
    }
}

fn fill_canvas(canvas: &mut RgbaImage, color: [u8; 4]) {
    for pixel in canvas.as_mut().chunks_exact_mut(4) {
        pixel.copy_from_slice(&color);
    }
}

fn dilate_mask(clean_mask: &[u8], width: u32, height: u32, r: i32) -> Vec<u8> {
    // A square (2r+1)² max-dilation equals a horizontal then a vertical 1-D max pass.
    let r = r.max(0) as usize;
    let (w, h) = (width as usize, height as usize);
    let (out_w, out_h) = (w + 2 * r, h + 2 * r);
    let mut horiz = vec![0u8; out_w * h];
    for y in 0..h {
        let src = &clean_mask[y * w..(y + 1) * w];
        let dst = &mut horiz[y * out_w..(y + 1) * out_w];
        for (x, &val) in src.iter().enumerate() {
            if val > 0 {
                for cell in &mut dst[x..=x + 2 * r] {
                    *cell = (*cell).max(val);
                }
            }
        }
    }
    let mut out = vec![0u8; out_w * out_h];
    for y in 0..h {
        let src = &horiz[y * out_w..(y + 1) * out_w];
        for dy in 0..=2 * r {
            let dst = &mut out[(y + dy) * out_w..(y + dy + 1) * out_w];
            for (d, &s) in dst.iter_mut().zip(src) {
                *d = (*d).max(s);
            }
        }
    }
    out
}

fn blend_pixel(canvas: &mut RgbaImage, x: i32, y: i32, color: Rgba<u8>, alpha: u8) {
    if x < 0 || y < 0 || x >= canvas.width() as i32 || y >= canvas.height() as i32 {
        return;
    }
    if alpha == 0 {
        return;
    }
    let pixel = canvas.get_pixel_mut(x as u32, y as u32);
    let src_alpha = color.0[3] as f32 / 255.0;
    let factor = (alpha as f32 / 255.0) * src_alpha;
    if factor >= 1.0 {
        *pixel = color;
    } else if factor <= 0.0 {
        // do nothing
    } else {
        let inv_factor = 1.0 - factor;
        pixel.0[0] = (pixel.0[0] as f32 * inv_factor + color.0[0] as f32 * factor).round() as u8;
        pixel.0[1] = (pixel.0[1] as f32 * inv_factor + color.0[1] as f32 * factor).round() as u8;
        pixel.0[2] = (pixel.0[2] as f32 * inv_factor + color.0[2] as f32 * factor).round() as u8;
        pixel.0[3] = (pixel.0[3] as f32 * inv_factor + 255.0 * factor).round() as u8;
    }
}

fn resize_image_to_rgba(image: &DynamicImage, max_width: i32, max_height: i32) -> RgbaImage {
    let (w, h) = scaled_dimensions_fit(image, max_width, max_height);
    crate::chat_overlay::cache::resize_rgba_premultiplied(image, w, h)
}

fn draw_rgba_image(canvas: &mut RgbaImage, image: &RgbaImage, x: i32, y: i32, max_height: i32) {
    let centered_y = y + ((max_height - image.height() as i32) / 2).max(0);
    overlay_fast(canvas, image, x.max(0) as i64, centered_y as i64);
}

/// Drops the fully transparent columns to the right of the drawn content.
///
/// Messages are laid out on a canvas as wide as the chat box, but most end well
/// before its right edge. Every prepared message stays in memory for the whole
/// render, and each static frame composites them all; both shrink with the
/// width. The bitmap is drawn at x = 0 either way, so frames are unchanged.
fn crop_to_drawn_width(image: RgbaImage) -> RgbaImage {
    let (width, height) = image.dimensions();
    if width == 0 || height == 0 {
        return image;
    }
    let stride = width as usize * 4;
    let mut drawn = 0usize;
    for row in image.as_raw().chunks_exact(stride) {
        if let Some(last) = row.chunks_exact(4).rposition(|pixel| pixel[3] != 0) {
            drawn = drawn.max(last + 1);
            if drawn == width as usize {
                return image;
            }
        }
    }
    imageops::crop_imm(&image, 0, 0, drawn.max(1) as u32, height).to_image()
}

/// Draw a message at `y`, cutting off whatever sticks out above the box.
///
/// A negative `y` means the message is taller than the chat area; clamping it
/// to zero would show its beginning and hide the newest line, which is the one
/// the viewer is reading.
fn overlay_clipped(canvas: &mut RgbaImage, image: &RgbaImage, y: i32) {
    overlay_fast(canvas, image, 0, y as i64);
}

fn update_asset_progress(queue: &Arc<QueueManager>, job_id: &str, loaded: usize, total: usize) {
    if total == 0 || (loaded % 25 != 0 && loaded != total) {
        return;
    }
    queue.set_progress(
        job_id,
        JobProgress {
            percent: (loaded as f32 / total as f32) * 100.0,
            stage_percent: None,
            stage_start: None,
            stage_end: None,
            stage_started_at: None,
            download_elapsed_ms: None,
            speed: None,
            eta: None,
            size: None,
            message: Some(format!("Preparing emotes/badges: {loaded}/{total}")),
            ..JobProgress::default()
        },
    );
}

#[derive(Clone)]
struct DirectEncoderAttempt {
    /// Overlay on CUDA frames (NVDEC → overlay_cuda → NVENC); no CPU full-frame passes.
    gpu_overlay: bool,
    mode: GpuEncoderMode,
    label: &'static str,
    args: Vec<String>,
}

/// Encoder that completed the most recent direct render in this app session. Tried first
/// on subsequent jobs so a broken earlier candidate is not re-discovered every time.
static PROBED_DIRECT_ENCODERS: std::sync::Mutex<Vec<&'static str>> =
    std::sync::Mutex::new(Vec::new());

fn encoder_probe_passed(label: &str) -> bool {
    PROBED_DIRECT_ENCODERS
        .lock()
        .map(|list| list.contains(&label))
        .unwrap_or(false)
}

fn remember_encoder_probe(label: &'static str) {
    if let Ok(mut list) = PROBED_DIRECT_ENCODERS.lock() {
        if !list.contains(&label) {
            list.push(label);
        }
    }
}

static LAST_GOOD_DIRECT_ENCODER: std::sync::Mutex<Option<GpuEncoderMode>> =
    std::sync::Mutex::new(None);

/// 1-second synthetic encode with the candidate's exact args. Init/driver failures of
/// HW encoders show up here in ~1-2s, instead of aborting a real render pass mid-way.
async fn probe_direct_encoder(ffmpeg: &Path, attempt: &DirectEncoderAttempt) -> Result<()> {
    let mut cmd = Command::new(ffmpeg);
    cmd.kill_on_drop(true)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .args([
            "-y",
            "-hide_banner",
            "-f",
            "lavfi",
            "-i",
            "color=c=black:s=1280x720:r=30:d=1",
        ])
        .args(&attempt.args)
        .args(["-frames:v", "30", "-f", "null", "-"]);
    #[cfg(windows)]
    {
        cmd.creation_flags(0x0800_0000);
    }
    let child = cmd.spawn().context("spawn ffmpeg encoder probe")?;
    let output = tokio::time::timeout(std::time::Duration::from_secs(15), child.wait_with_output())
        .await
        .map_err(|_| anyhow!("encoder probe timed out"))?
        .context("wait for ffmpeg encoder probe")?;
    if output.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let detail = stderr
            .lines()
            .rev()
            .find(|line| !line.trim().is_empty())
            .unwrap_or("")
            .trim()
            .to_string();
        Err(anyhow!("encoder probe exited {}: {detail}", output.status))
    }
}

/// Encoder chain for `GpuEncoderMode::Auto`, tuned per OS. Always ends with the
/// CPU (libx264) attempt so the render always succeeds.
fn direct_auto_attempts(
    performance: &PerformanceSettings,
    target_bitrate: Option<u64>,
) -> Vec<DirectEncoderAttempt> {
    #[cfg(target_os = "windows")]
    {
        return vec![
            direct_gpu_attempt(GpuEncoderMode::IntelXeQsv, performance, target_bitrate),
            direct_gpu_attempt(GpuEncoderMode::Qsv, performance, target_bitrate),
            direct_gpu_attempt(GpuEncoderMode::Nvenc, performance, target_bitrate),
            direct_gpu_attempt(GpuEncoderMode::Amf, performance, target_bitrate),
            direct_cpu_attempt(performance, target_bitrate),
        ];
    }
    #[cfg(target_os = "macos")]
    {
        return vec![
            direct_videotoolbox_attempt(target_bitrate),
            direct_cpu_attempt(performance, target_bitrate),
        ];
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        return vec![direct_cpu_attempt(performance, target_bitrate)];
    }
}

/// Apple VideoToolbox H.264 encoder for the direct render path (system-memory
/// frames, no hwupload needed). `mode` stays `Auto` so a failure falls through.
#[cfg(target_os = "macos")]
fn direct_videotoolbox_attempt(target_bitrate: Option<u64>) -> DirectEncoderAttempt {
    let mut args = vec!["-c:v".into(), "h264_videotoolbox".into()];
    match target_bitrate {
        Some(b) => args.extend([
            "-b:v".into(),
            b.to_string(),
            "-maxrate".into(),
            b.to_string(),
        ]),
        None => args.extend(["-q:v".into(), "55".into()]),
    }
    args.extend(["-pix_fmt".into(), "yuv420p".into()]);
    DirectEncoderAttempt {
        gpu_overlay: false,
        mode: GpuEncoderMode::Auto,
        label: "Apple VideoToolbox",
        args,
    }
}

fn direct_encoder_attempts(
    performance: &PerformanceSettings,
    target_bitrate: Option<u64>,
) -> Vec<DirectEncoderAttempt> {
    let mode = performance.gpu_encoder_mode.unwrap_or(GpuEncoderMode::Auto);
    match mode {
        // CPU overlay feeds the encoder system-memory frames, so encoders that accept those
        // are tried first (QSV/NVENC/AMF). h264_vulkan needs Vulkan surfaces and cannot take
        // system frames in this path, so it is excluded here (CPU libx264 is the final fallback).
        GpuEncoderMode::Auto => direct_auto_attempts(performance, target_bitrate),
        GpuEncoderMode::IntelXeQsv
        | GpuEncoderMode::Qsv
        | GpuEncoderMode::Nvenc
        | GpuEncoderMode::Amf
        | GpuEncoderMode::Vulkan => {
            vec![
                direct_gpu_attempt(mode, performance, target_bitrate),
                direct_cpu_attempt(performance, target_bitrate),
            ]
        }
        GpuEncoderMode::Cpu => vec![direct_cpu_attempt(performance, target_bitrate)],
    }
}

fn direct_cpu_attempt(
    performance: &PerformanceSettings,
    target_bitrate: Option<u64>,
) -> DirectEncoderAttempt {
    let preset = performance
        .ffmpeg_preset
        .clone()
        .filter(|v| !v.trim().is_empty())
        // veryfast is ~3-4x faster than medium at near-identical visual quality for
        // screen content; the CPU fallback must not be the silent slow path.
        .unwrap_or_else(|| "veryfast".into());
    let mut args = vec!["-c:v".into(), "libx264".into(), "-preset".into(), preset];
    match target_bitrate {
        Some(b) => args.extend(cbr_rate_args(GpuEncoderMode::Cpu, b)),
        None => args.extend(["-crf".into(), "20".into()]),
    }
    args.extend(["-pix_fmt".into(), "yuv420p".into()]);
    DirectEncoderAttempt {
        gpu_overlay: false,
        mode: GpuEncoderMode::Cpu,
        label: "CPU libx264",
        args,
    }
}

fn direct_gpu_attempt(
    mode: GpuEncoderMode,
    performance: &PerformanceSettings,
    target_bitrate: Option<u64>,
) -> DirectEncoderAttempt {
    let preset = performance
        .ffmpeg_preset
        .clone()
        .filter(|v| !v.trim().is_empty());
    match mode {
        GpuEncoderMode::IntelXeQsv | GpuEncoderMode::Qsv => {
            // Xe attempt uses the fixed-function VDEnc path (-low_power 1): it encodes
            // noticeably faster and leaves the EUs free. If the driver rejects it the
            // attempt fails at init and the chain falls back to the standard QSV attempt.
            let low_power = mode == GpuEncoderMode::IntelXeQsv;
            let mut args = vec![
                "-c:v".into(),
                "h264_qsv".into(),
                "-preset".into(),
                preset.unwrap_or_else(|| "veryfast".into()),
                "-async_depth".into(),
                "8".into(),
            ];
            match target_bitrate {
                Some(b) => args.extend(cbr_rate_args(mode, b)),
                None => args.extend(["-global_quality".into(), "20".into()]),
            }
            args.extend(["-pix_fmt".into(), "nv12".into()]);
            if low_power {
                args.push("-low_power".into());
                args.push("1".into());
            }
            DirectEncoderAttempt {
        gpu_overlay: false,
                mode,
                label: if low_power {
                    "Intel Xe Quick Sync (VDEnc)"
                } else {
                    "Intel Quick Sync"
                },
                args,
            }
        }
        GpuEncoderMode::Nvenc => {
            let mut args = vec![
                "-c:v".into(),
                "h264_nvenc".into(),
                "-preset".into(),
                preset.unwrap_or_else(|| "p4".into()),
            ];
            match target_bitrate {
                Some(b) => args.extend(cbr_rate_args(mode, b)),
                None => args.extend(["-cq".into(), "20".into(), "-b:v".into(), "0".into()]),
            }
            args.extend(["-pix_fmt".into(), "yuv420p".into()]);
            DirectEncoderAttempt {
        gpu_overlay: false,
                mode,
                label: "NVIDIA NVENC",
                args,
            }
        }
        GpuEncoderMode::Amf => {
            let mut args = vec![
                "-c:v".into(),
                "h264_amf".into(),
                "-quality".into(),
                preset.unwrap_or_else(|| "speed".into()),
            ];
            match target_bitrate {
                Some(b) => args.extend(cbr_rate_args(mode, b)),
                None => args.extend(["-qp_i".into(), "20".into(), "-qp_p".into(), "20".into()]),
            }
            args.extend(["-pix_fmt".into(), "yuv420p".into()]);
            DirectEncoderAttempt {
        gpu_overlay: false,
                mode,
                label: "AMD AMF",
                args,
            }
        }
        GpuEncoderMode::Vulkan => DirectEncoderAttempt {
        gpu_overlay: false,
            mode,
            label: "Vulkan Hardware Encoder",
            args: vec![
                "-c:v".into(),
                "h264_vulkan".into(),
                "-pix_fmt".into(),
                "vulkan".into(),
            ],
        },
        GpuEncoderMode::Auto | GpuEncoderMode::Cpu => {
            direct_cpu_attempt(performance, target_bitrate)
        }
    }
}

fn alpha_encoder_args(format: AlphaOutputFormat, _gpu_mode: Option<GpuEncoderMode>) -> Vec<String> {
    match format {
        // Frame-threaded intra codec: ffmpeg encodes many PNG frames in parallel, unlike
        // single-threaded qtrle. compression_level 1 favors speed (lossless either way).
        AlphaOutputFormat::MovPng => vec![
            "-c:v".into(),
            "png".into(),
            "-compression_level".into(),
            "1".into(),
            "-pix_fmt".into(),
            "rgba".into(),
        ],
        AlphaOutputFormat::MovQtrle => vec![
            "-c:v".into(),
            "qtrle".into(),
            "-pix_fmt".into(),
            "argb".into(),
        ],
        AlphaOutputFormat::WebmVp9 => vec![
            "-c:v".into(),
            "libvpx-vp9".into(),
            "-pix_fmt".into(),
            "yuva420p".into(),
            "-lossless".into(),
            "1".into(),
            "-deadline".into(),
            "realtime".into(),
            "-cpu-used".into(),
            "6".into(),
            "-row-mt".into(),
            "1".into(),
        ],
        AlphaOutputFormat::WebmVp8 => vec![
            "-c:v".into(),
            "libvpx".into(),
            "-pix_fmt".into(),
            "yuva420p".into(),
            "-deadline".into(),
            "realtime".into(),
            "-cpu-used".into(),
            "6".into(),
        ],
        AlphaOutputFormat::Ffv1Mkv => vec![
            "-c:v".into(),
            "ffv1".into(),
            "-level".into(),
            "3".into(),
            "-pix_fmt".into(),
            "rgba".into(),
        ],
        AlphaOutputFormat::Prores4444 => vec![
            "-c:v".into(),
            "prores_ks".into(),
            "-profile:v".into(),
            "4".into(),
            "-pix_fmt".into(),
            "yuva444p10le".into(),
        ],
        AlphaOutputFormat::LagarithAvi => vec![
            "-c:v".into(),
            "lagarith".into(),
            "-pix_fmt".into(),
            "rgba".into(),
        ],
    }
}

fn visible_timeline_indices(
    active: &VecDeque<usize>,
    timeline: &[TimelineMessage],
    settings: &EffectiveChatOverlaySettings,
) -> Vec<usize> {
    let mut visible = active
        .iter()
        .rev()
        .take(settings.max_visible_messages)
        .copied()
        .collect::<Vec<_>>();
    visible.retain(|idx| timeline.get(*idx).is_some());
    visible
}

fn message_positions(
    visible: &[usize],
    timeline: &[TimelineMessage],
    settings: &EffectiveChatOverlaySettings,
) -> Vec<(usize, i32)> {
    let gap = 8_i32;
    let mut positions = Vec::with_capacity(visible.len());
    // The message that runs past the edge is drawn clipped rather than dropped.
    // Dropping it left a blank strip the height of that message — and a message
    // taller than the whole box blanked the chat entirely while it was newest.
    let height_limit = settings.chat_height as i32;
    if settings.direction == "bottom-up" {
        // `bottom` is where the next message ends. Once that is above the box
        // there is no visible strip left to fill.
        let mut bottom = height_limit;
        for idx in visible {
            if bottom <= 0 {
                break;
            }
            let Some(message) = timeline.get(*idx) else {
                continue;
            };
            bottom -= message.prepared.height as i32;
            positions.push((*idx, bottom));
            bottom -= gap;
        }
    } else {
        let mut top = 0_i32;
        for idx in visible.iter().rev() {
            if top >= height_limit {
                break;
            }
            let Some(message) = timeline.get(*idx) else {
                continue;
            };
            positions.push((*idx, top));
            top += message.prepared.height as i32 + gap;
        }
    }
    positions
}

struct PlacedMessage {
    idx: usize,
    y: i32,
    appear: AppearState,
}

fn message_appear(
    message: &TimelineMessage,
    settings: &EffectiveChatOverlaySettings,
    t: f64,
) -> AppearState {
    appear_state(
        settings.message_animation,
        settings.message_animation_ms,
        t - message.start,
        settings.chat_width,
    )
}

/// [`message_positions`] at time `t`, with the entry effect of new messages:
/// a message still appearing takes only part of its room, so the stack slides
/// instead of jumping, and is drawn shifted and faded.
fn placed_messages(
    visible: &[usize],
    timeline: &[TimelineMessage],
    settings: &EffectiveChatOverlaySettings,
    t: f64,
) -> Vec<PlacedMessage> {
    let gap = 8_f32;
    let height_limit = settings.chat_height as i32;
    let mut placed = Vec::with_capacity(visible.len());
    if settings.direction == "bottom-up" {
        let mut bottom = height_limit as f32;
        for idx in visible {
            if bottom <= 0.0 {
                break;
            }
            let Some(message) = timeline.get(*idx) else {
                continue;
            };
            let appear = message_appear(message, settings, t);
            let height = message.prepared.height as f32;
            // Only `push` of its height is claimed yet: the rest hangs below the
            // slot (under the box edge for the newest), so it rises into place.
            bottom -= height * appear.push;
            placed.push(PlacedMessage { idx: *idx, y: bottom.round() as i32, appear });
            bottom -= gap * appear.push;
        }
    } else {
        let mut top = 0_f32;
        for idx in visible.iter().rev() {
            if top >= height_limit as f32 {
                break;
            }
            let Some(message) = timeline.get(*idx) else {
                continue;
            };
            let appear = message_appear(message, settings, t);
            placed.push(PlacedMessage { idx: *idx, y: top.round() as i32, appear });
            top += (message.prepared.height as f32 + gap) * appear.push;
        }
    }
    placed
}

/// Frame-signature part for messages still in their entry effect; empty once
/// everything has settled, so settled frames keep their old cache keys.
fn appear_signature(
    visible: &[usize],
    timeline: &[TimelineMessage],
    settings: &EffectiveChatOverlaySettings,
    t: f64,
) -> String {
    let mut signature = String::new();
    for idx in visible {
        let Some(message) = timeline.get(*idx) else {
            continue;
        };
        let appear = message_appear(message, settings, t);
        if appear != SETTLED {
            signature.push_str(&format!("~{idx}@{}", appear.signature()));
        }
    }
    signature
}

/// Keeps only the messages that end up on screen, in the same order.
///
/// The UI allows up to 999 "visible" messages, far more than the box holds.
/// Every frame hashed all of them into its signatures, and one animated emote
/// anywhere in those 999 made every frame distinct, which defeated the frame
/// dedup. The drawn frame depends only on the drawn messages, so the result is
/// identical.
fn drawn_timeline_indices(
    mut visible: Vec<usize>,
    timeline: &[TimelineMessage],
    settings: &EffectiveChatOverlaySettings,
) -> Vec<usize> {
    let drawn = message_positions(&visible, timeline, settings);
    if drawn.len() < visible.len() {
        let drawn_set: HashSet<usize> = drawn.iter().map(|(idx, _)| *idx).collect();
        visible.retain(|idx| drawn_set.contains(idx));
    }
    visible
}

/// Identity of a static frame: which messages it shows, in order. It does not
/// depend on time (the static layer has no time-based effects), so a frame is
/// re-composited only when the drawn messages change.
fn static_timeline_signature(visible: &[usize], timeline: &[TimelineMessage]) -> String {
    let mut signature = String::new();
    for idx in visible {
        let Some(message) = timeline.get(*idx) else {
            continue;
        };
        signature.push_str(&message.stable_key);
        signature.push('|');
    }
    signature
}

fn animated_timeline_signature(visible: &[usize], timeline: &[TimelineMessage], t: f64) -> String {
    let mut signature = String::new();
    for idx in visible {
        let Some(message) = timeline.get(*idx) else {
            continue;
        };
        // Drawing uses the per-message elapsed time (`t - message.start`), so the
        // cache signature must use the same basis. Using absolute `t` here desynced
        // the cache from what is actually drawn, freezing/stuttering animated emotes
        // (most 7TV/BetterTTV emotes) and reusing stale frames.
        let message_elapsed = t - message.start;
        for (run_idx, run) in message.prepared.animated_runs.iter().enumerate() {
            signature.push_str(&idx.to_string());
            signature.push(':');
            signature.push_str(&run_idx.to_string());
            signature.push(':');
            signature.push_str(&run.frames.frame_index_at(message_elapsed).to_string());
            signature.push('|');
        }
    }
    signature
}

fn combined_timeline_signature(static_signature: &str, animated_signature: &str) -> String {
    if animated_signature.is_empty() {
        static_signature.to_string()
    } else {
        format!("{static_signature}anim|{animated_signature}")
    }
}

fn scaled_dimensions_fit(image: &DynamicImage, max_width: i32, max_height: i32) -> (u32, u32) {
    let max_w = max_width.max(1) as f32;
    let max_h = max_height.max(1) as f32;
    let scale = (max_w / image.width().max(1) as f32).min(max_h / image.height().max(1) as f32);
    (
        (image.width() as f32 * scale).round().max(1.0) as u32,
        (image.height() as f32 * scale).round().max(1.0) as u32,
    )
}

/// Emit a pipeline-profiling verdict: where the time went while feeding ffmpeg.
/// `wait_recv` ≫ `wait_write` ⇒ chat rasterization is the bottleneck;
/// `wait_write` ≫ `wait_recv` ⇒ ffmpeg (decode+overlay+encode) is the bottleneck.
fn emit_profile(
    queue: &Arc<QueueManager>,
    job_id: &str,
    wait_recv: std::time::Duration,
    wait_write: std::time::Duration,
    stats: &ProducerStats,
    video_output_fps: Option<f64>,
) {
    let recv = wait_recv.as_secs_f64();
    let write = wait_write.as_secs_f64();
    let verdict = if recv > write {
        "растеризация"
    } else {
        "ffmpeg"
    };
    let send_blocks = stats.send_blocks_count.load(Ordering::Relaxed);
    let channel_full = stats.channel_full_count.load(Ordering::Relaxed);
    let total_frames = stats.frames.load(Ordering::Relaxed);

    emit_log(
        queue,
        job_id,
        &format!(
            "Профиль: recv {recv:.1}s / write {write:.1}s → узкое место: {verdict}\n\
             Детали: чистый рендер (без send) {render_fps:.1} fps, блокировок send: {send_blocks}, канал был полон: {channel_full} раз",
            render_fps = stats.render_fps()
        ),
    );

    if channel_full > total_frames / 10 && total_frames > 0 {
        let video_context = video_output_fps
            .map(|fps| format!(" Текущий ffmpeg output: {fps:.1} video-fps."))
            .unwrap_or_default();
        emit_log(
            queue,
            job_id,
            &format!(
                "Warning: буфер отправки кадров часто переполнялся — FrameProducer быстрее ffmpeg pipe; это не критическая ошибка при высоком output fps.{video_context}"
            ),
        );
    }
}

fn snapshot_ffmpeg_metrics(metrics: &Arc<Mutex<FfmpegEncodeMetrics>>) -> FfmpegEncodeMetrics {
    metrics
        .lock()
        .map(|guard| guard.clone())
        .unwrap_or_default()
}

use crate::util::format_duration;

fn strip_pix_fmt(args: &[String]) -> Vec<String> {
    let mut out = Vec::with_capacity(args.len());
    let mut iter = args.iter();
    while let Some(arg) = iter.next() {
        if arg == "-pix_fmt" {
            iter.next();
        } else {
            out.push(arg.clone());
        }
    }
    out
}

fn render_pool(workers: usize) -> Option<rayon::ThreadPool> {
    rayon::ThreadPoolBuilder::new()
        .num_threads(workers.max(1))
        .build()
        .ok()
}

fn effective_render_workers(
    configured: Option<u32>,
    performance_profile: Option<PerformanceProfile>,
) -> usize {
    if let Some(value) = configured.filter(|value| *value > 0) {
        return value.clamp(1, 64) as usize;
    }
    if performance_profile == Some(PerformanceProfile::Turbo) {
        return std::thread::available_parallelism()
            .map(|cores| cores.get().clamp(2, 64))
            .unwrap_or(8);
    }
    std::thread::available_parallelism()
        .map(|cores| cores.get().saturating_sub(1).max(2).min(12))
        .unwrap_or(4)
}

fn effective_asset_workers(
    performance_profile: Option<PerformanceProfile>,
    network_workers: Option<u32>,
) -> usize {
    match performance_profile.unwrap_or(PerformanceProfile::Auto) {
        PerformanceProfile::Auto => 8,
        PerformanceProfile::Maximum => 16,
        PerformanceProfile::Turbo | PerformanceProfile::Custom => {
            network_workers.unwrap_or(32).clamp(1, 32) as usize
        }
    }
}

#[cfg(test)]
pub(crate) fn load_font_for_tests(family: &str) -> Option<FontArc> {
    load_font(family, 400, ChatFontStyle::Normal)
}

fn load_font(family: &str, weight: u16, style: ChatFontStyle) -> Option<FontArc> {
    if let Some(font) = load_fontdb(family, weight, style) {
        return Some(font);
    }
    let windows = std::env::var_os("WINDIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(r"C:\Windows"));
    let font_dir = windows.join("Fonts");
    let mut candidates = Vec::new();
    let f = family.to_ascii_lowercase();
    if f.contains("inter") {
        candidates.extend([
            font_dir.join("Inter.ttf"),
            font_dir.join("Inter-Regular.ttf"),
            font_dir.join("InterVariable.ttf"),
        ]);
    }
    if weight >= 600 {
        candidates.extend([
            font_dir.join("segoeuib.ttf"),
            font_dir.join("arialbd.ttf"),
            font_dir.join("tahomabd.ttf"),
        ]);
    }
    candidates.extend([
        font_dir.join("segoeui.ttf"),
        font_dir.join("arial.ttf"),
        font_dir.join("tahoma.ttf"),
    ]);

    for path in candidates {
        if let Ok(bytes) = std::fs::read(&path) {
            if let Ok(font) = FontArc::try_from_vec(bytes) {
                return Some(font);
            }
        }
    }
    None
}

fn load_fontdb(family: &str, weight: u16, style: ChatFontStyle) -> Option<FontArc> {
    let db = crate::system_fonts::database();
    let query = fontdb::Query {
        families: &[fontdb::Family::Name(family)],
        weight: fontdb::Weight(weight),
        stretch: fontdb::Stretch::Normal,
        style: fontdb_style(style),
    };
    let id = db.query(&query)?;
    let face = db.face(id)?;
    match &face.source {
        fontdb::Source::File(path) => std::fs::read(path)
            .ok()
            .and_then(|bytes| FontArc::try_from_vec(bytes).ok()),
        fontdb::Source::Binary(bytes) => {
            FontArc::try_from_vec(bytes.as_ref().as_ref().to_vec()).ok()
        }
        fontdb::Source::SharedFile(path, _) => std::fs::read(path)
            .ok()
            .and_then(|bytes| FontArc::try_from_vec(bytes).ok()),
    }
}

fn fontdb_style(style: ChatFontStyle) -> fontdb::Style {
    match style {
        ChatFontStyle::Normal => fontdb::Style::Normal,
        ChatFontStyle::Italic => fontdb::Style::Italic,
        ChatFontStyle::Oblique => fontdb::Style::Oblique,
    }
}

fn debug_cmd(bin: &Path, cmd: &Command) -> String {
    let std = cmd.as_std();
    let mut out = quote_arg(bin.to_string_lossy().as_ref());
    for a in std.get_args() {
        out.push(' ');
        out.push_str(&quote_arg(a.to_string_lossy().as_ref()));
    }
    out
}

fn quote_arg(s: &str) -> String {
    if s.is_empty() {
        return "\"\"".into();
    }
    if s.chars().any(|c| c == ' ' || c == '"') {
        format!("\"{}\"", s.replace('"', "\\\""))
    } else {
        s.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::jobs::types::ChatOverlaySettings;

    fn settings(chat_height: u32) -> EffectiveChatOverlaySettings {
        let mut settings = EffectiveChatOverlaySettings::from(ChatOverlaySettings::default());
        settings.chat_height = chat_height;
        settings.chat_width = 400;
        settings.direction = "bottom-up".to_string();
        settings.max_visible_messages = 999;
        settings
    }

    fn message(height: u32) -> TimelineMessage {
        TimelineMessage {
            start: 0.0,
            end: 1.0,
            stable_key: format!("h{height}"),
            prepared: PreparedMessage {
                height,
                static_image: RgbaImage::new(400, height.max(1)),
                animated_runs: Vec::new(),
            },
        }
    }

    #[test]
    fn signatures_only_see_the_messages_on_screen() {
        // 200 px box, 90 px messages: the newest three (with gaps) reach the
        // top; the two older ones are off screen.
        let timeline = vec![message(90), message(90), message(90), message(90), message(90)];
        let drawn = drawn_timeline_indices(vec![4, 3, 2, 1, 0], &timeline, &settings(200));
        assert_eq!(drawn, vec![4, 3, 2]);
        assert_eq!(
            message_positions(&drawn, &timeline, &settings(200)),
            message_positions(&[4, 3, 2, 1, 0], &timeline, &settings(200)),
            "trimming must not move anything"
        );
    }

    #[test]
    fn prepared_bitmaps_are_cut_to_their_drawn_width() {
        let mut image = RgbaImage::new(400, 4);
        image.put_pixel(30, 2, Rgba([255, 255, 255, 255]));
        assert_eq!(crop_to_drawn_width(image).dimensions(), (31, 4));

        let empty = RgbaImage::new(400, 4);
        assert_eq!(crop_to_drawn_width(empty).dimensions(), (1, 4));
    }

    /// Newest at the bottom, older stacked above, clipped at the top edge.
    #[test]
    fn bottom_up_fills_from_the_bottom() {
        let timeline = vec![message(40), message(40), message(40)];
        // `visible` is newest-first, as the sweep produces it.
        let positions = message_positions(&[2, 1, 0], &timeline, &settings(200));
        assert_eq!(positions.len(), 3);
        assert_eq!(positions[0].1, 160);
        assert!(positions[1].1 < positions[0].1, "older must sit higher");
    }

    /// A message taller than the box used to blank the whole chat: the layout
    /// bailed out before placing anything, so every frame where it was newest
    /// rendered empty.
    #[test]
    fn oversized_newest_message_is_still_drawn() {
        let timeline = vec![message(500)];
        let positions = message_positions(&[0], &timeline, &settings(200));
        assert_eq!(
            positions.len(),
            1,
            "an over-tall message must still be drawn"
        );
        assert!(
            positions[0].1 < 0,
            "it hangs above the box: {}",
            positions[0].1
        );
    }

    /// Older messages behind an over-tall one are dropped, not the new one.
    #[test]
    fn oversized_message_does_not_evict_itself() {
        let timeline = vec![message(30), message(500)];
        let positions = message_positions(&[1, 0], &timeline, &settings(200));
        assert_eq!(positions.len(), 1);
        assert_eq!(positions[0].0, 1, "the newest message must survive");
    }

    /// The box has to stay filled: whatever does not fit is clipped, not
    /// skipped. Dropping it left a blank strip the height of a whole message —
    /// which is what the empty top of the chat actually was.
    #[test]
    fn top_message_is_clipped_instead_of_leaving_a_gap() {
        let timeline = vec![message(60), message(60), message(60), message(60)];
        let positions = message_positions(&[3, 2, 1, 0], &timeline, &settings(200));
        let top = positions.last().expect("something must be drawn");
        // Anything left over at the top is spacing, never a message's worth.
        assert!(
            top.1 < 8,
            "a blank strip of {}px was left at the top of the box",
            top.1,
        );
        // Every placed message has some part inside the box.
        for (idx, y) in &positions {
            assert!(
                y + timeline[*idx].prepared.height as i32 > 0,
                "message at y={y} is drawn entirely above the box",
            );
        }
    }

    /// Messages taller than the remaining space still fill it, clipped.
    #[test]
    fn tall_message_fills_the_remaining_strip() {
        let timeline = vec![message(300), message(50)];
        let positions = message_positions(&[1, 0], &timeline, &settings(200));
        assert_eq!(positions.len(), 2, "the tall older message must be drawn");
        assert_eq!(positions[0].1, 150);
        assert!(
            positions[1].1 < 0,
            "it is clipped at the top: {}",
            positions[1].1
        );
        assert!(
            positions[1].1 + 300 > 0,
            "the clipped message must still cover the strip",
        );
    }

    /// Clipping keeps the newest lines: the hidden part comes off the top.
    #[test]
    fn overlay_clipped_cuts_the_top_not_the_bottom() {
        let mut canvas = RgbaImage::from_pixel(4, 10, Rgba([0, 0, 0, 0]));
        let mut source = RgbaImage::from_pixel(4, 30, Rgba([1, 0, 0, 255]));
        // Mark the last row so we can prove it survived the crop.
        for x in 0..4 {
            source.put_pixel(x, 29, Rgba([9, 9, 9, 255]));
        }
        overlay_clipped(&mut canvas, &source, -20);
        assert_eq!(canvas.get_pixel(0, 9).0, [9, 9, 9, 255]);
    }

    /// Entirely above the box: nothing to draw, and no panic.
    #[test]
    fn overlay_clipped_skips_fully_hidden_images() {
        let mut canvas = RgbaImage::from_pixel(4, 10, Rgba([7, 7, 7, 255]));
        let source = RgbaImage::from_pixel(4, 30, Rgba([1, 0, 0, 255]));
        overlay_clipped(&mut canvas, &source, -30);
        assert_eq!(canvas.get_pixel(0, 0).0, [7, 7, 7, 255]);
    }
}
