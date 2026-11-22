use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use base64::{engine::general_purpose, Engine as _};
use chrono::{DateTime, Local, NaiveDateTime, TimeZone, Utc};
use futures::StreamExt;
use once_cell::sync::Lazy;
use parking_lot::Mutex;
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha1::{Digest, Sha1};
use tauri::{AppHandle, State};

use crate::app_log::LogLevel;
use crate::commands::cf_scrape;
use crate::commands::source_progress::{self, Stage};
use crate::AppState;

/// Twitch CDN domains that typically host VOD storage (from community research).
const DOMAINS: &[&str] = &[
    "https://ds0h3roq6wcgc.cloudfront.net/",
    "https://d2nvs31859zcd8.cloudfront.net/",
    "https://d2aba1wr3818hz.cloudfront.net/",
    "https://d3c27h4odz752x.cloudfront.net/",
    "https://dgeft87wbj63p.cloudfront.net/",
    "https://d1m7jfoe9zdc1j.cloudfront.net/",
    "https://d3vd9lfkzbru3h.cloudfront.net/",
    "https://ddacn6pr5v0tl.cloudfront.net/",
    "https://d3aqoihi2n8ty8.cloudfront.net/",
    "https://d3fi1amfgojobc.cloudfront.net/",
    "https://d1g1f25tn8m2e6.cloudfront.net/",
    "https://d1oca24q5dwo6d.cloudfront.net/",
    "https://d1w2poirtb3as9.cloudfront.net/",
    "https://d2dylwb3shzel1.cloudfront.net/",
    "https://d2um2qdswy1tb0.cloudfront.net/",
    "https://d2xmjdvx03ij56.cloudfront.net/",
    "https://d36nr0u3xmc4mm.cloudfront.net/",
    "https://d6d4ismr40iw.cloudfront.net/",
    "https://d6tizftlrpuof.cloudfront.net/",
    "https://dykkng5hnh52u.cloudfront.net/",
    "https://d2vi6trrdongqn.cloudfront.net/",
    "https://d3stzm2eumvgb4.cloudfront.net/",
];

/// Regex for twitchtracker.com/{user}/streams/{id}
static RE_TRACKER: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"twitchtracker\.com/([^/]+)/streams/(\d+)").unwrap());
/// Regex for streamscharts.com/channels/{user}/streams/{id}
static RE_CHARTS: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"streamscharts\.com/channels/([^/]+)/streams/(\d+)").unwrap());
/// Regex for sullygnome.com/channel/{user}/stream/{id}
static RE_SULLY: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"sullygnome\.com/channel/(?:([^/]+)/)?stream/(\d+)").unwrap());
/// Direct twitch vod url: twitch.tv/videos/{id}
static RE_VOD: Lazy<Regex> = Lazy::new(|| Regex::new(r"twitch\.tv/videos/(\d+)").unwrap());
static RE_TWITCH_LOGIN: Lazy<Regex> = Lazy::new(|| Regex::new(r"^[A-Za-z0-9_]{3,25}$").unwrap());
const TWITCH_WEB_CLIENT_ID: &str = "kimne78kx3ncx6brgo4mv6wki5h1ko";
const SULLYGNOME_RANGE_DAYS: u32 = 90;
const SULLYGNOME_CACHE_TTL_SECS: u64 = 10 * 60;

static SULLYGNOME_STREAMS_CACHE: Lazy<Mutex<HashMap<String, SullyGnomeCacheEntry>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

#[derive(Debug, Serialize, Deserialize)]
pub struct TwitchHint {
    pub username: Option<String>,
    pub stream_id: Option<String>,
    pub source: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct TrackerMeta {
    pub username: Option<String>,
    pub stream_id: Option<String>,
    pub start_time: Option<String>,
    pub title: Option<String>,
    pub thumbnail: Option<String>,
    /// Every plausible stream-start timestamp we could find on the page —
    /// the UI lets the user pick one if auto-detect guessed wrong.
    #[serde(default)]
    pub candidates: Vec<String>,
}

/// Best-effort extraction of (username, stream_id) from a pasted URL.
#[tauri::command]
pub fn twitch_parse_url(url: String) -> TwitchHint {
    let u = url.trim();
    if let Some(c) = RE_TRACKER.captures(u) {
        return TwitchHint {
            username: Some(c[1].to_lowercase()),
            stream_id: Some(c[2].to_string()),
            source: "twitchtracker".into(),
        };
    }
    if let Some(c) = RE_CHARTS.captures(u) {
        return TwitchHint {
            username: Some(c[1].to_lowercase()),
            stream_id: Some(c[2].to_string()),
            source: "streamscharts".into(),
        };
    }
    if let Some(c) = RE_SULLY.captures(u) {
        return TwitchHint {
            username: c.get(1).map(|m| m.as_str().to_lowercase()),
            stream_id: c.get(2).map(|m| m.as_str().to_string()),
            source: "sullygnome".into(),
        };
    }
    if let Some(c) = RE_VOD.captures(u) {
        return TwitchHint {
            username: None,
            stream_id: Some(c[1].to_string()),
            source: "twitch_vod".into(),
        };
    }
    TwitchHint {
        username: None,
        stream_id: None,
        source: "unknown".into(),
    }
}

#[derive(Debug, Deserialize)]
pub struct FinderRequest {
    pub username: String,
    pub stream_id: String,
    /// Free-form time string: accepts Unix secs, ISO 8601, "YYYY-MM-DD HH:MM[:SS]",
    /// "DD.MM.YYYY HH:MM", "HH:MM" (today), etc.
    pub start_time: String,
    /// "local" (default) or "utc" — timezone in which start_time is expressed.
    #[serde(default)]
    pub timezone: Option<String>,
    /// Seconds around the given timestamp to probe (default 90).
    #[serde(default)]
    pub window: Option<u32>,
}

#[derive(Debug, Serialize)]
pub struct FinderResult {
    pub urls: Vec<String>,
    pub tried: u32,
    pub timestamp_utc: i64,
}

#[derive(Debug, Deserialize)]
pub struct TwitchStreamsRequest {
    pub username: String,
    #[serde(default)]
    pub page: Option<u32>,
    #[serde(default)]
    pub page_size: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TwitchStreamListItem {
    pub date: Option<String>,
    pub start_time: Option<String>,
    pub title: Option<String>,
    pub duration_minutes: Option<u32>,
    pub game: Option<String>,
    pub url: Option<String>,
    pub stream_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct TwitchStreamsPage {
    pub username: String,
    pub page: u32,
    pub page_size: u32,
    pub total: u32,
    pub items: Vec<TwitchStreamListItem>,
}

#[derive(Debug, Deserialize)]
pub struct TwitchPublicVodsRequest {
    pub login: String,
    #[serde(default)]
    pub first: Option<u32>,
    #[serde(default)]
    pub cursor: Option<String>,
    /// The user's proxy: where Twitch is only reachable through one, a direct
    /// request fails and the list loses every public VOD.
    #[serde(default)]
    pub proxy: Option<crate::proxy::ProxyConfig>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TwitchBroadcaster {
    pub id: String,
    pub login: String,
    pub display_name: String,
    pub profile_image_url: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TwitchPublicVod {
    pub id: String,
    pub title: String,
    pub created_at: String,
    pub duration: String,
    pub duration_seconds: Option<u64>,
    pub url: String,
    pub thumbnail_url: Option<String>,
    pub viewable: String,
    pub public: bool,
    pub stream_id: Option<String>,
    pub chat_available: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TwitchPublicVodPage {
    pub broadcaster: TwitchBroadcaster,
    pub items: Vec<TwitchPublicVod>,
    pub cursor: Option<String>,
    pub has_next_page: bool,
}

#[tauri::command]
pub async fn twitch_public_vods(
    state: State<'_, AppState>,
    req: TwitchPublicVodsRequest,
) -> Result<TwitchPublicVodPage, String> {
    let queue = state.queue.clone();
    let login = req.login.trim().trim_start_matches('@').to_lowercase();
    let first = req.first.unwrap_or(20).clamp(1, 100);
    let cursor = req.cursor.filter(|value| !value.trim().is_empty());
    let input = json!({
        "login": login.clone(),
        "first": first,
        "cursor": cursor,
    });

    if login.is_empty() {
        return Err("Введите ник Twitch-стримера.".to_string());
    }
    if !RE_TWITCH_LOGIN.is_match(&login) {
        return Err(
            "Ник Twitch должен содержать только латиницу, цифры и подчёркивание.".to_string(),
        );
    }

    queue.emit_app_log(
        LogLevel::Info,
        "twitch_public_vods_lookup_started",
        "Started public Twitch VOD lookup",
        Some(input.clone()),
    );

    let page = fetch_public_twitch_vods(&login, first, cursor.as_deref(), req.proxy.as_ref())
        .await
        .map_err(|err| {
            queue.emit_app_error(
                "twitch_public_vods_lookup_failed",
                err.clone(),
                None,
                Some(input.clone()),
            );
            err
        })?;

    queue.emit_app_log(
        LogLevel::Info,
        "twitch_public_vods_lookup_finished",
        format!(
            "Loaded public Twitch VODs for {}: {} items",
            page.broadcaster.login,
            page.items.len()
        ),
        Some(json!({
            "login": page.broadcaster.login,
            "broadcaster_id": page.broadcaster.id,
            "items": page.items.len(),
            "has_next_page": page.has_next_page,
        })),
    );

    Ok(page)
}

#[tauri::command]
pub async fn twitch_find_m3u8(
    state: State<'_, AppState>,
    req: FinderRequest,
) -> Result<FinderResult, String> {
    let queue = state.queue.clone();
    let input = json!({
        "username": req.username.clone(),
        "stream_id": req.stream_id.clone(),
        "start_time": req.start_time.clone(),
        "timezone": req.timezone.clone(),
        "window": req.window,
    });
    queue.emit_app_log(
        LogLevel::Info,
        "twitch_find_m3u8_started",
        "Started Twitch m3u8 candidate probing",
        Some(input.clone()),
    );

    let ts = match parse_time(&req.start_time, req.timezone.as_deref()) {
        Ok(ts) => ts,
        Err(e) => {
            let msg = format!("Bad time: {e}");
            queue.emit_app_error(
                "twitch_find_m3u8_failed",
                msg.clone(),
                Some(format!("{e:?}")),
                Some(input),
            );
            return Err(msg);
        }
    };
    let window: i64 = req.window.unwrap_or(90) as i64;

    let client = reqwest::Client::builder()
        .user_agent(
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 \
             (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        )
        .timeout(Duration::from_secs(6))
        .build()
        .map_err(|e| {
            let msg = e.to_string();
            queue.emit_app_error(
                "twitch_find_m3u8_failed",
                msg.clone(),
                Some(format!("{e:?}")),
                Some(input.clone()),
            );
            msg
        })?;

    let username = req.username.trim().to_lowercase();
    let stream_id = req.stream_id.trim().to_string();
    let client = Arc::new(client);

    // Base pass around the given timestamp.
    let (mut urls, mut tried) = probe_window(&client, &username, &stream_id, ts, window).await;
    let mut found_ts = ts;

    // Timezone rescue: the tracker time may have been read in the wrong zone
    // (UTC vs local, or AM/PM mixup = ±12h). Re-probe with hour offsets,
    // most likely ones first, until something is found.
    if urls.is_empty() {
        let local_off = Local::now().offset().local_minus_utc() as i64;
        let mut offsets: Vec<i64> = Vec::new();
        let push_off = |offsets: &mut Vec<i64>, o: i64| {
            if o != 0 && !offsets.contains(&o) {
                offsets.push(o);
            }
        };
        push_off(&mut offsets, -local_off);
        push_off(&mut offsets, local_off);
        push_off(&mut offsets, 12 * 3600);
        push_off(&mut offsets, -12 * 3600);
        // Small ± hour drift only; the wide ±14h scan rarely helped and made
        // a true miss take very long.
        for h in 1..=3i64 {
            push_off(&mut offsets, h * 3600);
            push_off(&mut offsets, -h * 3600);
        }

        for off in offsets {
            queue.emit_app_log(
                LogLevel::Info,
                "twitch_find_m3u8_offset_retry",
                format!("No hits; retrying with offset {} h", off / 3600),
                Some(json!({ "offset_hours": off / 3600 })),
            );
            let (u, t) =
                probe_window(&client, &username, &stream_id, ts + off, window.min(120)).await;
            tried += t;
            if !u.is_empty() {
                urls = u;
                found_ts = ts + off;
                break;
            }
        }
    }

    queue.emit_app_log(
        LogLevel::Info,
        "twitch_find_m3u8_finished",
        format!(
            "Finished Twitch m3u8 probing: tried {tried}, found {}",
            urls.len()
        ),
        Some(json!({
            "username": username,
            "stream_id": stream_id,
            "tried": tried,
            "found": urls.len(),
            "timestamp_utc": found_ts,
            "offset_seconds": found_ts - ts,
        })),
    );
    Ok(FinderResult {
        urls,
        tried,
        timestamp_utc: found_ts,
    })
}

/// Probe seconds around `ts` × all CDN domains, ordered center-out, and stop at
/// the first hit. A given stream has exactly one valid `index-dvr.m3u8`
/// (same hash path on whichever CDN hosts it), so the first 2xx is the answer
/// and every remaining probe is wasted work — hence early exit + cancellation.
async fn probe_window(
    client: &Arc<reqwest::Client>,
    username: &str,
    stream_id: &str,
    ts: i64,
    window: i64,
) -> (Vec<String>, u32) {
    // Tracker timestamps are minute-precise, so the real start second is very
    // close to `ts`. Probe closest-to-center first so the hit comes up early.
    let mut times: Vec<i64> = Vec::with_capacity(window as usize * 2 + 1);
    times.push(ts);
    for d in 1..=window {
        times.push(ts + d);
        times.push(ts - d);
    }

    let mut candidates: Vec<String> = Vec::with_capacity(times.len() * DOMAINS.len());
    for t in times {
        for d in DOMAINS.iter() {
            candidates.push(construct_url(d, username, stream_id, t));
        }
    }

    const MAX_INFLIGHT: usize = 128;
    let mut stream = futures::stream::iter(candidates.into_iter().map(|url| {
        let c = client.clone();
        async move { probe(&c, url).await }
    }))
    .buffer_unordered(MAX_INFLIGHT);

    let mut tried = 0u32;
    let mut found: Option<String> = None;
    while let Some(r) = stream.next().await {
        tried += 1;
        if let Ok(Some(u)) = r {
            found = Some(u);
            break;
        }
    }
    drop(stream); // drop in-flight futures -> abort pending requests

    match found {
        Some(u) => (vec![u], tried),
        None => (Vec::new(), tried),
    }
}

#[tauri::command]
pub async fn twitch_tracker_streams(
    app: AppHandle,
    state: State<'_, AppState>,
    req: TwitchStreamsRequest,
) -> Result<TwitchStreamsPage, String> {
    let queue = state.queue.clone();
    let username = req.username.trim().trim_start_matches('@').to_lowercase();
    let page = req.page.unwrap_or(1).max(1);
    let page_size = req.page_size.unwrap_or(8).clamp(1, 20);
    let input = json!({
        "username": username.clone(),
        "page": page,
        "page_size": page_size,
    });

    if username.is_empty() {
        let msg = "Введите ник Twitch-стримера.".to_string();
        queue.emit_app_error(
            "twitch_streams_lookup_failed",
            msg.clone(),
            None,
            Some(input),
        );
        return Err(msg);
    }
    if !RE_TWITCH_LOGIN.is_match(&username) {
        let msg = "Ник Twitch должен содержать только латиницу, цифры и подчёркивание.".to_string();
        queue.emit_app_error(
            "twitch_streams_lookup_failed",
            msg.clone(),
            None,
            Some(input),
        );
        return Err(msg);
    }

    queue.emit_app_log(
        LogLevel::Info,
        "twitch_streams_lookup_started",
        "Started TwitchTracker stream list lookup",
        Some(input.clone()),
    );

    source_progress::emit(&app, "twitchtracker", Stage::Started, None);
    match fetch_twitchtracker_streams(&app, &username, page, page_size).await {
        Ok(result) => {
            source_progress::emit(&app, "twitchtracker", Stage::Done, None);
            queue.emit_app_log(
                LogLevel::Info,
                "twitch_streams_lookup_finished",
                format!(
                    "Loaded TwitchTracker streams: total {}, page {}, items {}",
                    result.total,
                    result.page,
                    result.items.len()
                ),
                Some(json!({
                    "username": result.username.clone(),
                    "page": result.page,
                    "page_size": result.page_size,
                    "total": result.total,
                    "items": result.items.len(),
                })),
            );
            Ok(result)
        }
        Err(err) => {
            source_progress::emit(&app, "twitchtracker", Stage::Failed, Some(&err.message));
            if should_fallback_twitchtracker_streams(&err) {
                source_progress::emit(&app, "sullygnome", Stage::Started, None);
                queue.emit_app_log(
                    LogLevel::Warn,
                    "twitch_streams_lookup_sullygnome_fallback_started",
                    "TwitchTracker lookup was blocked; trying SullyGnome fallback",
                    Some(json!({
                        "username": username.clone(),
                        "page": page,
                        "page_size": page_size,
                        "range_days": SULLYGNOME_RANGE_DAYS,
                        "reason": err.message.clone(),
                        "traceback": err.traceback.clone(),
                    })),
                );
                match fetch_sullygnome_streams_cached(&app, &username, page, page_size).await {
                    Ok(result) => {
                        source_progress::emit(&app, "sullygnome", Stage::Done, None);
                        queue.emit_app_log(
                            LogLevel::Info,
                            "twitch_streams_lookup_sullygnome_fallback_finished",
                            format!(
                                "Loaded SullyGnome streams: total {}, page {}, items {}",
                                result.total,
                                result.page,
                                result.items.len()
                            ),
                            Some(json!({
                                "username": result.username.clone(),
                                "page": result.page,
                                "page_size": result.page_size,
                                "total": result.total,
                                "items": result.items.len(),
                                "range_days": SULLYGNOME_RANGE_DAYS,
                            })),
                        );
                        return Ok(result);
                    }
                    Err(fallback_err) => {
                        source_progress::emit(
                            &app,
                            "sullygnome",
                            Stage::Failed,
                            Some(&fallback_err.message),
                        );
                        let msg = combined_tracker_lookup_error(&err, &fallback_err);
                        queue.emit_app_error(
                            "twitch_streams_lookup_failed",
                            msg.clone(),
                            Some(format!(
                                "TwitchTracker: {:?}\nSullyGnome: {:?}",
                                err.traceback, fallback_err.traceback
                            )),
                            Some(input),
                        );
                        return Err(msg);
                    }
                }
            }
            queue.emit_app_error(
                "twitch_streams_lookup_failed",
                err.to_string(),
                err.traceback,
                Some(input),
            );
            Err(err.message)
        }
    }
}

fn construct_url(domain: &str, username: &str, stream_id: &str, ts: i64) -> String {
    let input = format!("{username}_{stream_id}_{ts}");
    let mut hasher = Sha1::new();
    hasher.update(input.as_bytes());
    let digest = hasher.finalize();
    let hex_full = hex::encode(digest);
    let hash_prefix = &hex_full[..20];
    format!("{domain}{hash_prefix}_{input}/chunked/index-dvr.m3u8")
}

async fn probe(client: &reqwest::Client, url: String) -> anyhow::Result<Option<String>> {
    // Ranged GET instead of HEAD: some CloudFront distributions reject HEAD
    // (405/403) for valid objects, which made correct URLs read as "not found".
    // `bytes=0-0` keeps the response to a single byte.
    let resp = client.get(&url).header("Range", "bytes=0-0").send().await?;
    if resp.status().is_success() {
        Ok(Some(url))
    } else {
        Ok(None)
    }
}

#[derive(Debug)]
struct StreamsLookupError {
    message: String,
    traceback: Option<String>,
}

impl StreamsLookupError {
    fn new(message: impl Into<String>, traceback: Option<String>) -> Self {
        Self {
            message: message.into(),
            traceback,
        }
    }
}

impl std::fmt::Display for StreamsLookupError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

fn should_fallback_twitchtracker_streams(err: &StreamsLookupError) -> bool {
    let mut text = err.message.to_lowercase();
    if let Some(traceback) = err.traceback.as_deref() {
        text.push(' ');
        text.push_str(&traceback.to_lowercase());
    }
    text.contains("403")
        || text.contains("forbidden")
        || text.contains("cloudflare")
        || text.contains("challenge")
        || text.contains("html-")
        || text.contains("html-структура")
}

fn combined_tracker_lookup_error(
    twitchtracker_err: &StreamsLookupError,
    sullygnome_err: &StreamsLookupError,
) -> String {
    format!(
        "Tracker список недоступен. TwitchTracker: {} SullyGnome fallback: {}",
        twitchtracker_err.message, sullygnome_err.message
    )
}

#[derive(Clone)]
struct SullyGnomeCacheEntry {
    created_at: Instant,
    page: TwitchStreamsPage,
}

fn paginate_twitch_streams(
    username: String,
    page: u32,
    page_size: u32,
    mut items: Vec<TwitchStreamListItem>,
) -> Result<TwitchStreamsPage, StreamsLookupError> {
    if items.is_empty() {
        return Err(StreamsLookupError::new(
            "У стримера нет найденных стримов на TwitchTracker.",
            None,
        ));
    }
    for item in items.iter_mut() {
        if item.start_time.is_none() {
            if let Some(date) = item.date.as_deref() {
                item.start_time = tracker_date_to_iso_utc(date);
            }
        }
        if item.url.is_none() {
            if let Some(id) = item.stream_id.as_deref() {
                item.url = Some(format!("https://twitchtracker.com/{username}/streams/{id}"));
            }
        }
    }
    items.sort_by(|a, b| b.date.cmp(&a.date));
    let total = items.len() as u32;
    let start = ((page - 1) * page_size) as usize;
    let end = (start + page_size as usize).min(items.len());
    let page_items = if start < items.len() {
        items[start..end].to_vec()
    } else {
        Vec::new()
    };

    Ok(TwitchStreamsPage {
        username,
        page,
        page_size,
        total,
        items: page_items,
    })
}

async fn fetch_public_twitch_vods(
    login: &str,
    first: u32,
    cursor: Option<&str>,
    proxy: Option<&crate::proxy::ProxyConfig>,
) -> Result<TwitchPublicVodPage, String> {
    let mut builder = reqwest::Client::builder()
        .user_agent(
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 \
             (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        )
        .timeout(Duration::from_secs(15));
    // reqwest reads only the *_PROXY variables, not the Windows proxy a VPN
    // client switches on; where Twitch is blocked, direct GQL just times out.
    let proxy_url = match proxy {
        Some(proxy) => proxy.effective(),
        None => crate::proxy::system_proxy(),
    };
    if let Some(proxy_url) = proxy_url {
        builder = builder.proxy(
            reqwest::Proxy::all(&proxy_url).map_err(|e| format!("Некорректный прокси: {e}"))?,
        );
    }
    let client = builder
        .build()
        .map_err(|e| format!("Не удалось подготовить HTTP-клиент Twitch: {e}"))?;

    let query = r#"
      query FetchrPublicVods($login: String!, $first: Int!, $cursor: Cursor) {
        user(login: $login) {
          id
          login
          displayName
          profileImageURL(width: 150)
          videos(first: $first, after: $cursor, type: ARCHIVE, sort: TIME) {
            edges {
              cursor
              node {
                id
                title
                createdAt
                lengthSeconds
                previewThumbnailURL(width: 320, height: 180)
                broadcastType
              }
            }
            pageInfo {
              hasNextPage
            }
          }
        }
      }
    "#;

    let payload = json!({
        "operationName": "FetchrPublicVods",
        "query": query,
        "variables": {
            "login": login,
            "first": first,
            "cursor": cursor,
        }
    });

    let (status, body) = crate::util::fetch_text_with_retry(|| {
        client
            .post("https://gql.twitch.tv/gql")
            .header("Client-ID", TWITCH_WEB_CLIENT_ID)
            .header("Content-Type", "application/json")
            .json(&payload)
    })
    .await
    .map_err(|e| format!("Twitch GQL request failed: {e}"))?;
    if !status.is_success() {
        return Err(format!("Twitch GQL returned HTTP {status}"));
    }
    let value: Value =
        serde_json::from_str(&body).map_err(|e| format!("Twitch GQL JSON failed: {e}"))?;

    if let Some(errors) = value.get("errors").and_then(|errors| errors.as_array()) {
        let message = errors
            .iter()
            .filter_map(|error| error.get("message").and_then(|message| message.as_str()))
            .collect::<Vec<_>>()
            .join("; ");
        return Err(if message.is_empty() {
            "Twitch вернул ошибку при получении публичных VOD.".to_string()
        } else {
            message
        });
    }

    let user = value
        .get("data")
        .and_then(|data| data.get("user"))
        .filter(|user| !user.is_null())
        .ok_or_else(|| "Twitch-канал не найден или недоступен публично.".to_string())?;

    let broadcaster = TwitchBroadcaster {
        id: string_field(user, "id").ok_or_else(|| "Twitch user id missing".to_string())?,
        login: string_field(user, "login").unwrap_or_else(|| login.to_string()),
        display_name: string_field(user, "displayName").unwrap_or_else(|| login.to_string()),
        profile_image_url: string_field(user, "profileImageURL"),
    };

    let videos = user
        .get("videos")
        .ok_or_else(|| "Twitch не вернул список публичных VOD.".to_string())?;
    let edges = videos
        .get("edges")
        .and_then(|edges| edges.as_array())
        .cloned()
        .unwrap_or_default();

    let mut items = Vec::new();
    let mut next_cursor = None;
    for edge in edges {
        next_cursor = string_field(&edge, "cursor").or(next_cursor);
        let Some(node) = edge.get("node") else {
            continue;
        };
        let Some(id) = string_field(node, "id") else {
            continue;
        };
        let viewable = "public".to_string();
        let is_public = true;
        let duration_seconds = node.get("lengthSeconds").and_then(|value| value.as_u64());
        items.push(TwitchPublicVod {
            url: format!("https://www.twitch.tv/videos/{id}"),
            stream_id: None,
            chat_available: is_public,
            public: is_public,
            id,
            title: string_field(node, "title").unwrap_or_else(|| "Untitled Twitch VOD".to_string()),
            created_at: string_field(node, "createdAt").unwrap_or_default(),
            duration: duration_seconds
                .map(format_seconds)
                .unwrap_or_else(|| "—".to_string()),
            duration_seconds,
            thumbnail_url: string_field(node, "previewThumbnailURL"),
            viewable,
        });
    }

    let has_next_page = videos
        .get("pageInfo")
        .and_then(|page_info| page_info.get("hasNextPage"))
        .and_then(|value| value.as_bool())
        .unwrap_or(false);

    Ok(TwitchPublicVodPage {
        broadcaster,
        items,
        cursor: if has_next_page { next_cursor } else { None },
        has_next_page,
    })
}

fn string_field(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(|value| value.as_str())
        .map(|value| value.to_string())
        .filter(|value| !value.is_empty())
}

fn format_seconds(seconds: u64) -> String {
    let hours = seconds / 3600;
    let minutes = (seconds % 3600) / 60;
    let secs = seconds % 60;
    if hours > 0 {
        format!("{hours}h {minutes}m")
    } else if minutes > 0 {
        format!("{minutes}m {secs}s")
    } else {
        format!("{secs}s")
    }
}

static RE_STREAMS_TABLE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r#"(?is)<table[^>]+id=["']streams["'][^>]*>(.*?)</table>"#).unwrap());
static RE_TABLE_ROW: Lazy<Regex> = Lazy::new(|| Regex::new(r#"(?is)<tr[^>]*>(.*?)</tr>"#).unwrap());
static RE_TABLE_CELL: Lazy<Regex> =
    Lazy::new(|| Regex::new(r#"(?is)<td\b([^>]*)>(.*?)</td>"#).unwrap());
static RE_DATA_ORDER: Lazy<Regex> =
    Lazy::new(|| Regex::new(r#"data-order=["']([^"']+)["']"#).unwrap());
static RE_TAGS: Lazy<Regex> = Lazy::new(|| Regex::new(r#"(?is)<[^>]+>"#).unwrap());
static RE_ECS: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r#"(?is)<meta[^>]+id=["']ecs["'][^>]+content=["']([^"']+)["']"#).unwrap()
});
static RE_STREAM_DATE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r#"^\d{4}-\d{2}-\d{2} \d{2}:\d{2}"#).unwrap());
static RE_ROW_STREAM_HREF: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r#"(?i)/[A-Za-z0-9_]+/streams/(\d+)|twitchtracker\.com/[A-Za-z0-9_]+/streams/(\d+)"#)
        .unwrap()
});

async fn fetch_twitchtracker_streams(
    app: &AppHandle,
    username: &str,
    page: u32,
    page_size: u32,
) -> Result<TwitchStreamsPage, StreamsLookupError> {
    let url = format!("https://twitchtracker.com/{username}/streams");
    let html = fetch_tracker_html(app, &url).await.map_err(|e| {
        let msg = match (e.blocked, e.status) {
            (true, _) => format!("TwitchTracker сейчас {}.", e.message),
            (false, 404) => "Стример не найден на TwitchTracker.".to_string(),
            (false, s) if (500..600).contains(&s) => {
                "TwitchTracker недоступен. Попробуйте позже.".to_string()
            }
            (false, 0) => format!("TwitchTracker недоступен: {}.", e.message),
            (false, _) => format!("TwitchTracker вернул {}.", e.message),
        };
        StreamsLookupError::new(msg, Some(format!("{} for {url}", e.message)))
    })?;

    if html.to_lowercase().contains("channel not found")
        || html.to_lowercase().contains("streamer not found")
    {
        return Err(StreamsLookupError::new(
            "Стример не найден на TwitchTracker.",
            None,
        ));
    }

    let items = parse_twitchtracker_streams_html(&html, username)?;
    if items.is_empty() {
        return Err(StreamsLookupError::new(
            "У стримера нет найденных стримов на TwitchTracker.",
            None,
        ));
    }

    paginate_twitch_streams(username.to_string(), page, page_size, items)
}

async fn fetch_sullygnome_streams_cached(
    app: &AppHandle,
    username: &str,
    page: u32,
    page_size: u32,
) -> Result<TwitchStreamsPage, StreamsLookupError> {
    let key = sullygnome_cache_key(username, page, page_size);
    let ttl = Duration::from_secs(SULLYGNOME_CACHE_TTL_SECS);
    {
        let mut cache = SULLYGNOME_STREAMS_CACHE.lock();
        if let Some(entry) = cache.get(&key) {
            if entry.created_at.elapsed() < ttl {
                return Ok(entry.page.clone());
            }
        }
        cache.remove(&key);
    }

    let page_data = fetch_sullygnome_streams(app, username, page, page_size).await?;
    {
        let mut cache = SULLYGNOME_STREAMS_CACHE.lock();
        cache.retain(|_, entry| entry.created_at.elapsed() < ttl);
        cache.insert(
            key,
            SullyGnomeCacheEntry {
                created_at: Instant::now(),
                page: page_data.clone(),
            },
        );
    }
    Ok(page_data)
}

async fn fetch_sullygnome_streams(
    app: &AppHandle,
    username: &str,
    page: u32,
    page_size: u32,
) -> Result<TwitchStreamsPage, StreamsLookupError> {
    let page_url = format!("https://sullygnome.com/channel/{username}/streams");
    let page_html = fetch_tracker_html(app, &page_url).await.map_err(|e| {
        let msg = match (e.blocked, e.status) {
            (true, _) => format!("SullyGnome сейчас {}.", e.message),
            (false, 404) => "Стример не найден на SullyGnome.".to_string(),
            (false, 0) => format!("SullyGnome недоступен: {}.", e.message),
            (false, _) => format!("SullyGnome вернул {}.", e.message),
        };
        StreamsLookupError::new(msg, Some(format!("{} for {page_url}", e.message)))
    })?;

    if page_html.to_lowercase().contains("channel not found")
        || page_html.to_lowercase().contains("streamer not found")
    {
        return Err(StreamsLookupError::new(
            "Стример не найден на SullyGnome.",
            Some(format!("channel not found for {page_url}")),
        ));
    }

    let channel_id = parse_sullygnome_channel_id(&page_html)?;
    let offset = (page - 1) * page_size;
    let api_url = format!(
        "https://sullygnome.com/api/tables/channeltables/streams/{}/{}/%20/1/1/desc/{}/{}",
        SULLYGNOME_RANGE_DAYS, channel_id, offset, page_size
    );
    // The WebView fallback downloads JSON instead of rendering it, so after a
    // Cloudflare challenge this got an HTML page: "unexpected JSON".
    let api_body = fetch_tracker_json(app, &page_url, &api_url).await.map_err(|e| {
        let msg = if e.blocked {
            format!("SullyGnome API сейчас {}.", e.message)
        } else {
            format!("SullyGnome API вернул {}.", e.message)
        };
        StreamsLookupError::new(msg, Some(format!("{} for {api_url}", e.message)))
    })?;

    parse_sullygnome_streams_json(username, page, page_size, &api_body)
}

fn sullygnome_cache_key(username: &str, page: u32, page_size: u32) -> String {
    format!(
        "{}:{}:{}:{}",
        username, SULLYGNOME_RANGE_DAYS, page, page_size
    )
}

fn parse_sullygnome_channel_id(html: &str) -> Result<u64, StreamsLookupError> {
    let page_info = extract_sullygnome_page_info_json(html).ok_or_else(|| {
        StreamsLookupError::new(
            "HTML-структура SullyGnome изменилась: PageInfo не найден.",
            None,
        )
    })?;
    let value: Value = serde_json::from_str(page_info).map_err(|e| {
        StreamsLookupError::new(
            "Не удалось прочитать PageInfo SullyGnome.",
            Some(format!("{e:?}")),
        )
    })?;
    value.get("id").and_then(|id| id.as_u64()).ok_or_else(|| {
        StreamsLookupError::new(
            "HTML-структура SullyGnome изменилась: channel id не найден.",
            None,
        )
    })
}

fn extract_sullygnome_page_info_json(html: &str) -> Option<&str> {
    let marker = "var PageInfo =";
    let mut start = html.find(marker)? + marker.len();
    let bytes = html.as_bytes();
    while start < bytes.len() && bytes[start].is_ascii_whitespace() {
        start += 1;
    }
    if bytes.get(start) != Some(&b'{') {
        return None;
    }

    let mut depth = 0usize;
    let mut in_string = false;
    let mut escape = false;
    for (offset, ch) in html[start..].char_indices() {
        if in_string {
            if escape {
                escape = false;
            } else if ch == '\\' {
                escape = true;
            } else if ch == '"' {
                in_string = false;
            }
            continue;
        }

        match ch {
            '"' => in_string = true,
            '{' => depth += 1,
            '}' => {
                depth = depth.saturating_sub(1);
                if depth == 0 {
                    let end = start + offset + ch.len_utf8();
                    return Some(&html[start..end]);
                }
            }
            _ => {}
        }
    }
    None
}

#[derive(Debug, Deserialize)]
struct SullyGnomeStreamsResponse {
    #[serde(default, rename = "recordsTotal")]
    records_total: Option<u32>,
    #[serde(default, rename = "recordsFiltered")]
    records_filtered: Option<u32>,
    #[serde(default)]
    data: Vec<SullyGnomeStreamRow>,
}

#[derive(Debug, Deserialize)]
struct SullyGnomeStreamRow {
    #[serde(default)]
    starttime: Option<String>,
    #[serde(default, rename = "startDateTime")]
    start_date_time: Option<String>,
    #[serde(default)]
    length: Option<u32>,
    #[serde(default)]
    gamesplayed: Option<String>,
    #[serde(default, rename = "streamId")]
    stream_id: Option<Value>,
    #[serde(default, rename = "streamUrl")]
    stream_url: Option<String>,
}

fn parse_sullygnome_streams_json(
    username: &str,
    page: u32,
    page_size: u32,
    body: &str,
) -> Result<TwitchStreamsPage, StreamsLookupError> {
    let parsed: SullyGnomeStreamsResponse = serde_json::from_str(body).map_err(|e| {
        StreamsLookupError::new(
            "SullyGnome вернул неожиданный JSON списка стримов.",
            Some(format!("{e:?}")),
        )
    })?;

    let items: Vec<TwitchStreamListItem> = parsed
        .data
        .into_iter()
        .filter_map(sullygnome_row_to_item)
        .collect();
    if items.is_empty() {
        return Err(StreamsLookupError::new(
            "SullyGnome не вернул стримы с usable stream_id.",
            None,
        ));
    }

    Ok(TwitchStreamsPage {
        username: username.to_string(),
        page,
        page_size,
        total: parsed
            .records_filtered
            .or(parsed.records_total)
            .unwrap_or(items.len() as u32),
        items,
    })
}

fn sullygnome_row_to_item(row: SullyGnomeStreamRow) -> Option<TwitchStreamListItem> {
    let stream_id = row.stream_id.as_ref().and_then(json_value_to_string)?;
    let start_time = normalize_sullygnome_start_time(row.start_date_time.as_deref());
    let date = start_time.clone().or(row.starttime);
    let url = row
        .stream_url
        .filter(|url| !url.trim().is_empty())
        .or_else(|| Some(format!("https://sullygnome.com/channel/stream/{stream_id}")));

    Some(TwitchStreamListItem {
        date,
        start_time,
        title: None,
        duration_minutes: row.length,
        game: parse_sullygnome_games(row.gamesplayed.as_deref()),
        url,
        stream_id: Some(stream_id),
    })
}

fn json_value_to_string(value: &Value) -> Option<String> {
    value
        .as_str()
        .map(|s| s.to_string())
        .or_else(|| value.as_u64().map(|n| n.to_string()))
        .or_else(|| value.as_i64().map(|n| n.to_string()))
        .filter(|s| !s.trim().is_empty() && s != "0")
}

fn normalize_sullygnome_start_time(value: Option<&str>) -> Option<String> {
    let value = value?.trim();
    if value.is_empty() {
        return None;
    }
    DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|dt| {
            dt.with_timezone(&Utc)
                .to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
        })
        .or_else(|| Some(value.to_string()))
}

fn parse_sullygnome_games(value: Option<&str>) -> Option<String> {
    let parts: Vec<&str> = value?
        .split('|')
        .map(str::trim)
        .filter(|part| !part.is_empty())
        .collect();
    if parts.is_empty() {
        return None;
    }

    let mut names: Vec<String> = Vec::new();
    for chunk in parts.chunks(3) {
        let Some(name) = chunk.first().copied() else {
            continue;
        };
        if name.starts_with("http") || names.iter().any(|known| known == name) {
            continue;
        }
        names.push(html_unescape(name));
    }

    if names.is_empty() {
        names = parts
            .into_iter()
            .filter(|part| !part.starts_with("http"))
            .map(html_unescape)
            .collect();
    }
    if names.is_empty() {
        None
    } else {
        Some(names.join(", "))
    }
}

fn parse_twitchtracker_streams_html(
    html: &str,
    username: &str,
) -> Result<Vec<TwitchStreamListItem>, StreamsLookupError> {
    let table = RE_STREAMS_TABLE
        .captures(html)
        .and_then(|c| c.get(1))
        .map(|m| m.as_str())
        .ok_or_else(|| {
            StreamsLookupError::new(
                "HTML-структура TwitchTracker изменилась: таблица стримов не найдена.",
                None,
            )
        })?;
    let complicator = decode_twitchtracker_complicator(html);
    let mut rows_seen = 0usize;
    let mut items = Vec::new();

    for row in RE_TABLE_ROW.captures_iter(table) {
        let Some(row_html) = row.get(1).map(|m| m.as_str()) else {
            continue;
        };
        let cells: Vec<(&str, &str)> = RE_TABLE_CELL
            .captures_iter(row_html)
            .filter_map(|c| Some((c.get(1)?.as_str(), c.get(2)?.as_str())))
            .collect();
        if cells.len() < 7 {
            continue;
        }
        rows_seen += 1;
        let date = extract_data_order(cells[0].0)
            .or_else(|| Some(clean_html_text(cells[0].1)))
            .map(|s| s.trim().to_string())
            .filter(|s| RE_STREAM_DATE.is_match(s));
        let Some(date) = date else {
            continue;
        };
        let duration_minutes = extract_data_order(cells[1].0)
            .and_then(|s| s.parse::<u32>().ok())
            .or_else(|| first_u32(&clean_html_text(cells[1].1)));
        let title = clean_html_text(cells[6].1);
        let title = if title.is_empty() { None } else { Some(title) };
        let details = complicator.as_ref().and_then(|v| v.get(&date));
        let stream_id = extract_stream_id(details).or_else(|| extract_href_stream_id(row_html));
        let game = extract_games(details).or_else(|| {
            cells
                .get(7)
                .map(|(_, body)| clean_html_text(body))
                .filter(|s| !s.is_empty())
        });
        let url = stream_id
            .as_ref()
            .map(|id| format!("https://twitchtracker.com/{username}/streams/{id}"));

        items.push(TwitchStreamListItem {
            date: Some(date.clone()),
            start_time: tracker_date_to_iso_utc(&date),
            title,
            duration_minutes,
            game,
            url,
            stream_id,
        });
    }

    if rows_seen == 0 {
        return Err(StreamsLookupError::new(
            "HTML-структура TwitchTracker изменилась: строки таблицы не распознаны.",
            None,
        ));
    }
    if !items.is_empty() && items.iter().all(|item| item.stream_id.is_none()) {
        return Err(StreamsLookupError::new(
            "HTML-структура TwitchTracker изменилась: id стримов не найдены.",
            None,
        ));
    }
    Ok(items)
}

fn decode_twitchtracker_complicator(html: &str) -> Option<Value> {
    let content = RE_ECS.captures(html)?.get(1)?.as_str();
    let marker = content.chars().next()?;
    let mut parts: Vec<&str> = content.split('!').collect();
    let keys_part = parts.pop()?;
    let keys: Vec<String> = decode_twitchtracker_payload(keys_part, marker)?;
    for (idx, key) in keys.iter().enumerate() {
        if key != "complicator" {
            continue;
        }
        let part = parts.get(idx)?;
        return decode_twitchtracker_payload(part, marker);
    }
    None
}

fn decode_twitchtracker_payload<T: serde::de::DeserializeOwned>(
    encoded: &str,
    marker: char,
) -> Option<T> {
    let mut normalized = encoded.replace(marker, "W");
    let rem = normalized.len() % 4;
    if rem != 0 {
        normalized.extend(std::iter::repeat('=').take(4 - rem));
    }
    let bytes = general_purpose::STANDARD.decode(normalized).ok()?;
    let text = String::from_utf8(bytes).ok()?;
    serde_json::from_str(&text).ok()
}

fn extract_data_order(attrs: &str) -> Option<String> {
    RE_DATA_ORDER
        .captures(attrs)
        .and_then(|c| c.get(1))
        .map(|m| html_unescape(m.as_str()))
}

fn clean_html_text(html: &str) -> String {
    let no_tags = RE_TAGS.replace_all(html, " ");
    html_unescape(&no_tags)
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn first_u32(s: &str) -> Option<u32> {
    s.split(|c: char| !c.is_ascii_digit())
        .find(|p| !p.is_empty())
        .and_then(|p| p.parse::<u32>().ok())
}

fn extract_stream_id(details: Option<&Value>) -> Option<String> {
    let id = details?.get("id")?;
    id.as_str()
        .map(|s| s.to_string())
        .or_else(|| id.as_u64().map(|n| n.to_string()))
}

fn extract_href_stream_id(row_html: &str) -> Option<String> {
    RE_ROW_STREAM_HREF.captures(row_html).and_then(|c| {
        c.get(1)
            .or_else(|| c.get(2))
            .map(|m| m.as_str().to_string())
    })
}

fn extract_games(details: Option<&Value>) -> Option<String> {
    let games = details?.get("games")?.as_array()?;
    let names: Vec<String> = games
        .iter()
        .filter_map(|g| g.get("name").and_then(|n| n.as_str()))
        .map(html_unescape)
        .filter(|s| !s.trim().is_empty())
        .collect();
    if names.is_empty() {
        None
    } else {
        Some(names.join(", "))
    }
}

fn tracker_date_to_iso_utc(date: &str) -> Option<String> {
    NaiveDateTime::parse_from_str(date, "%Y-%m-%d %H:%M")
        .ok()
        .map(|naive| {
            Utc.from_utc_datetime(&naive)
                .to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
        })
}

/// Parse flexible time strings. Returns Unix timestamp (seconds).
fn parse_time(s: &str, tz: Option<&str>) -> anyhow::Result<i64> {
    let s = s.trim();
    if s.is_empty() {
        anyhow::bail!("empty");
    }

    // Unix seconds
    if let Ok(n) = s.parse::<i64>() {
        if n > 1_000_000_000 {
            return Ok(n);
        }
    }

    // ISO 8601 with tz
    if let Ok(dt) = DateTime::parse_from_rfc3339(s) {
        return Ok(dt.timestamp());
    }

    // Try RFC-2822 too (some feeds emit "Thu, 16 Apr 2026 05:58:10 GMT")
    if let Ok(dt) = DateTime::parse_from_rfc2822(s) {
        return Ok(dt.timestamp());
    }

    // Trim trailing Z and retry as UTC naive before the generic loop.
    let s_noz = s.trim_end_matches('Z').trim_end_matches('z');

    let formats = [
        "%Y-%m-%d %H:%M:%S",
        "%Y-%m-%d %H:%M",
        "%Y-%m-%dT%H:%M:%S%.f",
        "%Y-%m-%dT%H:%M:%S",
        "%Y-%m-%dT%H:%M",
        "%d.%m.%Y %H:%M:%S",
        "%d.%m.%Y %H:%M",
        "%d/%m/%Y %H:%M:%S",
        "%d/%m/%Y %H:%M",
        "%m/%d/%Y %H:%M:%S",
        "%m/%d/%Y %H:%M",
        "%d %b %Y %H:%M:%S",
        "%d %b %Y %H:%M",
        "%d/%b/%Y %H:%M:%S",
        "%d/%b/%Y %H:%M",
        "%b %d, %Y %H:%M:%S",
        "%b %d, %Y %H:%M",
        "%b %d %Y %H:%M:%S",
        "%b %d %Y %H:%M",
        "%b %d, %Y %I:%M %p",
        "%b %d, %Y %I:%M:%S %p",
    ];
    for f in formats {
        if let Ok(naive) = NaiveDateTime::parse_from_str(s, f) {
            return Ok(naive_to_utc(naive, tz));
        }
        if let Ok(naive) = NaiveDateTime::parse_from_str(s_noz, f) {
            // Had a Z suffix — interpret as UTC regardless of tz hint.
            return Ok(Utc.from_utc_datetime(&naive).timestamp());
        }
    }

    // "HH:MM" — today in local time.
    if let Ok(naive_time) = chrono::NaiveTime::parse_from_str(s, "%H:%M") {
        let today = Local::now().date_naive();
        let naive = NaiveDateTime::new(today, naive_time);
        return Ok(naive_to_utc(naive, tz));
    }

    anyhow::bail!("unrecognized time format: {s}");
}

fn naive_to_utc(naive: NaiveDateTime, tz: Option<&str>) -> i64 {
    let tz_s = tz.unwrap_or("local");
    if tz_s.eq_ignore_ascii_case("utc") {
        Utc.from_utc_datetime(&naive).timestamp()
    } else {
        // local
        let local = Local
            .from_local_datetime(&naive)
            .single()
            .unwrap_or_else(|| {
                // Fallback: treat as UTC on DST ambiguity
                let utc = Utc.from_utc_datetime(&naive);
                utc.with_timezone(&Local)
            });
        local.timestamp()
    }
}

// ---------------------------------------------------------------------------
// Best-effort scraper that pulls stream start-time out of twitchtracker /
// streamscharts / sullygnome pages so the UI only needs a URL.
// ---------------------------------------------------------------------------

/// Regex grabs the first `YYYY-MM-DD HH:MM(:SS)?` or `YYYY-MM-DDTHH:MM(:SS)?`.
static RE_ISO_LIKE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2})?)").unwrap());
/// Meta tag extractor: `<meta property="og:title" content="...">`
static RE_OG_TITLE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r#"<meta[^>]*property=["']og:title["'][^>]*content=["']([^"']+)["']"#).unwrap()
});
static RE_OG_IMAGE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r#"<meta[^>]*property=["']og:image["'][^>]*content=["']([^"']+)["']"#).unwrap()
});
/// `datetime="..."` attributes (streamscharts uses <time datetime>).
static RE_DT_ATTR: Lazy<Regex> = Lazy::new(|| Regex::new(r#"datetime=["']([^"']+)["']"#).unwrap());
/// Human-readable dates like "11 Jun 2026, 17:05" or "11th June 2026 17:05".
static RE_HUMAN_DT: Lazy<Regex> = Lazy::new(|| {
    Regex::new(
        r"(?i)(\d{1,2})(?:st|nd|rd|th)?\s+(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(\d{4}),?\s+(\d{1,2}):(\d{2})",
    )
    .unwrap()
});

/// Multi-service discovery: tries the pasted URL first, then automatically
/// falls back to the other trackers (twitchtracker / streamscharts /
/// sullygnome page / sullygnome API) until one yields a start time.
#[tauri::command]
pub async fn twitch_tracker_fetch(app: AppHandle, url: String) -> Result<TrackerMeta, String> {
    let hint = twitch_parse_url(url.clone());
    let mut errors: Vec<String> = Vec::new();
    let mut base: Option<TrackerMeta> = None;

    match scrape_tracker_page(&app, &url, &hint).await {
        Ok(meta) => {
            if meta.start_time.is_some() {
                return Ok(meta);
            }
            base = Some(meta);
        }
        Err(e) => errors.push(format!("{}: {e}", host_of(&url))),
    }

    if let (Some(u), Some(id)) = (hint.username.clone(), hint.stream_id.clone()) {
        for alt in alternate_source_urls(&u, &id, &url) {
            match scrape_tracker_page(&app, &alt, &hint).await {
                Ok(meta) if meta.start_time.is_some() => return Ok(meta),
                Ok(_) => {}
                Err(e) => errors.push(format!("{}: {e}", host_of(&alt))),
            }
        }
        match fetch_sullygnome_stream_meta(&app, &u, &id).await {
            Ok(meta) if meta.start_time.is_some() => return Ok(meta),
            Ok(_) => {}
            Err(e) => errors.push(format!("sullygnome api: {e}")),
        }
    }

    if let Some(meta) = base {
        return Ok(meta);
    }
    Err(format!(
        "Время старта не найдено ни на одном сервисе (twitchtracker, streamscharts, sullygnome). {}",
        errors.join(" | ")
    ))
}

fn host_of(url: &str) -> String {
    url.split("//")
        .nth(1)
        .and_then(|rest| rest.split('/').next())
        .unwrap_or(url)
        .to_string()
}

fn alternate_source_urls(username: &str, stream_id: &str, original: &str) -> Vec<String> {
    let orig_host = host_of(original);
    [
        format!("https://streamscharts.com/channels/{username}/streams/{stream_id}"),
        format!("https://sullygnome.com/channel/{username}/stream/{stream_id}"),
        format!("https://twitchtracker.com/{username}/streams/{stream_id}"),
    ]
    .into_iter()
    .filter(|u| host_of(u) != orig_host)
    .collect()
}

/// SullyGnome JSON API: exact ISO-UTC start time by stream id (last 90 days).
async fn fetch_sullygnome_stream_meta(
    app: &AppHandle,
    username: &str,
    stream_id: &str,
) -> Result<TrackerMeta, String> {
    let page = fetch_sullygnome_streams(app, username, 1, 100)
        .await
        .map_err(|e| e.message)?;
    let item = page
        .items
        .into_iter()
        .find(|i| i.stream_id.as_deref() == Some(stream_id))
        .ok_or_else(|| "стрим не найден за последние 90 дней".to_string())?;
    let start = item.start_time.or(item.date);
    Ok(TrackerMeta {
        username: Some(username.to_string()),
        stream_id: Some(stream_id.to_string()),
        start_time: start.clone(),
        title: item.title,
        thumbnail: None,
        candidates: start.into_iter().collect(),
    })
}

fn month_num(name: &str) -> Option<u32> {
    let lower = name.to_lowercase();
    let key = lower.get(..3)?;
    Some(match key {
        "jan" => 1,
        "feb" => 2,
        "mar" => 3,
        "apr" => 4,
        "may" => 5,
        "jun" => 6,
        "jul" => 7,
        "aug" => 8,
        "sep" => 9,
        "oct" => 10,
        "nov" => 11,
        "dec" => 12,
        _ => return None,
    })
}

/// Pull every plausible stream-start timestamp out of a tracker page.
fn extract_time_candidates(html: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut push = |v: String| {
        if !out.contains(&v) {
            out.push(v);
        }
    };

    // All tracker sites render raw timestamps in UTC — emit explicit `Z`
    // so the frontend's `new Date()` doesn't misparse them as local time.
    for c in RE_ISO_LIKE.captures_iter(html).take(40) {
        if let Some(m) = c.get(1) {
            let mut v = m.as_str().replace(' ', "T");
            if v.len() == 16 {
                v.push_str(":00");
            }
            v.push('Z');
            push(v);
        }
    }
    for c in RE_DT_ATTR.captures_iter(html).take(40) {
        if let Some(m) = c.get(1) {
            if let Ok(dt) = DateTime::parse_from_rfc3339(m.as_str()) {
                push(
                    dt.with_timezone(&Utc)
                        .format("%Y-%m-%dT%H:%M:%SZ")
                        .to_string(),
                );
            }
        }
    }
    for c in RE_HUMAN_DT.captures_iter(html).take(40) {
        let (Some(d), Some(mon), Some(y), Some(h), Some(min)) =
            (c.get(1), c.get(2), c.get(3), c.get(4), c.get(5))
        else {
            continue;
        };
        let Some(month) = month_num(mon.as_str()) else {
            continue;
        };
        let (Ok(d), Ok(y), Ok(h), Ok(min)) = (
            d.as_str().parse::<u32>(),
            y.as_str().parse::<u32>(),
            h.as_str().parse::<u32>(),
            min.as_str().parse::<u32>(),
        ) else {
            continue;
        };
        push(format!("{y:04}-{month:02}-{d:02}T{h:02}:{min:02}:00Z"));
    }
    out.truncate(12);
    out
}

/// A tracker request that never reached usable content.
struct PlainFetchError {
    message: String,
    /// Cloudflare stood in the way — the WebView solver is worth a try.
    blocked: bool,
    /// 0 when the request never got a response at all.
    status: u16,
}

impl PlainFetchError {
    fn plain(message: impl Into<String>, status: u16) -> Self {
        Self {
            message: message.into(),
            blocked: false,
            status,
        }
    }

    fn blocked(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            blocked: true,
            status: 403,
        }
    }
}

fn tracker_http_client(timeout_secs: u64) -> Result<reqwest::Client, PlainFetchError> {
    reqwest::Client::builder()
        .user_agent(cf_scrape::BROWSER_UA)
        .timeout(Duration::from_secs(timeout_secs))
        .build()
        .map_err(|e| PlainFetchError::plain(format!("не удалось подготовить HTTP-клиент: {e}"), 0))
}

async fn fetch_body_plain(url: &str) -> Result<String, PlainFetchError> {
    let client = tracker_http_client(15)?;
    let request = client
        .get(url)
        .header(
            "Accept",
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        )
        .header("Accept-Language", "en-US,en;q=0.9");
    let resp = request.send().await.map_err(|e| {
        let msg = if e.is_timeout() || e.is_connect() {
            "ошибка сети".to_string()
        } else {
            format!("запрос не удался: {e}")
        };
        PlainFetchError::plain(msg, 0)
    })?;

    let status = resp.status();
    let cf_mitigated = resp.headers().contains_key("cf-mitigated");
    let body = resp
        .text()
        .await
        .map_err(|e| PlainFetchError::plain(format!("не удалось прочитать ответ: {e}"), 0))?;

    if cf_mitigated || is_cloudflare_challenge_html(&body) {
        return Err(PlainFetchError::blocked("закрыт Cloudflare-проверкой"));
    }
    if !status.is_success() {
        return Err(PlainFetchError::plain(
            format!("HTTP {status}"),
            status.as_u16(),
        ));
    }
    Ok(body)
}

/// Plain HTTP first — instant whenever Cloudflare is not challenging — then the
/// hidden WebView, which is slow but is the only thing that actually passes the
/// challenge.
async fn fetch_tracker_html(app: &AppHandle, url: &str) -> Result<String, PlainFetchError> {
    match fetch_body_plain(url).await {
        Ok(body) => Ok(body),
        Err(err) if err.blocked => {
            if let Some(source) = source_progress::source_for_url(url) {
                source_progress::emit(app, source, Stage::Cloudflare, None);
            }
            // Re-fetch the page's own source once the challenge is cleared:
            // the rendered DOM is useless to the parser, TwitchTracker's script
            // deletes `meta#ecs` (the stream ids) before it fills the row links.
            solved_or_blocked(cf_scrape::fetch_same_origin(app, url, url).await)
        }
        Err(err) => Err(err),
    }
}

/// Same as [`fetch_tracker_html`] for JSON endpoints: the WebView downloads
/// `application/json` instead of rendering it, so the fallback loads `page_url`
/// to clear the challenge and fetches `api_url` from that origin.
async fn fetch_tracker_json(
    app: &AppHandle,
    page_url: &str,
    api_url: &str,
) -> Result<String, PlainFetchError> {
    match fetch_body_plain(api_url).await {
        Ok(body) => Ok(body),
        Err(err) if err.blocked => {
            solved_or_blocked(cf_scrape::fetch_same_origin(app, page_url, api_url).await)
        }
        Err(err) => Err(err),
    }
}

fn solved_or_blocked(result: Result<String, String>) -> Result<String, PlainFetchError> {
    match result {
        Ok(body) if !is_cloudflare_challenge_html(&body) => Ok(body),
        Ok(_) => Err(PlainFetchError::blocked(
            "закрыт Cloudflare-проверкой (WebView её не прошёл)",
        )),
        Err(e) => Err(PlainFetchError::blocked(format!(
            "закрыт Cloudflare-проверкой, обход не удался: {e}"
        ))),
    }
}

async fn scrape_tracker_page(
    app: &AppHandle,
    url: &str,
    hint: &TwitchHint,
) -> Result<TrackerMeta, String> {
    let html = fetch_tracker_html(app, url).await.map_err(|e| e.message)?;
    Ok(parse_tracker_meta(&html, hint))
}

fn parse_tracker_meta(html: &str, hint: &TwitchHint) -> TrackerMeta {
    let candidates = extract_time_candidates(html);
    let start_time = candidates.first().cloned();
    let title = RE_OG_TITLE
        .captures(html)
        .and_then(|c| c.get(1))
        .map(|m| html_unescape(m.as_str()));
    let thumbnail = RE_OG_IMAGE
        .captures(html)
        .and_then(|c| c.get(1))
        .map(|m| m.as_str().to_string());

    TrackerMeta {
        username: hint.username.clone(),
        stream_id: hint.stream_id.clone(),
        start_time,
        title,
        thumbnail,
        candidates,
    }
}

/// Deliberately does not test for `challenge-platform`: Cloudflare injects that
/// script into ordinary pages too, so it flags served content as a challenge.
fn is_cloudflare_challenge_html(html: &str) -> bool {
    let html = html.to_lowercase();
    // Cloudflare localises every visible string on the interstitial, so match on
    // its config object and markup ids rather than the English wording.
    html.contains("_cf_chl_opt")
        || html.contains("challenge-error-text")
        || html.contains("cf-browser-verification")
        || html.contains("just a moment")
        || html.contains("checking your browser")
        || html.contains(r#"id="challenge-running""#)
        || html.contains(r#"id="challenge-form""#)
}

/// Minimal HTML entity decoder for the few entities og:title usually has.
fn html_unescape(s: &str) -> String {
    s.replace("&amp;", "&")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&apos;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
}

#[cfg(test)]
mod tests {
    use super::{
        is_cloudflare_challenge_html, parse_sullygnome_channel_id, parse_sullygnome_streams_json,
        should_fallback_twitchtracker_streams, twitch_parse_url, StreamsLookupError,
    };

    #[test]
    fn cloudflare_interstitial_is_detected_in_any_language() {
        // Cloudflare serves the interstitial in the browser's language, so the
        // English wording is never a reliable marker — `_cf_chl_opt` is.
        let ru = r#"<html><head><title>Один момент…</title></head><body>
            <script>window._cf_chl_opt = {cvId: "3"};</script></body></html>"#;
        assert!(is_cloudflare_challenge_html(ru));
    }

    #[test]
    fn served_pages_carrying_the_cloudflare_probe_script_are_not_challenges() {
        // Cloudflare injects challenge-platform/jsd into ordinary responses too;
        // treating that as a challenge would reject every page we ask for.
        let served = r#"<html><head><title>rachelr - Twitch statistics</title>
            <script src="/cdn-cgi/challenge-platform/scripts/jsd/main.js"></script>
            </head><body><table id="streams"></table></body></html>"#;
        assert!(!is_cloudflare_challenge_html(served));
    }

    #[test]
    fn parses_sullygnome_page_info_channel_id() {
        let html = r#"
          <script>
            var PageInfo = {"id":10459094,"name":"cutierover","rangeInfo":{"dayRange":90}};
          </script>
        "#;

        assert_eq!(parse_sullygnome_channel_id(html).unwrap(), 10_459_094);
    }

    #[test]
    fn parses_sullygnome_streams_json_into_tracker_items() {
        let body = r#"{
          "draw": 1,
          "recordsTotal": 17,
          "recordsFiltered": 17,
          "data": [{
            "starttime": "Sunday 24th May 2026 12:16",
            "length": 419,
            "gamesplayed": "IRL|Travel_and_outdoors|https://static-cdn.jtvnw.net/box.jpg|Just Chatting|Just_Chatting|https://static-cdn.jtvnw.net/chat.jpg",
            "startDateTime": "2026-05-24T12:16:15Z",
            "streamId": 316083496533,
            "streamUrl": "https://sullygnome.com/channel/stream/316083496533"
          }]
        }"#;

        let page = parse_sullygnome_streams_json("cutierover", 1, 5, body).unwrap();
        assert_eq!(page.username, "cutierover");
        assert_eq!(page.total, 17);
        assert_eq!(page.items.len(), 1);

        let item = &page.items[0];
        assert_eq!(item.stream_id.as_deref(), Some("316083496533"));
        assert_eq!(item.start_time.as_deref(), Some("2026-05-24T12:16:15Z"));
        assert_eq!(item.duration_minutes, Some(419));
        assert_eq!(item.game.as_deref(), Some("IRL, Just Chatting"));
        assert_eq!(
            item.url.as_deref(),
            Some("https://sullygnome.com/channel/stream/316083496533")
        );
    }

    #[test]
    fn twitchtracker_403_is_fallback_worthy_but_not_found_is_not() {
        let blocked = StreamsLookupError::new(
            "TwitchTracker вернул HTTP 403 Forbidden.",
            Some("HTTP 403 for https://twitchtracker.com/x/streams".to_string()),
        );
        assert!(should_fallback_twitchtracker_streams(&blocked));

        let not_found = StreamsLookupError::new("Стример не найден на TwitchTracker.", None);
        assert!(!should_fallback_twitchtracker_streams(&not_found));
    }

    #[test]
    fn parses_sullygnome_stream_url_without_username() {
        let hint =
            twitch_parse_url("https://sullygnome.com/channel/stream/316083496533".to_string());
        assert_eq!(hint.source, "sullygnome");
        assert_eq!(hint.username, None);
        assert_eq!(hint.stream_id.as_deref(), Some("316083496533"));
    }
}

#[derive(Debug, Serialize)]
pub struct TwitchTokenStatus {
    pub login: Option<String>,
    pub expires_in: Option<i64>,
}

/// Checks the saved auth-token against Twitch before a 1440p download: without
/// a valid one Twitch quietly serves 1080p, and the user only finds out later.
#[tauri::command]
pub async fn twitch_validate_auth_token(
    token: String,
    proxy: Option<crate::proxy::ProxyConfig>,
) -> Result<TwitchTokenStatus, String> {
    let token = token.trim().trim_start_matches("OAuth ").trim();
    if token.is_empty() {
        return Err("Нет Twitch auth-token. Добавь его в Настройках → Интеграции.".to_string());
    }
    let mut builder = reqwest::Client::builder().timeout(Duration::from_secs(10));
    let proxy_url = match proxy.as_ref() {
        Some(proxy) => proxy.effective(),
        None => crate::proxy::system_proxy(),
    };
    if let Some(proxy_url) = proxy_url {
        builder = builder.proxy(
            reqwest::Proxy::all(&proxy_url).map_err(|e| format!("Некорректный прокси: {e}"))?,
        );
    }
    let client = builder
        .build()
        .map_err(|e| format!("Не удалось подготовить HTTP-клиент Twitch: {e}"))?;
    let response = client
        .get("https://id.twitch.tv/oauth2/validate")
        .header("Authorization", format!("OAuth {token}"))
        .send()
        .await
        .map_err(|e| format!("Не удалось проверить Twitch auth-token: {e}"))?;
    let status = response.status();
    if status == reqwest::StatusCode::UNAUTHORIZED {
        return Err("Twitch auth-token недействителен или истёк. Обнови его в Настройках → Интеграции.".to_string());
    }
    if !status.is_success() {
        return Err(format!("Twitch не подтвердил auth-token (HTTP {}).", status.as_u16()));
    }
    let body: Value = response
        .json()
        .await
        .map_err(|e| format!("Не удалось прочитать ответ Twitch: {e}"))?;
    Ok(TwitchTokenStatus {
        login: body.get("login").and_then(Value::as_str).map(str::to_string),
        expires_in: body.get("expires_in").and_then(Value::as_i64),
    })
}
