use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};
use tokio::process::Command;

use crate::jobs::fetchr_mute::WordHit;
use crate::jobs::model_download;
use crate::jobs::queue::QueueManager;
use crate::jobs::types::{
    FetchrMuteAsrModel, FetchrMuteLanguage, FetchrMuteProcessingMode, JobProgress,
};

const RUNNER_SOURCE: &str = include_str!("../../resources/fetchr_mute_asr_onnx.py");
const RUNTIME_VERSION: &str = "fetchr-mute-asr-onnx-runtime-v8";

struct ModelFile {
    name: &'static str,
    expected_size: u64,
    sha256: &'static str,
}

const GIGAAM_V3_RNNT_FILES: &[ModelFile] = &[
    ModelFile {
        name: "encoder.int8.onnx",
        expected_size: 224_570_814,
        sha256: "0ec54e5f130a91c0f228d21795ede10b31c992a1f73e45dcd827e843a71a9b50",
    },
    ModelFile {
        name: "decoder.onnx",
        expected_size: 3_331_651,
        sha256: "5d1cfef155d8e07f213bd2f3229b5f6c5c29355c7fa5c1b9eb62cb1925725254",
    },
    ModelFile {
        name: "joiner.onnx",
        expected_size: 1_440_448,
        sha256: "fd1d02f45c2ad3d6b67cc149811ad794ab4b020ed49a0a9e2790a8619d1cddd8",
    },
    ModelFile {
        name: "tokens.txt",
        expected_size: 196,
        sha256: "17cc514451bcceac9c280068c71502f8448f99e9fb1456b8d0761651fd0392f2",
    },
];

/// Каталоги моделей, которыми приложение пользовалось до перехода на
/// единственную v3 RNN-T. Каждый весит ~225 МБ и после обновления не нужен.
/// `gigaam-v3-rnnt-int8` — экспорт под onnx-asr: тот же GigaAM v3, но с другой
/// сигнатурой графов, sherpa-onnx его не читает.
const LEGACY_MODEL_DIRECTORIES: &[&str] = &[
    "gigaam-v3-ctc-int8",
    "gigaam-v3-e2e-rnnt-int8",
    "gigaam-v3-rnnt-int8",
    "gigaam-multilingual-ctc-int8",
    "gigaam-multilingual-large-ctc-int8",
];

struct ModelSpec {
    key: &'static str,
    directory: &'static str,
    repo: &'static str,
    revision: &'static str,
    files: &'static [ModelFile],
}

fn model_spec(model: FetchrMuteAsrModel) -> ModelSpec {
    match model {
        FetchrMuteAsrModel::GigaAmV3RnntInt8 => ModelSpec {
            key: "gigaam-v3-rnnt",
            directory: "gigaam-v3-rnnt-sherpa-int8",
            repo: "csukuangfj/sherpa-onnx-nemo-transducer-giga-am-v3-russian-2025-12-16",
            revision: "0424d62637b37d8b7b1eb0f75a04d78dec55fdcc",
            files: GIGAAM_V3_RNNT_FILES,
        },
    }
}

/// Модель теперь одна на все режимы. Режим по-прежнему управляет длиной
/// сегментов и параметрами предотбора речи (см. `mode_config`), но не выбором
/// модели: раньше «Точный» уходил на E2E RNN-T, который распознаёт хуже
/// обычного (WER 11.2 против 9.1).
pub fn model_for_mode(_mode: FetchrMuteProcessingMode) -> FetchrMuteAsrModel {
    FetchrMuteAsrModel::GigaAmV3RnntInt8
}

/// Пользовательское имя движка распознавания. Название конкретной модели
/// в UI не показываем — только то, что это «модель распознавания».
pub fn model_label(_model: FetchrMuteAsrModel) -> &'static str {
    "ASR"
}

#[derive(Debug, Clone, Copy, Serialize)]
pub struct AsrSegment {
    pub start_sample: usize,
    pub end_sample: usize,
    /// Зона ответственности куска: из него берутся только слова, чья середина
    /// лежит в `[keep_start_sample, keep_end_sample)`. Куски длинной речи идут
    /// с нахлёстом, и без этого слово на стыке дублировалось бы.
    pub keep_start_sample: usize,
    pub keep_end_sample: usize,
}

#[derive(Debug, Deserialize)]
struct RunnerWord {
    raw: String,
    start: f64,
    end: f64,
    #[serde(default = "default_runner_confidence")]
    confidence: f32,
    #[serde(default)]
    lemma: Option<String>,
}

fn default_runner_confidence() -> f32 {
    1.0
}

#[derive(Debug, Deserialize)]
struct RunnerOutput {
    backend: String,
    words: Vec<RunnerWord>,
}

pub fn model_root(model: FetchrMuteAsrModel) -> PathBuf {
    crate::platform::app_data_dir()
        .unwrap_or_else(|| std::env::temp_dir().join("Fetchr"))
        .join("models")
        .join(model_spec(model).directory)
}

fn runtime_dir(_model_root: &Path) -> PathBuf {
    crate::platform::app_data_dir()
        .unwrap_or_else(|| std::env::temp_dir().join("Fetchr"))
        .join("runtime")
        .join("fetchr-mute-onnx-asr")
}

fn model_dir(model_root: &Path) -> PathBuf {
    model_root.join("model")
}

fn runner_path(model_root: &Path) -> PathBuf {
    runtime_dir(model_root).join("fetchr_mute_asr_onnx.py")
}

fn venv_python(model_root: &Path) -> PathBuf {
    #[cfg(windows)]
    return runtime_dir(model_root)
        .join("venv")
        .join("Scripts")
        .join("python.exe");
    #[cfg(not(windows))]
    return runtime_dir(model_root)
        .join("venv")
        .join("bin")
        .join("python");
}

/// Интерпретатор рантайма. Порядок важен: у установок, сделанных до
/// автоустановщика, зависимости уже лежат в venv — повторно качать Python и
/// 200 МБ колёс незачем.
fn python_executable(model_root: &Path) -> PathBuf {
    let venv = venv_python(model_root);
    if venv.is_file() {
        return venv;
    }
    let embedded = crate::jobs::python_runtime::embedded_python(&runtime_dir(model_root));
    if embedded.is_file() {
        return embedded;
    }
    venv
}

fn is_venv_interpreter(python: &Path) -> bool {
    python
        .parent()
        .and_then(|parent| parent.parent())
        .and_then(|root| root.file_name())
        .map(|name| name == std::ffi::OsStr::new("venv"))
        .unwrap_or(false)
}

/// Маркер установленных зависимостей лежит рядом с интерпретатором: снос venv
/// или встроенного Python автоматически заставляет поставить их заново.
fn runtime_marker(python: &Path) -> PathBuf {
    let root = if is_venv_interpreter(python) {
        python
            .parent()
            .and_then(|parent| parent.parent())
            .map(Path::to_path_buf)
    } else {
        python.parent().map(Path::to_path_buf)
    };
    root.unwrap_or_else(|| PathBuf::from("."))
        .join(RUNTIME_VERSION)
}

/// До появления встроенного Python маркер лежал в корне runtime. Старые
/// установки не должны переустанавливать зависимости из-за переезда файла.
fn dependencies_installed(model_root: &Path, python: &Path) -> bool {
    dependencies_installed_at(
        python,
        &runtime_dir(model_root).join(RUNTIME_VERSION),
    )
}

/// Пути передаются явно, поэтому проверку можно гонять в тестах, не трогая
/// настоящую установку рантайма. `runtime_dir` намеренно игнорирует
/// `model_root` (рантайм один на все модели), и тест с временным каталогом
/// раньше писал прямо в рабочий venv пользователя.
fn dependencies_installed_at(python: &Path, legacy_marker: &Path) -> bool {
    runtime_marker(python).is_file() || (is_venv_interpreter(python) && legacy_marker.is_file())
}

fn mode_config(mode: FetchrMuteProcessingMode) -> (&'static str, u16) {
    match mode {
        FetchrMuteProcessingMode::Normal => ("standard", 12),
        FetchrMuteProcessingMode::Precise => ("precise", 6),
    }
}

fn model_is_ready(model_root: &Path, spec: &ModelSpec) -> bool {
    spec.files
        .iter()
        .all(|file| model_file_is_ready(model_root, file))
}

fn model_file_is_ready(model_root: &Path, file: &ModelFile) -> bool {
    std::fs::metadata(model_dir(model_root).join(file.name))
        .map(|meta| meta.is_file() && meta.len() == file.expected_size)
        .unwrap_or(false)
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

async fn run_command(
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
                    if let Some(pid) = child_pid {
                        terminate_process_tree(pid);
                    }
                    return Err(anyhow!("FetchrMute task cancelled"));
                }
            }
        }
    }
}

fn terminate_process_tree(pid: u32) {
    #[cfg(windows)]
    {
        let mut command = crate::platform::hidden_command("taskkill");
        let _ = command
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    #[cfg(not(windows))]
    {
        let _ = crate::platform::hidden_command("kill")
            .args(["-TERM", &pid.to_string()])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
}

/// Единая точка получения интерпретатора.
///
/// 1. Уже готовый venv или встроенный Python — используем как есть.
/// 2. `FETCHR_PYTHON` — явное указание пользователя, строим из него venv.
/// 3. Windows x64 — ставим встроенный Python сами (основной путь).
/// 4. Остальные платформы — системный Python, как раньше.
async fn ensure_python(
    queue: &Arc<QueueManager>,
    job_id: &str,
    model_root: &Path,
    runtime: &Path,
    cancel: Arc<AtomicBool>,
) -> Result<PathBuf> {
    let existing = python_executable(model_root);
    if interpreter_is_usable(&existing, runtime) {
        return Ok(existing);
    }

    let explicit = std::env::var("FETCHR_PYTHON")
        .ok()
        .filter(|value| !value.trim().is_empty());
    if explicit.is_none() && crate::jobs::python_runtime::is_supported() {
        return crate::jobs::python_runtime::install(queue, job_id, runtime, cancel).await;
    }

    progress(queue, job_id, 3.0, "Подготовка общей среды ONNX ASR...");
    let system_python = match explicit {
        Some(path) => path,
        None => find_system_python(cancel.clone()).await?,
    };
    let mut command = Command::new(system_python);
    command
        .args(["-m", "venv"])
        .arg(runtime.join("venv"))
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let output = run_command(&mut command, cancel, "ASR virtual environment").await?;
    if !output.status.success() {
        return Err(anyhow!(
            "Failed to create ASR Python environment: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(venv_python(model_root))
}

/// python.exe появляется ещё при распаковке, а pip ставится следующим шагом.
/// Оборванная установка оставляла интерпретатор без pip, и каждая новая попытка
/// падала на «No module named pip» вместо того, чтобы доустановить его.
fn interpreter_is_usable(python: &Path, runtime: &Path) -> bool {
    python.is_file()
        && (is_venv_interpreter(python)
            || runtime_marker(python).is_file()
            || crate::jobs::python_runtime::is_installed(runtime))
}

/// Minor versions with onnxruntime wheels, newest first. A brand-new Python
/// (3.14, 3.15) often has none yet, so it is accepted only as a last resort.
const PREFERRED_PYTHON_MINORS: &[u32] = &[13, 12, 11, 10];

/// Where Python lives outside the PATH an app launched from Finder gets
/// (`/usr/bin:/bin:/usr/sbin:/sbin`, whose `python3` is Apple's 3.9).
fn unix_python_dirs(home: Option<&Path>) -> Vec<PathBuf> {
    let mut dirs = vec![
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/local/bin"),
        PathBuf::from("/opt/local/bin"),
    ];
    for minor in PREFERRED_PYTHON_MINORS {
        dirs.push(PathBuf::from(format!(
            "/Library/Frameworks/Python.framework/Versions/3.{minor}/bin"
        )));
    }
    if let Some(home) = home {
        dirs.push(home.join(".pyenv/shims"));
        dirs.push(home.join(".local/bin"));
    }
    dirs
}

/// Interpreters to probe, best first: an explicit `FETCHR_PYTHON`, then
/// versioned binaries in the known folders, then whatever PATH resolves.
fn python_candidates(explicit: Option<String>, dirs: &[PathBuf], windows: bool) -> Vec<String> {
    let mut candidates: Vec<String> = explicit.into_iter().filter(|p| !p.trim().is_empty()).collect();
    if !windows {
        for minor in PREFERRED_PYTHON_MINORS {
            for dir in dirs {
                candidates.push(format!("{}/python3.{minor}", dir.display()));
            }
        }
        for dir in dirs {
            candidates.push(format!("{}/python3", dir.display()));
        }
    }
    candidates.extend(["python3".to_string(), "python".to_string()]);
    let mut seen = std::collections::HashSet::new();
    candidates.retain(|candidate| seen.insert(candidate.clone()));
    candidates
}

async fn find_system_python(cancel: Arc<AtomicBool>) -> Result<String> {
    let home = std::env::var_os("HOME").map(PathBuf::from);
    let dirs = if cfg!(windows) { Vec::new() } else { unix_python_dirs(home.as_deref()) };
    let candidates = python_candidates(std::env::var("FETCHR_PYTHON").ok(), &dirs, cfg!(windows));

    for candidate in candidates {
        // Absolute paths that do not exist are skipped without spawning.
        if Path::new(&candidate).is_absolute() && !Path::new(&candidate).is_file() {
            continue;
        }
        let mut command = Command::new(&candidate);
        command
            .args([
                "-c",
                "import struct,sys; assert sys.version_info >= (3,10); assert struct.calcsize('P') == 8",
            ])
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        match run_command(&mut command, cancel.clone(), "Python runtime check").await {
            Ok(output) if output.status.success() => return Ok(candidate),
            _ => continue,
        }
    }
    Err(anyhow!(
        "ONNX ASR requires 64-bit Python 3.10 or newer. Install Python and restart Fetchr, or set FETCHR_PYTHON."
    ))
}

#[cfg(test)]
mod python_lookup_tests {
    use super::*;

    #[test]
    fn explicit_python_comes_first_and_versioned_before_generic() {
        let dirs = unix_python_dirs(Some(Path::new("/Users/me")));
        let list = python_candidates(Some("/custom/python".into()), &dirs, false);
        assert_eq!(list[0], "/custom/python");
        let brew313 = list.iter().position(|c| c == "/opt/homebrew/bin/python3.13").unwrap();
        let brew_generic = list.iter().position(|c| c == "/opt/homebrew/bin/python3").unwrap();
        let path_generic = list.iter().position(|c| c == "python3").unwrap();
        assert!(brew313 < brew_generic && brew_generic < path_generic);
    }

    #[test]
    fn includes_python_org_framework_and_skips_duplicates() {
        let dirs = unix_python_dirs(None);
        let list = python_candidates(None, &dirs, false);
        assert!(list.contains(&"/Library/Frameworks/Python.framework/Versions/3.12/bin/python3.12".to_string()));
        let unique: std::collections::HashSet<_> = list.iter().collect();
        assert_eq!(unique.len(), list.len());
    }

    #[test]
    fn windows_keeps_plain_path_lookup() {
        let list = python_candidates(None, &[], true);
        assert_eq!(list, vec!["python3".to_string(), "python".to_string()]);
    }
}

/// Докачивает недостающие файлы и ведёт прогресс от `start` до `end` по байтам
/// всего набора.
#[allow(clippy::too_many_arguments)]
async fn download_files(
    queue: &Arc<QueueManager>,
    job_id: &str,
    directory: &Path,
    repo: &str,
    revision: &str,
    files: &[ModelFile],
    (start, end): (f32, f32),
    label: &str,
    cancel: &AtomicBool,
) -> Result<()> {
    let total: u64 = files.iter().map(|file| file.expected_size).sum();
    let mut completed = 0u64;
    for file in files {
        let target = directory.join(file.name);
        let ready = std::fs::metadata(&target)
            .map(|meta| meta.is_file() && meta.len() == file.expected_size)
            .unwrap_or(false);
        if !ready {
            let done_before = completed;
            let mut report = |downloaded: u64, _: u64| {
                let done = done_before + downloaded;
                progress(
                    queue,
                    job_id,
                    start + (end - start) * done as f32 / total.max(1) as f32,
                    format!(
                        "{label}: {} / {}",
                        crate::util::format_bytes(done),
                        crate::util::format_bytes(total)
                    ),
                );
            };
            model_download::download(
                model_download::DownloadRequest {
                    urls: model_download::with_mirror(&model_download::hf_url(
                        repo, revision, file.name,
                    )),
                    target: &target,
                    size: file.expected_size,
                    sha256: file.sha256,
                    label,
                },
                cancel,
                &mut report,
            )
            .await?;
        }
        completed += file.expected_size;
    }
    Ok(())
}

async fn download_model(
    queue: &Arc<QueueManager>,
    job_id: &str,
    model_root: &Path,
    spec: &ModelSpec,
    cancel: Arc<AtomicBool>,
) -> Result<()> {
    progress(queue, job_id, 18.0, "Скачивание модели распознавания...");
    emit(queue, job_id, "Downloading pinned ASR model...");
    download_files(
        queue,
        job_id,
        &model_dir(model_root),
        spec.repo,
        spec.revision,
        spec.files,
        (18.0, 26.0),
        "Скачивание модели распознавания",
        &cancel,
    )
    .await
    .map_err(|error| {
        if model_download::is_cancelled(&error) {
            anyhow!("FetchrMute task cancelled")
        } else {
            error
        }
    })
}

pub async fn prepare(
    queue: &Arc<QueueManager>,
    job_id: &str,
    model_root: &Path,
    model: FetchrMuteAsrModel,
    cancel: Arc<AtomicBool>,
) -> Result<()> {
    let spec = model_spec(model);
    let runtime = runtime_dir(model_root);
    tokio::fs::create_dir_all(&runtime)
        .await
        .with_context(|| format!("create ASR runtime dir {runtime:?}"))?;
    tokio::fs::create_dir_all(model_dir(model_root)).await?;

    let runner = runner_path(model_root);
    let runner_current = tokio::fs::read_to_string(&runner).await.unwrap_or_default();
    if runner_current != RUNNER_SOURCE {
        tokio::fs::write(&runner, RUNNER_SOURCE)
            .await
            .with_context(|| format!("write ASR runner {runner:?}"))?;
        // Живой сервер держит старый код в памяти: файл переписан, а работает
        // по-прежнему прежняя версия. Гасим — следующая задача поднимет новую.
        kill_asr_server();
        emit(queue, job_id, "ASR runner updated; server will restart");
    }

    let python = ensure_python(queue, job_id, model_root, &runtime, cancel.clone()).await?;

    if !dependencies_installed(model_root, &python) {
        progress(
            queue,
            job_id,
            7.0,
            "Установка общего ONNX Runtime (выполняется один раз)...",
        );
        emit(
            queue,
            job_id,
            "Installing sherpa-onnx 1.13.7, ONNX Runtime and pymorphy3...",
        );
        let mut command = Command::new(&python);
        command
            .args([
                "-m",
                "pip",
                "install",
                "--disable-pip-version-check",
                "--no-input",
                // Без этого обрезанный PyPI выглядел как зависшая установка.
                "--timeout",
                "30",
                "--retries",
                "2",
                // sherpa-onnx несёт свой ONNX Runtime внутри. Отдельный
                // onnxruntime остаётся ради Silero VAD.
                "sherpa-onnx==1.13.7",
                "onnxruntime==1.27.0",
                "numpy==2.4.6",
                // Начальные формы слов: отличает «психуешь» (психовать) от мата.
                "pymorphy3==2.0.6",
            ])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let output = run_command(&mut command, cancel.clone(), "ASR dependencies").await?;
        if !output.status.success() {
            return Err(anyhow!(
                "Failed to install ASR dependencies: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            ));
        }
        tokio::fs::write(runtime_marker(&python), b"ok").await?;
    }

    if !model_is_ready(model_root, &spec) {
        download_model(queue, job_id, model_root, &spec, cancel.clone()).await?;
    }
    remove_legacy_models(model_root);
    ensure_vad_model(queue, job_id, model_root, cancel.clone()).await;
    ensure_ctc_model(queue, job_id, cancel).await;

    progress(queue, job_id, 28.0, "Модель распознавания готова");
    Ok(())
}

/// Чистка каталогов моделей, оставшихся от прежней схемы «модель на режим».
/// Best-effort: место освободить полезно, но ошибка удаления не должна ронять
/// задачу, а текущий каталог не трогаем ни при каких условиях.
fn remove_legacy_models(model_root: &Path) {
    // Вторая копия Silero VAD рядом с моделью: её качала прежняя версия
    // `fetchr_mute::ensure_model`, а читалась всегда копия в runtime-каталоге.
    let _ = std::fs::remove_file(model_root.join("silero_vad.onnx"));

    let Some(models_dir) = model_root.parent() else {
        return;
    };
    let current = model_root.file_name();
    for name in LEGACY_MODEL_DIRECTORIES {
        if current == Some(std::ffi::OsStr::new(name)) {
            continue;
        }
        let stale = models_dir.join(name);
        if stale.is_dir() {
            let _ = std::fs::remove_dir_all(&stale);
        }
    }
}

const CTC_MODEL_REPO: &str = "csukuangfj/sherpa-onnx-nemo-ctc-giga-am-v3-russian-2025-12-16";
const CTC_MODEL_REVISION: &str = "32a4c7cc81809bd132e2d935ab99e9e6ab47fbec";
const CTC_MODEL_FILES: &[ModelFile] = &[
    ModelFile {
        name: "model.int8.onnx",
        expected_size: 224_721_476,
        sha256: "f86ebfa0429ced91be6054fc344827e9c6c2572f3c318416cd974b06f66437ec",
    },
    ModelFile {
        name: "tokens.txt",
        expected_size: 196,
        sha256: "17cc514451bcceac9c280068c71502f8448f99e9fb1456b8d0761651fd0392f2",
    },
];

/// Каталог CTC-модели для перепроверки кандидатов. Отдельно от RNN-T: та же
/// GigaAM v3, но другая голова, и ошибается она в других местах.
pub fn ctc_model_dir() -> PathBuf {
    crate::platform::app_data_dir()
        .unwrap_or_else(|| std::env::temp_dir().join("Fetchr"))
        .join("models")
        .join("gigaam-v3-ctc-sherpa-int8")
        .join("model")
}

pub fn ctc_model_ready() -> bool {
    let dir = ctc_model_dir();
    CTC_MODEL_FILES.iter().all(|file| {
        std::fs::metadata(dir.join(file.name))
            .map(|meta| meta.is_file() && meta.len() == file.expected_size)
            .unwrap_or(false)
    })
}

/// CTC-модель (225 МБ) нужна только перепроверке. Не критична: без неё
/// мутится всё, что прошло порог уверенности, как раньше.
async fn ensure_ctc_model(
    queue: &Arc<QueueManager>,
    job_id: &str,
    cancel: Arc<AtomicBool>,
) {
    if ctc_model_ready() {
        return;
    }
    let dir = ctc_model_dir();
    if tokio::fs::create_dir_all(&dir).await.is_err() {
        return;
    }
    let outcome = download_files(
        queue,
        job_id,
        &dir,
        CTC_MODEL_REPO,
        CTC_MODEL_REVISION,
        CTC_MODEL_FILES,
        (26.0, 28.0),
        "Скачивание модели перепроверки",
        &cancel,
    )
    .await;
    if let Err(error) = outcome {
        emit(
            queue,
            job_id,
            format!("CTC model download failed (verification disabled): {error:#}"),
        );
    }
}

const VAD_MODEL_URL: &str = "https://raw.githubusercontent.com/snakers4/silero-vad/refs/tags/v5.1.2/src/silero_vad/data/silero_vad.onnx";
const VAD_MODEL_MIRROR_URL: &str =
    "https://cdn.jsdelivr.net/gh/snakers4/silero-vad@v5.1.2/src/silero_vad/data/silero_vad.onnx";
const VAD_MODEL_SIZE: u64 = 2_327_524;
const VAD_MODEL_SHA256: &str = "2623a2953f6ff3d2c1e61740c6cdb7168133479b267dfef114a4a3cc5bdd788f";

/// Silero VAD (2.3 МБ) фильтрует неречевые сегменты до ASR. Не критичен:
/// при ошибке скачивания распознавание просто работает без фильтра.
async fn ensure_vad_model(
    queue: &Arc<QueueManager>,
    job_id: &str,
    model_root: &Path,
    cancel: Arc<AtomicBool>,
) {
    let target = runtime_dir(model_root).join("silero_vad.onnx");
    let ready = std::fs::metadata(&target)
        .map(|meta| meta.is_file() && meta.len() == VAD_MODEL_SIZE)
        .unwrap_or(false);
    if ready {
        return;
    }
    let _ = tokio::fs::remove_file(&target).await;
    emit(queue, job_id, "Downloading Silero VAD model (2.3 MB)...");
    let outcome = model_download::download(
        model_download::DownloadRequest {
            urls: vec![VAD_MODEL_URL.to_string(), VAD_MODEL_MIRROR_URL.to_string()],
            target: &target,
            size: VAD_MODEL_SIZE,
            sha256: VAD_MODEL_SHA256,
            label: "Silero VAD",
        },
        &cancel,
        &mut |_, _| {},
    )
    .await;
    if let Err(error) = outcome {
        emit(
            queue,
            job_id,
            format!("Silero VAD download failed (speech filter disabled): {error:#}"),
        );
    }
}

// ---------------------------------------------------------------------------
// Профиль ASR-рантайма: число потоков, маска аффинности и размер батча.
//
// Раньше это была формула `(logical/2).clamp(4,8)` с маской `(1<<threads)-1`.
// На i5-13500H она даёт 8 потоков внутри маски из 4 физических P-ядер, и это не
// оптимум. Но и константа «физические ядра» не годится: замеры одного и того же
// конфига на ноутбуке разъезжаются в 4.5 раза из-за троттлинга и переноса
// потоков между P- и E-ядрами. Поэтому конфигурация подбирается замером на
// конкретной машине и запоминается.
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct AsrRuntimeConfig {
    pub threads: usize,
    /// `None` — пин выключен, процесс отдан планировщику.
    pub affinity: Option<u64>,
    pub batch: usize,
}

impl AsrRuntimeConfig {
    fn affinity_argument(&self) -> String {
        match self.affinity {
            Some(mask) => format!("{mask:#x}"),
            None => "off".to_string(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct AsrProfile {
    key: String,
    #[serde(flatten)]
    config: AsrRuntimeConfig,
    rtf: f32,
    measured_at_ms: u64,
}

const DEFAULT_ASR_BATCH: usize = 8;
/// Сколько секунд аудио прогоняется на одну конфигурацию при калибровке.
/// На 10 с при сегменте 12 с получался ровно один чанк, и замер не отражал
/// реальную нарезку; 15 с дают уже два.
const CALIBRATION_SECONDS: f64 = 15.0;
/// Общий бюджет калибровки. Превышение — берётся лучшее из уже измеренного,
/// а если не успела ни одна конфигурация — прежний дефолт. Запас рассчитан на
/// загруженную машину: замеренный там худший кандидат давал RTF 1.2, то есть
/// 18 с на один прогон плюс загрузка модели.
const CALIBRATION_BUDGET: Duration = Duration::from_secs(150);
/// Предел на один замер. Дочерний процесс, который завис на загрузке модели,
/// иначе держал бы глобальный ASR-мьютекс бесконечно.
const CALIBRATION_RUN_TIMEOUT: Duration = Duration::from_secs(75);
/// Сколько лучших конфигураций проверяются вторым кругом. Один замер на
/// ноутбуке слишком шумный, но и восемь замеров в бюджет не влезают.
const CALIBRATION_FINALISTS: usize = 2;

fn logical_cores() -> usize {
    std::thread::available_parallelism()
        .map(|count| count.get())
        .unwrap_or(4)
}

/// Ключ профиля. Меняется вместе с CPU, числом ядер, версией рантайма и
/// моделью — любая из этих смен делает старый замер недействительным.
fn profile_key(cpu: &str, logical: usize, model: FetchrMuteAsrModel) -> String {
    format!("{cpu}|{logical}|{RUNTIME_VERSION}|{}", model_spec(model).key)
}

fn cpu_identifier() -> String {
    std::env::var("PROCESSOR_IDENTIFIER")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "unknown-cpu".to_string())
}

/// Конфигурация, которой пользовались до калибровки. Остаётся запасным путём:
/// на ней всё работало, и любая ошибка замера обязана откатываться сюда.
fn default_runtime_config(logical: usize) -> AsrRuntimeConfig {
    let threads = (logical / 2).clamp(4, 8);
    AsrRuntimeConfig {
        threads,
        affinity: Some((1u64 << threads) - 1),
        batch: DEFAULT_ASR_BATCH,
    }
}

/// Кандидаты для замера. Набор намеренно короткий: каждая конфигурация — это
/// отдельный процесс с загрузкой модели.
fn calibration_candidates(logical: usize) -> Vec<AsrRuntimeConfig> {
    let default = default_runtime_config(logical);
    let narrow = (logical / 4).max(2);
    let mut candidates = vec![
        // Один поток на физическое P-ядро — гипотеза «HT мешает int8-GEMM».
        AsrRuntimeConfig {
            threads: narrow,
            affinity: Some((1u64 << narrow) - 1),
            batch: DEFAULT_ASR_BATCH,
        },
        default,
        // Тот же счётчик потоков, но без пина: планировщик волен занять E-ядра.
        AsrRuntimeConfig {
            affinity: None,
            ..default
        },
        // Все логические ядра, без пина.
        AsrRuntimeConfig {
            threads: logical.max(1),
            affinity: None,
            batch: DEFAULT_ASR_BATCH,
        },
    ];
    candidates.dedup();
    candidates
}

fn parse_benchmark_rtf(stdout: &str) -> Option<f32> {
    stdout.lines().rev().find_map(|line| {
        let payload = line.trim().strip_prefix("FETCHR_BENCH|")?;
        payload.split('|').find_map(|field| {
            field
                .strip_prefix("rtf=")
                .and_then(|value| value.parse::<f32>().ok())
        })
    })
}

fn profile_path(model_root: &Path) -> PathBuf {
    runtime_dir(model_root).join("asr-profile.json")
}

fn load_profile(model_root: &Path, key: &str) -> Option<AsrRuntimeConfig> {
    let content = std::fs::read_to_string(profile_path(model_root)).ok()?;
    let profile: AsrProfile = serde_json::from_str(&content).ok()?;
    (profile.key == key).then_some(profile.config)
}

fn save_profile(model_root: &Path, key: &str, config: AsrRuntimeConfig, rtf: f32) {
    let profile = AsrProfile {
        key: key.to_string(),
        config,
        rtf,
        measured_at_ms: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|value| value.as_millis() as u64)
            .unwrap_or_default(),
    };
    let path = profile_path(model_root);
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(content) = serde_json::to_string_pretty(&profile) {
        let _ = std::fs::write(path, content);
    }
}

fn thread_override() -> Option<usize> {
    std::env::var("FETCHR_ASR_THREADS")
        .ok()
        .and_then(|value| value.trim().parse::<usize>().ok())
        .filter(|threads| *threads > 0)
}

/// Замер запускается только по явной просьбе. Он стоит до шести запусков python
/// с загрузкой 225 МБ модели, а на этой машине выбрал ровно прежний дефолт —
/// то есть в обычном прогоне это чистая задержка перед распознаванием.
fn calibration_requested() -> bool {
    matches!(
        std::env::var("FETCHR_ASR_CALIBRATE")
            .unwrap_or_default()
            .trim(),
        "1" | "on" | "yes" | "true"
    )
}

/// Откуда берётся конфигурация. Вынесено отдельно, чтобы порядок приоритетов
/// проверялся тестом без запуска самих замеров.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ConfigSource {
    Override(usize),
    Profile(AsrRuntimeConfig),
    Calibrate,
    Default,
}

fn choose_config_source(
    override_threads: Option<usize>,
    profile: Option<AsrRuntimeConfig>,
    calibrate: bool,
) -> ConfigSource {
    if let Some(threads) = override_threads {
        return ConfigSource::Override(threads);
    }
    if let Some(config) = profile {
        return ConfigSource::Profile(config);
    }
    if calibrate {
        return ConfigSource::Calibrate;
    }
    ConfigSource::Default
}

/// Один замер одной конфигурации в отдельном процессе.
fn run_benchmark(
    model_root: &Path,
    model: FetchrMuteAsrModel,
    wav_path: &Path,
    config: AsrRuntimeConfig,
) -> Option<f32> {
    let mut command = crate::platform::hidden_command(python_executable(model_root));
    command
        .arg(runner_path(model_root))
        .arg("--benchmark")
        .arg("--model-dir")
        .arg(model_dir(model_root))
        .args(["--backend", model_spec(model).key])
        .arg("--wav")
        .arg(wav_path)
        .args(["--threads", &config.threads.to_string()])
        .args(["--affinity", &config.affinity_argument()])
        .args(["--batch", &config.batch.to_string()])
        .args(["--seconds", &CALIBRATION_SECONDS.to_string()])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .env("PYTHONIOENCODING", "utf-8");
    // Замер обязан быть ограничен по времени: калибровка идёт под глобальным
    // ASR-мьютексом, и зависший дочерний процесс заморозил бы задачу целиком.
    let mut child = command.spawn().ok()?;
    let deadline = Instant::now() + CALIBRATION_RUN_TIMEOUT;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {
                if Instant::now() >= deadline {
                    terminate_process_tree(child.id());
                    let _ = child.kill();
                    let _ = child.wait();
                    return None;
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            Err(_) => return None,
        }
    }
    let output = child.wait_with_output().ok()?;
    if !output.status.success() {
        return None;
    }
    parse_benchmark_rtf(&String::from_utf8_lossy(&output.stdout))
}

/// Подбор конфигурации на реальном аудио задачи. Возвращает `None`, если
/// замерить ничего не удалось — вызывающий берёт дефолт.
fn calibrate(
    queue: &Arc<QueueManager>,
    job_id: &str,
    model_root: &Path,
    model: FetchrMuteAsrModel,
    wav_path: &Path,
    cancel: &Arc<AtomicBool>,
) -> Option<(AsrRuntimeConfig, f32)> {
    let deadline = Instant::now() + CALIBRATION_BUDGET;
    let measure = |config: AsrRuntimeConfig| -> Option<f32> {
        if cancel.load(Ordering::SeqCst) || Instant::now() >= deadline {
            return None;
        }
        let rtf = run_benchmark(model_root, model, wav_path, config)?;
        emit(
            queue,
            job_id,
            format!(
                "ASR calibration: threads={} affinity={} batch={} RTF={rtf:.4}",
                config.threads,
                config.affinity_argument(),
                config.batch
            ),
        );
        Some(rtf)
    };

    // Первый круг — все кандидаты по одному замеру.
    let mut measured: Vec<(AsrRuntimeConfig, f32)> = calibration_candidates(logical_cores())
        .into_iter()
        .filter_map(|config| measure(config).map(|rtf| (config, rtf)))
        .collect();
    if measured.is_empty() {
        return None;
    }
    measured.sort_by(|left, right| left.1.total_cmp(&right.1));

    // Второй круг — только финалисты: один замер на ноутбуке слишком шумный,
    // но полный повтор не влезает в бюджет.
    for index in 0..measured.len().min(CALIBRATION_FINALISTS) {
        if let Some(rtf) = measure(measured[index].0) {
            measured[index].1 = measured[index].1.min(rtf);
        }
    }
    measured
        .into_iter()
        .min_by(|left, right| left.1.total_cmp(&right.1))
}

/// Конфигурация для запуска сервера: явное переопределение, затем сохранённый
/// профиль, затем замер, затем дефолт.
fn resolve_runtime_config(
    queue: &Arc<QueueManager>,
    job_id: &str,
    model_root: &Path,
    model: FetchrMuteAsrModel,
    wav_path: &Path,
    cancel: &Arc<AtomicBool>,
) -> AsrRuntimeConfig {
    let logical = logical_cores();
    let key = profile_key(&cpu_identifier(), logical, model);
    match choose_config_source(
        thread_override(),
        load_profile(model_root, &key),
        calibration_requested(),
    ) {
        ConfigSource::Override(threads) => AsrRuntimeConfig {
            threads,
            ..default_runtime_config(logical)
        },
        ConfigSource::Profile(config) => config,
        ConfigSource::Default => default_runtime_config(logical),
        ConfigSource::Calibrate => {
            progress(
                queue,
                job_id,
                33.0,
                "Подбор параметров распознавания (выполняется один раз)...",
            );
            match calibrate(queue, job_id, model_root, model, wav_path, cancel) {
                Some((config, rtf)) => {
                    save_profile(model_root, &key, config, rtf);
                    emit(
                        queue,
                        job_id,
                        format!(
                            "ASR calibration picked threads={} affinity={} batch={} (RTF={rtf:.4})",
                            config.threads,
                            config.affinity_argument(),
                            config.batch
                        ),
                    );
                    config
                }
                None => default_runtime_config(logical),
            }
        }
    }
}

pub fn transcribe(
    queue: &Arc<QueueManager>,
    job_id: &str,
    model_root: &Path,
    wav_path: &Path,
    segments: &[AsrSegment],
    hotwords: &[String],
    model: FetchrMuteAsrModel,
    language: FetchrMuteLanguage,
    mode: FetchrMuteProcessingMode,
    cancel: Arc<AtomicBool>,
) -> Result<Vec<WordHit>> {
    if cancel.load(Ordering::SeqCst) {
        return Err(anyhow!("FetchrMute task cancelled"));
    }
    let spec = model_spec(model);
    let segments_path = wav_path.with_extension("asr-segments.json");
    let stdout_path = wav_path.with_extension("asr-result.json");
    let stderr_path = wav_path.with_extension("asr-stderr.log");
    let hotwords_path = wav_path.with_extension("asr-hotwords.txt");
    std::fs::write(&segments_path, serde_json::to_vec(segments)?)
        .with_context(|| format!("write ASR segments {segments_path:?}"))?;
    // Бустинг словаря в декодере. Список зависит от настроек задачи, поэтому
    // пишется рядом с сегментами и живёт ровно столько же.
    let _ = std::fs::remove_file(&hotwords_path);
    if !hotwords.is_empty() {
        std::fs::write(&hotwords_path, hotwords.join("\n"))
            .with_context(|| format!("write ASR hotwords {hotwords_path:?}"))?;
    }
    // Файл лога задачи усекается; ASR-сервер дописывает в него прогресс
    // и маркеры завершения. Файл результата создаёт сам сервер.
    let _stderr_file = std::fs::File::create(&stderr_path)?;

    let locale = match language {
        FetchrMuteLanguage::Ru => "ru-RU",
        FetchrMuteLanguage::En => "en-US",
    };
    // Число потоков, маска аффинности и размер батча подбираются замером на
    // этой машине и запоминаются: константа тут не работает — оптимум зависит
    // от топологии CPU и от режима питания. Процессный параллелизм (2 воркера)
    // на замерах выигрыша не давал — глобальный ASR-мьютекс сохранён.
    let runtime_config =
        resolve_runtime_config(queue, job_id, model_root, model, wav_path, &cancel);
    let threads = runtime_config.threads;
    let (mode_name, segment_seconds) = mode_config(mode);
    progress(
        queue,
        job_id,
        35.0,
        format!("Этап 3 из 4 · распознавание: {locale}, фразы до {segment_seconds} с"),
    );
    emit(
        queue,
        job_id,
        format!(
            "ASR started: locale={locale}, mode={mode_name}, segments={}, threads={threads}, hotwords={}",
            segments.len(),
            hotwords.len()
        ),
    );

    let task = serde_json::json!({
        "id": job_id,
        "model_dir": model_dir(model_root),
        "backend": spec.key,
        "wav": wav_path,
        "segments": segments_path,
        "result": stdout_path,
        "log": stderr_path,
        "batch": runtime_config.batch,
        "hotwords": if hotwords.is_empty() { None } else { Some(&hotwords_path) },
    });
    let task_line = format!("{}\n", serde_json::to_string(&task)?);

    let cleanup = [
        segments_path.clone(),
        stdout_path.clone(),
        hotwords_path.clone(),
    ];
    let outcome = run_server_task(
        queue,
        job_id,
        model_root,
        runtime_config,
        &task_line,
        &stderr_path,
        &cleanup,
        &cancel,
        &mut |completed, total| {
            let percent = 35.0 + 52.0 * completed as f32 / total as f32;
            progress(
                queue,
                job_id,
                percent.min(87.0),
                format!("Этап 3 из 4 · распознавание: фрагмент {completed} из {total}"),
            );
        },
    );

    let stdout = std::fs::read_to_string(&stdout_path).unwrap_or_default();
    let stderr = std::fs::read_to_string(&stderr_path).unwrap_or_default();
    let _ = std::fs::remove_file(&segments_path);
    let _ = std::fs::remove_file(&stdout_path);
    let _ = std::fs::remove_file(&stderr_path);
    let _ = std::fs::remove_file(&hotwords_path);
    outcome.map_err(|error| anyhow!("ASR failed: {error:#} {}", runner_diagnostics(&stderr)))?;

    let output: RunnerOutput = serde_json::from_str(stdout.trim()).with_context(|| {
        format!("parse ASR result; stderr={}", runner_diagnostics(&stderr))
    })?;
    emit(
        queue,
        job_id,
        format!(
            "ASR completed on {}: {} word tokens",
            output.backend,
            output.words.len()
        ),
    );
    let words = output
        .words
        .into_iter()
        .filter(|word| word.start.is_finite() && word.end.is_finite() && word.end > word.start)
        .map(|word| WordHit {
            lemma: word
                .lemma
                .as_deref()
                .map(normalize_word)
                .filter(|lemma| !lemma.is_empty()),
            verified: None,
            normalized: normalize_word(&word.raw),
            raw: word.raw,
            start: word.start.max(0.0),
            end: word.end.max(0.0),
            confidence: if word.confidence.is_finite() {
                word.confidence.clamp(0.0, 1.0)
            } else {
                0.0
            },
        })
        .filter(|word| !word.normalized.is_empty())
        .collect();
    Ok(words)
}

/// Отправляет одну задачу постоянному ASR-серверу и ждёт её маркера в логе.
/// Общий цикл для распознавания и CTC-перепроверки: сервер поднимается при
/// необходимости, при отмене и зависании убивается. `cleanup` удаляется при
/// отмене и таймауте — остальное вызывающий убирает сам.
#[allow(clippy::too_many_arguments)]
fn run_server_task(
    queue: &Arc<QueueManager>,
    job_id: &str,
    model_root: &Path,
    runtime_config: AsrRuntimeConfig,
    task_line: &str,
    stderr_path: &Path,
    cleanup: &[PathBuf],
    cancel: &Arc<AtomicBool>,
    on_progress: &mut dyn FnMut(usize, usize),
) -> Result<()> {
    let vad_model = runtime_dir(model_root).join("silero_vad.onnx");
    let remove_all = || {
        for path in cleanup {
            let _ = std::fs::remove_file(path);
        }
    };
    // Постоянный ASR-процесс: модель загружается один раз и переиспользуется
    // между файлами очереди (раньше каждый файл платил 3-5 с за старт Python
    // и загрузку модели). Сервер живёт под тем же глобальным мьютексом, что
    // сериализует ASR; при отмене/зависании убивается и перезапускается.
    // Завершается сам по EOF на stdin при выходе приложения.
    let mut last_reported = 0usize;
    let mut last_activity = Instant::now();
    let mut attempts = 0usize;
    let mut sent = false;
    let mut log_offset = 0u64;
    loop {
        if cancel.load(Ordering::SeqCst) {
            kill_asr_server();
            remove_all();
            let _ = std::fs::remove_file(stderr_path);
            return Err(anyhow!("FetchrMute task cancelled"));
        }

        if !sent {
            let mut guard = asr_server().lock();
            // Профиль сменился (первая калибровка, другая модель): потоки и
            // маска зашиты в уже созданные сессии, поднимаем сервер заново.
            if guard
                .as_ref()
                .is_some_and(|server| server.config != runtime_config)
            {
                if let Some(mut server) = guard.take() {
                    terminate_process_tree(server.child.id());
                    let _ = server.child.kill();
                    let _ = server.child.wait();
                }
            }
            if guard.is_none() {
                attempts += 1;
                if attempts > 1 {
                    return Err(anyhow!("ASR server restart failed"));
                }
                // Каждый старт сервера — это ~2 с загрузки модели. В логе их
                // набиралось два десятка, а причина нигде не фиксировалась.
                emit(
                    queue,
                    job_id,
                    format!(
                        "Starting ASR server (attempt {attempts}); threads={} affinity={} batch={}",
                        runtime_config.threads,
                        runtime_config.affinity_argument(),
                        runtime_config.batch
                    ),
                );
                match spawn_asr_server(model_root, runtime_config, &vad_model) {
                    Ok(server) => *guard = Some(server),
                    Err(error) => return Err(anyhow!("spawn ASR server: {error:#}")),
                }
            }
            if let Some(server) = guard.as_mut() {
                let write = server
                    .stdin
                    .write_all(task_line.as_bytes())
                    .and_then(|_| server.stdin.flush());
                match write {
                    Ok(_) => sent = true,
                    Err(_) => {
                        // Сервер умер между задачами: перезапуск на следующем круге.
                        let _ = server.child.kill();
                        *guard = None;
                        continue;
                    }
                }
            }
            drop(guard);
        }

        // Сервер упал после отправки задачи: ждать маркера пять минут незачем.
        let server_died = asr_server()
            .lock()
            .as_mut()
            .map(|server| matches!(server.child.try_wait(), Ok(Some(_))))
            .unwrap_or(true);

        // Читаем только дописанное. Раньше весь файл перечитывался каждые
        // 100 мс, а на длинном файле он растёт со строкой прогресса на батч.
        let live_stderr = read_log_tail(stderr_path, &mut log_offset);
        if !live_stderr.is_empty() {
            if let Some((completed, total)) = parse_runner_progress(&live_stderr) {
                if completed > last_reported && total > 0 {
                    last_reported = completed;
                    last_activity = Instant::now();
                    on_progress(completed, total);
                }
            }
            if let Some(error) = parse_runner_task_error(&live_stderr, job_id) {
                kill_asr_server();
                return Err(anyhow!(error));
            }
            if runner_task_done(&live_stderr, job_id) {
                return Ok(());
            }
        }
        if server_died {
            kill_asr_server();
            return Err(anyhow!("ASR server exited before finishing the task"));
        }
        if last_activity.elapsed() >= Duration::from_secs(300) {
            kill_asr_server();
            remove_all();
            let diagnostics = std::fs::read_to_string(stderr_path).unwrap_or_default();
            let _ = std::fs::remove_file(stderr_path);
            return Err(anyhow!(
                "Распознавание не отвечает больше 5 минут. Процесс остановлен, чтобы задача не висела бесконечно. {}",
                runner_diagnostics(&diagnostics)
            ));
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

/// Окно аудио для CTC-перепроверки: кусок подготовленного WAV или отдельный
/// файл (голос, отделённый от музыки). `base_time` — время начала окна в
/// исходнике.
#[derive(Debug, Clone, Serialize)]
pub struct VerifyWindow {
    pub id: String,
    pub wav: PathBuf,
    pub start_sample: usize,
    pub end_sample: usize,
    pub base_time: f64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct CtcWord {
    pub raw: String,
    pub start: f64,
    pub end: f64,
}

#[derive(Debug, Deserialize)]
struct VerifyWindowResult {
    id: String,
    words: Vec<CtcWord>,
}

#[derive(Debug, Deserialize)]
struct VerifyOutput {
    windows: Vec<VerifyWindowResult>,
}

/// CTC-распознавание окон тем же ASR-сервером. Возвращает слова по id окна.
pub fn verify_windows(
    queue: &Arc<QueueManager>,
    job_id: &str,
    model_root: &Path,
    model: FetchrMuteAsrModel,
    work_dir: &Path,
    calibration_wav: &Path,
    windows: &[VerifyWindow],
    cancel: Arc<AtomicBool>,
) -> Result<std::collections::HashMap<String, Vec<CtcWord>>> {
    if windows.is_empty() {
        return Ok(Default::default());
    }
    let windows_path = work_dir.join("ctc-windows.json");
    let result_path = work_dir.join("ctc-result.json");
    let stderr_path = work_dir.join("ctc-stderr.log");
    std::fs::write(&windows_path, serde_json::to_vec(windows)?)
        .with_context(|| format!("write CTC windows {windows_path:?}"))?;
    let _ = std::fs::remove_file(&result_path);
    let _stderr_file = std::fs::File::create(&stderr_path)?;
    // Профиль сервера тот же, что у распознавания: иначе сервер перезапустится
    // ради одной короткой задачи. Если замер всё же понадобится, он идёт по
    // полному WAV задачи, а не по трёхсекундному клипу.
    let runtime_config =
        resolve_runtime_config(queue, job_id, model_root, model, calibration_wav, &cancel);
    let task = serde_json::json!({
        "id": job_id,
        "kind": "verify",
        "model_dir": ctc_model_dir(),
        "windows": windows_path,
        "result": result_path,
        "log": stderr_path,
    });
    let task_line = format!("{}\n", serde_json::to_string(&task)?);
    let cleanup = [windows_path.clone(), result_path.clone()];
    let outcome = run_server_task(
        queue,
        job_id,
        model_root,
        runtime_config,
        &task_line,
        &stderr_path,
        &cleanup,
        &cancel,
        &mut |completed, total| {
            progress(
                queue,
                job_id,
                88.0,
                format!("Перепроверка сомнительных слов: {completed} из {total}"),
            );
        },
    );
    let stdout = std::fs::read_to_string(&result_path).unwrap_or_default();
    let stderr = std::fs::read_to_string(&stderr_path).unwrap_or_default();
    let _ = std::fs::remove_file(&windows_path);
    let _ = std::fs::remove_file(&result_path);
    let _ = std::fs::remove_file(&stderr_path);
    outcome.map_err(|error| anyhow!("CTC verify failed: {error:#} {}", runner_diagnostics(&stderr)))?;
    let output: VerifyOutput = serde_json::from_str(stdout.trim())
        .with_context(|| format!("parse CTC result; stderr={}", runner_diagnostics(&stderr)))?;
    Ok(output
        .windows
        .into_iter()
        .map(|window| (window.id, window.words))
        .collect())
}

/// Дописанные с прошлого раза целые строки лога. Хвост без перевода строки не
/// отдаётся и не двигает смещение: иначе маркер `FETCHR_DONE|...` мог бы
/// прийти разрезанным пополам и потеряться.
fn read_log_tail(path: &Path, offset: &mut u64) -> String {
    use std::io::{Read, Seek, SeekFrom};

    let Ok(mut file) = std::fs::File::open(path) else {
        return String::new();
    };
    let length = file.metadata().map(|meta| meta.len()).unwrap_or(0);
    if length < *offset {
        // Файл пересоздали — начинаем сначала.
        *offset = 0;
    }
    if length == *offset {
        return String::new();
    }
    if file.seek(SeekFrom::Start(*offset)).is_err() {
        return String::new();
    }
    let mut buffer = Vec::with_capacity((length - *offset) as usize);
    if file.read_to_end(&mut buffer).is_err() {
        return String::new();
    }
    let Some(last_newline) = buffer.iter().rposition(|byte| *byte == b'\n') else {
        return String::new();
    };
    buffer.truncate(last_newline + 1);
    *offset += buffer.len() as u64;
    String::from_utf8_lossy(&buffer).into_owned()
}

fn parse_runner_progress(stderr: &str) -> Option<(usize, usize)> {
    stderr.lines().rev().find_map(|line| {
        let payload = line.trim().strip_prefix("FETCHR_PROGRESS|")?;
        let (completed, total) = payload.split_once('|')?;
        Some((completed.parse().ok()?, total.parse().ok()?))
    })
}

// ---------------------------------------------------------------------------
// Постоянный ASR-процесс (см. --serve в fetchr_mute_asr_onnx.py).
// ---------------------------------------------------------------------------

struct AsrServer {
    child: Child,
    stdin: ChildStdin,
    /// Конфигурация, с которой сервер поднят. Потоки и маска фиксируются при
    /// создании ONNX-сессии, поэтому смена профиля требует перезапуска.
    config: AsrRuntimeConfig,
}

fn asr_server() -> &'static parking_lot::Mutex<Option<AsrServer>> {
    static SERVER: OnceLock<parking_lot::Mutex<Option<AsrServer>>> = OnceLock::new();
    SERVER.get_or_init(|| parking_lot::Mutex::new(None))
}

fn spawn_asr_server(
    model_root: &Path,
    config: AsrRuntimeConfig,
    vad_model: &Path,
) -> Result<AsrServer> {
    let threads = config.threads;
    let server_log = runtime_dir(model_root).join("asr-server-stderr.log");
    if let Some(parent) = server_log.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let stderr_file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&server_log)
        .with_context(|| format!("open ASR server log {server_log:?}"))?;
    let mut command = crate::platform::hidden_command(python_executable(model_root));
    command
        .arg(runner_path(model_root))
        .arg("--serve")
        .arg("--threads")
        .arg(threads.to_string())
        .arg("--affinity")
        .arg(config.affinity_argument())
        .arg("--batch")
        .arg(config.batch.to_string())
        .arg("--vad-model")
        .arg(vad_model)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::from(stderr_file))
        // Task JSON is always written as UTF-8 below. Force the same encoding
        // even for older Windows Python installations using a legacy code page.
        .env("PYTHONIOENCODING", "utf-8");
    let mut child = command
        .spawn()
        .context("spawn persistent ONNX ASR server")?;
    // Самый долгий дочерний процесс задачи: без opt-out он уезжает на E-ядра
    // вместе со свёрнутым окном приложения, а замеренный RTF 0.06 получен на
    // P-ядрах. Пин потоков на P-ядра делает сам runner (FETCHR_ASR_AFFINITY).
    crate::win_power::disable_for_pid(Some(child.id()));
    let stdin = child.stdin.take().context("ASR server stdin pipe")?;
    Ok(AsrServer {
        child,
        stdin,
        config,
    })
}

fn kill_asr_server() {
    if let Some(mut server) = asr_server().lock().take() {
        terminate_process_tree(server.child.id());
        let _ = server.child.kill();
        let _ = server.child.wait();
    }
}

fn runner_task_done(stderr: &str, job_id: &str) -> bool {
    let marker = format!("FETCHR_DONE|{job_id}");
    stderr.lines().any(|line| line.trim() == marker)
}

fn parse_runner_task_error(stderr: &str, job_id: &str) -> Option<String> {
    let prefix = format!("FETCHR_ERROR|{job_id}|");
    stderr.lines().rev().find_map(|line| {
        line.trim()
            .strip_prefix(&prefix)
            .map(|error| error.to_string())
    })
}

fn runner_diagnostics(stderr: &str) -> String {
    let diagnostics = stderr
        .lines()
        .filter(|line| {
            let line = line.trim();
            !line.starts_with("FETCHR_PROGRESS|") && !line.starts_with("FETCHR_ERROR|")
        })
        .collect::<Vec<_>>()
        .join("\n");
    let diagnostics = diagnostics.trim();
    if diagnostics.is_empty() {
        "процесс распознавания завершился без диагностики".to_string()
    } else {
        diagnostics.to_string()
    }
}

fn normalize_word(word: &str) -> String {
    word.to_lowercase()
        .chars()
        .filter_map(|ch| match ch {
            'ё' => Some('е'),
            ch if ch.is_alphanumeric() => Some(ch),
            _ => None,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mode_uses_distinct_segment_lengths() {
        assert_eq!(
            mode_config(FetchrMuteProcessingMode::Normal),
            ("standard", 12)
        );
        assert_eq!(
            mode_config(FetchrMuteProcessingMode::Precise),
            ("precise", 6)
        );
    }

    #[test]
    fn russian_normalization_matches_wordlist_format() {
        assert_eq!(normalize_word("Ё-Моё!"), "емое");
    }

    #[test]
    fn half_installed_embedded_python_is_not_usable() {
        let runtime = std::env::temp_dir().join(format!("fetchr-asr-{}", uuid::Uuid::new_v4()));
        let python = crate::jobs::python_runtime::embedded_python(&runtime);
        std::fs::create_dir_all(python.parent().unwrap()).unwrap();
        std::fs::write(&python, b"stub").unwrap();
        assert!(!interpreter_is_usable(&python, &runtime));

        // Установка с зависимостями не должна переустанавливаться.
        std::fs::write(runtime_marker(&python), b"ok").unwrap();
        assert!(interpreter_is_usable(&python, &runtime));
        let _ = std::fs::remove_dir_all(runtime);
    }

    #[test]
    fn model_file_check_rejects_truncated_downloads() {
        let root = std::env::temp_dir().join(format!(
            "fetchr-gigaam-v3-test-{}",
            uuid::Uuid::new_v4()
        ));
        let directory = model_dir(&root);
        std::fs::create_dir_all(&directory).unwrap();
        let config = GIGAAM_V3_RNNT_FILES
            .iter()
            .find(|file| file.name == "tokens.txt")
            .unwrap();
        let path = directory.join(config.name);
        std::fs::write(&path, vec![b'x'; config.expected_size as usize]).unwrap();
        assert!(model_file_is_ready(&root, config));
        std::fs::write(&path, vec![b'x'; config.expected_size as usize - 1]).unwrap();
        assert!(!model_file_is_ready(&root, config));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn every_mode_uses_the_single_rnnt_model() {
        for mode in [
            FetchrMuteProcessingMode::Normal,
            FetchrMuteProcessingMode::Precise,
        ] {
            assert_eq!(
                model_for_mode(mode),
                FetchrMuteAsrModel::GigaAmV3RnntInt8,
                "{mode:?} must not pick its own model"
            );
        }
        let spec = model_spec(FetchrMuteAsrModel::GigaAmV3RnntInt8);
        assert_eq!(spec.key, "gigaam-v3-rnnt");
        assert_eq!(spec.directory, "gigaam-v3-rnnt-sherpa-int8");
        // Символьный словарь на 34 токена: от него зависят склейка CTC/RNN-T
        // фрагментов, границы спанов и токенизация списка бустинга.
        assert!(spec.files.iter().any(|file| file.name == "tokens.txt"));
        // Каталог экспорта под onnx-asr обязан попасть в чистку: sherpa его
        // не читает, а 225 МБ на диске остаются.
        assert!(LEGACY_MODEL_DIRECTORIES.contains(&"gigaam-v3-rnnt-int8"));
        assert!(!LEGACY_MODEL_DIRECTORIES.contains(&spec.directory));
    }

    #[test]
    fn legacy_model_settings_migrate_to_single_model() {
        for legacy in [
            r#""gigaam_v3_ctc_int8""#,
            r#""gigaam_v3_e2e_rnnt_int8""#,
            r#""gigaam_v3_rnnt_onnx""#,
            r#""gigaam_multilingual_ctc_int8""#,
            r#""gigaam_multilingual_large_ctc_int8""#,
            r#""parakeet_tdt_0_6b_v3""#,
        ] {
            let model: FetchrMuteAsrModel = serde_json::from_str(legacy).unwrap();
            assert_eq!(model, FetchrMuteAsrModel::GigaAmV3RnntInt8, "{legacy}");
        }
        assert_eq!(
            serde_json::to_string(&FetchrMuteAsrModel::GigaAmV3RnntInt8).unwrap(),
            r#""gigaam_v3_rnnt_int8""#
        );
    }

    #[test]
    fn dependency_marker_follows_the_interpreter() {
        let venv = Path::new("C:/Fetchr/runtime/fetchr-mute-onnx-asr/venv/Scripts/python.exe");
        let embedded = Path::new("C:/Fetchr/runtime/fetchr-mute-onnx-asr/python/python.exe");
        assert!(is_venv_interpreter(venv));
        assert!(!is_venv_interpreter(embedded));
        assert!(runtime_marker(venv).ends_with(Path::new("venv").join(RUNTIME_VERSION)));
        assert!(runtime_marker(embedded).ends_with(Path::new("python").join(RUNTIME_VERSION)));
    }

    #[test]
    fn legacy_venv_marker_still_counts_as_installed() {
        // Все пути — во временном каталоге. Раньше тест звал `venv_python(&root)`
        // и писал в него, но `runtime_dir` игнорирует `model_root`, поэтому
        // «временный» путь указывал в рабочую установку пользователя и тест
        // затирал настоящий venv/Scripts/python.exe.
        let runtime = std::env::temp_dir().join(format!("fetchr-marker-{}", uuid::Uuid::new_v4()));
        let venv = runtime.join("venv").join("Scripts").join("python.exe");
        let legacy_marker = runtime.join(RUNTIME_VERSION);
        assert!(!dependencies_installed_at(&venv, &legacy_marker));

        // Установки до автоустановщика держали маркер в корне runtime.
        std::fs::create_dir_all(&runtime).unwrap();
        std::fs::write(&legacy_marker, b"ok").unwrap();
        assert!(dependencies_installed_at(&venv, &legacy_marker));

        // Для встроенного Python старый маркер не действует.
        let embedded = crate::jobs::python_runtime::embedded_python(&runtime);
        assert!(!dependencies_installed_at(&embedded, &legacy_marker));
        let _ = std::fs::remove_dir_all(runtime);
    }

    #[test]
    fn legacy_cleanup_never_removes_the_active_model() {
        let root = std::env::temp_dir().join(format!("fetchr-legacy-test-{}", uuid::Uuid::new_v4()));
        let models = root.join("models");
        let active = models.join("gigaam-v3-rnnt-int8");
        let stale = models.join("gigaam-v3-ctc-int8");
        std::fs::create_dir_all(&active).unwrap();
        std::fs::create_dir_all(&stale).unwrap();
        // Дубликат VAD, оставшийся от прежней схемы с двумя загрузками.
        let stale_vad = active.join("silero_vad.onnx");
        std::fs::write(&stale_vad, b"stub").unwrap();
        remove_legacy_models(&active);
        assert!(active.is_dir());
        assert!(!stale.exists());
        assert!(!stale_vad.exists(), "duplicate VAD copy must be removed");
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn runner_protocol_preserves_utf8_words() {
        let output: RunnerOutput = serde_json::from_str(
            r#"{"backend":"cpu","words":[{"raw":"Оцелоты","start":1.2,"end":1.8}]}"#,
        )
        .unwrap();
        assert_eq!(output.backend, "cpu");
        assert_eq!(output.words[0].raw, "Оцелоты");
    }

    #[test]
    fn profile_key_tracks_everything_that_invalidates_a_measurement() {
        let model = FetchrMuteAsrModel::GigaAmV3RnntInt8;
        let base = profile_key("Intel64 Family 6 Model 186", 16, model);
        assert_ne!(base, profile_key("AMD64 Family 25", 16, model));
        assert_ne!(base, profile_key("Intel64 Family 6 Model 186", 8, model));
        assert!(base.contains(RUNTIME_VERSION), "{base}");
        assert!(base.contains(model_spec(model).key), "{base}");
    }

    #[test]
    fn saved_profile_is_reused_only_for_its_own_key() {
        let root = std::env::temp_dir().join(format!("fetchr-profile-{}", uuid::Uuid::new_v4()));
        // `runtime_dir` игнорирует model_root, поэтому пишем и читаем по одному
        // и тому же реальному пути — проверяем сопоставление ключей, а не путь.
        let path = profile_path(&root);
        let restore = std::fs::read_to_string(&path).ok();

        let config = AsrRuntimeConfig {
            threads: 4,
            affinity: Some(0xff),
            batch: 16,
        };
        save_profile(&root, "key-a", config, 0.0693);
        assert_eq!(load_profile(&root, "key-a"), Some(config));
        assert_eq!(load_profile(&root, "key-b"), None);

        match restore {
            Some(content) => std::fs::write(&path, content).unwrap(),
            None => {
                let _ = std::fs::remove_file(&path);
            }
        }
    }

    #[test]
    fn calibration_candidates_keep_the_shipped_default() {
        let logical = 16;
        let candidates = calibration_candidates(logical);
        assert!(
            candidates.contains(&default_runtime_config(logical)),
            "{candidates:?}"
        );
        // Узкая конфигурация — один поток на физическое P-ядро.
        assert!(candidates.iter().any(|config| config.threads == 4
            && config.affinity == Some(0xf)));
        // Без пина тоже обязана быть: на однородных CPU маска только мешает.
        assert!(candidates.iter().any(|config| config.affinity.is_none()));
        assert!(candidates.len() <= 4, "калибровка не должна разрастаться");
    }

    #[test]
    fn default_config_matches_the_previous_formula() {
        assert_eq!(
            default_runtime_config(16),
            AsrRuntimeConfig {
                threads: 8,
                affinity: Some(0xff),
                batch: 8
            }
        );
        // clamp снизу: двухъядерная машина всё равно получает 4 потока.
        assert_eq!(default_runtime_config(2).threads, 4);
    }

    #[test]
    fn calibration_does_not_run_unless_requested() {
        let profile = AsrRuntimeConfig {
            threads: 4,
            affinity: Some(0xf),
            batch: 8,
        };
        // Обычный запуск без профиля: замер не трогаем, берём прежний дефолт.
        assert_eq!(
            choose_config_source(None, None, false),
            ConfigSource::Default
        );
        // Сохранённый профиль важнее замера.
        assert_eq!(
            choose_config_source(None, Some(profile), true),
            ConfigSource::Profile(profile)
        );
        // Явные потоки бьют всё.
        assert_eq!(
            choose_config_source(Some(6), Some(profile), true),
            ConfigSource::Override(6)
        );
        // Замер — только по явной просьбе и только когда профиля нет.
        assert_eq!(
            choose_config_source(None, None, true),
            ConfigSource::Calibrate
        );
    }

    #[test]
    fn log_tail_returns_only_new_whole_lines() {
        let path = std::env::temp_dir().join(format!("fetchr-log-{}.log", uuid::Uuid::new_v4()));
        std::fs::write(&path, "first\nsecond\n").unwrap();
        let mut offset = 0u64;
        assert_eq!(read_log_tail(&path, &mut offset), "first\nsecond\n");
        // Повторный вызов без записи не отдаёт ничего.
        assert_eq!(read_log_tail(&path, &mut offset), "");

        // Незавершённая строка ждёт своего перевода строки.
        std::fs::write(&path, "first\nsecond\nthi").unwrap();
        assert_eq!(read_log_tail(&path, &mut offset), "");
        std::fs::write(&path, "first\nsecond\nthird\n").unwrap();
        assert_eq!(read_log_tail(&path, &mut offset), "third\n");

        // Пересозданный файл читается с начала.
        std::fs::write(&path, "fresh\n").unwrap();
        assert_eq!(read_log_tail(&path, &mut offset), "fresh\n");
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn benchmark_line_is_parsed() {
        let stdout = "noise\nFETCHR_BENCH|threads=4|affinity=0xff|batch=8|audio_s=10.00|rtf=0.06931\n";
        assert_eq!(parse_benchmark_rtf(stdout), Some(0.06931));
        assert_eq!(parse_benchmark_rtf("nothing here"), None);
        // Берётся последняя строка: процесс мог напечатать прогрев.
        let repeated = "FETCHR_BENCH|rtf=0.5\nFETCHR_BENCH|rtf=0.25\n";
        assert_eq!(parse_benchmark_rtf(repeated), Some(0.25));
    }

    #[test]
    fn affinity_argument_round_trips_through_the_runner() {
        assert_eq!(
            AsrRuntimeConfig {
                threads: 4,
                affinity: Some(0xff),
                batch: 8
            }
            .affinity_argument(),
            "0xff"
        );
        assert_eq!(
            AsrRuntimeConfig {
                threads: 4,
                affinity: None,
                batch: 8
            }
            .affinity_argument(),
            "off"
        );
    }

    #[test]
    fn runner_progress_uses_latest_completed_segment() {
        let stderr = "diagnostic\nFETCHR_PROGRESS|1|7\nFETCHR_PROGRESS|4|7\n";
        assert_eq!(parse_runner_progress(stderr), Some((4, 7)));
        assert_eq!(runner_diagnostics(stderr), "diagnostic");
    }

    #[test]
    fn runner_diagnostics_does_not_duplicate_task_error() {
        let stderr =
            "FETCHR_ERROR|in_page_123|gigaam-v3-ctc ONNX model is incomplete: model.onnx\n";
        assert_eq!(
            parse_runner_task_error(stderr, "in_page_123").as_deref(),
            Some("gigaam-v3-ctc ONNX model is incomplete: model.onnx")
        );
        assert_eq!(
            runner_diagnostics(stderr),
            "процесс распознавания завершился без диагностики"
        );
    }
}
