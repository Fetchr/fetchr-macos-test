//! On-demand flush of a running live chat recorder's sidecar json.
//!
//! Recorders rewrite the sidecar on an interval that grows with the chat
//! (`model::live_chat_flush_interval`, up to a minute on a busy stream). A
//! clip cut from the running recording reads that file, and the clip is
//! usually the last minute, so it first asks the recorder to write what it
//! has and waits for that.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use parking_lot::Mutex;

#[derive(Default)]
pub struct LiveChatFlush {
    requested: AtomicBool,
    written: AtomicU64,
}

impl LiveChatFlush {
    /// True once per request; the recorder then writes the sidecar.
    pub fn take_request(&self) -> bool {
        self.requested.swap(false, Ordering::SeqCst)
    }

    /// Called after every sidecar write (or a flush with nothing to write).
    pub fn mark_written(&self) {
        self.written.fetch_add(1, Ordering::SeqCst);
    }
}

fn recorders() -> &'static Mutex<HashMap<String, Arc<LiveChatFlush>>> {
    static RECORDERS: OnceLock<Mutex<HashMap<String, Arc<LiveChatFlush>>>> = OnceLock::new();
    RECORDERS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Registration of a running recorder; removed again when dropped.
pub struct LiveChatFlushGuard {
    job_id: String,
    pub flush: Arc<LiveChatFlush>,
}

impl Drop for LiveChatFlushGuard {
    fn drop(&mut self) {
        let mut recorders = recorders().lock();
        // A reconnect may have registered a newer recorder for the same job.
        if recorders
            .get(&self.job_id)
            .is_some_and(|current| Arc::ptr_eq(current, &self.flush))
        {
            recorders.remove(&self.job_id);
        }
    }
}

pub fn register(job_id: &str) -> LiveChatFlushGuard {
    let flush = Arc::new(LiveChatFlush::default());
    recorders()
        .lock()
        .insert(job_id.to_string(), flush.clone());
    LiveChatFlushGuard {
        job_id: job_id.to_string(),
        flush,
    }
}

/// Asks the running recorder of `job_id`, if there is one, to write its
/// sidecar now, and waits until it has or `timeout` passes. Recorders poll at
/// least once a second, so a second or two is enough.
pub async fn flush_live_chat(job_id: &str, timeout: Duration) {
    let Some(flush) = recorders().lock().get(job_id).cloned() else {
        return;
    };
    let before = flush.written.load(Ordering::SeqCst);
    flush.requested.store(true, Ordering::SeqCst);
    let deadline = Instant::now() + timeout;
    while flush.written.load(Ordering::SeqCst) == before && Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_flush_request_waits_for_the_recorder_write() {
        let guard = register("live-flush-test");
        let flush = guard.flush.clone();
        let recorder = tokio::spawn(async move {
            loop {
                if flush.take_request() {
                    flush.mark_written();
                    return;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        });
        let started = Instant::now();
        flush_live_chat("live-flush-test", Duration::from_secs(5)).await;
        assert!(started.elapsed() < Duration::from_secs(2), "returned on the write, not the timeout");
        recorder.await.expect("recorder task");
        drop(guard);
        assert!(recorders().lock().get("live-flush-test").is_none());
    }

    #[tokio::test]
    async fn no_recorder_means_no_wait() {
        let started = Instant::now();
        flush_live_chat("no-such-job", Duration::from_secs(5)).await;
        assert!(started.elapsed() < Duration::from_millis(100));
    }
}
