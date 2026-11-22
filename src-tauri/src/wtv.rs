//! W.TV (w.tv) public API.
//!
//! The site is a Nuxt app over a few JSON services behind CloudFront; the WAF
//! answers 403 to requests that do not look like the web client, so every call
//! carries a browser user agent and the site as Origin/Referer.
//!
//! - `profiles-service/api/v1/profiles/by-nickname/{nick}` → user id (= channel id);
//! - `streams-search-service/api/v1/channels/{id}/streams` → broadcasts, newest first,
//!   each with an HLS `playbackUrl` (Amazon IVS for live, `streams.w.tv/.../master.m3u8`
//!   for finished ones);
//! - `chats-service/api/v1/chats/{id}/messages` → the last ~50 chat messages.

use anyhow::{anyhow, Context, Result};
use serde::Deserialize;
use serde_json::Value;

const USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
const QUERY: &str = "user_lang=ru&platform=web";

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WtvStream {
    pub stream_id: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub state: String,
    #[serde(default)]
    pub started_at: Option<String>,
    #[serde(default)]
    pub finished_at: Option<String>,
    #[serde(default)]
    pub thumbnail_url: Option<String>,
    #[serde(default)]
    pub playback_url: Option<String>,
    #[serde(default)]
    pub channel: Option<WtvStreamChannel>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WtvStreamChannel {
    #[serde(default)]
    pub name: Option<String>,
}

impl WtvStream {
    pub fn is_live(&self) -> bool {
        self.state == "started"
    }

    /// Length of a finished broadcast, in seconds.
    pub fn duration_sec(&self) -> Option<f64> {
        let start = chrono::DateTime::parse_from_rfc3339(self.started_at.as_deref()?).ok()?;
        let end = chrono::DateTime::parse_from_rfc3339(self.finished_at.as_deref()?).ok()?;
        Some((end - start).num_milliseconds() as f64 / 1000.0).filter(|sec| *sec > 0.0)
    }
}

#[derive(Debug, Clone)]
pub struct WtvChannel {
    pub user_id: String,
    pub nickname: String,
    pub streams: Vec<WtvStream>,
}

impl WtvChannel {
    pub fn live_stream(&self) -> Option<&WtvStream> {
        self.streams.iter().find(|stream| stream.is_live())
    }

    pub fn latest_finished(&self) -> Option<&WtvStream> {
        self.streams
            .iter()
            .find(|stream| !stream.is_live() && stream.playback_url.is_some())
    }
}

pub fn client() -> reqwest::Client {
    let mut headers = reqwest::header::HeaderMap::new();
    headers.insert("Origin", reqwest::header::HeaderValue::from_static("https://w.tv"));
    headers.insert("Referer", reqwest::header::HeaderValue::from_static("https://w.tv/"));
    headers.insert("Accept", reqwest::header::HeaderValue::from_static("application/json"));
    reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .default_headers(headers)
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new())
}

fn host_of(url: &str) -> Option<String> {
    let rest = url.trim().split("://").nth(1).unwrap_or(url.trim());
    let host = rest.split(['/', '?', '#']).next()?.to_ascii_lowercase();
    Some(host.split(':').next().unwrap_or(&host).to_string())
}

pub fn is_wtv_url(url: &str) -> bool {
    host_of(url).is_some_and(|host| host == "w.tv" || host.ends_with(".w.tv"))
}

/// The channel nickname of a `w.tv/<nick>` link.
pub fn parse_wtv_channel(url: &str) -> Option<String> {
    let host = host_of(url)?;
    if host != "w.tv" && host != "www.w.tv" {
        return None;
    }
    let rest = url.trim().split("://").nth(1).unwrap_or(url.trim());
    let path = rest.split(['?', '#']).next()?;
    let nick = path.split('/').nth(1)?.trim();
    const RESERVED: [&str; 10] = [
        "", "navigation", "search", "settings", "cabinet", "following", "doc", "oauth",
        "referrals", "tg-privacy-ru",
    ];
    if RESERVED.contains(&nick.to_ascii_lowercase().as_str()) {
        return None;
    }
    Some(nick.to_string())
}

/// The saved broadcast a link points at: `w.tv/<nick>/videos/<streamId>` (the
/// site's own record page), or `?stream=<id>` on a channel link.
pub fn requested_stream_id(url: &str) -> Option<String> {
    let rest = url.trim().split("://").nth(1).unwrap_or(url.trim());
    let (path, query) = match rest.split_once('?') {
        Some((path, query)) => (path, Some(query.split('#').next().unwrap_or(""))),
        None => (rest.split('#').next().unwrap_or(rest), None),
    };
    let segments: Vec<&str> = path.split('/').filter(|part| !part.is_empty()).collect();
    if let Some(index) = segments.iter().position(|part| part.eq_ignore_ascii_case("videos")) {
        if let Some(id) = segments.get(index + 1).filter(|id| is_stream_id(id)) {
            return Some(id.to_ascii_lowercase());
        }
    }
    query?.split('&').find_map(|pair| {
        let (key, value) = pair.split_once('=')?;
        (key == "stream" && is_stream_id(value)).then(|| value.to_ascii_lowercase())
    })
}

/// W.TV ids are UUIDs (v7): hex digits and dashes only, so they are safe in a URL path.
fn is_stream_id(value: &str) -> bool {
    value.len() >= 8 && value.chars().all(|ch| ch.is_ascii_hexdigit() || ch == '-')
}

pub async fn fetch_stream(client: &reqwest::Client, stream_id: &str) -> Result<WtvStream> {
    let url = format!("https://streams-search-service.w.tv/api/v1/streams/{stream_id}?{QUERY}");
    let value = get_json(client, &url)
        .await
        .with_context(|| format!("W.TV: запись {stream_id} не найдена"))?;
    let stream = value
        .get("stream")
        .cloned()
        .ok_or_else(|| anyhow!("W.TV: в ответе нет записи {stream_id}"))?;
    serde_json::from_value(stream).context("parse W.TV stream")
}

async fn get_json(client: &reqwest::Client, url: &str) -> Result<Value> {
    client
        .get(url)
        .send()
        .await
        .with_context(|| format!("GET {url}"))?
        .error_for_status()
        .with_context(|| format!("GET {url}"))?
        .json()
        .await
        .with_context(|| format!("parse {url}"))
}

pub async fn fetch_channel(client: &reqwest::Client, nickname: &str) -> Result<WtvChannel> {
    let profile_url = format!(
        "https://profiles-service.w.tv/api/v1/profiles/by-nickname/{}?{QUERY}",
        urlencoding::encode(nickname)
    );
    let profile = get_json(client, &profile_url)
        .await
        .with_context(|| format!("W.TV канал «{nickname}» не найден"))?;
    let user_id = profile
        .pointer("/profile/userId")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("W.TV: в профиле {nickname} нет userId"))?
        .to_string();
    let nickname = profile
        .pointer("/profile/nickname")
        .and_then(Value::as_str)
        .unwrap_or(nickname)
        .to_string();
    let streams_url = format!(
        "https://streams-search-service.w.tv/api/v1/channels/{user_id}/streams?{QUERY}"
    );
    let streams = get_json(client, &streams_url).await?;
    let streams = streams
        .get("data")
        .cloned()
        .map(serde_json::from_value::<Vec<WtvStream>>)
        .transpose()
        .context("parse W.TV streams")?
        .unwrap_or_default();
    Ok(WtvChannel {
        user_id,
        nickname,
        streams,
    })
}

pub struct WtvResolved {
    pub channel: Option<WtvChannel>,
    pub stream: Option<WtvStream>,
    pub playback_url: String,
}

/// The HLS playlist behind a W.TV link: a `streams.w.tv` playlist as is, the
/// live broadcast of `w.tv/<nick>`, or — when the channel is offline — its
/// latest finished broadcast (or the one `?stream=<id>` names).
pub async fn resolve(url: &str) -> Result<WtvResolved> {
    if url.to_ascii_lowercase().contains(".m3u8") {
        return Ok(WtvResolved {
            channel: None,
            stream: None,
            playback_url: url.trim().to_string(),
        });
    }
    // A saved broadcast resolves by its id alone: the channel's list holds only
    // the latest few broadcasts.
    if let Some(id) = requested_stream_id(url) {
        let stream = fetch_stream(&client(), &id).await?;
        let playback_url = stream
            .playback_url
            .clone()
            .ok_or_else(|| anyhow!("W.TV: у записи нет ссылки на видео"))?;
        return Ok(WtvResolved {
            channel: None,
            stream: Some(stream),
            playback_url,
        });
    }
    let nickname =
        parse_wtv_channel(url).ok_or_else(|| anyhow!("Не удалось найти ник канала в ссылке W.TV"))?;
    let channel = fetch_channel(&client(), &nickname).await?;
    let stream = channel
        .live_stream()
        .or_else(|| channel.latest_finished())
        .cloned()
        .ok_or_else(|| anyhow!("W.TV: у канала {nickname} нет трансляций"))?;
    let playback_url = stream
        .playback_url
        .clone()
        .ok_or_else(|| anyhow!("W.TV: у трансляции нет ссылки на видео"))?;
    Ok(WtvResolved {
        channel: Some(channel),
        stream: Some(stream),
        playback_url,
    })
}

pub async fn fetch_chat_messages(client: &reqwest::Client, channel_id: &str) -> Result<Vec<Value>> {
    let url = format!(
        "https://chats-service.w.tv/api/v1/chats/{channel_id}/messages?limit=100&{QUERY}"
    );
    let value = get_json(client, &url).await?;
    Ok(value
        .get("messages")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognizes_wtv_hosts_only() {
        assert!(is_wtv_url("https://w.tv/1win_cs"));
        assert!(is_wtv_url("w.tv/papich"));
        assert!(is_wtv_url("https://streams.w.tv/ivs/v1/x/media/hls/master.m3u8"));
        assert!(!is_wtv_url("https://snow.tv/abc"));
        assert!(!is_wtv_url("https://twitch.tv/w.tv"));
    }

    #[test]
    fn parses_channel_and_stream_choice() {
        assert_eq!(parse_wtv_channel("https://w.tv/1win_cs").as_deref(), Some("1win_cs"));
        assert_eq!(parse_wtv_channel("https://www.w.tv/Nick?stream=1").as_deref(), Some("Nick"));
        assert_eq!(parse_wtv_channel("https://w.tv/search"), None);
        assert_eq!(parse_wtv_channel("https://w.tv/"), None);
        assert_eq!(
            requested_stream_id("https://w.tv/n?stream=01a11aa3&x=1").as_deref(),
            Some("01a11aa3")
        );
        assert_eq!(
            requested_stream_id(
                "https://w.tv/lenkapenka/videos/01a12157-a9c5-71ec-9510-6bb11485a573"
            )
            .as_deref(),
            Some("01a12157-a9c5-71ec-9510-6bb11485a573")
        );
        assert_eq!(requested_stream_id("https://w.tv/lenkapenka"), None);
        assert_eq!(requested_stream_id("https://w.tv/n/videos/../x"), None);
    }

    #[test]
    fn finished_stream_duration() {
        let stream = WtvStream {
            stream_id: "s".into(),
            title: String::new(),
            state: "finished".into(),
            started_at: Some("2026-10-08T08:31:27.415Z".into()),
            finished_at: Some("2026-10-08T08:32:27.415Z".into()),
            thumbnail_url: None,
            playback_url: None,
            channel: None,
        };
        assert_eq!(stream.duration_sec(), Some(60.0));
        assert!(!stream.is_live());
    }
}
