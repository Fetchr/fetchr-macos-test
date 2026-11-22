//! Cloudflare-aware page fetching for the tracker sites.
//!
//! TwitchTracker / StreamsCharts / SullyGnome sit behind a Cloudflare managed
//! challenge that no plain HTTP client can pass — it needs a real browser to run
//! the JS challenge. The app already ships one, so when reqwest gets a challenge
//! page back we load the URL in an invisible WebView window, wait for Cloudflare
//! to hand over the real document, and read it back through an injected script.
//!
//! Replaying the `cf_clearance` cookie over reqwest instead was tried and does
//! not work: Cloudflare ties the cookie to the TLS fingerprint, so the same
//! cookie from rustls still comes back 403. The page content has to travel out
//! of the WebView itself.
//!
//! The solver window loads third-party pages, so `lib.rs` rejects every IPC
//! message from a webview labelled [`SOLVER_LABEL_PREFIX`] except
//! [`DELIVER_COMMAND`] — a hostile script on a tracker page gets to hand us a
//! page body for a token it cannot guess, and nothing else.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use once_cell::sync::Lazy;
use parking_lot::Mutex;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tokio::sync::{oneshot, Mutex as AsyncMutex};

/// Label prefix of every solver window. Also the IPC deny-list key in `lib.rs`.
pub const SOLVER_LABEL_PREFIX: &str = "cf-solver-";
/// The one command a solver window is allowed to invoke.
pub const DELIVER_COMMAND: &str = "cf_scrape_deliver";

/// UA the solver window announces, and the one the plain reqwest paths send, so
/// both look like the same client to the tracker sites.
pub const BROWSER_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 \
     (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/// Interstitials normally clear in a few seconds; this covers a slow link plus a
/// turnstile round-trip without hanging the UI forever.
const SOLVE_TIMEOUT: Duration = Duration::from_secs(45);
/// How long the hidden window gets before we reveal it (see [`solve`]).
const ESCALATE_AFTER: Duration = Duration::from_secs(12);

pub struct CfPage {
    pub html: String,
    pub text: String,
}

static PENDING: Lazy<Mutex<HashMap<String, oneshot::Sender<CfPage>>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));
static SEQ: AtomicU64 = AtomicU64::new(0);
/// One solver window at a time: they are heavy, and parallel challenges from one
/// IP are exactly what gets an app rate-limited.
static SOLVER: Lazy<AsyncMutex<()>> = Lazy::new(|| AsyncMutex::new(()));

/// Called by the injected script once the page is past the challenge.
#[tauri::command]
pub fn cf_scrape_deliver(token: String, html: String, text: String) {
    if let Some(tx) = PENDING.lock().remove(&token) {
        let _ = tx.send(CfPage { html, text });
    }
}

/// Load `page_url` to clear the challenge, then `fetch()` `api_url` from that
/// same origin — the way to reach JSON endpoints, which the WebView would
/// download instead of render if we navigated to them directly.
pub async fn fetch_same_origin(
    app: &AppHandle,
    page_url: &str,
    api_url: &str,
) -> Result<String, String> {
    solve(app, page_url, Some(api_url))
        .await
        .map(|page| page.text)
}

async fn solve(app: &AppHandle, url: &str, fetch_url: Option<&str>) -> Result<CfPage, String> {
    let _serialized = SOLVER.lock().await;

    let parsed: url::Url = url
        .parse()
        .map_err(|e| format!("некорректный URL {url}: {e}"))?;
    let allowed_host = parsed
        .host_str()
        .map(|host| host.to_string())
        .ok_or_else(|| format!("в URL нет хоста: {url}"))?;

    let seq = SEQ.fetch_add(1, Ordering::Relaxed);
    let token = format!("{SOLVER_LABEL_PREFIX}{seq}-{}", uuid::Uuid::new_v4());
    let label = format!("{SOLVER_LABEL_PREFIX}{seq}");

    let (tx, rx) = oneshot::channel();
    PENDING.lock().insert(token.clone(), tx);

    let script = build_script(&token, fetch_url);
    let window = match build_solver_window(app, &label, parsed, allowed_host, script).await {
        Ok(window) => window,
        Err(e) => {
            PENDING.lock().remove(&token);
            return Err(e);
        }
    };

    // Some challenges only finish once the webview is actually on screen. Hidden
    // is the quiet path, so try that first and reveal the window only if it is
    // clearly not working.
    let escalate = {
        let window = window.clone();
        tokio::spawn(async move {
            tokio::time::sleep(ESCALATE_AFTER).await;
            let _ = window.show();
        })
    };

    let outcome = tokio::time::timeout(SOLVE_TIMEOUT, rx).await;
    escalate.abort();
    PENDING.lock().remove(&token);
    close_window(app, &label);

    match outcome {
        Ok(Ok(page)) => Ok(page),
        Ok(Err(_)) => Err("окно проверки закрылось раньше времени".into()),
        Err(_) => Err(format!(
            "Cloudflare-проверка не пройдена за {} с",
            SOLVE_TIMEOUT.as_secs()
        )),
    }
}

async fn build_solver_window(
    app: &AppHandle,
    label: &str,
    url: url::Url,
    allowed_host: String,
    script: String,
) -> Result<WebviewWindow, String> {
    let (built_tx, built_rx) = oneshot::channel();
    let app_for_build = app.clone();
    let label_for_build = label.to_string();

    app.run_on_main_thread(move || {
        let built =
            WebviewWindowBuilder::new(&app_for_build, &label_for_build, WebviewUrl::External(url))
                .title("Проверка Cloudflare…")
                .inner_size(1000.0, 700.0)
                .visible(false)
                .focused(false)
                .skip_taskbar(true)
                .user_agent(BROWSER_UA)
                .initialization_script(script)
                // Cloudflare bounces between the site and its own challenge host;
                // anything else is a redirect we have no business following.
                .on_navigation(move |next| {
                    next.host_str().is_some_and(|host| {
                        host == allowed_host
                            || host.ends_with(&format!(".{allowed_host}"))
                            || host.ends_with(".cloudflare.com")
                    })
                })
                .build()
                .map_err(|e| e.to_string());
        let _ = built_tx.send(built);
    })
    .map_err(|e| format!("не удалось обратиться к WebView: {e}"))?;

    built_rx
        .await
        .map_err(|_| "WebView не ответил на запрос окна".to_string())?
        .map_err(|e| format!("не удалось открыть WebView: {e}"))
}

fn close_window(app: &AppHandle, label: &str) {
    let app_for_close = app.clone();
    let label = label.to_string();
    let _ = app.run_on_main_thread(move || {
        if let Some(window) = app_for_close.get_webview_window(&label) {
            let _ = window.destroy();
        }
    });
}

fn build_script(token: &str, fetch_url: Option<&str>) -> String {
    let token_js = serde_json::to_string(token).unwrap_or_else(|_| "\"\"".to_string());
    let fetch_js = fetch_url
        .and_then(|u| serde_json::to_string(u).ok())
        .unwrap_or_else(|| "null".to_string());
    DELIVER_SCRIPT
        .replace("__TOKEN__", &token_js)
        .replace("__FETCH_URL__", &fetch_js)
        .replace("__COMMAND__", DELIVER_COMMAND)
}

/// Runs on every document the solver window loads — the challenge page first,
/// then the real one once Cloudflare lets go. `challenged()` deliberately does
/// not look for `challenge-platform`: Cloudflare injects that script into
/// ordinary pages too, so it would never report the page as settled. It also
/// cannot test the title — Cloudflare serves it in the browser's language.
const DELIVER_SCRIPT: &str = r#"
(function () {
  if (window.top !== window.self) return;
  var TOKEN = __TOKEN__;
  var FETCH_URL = __FETCH_URL__;
  var sent = false;
  var busy = false;
  var timer = null;

  function challenged() {
    // `_cf_chl_opt` is the interstitial's own config object and the only marker
    // that survives Cloudflare localising every visible string.
    if (window._cf_chl_opt) return true;
    if (document.getElementById("challenge-error-text")) return true;
    if (document.getElementById("challenge-running")) return true;
    if (document.getElementById("cf-challenge-running")) return true;
    if (document.getElementById("challenge-form")) return true;
    if (document.getElementById("challenge-stage")) return true;
    return false;
  }

  function send(html, text) {
    if (sent) return;
    sent = true;
    if (timer) { clearInterval(timer); timer = null; }
    try {
      var call = window.__TAURI_INTERNALS__.invoke("__COMMAND__", {
        token: TOKEN, html: html, text: text
      });
      if (call && call.catch) call.catch(function () {});
    } catch (err) {
      sent = false;
    }
  }

  function tick() {
    if (sent || busy) return;
    if (!document.documentElement) return;
    if (document.readyState === "loading") return;
    if (challenged()) return;
    if (FETCH_URL) {
      busy = true;
      fetch(FETCH_URL, { credentials: "include" })
        .then(function (r) { return r.text(); })
        .then(function (body) { busy = false; send("", body); })
        .catch(function () { busy = false; });
      return;
    }
    send(
      document.documentElement.outerHTML || "",
      document.body ? (document.body.innerText || "") : ""
    );
  }

  timer = setInterval(tick, 300);
  document.addEventListener("DOMContentLoaded", tick);
  window.addEventListener("load", tick);
})();
"#;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn script_carries_token_and_command() {
        let script = build_script("tok-1", None);
        assert!(script.contains(r#"var TOKEN = "tok-1""#));
        assert!(script.contains(r#"invoke("cf_scrape_deliver""#));
        assert!(script.contains("var FETCH_URL = null"));
    }

    #[test]
    fn script_embeds_the_same_origin_fetch_target() {
        let script = build_script("tok-2", Some("https://sullygnome.com/api/x?a=1&b=2"));
        assert!(script.contains(r#"var FETCH_URL = "https://sullygnome.com/api/x?a=1&b=2""#));
    }

    #[test]
    fn delivering_an_unknown_token_is_a_no_op() {
        cf_scrape_deliver("never-registered".into(), "<html/>".into(), String::new());
        assert!(PENDING.lock().is_empty());
    }
}
