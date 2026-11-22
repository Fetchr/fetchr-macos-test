//! Live progress of the stream-list lookup, so the M3U8 Finder can show which
//! site is being asked right now instead of a bare spinner.

use serde::Serialize;
use tauri::{AppHandle, Emitter};

pub const EVENT: &str = "m3u8-source-progress";

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Stage {
    Started,
    /// Plain request hit a Cloudflare challenge; solving it in a WebView.
    Cloudflare,
    Done,
    Failed,
}

#[derive(Clone, Serialize)]
struct Payload<'a> {
    source: &'a str,
    stage: Stage,
    detail: Option<&'a str>,
}

pub fn emit(app: &AppHandle, source: &str, stage: Stage, detail: Option<&str>) {
    let _ = app.emit(EVENT, Payload { source, stage, detail });
}

/// Tracker site behind a URL, as the UI names its rows.
pub fn source_for_url(url: &str) -> Option<&'static str> {
    let host = url::Url::parse(url).ok()?.host_str()?.to_ascii_lowercase();
    if host.ends_with("twitchtracker.com") {
        Some("twitchtracker")
    } else if host.ends_with("sullygnome.com") {
        Some("sullygnome")
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tracker_urls_map_to_their_source() {
        assert_eq!(source_for_url("https://twitchtracker.com/rachelr/streams"), Some("twitchtracker"));
        assert_eq!(
            source_for_url("https://sullygnome.com/api/tables/channeltables/streams/365/1/1"),
            Some("sullygnome")
        );
        assert_eq!(source_for_url("https://example.com/"), None);
    }
}
