use std::collections::HashMap;
use std::io::{BufReader, Cursor};
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use futures::stream::{self, StreamExt};
use image::codecs::gif::GifDecoder;
use image::{imageops, AnimationDecoder, DynamicImage, RgbaImage};
use sha1::{Digest, Sha1};
use webp::{AnimDecoder, PixelLayout};

use crate::chat_overlay::emit_log;
use crate::jobs::queue::QueueManager;
use crate::jobs::types::JobProgress;

#[derive(Debug, Clone)]
pub struct AnimatedImage {
    frames: Vec<DynamicImage>,
    cumulative_ms: Vec<u32>,
    duration_ms: u32,
}

#[derive(Debug, Clone)]
pub struct ScaledAnimatedImage {
    frames: Vec<RgbaImage>,
    cumulative_ms: Vec<u32>,
    duration_ms: u32,
}

impl AnimatedImage {
    pub fn from_static(image: DynamicImage) -> Self {
        Self {
            frames: vec![image],
            cumulative_ms: vec![1000],
            duration_ms: 1000,
        }
    }

    pub fn is_animated(&self) -> bool {
        self.frames.len() > 1
    }

    pub fn dimensions(&self) -> (u32, u32) {
        self.frames
            .first()
            .map(|frame| (frame.width(), frame.height()))
            .unwrap_or((1, 1))
    }

    pub fn scaled_rgba(&self, max_width: i32, max_height: i32) -> ScaledAnimatedImage {
        let frames = self
            .frames
            .iter()
            .map(|frame| resize_to_rgba(frame, max_width, max_height))
            .collect();
        ScaledAnimatedImage {
            frames,
            cumulative_ms: self.cumulative_ms.clone(),
            duration_ms: self.duration_ms,
        }
    }
}

impl ScaledAnimatedImage {
    pub fn frame_at(&self, seconds: f64) -> &RgbaImage {
        &self.frames[self.frame_index_at(seconds)]
    }

    pub fn frame_index_at(&self, seconds: f64) -> usize {
        if self.frames.len() == 1 || self.duration_ms == 0 {
            return 0;
        }
        let ms = ((seconds.max(0.0) * 1000.0) as u32) % self.duration_ms;
        self.cumulative_ms
            .iter()
            .position(|end| ms < *end)
            .unwrap_or(0)
            .min(self.frames.len() - 1)
    }
}

pub struct EmoteCache {
    root: PathBuf,
    memory: HashMap<String, Option<AnimatedImage>>,
    client: reqwest::Client,
    proxy_client: Option<reqwest::Client>,
}

pub struct BadgeCache {
    root: PathBuf,
    memory: HashMap<String, Option<DynamicImage>>,
    client: reqwest::Client,
    proxy_client: Option<reqwest::Client>,
}

impl EmoteCache {
    pub fn new(root: PathBuf, proxy_url: Option<&str>) -> Self {
        let _ = std::fs::create_dir_all(&root);
        Self {
            root,
            memory: HashMap::new(),
            client: crate::chat_overlay::chat_http_client(None),
            proxy_client: proxy_url.map(|url| crate::chat_overlay::chat_http_client(Some(url))),
        }
    }

    pub fn get(&self, provider: &str, id: &str, url: &str) -> Option<&AnimatedImage> {
        self.memory
            .get(&format!("emote:{provider}:{id}:{url}"))
            .and_then(Option::as_ref)
    }

    pub async fn preload_many(
        &mut self,
        assets: Vec<(String, String, String)>,
        limit: usize,
        queue: &std::sync::Arc<QueueManager>,
        job_id: &str,
        progress_offset: usize,
        total_assets: usize,
    ) -> usize {
        let root = self.root.clone();
        let client = self.client.clone();
        let proxy_client = self.proxy_client.clone();
        let mut loaded = stream::iter(assets)
            .map(|(provider, id, url)| {
                let root = root.clone();
                let client = client.clone();
                let proxy_client = proxy_client.clone();
                async move {
                    let key = format!("emote:{provider}:{id}:{url}");
                    let path = cache_path(&root, &provider, &id, &url);
                    let image = load_or_download_animated(
                        &client,
                        proxy_client.as_ref(),
                        &path,
                        &url,
                    )
                    .await
                    .ok();
                    (key, provider, id, image)
                }
            })
            .buffer_unordered(limit.max(1));

        let mut count = progress_offset;
        while let Some((key, provider, id, image)) = loaded.next().await {
            if image.is_none() {
                emit_log(
                    queue,
                    job_id,
                    &format!("Chat overlay: emote {provider}/{id} unavailable during preload"),
                );
            }
            self.memory.insert(key, image);
            count += 1;
            update_preload_progress(queue, job_id, count, total_assets);
        }
        count
    }
}

impl BadgeCache {
    pub fn new(root: PathBuf, proxy_url: Option<&str>) -> Self {
        let _ = std::fs::create_dir_all(&root);
        Self {
            root,
            memory: HashMap::new(),
            client: crate::chat_overlay::chat_http_client(None),
            proxy_client: proxy_url.map(|url| crate::chat_overlay::chat_http_client(Some(url))),
        }
    }

    pub fn get(&self, provider: &str, id: &str, url: &str) -> Option<&DynamicImage> {
        self.memory
            .get(&format!("badge:{provider}:{id}:{url}"))
            .and_then(Option::as_ref)
    }

    pub async fn preload_many(
        &mut self,
        assets: Vec<(String, String, String)>,
        limit: usize,
        queue: &std::sync::Arc<QueueManager>,
        job_id: &str,
        progress_offset: usize,
        total_assets: usize,
    ) -> usize {
        let root = self.root.clone();
        let client = self.client.clone();
        let proxy_client = self.proxy_client.clone();
        let mut loaded = stream::iter(assets)
            .map(|(provider, id, url)| {
                let root = root.clone();
                let client = client.clone();
                let proxy_client = proxy_client.clone();
                async move {
                    let key = format!("badge:{provider}:{id}:{url}");
                    let path = cache_path(&root, &provider, &id, &url);
                    let image =
                        load_or_download_static(&client, proxy_client.as_ref(), &path, &url)
                            .await
                            .ok();
                    (key, provider, id, image)
                }
            })
            .buffer_unordered(limit.max(1));

        let mut count = progress_offset;
        while let Some((key, provider, id, image)) = loaded.next().await {
            if image.is_none() {
                emit_log(
                    queue,
                    job_id,
                    &format!("Chat overlay: badge {provider}/{id} unavailable during preload"),
                );
            }
            self.memory.insert(key, image);
            count += 1;
            update_preload_progress(queue, job_id, count, total_assets);
        }
        count
    }
}

fn update_preload_progress(
    queue: &std::sync::Arc<QueueManager>,
    job_id: &str,
    loaded: usize,
    total: usize,
) {
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
            message: Some(format!("Загрузка эмотов/бейджей: {loaded}/{total}")),
            ..JobProgress::default()
        },
    );
}

fn cache_path(root: &Path, provider: &str, id: &str, url: &str) -> PathBuf {
    let mut hasher = Sha1::new();
    hasher.update(url.as_bytes());
    let hash = hex::encode(hasher.finalize());
    let ext = url
        .split('?')
        .next()
        .and_then(|u| u.rsplit('.').next())
        .filter(|ext| ext.len() <= 5 && is_safe_path_part(ext))
        .unwrap_or("img");
    // provider/id come from chat json files too (imported, not only downloaded):
    // anything that is not a plain token must not reach the path.
    let provider = if is_safe_path_part(provider) { provider } else { "other" };
    let id = if is_safe_path_part(id) && id.len() <= 64 { id } else { "asset" };
    root.join(provider).join(format!("{id}-{hash}.{ext}"))
}

fn is_safe_path_part(value: &str) -> bool {
    !value.is_empty()
        && value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-')
}

async fn load_or_download_static(
    client: &reqwest::Client,
    proxy_client: Option<&reqwest::Client>,
    path: &Path,
    url: &str,
) -> Result<DynamicImage> {
    if crate::chat_overlay::badge_art::is_builtin(url) {
        return crate::chat_overlay::badge_art::render(url)
            .ok_or_else(|| anyhow::anyhow!("unknown built-in badge {url}"));
    }
    load_or_download_decoded(client, proxy_client, path, url, |bytes, label| {
        image::load_from_memory(bytes).with_context(|| format!("decode {label}"))
    })
    .await
}

async fn load_or_download_animated(
    client: &reqwest::Client,
    proxy_client: Option<&reqwest::Client>,
    path: &Path,
    url: &str,
) -> Result<AnimatedImage> {
    match load_or_download_decoded(client, proxy_client, path, url, decode_animated).await {
        Ok(image) => Ok(image),
        Err(err) if is_7tv_cdn_url(url) => {
            let proxy_url = seven_tv_proxy_url(url);
            let proxy_path = path.with_file_name(format!(
                "{}.proxy",
                path.file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or("7tv.webp")
            ));
            load_or_download_decoded(client, proxy_client, &proxy_path, &proxy_url, decode_animated)
                .await
                .with_context(|| format!("7TV proxy fallback after {err}"))
        }
        Err(err) => Err(err),
    }
}

/// Reading, decoding (every frame of a GIF/WebP) and writing run on the
/// blocking pool: on the async worker they went one asset at a time and held
/// up the other downloads of the `buffer_unordered` batch, so a warm cache
/// decoded strictly serially.
async fn load_or_download_decoded<T, F>(
    client: &reqwest::Client,
    proxy_client: Option<&reqwest::Client>,
    path: &Path,
    url: &str,
    decode: F,
) -> Result<T>
where
    T: Send + 'static,
    F: Fn(&[u8], &str) -> Result<T> + Send + Copy + 'static,
{
    if path.is_file() {
        let cached_path = path.to_path_buf();
        let label = url.to_string();
        let cached = tokio::task::spawn_blocking(move || -> Result<Option<T>> {
            let bytes = std::fs::read(&cached_path)
                .with_context(|| format!("read {}", cached_path.display()))?;
            match decode(&bytes, &label) {
                Ok(value) => Ok(Some(value)),
                Err(err) => {
                    let _ = std::fs::remove_file(&cached_path);
                    tracing::warn!(
                        "deleted corrupt chat asset cache {}: {err:#}",
                        cached_path.display()
                    );
                    Ok(None)
                }
            }
        })
        .await
        .context("chat asset decode task")??;
        if let Some(value) = cached {
            return Ok(value);
        }
    }

    // Emote CDNs are frequently blackholed on direct connections; retry once through the
    // configured proxy when the direct download fails.
    let bytes = match download_bytes(client, url).await {
        Ok(bytes) => bytes,
        Err(err) => {
            let err = match proxy_client {
                Some(proxy) => match download_bytes(proxy, url).await {
                    Ok(bytes) => return finish_download(path, url, bytes, decode).await,
                    Err(retry) => anyhow::anyhow!("{err:#}; proxy retry failed too: {retry:#}"),
                },
                None => err,
            };
            if !crate::chat_overlay::mirror::available_for(url) {
                return Err(err);
            }
            crate::chat_overlay::mirror::fetch(client, url)
                .await
                .with_context(|| format!("{err:#}; recorder relay failed too"))?
        }
    };
    finish_download(path, url, bytes, decode).await
}

async fn finish_download<T, F>(path: &Path, url: &str, bytes: Vec<u8>, decode: F) -> Result<T>
where
    T: Send + 'static,
    F: Fn(&[u8], &str) -> Result<T> + Send + Copy + 'static,
{
    let target = path.to_path_buf();
    let label = url.to_string();
    tokio::task::spawn_blocking(move || -> Result<T> {
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(&target, &bytes).with_context(|| format!("write {}", target.display()))?;
        decode(&bytes, &label)
    })
    .await
    .context("chat asset decode task")?
}

async fn download_bytes(client: &reqwest::Client, url: &str) -> Result<Vec<u8>> {
    client
        .get(url)
        .send()
        .await
        .with_context(|| format!("GET {url}"))?
        .error_for_status()
        .with_context(|| format!("GET {url}"))?
        .bytes()
        .await
        .with_context(|| format!("read {url}"))
        .map(|bytes| bytes.to_vec())
}

fn is_7tv_cdn_url(url: &str) -> bool {
    url.contains("://cdn.7tv.app/")
}

fn seven_tv_proxy_url(url: &str) -> String {
    url.replace(
        "https://cdn.7tv.app",
        "https://7tv-imageproxy.twitcharchives.workers.dev",
    )
}

fn decode_animated(bytes: &[u8], label: &str) -> Result<AnimatedImage> {
    if let Ok(decoder) = GifDecoder::new(BufReader::new(Cursor::new(bytes))) {
        if let Ok(frames) = decoder.into_frames().collect_frames() {
            return Ok(animated_from_frames(frames));
        }
    }

    // Animated WebP (most 7TV emotes): decode via libwebp, which composites blended/disposed
    // frames correctly. The pure-Rust image-webp path produced torn/ghosted frames.
    if is_webp(bytes) {
        if let Some(animated) = decode_webp_animation(bytes) {
            return Ok(animated);
        }
    }

    image::load_from_memory(bytes)
        .map(AnimatedImage::from_static)
        .with_context(|| format!("decode {label}"))
}

fn is_webp(bytes: &[u8]) -> bool {
    bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP"
}

/// Decode an animated WebP into fully-composited RGBA frames using libwebp. Returns `None` for a
/// single-frame (static) WebP so the caller falls back to the static decode path.
fn decode_webp_animation(bytes: &[u8]) -> Option<AnimatedImage> {
    let decoded = AnimDecoder::new(bytes).decode().ok()?;
    let mut frames = Vec::new();
    let mut cumulative_ms = Vec::new();
    let mut last_end = 0_u32;
    for frame in &decoded {
        let width = frame.width();
        let height = frame.height();
        let raw = frame.get_image();
        let rgba = match frame.get_layout() {
            PixelLayout::Rgba => RgbaImage::from_raw(width, height, raw.to_vec())?,
            PixelLayout::Rgb => {
                let mut buf = Vec::with_capacity((width as usize) * (height as usize) * 4);
                for px in raw.chunks_exact(3) {
                    buf.extend_from_slice(&[px[0], px[1], px[2], 255]);
                }
                RgbaImage::from_raw(width, height, buf)?
            }
        };
        // libwebp reports the frame's end timestamp (ms); keep it strictly increasing.
        let end = (frame.get_time_ms().max(0) as u32).max(last_end + 20);
        cumulative_ms.push(end);
        last_end = end;
        frames.push(DynamicImage::ImageRgba8(rgba));
    }
    if frames.len() < 2 {
        return None;
    }
    let duration_ms = last_end.max(20);
    Some(AnimatedImage {
        frames,
        cumulative_ms,
        duration_ms,
    })
}

fn animated_from_frames(frames: Vec<image::Frame>) -> AnimatedImage {
    let mut images = Vec::new();
    let mut cumulative_ms = Vec::new();
    let mut total = 0_u32;

    for frame in frames {
        let (num, den) = frame.delay().numer_denom_ms();
        let delay = if den == 0 { 100 } else { (num / den).max(20) };
        total = total.saturating_add(delay);
        cumulative_ms.push(total);
        images.push(DynamicImage::ImageRgba8(frame.into_buffer()));
    }

    if images.is_empty() {
        return AnimatedImage::from_static(DynamicImage::new_rgba8(1, 1));
    }

    AnimatedImage {
        frames: images,
        cumulative_ms,
        duration_ms: total.max(20),
    }
}

fn resize_to_rgba(image: &DynamicImage, max_width: i32, max_height: i32) -> RgbaImage {
    let max_w = max_width.max(1) as f32;
    let target_h = snap_resize_height(max_height.max(1), image.height().max(1), 4, 4) as f32;
    let scale = (max_w / image.width().max(1) as f32).min(target_h / image.height().max(1) as f32);
    let w = (image.width() as f32 * scale).round().max(1.0).min(max_w) as u32;
    let h = (image.height() as f32 * scale).round().max(1.0) as u32;
    resize_rgba_premultiplied(image, w, h)
}

/// Resize an RGBA image with alpha premultiplication, so transparent edges of emotes/badges do
/// not bleed dark/colored fringes during interpolation (the usual cause of "artifacts" on
/// scaled transparent emotes, animated ones especially).
pub(crate) fn resize_rgba_premultiplied(image: &DynamicImage, w: u32, h: u32) -> RgbaImage {
    let mut src = image.to_rgba8();
    for px in src.pixels_mut() {
        let a = px[3] as u32;
        px[0] = ((px[0] as u32 * a + 127) / 255) as u8;
        px[1] = ((px[1] as u32 * a + 127) / 255) as u8;
        px[2] = ((px[2] as u32 * a + 127) / 255) as u8;
    }
    // Triangle (bilinear): no ringing/overshoot on the alpha channel. Lanczos3 overshoots at
    // hard edges, leaving a halo ("бахрома") around transparent emotes that premultiply alone
    // cannot fix.
    let mut out = imageops::resize(&src, w.max(1), h.max(1), imageops::FilterType::Triangle);
    for px in out.pixels_mut() {
        let a = px[3] as u32;
        if a == 0 {
            px[0] = 0;
            px[1] = 0;
            px[2] = 0;
        } else {
            px[0] = ((px[0] as u32 * 255 + a / 2) / a).min(255) as u8;
            px[1] = ((px[1] as u32 * 255 + a / 2) / a).min(255) as u8;
            px[2] = ((px[2] as u32 * 255 + a / 2) / a).min(255) as u8;
        }
    }
    out
}

fn snap_resize_height(
    desired_height: i32,
    source_height: u32,
    up_snap_threshold: i32,
    down_snap_threshold: i32,
) -> i32 {
    let source_height = source_height.max(1) as i32;
    if up_snap_threshold == down_snap_threshold && up_snap_threshold != 0 {
        let remainder = (desired_height + up_snap_threshold) % source_height;
        if remainder <= up_snap_threshold * 2 {
            return desired_height + up_snap_threshold - remainder;
        }
    } else {
        if down_snap_threshold != 0 {
            let remainder = desired_height % source_height;
            if remainder <= down_snap_threshold {
                return desired_height - remainder;
            }
        }
        if up_snap_threshold != 0 {
            let remainder = source_height - (desired_height % source_height);
            if remainder <= up_snap_threshold {
                return desired_height + remainder;
            }
        }
    }
    desired_height
}

#[cfg(test)]
mod tests {
    use super::{cache_path, seven_tv_proxy_url, snap_resize_height};
    use std::path::Path;

    #[test]
    fn cache_path_is_stable_for_same_asset() {
        let root = Path::new("cache-root");
        let first = cache_path(root, "7tv", "abc", "https://cdn.7tv.app/emote/abc/2x.webp");
        let second = cache_path(root, "7tv", "abc", "https://cdn.7tv.app/emote/abc/2x.webp");
        assert_eq!(first, second);
    }

    #[test]
    fn cache_path_never_leaves_the_root() {
        let root = Path::new("cache-root");
        let path = cache_path(root, "/abs/evil", "../../x", "https://e/a/b");
        assert!(path.starts_with(root.join("other")));
        assert!(path.file_name().unwrap().to_string_lossy().starts_with("asset-"));
    }

    #[test]
    fn seven_tv_proxy_replaces_only_cdn_host() {
        assert_eq!(
            seven_tv_proxy_url("https://cdn.7tv.app/emote/abc/2x.webp"),
            "https://7tv-imageproxy.twitcharchives.workers.dev/emote/abc/2x.webp"
        );
    }

    #[test]
    fn snap_resize_prefers_near_integer_height() {
        assert_eq!(snap_resize_height(38, 36, 4, 4), 36);
        assert_eq!(snap_resize_height(70, 36, 4, 4), 72);
    }
}
