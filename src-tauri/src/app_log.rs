mod repeats;

use std::fs::{self, OpenOptions};
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Sender};
use std::thread;
use std::time::{Duration, SystemTime};

use repeats::RepeatFilter;

use chrono::{SecondsFormat, Utc};
use serde::Serialize;
use serde_json::{json, Value};

#[derive(Clone)]
pub struct AppLogger {
    tx: Sender<LogRecord>,
}

#[derive(Debug, Serialize)]
pub struct LogRecord {
    pub time: String,
    pub ts: i64,
    pub level: LogLevel,
    pub action: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub job_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stdout: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stderr: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub traceback: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum LogLevel {
    Debug,
    Info,
    Warn,
    Error,
}

impl AppLogger {
    pub fn new() -> Self {
        let (tx, rx) = mpsc::channel::<LogRecord>();
        let path = create_log_path();
        let writer_path = path.clone();

        thread::Builder::new()
            .name("fetchr-log-writer".to_string())
            .spawn(move || {
                let Some(path) = writer_path else {
                    drain_without_writing(rx);
                    return;
                };

                let file = OpenOptions::new().create(true).append(true).open(&path);
                let Ok(file) = file else {
                    drain_without_writing(rx);
                    return;
                };

                if let Some(dir) = path.parent() {
                    prune_old_logs(dir, &path);
                }

                let mut writer = BufWriter::new(file);
                let mut repeats = RepeatFilter::default();
                for record in rx.iter() {
                    for record in filter_repeats(&mut repeats, record) {
                        let line = match serde_json::to_string(&record) {
                            Ok(line) => line,
                            Err(err) => fallback_record("serialize_log_record", err.to_string()),
                        };
                        if writer.write_all(line.as_bytes()).is_err()
                            || writer.write_all(b"\n").is_err()
                        {
                            return;
                        }
                    }
                    let _ = writer.flush();
                }
            })
            .ok();

        let logger = Self { tx };
        logger.event(
            LogLevel::Info,
            "logger_started",
            None,
            Some(json!({ "file": path.map(|p| p.to_string_lossy().into_owned()) })),
        );
        logger
    }

    pub fn event(
        &self,
        level: LogLevel,
        action: impl Into<String>,
        message: Option<String>,
        input: Option<Value>,
    ) {
        self.write(LogRecord::new(level, action.into(), None, message, input));
    }

    pub fn job_event(
        &self,
        level: LogLevel,
        action: impl Into<String>,
        job_id: impl Into<String>,
        message: Option<String>,
        input: Option<Value>,
    ) {
        let mut record = LogRecord::new(level, action.into(), None, message, input);
        record.job_id = Some(job_id.into());
        self.write(record);
    }

    pub fn stdout(&self, job_id: &str, line: &str) {
        let mut record = LogRecord::new(
            LogLevel::Debug,
            "command_stdout".to_string(),
            None,
            None,
            None,
        );
        record.job_id = Some(job_id.to_string());
        record.stdout = Some(line.to_string());
        self.write(record);
    }

    pub fn stderr(&self, job_id: &str, line: &str) {
        let mut record = LogRecord::new(
            LogLevel::Warn,
            "command_stderr".to_string(),
            None,
            None,
            None,
        );
        record.job_id = Some(job_id.to_string());
        record.stderr = Some(line.to_string());
        self.write(record);
    }

    pub fn command_started(&self, job_id: &str, command: String, input: Option<Value>) {
        let mut record = LogRecord::new(
            LogLevel::Info,
            "command_started".to_string(),
            None,
            None,
            input,
        );
        record.job_id = Some(job_id.to_string());
        record.command = Some(command);
        self.write(record);
    }

    pub fn command_finished(&self, job_id: &str, command: String, exit_code: Option<i32>) {
        let mut record = LogRecord::new(
            if matches!(exit_code, Some(0) | Some(-1073741510)) {
                LogLevel::Info
            } else {
                LogLevel::Error
            },
            "command_finished".to_string(),
            None,
            None,
            None,
        );
        record.job_id = Some(job_id.to_string());
        record.command = Some(command);
        record.exit_code = exit_code;
        self.write(record);
    }

    pub fn error(
        &self,
        action: impl Into<String>,
        job_id: Option<String>,
        error: String,
        traceback: Option<String>,
        input: Option<Value>,
    ) {
        let mut record = LogRecord::new(LogLevel::Error, action.into(), None, None, input);
        record.job_id = job_id;
        record.error = Some(error);
        record.traceback = traceback;
        self.write(record);
    }

    fn write(&self, record: LogRecord) {
        crate::error_reports::observe_log_record(&record);
        let _ = self.tx.send(record);
    }
}

impl Default for AppLogger {
    fn default() -> Self {
        Self::new()
    }
}

impl LogRecord {
    fn new(
        level: LogLevel,
        action: String,
        job_id: Option<String>,
        message: Option<String>,
        input: Option<Value>,
    ) -> Self {
        let now = Utc::now();
        Self {
            time: now.to_rfc3339_opts(SecondsFormat::Millis, true),
            ts: now.timestamp_millis(),
            level,
            action,
            job_id,
            message,
            input,
            command: None,
            stdout: None,
            stderr: None,
            exit_code: None,
            error: None,
            traceback: None,
        }
    }
}

fn create_log_path() -> Option<PathBuf> {
    // Write logs to a stable per-user location (not the process CWD). Under
    // `tauri dev` the CWD is `src-tauri`, which the dev watcher monitors — a
    // download's log flood there would rebuild/restart the app in a loop.
    let base = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .map(|d| d.join("Fetchr"))
        .unwrap_or_else(std::env::temp_dir);
    let dir = base.join("Logs");
    if fs::create_dir_all(&dir).is_err() {
        return None;
    }
    let name = format!("{}.jsonl", Utc::now().format("%Y-%m-%d_%H-%M-%S-%3f"));
    Some(dir.join(name))
}

fn fallback_record(action: &str, error: String) -> String {
    json!({
        "time": Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
        "ts": Utc::now().timestamp_millis(),
        "level": "error",
        "action": action,
        "error": error,
    })
    .to_string()
}

fn drain_without_writing(rx: mpsc::Receiver<LogRecord>) {
    for _ in rx {}
}

/// The records to write for one incoming record: none for a repeated process
/// line, plus a summary of what was dropped once the job's command finishes.
fn filter_repeats(repeats: &mut RepeatFilter, record: LogRecord) -> Vec<LogRecord> {
    let Some(job_id) = record.job_id.clone() else {
        return vec![record];
    };
    let text = match record.action.as_str() {
        "command_stderr" => record.stderr.as_deref(),
        "command_stdout" => record.stdout.as_deref(),
        "job_log" => record.message.as_deref(),
        _ => None,
    };
    if let Some(text) = text {
        let key = format!("{}|{text}", record.action);
        return if repeats.admit(&job_id, &key) { vec![record] } else { Vec::new() };
    }
    if !matches!(
        record.action.as_str(),
        "command_finished" | "job_failed" | "job_cancelled" | "job_status"
    ) {
        return vec![record];
    }

    let mut out: Vec<LogRecord> = repeats.finish_job(&job_id).into_iter().map(|gone| {
        let sample = gone.sample.split_once('|').map_or(gone.sample.as_str(), |(_, s)| s);
        let mut summary = LogRecord::new(
            LogLevel::Warn,
            "log_repeats_suppressed".to_string(),
            Some(job_id.clone()),
            Some(format!("{} more lines like: {sample}", gone.dropped)),
            None,
        );
        summary.ts = record.ts;
        summary.time = record.time.clone();
        summary
    }).collect();
    out.push(record);
    out
}

const LOG_KEEP_DAYS: u64 = 14;
const LOG_KEEP_BYTES: u64 = 100 * 1024 * 1024;

/// Drop logs older than two weeks, then the oldest until the folder fits
/// `LOG_KEEP_BYTES`. Nothing rotated them, so a month of use kept every file.
fn prune_old_logs(dir: &Path, current: &Path) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    let max_age = Duration::from_secs(LOG_KEEP_DAYS * 24 * 3600);
    let now = SystemTime::now();
    let mut logs: Vec<(SystemTime, u64, PathBuf)> = entries
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path != current && path.extension().is_some_and(|ext| ext == "jsonl"))
        .filter_map(|path| {
            let meta = fs::metadata(&path).ok()?;
            Some((meta.modified().ok()?, meta.len(), path))
        })
        .collect();
    logs.sort_by_key(|(modified, _, _)| *modified);

    let mut total: u64 = logs.iter().map(|(_, len, _)| len).sum();
    for (modified, len, path) in logs {
        let too_old = now.duration_since(modified).is_ok_and(|age| age > max_age);
        if (too_old || total > LOG_KEEP_BYTES) && fs::remove_file(&path).is_ok() {
            total -= len;
        }
    }
}
