//! Which way to reach the Fetchr archive: straight to the storage server, or
//! through the account server in Russia.
//!
//! The account server only relays: every byte of a recording crosses it twice,
//! and its port caps the whole transfer at ~23 MB/s. The storage server serves
//! the same API directly. Some networks in Russia reach a foreign address badly
//! or not at all, so the direct route is used only once a probe has proved it,
//! and the relay stays the fallback.

use std::sync::Mutex;
use std::time::{Duration, Instant};

const RELAY_PREFIX: &str = "https://fetchr.fun/rec/";
const DIRECT_PREFIX: &str = "https://archive.fetchr.fun/rec/";
/// How long a probe verdict holds before it is taken again.
const RECHECK: Duration = Duration::from_secs(10 * 60);
const PROBE_TIMEOUT: Duration = Duration::from_secs(5);

struct Verdict {
    base: String,
    direct_ok: bool,
    at: Instant,
}

static VERDICT: Mutex<Option<Verdict>> = Mutex::new(None);
static PROBING: Mutex<bool> = Mutex::new(false);

/// The direct address for a relayed archive base, if it has one.
pub fn direct_base(base: &str) -> Option<String> {
    base.strip_prefix(RELAY_PREFIX)
        .map(|rest| format!("{DIRECT_PREFIX}{rest}"))
}

/// The relayed address for a direct base: the fallback when it fails.
pub fn relay_base(base: &str) -> Option<String> {
    base.strip_prefix(DIRECT_PREFIX)
        .map(|rest| format!("{RELAY_PREFIX}{rest}"))
}

/// The base to use now for `relay` (a `https://fetchr.fun/rec/<id>` address).
///
/// Never blocks: a stale or missing verdict answers with the relay and starts a
/// probe in the background, so the next request can go direct.
pub fn choose(relay: &str, token: &str) -> String {
    let Some(direct) = direct_base(relay) else {
        return relay.to_string();
    };
    let fresh = VERDICT.lock().ok().and_then(|slot| {
        slot.as_ref()
            .filter(|v| v.base == relay && v.at.elapsed() < RECHECK)
            .map(|v| v.direct_ok)
    });
    match fresh {
        Some(true) => direct,
        Some(false) => relay.to_string(),
        None => {
            spawn_probe(relay.to_string(), direct, token.to_string());
            relay.to_string()
        }
    }
}

/// Forget the verdict after the direct route failed mid-use.
pub fn mark_direct_failed(relay: &str) {
    if let Ok(mut slot) = VERDICT.lock() {
        *slot = Some(Verdict {
            base: relay.to_string(),
            direct_ok: false,
            at: Instant::now(),
        });
    }
}

fn spawn_probe(relay: String, direct: String, token: String) {
    {
        let Ok(mut busy) = PROBING.lock() else { return };
        if *busy {
            return;
        }
        *busy = true;
    }
    tauri::async_runtime::spawn(async move {
        let ok = probe(&direct, &token).await;
        if let Ok(mut slot) = VERDICT.lock() {
            *slot = Some(Verdict {
                base: relay,
                direct_ok: ok,
                at: Instant::now(),
            });
        }
        if let Ok(mut busy) = PROBING.lock() {
            *busy = false;
        }
        tracing::info!("archive route: direct {}", if ok { "ok" } else { "unavailable" });
    });
}

/// Whether `direct` answers the agent API with this token.
pub async fn probe(direct: &str, token: &str) -> bool {
    let Ok(client) = reqwest::Client::builder()
        .connect_timeout(PROBE_TIMEOUT)
        .timeout(PROBE_TIMEOUT)
        .build()
    else {
        return false;
    };
    client
        .get(format!("{direct}/status"))
        .header("X-Token", token)
        .send()
        .await
        .map(|resp| resp.status().is_success())
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::{direct_base, relay_base};

    #[test]
    fn maps_between_relay_and_direct() {
        let relay = "https://fetchr.fun/rec/2962397dfc83";
        let direct = direct_base(relay).unwrap();
        assert_eq!(direct, "https://archive.fetchr.fun/rec/2962397dfc83");
        assert_eq!(relay_base(&direct).as_deref(), Some(relay));
        assert_eq!(direct_base("http://127.0.0.1:8765"), None);
    }
}
