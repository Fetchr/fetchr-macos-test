//! Kick VOD chat straight from Kick: `/api/v1/video/{uuid}` gives the broadcast
//! window, `/api/v2/channels/{id}/messages?cursor=<µs>` pages the chat history
//! backwards from any moment (the cursor is a microsecond timestamp). The window
//! is cut into slices fetched in parallel, so a long VOD does not wait on one
//! cursor chain.

use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;

use anyhow::{anyhow, Context, Result};
use futures::{stream, StreamExt};
use serde_json::Value;

use crate::chat_overlay::emit_log;
use crate::chat_overlay::import_formats::{kick_created_ms, parse_kick_api_message, parse_kick_time};
use crate::chat_overlay::model::ChatMessage;
use crate::jobs::queue::QueueManager;

const SLICE_MS: i64 = 5 * 60 * 1000;
const PARALLEL_SLICES: usize = 6;
/// A slice of a busy chat can take many pages; this caps a runaway cursor loop.
const MAX_PAGES_PER_SLICE: usize = 4000;

pub struct KickVodWindow {
    pub channel_id: String,
    pub start_ms: i64,
    pub duration_ms: i64,
}

pub async fn fetch_vod_window(client: &reqwest::Client, video_id: &str) -> Result<KickVodWindow> {
    let url = format!("https://kick.com/api/v1/video/{video_id}");
    let value: Value = get_json(client, &url).await?;
    let live = value
        .get("livestream")
        .ok_or_else(|| anyhow!("Kick video {video_id} has no livestream info"))?;
    let channel_id = live
        .get("channel_id")
        .and_then(value_to_string)
        .ok_or_else(|| anyhow!("Kick video {video_id} has no channel id"))?;
    let start_ms = live
        .get("start_time")
        .and_then(Value::as_str)
        .and_then(parse_kick_time)
        .ok_or_else(|| anyhow!("Kick video {video_id} has no start time"))?;
    let duration_ms = live
        .get("duration")
        .and_then(Value::as_i64)
        .filter(|duration| *duration > 0)
        .ok_or_else(|| anyhow!("Kick video {video_id} has no duration"))?;
    Ok(KickVodWindow {
        channel_id,
        start_ms,
        duration_ms,
    })
}

/// Chat of `[from_ms, to_ms]` (wall clock), timestamps relative to `base_ms`.
pub async fn download_range(
    client: &reqwest::Client,
    channel_id: &str,
    base_ms: i64,
    from_ms: i64,
    to_ms: i64,
    queue: &Arc<QueueManager>,
    job_id: &str,
    cancel: Arc<AtomicBool>,
) -> Result<Vec<ChatMessage>> {
    if from_ms >= to_ms {
        return Err(anyhow!("selected Kick chat range is empty"));
    }
    let slices: Vec<(i64, i64)> = (from_ms..to_ms)
        .step_by(SLICE_MS as usize)
        .map(|start| (start, (start + SLICE_MS).min(to_ms)))
        .collect();
    let total = slices.len();
    let done = AtomicUsize::new(0);
    let results: Vec<Result<Vec<Value>>> = stream::iter(slices)
        .map(|(start, end)| {
            let cancel = cancel.clone();
            let done = &done;
            async move {
                let raw = download_slice(client, channel_id, start, end, &cancel).await;
                let finished = done.fetch_add(1, Ordering::SeqCst) + 1;
                if finished == 1 || finished % 12 == 0 || finished == total {
                    emit_log(
                        queue,
                        job_id,
                        &format!("Chat overlay: Kick chat history {finished}/{total} slices"),
                    );
                }
                raw
            }
        })
        .buffer_unordered(PARALLEL_SLICES)
        .collect()
        .await;

    let mut seen = HashSet::new();
    let mut messages = Vec::new();
    for slice in results {
        for raw in slice? {
            let id = raw.get("id").and_then(value_to_string).unwrap_or_default();
            if !id.is_empty() && !seen.insert(id) {
                continue;
            }
            if let Some(message) = parse_kick_api_message(&raw, base_ms) {
                messages.push(message);
            }
        }
    }
    messages.sort_by(|a, b| a.timestamp.total_cmp(&b.timestamp));
    Ok(messages)
}

async fn download_slice(
    client: &reqwest::Client,
    channel_id: &str,
    start_ms: i64,
    end_ms: i64,
    cancel: &AtomicBool,
) -> Result<Vec<Value>> {
    let mut cursor = (end_ms * 1000).to_string();
    let mut out = Vec::new();
    for _ in 0..MAX_PAGES_PER_SLICE {
        if cancel.load(Ordering::SeqCst) {
            return Err(anyhow!("cancelled"));
        }
        let url = format!("https://kick.com/api/v2/channels/{channel_id}/messages?cursor={cursor}");
        let page: Value = get_json(client, &url).await?;
        let data = page.get("data").unwrap_or(&Value::Null);
        let items = data
            .get("messages")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let oldest = items.iter().filter_map(kick_created_ms).min();
        out.extend(items.into_iter().filter(|item| {
            kick_created_ms(item).is_some_and(|created| created >= start_ms && created <= end_ms)
        }));
        let next = data.get("cursor").and_then(value_to_string);
        match (oldest, next) {
            (Some(oldest), Some(next)) if oldest >= start_ms && next != cursor => cursor = next,
            (None, Some(next)) if next != cursor && next.parse::<i64>().is_ok_and(|n| n / 1000 > start_ms) => {
                cursor = next
            }
            _ => return Ok(out),
        }
    }
    Ok(out)
}

async fn get_json(client: &reqwest::Client, url: &str) -> Result<Value> {
    let mut last_err = None;
    // Kick answers a burst of parallel slices with 429 now and then: back off
    // 1, 2, 4, 8 s rather than failing a long download on one refusal.
    for attempt in 0..5_u32 {
        if attempt > 0 {
            tokio::time::sleep(std::time::Duration::from_millis(500 << attempt)).await;
        }
        let response = client
            .get(url)
            .header("Accept", "application/json")
            .send()
            .await;
        match response {
            Ok(response) if response.status().as_u16() == 429 || response.status().is_server_error() => {
                last_err = Some(anyhow!("GET {url}: HTTP {}", response.status()));
            }
            Ok(response) => {
                return response
                    .error_for_status()
                    .with_context(|| format!("GET {url}"))?
                    .json()
                    .await
                    .with_context(|| format!("parse {url}"));
            }
            Err(err) => last_err = Some(anyhow!(err).context(format!("GET {url}"))),
        }
    }
    Err(last_err.unwrap_or_else(|| anyhow!("GET {url} failed")))
}

fn value_to_string(value: &Value) -> Option<String> {
    match value {
        Value::String(text) if !text.is_empty() => Some(text.clone()),
        Value::Number(number) => Some(number.to_string()),
        _ => None,
    }
}
