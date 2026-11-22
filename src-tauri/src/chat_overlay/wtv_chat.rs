//! W.TV chat: message parsing shared by the live recorder and json import.
//!
//! W.TV exposes no chat replay, only the last messages of a live chat
//! (`chats-service.w.tv/api/v1/chats/{channelId}/messages`), so a chat can only
//! be captured while the stream is live.

use std::collections::HashMap;

use serde_json::Value;

use crate::chat_overlay::model::{ChatBadge, ChatFragment, ChatMessage};

pub const WTV_PROVIDER: &str = "wtv";

/// Nickname palette of the W.TV web client, in its order: the colour of a user
/// is `userId (as a 128-bit hex number) % palette.len()`.
const NAME_PALETTE: [&str; 15] = [
    "#BCC2CF", "#4DF4FF", "#7F97FE", "#1381FF", "#B173FF", "#C34DFF", "#FF99EE", "#FF2681",
    "#FF4026", "#FF5D26", "#FF9673", "#FF974D", "#FFE601", "#A9FF26", "#26FF81",
];

pub fn wtv_name_color(user_id: &str) -> String {
    let hex = user_id.replace('-', "");
    match u128::from_str_radix(&hex, 16) {
        Ok(value) => NAME_PALETTE[(value % NAME_PALETTE.len() as u128) as usize].to_string(),
        Err(_) => NAME_PALETTE[0].to_string(),
    }
}

/// One message of the W.TV chat API. `base_ms` is the wall-clock moment that
/// maps to timestamp 0 of the recording.
pub fn parse_wtv_message(raw: &Value, base_ms: i64) -> Option<(String, ChatMessage)> {
    let kind = raw.get("type").and_then(Value::as_str).unwrap_or("MESSAGE");
    if kind != "MESSAGE" {
        return None;
    }
    let content = raw.get("content").and_then(Value::as_str)?.trim().to_string();
    if content.is_empty() {
        return None;
    }
    let id = raw
        .get("messageId")
        .and_then(Value::as_str)
        .map(str::to_string)?;
    let created_at = raw.get("createdAt").and_then(Value::as_str)?.to_string();
    let created_ms = chrono::DateTime::parse_from_rfc3339(&created_at)
        .ok()?
        .timestamp_millis();
    let sender = raw.get("sender").unwrap_or(&Value::Null);
    let nickname = sender
        .get("nickname")
        .and_then(Value::as_str)
        .unwrap_or("w.tv")
        .to_string();
    let user_id = sender.get("userId").and_then(Value::as_str).unwrap_or("");
    let user_color = sender
        .get("nicknameColor")
        .and_then(Value::as_str)
        .filter(|color| !color.trim().is_empty())
        .map(|color| format!("#{}", color.trim().trim_start_matches('#')))
        .unwrap_or_else(|| wtv_name_color(user_id));

    let mut fragments = Vec::new();
    if let Some(reply) = raw
        .pointer("/replyToMessage/sender/nickname")
        .and_then(Value::as_str)
    {
        fragments.push(ChatFragment::Text {
            text: format!("@{reply} "),
        });
    }
    fragments.push(ChatFragment::Text { text: content });

    Some((
        id,
        ChatMessage {
            timestamp: ((created_ms - base_ms) as f64 / 1000.0).max(0.0),
            created_at: Some(created_at),
            username: nickname.to_lowercase(),
            display_name: nickname,
            user_color: Some(user_color),
            badges: wtv_badges(sender),
            fragments,
            source_platform: WTV_PROVIDER.to_string(),
        },
    ))
}

/// The emote pack every W.TV chat offers (7TV-hosted images).
const GLOBAL_EMOTE_PACK: &str = "https://files.w.tv/emote_packs/01K34F5GERPBEYNJVQ6R780YVB.json";

/// Emote name → (id, image url). Empty when the pack is unreachable: messages then stay text.
pub async fn fetch_global_emotes(client: &reqwest::Client) -> HashMap<String, (String, String)> {
    let Ok(response) = client.get(GLOBAL_EMOTE_PACK).send().await else {
        return HashMap::new();
    };
    let Ok(pack) = response.json::<Value>().await else {
        return HashMap::new();
    };
    pack.get("emotes")
        .and_then(Value::as_array)
        .map(|emotes| {
            emotes
                .iter()
                .filter_map(|emote| {
                    let name = emote.get("name").and_then(Value::as_str)?;
                    let id = emote.get("id").and_then(Value::as_str)?;
                    Some((
                        name.to_string(),
                        (id.to_string(), format!("https://files.w.tv/emotes/{id}/2x.webp")),
                    ))
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Turn emote names in the text of a message into emote fragments.
pub fn apply_emotes(mut message: ChatMessage, emotes: &HashMap<String, (String, String)>) -> ChatMessage {
    if emotes.is_empty() {
        return message;
    }
    let mut fragments = Vec::with_capacity(message.fragments.len());
    for fragment in message.fragments {
        let ChatFragment::Text { text } = fragment else {
            fragments.push(fragment);
            continue;
        };
        let mut pending = String::new();
        for (index, word) in text.split(' ').enumerate() {
            if index > 0 {
                pending.push(' ');
            }
            match emotes.get(word) {
                Some((id, url)) => {
                    if !pending.is_empty() {
                        fragments.push(ChatFragment::Text {
                            text: std::mem::take(&mut pending),
                        });
                    }
                    fragments.push(ChatFragment::Emote {
                        provider: WTV_PROVIDER.to_string(),
                        id: id.clone(),
                        url: url.clone(),
                        text: Some(word.to_string()),
                        zero_width: false,
                    });
                }
                None => pending.push_str(word),
            }
        }
        if !pending.is_empty() {
            fragments.push(ChatFragment::Text { text: pending });
        }
    }
    message.fragments = fragments;
    message
}

pub fn parse_created_ms(raw: &Value) -> Option<i64> {
    let created_at = raw.get("createdAt").and_then(Value::as_str)?;
    chrono::DateTime::parse_from_rfc3339(created_at)
        .ok()
        .map(|date| date.timestamp_millis())
}

fn wtv_badges(sender: &Value) -> Vec<ChatBadge> {
    let tags: Vec<&str> = sender
        .get("tags")
        .and_then(Value::as_array)
        .map(|tags| tags.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();
    let mut badges = Vec::new();
    let mut push = |id: &str, title: &str| {
        badges.push(ChatBadge {
            provider: WTV_PROVIDER.to_string(),
            id: id.to_string(),
            version: None,
            url: None,
            title: Some(title.to_string()),
        });
    };
    if tags.contains(&"TAG_OWNER") {
        push("owner", "Владелец");
    } else if tags.contains(&"TAG_ROLE_MOD") {
        push("moderator", "Модератор");
    }
    if tags.contains(&"TAG_VERIFIED_STREAMER") {
        push("verified", "Верифицирован");
    }
    if let Some(badge) = sender.get("badge").filter(|badge| !badge.is_null()) {
        let url = badge
            .get("imageUrl")
            .or_else(|| badge.get("url"))
            .or_else(|| badge.get("image"))
            .and_then(Value::as_str);
        if let Some(url) = url {
            badges.push(ChatBadge {
                provider: WTV_PROVIDER.to_string(),
                id: badge
                    .get("id")
                    .or_else(|| badge.get("badgeId"))
                    .and_then(Value::as_str)
                    .unwrap_or(url)
                    .to_string(),
                version: None,
                url: Some(url.to_string()),
                title: badge.get("name").and_then(Value::as_str).map(str::to_string),
            });
        }
    }
    badges
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn name_color_matches_the_web_client_palette() {
        // 0x...c122 % 15 computed with BigInt in the W.TV client.
        let id = "019ff035-736b-725a-b8d6-5b0f2bb7c122";
        let value = u128::from_str_radix(&id.replace('-', ""), 16).unwrap();
        assert_eq!(wtv_name_color(id), NAME_PALETTE[(value % 15) as usize]);
        assert_eq!(wtv_name_color("not-hex"), NAME_PALETTE[0]);
    }

    #[test]
    fn parses_api_message_with_offset_and_roles() {
        let raw = json!({
            "messageId": "01a12216",
            "type": "MESSAGE",
            "content": "hello",
            "sender": {"userId": "019ff035-736b-725a-b8d6-5b0f2bb7c122", "nickname": "Streamer",
                       "tags": ["TAG_VERIFIED_STREAMER", "TAG_OWNER"]},
            "createdAt": "2026-10-09T19:14:05.500Z"
        });
        let base = chrono::DateTime::parse_from_rfc3339("2026-10-09T19:14:00.000Z")
            .unwrap()
            .timestamp_millis();
        let (id, message) = parse_wtv_message(&raw, base).expect("message");
        assert_eq!(id, "01a12216");
        assert!((message.timestamp - 5.5).abs() < 1e-6);
        assert_eq!(message.source_platform, "wtv");
        let badges: Vec<_> = message.badges.iter().map(|b| b.id.as_str()).collect();
        assert_eq!(badges, ["owner", "verified"]);
    }

    #[test]
    fn emote_names_become_emote_fragments() {
        let mut emotes = HashMap::new();
        emotes.insert("Prayge".to_string(), ("01F6".to_string(), "https://e/2x.webp".to_string()));
        let raw = json!({"messageId": "m", "type": "MESSAGE", "content": "hi Prayge all",
                         "sender": {"nickname": "a"}, "createdAt": "2026-10-09T19:14:05Z"});
        let (_, message) = parse_wtv_message(&raw, 0).unwrap();
        let message = apply_emotes(message, &emotes);
        assert_eq!(message.fragments.len(), 3);
        assert!(matches!(&message.fragments[1], ChatFragment::Emote { id, .. } if id == "01F6"));
        assert!(matches!(&message.fragments[2], ChatFragment::Text { text } if text == " all"));
    }

    #[test]
    fn skips_system_messages() {
        let raw = json!({"messageId": "x", "type": "MESSAGE_RAID_RECEIVED", "content": "r",
                         "createdAt": "2026-10-09T19:14:05Z"});
        assert!(parse_wtv_message(&raw, 0).is_none());
    }
}
