use std::path::{Path, PathBuf};

use once_cell::sync::OnceCell;
use serde::Serialize;
use tokio::process::Command;

/// Names of the CLI tools we wrap (platform executable suffix included).
#[cfg(windows)]
pub const YTDLP: &str = "yt-dlp.exe";
#[cfg(windows)]
pub const NM3U8DL: &str = "N_m3u8DL-RE.exe";
#[cfg(windows)]
pub const FFMPEG: &str = "ffmpeg.exe";
#[cfg(windows)]
pub const FFPROBE: &str = "ffprobe.exe";

#[cfg(not(windows))]
pub const YTDLP: &str = "yt-dlp";
#[cfg(not(windows))]
pub const NM3U8DL: &str = "N_m3u8DL-RE";
#[cfg(not(windows))]
pub const FFMPEG: &str = "ffmpeg";
#[cfg(not(windows))]
pub const FFPROBE: &str = "ffprobe";

/// Directory where Tauri unpacks bundled resources, set once at startup from
/// `app.path().resource_dir()`. Checked first when resolving bundled tools so
/// resolution works on macOS (`Fetchr.app/Contents/Resources`) and Linux
/// (`/usr/lib/<app>/`), where the layout differs from the Windows exe-adjacent one.
static RESOURCE_DIR: OnceCell<PathBuf> = OnceCell::new();

/// Record the Tauri resource directory (called once during app setup).
pub fn set_resource_dir(dir: PathBuf) {
    let _ = RESOURCE_DIR.set(dir);
}

#[derive(Debug, Clone, Serialize)]
pub struct BinaryReport {
    pub name: String,
    pub path: Option<String>,
    pub found: bool,
}

/// Resolve a binary's location using the following strategy:
/// 1. Explicit override directory (app settings) — passed in by caller.
/// 2. Directory of the current executable (production bundle).
/// 3. Parent of `src-tauri/` (development: the project root).
/// 4. Grandparent (the user's existing `yt-dlp/` folder).
/// 5. System PATH.
pub fn resolve_binary(name: &str, override_dir: Option<&Path>) -> Option<PathBuf> {
    if let Some(dir) = override_dir {
        let cand = dir.join(name);
        if cand.is_file() {
            return Some(cand);
        }
    }

    // Tauri-provided resource directory (correct on macOS/Linux bundles).
    if let Some(base) = RESOURCE_DIR.get() {
        for cand in [base.join(name), base.join("resources").join(name)] {
            if cand.is_file() {
                return Some(cand);
            }
        }
    }

    // Auto-install location (downloaded ffmpeg/ffprobe fallback).
    if let Some(dir) = managed_bin_dir() {
        let cand = dir.join(name);
        if cand.is_file() {
            return Some(cand);
        }
    }

    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            let cand = parent.join(name);
            if cand.is_file() {
                return Some(cand);
            }

            for resource_dir in ["resources", "Resources"] {
                let cand = parent.join(resource_dir).join(name);
                if cand.is_file() {
                    return Some(cand);
                }
            }

            // dev: ../../ from src-tauri/target/debug/
            for up in [1u8, 2, 3, 4] {
                let mut p = parent.to_path_buf();
                for _ in 0..up {
                    if !p.pop() {
                        break;
                    }
                }
                let cand = p.join(name);
                if cand.is_file() {
                    return Some(cand);
                }

                for resource_dir in ["resources", "Resources"] {
                    let cand = p.join(resource_dir).join(name);
                    if cand.is_file() {
                        return Some(cand);
                    }
                }
            }
        }
    }

    // Common install locations that a GUI app's minimal PATH may miss. macOS apps
    // launched from Finder do NOT inherit the shell PATH, so Homebrew's bin dirs
    // (where `brew install ffmpeg` lands) are invisible to `which_on_path` — check
    // them explicitly so bundled-less tools like ffmpeg still resolve.
    for dir in extra_bin_dirs() {
        let cand = dir.join(name);
        if cand.is_file() {
            return Some(cand);
        }
    }

    // Fallback: PATH
    which_on_path(name)
}

fn which_on_path(name: &str) -> Option<PathBuf> {
    let path_var = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path_var) {
        let cand = dir.join(name);
        if cand.is_file() {
            return Some(cand);
        }
    }
    None
}

/// Extra directories to probe for CLI tools, beyond `$PATH`.
fn extra_bin_dirs() -> Vec<PathBuf> {
    #[cfg(target_os = "macos")]
    {
        // Apple Silicon Homebrew, Intel Homebrew, MacPorts.
        return vec![
            PathBuf::from("/opt/homebrew/bin"),
            PathBuf::from("/usr/local/bin"),
            PathBuf::from("/opt/local/bin"),
        ];
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        return vec![
            PathBuf::from("/usr/local/bin"),
            PathBuf::from("/usr/bin"),
            PathBuf::from("/snap/bin"),
        ];
    }
    #[cfg(windows)]
    {
        return Vec::new();
    }
}

/// Tauri command — UI calls this on startup to verify bundled tools are present.
#[tauri::command]
pub fn detect_binaries(override_dir: Option<String>) -> Vec<BinaryReport> {
    let dir = override_dir.as_deref().map(Path::new);
    [YTDLP, NM3U8DL, FFMPEG, FFPROBE]
        .iter()
        .map(|name| {
            let path = resolve_binary(name, dir);
            BinaryReport {
                name: (*name).to_string(),
                path: path.as_ref().map(|p| p.display().to_string()),
                found: path.is_some(),
            }
        })
        .collect()
}

/// `<app-data>/Fetchr/bin` — where auto-downloaded ffmpeg/ffprobe live.
pub fn managed_bin_dir() -> Option<PathBuf> {
    crate::platform::app_data_dir().map(|d| d.join("bin"))
}

/// gyan.dev essentials build (includes h264_qsv/hevc_qsv/nvenc/amf), pinned to
/// one release: a moving "latest" URL cannot be checked against a hash. To bump,
/// change the URL and the hash together (GitHub shows the asset's sha256).
#[cfg(windows)]
const FFMPEG_ZIP_URL: &str =
    "https://github.com/GyanD/codexffmpeg/releases/download/9.1/ffmpeg-9.1-essentials_build.zip";
#[cfg(windows)]
const FFMPEG_ZIP_SHA256: &str = "b9bbbb3acece000cbeec994f856649354e52c773807841e78908374b24d658fd";

/// Refuses downloaded bytes that are not exactly the pinned file: these
/// archives hold executables the app runs.
#[cfg(windows)]
pub(crate) fn ensure_sha256(bytes: &[u8], expected: &str, what: &str) -> anyhow::Result<()> {
    use sha2::{Digest, Sha256};
    let actual = hex::encode(Sha256::digest(bytes));
    if !actual.eq_ignore_ascii_case(expected) {
        anyhow::bail!("{what}: SHA-256 mismatch (expected {expected}, got {actual})");
    }
    Ok(())
}

/// Ensure ffmpeg/ffprobe exist; if missing everywhere, download a light build into
/// the managed bin dir (Windows only). On macOS/Linux ffmpeg is bundled as an app
/// resource or taken from PATH. Best-effort: errors are logged, not fatal.
pub async fn ensure_ffmpeg() -> anyhow::Result<()> {
    if resolve_binary(FFMPEG, None).is_some() && resolve_binary(FFPROBE, None).is_some() {
        return Ok(());
    }

    #[cfg(not(windows))]
    {
        tracing::warn!(
            "ffmpeg/ffprobe not found — install ffmpeg (e.g. `brew install ffmpeg` / your \
             package manager) or set the binaries folder in Settings"
        );
        return Ok(());
    }

    #[cfg(windows)]
    {
        let dir = managed_bin_dir().ok_or_else(|| anyhow::anyhow!("no app data dir"))?;
        std::fs::create_dir_all(&dir)?;

        tracing::info!("ffmpeg not found — downloading light build from gyan.dev");
        let bytes = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(900))
            .build()?
            .get(FFMPEG_ZIP_URL)
            .send()
            .await?
            .error_for_status()?
            .bytes()
            .await?;
        ensure_sha256(&bytes, FFMPEG_ZIP_SHA256, "ffmpeg archive")?;

        // Extract only bin/ffmpeg.exe and bin/ffprobe.exe (CPU-bound → blocking pool).
        tokio::task::spawn_blocking(move || -> anyhow::Result<()> {
            let reader = std::io::Cursor::new(bytes);
            let mut zip = zip::ZipArchive::new(reader)?;
            for i in 0..zip.len() {
                let mut entry = zip.by_index(i)?;
                let Some(name) = entry.enclosed_name() else {
                    continue;
                };
                let fname = match name.file_name().and_then(|n| n.to_str()) {
                    Some(n)
                        if n.eq_ignore_ascii_case(FFMPEG) || n.eq_ignore_ascii_case(FFPROBE) =>
                    {
                        n.to_string()
                    }
                    _ => continue,
                };
                let out = dir.join(&fname);
                let mut f = std::fs::File::create(&out)?;
                std::io::copy(&mut entry, &mut f)?;
                tracing::info!("installed {}", out.display());
            }
            Ok(())
        })
        .await??;
        Ok(())
    }
}

pub fn configure_ytdlp_env(cmd: &mut Command) {
    crate::platform::hide_console_tokio(cmd);
    cmd.env("PYTHONUTF8", "1")
        .env("PYTHONIOENCODING", "utf-8")
        .env("PYTHONLEGACYWINDOWSSTDIO", "0");

    // Ensure the per-user temp dir exists (yt-dlp PyInstaller cache).
    let _ = crate::platform::app_data_subdir("temp");

    // Called right after `Command::new`, so these land before every other arg.
    cmd.args(crate::ytdlp_runtime::js_runtime_args());
}
