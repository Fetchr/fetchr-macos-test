use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use tauri::State;

use crate::jobs::fetchr_mute::{MuteSpan, WordHit};
use crate::jobs::types::{FetchrMuteProcessingMode, FetchrMuteSettings, JobProgress};
use crate::AppState;

#[derive(serde::Serialize, serde::Deserialize)]
pub struct InPageResult {
    pub output_path: String,
    pub words: Vec<WordHit>,
    pub spans: Vec<MuteSpan>,
}

/// Куда сохранять результат, если пользователь выбрал «Сохранить как».
/// None в любом поле — прежнее поведение: рядом с исходником.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct OutputTarget {
    pub directory: Option<String>,
    pub file_name: Option<String>,
}

/// Резервирует итоговый путь: пользовательский, если задан, иначе прежний
/// автоматический рядом с исходником.
fn reserve_output_path(
    input_path: &str,
    target: Option<&OutputTarget>,
) -> Result<std::path::PathBuf, String> {
    let input = Path::new(input_path);
    let custom = target.and_then(|value| {
        let directory = value
            .directory
            .as_deref()
            .map(str::trim)
            .filter(|v| !v.is_empty())?;
        let file_name = value
            .file_name
            .as_deref()
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| {
                let stem = input
                    .file_stem()
                    .map(|v| v.to_string_lossy().into_owned())
                    .unwrap_or_else(|| "output".to_string());
                format!("{stem}_fetchr_mute")
            });
        Some((directory.to_string(), file_name))
    });
    // Пустые «зарезервированные» файлы от прерванных запусков не должны
    // копиться рядом с исходником ни на одном из путей.
    crate::jobs::fetchr_mute::cleanup_empty_reserved_outputs(input);
    match custom {
        Some((directory, file_name)) => crate::jobs::fetchr_mute::fetchr_mute_output_path_at(
            Path::new(&directory),
            &file_name,
            input,
        )
        .map_err(|e| e.to_string()),
        None => crate::jobs::fetchr_mute::fetchr_mute_output_path(input).map_err(|e| e.to_string()),
    }
}

#[derive(serde::Serialize, serde::Deserialize)]
pub struct InPageRecensorResult {
    pub output_path: String,
    pub spans: Vec<MuteSpan>,
}

struct CleanupCancel {
    cancels: Arc<parking_lot::Mutex<std::collections::HashMap<String, Arc<AtomicBool>>>>,
    task_id: String,
}

impl Drop for CleanupCancel {
    fn drop(&mut self) {
        self.cancels.lock().remove(&self.task_id);
    }
}

#[tauri::command]
pub async fn run_mute_in_page(
    _app_handle: tauri::AppHandle,
    state: State<'_, AppState>,
    task_id: String,
    input_path: String,
    binaries_dir: Option<String>,
    settings: FetchrMuteSettings,
    force_reanalysis: Option<bool>,
    output_target: Option<OutputTarget>,
) -> Result<InPageResult, String> {
    let mut settings = settings;
    settings.asr_model = crate::jobs::asr_models::model_for_mode(settings.mode);

    let task_id = uuid::Uuid::parse_str(&task_id)
        .map_err(|_| "Invalid FetchrMute task id".to_string())?
        .to_string();
    let cancel_flag = Arc::new(AtomicBool::new(false));
    {
        // A new file/retry supersedes every older in-page analysis. Leaving
        // them alive used to accumulate competing VAD/ASR workers.
        let mut active = state.in_page_cancels.lock();
        for previous in active.values() {
            previous.store(true, Ordering::SeqCst);
        }
        active.clear();
        active.insert(task_id.clone(), cancel_flag.clone());
    }

    let _cleanup = CleanupCancel {
        cancels: state.in_page_cancels.clone(),
        task_id: task_id.clone(),
    };

    let bin_dir = binaries_dir.as_deref().map(Path::new);
    let ffmpeg = crate::binaries::resolve_binary(crate::binaries::FFMPEG, bin_dir)
        .ok_or_else(|| "ffmpeg.exe not found - set binaries folder in Settings".to_string())?;

    let is_precise = matches!(settings.mode, FetchrMuteProcessingMode::Precise);
    let asr_model = settings.asr_model;
    let model_dir = crate::jobs::asr_models::model_root(asr_model);

    let job_id = format!("in_page_{task_id}");
    let tmp_dir = std::env::temp_dir().join("fetchr-mute").join(&task_id);
    // In-page progress values are already absolute (0..100). Keeping a 0..100
    // stage avoids accidentally remapping 35% recognition progress into a tiny
    // 30..34% subrange.
    state.queue.set_progress_stage(
        &job_id,
        0.0,
        100.0,
        Some("Этап 1 из 4 · подготовка моделей".to_string()),
    );

    tokio::fs::create_dir_all(&tmp_dir)
        .await
        .map_err(|e| format!("create FetchrMute temp dir: {e}"))?;
    let _tmp_guard = crate::jobs::fetchr_mute::TempDirGuard::new(tmp_dir.clone());

    let source_fingerprint = crate::jobs::fetchr_mute::source_fingerprint(Path::new(&input_path))
        .map_err(|e| e.to_string())?;
    // Подготовленный WAV переживает задачу: следующий пересчёт цензуры возьмёт
    // его из кэша вместо полного декода исходника.
    let wav_path =
        crate::jobs::fetchr_mute::prepared_wav_path(
        &source_fingerprint,
        settings.mute_profile,
        crate::jobs::fetchr_mute::selected_audio_track(&settings),
    );
    if let Some(parent) = wav_path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| format!("create FetchrMute wav cache: {e}"))?;
    }
    crate::jobs::fetchr_mute::prune_prepared_wav_cache(&wav_path, 2);

    // Recognition cache: if this exact file was already processed with the same
    // model (mode), reuse the saved words and skip the heavy ASR pass. Changing
    // censor settings afterwards then re-applies almost instantly because only
    // span-building + render run. «Обработать заново» passes force_reanalysis
    // to bypass the cache and run a fresh ASR pass.
    let cached_words = if force_reanalysis.unwrap_or(false) {
        None
    } else {
        crate::jobs::fetchr_mute::cached_recognition(&input_path, &settings, &source_fingerprint)
    };

    let words = if let Some(words) = cached_words {
        set_in_page_progress(
            &state.queue,
            &job_id,
            88.0,
            "Этап 3 из 4 · распознавание загружено из кэша",
        );
        // Другие настройки цензуры дают новых кандидатов, которых прошлый
        // прогон не перепроверял (verified == None).
        let profane_words =
            crate::jobs::fetchr_mute::load_profane_words(&settings).map_err(|e| e.to_string())?;
        let needs_verify = !crate::jobs::fetchr_mute_verify::candidate_indices(
            &words,
            &profane_words,
            &settings,
        )
        .is_empty()
            && crate::jobs::asr_models::ctc_model_ready();
        let wav_ready = needs_verify
            && (crate::jobs::fetchr_mute::prepared_wav_ready(&wav_path)
                || crate::jobs::fetchr_mute::convert_to_wav_for_profile(
                    &ffmpeg,
                    Path::new(&input_path),
                    &wav_path,
                    cancel_flag.clone(),
                    settings.mute_profile,
                    crate::jobs::fetchr_mute::selected_audio_track(&settings),
                )
                .await
                .is_ok());
        if wav_ready {
            crate::jobs::fetchr_mute::verify_words_blocking(
                &state.queue,
                &job_id,
                &model_dir,
                &ffmpeg,
                Path::new(&input_path),
                &wav_path,
                &tmp_dir,
                words,
                &profane_words,
                &settings,
                cancel_flag.clone(),
            )
            .await
            .map_err(|e| e.to_string())?
        } else {
            words
        }
    } else {
        // 1. Ensure models
        set_in_page_progress(
            &state.queue,
            &job_id,
            0.0,
            "Этап 1 из 4 · подготовка моделей",
        );
        crate::jobs::fetchr_mute::ensure_model(
            &state.queue,
            &job_id,
            &model_dir,
            asr_model,
            is_precise,
            cancel_flag.clone(),
        )
        .await
        .map_err(|e| e.to_string())?;

        if cancel_flag.load(Ordering::SeqCst) {
            return Err("Task cancelled".to_string());
        }

        // 2. Convert to wav
        set_in_page_progress(
            &state.queue,
            &job_id,
            30.0,
            "Этап 2 из 4 · подготовка аудио",
        );
        let silences = crate::jobs::fetchr_mute::convert_to_wav_for_profile_with_progress(
            &ffmpeg,
            Path::new(&input_path),
            &wav_path,
            cancel_flag.clone(),
            settings.mute_profile,
            crate::jobs::fetchr_mute::selected_audio_track(&settings),
            Some(crate::jobs::fetchr_mute::progress_reporter(
                &state.queue,
                &job_id,
                30.0,
                34.0,
                "Этап 2 из 4 · подготовка аудио".to_string(),
            )),
        )
        .await
        .map_err(|e| e.to_string())?;
        set_in_page_progress(&state.queue, &job_id, 34.0, "Этап 3 из 4 · поиск речи");

        if cancel_flag.load(Ordering::SeqCst) {
            return Err("Task cancelled".to_string());
        }

        // 3. Transcribe
        let queue = state.queue.clone();
        let model_dir_for_asr = model_dir.clone();
        let wav_path_for_asr = wav_path.clone();
        let cancel_flag_for_asr = cancel_flag.clone();
        let job_id_for_asr = job_id.clone();
        let mode_for_asr = settings.mode;
        let model_for_asr = settings.asr_model;
        let language_for_asr = settings.language;
        // Тот же словарь, что потом строит спаны, но здесь он нужен декодеру:
        // бустинг поднимает мат в гипотезах, а не только ищет его в тексте.
        let hotwords_for_asr = crate::jobs::fetchr_mute::load_profane_words(&settings)
            .map_err(|e| e.to_string())?
            .hotwords();
        let words = tokio::task::spawn_blocking(move || {
            crate::jobs::fetchr_mute::transcribe_wav_blocking(
                &queue,
                &job_id_for_asr,
                &model_dir_for_asr,
                &wav_path_for_asr,
                &silences,
                &hotwords_for_asr,
                cancel_flag_for_asr,
                mode_for_asr,
                language_for_asr,
                model_for_asr,
            )
        })
        .await
        .map_err(|_| "ASR thread panicked".to_string())?
        .map_err(|e| e.to_string())?;
        set_in_page_progress(
            &state.queue,
            &job_id,
            88.0,
            "Этап 3 из 4 · распознавание завершено",
        );

        if cancel_flag.load(Ordering::SeqCst) {
            return Err("Task cancelled".to_string());
        }

        let profane_words =
            crate::jobs::fetchr_mute::load_profane_words(&settings).map_err(|e| e.to_string())?;
        crate::jobs::fetchr_mute::verify_words_blocking(
            &state.queue,
            &job_id,
            &model_dir,
            &ffmpeg,
            Path::new(&input_path),
            &wav_path,
            &tmp_dir,
            words,
            &profane_words,
            &settings,
            cancel_flag.clone(),
        )
        .await
        .map_err(|e| e.to_string())?
    };

    // 4. Build spans
    let profane_words =
        crate::jobs::fetchr_mute::load_profane_words(&settings).map_err(|e| e.to_string())?;
    let spans = crate::jobs::fetchr_mute::build_mute_spans(&words, &profane_words, &settings);
    // «Герметичный» профиль: уточнить границы по энергетике слова (WAV уже
    // есть после ASR; при кэше распознавания хелпер пересоздаст его сам).
    let spans = crate::jobs::fetchr_mute::refine_spans_for_settings(
        &ffmpeg,
        Path::new(&input_path),
        &wav_path,
        spans,
        &words,
        &settings,
        cancel_flag.clone(),
    )
    .await;

    // 5. Render censored media
    let output_path = reserve_output_path(&input_path, output_target.as_ref())?;
    let render_message = format!("Этап 4 из 4 · сохраняю файл · найдено: {}", spans.len());
    set_in_page_progress(&state.queue, &job_id, 90.0, &render_message);
    if let Err(error) = crate::jobs::fetchr_mute::render_censored_media(
        &ffmpeg,
        Path::new(&input_path),
        &output_path,
        &tmp_dir,
        &spans,
        &settings,
        cancel_flag,
        Some(crate::jobs::fetchr_mute::progress_reporter(
            &state.queue,
            &job_id,
            90.0,
            99.0,
            render_message,
        )),
    )
    .await
    {
        let _ = tokio::fs::remove_file(&output_path).await;
        return Err(error.to_string());
    }
    set_in_page_progress(
        &state.queue,
        &job_id,
        100.0,
        "Готово · файл успешно сохранён",
    );

    crate::jobs::fetchr_mute::cleanup_stale_outputs(Path::new(&input_path), &output_path);

    // Save to history file
    let history_item = crate::jobs::fetchr_mute::HistoryItem {
        id: uuid::Uuid::new_v4().to_string(),
        file_name: Path::new(&input_path)
            .file_name()
            .and_then(|f| f.to_str())
            .unwrap_or("")
            .to_string(),
        file_path: input_path.clone(),
        output_path: output_path.to_string_lossy().into_owned(),
        date: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64,
        words: words.clone(),
        spans: spans.clone(),
        manual_spans: Vec::new(),
        excluded_spans: Vec::new(),
        source_fingerprint: Some(source_fingerprint),
        recognition_version: Some(crate::jobs::fetchr_mute::RECOGNITION_CACHE_VERSION),
        settings: settings.clone(),
    };
    if let Err(e) = crate::jobs::fetchr_mute::add_history_item(history_item) {
        tracing::error!("Failed to save mute history: {e}");
    }

    Ok(InPageResult {
        output_path: output_path.to_string_lossy().into_owned(),
        words,
        spans,
    })
}

fn set_in_page_progress(
    queue: &Arc<crate::jobs::queue::QueueManager>,
    job_id: &str,
    percent: f32,
    message: &str,
) {
    queue.set_progress(
        job_id,
        JobProgress {
            percent,
            message: Some(message.to_string()),
            ..JobProgress::default()
        },
    );
}

#[tauri::command]
pub async fn recensor_in_page(
    state: State<'_, AppState>,
    task_id: String,
    input_path: String,
    binaries_dir: Option<String>,
    words: Vec<WordHit>,
    settings: FetchrMuteSettings,
    manual_spans: Option<Vec<MuteSpan>>,
    excluded_spans: Option<Vec<MuteSpan>>,
    output_target: Option<OutputTarget>,
) -> Result<InPageRecensorResult, String> {
    // Recensor — полноценная отменяемая задача: длинный ffmpeg-рендер
    // можно прервать кнопкой «Отмена» на фронте.
    let task_id = uuid::Uuid::parse_str(&task_id)
        .map_err(|_| "Invalid FetchrMute recensor task id".to_string())?
        .to_string();
    let cancel_flag = Arc::new(AtomicBool::new(false));
    state
        .in_page_cancels
        .lock()
        .insert(task_id.clone(), cancel_flag.clone());
    // Префикс `in_page_` направляет прогресс рендера в событие страницы
    // FetchrMute (то же, что у основной обработки).
    let job_id = format!("in_page_{task_id}");
    let _cleanup = CleanupCancel {
        cancels: state.in_page_cancels.clone(),
        task_id,
    };

    let bin_dir = binaries_dir.as_deref().map(Path::new);
    let ffmpeg = crate::binaries::resolve_binary(crate::binaries::FFMPEG, bin_dir)
        .ok_or_else(|| "ffmpeg.exe not found - set binaries folder in Settings".to_string())?;

    let tmp_dir = std::env::temp_dir()
        .join("fetchr-mute-fast")
        .join(uuid::Uuid::new_v4().to_string());
    tokio::fs::create_dir_all(&tmp_dir)
        .await
        .map_err(|e| e.to_string())?;
    let _tmp_guard = crate::jobs::fetchr_mute::TempDirGuard::new(tmp_dir.clone());

    let profane_words =
        crate::jobs::fetchr_mute::load_profane_words(&settings).map_err(|e| e.to_string())?;
    // Точечные правки: места, снятые пользователем в панели «Правки мута»,
    // убираются только из автоматических спанов и до их слияния — ручные
    // спаны и соседние слова слитого спана исключение не трогает.
    let excluded_spans = excluded_spans.unwrap_or_default();
    let mut spans = crate::jobs::fetchr_mute::build_mute_spans_excluding(
        &words,
        &profane_words,
        &settings,
        &excluded_spans,
    );
    // «Герметичный» профиль: уточнить границы по энергетике слова. WAV лежит в
    // кэше по отпечатку источника, поэтому повторный пересчёт (движение
    // ползунка) не декодирует исходник заново.
    let wav_path = crate::jobs::fetchr_mute::source_fingerprint(Path::new(&input_path))
        .map(|fingerprint| {
            let path = crate::jobs::fetchr_mute::prepared_wav_path(
                &fingerprint,
                settings.mute_profile,
                crate::jobs::fetchr_mute::selected_audio_track(&settings),
            );
            if let Some(parent) = path.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            crate::jobs::fetchr_mute::prune_prepared_wav_cache(&path, 2);
            path
        })
        .unwrap_or_else(|_| tmp_dir.join("stt_input_16k_mono.wav"));
    spans = crate::jobs::fetchr_mute::refine_spans_for_settings(
        &ffmpeg,
        Path::new(&input_path),
        &wav_path,
        spans,
        &words,
        &settings,
        cancel_flag.clone(),
    )
    .await;
    tracing::info!(
        "recensor: coverage={}%, smooth={}, spans={} [{}]",
        settings.coverage_percent,
        settings.smooth_mute,
        spans.len(),
        crate::jobs::fetchr_mute::summarize_matched_spans(&spans),
    );
    // Manually added moments (by timecode) are merged in and kept sorted so the
    // user can patch anything the recognizer missed without re-analyzing.
    let manual_spans = manual_spans.unwrap_or_default();
    if !manual_spans.is_empty() {
        // Ручные спаны получают те же пады, что и авто-спаны, иначе границы
        // слова «выскакивают» из мута и звучат резко.
        let (pre_pad, post_pad) = crate::jobs::fetchr_mute::manual_span_padding(&settings);
        spans.extend(
            manual_spans
                .iter()
                .filter(|s| s.end > s.start)
                .cloned()
                .map(|mut s| {
                    s.start = (s.start - pre_pad).max(0.0);
                    s.end = (s.end + post_pad).max(s.start + 0.05);
                    s
                }),
        );
        spans.sort_by(|a, b| {
            a.start
                .partial_cmp(&b.start)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
    }

    let output_path = reserve_output_path(&input_path, output_target.as_ref())?;

    // У пересборки весь этап — рендер, поэтому шкала идёт 0→100 по нему одному.
    let render_message = format!("Этап 4 из 4 · сохраняю файл · найдено: {}", spans.len());
    set_in_page_progress(&state.queue, &job_id, 0.0, &render_message);
    if let Err(error) = crate::jobs::fetchr_mute::render_censored_media(
        &ffmpeg,
        Path::new(&input_path),
        &output_path,
        &tmp_dir,
        &spans,
        &settings,
        cancel_flag,
        Some(crate::jobs::fetchr_mute::progress_reporter(
            &state.queue,
            &job_id,
            0.0,
            100.0,
            render_message,
        )),
    )
    .await
    {
        let _ = tokio::fs::remove_file(&output_path).await;
        return Err(error.to_string());
    }
    set_in_page_progress(&state.queue, &job_id, 100.0, "Готово · файл успешно сохранён");

    crate::jobs::fetchr_mute::cleanup_stale_outputs(Path::new(&input_path), &output_path);

    // Update history item
    if let Err(e) = crate::jobs::fetchr_mute::update_history_item(
        &input_path,
        &output_path.to_string_lossy(),
        spans.clone(),
        manual_spans,
        excluded_spans,
        settings.clone(),
    ) {
        tracing::error!("Failed to update mute history: {e}");
    }

    Ok(InPageRecensorResult {
        output_path: output_path.to_string_lossy().into_owned(),
        spans,
    })
}

/// Список аудиодорожек исходного файла для селектора на странице.
#[tauri::command]
pub async fn probe_mute_audio_tracks(
    input_path: String,
    binaries_dir: Option<String>,
) -> Result<Vec<crate::jobs::fetchr_mute::AudioTrackInfo>, String> {
    let bin_dir = binaries_dir.as_deref().map(Path::new);
    let ffprobe = crate::binaries::resolve_binary(crate::binaries::FFPROBE, bin_dir)
        .ok_or_else(|| "ffprobe.exe not found - set binaries folder in Settings".to_string())?;
    crate::jobs::fetchr_mute::list_audio_tracks(&ffprobe, Path::new(&input_path))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn cancel_mute_in_page(state: State<'_, AppState>, task_id: String) {
    if let Some(flag) = state.in_page_cancels.lock().get(&task_id) {
        flag.store(true, Ordering::SeqCst);
    }
}

#[tauri::command]
pub async fn get_mute_history() -> Result<Vec<crate::jobs::fetchr_mute::HistoryItem>, String> {
    crate::jobs::fetchr_mute::load_history().map_err(|e| e.to_string())
}

/// Транскрипция конкретного элемента истории — грузится лениво из sidecar,
/// чтобы список истории не таскал за собой мегабайты слов.
#[tauri::command]
pub async fn get_mute_history_words(id: String) -> Result<Vec<WordHit>, String> {
    let history = crate::jobs::fetchr_mute::load_history().map_err(|e| e.to_string())?;
    let item = history
        .iter()
        .find(|item| item.id == id)
        .ok_or_else(|| "Элемент истории не найден".to_string())?;
    Ok(crate::jobs::fetchr_mute::load_history_item_words(item))
}

#[tauri::command]
pub async fn delete_mute_history_item(id: String) -> Result<(), String> {
    crate::jobs::fetchr_mute::delete_history_item(&id).map_err(|e| e.to_string())
}

/// Пакетная проверка существования путей (валидация элементов истории).
#[tauri::command]
pub async fn mute_paths_exist(paths: Vec<String>) -> Result<Vec<bool>, String> {
    Ok(paths
        .iter()
        .map(|path| std::path::Path::new(path).is_file())
        .collect())
}

/// Текущая версия кэша распознавания — фронт помечает элементы истории,
/// записанные старой версией анализа.
#[tauri::command]
pub fn mute_recognition_version() -> u32 {
    crate::jobs::fetchr_mute::RECOGNITION_CACHE_VERSION
}

#[derive(serde::Serialize)]
struct SuggestMuteWordsRequest {
    machine_id: String,
    data: String,
}

#[tauri::command]
pub async fn suggest_mute_words(words: Vec<String>, machine_id: String) -> Result<(), String> {
    if words.is_empty() {
        return Ok(());
    }

    let Some(base) = crate::remote::api_base_url() else {
        return Ok(());
    };

    let raw_payload = serde_json::to_string(&words).map_err(|e| e.to_string())?;
    let secret_key = b"SuperSecretSaltForFetchrMute2026";
    let encrypted_data = simple_obfuscate(raw_payload.as_bytes(), secret_key);
    let auth_token = generate_secure_token(&machine_id);

    let client = crate::remote::secure_client(std::time::Duration::from_secs(10))?;
    let _ = client
        .post(format!("{base}/mute/suggestions"))
        .header("X-Fetchr-Token", auth_token)
        .header("Content-Type", "application/json")
        .json(&SuggestMuteWordsRequest {
            machine_id,
            data: hex::encode(encrypted_data),
        })
        .send()
        .await;

    Ok(())
}

fn simple_obfuscate(data: &[u8], key: &[u8]) -> Vec<u8> {
    data.iter()
        .enumerate()
        .map(|(i, &byte)| byte ^ key[i % key.len()] ^ (i as u8))
        .collect()
}

fn generate_secure_token(machine_id: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(machine_id.as_bytes());
    hasher.update(b"vps_secure_salt_2026");
    hex::encode(hasher.finalize())
}

/// Частота, до которой ffmpeg прореживает звук для волны: 2 кГц моно
/// хватает, чтобы увидеть речь и паузы, и это всего ~4 МБ на 16 минут.
const PEAKS_SAMPLE_RATE: u32 = 2000;
/// Отсчётов в одном мелком окне (10 мс), из которых потом собираются бины.
const PEAKS_WINDOW: usize = 20;

/// Настоящая волна звука файла: `bins` значений 0..1 по всей длине.
/// ffmpeg отдаёт звук потоком, по нему считаются пики мелких окон, а в
/// конце они сводятся к нужному числу столбиков. Видео не декодируется.
#[tauri::command]
pub async fn audio_waveform_peaks(
    input_path: String,
    bins: usize,
    binaries_dir: Option<String>,
) -> Result<Vec<f32>, String> {
    use tokio::io::AsyncReadExt;

    let bins = bins.clamp(16, 2000);
    let bin_dir = binaries_dir.as_deref().map(Path::new);
    let ffmpeg = crate::binaries::resolve_binary(crate::binaries::FFMPEG, bin_dir)
        .ok_or_else(|| "ffmpeg.exe not found - set binaries folder in Settings".to_string())?;

    let mut cmd = tokio::process::Command::new(ffmpeg);
    #[cfg(windows)]
    {
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    cmd.args(["-v", "error", "-nostdin", "-i"])
        .arg(&input_path)
        .args(["-vn", "-sn", "-dn", "-ac", "1", "-ar"])
        .arg(PEAKS_SAMPLE_RATE.to_string())
        .args(["-f", "s16le", "-"])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true);

    let mut child = cmd.spawn().map_err(|e| format!("Не удалось запустить ffmpeg: {e}"))?;
    let mut stdout = child
        .stdout
        .take()
        .ok_or_else(|| "ffmpeg не отдал звук".to_string())?;

    let mut windows: Vec<f32> = Vec::new();
    let mut buffer = vec![0u8; 64 * 1024];
    let mut low_byte: Option<u8> = None;
    let mut window_peak: i32 = 0;
    let mut window_len: usize = 0;

    loop {
        let read = stdout.read(&mut buffer).await.map_err(|e| e.to_string())?;
        if read == 0 {
            break;
        }
        // Отсчёт s16le может разрезаться между чтениями: младший байт ждёт старшего.
        for &byte in &buffer[..read] {
            let Some(low) = low_byte.take() else {
                low_byte = Some(byte);
                continue;
            };
            let sample = i16::from_le_bytes([low, byte]) as i32;
            window_peak = window_peak.max(sample.abs());
            window_len += 1;
            if window_len == PEAKS_WINDOW {
                windows.push(window_peak as f32 / i16::MAX as f32);
                window_peak = 0;
                window_len = 0;
            }
        }
    }
    if window_len > 0 {
        windows.push(window_peak as f32 / i16::MAX as f32);
    }
    let _ = child.wait().await;

    if windows.is_empty() {
        return Err("В файле нет звуковой дорожки".to_string());
    }

    // Сводим мелкие окна к бинам: пик внутри бина, чтобы короткие слова не терялись.
    let per_bin = windows.len() as f64 / bins as f64;
    let mut peaks: Vec<f32> = (0..bins)
        .map(|i| {
            let from = (i as f64 * per_bin).floor() as usize;
            let to = (((i + 1) as f64 * per_bin).ceil() as usize).clamp(from + 1, windows.len());
            windows[from.min(windows.len() - 1)..to]
                .iter()
                .copied()
                .fold(0.0_f32, f32::max)
        })
        .collect();

    // Нормализация по громкому месту и мягкая кривая: тихая речь остаётся видна.
    let loudest = peaks.iter().copied().fold(0.0_f32, f32::max).max(1e-4);
    for value in peaks.iter_mut() {
        *value = (*value / loudest).sqrt().clamp(0.0, 1.0);
    }
    Ok(peaks)
}
