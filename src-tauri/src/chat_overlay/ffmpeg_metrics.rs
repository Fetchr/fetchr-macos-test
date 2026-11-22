use std::path::Path;

use tokio::process::Command;

use crate::jobs::types::GpuEncoderMode;

/// What one ffprobe call learns about the source video.
#[derive(Debug, Clone, Copy, Default)]
pub struct SourceProbe {
    /// Video stream bitrate, falling back to the container bitrate (HLS/MKV often
    /// report N/A on the stream). `None` keeps quality-based (CRF/CQ) defaults.
    pub bitrate: Option<u64>,
    pub size: Option<(u32, u32)>,
    /// Video `r_frame_rate`.
    pub fps: Option<f64>,
    /// How much later the video starts than the container (Twitch clips: ~1 s).
    pub video_offset: Option<f64>,
}

/// Probe bitrate and size in a single ffprobe run. Every ffmpeg/ffprobe launch costs
/// seconds on some machines (200 MB static binary, AV scanning), so probes are merged.
pub async fn probe_source(ffmpeg: &Path, input: &Path) -> SourceProbe {
    let ffprobe = ffmpeg.with_file_name(if cfg!(windows) { "ffprobe.exe" } else { "ffprobe" });
    if !ffprobe.is_file() {
        return SourceProbe::default();
    }
    let mut cmd = Command::new(&ffprobe);
    cmd.args([
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=width,height,bit_rate,r_frame_rate,start_time:format=bit_rate,start_time",
        "-of",
        "default=nw=1",
    ])
    .arg(input)
    .stdin(std::process::Stdio::null())
    .stdout(std::process::Stdio::piped())
    .stderr(std::process::Stdio::null());
    #[cfg(windows)]
    {
        cmd.creation_flags(0x0800_0000);
    }
    let Ok(out) = cmd.output().await else {
        return SourceProbe::default();
    };
    parse_source_probe(&String::from_utf8_lossy(&out.stdout))
}

/// Stream fields come before format fields, so the first valid `bit_rate` is the
/// stream's and a later one is the container fallback.
fn parse_source_probe(text: &str) -> SourceProbe {
    let mut probe = SourceProbe::default();
    let (mut width, mut height) = (None, None);
    let mut starts: Vec<Option<f64>> = Vec::new();
    for line in text.lines() {
        let Some((key, value)) = line.trim().split_once('=') else {
            continue;
        };
        match key {
            "width" => width = value.parse::<u32>().ok(),
            "height" => height = value.parse::<u32>().ok(),
            "bit_rate" if probe.bitrate.is_none() => {
                probe.bitrate = value.parse::<u64>().ok().filter(|v| *v > 0);
            }
            "r_frame_rate" => probe.fps = parse_rate(value),
            "start_time" => starts.push(value.parse::<f64>().ok()),
            _ => {}
        }
    }
    if let (Some(w), Some(h)) = (width, height) {
        probe.size = Some((w, h));
    }
    // Stream start comes first, container start second.
    if let [Some(video), Some(container)] = starts.as_slice() {
        probe.video_offset = Some((video - container).max(0.0));
    }
    probe
}

fn parse_rate(value: &str) -> Option<f64> {
    let (num, den) = value.split_once('/')?;
    let (num, den) = (num.parse::<f64>().ok()?, den.parse::<f64>().ok()?);
    (num > 0.0 && den > 0.0).then(|| num / den)
}

pub async fn probe_source_bitrate(ffmpeg: &Path, input: &Path) -> Option<u64> {
    probe_source(ffmpeg, input).await.bitrate
}

/// Constant-bitrate rate-control args for the given encoder, locking the output bitrate to
/// `bitrate` bits/sec so the chat-render re-encode keeps the source's bitrate (and file size)
/// instead of inflating it via CRF/CQ quality targets.
pub fn cbr_rate_args(mode: GpuEncoderMode, bitrate: u64) -> Vec<String> {
    let b = bitrate.to_string();
    match mode {
        GpuEncoderMode::Nvenc => vec![
            "-rc".into(),
            "cbr".into(),
            "-b:v".into(),
            b.clone(),
            "-maxrate".into(),
            b.clone(),
            "-bufsize".into(),
            b,
        ],
        GpuEncoderMode::Amf => vec![
            "-rc".into(),
            "cbr".into(),
            "-b:v".into(),
            b.clone(),
            "-maxrate".into(),
            b,
        ],
        GpuEncoderMode::IntelXeQsv | GpuEncoderMode::Qsv => vec![
            "-b:v".into(),
            b.clone(),
            "-maxrate".into(),
            b.clone(),
            "-bufsize".into(),
            b,
        ],
        // libx264 (CPU) and Vulkan: minrate=maxrate=b:v forces true CBR.
        _ => vec![
            "-b:v".into(),
            b.clone(),
            "-minrate".into(),
            b.clone(),
            "-maxrate".into(),
            b.clone(),
            "-bufsize".into(),
            b,
        ],
    }
}

#[derive(Debug, Clone, Copy)]
pub struct ChatPipeMetrics {
    pub frames: usize,
    pub elapsed_seconds: f64,
    pub fps: f64,
    pub target_fps: u32,
}

#[derive(Debug, Clone)]
pub struct DirectRenderMetrics {
    pub frame: Option<u64>,
    pub video_output_fps: Option<f64>,
    pub ffmpeg_speed: Option<f64>,
    pub chat_pipe_fps: f64,
    pub elapsed_seconds: f64,
    pub wall_speed: f64,
}

impl ChatPipeMetrics {
    pub fn new(frames: usize, elapsed_seconds: f64, target_fps: u32) -> Self {
        let elapsed_seconds = elapsed_seconds.max(0.001);
        Self {
            frames,
            elapsed_seconds,
            fps: frames as f64 / elapsed_seconds,
            target_fps: target_fps.max(1),
        }
    }

    pub fn speed_ratio(&self) -> f64 {
        self.fps / self.target_fps as f64
    }
}

#[derive(Debug, Default, Clone)]
pub struct FfmpegEncodeMetrics {
    pub frame: Option<u64>,
    pub video_output_fps: Option<f64>,
    pub speed: Option<f64>,
    pub out_time_seconds: Option<f64>,
}

impl FfmpegEncodeMetrics {
    pub fn update_from_line(&mut self, line: &str) -> bool {
        let mut changed = false;

        if let Some(frame) = parse_key_u64(line, "frame") {
            self.frame = Some(frame);
            changed = true;
        }
        if let Some(fps) = parse_key_f64(line, "fps") {
            self.video_output_fps = Some(fps);
            changed = true;
        }
        if let Some(speed) = parse_key_f64_with_suffix(line, "speed", "x") {
            self.speed = Some(speed);
            changed = true;
        }
        if let Some(time) =
            parse_key_time(line, "time").or_else(|| parse_key_time(line, "out_time"))
        {
            self.out_time_seconds = Some(time);
            changed = true;
        } else if let Some(us) =
            parse_key_f64(line, "out_time_us").or_else(|| parse_key_f64(line, "out_time_ms"))
        {
            self.out_time_seconds = Some(us / 1_000_000.0);
            changed = true;
        }

        changed
    }
}

pub fn is_ffmpeg_progress_line(line: &str) -> bool {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return false;
    }
    if contains_key(trimmed, "frame")
        || contains_key(trimmed, "fps")
        || contains_key(trimmed, "speed")
        || contains_key(trimmed, "time")
        || contains_key(trimmed, "out_time")
    {
        return true;
    }

    let key = trimmed.split('=').next().unwrap_or_default().trim();
    matches!(
        key,
        "bitrate"
            | "total_size"
            | "out_time_us"
            | "out_time_ms"
            | "out_time"
            | "dup_frames"
            | "drop_frames"
            | "progress"
            | "stream_0_0_q"
    )
}

pub fn render_progress_message(
    metrics: &FfmpegEncodeMetrics,
    chat_pipe_fps: Option<f64>,
) -> String {
    format!(
        "Render: {} video-fps / {} chat-fps / speed {}",
        metrics
            .video_output_fps
            .map(format_fps_value)
            .unwrap_or_else(|| "...".to_string()),
        chat_pipe_fps
            .map(format_fps_value)
            .unwrap_or_else(|| "...".to_string()),
        metrics
            .speed
            .map(format_speed_value)
            .unwrap_or_else(|| "...".to_string())
    )
}

pub fn format_fps_value(value: f64) -> String {
    if value.is_finite() {
        format!("{:.0}", value.max(0.0))
    } else {
        "n/a".to_string()
    }
}

pub fn format_speed_value(value: f64) -> String {
    if value.is_finite() {
        format!("{:.2}x", value.max(0.0))
    } else {
        "n/a".to_string()
    }
}

pub fn format_optional_fps(value: Option<f64>) -> String {
    value
        .filter(|value| value.is_finite())
        .map(|value| format!("{value:.1}"))
        .unwrap_or_else(|| "n/a".to_string())
}

pub fn format_optional_speed(value: Option<f64>) -> String {
    value
        .filter(|value| value.is_finite())
        .map(format_speed_value)
        .unwrap_or_else(|| "n/a".to_string())
}

fn parse_key_u64(line: &str, key: &str) -> Option<u64> {
    key_value(line, key)?.trim_end_matches(',').parse().ok()
}

fn parse_key_f64(line: &str, key: &str) -> Option<f64> {
    parse_float(key_value(line, key)?)
}

fn parse_key_f64_with_suffix(line: &str, key: &str, suffix: &str) -> Option<f64> {
    parse_float(key_value(line, key)?.trim_end_matches(suffix))
}

fn parse_key_time(line: &str, key: &str) -> Option<f64> {
    parse_timecode(key_value(line, key)?)
}

fn parse_float(raw: &str) -> Option<f64> {
    let cleaned = raw.trim().trim_end_matches(',').trim_end_matches('\r');
    if cleaned.eq_ignore_ascii_case("n/a") {
        return None;
    }
    cleaned.parse().ok().filter(|value: &f64| value.is_finite())
}

fn parse_timecode(raw: &str) -> Option<f64> {
    let cleaned = raw.trim().trim_end_matches(',').trim_end_matches('\r');
    let mut parts = cleaned.split(':');
    let h = parts.next()?.parse::<f64>().ok()?;
    let m = parts.next()?.parse::<f64>().ok()?;
    let s = parts.next()?.parse::<f64>().ok()?;
    Some(h * 3600.0 + m * 60.0 + s)
}

fn contains_key(line: &str, key: &str) -> bool {
    key_value(line, key).is_some()
}

fn key_value<'a>(line: &'a str, key: &str) -> Option<&'a str> {
    let needle = format!("{key}=");
    let mut start = 0;
    while let Some(relative) = line[start..].find(&needle) {
        let idx = start + relative;
        let boundary = idx == 0
            || line[..idx]
                .chars()
                .next_back()
                .map(|ch| ch.is_whitespace() || ch == '\r')
                .unwrap_or(true);
        if boundary {
            let rest = line[idx + needle.len()..].trim_start();
            return rest.split_whitespace().next();
        }
        start = idx + needle.len();
    }
    None
}

#[cfg(test)]
mod probe_tests {
    use super::parse_source_probe;

    #[test]
    fn stream_bitrate_wins_over_format() {
        let p = parse_source_probe("width=1920\nheight=1080\nbit_rate=6003374\nbit_rate=6173000\n");
        assert_eq!(p.bitrate, Some(6003374));
        assert_eq!(p.size, Some((1920, 1080)));
    }

    #[test]
    fn reads_rate_and_late_video_start() {
        let p = parse_source_probe(
            "r_frame_rate=60/1\nstart_time=1.055000\nbit_rate=1\nstart_time=0.015000\n",
        );
        assert_eq!(p.fps, Some(60.0));
        assert!((p.video_offset.unwrap() - 1.04).abs() < 1e-9);
    }

    #[test]
    fn falls_back_to_format_bitrate() {
        let p = parse_source_probe("width=1280\nheight=720\nbit_rate=N/A\nbit_rate=4000000\n");
        assert_eq!(p.bitrate, Some(4000000));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_ffmpeg_stats_line() {
        let mut metrics = FfmpegEncodeMetrics::default();
        assert!(metrics.update_from_line(
            "frame=18720 fps=217 q=-0.0 size=123kB time=00:05:12.00 bitrate=3.2kbits/s speed=3.61x"
        ));
        assert_eq!(metrics.frame, Some(18720));
        assert_eq!(metrics.video_output_fps, Some(217.0));
        assert_eq!(metrics.speed, Some(3.61));
        assert_eq!(metrics.out_time_seconds, Some(312.0));
    }

    #[test]
    fn parses_ffmpeg_progress_lines() {
        let mut metrics = FfmpegEncodeMetrics::default();
        assert!(metrics.update_from_line("frame=18720"));
        assert!(metrics.update_from_line("fps=217.42"));
        assert!(metrics.update_from_line("out_time=00:05:12.000000"));
        assert!(metrics.update_from_line("speed=3.61x"));
        assert_eq!(metrics.frame, Some(18720));
        assert_eq!(metrics.video_output_fps, Some(217.42));
        assert_eq!(metrics.speed, Some(3.61));
        assert_eq!(metrics.out_time_seconds, Some(312.0));
    }
}
