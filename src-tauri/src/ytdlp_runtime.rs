//! What yt-dlp needs beyond its own exe to keep YouTube working.
//!
//! YouTube now hides most formats behind a JavaScript "n" challenge. yt-dlp
//! ships the solver script (yt_dlp_ejs) but needs an external JS runtime to run
//! it; without one it falls back to a reduced client set that YouTube answers
//! with "Sign in to confirm you're not a bot". YouTube also breaks old yt-dlp
//! builds within weeks, so the bundled exe is self-updated in the background.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use tokio::process::Command;

use crate::binaries::{managed_bin_dir, resolve_binary, YTDLP};

#[cfg(windows)]
const DENO: &str = "deno.exe";
#[cfg(not(windows))]
const DENO: &str = "deno";
#[cfg(windows)]
const NODE: &str = "node.exe";
#[cfg(not(windows))]
const NODE: &str = "node";

/// Pinned release: "latest" cannot be checked against a hash. Bump the URL and
/// the hash together (GitHub shows the asset's sha256).
#[cfg(windows)]
const DENO_ZIP_URL: &str =
    "https://github.com/denoland/deno/releases/download/v2.9.8/deno-x86_64-pc-windows-msvc.zip";
#[cfg(windows)]
const DENO_ZIP_SHA256: &str = "cba84b26e0df5ae7f74fc66b86a95b866872a86292ebd84fa1e959927edd93bf";

const UPDATE_EVERY: Duration = Duration::from_secs(24 * 3600);
const UPDATE_TIMEOUT: Duration = Duration::from_secs(180);
const UPDATE_STAMP: &str = "ytdlp-update.stamp";

/// `--js-runtimes` arguments for the best runtime on this machine, or nothing
/// when none is installed (yt-dlp then looks for deno on PATH by itself).
pub fn js_runtime_args() -> Vec<String> {
    find_js_runtime()
        .map(|(name, path)| vec!["--js-runtimes".to_string(), format!("{name}:{}", path.display())])
        .unwrap_or_default()
}

fn find_js_runtime() -> Option<(&'static str, PathBuf)> {
    let managed_deno = managed_bin_dir().map(|dir| dir.join(DENO)).filter(|p| p.is_file());
    managed_deno
        .or_else(|| which(DENO))
        .map(|path| ("deno", path))
        .or_else(|| which(NODE).map(|path| ("node", path)))
}

fn which(name: &str) -> Option<PathBuf> {
    let path_var = std::env::var_os("PATH")?;
    std::env::split_paths(&path_var)
        .map(|dir| dir.join(name))
        .find(|cand| cand.is_file())
}

/// Download deno into the managed bin dir when no JS runtime exists (Windows
/// only; elsewhere it is a package-manager install). Best-effort.
pub async fn ensure_js_runtime() -> anyhow::Result<()> {
    if find_js_runtime().is_some() {
        return Ok(());
    }

    #[cfg(not(windows))]
    {
        tracing::warn!("no JS runtime for yt-dlp: install deno for full YouTube support");
        Ok(())
    }

    #[cfg(windows)]
    {
        let dir = managed_bin_dir().ok_or_else(|| anyhow::anyhow!("no app data dir"))?;
        std::fs::create_dir_all(&dir)?;
        tracing::info!("no JS runtime for yt-dlp - downloading deno");

        let bytes = reqwest::Client::builder()
            .timeout(Duration::from_secs(600))
            .build()?
            .get(DENO_ZIP_URL)
            .send()
            .await?
            .error_for_status()?
            .bytes()
            .await?;
        crate::binaries::ensure_sha256(&bytes, DENO_ZIP_SHA256, "deno archive")?;

        tokio::task::spawn_blocking(move || extract_deno(&bytes, &dir)).await??;
        Ok(())
    }
}

#[cfg(windows)]
fn extract_deno(bytes: &[u8], dir: &Path) -> anyhow::Result<()> {
    let mut zip = zip::ZipArchive::new(std::io::Cursor::new(bytes))?;
    let mut entry = zip.by_name(DENO)?;
    // Write under a temp name so a half-written exe is never picked up.
    let partial = dir.join(format!("{DENO}.part"));
    let mut file = std::fs::File::create(&partial)?;
    std::io::copy(&mut entry, &mut file)?;
    drop(file);
    std::fs::rename(&partial, dir.join(DENO))?;
    tracing::info!("installed {}", dir.join(DENO).display());
    Ok(())
}

/// Run `yt-dlp -U` at most once a day, and right away after an app update
/// replaced the exe with the (older) bundled build.
pub async fn update_ytdlp_if_stale() {
    let Some(exe) = resolve_binary(YTDLP, None) else {
        return;
    };
    let Some(stamp) = crate::platform::app_data_dir().map(|d| d.join(UPDATE_STAMP)) else {
        return;
    };
    if !update_due(&exe, &stamp) {
        return;
    }

    let mut cmd = Command::new(&exe);
    crate::binaries::configure_ytdlp_env(&mut cmd);
    cmd.arg("-U").kill_on_drop(true);
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    match tokio::time::timeout(UPDATE_TIMEOUT, cmd.output()).await {
        Ok(Ok(out)) if out.status.success() => {
            let text = String::from_utf8_lossy(&out.stdout);
            let last = text.lines().last().unwrap_or_default().trim().to_string();
            tracing::info!("yt-dlp -U: {last}");
            let _ = std::fs::write(&stamp, b"ok");
        }
        Ok(Ok(out)) => tracing::warn!(
            "yt-dlp -U failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ),
        Ok(Err(err)) => tracing::warn!("yt-dlp -U could not start: {err}"),
        Err(_) => tracing::warn!("yt-dlp -U timed out"),
    }
}

fn update_due(exe: &Path, stamp: &Path) -> bool {
    let modified = |p: &Path| std::fs::metadata(p).and_then(|m| m.modified()).ok();
    let Some(stamped) = modified(stamp) else {
        return true;
    };
    let replaced_since = modified(exe).is_some_and(|exe_time| exe_time > stamped);
    let stale = SystemTime::now()
        .duration_since(stamped)
        .map_or(true, |age| age >= UPDATE_EVERY);
    replaced_since || stale
}

#[cfg(test)]
mod tests {
    use super::update_due;

    #[test]
    fn update_runs_without_stamp_and_skips_right_after_one() {
        let dir = std::env::temp_dir().join(format!("fetchr-ytdlp-stamp-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let exe = dir.join("yt-dlp.exe");
        let stamp = dir.join("stamp");
        std::fs::write(&exe, b"x").unwrap();
        let _ = std::fs::remove_file(&stamp);

        assert!(update_due(&exe, &stamp));
        std::thread::sleep(std::time::Duration::from_millis(20));
        std::fs::write(&stamp, b"ok").unwrap();
        assert!(!update_due(&exe, &stamp));

        std::thread::sleep(std::time::Duration::from_millis(20));
        std::fs::write(&exe, b"newer bundled build").unwrap();
        assert!(update_due(&exe, &stamp));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
