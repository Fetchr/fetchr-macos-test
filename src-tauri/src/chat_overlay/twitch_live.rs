use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{anyhow, Context, Result};
use futures::{SinkExt, StreamExt};
use tokio::sync::oneshot;
use tokio::task::JoinHandle;
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::Message;

use crate::chat_overlay::emit_log;
use crate::chat_overlay::model::{
    write_chat_messages_for_streamer, ChatBadge, ChatFragment, ChatMessage, ChatStreamer,
};
use crate::chat_overlay::providers::{apply_third_party_emotes, EmotePlatform, ResolvedChannel};
use crate::chat_overlay::settings::EffectiveChatOverlaySettings;
use crate::jobs::queue::QueueManager;
use crate::jobs::types::Job;

pub struct TwitchLiveChatRecorder {
    stop: Arc<AtomicBool>,
    output_path: PathBuf,
    task: JoinHandle<Result<TwitchLiveChatStats>>,
}

#[derive(Debug, Clone)]
pub struct TwitchLiveChatStats {
    pub subscribed: bool,
    pub raw_events: usize,
    pub parsed_messages: usize,
    pub output_path: PathBuf,
}

impl TwitchLiveChatRecorder {
    pub async fn stop_and_wait(
        self,
        queue: &Arc<QueueManager>,
        job_id: &str,
    ) -> Result<TwitchLiveChatStats> {
        self.stop.store(true, Ordering::SeqCst);
        match tokio::time::timeout(Duration::from_secs(8), self.task).await {
            Ok(Ok(Ok(stats))) => {
                emit_log(
                    queue,
                    job_id,
                    &format!(
                        "Twitch live chat recorder: captured {} messages (raw events {}, joined {}) to {}",
                        stats.parsed_messages,
                        stats.raw_events,
                        stats.subscribed,
                        stats.output_path.display()
                    ),
                );
                Ok(stats)
            }
            Ok(Ok(Err(err))) => {
                emit_log(
                    queue,
                    job_id,
                    &format!("!! Twitch live chat recorder stopped with error: {err:#}"),
                );
                Err(err)
            }
            Ok(Err(err)) => {
                emit_log(
                    queue,
                    job_id,
                    &format!("!! Twitch live chat recorder task failed: {err}"),
                );
                Err(anyhow!("Twitch live chat recorder task failed: {err}"))
            }
            Err(_) => {
                emit_log(
                    queue,
                    job_id,
                    "!! Twitch live chat recorder did not stop within timeout.",
                );
                Err(anyhow!(
                    "Twitch live chat recorder did not stop within timeout for {}",
                    self.output_path.display()
                ))
            }
        }
    }
}

pub async fn start_twitch_live_chat_recorder(
    queue: Arc<QueueManager>,
    job: &Job,
    output_path: PathBuf,
    cancel: Arc<AtomicBool>,
) -> Result<TwitchLiveChatRecorder> {
    let channel = parse_twitch_channel(&job.spec.url)
        .ok_or_else(|| anyhow!("Twitch channel name not found in URL"))?;
    let settings = EffectiveChatOverlaySettings::from(
        job.spec
            .chat_overlay
            .clone()
            .unwrap_or_default()
            .with_defaults(),
    );

    if let Some(parent) = output_path.parent() {
        std::fs::create_dir_all(parent).with_context(|| format!("create {}", parent.display()))?;
    }
    if output_path.exists() {
        std::fs::remove_file(&output_path)
            .with_context(|| format!("remove stale {}", output_path.display()))?;
    }
    emit_log(
        &queue,
        &job.id,
        &format!(
            "Twitch live chat recorder: connecting to channel {channel}; writing {}",
            output_path.display()
        ),
    );

    let stop = Arc::new(AtomicBool::new(false));
    let task_stop = stop.clone();
    let job_id = job.id.clone();
    let task_path = output_path.clone();
    let emote_proxy_url = job.spec.proxy.resolved();
    let started_at = Instant::now();
    let (subscription_tx, subscription_rx) = oneshot::channel();
    let task = tokio::spawn(async move {
        record_twitch_chat(
            queue,
            job_id,
            channel,
            settings,
            task_path,
            task_stop,
            cancel,
            started_at,
            subscription_tx,
            emote_proxy_url,
        )
        .await
    });

    match tokio::time::timeout(Duration::from_secs(12), subscription_rx).await {
        Ok(Ok(Ok(()))) => {}
        Ok(Ok(Err(err))) => {
            stop.store(true, Ordering::SeqCst);
            return Err(err.context("Twitch live chat recorder connection failed"));
        }
        Ok(Err(_)) => {
            stop.store(true, Ordering::SeqCst);
            return Err(anyhow!(
                "Twitch live chat recorder ended before connection confirmation"
            ));
        }
        Err(_) => {
            stop.store(true, Ordering::SeqCst);
            return Err(anyhow!(
                "Twitch live chat recorder did not confirm connection within 12s"
            ));
        }
    }

    Ok(TwitchLiveChatRecorder {
        stop,
        output_path,
        task,
    })
}

/// Identity to stamp on a recorded sidecar, so rendering that file later still resolves the
/// channel and its 7TV/BTTV/FFZ emotes.
fn recorded_streamer(channel: &str, channel_id: Option<&str>) -> ChatStreamer {
    ChatStreamer {
        login: Some(channel.to_string()),
        id: channel_id.map(str::to_string),
    }
}

/// The channel a Twitch URL points at, or `None` for anything that is not one.
///
/// [`parse_twitch_channel`] also accepts a bare login, so it happily turns a file path or a
/// recorder-agent endpoint into a nonsense channel. Use this wherever the input is an arbitrary
/// job URL.
pub fn parse_twitch_channel_url(url: &str) -> Option<String> {
    if !url.to_ascii_lowercase().contains("twitch.tv") {
        return None;
    }
    parse_twitch_channel(url)
}

pub fn parse_twitch_channel(url: &str) -> Option<String> {
    let without_query = url.split(['?', '#']).next().unwrap_or(url);
    let parts = without_query
        .split('/')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>();
    let host_index = parts.iter().position(|part| {
        part.eq_ignore_ascii_case("twitch.tv") || part.eq_ignore_ascii_case("www.twitch.tv")
    });
    let first_path = host_index.map(|idx| idx + 1).unwrap_or(0);
    let channel = parts.get(first_path)?;
    if channel.eq_ignore_ascii_case("directory")
        || channel.eq_ignore_ascii_case("videos")
        || channel.eq_ignore_ascii_case("video")
        || channel.eq_ignore_ascii_case("moderator")
    {
        None
    } else {
        Some(channel.to_ascii_lowercase())
    }
}

#[allow(clippy::too_many_arguments)]
async fn record_twitch_chat(
    queue: Arc<QueueManager>,
    job_id: String,
    channel: String,
    settings: EffectiveChatOverlaySettings,
    output_path: PathBuf,
    stop: Arc<AtomicBool>,
    cancel: Arc<AtomicBool>,
    started_at: Instant,
    subscription_tx: oneshot::Sender<Result<()>>,
    emote_proxy_url: Option<String>,
) -> Result<TwitchLiveChatStats> {
    let ws_url = "wss://irc-ws.chat.twitch.tv:443";
    let (mut ws, _) = connect_async(ws_url)
        .await
        .context("connect Twitch chat websocket")?;

    // Send anonymous login
    ws.send(Message::Text(
        "CAP REQ :twitch.tv/tags twitch.tv/commands".to_string(),
    ))
    .await?;
    ws.send(Message::Text("PASS oauth:anon".to_string()))
        .await?;
    ws.send(Message::Text("NICK justinfan12345".to_string()))
        .await?;
    ws.send(Message::Text(format!("JOIN #{channel}"))).await?;

    let mut messages = Vec::new();
    let mut channel_id: Option<String> = None;
    let mut last_flush = Instant::now();
    let mut joined = false;
    let mut raw_events = 0_usize;
    let mut subscription_tx = Some(subscription_tx);
    let flush_guard = super::live_flush::register(&job_id);

    loop {
        if stop.load(Ordering::SeqCst) || cancel.load(Ordering::SeqCst) {
            break;
        }
        match tokio::time::timeout(Duration::from_secs(1), ws.next()).await {
            Ok(Some(Ok(Message::Text(text)))) => {
                for line in text.lines() {
                    raw_events += 1;
                    if line.starts_with("PING") {
                        let _ = ws
                            .send(Message::Text("PONG :tmi.twitch.tv".to_string()))
                            .await;
                    } else if line.contains("366 justinfan12345") {
                        // End of NAMES list, indicates join success
                        joined = true;
                        emit_log(
                            &queue,
                            &job_id,
                            &format!("Twitch live chat recorder: successfully joined #{channel}"),
                        );
                        if let Some(tx) = subscription_tx.take() {
                            let _ = tx.send(Ok(()));
                        }
                    } else if let Some(msg) =
                        parse_twitch_irc_line(line, started_at.elapsed().as_secs_f64())
                    {
                        // `room-id` is the channel's numeric Twitch id — needed to fetch the
                        // channel's 7TV/BTTV/FFZ emote sets. It comes straight from the chat tags.
                        if channel_id.is_none() {
                            channel_id = extract_irc_tag(line, "room-id");
                        }
                        messages.push(msg);
                    }
                }
            }
            Ok(Some(Ok(Message::Close(_)))) => {
                if let Some(tx) = subscription_tx.take() {
                    let _ = tx.send(Err(anyhow!(
                        "Twitch chat websocket closed before connection confirmation"
                    )));
                }
                break;
            }
            Ok(Some(Ok(_))) | Err(_) => {}
            Ok(Some(Err(err))) => {
                if let Some(tx) = subscription_tx.take() {
                    let _ = tx.send(Err(anyhow!("read Twitch chat websocket: {err}")));
                    return Err(anyhow!(err).context("read Twitch chat websocket"));
                }
                // The connection was already confirmed: an abrupt drop (VPN/ISP
                // hiccup) must not discard the collected chat. Stop reading, then
                // fall through to the final flush so the messages are kept.
                emit_log(
                    &queue,
                    &job_id,
                    &format!(
                        "!! Twitch chat websocket dropped, keeping collected messages: {err}"
                    ),
                );
                break;
            }
            Ok(None) => {
                if let Some(tx) = subscription_tx.take() {
                    let _ = tx.send(Err(anyhow!(
                        "Twitch chat websocket ended before connection confirmation"
                    )));
                }
                break;
            }
        }
        // A clip cut from the running recording asks for the chat so far.
        let flush_requested = flush_guard.flush.take_request();
        if flush_requested
            || last_flush.elapsed() >= super::model::live_chat_flush_interval(messages.len())
        {
            messages.sort_by(|a: &ChatMessage, b| a.timestamp.total_cmp(&b.timestamp));
            if !messages.is_empty() {
                write_chat_messages_for_streamer(
                    &output_path,
                    &messages,
                    Some(&recorded_streamer(&channel, channel_id.as_deref())),
                )?;
            }
            emit_log(
                &queue,
                &job_id,
                &format!(
                    "Twitch live chat recorder: parsed {} messages from {raw_events} raw events",
                    messages.len()
                ),
            );
            last_flush = Instant::now();
            flush_guard.flush.mark_written();
        }
    }

    messages.sort_by(|a: &ChatMessage, b| a.timestamp.total_cmp(&b.timestamp));
    // Resolve 7TV/BTTV/FFZ emotes once, on the full recording, using the channel id parsed from
    // the live chat tags. Native emotes are already attached per message via the `emotes` tag.
    if let Some(channel_id) = channel_id.clone() {
        if settings.show_bttv || settings.show_ffz || settings.show_7tv {
            let client = crate::chat_overlay::chat_http_client(None);
            let proxy_client = emote_proxy_url
                .as_deref()
                .map(|url| crate::chat_overlay::chat_http_client(Some(url)));
            let channel = ResolvedChannel {
                platform: EmotePlatform::Twitch,
                id: channel_id,
            };
            apply_third_party_emotes(
                &client,
                proxy_client.as_ref(),
                &channel,
                &settings,
                &mut messages,
                &queue,
                &job_id,
            )
            .await;
        }
    }
    if !messages.is_empty() {
        write_chat_messages_for_streamer(
            &output_path,
            &messages,
            Some(&recorded_streamer(&channel, channel_id.as_deref())),
        )?;
    }

    Ok(TwitchLiveChatStats {
        subscribed: joined,
        raw_events,
        parsed_messages: messages.len(),
        output_path,
    })
}

fn parse_twitch_irc_line(line: &str, elapsed: f64) -> Option<ChatMessage> {
    if !line.contains("PRIVMSG") {
        return None;
    }
    let (tags_part, rest) = if line.starts_with('@') {
        let mut parts = line.splitn(2, ' ');
        let tags = parts.next()?;
        let rest = parts.next()?;
        (Some(&tags[1..]), rest)
    } else {
        (None, line)
    };

    let privmsg_idx = rest.find("PRIVMSG")?;
    let colon_idx = rest[privmsg_idx..].find(':')?;
    let content = &rest[privmsg_idx + colon_idx + 1..];

    let prefix = rest.split(' ').next()?;
    let username = if prefix.starts_with(':') {
        let exclamation = prefix.find('!')?;
        &prefix[1..exclamation]
    } else {
        "anonymous"
    };

    let mut display_name = username.to_string();
    let mut user_color = None;
    let mut badges = Vec::new();
    let mut emotes_tag: Option<String> = None;

    if let Some(tags) = tags_part {
        for tag in tags.split(';') {
            let mut kv = tag.splitn(2, '=');
            let key = kv.next()?;
            let val = kv.next()?;
            if val.is_empty() {
                continue;
            }
            match key {
                "display-name" => {
                    display_name = val.to_string();
                }
                "color" => {
                    user_color = Some(val.to_string());
                }
                "emotes" => {
                    emotes_tag = Some(val.to_string());
                }
                "badges" => {
                    for badge_str in val.split(',') {
                        let mut b_parts = badge_str.splitn(2, '/');
                        let b_id = b_parts.next()?;
                        let b_ver = b_parts.next().map(|v| v.to_string());
                        badges.push(ChatBadge {
                            provider: "twitch".to_string(),
                            id: b_id.to_string(),
                            version: b_ver,
                            url: None,
                            title: None,
                        });
                    }
                }
                _ => {}
            }
        }
    }

    let content = content.trim_end_matches(['\r', '\n']);
    Some(ChatMessage {
        timestamp: elapsed,
        created_at: None,
        username: username.to_lowercase(),
        display_name,
        user_color,
        badges,
        fragments: build_twitch_fragments(content, emotes_tag.as_deref()),
        source_platform: "twitch".to_string(),
    })
}

/// Split a Twitch PRIVMSG body into text/emote fragments using the IRC `emotes` tag
/// (`id:start-end,start-end/id:start-end`). Positions are Unicode codepoint indices into the
/// message body. Without the tag, the whole body is a single text fragment.
fn build_twitch_fragments(content: &str, emotes_tag: Option<&str>) -> Vec<ChatFragment> {
    let tag = match emotes_tag {
        Some(tag) if !tag.is_empty() => tag,
        _ => {
            return vec![ChatFragment::Text {
                text: content.to_string(),
            }]
        }
    };

    let mut spans: Vec<(usize, usize, String)> = Vec::new();
    for group in tag.split('/') {
        let mut group_parts = group.splitn(2, ':');
        let id = group_parts.next().unwrap_or("");
        let Some(positions) = group_parts.next() else {
            continue;
        };
        if id.is_empty() {
            continue;
        }
        for range in positions.split(',') {
            let mut bounds = range.splitn(2, '-');
            let (Some(start), Some(end)) = (bounds.next(), bounds.next()) else {
                continue;
            };
            if let (Ok(start), Ok(end)) = (start.parse::<usize>(), end.parse::<usize>()) {
                spans.push((start, end, id.to_string()));
            }
        }
    }
    spans.sort_by_key(|span| span.0);

    let chars: Vec<char> = content.chars().collect();
    let mut fragments = Vec::new();
    let mut cursor = 0_usize;
    for (start, end, id) in spans {
        if start > end || end >= chars.len() || start < cursor {
            continue;
        }
        if start > cursor {
            fragments.push(ChatFragment::Text {
                text: chars[cursor..start].iter().collect(),
            });
        }
        fragments.push(ChatFragment::Emote {
            provider: "twitch".to_string(),
            id: id.clone(),
            url: format!("https://static-cdn.jtvnw.net/emoticons/v2/{id}/default/dark/2.0"),
            text: Some(chars[start..=end].iter().collect()),
            zero_width: false,
        });
        cursor = end + 1;
    }
    if cursor < chars.len() {
        fragments.push(ChatFragment::Text {
            text: chars[cursor..].iter().collect(),
        });
    }
    if fragments.is_empty() {
        fragments.push(ChatFragment::Text {
            text: content.to_string(),
        });
    }
    fragments
}

/// Extract a single IRC tag value (e.g. `room-id`) from a raw line, if present and non-empty.
fn extract_irc_tag(line: &str, key: &str) -> Option<String> {
    if !line.starts_with('@') {
        return None;
    }
    let tags = line[1..].split(' ').next()?;
    for tag in tags.split(';') {
        let mut kv = tag.splitn(2, '=');
        if kv.next() == Some(key) {
            let val = kv.next().unwrap_or("");
            if !val.is_empty() {
                return Some(val.to_string());
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::parse_twitch_channel_url;

    #[test]
    fn channel_url_yields_the_login() {
        assert_eq!(
            parse_twitch_channel_url("https://www.twitch.tv/rachelr").as_deref(),
            Some("rachelr")
        );
    }

    /// A chat job renders a file, and a VPS job points at the recorder agent. Neither names a
    /// channel — reading one out of them would send the render to a stranger's emotes.
    #[test]
    fn non_twitch_sources_name_no_channel() {
        assert_eq!(
            parse_twitch_channel_url(r"C:\chat\rachelr_stream_chat.json"),
            None
        );
        assert_eq!(
            parse_twitch_channel_url("https://recorder.example/recordings/abc123"),
            None
        );
    }
}
