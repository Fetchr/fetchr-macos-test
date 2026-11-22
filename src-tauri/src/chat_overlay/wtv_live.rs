//! Live W.TV chat recorder: polls the chat API (it keeps only the last
//! messages, no replay) and writes a sidecar json like the Kick/Twitch recorders.

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use tokio::task::JoinHandle;

use crate::chat_overlay::emit_log;
use crate::chat_overlay::model::{
    live_chat_flush_interval, write_chat_messages_for_streamer, ChatMessage, ChatStreamer,
};
use crate::chat_overlay::wtv_chat::parse_wtv_message;
use crate::jobs::queue::QueueManager;
use crate::jobs::types::Job;

/// The API returns ~50 newest messages; polling this often keeps a busy chat
/// from scrolling past between two polls.
const POLL_INTERVAL: Duration = Duration::from_millis(1500);

pub struct WtvLiveChatRecorder {
    stop: Arc<AtomicBool>,
    output_path: PathBuf,
    task: JoinHandle<Result<usize>>,
}

impl WtvLiveChatRecorder {
    pub async fn stop_and_wait(self, queue: &Arc<QueueManager>, job_id: &str) -> Result<usize> {
        self.stop.store(true, Ordering::SeqCst);
        match tokio::time::timeout(Duration::from_secs(8), self.task).await {
            Ok(Ok(Ok(count))) => {
                emit_log(
                    queue,
                    job_id,
                    &format!(
                        "W.TV live chat recorder: captured {count} messages to {}",
                        self.output_path.display()
                    ),
                );
                Ok(count)
            }
            Ok(Ok(Err(err))) => Err(err),
            Ok(Err(err)) => Err(anyhow!("W.TV live chat recorder task failed: {err}")),
            Err(_) => Err(anyhow!("W.TV live chat recorder did not stop within timeout")),
        }
    }
}

pub fn is_wtv_live_channel_url(url: &str) -> bool {
    crate::wtv::parse_wtv_channel(url).is_some() && crate::wtv::requested_stream_id(url).is_none()
}

pub async fn start_wtv_live_chat_recorder(
    queue: Arc<QueueManager>,
    job: &Job,
    output_path: PathBuf,
    cancel: Arc<AtomicBool>,
) -> Result<WtvLiveChatRecorder> {
    let nickname = crate::wtv::parse_wtv_channel(&job.spec.url)
        .ok_or_else(|| anyhow!("W.TV channel name not found in URL"))?;
    let client = crate::wtv::client();
    let channel = crate::wtv::fetch_channel(&client, &nickname).await?;
    // First poll before returning, so a broken chat fails the start, not the recording.
    crate::wtv::fetch_chat_messages(&client, &channel.user_id)
        .await
        .context("W.TV chat is unavailable")?;

    if let Some(parent) = output_path.parent() {
        std::fs::create_dir_all(parent).with_context(|| format!("create {}", parent.display()))?;
    }
    emit_log(
        &queue,
        &job.id,
        &format!(
            "W.TV live chat recorder: polling chat of {}; writing {}",
            channel.nickname,
            output_path.display()
        ),
    );

    let stop = Arc::new(AtomicBool::new(false));
    let task_stop = stop.clone();
    let task_path = output_path.clone();
    let job_id = job.id.clone();
    let base_ms = chrono::Utc::now().timestamp_millis();
    // No streamer stamp: the render would take the nickname for a Twitch login.
    let streamer: Option<ChatStreamer> = None;
    let emotes = crate::chat_overlay::wtv_chat::fetch_global_emotes(&client).await;
    let task = tokio::spawn(async move {
        let mut seen = HashSet::new();
        let mut messages: Vec<ChatMessage> = Vec::new();
        let mut last_flush = std::time::Instant::now();
        let mut dirty = false;
        let mut failures = 0_u32;
        while !task_stop.load(Ordering::SeqCst) && !cancel.load(Ordering::SeqCst) {
            // Short per-poll timeout: stop waits only 8 s for the final write.
            let poll = tokio::time::timeout(
                Duration::from_secs(4),
                crate::wtv::fetch_chat_messages(&client, &channel.user_id),
            );
            match poll.await.unwrap_or_else(|_| Err(anyhow!("chat poll timed out"))) {
                Ok(items) => {
                    failures = 0;
                    for item in &items {
                        // Messages from before the recording started are not part of it.
                        if let Some((id, message)) = parse_wtv_message(item, base_ms) {
                            let created = crate::chat_overlay::wtv_chat::parse_created_ms(item);
                            if created.is_some_and(|ms| ms < base_ms) || !seen.insert(id) {
                                continue;
                            }
                            messages.push(crate::chat_overlay::wtv_chat::apply_emotes(
                                message, &emotes,
                            ));
                            dirty = true;
                        }
                    }
                }
                Err(err) => {
                    failures += 1;
                    if failures == 1 || failures % 20 == 0 {
                        emit_log(
                            &queue,
                            &job_id,
                            &format!("!! W.TV live chat poll failed ({failures}x): {err:#}"),
                        );
                    }
                }
            }
            if dirty && last_flush.elapsed() >= live_chat_flush_interval(messages.len()) {
                messages.sort_by(|a, b| a.timestamp.total_cmp(&b.timestamp));
                // A failed interim write (file open elsewhere) must not end the
                // recorder: the messages stay in memory for the next attempt.
                match write_chat_messages_for_streamer(&task_path, &messages, streamer.as_ref()) {
                    Ok(()) => dirty = false,
                    Err(err) => emit_log(
                        &queue,
                        &job_id,
                        &format!("!! W.TV live chat: interim write failed: {err:#}"),
                    ),
                }
                last_flush = std::time::Instant::now();
            }
            tokio::time::sleep(POLL_INTERVAL).await;
        }
        messages.sort_by(|a, b| a.timestamp.total_cmp(&b.timestamp));
        write_chat_messages_for_streamer(&task_path, &messages, streamer.as_ref())?;
        Ok(messages.len())
    });

    Ok(WtvLiveChatRecorder {
        stop,
        output_path,
        task,
    })
}
