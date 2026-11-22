//! Chat json formats other than Fetchr's own / TwitchDownloader's.
//!
//! Accepted for import:
//! - Kick API messages (`/api/v2/channels/{id}/messages`, pusher payloads, KickVOD dumps),
//!   as a bare array or wrapped in `{data: {messages}}` / `{messages}`;
//! - the app's normalized Kick export (`*.kick.chat.json`, `offsetMs` + `authorName`)
//!   and its raw export (`*.kick.raw-chat.json`, `source.videoCreatedAtMs`);
//! - W.TV chat API messages (`messageId` + `sender.nickname`).

use serde_json::Value;

use crate::chat_overlay::kick_live::{
    extract_message_content, kick_sender_badges, parse_kick_fragments,
};
use crate::chat_overlay::model::{ChatBadge, ChatFragment, ChatMessage};
use crate::chat_overlay::wtv_chat::{parse_created_ms, parse_wtv_message};

pub fn parse_foreign_chat(bytes: &mut [u8]) -> Option<Vec<ChatMessage>> {
    let root: Value = simd_json::from_slice(bytes).ok()?;
    let base_hint = root
        .pointer("/source/videoCreatedAtMs")
        .and_then(Value::as_i64);
    let items = message_items(&root)?;
    let first = items.iter().find(|item| item.is_object())?;

    let mut messages = if first.get("offsetMs").is_some() && first.get("authorName").is_some() {
        items.iter().filter_map(parse_kick_normalized).collect::<Vec<_>>()
    } else if first.get("messageId").is_some() && first.pointer("/sender/nickname").is_some() {
        let base = base_hint.or_else(|| items.iter().filter_map(parse_created_ms).min())?;
        items
            .iter()
            .filter_map(|item| parse_wtv_message(item, base).map(|(_, message)| message))
            .collect()
    } else if first.get("sender").is_some() || first.get("chat_id").is_some() {
        let base = base_hint.or_else(|| items.iter().filter_map(kick_created_ms).min())?;
        items
            .iter()
            .filter_map(|item| parse_kick_api_message(item, base))
            .collect()
    } else {
        return None;
    };
    messages.sort_by(|a, b| a.timestamp.total_cmp(&b.timestamp));
    Some(messages)
}

fn message_items(root: &Value) -> Option<&Vec<Value>> {
    root.as_array()
        .or_else(|| root.pointer("/data/messages").and_then(Value::as_array))
        .or_else(|| root.get("messages").and_then(Value::as_array))
        .or_else(|| root.get("data").and_then(Value::as_array))
}

pub(crate) fn kick_created_ms(raw: &Value) -> Option<i64> {
    let created = raw
        .get("created_at")
        .or_else(|| raw.get("createdAt"))
        .and_then(Value::as_str)?;
    parse_kick_time(created)
}

/// Kick writes both RFC 3339 (`2026-10-08T22:17:00Z`) and `2026-10-08 22:07:39`.
pub(crate) fn parse_kick_time(value: &str) -> Option<i64> {
    if let Ok(date) = chrono::DateTime::parse_from_rfc3339(value) {
        return Some(date.timestamp_millis());
    }
    chrono::NaiveDateTime::parse_from_str(value, "%Y-%m-%d %H:%M:%S")
        .ok()
        .map(|date| date.and_utc().timestamp_millis())
}

/// A Kick chat message as the Kick API returns it. `base_ms` maps to timestamp 0.
pub(crate) fn parse_kick_api_message(raw: &Value, base_ms: i64) -> Option<ChatMessage> {
    let kind = raw.get("type").and_then(Value::as_str).unwrap_or("message");
    if kind != "message" && kind != "reply" {
        return None;
    }
    let created_ms = kick_created_ms(raw)?;
    let content = extract_message_content(raw)?;
    let sender = raw.get("sender").or_else(|| raw.get("user"))?;
    let username = sender
        .get("slug")
        .or_else(|| sender.get("username"))
        .and_then(Value::as_str)
        .unwrap_or("kick")
        .to_string();
    let display_name = sender
        .get("username")
        .and_then(Value::as_str)
        .unwrap_or(&username)
        .to_string();
    Some(ChatMessage {
        timestamp: ((created_ms - base_ms) as f64 / 1000.0).max(0.0),
        created_at: raw
            .get("created_at")
            .or_else(|| raw.get("createdAt"))
            .and_then(Value::as_str)
            .map(str::to_string),
        username,
        display_name,
        user_color: sender
            .pointer("/identity/color")
            .or_else(|| sender.get("color"))
            .and_then(Value::as_str)
            .map(str::to_string),
        badges: kick_sender_badges(sender),
        fragments: parse_kick_fragments(&content),
        source_platform: "kick".to_string(),
    })
}

fn parse_kick_normalized(raw: &Value) -> Option<ChatMessage> {
    let offset_ms = raw.get("offsetMs").and_then(Value::as_f64)?;
    let author = raw.get("authorName").and_then(Value::as_str).unwrap_or("kick");
    let fragments = raw
        .get("fragments")
        .and_then(Value::as_array)
        .map(|items| items.iter().filter_map(normalized_fragment).collect::<Vec<_>>())
        .filter(|fragments| !fragments.is_empty())
        .or_else(|| {
            raw.get("text")
                .and_then(Value::as_str)
                .map(|text| vec![ChatFragment::Text { text: text.to_string() }])
        })?;
    let badges = raw
        .get("authorBadges")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|badge| {
                    Some(ChatBadge {
                        provider: "kick".to_string(),
                        id: badge.get("id").and_then(Value::as_str)?.to_string(),
                        version: badge.get("count").map(|count| count.to_string()),
                        url: badge
                            .get("url")
                            .or_else(|| badge.get("imageUrl"))
                            .and_then(Value::as_str)
                            .map(str::to_string),
                        title: badge.get("label").and_then(Value::as_str).map(str::to_string),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    Some(ChatMessage {
        timestamp: (offset_ms / 1000.0).max(0.0),
        created_at: raw.get("createdAt").and_then(Value::as_str).map(str::to_string),
        username: author.trim().to_lowercase().replace(' ', "_"),
        display_name: author.to_string(),
        user_color: raw.get("authorColor").and_then(Value::as_str).map(str::to_string),
        badges,
        fragments,
        source_platform: "kick".to_string(),
    })
}

fn normalized_fragment(raw: &Value) -> Option<ChatFragment> {
    let text = raw.get("text").and_then(Value::as_str).unwrap_or("").to_string();
    if raw.get("type").and_then(Value::as_str) == Some("emote") {
        let id = raw.get("id").and_then(Value::as_str)?.to_string();
        let url = raw
            .get("url")
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| format!("https://files.kick.com/emotes/{id}/fullsize"));
        return Some(ChatFragment::Emote {
            provider: "kick".to_string(),
            id,
            url,
            text: Some(text),
            zero_width: false,
        });
    }
    (!text.is_empty()).then_some(ChatFragment::Text { text })
}

#[cfg(test)]
mod tests {
    use super::parse_foreign_chat;

    fn parse(raw: &str) -> Vec<crate::chat_overlay::model::ChatMessage> {
        let mut bytes = raw.as_bytes().to_vec();
        parse_foreign_chat(&mut bytes).expect("parsed")
    }

    #[test]
    fn kick_api_page_is_timed_from_the_first_message() {
        let messages = parse(
            r##"{"data":{"messages":[
              {"id":"b","type":"message","content":"[emote:5756627:politeCat] hi","created_at":"2026-10-08T22:17:10Z",
               "sender":{"slug":"shiverpk","username":"shiverPK","identity":{"color":"#F2708A",
               "badges":[{"type":"moderator","text":"Moderator"}],
               "badges_v2":[{"name":"level","image_url":"https://ext.cdn.kick.com/l.png","selected":true}]}}},
              {"id":"a","type":"message","content":"first","created_at":"2026-10-08T22:17:00Z",
               "sender":{"slug":"x","username":"X","identity":{"badges":[]}}}
            ],"cursor":"1"}}"##,
        );
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0].display_name, "X");
        assert!((messages[1].timestamp - 10.0).abs() < 1e-6);
        assert_eq!(messages[1].source_platform, "kick");
        assert_eq!(messages[1].badges.len(), 2);
        assert_eq!(messages[1].badges[1].url.as_deref(), Some("https://ext.cdn.kick.com/l.png"));
        assert_eq!(messages[1].fragments.len(), 2);
    }

    #[test]
    fn normalized_kick_export_keeps_offsets() {
        let messages = parse(
            r##"[{"id":"1","platform":"kick","offsetMs":2500,"createdAt":"2026-01-01T00:00:02Z",
                 "authorName":"Some User","authorColor":"#00FF00","authorBadges":[{"id":"vip","label":"VIP","count":null}],
                 "text":"yo","fragments":[{"type":"text","text":"yo"}],"emotes":[]}]"##,
        );
        assert!((messages[0].timestamp - 2.5).abs() < 1e-6);
        assert_eq!(messages[0].username, "some_user");
        assert_eq!(messages[0].badges[0].id, "vip");
    }

    #[test]
    fn wtv_messages_are_recognized() {
        let messages = parse(
            r#"{"messages":[{"messageId":"m2","type":"MESSAGE","content":"b","createdAt":"2026-10-09T19:14:10Z",
                 "sender":{"userId":"01a11719-599c-71f0-aefb-529c8c3b0a8f","nickname":"Armor","tags":[]}},
               {"messageId":"m1","type":"MESSAGE","content":"a","createdAt":"2026-10-09T19:14:00Z",
                 "sender":{"userId":"01a11719-599c-71f0-aefb-529c8c3b0a8f","nickname":"Armor","tags":[]}}]}"#,
        );
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0].source_platform, "wtv");
        assert!((messages[1].timestamp - 10.0).abs() < 1e-6);
    }

    #[test]
    fn unknown_shapes_are_rejected() {
        let mut bytes = br#"{"foo":[{"bar":1}]}"#.to_vec();
        assert!(parse_foreign_chat(&mut bytes).is_none());
    }
}
