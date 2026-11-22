use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{anyhow, Context, Result};
use futures::{StreamExt, TryStreamExt};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

use crate::binaries::{resolve_binary, FFMPEG, FFPROBE};
use crate::chat_overlay::blur_filter::{
    append_blur_zone_filters, blur_active_intervals, map_blur_zones_to_fragments,
    normalized_blur_zones, offset_blur_zone_times,
};
use crate::chat_overlay::blur_timeline_offset_seconds;
use crate::chat_overlay::composer::{decode_hwaccels, encoder_attempts, EncoderAttempt};
use crate::chat_overlay::emit_log;
use crate::chat_overlay::settings::EffectiveChatOverlaySettings;
use crate::jobs::queue::QueueManager;
use crate::jobs::types::{BlurEffect, BlurZone, Job, JobProgress, PerformanceSettings};

/// Below this the copy-vs-encode bookkeeping costs more than it saves.
const MIN_COPY_SEGMENT_SEC: f64 = 3.0;
/// If blur covers nearly all of the video there is nothing left to stream-copy.
/// Copying is close to free, so even a 15% untouched remainder pays for the
/// extra processes.
const MAX_BLUR_COVERAGE: f64 = 0.85;
/// Blurred segments encoded at once. One ffmpeg process leaves the hardware
/// mostly idle (see [`chunk_plan`]); three sit near the measured QSV ceiling
/// and stay within consumer NVENC's session limit.
const PARALLEL_SEGMENTS: usize = 3;
/// Generous because opening an unindexed fragmented MP4 is slow; see
/// [`probe_video_info`].
const PROBE_TIMEOUT: Duration = Duration::from_secs(300);
/// Shorter videos are not worth the extra processes and concat pass.
const MIN_CHUNKED_SEC: f64 = 120.0;
/// Guard against pathological plans spawning hundreds of ffmpeg processes.
const MAX_SEGMENTS: usize = 48;

pub async fn render_blur_zones_for_video(
    queue: &Arc<QueueManager>,
    job: &Job,
    input_video: &Path,
    cancel: Arc<AtomicBool>,
    bin_dir: Option<&Path>,
) -> Result<PathBuf> {
    let started = Instant::now();
    let ffmpeg = resolve_binary(FFMPEG, bin_dir)
        .ok_or_else(|| anyhow!("ffmpeg.exe not found - set binaries folder in Settings"))?;
    let performance = job
        .spec
        .performance
        .clone()
        .unwrap_or_default()
        .with_defaults();
    let settings = job
        .spec
        .chat_overlay
        .clone()
        .unwrap_or_default()
        .with_defaults();
    let configured = EffectiveChatOverlaySettings::from(settings);
    let source = probe_video_info(input_video, bin_dir).await;
    // Blur alone keeps the source's own resolution and frame rate: a 1440p
    // VOD must not come back as 1080p just because the chat overlay settings
    // (unused here) say 1920x1080, and skipping scale/pad/fps is also what
    // lets untouched spans be stream-copied. The configured geometry is only a
    // fallback for a source ffprobe could not read.
    let (effective, normalize) = match source.as_ref() {
        Some(info) => (
            EffectiveChatOverlaySettings {
                output_width: info.width,
                output_height: info.height,
                ..configured
            },
            false,
        ),
        None => {
            emit_log(
                queue,
                &job.id,
                &format!(
                    "Sponsor blur: ffprobe could not read the source - falling back to {}x{}",
                    configured.output_width, configured.output_height
                ),
            );
            (configured, true)
        }
    };
    // Cut videos get their tracking times remapped onto the concatenated
    // fragment timeline; a plain start offset only applies to uncut jobs.
    let blur_zones = if job.spec.fragments.is_empty() {
        offset_blur_zone_times(&job.spec.blur_zones, blur_timeline_offset_seconds(job))
    } else {
        let (mapped, disabled) =
            map_blur_zones_to_fragments(&job.spec.blur_zones, &job.spec.fragments);
        if disabled > 0 {
            emit_log(
                queue,
                &job.id,
                &format!(
                    "Sponsor blur: {disabled} tracked zone(s) disabled - all keyframes fall outside the cut fragments"
                ),
            );
        }
        mapped
    };
    let zones = normalized_blur_zones(&blur_zones, effective.output_width, effective.output_height);
    if zones.is_empty() {
        return Ok(input_video.to_path_buf());
    }

    let output_video = input_video.with_file_name(format!(
        "{}_blur.mp4",
        input_video
            .file_stem()
            .and_then(|stem| stem.to_str())
            .unwrap_or("video")
    ));
    queue.set_progress_stage(
        &job.id,
        60.0,
        100.0,
        Some("Rendering sponsor blur".to_string()),
    );
    queue.set_progress(
        &job.id,
        JobProgress {
            percent: 0.0,
            message: Some("Rendering sponsor blur".to_string()),
            ..JobProgress::default()
        },
    );

    let total_duration = source.as_ref().and_then(|info| info.duration);
    if !normalize {
        emit_log(
            queue,
            &job.id,
            &format!(
                "Sponsor blur: keeping source geometry {}x{}",
                effective.output_width, effective.output_height
            ),
        );
    }

    let ctx = RenderContext {
        ffmpeg,
        performance,
        normalize,
        settings: effective,
    };

    // Try the cheap path first: re-encode only the spans where a zone is
    // actually visible and stream-copy everything else.
    if let (Some(info), Some(duration)) = (source.as_ref(), total_duration) {
        // Probing keyframes walks the whole file, so only do it once the cheap
        // structural gates have already said segmentation is possible.
        let keyframes = if segmentation_possible(&zones, info, duration, normalize) {
            probe_keyframes(input_video, bin_dir, info.start_time).await
        } else {
            Vec::new()
        };
        let plan = plan_segments(&zones, duration, &keyframes)
            .or_else(|| chunk_plan(duration));
        if let Some(plan) = plan {
            let encoded: f64 = plan
                .iter()
                .filter(|segment| segment.blurred)
                .map(|segment| segment.duration(duration))
                .sum();
            let message = if plan.iter().all(|segment| segment.blurred) {
                format!(
                    "Sponsor blur: chunked render - {} in {} parallel chunks",
                    format_duration(duration),
                    plan.len()
                )
            } else {
                format!(
                    "Sponsor blur: segmented render - {} of {} re-encoded ({} segments), rest stream-copied",
                    format_duration(encoded),
                    format_duration(duration),
                    plan.len()
                )
            };
            emit_log(queue, &job.id, &message);
            match render_segmented(
                queue,
                job,
                &ctx,
                input_video,
                &output_video,
                &zones,
                &plan,
                encoded,
                &cancel,
            )
            .await
            {
                Ok(path) => {
                    finish(queue, job, started);
                    return Ok(path);
                }
                Err(err) if cancel.load(Ordering::SeqCst) => return Err(err),
                Err(err) => {
                    emit_log(
                        queue,
                        &job.id,
                        &format!("Sponsor blur: segmented render failed ({err}) - falling back to a full pass"),
                    );
                }
            }
        }
    }

    render_single_pass(
        queue,
        job,
        &ctx,
        input_video,
        &output_video,
        &zones,
        total_duration,
        &cancel,
    )
    .await?;
    finish(queue, job, started);
    Ok(output_video)
}

fn finish(queue: &Arc<QueueManager>, job: &Job, started: Instant) {
    queue.set_progress(
        &job.id,
        JobProgress {
            percent: 100.0,
            message: Some("Sponsor blur rendered".to_string()),
            ..JobProgress::default()
        },
    );
    emit_log(
        queue,
        &job.id,
        &format!(
            "Sponsor blur: total time {}",
            format_duration(started.elapsed().as_secs_f64())
        ),
    );
}

struct RenderContext {
    ffmpeg: PathBuf,
    performance: PerformanceSettings,
    normalize: bool,
    settings: EffectiveChatOverlaySettings,
}

// ---------------------------------------------------------------------------
// Source probing
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
struct VideoInfo {
    width: u32,
    height: u32,
    fps: Option<f64>,
    codec: String,
    duration: Option<f64>,
    /// Container start time. MPEG-TS from HLS rarely starts at zero, while
    /// ffmpeg's `-ss` and filter `t` count from it; keyframe times and concat
    /// in/out points are raw timestamps and need this offset.
    start_time: f64,
}

async fn probe_video_info(path: &Path, bin_dir: Option<&Path>) -> Option<VideoInfo> {
    let ffprobe = resolve_binary(FFPROBE, bin_dir)?;
    let mut cmd = Command::new(&ffprobe);
    configure_silent(&mut cmd);
    cmd.kill_on_drop(true)
        .args(["-v", "error", "-select_streams", "v:0"])
        .args([
            "-show_entries",
            "stream=width,height,codec_name,avg_frame_rate:format=duration,start_time",
        ])
        .args(["-of", "default=noprint_wrappers=1"])
        .arg(path)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    // A fragmented MP4 straight from the HLS downloader has no index, so
    // ffprobe walks every fragment header to learn the duration: ~1.5 minutes
    // on a 15 GB VOD. Later opens hit the OS cache and are quick.
    let output = tokio::time::timeout(PROBE_TIMEOUT, cmd.output())
        .await
        .ok()?
        .ok()?;
    let text = String::from_utf8_lossy(&output.stdout);

    let mut width = None;
    let mut height = None;
    let mut codec = None;
    let mut fps = None;
    let mut duration = None;
    let mut start_time = 0.0;
    for line in text.lines() {
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let value = value.trim();
        match key.trim() {
            "width" => width = value.parse::<u32>().ok(),
            "height" => height = value.parse::<u32>().ok(),
            "codec_name" => codec = Some(value.to_ascii_lowercase()),
            "avg_frame_rate" => fps = parse_rational(value),
            "duration" => {
                duration = value.parse::<f64>().ok().filter(|v| v.is_finite() && *v > 0.0)
            }
            "start_time" => {
                start_time = value.parse::<f64>().ok().filter(|v| v.is_finite()).unwrap_or(0.0)
            }
            _ => {}
        }
    }
    Some(VideoInfo {
        width: width?,
        height: height?,
        fps,
        codec: codec.unwrap_or_default(),
        duration,
        start_time,
    })
}

fn parse_rational(value: &str) -> Option<f64> {
    let (num, den) = value.split_once('/')?;
    let num: f64 = num.trim().parse().ok()?;
    let den: f64 = den.trim().parse().ok()?;
    if den == 0.0 {
        return None;
    }
    let fps = num / den;
    fps.is_finite().then_some(fps).filter(|v| *v > 0.0)
}

/// Presentation timestamps of every keyframe in the video stream. Segment
/// boundaries must land on these or a stream-copied segment would start on a
/// frame that references data it no longer has.
///
/// Reads packet flags only: no frame is decoded, so this costs a demux pass
/// instead of decoding every keyframe of the file.
async fn probe_keyframes(path: &Path, bin_dir: Option<&Path>, start_time: f64) -> Vec<f64> {
    let Some(ffprobe) = resolve_binary(FFPROBE, bin_dir) else {
        return Vec::new();
    };
    let mut cmd = Command::new(&ffprobe);
    configure_silent(&mut cmd);
    cmd.kill_on_drop(true)
        .args(["-v", "error", "-select_streams", "v:0"])
        .args(["-show_entries", "packet=pts_time,flags"])
        .args(["-of", "csv=p=0"])
        .arg(path)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let Ok(Ok(output)) = tokio::time::timeout(Duration::from_secs(600), cmd.output()).await else {
        return Vec::new();
    };
    let mut times: Vec<f64> = String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| {
            let (pts, flags) = line.trim().split_once(',')?;
            flags.starts_with('K').then(|| pts.parse::<f64>().ok())?
        })
        .map(|value| value - start_time)
        .filter(|value| value.is_finite() && *value >= 0.0)
        .collect();
    times.sort_by(f64::total_cmp);
    times.dedup_by(|a, b| (*a - *b).abs() < 0.0005);
    times
}

// ---------------------------------------------------------------------------
// Segment planning
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
struct Segment {
    start: f64,
    /// `None` means "to end of file".
    end: Option<f64>,
    blurred: bool,
}

impl Segment {
    fn duration(&self, total: f64) -> f64 {
        (self.end.unwrap_or(total) - self.start).max(0.0)
    }
}

/// Cheap structural check: is segmented rendering even conceivable for this
/// source? Stream-copied and re-encoded parts have to be concatenable, so the
/// source must already be H.264 (every encoder in the fallback chain is H.264)
/// and must not need resizing. A zone without tracking covers the whole
/// timeline and leaves nothing to copy.
fn segmentation_possible(
    zones: &[BlurZone],
    info: &VideoInfo,
    duration: f64,
    normalize: bool,
) -> bool {
    if normalize || info.codec != "h264" {
        return false;
    }
    let intervals = blur_active_intervals(zones, duration);
    if intervals.is_empty() {
        return false;
    }
    let coverage: f64 = intervals.iter().map(|(a, b)| b - a).sum();
    coverage < duration * MAX_BLUR_COVERAGE
}

/// Build a copy/encode plan, or `None` when a single full pass is the better
/// (or only correct) option.
fn plan_segments(zones: &[BlurZone], duration: f64, keyframes: &[f64]) -> Option<Vec<Segment>> {
    if keyframes.len() < 2 {
        return None;
    }
    let intervals = blur_active_intervals(zones, duration);
    if intervals.is_empty() {
        return None;
    }

    let mut segments: Vec<Segment> = Vec::new();
    let mut cursor = 0.0_f64;
    for (start, end) in intervals {
        let snapped_start = keyframe_at_or_before(keyframes, start).max(cursor);
        let snapped_end = keyframe_at_or_after(keyframes, end);
        if let Some(snapped_end) = snapped_end {
            if snapped_end <= snapped_start {
                continue;
            }
        }
        if snapped_start > cursor {
            segments.push(Segment {
                start: cursor,
                end: Some(snapped_start),
                blurred: false,
            });
        }
        segments.push(Segment {
            start: snapped_start,
            end: snapped_end,
            blurred: true,
        });
        match snapped_end {
            Some(value) => cursor = value,
            // The blur runs to EOF; nothing left to copy.
            None => return finalize_plan(segments, duration),
        }
    }
    if cursor < duration {
        segments.push(Segment {
            start: cursor,
            end: None,
            blurred: false,
        });
    }
    finalize_plan(segments, duration)
}

fn finalize_plan(segments: Vec<Segment>, duration: f64) -> Option<Vec<Segment>> {
    if segments.len() > MAX_SEGMENTS {
        return None;
    }
    let copied: f64 = segments
        .iter()
        .filter(|segment| !segment.blurred)
        .map(|segment| segment.duration(duration))
        .sum();
    // Not enough untouched footage for the extra process orchestration to pay off.
    if copied < MIN_COPY_SEGMENT_SEC {
        return None;
    }
    Some(segments)
}

/// Whole-video re-encode split into equal chunks that run side by side.
///
/// One ffmpeg process barely overlaps decode, filtering and encoding: on a
/// 1440p60 HEVC source with QSV it ran at 1.35x, while two processes on
/// different halves reached 1.92x and four 2.24x. Every chunk is re-encoded,
/// so cuts need no keyframes; input `-ss`/`-t` split the frames between
/// neighbours, give or take one frame (~16 ms) at each cut.
fn chunk_plan(duration: f64) -> Option<Vec<Segment>> {
    if duration < MIN_CHUNKED_SEC {
        return None;
    }
    let count = PARALLEL_SEGMENTS;
    let length = duration / count as f64;
    Some(
        (0..count)
            .map(|idx| Segment {
                start: idx as f64 * length,
                end: (idx + 1 < count).then(|| (idx + 1) as f64 * length),
                blurred: true,
            })
            .collect(),
    )
}

fn keyframe_at_or_before(keyframes: &[f64], time: f64) -> f64 {
    keyframes
        .iter()
        .copied()
        .take_while(|value| *value <= time + 0.0005)
        .last()
        .unwrap_or(0.0)
}

fn keyframe_at_or_after(keyframes: &[f64], time: f64) -> Option<f64> {
    keyframes
        .iter()
        .copied()
        .find(|value| *value >= time - 0.0005)
}

// ---------------------------------------------------------------------------
// Filter graph
// ---------------------------------------------------------------------------

fn blur_only_filter(
    zones: &[BlurZone],
    settings: &EffectiveChatOverlaySettings,
    normalize: bool,
) -> String {
    let mut filter = if normalize {
        format!(
            "[0:v]scale={w}:{h}:force_original_aspect_ratio=decrease,\
pad={w}:{h}:(ow-iw)/2:(oh-ih)/2,fps={fps},setsar=1[base0];",
            w = settings.output_width,
            h = settings.output_height,
            fps = settings.fps,
        )
    } else {
        "[0:v]null[base0];".to_string()
    };
    let mut current = "base0".to_string();
    let mut image_input = 1;
    append_blur_zone_filters(&mut filter, &mut current, zones, &mut image_input);
    filter.push_str(&format!("[{current}]format=yuv420p[v]"));
    filter
}

// ---------------------------------------------------------------------------
// Encoder selection
// ---------------------------------------------------------------------------

#[derive(Clone)]
struct RenderPlan {
    hwaccel: Option<&'static str>,
    encoder: EncoderAttempt,
}

/// Probe (decode-hwaccel, encoder) combinations on a half-second slice so a
/// broken GPU path costs a fraction of a second instead of failing hours into
/// the real render. Always resolves, because the chain ends with libx264.
async fn select_render_plan(
    queue: &Arc<QueueManager>,
    job: &Job,
    ctx: &RenderContext,
    input_video: &Path,
    zones: &[BlurZone],
    probe_at: f64,
) -> RenderPlan {
    let filter = blur_only_filter(zones, &ctx.settings, ctx.normalize);
    let attempts = encoder_attempts(&ctx.performance, None);
    let safe_id: String = job
        .id
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
        .collect();
    let probe_out = std::env::temp_dir().join(format!("fetchr_blur_probe_{safe_id}.mp4"));
    let mut fallback: Option<RenderPlan> = None;

    // Software decode first: copying every hardware-decoded frame back for the
    // CPU blur filters cost more than it saved (1440p HEVC: 7.2x decode on the
    // CPU vs 1.4x through d3d11va). The hardware path stays as a fallback.
    let mut hwaccels = decode_hwaccels();
    hwaccels.sort_by_key(|hwaccel| hwaccel.is_some());
    for hwaccel in hwaccels {
        for encoder in &attempts {
            let plan = RenderPlan {
                hwaccel,
                encoder: encoder.clone(),
            };
            if fallback.is_none() {
                fallback = Some(plan.clone());
            }
            let mut cmd = Command::new(&ctx.ffmpeg);
            configure_silent(&mut cmd);
            // stderr is discarded rather than piped: `status()` never drains a
            // pipe, so a chatty failing encoder could deadlock the probe.
            cmd.kill_on_drop(true)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .args(["-y", "-hide_banner", "-v", "error"]);
            if let Some(hw) = hwaccel {
                cmd.args(["-hwaccel", hw]);
            }
            cmd.args(["-ss", &format!("{probe_at:.3}"), "-t", "0.5", "-i"])
                .arg(input_video);
            append_image_inputs(&mut cmd, zones);
            cmd.args(["-filter_complex", &filter, "-map", "[v]", "-an"])
                .args(&plan.encoder.args)
                .arg(&probe_out);
            let ok = matches!(
                tokio::time::timeout(PROBE_TIMEOUT, cmd.status()).await,
                Ok(Ok(status)) if status.success()
            );
            let _ = tokio::fs::remove_file(&probe_out).await;
            if ok {
                emit_log(
                    queue,
                    &job.id,
                    &format!(
                        "Sponsor blur: encoder {} (decode: {})",
                        plan.encoder.label,
                        hwaccel.unwrap_or("cpu")
                    ),
                );
                return plan;
            }
        }
    }
    let plan = fallback.expect("encoder_attempts is never empty");
    emit_log(
        queue,
        &job.id,
        &format!(
            "Sponsor blur: no encoder passed the probe - using {} anyway",
            plan.encoder.label
        ),
    );
    plan
}

fn append_image_inputs(cmd: &mut Command, zones: &[BlurZone]) {
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
}

// ---------------------------------------------------------------------------
// Single pass
// ---------------------------------------------------------------------------

#[allow(clippy::too_many_arguments)]
async fn render_single_pass(
    queue: &Arc<QueueManager>,
    job: &Job,
    ctx: &RenderContext,
    input_video: &Path,
    output_video: &Path,
    zones: &[BlurZone],
    total_duration: Option<f64>,
    cancel: &Arc<AtomicBool>,
) -> Result<()> {
    let probe_at = total_duration.map(|d| (d * 0.5).min(d - 1.0).max(0.0)).unwrap_or(0.0);
    let plan = select_render_plan(queue, job, ctx, input_video, zones, probe_at).await;
    let filter = blur_only_filter(zones, &ctx.settings, ctx.normalize);

    let mut cmd = Command::new(&ctx.ffmpeg);
    configure_silent(&mut cmd);
    cmd.kill_on_drop(true)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .args(["-y", "-hide_banner", "-progress", "pipe:1", "-nostats"]);
    if let Some(hw) = plan.hwaccel {
        cmd.args(["-hwaccel", hw]);
    }
    cmd.arg("-i").arg(input_video);
    for zone in zones
        .iter()
        .filter(|zone| zone.effect == BlurEffect::ImageOverlay)
    {
        match zone.image_path.as_deref() {
            Some(path) if Path::new(path).is_file() => {
                cmd.args(["-loop", "1", "-i"]).arg(path);
            }
            _ => emit_log(
                queue,
                &job.id,
                &format!(
                    "Sponsor blur: image overlay zone skipped - file not found: {}",
                    zone.image_path.as_deref().unwrap_or("<empty>")
                ),
            ),
        }
    }

    cmd.args(["-filter_complex", &filter, "-map", "[v]", "-map", "0:a?"]);
    if let Some(threads) = ctx.performance.cpu_threads() {
        cmd.args(["-threads", &threads.to_string()]);
    }
    cmd.args(&plan.encoder.args)
        .args(["-c:a", "copy"])
        .arg(output_video);

    let command_line = format!(
        "{} -i {} -filter_complex <sponsor-blur> {}",
        ctx.ffmpeg.display(),
        input_video.display(),
        output_video.display()
    );
    queue.log_command_started(&job.id, command_line.clone(), None);
    emit_log(
        queue,
        &job.id,
        &format!("Sponsor blur: rendering {} zone(s)...", zones.len()),
    );
    let result = run_with_progress(queue, job, cmd, cancel, move |elapsed| {
        total_duration.map(|duration| (elapsed / duration * 100.0).clamp(0.0, 99.0))
    })
    .await;
    queue.log_command_finished(&job.id, command_line, result.as_ref().ok().copied().flatten());
    match result {
        Ok(_) => Ok(()),
        Err(err) => {
            let _ = tokio::fs::remove_file(output_video).await;
            Err(err)
        }
    }
}

// ---------------------------------------------------------------------------
// Segmented render
// ---------------------------------------------------------------------------

#[allow(clippy::too_many_arguments)]
async fn render_segmented(
    queue: &Arc<QueueManager>,
    job: &Job,
    ctx: &RenderContext,
    input_video: &Path,
    output_video: &Path,
    zones: &[BlurZone],
    plan: &[Segment],
    encoded_total: f64,
    cancel: &Arc<AtomicBool>,
) -> Result<PathBuf> {
    let work_dir = output_video.with_file_name(format!(
        "{}_segments",
        output_video
            .file_stem()
            .and_then(|stem| stem.to_str())
            .unwrap_or("blur")
    ));
    let _ = tokio::fs::remove_dir_all(&work_dir).await;
    tokio::fs::create_dir_all(&work_dir)
        .await
        .context("create blur segment dir")?;
    let guard = DirGuard(work_dir.clone());

    let first_blur = plan
        .iter()
        .find(|segment| segment.blurred)
        .map(|segment| segment.start)
        .unwrap_or(0.0);
    let render_plan = select_render_plan(queue, job, ctx, input_video, zones, first_blur).await;

    let command_line = format!(
        "{} <segmented sponsor-blur: {} segments> {}",
        ctx.ffmpeg.display(),
        plan.len(),
        output_video.display()
    );
    queue.log_command_started(&job.id, command_line.clone(), None);

    // Encoded seconds per segment, summed into one progress figure while
    // segments run side by side.
    let progress: Arc<Vec<AtomicU64>> =
        Arc::new((0..plan.len()).map(|_| AtomicU64::new(0)).collect());
    let render_plan = &render_plan;
    let segment_jobs = plan
        .iter()
        .enumerate()
        .map(|(idx, segment)| {
            let part = work_dir.join(format!("part{idx:03}.ts"));
            let progress = progress.clone();
            async move {
                if cancel.load(Ordering::SeqCst) {
                    return Err(anyhow!("cancelled"));
                }
                if segment.blurred {
                    let report = move |elapsed: f64| {
                        progress[idx].store(elapsed.to_bits(), Ordering::Relaxed);
                        let done: f64 = progress
                            .iter()
                            .map(|value| f64::from_bits(value.load(Ordering::Relaxed)))
                            .sum();
                        (encoded_total > 0.0)
                            .then(|| (done / encoded_total * 100.0).clamp(0.0, 99.0))
                    };
                    let cmd =
                        blur_segment_command(ctx, render_plan, input_video, zones, segment, &part);
                    run_with_progress(queue, job, cmd, cancel, report)
                        .await
                        .with_context(|| format!("blur segment {idx}"))?;
                } else {
                    copy_segment(ctx, input_video, segment, &part)
                        .await
                        .with_context(|| format!("copy segment {idx}"))?;
                }
                let size = tokio::fs::metadata(&part).await.map(|m| m.len()).unwrap_or(0);
                if size == 0 {
                    return Err(anyhow!("segment {idx} produced no data"));
                }
                Ok(part)
            }
        })
        // Collected eagerly: a lazy `Map` over borrowing closures trips the
        // compiler's `Send` inference for the enclosing future.
        .collect::<Vec<_>>();
    // `buffered` keeps plan order for the concat list; a failure drops the
    // remaining futures, and `kill_on_drop` stops their ffmpeg processes.
    //
    // Untouched spans are still copied out to MPEG-TS parts rather than read
    // in place with concat `inpoint`/`outpoint`: the concat demuxer takes its
    // time base from the first file, and mixing the source with the encoded
    // parts that way produced broken timestamps and dropped a GOP in testing.
    let parts: Vec<PathBuf> = futures::stream::iter(segment_jobs)
        .buffered(PARALLEL_SEGMENTS)
        .try_collect()
        .await?;

    // MPEG-TS carries SPS/PPS inline, so segments from different encoders splice
    // cleanly; MP4 concat would need identical extradata and silently break.
    let list_path = work_dir.join("concat.txt");
    let list = parts
        .iter()
        .map(|part| format!("file '{}'\n", part.display().to_string().replace('\'', "'\\''")))
        .collect::<String>();
    tokio::fs::write(&list_path, list)
        .await
        .context("write concat list")?;

    // Video is concatenated losslessly, then the untouched original audio is
    // muxed back in one copy pass - joining audio per segment would drift by up
    // to a frame at each cut.
    let mut cmd = Command::new(&ctx.ffmpeg);
    configure_silent(&mut cmd);
    cmd.kill_on_drop(true)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .args(["-y", "-hide_banner", "-v", "error"])
        .args(["-fflags", "+genpts", "-f", "concat", "-safe", "0", "-i"])
        .arg(&list_path)
        .arg("-i")
        .arg(input_video)
        .args(["-map", "0:v:0", "-map", "1:a:0?", "-c", "copy"])
        // No +faststart: it rewrites the whole finished file a second time,
        // and local players and editors read the index from the end anyway.
        .arg(output_video);
    let output = cmd.output().await.context("ffmpeg blur concat")?;
    if !output.status.success() {
        let _ = tokio::fs::remove_file(output_video).await;
        return Err(anyhow!(
            "concat failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    queue.log_command_finished(&job.id, command_line, Some(0));
    drop(guard);
    Ok(output_video.to_path_buf())
}

fn blur_segment_command(
    ctx: &RenderContext,
    render_plan: &RenderPlan,
    input_video: &Path,
    zones: &[BlurZone],
    segment: &Segment,
    part: &Path,
) -> Command {
    // `-ss` resets the segment clock to zero, so tracking keyframes have to be
    // rebased or every `enable`/interpolation expression would reference the
    // wrong moment.
    let local_zones = offset_blur_zone_times(zones, segment.start);
    let filter = blur_only_filter(&local_zones, &ctx.settings, ctx.normalize);
    let mut cmd = Command::new(&ctx.ffmpeg);
    configure_silent(&mut cmd);
    cmd.kill_on_drop(true)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .args(["-y", "-hide_banner", "-progress", "pipe:1", "-nostats"]);
    if let Some(hw) = render_plan.hwaccel {
        cmd.args(["-hwaccel", hw]);
    }
    cmd.args(["-ss", &format!("{:.6}", segment.start)]);
    if let Some(end) = segment.end {
        cmd.args(["-t", &format!("{:.6}", end - segment.start)]);
    }
    cmd.arg("-i").arg(input_video);
    append_image_inputs(&mut cmd, &local_zones);
    cmd.args(["-filter_complex", &filter, "-map", "[v]", "-an"]);
    if let Some(threads) = ctx.performance.cpu_threads() {
        cmd.args(["-threads", &threads.to_string()]);
    }
    // The mpegts muxer inserts h264_mp4toannexb itself; forcing the bitstream
    // filter here breaks on encoders that already emit Annex B.
    cmd.args(&render_plan.encoder.args)
        .args(["-f", "mpegts"])
        .arg(part);
    cmd
}

async fn copy_segment(
    ctx: &RenderContext,
    input_video: &Path,
    segment: &Segment,
    part: &Path,
) -> Result<()> {
    let mut cmd = Command::new(&ctx.ffmpeg);
    configure_silent(&mut cmd);
    cmd.kill_on_drop(true)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .args(["-y", "-hide_banner", "-v", "error"])
        .args(["-ss", &format!("{:.6}", segment.start)]);
    if let Some(end) = segment.end {
        cmd.args(["-t", &format!("{:.6}", end - segment.start)]);
    }
    cmd.arg("-i")
        .arg(input_video)
        .args(["-map", "0:v:0", "-an", "-c", "copy"])
        .args(["-f", "mpegts"])
        .arg(part);
    let output = cmd.output().await.context("ffmpeg blur copy segment")?;
    if !output.status.success() {
        return Err(anyhow!("{}", String::from_utf8_lossy(&output.stderr).trim()));
    }
    Ok(())
}

struct DirGuard(PathBuf);

impl Drop for DirGuard {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

// ---------------------------------------------------------------------------
// Process supervision
// ---------------------------------------------------------------------------

/// Run an ffmpeg command that writes `-progress pipe:1`, forwarding stderr to the
/// job log and mapping elapsed output time to a percentage via `percent_of`.
async fn run_with_progress<F>(
    queue: &Arc<QueueManager>,
    job: &Job,
    mut cmd: Command,
    cancel: &Arc<AtomicBool>,
    percent_of: F,
) -> Result<Option<i32>>
where
    F: Fn(f64) -> Option<f64> + Send + 'static,
{
    let mut child = cmd.spawn().context("spawn ffmpeg sponsor blur")?;
    crate::win_power::disable_for_pid(child.id());
    let stderr = child.stderr.take().context("ffmpeg stderr handle")?;
    let q = queue.clone();
    let id = job.id.clone();
    let stderr_task = tokio::spawn(async move {
        let mut captured = String::new();
        let mut reader = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = reader.next_line().await {
            if !captured.is_empty() {
                captured.push('\n');
            }
            captured.push_str(&line);
            emit_log(&q, &id, &line);
        }
        captured
    });

    // ffmpeg writes key=value stats blocks to stdout; out_time_us is in
    // microseconds. The reader shares the latest value through an atomic.
    let progress_time_us = Arc::new(AtomicI64::new(0));
    let progress_task = match child.stdout.take() {
        Some(stdout) => {
            let shared = progress_time_us.clone();
            Some(tokio::spawn(async move {
                let mut reader = BufReader::new(stdout).lines();
                while let Ok(Some(line)) = reader.next_line().await {
                    if let Some(value) = line
                        .strip_prefix("out_time_us=")
                        .or_else(|| line.strip_prefix("out_time_ms="))
                    {
                        if let Ok(parsed) = value.trim().parse::<i64>() {
                            shared.store(parsed, Ordering::Relaxed);
                        }
                    }
                }
            }))
        }
        None => None,
    };

    let mut last_reported = -1_i64;
    let status = loop {
        if cancel.load(Ordering::SeqCst) {
            let _ = child.kill().await;
            let _ = child.wait().await;
            let _ = stderr_task.await;
            if let Some(task) = progress_task {
                task.abort();
            }
            return Err(anyhow!("cancelled"));
        }
        match child.try_wait()? {
            Some(status) => break status,
            None => {
                let elapsed = progress_time_us.load(Ordering::Relaxed) as f64 / 1_000_000.0;
                if let Some(percent) = percent_of(elapsed) {
                    let rounded = percent as i64;
                    if rounded != last_reported {
                        last_reported = rounded;
                        queue.set_progress(
                            &job.id,
                            JobProgress {
                                percent: percent as f32,
                                message: Some("Rendering sponsor blur".to_string()),
                                ..JobProgress::default()
                            },
                        );
                    }
                }
                tokio::time::sleep(Duration::from_millis(400)).await;
            }
        }
    };
    let stderr = stderr_task.await.unwrap_or_default();
    if let Some(task) = progress_task {
        let _ = task.await;
    }
    if !status.success() {
        return Err(anyhow!("ffmpeg sponsor blur exited with {status}: {stderr}"));
    }
    Ok(status.code())
}

fn configure_silent(cmd: &mut Command) {
    #[cfg(windows)]
    {
        cmd.creation_flags(0x0800_0000);
    }
    #[cfg(not(windows))]
    {
        let _ = cmd;
    }
}

use crate::util::format_duration;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn short_videos_are_not_chunked() {
        assert!(chunk_plan(MIN_CHUNKED_SEC - 1.0).is_none());
    }

    #[test]
    fn chunks_cover_the_whole_video_without_overlap() {
        let plan = chunk_plan(600.0).expect("long video is chunked");
        assert_eq!(plan.len(), PARALLEL_SEGMENTS);
        assert!(plan.iter().all(|segment| segment.blurred));
        assert_eq!(plan[0].start, 0.0);
        for pair in plan.windows(2) {
            assert_eq!(pair[0].end, Some(pair[1].start));
        }
        // The last chunk runs to EOF so a slightly short probe loses nothing.
        assert_eq!(plan.last().unwrap().end, None);
    }
}
