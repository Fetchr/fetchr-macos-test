//! Commands for the VPS recorder agent (recording control, clips, downloads).

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

use crate::jobs::types::{
    BlurZone, ChatOverlaySettings, DownloadKind, FetchrMuteSettings, Job, JobKind, JobSpec, Mode,
    PerformanceSettings, VpsDownloadSpec,
};
use crate::AppState;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct VpsConfig {
    /// SSH host of the recorder. Everything else is derived from it: the app
    /// reaches the agent through a tunnel, not through a public address.
    #[serde(default)]
    pub host: String,
    #[serde(default = "default_ssh_port")]
    pub ssh_port: u16,
    #[serde(default = "default_ssh_user")]
    pub user: String,
    #[serde(default = "default_agent_port")]
    pub agent_port: u16,
    #[serde(default)]
    pub token: String,
    /// SHA256 of the server's SSH key, pinned on the first connection.
    #[serde(default)]
    pub host_key_fingerprint: String,
    /// Private key used instead of a password when the server refuses password
    /// auth — the default on current Ubuntu cloud images.
    #[serde(default)]
    pub key_path: Option<String>,
    /// Escape hatch for an agent already published behind https. Empty in the
    /// normal SSH-tunnel setup.
    #[serde(default)]
    pub base_url: String,
}

fn default_ssh_port() -> u16 {
    22
}

fn default_ssh_user() -> String {
    "root".to_string()
}

fn default_agent_port() -> u16 {
    8484
}

impl VpsConfig {
    fn ssh_target(&self) -> crate::vps_ssh::SshTarget {
        crate::vps_ssh::SshTarget {
            host: self.host.clone(),
            port: self.ssh_port,
            user: self.user.clone(),
        }
    }

    fn fingerprint(&self) -> Option<String> {
        Some(self.host_key_fingerprint.clone()).filter(|value| !value.is_empty())
    }

    /// Rebuild the credential for a reconnect: the keyring holds either the
    /// password or the key's passphrase, depending on which was configured.
    fn credential(&self, secret: String) -> crate::vps_ssh::Credential {
        match self
            .key_path
            .as_deref()
            .filter(|path| !path.trim().is_empty())
        {
            Some(path) => crate::vps_ssh::Credential::Key {
                path: path.to_string(),
                passphrase: Some(secret).filter(|value| !value.is_empty()),
            },
            None => crate::vps_ssh::Credential::Password(secret),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VpsClipMeta {
    pub id: String,
    pub channel: Option<String>,
    pub session: Option<String>,
    pub label: Option<String>,
    #[serde(default)]
    pub note: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    pub start: f64,
    pub end: f64,
    pub duration: f64,
    pub created_at: f64,
    pub video_size: u64,
    pub chat_messages: usize,
    #[serde(default)]
    pub recording_started_at: Option<f64>,
    #[serde(default)]
    pub absolute_start_at: Option<f64>,
}

fn config_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("create app data dir: {e}"))?;
    Ok(dir.join("vps-config.json"))
}

fn load_config(app: &AppHandle) -> VpsConfig {
    config_path(app)
        .ok()
        .and_then(|p| std::fs::read(&p).ok())
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_else(|| VpsConfig {
            ssh_port: default_ssh_port(),
            user: default_ssh_user(),
            agent_port: default_agent_port(),
            ..Default::default()
        })
}

/// Where the agent answers right now. Normally the SSH tunnel; the legacy
/// `base_url` only applies when the user pointed the app at an agent they
/// published themselves.
fn agent_base_url(cfg: &VpsConfig) -> Result<String, String> {
    if let Some(base) = crate::vps_ssh::tunnel_base_url() {
        return Ok(base);
    }
    if !cfg.base_url.is_empty() {
        return Ok(cfg.base_url.trim_end_matches('/').to_string());
    }
    if cfg.host.is_empty() {
        Err("VPS не настроен: укажите адрес сервера, логин и пароль".to_string())
    } else {
        Err("Нет соединения с VPS — подключение разорвано".to_string())
    }
}

/// The token travels in the `X-Token` header on every call, so a plaintext
/// base URL leaks it to anyone on the path. Loopback is exempt: that is the
/// tunnel, and the traffic inside it is already encrypted by SSH.
fn ensure_secure_base_url(base: &str) -> Result<(), String> {
    let parsed = url::Url::parse(base).map_err(|_| format!("Некорректный адрес VPS: {base}"))?;
    if parsed.scheme() == "https" {
        return Ok(());
    }
    let host = parsed.host_str().unwrap_or_default();
    let is_loopback = host == "localhost"
        || host
            .parse::<std::net::IpAddr>()
            .map(|ip| ip.is_loopback())
            .unwrap_or(false);
    if is_loopback {
        return Ok(());
    }
    Err("Адрес VPS должен начинаться с https:// — токен передаётся в заголовке".to_string())
}

fn client_for(app: &AppHandle) -> Result<(reqwest::Client, String, String), String> {
    let (base, token) = request_target(app)?;
    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(10))
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|e| format!("http client: {e}"))?;
    Ok((client, base, token))
}

/// Where requests go right now and with which token: the Fetchr archive when
/// it is the selected source, otherwise the user's own VPS through its tunnel.
fn request_target(app: &AppHandle) -> Result<(String, String), String> {
    let managed = load_managed(app);
    let (base, token) = if managed.active && !managed.base_url.is_empty() {
        let relay = managed.base_url.trim_end_matches('/').to_string();
        ensure_secure_base_url(&relay)?;
        // Straight to the storage server once it has proved reachable; the
        // account server relays otherwise (and caps the speed).
        let base = crate::archive_route::choose(&relay, &managed.token);
        (base, managed.token)
    } else {
        let cfg = load_config(app);
        if cfg.token.is_empty() {
            return Err("VPS не настроен: укажите адрес сервера, логин и пароль".to_string());
        }
        let base = agent_base_url(&cfg)?;
        ensure_secure_base_url(&base)?;
        (base, cfg.token)
    };
    crate::chat_overlay::mirror::set_agent(&base, &token);
    Ok((base, token))
}

async fn parse_err(resp: reqwest::Response, what: &str) -> String {
    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    let detail = serde_json::from_str::<serde_json::Value>(&body)
        .ok()
        .and_then(|v| v.get("detail").and_then(|d| d.as_str()).map(String::from))
        .unwrap_or_else(|| body.chars().take(200).collect());
    format!("{what}: HTTP {status} — {detail}")
}

#[tauri::command]
pub fn vps_get_config(app: AppHandle) -> VpsConfig {
    load_config(&app)
}

fn save_config(app: &AppHandle, config: &VpsConfig) -> Result<(), String> {
    let path = config_path(app)?;
    let bytes = serde_json::to_vec_pretty(config).map_err(|e| e.to_string())?;
    std::fs::write(&path, bytes).map_err(|e| format!("save vps config: {e}"))
}

#[tauri::command]
pub fn vps_set_config(app: AppHandle, config: VpsConfig) -> Result<(), String> {
    save_config(&app, &config)
}

/// Measure what the tunnel actually delivers, by pulling filler from the agent
/// for a few seconds.
///
#[tauri::command]
pub async fn vps_status(app: AppHandle) -> Result<serde_json::Value, String> {
    let (client, base, token) = client_for(&app)?;
    let resp = client
        .get(format!("{base}/status"))
        .header("X-Token", &token)
        .send()
        .await
        .map_err(|e| format!("VPS недоступен: {e}"))?;
    if !resp.status().is_success() {
        return Err(parse_err(resp, "Статус VPS").await);
    }
    resp.json::<serde_json::Value>()
        .await
        .map_err(|e| format!("parse status: {e}"))
}

#[tauri::command]
pub async fn vps_recordings_list(app: AppHandle) -> Result<Vec<serde_json::Value>, String> {
    let (client, base, token) = client_for(&app)?;
    let resp = client
        .get(format!("{base}/recordings"))
        .header("X-Token", &token)
        .send()
        .await
        .map_err(|e| format!("VPS недоступен: {e}"))?;
    if !resp.status().is_success() {
        return Err(parse_err(resp, "Список записей").await);
    }
    resp.json::<Vec<serde_json::Value>>()
        .await
        .map_err(|e| format!("parse recordings: {e}"))
}

#[tauri::command]
pub async fn vps_schedules_list(app: AppHandle) -> Result<Vec<serde_json::Value>, String> {
    let (client, base, token) = client_for(&app)?;
    let resp = client
        .get(format!("{base}/schedules"))
        .header("X-Token", &token)
        .send()
        .await
        .map_err(|e| format!("VPS недоступен: {e}"))?;
    if !resp.status().is_success() {
        return Err(parse_err(resp, "Расписание VPS").await);
    }
    resp.json::<Vec<serde_json::Value>>()
        .await
        .map_err(|e| format!("parse schedules: {e}"))
}

#[tauri::command]
pub async fn vps_schedule_create(
    app: AppHandle,
    channel: String,
    title: Option<String>,
    start_at: f64,
    end_at: Option<f64>,
) -> Result<serde_json::Value, String> {
    let (client, base, token) = client_for(&app)?;
    let resp = client
        .post(format!("{base}/schedules"))
        .header("X-Token", &token)
        .json(&serde_json::json!({
            "channel": channel,
            "title": title,
            "start_at": start_at,
            "end_at": end_at,
        }))
        .send()
        .await
        .map_err(|e| format!("VPS недоступен: {e}"))?;
    if !resp.status().is_success() {
        return Err(parse_err(resp, "Создание расписания").await);
    }
    resp.json::<serde_json::Value>()
        .await
        .map_err(|e| format!("parse schedule: {e}"))
}

#[tauri::command]
pub async fn vps_schedule_delete(app: AppHandle, schedule_id: String) -> Result<(), String> {
    let (client, base, token) = client_for(&app)?;
    let resp = client
        .delete(format!("{base}/schedules/{schedule_id}"))
        .header("X-Token", &token)
        .send()
        .await
        .map_err(|e| format!("VPS недоступен: {e}"))?;
    if !resp.status().is_success() {
        return Err(parse_err(resp, "Отмена расписания").await);
    }
    Ok(())
}

/// Media URL for a `<video>`/HLS element. The token has to ride in the query
/// string because the player cannot send an `X-Token` header; over the tunnel
/// that URL never leaves the machine.
fn media_url(app: &AppHandle, path: &str) -> Result<String, String> {
    let (base, token) = request_target(app)?;
    let separator = if path.contains('?') { '&' } else { '?' };
    Ok(format!(
        "{base}{path}{separator}token={}",
        urlencoding::encode(&token)
    ))
}

#[tauri::command]
pub fn vps_recording_preview_url(app: AppHandle, session: String) -> Result<String, String> {
    media_url(
        &app,
        &format!(
            "/recordings/{}/playlist.m3u8",
            urlencoding::encode(&session)
        ),
    )
}

#[tauri::command]
pub fn vps_clip_preview_url(app: AppHandle, clip_id: String) -> Result<String, String> {
    media_url(
        &app,
        &format!("/clips/{}/video.mp4", urlencoding::encode(&clip_id)),
    )
}

#[tauri::command]
pub fn vps_recording_poster_url(
    app: AppHandle,
    session: String,
    at: f64,
) -> Result<String, String> {
    media_url(
        &app,
        &format!(
            "/recordings/{}/poster.jpg?at={:.0}",
            urlencoding::encode(&session),
            at.max(0.0)
        ),
    )
}

#[tauri::command]
pub fn vps_clip_poster_url(app: AppHandle, clip_id: String) -> Result<String, String> {
    media_url(
        &app,
        &format!("/clips/{}/poster.jpg", urlencoding::encode(&clip_id)),
    )
}

#[tauri::command]
pub async fn vps_clip_set_keep(
    app: AppHandle,
    clip_id: String,
    keep: bool,
) -> Result<serde_json::Value, String> {
    let (client, base, token) = client_for(&app)?;
    let resp = client
        .post(format!("{base}/clips/{clip_id}/keep"))
        .header("X-Token", &token)
        .json(&serde_json::json!({ "keep": keep }))
        .send()
        .await
        .map_err(|e| format!("VPS недоступен: {e}"))?;
    if !resp.status().is_success() {
        return Err(parse_err(resp, "Закрепление клипа").await);
    }
    resp.json::<serde_json::Value>()
        .await
        .map_err(|e| format!("parse clip: {e}"))
}

/// Chat captured alongside a recording, timestamped on the session timeline.
///
/// The agent only resolves Twitch's own emotes (it has the IRC `emotes` tag and
/// nothing else). BTTV, FFZ and 7TV are word-substitutions that need the
/// channel's emote sets, so they are applied here, reusing the same index the
/// chat renderer builds — no second implementation to keep in sync.
#[tauri::command]
pub async fn vps_recording_chat(
    state: State<'_, AppState>,
    app: AppHandle,
    session: String,
    channel: Option<String>,
    proxy: Option<crate::proxy::ProxyConfig>,
) -> Result<Vec<serde_json::Value>, String> {
    let (client, base, token) = client_for(&app)?;
    let resp = client
        .get(format!("{base}/recordings/{session}/chat.json"))
        .header("X-Token", &token)
        .send()
        .await
        .map_err(|e| format!("VPS недоступен: {e}"))?;
    if !resp.status().is_success() {
        return Err(parse_err(resp, "Чат записи").await);
    }
    let mut messages = resp
        .json::<Vec<crate::chat_overlay::model::ChatMessage>>()
        .await
        .map_err(|e| format!("parse chat: {e}"))?;

    let login = channel
        .map(|value| value.trim().to_lowercase())
        .unwrap_or_default();
    // W.TV channels have no BTTV/FFZ/7TV sets; their chat arrives as recorded.
    if !messages.is_empty() && !login.is_empty() && vps_channel_platform(&login).0 != "wtv" {
        let log_id = format!("vps-chat:{session}");
        // 7TV/BTTV/FFZ are routinely blackholed by DPI, which is exactly why the
        // renderer takes a proxy client as a fallback. Without it the index
        // silently comes back empty and no third-party emote ever appears.
        let (direct, proxied) = crate::chat_overlay::chat_http_clients(&proxy.unwrap_or_default());
        match resolve_vps_emote_channel(&login, &direct, proxied.as_ref()).await {
            Some(resolved) => {
                let settings = crate::chat_overlay::settings::EffectiveChatOverlaySettings::from(
                    crate::jobs::types::ChatOverlaySettings::default(),
                );
                crate::chat_overlay::providers::apply_third_party_emotes(
                    &direct,
                    proxied.as_ref(),
                    &resolved,
                    &settings,
                    &mut messages,
                    &state.queue,
                    &log_id,
                )
                .await;
            }
            None => state.queue.emit_job_log(
                &log_id,
                &format!(
                    "Чат {login}: не удалось определить id канала — эмоуты BTTV/FFZ/7TV пропущены \
                     (проверьте доступ к gql.twitch.tv или включите прокси в настройках)"
                ),
            ),
        }
    }

    messages
        .into_iter()
        .map(|message| serde_json::to_value(message).map_err(|e| format!("encode chat: {e}")))
        .collect()
}

/// BTTV/FFZ/7TV emotes of a channel as a code → fragment map.
///
/// The live chat arrives message by message over IRC, so it substitutes emotes
/// itself from this map rather than asking the backend per line.
#[tauri::command]
pub async fn vps_channel_emotes(
    state: State<'_, AppState>,
    channel: String,
    proxy: Option<crate::proxy::ProxyConfig>,
) -> Result<serde_json::Value, String> {
    let login = channel.trim().to_lowercase();
    if login.is_empty() || vps_channel_platform(&login).0 == "wtv" {
        return Ok(serde_json::json!({}));
    }
    let (direct, proxied) = crate::chat_overlay::chat_http_clients(&proxy.unwrap_or_default());
    let Some(resolved) = resolve_vps_emote_channel(&login, &direct, proxied.as_ref()).await else {
        return Err(format!(
            "Не удалось определить id канала {login} — эмоуты BTTV/FFZ/7TV недоступны"
        ));
    };
    let settings = crate::chat_overlay::settings::EffectiveChatOverlaySettings::from(
        crate::jobs::types::ChatOverlaySettings::default(),
    );
    let map = crate::chat_overlay::providers::third_party_emote_map(
        &direct,
        proxied.as_ref(),
        &resolved,
        &settings,
        &state.queue,
        &format!("vps-live-chat:{login}"),
    )
    .await;
    serde_json::to_value(map).map_err(|e| format!("encode emotes: {e}"))
}

/// A recorder channel is a bare Twitch login or `kick:<slug>` / `wtv:<nick>`.
fn vps_channel_platform(channel: &str) -> (&str, &str) {
    match channel.split_once(':') {
        Some((platform @ ("kick" | "wtv"), name)) => (platform, name),
        _ => ("twitch", channel),
    }
}

/// Page of the channel on its platform — the source a downloaded clip names.
fn vps_channel_url(channel: &str) -> String {
    match vps_channel_platform(channel) {
        ("kick", name) => format!("https://kick.com/{name}"),
        ("wtv", name) => format!("https://w.tv/{name}"),
        (_, name) => format!("https://www.twitch.tv/{name}"),
    }
}

/// The channel whose 7TV/BTTV/FFZ sets apply to a recorder chat.
async fn resolve_vps_emote_channel(
    channel: &str,
    direct: &reqwest::Client,
    proxied: Option<&reqwest::Client>,
) -> Option<crate::chat_overlay::providers::ResolvedChannel> {
    use crate::chat_overlay::providers::{EmotePlatform, ResolvedChannel};
    match vps_channel_platform(channel) {
        ("kick", slug) => crate::chat_overlay::providers::fetch_kick_user_id(slug)
            .await
            .map(|id| ResolvedChannel { platform: EmotePlatform::Kick, id }),
        ("wtv", _) => None,
        (_, login) => {
            let mut id = crate::chat_overlay::providers::fetch_twitch_user_id(direct, login).await;
            if id.is_none() {
                if let Some(via_proxy) = proxied {
                    id = crate::chat_overlay::providers::fetch_twitch_user_id(via_proxy, login)
                        .await;
                }
            }
            id.map(|id| ResolvedChannel { platform: EmotePlatform::Twitch, id })
        }
    }
}

/// Loudness envelope for the visible slice of a recording's timeline.
#[tauri::command]
pub async fn vps_recording_peaks(
    app: AppHandle,
    session: String,
    start: f64,
    end: f64,
    bins: u32,
) -> Result<serde_json::Value, String> {
    let (client, base, token) = client_for(&app)?;
    let resp = client
        .get(format!("{base}/recordings/{session}/peaks"))
        .query(&[
            ("start", start.to_string()),
            ("end", end.to_string()),
            ("bins", bins.to_string()),
        ])
        .header("X-Token", &token)
        .send()
        .await
        .map_err(|e| format!("VPS недоступен: {e}"))?;
    if !resp.status().is_success() {
        return Err(parse_err(resp, "Осциллограмма").await);
    }
    resp.json::<serde_json::Value>()
        .await
        .map_err(|e| format!("parse peaks: {e}"))
}

#[tauri::command]
pub async fn vps_marker_add(
    app: AppHandle,
    session: String,
    timestamp: f64,
    label: String,
    note: Option<String>,
) -> Result<serde_json::Value, String> {
    let (client, base, token) = client_for(&app)?;
    let resp = client
        .post(format!("{base}/recordings/{session}/markers"))
        .header("X-Token", &token)
        .json(&serde_json::json!({ "timestamp": timestamp, "label": label, "note": note }))
        .send()
        .await
        .map_err(|e| format!("VPS недоступен: {e}"))?;
    if !resp.status().is_success() {
        return Err(parse_err(resp, "Сохранение метки").await);
    }
    resp.json::<serde_json::Value>()
        .await
        .map_err(|e| format!("parse marker: {e}"))
}

#[tauri::command]
pub async fn vps_marker_delete(
    app: AppHandle,
    session: String,
    marker_id: String,
) -> Result<(), String> {
    let (client, base, token) = client_for(&app)?;
    let resp = client
        .delete(format!("{base}/recordings/{session}/markers/{marker_id}"))
        .header("X-Token", &token)
        .send()
        .await
        .map_err(|e| format!("VPS недоступен: {e}"))?;
    if !resp.status().is_success() {
        return Err(parse_err(resp, "Удаление метки").await);
    }
    Ok(())
}

#[tauri::command]
pub async fn vps_session_start(
    app: AppHandle,
    channel: String,
    title: Option<String>,
) -> Result<String, String> {
    let (client, base, token) = client_for(&app)?;
    let resp = client
        .post(format!("{base}/session"))
        .header("X-Token", &token)
        .json(&serde_json::json!({ "channel": channel, "title": title }))
        .send()
        .await
        .map_err(|e| format!("VPS недоступен: {e}"))?;
    if !resp.status().is_success() {
        return Err(parse_err(resp, "Запуск записи").await);
    }
    Ok(channel)
}

#[tauri::command]
/// Drop one watched channel, or every one when `channel` is absent.
pub async fn vps_session_stop(app: AppHandle, channel: Option<String>) -> Result<(), String> {
    let (client, base, token) = client_for(&app)?;
    let url = match channel.as_deref().map(str::trim).filter(|c| !c.is_empty()) {
        Some(one) => format!("{base}/session?channel={}", urlencoding::encode(one)),
        None => format!("{base}/session"),
    };
    let resp = client
        .delete(url)
        .header("X-Token", &token)
        .send()
        .await
        .map_err(|e| format!("VPS недоступен: {e}"))?;
    if !resp.status().is_success() {
        return Err(parse_err(resp, "Остановка записи").await);
    }
    Ok(())
}

#[tauri::command]
pub async fn vps_clip_create(
    app: AppHandle,
    session: Option<String>,
    start: f64,
    end: f64,
    label: Option<String>,
    note: Option<String>,
    tags: Option<Vec<String>>,
    accurate: Option<bool>,
) -> Result<VpsClipMeta, String> {
    let (client, base, token) = client_for(&app)?;
    // An hour-long clip off the storage disk takes minutes; the client's
    // default 120 s would report a failure while the server finishes the job.
    let resp = client
        .post(format!("{base}/clips"))
        .timeout(std::time::Duration::from_secs(35 * 60))
        .header("X-Token", &token)
        .json(&serde_json::json!({
            "start": start,
            "end": end,
            "session": session,
            "label": label,
            "note": note,
            "tags": tags.unwrap_or_default(),
            "accurate": accurate.unwrap_or(false),
        }))
        .send()
        .await
        .map_err(|e| format!("VPS недоступен: {e}"))?;
    if !resp.status().is_success() {
        return Err(parse_err(resp, "Нарезка отрезка").await);
    }
    resp.json::<VpsClipMeta>()
        .await
        .map_err(|e| format!("parse clip: {e}"))
}

#[tauri::command]
pub async fn vps_clips_list(app: AppHandle) -> Result<Vec<VpsClipMeta>, String> {
    let (client, base, token) = client_for(&app)?;
    let resp = client
        .get(format!("{base}/clips"))
        .header("X-Token", &token)
        .send()
        .await
        .map_err(|e| format!("VPS недоступен: {e}"))?;
    if !resp.status().is_success() {
        return Err(parse_err(resp, "Список клипов").await);
    }
    resp.json::<Vec<VpsClipMeta>>()
        .await
        .map_err(|e| format!("parse clips: {e}"))
}

#[tauri::command]
pub async fn vps_clip_delete(app: AppHandle, clip_id: String) -> Result<(), String> {
    let (client, base, token) = client_for(&app)?;
    let resp = client
        .delete(format!("{base}/clips/{clip_id}"))
        .header("X-Token", &token)
        .send()
        .await
        .map_err(|e| format!("VPS недоступен: {e}"))?;
    if !resp.status().is_success() {
        return Err(parse_err(resp, "Удаление клипа").await);
    }
    Ok(())
}

/// Delete one recording from the VPS. Returns the bytes freed.
#[tauri::command]
pub async fn vps_recording_delete(app: AppHandle, session: String) -> Result<u64, String> {
    let (client, base, token) = client_for(&app)?;
    let resp = client
        .delete(format!("{base}/recordings/{session}"))
        .header("X-Token", &token)
        .send()
        .await
        .map_err(|e| format!("VPS недоступен: {e}"))?;
    if !resp.status().is_success() {
        return Err(parse_err(resp, "Удаление записи").await);
    }
    let body: serde_json::Value = resp.json().await.map_err(|e| format!("parse: {e}"))?;
    Ok(body
        .get("freed_bytes")
        .and_then(|v| v.as_u64())
        .unwrap_or(0))
}

/// Clear the VPS recording buffer (and clips when `with_clips`), returns freed bytes.
#[tauri::command]
pub async fn vps_buffer_clear(app: AppHandle, with_clips: Option<bool>) -> Result<u64, String> {
    let (client, base, token) = client_for(&app)?;
    let clips = if with_clips.unwrap_or(false) { 1 } else { 0 };
    let resp = client
        .delete(format!("{base}/buffer?clips={clips}"))
        .header("X-Token", &token)
        .send()
        .await
        .map_err(|e| format!("VPS недоступен: {e}"))?;
    if !resp.status().is_success() {
        return Err(parse_err(resp, "Очистка VPS").await);
    }
    let body: serde_json::Value = resp.json().await.map_err(|e| format!("parse: {e}"))?;
    Ok(body
        .get("freed_bytes")
        .and_then(|v| v.as_u64())
        .unwrap_or(0))
}

/// Enqueue a queue job that downloads clip video + chat from the VPS.
#[tauri::command]
pub async fn vps_download_clip(
    state: State<'_, AppState>,
    app: AppHandle,
    clip_id: String,
    session: Option<String>,
    name: String,
    directory: String,
    channel: Option<String>,
    duration: Option<f64>,
    chat_overlay: Option<ChatOverlaySettings>,
    performance: Option<PerformanceSettings>,
    blur_zones: Option<Vec<BlurZone>>,
    fetchr_mute_enabled: Option<bool>,
    fetchr_mute_settings: Option<FetchrMuteSettings>,
) -> Result<Job, String> {
    let (base, token) = request_target(&app)?;
    let channel = channel.filter(|value| !value.trim().is_empty());
    let source_url = channel
        .as_ref()
        .map(|value| vps_channel_url(value.trim()))
        .unwrap_or_else(|| match session.as_deref() {
            Some(id) => format!("{base}/recordings/{id}"),
            None => format!("{base}/clips/{clip_id}"),
        });
    let spec = JobSpec {
        url: source_url,
        chat_source_url: None,
        name: name.clone(),
        directory,
        job_kind: Some(JobKind::VpsDownload),
        mode: Mode::Vod,
        download_kind: Some(DownloadKind::Video),
        start: None,
        end: None,
        fragments: vec![],
        split: false,
        split_interval_minutes: None,
        quality: None,
        quality_has_audio: None,
        quality_has_video: None,
        quality_height: None,
        video_codec_policy: None,
        audio_format: None,
        unmute_video: false,
        proxy: Default::default(),
        chat_overlay,
        performance,
        blur_zones: blur_zones.unwrap_or_default(),
        binaries_dir: None,
        fetchr_mute_enabled: fetchr_mute_enabled.unwrap_or(false),
        fetchr_mute_model: None,
        fetchr_mute_settings: fetchr_mute_settings.unwrap_or_default(),
        fetchr_mute_output_dir: None,
        vocal_remover_enabled: false,
        vocal_remover_settings: None,
        record_chat_separate: false,
        meta: crate::jobs::types::JobMeta {
            title: Some(name),
            uploader: channel,
            platform: Some("twitch-vps".to_string()),
            thumbnail: None,
            duration,
            output_path: None,
        },
        twitch_auth_token: None,
        vps_download: Some(VpsDownloadSpec {
            base_url: base,
            token,
            clip_id,
            session,
            include_chat: true,
        }),
        priority: 0,
    };
    Ok(state.queue.enqueue(spec))
}

// --- Подключение к VPS: провижининг и туннель --------------------------------

/// Tauri renames *command arguments* from camelCase, but not fields inside a
/// struct — without this, `keyPath` from the UI silently arrives as `None` and
/// the app falls back to password auth.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VpsCredentials {
    pub host: String,
    pub port: u16,
    pub user: String,
    #[serde(default)]
    pub password: String,
    /// Path to an OpenSSH private key. Set instead of relying on the password
    /// when the server runs `PasswordAuthentication no` — the default on
    /// current Ubuntu cloud images.
    #[serde(default)]
    pub key_path: Option<String>,
}

impl VpsCredentials {
    fn target(&self) -> crate::vps_ssh::SshTarget {
        crate::vps_ssh::SshTarget {
            host: self.host.trim().to_string(),
            port: self.port,
            user: self.user.trim().to_string(),
        }
    }

    fn credential(&self) -> crate::vps_ssh::Credential {
        match self
            .key_path
            .as_deref()
            .map(str::trim)
            .filter(|p| !p.is_empty())
        {
            // With a key, the password field carries the key's passphrase.
            Some(path) => crate::vps_ssh::Credential::Key {
                path: path.to_string(),
                passphrase: Some(self.password.clone()).filter(|p| !p.is_empty()),
            },
            None => crate::vps_ssh::Credential::Password(self.password.clone()),
        }
    }
}

/// Which login methods the server accepts. Needs no password — the UI calls it
/// as soon as the address is filled in so it can offer the right form.
#[tauri::command]
pub async fn vps_auth_methods(
    host: String,
    port: Option<u16>,
    user: Option<String>,
) -> Result<crate::vps_ssh::AuthMethods, String> {
    let target = crate::vps_ssh::SshTarget {
        host: host.trim().to_string(),
        port: port.unwrap_or(default_ssh_port()),
        user: user.unwrap_or_else(default_ssh_user).trim().to_string(),
    };
    if target.host.is_empty() {
        return Err("Укажите адрес сервера".to_string());
    }
    crate::vps_ssh::auth_methods(&target).await
}

/// Look at the server before touching it: what is installed, how much disk it
/// has, and which SSH key it presents.
#[tauri::command]
pub async fn vps_preflight(
    app: AppHandle,
    credentials: VpsCredentials,
) -> Result<crate::vps_ssh::PreflightReport, String> {
    let saved = load_config(&app);
    let expected = if saved.host == credentials.host.trim() {
        saved.fingerprint()
    } else {
        None
    };
    crate::vps_ssh::preflight(&credentials.target(), &credentials.credential(), expected).await
}

/// Install (or refresh) the agent, then bring the tunnel up. The password goes
/// to the OS credential store and never into `vps-config.json`.
#[tauri::command]
pub async fn vps_provision(
    app: AppHandle,
    credentials: VpsCredentials,
    agent_port: Option<u16>,
) -> Result<crate::vps_ssh::ProvisionReport, String> {
    let target = credentials.target();
    if target.host.is_empty() {
        return Err("Укажите адрес сервера".to_string());
    }
    let saved = load_config(&app);
    let same_host = saved.host == target.host;
    let expected = if same_host { saved.fingerprint() } else { None };
    let agent_port = agent_port.unwrap_or(default_agent_port());

    let credential = credentials.credential();
    let on_step = |step: &str| {
        let _ = tauri::Emitter::emit(&app, "vps-provision-step", step);
    };
    let report = crate::vps_ssh::provision(
        &target,
        &credential,
        agent_port,
        expected,
        if same_host {
            Some(saved.token.clone())
        } else {
            None
        },
        &on_step,
    )
    .await?;

    // A key with no passphrase has no secret to keep; Windows Credential
    // Manager rejects an empty one anyway.
    if credentials.password.is_empty() {
        let _ = crate::vps_ssh::forget_password(&target.host, &target.user);
    } else {
        crate::vps_ssh::store_password(&target.host, &target.user, &credentials.password)?;
    }
    let cfg = VpsConfig {
        host: target.host.clone(),
        ssh_port: target.port,
        user: target.user.clone(),
        agent_port: report.agent_port,
        token: report.token.clone(),
        host_key_fingerprint: report.host_key_fingerprint.clone(),
        key_path: credentials
            .key_path
            .clone()
            .filter(|path| !path.trim().is_empty()),
        base_url: String::new(),
    };
    save_config(&app, &cfg)?;

    on_step("Открываю защищённый канал к серверу");
    crate::vps_ssh::tunnel_start(target, credential, report.agent_port, cfg.fingerprint()).await?;
    Ok(report)
}

/// Reopen the tunnel with the stored credentials — called on app start and
/// whenever the user opens the VPS page.
#[tauri::command]
pub async fn vps_connect(app: AppHandle) -> Result<crate::vps_ssh::TunnelState, String> {
    let cfg = load_config(&app);
    if cfg.host.is_empty() {
        return Err("VPS не настроен".to_string());
    }
    if crate::vps_ssh::tunnel_probe().await {
        return Ok(crate::vps_ssh::tunnel_state());
    }
    // With a key configured the stored secret is only its passphrase, and an
    // unencrypted key has none — that is not a reason to refuse to reconnect.
    let secret = match crate::vps_ssh::load_password(&cfg.host, &cfg.user) {
        Ok(value) => value,
        Err(_) if cfg.key_path.is_some() => String::new(),
        Err(message) => return Err(message),
    };
    crate::vps_ssh::tunnel_start(
        cfg.ssh_target(),
        cfg.credential(secret),
        cfg.agent_port,
        cfg.fingerprint(),
    )
    .await?;
    Ok(crate::vps_ssh::tunnel_state())
}

#[tauri::command]
pub fn vps_disconnect() -> crate::vps_ssh::TunnelState {
    crate::vps_ssh::tunnel_stop();
    crate::vps_ssh::tunnel_state()
}

// --- Сервер Fetchr (купленный «Архив VPS») ----------------------------------
// Kept apart from the user's own VPS: its own file, no SSH, no tunnel. Both
// can be attached at once; `active` picks which one the archive page shows,
// and switching never touches the own VPS's tunnel.

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ManagedArchive {
    #[serde(default)]
    pub base_url: String,
    #[serde(default)]
    pub token: String,
    #[serde(default)]
    pub active: bool,
}

fn managed_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    Ok(config_path(app)?.with_file_name("vps-managed.json"))
}

fn load_managed(app: &AppHandle) -> ManagedArchive {
    managed_path(app)
        .ok()
        .and_then(|p| std::fs::read(&p).ok())
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

fn save_managed(app: &AppHandle, managed: &ManagedArchive) -> Result<(), String> {
    let path = managed_path(app)?;
    let bytes = serde_json::to_vec_pretty(managed).map_err(|e| e.to_string())?;
    std::fs::write(&path, bytes).map_err(|e| format!("save managed archive: {e}"))
}

enum ProbeError {
    Rejected,
    Unreachable(String),
}

impl ProbeError {
    fn message(&self) -> String {
        match self {
            ProbeError::Rejected => "Сервер архива не принял доступ".to_string(),
            ProbeError::Unreachable(err) => format!("Сервер архива недоступен: {err}"),
        }
    }
}

async fn probe_agent(base: &str, token: &str) -> Result<(), ProbeError> {
    ensure_secure_base_url(base).map_err(ProbeError::Unreachable)?;
    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(10))
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|e| ProbeError::Unreachable(e.to_string()))?;
    let resp = client
        .get(format!("{}/status", base.trim_end_matches('/')))
        .header("X-Token", token)
        .send()
        .await
        .map_err(|e| ProbeError::Unreachable(e.to_string()))?;
    match resp.status().as_u16() {
        200..=299 => Ok(()),
        401 | 404 => Err(ProbeError::Rejected),
        code => Err(ProbeError::Unreachable(format!("HTTP {code}"))),
    }
}

struct ManagedAccess {
    base_url: String,
    token: String,
}

/// Ask the account server for this machine's recorder. It authenticates the
/// machine by its licence key, the same pair the start-up check sends.
async fn fetch_managed_access() -> Result<ManagedAccess, String> {
    // Release builds bake the API address in; a plain `tauri dev` has none,
    // and the archive is only ever served by fetchr.fun anyway.
    let url = crate::remote::join_api_url("archive/connect")
        .unwrap_or_else(|| "https://fetchr.fun/api/archive/connect".to_string());
    let license_key = crate::license::stored_license_key()
        .ok_or_else(|| "Сначала активируйте Fetchr ключом из бота".to_string())?;
    let client = crate::remote::secure_client(std::time::Duration::from_secs(60))?;
    let resp = client
        .post(url)
        .json(&serde_json::json!({
            "machine_id": crate::license::current_machine_id(),
            "license_key": license_key,
        }))
        .send()
        .await
        .map_err(|e| format!("Сервер Fetchr недоступен: {e}"))?;
    crate::remote::verify_tls_pin(&resp)?;
    let body = resp
        .json::<serde_json::Value>()
        .await
        .map_err(|e| format!("Непонятный ответ сервера Fetchr: {e}"))?;
    if body.get("ok").and_then(|v| v.as_bool()) != Some(true) {
        let message = body
            .get("message")
            .and_then(|v| v.as_str())
            .unwrap_or("Не удалось подключить архив");
        return Err(message.to_string());
    }
    let field = |name: &str| {
        body.get(name)
            .and_then(|v| v.as_str())
            .map(str::to_string)
            .filter(|v| !v.is_empty())
            .ok_or_else(|| format!("Сервер Fetchr не прислал {name}"))
    };
    Ok(ManagedAccess {
        base_url: field("base_url")?,
        token: field("token")?,
    })
}

#[derive(Debug, Clone, Serialize)]
pub struct ManagedState {
    /// A Fetchr archive is attached to this machine.
    pub available: bool,
    /// It is the source the archive page shows (otherwise the own VPS).
    pub active: bool,
}

fn managed_state(app: &AppHandle) -> ManagedState {
    let managed = load_managed(app);
    let available = !managed.base_url.is_empty();
    ManagedState {
        available,
        active: available && managed.active,
    }
}

/// Attach the archive bought on fetchr.fun. `activate` makes it the shown
/// source; the automatic attempt passes false when the user already works
/// with an own VPS, so nothing changes under them.
#[tauri::command]
pub async fn vps_managed_connect(app: AppHandle, activate: bool) -> Result<ManagedState, String> {
    let access = fetch_managed_access().await?;
    probe_agent(&access.base_url, &access.token)
        .await
        .map_err(|err| err.message())?;
    let keep_active = load_managed(&app).active;
    save_managed(
        &app,
        &ManagedArchive {
            base_url: access.base_url,
            token: access.token,
            active: activate || keep_active,
        },
    )?;
    Ok(managed_state(&app))
}

#[tauri::command]
pub fn vps_managed_state(app: AppHandle) -> ManagedState {
    managed_state(&app)
}

/// Switch the archive page between the own VPS and the Fetchr archive.
#[tauri::command]
pub fn vps_managed_select(app: AppHandle, active: bool) -> Result<ManagedState, String> {
    let mut managed = load_managed(&app);
    if active && managed.base_url.is_empty() {
        return Err("Архив Fetchr не подключён".to_string());
    }
    managed.active = active;
    save_managed(&app, &managed)?;
    Ok(managed_state(&app))
}

/// Is the Fetchr archive answering. A token it no longer accepts (the tenant
/// was rebuilt) is fetched again from the account server once.
#[tauri::command]
pub async fn vps_managed_probe(app: AppHandle) -> Result<(), String> {
    let managed = load_managed(&app);
    if managed.base_url.is_empty() {
        return Err("Архив Fetchr не подключён".to_string());
    }
    match probe_agent(&managed.base_url, &managed.token).await {
        Ok(()) => Ok(()),
        Err(ProbeError::Rejected) => {
            let fresh = fetch_managed_access().await?;
            probe_agent(&fresh.base_url, &fresh.token)
                .await
                .map_err(|err| err.message())?;
            save_managed(
                &app,
                &ManagedArchive {
                    base_url: fresh.base_url,
                    token: fresh.token,
                    active: managed.active,
                },
            )
        }
        Err(err) => Err(err.message()),
    }
}

/// Detach the Fetchr archive from this machine; the recordings stay on the
/// server and the own VPS is left alone.
#[tauri::command]
pub fn vps_managed_forget(app: AppHandle) -> Result<ManagedState, String> {
    save_managed(&app, &ManagedArchive::default())?;
    Ok(managed_state(&app))
}

#[tauri::command]
pub fn vps_tunnel_state() -> crate::vps_ssh::TunnelState {
    crate::vps_ssh::tunnel_state()
}

/// Drop the tunnel, wipe the stored password and forget the server. The agent
/// on the VPS keeps running — this only detaches this machine from it.
#[tauri::command]
pub fn vps_forget(app: AppHandle) -> Result<(), String> {
    let cfg = load_config(&app);
    crate::vps_ssh::tunnel_stop();
    if !cfg.host.is_empty() {
        crate::vps_ssh::forget_password(&cfg.host, &cfg.user)?;
    }
    save_config(
        &app,
        &VpsConfig {
            ssh_port: default_ssh_port(),
            user: default_ssh_user(),
            agent_port: default_agent_port(),
            ..Default::default()
        },
    )
}

// --- Скрытая разблокировка функции «Запись на VPS» --------------------------
// Пароль сверяется по SHA-256 (сам пароль в коде не хранится). При успехе
// рядом с лицензией сохраняется токен, привязанный к железу (HWID из
// license.rs): файл в config_dir переживает обновления приложения, а на
// другом ПК токен не совпадёт.

use sha2::{Digest, Sha256};

const VPS_UNLOCK_PASSWORD_SHA256: &str =
    "4a623ff5f6a36d01fe72fc0eab6352f45f8999ff322be8d38bed4a25b97793a7";

#[derive(Debug, Serialize, Deserialize)]
struct StoredVpsUnlock {
    token: String,
}

fn vps_unlock_file_path() -> Result<std::path::PathBuf, String> {
    let base = dirs::config_dir()
        .ok_or_else(|| "Could not locate Windows config directory".to_string())?;
    Ok(base.join("Fetchr").join("vps-unlock.json"))
}

fn expected_vps_unlock_token() -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"fetchr-vps-unlock:v1:");
    hasher.update(crate::license::current_hwid_sha256().as_bytes());
    hasher.update(b":");
    hasher.update(VPS_UNLOCK_PASSWORD_SHA256.as_bytes());
    hex::encode(hasher.finalize())
}

/// Async on purpose: the token needs the hardware id, which may still be
/// computing (PowerShell) and must not stall the main thread.
#[tauri::command]
pub async fn vps_unlock_status() -> bool {
    tauri::async_runtime::spawn_blocking(read_vps_unlock_status)
        .await
        .unwrap_or(false)
}

fn read_vps_unlock_status() -> bool {
    let Ok(path) = vps_unlock_file_path() else {
        return false;
    };
    let Ok(raw) = std::fs::read_to_string(path) else {
        return false;
    };
    let Ok(stored) = serde_json::from_str::<StoredVpsUnlock>(&raw) else {
        return false;
    };
    stored.token == expected_vps_unlock_token()
}

#[tauri::command]
pub async fn vps_unlock(password: String) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || store_vps_unlock(&password))
        .await
        .map_err(|e| format!("unlock task failed: {e}"))?
}

fn store_vps_unlock(password: &str) -> Result<bool, String> {
    let mut hasher = Sha256::new();
    hasher.update(password.as_bytes());
    if hex::encode(hasher.finalize()) != VPS_UNLOCK_PASSWORD_SHA256 {
        return Ok(false);
    }
    let path = vps_unlock_file_path()?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("create unlock dir: {e}"))?;
    }
    let stored = StoredVpsUnlock {
        token: expected_vps_unlock_token(),
    };
    let raw = serde_json::to_string(&stored).map_err(|e| format!("serialize unlock: {e}"))?;
    std::fs::write(&path, raw).map_err(|e| format!("write unlock file: {e}"))?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn credentials_accept_the_camel_case_the_ui_sends() {
        // The UI sends `keyPath`; if this stops matching, key auth silently
        // degrades to a password attempt against a server that has none.
        let parsed: VpsCredentials = serde_json::from_str(
            r#"{"host":"10.0.0.1","port":22,"user":"root","password":"","keyPath":"C:\\k\\id_ed25519"}"#,
        )
        .expect("deserialize");
        assert_eq!(parsed.key_path.as_deref(), Some("C:\\k\\id_ed25519"));
        assert!(matches!(
            parsed.credential(),
            crate::vps_ssh::Credential::Key { .. }
        ));
    }

    #[test]
    fn blank_key_path_still_means_password_auth() {
        let parsed: VpsCredentials = serde_json::from_str(
            r#"{"host":"10.0.0.1","port":22,"user":"root","password":"secret","keyPath":"  "}"#,
        )
        .expect("deserialize");
        assert!(matches!(
            parsed.credential(),
            crate::vps_ssh::Credential::Password(_)
        ));
    }

    #[test]
    fn unlock_token_is_hwid_bound_and_stable() {
        let first = expected_vps_unlock_token();
        let second = expected_vps_unlock_token();
        assert_eq!(first, second);
        assert_eq!(first.len(), 64);
        assert_ne!(first, VPS_UNLOCK_PASSWORD_SHA256);
    }
}
