//! Normalizes a finished download to H.264 + AAC.
//!
//! YouTube only offers H.264 up to 1080p; above that the best (and often the
//! only) renditions are VP9 or AV1, and `--remux-video mp4` copies them into an
//! MP4 that Premiere Pro cannot decode. Opus audio fails the same way even at
//! 1080p. The format selector avoids both whenever the source allows it, so
//! this stage is a no-op for most downloads and only pays for an encoder pass
//! when there was nothing compatible to pick.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

use crate::binaries::{resolve_binary, FFMPEG, FFPROBE};
use crate::chat_overlay::composer::{decode_hwaccels, encoder_attempts, EncoderAttempt};
use crate::chat_overlay::emit_log;
use crate::jobs::queue::QueueManager;
use crate::jobs::types::{GpuEncoderMode, Job, JobProgress, PerformanceSettings};

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

/// Codec names ffprobe reports for streams that need no re-encode.
fn is_compatible(video: Option<&str>, audio: Option<&str>) -> bool {
    matches!(video, Some("h264")) && matches!(audio, None | Some("aac"))
}

/// Which streams can be copied as they are. Only the incompatible one is
/// re-encoded: H.264 + Opus needs a seconds-long audio pass, not a full
/// video encode.
fn copyable_streams(video: Option<&str>, audio: Option<&str>) -> (bool, bool) {
    (matches!(video, Some("h264")), matches!(audio, Some("aac")))
}

struct ProbeResult {
    video: Option<String>,
    audio: Option<String>,
    duration: Option<f64>,
}

async fn probe(ffprobe: &Path, input: &Path) -> Result<ProbeResult> {
    let mut cmd = Command::new(ffprobe);
    configure_silent(&mut cmd);
    cmd.args([
        "-v",
        "error",
        "-show_entries",
        "stream=codec_type,codec_name:format=duration",
        "-of",
        "json",
    ])
    .arg(input)
    .stdin(Stdio::null())
    .stdout(Stdio::piped())
    .stderr(Stdio::piped());

    let output = cmd.output().await.context("spawn ffprobe")?;
    if !output.status.success() {
        return Err(anyhow!(
            "ffprobe exited with {}: {}",
            output.status,
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    let json: serde_json::Value =
        serde_json::from_slice(&output.stdout).context("parse ffprobe json")?;

    let mut video = None;
    let mut audio = None;
    for stream in json
        .get("streams")
        .and_then(|v| v.as_array())
        .map(Vec::as_slice)
        .unwrap_or_default()
    {
        let name = stream
            .get("codec_name")
            .and_then(|v| v.as_str())
            .map(str::to_string);
        match stream.get("codec_type").and_then(|v| v.as_str()) {
            Some("video") if video.is_none() => video = name,
            Some("audio") if audio.is_none() => audio = name,
            _ => {}
        }
    }

    let duration = json
        .get("format")
        .and_then(|f| f.get("duration"))
        .and_then(|v| v.as_str())
        .and_then(|v| v.parse::<f64>().ok())
        .filter(|d| *d > 0.0);

    Ok(ProbeResult {
        video,
        audio,
        duration,
    })
}

#[derive(Clone)]
struct RenderPlan {
    hwaccel: Option<&'static str>,
    hwaccel_output_format: Option<&'static str>,
    verify_decode: bool,
    encoder: EncoderAttempt,
}

/// Zero-copy GPU-only plans for plain transcode (no CPU video filters). Keeping
/// decoded frames in VRAM avoids the GPU -> RAM -> GPU roundtrip and roughly
/// doubles VP9/AV1 -> H.264 throughput on Windows iGPUs. Every plan is verified
/// by decoding its probe clip before being selected, so unsupported drivers or
/// 10-bit inputs fall back cleanly to the standard decode/encode chain.
fn zero_copy_plans(performance: &PerformanceSettings) -> Vec<RenderPlan> {
    #[cfg(not(target_os = "windows"))]
    {
        let _ = performance;
        return Vec::new();
    }
    #[cfg(target_os = "windows")]
    {
        let mode = performance.gpu_encoder_mode.unwrap_or(GpuEncoderMode::Auto);
        let qsv_preset = performance
            .ffmpeg_preset
            .clone()
            .filter(|v| !v.trim().is_empty())
            .unwrap_or_else(|| "veryfast".into());
        let qsv_plan = || RenderPlan {
            hwaccel: Some("qsv"),
            hwaccel_output_format: Some("qsv"),
            verify_decode: true,
            encoder: EncoderAttempt {
                mode: GpuEncoderMode::IntelXeQsv,
                label: "Intel Quick Sync Zero-Copy",
                args: vec![
                    "-c:v".into(),
                    "h264_qsv".into(),
                    "-preset".into(),
                    qsv_preset.clone(),
                    "-async_depth".into(),
                    "8".into(),
                    "-global_quality".into(),
                    "20".into(),
                ],
            },
        };

        match mode {
            GpuEncoderMode::Auto => vec![
                // Use default Main profile on D3D12VA: forcing `-profile high`
                // produces corrupted intra blocks on some Intel Iris Xe drivers.
                RenderPlan {
                    hwaccel: Some("d3d12va"),
                    hwaccel_output_format: Some("d3d12"),
                    verify_decode: true,
                    encoder: EncoderAttempt {
                        mode: GpuEncoderMode::Auto,
                        label: "D3D12VA Zero-Copy",
                        args: vec!["-c:v".into(), "h264_d3d12va".into(), "-qp".into(), "22".into()],
                    },
                },
                qsv_plan(),
            ],
            GpuEncoderMode::IntelXeQsv | GpuEncoderMode::Qsv => vec![qsv_plan()],
            GpuEncoderMode::Cpu
            | GpuEncoderMode::Nvenc
            | GpuEncoderMode::Amf
            | GpuEncoderMode::Vulkan => Vec::new(),
        }
    }
}

/// Verify that a probed video clip is non-empty and decodes with zero H.264
/// bitstream errors. Catches buggy GPU drivers before committing to a full pass.
async fn verify_probe_decodes_cleanly(ffmpeg: &Path, probe_out: &Path) -> bool {
    let non_empty = tokio::fs::metadata(probe_out)
        .await
        .map(|m| m.len() > 0)
        .unwrap_or(false);
    if !non_empty {
        return false;
    }
    let mut cmd = Command::new(ffmpeg);
    configure_silent(&mut cmd);
    cmd.kill_on_drop(true)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .args(["-hide_banner", "-v", "error", "-i"])
        .arg(probe_out)
        .args(["-f", "null", "-"]);
    match tokio::time::timeout(Duration::from_secs(30), cmd.output()).await {
        Ok(Ok(out)) => out.status.success() && out.stderr.is_empty(),
        _ => false,
    }
}

/// Probe (decode-hwaccel, encoder) pairs on a half-second slice so a broken GPU
/// path costs a fraction of a second instead of failing hours into the real
/// pass. Always resolves, because the chain ends with libx264.
async fn select_render_plan(
    queue: &Arc<QueueManager>,
    job: &Job,
    ffmpeg: &Path,
    performance: &PerformanceSettings,
    input: &Path,
    probe_at: f64,
) -> RenderPlan {
    let attempts = encoder_attempts(performance, None);
    let safe_id: String = job
        .id
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
        .collect();
    let probe_out = std::env::temp_dir().join(format!("fetchr_transcode_probe_{safe_id}.mp4"));

    let mut candidates = zero_copy_plans(performance);
    let mut fallback: Option<RenderPlan> = None;
    for hwaccel in decode_hwaccels() {
        for encoder in &attempts {
            let plan = RenderPlan {
                hwaccel,
                hwaccel_output_format: None,
                verify_decode: false,
                encoder: encoder.clone(),
            };
            if fallback.is_none() {
                fallback = Some(plan.clone());
            }
            candidates.push(plan);
        }
    }

    for plan in candidates {
        let mut cmd = Command::new(ffmpeg);
        configure_silent(&mut cmd);
        // stderr is discarded rather than piped: `status()` never drains a
        // pipe, so a chatty failing encoder could deadlock the probe.
        cmd.kill_on_drop(true)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .args(["-y", "-hide_banner", "-v", "error"]);
        if let Some(hw) = plan.hwaccel {
            cmd.args(["-hwaccel", hw]);
            if let Some(fmt) = plan.hwaccel_output_format {
                cmd.args(["-hwaccel_output_format", fmt]);
            }
        }
        cmd.args(["-ss", &format!("{probe_at:.3}"), "-t", "0.5", "-i"])
            .arg(input)
            .args(["-map", "0:v:0", "-an"])
            .args(&plan.encoder.args)
            .arg(&probe_out);
        let mut ok = matches!(
            tokio::time::timeout(Duration::from_secs(90), cmd.status()).await,
            Ok(Ok(status)) if status.success()
        );
        if ok && plan.verify_decode {
            ok = verify_probe_decodes_cleanly(ffmpeg, &probe_out).await;
        }
        let _ = tokio::fs::remove_file(&probe_out).await;
        if ok {
            emit_log(
                queue,
                &job.id,
                &format!(
                    "Transcode: encoder {} (decode: {})",
                    plan.encoder.label,
                    plan.hwaccel.unwrap_or("cpu")
                ),
            );
            return plan;
        }
    }
    let plan = fallback.expect("encoder_attempts is never empty");
    emit_log(
        queue,
        &job.id,
        &format!(
            "Transcode: no encoder passed the probe, falling back to {}",
            plan.encoder.label
        ),
    );
    plan
}

/// Run ffmpeg with `-progress pipe:1`, forwarding stderr to the job log and
/// mapping elapsed output time onto the job's current progress stage.
async fn run_with_progress(
    queue: &Arc<QueueManager>,
    job: &Job,
    mut cmd: Command,
    cancel: &Arc<AtomicBool>,
    total_duration: Option<f64>,
) -> Result<()> {
    let mut child = cmd.spawn().context("spawn ffmpeg transcode")?;
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
    let progress_task = child.stdout.take().map(|stdout| {
        let shared = progress_time_us.clone();
        tokio::spawn(async move {
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
        })
    });

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
                if let Some(duration) = total_duration {
                    let percent = (elapsed / duration * 100.0).clamp(0.0, 99.0);
                    let rounded = percent as i64;
                    if rounded != last_reported {
                        last_reported = rounded;
                        queue.set_progress(
                            &job.id,
                            JobProgress {
                                percent: percent as f32,
                                message: Some("Converting to H.264".to_string()),
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
        return Err(anyhow!("ffmpeg transcode exited with {status}: {stderr}"));
    }
    Ok(())
}

/// Re-encode `input` in place when its codecs would not import into a standard
/// editor. Returns the path of the file to carry forward — the same path when
/// nothing had to change.
pub async fn ensure_compatible(
    queue: &Arc<QueueManager>,
    job: &Job,
    cancel: &Arc<AtomicBool>,
    input: &Path,
    bin_dir: Option<&Path>,
    performance: &PerformanceSettings,
) -> Result<PathBuf> {
    let Some(ffprobe) = resolve_binary(FFPROBE, bin_dir) else {
        emit_log(
            queue,
            &job.id,
            "Transcode: ffprobe not found, leaving codecs untouched.",
        );
        return Ok(input.to_path_buf());
    };
    let Some(ffmpeg) = resolve_binary(FFMPEG, bin_dir) else {
        emit_log(
            queue,
            &job.id,
            "Transcode: ffmpeg not found, leaving codecs untouched.",
        );
        return Ok(input.to_path_buf());
    };

    let probed = probe(&ffprobe, input).await?;
    if is_compatible(probed.video.as_deref(), probed.audio.as_deref()) {
        return Ok(input.to_path_buf());
    }

    emit_log(
        queue,
        &job.id,
        &format!(
            "Transcode: source is {} / {}, converting to H.264 + AAC for editor compatibility.",
            probed.video.as_deref().unwrap_or("no video"),
            probed.audio.as_deref().unwrap_or("no audio")
        ),
    );

    let (copy_video, copy_audio) =
        copyable_streams(probed.video.as_deref(), probed.audio.as_deref());
    let plan = if copy_video {
        None
    } else {
        let probe_at = probed
            .duration
            .map(|d| (d * 0.5).min(d - 1.0).max(0.0))
            .unwrap_or(0.0);
        Some(select_render_plan(queue, job, &ffmpeg, performance, input, probe_at).await)
    };

    let stem = input
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("output");
    let temp_output = input.with_file_name(format!("{stem}.h264.mp4"));

    let mut cmd = Command::new(&ffmpeg);
    configure_silent(&mut cmd);
    cmd.kill_on_drop(true)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .args(["-y", "-hide_banner", "-progress", "pipe:1", "-nostats"]);
    if let Some(plan) = plan.as_ref() {
        if let Some(hw) = plan.hwaccel {
            cmd.args(["-hwaccel", hw]);
            if let Some(fmt) = plan.hwaccel_output_format {
                cmd.args(["-hwaccel_output_format", fmt]);
            }
        }
    }
    cmd.arg("-i")
        .arg(input)
        .args(["-map", "0:v:0", "-map", "0:a?"]);
    match &plan {
        Some(plan) => {
            if let Some(threads) = performance.cpu_threads() {
                cmd.args(["-threads", &threads.to_string()]);
            }
            cmd.args(&plan.encoder.args);
        }
        None => {
            cmd.args(["-c:v", "copy"]);
        }
    }
    if copy_audio {
        cmd.args(["-c:a", "copy"]);
    } else {
        cmd.args(["-c:a", "aac", "-b:a", "192k"]);
    }
    // No +faststart: it rewrites the whole finished file once more, and
    // editors read the index from the end just as well.
    cmd.arg(&temp_output);

    queue.log_command_started(
        &job.id,
        format!(
            "{} -i {} <{}+{}> {}",
            ffmpeg.display(),
            input.display(),
            if copy_video { "copy" } else { "h264" },
            if copy_audio { "copy" } else { "aac" },
            temp_output.display()
        ),
        None,
    );

    let result = run_with_progress(queue, job, cmd, cancel, probed.duration).await;
    if let Err(err) = result {
        let _ = tokio::fs::remove_file(&temp_output).await;
        return Err(err);
    }

    let produced_ok = temp_output
        .metadata()
        .map(|meta| meta.is_file() && meta.len() > 0)
        .unwrap_or(false);
    if !produced_ok {
        let _ = tokio::fs::remove_file(&temp_output).await;
        return Err(anyhow!("transcode produced an empty file"));
    }

    // Take the original name back so downstream stages and the queue's saved
    // output path keep pointing at the same file.
    tokio::fs::remove_file(input)
        .await
        .with_context(|| format!("remove pre-transcode file {}", input.display()))?;
    tokio::fs::rename(&temp_output, input)
        .await
        .with_context(|| format!("rename {} into place", temp_output.display()))?;

    emit_log(queue, &job.id, "Transcode: done, output is H.264 + AAC.");
    Ok(input.to_path_buf())
}

#[cfg(test)]
mod tests {
    use super::{copyable_streams, is_compatible, zero_copy_plans};
    use crate::jobs::types::{GpuEncoderMode, PerformanceSettings};

    #[test]
    fn only_the_incompatible_stream_is_encoded() {
        assert_eq!(copyable_streams(Some("h264"), Some("opus")), (true, false));
        assert_eq!(copyable_streams(Some("vp9"), Some("aac")), (false, true));
        assert_eq!(copyable_streams(Some("av1"), Some("opus")), (false, false));
        assert_eq!(copyable_streams(Some("av1"), None), (false, false));
    }

    #[test]
    fn h264_with_aac_needs_no_work() {
        assert!(is_compatible(Some("h264"), Some("aac")));
    }

    #[test]
    fn silent_h264_needs_no_work() {
        assert!(is_compatible(Some("h264"), None));
    }

    #[test]
    fn opus_audio_forces_a_pass() {
        // The Premiere failure that survives even an H.264 video track.
        assert!(!is_compatible(Some("h264"), Some("opus")));
    }

    #[test]
    fn av1_and_vp9_force_a_pass() {
        assert!(!is_compatible(Some("av1"), Some("aac")));
        assert!(!is_compatible(Some("vp9"), Some("aac")));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn zero_copy_plans_respect_gpu_mode_and_avoid_high_profile_on_d3d12() {
        let auto = zero_copy_plans(&PerformanceSettings::default());
        assert_eq!(auto.len(), 2);
        assert_eq!(auto[0].hwaccel, Some("d3d12va"));
        assert_eq!(auto[0].hwaccel_output_format, Some("d3d12"));
        assert!(auto[0].verify_decode);
        assert!(!auto[0].encoder.args.iter().any(|a| a == "-profile"));
        assert_eq!(auto[1].hwaccel, Some("qsv"));
        assert_eq!(auto[1].hwaccel_output_format, Some("qsv"));

        let qsv = zero_copy_plans(&PerformanceSettings {
            gpu_encoder_mode: Some(GpuEncoderMode::IntelXeQsv),
            ..PerformanceSettings::default()
        });
        assert_eq!(qsv.len(), 1);
        assert_eq!(qsv[0].hwaccel, Some("qsv"));

        for mode in [
            GpuEncoderMode::Cpu,
            GpuEncoderMode::Nvenc,
            GpuEncoderMode::Amf,
            GpuEncoderMode::Vulkan,
        ] {
            let plans = zero_copy_plans(&PerformanceSettings {
                gpu_encoder_mode: Some(mode),
                ..PerformanceSettings::default()
            });
            assert!(plans.is_empty(), "expected no zero-copy override for {mode:?}");
        }
    }
}
