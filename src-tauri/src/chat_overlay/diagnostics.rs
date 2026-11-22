//! Extended render diagnostics: environment dump and short per-stage ffmpeg benchmarks
//! (decode, filter graph, encoder) that show which stage limits throughput.
//!
//! Enabled in debug builds, or in release with `FETCHR_CHAT_DIAG=1`.

use std::path::Path;
use std::process::Stdio;
use std::sync::Arc;
use std::time::{Duration, Instant};

use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

use crate::chat_overlay::emit_log;
use crate::jobs::queue::QueueManager;

const STAGE_SECONDS: f64 = 20.0;
const STAGE_TIMEOUT: Duration = Duration::from_secs(180);

pub fn enabled() -> bool {
    cfg!(debug_assertions)
        || std::env::var("FETCHR_CHAT_DIAG")
            .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
            .unwrap_or(false)
}

/// The stage benchmark costs ~50 s per render (each ffmpeg launch is seconds), so it
/// only runs on request: `FETCHR_CHAT_BENCH=1`.
pub fn stage_bench_enabled() -> bool {
    std::env::var("FETCHR_CHAT_BENCH")
        .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
        .unwrap_or(false)
}

pub struct StageContext<'a> {
    pub ffmpeg: &'a Path,
    pub input: &'a Path,
    /// Decoder the real render uses (`None` = software).
    pub hwaccel: Option<&'a str>,
    /// Other decoder to compare against.
    pub alt_hwaccel: &'a str,
    pub filter: &'a str,
    pub encoder_args: &'a [String],
    pub chat_width: u32,
    pub chat_height: u32,
    pub chat_fps: u32,
    pub output_width: u32,
    pub output_height: u32,
    pub clip_seconds: f64,
}

struct StageResult {
    frames: u64,
    wall: f64,
    /// Spawn → first progress report with frames: process start, probing, device init.
    startup: Option<f64>,
    /// Frames/s between the first and last progress report (startup excluded).
    steady_fps: Option<f64>,
    cpu_seconds: Option<f64>,
    maxrss_mb: Option<f64>,
}

impl StageResult {
    fn fps(&self) -> f64 {
        self.steady_fps.unwrap_or(if self.wall > 0.0 {
            self.frames as f64 / self.wall
        } else {
            0.0
        })
    }

    fn describe(&self, label: &str) -> String {
        let cores = self
            .cpu_seconds
            .filter(|_| self.wall > 0.0)
            .map(|cpu| format!(", CPU {:.1} ядер", cpu / self.wall))
            .unwrap_or_default();
        let rss = self
            .maxrss_mb
            .map(|mb| format!(", RSS {mb:.0} МБ"))
            .unwrap_or_default();
        let startup = self
            .startup
            .map(|s| format!(", старт {s:.1}s"))
            .unwrap_or_default();
        format!(
            "  {label:<40} {:>7.1} fps ({} кадров за {:.1}s{startup}{cores}{rss})",
            self.fps(),
            self.frames,
            self.wall
        )
    }
}

/// Static facts that explain most "slow on a fast PC" reports.
pub async fn log_environment(
    queue: &Arc<QueueManager>,
    job_id: &str,
    ffmpeg: &Path,
    summary: &str,
) {
    let threads = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(0);
    let (version, hwaccels) = tokio::join!(
        ffmpeg_output(ffmpeg, &["-version"]),
        ffmpeg_output(ffmpeg, &["-hide_banner", "-hwaccels"]),
    );
    let version = version
        .and_then(|text| text.lines().next().map(str::to_string))
        .unwrap_or_else(|| "?".into());
    let hwaccels = hwaccels
        .map(|text| {
            text.lines()
                .skip(1)
                .map(str::trim)
                .filter(|l| !l.is_empty())
                .collect::<Vec<_>>()
                .join(", ")
        })
        .unwrap_or_default();
    emit_log(
        queue,
        job_id,
        &format!(
            "Диагностика: сборка приложения {} (debug-сборка заметно медленнее на растеризации)\n\
             Диагностика: логических потоков CPU {threads}, ОС {}\n\
             Диагностика: {version}\n\
             Диагностика: hwaccels ffmpeg: {hwaccels}\n\
             Диагностика: {summary}",
            if cfg!(debug_assertions) {
                "DEBUG"
            } else {
                "release"
            },
            std::env::consts::OS,
        ),
    );
}

fn strs(items: &[&str]) -> Vec<String> {
    items.iter().map(|s| s.to_string()).collect()
}

/// Run short isolated ffmpeg passes and log how fast each stage alone can go.
/// The slowest stage is the real ceiling of the render.
pub async fn run_stage_benchmarks(queue: &Arc<QueueManager>, job_id: &str, ctx: &StageContext<'_>) {
    let seconds = STAGE_SECONDS.min(ctx.clip_seconds.max(1.0));
    let t = format!("{seconds:.1}");
    let src = ctx.input.to_string_lossy().to_string();
    let chat_src = format!(
        "color=c=black@0.0:s={}x{}:r={},format=rgba",
        ctx.chat_width, ctx.chat_height, ctx.chat_fps
    );
    let decode = |hw: Option<&str>| {
        let mut args = Vec::new();
        if let Some(hw) = hw {
            args.extend(strs(&["-hwaccel", hw]));
        }
        args.extend(strs(&["-t", &t, "-i", &src]));
        args
    };
    let with_filters = |hw: Option<&str>| {
        let mut args = decode(hw);
        args.extend(strs(&["-f", "lavfi", "-t", &t, "-i", &chat_src]));
        args.extend(strs(&["-filter_complex", ctx.filter, "-map", "[v]", "-an"]));
        args
    };
    let null_out = strs(&["-f", "null", "-"]);
    let encoder = ctx.encoder_args.to_vec();
    let main_name = ctx.hwaccel.unwrap_or("софт");
    let alt = Some(ctx.alt_hwaccel);
    let alt_name = ctx.alt_hwaccel;

    let mut stages: Vec<(String, Vec<String>)> = vec![
        ("пустой запуск ffmpeg (-version)".into(), strs(&["-version"])),
        (
            "декод (софт)".into(),
            [decode(None), strs(&["-an"]), null_out.clone()].concat(),
        ),
        (
            format!("декод ({alt_name})"),
            [decode(alt), strs(&["-an"]), null_out.clone()].concat(),
        ),
        (
            format!("декод ({main_name}) + энкодер, без фильтров"),
            [
                decode(ctx.hwaccel),
                strs(&["-an"]),
                encoder.clone(),
                null_out.clone(),
            ]
            .concat(),
        ),
        (
            format!("декод ({main_name}) + фильтры"),
            [with_filters(ctx.hwaccel), null_out.clone()].concat(),
        ),
        (
            format!("декод ({main_name}) + фильтры + энкодер"),
            [with_filters(ctx.hwaccel), encoder.clone(), null_out.clone()].concat(),
        ),
    ];
    if ctx.hwaccel != alt {
        stages.push((
            format!("декод ({alt_name}) + фильтры + энкодер"),
            [with_filters(alt), encoder, null_out].concat(),
        ));
    }

    emit_log(
        queue,
        job_id,
        &format!(
            "Диагностика: стадийный бенчмарк на первых {seconds:.0} с клипа ({}x{})...",
            ctx.output_width, ctx.output_height
        ),
    );
    let started = Instant::now();
    let mut lines = Vec::new();
    for (label, args) in stages {
        match run_stage(ctx.ffmpeg, &args).await {
            Ok(result) if result.frames == 0 => lines.push(format!(
                "  {label:<40} {:.1}s на запуск процесса",
                result.wall
            )),
            Ok(result) => lines.push(result.describe(&label)),
            Err(err) => lines.push(format!("  {label:<40} ошибка: {err}")),
        }
    }
    emit_log(
        queue,
        job_id,
        &format!(
            "Диагностика: пропускная способность по стадиям (fps без учёта старта; итог ограничивает самая медленная):\n{}\n\
             Диагностика: бенчмарк занял {:.1}s",
            lines.join("\n"),
            started.elapsed().as_secs_f64()
        ),
    );
}

async fn run_stage(ffmpeg: &Path, args: &[String]) -> Result<StageResult, String> {
    let mut cmd = Command::new(ffmpeg);
    cmd.kill_on_drop(true);
    if args.first().map(String::as_str) != Some("-version") {
        cmd.args([
            "-y",
            "-hide_banner",
            "-nostats",
            "-benchmark",
            "-progress",
            "pipe:2",
        ]);
    }
    cmd.args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        cmd.creation_flags(0x0800_0000);
    }
    let started = Instant::now();
    let mut child = cmd.spawn().map_err(|e| e.to_string())?;
    let stderr = child.stderr.take().ok_or("нет stderr")?;
    let reader = async {
        let mut frames = 0_u64;
        // (seconds since spawn, frame count) of each progress report with frames.
        let mut samples: Vec<(f64, u64)> = Vec::new();
        let mut cpu = None;
        let mut rss = None;
        let mut last_error = String::new();
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if let Some(v) = line.strip_prefix("frame=") {
                frames = v.trim().parse().unwrap_or(frames);
            } else if line.starts_with("progress=") {
                if frames > 0 {
                    samples.push((started.elapsed().as_secs_f64(), frames));
                }
            } else if line.starts_with("bench: utime=") {
                let value = |key: &str| {
                    line.split_whitespace()
                        .find_map(|part| part.strip_prefix(key))
                        .and_then(|v| v.trim_end_matches('s').parse::<f64>().ok())
                };
                cpu = Some(value("utime=").unwrap_or(0.0) + value("stime=").unwrap_or(0.0));
            } else if let Some(v) = line.strip_prefix("bench: maxrss=") {
                rss = v
                    .trim()
                    .trim_end_matches("KiB")
                    .trim()
                    .parse::<f64>()
                    .ok()
                    .map(|kib| kib / 1024.0);
            } else if !line.contains('=') && !line.trim().is_empty() {
                last_error = line;
            }
        }
        (frames, samples, cpu, rss, last_error)
    };
    let (frames, samples, cpu, rss, last_error) = tokio::time::timeout(STAGE_TIMEOUT, reader)
        .await
        .map_err(|_| "таймаут".to_string())?;
    let status = child.wait().await.map_err(|e| e.to_string())?;
    let wall = started.elapsed().as_secs_f64();
    if !status.success() {
        return Err(format!("ffmpeg {status}: {last_error}"));
    }
    Ok(StageResult {
        frames,
        wall,
        startup: samples.first().map(|(at, _)| *at),
        steady_fps: steady_fps(&samples),
        cpu_seconds: cpu,
        maxrss_mb: rss,
    })
}

/// Throughput between the first and last progress report, so process start and
/// device init do not drag the number down on short clips.
fn steady_fps(samples: &[(f64, u64)]) -> Option<f64> {
    match (samples.first(), samples.last()) {
        (Some(&(t0, f0)), Some(&(t1, f1))) if t1 - t0 > 0.5 && f1 > f0 => {
            Some((f1 - f0) as f64 / (t1 - t0))
        }
        _ => None,
    }
}

async fn ffmpeg_output(ffmpeg: &Path, args: &[&str]) -> Option<String> {
    let mut cmd = Command::new(ffmpeg);
    cmd.args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        cmd.creation_flags(0x0800_0000);
    }
    let out = cmd.output().await.ok()?;
    Some(String::from_utf8_lossy(&out.stdout).to_string())
}

#[cfg(test)]
mod tests {
    use super::steady_fps;

    #[test]
    fn steady_fps_ignores_startup() {
        // 4 s of startup, then 600 frames in 2 s.
        let samples = [(4.0, 100), (5.0, 400), (6.0, 700)];
        assert_eq!(steady_fps(&samples), Some(300.0));
    }

    #[test]
    fn steady_fps_needs_two_spaced_samples() {
        assert_eq!(steady_fps(&[(4.0, 100)]), None);
    }
}
