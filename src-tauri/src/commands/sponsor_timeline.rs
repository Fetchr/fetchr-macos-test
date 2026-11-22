//! Thumbnail strip for the sponsor-blur timeline.
//!
//! The timeline under the preview needs a filmstrip across the whole VOD. Two
//! ways to get one, and only the second is viable:
//!
//!   * one sequential FFmpeg pass (`-skip_frame nokey`) — decodes only
//!     keyframes, but still streams the entire file. On a multi-gigabyte VOD
//!     over the network that is minutes of transfer for a few dozen frames.
//!   * N independent seeks — each `-ss` before `-i` jumps straight to the
//!     nearest keyframe and pulls one frame, so cost scales with the number of
//!     thumbnails rather than with the length of the video.
//!
//! So: N parallel seeks, capped so a VOD host is not hammered, composited into
//! a single sprite. One sprite means one IPC read and one decode in the WebView
//! instead of N of each, and it is cached on disk keyed by URL + geometry, so
//! re-opening the same video is instant.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use image::imageops::FilterType;
use image::{ImageBuffer, Rgb, RgbImage};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use tauri::State;
use tokio::process::Command;
use tokio::sync::Semaphore;

use crate::app_log::LogLevel;
use crate::binaries::{resolve_binary, FFMPEG};
use crate::commands::sponsor_blur::resolve_tracker_media_url;
use crate::jobs::queue::QueueManager;
use crate::jobs::types::JobProgress;
use crate::proxy::ProxyConfig;
use crate::AppState;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Simultaneous FFmpeg seeks. Above ~4 the VOD host becomes the bottleneck and
/// starts refusing connections, which shows up as random black tiles.
const MAX_PARALLEL_SEEKS: usize = 4;
const MIN_TILES: u32 = 8;
const MAX_TILES: u32 = 160;

#[derive(Debug, Deserialize)]
pub struct TimelineThumbnailsRequest {
    pub url: String,
    pub duration_sec: f64,
    #[serde(default = "default_tile_count")]
    pub count: u32,
    #[serde(default = "default_tile_width")]
    pub tile_width: u32,
    #[serde(default)]
    pub task_id: Option<String>,
    #[serde(default)]
    pub quality: Option<String>,
    #[serde(default)]
    pub proxy: Option<ProxyConfig>,
    #[serde(default)]
    pub binaries_dir: Option<String>,
    #[serde(default)]
    pub twitch_auth_token: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct TimelineThumbnails {
    /// Sprite on disk: `count` tiles laid out left to right in one row.
    pub path: String,
    pub count: u32,
    pub tile_width: u32,
    pub tile_height: u32,
    /// Timestamp at the centre of each tile, on the original timeline.
    pub times: Vec<f64>,
    /// True when the sprite came from the on-disk cache.
    pub cached: bool,
}

#[tauri::command]
pub async fn capture_timeline_thumbnails(
    state: State<'_, AppState>,
    req: TimelineThumbnailsRequest,
) -> Result<TimelineThumbnails, String> {
    let input_url = req.url.trim().to_string();
    if input_url.is_empty() {
        return Err("empty video URL".to_string());
    }
    if !req.duration_sec.is_finite() || req.duration_sec <= 0.0 {
        // Live streams have no timeline to fill.
        return Err("timeline thumbnails need a known duration".to_string());
    }
    let count = req.count.clamp(MIN_TILES, MAX_TILES);
    let tile_width = (req.tile_width.clamp(80, 480) / 2) * 2;
    // 16:9 tiles; the source is letterboxed into them so nothing is cropped.
    let tile_height = (tile_width * 9 / 16 / 2) * 2;

    let cache_path = cache_path_for(&input_url, req.duration_sec, count, tile_width);
    let times = tile_times(req.duration_sec, count);
    if tokio::fs::metadata(&cache_path)
        .await
        .map(|meta| meta.is_file() && meta.len() > 0)
        .unwrap_or(false)
    {
        return Ok(TimelineThumbnails {
            path: cache_path.to_string_lossy().into_owned(),
            count,
            tile_width,
            tile_height,
            times,
            cached: true,
        });
    }

    let bin_dir = req.binaries_dir.as_deref().map(Path::new);
    let ffmpeg = resolve_binary(FFMPEG, bin_dir)
        .ok_or_else(|| "ffmpeg.exe not found; thumbnails require FFmpeg".to_string())?;

    let task_id = req
        .task_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| "sponsor_timeline".to_string());
    let cancel = Arc::new(AtomicBool::new(false));
    {
        let mut active = state.timeline_cancels.lock();
        // Only one filmstrip at a time; a new request supersedes the old one.
        for previous in active.values() {
            previous.store(true, Ordering::SeqCst);
        }
        active.clear();
        active.insert(task_id.clone(), cancel.clone());
    }
    let _guard = CancelGuard {
        cancels: state.timeline_cancels.clone(),
        task_id: task_id.clone(),
    };

    let queue = state.queue.clone();
    let progress_id = format!("sponsor_timeline_{task_id}");
    report(&queue, &progress_id, 0.0, "Подготовка ленты кадров...");

    let media_url = resolve_tracker_media_url(
        input_url.clone(),
        req.proxy.clone(),
        req.binaries_dir.clone(),
        req.quality.clone(),
        req.twitch_auth_token.clone(),
    )
    .await?;
    if cancel.load(Ordering::SeqCst) {
        return Err("cancelled".to_string());
    }

    let work_dir = std::env::temp_dir()
        .join("fetchr-timeline")
        .join(format!("work-{task_id}"));
    tokio::fs::create_dir_all(&work_dir)
        .await
        .map_err(|err| format!("create thumbnail dir: {err}"))?;
    let _work_guard = TempDirGuard(work_dir.clone());

    let semaphore = Arc::new(Semaphore::new(MAX_PARALLEL_SEEKS));
    let done = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let mut tasks = Vec::with_capacity(count as usize);
    for (index, time) in times.iter().copied().enumerate() {
        let permits = semaphore.clone();
        let ffmpeg = ffmpeg.clone();
        let media_url = media_url.clone();
        let target = work_dir.join(format!("tile-{index:04}.jpg"));
        let cancel = cancel.clone();
        let queue = queue.clone();
        let progress_id = progress_id.clone();
        let done = done.clone();
        tasks.push(tokio::spawn(async move {
            let _permit = permits
                .acquire()
                .await
                .map_err(|err| format!("thumbnail scheduler closed: {err}"))?;
            if cancel.load(Ordering::SeqCst) {
                return Err::<(usize, Option<PathBuf>), String>("cancelled".to_string());
            }
            let ok = grab_tile(
                &ffmpeg,
                &media_url,
                time,
                tile_width,
                tile_height,
                &target,
                &cancel,
            )
            .await;
            let finished = done.fetch_add(1, Ordering::SeqCst) + 1;
            report(
                &queue,
                &progress_id,
                100.0 * finished as f32 / count as f32,
                &format!("Кадры ленты: {finished}/{count}"),
            );
            // A single failed seek is not fatal: that tile stays blank.
            Ok((index, ok.then_some(target)))
        }));
    }

    let mut tiles: Vec<Option<PathBuf>> = vec![None; count as usize];
    for task in tasks {
        match task.await {
            Ok(Ok((index, path))) => tiles[index] = path,
            Ok(Err(err)) => {
                if err == "cancelled" {
                    return Err(err);
                }
            }
            Err(err) => return Err(format!("thumbnail task failed: {err}")),
        }
    }
    if cancel.load(Ordering::SeqCst) {
        return Err("cancelled".to_string());
    }
    if tiles.iter().all(Option::is_none) {
        return Err("FFmpeg could not extract any timeline thumbnails".to_string());
    }

    let sprite_path = cache_path.clone();
    let composed = tokio::task::spawn_blocking(move || {
        compose_sprite(&tiles, tile_width, tile_height, &sprite_path)
    })
    .await
    .map_err(|err| format!("compose thumbnails: {err}"))?;
    composed?;

    queue.emit_app_log(
        LogLevel::Info,
        "sponsor_timeline_thumbnails",
        "Built sponsor timeline filmstrip",
        Some(json!({
            "url": input_url,
            "count": count,
            "tile_width": tile_width,
            "duration_sec": req.duration_sec,
        })),
    );
    report(&queue, &progress_id, 100.0, "Лента кадров готова");

    Ok(TimelineThumbnails {
        path: cache_path.to_string_lossy().into_owned(),
        count,
        tile_width,
        tile_height,
        times,
        cached: false,
    })
}

#[tauri::command]
pub fn cancel_timeline_thumbnails(state: State<'_, AppState>, task_id: String) {
    if let Some(flag) = state.timeline_cancels.lock().get(&task_id) {
        flag.store(true, Ordering::SeqCst);
    }
}

struct CancelGuard {
    cancels: Arc<parking_lot::Mutex<std::collections::HashMap<String, Arc<AtomicBool>>>>,
    task_id: String,
}

impl Drop for CancelGuard {
    fn drop(&mut self) {
        self.cancels.lock().remove(&self.task_id);
    }
}

struct TempDirGuard(PathBuf);

impl Drop for TempDirGuard {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// Tile centres, inset by half a step so the first and last tiles are not the
/// black frames that often bracket a stream.
fn tile_times(duration: f64, count: u32) -> Vec<f64> {
    let step = duration / count as f64;
    (0..count)
        .map(|index| ((index as f64 + 0.5) * step).clamp(0.0, (duration - 0.05).max(0.0)))
        .collect()
}

async fn grab_tile(
    ffmpeg: &Path,
    media_url: &str,
    time_sec: f64,
    width: u32,
    height: u32,
    target: &Path,
    cancel: &Arc<AtomicBool>,
) -> bool {
    let filter = format!(
        "scale={width}:{height}:force_original_aspect_ratio=decrease,\
pad={width}:{height}:(ow-iw)/2:(oh-ih)/2,setsar=1"
    );
    let mut cmd = Command::new(ffmpeg);
    hide_console(&mut cmd);
    cmd.kill_on_drop(true)
        .args(["-y", "-hide_banner", "-loglevel", "error", "-nostdin"]);
    if time_sec > 0.0 {
        // Input seek: jumps to the nearest keyframe without decoding the lead-in.
        cmd.args(["-ss", &format!("{time_sec:.3}")]);
    }
    cmd.args([
        "-i",
        media_url,
        "-frames:v",
        "1",
        "-an",
        "-sn",
        "-vf",
        &filter,
        "-q:v",
        "6",
    ])
    .arg(target)
    .stdin(Stdio::null())
    .stdout(Stdio::null())
    .stderr(Stdio::null());

    let mut child = match cmd.spawn() {
        Ok(child) => child,
        Err(_) => return false,
    };
    loop {
        if cancel.load(Ordering::SeqCst) {
            let _ = child.kill().await;
            return false;
        }
        match tokio::time::timeout(std::time::Duration::from_millis(250), child.wait()).await {
            Ok(Ok(status)) => {
                return status.success()
                    && std::fs::metadata(target)
                        .map(|meta| meta.len() > 0)
                        .unwrap_or(false)
            }
            Ok(Err(_)) => return false,
            Err(_) => continue,
        }
    }
}

fn compose_sprite(
    tiles: &[Option<PathBuf>],
    tile_width: u32,
    tile_height: u32,
    target: &Path,
) -> Result<(), String> {
    let width = tile_width * tiles.len() as u32;
    let mut sprite: RgbImage = ImageBuffer::from_pixel(width.max(1), tile_height.max(1), Rgb([18, 18, 20]));
    for (index, tile) in tiles.iter().enumerate() {
        let Some(path) = tile else { continue };
        let Ok(image) = image::open(path) else { continue };
        let image = image.to_rgb8();
        let image = if image.width() != tile_width || image.height() != tile_height {
            image::imageops::resize(&image, tile_width, tile_height, FilterType::Triangle)
        } else {
            image
        };
        image::imageops::overlay(&mut sprite, &image, (index as u32 * tile_width) as i64, 0);
    }
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent).map_err(|err| format!("create sprite dir: {err}"))?;
    }
    sprite
        .save(target)
        .map_err(|err| format!("write sprite {}: {err}", target.display()))
}

fn cache_path_for(url: &str, duration: f64, count: u32, tile_width: u32) -> PathBuf {
    let mut hasher = Sha256::new();
    hasher.update(url.as_bytes());
    // Duration is part of the key: a live VOD that is still growing produces a
    // different strip once it gets longer.
    hasher.update(format!("|{duration:.0}|{count}|{tile_width}").as_bytes());
    let digest = hex::encode(&hasher.finalize()[..12]);
    std::env::temp_dir()
        .join("fetchr-timeline")
        .join(format!("strip-{digest}.jpg"))
}

fn report(queue: &Arc<QueueManager>, id: &str, percent: f32, message: &str) {
    queue.set_progress(
        id,
        JobProgress {
            percent,
            message: Some(message.to_string()),
            ..JobProgress::default()
        },
    );
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

fn default_tile_count() -> u32 {
    48
}

fn default_tile_width() -> u32 {
    160
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tile_times_stay_inside_the_video() {
        let times = tile_times(100.0, 10);
        assert_eq!(times.len(), 10);
        assert!(times[0] > 0.0, "first tile should not be frame zero");
        assert!(*times.last().unwrap() < 100.0);
        // Strictly increasing and evenly spaced.
        for pair in times.windows(2) {
            assert!(pair[1] > pair[0]);
        }
        assert!((times[1] - times[0] - 10.0).abs() < 1e-9);
    }

    #[test]
    fn cache_key_tracks_url_and_geometry() {
        let a = cache_path_for("https://example/a", 100.0, 48, 160);
        assert_eq!(a, cache_path_for("https://example/a", 100.0, 48, 160));
        assert_ne!(a, cache_path_for("https://example/b", 100.0, 48, 160));
        assert_ne!(a, cache_path_for("https://example/a", 200.0, 48, 160));
        assert_ne!(a, cache_path_for("https://example/a", 100.0, 64, 160));
        assert_ne!(a, cache_path_for("https://example/a", 100.0, 48, 240));
    }
}
