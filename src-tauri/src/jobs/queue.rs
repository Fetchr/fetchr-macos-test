use std::path::PathBuf;
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use chrono::Utc;
use parking_lot::Mutex;
use serde_json::json;
use tauri::{AppHandle, Emitter, Manager};
use uuid::Uuid;

use crate::app_log::{AppLogger, LogLevel};

use super::runner::run_job;
use super::types::{Job, JobKind, JobProgress, JobSpec, JobStatus, LiveStats, Mode};

const EVENT_QUEUE_CHANGED: &str = "queue:changed";
/// One job's progress. Tools print progress many times a second; sending the
/// whole queue (and rewriting it to disk) for each line kept the UI busy.
const EVENT_QUEUE_PROGRESS: &str = "queue:progress";
/// Whether the queue is paused (no new jobs start), sent on pause/resume.
const EVENT_QUEUE_PAUSED: &str = "queue:paused";
/// At most this often per job; the newest value always goes out afterwards.
const PROGRESS_EVENT_INTERVAL: Duration = Duration::from_millis(250);

const EVENT_LOG: &str = "job:log";
const EVENT_FETCHR_MUTE_PROGRESS: &str = "fetchr_mute:progress";
const EVENT_VOCAL_REMOVER_PROGRESS: &str = "vocal_remover:progress";
const EVENT_SPONSOR_TRACKER_PROGRESS: &str = "sponsor_tracker:progress";
const EVENT_SPONSOR_TIMELINE_PROGRESS: &str = "sponsor_timeline:progress";
const EVENT_SETUP_PROGRESS: &str = "setup:progress";

#[derive(Default)]
struct Inner {
    jobs: Vec<Job>,
    running: std::collections::HashSet<String>,
    paused: bool,
    draining: bool,
    max_concurrent: usize,
    cancel_flags: std::collections::HashMap<String, Arc<std::sync::atomic::AtomicBool>>,
    progress_stages: std::collections::HashMap<String, (f32, f32, i64)>,
    /// Per-job log lines, flushed to `<directory>/log_<date>_<name>.log` when the job
    /// reaches a terminal state (done / cancelled / error).
    job_logs: std::collections::HashMap<String, Vec<String>>,
    /// When each job last sent a progress event.
    progress_sent_at: std::collections::HashMap<String, Instant>,
    /// Jobs whose newest progress has not been sent yet.
    progress_pending: std::collections::HashSet<String>,
}

#[derive(serde::Serialize)]
struct JobProgressEvent {
    id: String,
    progress: JobProgress,
    live_stats: Option<LiveStats>,
}

fn progress_event(inner: &Inner, id: &str) -> Option<JobProgressEvent> {
    let job = inner.jobs.iter().find(|j| j.id == id)?;
    Some(JobProgressEvent {
        id: job.id.clone(),
        progress: job.progress.clone(),
        live_stats: job.live_stats.clone(),
    })
}

const JOB_LOG_MAX_LINES: usize = 100_000;

pub struct QueueManager {
    inner: Mutex<Inner>,
    app: Option<AppHandle>,
    logger: AppLogger,
    persist_path: Option<PathBuf>,
    /// Wakes the thread that sends throttled progress (see `start_progress_flusher`).
    progress_wake: OnceLock<std::sync::mpsc::SyncSender<()>>,
    /// Held from reading the state to emitting it, so queue events leave in
    /// the order their contents were read: a progress event read after a
    /// snapshot can never arrive before it and be reverted by it.
    emit_order: Mutex<()>,
}

impl QueueManager {
    pub fn new(app: AppHandle, logger: AppLogger) -> Self {
        let persist_path = app
            .path()
            .app_data_dir()
            .ok()
            .map(|dir| dir.join("queue-state.json"));
        let manager = Self {
            inner: Mutex::new(Inner::default()),
            app: Some(app),
            logger,
            persist_path,
            progress_wake: OnceLock::new(),
            emit_order: Mutex::new(()),
        };
        manager.load_persisted();
        manager
    }

    pub fn new_mock(logger: AppLogger) -> Self {
        Self {
            inner: Mutex::new(Inner::default()),
            app: None,
            logger,
            persist_path: None,
            progress_wake: OnceLock::new(),
            emit_order: Mutex::new(()),
        }
    }

    /// Structural change (added, removed, reordered, status, output): the whole
    /// queue goes to the UI and to disk.
    fn emit_changed(&self) {
        let order = self.emit_order.lock();
        let snapshot = {
            let mut g = self.inner.lock();
            let inner = &mut *g;
            // The snapshot carries every job's newest progress.
            inner.progress_pending.clear();
            if inner.progress_sent_at.len() > inner.jobs.len() {
                let ids: std::collections::HashSet<&str> =
                    inner.jobs.iter().map(|j| j.id.as_str()).collect();
                inner.progress_sent_at.retain(|id, _| ids.contains(id.as_str()));
            }
            inner.jobs.clone()
        };
        if let Some(ref app) = self.app {
            let _ = app.emit(EVENT_QUEUE_CHANGED, &snapshot);
        }
        drop(order);
        self.persist(&snapshot);
    }

    /// Starts the thread that sends the progress `notify_progress` held back.
    /// Idle (blocked on the channel) while nothing is pending.
    pub fn start_progress_flusher(self: &Arc<Self>) {
        let (tx, rx) = std::sync::mpsc::sync_channel::<()>(1);
        if self.progress_wake.set(tx).is_err() {
            return;
        }
        let queue = Arc::downgrade(self);
        let _ = std::thread::Builder::new()
            .name("fetchr-queue-progress".to_string())
            .spawn(move || {
                while rx.recv().is_ok() {
                    std::thread::sleep(PROGRESS_EVENT_INTERVAL);
                    let Some(queue) = queue.upgrade() else {
                        break;
                    };
                    queue.flush_pending_progress();
                }
            });
    }

    /// Progress change: only this job goes to the UI, at most every
    /// `PROGRESS_EVENT_INTERVAL`; nothing is written to disk.
    fn notify_progress(&self, id: &str) {
        let _order = self.emit_order.lock();
        let now = Instant::now();
        let event = {
            let mut g = self.inner.lock();
            let due = g
                .progress_sent_at
                .get(id)
                .map_or(true, |at| now.duration_since(*at) >= PROGRESS_EVENT_INTERVAL);
            if due {
                g.progress_pending.remove(id);
                g.progress_sent_at.insert(id.to_string(), now);
                progress_event(&g, id)
            } else {
                g.progress_pending.insert(id.to_string());
                None
            }
        };
        match event {
            Some(event) => self.emit_progress(&event),
            None => {
                if let Some(wake) = self.progress_wake.get() {
                    let _ = wake.try_send(());
                }
            }
        }
    }

    fn flush_pending_progress(&self) {
        let _order = self.emit_order.lock();
        let now = Instant::now();
        let events: Vec<JobProgressEvent> = {
            let mut g = self.inner.lock();
            let ids: Vec<String> = g.progress_pending.drain().collect();
            ids.iter()
                .filter_map(|id| {
                    g.progress_sent_at.insert(id.clone(), now);
                    progress_event(&g, id)
                })
                .collect()
        };
        for event in &events {
            self.emit_progress(event);
        }
    }

    fn emit_progress(&self, event: &JobProgressEvent) {
        if let Some(ref app) = self.app {
            let _ = app.emit(EVENT_QUEUE_PROGRESS, event);
        }
    }

    /// Persist the queue to disk so tasks survive an app restart.
    /// Written atomically (temp file + rename); errors are non-fatal.
    fn persist(&self, snapshot: &[Job]) {
        let Some(ref path) = self.persist_path else {
            return;
        };
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if let Ok(bytes) = serde_json::to_vec(snapshot) {
            let tmp = path.with_extension("json.tmp");
            if std::fs::write(&tmp, &bytes).is_ok() {
                let _ = std::fs::rename(&tmp, path);
            }
        }
    }

    /// Restore the queue from disk at startup. Jobs that were running or paused
    /// cannot resume mid-flight, so they are requeued.
    fn load_persisted(&self) {
        let Some(ref path) = self.persist_path else {
            return;
        };
        let Ok(bytes) = std::fs::read(path) else {
            return;
        };
        let Ok(mut jobs) = serde_json::from_slice::<Vec<Job>>(&bytes) else {
            return;
        };
        for job in jobs.iter_mut() {
            if job.status == JobStatus::Running || job.status == JobStatus::Paused {
                job.status = JobStatus::Queued;
                job.started_at = None;
                job.finished_at = None;
            }
        }
        self.inner.lock().jobs = jobs;
    }

    pub fn enqueue(&self, spec: JobSpec) -> Job {
        let id = Uuid::new_v4().to_string();
        self.logger.job_event(
            LogLevel::Info,
            "job_enqueue",
            id.clone(),
            Some("Job queued".to_string()),
            Some(json!({ "spec": spec.clone() })),
        );
        let job = Job {
            id: id.clone(),
            spec,
            status: JobStatus::Queued,
            progress: JobProgress::default(),
            created_at: Utc::now().timestamp_millis(),
            started_at: None,
            finished_at: None,
            error: None,
            output_path: None,
            live_stats: None,
        };
        self.inner.lock().jobs.push(job.clone());
        self.emit_changed();
        job
    }

    pub fn list(&self) -> Vec<Job> {
        self.inner.lock().jobs.clone()
    }

    pub fn remove(&self, id: &str) -> bool {
        let mut g = self.inner.lock();
        if g.running.contains(id) {
            return false;
        }
        let before = g.jobs.len();
        g.jobs.retain(|j| j.id != id);
        let changed = g.jobs.len() != before;
        g.job_logs.remove(id);
        drop(g);
        if changed {
            crate::job_logs::remove_local(id);
        }
        if changed {
            self.logger.job_event(
                LogLevel::Info,
                "job_remove",
                id.to_string(),
                Some("Job removed from queue".to_string()),
                None,
            );
            self.emit_changed();
        }
        changed
    }

    pub fn move_job(&self, id: &str, direction: &str) -> bool {
        let mut g = self.inner.lock();
        if g.running.contains(id) {
            return false;
        }
        let Some(index) = g.jobs.iter().position(|j| j.id == id) else {
            return false;
        };
        if g.jobs[index].status != JobStatus::Queued {
            return false;
        }
        let target = match direction {
            "up" if index > 0 => index - 1,
            "down" if index + 1 < g.jobs.len() => index + 1,
            _ => return false,
        };
        if g.jobs[target].status == JobStatus::Running {
            return false;
        }
        g.jobs.swap(index, target);
        drop(g);
        self.emit_changed();
        true
    }

    /// Change the queue priority of a still-queued job. Running/terminal jobs are
    /// left untouched. The next drain picks higher priority first.
    pub fn set_priority(&self, id: &str, priority: i32) -> bool {
        let mut g = self.inner.lock();
        let Some(job) = g.jobs.iter_mut().find(|j| j.id == id) else {
            return false;
        };
        if job.status != JobStatus::Queued {
            return false;
        }
        job.spec.priority = priority;
        drop(g);
        self.emit_changed();
        true
    }

    /// Removes only successfully finished jobs (a stopped live recording counts
    /// as finished, as in the UI). Failed and cancelled jobs stay for retry.
    pub fn clear_completed(&self) {
        let mut g = self.inner.lock();
        g.jobs.retain(|j| {
            let finished = j.status == JobStatus::Done
                || (j.status == JobStatus::Cancelled && j.spec.mode == Mode::Live);
            !finished
        });
        drop(g);
        self.emit_changed();
    }

    pub fn cancel(&self, id: &str) {
        let mut g = self.inner.lock();
        if let Some(flag) = g.cancel_flags.get(id) {
            flag.store(true, std::sync::atomic::Ordering::SeqCst);
        }
        let mut became_terminal = false;
        if let Some(job) = g.jobs.iter_mut().find(|j| j.id == id) {
            if job.status == JobStatus::Queued {
                job.status = JobStatus::Cancelled;
                job.finished_at = Some(Utc::now().timestamp_millis());
                became_terminal = true;
            }
        }
        drop(g);
        if became_terminal {
            self.upload_job_log(id);
        }
        self.logger.job_event(
            LogLevel::Warn,
            "job_cancel_requested",
            id.to_string(),
            Some("Cancel requested".to_string()),
            None,
        );
        self.emit_changed();
    }

    /// Re-queue a cancelled/failed job (or kick a stale queued one) so the runner picks it
    /// up again. Download/render stages resume from partial files where the tools allow it.
    pub fn restart(&self, id: &str) -> bool {
        let mut g = self.inner.lock();
        if g.running.contains(id) {
            return false;
        }
        let Some(job) = g.jobs.iter_mut().find(|j| j.id == id) else {
            return false;
        };
        if !matches!(
            job.status,
            JobStatus::Cancelled | JobStatus::Error | JobStatus::Queued | JobStatus::Paused
        ) {
            return false;
        }
        job.status = JobStatus::Queued;
        // Keep the last known progress so the UI doesn't reset to 0% — the
        // download resumes from the partial file (yt-dlp --continue) and
        // re-reports its real position shortly after starting.
        job.error = None;
        job.started_at = None;
        job.finished_at = None;
        job.output_path = None;
        g.cancel_flags.remove(id);
        g.progress_stages.remove(id);
        g.job_logs.remove(id);
        drop(g);
        self.logger.job_event(
            LogLevel::Info,
            "job_restart",
            id.to_string(),
            Some("Job re-queued".to_string()),
            None,
        );
        self.emit_changed();
        true
    }

    pub fn pause(&self) {
        self.inner.lock().paused = true;
        self.emit_paused(true);
        self.logger.event(
            LogLevel::Info,
            "queue_pause",
            Some("Queue paused".to_string()),
            None,
        );
    }

    fn emit_paused(&self, paused: bool) {
        if let Some(ref app) = self.app {
            let _ = app.emit(EVENT_QUEUE_PAUSED, paused);
        }
    }

    pub fn set_output_path(&self, id: &str, path: String) {
        let file_size = std::fs::metadata(&path).ok().map(|meta| meta.len());
        let mut g = self.inner.lock();
        if let Some(job) = g.jobs.iter_mut().find(|j| j.id == id) {
            job.output_path = Some(path);
            if let Some(bytes) = file_size {
                job.progress.size = Some(format_bytes(bytes));
            }
        }
        drop(g);
        self.emit_changed();
    }

    pub fn set_progress(&self, id: &str, progress: JobProgress) {
        let mut g = self.inner.lock();
        let (stage_start, stage_end, stage_started_at) = g
            .progress_stages
            .get(id)
            .copied()
            .unwrap_or((0.0, 100.0, Utc::now().timestamp_millis()));
        let span = (stage_end - stage_start).max(0.0);
        if let Some(job) = g.jobs.iter_mut().find(|j| j.id == id) {
            let download_elapsed_ms = progress
                .download_elapsed_ms
                .or(job.progress.download_elapsed_ms);
            let speed = progress
                .speed
                .clone()
                .or_else(|| job.progress.speed.clone());
            let eta = progress.eta.clone().or_else(|| job.progress.eta.clone());
            let size = progress.size.clone().or_else(|| job.progress.size.clone());
            let downloaded_bytes = progress.downloaded_bytes.or(job.progress.downloaded_bytes);
            let total_bytes = progress.total_bytes.or(job.progress.total_bytes);
            let speed_bps = progress.speed_bps.or(job.progress.speed_bps);
            let current_segment = progress
                .current_segment
                .clone()
                .or_else(|| job.progress.current_segment.clone());
            let message = progress
                .message
                .clone()
                .or_else(|| job.progress.message.clone());
            job.progress = JobProgress {
                percent: (stage_start + progress.percent.clamp(0.0, 100.0) * span / 100.0)
                    .clamp(0.0, 100.0),
                stage_percent: Some(progress.percent.clamp(0.0, 100.0)),
                stage_start: Some(stage_start),
                stage_end: Some(stage_end),
                stage_started_at: Some(stage_started_at),
                download_elapsed_ms,
                downloaded_bytes,
                total_bytes,
                speed_bps,
                current_segment,
                speed,
                eta,
                size,
                message,
                ..progress
            };
        }
        if in_page_progress_event(id).is_some() {
            let actual_percent =
                (stage_start + progress.percent.clamp(0.0, 100.0) * span / 100.0).clamp(0.0, 100.0);
            let msg = progress.message.clone().unwrap_or_default();
            #[derive(serde::Serialize, Clone)]
            struct InPageProgressPayload {
                percent: f32,
                message: String,
                #[serde(rename = "taskId")]
                task_id: String,
            }
            if let Some(event) = in_page_progress_event(id) {
                if let Some(ref app) = self.app {
                    let _ = app.emit(
                        event,
                        InPageProgressPayload {
                            percent: actual_percent,
                            message: msg,
                            task_id: id.to_string(),
                        },
                    );
                }
            }
        }
        drop(g);
        self.notify_progress(id);
    }

    pub fn set_progress_stage(&self, id: &str, start: f32, end: f32, message: Option<String>) {
        let start = start.clamp(0.0, 100.0);
        let end = end.clamp(start, 100.0);
        let mut g = self.inner.lock();
        let stage_started_at = Utc::now().timestamp_millis();
        g.progress_stages
            .insert(id.to_string(), (start, end, stage_started_at));
        if let Some(job) = g.jobs.iter_mut().find(|j| j.id == id) {
            let download_elapsed_ms = job.progress.download_elapsed_ms;
            let speed = job.progress.speed.clone();
            let eta = job.progress.eta.clone();
            let size = job.progress.size.clone();
            let downloaded_bytes = job.progress.downloaded_bytes;
            let total_bytes = job.progress.total_bytes;
            let speed_bps = job.progress.speed_bps;
            let current_segment = job.progress.current_segment.clone();
            job.progress = JobProgress {
                percent: start,
                stage_percent: Some(0.0),
                stage_start: Some(start),
                stage_end: Some(end),
                stage_started_at: Some(stage_started_at),
                download_elapsed_ms,
                downloaded_bytes,
                total_bytes,
                speed_bps,
                current_segment,
                speed,
                eta,
                size,
                message: message.clone(),
            };
        }
        if let Some(event) = in_page_progress_event(id) {
            #[derive(serde::Serialize, Clone)]
            struct InPageProgressPayload {
                percent: f32,
                message: String,
            }
            if let Some(ref app) = self.app {
                let _ = app.emit(
                    event,
                    InPageProgressPayload {
                        percent: start,
                        message: message.clone().unwrap_or_default(),
                    },
                );
            }
        }
        drop(g);
        self.notify_progress(id);
    }

    /// Merge live-recording health stats into the job and notify the UI.
    pub fn set_live_stats(
        &self,
        id: &str,
        update: impl FnOnce(&mut crate::jobs::types::LiveStats),
    ) {
        let mut changed = false;
        {
            let mut g = self.inner.lock();
            if let Some(job) = g.jobs.iter_mut().find(|j| j.id == id) {
                let mut stats = job.live_stats.clone().unwrap_or_default();
                update(&mut stats);
                job.live_stats = Some(stats);
                changed = true;
            }
        }
        if changed {
            self.notify_progress(id);
        }
    }

    pub fn set_download_elapsed(&self, id: &str, elapsed_ms: i64) {
        let mut g = self.inner.lock();
        if let Some(job) = g.jobs.iter_mut().find(|j| j.id == id) {
            job.progress.download_elapsed_ms = Some(elapsed_ms.max(0));
        }
        drop(g);
        self.notify_progress(id);
    }

    pub fn set_status(&self, id: &str, status: JobStatus, err: Option<String>) {
        let err_for_log = err.clone();
        let mut g = self.inner.lock();
        if let Some(job) = g.jobs.iter_mut().find(|j| j.id == id) {
            job.status = status;
            if status == JobStatus::Running && job.started_at.is_none() {
                job.started_at = Some(Utc::now().timestamp_millis());
            }
            if status.is_terminal() {
                job.finished_at = Some(Utc::now().timestamp_millis());
                if let Some(e) = err {
                    job.error = Some(e);
                }
            }
        }
        drop(g);
        if status.is_terminal() || status == JobStatus::Running {
            self.logger.job_event(
                if matches!(status, JobStatus::Error) {
                    LogLevel::Error
                } else {
                    LogLevel::Info
                },
                "job_status",
                id.to_string(),
                Some(format!("Job status: {status:?}")),
                Some(json!({
                    "status": status,
                    "error": err_for_log,
                })),
            );
        }
        if status.is_terminal() {
            self.upload_job_log(id);
        }
        self.emit_changed();
    }

    /// Send the accumulated job log to the VPS (see `job_logs`); nothing is written to the
    /// user's folders. Called on every terminal transition (done / cancelled / error).
    fn upload_job_log(&self, id: &str) {
        let (job, lines) = {
            let mut g = self.inner.lock();
            let job = g.jobs.iter().find(|j| j.id == id).cloned();
            let lines = g.job_logs.remove(id).unwrap_or_default();
            (job, lines)
        };
        crate::job_logs::save_local(id, &lines);
        let Some(job) = job else { return };
        crate::job_logs::upload(crate::job_logs::FinishedJob {
            kind: match job.spec.job_kind {
                Some(JobKind::Chat) => "chat",
                Some(JobKind::FetchrMute) => "fetchr_mute",
                Some(JobKind::VpsDownload) => "vps_download",
                Some(JobKind::Video) | None => "video",
            },
            status: match job.status {
                JobStatus::Done => "done",
                JobStatus::Error => "error",
                _ => "cancelled",
            },
            name: &job.spec.name,
            url: &job.spec.url,
            error: job.error.as_deref(),
            created_at: job.created_at,
            finished_at: job.finished_at,
            lines: &lines,
        });
    }

    fn finish_job(&self, id: &str, result: Result<(), JobFailure>) {
        match result {
            Ok(()) => {
                self.set_status(id, JobStatus::Done, None);
                if let Some(job) = self
                    .inner
                    .lock()
                    .jobs
                    .iter()
                    .find(|job| job.id == id)
                    .cloned()
                {
                    crate::telemetry::track_job_finished(job.clone(), false);
                    crate::telemetry::track_download_completed(job);
                }
            }
            Err(failure) => {
                let cancelled = self
                    .inner
                    .lock()
                    .cancel_flags
                    .get(id)
                    .map(|f| f.load(std::sync::atomic::Ordering::SeqCst))
                    .unwrap_or(false);
                if cancelled {
                    // A cancel ends the job through the error path, but it is
                    // the user's choice, not a failure.
                    self.logger.job_event(
                        LogLevel::Info,
                        "job_cancelled",
                        id.to_string(),
                        Some(failure.message.clone()),
                        None,
                    );
                } else {
                    self.logger.error(
                        "job_failed",
                        Some(id.to_string()),
                        failure.message.clone(),
                        Some(failure.traceback.clone()),
                        None,
                    );
                }
                if cancelled {
                    self.set_status(id, JobStatus::Cancelled, Some(failure.message));
                } else {
                    self.set_status(id, JobStatus::Error, Some(failure.message));
                    let failed_job = self.inner.lock().jobs.iter().find(|job| job.id == id).cloned();
                    if let Some(job) = failed_job {
                        crate::telemetry::track_job_finished(job, true);
                    }
                }
            }
        }

        let mut g = self.inner.lock();
        g.cancel_flags.remove(id);
        g.progress_stages.remove(id);
        g.running.remove(id);
        drop(g);
        self.emit_changed();
    }

    /// Drain queued jobs up to the configured concurrency limit.
    pub async fn start(self: Arc<Self>) {
        loop {
            let next_batch = {
                let mut g = self.inner.lock();
                if g.paused {
                    g.draining = false;
                    Vec::new()
                } else {
                    let limit = g.max_concurrent.max(1);
                    let batch = next_jobs_to_start(&g.jobs, &g.running, limit);

                    for job in &batch {
                        g.running.insert(job.id.clone());
                        let flag = Arc::new(std::sync::atomic::AtomicBool::new(false));
                        g.cancel_flags.insert(job.id.clone(), flag);
                    }

                    if batch.is_empty() && g.running.is_empty() {
                        g.draining = false;
                    }
                    batch
                }
            };

            if next_batch.is_empty() {
                let done = {
                    let g = self.inner.lock();
                    !g.draining || (!g.paused && g.running.is_empty())
                };
                if done {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(250)).await;
                continue;
            }

            for job in next_batch {
                let q = self.clone();
                tauri::async_runtime::spawn(async move {
                    let id = job.id.clone();
                    q.set_status(&id, JobStatus::Running, None);
                    q.logger.job_event(
                        LogLevel::Info,
                        "job_started",
                        id.clone(),
                        Some("Job started".to_string()),
                        Some(json!({ "job": job })),
                    );

                    let cancel_flag = {
                        let g = q.inner.lock();
                        g.cancel_flags.get(&id).cloned()
                    };

                    let result = run_job(
                        q.clone(),
                        job,
                        cancel_flag
                            .unwrap_or_else(|| Arc::new(std::sync::atomic::AtomicBool::new(false))),
                    )
                    .await
                    .map_err(JobFailure::from);

                    q.finish_job(&id, result);
                });
            }

            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
    }

    pub fn max_concurrent(&self) -> usize {
        self.inner.lock().max_concurrent.max(1)
    }

    /// Change the limit of a running queue without touching its paused state;
    /// the drain loop reads it on every pass.
    pub fn set_max_concurrent(&self, max_concurrent: usize) {
        self.inner.lock().max_concurrent = max_concurrent.clamp(1, MAX_CONCURRENT_JOBS);
    }

    pub fn resume(self: Arc<Self>, max_concurrent: usize) {
        let should_spawn = {
            let mut g = self.inner.lock();
            g.paused = false;
            g.max_concurrent = max_concurrent.clamp(1, MAX_CONCURRENT_JOBS);
            if g.draining {
                false
            } else {
                g.draining = true;
                true
            }
        };
        self.emit_paused(false);

        if should_spawn {
            let me = self.clone();
            tauri::async_runtime::spawn(async move {
                me.start().await;
            });
        }
    }

    pub fn app_handle(&self) -> tauri::AppHandle {
        self.app
            .clone()
            .expect("app handle not available in mock mode")
    }

    /// Full log of one job: the live buffer while it runs, the local copy after.
    pub fn job_log_text(&self, id: &str) -> Option<String> {
        let live = self.inner.lock().job_logs.get(id).map(|lines| lines.join("
"));
        live.or_else(|| crate::job_logs::read_local(id))
    }

    pub fn emit_job_log(&self, id: &str, line: &str) {
        #[derive(serde::Serialize, Clone)]
        struct LogLine<'a> {
            id: &'a str,
            line: String,
            ts: i64,
        }

        let payload = LogLine {
            id,
            line: compact_ui_line(line),
            ts: Utc::now().timestamp_millis(),
        };
        if let Some(ref app) = self.app {
            let _ = app.emit(EVENT_LOG, payload);
        }

        {
            let mut g = self.inner.lock();
            let buffer = g.job_logs.entry(id.to_string()).or_default();
            if buffer.len() < JOB_LOG_MAX_LINES {
                buffer.push(format!(
                    "[{}] {line}",
                    chrono::Local::now().format("%Y-%m-%d %H:%M:%S")
                ));
            }
        }

        let level = if line.starts_with("!!") {
            LogLevel::Warn
        } else if line_is_process_warning(line) {
            LogLevel::Warn
        } else {
            LogLevel::Info
        };
        // "!!" lines are already in the file as `command_stderr` when they came
        // from a process; writing them there again tripled every ffmpeg error.
        self.logger.job_event(
            level,
            "job_log",
            id.to_string(),
            Some(line.to_string()),
            None,
        );
    }

    pub fn log_stdout(&self, id: &str, line: &str) {
        self.logger.stdout(id, line);
    }

    pub fn log_stderr(&self, id: &str, line: &str) {
        self.logger.stderr(id, line);
    }

    pub fn log_command_started(&self, id: &str, command: String, input: Option<serde_json::Value>) {
        self.logger.command_started(id, command, input);
    }

    pub fn log_command_finished(&self, id: &str, command: String, exit_code: Option<i32>) {
        self.logger.command_finished(id, command, exit_code);
    }

    pub fn emit_app_log(
        &self,
        level: LogLevel,
        action: &str,
        message: impl Into<String>,
        input: Option<serde_json::Value>,
    ) {
        let message = message.into();
        #[derive(serde::Serialize, Clone)]
        struct LogLine<'a> {
            id: &'a str,
            line: String,
            ts: i64,
        }

        let payload = LogLine {
            id: "system",
            line: compact_ui_line(&format!("{action}: {message}")),
            ts: Utc::now().timestamp_millis(),
        };
        if let Some(ref app) = self.app {
            let _ = app.emit(EVENT_LOG, payload);
        }
        self.logger
            .event(level, action.to_string(), Some(message), input);
    }

    pub fn emit_app_error(
        &self,
        action: &str,
        error: impl Into<String>,
        traceback: Option<String>,
        input: Option<serde_json::Value>,
    ) {
        let error = error.into();
        #[derive(serde::Serialize, Clone)]
        struct LogLine<'a> {
            id: &'a str,
            line: String,
            ts: i64,
        }

        let payload = LogLine {
            id: "system",
            line: compact_ui_line(&format!("{action}: ERROR: {error}")),
            ts: Utc::now().timestamp_millis(),
        };
        if let Some(ref app) = self.app {
            let _ = app.emit(EVENT_LOG, payload);
        }
        self.logger
            .error(action.to_string(), None, error, traceback, input);
    }
}

fn line_is_process_warning(line: &str) -> bool {
    let lower = line.to_lowercase();
    lower.contains("warn")
        || lower.contains("fallback")
        || lower.contains("skipped")
        || lower.contains("deprecated")
}

fn in_page_progress_event(id: &str) -> Option<&'static str> {
    if id.starts_with("sponsor_tracker_in_page_") {
        Some(EVENT_SPONSOR_TRACKER_PROGRESS)
    } else if id.starts_with("sponsor_timeline_") {
        Some(EVENT_SPONSOR_TIMELINE_PROGRESS)
    } else if id.starts_with("in_page_") {
        Some(EVENT_FETCHR_MUTE_PROGRESS)
    } else if id.starts_with("vocal_remover_in_page_") {
        Some(EVENT_VOCAL_REMOVER_PROGRESS)
    } else if id.starts_with("setup_") {
        Some(EVENT_SETUP_PROGRESS)
    } else {
        None
    }
}

fn format_bytes(bytes: u64) -> String {
    const UNITS: [&str; 5] = ["B", "KiB", "MiB", "GiB", "TiB"];
    let mut value = bytes as f64;
    let mut unit_index = 0usize;
    while value >= 1024.0 && unit_index + 1 < UNITS.len() {
        value /= 1024.0;
        unit_index += 1;
    }
    if unit_index == 0 {
        format!("{bytes} {}", UNITS[unit_index])
    } else {
        format!("{value:.2} {}", UNITS[unit_index])
    }
}

#[derive(Debug)]
struct JobFailure {
    message: String,
    traceback: String,
}

impl From<anyhow::Error> for JobFailure {
    fn from(error: anyhow::Error) -> Self {
        Self {
            message: error.to_string(),
            traceback: format!("{error:?}"),
        }
    }
}

fn compact_ui_line(line: &str) -> String {
    const MAX_UI_CHARS: usize = 4000;
    if line.chars().count() <= MAX_UI_CHARS {
        return line.to_string();
    }
    let mut out: String = line.chars().take(MAX_UI_CHARS).collect();
    out.push_str(" ... [truncated in UI, full line saved to file]");
    out
}

const MAX_CONCURRENT_JOBS: usize = 8;

/// Queued jobs to start now, highest priority first (FIFO within a level).
///
/// Live recordings get their own lane: they run for hours and cannot wait
/// for a slot, and while one runs it must not hold back downloads and renders
/// either. The concurrency limit therefore counts only the other jobs.
fn next_jobs_to_start(
    jobs: &[Job],
    running: &std::collections::HashSet<String>,
    limit: usize,
) -> Vec<Job> {
    let is_live = |job: &Job| job.spec.mode == Mode::Live;
    let running_regular = jobs
        .iter()
        .filter(|job| running.contains(&job.id) && !is_live(job))
        .count();
    let mut free_slots = limit.saturating_sub(running_regular);
    let mut queued: Vec<&Job> = jobs
        .iter()
        .filter(|job| job.status == JobStatus::Queued && !running.contains(&job.id))
        .collect();
    queued.sort_by(|a, b| b.spec.priority.cmp(&a.spec.priority));
    queued
        .into_iter()
        .filter(|job| {
            if is_live(job) {
                return true;
            }
            if free_slots == 0 {
                return false;
            }
            free_slots -= 1;
            true
        })
        .cloned()
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn job(id: &str, mode: &str, status: JobStatus) -> Job {
        let mut job = QueueManager::new_mock(AppLogger::new()).enqueue(spec(mode));
        job.id = id.to_string();
        job.status = status;
        job
    }

    #[test]
    fn a_running_live_recording_does_not_take_the_only_slot() {
        let jobs = vec![
            job("live", "live", JobStatus::Running),
            job("vod", "vod", JobStatus::Queued),
        ];
        let running = std::collections::HashSet::from(["live".to_string()]);
        let started = next_jobs_to_start(&jobs, &running, 1);
        assert_eq!(started.iter().map(|j| j.id.as_str()).collect::<Vec<_>>(), ["vod"]);
    }

    #[test]
    fn a_queued_live_recording_starts_even_when_the_slots_are_full() {
        let jobs = vec![
            job("vod1", "vod", JobStatus::Running),
            job("vod2", "vod", JobStatus::Queued),
            job("live", "live", JobStatus::Queued),
        ];
        let running = std::collections::HashSet::from(["vod1".to_string()]);
        let started = next_jobs_to_start(&jobs, &running, 1);
        assert_eq!(started.iter().map(|j| j.id.as_str()).collect::<Vec<_>>(), ["live"]);
    }

    fn spec(mode: &str) -> JobSpec {
        serde_json::from_value(json!({
            "url": "https://example.com/v",
            "name": "t",
            "directory": "d",
            "mode": mode,
        }))
        .expect("minimal job spec")
    }

    fn progress(percent: f32) -> JobProgress {
        JobProgress {
            percent,
            ..JobProgress::default()
        }
    }

    #[test]
    fn progress_inside_the_interval_is_held_back_and_flushed_with_the_newest_value() {
        let queue = QueueManager::new_mock(AppLogger::new());
        let job = queue.enqueue(spec("vod"));

        queue.set_progress(&job.id, progress(10.0));
        assert!(queue.inner.lock().progress_pending.is_empty(), "first tick goes out at once");

        queue.set_progress(&job.id, progress(20.0));
        queue.set_progress(&job.id, progress(30.0));
        assert!(queue.inner.lock().progress_pending.contains(&job.id), "burst is held back");

        queue.flush_pending_progress();
        let g = queue.inner.lock();
        assert!(g.progress_pending.is_empty());
        let event = progress_event(&g, &job.id).expect("job exists");
        assert_eq!(event.progress.stage_percent, Some(30.0), "the flush carries the newest value");
    }

    #[test]
    fn a_structural_change_drops_pending_progress() {
        let queue = QueueManager::new_mock(AppLogger::new());
        let job = queue.enqueue(spec("vod"));
        queue.set_progress(&job.id, progress(10.0));
        queue.set_progress(&job.id, progress(20.0));
        assert!(!queue.inner.lock().progress_pending.is_empty());

        queue.set_output_path(&job.id, "out.mp4".to_string());
        assert!(queue.inner.lock().progress_pending.is_empty());
    }
}
