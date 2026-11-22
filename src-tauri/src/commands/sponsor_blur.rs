//! Tauri commands for the sponsor-blur zone tracker.
//!
//! The tracking itself lives in `modules::tracker`; this file only resolves the
//! media URL, wires progress/cancellation into the queue, and translates
//! between the UI's payload shape and the tracker's types.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::State;
use uuid::Uuid;

use crate::app_log::LogLevel;
use crate::binaries::{resolve_binary, FFMPEG};
use crate::commands::resolve::resolve_direct_url;
use crate::jobs::queue::QueueManager;
use crate::jobs::types::{BlurZone, BlurZoneKeyframe, JobProgress};
use crate::modules::tracker::vit::BoxF;
use crate::modules::tracker::{
    self, ProgressSink, TrackerEngine, TrackerRequest, DEFAULT_ANALYSIS_WIDTH,
};
use crate::proxy::ProxyConfig;
use crate::AppState;

#[derive(Debug, Deserialize)]
pub struct TrackSponsorZoneRequest {
    pub url: String,
    pub reference_frame_path: String,
    pub zone: BlurZone,
    /// Client-generated id used for progress events and cancellation.
    #[serde(default)]
    pub task_id: Option<String>,
    #[serde(default)]
    pub start_time_sec: f64,
    #[serde(default)]
    pub duration_sec: Option<f64>,
    #[serde(default = "default_sample_interval")]
    pub sample_interval_sec: f64,
    #[serde(default = "default_confidence_threshold")]
    pub confidence_threshold: f32,
    #[serde(default = "default_output_width")]
    pub output_width: u32,
    #[serde(default = "default_output_height")]
    pub output_height: u32,
    /// `"hybrid"` (VitTrack + ZNCC, default) or `"correlation"` (no model).
    #[serde(default)]
    pub engine: Option<String>,
    /// Internal analysis resolution; lower is faster.
    #[serde(default = "default_analysis_width")]
    pub analysis_width: u32,
    #[serde(default = "default_true")]
    pub use_gpu: bool,
    /// Off by default: `-hwaccel auto` copies every decoded frame back from the
    /// GPU before `fps` drops most of them, which measured ~5x slower than
    /// software decode for 5 fps sampling of 1080p60 H.264.
    #[serde(default)]
    pub hwaccel: bool,
    /// Keep the box at the size the user drew (banners do not resize).
    #[serde(default = "default_true")]
    pub lock_size: bool,
    #[serde(default = "default_redetect_after")]
    pub redetect_after_sec: f64,
    #[serde(default = "default_give_up")]
    pub give_up_sec: f64,
    #[serde(default)]
    pub quality: Option<String>,
    #[serde(default)]
    pub proxy: Option<ProxyConfig>,
    #[serde(default)]
    pub binaries_dir: Option<String>,
    #[serde(default)]
    pub twitch_auth_token: Option<String>,
    /// Legacy field from the brute-force matcher; ignored, kept so older
    /// persisted drafts still deserialize.
    #[serde(default)]
    pub search_radius: Option<u32>,
}

#[derive(Debug, Serialize)]
pub struct TrackSponsorZoneResult {
    pub keyframes: Vec<BlurZoneKeyframe>,
    pub analyzed_frames: usize,
    pub matched_frames: usize,
    pub min_confidence: f32,
    pub max_confidence: f32,
    /// Original-timeline time until which the banner was still tracked.
    pub end_time_sec: f64,
    /// True when the keyframe cap was hit and tracking stopped early.
    pub truncated: bool,
    pub engine: String,
    pub device: String,
    pub redetections: usize,
    /// `[start, end]` intervals where the banner was not visible.
    pub gaps: Vec<[f64; 2]>,
    /// Analysed frames per wall-clock second.
    pub analysis_fps: f64,
}

struct CleanupCancel {
    cancels: Arc<parking_lot::Mutex<std::collections::HashMap<String, Arc<AtomicBool>>>>,
    task_id: String,
}

impl Drop for CleanupCancel {
    fn drop(&mut self) {
        self.cancels.lock().remove(&self.task_id);
    }
}

#[tauri::command]
pub async fn track_sponsor_zone(
    state: State<'_, AppState>,
    req: TrackSponsorZoneRequest,
) -> Result<TrackSponsorZoneResult, String> {
    let input_url = req.url.trim().to_string();
    if input_url.is_empty() {
        return Err("empty video URL".to_string());
    }
    if req.zone.width == 0 || req.zone.height == 0 {
        return Err("tracker rectangle is empty".to_string());
    }
    let reference_path = PathBuf::from(req.reference_frame_path.trim());
    let reference_frame = reference_path.is_file().then_some(reference_path);

    let width = req.output_width.max(2);
    let height = req.output_height.max(2);
    let zone = BoxF {
        x: req.zone.x.clamp(0, width as i32 - 1) as f64,
        y: req.zone.y.clamp(0, height as i32 - 1) as f64,
        w: req.zone.width.min(width) as f64,
        h: req.zone.height.min(height) as f64,
    };

    let bin_dir = req.binaries_dir.as_deref().map(Path::new);
    let ffmpeg = resolve_binary(FFMPEG, bin_dir)
        .ok_or_else(|| "ffmpeg.exe not found; tracker requires FFmpeg".to_string())?;

    let engine = match req.engine.as_deref() {
        Some("correlation") | Some("zncc") => TrackerEngine::Correlation,
        _ => TrackerEngine::Hybrid,
    };

    // Cancellation + progress wiring (same pattern as the in-page mute flow).
    let task_id = req
        .task_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    let cancel_flag = Arc::new(AtomicBool::new(false));
    {
        // A new tracker run supersedes older in-page runs.
        let mut active = state.in_page_cancels.lock();
        for previous in active.values() {
            previous.store(true, Ordering::SeqCst);
        }
        active.clear();
        active.insert(task_id.clone(), cancel_flag.clone());
    }
    let _cancel_cleanup = CleanupCancel {
        cancels: state.in_page_cancels.clone(),
        task_id: task_id.clone(),
    };
    let progress_id = format!("sponsor_tracker_in_page_{task_id}");
    let queue = state.queue.clone();

    queue.emit_app_log(
        LogLevel::Info,
        "sponsor_tracker_started",
        "Started sponsor banner tracker",
        Some(json!({
            "url": input_url,
            "engine": if engine == TrackerEngine::Hybrid { "vittrack+zncc" } else { "zncc" },
            "zone": { "x": zone.x, "y": zone.y, "width": zone.w, "height": zone.h },
            "start_time_sec": req.start_time_sec,
            "duration_sec": req.duration_sec,
            "sample_interval_sec": req.sample_interval_sec,
            "analysis_width": req.analysis_width,
            "confidence_threshold": req.confidence_threshold,
            "use_gpu": req.use_gpu,
        })),
    );
    report_progress(&queue, &progress_id, 0.0, "Подготовка трекера...".to_string());

    let media_url = resolve_tracker_media_url(
        input_url,
        req.proxy.clone(),
        req.binaries_dir.clone(),
        req.quality.clone(),
        req.twitch_auth_token.clone(),
    )
    .await?;
    if cancel_flag.load(Ordering::SeqCst) {
        return Err("cancelled".to_string());
    }

    let progress_queue = queue.clone();
    let progress_key = progress_id.clone();
    let on_progress: ProgressSink = Arc::new(move |percent: f32, message: String| {
        report_progress(&progress_queue, &progress_key, percent, message);
    });

    let outcome = tracker::run(
        TrackerRequest {
            ffmpeg,
            media_url,
            reference_frame,
            zone,
            design_width: width,
            design_height: height,
            start_time: req.start_time_sec.max(0.0),
            duration: req
                .duration_sec
                .filter(|value| value.is_finite() && *value > 0.0),
            interval: req.sample_interval_sec.clamp(0.05, 5.0),
            analysis_width: req.analysis_width,
            engine,
            prefer_gpu: req.use_gpu,
            hwaccel: req.hwaccel,
            lock_size: req.lock_size,
            confidence_threshold: req.confidence_threshold.clamp(0.0, 0.99),
            redetect_after_sec: req.redetect_after_sec.clamp(0.2, 60.0),
            give_up_sec: req.give_up_sec.clamp(1.0, 3600.0),
        },
        cancel_flag.clone(),
        on_progress,
    )
    .await;

    let outcome = match outcome {
        Ok(outcome) => outcome,
        Err(err) => {
            if err != "cancelled" {
                queue.emit_app_log(
                    LogLevel::Warn,
                    "sponsor_tracker_failed",
                    "Sponsor banner tracker failed",
                    Some(json!({ "error": err })),
                );
            }
            return Err(err);
        }
    };

    queue.emit_app_log(
        LogLevel::Info,
        "sponsor_tracker_finished",
        "Finished sponsor banner tracker",
        Some(json!({
            "engine": outcome.engine,
            "device": outcome.device,
            "normalization": outcome.normalization,
            "matched_frames": outcome.matched_frames,
            "analyzed_frames": outcome.analyzed_frames,
            "keyframes": outcome.keyframes.len(),
            "redetections": outcome.redetections,
            "gaps": outcome.gaps.len(),
            "analysis_fps": outcome.fps,
            "end_time_sec": outcome.end_time_sec,
            "truncated": outcome.truncated,
        })),
    );
    report_progress(
        &queue,
        &progress_id,
        100.0,
        format!(
            "Трекинг завершён · совпадений: {} · {:.0} кадр/с",
            outcome.matched_frames, outcome.fps
        ),
    );

    Ok(TrackSponsorZoneResult {
        keyframes: outcome
            .keyframes
            .iter()
            .map(|frame| BlurZoneKeyframe {
                time_sec: frame.time_sec,
                x: frame.x,
                y: frame.y,
                width: frame.width,
                height: frame.height,
                confidence: frame.confidence,
            })
            .collect(),
        analyzed_frames: outcome.analyzed_frames,
        matched_frames: outcome.matched_frames,
        min_confidence: outcome.min_confidence,
        max_confidence: outcome.max_confidence,
        end_time_sec: outcome.end_time_sec,
        truncated: outcome.truncated,
        engine: outcome.engine.to_string(),
        device: outcome.device.to_string(),
        redetections: outcome.redetections,
        gaps: outcome.gaps.iter().map(|(a, b)| [*a, *b]).collect(),
        analysis_fps: outcome.fps,
    })
}

#[tauri::command]
pub fn cancel_sponsor_tracker(state: State<'_, AppState>, task_id: String) {
    if let Some(flag) = state.in_page_cancels.lock().get(&task_id) {
        flag.store(true, Ordering::SeqCst);
    }
}

fn report_progress(queue: &Arc<QueueManager>, id: &str, percent: f32, message: String) {
    queue.set_progress(
        id,
        JobProgress {
            percent,
            message: Some(message),
            ..JobProgress::default()
        },
    );
}

/// Shared with the timeline filmstrip so both resolve VOD URLs identically.
pub(crate) async fn resolve_tracker_media_url(
    input_url: String,
    proxy: Option<ProxyConfig>,
    binaries_dir: Option<String>,
    quality: Option<String>,
    twitch_auth_token: Option<String>,
) -> Result<String, String> {
    if Path::new(&input_url).is_file() || is_direct_media_url(&input_url) {
        return Ok(input_url);
    }
    resolve_direct_url(input_url, proxy, binaries_dir, quality, twitch_auth_token).await
}

fn is_direct_media_url(url: &str) -> bool {
    let lower = url.to_ascii_lowercase();
    lower.contains(".m3u8")
        || lower.ends_with(".mp4")
        || lower.ends_with(".mov")
        || lower.ends_with(".mkv")
        || lower.ends_with(".webm")
        || lower.contains("/videoplayback")
}

fn default_true() -> bool {
    true
}

fn default_sample_interval() -> f64 {
    // The neural tracker is causal: it assumes small motion between samples, so
    // denser 5 fps sampling both tracks better and is still far cheaper than
    // the old 2 fps PNG pipeline.
    0.2
}

fn default_confidence_threshold() -> f32 {
    // ZNCC similarity, not the old MSE score: 0.45 comfortably separates "same
    // banner, different lighting" from "different content".
    0.45
}

fn default_analysis_width() -> u32 {
    DEFAULT_ANALYSIS_WIDTH
}

fn default_redetect_after() -> f64 {
    1.0
}

fn default_give_up() -> f64 {
    30.0
}

fn default_output_width() -> u32 {
    1920
}

fn default_output_height() -> u32 {
    1080
}
