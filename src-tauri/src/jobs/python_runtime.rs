//! Автономная установка Python для ASR-рантайма.
//!
//! Раньше распознавание требовало предустановленного системного Python 3.10+
//! x64 и без него задача падала на первом же запуске. Здесь встроенный
//! (embeddable) дистрибутив скачивается и разворачивается самим приложением:
//! ~11 МБ, ставится один раз в `runtime/python`, ни во что системное не лезет
//! и не трогает PATH.

use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{anyhow, Context, Result};
use tokio::io::AsyncWriteExt;
use tokio::process::Command;

use crate::jobs::model_download;
use crate::jobs::queue::QueueManager;
use crate::jobs::types::JobProgress;

/// 3.12 — последняя ветка с Windows-сборками (3.12.12 уже только исходники), и
/// под неё гарантированно есть cp312-колёса у onnxruntime, numpy и sherpa-onnx.
/// При обновлении версии менять URL, размер и `PYTHON_DIR_VERSION` вместе.
const EMBEDDED_PYTHON_VERSION: &str = "3.12.10";
const EMBEDDED_PYTHON_URL: &str =
    "https://www.python.org/ftp/python/3.12.10/python-3.12.10-embed-amd64.zip";
/// Точный размер архива с python.org — дешёвая проверка целостности до распаковки.
const EMBEDDED_PYTHON_SIZE: u64 = 11_133_606;
/// SHA-256 того же архива: в нём python.exe, который приложение запускает.
const EMBEDDED_PYTHON_SHA256: &str =
    "4acbed6dd1c744b0376e3b1cf57ce906f9dc9e95e68824584c8099a63025a3c3";

const STALL_TIMEOUT: Duration = Duration::from_secs(30);

/// В embeddable-дистрибутиве нет ни pip, ни ensurepip. get-pip.py закреплён
/// на теге 26.3: файл по «плавающему» адресу нельзя сверить с хешем. Оба
/// адреса отдают один и тот же файл; менять тег и хеш вместе.
const GET_PIP_URLS: &[&str] = &[
    "https://raw.githubusercontent.com/pypa/get-pip/26.3/public/get-pip.py",
    "https://cdn.jsdelivr.net/gh/pypa/get-pip@26.3/public/get-pip.py",
];
const GET_PIP_SHA256: &str = "f7654c5589318e1d0789575b2586ce76937eb9943602adda8b15b3be3aa0dac3";

/// get-pip 26.3 запускает pip как `python <tmp>\pip`, и на Windows защита pip
/// от самообновления (basename argv[0] == "pip") обрывает установку. Поэтому
/// берём из get-pip.py только встроенный архив pip и вызываем его main()
/// сами через `-c`, где argv[0] == "-c".
const GET_PIP_BOOTSTRAP: &str = r#"import sys, runpy, tempfile, io, zipfile, base64, shutil
script = runpy.run_path(sys.argv[1], run_name="fetchr_get_pip")
payload = base64.b85decode(script["DATA"].replace(b"\n", b""))
tmp = tempfile.mkdtemp()
try:
    zipfile.ZipFile(io.BytesIO(payload)).extractall(tmp)
    sys.path.insert(0, tmp)
    from pip._internal.cli.main import main
    code = main(["install", "--upgrade", "--force-reinstall"] + sys.argv[2:] + ["pip"])
finally:
    shutil.rmtree(tmp, ignore_errors=True)
sys.exit(code)
"#;

/// Встроенный дистрибутив собран только под Windows x64. На остальных
/// платформах остаётся прежний путь через системный Python.
pub fn is_supported() -> bool {
    cfg!(all(windows, target_arch = "x86_64"))
}

pub fn embedded_dir(runtime_dir: &Path) -> PathBuf {
    runtime_dir.join("python")
}

pub fn embedded_python(runtime_dir: &Path) -> PathBuf {
    #[cfg(windows)]
    return embedded_dir(runtime_dir).join("python.exe");
    #[cfg(not(windows))]
    return embedded_dir(runtime_dir).join("bin").join("python3");
}

/// Установка считается годной только если интерпретатор запускается и в нём
/// есть pip. Оборванная распаковка оставляет python.exe без стандартной
/// библиотеки, и такую установку надо переделать, а не использовать.
fn ready_marker(runtime_dir: &Path) -> PathBuf {
    embedded_dir(runtime_dir).join(format!("fetchr-python-{EMBEDDED_PYTHON_VERSION}.ok"))
}

pub fn is_installed(runtime_dir: &Path) -> bool {
    embedded_python(runtime_dir).is_file() && ready_marker(runtime_dir).is_file()
}

fn emit(queue: &Arc<QueueManager>, job_id: &str, line: impl Into<String>) {
    queue.emit_job_log(job_id, &line.into());
}

fn progress(queue: &Arc<QueueManager>, job_id: &str, percent: f32, message: impl Into<String>) {
    queue.set_progress(
        job_id,
        JobProgress {
            percent,
            message: Some(message.into()),
            ..JobProgress::default()
        },
    );
}

fn format_bytes(bytes: u64) -> String {
    const UNITS: [&str; 4] = ["Б", "КБ", "МБ", "ГБ"];
    let mut value = bytes as f64;
    let mut unit = 0;
    while value >= 1024.0 && unit + 1 < UNITS.len() {
        value /= 1024.0;
        unit += 1;
    }
    format!("{value:.1} {}", UNITS[unit])
}

/// Разворачивает встроенный Python и возвращает путь к интерпретатору.
/// Повторный вызов при готовой установке ничего не делает.
pub async fn install(
    queue: &Arc<QueueManager>,
    job_id: &str,
    runtime_dir: &Path,
    cancel: Arc<AtomicBool>,
) -> Result<PathBuf> {
    if is_installed(runtime_dir) {
        return Ok(embedded_python(runtime_dir));
    }
    if !is_supported() {
        return Err(anyhow!(
            "Встроенный Python доступен только для 64-битной Windows. Установите Python 3.10+ или задайте FETCHR_PYTHON."
        ));
    }

    let target = embedded_dir(runtime_dir);
    // Незавершённая установка могла оставить обрубки — начинаем с чистого места.
    let _ = tokio::fs::remove_dir_all(&target).await;
    tokio::fs::create_dir_all(&target)
        .await
        .with_context(|| format!("create embedded Python dir {target:?}"))?;

    progress(
        queue,
        job_id,
        2.0,
        "Установка Python для распознавания (выполняется один раз)...",
    );
    emit(
        queue,
        job_id,
        format!("Installing embedded Python {EMBEDDED_PYTHON_VERSION} into {target:?}"),
    );

    let archive = runtime_dir.join("python-embed.zip.part");
    download(
        queue,
        job_id,
        EMBEDDED_PYTHON_URL,
        &archive,
        Some(EMBEDDED_PYTHON_SIZE),
        Some(EMBEDDED_PYTHON_SHA256),
        2.0,
        "Скачивание Python",
        cancel.clone(),
    )
    .await?;

    let extract_target = target.clone();
    let extract_archive = archive.clone();
    tokio::task::spawn_blocking(move || extract_zip(&extract_archive, &extract_target))
        .await
        .context("embedded Python extraction worker panicked")??;
    let _ = tokio::fs::remove_file(&archive).await;

    let patch_target = target.clone();
    tokio::task::spawn_blocking(move || enable_site_packages(&patch_target))
        .await
        .context("embedded Python _pth patch worker panicked")??;

    let python = embedded_python(runtime_dir);
    if !python.is_file() {
        return Err(anyhow!(
            "Архив Python распакован, но {python:?} не найден — установка повреждена"
        ));
    }

    progress(queue, job_id, 4.0, "Установка pip...");
    let get_pip = runtime_dir.join("get-pip.py");
    let mut last_error = None;
    let mut installed = false;
    for url in GET_PIP_URLS {
        if cancel.load(Ordering::SeqCst) {
            return Err(anyhow!("FetchrMute task cancelled"));
        }
        if let Err(error) = download(
            queue,
            job_id,
            url,
            &get_pip,
            None,
            Some(GET_PIP_SHA256),
            4.0,
            "Скачивание pip",
            cancel.clone(),
        )
        .await
        {
            last_error = Some(error);
            continue;
        }
        let mut command = Command::new(&python);
        command
            .arg("-c")
            .arg(GET_PIP_BOOTSTRAP)
            .arg(&get_pip)
            .args([
                "--no-warn-script-location",
                "--no-cache-dir",
                "--timeout",
                "30",
                "--retries",
                "2",
            ])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        match run(&mut command, cancel.clone(), "get-pip").await {
            Ok(output) if output.status.success() => {
                installed = true;
                break;
            }
            Ok(output) => {
                last_error = Some(anyhow!(
                    "get-pip failed: {}",
                    String::from_utf8_lossy(&output.stderr).trim().to_string()
                ));
            }
            Err(error) => last_error = Some(error),
        }
    }
    let _ = tokio::fs::remove_file(&get_pip).await;
    if !installed {
        return Err(last_error
            .unwrap_or_else(|| anyhow!("Не удалось установить pip во встроенный Python")));
    }

    verify(&python, cancel).await?;
    tokio::fs::write(ready_marker(runtime_dir), EMBEDDED_PYTHON_VERSION.as_bytes())
        .await
        .context("write embedded Python ready marker")?;
    emit(
        queue,
        job_id,
        format!("Embedded Python {EMBEDDED_PYTHON_VERSION} is ready"),
    );
    Ok(python)
}

/// Интерпретатор обязан запускаться, иметь нужную версию и видеть pip. Без этой
/// проверки битая установка всплыла бы позже — на установке onnxruntime.
async fn verify(python: &Path, cancel: Arc<AtomicBool>) -> Result<()> {
    let mut command = Command::new(python);
    command
        .args([
            "-c",
            "import struct,sys; assert sys.version_info >= (3,10); assert struct.calcsize('P') == 8; import pip",
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let output = run(&mut command, cancel, "embedded Python self-check").await?;
    if !output.status.success() {
        return Err(anyhow!(
            "Встроенный Python не прошёл проверку: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(())
}

/// В embeddable-дистрибутиве `Lib\site-packages` отключён, а `import site`
/// закомментирован — без правки `._pth` pip поставит пакеты туда, откуда
/// интерпретатор их не увидит.
fn enable_site_packages(target: &Path) -> Result<()> {
    let pth = std::fs::read_dir(target)
        .with_context(|| format!("read embedded Python dir {target:?}"))?
        .flatten()
        .map(|entry| entry.path())
        .find(|path| path.extension() == Some(OsStr::new("_pth")))
        .ok_or_else(|| anyhow!("._pth не найден в архиве Python — формат дистрибутива изменился"))?;

    let content = std::fs::read_to_string(&pth).with_context(|| format!("read {pth:?}"))?;
    let mut lines: Vec<String> = content
        .lines()
        .map(|line| {
            if line.trim_start().trim_start_matches('#').trim() == "import site" {
                "import site".to_string()
            } else {
                line.to_string()
            }
        })
        .collect();
    if !lines.iter().any(|line| line.trim() == "import site") {
        lines.push("import site".to_string());
    }
    if !lines.iter().any(|line| line.trim() == "Lib\\site-packages") {
        // Перед `import site`, иначе каталог не попадёт в sys.path.
        let position = lines
            .iter()
            .position(|line| line.trim() == "import site")
            .unwrap_or(lines.len());
        lines.insert(position, "Lib\\site-packages".to_string());
    }
    std::fs::create_dir_all(target.join("Lib").join("site-packages"))?;
    std::fs::write(&pth, lines.join("\r\n") + "\r\n").with_context(|| format!("write {pth:?}"))?;
    Ok(())
}

fn extract_zip(archive: &Path, target: &Path) -> Result<()> {
    let file = std::fs::File::open(archive)
        .with_context(|| format!("open Python archive {archive:?}"))?;
    let mut zip = zip::ZipArchive::new(file).context("open Python archive as zip")?;
    for index in 0..zip.len() {
        let mut entry = zip.by_index(index)?;
        // enclosed_name отсекает `..` и абсолютные пути внутри архива.
        let Some(relative) = entry.enclosed_name() else {
            continue;
        };
        let path = target.join(relative);
        if entry.is_dir() {
            std::fs::create_dir_all(&path)?;
            continue;
        }
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let mut out = std::fs::File::create(&path)
            .with_context(|| format!("write extracted file {path:?}"))?;
        std::io::copy(&mut entry, &mut out)?;
    }
    Ok(())
}

async fn download(
    queue: &Arc<QueueManager>,
    job_id: &str,
    url: &str,
    target: &Path,
    expected_size: Option<u64>,
    expected_sha256: Option<&str>,
    percent: f32,
    label: &str,
    cancel: Arc<AtomicBool>,
) -> Result<()> {
    if cancel.load(Ordering::SeqCst) {
        return Err(anyhow!("FetchrMute task cancelled"));
    }
    let client = model_download::client("Fetchr Mute/PythonRuntime")?;

    let mut response = model_download::until_stalled(client.get(url).send(), STALL_TIMEOUT, &cancel)
        .await
        .with_context(|| format!("request {url}"))?
        .with_context(|| format!("request {url}"))?
        .error_for_status()
        .with_context(|| format!("bad status from {url}"))?;

    let total = response.content_length().or(expected_size);
    let mut file = tokio::fs::File::create(target)
        .await
        .with_context(|| format!("create {target:?}"))?;
    let mut downloaded = 0u64;
    let mut hasher = <sha2::Sha256 as sha2::Digest>::new();
    let mut last_report = Instant::now() - Duration::from_secs(2);

    loop {
        let next = model_download::until_stalled(response.chunk(), STALL_TIMEOUT, &cancel).await;
        let chunk = match next {
            Ok(result) => result.with_context(|| format!("read body from {url}"))?,
            Err(error) => {
                drop(file);
                let _ = tokio::fs::remove_file(target).await;
                return if model_download::is_cancelled(&error) {
                    Err(anyhow!("FetchrMute task cancelled"))
                } else {
                    Err(error.context(format!("read body from {url}")))
                };
            }
        };
        let Some(chunk) = chunk else {
            break;
        };
        file.write_all(&chunk).await?;
        sha2::Digest::update(&mut hasher, &chunk);
        downloaded += chunk.len() as u64;
        if last_report.elapsed() >= Duration::from_millis(500) {
            let message = match total {
                Some(total) => format!(
                    "{label}: {} / {}",
                    format_bytes(downloaded),
                    format_bytes(total)
                ),
                None => format!("{label}: {}", format_bytes(downloaded)),
            };
            progress(queue, job_id, percent, message);
            last_report = Instant::now();
        }
    }
    file.flush().await?;
    drop(file);

    if let Some(expected) = expected_size {
        if downloaded != expected {
            let _ = tokio::fs::remove_file(target).await;
            return Err(anyhow!(
                "{url} скачан не полностью: {downloaded} из {expected} байт"
            ));
        }
    }
    if let Some(expected) = expected_sha256 {
        let actual = hex::encode(sha2::Digest::finalize(hasher));
        if !actual.eq_ignore_ascii_case(expected) {
            let _ = tokio::fs::remove_file(target).await;
            return Err(anyhow!(
                "{url}: SHA-256 не совпал (ожидался {expected}, получен {actual})"
            ));
        }
    }
    Ok(())
}

async fn run(
    command: &mut Command,
    cancel: Arc<AtomicBool>,
    label: &str,
) -> Result<std::process::Output> {
    crate::platform::hide_console_tokio(command);
    command.kill_on_drop(true);
    let child = command.spawn().with_context(|| format!("spawn {label}"))?;
    let child_pid = child.id();
    crate::win_power::disable_for_pid(child_pid);
    let wait = child.wait_with_output();
    tokio::pin!(wait);
    loop {
        tokio::select! {
            result = &mut wait => return result.with_context(|| format!("wait for {label}")),
            _ = tokio::time::sleep(Duration::from_millis(100)) => {
                if cancel.load(Ordering::SeqCst) {
                    return Err(anyhow!("FetchrMute task cancelled"));
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pth_patch_enables_site_packages() {
        let dir = std::env::temp_dir().join(format!("fetchr-pth-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("python312._pth"),
            "python312.zip\r\n.\r\n\r\n# Uncomment to run site.main() automatically\r\n#import site\r\n",
        )
        .unwrap();

        enable_site_packages(&dir).unwrap();
        let patched = std::fs::read_to_string(dir.join("python312._pth")).unwrap();
        let lines: Vec<&str> = patched.lines().map(str::trim).collect();

        assert!(lines.contains(&"import site"), "{patched}");
        assert!(lines.contains(&"Lib\\site-packages"), "{patched}");
        assert!(!lines.contains(&"#import site"), "{patched}");
        // site-packages обязан идти до import site.
        let site = lines.iter().position(|line| *line == "import site").unwrap();
        let packages = lines
            .iter()
            .position(|line| *line == "Lib\\site-packages")
            .unwrap();
        assert!(packages < site, "{patched}");
        assert!(dir.join("Lib").join("site-packages").is_dir());

        // Повторный прогон не должен дублировать строки.
        enable_site_packages(&dir).unwrap();
        let again = std::fs::read_to_string(dir.join("python312._pth")).unwrap();
        assert_eq!(
            again.lines().filter(|line| line.trim() == "import site").count(),
            1
        );

        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn get_pip_bootstrap_does_not_run_as_pip() {
        assert!(!GET_PIP_BOOTSTRAP.contains("__main__"));
        assert!(GET_PIP_BOOTSTRAP.contains("from pip._internal.cli.main import main"));
        assert!(GET_PIP_BOOTSTRAP.contains("sys.argv[2:]"));
    }

    #[test]
    fn install_is_not_ready_without_marker() {
        let runtime = std::env::temp_dir().join(format!("fetchr-py-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(embedded_dir(&runtime)).unwrap();
        std::fs::write(embedded_python(&runtime), b"stub").unwrap();
        assert!(!is_installed(&runtime));
        std::fs::write(ready_marker(&runtime), EMBEDDED_PYTHON_VERSION).unwrap();
        assert!(is_installed(&runtime));
        let _ = std::fs::remove_dir_all(runtime);
    }
}
