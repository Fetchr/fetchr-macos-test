//! Full job logs: every finished job (done, failed or cancelled) sends its
//! complete log to the VPS API, so problems can be fixed without waiting for
//! users to send logs themselves.
//!
//! Every line goes through the error-report scrubber first (paths, URLs,
//! tokens, e-mails, addresses and ids are removed). Unsent logs wait on disk
//! and go out with the next finished job. Nothing here may disturb the app:
//! uploads run in the background and every failure is silent.
//!
//! Switched off in the settings (see `privacy`), or with `FETCHR_JOB_LOGS=0` or
//! `FETCHR_ERROR_REPORTS=0`.

use std::path::{Path, PathBuf};
use std::time::Duration;

use chrono::Utc;
use serde_json::{json, Value};

use crate::error_reports::scrub;

const SEND_TIMEOUT: Duration = Duration::from_secs(30);
const PENDING_DIR: &str = "job-logs-pending";
/// Kept unsent logs; older ones are dropped first.
const MAX_PENDING: usize = 20;
const MAX_LINE_CHARS: usize = 4_000;
/// Upper bound of one uploaded log. A longer one keeps its start and its end,
/// where setup and the failure are.
const MAX_LOG_CHARS: usize = 900_000;
const HEAD_CHARS: usize = 250_000;

pub struct FinishedJob<'a> {
    pub kind: &'a str,
    pub status: &'a str,
    pub name: &'a str,
    pub url: &'a str,
    pub error: Option<&'a str>,
    pub created_at: i64,
    pub finished_at: Option<i64>,
    pub lines: &'a [String],
}

const LOCAL_DIR: &str = "job-logs";
/// Local copies kept for the "Лог" button; the oldest go first.
const MAX_LOCAL: usize = 300;

fn local_path(id: &str) -> Option<PathBuf> {
    // Job ids are UUIDs; anything else must not become a path.
    if id.is_empty() || !id.chars().all(|ch| ch.is_ascii_alphanumeric() || ch == '-') {
        return None;
    }
    Some(crate::platform::app_data_subdir(LOCAL_DIR)?.join(format!("{id}.log")))
}

/// Keeps the full, unscrubbed log on this machine so the user can still open
/// and save it after the job left memory. Independent of the VPS upload.
pub fn save_local(id: &str, lines: &[String]) {
    let Some(path) = local_path(id) else { return };
    if std::fs::write(&path, lines.join("
")).is_err() {
        return;
    }
    if let Some(dir) = path.parent() {
        prune_oldest(dir, MAX_LOCAL);
    }
}

pub fn read_local(id: &str) -> Option<String> {
    std::fs::read_to_string(local_path(id)?).ok()
}

pub fn remove_local(id: &str) {
    if let Some(path) = local_path(id) {
        let _ = std::fs::remove_file(path);
    }
}

fn prune_oldest(dir: &Path, keep: usize) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    let mut files: Vec<_> = entries
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let modified = entry.metadata().ok()?.modified().ok()?;
            Some((modified, entry.path()))
        })
        .collect();
    if files.len() <= keep {
        return;
    }
    files.sort_by_key(|(modified, _)| *modified);
    for (_, path) in files.iter().take(files.len() - keep) {
        let _ = std::fs::remove_file(path);
    }
}

/// Logs were switched off: what was waiting to be sent goes too.
pub fn forget_pending() {
    if let Some(dir) = pending_dir() {
        let _ = std::fs::remove_dir_all(dir);
    }
}

/// Queues the upload of one finished job's log. Never blocks.
pub fn upload(job: FinishedJob<'_>) {
    if !crate::privacy::job_logs_allowed() {
        return;
    }
    let Some(url) = crate::remote::join_api_url("/telemetry/job-logs") else {
        return;
    };
    let envelope = build_envelope(&job);
    tauri::async_runtime::spawn(async move {
        let pending = pending_dir();
        if !send(&url, &envelope).await {
            if let Some(dir) = &pending {
                save_pending(dir, &envelope);
            }
            return;
        }
        if let Some(dir) = &pending {
            flush_pending(&url, dir).await;
        }
    });
}

fn build_envelope(job: &FinishedJob<'_>) -> Value {
    json!({
        "log_id": uuid::Uuid::new_v4().to_string(),
        "machine_id": crate::error_reports::reporter_id(),
        "app_version": crate::remote::app_version(),
        "channel": crate::remote::APP_CHANNEL,
        "os": format!("{}-{}", std::env::consts::OS, std::env::consts::ARCH),
        "sent_at": Utc::now().to_rfc3339(),
        "kind": job.kind,
        "status": job.status,
        "name": scrub::scrub(job.name, 200),
        "source": scrub::scrub(job.url, 300),
        "error": job.error.map(|error| scrub::scrub(error, 2_000)),
        "duration_ms": job.finished_at.map(|end| (end - job.created_at).max(0)),
        "log": scrub_log(job.lines),
    })
}

fn scrub_log(lines: &[String]) -> String {
    let mut out = String::new();
    for line in lines {
        out.push_str(&scrub::scrub(line, MAX_LINE_CHARS));
        out.push('\n');
    }
    cap_log(out)
}

fn cap_log(log: String) -> String {
    let total = log.chars().count();
    if total <= MAX_LOG_CHARS {
        return log;
    }
    let tail_chars = MAX_LOG_CHARS - HEAD_CHARS;
    let head: String = log.chars().take(HEAD_CHARS).collect();
    let tail: String = log.chars().skip(total - tail_chars).collect();
    format!(
        "{head}\n... пропущено {} символов ...\n{tail}",
        total - HEAD_CHARS - tail_chars
    )
}

async fn send(url: &str, envelope: &Value) -> bool {
    let Ok(client) = crate::remote::secure_client(SEND_TIMEOUT) else {
        return false;
    };
    // The pin can only be checked on a response: a bodyless request proves the
    // server before the log goes out.
    match client.head(url).send().await {
        Ok(response) if crate::remote::verify_tls_pin(&response).is_ok() => {}
        _ => return false,
    }
    // Gzipped: a Cyrillic log is ~2 bytes per char and would trip the proxy's
    // body limit; compressed it is ~10x smaller.
    let Some(body) = gzip_json(envelope) else {
        return true;
    };
    let request = client
        .post(url)
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .header(reqwest::header::CONTENT_ENCODING, "gzip")
        .body(body);
    match request.send().await {
        // A 4xx means the server will never take this log; keeping it would
        // only block the queue.
        Ok(response) => {
            let status = response.status().as_u16();
            !(status == 429 || status >= 500)
        }
        Err(_) => false,
    }
}

fn gzip_json(value: &Value) -> Option<Vec<u8>> {
    use std::io::Write as _;
    let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    serde_json::to_writer(&mut encoder, value).ok()?;
    encoder.flush().ok()?;
    encoder.finish().ok()
}

fn pending_dir() -> Option<PathBuf> {
    Some(crate::platform::app_data_dir()?.join(PENDING_DIR))
}

fn save_pending(dir: &Path, envelope: &Value) {
    if std::fs::create_dir_all(dir).is_err() {
        return;
    }
    let mut files = pending_files(dir);
    while files.len() >= MAX_PENDING {
        let _ = std::fs::remove_file(files.remove(0));
    }
    let name = format!(
        "{}_{}.json",
        Utc::now().format("%Y%m%d%H%M%S%3f"),
        envelope["log_id"].as_str().unwrap_or("log")
    );
    if let Ok(bytes) = serde_json::to_vec(envelope) {
        let _ = std::fs::write(dir.join(name), bytes);
    }
}

/// Oldest first (names start with a timestamp).
fn pending_files(dir: &Path) -> Vec<PathBuf> {
    let mut files: Vec<PathBuf> = std::fs::read_dir(dir)
        .map(|entries| {
            entries
                .filter_map(|entry| entry.ok().map(|entry| entry.path()))
                .filter(|path| path.extension().is_some_and(|ext| ext == "json"))
                .collect()
        })
        .unwrap_or_default();
    files.sort();
    files
}

async fn flush_pending(url: &str, dir: &Path) {
    for path in pending_files(dir) {
        let Some(envelope) = std::fs::read(&path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        else {
            let _ = std::fs::remove_file(&path);
            continue;
        };
        if !send(url, &envelope).await {
            return;
        }
        let _ = std::fs::remove_file(&path);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gzip_body_round_trips() {
        use std::io::Read as _;
        let value = json!({ "log": "строка лога\n".repeat(1000) });
        let packed = gzip_json(&value).unwrap();
        let mut text = String::new();
        flate2::read::GzDecoder::new(packed.as_slice())
            .read_to_string(&mut text)
            .unwrap();
        assert_eq!(serde_json::from_str::<Value>(&text).unwrap(), value);
        assert!(packed.len() < text.len() / 10);
    }

    #[test]
    fn short_log_is_untouched() {
        assert_eq!(cap_log("a\nb\n".into()), "a\nb\n");
    }

    #[test]
    fn long_log_keeps_head_and_tail() {
        let log = format!("{}{}", "h".repeat(HEAD_CHARS), "x".repeat(MAX_LOG_CHARS + 10));
        let capped = cap_log(log);
        assert!(capped.starts_with(&"h".repeat(HEAD_CHARS)));
        assert!(capped.ends_with(&"x".repeat(MAX_LOG_CHARS - HEAD_CHARS)));
        assert!(capped.contains("пропущено"));
        assert!(capped.chars().count() < MAX_LOG_CHARS + 100);
    }
}
