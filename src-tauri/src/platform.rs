//! Cross-platform helpers shared across the app.
//!
//! Keeps the rest of the codebase free of `#[cfg(...)]` noise for the two
//! things that differ per OS: the per-user data directory (was `%LOCALAPPDATA%`)
//! and spawning child processes without flashing a console window on Windows.

use std::ffi::OsStr;
use std::path::PathBuf;

/// Per-user writable data directory for Fetchr:
/// - Windows: `%LOCALAPPDATA%\Fetchr`
/// - macOS:   `~/Library/Application Support/Fetchr`
/// - Linux:   `$XDG_DATA_HOME/Fetchr` (default `~/.local/share/Fetchr`)
///
/// Replaces the previous hard dependency on the Windows-only `LOCALAPPDATA`
/// environment variable.
pub fn app_data_dir() -> Option<PathBuf> {
    dirs::data_local_dir().map(|d| d.join("Fetchr"))
}

/// A named subdirectory under [`app_data_dir`], created if missing.
/// Returns `None` only when the base data directory cannot be determined.
pub fn app_data_subdir(name: &str) -> Option<PathBuf> {
    let dir = app_data_dir()?.join(name);
    let _ = std::fs::create_dir_all(&dir);
    Some(dir)
}

/// `CREATE_NO_WINDOW` — suppresses the console window when spawning CLI tools
/// (ffmpeg / yt-dlp / N_m3u8DL-RE) on Windows. No-op elsewhere.
#[cfg(windows)]
pub const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Apply the "no console window" flag to a std [`Command`](std::process::Command)
/// on Windows. No-op on macOS/Linux.
pub fn hide_console(cmd: &mut std::process::Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let _ = cmd;
}

/// Apply the "no console window" flag to a tokio
/// [`Command`](tokio::process::Command) on Windows. No-op on macOS/Linux.
pub fn hide_console_tokio(cmd: &mut tokio::process::Command) {
    #[cfg(windows)]
    {
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let _ = cmd;
}

/// Build a std [`Command`](std::process::Command) that never flashes a console
/// window on Windows. Cross-platform replacement for the old Windows-only
/// `hidden_command` helpers.
pub fn hidden_command(program: impl AsRef<OsStr>) -> std::process::Command {
    let mut cmd = std::process::Command::new(program);
    hide_console(&mut cmd);
    cmd
}
