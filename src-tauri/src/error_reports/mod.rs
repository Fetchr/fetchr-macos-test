//! Error reports: warnings and errors from the app log and from `tracing`,
//! panics, and frontend exceptions. Each one is scrubbed of personal data,
//! reduced to a fingerprint, counted locally and sent in batches to the VPS
//! API, where equal fingerprints form one group that can be named and
//! tracked until it is fixed.
//!
//! Nothing here may disturb the app: every entry point is non-blocking, the
//! queue drops on overflow, and without an API URL the reporter never starts.

mod layer;
pub(crate) mod scrub;

use std::collections::{HashMap, HashSet, VecDeque};
use std::io::Write as _;
use std::path::PathBuf;
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, SyncSender};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use chrono::Utc;
use once_cell::sync::Lazy;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

use crate::app_log::{LogLevel, LogRecord};

pub use layer::ErrorReportLayer;

const QUEUE_CAPACITY: usize = 512;
const FLUSH_EVERY: Duration = Duration::from_secs(30);
const MAX_BACKOFF: Duration = Duration::from_secs(15 * 60);
const SEND_TIMEOUT: Duration = Duration::from_secs(12);
/// Distinct groups one run may report; a loop that fails differently every
/// time must not turn into an upload of its own.
const MAX_GROUPS_PER_RUN: usize = 300;
const MAX_REPORTS_PER_BATCH: usize = 50;
/// The server rejects larger counts; one report must never poison a batch.
const MAX_COUNT: u64 = 1_000_000;
/// A certificate that stops matching the pin is not retried forever.
const MAX_PIN_FAILURES: u32 = 3;
const MAX_QUEUED_MESSAGE_CHARS: usize = 8_000;
const TAIL_LINES: usize = 12;
const TAIL_JOBS: usize = 32;
const PENDING_FILE: &str = "error-reports-pending.json";
const PANICS_FILE: &str = "error-reports-panics.jsonl";
const REPORTER_ID_FILE: &str = "reporter-id";
const DISABLE_ENV: &str = "FETCHR_ERROR_REPORTS";
/// Log actions that are never reports: `job_status` repeats `job_failed`
/// without its message.
const IGNORED_ACTIONS: &[&str] = &["job_status"];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Source {
    Log,
    Tracing,
    Panic,
    Frontend,
}

impl Source {
    fn as_str(self) -> &'static str {
        match self {
            Source::Log => "log",
            Source::Tracing => "tracing",
            Source::Panic => "panic",
            Source::Frontend => "frontend",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    Warn,
    Error,
}

/// One group as it goes over the wire: the first occurrence plus how often
/// it happened since the group was last sent.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct Report {
    fingerprint: String,
    source: Source,
    level: Severity,
    code: String,
    message: String,
    context: Value,
    count: u64,
    first_at: String,
    last_at: String,
}

struct Incoming {
    source: Source,
    level: Severity,
    code: String,
    message: String,
    context: Value,
}

enum Msg {
    Report(Incoming),
    /// Bring the pending file up to date, then acknowledge.
    Persist(SyncSender<()>),
}

/// How the API answered one batch.
#[derive(Debug, PartialEq, Eq)]
enum Delivery {
    Accepted,
    /// The server refused the batch itself; sending it again cannot help.
    Rejected,
    /// Network trouble, rate limit or a server fault: try again later.
    Retry,
    /// The certificate does not match the pin: nothing was sent.
    Untrusted,
}

static SENDER: OnceLock<SyncSender<Msg>> = OnceLock::new();
/// Last stderr lines per job, attached to that job's error. Kept outside the
/// worker so a chatty ffmpeg never competes with real reports for the queue.
static TAILS: Lazy<Mutex<Tails>> = Lazy::new(|| Mutex::new(Tails::default()));

/// Starts the background sender. A no-op when the build has no API URL or
/// reports are switched off with `FETCHR_ERROR_REPORTS=0`.
pub fn start() {
    if std::env::var(DISABLE_ENV).is_ok_and(|value| value.trim() == "0") {
        return;
    }
    let Some(url) = crate::remote::join_api_url("/telemetry/errors") else {
        return;
    };
    let (tx, rx) = mpsc::sync_channel(QUEUE_CAPACITY);
    if SENDER.set(tx).is_err() {
        return;
    }
    let spawned = std::thread::Builder::new()
        .name("fetchr-error-reports".to_string())
        .spawn(move || {
            Worker::new(url, reporter_id(), crate::platform::app_data_dir()).run(rx)
        });
    if let Err(err) = spawned {
        tracing::debug!("error reports disabled: {err}");
    }
}

/// Queues one warning or error. Never blocks; drops when the queue is full.
pub fn report(source: Source, level: Severity, code: String, message: &str, context: Value) {
    if !sending_allowed() {
        return;
    }
    let Some(sender) = SENDER.get() else {
        return;
    };
    let _ = sender.try_send(Msg::Report(Incoming {
        source,
        level,
        code,
        message: message.chars().take(MAX_QUEUED_MESSAGE_CHARS).collect(),
        context,
    }));
}

/// Hook for `AppLogger`: errors become reports, stderr lines become context.
pub fn observe_log_record(record: &LogRecord) {
    if record.action == "command_stderr" {
        if let (Some(job_id), Some(line)) = (&record.job_id, &record.stderr) {
            TAILS.lock().push(job_id, line);
        }
        return;
    }
    // N_m3u8DL-RE prints its errors to stdout, so without this its failures
    // arrive with no reason attached. Only error-looking lines: stdout is noisy.
    if record.action == "command_stdout" {
        if let (Some(job_id), Some(line)) = (&record.job_id, &record.stdout) {
            if is_stdout_error_line(line) {
                TAILS.lock().push(job_id, line);
            }
        }
        return;
    }
    if !matches!(record.level, LogLevel::Error)
        || IGNORED_ACTIONS.contains(&record.action.as_str())
        || SENDER.get().is_none()
    {
        return;
    }
    let mut context = Map::new();
    let mut code = format!("log.{}", record.action);
    let program = record.command.as_deref().map(program_name);
    if let Some(program) = &program {
        context.insert("program".into(), json!(program));
    }
    if let Some(exit_code) = record.exit_code {
        context.insert("exit_code".into(), json!(exit_code));
    }
    // A failed command carries no message of its own: the program and exit
    // code are what separate one failure from another.
    let generated;
    let message = match (record.error.as_deref(), record.message.as_deref()) {
        (Some(error), _) => error,
        (None, Some(message)) => message,
        (None, None) => {
            if let Some(program) = &program {
                code = format!("{code}.{program}.{}", record.exit_code.unwrap_or(-1));
            }
            generated = format!(
                "{} exited with code {}",
                program.as_deref().unwrap_or("command"),
                record
                    .exit_code
                    .map_or_else(|| "unknown".to_string(), |code| code.to_string())
            );
            &generated
        }
    };
    if let Some(traceback) = &record.traceback {
        context.insert("traceback".into(), json!(traceback));
    }
    if let Some(job_id) = &record.job_id {
        let tail = TAILS.lock().tail(job_id);
        if !tail.is_empty() {
            context.insert("stderr_tail".into(), json!(tail));
        }
    }
    report(Source::Log, Severity::Error, code, message, Value::Object(context));
}

/// Entry point for exceptions the webview reports over IPC.
pub fn report_frontend(kind: &str, message: &str, stack: Option<&str>) {
    let kind: String = kind
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric() || *ch == '_')
        .take(40)
        .collect();
    let context = match stack {
        Some(stack) => json!({ "stack": stack.chars().take(6_000).collect::<String>() }),
        None => json!({}),
    };
    let message: String = message.chars().take(2_000).collect();
    report(
        Source::Frontend,
        Severity::Error,
        format!("ui.{}", if kind.is_empty() { "error" } else { &kind }),
        &message,
        context,
    );
}

/// Records panics on disk first: the process may not live long enough for
/// the queue, and the file is sent on the next start.
pub fn install_panic_hook() {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        if SENDER.get().is_some() && sending_allowed() {
            record_panic(info);
        }
        previous(info);
    }));
}

fn record_panic(info: &std::panic::PanicHookInfo<'_>) {
    let message = info
        .payload()
        .downcast_ref::<&str>()
        .map(|text| text.to_string())
        .or_else(|| info.payload().downcast_ref::<String>().cloned())
        .unwrap_or_else(|| "panic".to_string());
    let location = info
        .location()
        .map(|place| format!("{}:{}", place.file(), place.line()));
    // Last two path components only: a dependency's absolute path would
    // carry the user's profile name into the group code.
    let code = format!(
        "panic.{}",
        info.location()
            .map(|place| {
                let parts: Vec<&str> = place.file().rsplit(['\\', '/']).take(2).collect();
                parts
                    .iter()
                    .rev()
                    .map(|part| part.trim_end_matches(".rs"))
                    .collect::<Vec<_>>()
                    .join(".")
            })
            .unwrap_or_else(|| "unknown".to_string())
    );
    let thread = std::thread::current().name().unwrap_or("unnamed").to_string();
    let report = build_report(Incoming {
        source: Source::Panic,
        level: Severity::Error,
        code,
        message,
        context: json!({ "location": location, "thread": thread }),
    });
    let Some(dir) = crate::platform::app_data_dir() else {
        return;
    };
    let _ = std::fs::create_dir_all(&dir);
    if let (Ok(mut file), Ok(line)) = (
        std::fs::OpenOptions::new().create(true).append(true).open(dir.join(PANICS_FILE)),
        serde_json::to_string(&report),
    ) {
        let _ = writeln!(file, "{line}");
    }
}

/// Called on app exit: brings the counts in the pending file up to date.
pub fn persist_before_exit() {
    let Some(sender) = SENDER.get() else {
        return;
    };
    let (ack_tx, ack_rx) = mpsc::sync_channel(1);
    if sender.try_send(Msg::Persist(ack_tx)).is_ok() {
        let _ = ack_rx.recv_timeout(Duration::from_secs(1));
    }
}

/// Error reports were switched off: drop queued reports and panic records on disk.
pub fn forget_pending() {
    if let Some(dir) = crate::platform::app_data_dir() {
        let _ = std::fs::remove_file(dir.join(PENDING_FILE));
        let _ = std::fs::remove_file(dir.join(PANICS_FILE));
    }
}

/// Removes the stored random reporter id when both error reports and job logs are off.
pub fn forget_reporter_id() {
    if let Some(dir) = crate::platform::app_data_dir() {
        let _ = std::fs::remove_file(dir.join(REPORTER_ID_FILE));
    }
}

/// Random per-install id for grouping reports and job logs. It is not derived
/// from the machine id, so nothing sent under it can be matched with a license.
pub(crate) fn reporter_id() -> String {
    static ID: OnceLock<String> = OnceLock::new();
    ID.get_or_init(|| {
        let Some(path) = crate::platform::app_data_dir().map(|dir| dir.join(REPORTER_ID_FILE)) else {
            return new_reporter_id();
        };
        if let Some(id) = std::fs::read_to_string(&path)
            .ok()
            .map(|text| text.trim().to_string())
            .filter(|id| is_reporter_id(id))
        {
            return id;
        }
        let id = new_reporter_id();
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let _ = std::fs::write(&path, &id);
        id
    })
    .clone()
}

fn is_reporter_id(id: &str) -> bool {
    id.len() == 32 && id.chars().all(|ch| ch.is_ascii_hexdigit())
}

fn new_reporter_id() -> String {
    uuid::Uuid::new_v4().simple().to_string().to_uppercase()
}

/// The user's choice in the settings; tests exercise the worker without it.
fn sending_allowed() -> bool {
    cfg!(test) || crate::privacy::error_reports_allowed()
}

struct Worker {
    url: String,
    reporter_id: String,
    /// Where unsent reports survive restarts; `None` keeps them in memory.
    storage: Option<PathBuf>,
    /// Unsent groups, in the order they first appeared. Mirrored to the
    /// pending file whenever the set of groups changes.
    groups: HashMap<String, Report>,
    order: Vec<String>,
    /// Every group this run has accepted, sent or not.
    known: HashSet<String>,
    /// The batch in flight keeps its id across retries so the server can
    /// drop a copy it already stored.
    batch_id: Option<String>,
    next_attempt: Instant,
    backoff: Duration,
    pin_failures: u32,
}

impl Worker {
    fn new(url: String, reporter_id: String, storage: Option<PathBuf>) -> Self {
        Self {
            url,
            reporter_id,
            storage,
            groups: HashMap::new(),
            order: Vec::new(),
            known: HashSet::new(),
            batch_id: None,
            next_attempt: Instant::now() + FLUSH_EVERY,
            backoff: FLUSH_EVERY,
            pin_failures: 0,
        }
    }

    fn run(mut self, rx: Receiver<Msg>) {
        let Ok(runtime) = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
        else {
            return;
        };
        // Whatever an earlier run could not send goes out right away.
        let mut restored = read_pending(self.storage.as_deref());
        restored.extend(take_panics(self.storage.as_deref()));
        if !restored.is_empty() {
            for report in restored {
                self.merge(report);
            }
            self.save_pending();
            self.next_attempt = Instant::now();
        }
        loop {
            let wait = self.next_attempt.saturating_duration_since(Instant::now());
            match rx.recv_timeout(wait) {
                Ok(Msg::Report(incoming)) => {
                    if self.merge(build_report(incoming)) {
                        self.save_pending();
                    }
                }
                Ok(Msg::Persist(ack)) => {
                    self.save_pending();
                    let _ = ack.send(());
                }
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => break,
            }
            if Instant::now() >= self.next_attempt {
                let panics = take_panics(self.storage.as_deref());
                if !panics.is_empty() {
                    for report in panics {
                        self.merge(report);
                    }
                    self.save_pending();
                }
                let delivery = runtime.block_on(self.flush());
                self.schedule(delivery);
            }
        }
    }

    /// Adds a report; true when it started a new group.
    fn merge(&mut self, report: Report) -> bool {
        if let Some(existing) = self.groups.get_mut(&report.fingerprint) {
            existing.count = existing.count.saturating_add(report.count).min(MAX_COUNT);
            existing.last_at = report.last_at;
            return false;
        }
        if !self.known.contains(&report.fingerprint) {
            if self.known.len() >= MAX_GROUPS_PER_RUN {
                return false;
            }
            self.known.insert(report.fingerprint.clone());
        }
        self.order.push(report.fingerprint.clone());
        self.groups.insert(report.fingerprint.clone(), report);
        true
    }

    fn schedule(&mut self, delivery: Option<Delivery>) {
        match delivery {
            None | Some(Delivery::Accepted) | Some(Delivery::Rejected) => {
                self.backoff = FLUSH_EVERY;
                self.pin_failures = 0;
            }
            Some(Delivery::Retry) => self.backoff = (self.backoff * 2).min(MAX_BACKOFF),
            Some(Delivery::Untrusted) => {
                self.pin_failures += 1;
                self.backoff = MAX_BACKOFF;
            }
        }
        self.next_attempt = if self.pin_failures >= MAX_PIN_FAILURES {
            // Stays on disk for a build that knows the new certificate.
            Instant::now() + Duration::from_secs(365 * 24 * 3600)
        } else {
            Instant::now() + self.backoff
        };
        if self.pin_failures >= MAX_PIN_FAILURES {
            self.save_pending();
        }
    }

    /// Sends the oldest unsent groups; `None` when there was nothing to send.
    async fn flush(&mut self) -> Option<Delivery> {
        if self.order.is_empty() {
            return None;
        }
        // Switched off after these were queued: they are not to be sent later either.
        if !sending_allowed() {
            self.order.clear();
            self.groups.clear();
            self.batch_id = None;
            self.save_pending();
            return None;
        }
        let take = self.order.len().min(MAX_REPORTS_PER_BATCH);
        let batch: Vec<Report> = self.order[..take]
            .iter()
            .filter_map(|fingerprint| self.groups.get(fingerprint).cloned())
            .collect();
        let batch_id = self
            .batch_id
            .get_or_insert_with(|| uuid::Uuid::new_v4().to_string())
            .clone();
        let delivery = self.send(&batch_id, &batch).await;
        if matches!(delivery, Delivery::Accepted | Delivery::Rejected) {
            for fingerprint in self.order.drain(..take) {
                self.groups.remove(&fingerprint);
            }
            self.batch_id = None;
            self.save_pending();
        }
        Some(delivery)
    }

    async fn send(&self, batch_id: &str, batch: &[Report]) -> Delivery {
        let Ok(client) = crate::remote::secure_client(SEND_TIMEOUT) else {
            return Delivery::Retry;
        };
        // The pin can only be checked on a response, so a bodyless request
        // proves the server first; the batch follows on the same connection.
        match client.head(&self.url).send().await {
            Ok(response) => {
                if crate::remote::verify_tls_pin(&response).is_err() {
                    return Delivery::Untrusted;
                }
            }
            Err(_) => return Delivery::Retry,
        }
        let envelope = json!({
            "batch_id": batch_id,
            "app_version": crate::remote::app_version(),
            "channel": crate::remote::APP_CHANNEL,
            "machine_id": self.reporter_id,
            "os": format!("{}-{}", std::env::consts::OS, std::env::consts::ARCH),
            "sent_at": Utc::now().to_rfc3339(),
            "reports": batch,
        });
        match client.post(&self.url).json(&envelope).send().await {
            Ok(response) => classify(response.status().as_u16()),
            Err(_) => Delivery::Retry,
        }
    }

    fn save_pending(&self) {
        let Some(dir) = self.storage.as_deref() else {
            return;
        };
        let unsent: Vec<&Report> = self
            .order
            .iter()
            .filter_map(|fingerprint| self.groups.get(fingerprint))
            .collect();
        write_pending(dir, &unsent);
    }
}

fn classify(status: u16) -> Delivery {
    match status {
        200..=299 => Delivery::Accepted,
        429 | 500..=599 => Delivery::Retry,
        _ => Delivery::Rejected,
    }
}

fn build_report(incoming: Incoming) -> Report {
    let message = scrub::scrub(&incoming.message, scrub::MAX_MESSAGE_CHARS);
    let code = scrub::scrub(&incoming.code, 120);
    let shaped = scrub::shape(&message);
    let now = Utc::now().to_rfc3339();
    Report {
        fingerprint: scrub::fingerprint(incoming.source.as_str(), &code, &shaped),
        source: incoming.source,
        level: incoming.level,
        code,
        message,
        context: scrub_value(incoming.context),
        count: 1,
        first_at: now.clone(),
        last_at: now,
    }
}

/// Every string inside the context goes through the same scrubbing as the
/// message; arrays and objects are capped so one report stays small.
fn scrub_value(value: Value) -> Value {
    match value {
        Value::String(text) => Value::String(scrub::scrub(&text, scrub::MAX_LINE_CHARS * 8)),
        Value::Array(items) => Value::Array(
            items
                .into_iter()
                .take(TAIL_LINES * 2)
                // Arrays are stderr tails: external tools quote titles and
                // channel names, so their quoted text goes too.
                .map(|item| match item {
                    Value::String(text) => Value::String(scrub::mask_quoted(&scrub::scrub(
                        &text,
                        scrub::MAX_LINE_CHARS,
                    ))),
                    other => scrub_value(other),
                })
                .collect(),
        ),
        Value::Object(map) => Value::Object(
            map.into_iter()
                .take(24)
                .map(|(key, item)| (key, scrub_value(item)))
                .collect(),
        ),
        other => other,
    }
}

/// `C:\...\yt-dlp.exe --flag url` -> `yt-dlp`: the program says what failed,
/// the arguments carry the user's URLs and paths.
fn program_name(command: &str) -> String {
    let first = if let Some(stripped) = command.strip_prefix('"') {
        stripped.split('"').next().unwrap_or("")
    } else {
        command.split_whitespace().next().unwrap_or("")
    };
    let file = first.rsplit(['\\', '/']).next().unwrap_or(first);
    file.trim_end_matches(".exe")
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric() || "-_.".contains(*ch))
        .take(40)
        .collect()
}

/// Unsent groups, rewritten whole through a temporary file so a crash
/// mid-write never leaves half a list.
fn write_pending(dir: &std::path::Path, reports: &[&Report]) {
    let _ = std::fs::create_dir_all(dir);
    let path = dir.join(PENDING_FILE);
    if reports.is_empty() {
        let _ = std::fs::remove_file(&path);
        return;
    }
    let Ok(text) = serde_json::to_string(reports) else {
        return;
    };
    let temp = path.with_extension("json.tmp");
    if std::fs::write(&temp, text).is_ok() {
        let _ = std::fs::rename(&temp, &path);
    }
}

fn read_pending(dir: Option<&std::path::Path>) -> Vec<Report> {
    let Some(dir) = dir else {
        return Vec::new();
    };
    std::fs::read_to_string(dir.join(PENDING_FILE))
        .ok()
        .and_then(|text| serde_json::from_str::<Vec<Report>>(&text).ok())
        .map(|mut reports| {
            reports.truncate(MAX_GROUPS_PER_RUN);
            reports
        })
        .unwrap_or_default()
}

/// Moves the panic file aside before reading it, so a panic recorded while
/// it is being read lands in a fresh file instead of being deleted unseen.
fn take_panics(dir: Option<&std::path::Path>) -> Vec<Report> {
    let Some(dir) = dir else {
        return Vec::new();
    };
    let path = dir.join(PANICS_FILE);
    let taking = path.with_extension("jsonl.taking");
    if !taking.exists() && std::fs::rename(&path, &taking).is_err() {
        return Vec::new();
    }
    let reports = std::fs::read_to_string(&taking)
        .map(|text| {
            text.lines()
                .take(MAX_GROUPS_PER_RUN)
                .filter_map(|line| serde_json::from_str::<Report>(line).ok())
                .collect()
        })
        .unwrap_or_default();
    let _ = std::fs::remove_file(&taking);
    reports
}

#[derive(Default)]
struct Tails {
    jobs: VecDeque<(String, VecDeque<String>)>,
}

impl Tails {
    fn push(&mut self, job_id: &str, line: &str) {
        if is_progress_line(line) {
            return;
        }
        let index = match self.jobs.iter().position(|(id, _)| id == job_id) {
            Some(index) => index,
            None => {
                if self.jobs.len() >= TAIL_JOBS {
                    self.jobs.pop_front();
                }
                self.jobs.push_back((job_id.to_string(), VecDeque::new()));
                self.jobs.len() - 1
            }
        };
        let lines = &mut self.jobs[index].1;
        if lines.len() >= TAIL_LINES {
            lines.pop_front();
        }
        lines.push_back(line.chars().take(scrub::MAX_LINE_CHARS * 2).collect());
    }

    fn tail(&self, job_id: &str) -> Vec<String> {
        self.jobs
            .iter()
            .find(|(id, _)| id == job_id)
            .map(|(_, lines)| lines.iter().cloned().collect())
            .unwrap_or_default()
    }
}

/// ffmpeg/yt-dlp progress chatter: it would push the actual error out of the
/// tail and says nothing about why a job failed.
fn is_progress_line(line: &str) -> bool {
    let trimmed = line.trim_start();
    trimmed.starts_with("frame=")
        || trimmed.starts_with("size=")
        || trimmed.starts_with("[download]")
        || (trimmed.contains("time=") && trimmed.contains("bitrate="))
}

fn is_stdout_error_line(line: &str) -> bool {
    let lower = line.to_lowercase();
    lower.contains("error") || lower.contains("exception") || lower.contains("failed")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stdout_error_lines_are_told_apart_from_chatter() {
        assert!(is_stdout_error_line("09:03:07.512 ERROR: The remote server returned an error: (403)"));
        assert!(is_stdout_error_line("System.Net.Http.HttpRequestException: timed out"));
        assert!(!is_stdout_error_line("09:03:01.100 INFO : Loading URL: <url>"));
        assert!(!is_stdout_error_line("Vid 1920x1080 | 6000 Kbps ------ 12/340 3.5%"));
    }

    fn incoming(message: &str) -> Incoming {
        Incoming {
            source: Source::Log,
            level: Severity::Error,
            code: "log.download_failed".to_string(),
            message: message.to_string(),
            context: json!({ "stderr_tail": [r"ERROR: unable to open C:\Users\bob\Videos\x.mp4"] }),
        }
    }

    fn worker() -> Worker {
        Worker::new(String::new(), new_reporter_id(), None)
    }

    #[test]
    fn repeated_errors_merge_into_one_counted_group() {
        let mut worker = worker();
        worker.merge(build_report(incoming(r"HTTP 403 for C:\a\b.mp4 after 12 s")));
        worker.merge(build_report(incoming(r"HTTP 403 for D:\c\d.mp4 after 40 s")));
        worker.merge(build_report(incoming("disk full")));
        assert_eq!(worker.order.len(), 2);
        let first = &worker.groups[&worker.order[0]];
        assert_eq!(first.count, 2);
        assert_eq!(first.message, "HTTP 403 for <path>.mp4 after 12 s");
        assert_eq!(
            first.context["stderr_tail"][0],
            json!("ERROR: unable to open <path>.mp4")
        );
    }

    #[test]
    fn a_run_reports_a_bounded_number_of_distinct_groups() {
        let mut worker = worker();
        for index in 0..(MAX_GROUPS_PER_RUN + 50) {
            let mut report = build_report(incoming("x"));
            report.fingerprint = format!("{index:032x}");
            worker.merge(report);
        }
        assert_eq!(worker.order.len(), MAX_GROUPS_PER_RUN);
        // Sent groups stay known: their repeats are still counted.
        let sent: Vec<String> = worker.order.drain(..).collect();
        worker.groups.clear();
        let mut again = build_report(incoming("x"));
        again.fingerprint = sent[0].clone();
        again.count = 3;
        assert!(worker.merge(again));
        assert_eq!(worker.groups[&sent[0]].count, 3);
    }

    #[test]
    fn counts_never_exceed_what_the_server_accepts() {
        let mut worker = worker();
        let mut report = build_report(incoming("x"));
        report.count = MAX_COUNT - 1;
        let mut more = report.clone();
        more.count = 50;
        worker.merge(report);
        worker.merge(more);
        assert_eq!(worker.groups[&worker.order[0]].count, MAX_COUNT);
    }

    #[test]
    fn server_answers_decide_between_dropping_and_retrying() {
        assert_eq!(classify(202), Delivery::Accepted);
        assert_eq!(classify(400), Delivery::Rejected);
        assert_eq!(classify(413), Delivery::Rejected);
        assert_eq!(classify(429), Delivery::Retry);
        assert_eq!(classify(503), Delivery::Retry);
    }

    #[test]
    fn failures_back_off_and_a_foreign_certificate_stops_sending() {
        let mut worker = worker();
        worker.schedule(Some(Delivery::Retry));
        worker.schedule(Some(Delivery::Retry));
        assert_eq!(worker.backoff, FLUSH_EVERY * 4);
        worker.schedule(Some(Delivery::Accepted));
        assert_eq!(worker.backoff, FLUSH_EVERY);
        for _ in 0..MAX_PIN_FAILURES {
            worker.schedule(Some(Delivery::Untrusted));
        }
        assert!(worker.next_attempt > Instant::now() + Duration::from_secs(24 * 3600));
    }

    #[test]
    fn reporter_ids_are_random_hex() {
        let id = new_reporter_id();
        assert!(is_reporter_id(&id));
        assert_ne!(id, new_reporter_id());
        assert!(!is_reporter_id("not an id"));
    }

    #[test]
    fn unsent_reports_and_panics_survive_a_restart() {
        let dir = std::env::temp_dir().join(format!("fetchr-error-reports-{}", uuid::Uuid::new_v4()));
        let mut first = Worker::new(String::new(), new_reporter_id(), Some(dir.clone()));
        first.merge(build_report(incoming("disk full")));
        first.save_pending();
        let panic = build_report(Incoming {
            source: Source::Panic,
            level: Severity::Error,
            code: "panic.jobs.queue".to_string(),
            message: "index out of bounds".to_string(),
            context: json!({}),
        });
        std::fs::write(
            dir.join(PANICS_FILE),
            format!("{}
", serde_json::to_string(&panic).unwrap()),
        )
        .unwrap();
        let restored = read_pending(Some(&dir));
        let panics = take_panics(Some(&dir));
        assert_eq!(restored.len(), 1);
        assert_eq!(panics.len(), 1);
        assert!(!dir.join(PANICS_FILE).exists());
        // Once everything is sent the pending file disappears.
        write_pending(&dir, &[]);
        assert!(!dir.join(PENDING_FILE).exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn stderr_tail_skips_progress_and_keeps_the_last_lines() {
        let mut tails = Tails::default();
        for index in 0..20 {
            tails.push("job", &format!("line {index}"));
            tails.push("job", "frame=  100 fps=30 size=1kB time=00:00:01 bitrate=1kbits/s");
        }
        let tail = tails.tail("job");
        assert_eq!(tail.len(), TAIL_LINES);
        assert_eq!(tail.last().map(String::as_str), Some("line 19"));
        assert!(tails.tail("other").is_empty());
    }

    #[test]
    fn program_name_drops_path_and_arguments() {
        assert_eq!(program_name(r#""C:\Program Files\Fetchr\yt-dlp.exe" -f best https://x"#), "yt-dlp");
        assert_eq!(program_name(r"C:\tools\ffmpeg.exe -i C:\a.mp4"), "ffmpeg");
        assert_eq!(program_name("streamlink --twitch-disable-ads"), "streamlink");
    }

    /// Against a running `scripts/vps-api-server.mjs`:
    /// `FETCHR_ERRORS_TEST_URL=http://127.0.0.1:18787/telemetry/errors
    ///  cargo test --release --lib sends_a_batch -- --ignored`
    #[test]
    #[ignore]
    fn sends_a_batch_to_the_api_server() {
        let url = std::env::var("FETCHR_ERRORS_TEST_URL").expect("FETCHR_ERRORS_TEST_URL");
        let mut worker = Worker::new(url, new_reporter_id(), None);
        worker.merge(build_report(incoming(r"ffmpeg failed on C:\Users\bob\clip.mp4")));
        worker.merge(build_report(incoming(r"ffmpeg failed on C:\Users\eve\other.mp4")));
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let delivery = runtime.block_on(worker.flush());
        assert_eq!(delivery, Some(Delivery::Accepted));
        assert!(worker.order.is_empty(), "the server did not accept the batch");
    }
}
