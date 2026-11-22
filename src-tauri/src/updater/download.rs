//! Streaming installer download for the in-app updater.
//!
//! The installer goes to disk as it arrives and is hashed on the fly, so a
//! large build never sits in memory whole, and the launch splash gets a
//! progress tick with the current speed a few times per second.
#![cfg_attr(not(target_os = "windows"), allow(dead_code))]

use std::collections::VecDeque;
use std::future::Future;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, Instant};

use serde::Serialize;

/// Event the frontend listens to for download and install progress.
pub const EVENT_UPDATE_PROGRESS: &str = "update:progress";

/// Rejection text of `install_update` after a user cancel. The frontend
/// matches it exactly to tell "later" apart from a real failure.
pub const UPDATE_CANCELLED: &str = "update-cancelled";

/// This long without a single byte (or without response headers) and the
/// download is failed.
const STALL_LIMIT: Duration = Duration::from_secs(30);
/// How often waits wake up to notice a cancel or a stall.
const POLL_EVERY: Duration = Duration::from_millis(250);
const PROGRESS_EVERY: Duration = Duration::from_millis(150);
const SPEED_WINDOW: Duration = Duration::from_secs(2);
/// Hard ceiling for the installer on disk: a broken or hostile server must
/// not be able to fill %TEMP% before the checksum gets a say.
const MAX_INSTALLER_BYTES: u64 = 1 << 30;

static INSTALL_RUNNING: AtomicBool = AtomicBool::new(false);
/// The attempt the user asked to cancel. Keyed by attempt id rather than a
/// plain flag: "Later" pressed before the backend picked the install up still
/// counts, and a stale click can never cancel the next attempt.
static CANCELLED_ATTEMPT: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum UpdatePhase {
    Download,
    Verify,
    Install,
}

#[derive(Debug, Clone, Serialize)]
pub struct UpdateProgress {
    pub phase: UpdatePhase,
    pub received: u64,
    pub total: Option<u64>,
    pub bytes_per_second: f64,
}

impl UpdateProgress {
    /// A step after the download: the file is complete, speed no longer applies.
    pub fn finished(phase: UpdatePhase, received: u64) -> Self {
        Self {
            phase,
            received,
            total: Some(received),
            bytes_per_second: 0.0,
        }
    }
}

/// One install at a time. `attempt` is the id the frontend picked for this
/// run; 0 means the run cannot be cancelled.
pub struct InstallGuard {
    attempt: u64,
}

impl InstallGuard {
    pub fn acquire(attempt: u64) -> Result<Self, String> {
        if INSTALL_RUNNING.swap(true, Ordering::SeqCst) {
            return Err("An update is already being installed.".to_string());
        }
        Ok(Self { attempt })
    }

    pub fn cancelled(&self) -> bool {
        self.attempt != 0 && CANCELLED_ATTEMPT.load(Ordering::SeqCst) == self.attempt
    }
}

impl Drop for InstallGuard {
    fn drop(&mut self) {
        INSTALL_RUNNING.store(false, Ordering::SeqCst);
    }
}

/// Marks one install attempt as cancelled, whether or not it has started yet.
pub fn request_cancel(attempt: u64) {
    CANCELLED_ATTEMPT.store(attempt, Ordering::SeqCst);
}

/// Runs `work` unless the user cancels first. The cancel is checked every
/// POLL_EVERY, so "Later" answers at once even while a request hangs.
pub async fn unless_cancelled<T>(
    guard: &InstallGuard,
    work: impl Future<Output = Result<T, String>>,
) -> Result<T, String> {
    tokio::pin!(work);
    let mut ticks = tokio::time::interval(POLL_EVERY);
    loop {
        tokio::select! {
            result = &mut work => return result,
            _ = ticks.tick() => {
                if guard.cancelled() {
                    return Err(UPDATE_CANCELLED.to_string());
                }
            }
        }
    }
}

/// Download speed averaged over a sliding window, so the number on screen
/// follows the link without twitching on every TCP burst.
pub struct SpeedMeter {
    window: Duration,
    samples: VecDeque<(Instant, u64)>,
}

impl SpeedMeter {
    pub fn new(window: Duration) -> Self {
        Self {
            window,
            samples: VecDeque::new(),
        }
    }

    /// Records the running byte count and returns bytes per second.
    pub fn record(&mut self, at: Instant, received: u64) -> f64 {
        self.samples.push_back((at, received));
        // Keep the newest sample that is still a full window old as the
        // anchor: the average then always spans the whole window.
        while self.samples.len() > 1
            && at.saturating_duration_since(self.samples[1].0) >= self.window
        {
            self.samples.pop_front();
        }
        let (since, base) = self.samples[0];
        let span = at.saturating_duration_since(since).as_secs_f64();
        if span <= 0.0 {
            return 0.0;
        }
        received.saturating_sub(base) as f64 / span
    }
}

/// Lets a progress tick through at most once per `every`.
pub struct ProgressGate {
    every: Duration,
    last: Option<Instant>,
}

impl ProgressGate {
    pub fn new(every: Duration) -> Self {
        Self { every, last: None }
    }

    pub fn ready(&mut self, now: Instant) -> bool {
        if let Some(last) = self.last {
            if now.saturating_duration_since(last) < self.every {
                return false;
            }
        }
        self.last = Some(now);
        true
    }
}

#[cfg(target_os = "windows")]
pub fn emit(app: &tauri::AppHandle, progress: UpdateProgress) {
    use tauri::Emitter;
    let _ = app.emit(EVENT_UPDATE_PROGRESS, progress);
}

/// Streams the installer into `partial`, hashing it on the way. Returns the
/// lowercase hex SHA-256 and the byte count; the caller verifies the hash and
/// moves the file into place.
#[cfg(target_os = "windows")]
pub async fn fetch_installer(
    app: &tauri::AppHandle,
    guard: &InstallGuard,
    url: url::Url,
    size_hint: Option<u64>,
    partial: &std::path::Path,
) -> Result<(String, u64), String> {
    use futures::StreamExt;
    use sha2::{Digest, Sha256};
    use tokio::io::AsyncWriteExt;

    // No overall deadline: a slow link must still be able to finish. A dead
    // one is caught by the stall limit: per read here, per chunk below.
    let client = reqwest::Client::builder()
        .https_only(true)
        .connect_timeout(Duration::from_secs(15))
        .read_timeout(STALL_LIMIT)
        .build()
        .map_err(|err| format!("Could not create download client: {err}"))?;
    let response = unless_cancelled(guard, async {
        tokio::time::timeout(STALL_LIMIT, client.get(url).send())
            .await
            .map_err(|_| "Installer server did not respond.".to_string())?
            .map_err(|err| format!("Could not download installer: {err}"))
    })
    .await?;
    let response = response
        .error_for_status()
        .map_err(|err| format!("Installer server returned an error: {err}"))?;
    let total = response.content_length().or(size_hint);

    let mut file = tokio::fs::File::create(partial)
        .await
        .map_err(|err| format!("Could not save installer: {err}"))?;
    let mut stream = response.bytes_stream();
    let mut hasher = Sha256::new();
    let mut received = 0_u64;
    let mut meter = SpeedMeter::new(SPEED_WINDOW);
    let mut gate = ProgressGate::new(PROGRESS_EVERY);
    let mut last_byte_at = Instant::now();
    meter.record(last_byte_at, 0);
    gate.ready(last_byte_at);
    emit(
        app,
        UpdateProgress {
            phase: UpdatePhase::Download,
            received,
            total,
            bytes_per_second: 0.0,
        },
    );

    loop {
        if guard.cancelled() {
            return Err(UPDATE_CANCELLED.to_string());
        }
        let next = tokio::time::timeout(POLL_EVERY, stream.next()).await;
        let now = Instant::now();
        match next {
            Ok(Some(chunk)) => {
                let chunk =
                    chunk.map_err(|err| format!("Installer download was interrupted: {err}"))?;
                received += chunk.len() as u64;
                if received > MAX_INSTALLER_BYTES {
                    return Err("Installer is larger than any Fetchr build could be.".to_string());
                }
                hasher.update(&chunk);
                file.write_all(&chunk)
                    .await
                    .map_err(|err| format!("Could not save installer: {err}"))?;
                last_byte_at = now;
            }
            Ok(None) => break,
            Err(_) if now.saturating_duration_since(last_byte_at) >= STALL_LIMIT => {
                return Err(format!(
                    "Installer download stalled: no data for {} seconds.",
                    STALL_LIMIT.as_secs()
                ));
            }
            Err(_) => {}
        }
        // Ticks keep coming during a stall too, so the speed on screen decays.
        if gate.ready(now) {
            emit(
                app,
                UpdateProgress {
                    phase: UpdatePhase::Download,
                    received,
                    total,
                    bytes_per_second: meter.record(now, received),
                },
            );
        }
    }

    file.flush()
        .await
        .map_err(|err| format!("Could not save installer: {err}"))?;
    drop(file);
    emit(app, UpdateProgress::finished(UpdatePhase::Download, received));
    Ok((hex::encode(hasher.finalize()), received))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ms(value: u64) -> Duration {
        Duration::from_millis(value)
    }

    #[test]
    fn speed_is_bytes_over_the_sampled_span() {
        let start = Instant::now();
        let mut meter = SpeedMeter::new(Duration::from_secs(2));
        assert_eq!(meter.record(start, 0), 0.0);
        let speed = meter.record(start + ms(500), 500_000);
        assert!((speed - 1_000_000.0).abs() < 1.0, "speed was {speed}");
    }

    #[test]
    fn speed_forgets_samples_older_than_the_window() {
        let start = Instant::now();
        let mut meter = SpeedMeter::new(Duration::from_secs(2));
        meter.record(start, 0);
        // A 10 MB burst in the first second must not inflate the later rate.
        meter.record(start + ms(1_000), 10_000_000);
        meter.record(start + ms(2_000), 11_000_000);
        meter.record(start + ms(3_000), 12_000_000);
        let speed = meter.record(start + ms(4_000), 13_000_000);
        assert!((speed - 1_000_000.0).abs() < 1.0, "speed was {speed}");
    }

    #[test]
    fn stalled_download_decays_to_zero() {
        let start = Instant::now();
        let mut meter = SpeedMeter::new(Duration::from_secs(2));
        meter.record(start, 0);
        meter.record(start + ms(1_000), 1_000_000);
        meter.record(start + ms(2_000), 2_000_000);
        let slowing = meter.record(start + ms(3_000), 2_000_000);
        assert!(slowing > 0.0 && slowing < 1_000_000.0, "speed was {slowing}");
        let stalled = meter.record(start + ms(4_000), 2_000_000);
        assert_eq!(stalled, 0.0);
    }

    #[test]
    fn same_instant_does_not_divide_by_zero() {
        let start = Instant::now();
        let mut meter = SpeedMeter::new(Duration::from_secs(2));
        meter.record(start, 0);
        assert_eq!(meter.record(start, 4_096), 0.0);
    }

    #[test]
    fn progress_gate_throttles_after_the_first_tick() {
        let start = Instant::now();
        let mut gate = ProgressGate::new(ms(150));
        assert!(gate.ready(start));
        assert!(!gate.ready(start + ms(100)));
        assert!(gate.ready(start + ms(150)));
        assert!(!gate.ready(start + ms(299)));
        assert!(gate.ready(start + ms(300)));
    }

    // The guard lives in process-wide statics: tests touching it take turns.
    static GUARD_TESTS: std::sync::Mutex<()> = std::sync::Mutex::new(());

    #[test]
    fn install_guard_is_exclusive_and_cancel_is_per_attempt() {
        let _turn = GUARD_TESTS.lock().unwrap_or_else(|poison| poison.into_inner());
        let guard = InstallGuard::acquire(7).expect("first install");
        assert!(InstallGuard::acquire(8).is_err());
        assert!(!guard.cancelled());
        request_cancel(6);
        assert!(!guard.cancelled(), "another attempt's cancel must not count");
        request_cancel(7);
        assert!(guard.cancelled());
        drop(guard);

        let next = InstallGuard::acquire(8).expect("guard released on drop");
        assert!(!next.cancelled(), "a stale cancel must not leak into the next attempt");
        drop(next);

        // "Later" pressed before the backend picked the attempt up.
        request_cancel(9);
        let early = InstallGuard::acquire(9).expect("free again");
        assert!(early.cancelled());
    }

    #[tokio::test]
    async fn cancel_interrupts_a_hanging_request() {
        let _turn = GUARD_TESTS.lock().unwrap_or_else(|poison| poison.into_inner());
        let guard = InstallGuard::acquire(21).expect("free");
        request_cancel(21);
        let hanging = std::future::pending::<Result<(), String>>();
        let result = tokio::time::timeout(Duration::from_secs(2), unless_cancelled(&guard, hanging))
            .await
            .expect("cancel must end the wait");
        assert_eq!(result, Err(UPDATE_CANCELLED.to_string()));
    }

    #[tokio::test]
    async fn finished_work_passes_through() {
        let _turn = GUARD_TESTS.lock().unwrap_or_else(|poison| poison.into_inner());
        let guard = InstallGuard::acquire(31).expect("free");
        let result = unless_cancelled(&guard, async { Ok::<_, String>(5) }).await;
        assert_eq!(result, Ok(5));
    }

    #[test]
    fn progress_serializes_for_the_frontend() {
        let json = serde_json::to_value(UpdateProgress::finished(UpdatePhase::Verify, 42))
            .expect("serializes");
        assert_eq!(json["phase"], "verify");
        assert_eq!(json["received"], 42);
        assert_eq!(json["total"], 42);
    }
}
