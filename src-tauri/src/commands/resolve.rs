use std::cmp::Ordering;
use std::collections::HashMap;
use std::path::Path;
use std::process::Stdio;

use base64::Engine;
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use serde_json::json;
use tokio::process::Command;

use crate::binaries::{configure_ytdlp_env, resolve_binary, FFPROBE, YTDLP};
use crate::jobs::types::VideoCodecPolicy;
use crate::proxy::ProxyConfig;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Apply OS-specific tweaks to hide console windows spawned by child processes on Windows.
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

const YOUTUBE_COOKIE_BROWSERS: &[&str] =
    &["edge", "chrome", "firefox", "brave", "vivaldi", "opera"];

pub fn is_youtube_url(url: &str) -> bool {
    let lower = url.to_ascii_lowercase();
    lower.contains("youtube.com") || lower.contains("youtu.be")
}

/// Browsers worth a cookie retry: the ones with a profile on this machine.
/// Trying all six cost a yt-dlp start each and buried the useful reason
/// ("Brave is open") under "could not find opera cookies database".
pub fn youtube_cookie_retry_browsers() -> Vec<&'static str> {
    YOUTUBE_COOKIE_BROWSERS
        .iter()
        .copied()
        .filter(|browser| browser_profile_present(browser))
        .collect()
}

#[cfg(windows)]
fn browser_profile_present(browser: &str) -> bool {
    let local = dirs::data_local_dir();
    let roaming = dirs::data_dir();
    let profile = match browser {
        "edge" => local.map(|d| d.join(r"Microsoft\Edge\User Data")),
        "chrome" => local.map(|d| d.join(r"Google\Chrome\User Data")),
        "brave" => local.map(|d| d.join(r"BraveSoftware\Brave-Browser\User Data")),
        "vivaldi" => local.map(|d| d.join(r"Vivaldi\User Data")),
        "opera" => roaming.map(|d| d.join(r"Opera Software\Opera Stable")),
        "firefox" => roaming.map(|d| d.join(r"Mozilla\Firefox\Profiles")),
        _ => None,
    };
    profile.is_some_and(|dir| dir.is_dir())
}

#[cfg(not(windows))]
fn browser_profile_present(_browser: &str) -> bool {
    true
}

/// Why one browser's cookies did not get a YouTube download through.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CookieBrowserFailure {
    /// Chromium holds the cookie database open while the browser runs.
    Locked,
    /// Chromium app-bound encryption: yt-dlp cannot decrypt the cookies.
    Encrypted,
    /// Cookies were read, YouTube still asked to sign in.
    NotSignedIn,
    Other,
}

pub fn classify_cookie_browser_failure(text: &str) -> CookieBrowserFailure {
    let lower = text.to_ascii_lowercase();
    if lower.contains("could not copy") || lower.contains("database is locked") {
        CookieBrowserFailure::Locked
    } else if lower.contains("decrypt") || lower.contains("app-bound") || lower.contains("dpapi") {
        CookieBrowserFailure::Encrypted
    } else if youtube_cookie_auth_error(text) {
        CookieBrowserFailure::NotSignedIn
    } else {
        CookieBrowserFailure::Other
    }
}

/// yt-dlp failing to read a browser's cookie store (not a YouTube answer).
pub fn cookie_store_error(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    lower.contains("cookie database")
        || lower.contains("cookies database")
        || lower.contains("failed to decrypt")
        || lower.contains("app-bound")
}

/// The user-facing reason after every browser's cookies failed.
pub fn youtube_cookie_failure_message(tried: &[(&str, CookieBrowserFailure)]) -> String {
    let named = |kind: CookieBrowserFailure| {
        tried
            .iter()
            .filter(|(_, failure)| *failure == kind)
            .map(|(browser, _)| browser_label(browser))
            .collect::<Vec<_>>()
            .join(", ")
    };
    let mut hints = Vec::new();
    let locked = named(CookieBrowserFailure::Locked);
    if !locked.is_empty() {
        hints.push(format!("закройте {locked} полностью (браузер держит базу cookies) и повторите"));
    }
    let not_signed_in = named(CookieBrowserFailure::NotSignedIn);
    if !not_signed_in.is_empty() {
        hints.push(format!("в {not_signed_in} нет входа в YouTube"));
    }
    let encrypted = named(CookieBrowserFailure::Encrypted);
    if !encrypted.is_empty() {
        hints.push(format!("cookies {encrypted} зашифрованы и недоступны"));
    }
    if tried.is_empty() {
        hints.push("на компьютере не найден браузер с cookies".to_string());
    }
    hints.push("или смените VPN-сервер: YouTube чаще просит вход с общих IP".to_string());
    format!("YouTube требует подтвердить, что вы не бот. {}.", capitalize(&hints.join("; ")))
}

fn browser_label(browser: &str) -> &'static str {
    match browser {
        "edge" => "Edge",
        "chrome" => "Chrome",
        "firefox" => "Firefox",
        "brave" => "Brave",
        "vivaldi" => "Vivaldi",
        "opera" => "Opera",
        _ => "браузер",
    }
}

fn capitalize(text: &str) -> String {
    let mut chars = text.chars();
    chars
        .next()
        .map(|first| first.to_uppercase().chain(chars).collect())
        .unwrap_or_default()
}

pub fn apply_youtube_cookie_browser(cmd: &mut Command, browser: &str) {
    cmd.args(["--cookies-from-browser", browser]);
}

/// Errors browser cookies cannot fix. Retrying them with every browser's
/// cookies only multiplied the wait (a yt-dlp start plus an extraction per
/// browser) before the user saw "channel is offline".
pub fn cookies_cannot_help(stderr: &str) -> bool {
    let lower = stderr.to_ascii_lowercase();
    [
        "not currently live",
        "is offline",
        "does not exist",
        "http error 404",
        "unsupported url",
        "getaddrinfo failed",
        "timed out",
        "connection refused",
    ]
    .iter()
    .any(|needle| lower.contains(needle))
}

pub fn youtube_cookie_auth_error(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    lower.contains("sign in to confirm")
        || lower.contains("not a bot")
        || lower.contains("--cookies-from-browser")
        || lower.contains("--cookies for the authentication")
        || (lower.contains("youtube") && lower.contains("cookies"))
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Quality {
    pub id: String,
    pub label: String,
    #[serde(default)]
    pub group: Option<String>,
    pub height: Option<u32>,
    pub fps: Option<f32>,
    pub ext: Option<String>,
    pub has_audio: bool,
    pub has_video: bool,
    pub abr: Option<f32>,
    /// Normalized codec family (`h264`, `vp9`, `av1`, …), not the raw yt-dlp
    /// string — the UI shows it and the format picker ranks by it.
    #[serde(default)]
    pub vcodec: Option<String>,
    #[serde(default)]
    pub acodec: Option<String>,
    /// Exact size when yt-dlp reports one, otherwise `filesize_approx`.
    #[serde(default)]
    pub filesize: Option<u64>,
    #[serde(default)]
    pub tbr: Option<f32>,
    /// H.264 video with AAC (or no) audio — imports into Premiere Pro as-is.
    #[serde(default)]
    pub compatible: bool,
}

/// Collapse a yt-dlp codec string (`avc1.640028`, `vp09.00.40.08`, `mp4a.40.2`)
/// down to a family name. Returns `None` for `none`/empty.
pub fn codec_family(raw: &str) -> Option<&'static str> {
    let value = raw.trim().to_ascii_lowercase();
    if value.is_empty() || value == "none" {
        return None;
    }
    let family = if value.starts_with("avc") || value.starts_with("h264") {
        "h264"
    } else if value.starts_with("hev") || value.starts_with("hvc") || value.starts_with("h265") {
        "h265"
    } else if value.starts_with("vp9") || value.starts_with("vp09") {
        "vp9"
    } else if value.starts_with("vp8") || value.starts_with("vp08") {
        "vp8"
    } else if value.starts_with("av01") || value.starts_with("av1") {
        "av1"
    } else if value.starts_with("mp4a") || value.starts_with("aac") {
        "aac"
    } else if value.starts_with("opus") {
        "opus"
    } else if value.starts_with("mp3") || value.starts_with("mp4a.69") {
        "mp3"
    } else if value.starts_with("vorbis") {
        "vorbis"
    } else if value.starts_with("ec-3") || value.starts_with("ac-3") {
        "ac3"
    } else {
        "other"
    };
    Some(family)
}

/// True when this pair of codec families needs no re-encode to land in an
/// editor-friendly MP4.
fn codecs_are_compatible(vcodec: Option<&str>, acodec: Option<&str>) -> bool {
    matches!(vcodec, Some("h264")) && matches!(acodec, None | Some("aac"))
}

/// Split an HLS `CODECS="avc1.4d401f,mp4a.40.2"` attribute into
/// `(video family, audio family)`.
fn split_hls_codecs(codecs: Option<&str>) -> (Option<&'static str>, Option<&'static str>) {
    let mut video = None;
    let mut audio = None;
    for part in codecs.unwrap_or("").split(',') {
        match codec_family(part) {
            Some(family @ ("h264" | "h265" | "vp9" | "vp8" | "av1")) => {
                video = video.or(Some(family))
            }
            Some(family @ ("aac" | "opus" | "mp3" | "vorbis" | "ac3")) => {
                audio = audio.or(Some(family))
            }
            _ => {}
        }
    }
    (video, audio)
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ResolvedStream {
    pub platform: String,
    pub title: Option<String>,
    pub uploader: Option<String>,
    pub is_live: bool,
    pub duration: Option<f64>,
    pub qualities: Vec<Quality>,
    pub direct_url: Option<String>,
    pub thumbnail: Option<String>,
}

/// Detect platform from URL heuristics.
pub fn detect_platform(url: &str) -> String {
    let u = url.to_lowercase();
    if crate::wtv::is_wtv_url(url) {
        return "wtv".to_string();
    }
    if u.contains("twitch.tv") {
        "twitch"
    } else if u.contains("youtube.com") || u.contains("youtu.be") {
        "youtube"
    } else if u.contains("kick.com") {
        "kick"
    } else if u.contains("vkvideo.ru") || u.contains("vk.com") || u.contains("vkplay") {
        "vk"
    } else if u.contains(".m3u8") {
        "hls"
    } else {
        "unknown"
    }
    .to_string()
}

/// Rank a video-only format inside its `(height, fps)` bucket. Higher wins.
/// Under `Compatible` an H.264 rendition beats a fatter VP9/AV1 one, because
/// the alternative is a full re-encode after the download.
fn video_rank(q: &Quality, policy: VideoCodecPolicy) -> (u8, u32) {
    let bitrate = q.tbr.unwrap_or(0.0).max(0.0).round() as u32;
    let codec_score = match (policy, q.vcodec.as_deref()) {
        (VideoCodecPolicy::Compatible, Some("h264")) => 3,
        (VideoCodecPolicy::Compatible, Some("vp9")) => 2,
        (VideoCodecPolicy::Compatible, Some("av1")) => 1,
        _ => 0,
    };
    (codec_score, bitrate)
}

/// Rank an audio-only format. Higher wins.
fn audio_rank(q: &Quality) -> (u8, u32) {
    let bitrate = q.abr.unwrap_or(0.0).max(0.0).round() as u32;
    // AAC first: it survives a remux into MP4, Opus does not.
    let codec_score = match q.acodec.as_deref() {
        Some("aac") => 2,
        Some("opus") => 1,
        _ => 0,
    };
    (codec_score, bitrate)
}

fn quality_label(height: Option<u32>, fps: Option<f32>, fallback: &str) -> String {
    let fps = fps.unwrap_or(0.0);
    match height {
        // Only spell out the frame rate when it is not the boring default,
        // otherwise every single row would end in "p30".
        Some(h) if fps > 31.0 => format!("{h}p{}", fps.round() as u32),
        Some(h) => format!("{h}p"),
        None => fallback.to_string(),
    }
}

/// Collapse yt-dlp's ~30 YouTube renditions into one row per distinct
/// `(height, fps)`, so the picker stops offering the same 1080p60 three times
/// over in mp4/webm/av01 flavours.
///
/// Labels carry no container or codec text — the frontend composes those from
/// the structured fields, and duplicating them here is what produced the
/// "360p mp4 · mp4" rows.
fn normalize_youtube_qualities(raw: Vec<Quality>, policy: VideoCodecPolicy) -> Vec<Quality> {
    let best_audio = raw
        .iter()
        .filter(|q| !q.has_video && q.has_audio)
        .max_by_key(|q| audio_rank(q));
    let merged_audio_size = best_audio.and_then(|q| q.filesize).unwrap_or(0);
    let merged_audio_codec = best_audio.and_then(|q| q.acodec.clone());

    // One bucket per (height, rounded fps). The container is deliberately NOT
    // part of the key — it was, which let avc1-mp4 and av01-mp4 collide while
    // vp9-webm survived as a separate row.
    let mut buckets: HashMap<(u32, u32), Quality> = HashMap::new();
    for q in raw.iter().filter(|q| q.has_video && !q.has_audio) {
        let Some(height) = q.height else { continue };
        let key = (height, q.fps.unwrap_or(0.0).round() as u32);
        match buckets.get(&key) {
            Some(current) if video_rank(current, policy) >= video_rank(q, policy) => {}
            _ => {
                buckets.insert(key, q.clone());
            }
        }
    }

    let mut video = buckets.into_values().collect::<Vec<_>>();
    video.sort_by(|a, b| {
        b.height
            .unwrap_or(0)
            .cmp(&a.height.unwrap_or(0))
            .then_with(|| {
                b.fps
                    .unwrap_or(0.0)
                    .partial_cmp(&a.fps.unwrap_or(0.0))
                    .unwrap_or(Ordering::Equal)
            })
    });

    let covered_heights = video
        .iter()
        .filter_map(|q| q.height)
        .collect::<std::collections::HashSet<_>>();

    let mut out = Vec::new();
    for mut q in video {
        q.group = Some("video".to_string());
        q.label = quality_label(q.height, q.fps, &q.id);
        // The merged file gains the audio track, so quote the combined size.
        q.filesize = q.filesize.map(|size| size + merged_audio_size);
        q.acodec = merged_audio_codec.clone();
        q.compatible = codecs_are_compatible(q.vcodec.as_deref(), q.acodec.as_deref());
        out.push(q);
    }

    // Muxed formats only add value for heights the video-only list misses.
    // On YouTube that is normally nothing (itag 18/22 duplicate 360p/720p).
    let mut combined = raw
        .iter()
        .filter(|q| q.has_video && q.has_audio)
        .filter(|q| {
            q.height
                .map(|h| !covered_heights.contains(&h))
                .unwrap_or(false)
        })
        .cloned()
        .collect::<Vec<_>>();
    combined.sort_by(|a, b| b.height.unwrap_or(0).cmp(&a.height.unwrap_or(0)));
    for mut q in combined {
        q.group = Some("combined".to_string());
        q.label = quality_label(q.height, q.fps, &q.id);
        out.push(q);
    }

    // One row per audio codec family instead of six near-identical bitrates.
    let mut audio_by_family: HashMap<String, Quality> = HashMap::new();
    for q in raw.into_iter().filter(|q| !q.has_video && q.has_audio) {
        let family = q.acodec.clone().unwrap_or_else(|| "other".to_string());
        match audio_by_family.get(&family) {
            Some(current) if audio_rank(current) >= audio_rank(&q) => {}
            _ => {
                audio_by_family.insert(family, q);
            }
        }
    }
    let mut audio = audio_by_family.into_values().collect::<Vec<_>>();
    audio.sort_by(|a, b| audio_rank(b).cmp(&audio_rank(a)));
    for mut q in audio {
        q.group = Some("audio".to_string());
        q.label = match q.abr {
            Some(rate) if rate > 0.0 => format!("{} kbps", rate.round() as u32),
            _ => q.label.clone(),
        };
        out.push(q);
    }

    out
}

async fn resolve_twitch_qualities(
    input_url: &str,
    is_live: bool,
    proxy: Option<&ProxyConfig>,
    twitch_auth_token: Option<&str>,
) -> Result<Vec<Quality>, String> {
    let Some(target) = twitch_target(input_url, is_live) else {
        return Ok(Vec::new());
    };
    // A dead or credential-less proxy (ProxyAuthRequired) used to end the
    // resolve here, and the yt-dlp fallback only ever sees the 1080p ladder.
    // Try every route before giving up; the token and the usher request must
    // share one route, since the token is bound to the requesting IP.
    let mut last_error = String::new();
    for route in twitch_proxy_routes(proxy) {
        match resolve_twitch_qualities_via(&target, route.as_deref(), twitch_auth_token).await {
            Ok(qualities) => return Ok(qualities),
            Err(TwitchResolveError::Network(err)) => {
                // Expected on blocked/slow routes; only the final failure is worth a report.
                tracing::info!(
                    "Twitch resolve via {} failed, trying next route: {err}",
                    route.as_deref().map(redact_proxy).unwrap_or_else(|| "direct".to_string())
                );
                last_error = err;
            }
            Err(TwitchResolveError::Other(err)) => return Err(err),
        }
    }
    Err(last_error)
}

enum TwitchResolveError {
    /// The route itself failed (proxy refused, timeout); another route may work.
    Network(String),
    Other(String),
}

impl From<String> for TwitchResolveError {
    fn from(err: String) -> Self {
        Self::Other(err)
    }
}

fn redact_proxy(url: &str) -> String {
    match url::Url::parse(url) {
        Ok(parsed) => format!(
            "{}://{}:{}",
            parsed.scheme(),
            parsed.host_str().unwrap_or("?"),
            parsed.port_or_known_default().unwrap_or(0)
        ),
        Err(_) => "proxy".to_string(),
    }
}

/// Resolver proxy, then the user's (or system) proxy, then a direct connection.
fn twitch_proxy_routes(proxy: Option<&ProxyConfig>) -> Vec<Option<String>> {
    let preferred = [
        twitch_resolver_proxy(),
        match proxy {
            Some(proxy) => proxy.effective(),
            None => crate::proxy::system_proxy(),
        },
    ];
    let mut routes: Vec<Option<String>> = Vec::new();
    for route in preferred.into_iter().flatten() {
        if !routes.iter().any(|known| known.as_deref() == Some(route.as_str())) {
            routes.push(Some(route));
        }
    }
    routes.push(None);
    routes
}

async fn resolve_twitch_qualities_via(
    target: &TwitchTarget,
    route: Option<&str>,
    twitch_auth_token: Option<&str>,
) -> Result<Vec<Quality>, TwitchResolveError> {
    let client = twitch_http_client(route).map_err(TwitchResolveError::Other)?;
    let token = fetch_twitch_playback_token(target, &client, twitch_auth_token).await?;
    let master_url = match &target {
        TwitchTarget::Vod(id) => {
            let mut url = url::Url::parse(&format!("https://usher.ttvnw.net/vod/{id}.m3u8"))
                .map_err(|e| e.to_string())?;
            url.query_pairs_mut()
                .append_pair("allow_source", "true")
                .append_pair("allow_audio_only", "true")
                .append_pair("include_unavailable", "true")
                .append_pair("platform", "web")
                .append_pair("player_backend", "mediaplayer")
                .append_pair("playlist_include_framerate", "true")
                .append_pair("supported_codecs", "av1,h265,h264")
                .append_pair("sig", &token.signature)
                .append_pair("token", &token.value);
            url.to_string()
        }
        TwitchTarget::Live(login) => {
            let mut url = url::Url::parse(&format!(
                "https://usher.ttvnw.net/api/channel/hls/{login}.m3u8"
            ))
            .map_err(|e| e.to_string())?;
            url.query_pairs_mut()
                .append_pair("allow_source", "true")
                .append_pair("allow_audio_only", "true")
                .append_pair("supported_codecs", "av1,h265,h264")
                .append_pair("fast_bread", "true")
                .append_pair("sig", &token.signature)
                .append_pair("token", &token.value);
            url.to_string()
        }
    };
    let response = client
        .get(&master_url)
        .header("Referer", "https://www.twitch.tv/")
        .send()
        .await
        .map_err(|e| TwitchResolveError::Network(format!("Twitch usher request failed: {e:?}")))?;
    let status = response.status();
    if status == reqwest::StatusCode::FORBIDDEN {
        if let TwitchTarget::Vod(id) = target {
            let qualities = resolve_restricted_twitch_vod(&client, id, twitch_auth_token).await?;
            if !qualities.is_empty() {
                return Ok(qualities);
            }
        }
        // A 403 can be bound to the route's IP (geo / flagged exit), so let the
        // caller try the next route instead of giving up.
        return Err(TwitchResolveError::Network(format!("Twitch usher returned HTTP {status}")));
    }
    if !status.is_success() {
        return Err(TwitchResolveError::Other(format!("Twitch usher returned HTTP {status}")));
    }
    let text = response
        .text()
        .await
        .map_err(|e| TwitchResolveError::Network(format!("Twitch usher body failed: {e}")))?;
    // Diagnostic: dump the raw master playlist so we can see exactly which
    // renditions Twitch returned (does it include the 1440p "chunked" source?).
    // Debug only: it carries the viewer's IP, country and session ids.
    tracing::debug!(
        "Twitch usher master playlist ({} chars):\n{}",
        text.len(),
        text
    );
    Ok(parse_twitch_master_playlist(&text, &master_url))
}

pub async fn resolve_twitch_hls_url(
    input_url: &str,
    quality: Option<&str>,
    is_live: bool,
    proxy: &ProxyConfig,
    twitch_auth_token: Option<&str>,
) -> Result<Option<String>, String> {
    if let Some(q) = quality.filter(|q| !q.is_empty() && *q != "best") {
        if q.to_lowercase().contains(".m3u8") {
            return Ok(Some(q.to_string()));
        }
    }
    let qualities =
        resolve_twitch_qualities(input_url, is_live, Some(proxy), twitch_auth_token).await?;
    if let Some(requested) = quality.filter(|q| !q.is_empty() && *q != "best") {
        if let Some(matched) = select_requested_twitch_quality(&qualities, requested) {
            return Ok(Some(matched.id.clone()));
        }
    }
    Ok(qualities.first().map(|q| q.id.clone()))
}

enum TwitchTarget {
    Vod(String),
    Live(String),
}

struct TwitchPlaybackToken {
    signature: String,
    value: String,
}

fn twitch_target(input_url: &str, is_live: bool) -> Option<TwitchTarget> {
    let lower = input_url.to_lowercase();
    for prefix in ["twitch.tv/videos/", "twitch.tv/video/", "twitch.tv/v/"] {
        if let Some(id) = lower
            .split(prefix)
            .nth(1)
            .and_then(|tail| tail.split(['?', '/', '&', '#']).next())
            .filter(|id| !id.is_empty() && id.chars().all(|ch| ch.is_ascii_digit()))
        {
            return Some(TwitchTarget::Vod(id.to_string()));
        }
    }
    if !is_live {
        return None;
    }
    let parsed = url::Url::parse(input_url).ok()?;
    let host = parsed.host_str()?.trim_start_matches("www.");
    if host != "twitch.tv" {
        return None;
    }
    let login = parsed
        .path_segments()?
        .next()
        .filter(|value| !value.is_empty() && *value != "videos" && *value != "directory")?;
    Some(TwitchTarget::Live(login.to_lowercase()))
}

/// Stable per-process Twitch Device-ID. A real logged-in web client always
/// sends one; without it Twitch may withhold the full quality ladder (source /
/// 1440p) even with a valid OAuth token.
fn twitch_device_id() -> &'static str {
    static ID: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    ID.get_or_init(|| uuid::Uuid::new_v4().simple().to_string())
}

async fn fetch_twitch_playback_token(
    target: &TwitchTarget,
    client: &reqwest::Client,
    twitch_auth_token: Option<&str>,
) -> Result<TwitchPlaybackToken, TwitchResolveError> {
    let (variables, token_key) = match target {
        TwitchTarget::Vod(id) => (
            json!({
                "login": "",
                "isLive": false,
                "vodID": id,
                "isVod": true,
                "playerType": "site",
                "platform": "web"
            }),
            "videoPlaybackAccessToken",
        ),
        TwitchTarget::Live(login) => (
            json!({
                "login": login,
                "isLive": true,
                "vodID": "",
                "isVod": false,
                "playerType": "site",
                "platform": "web"
            }),
            "streamPlaybackAccessToken",
        ),
    };
    let persisted = json!({
        "operationName": "PlaybackAccessToken",
        "extensions": {
            "persistedQuery": {
                "version": 1,
                "sha256Hash": "ed230aa1e33e07eebb8928504583da78a5173989fadfb1ac94be06a04f3cdbe9"
            }
        },
        "variables": variables
    });
    let value = post_twitch_gql(client, &persisted, twitch_auth_token).await?;
    let data = match playback_token_data(&value, token_key) {
        Some(data) => data.clone(),
        None => {
            // Twitch rotates persisted-query hashes (PersistedQueryNotFound);
            // the plain query keeps working, as in TwitchDownloader.
            tracing::info!("Twitch persisted PlaybackAccessToken failed, retrying plain query");
            let value =
                post_twitch_gql(client, &raw_playback_token_payload(target), twitch_auth_token)
                    .await?;
            playback_token_data(&value, token_key).cloned().ok_or_else(|| {
                TwitchResolveError::Other("Twitch playback token missing".to_string())
            })?
        }
    };
    Ok(TwitchPlaybackToken {
        signature: data
            .get("signature")
            .and_then(|value| value.as_str())
            .unwrap_or_default()
            .to_string(),
        value: data
            .get("value")
            .and_then(|value| value.as_str())
            .unwrap_or_default()
            .to_string(),
    })
}

fn playback_token_data<'a>(
    value: &'a serde_json::Value,
    token_key: &str,
) -> Option<&'a serde_json::Value> {
    value
        .get("data")
        .and_then(|data| data.get(token_key))
        .filter(|data| data.get("value").and_then(|v| v.as_str()).is_some_and(|v| !v.is_empty()))
}

fn raw_playback_token_payload(target: &TwitchTarget) -> serde_json::Value {
    const PARAMS: &str = r#"params:{platform:"web",playerBackend:"mediaplayer",playerType:"site"}"#;
    match target {
        TwitchTarget::Vod(id) => json!({
            "query": format!(
                "query($id:ID!){{videoPlaybackAccessToken(id:$id,{PARAMS}){{value signature}}}}"
            ),
            "variables": { "id": id }
        }),
        TwitchTarget::Live(login) => json!({
            "query": format!(
                "query($login:String!){{streamPlaybackAccessToken(channelName:$login,{PARAMS}){{value signature}}}}"
            ),
            "variables": { "login": login }
        }),
    }
}

async fn post_twitch_gql(
    client: &reqwest::Client,
    payload: &serde_json::Value,
    twitch_auth_token: Option<&str>,
) -> Result<serde_json::Value, TwitchResolveError> {
    let build_request = || {
        let req = client
            .post("https://gql.twitch.tv/gql")
            .header("Client-ID", "kimne78kx3ncx6brgo4mv6wki5h1ko")
            .header("Content-Type", "application/json")
            .header("Device-ID", twitch_device_id())
            .header("X-Device-Id", twitch_device_id())
            .json(payload);
        match twitch_auth_token.map(str::trim).filter(|t| !t.is_empty()) {
            Some(token) => req.header("Authorization", format!("OAuth {token}")),
            None => req,
        }
    };
    let (status, body) = crate::util::fetch_text_with_retry(build_request)
        .await
        .map_err(|e| TwitchResolveError::Network(format!("Twitch GQL request failed: {e:?}")))?;
    if !status.is_success() {
        return Err(TwitchResolveError::Other(format!("Twitch GQL returned HTTP {status}")));
    }
    serde_json::from_str(&body)
        .map_err(|e| TwitchResolveError::Other(format!("Twitch GQL JSON failed: {e}")))
}

/// Usher refused the VOD (subscriber-only / restricted): address the public
/// CloudFront variant playlists through the storyboard URL instead.
async fn resolve_restricted_twitch_vod(
    client: &reqwest::Client,
    vod_id: &str,
    twitch_auth_token: Option<&str>,
) -> Result<Vec<Quality>, TwitchResolveError> {
    use super::twitch_vod_fallback::{
        fallback_variant_urls, vod_base_from_seek_previews, SEEK_PREVIEWS_QUERY,
    };
    let payload = json!({ "query": SEEK_PREVIEWS_QUERY, "variables": { "id": vod_id } });
    let value = post_twitch_gql(client, &payload, twitch_auth_token).await?;
    let video = value.get("data").and_then(|data| data.get("video"));
    let Some(base) = video
        .and_then(|video| video.get("seekPreviewsURL"))
        .and_then(|url| url.as_str())
        .and_then(vod_base_from_seek_previews)
    else {
        return Ok(Vec::new());
    };
    let broadcast_type = video
        .and_then(|video| video.get("broadcastType"))
        .and_then(|value| value.as_str());
    let candidates = fallback_variant_urls(&base, vod_id, broadcast_type);
    let probes = candidates.iter().map(|(_, url)| twitch_playlist_exists(client, url));
    let found = futures::future::join_all(probes).await;
    let qualities: Vec<Quality> = candidates
        .into_iter()
        .zip(found)
        .filter(|(_, exists)| *exists)
        .map(|((group, url), _)| fallback_quality(group, url))
        .collect();
    tracing::info!(
        "Twitch restricted VOD {vod_id}: {} variant(s) via storyboard fallback",
        qualities.len()
    );
    Ok(qualities)
}

async fn twitch_playlist_exists(client: &reqwest::Client, url: &str) -> bool {
    // Ranged GET: some CloudFront distributions reject HEAD for valid objects.
    client
        .get(url)
        .header("Range", "bytes=0-0")
        .header("Referer", "https://www.twitch.tv/")
        .send()
        .await
        .is_ok_and(|resp| resp.status().is_success())
}

fn fallback_quality(group: &str, url: String) -> Quality {
    let height = parse_height_from_group(group);
    let fps = parse_fps_from_group(group);
    Quality {
        id: url,
        label: twitch_quality_label(group, height, fps, 0),
        group: Some("combined".to_string()),
        height,
        fps,
        ext: Some("m3u8".to_string()),
        has_audio: true,
        has_video: true,
        // Codec is unknown without the master playlist; `chunked` may be HEVC.
        ..Quality::default()
    }
}

/// Optional dedicated proxy on a clean, Twitch-unflagged IP, used ONLY for the
/// Twitch gql token + usher master-playlist requests (baked in at build time via
/// FETCHR_TWITCH_RESOLVER). Twitch gates quality (1440p source) by the requesting
/// IP at the master-playlist step, so this small (KB) request must exit from a
/// clean IP. Segment downloads keep using the user's proxy — they are not
/// quality-gated.
fn twitch_resolver_proxy() -> Option<String> {
    option_env!("FETCHR_TWITCH_RESOLVER")
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| {
            if s.contains("://") {
                s.to_string()
            } else {
                // Bare "host:port" or "user:pass@host:port" → default to http.
                format!("http://{s}")
            }
        })
}

fn twitch_http_client(route: Option<&str>) -> Result<reqwest::Client, String> {
    let mut builder = reqwest::Client::builder()
        .user_agent(
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 \
             (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        )
        .timeout(std::time::Duration::from_secs(20));
    // `None` must really mean direct: reqwest would otherwise pick up the
    // *_PROXY variables on its own and the "direct" route would be the proxy.
    builder = match route {
        Some(proxy_url) => {
            builder.proxy(reqwest::Proxy::all(proxy_url).map_err(|e| e.to_string())?)
        }
        None => builder.no_proxy(),
    };
    builder.build().map_err(|e| e.to_string())
}

/// W.TV has no yt-dlp extractor: its API names the HLS playlist, and the master
/// playlist (Amazon IVS, same layout as Twitch) lists the qualities.
async fn resolve_wtv_stream(url: &str) -> Result<ResolvedStream, String> {
    let resolved = crate::wtv::resolve(url).await.map_err(|err| format!("{err:#}"))?;
    let qualities = match crate::wtv::client().get(&resolved.playback_url).send().await {
        Ok(response) => match response.text().await {
            Ok(text) => parse_twitch_master_playlist(&text, &resolved.playback_url),
            Err(_) => Vec::new(),
        },
        Err(_) => Vec::new(),
    };
    let stream = resolved.stream.as_ref();
    Ok(ResolvedStream {
        platform: "wtv".to_string(),
        title: stream.map(|stream| stream.title.clone()).filter(|title| !title.is_empty()),
        uploader: resolved
            .channel
            .as_ref()
            .map(|channel| channel.nickname.clone())
            .or_else(|| stream.and_then(|stream| stream.channel.as_ref()?.name.clone())),
        is_live: stream.is_some_and(|stream| stream.is_live()),
        duration: stream.and_then(|stream| stream.duration_sec()),
        direct_url: qualities
            .first()
            .map(|quality| quality.id.clone())
            .or(Some(resolved.playback_url.clone())),
        qualities,
        thumbnail: stream.and_then(|stream| stream.thumbnail_url.clone()),
    })
}

fn parse_twitch_master_playlist(text: &str, master_url: &str) -> Vec<Quality> {
    let base = url::Url::parse(master_url).ok();
    let mut out = Vec::new();
    let mut pending_stream: Option<HashMap<String, String>> = None;
    let mut unavailable_media = Vec::new();
    for line in text.lines().map(str::trim) {
        if let Some(data) = line.strip_prefix("#EXT-X-SESSION-DATA:") {
            let attrs = parse_hls_attrs(data);
            if attrs.get("DATA-ID").map(String::as_str) == Some("com.amazon.ivs.unavailable-media")
            {
                if let Some(value) = attrs.get("VALUE") {
                    unavailable_media.extend(parse_twitch_unavailable_media(value));
                }
            }
            continue;
        }
        if let Some(data) = line.strip_prefix("#EXT-X-STREAM-INF:") {
            pending_stream = Some(parse_hls_attrs(data));
            continue;
        }
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some(attrs) = pending_stream.take() else {
            continue;
        };
        let absolute = base
            .as_ref()
            .and_then(|base| base.join(line).ok())
            .map(|url| url.to_string())
            .unwrap_or_else(|| line.to_string());
        let group = attrs
            .get("VIDEO")
            .or_else(|| attrs.get("NAME"))
            .cloned()
            .unwrap_or_else(|| variant_group_from_url(&absolute));
        if group == "audio_only" {
            continue;
        }
        let (width, height) = attrs
            .get("RESOLUTION")
            .and_then(|value| value.split_once('x'))
            .and_then(|(w, h)| Some((w.parse::<u32>().ok()?, h.parse::<u32>().ok()?)))
            .unwrap_or((0, 0));
        let fps = attrs
            .get("FRAME-RATE")
            .and_then(|value| value.parse::<f32>().ok())
            .or_else(|| parse_fps_from_group(&group));
        let height = if height > 0 {
            Some(height)
        } else {
            parse_height_from_group(&group)
        };
        let label = twitch_quality_label(&group, height, fps, width);
        let (vcodec, acodec) = split_hls_codecs(attrs.get("CODECS").map(String::as_str));
        out.push(Quality {
            id: absolute,
            label,
            group: Some("combined".to_string()),
            height,
            fps,
            ext: Some("m3u8".to_string()),
            has_audio: true,
            has_video: true,
            vcodec: vcodec.map(str::to_string),
            acodec: acodec.map(str::to_string),
            compatible: codecs_are_compatible(vcodec, acodec),
            ..Quality::default()
        });
    }
    append_twitch_unavailable_qualities(&mut out, unavailable_media);
    out.sort_by(|a, b| twitch_quality_rank(b).cmp(&twitch_quality_rank(a)));
    out
}

#[derive(Debug, Deserialize)]
struct TwitchUnavailableMedia {
    #[serde(rename = "NAME")]
    name: Option<String>,
    #[serde(rename = "RESOLUTION")]
    resolution: Option<String>,
    #[serde(rename = "GROUP-ID")]
    group_id: Option<String>,
    #[serde(rename = "FRAME-RATE")]
    frame_rate: Option<f32>,
    #[serde(rename = "BANDWIDTH")]
    bandwidth: Option<u64>,
    #[serde(rename = "CODECS")]
    codecs: Option<String>,
}

fn parse_twitch_unavailable_media(encoded: &str) -> Vec<TwitchUnavailableMedia> {
    let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(encoded) else {
        return Vec::new();
    };
    serde_json::from_slice::<Vec<TwitchUnavailableMedia>>(&bytes).unwrap_or_default()
}

fn append_twitch_unavailable_qualities(
    qualities: &mut Vec<Quality>,
    unavailable: Vec<TwitchUnavailableMedia>,
) {
    let Some(path_template) = qualities
        .first()
        .and_then(|q| twitch_variant_path_template(&q.id))
    else {
        return;
    };

    for media in unavailable {
        let Some(group_id) = media.group_id.as_deref().filter(|value| !value.is_empty()) else {
            continue;
        };
        let (width, height) = media
            .resolution
            .as_deref()
            .and_then(|value| value.split_once('x'))
            .and_then(|(w, h)| Some((w.parse::<u32>().ok()?, h.parse::<u32>().ok()?)))
            .unwrap_or((0, 0));
        let Some(height) = (height > 0).then_some(height) else {
            continue;
        };
        let url = path_template
            .replace("{variant}", group_id)
            .replace("%7Bvariant%7D", group_id);
        let label = media
            .name
            .as_deref()
            .filter(|name| !name.trim().is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| {
                twitch_quality_label(group_id, Some(height), media.frame_rate, width)
            });
        let label = if is_source_group_id(group_id) {
            format!("{label} Source")
        } else {
            label
        };
        let has_audio = media
            .codecs
            .as_deref()
            .map(|codecs| codecs.contains("mp4a"))
            .unwrap_or(true);
        let abr = media.bandwidth.map(|bandwidth| bandwidth as f32 / 1000.0);
        let (vcodec, acodec) = split_hls_codecs(media.codecs.as_deref());

        if let Some(existing) = qualities.iter_mut().find(|q| q.id == url) {
            if existing.height.unwrap_or(0) < height {
                existing.label = label;
                existing.group = Some("combined".to_string());
                existing.height = Some(height);
                existing.fps = media.frame_rate;
                existing.ext = Some("m3u8".to_string());
                existing.has_audio = has_audio;
                existing.has_video = true;
                existing.abr = abr;
                existing.vcodec = vcodec.map(str::to_string);
                existing.acodec = acodec.map(str::to_string);
                existing.compatible = codecs_are_compatible(vcodec, acodec);
            }
            continue;
        }

        qualities.push(Quality {
            id: url,
            label,
            group: Some("combined".to_string()),
            height: Some(height),
            fps: media.frame_rate,
            ext: Some("m3u8".to_string()),
            has_audio,
            has_video: true,
            abr,
            vcodec: vcodec.map(str::to_string),
            acodec: acodec.map(str::to_string),
            compatible: codecs_are_compatible(vcodec, acodec),
            ..Quality::default()
        });
    }
}

fn twitch_variant_path_template(url: &str) -> Option<String> {
    let mut parsed = url::Url::parse(url).ok()?;
    let mut segments = parsed
        .path_segments()?
        .map(str::to_string)
        .collect::<Vec<_>>();
    if segments.len() < 2 {
        return None;
    }
    let variant_index = segments.len().saturating_sub(2);
    segments[variant_index] = "__FETCHR_TWITCH_VARIANT__".to_string();
    parsed.set_path(&segments.join("/"));
    Some(
        parsed
            .to_string()
            .replace("__FETCHR_TWITCH_VARIANT__", "{variant}"),
    )
}

fn parse_hls_attrs(input: &str) -> HashMap<String, String> {
    let mut out = HashMap::new();
    let mut key = String::new();
    let mut value = String::new();
    let mut in_key = true;
    let mut in_quote = false;
    for ch in input.chars().chain(std::iter::once(',')) {
        match ch {
            '=' if in_key => in_key = false,
            '"' => in_quote = !in_quote,
            ',' if !in_quote => {
                if !key.trim().is_empty() {
                    out.insert(
                        key.trim().to_string(),
                        value.trim().trim_matches('"').to_string(),
                    );
                }
                key.clear();
                value.clear();
                in_key = true;
            }
            _ if in_key => key.push(ch),
            _ => value.push(ch),
        }
    }
    out
}

fn variant_group_from_url(url: &str) -> String {
    url.split('/').rev().nth(1).unwrap_or_default().to_string()
}

fn parse_height_from_group(group: &str) -> Option<u32> {
    group
        .split('p')
        .next()
        .and_then(|value| value.parse::<u32>().ok())
}

fn parse_fps_from_group(group: &str) -> Option<f32> {
    group
        .split('p')
        .nth(1)
        .and_then(|value| value.parse::<f32>().ok())
}

fn twitch_quality_label(group: &str, height: Option<u32>, fps: Option<f32>, width: u32) -> String {
    if group == "chunked" {
        if let Some(height) = height {
            return match fps {
                Some(fps) if fps > 1.0 => format!("Source {height}p{}", fps.round() as u32),
                _ => format!("Source {height}p"),
            };
        }
        return "Source".to_string();
    }
    if let Some(height) = height {
        return match fps {
            Some(fps) if fps > 1.0 => format!("{height}p{}", fps.round() as u32),
            _ => format!("{height}p"),
        };
    }
    if width > 0 {
        return format!("{width}w");
    }
    group.to_string()
}

fn twitch_quality_rank(q: &Quality) -> (u8, u32, u32) {
    (
        if is_twitch_source_quality(q) { 1 } else { 0 },
        q.height.unwrap_or(0),
        q.fps.unwrap_or(0.0).round() as u32,
    )
}

fn twitch_resolution_rank(q: &Quality) -> (u32, u32, u8) {
    (
        q.height.unwrap_or(0),
        q.fps.unwrap_or(0.0).round() as u32,
        if is_twitch_source_quality(q) { 1 } else { 0 },
    )
}

fn is_twitch_source_quality(q: &Quality) -> bool {
    q.id.contains("/chunked/")
        || q.id.contains("chunked")
        || q.label.to_lowercase().contains("source")
}

fn is_source_group_id(group_id: &str) -> bool {
    group_id.eq_ignore_ascii_case("chunked") || group_id.eq_ignore_ascii_case("source")
}

fn select_requested_twitch_quality<'a>(
    qualities: &'a [Quality],
    requested: &str,
) -> Option<&'a Quality> {
    let requested_lower = requested.to_lowercase();
    if let Some(exact) = qualities
        .iter()
        .find(|q| q.id.eq_ignore_ascii_case(requested) || q.label.eq_ignore_ascii_case(requested))
    {
        return Some(exact);
    }

    let desired_height = parse_requested_height(&requested_lower)?;
    let desired_fps = parse_requested_fps(&requested_lower);
    qualities
        .iter()
        .filter(|q| q.height == Some(desired_height))
        .filter(|q| {
            desired_fps
                .map(|fps| {
                    q.fps
                        .map(|actual| (actual - fps).abs() < 1.0)
                        .unwrap_or(true)
                })
                .unwrap_or(true)
        })
        .max_by_key(|q| twitch_resolution_rank(q))
        .or_else(|| {
            if desired_height >= 1440 {
                qualities
                    .iter()
                    .filter(|q| is_twitch_source_quality(q))
                    .max_by_key(|q| twitch_quality_rank(q))
            } else {
                None
            }
        })
        .or_else(|| {
            qualities
                .iter()
                .filter(|q| q.height.unwrap_or(0) <= desired_height)
                .max_by_key(|q| twitch_resolution_rank(q))
        })
}

fn parse_requested_height(value: &str) -> Option<u32> {
    static HEIGHT_RE: Lazy<regex::Regex> = Lazy::new(|| {
        regex::Regex::new(
            r"(?i)(?:height\s*<=\s*|height\s*=\s*|^|[^0-9])(?P<h>[1-9][0-9]{2,3})\s*p?",
        )
        .expect("height regex")
    });
    HEIGHT_RE
        .captures(value)
        .and_then(|captures| captures.name("h"))
        .and_then(|height| height.as_str().parse::<u32>().ok())
}

fn parse_requested_fps(value: &str) -> Option<f32> {
    static FPS_RE: Lazy<regex::Regex> =
        Lazy::new(|| regex::Regex::new(r"(?i)[0-9]{3,4}p(?P<fps>[0-9]{2,3})").expect("fps regex"));
    FPS_RE
        .captures(value)
        .and_then(|captures| captures.name("fps"))
        .and_then(|fps| fps.as_str().parse::<f32>().ok())
}

#[tauri::command]
pub async fn resolve_stream(
    url: String,
    proxy: Option<ProxyConfig>,
    binaries_dir: Option<String>,
    twitch_auth_token: Option<String>,
    codec_policy: Option<VideoCodecPolicy>,
) -> Result<ResolvedStream, String> {
    let codec_policy = codec_policy.unwrap_or_default();
    let bin_dir = binaries_dir.as_deref().map(Path::new);
    let platform = detect_platform(&url);

    if platform == "wtv" {
        return resolve_wtv_stream(&url).await;
    }

    // For plain m3u8 we can't ask yt-dlp — return minimal info.
    if platform == "hls" {
        return Ok(ResolvedStream {
            platform,
            title: None,
            uploader: None,
            is_live: false,
            duration: None,
            qualities: vec![],
            direct_url: Some(url),
            thumbnail: None,
        });
    }

    if platform == "twitch" && is_twitch_vod_page_url(&url) {
        match resolve_twitch_vod_via_gql(&url, proxy.as_ref(), twitch_auth_token.as_deref()).await
        {
            Ok(Some(stream)) => return Ok(stream),
            Ok(None) => tracing::info!("Twitch GQL fast path found nothing, using yt-dlp"),
            Err(err) => tracing::info!("Twitch GQL fast path failed, using yt-dlp: {err}"),
        }
    }

    let ytdlp = resolve_binary(YTDLP, bin_dir).ok_or_else(|| "yt-dlp.exe not found".to_string())?;

    let stdout = run_ytdlp_json_with_cookie_retry(
        &ytdlp,
        &url,
        &platform,
        proxy.as_ref(),
        twitch_auth_token.as_deref(),
    )
    .await?;
    let raw = String::from_utf8_lossy(&stdout);
    let mut info: serde_json::Value = serde_json::from_str(&raw).map_err(|e| e.to_string())?;

    // --no-playlist normally prevents this, but a pure playlist/channel URL has
    // no single video to unwrap: fall back to the first entry rather than
    // silently returning an empty quality list.
    if info.get("formats").is_none() {
        let first_entry = info
            .get_mut("entries")
            .and_then(|v| v.as_array_mut())
            .and_then(|entries| entries.first_mut())
            .map(serde_json::Value::take);
        match first_entry {
            Some(entry) => info = entry,
            None => {
                return Err(
                    "Ссылка не содержит видео. Укажите ссылку на конкретный ролик.".to_string(),
                )
            }
        }
    }

    let mut qualities = info
        .get("formats")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|f| {
                    let id = f.get("format_id")?.as_str()?.to_string();
                    let height = f.get("height").and_then(|v| v.as_u64()).map(|v| v as u32);
                    let fps = f.get("fps").and_then(|v| v.as_f64()).map(|v| v as f32);
                    let ext = f.get("ext").and_then(|v| v.as_str()).map(str::to_string);
                    let vcodec =
                        codec_family(f.get("vcodec").and_then(|v| v.as_str()).unwrap_or(""));
                    let acodec =
                        codec_family(f.get("acodec").and_then(|v| v.as_str()).unwrap_or(""));
                    let abr = f.get("abr").and_then(|v| v.as_f64()).map(|v| v as f32);
                    let tbr = f.get("tbr").and_then(|v| v.as_f64()).map(|v| v as f32);
                    // yt-dlp only knows the exact size for some formats; for the
                    // rest it ships an estimate, and either beats showing nothing.
                    let filesize = f
                        .get("filesize")
                        .and_then(|v| v.as_u64())
                        .or_else(|| f.get("filesize_approx").and_then(|v| v.as_u64()));
                    let has_video = vcodec.is_some();
                    let has_audio = acodec.is_some();

                    if !has_video && !has_audio {
                        return None;
                    }

                    let label = if has_video {
                        match (height, fps) {
                            (Some(h), Some(f)) if f > 1.0 => format!("{h}p{}", f.round() as u32),
                            (Some(h), _) => format!("{h}p"),
                            _ => id.clone(),
                        }
                    } else if let Some(rate) = abr {
                        format!("audio {}", rate.round() as u32)
                    } else {
                        "audio".to_string()
                    };
                    Some(Quality {
                        id,
                        label,
                        group: Some(
                            match (has_video, has_audio) {
                                (true, true) => "combined",
                                (true, false) => "video",
                                _ => "audio",
                            }
                            .to_string(),
                        ),
                        height,
                        fps,
                        ext,
                        has_audio,
                        has_video,
                        abr,
                        vcodec: vcodec.map(str::to_string),
                        acodec: acodec.map(str::to_string),
                        filesize,
                        tbr,
                        compatible: codecs_are_compatible(vcodec, acodec),
                    })
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    qualities.sort_by(|a, b| {
        let by_stream_kind = match (a.has_video, b.has_video) {
            (true, false) => Ordering::Less,
            (false, true) => Ordering::Greater,
            _ => Ordering::Equal,
        };
        if by_stream_kind != Ordering::Equal {
            return by_stream_kind;
        }

        if a.has_video && b.has_video {
            let by_height = b.height.unwrap_or(0).cmp(&a.height.unwrap_or(0));
            if by_height != Ordering::Equal {
                return by_height;
            }
            let by_audio = b.has_audio.cmp(&a.has_audio);
            if by_audio != Ordering::Equal {
                return by_audio;
            }
            return b
                .fps
                .unwrap_or(0.0)
                .partial_cmp(&a.fps.unwrap_or(0.0))
                .unwrap_or(Ordering::Equal);
        }

        b.abr
            .unwrap_or(0.0)
            .partial_cmp(&a.abr.unwrap_or(0.0))
            .unwrap_or(Ordering::Equal)
    });

    if platform == "youtube" {
        qualities = normalize_youtube_qualities(qualities, codec_policy);
    }
    let mut is_live = info
        .get("is_live")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    if platform == "twitch" && is_twitch_vod_page_url(&url) {
        is_live = false;
    }
    let mut direct_url = info.get("url").and_then(|v| v.as_str()).map(str::to_string);
    if platform == "twitch" {
        match resolve_twitch_qualities(&url, is_live, proxy.as_ref(), twitch_auth_token.as_deref())
            .await
        {
            Ok(twitch_qualities) if !twitch_qualities.is_empty() => {
                direct_url = twitch_qualities.first().map(|q| q.id.clone());
                qualities = twitch_qualities;
            }
            Ok(_) => {}
            Err(err) => {
                eprintln!("Twitch quality resolver fallback to yt-dlp formats: {err}");
            }
        }
    }

    Ok(ResolvedStream {
        platform,
        title: info
            .get("title")
            .and_then(|v| v.as_str())
            .map(str::to_string),
        uploader: info
            .get("uploader")
            .and_then(|v| v.as_str())
            .map(str::to_string),
        is_live,
        duration: info.get("duration").and_then(|v| v.as_f64()),
        qualities,
        direct_url,
        thumbnail: info
            .get("thumbnail")
            .and_then(|v| v.as_str())
            .map(str::to_string),
    })
}

/// Twitch VODs without yt-dlp: metadata and the quality ladder both come from
/// GQL/usher in parallel (~1-2 s instead of yt-dlp's ~10 s cold start), as in
/// TwitchDownloader. `None` (deleted VOD, empty ladder) lets yt-dlp try.
async fn resolve_twitch_vod_via_gql(
    url: &str,
    proxy: Option<&ProxyConfig>,
    twitch_auth_token: Option<&str>,
) -> Result<Option<ResolvedStream>, String> {
    let Some(TwitchTarget::Vod(id)) = twitch_target(url, false) else {
        return Ok(None);
    };
    let (metadata, qualities) = tokio::join!(
        fetch_twitch_vod_metadata(&id, proxy, twitch_auth_token),
        resolve_twitch_qualities(url, false, proxy, twitch_auth_token),
    );
    let Some(video) = metadata? else {
        return Ok(None);
    };
    let qualities = qualities?;
    if qualities.is_empty() {
        return Ok(None);
    }
    let text = |value: &serde_json::Value| value.as_str().map(str::to_string);
    Ok(Some(ResolvedStream {
        platform: "twitch".to_string(),
        title: video.get("title").and_then(text),
        uploader: video
            .get("owner")
            .and_then(|owner| owner.get("displayName"))
            .and_then(text),
        is_live: false,
        duration: video.get("lengthSeconds").and_then(|v| v.as_f64()),
        direct_url: qualities.first().map(|q| q.id.clone()),
        qualities,
        thumbnail: video.get("previewThumbnailURL").and_then(text),
    }))
}

const VOD_METADATA_QUERY: &str = "query($id:ID!){video(id:$id){title lengthSeconds \
     owner{displayName} previewThumbnailURL(width:1280,height:720)}}";

async fn fetch_twitch_vod_metadata(
    vod_id: &str,
    proxy: Option<&ProxyConfig>,
    twitch_auth_token: Option<&str>,
) -> Result<Option<serde_json::Value>, String> {
    let payload = json!({ "query": VOD_METADATA_QUERY, "variables": { "id": vod_id } });
    let mut last_error = String::new();
    for route in twitch_proxy_routes(proxy) {
        let client = twitch_http_client(route.as_deref())?;
        match post_twitch_gql(&client, &payload, twitch_auth_token).await {
            Ok(value) => {
                return Ok(value
                    .get("data")
                    .and_then(|data| data.get("video"))
                    .filter(|video| !video.is_null())
                    .cloned())
            }
            Err(TwitchResolveError::Network(err)) => last_error = err,
            Err(TwitchResolveError::Other(err)) => return Err(err),
        }
    }
    Err(last_error)
}

async fn run_ytdlp_json_with_cookie_retry(
    ytdlp: &Path,
    url: &str,
    platform: &str,
    proxy: Option<&ProxyConfig>,
    twitch_auth_token: Option<&str>,
) -> Result<Vec<u8>, String> {
    let proxy_arg = proxy.and_then(|p| p.for_ytdlp());
    let should_retry_with_cookies = platform == "youtube"
        || is_youtube_url(url)
        || platform == "twitch"
        || url.to_lowercase().contains("twitch.tv");
    let mut cookie_retry_enabled = false;
    let mut last_stderr = String::new();

    for cookie_browser in
        std::iter::once(None).chain(youtube_cookie_retry_browsers().iter().copied().map(Some))
    {
        if cookie_browser.is_some() && !cookie_retry_enabled {
            break;
        }

        let mut cmd = Command::new(ytdlp);
        configure_ytdlp_env(&mut cmd);
        hide_console(&mut cmd);
        // --no-playlist: a "watch?v=X&list=Y" link otherwise resolves to the
        // whole playlist, which carries no top-level "formats" at all.
        cmd.args([
            "-J",
            "--no-playlist",
            "--no-warnings",
            "--no-check-certificates",
        ]);
        if let Some(token) = twitch_auth_token {
            if !token.trim().is_empty() {
                cmd.args([
                    "--add-header",
                    &format!("Authorization: OAuth {}", token.trim()),
                ]);
                cmd.args([
                    "--add-header",
                    &format!("Cookie: auth-token={}", token.trim()),
                ]);
            }
        }
        if let Some(browser) = cookie_browser {
            apply_youtube_cookie_browser(&mut cmd, browser);
        }
        if let Some(px) = proxy_arg.as_deref() {
            cmd.args(["--proxy", px]);
        }
        cmd.arg(url);

        let output = cmd.output().await.map_err(|e| e.to_string())?;
        if output.status.success() {
            return Ok(output.stdout);
        }

        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        let final_error = cookies_cannot_help(&stderr);
        if cookie_browser.is_none()
            && should_retry_with_cookies
            && !final_error
            && (youtube_cookie_auth_error(&stderr)
                || platform == "twitch"
                || url.to_lowercase().contains("twitch.tv"))
        {
            cookie_retry_enabled = true;
            last_stderr = stderr;
            continue;
        }
        if cookie_browser.is_some() && cookie_retry_enabled && !final_error {
            last_stderr = stderr;
            continue;
        }

        return Err(format!("yt-dlp failed: {stderr}"));
    }

    Err(format!(
        "yt-dlp failed after trying browser cookies: {last_stderr}"
    ))
}

fn is_twitch_vod_page_url(input: &str) -> bool {
    let lower = input.to_ascii_lowercase();
    (lower.contains("twitch.tv/videos/")
        || lower.contains("twitch.tv/video/")
        || lower.contains("twitch.tv/v/"))
        && !lower.contains(".m3u8")
}

fn twitch_hls_url_matches_requested_height(url: &str, height: u32) -> bool {
    let lower = url.to_lowercase();
    if height < 1440 {
        return true;
    }
    if lower.contains("chunked")
        || lower.contains("source")
        || lower.contains(&format!("{height}p"))
        || lower.contains(&format!("/{height}/"))
    {
        return true;
    }
    !(lower.contains("1080p")
        || lower.contains("720p")
        || lower.contains("480p")
        || lower.contains("360p")
        || lower.contains("160p"))
}

/// Resolve a playable direct HLS URL suitable for in-app preview.
/// Uses `yt-dlp -g` which returns the best variant's direct media URL.
pub async fn resolve_direct_url(
    url: String,
    proxy: Option<ProxyConfig>,
    binaries_dir: Option<String>,
    quality: Option<String>,
    twitch_auth_token: Option<String>,
) -> Result<String, String> {
    let bin_dir = binaries_dir.as_deref().map(Path::new);

    // Plain m3u8 — nothing to resolve.
    if url.to_lowercase().contains(".m3u8") {
        return Ok(url);
    }
    if let Some(q) = quality.as_deref().filter(|q| !q.is_empty() && *q != "best") {
        if q.to_lowercase().contains(".m3u8") {
            return Ok(q.to_string());
        }
    }

    let ytdlp = resolve_binary(YTDLP, bin_dir).ok_or_else(|| "yt-dlp.exe not found".to_string())?;

    let preview_format = match quality.as_deref() {
        Some(q) if !q.is_empty() && q != "best" => {
            format!("{q}/best[protocol^=m3u8]/best[ext=mp4][vcodec!=none][acodec!=none]/best[vcodec!=none][acodec!=none]/best")
        }
        _ => "best[protocol^=m3u8]/best[ext=mp4][vcodec!=none][acodec!=none]/best[vcodec!=none][acodec!=none]/best".to_string(),
    };

    let stdout = run_ytdlp_direct_url_with_cookie_retry(
        &ytdlp,
        &url,
        &preview_format,
        proxy.as_ref(),
        twitch_auth_token.as_deref(),
    )
    .await?;
    let text = String::from_utf8_lossy(&stdout);
    text.lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .find(|l| l.to_lowercase().contains(".m3u8"))
        .or_else(|| {
            text.lines()
                .map(str::trim)
                .filter(|l| !l.is_empty())
                .find(|l| l.starts_with("http://") || l.starts_with("https://"))
        })
        .map(|s| s.to_string())
        .ok_or_else(|| "empty yt-dlp -g output".to_string())
}

async fn run_ytdlp_direct_url_with_cookie_retry(
    ytdlp: &Path,
    url: &str,
    format_selector: &str,
    proxy: Option<&ProxyConfig>,
    twitch_auth_token: Option<&str>,
) -> Result<Vec<u8>, String> {
    let proxy_arg = proxy.and_then(|p| p.for_ytdlp());
    let should_retry_with_cookies = is_youtube_url(url) || url.to_lowercase().contains("twitch.tv");
    let mut cookie_retry_enabled = false;
    let mut last_stderr = String::new();
    let mut best_resolved: Option<Vec<u8>> = None;

    for cookie_browser in
        std::iter::once(None).chain(youtube_cookie_retry_browsers().iter().copied().map(Some))
    {
        if cookie_browser.is_some() && !cookie_retry_enabled {
            break;
        }

        let mut cmd = Command::new(ytdlp);
        configure_ytdlp_env(&mut cmd);
        hide_console(&mut cmd);
        cmd.arg("-g")
            .arg("--no-check-certificates")
            .arg("--no-warnings")
            .args(["-f", format_selector]);
        if let Some(token) = twitch_auth_token {
            if !token.trim().is_empty() {
                cmd.args([
                    "--add-header",
                    &format!("Authorization: OAuth {}", token.trim()),
                ]);
                cmd.args([
                    "--add-header",
                    &format!("Cookie: auth-token={}", token.trim()),
                ]);
            }
        }
        if let Some(browser) = cookie_browser {
            apply_youtube_cookie_browser(&mut cmd, browser);
        }
        if let Some(px) = proxy_arg.as_deref() {
            cmd.args(["--proxy", px]);
        }
        cmd.arg(url);

        let output = cmd.output().await.map_err(|e| e.to_string())?;
        if output.status.success() {
            let stdout_str = String::from_utf8_lossy(&output.stdout).into_owned();
            let is_under_resolved = url.to_lowercase().contains("twitch.tv")
                && format_selector.contains("1440")
                && !twitch_hls_url_matches_requested_height(&stdout_str, 1440);

            if !is_under_resolved {
                return Ok(output.stdout);
            }
            if best_resolved.is_none() {
                best_resolved = Some(output.stdout);
            }
            last_stderr = format!("Twitch returned a lower resolution (not 1440p): {stdout_str}");
        } else {
            last_stderr = String::from_utf8_lossy(&output.stderr).to_string();
        }

        if cookies_cannot_help(&last_stderr) {
            break;
        }
        if cookie_browser.is_none() && should_retry_with_cookies {
            cookie_retry_enabled = true;
            continue;
        }
        if cookie_browser.is_some() && cookie_retry_enabled {
            continue;
        }

        if best_resolved.is_some() {
            continue;
        }

        return Err(format!("yt-dlp -g failed: {last_stderr}"));
    }

    if let Some(resolved) = best_resolved {
        return Ok(resolved);
    }

    Err(format!(
        "yt-dlp -g failed after trying browser cookies: {last_stderr}"
    ))
}

#[tauri::command]
pub async fn probe_duration(
    path: String,
    binaries_dir: Option<String>,
) -> Result<Option<f64>, String> {
    let bin_dir = binaries_dir.as_deref().map(Path::new);
    let ffprobe = match resolve_binary(FFPROBE, bin_dir) {
        Some(p) => p,
        None => return Ok(None),
    };
    let mut cmd = Command::new(ffprobe);
    hide_console(&mut cmd);
    cmd.args([
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
    ])
    .arg(&path);
    let out = cmd.output().await.map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Ok(None);
    }
    Ok(String::from_utf8_lossy(&out.stdout)
        .trim()
        .parse::<f64>()
        .ok())
}

/// Browsers yt-dlp can read cookies from (`--cookies-from-browser`).
pub const TWITCH_COOKIE_BROWSERS: &[&str] = &[
    "chrome", "edge", "firefox", "brave", "opera", "vivaldi", "chromium", "whale",
];

/// Parse the Twitch `auth-token` value out of a Netscape-format cookie jar.
fn parse_twitch_auth_token(contents: &str) -> Option<String> {
    contents
        .lines()
        .filter(|line| !line.trim_start().starts_with('#') && !line.trim().is_empty())
        .find_map(|line| {
            let cols: Vec<&str> = line.split('\t').collect();
            if cols.len() >= 7 && cols[0].contains("twitch.tv") && cols[5] == "auth-token" {
                let value = cols[6].trim();
                if value.is_empty() {
                    None
                } else {
                    Some(value.to_string())
                }
            } else {
                None
            }
        })
}

/// Pull the Twitch `auth-token` from a cookies.txt file (Netscape format).
///
/// Works for every browser uniformly: the user exports cookies via a browser
/// extension (e.g. "Get cookies.txt LOCALLY"), bypassing Chromium app-bound
/// cookie encryption that blocks `--cookies-from-browser`.
#[tauri::command]
pub async fn twitch_extract_token_from_cookies_file(path: String) -> Result<String, String> {
    let contents =
        std::fs::read_to_string(&path).map_err(|e| format!("Не удалось прочитать файл: {e}"))?;
    if !contents.contains("auth-token") {
        return Err(
            "В файле нет cookie «auth-token» для twitch.tv. Экспортируй cookies, будучи залогиненным на twitch.tv.".to_string(),
        );
    }
    parse_twitch_auth_token(&contents).ok_or_else(|| {
        "auth-token для twitch.tv не найден или пуст. Проверь, что экспорт сделан с открытого twitch.tv.".to_string()
    })
}

/// Pull the Twitch `auth-token` cookie from a logged-in browser via yt-dlp.
///
/// Runs yt-dlp with `--cookies-from-browser <browser>` and dumps the resulting
/// cookie jar to a temp file (yt-dlp re-saves the jar even when the dummy URL
/// fails), then parses the `auth-token` value for the twitch.tv domain.
#[tauri::command]
pub async fn twitch_extract_browser_token(
    browser: String,
    binaries_dir: Option<String>,
) -> Result<String, String> {
    let browser = browser.trim().to_ascii_lowercase();
    if browser.is_empty() {
        return Err("Браузер не выбран".to_string());
    }
    if !TWITCH_COOKIE_BROWSERS.contains(&browser.as_str()) {
        return Err(format!("Неподдерживаемый браузер: {browser}"));
    }

    let bin_dir = binaries_dir.as_deref().map(Path::new);
    let ytdlp = resolve_binary(YTDLP, bin_dir).ok_or_else(|| "yt-dlp.exe не найден".to_string())?;

    // The jar holds every cookie of the browser, not just Twitch's: a random
    // name, so nothing else can guess it and read it before it is removed.
    let mut cookie_path = std::env::temp_dir();
    cookie_path.push(format!("fetchr-cookies-{}.txt", uuid::Uuid::new_v4().simple()));

    let mut cmd = Command::new(&ytdlp);
    configure_ytdlp_env(&mut cmd);
    hide_console(&mut cmd);
    cmd.args(["--cookies-from-browser", &browser])
        .arg("--cookies")
        .arg(&cookie_path)
        .args([
            "--simulate",
            "--no-warnings",
            "--no-playlist",
            "--socket-timeout",
            "5",
        ])
        .arg("https://www.twitch.tv/")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());

    let output = cmd
        .output()
        .await
        .map_err(|e| format!("Не удалось запустить yt-dlp: {e}"))?;
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    let contents = std::fs::read_to_string(&cookie_path).unwrap_or_default();
    let _ = std::fs::remove_file(&cookie_path);

    let token = parse_twitch_auth_token(&contents);

    let _ = &stderr;
    match token {
        Some(token) => Ok(token),
        None => Err(format!(
            "Не удалось получить куки из «{browser}». Закройте браузер и повторите, либо используйте «Импорт cookies.txt» ниже."
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::{
        codec_family, cookies_cannot_help, is_twitch_vod_page_url, normalize_youtube_qualities,
        Quality, VideoCodecPolicy,
    };

    #[test]
    fn offline_and_missing_targets_skip_the_cookie_retries() {
        assert!(cookies_cannot_help(
            "ERROR: [twitch:stream] somechannel: The channel is not currently live"
        ));
        assert!(cookies_cannot_help("ERROR: [twitch:vod] v123: Video 123 does not exist"));
        assert!(!cookies_cannot_help("ERROR: unable to download video data: HTTP Error 403: Forbidden"));
        assert!(!cookies_cannot_help("ERROR: Sign in to confirm you're not a bot"));
    }

    fn video(id: &str, height: u32, fps: f32, ext: &str, vcodec: &str, tbr: f32) -> Quality {
        Quality {
            id: id.to_string(),
            label: format!("{height}p"),
            height: Some(height),
            fps: Some(fps),
            ext: Some(ext.to_string()),
            has_video: true,
            has_audio: false,
            vcodec: Some(vcodec.to_string()),
            tbr: Some(tbr),
            filesize: Some(1_000_000),
            ..Quality::default()
        }
    }

    fn audio(id: &str, acodec: &str, abr: f32) -> Quality {
        Quality {
            id: id.to_string(),
            label: "audio".to_string(),
            ext: Some("m4a".to_string()),
            has_video: false,
            has_audio: true,
            acodec: Some(acodec.to_string()),
            abr: Some(abr),
            filesize: Some(100_000),
            ..Quality::default()
        }
    }

    /// The shape yt-dlp actually returns for a 1080p60 YouTube video: the same
    /// resolution in three codecs, two of them sharing the mp4 container.
    fn youtube_fixture() -> Vec<Quality> {
        vec![
            video("137", 1080, 60.0, "mp4", "h264", 4500.0),
            video("248", 1080, 60.0, "webm", "vp9", 3800.0),
            video("399", 1080, 60.0, "mp4", "av1", 3200.0),
            video("136", 720, 30.0, "mp4", "h264", 2200.0),
            video("247", 720, 30.0, "webm", "vp9", 1900.0),
            audio("140", "aac", 128.0),
            audio("251", "opus", 160.0),
            audio("249", "opus", 50.0),
        ]
    }

    #[test]
    fn collapses_codec_variants_into_one_row_per_resolution() {
        let out = normalize_youtube_qualities(youtube_fixture(), VideoCodecPolicy::Compatible);
        let video_rows = out
            .iter()
            .filter(|q| q.group.as_deref() == Some("video"))
            .collect::<Vec<_>>();

        assert_eq!(video_rows.len(), 2, "expected one row per (height, fps)");
        assert_eq!(video_rows[0].label, "1080p60");
        assert_eq!(video_rows[1].label, "720p");
    }

    #[test]
    fn compatible_policy_prefers_h264_over_a_fatter_stream() {
        let out = normalize_youtube_qualities(youtube_fixture(), VideoCodecPolicy::Compatible);
        let top = out
            .iter()
            .find(|q| q.group.as_deref() == Some("video"))
            .expect("a video row");

        assert_eq!(top.id, "137");
        assert_eq!(top.vcodec.as_deref(), Some("h264"));
        // Merged with the AAC track, so nothing has to be re-encoded.
        assert_eq!(top.acodec.as_deref(), Some("aac"));
        assert!(top.compatible);
    }

    #[test]
    fn best_policy_ranks_purely_by_bitrate() {
        let out = normalize_youtube_qualities(youtube_fixture(), VideoCodecPolicy::Best);
        let top = out
            .iter()
            .find(|q| q.group.as_deref() == Some("video"))
            .expect("a video row");

        assert_eq!(top.id, "137", "137 also has the highest tbr in the fixture");
    }

    #[test]
    fn video_rows_quote_the_merged_size() {
        let out = normalize_youtube_qualities(youtube_fixture(), VideoCodecPolicy::Compatible);
        let top = out
            .iter()
            .find(|q| q.group.as_deref() == Some("video"))
            .expect("a video row");

        assert_eq!(top.filesize, Some(1_100_000));
    }

    #[test]
    fn labels_carry_no_container_text() {
        // The frontend appends ext itself; duplicating it here produced rows
        // reading "360p mp4 · mp4".
        let out = normalize_youtube_qualities(youtube_fixture(), VideoCodecPolicy::Compatible);

        assert!(out.iter().all(|q| !q.label.contains("mp4")));
        assert!(out.iter().all(|q| !q.label.contains("webm")));
        assert!(out.iter().all(|q| !q.label.contains("best audio")));
    }

    #[test]
    fn keeps_one_row_per_audio_codec_family() {
        let out = normalize_youtube_qualities(youtube_fixture(), VideoCodecPolicy::Compatible);
        let audio_rows = out
            .iter()
            .filter(|q| q.group.as_deref() == Some("audio"))
            .collect::<Vec<_>>();

        assert_eq!(audio_rows.len(), 2);
        assert_eq!(audio_rows[0].acodec.as_deref(), Some("aac"));
        // The 50 kbps Opus rendition loses to the 160 kbps one.
        assert_eq!(audio_rows[1].id, "251");
    }

    #[test]
    fn drops_muxed_rows_that_duplicate_a_resolution() {
        let mut raw = youtube_fixture();
        raw.push(Quality {
            id: "22".to_string(),
            label: "720p".to_string(),
            height: Some(720),
            fps: Some(30.0),
            ext: Some("mp4".to_string()),
            has_video: true,
            has_audio: true,
            vcodec: Some("h264".to_string()),
            acodec: Some("aac".to_string()),
            ..Quality::default()
        });

        let out = normalize_youtube_qualities(raw, VideoCodecPolicy::Compatible);

        assert!(out.iter().all(|q| q.id != "22"));
    }

    #[test]
    fn normalizes_ytdlp_codec_strings() {
        assert_eq!(codec_family("avc1.640028"), Some("h264"));
        assert_eq!(codec_family("vp09.00.40.08"), Some("vp9"));
        assert_eq!(codec_family("av01.0.08M.08"), Some("av1"));
        assert_eq!(codec_family("mp4a.40.2"), Some("aac"));
        assert_eq!(codec_family("opus"), Some("opus"));
        assert_eq!(codec_family("none"), None);
        assert_eq!(codec_family(""), None);
    }

    #[test]
    fn detects_twitch_vod_page_urls() {
        assert!(is_twitch_vod_page_url(
            "https://www.twitch.tv/videos/2780687144"
        ));
        assert!(is_twitch_vod_page_url("https://twitch.tv/video/2780687144"));
        assert!(is_twitch_vod_page_url("https://twitch.tv/v/2780687144"));
        assert!(!is_twitch_vod_page_url("https://www.twitch.tv/cutierover"));
        assert!(!is_twitch_vod_page_url(
            "https://d3fi1amfgojobc.cloudfront.net/path/index-dvr.m3u8"
        ));
    }
}
