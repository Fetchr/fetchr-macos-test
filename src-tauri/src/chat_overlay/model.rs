use std::path::Path;

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    pub timestamp: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_at: Option<String>,
    pub username: String,
    pub display_name: String,
    pub user_color: Option<String>,
    #[serde(default)]
    pub badges: Vec<ChatBadge>,
    #[serde(default)]
    pub fragments: Vec<ChatFragment>,
    pub source_platform: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatBadge {
    pub provider: String,
    pub id: String,
    pub version: Option<String>,
    pub url: Option<String>,
    pub title: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum ChatFragment {
    Text {
        text: String,
    },
    Emote {
        provider: String,
        id: String,
        url: String,
        text: Option<String>,
        #[serde(default)]
        zero_width: bool,
    },
}

impl ChatMessage {
    pub fn stable_key(&self) -> String {
        let mut out = format!(
            "{:.3}|{}|{}|{}|{}|",
            self.timestamp,
            self.created_at.as_deref().unwrap_or(""),
            self.username,
            self.display_name,
            self.user_color.as_deref().unwrap_or("")
        );
        for badge in &self.badges {
            out.push_str(&badge.provider);
            out.push(':');
            out.push_str(&badge.id);
            out.push(';');
        }
        for fragment in &self.fragments {
            match fragment {
                ChatFragment::Text { text } => out.push_str(text),
                ChatFragment::Emote {
                    provider,
                    id,
                    text,
                    zero_width,
                    ..
                } => {
                    out.push_str(provider);
                    out.push(':');
                    out.push_str(id);
                    if *zero_width {
                        out.push_str(":zw");
                    }
                    if let Some(text) = text {
                        out.push(':');
                        out.push_str(text);
                    }
                }
            }
        }
        out
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TwitchDownloaderChatRoot {
    pub streamer: TwitchDownloaderStreamer,
    pub video: TwitchDownloaderVideo,
    pub comments: Vec<TwitchDownloaderComment>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TwitchDownloaderStreamer {
    pub name: String,
    pub id: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TwitchDownloaderVideo {
    pub title: String,
    pub id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TwitchDownloaderComment {
    pub _id: String,
    pub created_at: String,
    pub updated_at: String,
    pub channel_id: String,
    pub content_type: String,
    pub content_id: String,
    pub content_offset_seconds: f64,
    pub commenter: TwitchDownloaderCommenter,
    pub source: String,
    pub state: String,
    pub message: TwitchDownloaderMessage,
    /// Fetchr extension: the chat a comment came from. TwitchDownloader ignores it; without it
    /// a Kick or W.TV chat written to json read back as Twitch.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub platform: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TwitchDownloaderCommenter {
    pub display_name: String,
    pub _id: String,
    pub name: String,
    pub r#type: String,
    pub bio: String,
    pub created_at: String,
    pub updated_at: String,
    pub logo: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TwitchDownloaderMessage {
    pub body: String,
    pub bits_spent: u64,
    pub fragments: Vec<TwitchDownloaderFragment>,
    pub user_badges: Vec<TwitchDownloaderBadge>,
    pub user_color: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TwitchDownloaderBadge {
    pub _id: String,
    pub version: String,
    /// Fetchr extensions, so Kick/W.TV badges keep their image through a json round-trip.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TwitchDownloaderFragment {
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub emoticon: Option<serde_json::Value>,
}

impl From<TwitchDownloaderComment> for ChatMessage {
    fn from(c: TwitchDownloaderComment) -> Self {
        let platform = c
            .platform
            .clone()
            .filter(|platform| !platform.is_empty())
            .unwrap_or_else(|| "twitch".to_string());
        let username = c.commenter.name.to_lowercase();
        let display_name = if c.commenter.display_name.is_empty() {
            c.commenter.name.clone()
        } else {
            c.commenter.display_name
        };

        let mut badges = Vec::new();
        for b in c.message.user_badges {
            badges.push(ChatBadge {
                provider: b.provider.unwrap_or_else(|| platform.clone()),
                id: b._id,
                version: Some(b.version),
                url: b.url,
                title: b.title,
            });
        }

        let mut fragments = Vec::new();
        if !c.message.fragments.is_empty() {
            for f in c.message.fragments {
                // A fragment with an `emoticon` object is an emote (native Twitch, or our own
                // round-trip that stored provider/url/id). Keep it as an Emote so it renders as an
                // image instead of being flattened to text.
                if let Some(em) = f.emoticon.as_ref() {
                    let provider = em.get("provider").and_then(|v| v.as_str());
                    let url = em.get("url").and_then(|v| v.as_str());
                    let id = em
                        .get("id")
                        .or_else(|| em.get("emoticon_id"))
                        .or_else(|| em.get("emoticonID"))
                        .and_then(|v| v.as_str())
                        .filter(|s| !s.is_empty());
                    let zero_width = em
                        .get("zero_width")
                        .and_then(|v| v.as_bool())
                        .unwrap_or(false);
                    match (provider, url, id) {
                        // Our preserved round-trip emote (any provider, explicit url).
                        (Some(provider), Some(url), Some(id)) => {
                            fragments.push(ChatFragment::Emote {
                                provider: provider.to_string(),
                                id: id.to_string(),
                                url: url.to_string(),
                                text: Some(f.text),
                                zero_width,
                            });
                            continue;
                        }
                        // Native Twitch emoticon: build the CDN url from the id.
                        (_, _, Some(id)) => {
                            fragments.push(ChatFragment::Emote {
                                provider: "twitch".to_string(),
                                id: id.to_string(),
                                url: format!(
                                    "https://static-cdn.jtvnw.net/emoticons/v2/{id}/default/dark/2.0"
                                ),
                                text: Some(f.text),
                                zero_width,
                            });
                            continue;
                        }
                        _ => {}
                    }
                }
                fragments.push(ChatFragment::Text { text: f.text });
            }
        } else if !c.message.body.is_empty() {
            fragments.push(ChatFragment::Text {
                text: c.message.body,
            });
        }

        ChatMessage {
            timestamp: c.content_offset_seconds,
            created_at: Some(c.created_at),
            username,
            display_name,
            user_color: c.message.user_color,
            badges,
            fragments,
            source_platform: platform,
        }
    }
}

impl ChatMessage {
    pub fn to_twitch_downloader_comment(&self, idx: usize) -> TwitchDownloaderComment {
        let created_at_str = self
            .created_at
            .clone()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| {
                chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
            });

        let mut body = String::new();
        let mut fragments = Vec::new();
        for f in &self.fragments {
            match f {
                ChatFragment::Text { text } => {
                    body.push_str(text);
                    fragments.push(TwitchDownloaderFragment {
                        text: text.clone(),
                        emoticon: None,
                    });
                }
                ChatFragment::Emote {
                    provider,
                    id,
                    url,
                    text,
                    zero_width,
                } => {
                    let emote_text = text.clone().unwrap_or_else(|| format!("Emote:{}", id));
                    body.push_str(&emote_text);
                    // Preserve the full emote so it survives a write→read round-trip; the renderer
                    // needs provider/url to fetch the image. `emoticon: None` here used to silently
                    // downgrade every emote (native + 7TV/BTTV/FFZ) back to plain text.
                    fragments.push(TwitchDownloaderFragment {
                        text: emote_text,
                        emoticon: Some(serde_json::json!({
                            "provider": provider,
                            "id": id,
                            "url": url,
                            "zero_width": zero_width,
                        })),
                    });
                }
            }
        }

        let user_badges = self
            .badges
            .iter()
            .map(|b| TwitchDownloaderBadge {
                _id: b.id.clone(),
                version: b.version.clone().unwrap_or_else(|| "1".to_string()),
                provider: Some(b.provider.clone()).filter(|provider| provider != "twitch"),
                url: b.url.clone(),
                title: b.title.clone(),
            })
            .collect();

        TwitchDownloaderComment {
            _id: format!("msg_{}", idx),
            created_at: created_at_str.clone(),
            updated_at: created_at_str.clone(),
            channel_id: "0".to_string(),
            content_type: "video".to_string(),
            content_id: "0".to_string(),
            content_offset_seconds: self.timestamp,
            commenter: TwitchDownloaderCommenter {
                display_name: self.display_name.clone(),
                _id: "0".to_string(),
                name: self.username.clone(),
                r#type: "user".to_string(),
                bio: "".to_string(),
                created_at: created_at_str.clone(),
                updated_at: created_at_str,
                logo: "".to_string(),
            },
            source: "chat".to_string(),
            state: "published".to_string(),
            message: TwitchDownloaderMessage {
                body,
                bits_spent: 0,
                fragments,
                user_badges,
                user_color: self.user_color.clone(),
            },
            platform: Some(self.source_platform.clone())
                .filter(|platform| !platform.is_empty() && platform != "twitch"),
        }
    }
}

pub fn read_chat_messages(path: &Path) -> Result<Vec<ChatMessage>> {
    let mut bytes = std::fs::read(path).with_context(|| format!("read {}", path.display()))?;

    // Attempt to parse as flat list of ChatMessage first
    let mut bytes_copy = bytes.clone();
    if let Ok(flat) = simd_json::from_slice::<Vec<ChatMessage>>(&mut bytes_copy) {
        return Ok(flat);
    }

    // Otherwise, parse as TwitchDownloader format
    // simd-json parses in place, so the foreign-format fallback needs the
    // original bytes: keep a copy only while the TwitchDownloader parse runs.
    let mut td_bytes = bytes.clone();
    let td_error = match simd_json::from_slice::<TwitchDownloaderChatRoot>(&mut td_bytes) {
        Ok(root) => return Ok(root.comments.into_iter().map(ChatMessage::from).collect()),
        Err(err) => err,
    };
    drop(td_bytes);

    // Kick / W.TV exports (raw API dumps or the app's normalized Kick json).
    if let Some(messages) = super::import_formats::parse_foreign_chat(&mut bytes) {
        return Ok(messages);
    }
    Err(anyhow::anyhow!("parse {}: {}", path.display(), td_error))
}

/// The channel a chat json belongs to, as far as the file itself states it.
///
/// This is what makes third-party (7TV/BTTV/FFZ) emotes work for a chat json
/// rendered on its own: the job URL is then a file path and names no channel.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChatStreamer {
    pub login: Option<String>,
    pub id: Option<String>,
}

/// Read the streamer a chat json names, without parsing the whole file.
///
/// TwitchDownloader writes `streamer` as the first key, so the head of the file
/// is enough — a multi-hour VOD json is far too big to parse twice.
pub fn read_chat_streamer(path: &Path) -> Option<ChatStreamer> {
    let mut head = vec![0_u8; 8192];
    let read = {
        use std::io::Read;
        let mut file = std::fs::File::open(path).ok()?;
        file.read(&mut head).ok()?
    };
    head.truncate(read);
    streamer_from_head(&String::from_utf8_lossy(&head))
}

fn streamer_from_head(head: &str) -> Option<ChatStreamer> {
    let key = head.find("\"streamer\"")?;
    let open = head[key..].find('{')? + key;
    let close = head[open..].find('}')? + open + 1;
    let value: serde_json::Value = serde_json::from_str(&head[open..close]).ok()?;
    // The placeholder identity older versions wrote names no channel.
    let login = value
        .get("name")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|name| !name.is_empty() && *name != "streamer")
        .map(str::to_string);
    let id = value
        .get("id")
        .and_then(serde_json::Value::as_u64)
        .filter(|id| *id != 0)
        .map(|id| id.to_string());
    if login.is_none() && id.is_none() {
        return None;
    }
    Some(ChatStreamer { login, id })
}

/// How often a live chat recorder rewrites its sidecar json.
///
/// Every flush writes all messages so far, so a fixed 5 s made the total work
/// grow with the square of the stream length (a long, busy stream rewrote
/// 100 MB+ every 5 s, inside the websocket read loop). The interval grows with
/// the chat instead, up to a minute: that much chat is at stake if the app is
/// killed mid-stream; a normal stop always writes everything, and a clip cut
/// from the running recording asks for a fresh write first (`live_flush`).
pub fn live_chat_flush_interval(message_count: usize) -> std::time::Duration {
    std::time::Duration::from_millis((message_count as u64 / 2).clamp(5_000, 60_000))
}

pub fn write_chat_messages(path: &Path, messages: &[ChatMessage]) -> Result<()> {
    write_chat_messages_for_streamer(path, messages, None)
}

/// Write a chat json that states which channel it came from, so re-rendering
/// the file later still finds the channel's 7TV/BTTV/FFZ emotes.
pub fn write_chat_messages_for_streamer(
    path: &Path,
    messages: &[ChatMessage],
    streamer: Option<&ChatStreamer>,
) -> Result<()> {
    let root = TwitchDownloaderChatRoot {
        streamer: TwitchDownloaderStreamer {
            name: streamer
                .and_then(|streamer| streamer.login.clone())
                .unwrap_or_else(|| "streamer".to_string()),
            id: streamer
                .and_then(|streamer| streamer.id.as_deref())
                .and_then(|id| id.parse::<u64>().ok())
                .unwrap_or(0),
        },
        video: TwitchDownloaderVideo {
            title: "video".to_string(),
            id: "0".to_string(),
        },
        comments: messages
            .iter()
            .enumerate()
            .map(|(idx, m)| m.to_twitch_downloader_comment(idx))
            .collect(),
    };
    // Compact and streamed: pretty-printing built the whole (often 100 MB+)
    // document as one string first. Readers parse either form, and the
    // streamer head stays at the start of the file. Written next to the
    // target and renamed over it, so a clip cut mid-stream never reads a
    // half-written file; if the rename is refused (a reader has it open), the
    // file is written in place as before.
    let tmp = path.with_extension("json.tmp");
    write_json_file(&tmp, &root)?;
    if std::fs::rename(&tmp, path).is_ok() {
        return Ok(());
    }
    let _ = std::fs::remove_file(&tmp);
    write_json_file(path, &root)
}

fn write_json_file(path: &Path, value: &impl Serialize) -> Result<()> {
    let file = std::fs::File::create(path).with_context(|| format!("write {}", path.display()))?;
    let mut writer = std::io::BufWriter::new(file);
    serde_json::to_writer(&mut writer, value)?;
    std::io::Write::flush(&mut writer).with_context(|| format!("write {}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::streamer_from_head;
    use super::ChatFragment;
    use super::ChatMessage;

    /// The channel of a chat json is what makes 7TV/BTTV/FFZ emotes work when the file is
    /// rendered on its own, so it has to survive a trip through the file.
    #[test]
    fn streamer_head_reads_the_channel_a_chat_json_names() {
        let head = r#"{"streamer":{"name":"rachelr","id":123456},"video":{"title":"t","id":"0"},"comments":["#;
        let streamer = streamer_from_head(head).expect("streamer");
        assert_eq!(streamer.login.as_deref(), Some("rachelr"));
        assert_eq!(streamer.id.as_deref(), Some("123456"));
    }

    /// The placeholder older versions wrote names no channel; taking it at face value would send
    /// the render looking for emotes of a channel called "streamer".
    #[test]
    fn streamer_head_ignores_the_placeholder_identity() {
        let head = r#"{"streamer":{"name":"streamer","id":0},"video":{"title":"t","id":"0"},"#;
        assert_eq!(streamer_from_head(head), None);
    }

    /// A bare message array — what the recorder agent sends — names nobody.
    #[test]
    fn streamer_head_of_a_flat_message_array_is_none() {
        assert_eq!(streamer_from_head(r#"[{"timestamp":0.0,"username":"a"}]"#), None);
    }

    /// A truncated head must not be read as an identity.
    #[test]
    fn streamer_head_cut_mid_object_is_none() {
        assert_eq!(streamer_from_head(r#"{"streamer":{"name":"rach"#), None);
    }

    #[test]
    fn old_chat_json_without_created_at_still_deserializes() {
        let raw = r#"{
            "timestamp": 1.25,
            "username": "user",
            "display_name": "User",
            "user_color": null,
            "badges": [],
            "fragments": [{"type": "text", "text": "hello"}],
            "source_platform": "twitch"
        }"#;
        let message: ChatMessage = serde_json::from_str(raw).expect("deserialize old message");
        assert_eq!(message.created_at, None);
        assert_eq!(message.display_name, "User");
    }

    #[test]
    fn test_simd_json_deserializes_chat_message() {
        let raw = r#"[
            {
                "timestamp": 1.25,
                "username": "user",
                "display_name": "User",
                "user_color": null,
                "badges": [],
                "fragments": [
                    {"type": "text", "text": "hello"},
                    {"type": "emote", "provider": "twitch", "id": "123", "url": "http://temp.com", "text": "emote_text", "zero_width": false}
                ],
                "source_platform": "twitch"
            }
        ]"#;
        let mut bytes = raw.as_bytes().to_vec();
        let res: Result<Vec<ChatMessage>, _> = simd_json::from_slice(&mut bytes);
        match res {
            Ok(messages) => {
                assert_eq!(messages.len(), 1);
                assert_eq!(messages[0].fragments.len(), 2);
            }
            Err(err) => {
                panic!("Failed to parse with simd-json: {}", err);
            }
        }
    }

    #[test]
    fn test_read_write_twitch_downloader_format() {
        let temp_dir = std::env::temp_dir();
        let path = temp_dir.join("test_chat_td.json");

        let messages = vec![ChatMessage {
            timestamp: 12.34,
            created_at: Some("2026-06-08T17:00:00Z".to_string()),
            username: "testuser".to_string(),
            display_name: "TestUser".to_string(),
            user_color: Some("#FF0000".to_string()),
            badges: vec![],
            fragments: vec![ChatFragment::Text {
                text: "hello world".to_string(),
            }],
            source_platform: "twitch".to_string(),
        }];

        // Write out in TD format
        super::write_chat_messages(&path, &messages).expect("write TD format");

        // Read back in
        let read_messages = super::read_chat_messages(&path).expect("read TD format");
        assert_eq!(read_messages.len(), 1);
        assert_eq!(read_messages[0].username, "testuser");
        assert_eq!(read_messages[0].display_name, "TestUser");
        assert_eq!(read_messages[0].timestamp, 12.34);
        assert_eq!(read_messages[0].user_color.as_deref(), Some("#FF0000"));

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn test_read_flat_array_format() {
        let temp_dir = std::env::temp_dir();
        let path = temp_dir.join("test_chat_flat.json");

        let raw = r#"[
            {
                "timestamp": 5.5,
                "username": "flatuser",
                "display_name": "FlatUser",
                "user_color": null,
                "badges": [],
                "fragments": [{"type": "text", "text": "hello flat"}],
                "source_platform": "twitch"
            }
        ]"#;
        std::fs::write(&path, raw).expect("write flat raw");

        let read_messages = super::read_chat_messages(&path).expect("read flat format");
        assert_eq!(read_messages.len(), 1);
        assert_eq!(read_messages[0].username, "flatuser");
        assert_eq!(read_messages[0].timestamp, 5.5);

        let _ = std::fs::remove_file(&path);
    }

    /// Читает реальную выгрузку чата с машины разработчика. На других машинах
    /// (CI, Mac) файла нет: запуск вручную — `cargo test -- --ignored`.
    #[test]
    #[ignore = "needs a local chat export in Downloads"]
    fn test_parse_user_file() {
        let path =
            std::path::Path::new("C:\\Users\\h3r0n\\Downloads\\выфвыфвыфвф_twitch_live_chat.json");
        if path.is_file() {
            let res = super::read_chat_messages(path);
            match res {
                Ok(msgs) => {
                    println!("Parsed successfully: {} messages", msgs.len());
                    assert!(!msgs.is_empty());
                }
                Err(err) => {
                    panic!("Failed to parse: {:?}", err);
                }
            }
        } else {
            panic!("Test file not found at {:?}", path);
        }
    }
}
