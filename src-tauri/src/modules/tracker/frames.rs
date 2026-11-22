//! Streaming frame source for the sponsor tracker.
//!
//! The previous tracker wrote every sampled frame to disk as a 1080p PNG and
//! immediately re-decoded it; PNG encode + decode dominated the runtime and
//! forced a temp directory. This module keeps FFmpeg's output in a pipe: frames
//! arrive as packed BGR24 and are consumed one at a time, so only the current
//! frame is ever resident and no file I/O happens at all.

use std::path::Path;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use tokio::io::AsyncReadExt;
use tokio::process::{Child, ChildStdout, Command};

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// A single decoded frame in packed BGR24 (`width * height * 3` bytes).
pub struct RawFrame {
    /// 0-based index within the sampled sequence.
    pub index: usize,
    /// Timestamp on the original video timeline.
    pub time_sec: f64,
    pub data: Vec<u8>,
}

pub struct FrameStreamOptions<'a> {
    pub ffmpeg: &'a Path,
    pub media_url: &'a str,
    pub start_time: f64,
    pub duration: Option<f64>,
    /// Seconds between sampled frames (`fps = 1 / interval`).
    pub interval: f64,
    pub width: u32,
    pub height: u32,
    /// Ask FFmpeg for hardware-assisted decoding; it silently falls back to
    /// software when no usable device is present.
    pub hwaccel: bool,
}

/// A live FFmpeg process yielding raw frames through a pipe.
pub struct FrameStream {
    child: Child,
    stdout: ChildStdout,
    stderr: Option<tokio::task::JoinHandle<String>>,
    frame_bytes: usize,
    start_time: f64,
    interval: f64,
    index: usize,
    finished: bool,
}

impl FrameStream {
    pub fn spawn(options: FrameStreamOptions<'_>) -> Result<Self, String> {
        let width = options.width.max(2) & !1;
        let height = options.height.max(2) & !1;
        let fps = 1.0 / options.interval.clamp(0.01, 10.0);
        let filter = format!(
            "fps={fps:.5},scale={width}:{height}:force_original_aspect_ratio=decrease:flags=bilinear,\
pad={width}:{height}:(ow-iw)/2:(oh-ih)/2,setsar=1,format=bgr24"
        );

        let mut cmd = Command::new(options.ffmpeg);
        hide_console(&mut cmd);
        cmd.kill_on_drop(true)
            .args(["-y", "-hide_banner", "-loglevel", "error", "-nostdin"]);
        if options.hwaccel {
            // `auto` picks d3d11va/dxva2/videotoolbox/vaapi when available and
            // transparently downloads frames back for the software filters.
            cmd.args(["-hwaccel", "auto"]);
        }
        if options.start_time > 0.0 {
            // Input seek: orders of magnitude faster than output seek on long VODs.
            cmd.args(["-ss", &format!("{:.3}", options.start_time)]);
        }
        cmd.args(["-i", options.media_url]);
        let duration_arg = options.duration.map(|value| format!("{value:.3}"));
        if let Some(duration) = duration_arg.as_deref() {
            cmd.args(["-t", duration]);
        }
        cmd.args([
            "-an",
            "-sn",
            "-dn",
            "-vf",
            &filter,
            "-f",
            "rawvideo",
            "-pix_fmt",
            "bgr24",
            "-",
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

        let mut child = cmd
            .spawn()
            .map_err(|err| format!("start FFmpeg frame pipe: {err}"))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "FFmpeg frame pipe has no stdout".to_string())?;
        // Drain stderr in the background: a full pipe buffer would stall FFmpeg.
        let stderr = child.stderr.take();
        let stderr = tokio::spawn(async move {
            let mut buf = Vec::new();
            if let Some(mut stderr) = stderr {
                let _ = stderr.read_to_end(&mut buf).await;
            }
            String::from_utf8_lossy(&buf).into_owned()
        });

        Ok(Self {
            child,
            stdout,
            stderr: Some(stderr),
            frame_bytes: width as usize * height as usize * 3,
            start_time: options.start_time,
            interval: options.interval,
            index: 0,
            finished: false,
        })
    }

    /// Reads the next full frame. `Ok(None)` means the stream ended cleanly.
    pub async fn next_frame(
        &mut self,
        cancel: &Arc<AtomicBool>,
    ) -> Result<Option<RawFrame>, String> {
        if self.finished {
            return Ok(None);
        }
        let mut data = vec![0u8; self.frame_bytes];
        let mut filled = 0usize;
        while filled < self.frame_bytes {
            if cancel.load(Ordering::SeqCst) {
                self.shutdown().await;
                return Err("cancelled".to_string());
            }
            // `AsyncReadExt::read` is cancel-safe, so the timeout only wakes us
            // up to re-check the cancel flag; no bytes can be lost.
            let read = tokio::time::timeout(
                Duration::from_millis(400),
                self.stdout.read(&mut data[filled..]),
            )
            .await;
            match read {
                Ok(Ok(0)) => {
                    self.finished = true;
                    if filled == 0 {
                        return Ok(None);
                    }
                    // A partial trailing frame means FFmpeg died mid-write.
                    let stderr = self.take_stderr().await;
                    return Err(format!(
                        "FFmpeg produced a truncated frame ({filled}/{} bytes){}",
                        self.frame_bytes,
                        format_stderr(&stderr)
                    ));
                }
                Ok(Ok(bytes)) => filled += bytes,
                Ok(Err(err)) => {
                    self.finished = true;
                    return Err(format!("read frame from FFmpeg pipe: {err}"));
                }
                Err(_elapsed) => continue,
            }
        }
        let frame = RawFrame {
            index: self.index,
            time_sec: self.start_time + self.index as f64 * self.interval,
            data,
        };
        self.index += 1;
        Ok(Some(frame))
    }

    /// Waits for FFmpeg and turns a non-zero exit into an error. Call after the
    /// stream reports EOF; a clean EOF with a failed exit code means the source
    /// broke midway and the collected keyframes are incomplete.
    pub async fn finish(mut self) -> Result<(), String> {
        let status = match self.child.wait().await {
            Ok(status) => status,
            Err(err) => return Err(format!("wait for FFmpeg frame pipe: {err}")),
        };
        if status.success() {
            return Ok(());
        }
        let stderr = self.take_stderr().await;
        Err(format!(
            "FFmpeg frame pipe failed{}",
            format_stderr(&stderr)
        ))
    }

    async fn shutdown(&mut self) {
        let _ = self.child.kill().await;
        let _ = self.child.wait().await;
        self.finished = true;
    }

    async fn take_stderr(&mut self) -> String {
        match self.stderr.take() {
            Some(handle) => handle.await.unwrap_or_default(),
            None => String::new(),
        }
    }
}

fn format_stderr(stderr: &str) -> String {
    let trimmed = stderr.trim();
    if trimmed.is_empty() {
        String::new()
    } else {
        format!(": {trimmed}")
    }
}

fn hide_console(cmd: &mut Command) {
    #[cfg(windows)]
    {
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(windows))]
    {
        let _ = cmd;
    }
}
