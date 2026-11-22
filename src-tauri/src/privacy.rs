//! What the app may send to the VPS: anonymous statistics, error reports and
//! job logs, each switched on or off by the user. Nothing goes out until the
//! first-run notice has been answered.
//!
//! The environment variables stay as a hard off switch for builds and support.

use std::path::PathBuf;

use once_cell::sync::Lazy;
use parking_lot::RwLock;
use serde::{Deserialize, Serialize};

const FILE: &str = "privacy.json";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct PrivacySettings {
    pub statistics: bool,
    pub error_reports: bool,
    pub job_logs: bool,
    pub notice_seen: bool,
}

impl Default for PrivacySettings {
    fn default() -> Self {
        Self {
            statistics: false,
            error_reports: false,
            job_logs: false,
            notice_seen: false,
        }
    }
}

static CURRENT: Lazy<RwLock<PrivacySettings>> = Lazy::new(|| RwLock::new(load()));

fn path() -> Option<PathBuf> {
    crate::platform::app_data_dir().map(|dir| dir.join(FILE))
}

fn load() -> PrivacySettings {
    path()
        .and_then(|path| std::fs::read_to_string(path).ok())
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

fn save(settings: &PrivacySettings) -> Result<(), String> {
    let path = path().ok_or_else(|| "App data folder is not available".to_string())?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|err| err.to_string())?;
    }
    let text = serde_json::to_string_pretty(settings).map_err(|err| err.to_string())?;
    let temp = path.with_extension("json.tmp");
    std::fs::write(&temp, text).map_err(|err| err.to_string())?;
    std::fs::rename(&temp, &path).map_err(|err| err.to_string())
}

fn switched_off(variable: &str) -> bool {
    std::env::var(variable).is_ok_and(|value| value.trim() == "0")
}

pub fn statistics_allowed() -> bool {
    let current = *CURRENT.read();
    current.notice_seen && current.statistics && !switched_off("FETCHR_TELEMETRY")
}

pub fn error_reports_allowed() -> bool {
    let current = *CURRENT.read();
    current.notice_seen && current.error_reports && !switched_off("FETCHR_ERROR_REPORTS")
}

pub fn job_logs_allowed() -> bool {
    let current = *CURRENT.read();
    current.notice_seen
        && current.job_logs
        && !switched_off("FETCHR_JOB_LOGS")
        && !switched_off("FETCHR_ERROR_REPORTS")
}

#[tauri::command]
pub fn get_privacy_settings() -> PrivacySettings {
    *CURRENT.read()
}

/// Turning something off also drops what was waiting to be sent; turning
/// statistics on (or answering the notice with it on) counts this launch.
#[tauri::command]
pub fn set_privacy_settings(settings: PrivacySettings) -> Result<PrivacySettings, String> {
    let was_counting = statistics_allowed();
    save(&settings)?;
    *CURRENT.write() = settings;
    if !settings.statistics {
        crate::telemetry::forget_local_state();
    }
    if !settings.error_reports {
        crate::error_reports::forget_pending();
    }
    if !settings.job_logs {
        crate::job_logs::forget_pending();
    }
    if !settings.error_reports && !settings.job_logs {
        crate::error_reports::forget_reporter_id();
    }
    if !was_counting && statistics_allowed() {
        crate::telemetry::track_app_launch();
    }
    Ok(settings)
}

#[cfg(test)]
mod tests {
    use super::PrivacySettings;

    #[test]
    fn nothing_counts_as_answered_by_default() {
        assert!(!PrivacySettings::default().notice_seen);
    }

    #[test]
    fn a_partial_or_older_file_keeps_the_defaults_for_the_rest() {
        let parsed: PrivacySettings = serde_json::from_str(r#"{"statistics":true}"#).unwrap();
        assert!(parsed.statistics);
        assert!(!parsed.error_reports);
        assert!(!parsed.job_logs);
        assert!(!parsed.notice_seen);
    }
}
