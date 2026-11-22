//! Установка: распаковка пакета, ярлыки, реестр, VC++ Runtime.
//!
//! Повторяет то, что делал NSIS-установщик Tauri с installer-hooks.nsh, чтобы
//! старые установки обновлялись поверх: та же папка, те же ключи реестра,
//! тот же uninstall.exe. Данные пользователя (WebView, лицензия, пресеты)
//! лежат в AppData и не трогаются.

use std::fs::{self, File};
use std::io::{self, BufReader, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use fetchr_setup::{safe_relative, Counting, Located, WINDOW_LOG};
use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ, KEY_WOW64_64KEY};
use winreg::RegKey;

use crate::win;

pub const PRODUCT: &str = "Fetchr";
const MANUFACTURER: &str = "fetchr";
const UNINSTALL_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Uninstall\Fetchr";
const PRODUCT_KEY: &str = r"Software\fetchr\Fetchr";
const VCREDIST_URL: &str = "https://aka.ms/vs/17/release/vc_redist.x64.exe";
/// onnxruntime.dll нужен свежий msvcp140; старые 14.x падают внутри него
const VCREDIST_MIN_MINOR: u32 = 40;
const LEGACY_SHORTCUTS: [&str; 3] = ["Stream Cutter", "StreamCutter", "stream-cutter"];
/// Список поставленных файлов: по нему удаляет uninstall.exe
pub const FILE_LIST: &str = "install-files.txt";

#[derive(Debug, Clone)]
pub enum Event {
    Step(String),
    Progress { done: u64, total: u64, label: String },
}

pub struct Options {
    /// Обновление из приложения: ярлыки не пересоздаются
    pub update: bool,
}

/// Папка прошлой установки или %LOCALAPPDATA%\Fetchr
pub fn install_dir() -> PathBuf {
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let previous = hkcu
        .open_subkey(PRODUCT_KEY)
        .and_then(|k| k.get_value::<String, _>(""))
        .ok()
        .map(|v| v.trim_matches('"').to_string())
        .filter(|v| !v.is_empty());
    match previous {
        Some(dir) => PathBuf::from(dir),
        None => local_app_data().join(PRODUCT),
    }
}

pub fn is_installed() -> bool {
    install_dir().join("fetchr.exe").exists()
}

fn local_app_data() -> PathBuf {
    std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| std::env::temp_dir())
}

fn known_folder(var: &str, tail: &str) -> Option<PathBuf> {
    std::env::var_os(var).map(|base| PathBuf::from(base).join(tail))
}

fn desktop_dir() -> Option<PathBuf> {
    known_folder("USERPROFILE", "Desktop")
}

fn start_menu_dir() -> Option<PathBuf> {
    known_folder("APPDATA", r"Microsoft\Windows\Start Menu\Programs")
}

pub fn install(
    exe: &Path,
    pkg: &Located,
    opts: &Options,
    cancel: &AtomicBool,
    emit: &dyn Fn(Event),
) -> Result<PathBuf, String> {
    let dir = install_dir();
    // Отменить можно только первую установку: поверх старой версии отмена
    // посреди распаковки оставила бы смесь старых и новых файлов.
    let fresh = !dir.join(&pkg.meta.main_binary).exists();
    emit(Event::Step("Закрываем Fetchr".into()));
    if opts.update {
        // Обновление запускает сам Fetchr и сразу выходит: taskkill /T по ещё
        // живому fetchr.exe убил бы и этот установщик как дочерний процесс.
        win::wait_app_exit(Duration::from_secs(8));
    }
    win::kill_app();
    std::thread::sleep(Duration::from_millis(400));
    fs::create_dir_all(&dir).map_err(|err| format!("Не удалось создать папку {}: {err}", dir.display()))?;
    for file in &pkg.meta.files {
        if let Some(rel) = safe_relative(&file.path) {
            remove_set_aside(&dir.join(rel));
        }
    }

    let never = AtomicBool::new(false);
    let cancel = if fresh { cancel } else { &never };
    if let Err(err) = extract(exe, pkg, &dir, cancel, emit) {
        if fresh && cancel.load(Ordering::Relaxed) {
            for file in &pkg.meta.files {
                if let Some(rel) = safe_relative(&file.path) {
                    let _ = fs::remove_file(dir.join(rel));
                }
            }
            let _ = fs::remove_dir(dir.join("resources"));
            let _ = fs::remove_dir(&dir);
        }
        return Err(err);
    }
    let list: Vec<&str> = pkg.meta.files.iter().map(|f| f.path.as_str()).chain(["uninstall.exe"]).collect();
    fs::write(dir.join(FILE_LIST), list.join("\n")).map_err(|err| format!("{}: {err}", dir.display()))?;

    emit(Event::Step("Регистрируем Fetchr в системе".into()));
    write_uninstaller(exe, pkg, &dir)?;
    let size_kb = (pkg.meta.total_size() / 1024 + pkg.stub_len / 1024).min(u32::MAX as u64) as u32;
    write_registry(&dir, &pkg.meta.version, &pkg.meta.main_binary, size_kb)?;
    remove_legacy_shortcuts();
    if !opts.update {
        create_shortcuts(&dir.join(&pkg.meta.main_binary));
    }

    if !vcredist_ready() {
        emit(Event::Step("Устанавливаем Microsoft Visual C++ Runtime".into()));
        install_vcredist();
    }
    Ok(dir)
}

fn extract(exe: &Path, pkg: &Located, dir: &Path, cancel: &AtomicBool, emit: &dyn Fn(Event)) -> Result<(), String> {
    let mut file = File::open(exe).map_err(|err| format!("Не удалось открыть установщик: {err}"))?;
    file.seek(SeekFrom::Start(pkg.payload_offset)).map_err(|err| err.to_string())?;
    let payload = BufReader::with_capacity(1 << 20, file.take(pkg.payload_len));
    let mut decoder = zstd::Decoder::new(payload).map_err(|err| err.to_string())?;
    decoder.window_log_max(WINDOW_LOG).map_err(|err| err.to_string())?;
    let mut archive = tar::Archive::new(decoder);

    let total = pkg.meta.total_size().max(1);
    let mut done = 0u64;
    let mut last_emit = Instant::now() - Duration::from_secs(1);
    let mut buf = vec![0u8; 1 << 20];
    let entries = archive.entries().map_err(|err| format!("Пакет повреждён: {err}"))?;
    for entry in entries {
        let entry = entry.map_err(|err| format!("Пакет повреждён: {err}"))?;
        let name = entry.path().map_err(|err| err.to_string())?.to_string_lossy().replace('\\', "/");
        let rel = safe_relative(&name).ok_or_else(|| format!("Недопустимый путь в пакете: {name}"))?;
        let target = dir.join(&rel);
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|err| format!("{}: {err}", parent.display()))?;
        }
        let label = rel.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let mut out = create_replacing(&target)?;
        let mut reader = Counting::new(entry);
        loop {
            if cancel.load(Ordering::Relaxed) {
                return Err("cancelled".into());
            }
            let n = reader.read(&mut buf).map_err(|err| format!("Пакет повреждён: {err}"))?;
            if n == 0 {
                break;
            }
            out.write_all(&buf[..n]).map_err(|err| format!("{}: {err}", target.display()))?;
            done += n as u64;
            if last_emit.elapsed() >= Duration::from_millis(40) {
                last_emit = Instant::now();
                emit(Event::Progress { done, total, label: label.clone() });
            }
        }
        out.flush().map_err(|err| format!("{}: {err}", target.display()))?;
    }
    emit(Event::Progress { done: total, total, label: String::new() });
    Ok(())
}

/// Занятый файл (антивирус, задержка taskkill) переименовывается в сторону
fn create_replacing(target: &Path) -> Result<io::BufWriter<File>, String> {
    let open = || File::create(target).map(|f| io::BufWriter::with_capacity(1 << 20, f));
    for attempt in 0..10 {
        match open() {
            Ok(file) => return Ok(file),
            Err(_) if attempt == 4 && target.exists() => {
                let aside = target.with_extension(format!("old{}", std::process::id()));
                let _ = fs::rename(target, aside);
            }
            Err(_) => std::thread::sleep(Duration::from_millis(250)),
        }
    }
    open().map_err(|err| format!("Не удалось записать {}: {err}", target.display()))
}

/// uninstall.exe — эта же заглушка без пакета
fn write_uninstaller(exe: &Path, pkg: &Located, dir: &Path) -> Result<(), String> {
    let mut src = File::open(exe).map_err(|err| err.to_string())?.take(pkg.stub_len);
    let target = dir.join("uninstall.exe");
    let mut out = create_replacing(&target)?;
    io::copy(&mut src, &mut out).map_err(|err| format!("{}: {err}", target.display()))?;
    out.flush().map_err(|err| err.to_string())
}

/// Копии, отложенные create_replacing, когда файл был занят: <stem>.old<pid>
pub fn remove_set_aside(path: &Path) {
    let (Some(parent), Some(stem)) = (path.parent(), path.file_stem()) else { return };
    let prefix = format!("{}.old", stem.to_string_lossy());
    let Ok(entries) = fs::read_dir(parent) else { return };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.strip_prefix(&prefix).is_some_and(|pid| !pid.is_empty() && pid.bytes().all(|b| b.is_ascii_digit())) {
            let _ = fs::remove_file(entry.path());
        }
    }
}

fn write_registry(dir: &Path, version: &str, main_binary: &str, size_kb: u32) -> Result<(), String> {
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let dir_s = dir.to_string_lossy().to_string();
    let reg = |err: io::Error| format!("Не удалось записать в реестр: {err}");
    let (product, _) = hkcu.create_subkey(PRODUCT_KEY).map_err(reg)?;
    product.set_value("", &dir_s).map_err(reg)?;

    let (key, _) = hkcu.create_subkey(UNINSTALL_KEY).map_err(reg)?;
    let exe = dir.join(main_binary).to_string_lossy().to_string();
    let uninstall = dir.join("uninstall.exe").to_string_lossy().to_string();
    key.set_value("DisplayName", &PRODUCT).map_err(reg)?;
    key.set_value("DisplayIcon", &format!("\"{exe}\"")).map_err(reg)?;
    key.set_value("DisplayVersion", &version).map_err(reg)?;
    key.set_value("Publisher", &MANUFACTURER).map_err(reg)?;
    key.set_value("InstallLocation", &format!("\"{dir_s}\"")).map_err(reg)?;
    key.set_value("UninstallString", &format!("\"{uninstall}\"")).map_err(reg)?;
    key.set_value("QuietUninstallString", &format!("\"{uninstall}\" /S")).map_err(reg)?;
    key.set_value("MainBinaryName", &main_binary).map_err(reg)?;
    key.set_value("NoModify", &1u32).map_err(reg)?;
    key.set_value("NoRepair", &1u32).map_err(reg)?;
    key.set_value("EstimatedSize", &size_kb).map_err(reg)?;
    Ok(())
}

pub fn remove_registry() {
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let _ = hkcu.delete_subkey_all(UNINSTALL_KEY);
    let _ = hkcu.delete_subkey_all(PRODUCT_KEY);
    let _ = hkcu.delete_subkey(r"Software\fetchr");
}

fn shortcut_paths() -> Vec<PathBuf> {
    [desktop_dir(), start_menu_dir()]
        .into_iter()
        .flatten()
        .map(|d| d.join(format!("{PRODUCT}.lnk")))
        .collect()
}

fn create_shortcuts(target: &Path) {
    let target_s = target.to_string_lossy();
    let cwd = target.parent().map(|p| p.to_string_lossy().to_string()).unwrap_or_default();
    let mut script = String::from("$s = New-Object -ComObject WScript.Shell;");
    for link in shortcut_paths() {
        script.push_str(&format!(
            "$l = $s.CreateShortcut({}); $l.TargetPath = {}; $l.WorkingDirectory = {}; $l.IconLocation = {}; $l.Save();",
            win::ps_quote(&link.to_string_lossy()),
            win::ps_quote(&target_s),
            win::ps_quote(&cwd),
            win::ps_quote(&format!("{target_s},0")),
        ));
    }
    let _ = win::powershell(&script);
}

pub fn remove_shortcuts() {
    for link in shortcut_paths() {
        let _ = fs::remove_file(link);
    }
}

fn remove_legacy_shortcuts() {
    for base in [desktop_dir(), start_menu_dir()].into_iter().flatten() {
        for name in LEGACY_SHORTCUTS {
            let _ = fs::remove_file(base.join(format!("{name}.lnk")));
            let _ = fs::remove_dir(base.join(name));
        }
    }
}

fn vcredist_ready() -> bool {
    RegKey::predef(HKEY_LOCAL_MACHINE)
        .open_subkey_with_flags(r"SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64", KEY_READ | KEY_WOW64_64KEY)
        .map(|k| {
            let installed: u32 = k.get_value("Installed").unwrap_or(0);
            let minor: u32 = k.get_value("Minor").unwrap_or(0);
            installed == 1 && minor >= VCREDIST_MIN_MINOR
        })
        .unwrap_or(false)
}

/// Скачивает vc_redist и запускает его с повышением прав. Запускается только
/// файл с подписью Microsoft: всё остальное под этим именем удаляется.
fn install_vcredist() {
    let path = std::env::temp_dir().join("fetchr_vc_redist.x64.exe");
    let _ = fs::remove_file(&path);
    let path_s = path.to_string_lossy().to_string();
    let _ = win::run_hidden(
        "curl.exe",
        &["-fsSL", "--retry", "2", "--connect-timeout", "20", "--max-time", "600", "-o", &path_s, VCREDIST_URL],
    );
    if !path.exists() {
        let _ = win::powershell(&format!(
            "[Net.ServicePointManager]::SecurityProtocol='Tls12'; Invoke-WebRequest -UseBasicParsing -Uri {} -OutFile {}",
            win::ps_quote(VCREDIST_URL),
            win::ps_quote(&path_s)
        ));
    }
    if !path.exists() {
        return;
    }
    if signed_by_microsoft(&path) {
        win::run_elevated_wait(&path, "/install /quiet /norestart");
    }
    let _ = fs::remove_file(&path);
}

/// Действительная подпись Authenticode от Microsoft Corporation
pub fn signed_by_microsoft(path: &Path) -> bool {
    win::powershell(&format!(
        "$s = Get-AuthenticodeSignature -LiteralPath {}; if ($s.Status -eq 'Valid' -and $s.SignerCertificate.Subject -like 'CN=Microsoft Corporation,*') {{ exit 0 }} else {{ exit 1 }}",
        win::ps_quote(&path.to_string_lossy())
    )) == Some(0)
}
