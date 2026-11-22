use std::time::Duration;

use chrono::Utc;
use serde::Serialize;
use serde_json::{json, Value};

use crate::jobs::types::{DownloadKind, Job, JobKind, Mode};

const TELEMETRY_ATTEMPTS: usize = 3;
const HOUR_MS: i64 = 3_600_000;

#[derive(Debug, Serialize)]
struct TelemetryEnvelope {
    event_type: String,
    app_version: String,
    channel: String,
    /// Launches only: a random id that changes every month and is not derived
    /// from the machine id. Download events carry no id at all.
    #[serde(skip_serializing_if = "Option::is_none")]
    telemetry_id: Option<String>,
    sent_at: String,
    payload: Value,
}

pub fn track_app_launch() {
    if !crate::privacy::statistics_allowed() {
        return;
    }
    tauri::async_runtime::spawn(async move {
        let identity = identity::current();
        let payload = if identity.first_run_unsent {
            json!({ "first_run": true })
        } else {
            json!({})
        };
        if send_event("app_launch", Some(identity.id), payload).await {
            identity::mark_first_run_sent();
        }
        resend_outbox().await;
    });
}

/// Statistics were switched off: nothing is left to link or to send later.
pub fn forget_local_state() {
    identity::forget();
    outbox::clear();
}

pub fn track_download_completed(job: Job) {
    // A chat export or a mute pass over a local file is not a downloaded stream.
    if matches!(job.spec.job_kind, Some(JobKind::Chat | JobKind::FetchrMute)) {
        return;
    }
    if !crate::privacy::statistics_allowed() {
        return;
    }

    tauri::async_runtime::spawn(async move {
        let payload = json!({
            "job_id": job.id.clone(),
            "job_kind": job_kind_label(job.spec.job_kind),
            "media_seconds": media_seconds(&job),
            "platform": platform_for_job(&job),
            "streamer": streamer_for_job(&job),
            "mode": mode_label(job.spec.mode),
            "download_kind": download_kind_label(job.spec.download_kind.unwrap_or(DownloadKind::Video)),
            "source_url_hint": source_url_hint(&job.spec.url),
            "chat_source_url_hint": job.spec.chat_source_url.as_deref().and_then(source_url_hint),
            "title": job.spec.meta.title.clone(),
            "thumbnail": job.spec.meta.thumbnail.clone(),
            "output_bytes": output_bytes(&job),
            "download_elapsed_ms": job.progress.download_elapsed_ms,
            "created_at": to_hour(job.created_at),
            "started_at": job.started_at.map(to_hour),
            "finished_at": job.finished_at.map(to_hour),
        });
        send_event("stream_downloaded", None, payload).await;
    });
}

/// Every finished or failed job (cancels excluded), with the options it used,
/// so the dashboard can rank features. No URL, no title, no id.
pub fn track_job_finished(job: Job, failed: bool) {
    if !crate::privacy::statistics_allowed() {
        return;
    }
    tauri::async_runtime::spawn(async move {
        let payload = json!({
            "job_id": job.id.clone(),
            "job_kind": job_kind_label(job.spec.job_kind),
            "outcome": if failed { "error" } else { "done" },
            "platform": platform_for_job(&job),
            "mode": mode_label(job.spec.mode),
            "download_kind": download_kind_label(job.spec.download_kind.unwrap_or(DownloadKind::Video)),
            "features": job_features(&job),
            "quality_height": job.spec.quality_height,
            "media_seconds": media_seconds(&job),
        });
        send_event("job_finished", None, payload).await;
    });
}

fn job_features(job: &Job) -> Vec<&'static str> {
    let spec = &job.spec;
    let chat_render = spec
        .chat_overlay
        .as_ref()
        .and_then(|overlay| overlay.enabled)
        .unwrap_or(false);
    [
        (!spec.fragments.is_empty(), "fragments"),
        (spec.split, "split"),
        (chat_render, "chat_render"),
        (spec.record_chat_separate, "chat_separate"),
        (!spec.blur_zones.is_empty(), "sponsor_blur"),
        (spec.fetchr_mute_enabled || matches!(spec.job_kind, Some(JobKind::FetchrMute)), "fetchr_mute"),
        (spec.vocal_remover_enabled, "vocal_remover"),
        (spec.unmute_video, "unmute"),
        (spec.proxy.enabled, "proxy"),
        (matches!(spec.download_kind, Some(DownloadKind::Audio)), "audio"),
        (matches!(spec.mode, Mode::Live), "live"),
        (matches!(spec.job_kind, Some(JobKind::VpsDownload)), "vps"),
        (spec.twitch_auth_token.as_deref().is_some_and(|token| !token.is_empty()), "twitch_auth"),
    ]
    .into_iter()
    .filter_map(|(used, name)| used.then_some(name))
    .collect()
}

/// Screens the frontend reports; anything else is ignored.
const SCREENS: &[&str] = &[
    "home", "queue", "logs", "settings", "finder", "chat_render", "presets", "sponsor_blur",
    "fetchr_mute", "vocal_remover", "live_recorder", "vps_recorder",
];
const SCREEN_FLUSH_EVERY: Duration = Duration::from_secs(10 * 60);
const SCREEN_FLUSH_AT: u32 = 40;

/// Screen opens are counted locally and sent as one `screen_views` event
/// every few minutes, not one request per click.
#[tauri::command]
pub fn track_screen(screen: String) {
    if !crate::privacy::statistics_allowed() || !SCREENS.contains(&screen.as_str()) {
        return;
    }
    if let Some(counts) = screens::record(&screen, SCREEN_FLUSH_EVERY, SCREEN_FLUSH_AT) {
        tauri::async_runtime::spawn(async move {
            send_event("screen_views", None, json!({ "counts": counts })).await;
        });
    }
}

mod screens {
    use std::collections::BTreeMap;
    use std::time::{Duration, Instant};

    use parking_lot::Mutex;

    struct Pending {
        counts: BTreeMap<String, u32>,
        since: Option<Instant>,
    }

    static PENDING: Mutex<Pending> = Mutex::new(Pending { counts: BTreeMap::new(), since: None });

    /// Counts one open; returns the batch to send once it is due.
    pub fn record(screen: &str, every: Duration, at: u32) -> Option<BTreeMap<String, u32>> {
        let mut pending = PENDING.lock();
        *pending.counts.entry(screen.to_string()).or_default() += 1;
        let since = *pending.since.get_or_insert_with(Instant::now);
        let total: u32 = pending.counts.values().sum();
        if total < at && since.elapsed() < every {
            return None;
        }
        pending.since = None;
        Some(std::mem::take(&mut pending.counts))
    }
}

fn to_hour(ms: i64) -> i64 {
    ms - ms.rem_euclid(HOUR_MS)
}

/// True once the server has the event.
async fn send_event(event_type: &str, telemetry_id: Option<String>, payload: Value) -> bool {
    let envelope = TelemetryEnvelope {
        event_type: event_type.to_string(),
        app_version: crate::remote::app_version(),
        channel: crate::remote::APP_CHANNEL.to_string(),
        telemetry_id,
        sent_at: Utc::now().format("%Y-%m-%dT%H:00:00Z").to_string(),
        payload,
    };
    let Ok(envelope) = serde_json::to_value(&envelope) else {
        return false;
    };

    match deliver(&envelope).await {
        Ok(()) => true,
        // A download finished offline (VPN off, API unreachable) used to vanish
        // from the site counter; keep it and resend on the next launch. The
        // server de-duplicates by machine + job, so a resend never counts twice.
        Err(err) if event_type == "stream_downloaded" => {
            tracing::warn!("Telemetry `{event_type}` queued for resend: {err}");
            outbox::push(&envelope);
            false
        }
        Err(err) => {
            tracing::warn!("Telemetry `{event_type}` was not delivered: {err}");
            false
        }
    }
}

async fn resend_outbox() {
    let mut pending = outbox::take().into_iter();
    while let Some(envelope) = pending.next() {
        if let Err(err) = deliver(&envelope).await {
            tracing::debug!("Telemetry resend failed, keeping the rest: {err}");
            std::iter::once(envelope).chain(pending).for_each(|e| outbox::push(&e));
            return;
        }
    }
}

async fn deliver(envelope: &Value) -> Result<(), String> {
    let url = crate::remote::join_api_url("/telemetry/events")
        .ok_or_else(|| "FETCHR_VPS_API_URL is not configured".to_string())?;
    let client = crate::remote::secure_client(Duration::from_secs(12))
        .map_err(|err| format!("client: {err}"))?;

    let mut last_error = String::from("unknown error");
    for attempt in 1..=TELEMETRY_ATTEMPTS {
        match client.post(&url).json(envelope).send().await {
            Ok(response) => {
                if let Err(err) = crate::remote::verify_tls_pin(&response) {
                    last_error = err;
                } else if response.status().is_success()
                    // 400 will never succeed; resending it would loop forever.
                    || response.status() == reqwest::StatusCode::BAD_REQUEST
                {
                    return Ok(());
                } else {
                    last_error = format!("HTTP {}", response.status());
                }
            }
            Err(err) => last_error = err.to_string(),
        }

        if attempt < TELEMETRY_ATTEMPTS {
            tokio::time::sleep(Duration::from_millis((attempt as u64) * 750)).await;
        }
    }
    Err(last_error)
}

/// Looks for traces of earlier runs. Must run before anything creates them, so
/// first thing at startup. A saved licence is not enough: a revoked key is
/// deleted from disk, and every such user would count as a new install.
pub fn note_earlier_install() {
    identity::note_earlier_install();
}

/// The random id launches carry, and whether this install is still to be
/// counted as new.
mod identity {
    use std::path::PathBuf;
    use std::sync::OnceLock;

    /// Made by running the app, not by the installer, which shares this folder.
    const RUN_TRACES: &[&str] = &["Logs", "temp", "ytdlp-update.stamp"];
    static EARLIER_INSTALL: OnceLock<bool> = OnceLock::new();

    pub fn note_earlier_install() {
        let traces = crate::platform::app_data_dir()
            .is_some_and(|dir| RUN_TRACES.iter().any(|name| dir.join(name).exists()));
        let _ = EARLIER_INSTALL.set(traces || crate::license::stored_license_key().is_some());
    }

    use chrono::Utc;
    use serde::{Deserialize, Serialize};

    #[derive(Clone, Serialize, Deserialize)]
    pub struct Identity {
        pub id: String,
        month: String,
        pub first_run_unsent: bool,
    }

    fn path() -> Option<PathBuf> {
        crate::platform::app_data_dir().map(|dir| dir.join("telemetry-id.json"))
    }

    fn this_month() -> String {
        Utc::now().format("%Y-%m").to_string()
    }

    fn new_id() -> String {
        uuid::Uuid::new_v4().simple().to_string().to_uppercase()
    }

    fn save(identity: &Identity) {
        if let (Some(path), Ok(text)) = (path(), serde_json::to_string(identity)) {
            if let Some(dir) = path.parent() {
                let _ = std::fs::create_dir_all(dir);
            }
            let _ = std::fs::write(path, text);
        }
    }

    fn stored() -> Option<Identity> {
        serde_json::from_str(&std::fs::read_to_string(path()?).ok()?).ok()
    }

    /// The id for this month, replaced when the month has changed.
    pub fn current() -> Identity {
        let month = this_month();
        let identity = match stored() {
            Some(identity) if identity.month == month => return identity,
            Some(identity) => Identity {
                id: new_id(),
                month,
                first_run_unsent: identity.first_run_unsent,
            },
            None => Identity {
                id: new_id(),
                month,
                first_run_unsent: !EARLIER_INSTALL.get().copied().unwrap_or(true),
            },
        };
        save(&identity);
        identity
    }

    pub fn mark_first_run_sent() {
        if let Some(identity) = stored().filter(|identity| identity.first_run_unsent) {
            save(&Identity {
                first_run_unsent: false,
                ..identity
            });
        }
    }

    pub fn forget() {
        if let Some(path) = path() {
            let _ = std::fs::remove_file(path);
        }
    }
}

/// Undelivered download events, one JSON envelope per line.
mod outbox {
    use std::io::Write;
    use std::path::PathBuf;

    use parking_lot::Mutex;
    use serde_json::Value;

    const MAX_EVENTS: usize = 500;
    static LOCK: Mutex<()> = Mutex::new(());

    fn path() -> Option<PathBuf> {
        crate::platform::app_data_dir().map(|dir| dir.join("telemetry-outbox.jsonl"))
    }

    pub fn push(envelope: &Value) {
        let Some(path) = path() else { return };
        let _guard = LOCK.lock();
        let queued = std::fs::read_to_string(&path).map_or(0, |text| text.lines().count());
        if queued >= MAX_EVENTS {
            return;
        }
        if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
            let _ = writeln!(file, "{envelope}");
        }
    }

    pub fn take() -> Vec<Value> {
        let Some(path) = path() else { return Vec::new() };
        let _guard = LOCK.lock();
        let text = std::fs::read_to_string(&path).unwrap_or_default();
        let _ = std::fs::remove_file(&path);
        text.lines().filter_map(|line| serde_json::from_str(line).ok()).map(without_ids).collect()
    }

    pub fn clear() {
        let Some(path) = path() else { return };
        let _guard = LOCK.lock();
        let _ = std::fs::remove_file(path);
    }

    /// Events queued by an older version still hold what is no longer sent.
    fn without_ids(mut envelope: Value) -> Value {
        if let Some(fields) = envelope.as_object_mut() {
            fields.remove("machine_id");
            if let Some(payload) = fields.get_mut("payload").and_then(Value::as_object_mut) {
                payload.remove("url_hash");
            }
        }
        envelope
    }
}

fn job_kind_label(kind: Option<JobKind>) -> &'static str {
    match kind {
        Some(JobKind::VpsDownload) => "vps_download",
        Some(JobKind::Chat) => "chat",
        Some(JobKind::FetchrMute) => "fetchr_mute",
        Some(JobKind::Video) | None => "video",
    }
}

/// Length of what was saved: the picked fragments when the job had any,
/// otherwise the source duration.
fn media_seconds(job: &Job) -> Option<f64> {
    let fragments = &job.spec.fragments;
    if fragments.is_empty() {
        return job.spec.meta.duration.filter(|d| d.is_finite() && *d > 0.0);
    }
    let total: f64 = fragments
        .iter()
        .filter_map(|f| Some(parse_clock(&f.end)? - parse_clock(&f.start)?))
        .filter(|len| *len > 0.0)
        .sum();
    (total > 0.0).then_some(total)
}

/// "1:02:03", "02:03", "123" or "123.5" as seconds.
fn parse_clock(text: &str) -> Option<f64> {
    text.trim()
        .split(':')
        .try_fold(0.0, |acc, part| part.trim().parse::<f64>().ok().map(|n| acc * 60.0 + n))
}

fn platform_for_job(job: &Job) -> String {
    if let Some(platform) = job.spec.meta.platform.as_deref().map(str::trim) {
        if !platform.is_empty() {
            return platform.to_lowercase();
        }
    }

    let lower = format!(
        "{} {}",
        job.spec.url.to_lowercase(),
        job.spec
            .chat_source_url
            .as_deref()
            .unwrap_or("")
            .to_lowercase()
    );
    if lower.contains("twitch.tv") {
        "twitch".to_string()
    } else if lower.contains("kick.com") {
        "kick".to_string()
    } else if lower.contains("youtube.com") || lower.contains("youtu.be") {
        "youtube".to_string()
    } else if lower.contains("vkvideo.ru") || lower.contains("vk.com") || lower.contains("vkplay") {
        "vk".to_string()
    } else if lower.contains("rutube.ru") {
        "rutube".to_string()
    } else if lower.contains("trovo.live") {
        "trovo".to_string()
    } else if lower.starts_with("rtmp://") || lower.starts_with("rtmps://") {
        "rtmp".to_string()
    } else if lower.contains(".mpd") {
        "dash".to_string()
    } else if lower.contains("ttvnw.net")
        || lower.contains("jtvnw.net")
        || lower.contains("twitchcdn.net")
        || lower.contains("cloudfront.net") && parse_streamer_from_url(&job.spec.url).is_some()
    {
        "twitch".to_string()
    } else if lower.contains(".m3u8") {
        "hls".to_string()
    } else {
        "unknown".to_string()
    }
}

fn streamer_for_job(job: &Job) -> Option<String> {
    if let Some(uploader) = job.spec.meta.uploader.as_deref().map(str::trim) {
        if !uploader.is_empty() {
            return Some(uploader.trim_start_matches('@').to_string());
        }
    }

    parse_streamer_from_url(&job.spec.url).or_else(|| {
        job.spec
            .chat_source_url
            .as_deref()
            .and_then(parse_streamer_from_url)
    })
}

fn parse_streamer_from_url(input: &str) -> Option<String> {
    parse_streamer_from_url_inner(input, 0)
}

fn parse_streamer_from_url_inner(input: &str, depth: usize) -> Option<String> {
    if depth > 2 {
        return None;
    }

    let parsed = url::Url::parse(input).ok()?;
    let host = parsed.host_str()?.to_lowercase();
    for (_, value) in parsed.query_pairs() {
        let value = value.trim();
        if value.starts_with("http://") || value.starts_with("https://") {
            if let Some(streamer) = parse_streamer_from_url_inner(value, depth + 1) {
                return Some(streamer);
            }
        }
    }

    if host.contains("twitch.tv") {
        let first = first_path_segment(&parsed)?;
        if matches!(first, "videos" | "video" | "v" | "clip" | "directory") {
            return None;
        }
        return clean_streamer_name(first);
    }

    if host.contains("kick.com") {
        let first = first_path_segment(&parsed)?;
        if matches!(first, "video" | "categories") {
            return None;
        }
        return clean_streamer_name(first);
    }

    if host.contains("youtube.com") || host.contains("youtu.be") {
        let first = first_path_segment(&parsed)?;
        if let Some(handle) = first.strip_prefix('@') {
            return clean_streamer_name(handle);
        }
        if matches!(first, "c" | "channel" | "user") {
            return parsed
                .path_segments()
                .and_then(|mut segments| segments.nth(1))
                .and_then(clean_streamer_name);
        }
    }

    if host.contains("vkvideo.ru") || host.contains("vk.com") || host.contains("vkplay") {
        let first = first_path_segment(&parsed)?;
        if matches!(first, "video" | "clips" | "feed" | "search") {
            return None;
        }
        return clean_streamer_name(first);
    }

    if host.contains("rutube.ru") {
        let segments: Vec<&str> = parsed.path_segments()?.collect();
        if segments.first().copied() == Some("channel") || segments.first().copied() == Some("u") {
            return segments
                .get(1)
                .and_then(|segment| clean_streamer_name(segment));
        }
    }

    if host.contains("trovo.live") {
        let first = first_path_segment(&parsed)?;
        if matches!(first, "video" | "category" | "clip") {
            return None;
        }
        return clean_streamer_name(first);
    }

    if host.contains("usher.ttvnw.net") {
        let mut segments = parsed.path_segments()?;
        let first = segments.next()?;
        if first == "api" && segments.next() == Some("channel") && segments.next() == Some("hls") {
            return segments
                .next()
                .and_then(|segment| segment.strip_suffix(".m3u8").or(Some(segment)))
                .and_then(clean_streamer_name);
        }
    }

    if input.to_lowercase().contains(".m3u8")
        || host.contains("ttvnw.net")
        || host.contains("jtvnw.net")
        || host.contains("twitchcdn.net")
        || host.contains("cloudfront.net")
    {
        for segment in parsed.path_segments()? {
            if let Some(streamer) = parse_twitch_vod_segment(segment) {
                return Some(streamer);
            }
        }
    }

    None
}

fn first_path_segment(parsed: &url::Url) -> Option<&str> {
    let first = parsed.path_segments()?.next()?.trim();
    if first.is_empty() {
        None
    } else {
        Some(first)
    }
}

fn parse_twitch_vod_segment(segment: &str) -> Option<String> {
    let parts: Vec<&str> = segment.split('_').collect();
    if parts.len() < 4 {
        return None;
    }

    let candidate = parts.get(1)?.trim();
    if candidate.is_empty()
        || candidate
            .chars()
            .any(|ch| !(ch.is_ascii_alphanumeric() || ch == '_'))
    {
        return None;
    }

    clean_streamer_name(candidate)
}

fn clean_streamer_name(value: &str) -> Option<String> {
    let value = value
        .trim()
        .trim_start_matches('@')
        .trim_end_matches(".m3u8")
        .trim();
    if value.is_empty() {
        None
    } else {
        Some(value.to_string())
    }
}

fn source_url_hint(input: &str) -> Option<String> {
    let parsed = url::Url::parse(input).ok()?;
    Some(format!(
        "{}://{}{}",
        parsed.scheme(),
        parsed.host_str()?,
        parsed.path()
    ))
}

fn output_bytes(job: &Job) -> Option<u64> {
    job.output_path
        .as_deref()
        .and_then(|path| std::fs::metadata(path).ok())
        .map(|meta| meta.len())
        .or(job.progress.total_bytes)
        .or(job.progress.downloaded_bytes)
}

fn mode_label(mode: Mode) -> &'static str {
    match mode {
        Mode::Vod => "vod",
        Mode::Live => "live",
    }
}

fn download_kind_label(kind: DownloadKind) -> &'static str {
    match kind {
        DownloadKind::Video => "video",
        DownloadKind::Audio => "audio",
    }
}
