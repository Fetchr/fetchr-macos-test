//! Установщик Fetchr.
//!
//! Без аргументов — окно с интро «Проявка» и прогрессом установки.
//! Ключи совместимы с NSIS-установщиком, которым пользуется обновление из
//! приложения (src-tauri/src/updater.rs): /S — без окна, /UPDATE — поверх
//! установленной версии без ярлыков, /R — запустить Fetchr после установки.
//! Тот же exe без пакета в конце — это uninstall.exe.
#![windows_subsystem = "windows"]

mod install;
mod ui;
mod uninstall;
mod win;

use std::io::Write;
use std::path::Path;
use std::sync::atomic::AtomicBool;

use fetchr_setup::Located;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let flag = |name: &str| args.iter().any(|a| a.eq_ignore_ascii_case(name));
    let silent = flag("/S");
    let exe = match std::env::current_exe() {
        Ok(exe) => exe,
        Err(err) => fail(&format!("Не удалось найти файл установщика: {err}")),
    };
    match fetchr_setup::locate(&exe) {
        Ok(Some(pkg)) if silent => std::process::exit(silent_install(&exe, &pkg, flag("/UPDATE"), flag("/R"))),
        Ok(Some(pkg)) => ui::run(exe, pkg),
        // Без пакета удаляет только uninstall.exe: обрезанная загрузка или
        // подписанный после упаковки setup.exe не должны удалять Fetchr.
        Ok(None) if is_uninstaller(&exe) => std::process::exit(uninstall::run(&exe, silent)),
        Ok(None) => fail("Установщик повреждён или скачан не полностью. Скачайте его заново."),
        Err(err) => fail(&format!("Установщик повреждён, скачайте его заново.\n\n{err}")),
    }
}

fn is_uninstaller(exe: &Path) -> bool {
    exe.file_name().is_some_and(|name| name.eq_ignore_ascii_case("uninstall.exe"))
}

fn fail(text: &str) -> ! {
    win::message("Установка Fetchr", text, true);
    std::process::exit(1);
}

/// Тихая установка: обновление из приложения. Ошибки — в журнал во временной папке.
fn silent_install(exe: &Path, pkg: &Located, update: bool, relaunch: bool) -> i32 {
    if !update && win::cpu() == win::Cpu::NoAvx {
        log("CPU has no AVX, Fetchr cannot run");
        return 2;
    }
    let cancel = AtomicBool::new(false);
    let opts = install::Options { update };
    match install::install(exe, pkg, &opts, &cancel, &|_| {}) {
        Ok(dir) => {
            log(&format!("installed {} to {}", pkg.meta.version, dir.display()));
            if relaunch {
                win::spawn_detached(&dir.join(&pkg.meta.main_binary), &dir);
            }
            0
        }
        Err(err) => {
            log(&format!("install failed: {err}"));
            1
        }
    }
}

pub fn log(line: &str) {
    let dir = std::env::temp_dir().join("Fetchr Updates");
    let _ = std::fs::create_dir_all(&dir);
    if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(dir.join("setup.log")) {
        let secs = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let _ = writeln!(file, "[{secs}] {line}");
    }
}
