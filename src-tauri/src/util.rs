//! Shared small helpers, deduplicated from per-module copies.

/// Human-readable byte size using decimal-prefixed binary units (KB/MB/GB),
/// one fractional digit. Matches the formatting used by the job modules.
pub fn format_bytes(bytes: u64) -> String {
    const UNITS: &[&str] = &["B", "KB", "MB", "GB"];
    let mut value = bytes as f64;
    let mut unit = 0usize;
    while value >= 1024.0 && unit + 1 < UNITS.len() {
        value /= 1024.0;
        unit += 1;
    }
    if unit == 0 {
        format!("{} {}", bytes, UNITS[unit])
    } else {
        format!("{value:.1} {}", UNITS[unit])
    }
}

/// Format a duration given in seconds as `h:mm:ss` (or `mm:ss` under an hour).
pub fn format_duration(seconds: f64) -> String {
    let total = seconds.max(0.0).round() as u64;
    let h = total / 3600;
    let m = (total % 3600) / 60;
    let s = total % 60;
    if h > 0 {
        format!("{h}:{m:02}:{s:02}")
    } else {
        format!("{m:02}:{s:02}")
    }
}

const HTTP_ATTEMPTS: u32 = 3;

/// Sends a request and reads its body, retrying when the network drops or
/// times out on the way. HTTP error statuses are returned as is: Twitch
/// answering 403 will answer 403 again.
pub async fn fetch_text_with_retry<F>(
    build: F,
) -> Result<(reqwest::StatusCode, String), reqwest::Error>
where
    F: Fn() -> reqwest::RequestBuilder,
{
    let mut attempt = 1;
    loop {
        let result = match build().send().await {
            Ok(resp) => {
                let status = resp.status();
                resp.text().await.map(|text| (status, text))
            }
            Err(err) => Err(err),
        };
        match result {
            Err(err) if attempt < HTTP_ATTEMPTS && is_transient(&err) => {
                tracing::info!("HTTP attempt {attempt} failed, retrying: {err}");
                tokio::time::sleep(std::time::Duration::from_secs(u64::from(attempt) * 2)).await;
                attempt += 1;
            }
            other => return other,
        }
    }
}

fn is_transient(err: &reqwest::Error) -> bool {
    err.is_timeout() || err.is_connect() || err.is_body() || err.is_request()
}
