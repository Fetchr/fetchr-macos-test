//! Удаление: файлы приложения, ярлыки и ключи реестра. Данные пользователя в
//! AppData (настройки, лицензия, пресеты) остаются, как и при NSIS.
//!
//! Удаляются только свои файлы по списку из FILE_LIST: старый NSIS разрешал
//! ставить Fetchr в любую папку, и чистить её целиком нельзя.

use std::fs;
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};

use fetchr_setup::safe_relative;

use crate::install::{self, FILE_LIST, PRODUCT};
use crate::win;

/// Что ставили версии до списка файлов (NSIS)
const KNOWN_FILES: [&str; 6] = [
    "fetchr.exe",
    "resources/yt-dlp.exe",
    "resources/N_m3u8DL-RE.exe",
    "resources/ffmpeg.exe",
    "resources/ffprobe.exe",
    "resources/wordlist.txt",
];

/// Удаляет ту установку, в папке которой лежит этот uninstall.exe
pub fn run(exe: &Path, silent: bool) -> i32 {
    let dir = exe.parent().map(Path::to_path_buf).unwrap_or_else(install::install_dir);
    if !silent
        && !win::confirm(
            "Удаление Fetchr",
            "Удалить Fetchr с этого компьютера?\n\nНастройки, лицензия и пресеты останутся — они пригодятся, если поставите Fetchr снова.",
        )
    {
        return 1;
    }
    win::kill_app();
    std::thread::sleep(std::time::Duration::from_millis(400));
    install::remove_shortcuts();
    if install::install_dir() == dir {
        install::remove_registry();
    }
    remove_app_files(&dir);
    if !silent {
        win::message("Удаление Fetchr", &format!("{PRODUCT} удалён."), false);
    }
    schedule_self_delete(&dir);
    0
}

fn listed_files(dir: &Path) -> Vec<PathBuf> {
    let listed = fs::read_to_string(dir.join(FILE_LIST)).unwrap_or_default();
    let mut files: Vec<PathBuf> = listed
        .lines()
        .chain(KNOWN_FILES)
        .filter_map(safe_relative)
        .collect();
    files.push(PathBuf::from(FILE_LIST));
    files.sort();
    files.dedup();
    files
}

fn remove_app_files(dir: &Path) {
    let mut parents = Vec::new();
    for rel in listed_files(dir) {
        let path = dir.join(&rel);
        let _ = fs::remove_file(&path);
        install::remove_set_aside(&path);
        if let Some(parent) = path.parent() {
            if parent != dir {
                parents.push(parent.to_path_buf());
            }
        }
    }
    parents.sort_by_key(|p| std::cmp::Reverse(p.components().count()));
    for p in parents {
        let _ = fs::remove_dir(p);
    }
}

/// Работающий exe себя не удалит: это делает cmd, когда мы выйдем. del
/// повторяется, пока файл занят; rmdir без /s — папка уходит, только если в
/// ней не осталось чужого. raw_arg: кавычки для cmd нельзя экранировать \".
fn schedule_self_delete(dir: &Path) {
    let dir_s = dir.to_string_lossy();
    let exe = format!("{dir_s}\\uninstall.exe");
    let script = format!(
        "/C for /L %i in (1,1,20) do (if exist \"{exe}\" (del /f /q \"{exe}\" & ping 127.0.0.1 -n 2 >nul)) & rmdir \"{dir_s}\""
    );
    let _ = std::process::Command::new("cmd")
        .raw_arg(&script)
        .current_dir(std::env::temp_dir())
        .creation_flags(win::CREATE_NO_WINDOW)
        .spawn();
}
