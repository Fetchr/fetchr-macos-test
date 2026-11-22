//! Sponsor-banner zone tracker.
//!
//! Pipeline, per sampled frame:
//!
//! ```text
//!   [async task]  ffmpeg -f rawvideo (BGR24)  ──►  bounded channel
//!                 no temp files, no PNG            (decode overlaps analysis)
//!                                                        │
//!   [blocking task]                                      ▼
//!        ├─ VitTrack (ONNX, ~700 KB)  ──► candidate box + peak score
//!        │
//!        ├─ ZNCC verify against the user's patch  ──► quality in [0,1]
//!        │        └─ below threshold for a while ──► full-frame ZNCC re-detect
//!        │
//!        └─ constant-velocity Kalman  ──► smoothed box ──► keyframe (on move)
//! ```
//!
//! What this replaces: sampling at 2 fps into 1080p PNG files and matching a
//! 28x18 grid with raw MSE. That scheme paid PNG encode + decode per frame,
//! brute-forced a +-220 px window, had no scale handling, and its score fell
//! apart on any brightness change. The pieces here each fix one of those.
//!
//! The analysis runs on a blocking thread, never on a runtime worker: a track
//! can run for minutes, and the app's download queue shares that runtime.

pub mod frames;
pub mod smooth;
pub mod vit;
pub mod zncc;

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use image::imageops::FilterType;
use image::RgbImage;
use tokio::sync::mpsc;

use frames::{FrameStream, FrameStreamOptions, RawFrame};
use smooth::BoxSmoother;
use vit::{BoxF, FrameView, VitTracker};
use zncc::{GrayFrame, Template};

/// Model that OpenCV Zoo publishes for `cv::TrackerVit`.
const VIT_MODEL_URL: &str =
    "https://huggingface.co/opencv/object_tracking_vittrack/resolve/main/object_tracking_vittrack_2023sep.onnx";
const VIT_MODEL_FILE: &str = "object_tracking_vittrack_2023sep.onnx";
const VIT_MODEL_MIN_BYTES: u64 = 400_000;
const VIT_MODEL_SIZE: u64 = 714_726;
const VIT_MODEL_SHA256: &str = "2990f0b7cd44d92afa48cd97db6de7be113fc1d9594fddb74e2725c10478e91d";

/// The network's own "this is not a black frame" floor, from OpenCV's defaults.
const VIT_SCORE_FLOOR: f32 = 0.20;
/// Positions within this distance of the last stored keyframe are treated as
/// "did not move"; keeps a static banner at a single keyframe.
const KEYFRAME_MIN_DELTA_PX: f64 = 1.5;
/// The ffmpeg overlay expression grows linearly with keyframes, so cap it.
const MAX_KEYFRAMES: usize = 4000;
/// Frames buffered between the decoder and the analyser. Small on purpose: it
/// is enough to keep both busy, and it bounds memory at a few MB.
const FRAME_QUEUE: usize = 4;
/// Default analysis resolution: a quarter of the pixels of 1080p, which is
/// plenty for VitTrack's 256x256 search crop and four times cheaper to decode.
pub const DEFAULT_ANALYSIS_WIDTH: u32 = 960;

/// Progress sink. Owned and thread-safe so it can cross into the blocking task.
pub type ProgressSink = Arc<dyn Fn(f32, String) + Send + Sync>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrackerEngine {
    /// VitTrack + ZNCC verification (default).
    Hybrid,
    /// ZNCC only — no model download, works fully offline.
    Correlation,
}

pub struct TrackerRequest {
    pub ffmpeg: PathBuf,
    pub media_url: String,
    /// Frame the user drew the rectangle on. Optional: when it is missing or
    /// does not match the start of the range, the first sampled frame is used.
    pub reference_frame: Option<PathBuf>,
    /// User rectangle, in the design space below.
    pub zone: BoxF,
    pub design_width: u32,
    pub design_height: u32,
    pub start_time: f64,
    pub duration: Option<f64>,
    pub interval: f64,
    /// Horizontal resolution the analysis runs at. Lower is faster and barely
    /// affects accuracy, since VitTrack rescales its crops anyway.
    pub analysis_width: u32,
    pub engine: TrackerEngine,
    pub prefer_gpu: bool,
    pub hwaccel: bool,
    pub lock_size: bool,
    /// Minimum ZNCC similarity to count a frame as a match, in `[0, 1]`.
    pub confidence_threshold: f32,
    /// Seconds of continuous loss before a full-frame re-detect is attempted.
    pub redetect_after_sec: f64,
    /// Seconds of continuous loss after which tracking stops.
    pub give_up_sec: f64,
}

#[derive(Debug, Clone, Copy)]
pub struct TrackedKeyframe {
    pub time_sec: f64,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub confidence: f32,
}

#[derive(Debug, Clone)]
pub struct TrackerOutput {
    pub keyframes: Vec<TrackedKeyframe>,
    pub analyzed_frames: usize,
    pub matched_frames: usize,
    pub min_confidence: f32,
    pub max_confidence: f32,
    pub end_time_sec: f64,
    pub truncated: bool,
    pub engine: &'static str,
    pub device: &'static str,
    /// Which input normalisation the model picked on the first frame.
    pub normalization: &'static str,
    pub redetections: usize,
    /// Intervals on the original timeline where the banner was not visible.
    pub gaps: Vec<(f64, f64)>,
    /// Frames analysed per wall-clock second.
    pub fps: f64,
    /// True when the analyser finished before the decoder reached the end.
    pub stopped_early: bool,
}

pub fn model_path() -> PathBuf {
    app_data_root()
        .join("models")
        .join("tracker")
        .join(VIT_MODEL_FILE)
}

pub fn model_is_ready() -> bool {
    std::fs::metadata(model_path())
        .map(|meta| meta.is_file() && meta.len() >= VIT_MODEL_MIN_BYTES)
        .unwrap_or(false)
}

/// Downloads the VitTrack model if it is not cached yet (~700 KB, one time).
pub async fn ensure_model(progress: &ProgressSink) -> Result<PathBuf, String> {
    let target = model_path();
    if model_is_ready() {
        return Ok(target);
    }
    let parent = target
        .parent()
        .ok_or_else(|| "invalid tracker model path".to_string())?;
    tokio::fs::create_dir_all(parent)
        .await
        .map_err(|err| format!("create tracker model dir: {err}"))?;

    progress(1.0, "Загрузка модели трекера (~0,7 МБ)...".to_string());
    crate::jobs::model_download::download(
        crate::jobs::model_download::DownloadRequest {
            urls: crate::jobs::model_download::with_mirror(VIT_MODEL_URL),
            target: &target,
            size: VIT_MODEL_SIZE,
            sha256: VIT_MODEL_SHA256,
            label: "модель трекера",
        },
        &AtomicBool::new(false),
        &mut |_, _| {},
    )
    .await
    .map_err(|err| format!("{err:#}"))?;
    Ok(target)
}

/// Runs the tracker. `progress` receives `(percent, message)`.
pub async fn run(
    request: TrackerRequest,
    cancel: Arc<AtomicBool>,
    progress: ProgressSink,
) -> Result<TrackerOutput, String> {
    let design_w = request.design_width.max(2) as f64;
    let design_h = request.design_height.max(2) as f64;

    // Analysis resolution keeps the design aspect ratio exactly, which makes
    // the mapping back to design space a single uniform scale factor.
    let analysis_w = (request.analysis_width.clamp(320, 1920) as f64 / 2.0).round() * 2.0;
    let analysis_h = ((analysis_w * design_h / design_w) / 2.0).round() * 2.0;
    let to_design = design_w / analysis_w;
    let to_analysis = 1.0 / to_design;

    let zone = BoxF {
        x: request.zone.x * to_analysis,
        y: request.zone.y * to_analysis,
        w: (request.zone.w * to_analysis).max(4.0),
        h: (request.zone.h * to_analysis).max(4.0),
    };
    let width = analysis_w as usize;
    let height = analysis_h as usize;

    // Fetch the model before anything expensive starts, so a missing download
    // fails fast instead of after FFmpeg has already spun up.
    let model = if request.engine == TrackerEngine::Hybrid {
        Some(ensure_model(&progress).await?)
    } else {
        None
    };
    if cancel.load(Ordering::SeqCst) {
        return Err("cancelled".to_string());
    }

    progress(4.0, "Открытие видеопотока...".to_string());
    let stream = FrameStream::spawn(FrameStreamOptions {
        ffmpeg: &request.ffmpeg,
        media_url: &request.media_url,
        start_time: request.start_time,
        duration: request.duration,
        interval: request.interval,
        width: width as u32,
        height: height as u32,
        hwaccel: request.hwaccel,
    })?;

    // Decoder task: pushes frames until the consumer stops listening. Dropping
    // the stream on an early exit kills FFmpeg through `kill_on_drop`, which is
    // what keeps a bounded channel from deadlocking against a live encoder.
    let (sender, receiver) = mpsc::channel::<RawFrame>(FRAME_QUEUE);
    let decode_cancel = cancel.clone();
    let decoder = tokio::spawn(async move {
        let mut stream = stream;
        loop {
            match stream.next_frame(&decode_cancel).await {
                Ok(Some(frame)) => {
                    if sender.send(frame).await.is_err() {
                        // Analyser finished early; no need to decode further.
                        return Ok(());
                    }
                }
                Ok(None) => {
                    drop(sender);
                    return stream.finish().await;
                }
                Err(err) => return Err(err),
            }
        }
    });

    let params = TrackParams {
        zone,
        width,
        height,
        to_design,
        interval: request.interval,
        lock_size: request.lock_size,
        confidence_threshold: request.confidence_threshold,
        redetect_after: (request.redetect_after_sec / request.interval)
            .ceil()
            .max(1.0) as usize,
        give_up: (request.give_up_sec / request.interval).ceil().max(1.0) as usize,
        total_frames: request
            .duration
            .map(|duration| (duration / request.interval).ceil().max(1.0) as usize),
        start_time: request.start_time,
        engine: request.engine,
        prefer_gpu: request.prefer_gpu,
        model,
        reference_frame: request.reference_frame,
    };

    // The ONNX session is built inside the blocking task and never leaves it,
    // matching how the vocal remover handles its models.
    let analysis =
        tokio::task::spawn_blocking(move || track(receiver, params, cancel, progress)).await;

    let outcome = match analysis {
        Ok(result) => result,
        Err(err) => Err(format!("tracker task failed: {err}")),
    };

    // Surface a decoder error only when the analysis did not already fail, and
    // only when the analyser ran to the end of the stream: a deliberate early
    // stop kills FFmpeg, and that is not an error worth reporting.
    match (outcome, decoder.await) {
        (Ok(outcome), Ok(Err(err))) if !outcome.stopped_early => Err(err),
        (Ok(outcome), _) => Ok(outcome),
        (Err(err), _) => Err(err),
    }
}

struct TrackParams {
    zone: BoxF,
    width: usize,
    height: usize,
    to_design: f64,
    interval: f64,
    lock_size: bool,
    confidence_threshold: f32,
    redetect_after: usize,
    give_up: usize,
    total_frames: Option<usize>,
    start_time: f64,
    engine: TrackerEngine,
    prefer_gpu: bool,
    model: Option<PathBuf>,
    reference_frame: Option<PathBuf>,
}

/// The analysis loop. Runs on a blocking thread and owns the ONNX session.
fn track(
    mut receiver: mpsc::Receiver<RawFrame>,
    params: TrackParams,
    cancel: Arc<AtomicBool>,
    progress: ProgressSink,
) -> Result<TrackerOutput, String> {
    let started = std::time::Instant::now();
    let TrackParams {
        zone,
        width,
        height,
        to_design,
        interval,
        lock_size,
        confidence_threshold,
        redetect_after,
        give_up,
        total_frames,
        start_time,
        engine,
        prefer_gpu,
        model,
        reference_frame,
    } = params;

    let mut vit_session = match model.as_deref() {
        Some(path) => Some(VitTracker::load(path, prefer_gpu)?),
        None => None,
    };

    // Reference patch: what the user actually selected. Used to re-acquire the
    // banner if the range does not start on the captured frame.
    let reference_template = match reference_frame.as_deref() {
        Some(path) if path.is_file() => {
            let image = image::open(path)
                .map_err(|err| format!("open reference frame: {err}"))?
                .to_rgb8();
            let bgr = letterbox_bgr24(&image, width, height);
            let gray = GrayFrame::from_bgr24(&bgr, width, height);
            Some(Template::extract(&gray, zone)?)
        }
        _ => None,
    };

    let mut tracker: Option<VitTracker> = None;
    let mut template: Option<Template> = None;
    let mut smoother: Option<BoxSmoother> = None;
    let mut device = "cpu";
    let mut normalization = "n/a";

    let mut keyframes: Vec<TrackedKeyframe> = Vec::new();
    let mut last_keyframe_pos = (f64::MIN, f64::MIN);
    let mut last_keyframe_size = (0.0f64, 0.0f64);
    let mut analyzed = 0usize;
    let mut matched = 0usize;
    let mut redetections = 0usize;
    let mut min_confidence = f32::MAX;
    let mut max_confidence = 0.0f32;
    let mut last_match_time = start_time;
    let mut lost_frames = 0usize;
    let mut frames_since_redetect = 0usize;
    let mut gaps: Vec<(f64, f64)> = Vec::new();
    let mut gap_start: Option<f64> = None;
    let mut truncated = false;
    let mut stopped_early = false;

    while let Some(frame) = receiver.blocking_recv() {
        if cancel.load(Ordering::SeqCst) {
            return Err("cancelled".to_string());
        }
        analyzed += 1;
        let view = FrameView {
            data: &frame.data,
            width,
            height,
        };
        let gray = GrayFrame::from_bgr24(&frame.data, width, height);

        // ---- first frame: decide where the banner actually is ----
        if template.is_none() {
            let mut start_box = zone;
            if let Some(reference) = reference_template.as_ref() {
                let here = reference.score_at(&gray, zone);
                if here < 0.5 {
                    // The captured frame is not the start of the range: look for
                    // the banner across the whole frame before giving up.
                    match reference.redetect(&gray) {
                        Some((found, score)) if score >= 0.5 => {
                            start_box = found;
                            redetections += 1;
                        }
                        _ => {
                            return Err(format!(
                                "the selected banner is not visible at the start of the range \
(similarity {here:.2}); set the start time to the captured frame or recapture the frame"
                            ));
                        }
                    }
                }
            }
            // Re-extract from the video frame itself: same decoder and scaler as
            // every later frame, so the similarity scores are directly comparable.
            let extracted = Template::extract(&gray, start_box)?;
            if let Some(session) = vit_session.take() {
                let built = session.init(view, start_box)?;
                device = if built.accelerated { "gpu" } else { "cpu" };
                normalization = built.normalization();
                tracker = Some(built);
            }
            smoother = Some(BoxSmoother::new(start_box, lock_size));
            template = Some(extracted);
            push_keyframe(
                &mut keyframes,
                &mut last_keyframe_pos,
                &mut last_keyframe_size,
                frame.time_sec,
                start_box,
                1.0,
                to_design,
                true,
            );
            matched += 1;
            last_match_time = frame.time_sec;
            report(&progress, analyzed, total_frames, matched, &frame);
            continue;
        }

        let template_ref = template.as_ref().expect("template initialised above");
        let smoother_ref = smoother.as_mut().expect("smoother initialised above");

        // ---- candidate ----
        let (candidate, quality) = match tracker.as_mut() {
            Some(vit) => {
                let (candidate, vit_score) = vit.update(view)?;
                let quality = if vit_score >= VIT_SCORE_FLOOR {
                    template_ref.score_at(&gray, candidate).clamp(0.0, 1.0)
                } else {
                    // The network itself says there is nothing here (blank or
                    // black frame); do not let ZNCC vote on noise.
                    0.0
                };
                (candidate, quality)
            }
            // Correlation-only engine: local search around the predicted box.
            None => {
                let predicted = smoother_ref.predict(interval);
                let (found, score) = template_ref.search_local(&gray, predicted, 48);
                (found, score.clamp(0.0, 1.0))
            }
        };

        let mut accepted = quality >= confidence_threshold;
        let mut best = candidate;
        let mut best_quality = quality;

        // ---- recovery ----
        if !accepted {
            lost_frames += 1;
            frames_since_redetect += 1;
            if lost_frames >= redetect_after && frames_since_redetect >= redetect_after {
                frames_since_redetect = 0;
                if let Some((found, score)) = template_ref.redetect(&gray) {
                    if score >= confidence_threshold {
                        redetections += 1;
                        best = found;
                        best_quality = score.clamp(0.0, 1.0);
                        accepted = true;
                        smoother_ref.reset(found);
                        if let Some(vit) = tracker.as_mut() {
                            vit.reseed(found);
                        }
                    }
                }
            }
            if !accepted {
                if gap_start.is_none() {
                    gap_start = Some(last_match_time);
                }
                if lost_frames >= give_up {
                    stopped_early = true;
                    break;
                }
                report(&progress, analyzed, total_frames, matched, &frame);
                continue;
            }
        }

        // ---- accepted ----
        if let Some(start) = gap_start.take() {
            gaps.push((start, frame.time_sec));
        }
        lost_frames = 0;
        frames_since_redetect = 0;
        matched += 1;
        min_confidence = min_confidence.min(best_quality);
        max_confidence = max_confidence.max(best_quality);
        last_match_time = frame.time_sec;

        let smoothed = smoother_ref.update(interval, best, best_quality as f64);
        let smoothed = clamp_box(smoothed, width as f64, height as f64);
        if let Some(vit) = tracker.as_mut() {
            // Feed the filtered box back so the next search crop is centred on
            // the de-noised estimate rather than on raw detector jitter.
            vit.reseed(smoothed);
        }

        if push_keyframe(
            &mut keyframes,
            &mut last_keyframe_pos,
            &mut last_keyframe_size,
            frame.time_sec,
            smoothed,
            best_quality,
            to_design,
            false,
        ) && keyframes.len() >= MAX_KEYFRAMES
        {
            truncated = true;
            stopped_early = true;
            break;
        }
        report(&progress, analyzed, total_frames, matched, &frame);
    }
    // Dropping the receiver unblocks the decoder, which then shuts FFmpeg down.
    drop(receiver);

    if let Some(start) = gap_start.take() {
        gaps.push((start, last_match_time.max(start)));
    }
    if matched == 0 || keyframes.is_empty() {
        return Err("tracker found no matches in the sampled frames".to_string());
    }

    let elapsed = started.elapsed().as_secs_f64().max(1e-3);
    Ok(TrackerOutput {
        keyframes,
        analyzed_frames: analyzed,
        matched_frames: matched,
        min_confidence: if min_confidence == f32::MAX {
            0.0
        } else {
            min_confidence
        },
        max_confidence,
        end_time_sec: last_match_time + interval,
        truncated,
        engine: match engine {
            TrackerEngine::Hybrid => "vittrack+zncc",
            TrackerEngine::Correlation => "zncc",
        },
        device,
        normalization,
        redetections,
        gaps,
        fps: analyzed as f64 / elapsed,
        stopped_early,
    })
}

#[allow(clippy::too_many_arguments)]
fn push_keyframe(
    keyframes: &mut Vec<TrackedKeyframe>,
    last_pos: &mut (f64, f64),
    last_size: &mut (f64, f64),
    time_sec: f64,
    target: BoxF,
    confidence: f32,
    scale: f64,
    force: bool,
) -> bool {
    let moved = (target.x - last_pos.0).abs() > KEYFRAME_MIN_DELTA_PX
        || (target.y - last_pos.1).abs() > KEYFRAME_MIN_DELTA_PX
        || (target.w - last_size.0).abs() > KEYFRAME_MIN_DELTA_PX
        || (target.h - last_size.1).abs() > KEYFRAME_MIN_DELTA_PX;
    if !force && !moved {
        return false;
    }
    *last_pos = (target.x, target.y);
    *last_size = (target.w, target.h);
    keyframes.push(TrackedKeyframe {
        time_sec,
        x: (target.x * scale).round() as i32,
        y: (target.y * scale).round() as i32,
        width: (target.w * scale).round().max(1.0) as u32,
        height: (target.h * scale).round().max(1.0) as u32,
        confidence,
    });
    true
}

fn clamp_box(mut target: BoxF, width: f64, height: f64) -> BoxF {
    target.w = target.w.clamp(4.0, width);
    target.h = target.h.clamp(4.0, height);
    target.x = target.x.clamp(0.0, (width - target.w).max(0.0));
    target.y = target.y.clamp(0.0, (height - target.h).max(0.0));
    target
}

fn report(
    progress: &ProgressSink,
    analyzed: usize,
    total: Option<usize>,
    matched: usize,
    frame: &RawFrame,
) {
    if analyzed % 20 != 0 {
        return;
    }
    let percent = match total {
        Some(total) if total > 0 => 5.0 + 94.0 * (analyzed as f32 / total as f32).min(1.0),
        // Open-ended range: creep towards 95% asymptotically instead of faking
        // a percentage we cannot know.
        _ => 5.0 + 90.0 * (1.0 - (-(analyzed as f32) / 3000.0).exp()),
    };
    progress(
        percent,
        format!(
            "Кадр {analyzed} · {} · совпадений {matched}",
            format_timecode(frame.time_sec)
        ),
    );
}

fn format_timecode(seconds: f64) -> String {
    let total = seconds.max(0.0) as u64;
    let (h, m, s) = (total / 3600, (total / 60) % 60, total % 60);
    if h > 0 {
        format!("{h}:{m:02}:{s:02}")
    } else {
        format!("{m}:{s:02}")
    }
}

/// Resize preserving aspect ratio and pad with black, mirroring the ffmpeg
/// `scale=force_original_aspect_ratio=decrease,pad` chain the frame pipe uses.
fn letterbox_bgr24(image: &RgbImage, width: usize, height: usize) -> Vec<u8> {
    let scale = (width as f64 / image.width().max(1) as f64)
        .min(height as f64 / image.height().max(1) as f64);
    let new_w = ((image.width() as f64 * scale).round() as u32)
        .max(1)
        .min(width as u32);
    let new_h = ((image.height() as f64 * scale).round() as u32)
        .max(1)
        .min(height as u32);
    let resized = image::imageops::resize(image, new_w, new_h, FilterType::Triangle);
    let offset_x = (width - new_w as usize) / 2;
    let offset_y = (height - new_h as usize) / 2;

    let mut buffer = vec![0u8; width * height * 3];
    for y in 0..new_h as usize {
        for x in 0..new_w as usize {
            let pixel = resized.get_pixel(x as u32, y as u32).0;
            let index = ((y + offset_y) * width + x + offset_x) * 3;
            buffer[index] = pixel[2];
            buffer[index + 1] = pixel[1];
            buffer[index + 2] = pixel[0];
        }
    }
    buffer
}

fn app_data_root() -> PathBuf {
    dirs::data_local_dir()
        .or_else(|| std::env::var("LOCALAPPDATA").map(PathBuf::from).ok())
        .unwrap_or_else(std::env::temp_dir)
        .join("Fetchr")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keyframes_are_only_emitted_on_real_movement() {
        let mut keyframes = Vec::new();
        let mut pos = (f64::MIN, f64::MIN);
        let mut size = (0.0, 0.0);
        let base = BoxF {
            x: 100.0,
            y: 50.0,
            w: 120.0,
            h: 40.0,
        };
        assert!(push_keyframe(
            &mut keyframes, &mut pos, &mut size, 0.0, base, 1.0, 1.0, true
        ));
        // Sub-threshold wobble must not produce keyframes.
        for step in 1..20 {
            let jitter = BoxF {
                x: base.x + if step % 2 == 0 { 0.9 } else { -0.9 },
                ..base
            };
            assert!(!push_keyframe(
                &mut keyframes, &mut pos, &mut size, step as f64, jitter, 1.0, 1.0, false
            ));
        }
        // A real move does.
        let moved = BoxF { x: 140.0, ..base };
        assert!(push_keyframe(
            &mut keyframes, &mut pos, &mut size, 20.0, moved, 1.0, 1.0, false
        ));
        assert_eq!(keyframes.len(), 2);
    }

    #[test]
    fn keyframes_scale_into_design_space() {
        let mut keyframes = Vec::new();
        let mut pos = (f64::MIN, f64::MIN);
        let mut size = (0.0, 0.0);
        // Analysis at 960 wide, design at 1920: everything doubles.
        push_keyframe(
            &mut keyframes,
            &mut pos,
            &mut size,
            0.0,
            BoxF {
                x: 100.0,
                y: 50.0,
                w: 120.0,
                h: 40.0,
            },
            0.9,
            2.0,
            true,
        );
        let frame = keyframes[0];
        assert_eq!((frame.x, frame.y), (200, 100));
        assert_eq!((frame.width, frame.height), (240, 80));
    }

    #[test]
    fn boxes_are_clamped_inside_the_frame() {
        let clamped = clamp_box(
            BoxF {
                x: -30.0,
                y: 500.0,
                w: 120.0,
                h: 40.0,
            },
            960.0,
            540.0,
        );
        assert_eq!(clamped.x, 0.0);
        assert_eq!(clamped.y, 500.0);
        assert!(clamped.y + clamped.h <= 540.0);
    }

    #[test]
    fn timecodes_are_formatted_for_both_ranges() {
        assert_eq!(format_timecode(75.0), "1:15");
        assert_eq!(format_timecode(3725.0), "1:02:05");
    }
}
