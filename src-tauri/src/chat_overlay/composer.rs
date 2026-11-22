use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Instant;

use anyhow::{anyhow, Context, Result};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

use crate::chat_overlay::blur_filter::{
    append_chat_background_blur, gaussian_chain, normalized_blur_zones,
};
use crate::chat_overlay::emit_log;
use crate::chat_overlay::ffmpeg_metrics::{
    cbr_rate_args, format_optional_fps, format_optional_speed, format_speed_value,
    is_ffmpeg_progress_line, probe_source_bitrate, render_progress_message, ChatPipeMetrics,
    FfmpegEncodeMetrics,
};
use crate::chat_overlay::settings::EffectiveChatOverlaySettings;
use crate::jobs::queue::QueueManager;
use crate::jobs::types::{
    BlurEffect, BlurQuality, BlurZone, GpuEncoderMode, ImageFit, JobProgress, PerformanceSettings,
};

pub struct ChatOverlayComposer {
    settings: EffectiveChatOverlaySettings,
    ffmpeg: PathBuf,
    performance: PerformanceSettings,
    blur_zones: Vec<BlurZone>,
}

impl ChatOverlayComposer {
    pub fn new(
        settings: EffectiveChatOverlaySettings,
        ffmpeg: PathBuf,
        performance: PerformanceSettings,
        blur_zones: Vec<BlurZone>,
    ) -> Self {
        Self {
            settings,
            ffmpeg,
            performance: performance.with_defaults(),
            blur_zones,
        }
    }

    pub async fn compose(
        &self,
        input_video: &Path,
        overlay_video: &Path,
        output_video: &Path,
        duration: f64,
        chat_pipe_metrics: Option<ChatPipeMetrics>,
        queue: &Arc<QueueManager>,
        job_id: &str,
        cancel: Arc<AtomicBool>,
    ) -> Result<()> {
        let mut last_error: Option<anyhow::Error> = None;
        let target_bitrate = probe_source_bitrate(&self.ffmpeg, input_video).await;
        if let Some(b) = target_bitrate {
            emit_log(
                queue,
                job_id,
                &format!("Chat overlay: целевой битрейт видео {b} бит/с (как у исходника)"),
            );
        }
        for encoder in encoder_attempts(&self.performance, target_bitrate) {
            // HW-decode the source first (frees CPU for the CPU overlay); fall back to SW decode.
            for hwaccel in decode_hwaccels() {
                if cancel.load(Ordering::SeqCst) {
                    return Err(anyhow!("cancelled"));
                }
                emit_log(
                    queue,
                    job_id,
                    &format!(
                        "Начало прохода рендеринга:\n\
                         - Режим компоновки (compose mode): Intermediate (Pass 2 - composite)\n\
                         - Видеокодек (encoder): {}\n\
                         - Оверлей (overlay): CPU\n\
                         - Декодер (decode hwaccel): {}",
                        encoder.label,
                        hwaccel.unwrap_or("none")
                    ),
                );
                match self
                    .compose_with_encoder(
                        input_video,
                        overlay_video,
                        output_video,
                        duration,
                        chat_pipe_metrics,
                        queue,
                        job_id,
                        cancel.clone(),
                        &encoder,
                        hwaccel,
                    )
                    .await
                {
                    Ok(()) => return Ok(()),
                    Err(err) if hwaccel.is_some() => {
                        emit_log(
                            queue,
                            job_id,
                            &format!(
                                "Chat overlay: HW decode ({}) failed ({err:#}); retrying CPU decode...",
                                hwaccel.unwrap()
                            ),
                        );
                        last_error = Some(err);
                    }
                    Err(err) if encoder.mode != GpuEncoderMode::Cpu => {
                        emit_log(
                            queue,
                            job_id,
                            &format!(
                                "Chat overlay: {} failed ({err:#}); trying next encoder...",
                                encoder.label
                            ),
                        );
                        last_error = Some(err);
                        break;
                    }
                    Err(err) => return Err(err),
                }
            }
        }
        Err(last_error.unwrap_or_else(|| anyhow!("no ffmpeg encoder attempts configured")))
    }

    async fn compose_with_encoder(
        &self,
        input_video: &Path,
        overlay_video: &Path,
        output_video: &Path,
        duration: f64,
        chat_pipe_metrics: Option<ChatPipeMetrics>,
        queue: &Arc<QueueManager>,
        job_id: &str,
        cancel: Arc<AtomicBool>,
        encoder: &EncoderAttempt,
        hwaccel: Option<&str>,
    ) -> Result<()> {
        let zones = normalized_blur_zones(
            &self.blur_zones,
            self.settings.output_width,
            self.settings.output_height,
        );
        let filter = self.build_filter(&zones, encoder.mode);

        let mut cmd = Command::new(&self.ffmpeg);
        cmd.kill_on_drop(true)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .args(["-y", "-hide_banner", "-nostats", "-progress", "pipe:2"]);

        // CPU overlay + HW encode. The source is HW-decoded (frees CPU); ffmpeg auto-inserts
        // hwdownload for the CPU overlay filter. We do NOT use overlay_qsv / rgba hwupload —
        // that path regressed badly on Intel iGPUs. The qtrle overlay is decoded on CPU.
        if let Some(hw) = hwaccel {
            cmd.args(["-hwaccel", hw]);
        }
        cmd.arg("-i").arg(input_video);
        cmd.args(["-hwaccel", "none"]).arg("-i").arg(overlay_video);

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
        if let Some(threads) = self.performance.cpu_threads() {
            cmd.args(["-threads", &threads.to_string()]);
        }
        cmd.args(&encoder.args)
            .args(["-c:a", "copy", "-movflags", "+faststart", "-shortest"])
            .arg(output_video);

        #[cfg(windows)]
        {
            cmd.creation_flags(0x0800_0000);
        }

        emit_log(
            queue,
            job_id,
            &format!("$ {}", debug_cmd(&self.ffmpeg, &cmd)),
        );

        let mut child = cmd.spawn().context("spawn ffmpeg overlay composer")?;
        crate::win_power::disable_for_pid(child.id());
        let stderr = child.stderr.take().context("stderr handle")?;
        let q = queue.clone();
        let id = job_id.to_string();
        let total_duration = duration.max(0.1);
        let started = Instant::now();
        let chat_pipe_fps = chat_pipe_metrics.map(|metrics| metrics.fps);
        let stderr_task = tokio::spawn(async move {
            let mut metrics = FfmpegEncodeMetrics::default();
            let mut reader = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = reader.next_line().await {
                let updated = metrics.update_from_line(&line);
                if is_ffmpeg_progress_line(&line) {
                    if updated {
                        let done_seconds = metrics.out_time_seconds.unwrap_or(0.0);
                        let ratio = (done_seconds / total_duration).clamp(0.0, 1.0);
                        let elapsed = started.elapsed().as_secs_f64().max(0.001);
                        let eta = if ratio > 0.001 {
                            Some(format_duration(elapsed * (1.0 - ratio) / ratio))
                        } else {
                            None
                        };
                        q.set_progress(
                            &id,
                            JobProgress {
                                percent: ratio as f32 * 100.0,
                                stage_percent: None,
                                stage_start: None,
                                stage_end: None,
                                stage_started_at: None,
                                download_elapsed_ms: None,
                                speed: metrics.speed.map(format_speed_value),
                                eta: eta.clone(),
                                size: None,
                                message: Some(render_progress_message(&metrics, chat_pipe_fps)),
                                ..JobProgress::default()
                            },
                        );
                    }
                    continue;
                }
                emit_log(&q, &id, &format!("!! {line}"));
                if updated {
                    let done_seconds = metrics.out_time_seconds.unwrap_or(0.0);
                    let ratio = (done_seconds / total_duration).clamp(0.0, 1.0);
                    let elapsed = started.elapsed().as_secs_f64().max(0.001);
                    let eta = if ratio > 0.001 {
                        Some(format_duration(elapsed * (1.0 - ratio) / ratio))
                    } else {
                        None
                    };
                    q.set_progress(
                        &id,
                        JobProgress {
                            percent: ratio as f32 * 100.0,
                            stage_percent: None,
                            stage_start: None,
                            stage_end: None,
                            stage_started_at: None,
                            download_elapsed_ms: None,
                            speed: metrics.speed.map(format_speed_value),
                            eta: eta.clone(),
                            size: None,
                            message: Some(render_progress_message(&metrics, chat_pipe_fps)),
                            ..JobProgress::default()
                        },
                    );
                }
            }
            metrics
        });

        loop {
            if cancel.load(Ordering::SeqCst) {
                let _ = child.kill().await;
                return Err(anyhow!("cancelled"));
            }
            match child.try_wait()? {
                Some(status) => {
                    let mut final_metrics = stderr_task.await.unwrap_or_default();
                    if !status.success() {
                        return Err(anyhow!("ffmpeg overlay composer exited with {status}"));
                    }
                    let elapsed = started.elapsed().as_secs_f64().max(0.001);
                    if final_metrics.video_output_fps.is_none() {
                        final_metrics.video_output_fps =
                            final_metrics.frame.map(|frame| frame as f64 / elapsed);
                    }
                    let wall_speed = duration.max(0.001) / elapsed;
                    emit_log(
                        queue,
                        job_id,
                        &format!(
                            "Итог прохода (Intermediate Pass 2): video output {} кадров за {:.1}s ({} video-fps, ffmpeg speed {}, total wall-clock speed {}); chat pipe pass 1 {}",
                            final_metrics
                                .frame
                                .map(|frame| frame.to_string())
                                .unwrap_or_else(|| "n/a".to_string()),
                            elapsed,
                            format_optional_fps(final_metrics.video_output_fps),
                            format_optional_speed(final_metrics.speed),
                            format_speed_value(wall_speed),
                            chat_pipe_metrics
                                .map(|metrics| format!(
                                    "{} кадров за {:.1}s ({:.1} chat pipe fps, pipe speed {:.2}x)",
                                    metrics.frames,
                                    metrics.elapsed_seconds,
                                    metrics.fps,
                                    metrics.speed_ratio()
                                ))
                                .unwrap_or_else(|| "n/a".to_string()),
                        ),
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
                            message: Some(render_progress_message(&final_metrics, chat_pipe_fps)),
                            ..JobProgress::default()
                        },
                    );
                    break;
                }
                None => tokio::time::sleep(std::time::Duration::from_millis(250)).await,
            }
        }
        emit_log(
            queue,
            job_id,
            &format!("Chat overlay saved: {}", output_video.display()),
        );
        Ok(())
    }

    fn build_filter(&self, zones: &[BlurZone], _mode: GpuEncoderMode) -> String {
        // No blur zones and no chat-backdrop blur: plain CPU overlay of the prerendered chat
        // onto the source. The HW encoder still encodes; no rescale (both are at output
        // dimensions). The GPU-overlay path (overlay_qsv + rgba hwupload) was removed — it
        // regressed badly on Intel iGPUs. The prerendered chat layer may be supersampled
        // (render quality high/ultra), so it is always normalized to the placement size
        // before the overlay.
        let chat_scale = format!(
            "[1:v]scale={w}:{h}:flags=lanczos[chat_ov];",
            w = self.settings.chat_width,
            h = self.settings.chat_height,
        );
        let blur_bg = self.settings.background_enabled && self.settings.background_blur_enabled;
        if zones.is_empty() && !blur_bg {
            return format!(
                "{chat_scale}[0:v][chat_ov]overlay={x}:{y}:format=auto[v]",
                x = self.settings.chat_x,
                y = self.settings.chat_y,
            );
        }

        {
            // No fps= here: the whole video is re-encoded anyway, and forcing the
            // settings rate (60 by default) doubled every frame of a 30 fps source
            // through blur, overlay and encoder. The no-blur graph keeps the source
            // rate too.
            let mut filter = format!(
                "[0:v]scale={w}:{h}:force_original_aspect_ratio=decrease,\
pad={w}:{h}:(ow-iw)/2:(oh-ih)/2,setsar=1[base0];",
                w = self.settings.output_width,
                h = self.settings.output_height,
            );
            let mut current = "base0".to_string();
            let mut image_input = 2;
            for (idx, zone) in zones.iter().enumerate() {
                let next = format!("base{}", idx + 1);
                match zone.effect {
                    BlurEffect::GaussianBlur => {
                        let sigma = zone.intensity.clamp(1.0, 64.0) as f64;
                        filter.push_str(&format!(
                            "[{current}]split=2[{current}m][{current}c];\
[{current}c]crop={w}:{h}:{x}:{y},{chain}[zone{idx}];\
[{current}m][zone{idx}]overlay={x}:{y}[{next}];",
                            w = zone.width,
                            h = zone.height,
                            x = zone.x,
                            y = zone.y,
                            chain =
                                gaussian_chain(BlurQuality::High, sigma, zone.width, zone.height),
                        ));
                    }
                    BlurEffect::Mosaic => {
                        let factor = zone.intensity.round().clamp(2.0, 80.0) as u32;
                        let down_w = (zone.width / factor).max(1);
                        let down_h = (zone.height / factor).max(1);
                        filter.push_str(&format!(
                            "[{current}]split=2[{current}m][{current}c];\
[{current}c]crop={w}:{h}:{x}:{y},scale={dw}:{dh}:flags=neighbor,scale={w}:{h}:flags=neighbor[zone{idx}];\
[{current}m][zone{idx}]overlay={x}:{y}[{next}];",
                            w = zone.width,
                            h = zone.height,
                            x = zone.x,
                            y = zone.y,
                            dw = down_w,
                            dh = down_h,
                        ));
                    }
                    BlurEffect::ImageOverlay => {
                        if zone
                            .image_path
                            .as_deref()
                            .filter(|path| Path::new(path).is_file())
                            .is_none()
                        {
                            continue;
                        }
                        let image_filter = match zone.image_fit.unwrap_or(ImageFit::Contain) {
                            ImageFit::Contain => format!(
                                "[{input}:v]scale={w}:{h}:force_original_aspect_ratio=decrease,format=rgba,\
pad={w}:{h}:(ow-iw)/2:(oh-ih)/2:color=black@0[zone{idx}];",
                                input = image_input,
                                w = zone.width,
                                h = zone.height,
                            ),
                            ImageFit::Cover => format!(
                                "[{input}:v]scale={w}:{h}:force_original_aspect_ratio=increase,crop={w}:{h},format=rgba[zone{idx}];",
                                input = image_input,
                                w = zone.width,
                                h = zone.height,
                            ),
                            ImageFit::Stretch => format!(
                                "[{input}:v]scale={w}:{h},format=rgba[zone{idx}];",
                                input = image_input,
                                w = zone.width,
                                h = zone.height,
                            ),
                        };
                        filter.push_str(&image_filter);
                        filter.push_str(&format!(
                            "[{current}][zone{idx}]overlay={x}:{y}[{next}];",
                            x = zone.x,
                            y = zone.y,
                        ));
                        image_input += 1;
                    }
                }
                current = next;
            }
            if blur_bg {
                append_chat_background_blur(
                    &mut filter,
                    &mut current,
                    self.settings.chat_x,
                    self.settings.chat_y,
                    self.settings.chat_width,
                    self.settings.chat_height,
                );
            }
            filter.push_str(&chat_scale);
            filter.push_str(&format!(
                "[{current}][chat_ov]overlay={x}:{y}:format=auto[v]",
                x = self.settings.chat_x,
                y = self.settings.chat_y,
            ));
            filter
        }
    }
}

#[derive(Clone)]
pub(crate) struct EncoderAttempt {
    pub(crate) mode: GpuEncoderMode,
    pub(crate) label: &'static str,
    pub(crate) args: Vec<String>,
}

/// Preferred source-decode hwaccels per OS, in priority order, always ending with
/// SW decode (`None`) as the guaranteed fallback.
pub(crate) fn decode_hwaccels() -> Vec<Option<&'static str>> {
    #[cfg(target_os = "windows")]
    {
        return vec![Some("d3d11va"), None];
    }
    #[cfg(target_os = "macos")]
    {
        return vec![Some("videotoolbox"), None];
    }
    // Linux/other: VAAPI decode needs an explicit render node and often fails on
    // headless/mismatched drivers, so decode on CPU for reliability.
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        return vec![None];
    }
}

/// Encoder chain for `GpuEncoderMode::Auto`, tuned per OS. Every chain ends with
/// the CPU (libx264) attempt so composition always succeeds.
fn auto_attempts(
    performance: &PerformanceSettings,
    target_bitrate: Option<u64>,
) -> Vec<EncoderAttempt> {
    #[cfg(target_os = "windows")]
    {
        return vec![
            gpu_attempt(GpuEncoderMode::IntelXeQsv, performance, target_bitrate),
            gpu_attempt(GpuEncoderMode::Qsv, performance, target_bitrate),
            gpu_attempt(GpuEncoderMode::Nvenc, performance, target_bitrate),
            gpu_attempt(GpuEncoderMode::Amf, performance, target_bitrate),
            cpu_attempt(performance, target_bitrate),
        ];
    }
    #[cfg(target_os = "macos")]
    {
        return vec![
            videotoolbox_attempt(target_bitrate),
            cpu_attempt(performance, target_bitrate),
        ];
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        return vec![cpu_attempt(performance, target_bitrate)];
    }
}

/// Apple VideoToolbox H.264 encoder. It accepts system-memory frames directly, so
/// it drops in after the CPU overlay filter without any hwupload plumbing. `mode`
/// is left as `Auto` purely so the retry loop treats a failure as "try next".
#[cfg(target_os = "macos")]
fn videotoolbox_attempt(target_bitrate: Option<u64>) -> EncoderAttempt {
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
    EncoderAttempt {
        mode: GpuEncoderMode::Auto,
        label: "Apple VideoToolbox",
        args,
    }
}

pub(crate) fn encoder_attempts(
    performance: &PerformanceSettings,
    target_bitrate: Option<u64>,
) -> Vec<EncoderAttempt> {
    let mode = performance.gpu_encoder_mode.unwrap_or(GpuEncoderMode::Auto);
    match mode {
        // CPU overlay feeds system-memory frames to the encoder, so QSV/NVENC/AMF (which accept
        // them) are tried first; h264_vulkan needs Vulkan surfaces and is excluded here.
        GpuEncoderMode::Auto => auto_attempts(performance, target_bitrate),
        GpuEncoderMode::IntelXeQsv
        | GpuEncoderMode::Nvenc
        | GpuEncoderMode::Qsv
        | GpuEncoderMode::Amf
        | GpuEncoderMode::Vulkan => {
            vec![
                gpu_attempt(mode, performance, target_bitrate),
                cpu_attempt(performance, target_bitrate),
            ]
        }
        GpuEncoderMode::Cpu => vec![cpu_attempt(performance, target_bitrate)],
    }
}

fn cpu_attempt(performance: &PerformanceSettings, target_bitrate: Option<u64>) -> EncoderAttempt {
    let preset = performance
        .ffmpeg_preset
        .clone()
        .filter(|v| !v.trim().is_empty())
        .unwrap_or_else(|| "medium".into());
    let mut args = vec!["-c:v".into(), "libx264".into(), "-preset".into(), preset];
    match target_bitrate {
        Some(b) => args.extend(cbr_rate_args(GpuEncoderMode::Cpu, b)),
        None => args.extend(["-crf".into(), "20".into()]),
    }
    args.extend(["-pix_fmt".into(), "yuv420p".into()]);
    EncoderAttempt {
        mode: GpuEncoderMode::Cpu,
        label: "CPU libx264",
        args,
    }
}

fn gpu_attempt(
    mode: GpuEncoderMode,
    performance: &PerformanceSettings,
    target_bitrate: Option<u64>,
) -> EncoderAttempt {
    let preset = performance
        .ffmpeg_preset
        .clone()
        .filter(|v| !v.trim().is_empty());
    match mode {
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
            EncoderAttempt {
                mode,
                label: "NVIDIA NVENC",
                args,
            }
        }
        GpuEncoderMode::IntelXeQsv | GpuEncoderMode::Qsv => {
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
            EncoderAttempt {
                mode,
                label: if mode == GpuEncoderMode::IntelXeQsv {
                    "Intel Xe Quick Sync"
                } else {
                    "Intel Quick Sync"
                },
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
            EncoderAttempt {
                mode,
                label: "AMD AMF",
                args,
            }
        }
        GpuEncoderMode::Vulkan => EncoderAttempt {
            mode,
            label: "Vulkan Hardware Encoder",
            args: vec![
                "-c:v".into(),
                "h264_vulkan".into(),
                "-pix_fmt".into(),
                "vulkan".into(),
            ],
        },
        GpuEncoderMode::Auto | GpuEncoderMode::Cpu => cpu_attempt(performance, target_bitrate),
    }
}

use crate::util::format_duration;

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
