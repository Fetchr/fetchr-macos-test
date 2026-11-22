//! Обращения к Windows: окна сообщений, процессор, запуск процессов.

use std::ffi::OsStr;
use std::os::windows::ffi::OsStrExt;
use std::os::windows::process::CommandExt;
use std::path::Path;
use std::process::Command;

use windows_sys::Win32::System::Threading::{
    IsProcessorFeaturePresent, WaitForSingleObject, INFINITE, PF_AVX2_INSTRUCTIONS_AVAILABLE,
    PF_AVX_INSTRUCTIONS_AVAILABLE,
};
use windows_sys::Win32::UI::Shell::{ShellExecuteExW, SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    MessageBoxW, IDYES, MB_ICONERROR, MB_ICONINFORMATION, MB_ICONQUESTION, MB_OK, MB_YESNO, SW_HIDE,
};

pub const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const DETACHED_PROCESS: u32 = 0x0000_0008;

pub fn wide(text: impl AsRef<OsStr>) -> Vec<u16> {
    text.as_ref().encode_wide().chain(std::iter::once(0)).collect()
}

pub fn message(title: &str, text: &str, error: bool) {
    let icon = if error { MB_ICONERROR } else { MB_ICONINFORMATION };
    unsafe { MessageBoxW(std::ptr::null_mut(), wide(text).as_ptr(), wide(title).as_ptr(), MB_OK | icon) };
}

pub fn confirm(title: &str, text: &str) -> bool {
    unsafe {
        MessageBoxW(std::ptr::null_mut(), wide(text).as_ptr(), wide(title).as_ptr(), MB_YESNO | MB_ICONQUESTION) == IDYES
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Cpu {
    Ok,
    /// ONNX Runtime падает на старте без AVX: Fetchr не запустится
    NoAvx,
    /// Нейросетевые инструменты могут работать медленно или не запускаться
    NoAvx2,
}

pub fn cpu() -> Cpu {
    unsafe {
        if IsProcessorFeaturePresent(PF_AVX_INSTRUCTIONS_AVAILABLE) == 0 {
            Cpu::NoAvx
        } else if IsProcessorFeaturePresent(PF_AVX2_INSTRUCTIONS_AVAILABLE) == 0 {
            Cpu::NoAvx2
        } else {
            Cpu::Ok
        }
    }
}

/// Скрытый процесс без консоли; код выхода или None, если не запустился
pub fn run_hidden(program: &str, args: &[&str]) -> Option<i32> {
    Command::new(program)
        .args(args)
        .creation_flags(CREATE_NO_WINDOW)
        .status()
        .ok()
        .and_then(|s| s.code())
}

/// Запуск с повышением прав (UAC) и ожиданием конца
pub fn run_elevated_wait(file: &Path, params: &str) -> bool {
    let verb = wide("runas");
    let file_w = wide(file.as_os_str());
    let params_w = wide(params);
    let mut info: SHELLEXECUTEINFOW = unsafe { std::mem::zeroed() };
    info.cbSize = std::mem::size_of::<SHELLEXECUTEINFOW>() as u32;
    info.fMask = SEE_MASK_NOCLOSEPROCESS;
    info.lpVerb = verb.as_ptr();
    info.lpFile = file_w.as_ptr();
    info.lpParameters = params_w.as_ptr();
    info.nShow = SW_HIDE;
    unsafe {
        if ShellExecuteExW(&mut info) == 0 || info.hProcess.is_null() {
            return false;
        }
        WaitForSingleObject(info.hProcess, INFINITE);
        windows_sys::Win32::Foundation::CloseHandle(info.hProcess);
    }
    true
}

/// Запуск, который переживёт установщик
pub fn spawn_detached(program: &Path, cwd: &Path) -> bool {
    Command::new(program)
        .current_dir(cwd)
        .creation_flags(DETACHED_PROCESS)
        .spawn()
        .is_ok()
}

/// Закрывает работающий Fetchr и старые имена приложения
pub fn kill_app() {
    for name in ["fetchr.exe", "Fetchr.exe", "stream-cutter.exe", "Stream Cutter.exe"] {
        let _ = run_hidden("taskkill", &["/F", "/T", "/IM", name]);
    }
}

fn app_running() -> bool {
    Command::new("tasklist")
        .args(["/FI", "IMAGENAME eq fetchr.exe", "/NH"])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map(|out| String::from_utf8_lossy(&out.stdout).to_ascii_lowercase().contains("fetchr.exe"))
        .unwrap_or(false)
}

/// Ждёт, пока Fetchr закроется сам, но не дольше limit
pub fn wait_app_exit(limit: std::time::Duration) {
    let started = std::time::Instant::now();
    while app_running() && started.elapsed() < limit {
        std::thread::sleep(std::time::Duration::from_millis(250));
    }
}

/// Строка для PowerShell в одинарных кавычках
pub fn ps_quote(text: &str) -> String {
    format!("'{}'", text.replace('\'', "''"))
}

pub fn powershell(script: &str) -> Option<i32> {
    run_hidden("powershell.exe", &["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script])
}
