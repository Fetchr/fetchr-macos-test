use std::collections::{HashMap, HashSet};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use anyhow::{anyhow, Context, Result};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::Command;

use crate::binaries::{resolve_binary, FFMPEG, FFPROBE};
use crate::jobs::queue::QueueManager;
use crate::jobs::types::{
    FetchrMuteCensorMethod, FetchrMuteCensorshipLevel, FetchrMuteLanguage,
    FetchrMuteProcessingMode, FetchrMuteProfile, FetchrMuteSettings, Job, JobProgress,
};

/// Длительность fade-in/out универсального per-sample фильтра.
const FADE_S: f64 = 0.018;
/// CTC token timestamps are converted to acoustic word intervals by the ONNX
/// runner. A small safety pad is applied only while spans are built.
/// При частичном покрытии 35% незаглушённой части остаётся в начале и 65% —
/// в конце. Короткая голова сохраняет контекст, но fade начинается достаточно рано.
const UNCOVERED_LEAD_SHARE: f64 = 0.35;
const REFERENCE_MAX_MUTE_S: f64 = 0.750;
const REFERENCE_MAX_AUDIBLE_TAIL_S: f64 = 0.075;

/// Сколько звука разрешено оставить слышимым в конце слова, после ядра.
/// У большинства профилей это константа; у «Адаптивного» — доля длительности
/// слова в заданных границах, поэтому величина считается по конкретному слову.
#[derive(Debug, Clone, Copy)]
struct AudibleTail {
    share: f64,
    min: f64,
    max: f64,
}

impl AudibleTail {
    const fn fixed(seconds: f64) -> Self {
        Self {
            share: 0.0,
            min: seconds,
            max: seconds,
        }
    }

    const fn scaled(share: f64, min: f64, max: f64) -> Self {
        Self { share, min, max }
    }

    fn for_word(&self, word_duration: f64) -> f64 {
        if self.share <= 0.0 {
            return self.min;
        }
        (word_duration * self.share).clamp(self.min, self.max)
    }
}
/// Насколько раньше жёсткой границы сегмента искать тихий кадр для стыка.
const ASR_SEGMENT_CUT_SEARCH_S: f64 = 1.5;

const SAMPLE_RATE: u32 = 16_000;
const MIN_SPAN_S: f64 = 0.05;
const MIN_WORD_DURATION_S: f64 = 0.025;
const MAX_WORD_DURATION_S: f64 = 5.0;
/// Мат длиннее не бывает даже растянутым («бля-я-ять»). Такое «слово» —
/// склейка мусора на шуме, и мут на нём — секунды пропавшего звука.
const MAX_PROFANE_WORD_S: f64 = 2.5;
/// v12: единственная модель распознавания (v3 RNN-T). Проверка по `asr_model`
/// больше не различает старые транскрипции — их отсекает только версия кэша.
/// 13: переход на sherpa-onnx с бустингом словаря. Слова и их уверенность
/// приходят из другого декодера, поэтому расшифровки от onnx-asr в кэше
/// пришлось бы применять к новым порогам — они не сопоставимы.
/// 14: нахлёст кусков, Silero VAD, леммы pymorphy, CTC-перепроверка — слова
/// и их поля из старых транскрипций несопоставимы с новыми.
pub const RECOGNITION_CACHE_VERSION: u32 = 14;

/// Совпадение кэша распознавания: файл, модель, режим, ЯЗЫК и версия кэша
/// обязаны совпасть. Без проверки языка смена «Русский → English» молча
/// переиспользовала русскую транскрипцию для английского словаря.
pub fn cached_recognition_matches(
    item: &HistoryItem,
    input_path: &str,
    settings: &FetchrMuteSettings,
    fingerprint: &str,
) -> bool {
    item.file_path == input_path
        && item.settings.mode == settings.mode
        && item.settings.asr_model == settings.asr_model
        && item.settings.language == settings.language
        // «Адаптивный» готовит аудио для ASR другой цепочкой (компрессор),
        // поэтому его транскрипция с остальными профилями не взаимозаменяема.
        && is_adaptive(&item.settings) == is_adaptive(settings)
        && item.settings.audio_track_index.unwrap_or(0) == settings.audio_track_index.unwrap_or(0)
        && item.source_fingerprint.as_deref() == Some(fingerprint)
        && item.recognition_version == Some(RECOGNITION_CACHE_VERSION)
}
static MODEL_PREPARE_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
static ASR_EXECUTION_LOCK: OnceLock<parking_lot::Mutex<()>> = OnceLock::new();
const ENGLISH_PROFANE_WORDS: &[&str] = &[
    "fuck", "fucking", "fucker", "shit", "bitch", "asshole", "bastard", "cunt", "dick", "pussy",
    "slut", "whore",
];

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct WordHit {
    pub raw: String,
    pub normalized: String,
    pub start: f64,
    pub end: f64,
    #[serde(default = "default_word_confidence")]
    pub confidence: f32,
    /// Начальная форма слова из морфословаря (pymorphy3), только для слов,
    /// которые словарь знает. Отсекает корневые совпадения внутри чистых
    /// слов: «психуешь» → «психовать», «гребли» → «гребля».
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lemma: Option<String>,
    /// Итог перепроверки кандидата второй моделью (CTC) по окну вокруг
    /// слова: Some(true) — мат подтверждён, Some(false) — не подтверждён.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub verified: Option<bool>,
}

fn default_word_confidence() -> f32 {
    1.0
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct MuteSpan {
    pub word: String,
    pub start: f64,
    pub end: f64,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct HistoryItem {
    pub id: String,
    #[serde(rename = "fileName")]
    pub file_name: String,
    #[serde(rename = "filePath")]
    pub file_path: String,
    #[serde(rename = "outputPath")]
    pub output_path: String,
    pub date: u64,
    /// Транскрипция живёт в sidecar-файле (mute_history_words/<id>.words.json):
    /// основной JSON истории остаётся маленьким и не переписывает мегабайты
    /// слов на каждый recensor. Inline-значение — для миграции старого формата.
    #[serde(default, skip_serializing)]
    pub words: Vec<WordHit>,
    pub spans: Vec<MuteSpan>,
    #[serde(default, rename = "manualSpans")]
    pub manual_spans: Vec<MuteSpan>,
    #[serde(default, rename = "excludedSpans")]
    pub excluded_spans: Vec<MuteSpan>,
    #[serde(default, rename = "sourceFingerprint")]
    pub source_fingerprint: Option<String>,
    #[serde(default, rename = "recognitionVersion")]
    pub recognition_version: Option<u32>,
    pub settings: FetchrMuteSettings,
}

pub struct TempDirGuard {
    path: PathBuf,
}

impl TempDirGuard {
    pub fn new(path: PathBuf) -> Self {
        Self { path }
    }
}

impl Drop for TempDirGuard {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.path);
    }
}

fn history_lock() -> &'static parking_lot::Mutex<()> {
    static LOCK: OnceLock<parking_lot::Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| parking_lot::Mutex::new(()))
}

/// Cheap but content-aware cache key: metadata plus the first/last 64 KiB.
/// This avoids reusing timestamps after a file at the same path was replaced,
/// without hashing multi-gigabyte recordings in full.
pub fn source_fingerprint(path: &Path) -> Result<String> {
    use sha2::{Digest, Sha256};

    const SAMPLE: usize = 64 * 1024;
    let metadata =
        std::fs::metadata(path).with_context(|| format!("read source metadata {:?}", path))?;
    let mut file = std::fs::File::open(path)
        .with_context(|| format!("open source for fingerprint {:?}", path))?;
    let modified_ms = metadata
        .modified()
        .ok()
        .and_then(|value| value.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|value| value.as_millis() as u64)
        .unwrap_or_default();

    let mut hasher = Sha256::new();
    hasher.update(metadata.len().to_le_bytes());
    hasher.update(modified_ms.to_le_bytes());

    let mut buffer = vec![0u8; SAMPLE.min(metadata.len() as usize)];
    if !buffer.is_empty() {
        file.read_exact(&mut buffer)?;
        hasher.update(&buffer);
    }
    if metadata.len() > SAMPLE as u64 {
        file.seek(SeekFrom::End(-(SAMPLE as i64)))?;
        let mut tail = vec![0u8; SAMPLE];
        file.read_exact(&mut tail)?;
        hasher.update(&tail);
    }

    Ok(hex::encode(hasher.finalize()))
}

pub fn get_history_file_path() -> PathBuf {
    if let Ok(local_appdata) = std::env::var("LOCALAPPDATA") {
        PathBuf::from(local_appdata)
            .join("Fetchr")
            .join("mute_history.json")
    } else {
        std::env::temp_dir().join("fetchr-mute-history.json")
    }
}

fn words_sidecar_dir() -> PathBuf {
    get_history_file_path()
        .parent()
        .map(|parent| parent.join("mute_history_words"))
        .unwrap_or_else(|| std::env::temp_dir().join("fetchr-mute-history-words"))
}

fn words_sidecar_path(id: &str) -> PathBuf {
    // id — UUID, поэтому безопасен как имя файла.
    words_sidecar_dir().join(format!("{id}.words.json"))
}

fn write_words_sidecar(item: &HistoryItem) -> Result<()> {
    let dir = words_sidecar_dir();
    std::fs::create_dir_all(&dir)?;
    let content = serde_json::to_string(&item.words)?;
    std::fs::write(words_sidecar_path(&item.id), content)?;
    Ok(())
}

/// Транскрипция элемента истории: inline (старое хранилище до миграции)
/// или sidecar-файл (новый формат).
pub fn load_history_item_words(item: &HistoryItem) -> Vec<WordHit> {
    if !item.words.is_empty() {
        return item.words.clone();
    }
    std::fs::read_to_string(words_sidecar_path(&item.id))
        .ok()
        .and_then(|content| serde_json::from_str(&content).ok())
        .unwrap_or_default()
}

fn load_history_unlocked() -> Result<Vec<HistoryItem>> {
    let path = get_history_file_path();
    let backup_path = path.with_extension("json.bak");
    let read_path = if path.exists() {
        path
    } else if backup_path.exists() {
        backup_path
    } else {
        return Ok(Vec::new());
    };
    let content = std::fs::read_to_string(&read_path)?;
    serde_json::from_str(&content)
        .with_context(|| format!("parse FetchrMute history {:?}", read_path))
}

fn save_history_unlocked(history: &[HistoryItem]) -> Result<()> {
    // Миграция старого формата: inline-слова выносим в sidecar — дальше они
    // не сериализуются в основной JSON (skip_serializing на поле words).
    for item in history {
        if !item.words.is_empty() {
            let _ = write_words_sidecar(item);
        }
    }
    let path = get_history_file_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let content = serde_json::to_string_pretty(history)?;
    let tmp_path = path.with_extension("json.tmp");
    let backup_path = path.with_extension("json.bak");
    std::fs::write(&tmp_path, content)?;
    if path.exists() {
        let _ = std::fs::remove_file(&backup_path);
        std::fs::rename(&path, &backup_path)?;
    }
    if let Err(error) = std::fs::rename(&tmp_path, &path) {
        if backup_path.exists() {
            let _ = std::fs::rename(&backup_path, &path);
        }
        return Err(error).context("replace FetchrMute history");
    }
    let _ = std::fs::remove_file(backup_path);
    Ok(())
}

/// Сохранённая транскрипция того же файла с теми же параметрами распознавания.
/// Общая точка для страницы и для очереди: расходиться этим двум путям нельзя,
/// иначе один из них молча платит полный ASR второй раз.
pub fn cached_recognition(
    input_path: &str,
    settings: &FetchrMuteSettings,
    fingerprint: &str,
) -> Option<Vec<WordHit>> {
    load_history()
        .ok()?
        .into_iter()
        .find(|item| cached_recognition_matches(item, input_path, settings, fingerprint))
        .map(|item| load_history_item_words(&item))
        .filter(|words| !words.is_empty())
}

pub fn load_history() -> Result<Vec<HistoryItem>> {
    let _guard = history_lock().lock();
    load_history_unlocked()
}

pub fn save_history(history: &[HistoryItem]) -> Result<()> {
    let _guard = history_lock().lock();
    save_history_unlocked(history)
}

pub fn add_history_item(item: HistoryItem) -> Result<()> {
    let _guard = history_lock().lock();
    let mut history = load_history_unlocked()?;
    if !item.words.is_empty() {
        if let Err(e) = write_words_sidecar(&item) {
            tracing::error!("Failed to save mute history words sidecar: {e}");
        }
    }
    history.retain(|x| {
        let keep = x.file_path != item.file_path;
        if !keep {
            let _ = std::fs::remove_file(words_sidecar_path(&x.id));
        }
        keep
    });
    history.insert(0, item);
    if history.len() > 15 {
        for dropped in &history[15..] {
            let _ = std::fs::remove_file(words_sidecar_path(&dropped.id));
        }
        history.truncate(15);
    }
    save_history_unlocked(&history)?;
    Ok(())
}

pub fn delete_history_item(id: &str) -> Result<()> {
    let _guard = history_lock().lock();
    let mut history = load_history_unlocked()?;
    history.retain(|x| x.id != id);
    let _ = std::fs::remove_file(words_sidecar_path(id));
    save_history_unlocked(&history)?;
    Ok(())
}

pub fn update_history_item(
    file_path: &str,
    output_path: &str,
    spans: Vec<MuteSpan>,
    manual_spans: Vec<MuteSpan>,
    excluded_spans: Vec<MuteSpan>,
    settings: FetchrMuteSettings,
) -> Result<()> {
    let _guard = history_lock().lock();
    let mut history = load_history_unlocked()?;
    for item in history.iter_mut() {
        if item.file_path == file_path {
            item.output_path = output_path.to_string();
            item.spans = spans.clone();
            item.manual_spans = manual_spans.clone();
            item.excluded_spans = excluded_spans.clone();
            item.settings = recensor_history_settings(&item.settings, &settings);
        }
    }
    save_history_unlocked(&history)?;
    Ok(())
}

/// Настройки элемента истории после recensor. Recensor не запускает ASR,
/// поэтому всё, что входит в ключ кэша распознавания
/// (`cached_recognition_matches`: режим, модель, язык, дорожка, семейство
/// профиля «Адаптивный»/остальные), остаётся от исходного анализа. Иначе
/// следующий запуск с этими параметрами молча брал бы транскрипцию,
/// распознанную с другими. Настройки цензуры берутся из recensor.
fn recensor_history_settings(
    original: &FetchrMuteSettings,
    recensor: &FetchrMuteSettings,
) -> FetchrMuteSettings {
    let mute_profile = if is_adaptive(original) == is_adaptive(recensor) {
        recensor.mute_profile
    } else {
        original.mute_profile
    };
    FetchrMuteSettings {
        mode: original.mode,
        asr_model: original.asr_model,
        language: original.language,
        audio_track_index: original.audio_track_index,
        mute_profile,
        ..recensor.clone()
    }
}

pub async fn run_on_local_file(
    queue: &Arc<QueueManager>,
    job: &Job,
    input_path: &Path,
    cancel: Arc<AtomicBool>,
) -> Result<PathBuf> {
    if cancel.load(Ordering::SeqCst) {
        return Err(anyhow!("FetchrMute task cancelled"));
    }

    let ffmpeg = resolve_ffmpeg(job)?;
    let mut settings = job.spec.fetchr_mute_settings.clone();
    settings.asr_model = crate::jobs::asr_models::model_for_mode(settings.mode);
    let is_precise = matches!(settings.mode, FetchrMuteProcessingMode::Precise);
    let asr_model = settings.asr_model;
    let model_dir = crate::jobs::asr_models::model_root(asr_model);
    let tmp_dir = std::env::temp_dir()
        .join("fetchr-mute")
        .join(safe_path_part(&job.id));
    let wav_path = tmp_dir.join("stt_input_16k_mono.wav");

    tokio::fs::create_dir_all(&tmp_dir)
        .await
        .with_context(|| format!("create FetchrMute temp dir {:?}", tmp_dir))?;
    let _tmp_guard = TempDirGuard::new(tmp_dir.clone());

    let backend_msg = format!(
        "FetchrMute {} selected: {:?} phrase alignment.",
        crate::jobs::asr_models::model_label(asr_model),
        settings.mode
    );
    emit(queue, &job.id, &backend_msg);

    // Кэш распознавания: тот же файл с теми же параметрами ASR не разбирается
    // заново. Страница это делала давно, очередь — нет, и повторный прогон
    // (в том числе авто-мут после скачивания) платил полный ASR второй раз.
    let source_fingerprint_value = source_fingerprint(input_path).ok();
    let mut cached_words = source_fingerprint_value.as_deref().and_then(|fingerprint| {
        cached_recognition(&input_path.to_string_lossy(), &settings, fingerprint)
    });

    if cached_words.is_none() {
        ensure_model(
            queue,
            &job.id,
            &model_dir,
            asr_model,
            is_precise,
            cancel.clone(),
        )
        .await?;
    }

    let profane_words = load_profane_words(&settings)?;
    emit(
        queue,
        &job.id,
        &format!(
            "FetchrMute wordlist loaded: {} entries; language={:?}, mode={:?}, level={:?}, method={:?}.",
            profane_words.len(),
            settings.language,
            settings.mode,
            settings.censorship_level,
            settings.censor_method
        ),
    );

    let mut asr_elapsed = Duration::ZERO;
    let words = match cached_words.take() {
        Some(words) => {
            emit(
                queue,
                &job.id,
                &format!(
                    "FetchrMute reused a cached transcript: {} word tokens, ASR skipped.",
                    words.len()
                ),
            );
            set_progress(queue, &job.id, 88.0, "Распознавание загружено из кэша");
            // Другие настройки цензуры дают новых кандидатов, которых прошлый
            // прогон не перепроверял. Нужен подготовленный WAV — готовим его.
            if !crate::jobs::fetchr_mute_verify::candidate_indices(&words, &profane_words, &settings)
                .is_empty()
                && crate::jobs::asr_models::ctc_model_ready()
                && convert_to_wav_for_profile(
                    &ffmpeg,
                    input_path,
                    &wav_path,
                    cancel.clone(),
                    settings.mute_profile,
                    selected_audio_track(&settings),
                )
                .await
                .is_ok()
            {
                verify_words_blocking(
                    queue,
                    &job.id,
                    &model_dir,
                    &ffmpeg,
                    input_path,
                    &wav_path,
                    &tmp_dir,
                    words,
                    &profane_words,
                    &settings,
                    cancel.clone(),
                )
                .await?
            } else {
                words
            }
        }
        None => {
            set_progress(queue, &job.id, 31.0, "Подготовка аудио...");
            let convert_started = Instant::now();
            let silences = convert_to_wav_for_profile_with_progress(
                &ffmpeg,
                input_path,
                &wav_path,
                cancel.clone(),
                settings.mute_profile,
                selected_audio_track(&settings),
                Some(progress_reporter(
                    queue,
                    &job.id,
                    31.0,
                    34.0,
                    "Подготовка аудио...".to_string(),
                )),
            )
            .await?;
            emit(
                queue,
                &job.id,
                &format!(
                    "FetchrMute audio prepared in {}.",
                    format_duration(convert_started.elapsed())
                ),
            );

            let started = Instant::now();
            let queue_for_asr = Arc::clone(queue);
            let job_id = job.id.clone();
            let model_dir_for_asr = model_dir.clone();
            let wav_path_for_asr = wav_path.clone();
            let cancel_for_asr = cancel.clone();
            let mode_for_asr = settings.mode;
            let model_for_asr = settings.asr_model;
            let language_for_asr = settings.language;
            let hotwords_for_asr = profane_words.hotwords();
            let words = tokio::task::spawn_blocking(move || {
                transcribe_wav_blocking(
                    &queue_for_asr,
                    &job_id,
                    &model_dir_for_asr,
                    &wav_path_for_asr,
                    &silences,
                    &hotwords_for_asr,
                    cancel_for_asr,
                    mode_for_asr,
                    language_for_asr,
                    model_for_asr,
                )
            })
            .await
            .context("ASR worker panicked")??;

            asr_elapsed = started.elapsed();
            emit(
                queue,
                &job.id,
                &format!(
                    "{} recognized {} word tokens in {}.",
                    crate::jobs::asr_models::model_label(asr_model),
                    words.len(),
                    format_duration(asr_elapsed)
                ),
            );
            verify_words_blocking(
                queue,
                &job.id,
                &model_dir,
                &ffmpeg,
                input_path,
                &wav_path,
                &tmp_dir,
                words,
                &profane_words,
                &settings,
                cancel.clone(),
            )
            .await?
        }
    };

    let spans = build_mute_spans(&words, &profane_words, &settings);
    // «Герметичный» профиль: уточняем границы спанов по энергетике слова,
    // пока исходный WAV ещё существует (recensor пользуется тем же хелпером).
    let refine_started = Instant::now();
    let spans = refine_spans_for_settings(
        &ffmpeg,
        input_path,
        &wav_path,
        spans,
        &words,
        &settings,
        cancel.clone(),
    )
    .await;
    if !spans.is_empty() {
        emit(
            queue,
            &job.id,
            &format!(
                "FetchrMute matched {} censor spans in {}: {}",
                spans.len(),
                format_duration(refine_started.elapsed()),
                summarize_matched_spans(&spans)
            ),
        );
    }
    cleanup_empty_reserved_outputs(input_path);
    let output_path =
        queue_output_path(input_path, job.spec.fetchr_mute_output_dir.as_deref())?;
    let render_message = format!("Сохранение файла: {} матов удалено.", spans.len());
    set_progress(queue, &job.id, 90.0, &render_message);
    let render_started = Instant::now();
    let render_result = render_censored_media(
        &ffmpeg,
        input_path,
        &output_path,
        &tmp_dir,
        &spans,
        &settings,
        cancel,
        Some(progress_reporter(queue, &job.id, 90.0, 99.0, render_message)),
    )
    .await;
    if let Err(error) = render_result {
        let _ = tokio::fs::remove_file(&output_path).await;
        return Err(error);
    }
    let render_elapsed = render_started.elapsed();
    emit(
        queue,
        &job.id,
        &format!(
            "FetchrMute render finished in {}.",
            format_duration(render_elapsed)
        ),
    );
    // Одна строка с фактическими цифрами: без неё «стало медленнее» остаётся
    // спором на глаз, а дисперсия этой машины доходит до 4.5×.
    let source_seconds = media_duration_seconds(&ffmpeg, input_path).await;
    emit(
        queue,
        &job.id,
        &format!(
            "FetchrMute summary: source={:.1}s asr={:.1}s asr_rtf={:.4} spans={} render={:.1}s render_rtf={:.4}",
            source_seconds,
            asr_elapsed.as_secs_f64(),
            asr_elapsed.as_secs_f64() / source_seconds.max(1.0),
            spans.len(),
            render_elapsed.as_secs_f64(),
            render_elapsed.as_secs_f64() / source_seconds.max(1.0),
        ),
    );
    cleanup_stale_outputs(input_path, &output_path);
    set_progress(queue, &job.id, 100.0, "Обработка успешно завершена.");

    // Save to history file
    let history_item = HistoryItem {
        id: uuid::Uuid::new_v4().to_string(),
        file_name: input_path
            .file_name()
            .and_then(|f| f.to_str())
            .unwrap_or("")
            .to_string(),
        file_path: input_path.to_string_lossy().into_owned(),
        output_path: output_path.to_string_lossy().into_owned(),
        date: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64,
        words: words.clone(),
        spans: spans.clone(),
        manual_spans: Vec::new(),
        excluded_spans: Vec::new(),
        source_fingerprint: source_fingerprint_value,
        recognition_version: Some(RECOGNITION_CACHE_VERSION),
        settings: settings.clone(),
    };
    if let Err(e) = add_history_item(history_item) {
        tracing::error!("Failed to save mute history: {e}");
    }

    Ok(output_path)
}

/// CTC-перепроверка сомнительных кандидатов после распознавания. Ошибка
/// перепроверки не роняет задачу: слова остаются как есть, и решает порог.
#[allow(clippy::too_many_arguments)]
pub async fn verify_words_blocking(
    queue: &Arc<QueueManager>,
    job_id: &str,
    model_root: &Path,
    ffmpeg: &Path,
    input_path: &Path,
    wav_path: &Path,
    work_dir: &Path,
    words: Vec<WordHit>,
    profane_words: &ProfaneDictionary,
    settings: &FetchrMuteSettings,
    cancel: Arc<AtomicBool>,
) -> Result<Vec<WordHit>> {
    let queue_for_verify = Arc::clone(queue);
    let job_id_owned = job_id.to_string();
    let model_root = model_root.to_path_buf();
    let ffmpeg = ffmpeg.to_path_buf();
    let input_path = input_path.to_path_buf();
    let wav_path = wav_path.to_path_buf();
    let work_dir = work_dir.to_path_buf();
    let profane_words = profane_words.clone();
    let settings = settings.clone();
    let cancel_for_verify = cancel.clone();
    let original = words.clone();
    let outcome = tokio::task::spawn_blocking(move || {
        let mut words = words;
        let context = crate::jobs::fetchr_mute_verify::VerifyContext {
            queue: &queue_for_verify,
            job_id: &job_id_owned,
            model_root: &model_root,
            model: settings.asr_model,
            ffmpeg: &ffmpeg,
            input_path: &input_path,
            wav_path: &wav_path,
            work_dir: &work_dir,
            track: selected_audio_track(&settings),
            cancel: cancel_for_verify,
        };
        let stats = crate::jobs::fetchr_mute_verify::verify_uncertain_words(
            &context,
            &mut words,
            &profane_words,
            &settings,
        );
        (words, stats)
    })
    .await
    .unwrap_or_else(|join_error| {
        (
            Vec::new(),
            Err(anyhow!("CTC verify worker panicked: {join_error}")),
        )
    });
    match outcome {
        (words, Ok(stats)) => {
            emit(queue, job_id, &stats.summary());
            Ok(words)
        }
        (_, Err(_)) if cancel.load(Ordering::SeqCst) => Err(anyhow!("FetchrMute task cancelled")),
        (_, Err(error)) => {
            emit(
                queue,
                job_id,
                &format!("FetchrMute CTC verify skipped: {error:#}"),
            );
            Ok(original)
        }
    }
}

fn resolve_ffmpeg(job: &Job) -> Result<PathBuf> {
    let bin_dir = job.spec.binaries_dir.as_deref().map(Path::new);
    resolve_binary(FFMPEG, bin_dir)
        .ok_or_else(|| anyhow!("ffmpeg.exe not found - set binaries folder in Settings"))
}

pub async fn ensure_model(
    queue: &Arc<QueueManager>,
    job_id: &str,
    model_dir: &Path,
    model: crate::jobs::types::FetchrMuteAsrModel,
    _is_precise: bool,
    cancel: Arc<AtomicBool>,
) -> Result<()> {
    // Page and queue jobs may start together on first launch. They must not
    // remove or overwrite each other's shared `.part` files.
    let _model_guard = MODEL_PREPARE_LOCK.lock().await;
    tokio::fs::create_dir_all(model_dir)
        .await
        .with_context(|| format!("create model dir {:?}", model_dir))?;

    crate::jobs::asr_models::prepare(queue, job_id, model_dir, model, cancel.clone()).await?;

    if cancel.load(Ordering::SeqCst) {
        return Err(anyhow!("FetchrMute task cancelled"));
    }
    // Silero VAD скачивает `asr_models::ensure_vad_model` — в runtime-каталог,
    // откуда его читает ASR-сервер. Раньше здесь качалась вторая копия в каталог
    // модели, которую никто никогда не открывал.

    set_progress(
        queue,
        job_id,
        30.0,
        "Модель распознавания и VAD подготовлены",
    );
    Ok(())
}

#[derive(Clone, Copy)]
struct SpeechSegment {
    start_sample: usize,
    end_sample: usize,
    /// Зона ответственности куска (см. `AsrSegment::keep_start_sample`).
    keep_start_sample: usize,
    keep_end_sample: usize,
}

impl SpeechSegment {
    fn whole(start_sample: usize, end_sample: usize) -> Self {
        Self {
            start_sample,
            end_sample,
            keep_start_sample: start_sample,
            keep_end_sample: end_sample,
        }
    }
}

/// Нахлёст соседних кусков длинной речи. Слово на стыке целиком попадает хотя
/// бы в один кусок, а дубли снимает зона ответственности.
const ASR_SEGMENT_OVERLAP_S: f64 = 0.75;

const SPEECH_FRAME_SIZE: usize = 512;

/// Источник энергии для предотбора речи.
///
/// Когда карта тишины есть, границы сегментов задаёт она, а уровни нужны только
/// в узких окнах поиска точки разреза. Держать ради этого весь файл в памяти
/// незачем: три часа 16 кГц mono — это 690 МБ `f32`.
pub(crate) enum SpeechLevels<'a> {
    Full(&'a [f32]),
    Windowed {
        path: &'a Path,
        total_samples: usize,
    },
}

impl SpeechLevels<'_> {
    fn total_samples(&self) -> usize {
        match self {
            Self::Full(samples) => samples.len(),
            Self::Windowed { total_samples, .. } => *total_samples,
        }
    }

    fn frame_rms(frame: &[f32]) -> f32 {
        if frame.is_empty() {
            return 0.0;
        }
        (frame.iter().map(|sample| sample * sample).sum::<f32>() / frame.len() as f32).sqrt()
    }

    /// Уровни по всему файлу. Нужны только энергетическому пути.
    fn all(&self) -> Result<Vec<f32>> {
        match self {
            Self::Full(samples) => Ok(samples
                .chunks_exact(SPEECH_FRAME_SIZE)
                .map(Self::frame_rms)
                .collect()),
            Self::Windowed { path, .. } => {
                let samples = read_wav_samples(path)?;
                Ok(samples
                    .chunks_exact(SPEECH_FRAME_SIZE)
                    .map(Self::frame_rms)
                    .collect())
            }
        }
    }

    /// Уровни кадров в диапазоне сэмплов `[from, to)`. Индекс результата — от
    /// `from / SPEECH_FRAME_SIZE`.
    fn window(&self, from: usize, to: usize) -> Vec<f32> {
        let from = from.min(self.total_samples());
        let to = to.min(self.total_samples());
        if to <= from {
            return Vec::new();
        }
        match self {
            Self::Full(samples) => samples[from..to]
                .chunks_exact(SPEECH_FRAME_SIZE)
                .map(Self::frame_rms)
                .collect(),
            Self::Windowed { path, .. } => read_wav_window(path, from, to)
                .map(|samples| {
                    samples
                        .chunks_exact(SPEECH_FRAME_SIZE)
                        .map(Self::frame_rms)
                        .collect()
                })
                .unwrap_or_default(),
        }
    }
}

/// Число сэмплов подготовленного WAV без чтения самих сэмплов.
pub(crate) fn wav_sample_count(wav_path: &Path) -> Result<usize> {
    let reader = hound::WavReader::open(wav_path)
        .with_context(|| format!("open prepared wav {:?}", wav_path))?;
    Ok(reader.duration() as usize)
}

/// Кусок подготовленного WAV без материализации всего файла.
fn read_wav_window(wav_path: &Path, from: usize, to: usize) -> Result<Vec<f32>> {
    let mut reader = hound::WavReader::open(wav_path)
        .with_context(|| format!("open prepared wav {:?}", wav_path))?;
    reader.seek(from as u32).context("seek prepared wav")?;
    let count = to.saturating_sub(from);
    let spec = reader.spec();
    match spec.sample_format {
        hound::SampleFormat::Float => reader
            .samples::<f32>()
            .take(count)
            .collect::<std::result::Result<Vec<_>, _>>()
            .context("read float wav window"),
        hound::SampleFormat::Int if spec.bits_per_sample <= 16 => reader
            .samples::<i16>()
            .take(count)
            .map(|sample| sample.map(|value| value as f32 / i16::MAX as f32))
            .collect::<std::result::Result<Vec<_>, _>>()
            .context("read int16 wav window"),
        hound::SampleFormat::Int => {
            let denom = ((1i64 << (spec.bits_per_sample.saturating_sub(1) as u32)) - 1) as f32;
            reader
                .samples::<i32>()
                .take(count)
                .map(|sample| sample.map(|value| value as f32 / denom.max(1.0)))
                .collect::<std::result::Result<Vec<_>, _>>()
                .context("read int32 wav window")
        }
    }
}

fn detect_speech_segments(
    audio: SpeechLevels<'_>,
    silences: &[(f64, f64)],
    queue: &Arc<QueueManager>,
    job_id: &str,
    cancel: Arc<AtomicBool>,
    mode: FetchrMuteProcessingMode,
) -> Result<Vec<SpeechSegment>> {
    const FRAME_SIZE: usize = SPEECH_FRAME_SIZE;
    let total_samples = audio.total_samples();
    let num_frames = total_samples / FRAME_SIZE;
    if num_frames == 0 {
        return Ok(Vec::new());
    }

    // Energy-based speech preselection is deterministic and completes in
    // linear time. The previous per-frame ONNX VAD could deadlock when several
    // files were started quickly, leaving every task at "speech recognition".
    // При наличии карты тишины полный проход по уровням не нужен вовсе.
    let levels = if silences.is_empty() {
        audio.all()?
    } else {
        Vec::new()
    };
    let mut threshold = 0.0f32;
    if silences.is_empty() {
        let mut sorted_levels = levels.clone();
        sorted_levels.sort_by(|left, right| left.total_cmp(right));
        let percentile =
            |percent: usize| sorted_levels[sorted_levels.len().saturating_sub(1) * percent / 100];
        // False positives are intentional: extra ambience only costs ASR time,
        // while a false negative could expose a quiet profane word.
        threshold = (percentile(20) * 1.8)
            .max(percentile(80) * 0.04)
            .max(0.0003);
        // Звук без пауз (громкая музыка/игра, выровненная dynaudnorm): уровни
        // кадров лежат в узком коридоре, и p20×1.8 оказывается выше p80 — речью
        // считается горстка случайных кадров, остальное режется. Порог без
        // динамики ничего не различает, поэтому отдаём всё в ASR: лишнее
        // отсекает Silero VAD на стороне сервера.
        if percentile(20) > 0.0003 && percentile(80) <= percentile(20) * 1.8 {
            threshold = 0.0;
        }
    }
    let negative_threshold = threshold * 0.65;
    // More leading than trailing context preserves quiet initial consonants
    // (the observed failures were «блять» -> «ля» at speech onsets). Хвост
    // 6 кадров (~190 мс) вместо 3: тихие конечные согласные («-ть») у порога
    // тишины обрезались.
    let (min_silence_frames, pre_pad_frames, post_pad_frames, max_duration) = match mode {
        FetchrMuteProcessingMode::Normal => (6, 8, 6, (12.0 * SAMPLE_RATE as f32) as usize),
        FetchrMuteProcessingMode::Precise => (4, 8, 6, (6.0 * SAMPLE_RATE as f32) as usize),
    };
    let min_speech_frames = 3;
    let progress_stride = (num_frames / 100).max(1);

    // Карта тишины снята с ненормализованного сигнала и заведомо точнее
    // энергетического порога, посчитанного уже после dynaudnorm. Если ffmpeg её
    // не отдал (старая сборка, разбор не удался) — работает прежний путь.
    let silent_frames: Option<Vec<bool>> = (!silences.is_empty()).then(|| {
        let mut flags = vec![false; num_frames];
        let frame_of = |seconds: f64| {
            ((seconds.max(0.0) * SAMPLE_RATE as f64) as usize / FRAME_SIZE).min(num_frames)
        };
        for (start, end) in silences {
            let from = frame_of(*start);
            let to = frame_of(*end).max(from);
            flags[from..to].fill(true);
        }
        flags
    });
    let is_speech = |index: usize, level: f32| match &silent_frames {
        Some(flags) => !flags[index],
        None => level >= threshold,
    };
    let is_silence = |index: usize, level: f32| match &silent_frames {
        Some(flags) => flags[index],
        None => level < negative_threshold,
    };

    let mut raw_segments = Vec::new();
    let mut speech_start = None;
    let mut silence_run = 0usize;

    // При карте тишины сами уровни не нужны — решение принимается по флагам.
    let frame_levels: Box<dyn Iterator<Item = f32>> = if levels.is_empty() {
        Box::new(std::iter::repeat(0.0f32).take(num_frames))
    } else {
        Box::new(levels.iter().copied())
    };

    for (index, level) in frame_levels.enumerate() {
        if cancel.load(Ordering::SeqCst) {
            return Err(anyhow!("Fetchr Mute task cancelled"));
        }
        if index % progress_stride == 0 {
            set_progress(
                queue,
                job_id,
                (34.0 + index as f32 / num_frames as f32).min(35.0),
                &format!(
                    "Этап 3 из 4 · поиск речи: {}%",
                    (100 * index / num_frames).min(99)
                ),
            );
        }

        if speech_start.is_none() {
            if is_speech(index, level) {
                speech_start = Some(index);
                silence_run = 0;
            }
        } else if is_silence(index, level) {
            silence_run += 1;
            if silence_run >= min_silence_frames {
                let start_frame = speech_start.take().unwrap_or(index);
                let end_frame = index - silence_run + 1;
                if end_frame.saturating_sub(start_frame) >= min_speech_frames {
                    raw_segments.push(SpeechSegment::whole(
                        start_frame.saturating_sub(pre_pad_frames) * FRAME_SIZE,
                        (end_frame + post_pad_frames).min(num_frames) * FRAME_SIZE,
                    ));
                }
                silence_run = 0;
            }
        } else {
            silence_run = 0;
        }
    }
    if let Some(start_frame) = speech_start {
        if num_frames.saturating_sub(start_frame) >= min_speech_frames {
            raw_segments.push(SpeechSegment::whole(
                start_frame.saturating_sub(pre_pad_frames) * FRAME_SIZE,
                num_frames * FRAME_SIZE,
            ));
        }
    }

    let max_gap = (1.5 * SAMPLE_RATE as f32) as usize;
    let mut merged: Vec<SpeechSegment> = Vec::new();
    for next in raw_segments {
        if let Some(current) = merged.last_mut() {
            let gap = next.start_sample.saturating_sub(current.end_sample);
            let duration = next.end_sample.saturating_sub(current.start_sample);
            if gap <= max_gap && duration <= max_duration {
                current.end_sample = current.end_sample.max(next.end_sample);
                current.keep_end_sample = current.end_sample;
                continue;
            }
        }
        merged.push(next);
    }
    if merged.is_empty() && total_samples > 0 {
        merged.push(SpeechSegment::whole(0, total_samples));
    }

    // Непрерывная речь длиннее max_duration режется на куски. Стык ставится в
    // самый тихий кадр перед жёсткой границей, но в слитной речи без пауз он
    // всё равно попадал в середину слова: «бля-» уходило в один кусок, «-ть» в
    // другой, и мат терялся. Поэтому куски идут с нахлёстом ASR_SEGMENT_OVERLAP_S
    // в обе стороны от стыка, а каждое слово берётся из того куска, в чьей зоне
    // ответственности (до стыка или после) лежит его середина.
    let cut_search = (ASR_SEGMENT_CUT_SEARCH_S * SAMPLE_RATE as f64) as usize;
    let overlap = (ASR_SEGMENT_OVERLAP_S * SAMPLE_RATE as f64) as usize;
    let mut final_segments = Vec::new();
    for segment in merged {
        let mut keep_start = segment.start_sample;
        while keep_start < segment.end_sample {
            let hard_end = (keep_start + max_duration).min(segment.end_sample);
            let cut = if hard_end >= segment.end_sample {
                segment.end_sample
            } else {
                let window_start = hard_end.saturating_sub(cut_search);
                let window = audio.window(window_start, hard_end);
                quietest_cut(&window, FRAME_SIZE, window_start, hard_end)
                    .max(keep_start + FRAME_SIZE)
                    .min(segment.end_sample)
            };
            final_segments.push(SpeechSegment {
                start_sample: keep_start
                    .saturating_sub(overlap)
                    .max(segment.start_sample),
                end_sample: (cut + overlap).min(segment.end_sample),
                keep_start_sample: keep_start,
                keep_end_sample: cut,
            });
            if cut >= segment.end_sample {
                break;
            }
            keep_start = cut;
        }
    }
    Ok(final_segments)
}

/// Граница сэмплов внутри `[from, to]`, попадающая на самый тихий кадр.
/// `levels` — уровни кадров именно этого окна, начиная с сэмпла `from`.
/// Возвращает `to`, если окно пустое.
fn quietest_cut(levels: &[f32], frame_size: usize, from: usize, to: usize) -> usize {
    if levels.is_empty() || to <= from {
        return to;
    }
    let quietest = levels
        .iter()
        .enumerate()
        .min_by(|left, right| left.1.total_cmp(right.1))
        .map(|(index, _)| index)
        .unwrap_or(0);
    (from + quietest * frame_size).min(to)
}

/// Общее начало цепочки: приведение формата и срез инфранизких частот. Дальше
/// идёт `silencedetect`, и только потом — нормализация уровня.
/// `asetpts` отсчитывает время от первого сэмпла дорожки — от него же идут
/// сэмплы WAV и время слов. Сейчас ffmpeg сам сдвигает старт к единственному
/// замапленному потоку, и сброс ничего не меняет (WAV побайтно тот же), но
/// карта тишины не должна зависеть от этой эвристики демультиплексора.
const ASR_FILTER_HEAD: &str =
    "asetpts=PTS-STARTPTS,aformat=sample_fmts=fltp:sample_rates=16000:channel_layouts=mono,highpass=f=70";

/// Карта тишины снимается ДО нормализации. `dynaudnorm` поднимает паузы и шум
/// к уровню речи (m=16 — усиление до 16×), после него энергетический предотбор
/// речи перестаёт отличать речь от фона и отдаёт в ASR 93–105% аудио.
/// Фильтр пропускает звук без изменений — подготовленный WAV остаётся прежним.
/// −50 дБ, а не −45: тихий голос стримера под игрой уходил ниже порога и
/// выпадал из распознавания целиком — мат в нём не находился вовсе.
const ASR_SILENCE_DETECT: &str = "silencedetect=noise=-50dB:d=0.5";

/// Базовая нормализация временной ASR-копии. Не влияет на исходник и на рендер:
/// поднимает тихую речь, порог не даёт цифровой тишине стать шумом.
const ASR_FILTER_BASE_TAIL: &str = "dynaudnorm=f=150:g=15:p=0.95:m=16:r=0.12:s=3:t=0.0005";

/// Хвост цепочки для «Адаптивного» профиля. Компрессор перед dynaudnorm сжимает
/// разброс между шёпотом и криком (главная причина «вообще не замьютил»):
/// GigaAM теряет тихие слоги, а на клиппующем крике выдаёт мусорные токены.
/// dynaudnorm агрессивнее (окно короче, m больше), чтобы догонять уровень
/// внутри одной фразы, а не по всему файлу.
const ASR_FILTER_ADAPTIVE_TAIL: &str = "acompressor=threshold=0.03:ratio=6:attack=5:release=180:makeup=2,dynaudnorm=f=100:g=11:p=0.9:m=25:r=0.15:s=3:t=0.0005,alimiter=limit=0.95";

fn asr_filter_chain(tail: &str) -> String {
    format!("{ASR_FILTER_HEAD},{ASR_SILENCE_DETECT},{tail}")
}

/// Интервалы тишины исходника в секундах, снятые до нормализации.
pub type SilenceMap = Vec<(f64, f64)>;

/// Разбор вывода `silencedetect`. Незакрытый `silence_start` в конце файла —
/// тишина до самого конца, её длина неизвестна и остаётся открытой (f64::MAX).
fn parse_silence_map(stderr: &str) -> SilenceMap {
    let mut silences: SilenceMap = Vec::new();
    for line in stderr.lines() {
        if let Some((_, rest)) = line.split_once("silence_start:") {
            if let Ok(start) = rest.trim().parse::<f64>() {
                silences.push((start.max(0.0), f64::MAX));
            }
        } else if let Some((_, rest)) = line.split_once("silence_end:") {
            let value = rest.split('|').next().unwrap_or("").trim();
            if let (Ok(end), Some(last)) = (value.parse::<f64>(), silences.last_mut()) {
                if last.1 == f64::MAX {
                    last.1 = end;
                }
            }
        }
    }
    silences.retain(|(start, end)| end > start);
    silences
}

pub async fn convert_to_wav(
    ffmpeg: &Path,
    input_path: &Path,
    wav_path: &Path,
    cancel: Arc<AtomicBool>,
    _mode: FetchrMuteProcessingMode,
) -> Result<SilenceMap> {
    convert_to_wav_with_filter(
        ffmpeg,
        input_path,
        wav_path,
        cancel,
        &asr_filter_chain(ASR_FILTER_BASE_TAIL),
        0,
        None,
    )
    .await
}

/// Тот же путь, но с выбором цепочки по профилю. Если расширенная цепочка не
/// поддерживается сборкой ffmpeg, происходит откат на базовую: лучше обычная
/// нормализация, чем сорванная задача.
pub async fn convert_to_wav_for_profile(
    ffmpeg: &Path,
    input_path: &Path,
    wav_path: &Path,
    cancel: Arc<AtomicBool>,
    profile: FetchrMuteProfile,
    track: u32,
) -> Result<SilenceMap> {
    convert_to_wav_for_profile_with_progress(
        ffmpeg, input_path, wav_path, cancel, profile, track, None,
    )
    .await
}

/// `convert_to_wav_for_profile` с долей прохода ffmpeg в `progress`.
pub async fn convert_to_wav_for_profile_with_progress(
    ffmpeg: &Path,
    input_path: &Path,
    wav_path: &Path,
    cancel: Arc<AtomicBool>,
    profile: FetchrMuteProfile,
    track: u32,
    progress: Option<ProgressCallback>,
) -> Result<SilenceMap> {
    let base = asr_filter_chain(ASR_FILTER_BASE_TAIL);
    if !matches!(profile, FetchrMuteProfile::Adaptive) {
        return convert_to_wav_with_filter(
            ffmpeg, input_path, wav_path, cancel, &base, track, progress,
        )
        .await;
    }
    match convert_to_wav_with_filter(
        ffmpeg,
        input_path,
        wav_path,
        cancel.clone(),
        &asr_filter_chain(ASR_FILTER_ADAPTIVE_TAIL),
        track,
        progress.clone(),
    )
    .await
    {
        Ok(silences) => Ok(silences),
        Err(_) if !cancel.load(Ordering::SeqCst) => {
            convert_to_wav_with_filter(ffmpeg, input_path, wav_path, cancel, &base, track, progress)
                .await
        }
        Err(error) => Err(error),
    }
}

async fn convert_to_wav_with_filter(
    ffmpeg: &Path,
    input_path: &Path,
    wav_path: &Path,
    cancel: Arc<AtomicBool>,
    filter: &str,
    track: u32,
    progress: Option<ProgressCallback>,
) -> Result<SilenceMap> {
    if cancel.load(Ordering::SeqCst) {
        return Err(anyhow!("Fetchr Mute task cancelled"));
    }

    // Длительность нужна только для шкалы; без колбэка ffprobe не зовём.
    let total_seconds = match (&progress, resolve_binary(FFPROBE, ffmpeg.parent())) {
        (Some(_), Some(ffprobe)) => probe_audio_stream(&ffprobe, input_path, track)
            .await
            .map(|(_, _, duration)| duration),
        _ => None,
    };
    let tracker = ffmpeg_progress(total_seconds, progress);

    // ffmpeg пишет во временный `.part`: отмена или сбой посреди записи
    // оставляли обрезанный WAV по итоговому пути, и кэш принимал его за
    // готовый. Итоговый путь появляется только после успешной записи.
    let partial = PartialFileGuard::new(partial_output_path(wav_path));
    let mut args = vec![
        "-y".to_string(),
        "-hide_banner".to_string(),
        // `silencedetect` печатает интервалы на уровне info; на error они
        // теряются. Дополнительные строки уходят в тот же stderr, который и так
        // читается только для диагностики.
        "-loglevel".to_string(),
        "info".to_string(),
    ];
    if tracker.is_some() {
        args.extend(FFMPEG_PROGRESS_ARGS.iter().map(|arg| arg.to_string()));
    }
    args.extend([
        "-i".to_string(),
        input_path.to_string_lossy().into_owned(),
        "-map".to_string(),
        format!("0:a:{track}"),
        "-vn".to_string(),
        "-af".to_string(),
        filter.to_string(),
    ]);

    args.extend([
        "-ar".to_string(),
        "16000".to_string(),
        "-ac".to_string(),
        "1".to_string(),
        "-c:a".to_string(),
        "pcm_s16le".to_string(),
        "-f".to_string(),
        "wav".to_string(),
        partial.path().to_string_lossy().into_owned(),
    ]);

    let mut command = Command::new(ffmpeg);
    command
        .args(&args)
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    let output = run_cancelable_command_with_progress(
        &mut command,
        cancel,
        "ffmpeg audio preparation",
        tracker,
    )
    .await?;

    if !output.status.success() {
        return Err(ffmpeg_failure("подготовить аудио", &output, Some(wav_path)));
    }
    partial
        .commit(wav_path)
        .with_context(|| format!("move prepared wav into place {:?}", wav_path))?;
    Ok(parse_silence_map(&String::from_utf8_lossy(&output.stderr)))
}

/// Уникальное имя недописанного файла рядом с итоговым: две задачи, готовящие
/// один и тот же кэшированный WAV, не пишут в один `.part`.
fn partial_output_path(final_path: &Path) -> PathBuf {
    let file_name = final_path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "output".to_string());
    final_path.with_file_name(format!(
        "{file_name}.{}.{PARTIAL_FILE_EXTENSION}",
        uuid::Uuid::new_v4().simple()
    ))
}

const PARTIAL_FILE_EXTENSION: &str = "part";

/// Удаляет недописанный файл при любом выходе (ошибка, отмена, сброс future),
/// кроме успешного `commit`.
struct PartialFileGuard {
    path: PathBuf,
    committed: bool,
}

impl PartialFileGuard {
    fn new(path: PathBuf) -> Self {
        Self {
            path,
            committed: false,
        }
    }

    fn path(&self) -> &Path {
        &self.path
    }

    fn commit(mut self, final_path: &Path) -> std::io::Result<()> {
        std::fs::rename(&self.path, final_path)?;
        self.committed = true;
        Ok(())
    }
}

impl Drop for PartialFileGuard {
    fn drop(&mut self) {
        if !self.committed {
            let _ = std::fs::remove_file(&self.path);
        }
    }
}

/// Глобальный замок ASR-сервера: распознавание и перепроверка разных задач
/// не должны перезапускать общий сервер друг у друга.
pub(crate) fn lock_asr_execution(
    cancel: &AtomicBool,
) -> Result<parking_lot::MutexGuard<'static, ()>> {
    let execution_lock = ASR_EXECUTION_LOCK.get_or_init(|| parking_lot::Mutex::new(()));
    loop {
        if cancel.load(Ordering::SeqCst) {
            return Err(anyhow!("Fetchr Mute task cancelled"));
        }
        if let Some(guard) = execution_lock.try_lock() {
            return Ok(guard);
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

pub fn transcribe_wav_blocking(
    queue: &Arc<QueueManager>,
    job_id: &str,
    model_dir: &Path,
    wav_path: &Path,
    silences: &[(f64, f64)],
    hotwords: &[String],
    cancel: Arc<AtomicBool>,
    mode: FetchrMuteProcessingMode,
    language: FetchrMuteLanguage,
    model: crate::jobs::types::FetchrMuteAsrModel,
) -> Result<Vec<WordHit>> {
    if cancel.load(Ordering::SeqCst) {
        return Err(anyhow!("Fetchr Mute task cancelled"));
    }

    let _execution_guard = lock_asr_execution(&cancel)?;

    // Полный разбор WAV в память нужен только энергетическому пути. С картой
    // тишины уровни читаются окнами: трёхчасовой файл — это 690 МБ `f32`.
    let full_audio = if silences.is_empty() {
        Some(read_wav_samples(wav_path)?)
    } else {
        None
    };
    let total_samples = match &full_audio {
        Some(samples) => samples.len(),
        None => wav_sample_count(wav_path)?,
    };
    let levels = match &full_audio {
        Some(samples) => SpeechLevels::Full(samples),
        None => SpeechLevels::Windowed {
            path: wav_path,
            total_samples,
        },
    };
    let segments = detect_speech_segments(levels, silences, queue, job_id, cancel.clone(), mode)?;
    let fed: usize = segments
        .iter()
        .map(|segment| segment.end_sample - segment.start_sample)
        .sum();
    emit(
        queue,
        job_id,
        &format!(
            "FetchrMute preselection: {:.1}s of {:.1}s audio in {} segments ({} silence regions)",
            fed as f64 / SAMPLE_RATE as f64,
            total_samples as f64 / SAMPLE_RATE as f64,
            segments.len(),
            silences.len()
        ),
    );
    let asr_segments = segments
        .into_iter()
        .map(|segment| crate::jobs::asr_models::AsrSegment {
            start_sample: segment.start_sample,
            end_sample: segment.end_sample,
            keep_start_sample: segment.keep_start_sample,
            keep_end_sample: segment.keep_end_sample,
        })
        .collect::<Vec<_>>();
    let words = crate::jobs::asr_models::transcribe(
        queue,
        job_id,
        model_dir,
        wav_path,
        &asr_segments,
        hotwords,
        model,
        language,
        mode,
        cancel,
    )?;
    Ok(deduplicate_words(words))
}

pub(crate) fn read_wav_samples(wav_path: &Path) -> Result<Vec<f32>> {
    let mut reader = hound::WavReader::open(wav_path)
        .with_context(|| format!("open prepared wav {:?}", wav_path))?;
    let spec = reader.spec();
    if spec.channels != 1 {
        return Err(anyhow!("prepared wav is not mono"));
    }

    match spec.sample_format {
        hound::SampleFormat::Float => reader
            .samples::<f32>()
            .collect::<std::result::Result<Vec<_>, _>>()
            .context("read float wav samples"),
        hound::SampleFormat::Int if spec.bits_per_sample <= 16 => reader
            .samples::<i16>()
            .map(|sample| sample.map(|value| value as f32 / i16::MAX as f32))
            .collect::<std::result::Result<Vec<_>, _>>()
            .context("read int16 wav samples"),
        hound::SampleFormat::Int => {
            let denom = ((1i64 << (spec.bits_per_sample.saturating_sub(1) as u32)) - 1) as f32;
            reader
                .samples::<i32>()
                .map(|sample| sample.map(|value| value as f32 / denom.max(1.0)))
                .collect::<std::result::Result<Vec<_>, _>>()
                .context("read int32 wav samples")
        }
    }
}

fn deduplicate_words(mut words: Vec<WordHit>) -> Vec<WordHit> {
    words.sort_by(|left, right| {
        left.start
            .partial_cmp(&right.start)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    let mut deduped: Vec<WordHit> = Vec::with_capacity(words.len());
    'outer: for word in words {
        for prev in deduped.iter().rev().take(8) {
            if prev.normalized == word.normalized
                && (prev.start - word.start).abs() <= 0.18
                && (prev.end - word.end).abs() <= 0.18
            {
                continue 'outer;
            }
        }
        deduped.push(word);
    }

    // Merge only true double-detections (same token at adjacent frames, start diff ≤100 ms).
    // Words with start diff >100 ms are genuinely separate and must stay independent.
    let mut merged: Vec<WordHit> = Vec::with_capacity(deduped.len());
    for word in deduped {
        if let Some(last) = merged.last_mut() {
            if last.normalized == word.normalized && (word.start - last.start).abs() <= 0.100 {
                last.end = last.end.max(word.end);
                continue;
            }
        }
        merged.push(word);
    }

    // Safety-padded word intervals are expected to overlap. Clamping them at a
    // midpoint moves the next word start to the right and reintroduces the very
    // ASR delay that the lead pad compensates for.
    merged
}

/// Индексированный мат-словарь.
///
/// Раньше словарь был просто `HashSet<String>`, и каждое НЕсовпавшее слово
/// прогоняло его целиком дважды: fuzzy-проход с аллокацией `Vec<char>` на
/// запись и фонетический проход с аллокацией `String` на запись. На трёхчасовом
/// стриме (~29 тыс. слов, ~350 тыс. вызовов матчера) это давало сотни миллионов
/// аллокаций впустую. Здесь всё, что можно посчитать один раз, считается при
/// загрузке:
///
/// * `exact` — точное совпадение, как и раньше;
/// * `phonetic_keys` — фонетические ключи записей, проверка стала одним `contains`;
/// * `fuzzy_index` — «варианты с одним удалённым символом». Расстояние
///   Левенштейна ≤1 между `a` и `b` равносильно непустому пересечению их
///   множеств таких вариантов, поэтому кандидаты находятся по хэшу, а не
///   перебором словаря.
///
/// Проверки-предикаты после отбора кандидатов оставлены дословно теми же, что
/// и в переборной версии, — результат матчинга обязан совпадать бит в бит.
#[derive(Debug, Clone, Default)]
pub struct ProfaneDictionary {
    exact: HashSet<String>,
    phonetic_keys: HashSet<String>,
    fuzzy_entries: Vec<FuzzyEntry>,
    fuzzy_index: HashMap<String, Vec<u32>>,
}

#[derive(Debug, Clone)]
struct FuzzyEntry {
    chars: Vec<char>,
    bytes: usize,
}

/// Само слово плюс все варианты с одним удалённым символом.
fn deletion_variants(chars: &[char]) -> Vec<String> {
    let mut variants = Vec::with_capacity(chars.len() + 1);
    variants.push(chars.iter().collect());
    for skipped in 0..chars.len() {
        variants.push(
            chars
                .iter()
                .enumerate()
                .filter(|(index, _)| *index != skipped)
                .map(|(_, character)| *character)
                .collect(),
        );
    }
    variants
}

impl ProfaneDictionary {
    pub fn new(words: HashSet<String>) -> Self {
        let mut phonetic_keys = HashSet::with_capacity(words.len());
        let mut fuzzy_entries = Vec::new();
        let mut fuzzy_index: HashMap<String, Vec<u32>> = HashMap::new();
        for word in &words {
            phonetic_keys.insert(phonetic_key(word));
            let chars: Vec<char> = word.chars().collect();
            // Fuzzy-совпадение требует ≥5 символов с обеих сторон, поэтому
            // короткие записи в индекс не попадают вовсе.
            if chars.len() < FUZZY_MIN_LEN {
                continue;
            }
            let position = fuzzy_entries.len() as u32;
            for variant in deletion_variants(&chars) {
                let bucket = fuzzy_index.entry(variant).or_default();
                if bucket.last() != Some(&position) {
                    bucket.push(position);
                }
            }
            fuzzy_entries.push(FuzzyEntry {
                bytes: word.len(),
                chars,
            });
        }
        Self {
            exact: words,
            phonetic_keys,
            fuzzy_entries,
            fuzzy_index,
        }
    }

    pub fn len(&self) -> usize {
        self.exact.len()
    }

    /// Слова для бустинга в декодере ASR. Словарь модели — 33 строчные
    /// кириллические буквы, поэтому латиница и цифры отбрасываются: их не из
    /// чего собрать. Короткие записи отброшены намеренно — бустинг работает
    /// потокенно, и на двух буквах он цепляет пол-словаря русского языка.
    pub fn hotwords(&self) -> Vec<String> {
        const HOTWORD_MIN_LEN: usize = 3;
        let mut words: Vec<String> = self
            .exact
            .iter()
            .filter(|word| {
                word.chars().count() >= HOTWORD_MIN_LEN
                    && word.chars().all(|ch| matches!(ch, 'а'..='я'))
            })
            .cloned()
            .collect();
        words.sort();
        words
    }

    pub fn is_empty(&self) -> bool {
        self.exact.is_empty()
    }

    fn contains(&self, word: &str) -> bool {
        self.exact.contains(word)
    }

    fn contains_phonetic_key(&self, key: &str) -> bool {
        self.phonetic_keys.contains(key)
    }

    /// Кандидаты на fuzzy-совпадение: словарные записи, делящие с запросом хотя
    /// бы один вариант с удалённым символом.
    fn fuzzy_candidates(&self, chars: &[char]) -> Vec<u32> {
        let mut candidates: Vec<u32> = deletion_variants(chars)
            .iter()
            .filter_map(|variant| self.fuzzy_index.get(variant))
            .flatten()
            .copied()
            .collect();
        candidates.sort_unstable();
        candidates.dedup();
        candidates
    }

    /// Сколько словарных записей реально сверяется с одним словом. Нужна
    /// тестам, чтобы ловить возврат к перебору всего словаря.
    #[cfg(test)]
    pub fn fuzzy_candidates_examined(&self, word: &str) -> usize {
        let chars: Vec<char> = word.chars().collect();
        if chars.len() < FUZZY_MIN_LEN {
            return 0;
        }
        self.fuzzy_candidates(&chars).len()
    }
}

impl FromIterator<String> for ProfaneDictionary {
    fn from_iter<I: IntoIterator<Item = String>>(iter: I) -> Self {
        Self::new(iter.into_iter().collect())
    }
}

impl<const N: usize> From<[&str; N]> for ProfaneDictionary {
    fn from(words: [&str; N]) -> Self {
        Self::new(words.iter().map(|word| (*word).to_string()).collect())
    }
}

impl<const N: usize> From<[String; N]> for ProfaneDictionary {
    fn from(words: [String; N]) -> Self {
        Self::new(HashSet::from(words))
    }
}

/// Обе стороны fuzzy-совпадения обязаны быть не короче пяти символов: на более
/// коротких словах Левенштейн ≤1 слишком легко цепляет чистые слова.
const FUZZY_MIN_LEN: usize = 5;

/// С какого символа замена согласной перестаёт считаться опиской ASR.
///
/// Правка гласной — обычная ошибка распознавания: безударные гласные
/// сливаются («срань» → «срень», «сцуко» → «сцука», «охуенно» → «охенно»).
/// Замена согласной в начале слова меняет корень и обычно даёт другое, чистое
/// слово: «срать» → «стать», «курве» → «курсе». Оба поймано на реальном
/// материале с уверенностью 0.94-1.00 — порогом такое не отсечь.
const FUZZY_CONSONANT_EDIT_MIN_INDEX: usize = 4;

fn is_russian_vowel(ch: char) -> bool {
    matches!(
        ch,
        'а' | 'е' | 'ё' | 'и' | 'о' | 'у' | 'ы' | 'э' | 'ю' | 'я'
    )
}

/// Похожа ли единственная правка между словами на описку распознавания.
/// Вызывается только после `levenshtein_le1`, поэтому правка ровно одна.
fn edit_is_plausible_asr_slip(a: &[char], b: &[char]) -> bool {
    if a.len() == b.len() {
        let Some(index) = a.iter().zip(b.iter()).position(|(x, y)| x != y) else {
            return true; // Полное совпадение — правки нет вовсе.
        };
        if is_russian_vowel(a[index]) && is_russian_vowel(b[index]) {
            return true;
        }
        return index >= FUZZY_CONSONANT_EDIT_MIN_INDEX;
    }

    let (short, long) = if a.len() < b.len() { (a, b) } else { (b, a) };
    let mut index = 0;
    while index < short.len() && short[index] == long[index] {
        index += 1;
    }
    is_russian_vowel(long[index]) || index >= FUZZY_CONSONANT_EDIT_MIN_INDEX
}

pub fn load_profane_words(settings: &FetchrMuteSettings) -> Result<ProfaneDictionary> {
    let mut words = HashSet::new();

    if !settings.only_custom_words && matches!(settings.language, FetchrMuteLanguage::Ru) {
        const WORDLIST: &str = include_str!("../../../wordlist.txt");
        words.extend(WORDLIST.lines().filter_map(normalize_wordlist_line));
    }

    if !settings.only_custom_words && matches!(settings.language, FetchrMuteLanguage::En) {
        words.extend(ENGLISH_PROFANE_WORDS.iter().filter_map(|word| {
            let normalized = normalize_word(word);
            (!normalized.is_empty()).then_some(normalized)
        }));
    }

    words.extend(settings.custom_words.iter().filter_map(|word| {
        let normalized = normalize_word(word);
        (!normalized.is_empty()).then_some(normalized)
    }));

    for word in settings.whitelist_words.iter().filter_map(|word| {
        let normalized = normalize_word(word);
        (!normalized.is_empty()).then_some(normalized)
    }) {
        words.remove(&word);
    }

    Ok(ProfaneDictionary::new(words))
}

fn normalize_wordlist_line(line: &str) -> Option<String> {
    let line = line.trim().trim_start_matches('\u{feff}');
    let line = line.split('#').next().unwrap_or(line).trim();
    let normalized = normalize_word(line);
    (!normalized.is_empty()).then_some(normalized)
}

/// Минимальная уверенность каждого фрагмента для склейки CTC-осколков.
const JOIN_MIN_CONFIDENCE: f32 = 0.35;

/// Частотные служебные слова русского языка. Используются только как отсечка
/// для склейки CTC-фрагментов: настоящее слово, разорванное распознавателем,
/// никогда не даёт таких кусков, а вот беглая речь («да у нас») склеивалась в
/// «даунас» и ловилась корневой эвристикой.
const RU_FUNCTION_WORDS: &[&str] = &[
    "а",
    "аж",
    "без",
    "бы",
    "был",
    "было",
    "были",
    "в",
    "вам",
    "вас",
    "вот",
    "все",
    "всё",
    "вы",
    "где",
    "да",
    "для",
    "до",
    "его",
    "ее",
    "ей",
    "ему",
    "если",
    "еще",
    "же",
    "за",
    "и",
    "из",
    "или",
    "им",
    "их",
    "к",
    "как",
    "когда",
    "кто",
    "ко",
    "ли",
    "меня",
    "мне",
    "мной",
    "мы",
    "на",
    "над",
    "нам",
    "нас",
    "не",
    "него",
    "нее",
    "нем",
    "нет",
    "ни",
    "них",
    "но",
    "ну",
    "о",
    "об",
    "он",
    "она",
    "они",
    "оно",
    "от",
    "по",
    "под",
    "при",
    "про",
    "с",
    "себе",
    "себя",
    "со",
    "так",
    "там",
    "те",
    "тебе",
    "тебя",
    "тем",
    "то",
    "тот",
    "ты",
    "у",
    "уж",
    "уже",
    "чем",
    "что",
    "чтобы",
    "эта",
    "эти",
    "это",
    "этот",
    "я",
];

fn is_russian_function_word(normalized: &str) -> bool {
    RU_FUNCTION_WORDS.contains(&normalized)
}

pub fn build_mute_spans(
    words: &[WordHit],
    profane_words: &ProfaneDictionary,
    settings: &FetchrMuteSettings,
) -> Vec<MuteSpan> {
    build_mute_spans_excluding(words, profane_words, settings, &[])
}

/// `build_mute_spans` без мест, которые пользователь снял в «Правках мута».
///
/// Исключение снимается до слияния соседних спанов, по одному найденному
/// слову (фрагменту, фразе): слитый спан «мат + мат» больше не пропадает
/// целиком из-за исключения одного из слов, а снятое слово становится
/// контекстом для соседей, как чистое. Сопоставление — в
/// `excluded_candidate_flags`.
pub fn build_mute_spans_excluding(
    words: &[WordHit],
    profane_words: &ProfaneDictionary,
    settings: &FetchrMuteSettings,
    excluded_spans: &[MuteSpan],
) -> Vec<MuteSpan> {
    let timing = span_timing(settings);
    // Белый список должен перекрывать и словарь, и корневую эвристику
    // (is_russian_profane_root), иначе «Восстановить» не работает для слов,
    // пойманных по корню.
    let whitelist: HashSet<String> = settings
        .whitelist_words
        .iter()
        .map(|word| normalize_word(word))
        .filter(|word| !word.is_empty())
        .collect();
    let is_muted_word = |word: &WordHit| {
        if !is_valid_word_hit(word)
            || word.end - word.start > MAX_PROFANE_WORD_S
            || whitelist.contains(&word.normalized)
            || lemma_is_whitelisted(word, &whitelist)
        {
            return false;
        }
        let kind = word_profane_match_kind(word, profane_words, settings);
        match word.verified {
            // Вторая модель подтвердила мат в этом месте: уверенность первой
            // уже не важна — тихий мат проходит.
            Some(true) if kind.is_some() => return true,
            // «Максимум» мутит всё похожее, вплоть до нулевой уверенности:
            // отказ второй модели не должен делать его мягче, чем без неё.
            Some(false)
                if !matches!(
                    settings.censorship_level,
                    FetchrMuteCensorshipLevel::Maximum
                ) =>
            {
                return false
            }
            _ => {}
        }
        match kind {
            // Fuzzy (Левенштейн ≤1) и фонетика — слабые сигналы, держим для
            // них высокий порог уверенности уровня цензуры.
            Some(ProfaneMatchKind::Fuzzy) | Some(ProfaneMatchKind::Phonetic) => {
                word.confidence >= censor_confidence_threshold(settings)
            }
            // Точное словарное или корневое совпадение — сильный сигнал само
            // по себе: порог заметно ниже, чтобы тихо произнесённый, но верно
            // распознанный мат не отбрасывался.
            Some(_) => word.confidence >= exact_match_confidence_threshold(settings),
            None => false,
        }
    };
    // Решение по каждому слову считается один раз. Раньше `is_muted_word`
    // вызывался около двенадцати раз на слово (соседи по контексту плюс окна
    // склейки CTC-фрагментов), и каждый вызов заново шёл в словарь.
    let muted: Vec<bool> = words.iter().map(&is_muted_word).collect();
    let is_muted_at = |index: usize| muted.get(index).copied().unwrap_or(false);

    // CTC occasionally splits one obscene word into two or three timestamped
    // tokens, for example «ху» + «еву» or «ху» + «ё» + «вый». No fragment
    // matches by itself, so recover only tightly adjacent short fragments
    // whose concatenation is an actual match. Longer joins are preferred:
    // a matched triple suppresses pair attempts at the same position.
    // Adaptive склеивает до 4 фрагментов и терпит более широкие паузы между
    // ними: на крике и шёпоте CTC дробит мат сильнее обычного.
    let adaptive = is_adaptive(settings);
    let max_join = if adaptive { 4 } else { 3 };
    let join_gap = if adaptive { -0.25..=0.26 } else { -0.20..=0.18 };
    // (первый фрагмент, число фрагментов, склеенное слово)
    let mut joins: Vec<(usize, usize, WordHit)> = Vec::new();
    for start_index in 0..words.len() {
        for count in (2..=max_join).rev() {
            let Some(fragments) = words.get(start_index..start_index + count) else {
                continue;
            };
            if fragments.len() < count {
                continue;
            }
            if (start_index..start_index + count).any(&is_muted_at)
                || fragments
                    .iter()
                    .any(|fragment| !is_valid_split_fragment(fragment))
            {
                continue;
            }
            // Служебные слова никогда не бывают половинками разорванного слова:
            // CTC отдаёт нечитаемые куски («ху» + «еву»), а не «да» + «у» +
            // «нас». Без этой отсечки такая тройка склеивалась в «даунас» и
            // ловилась корнем «даун» — мут ложился на чистую речь.
            if fragments
                .iter()
                .any(|fragment| is_russian_function_word(&fragment.normalized))
            {
                continue;
            }
            let gaps_ok = fragments
                .windows(2)
                .all(|pair| join_gap.contains(&(pair[1].start - pair[0].end)));
            let combined_start = fragments
                .iter()
                .map(|fragment| fragment.start)
                .fold(f64::INFINITY, f64::min);
            let combined_end = fragments
                .iter()
                .map(|fragment| fragment.end)
                .fold(f64::NEG_INFINITY, f64::max);
            let combined_duration = combined_end - combined_start;
            // Для пары достаточно одного короткого фрагмента; тройку
            // склеиваем только из коротких кусков, чтобы не сшивать
            // случайные соседние слова.
            let short_enough = if count == 2 {
                // Осколок разорванного слова короткий: CTC отдаёт «ху» + «еву»,
                // а не «картинку» + «рвет». Без верхней границы на длинный
                // фрагмент склейка сшивала два обычных слова, и корень
                // попадал ровно на шов («картинКУ РВЕт» → «курв»).
                let longest = if adaptive { 6 } else { 5 };
                fragments
                    .iter()
                    .all(|fragment| fragment.normalized.chars().count() <= longest)
                    && fragments.iter().any(|fragment| {
                        fragment.normalized.chars().count() <= if adaptive { 4 } else { 3 }
                    })
            } else {
                fragments
                    .iter()
                    .all(|fragment| fragment.normalized.chars().count() <= 4)
            };
            if !gaps_ok || combined_duration > 1.0 || !short_enough {
                continue;
            }

            let joined_normalized: String = fragments
                .iter()
                .map(|fragment| fragment.normalized.as_str())
                .collect();
            if whitelist.contains(&joined_normalized)
                || fragments
                    .iter()
                    .any(|fragment| whitelist.contains(&fragment.normalized))
            {
                continue;
            }
            // Склейка — слабый сигнал сама по себе: строка собрана из соседних
            // токенов, а не распознана моделью. Поэтому fuzzy/фонетика на
            // конкатенации не принимаются вовсе, а уверенность каждого
            // фрагмента обязана быть не ниже JOIN_MIN_CONFIDENCE, независимо от
            // уровня цензуры (0.06 на adaptive/standard пропускал шум).
            let joined_threshold =
                match profane_match_kind(&joined_normalized, profane_words, settings) {
                    Some(ProfaneMatchKind::Fuzzy) | Some(ProfaneMatchKind::Phonetic) => continue,
                    Some(_) => exact_match_confidence_threshold(settings).max(JOIN_MIN_CONFIDENCE),
                    None => continue,
                };
            if fragments
                .iter()
                .any(|fragment| fragment.confidence < joined_threshold)
            {
                continue;
            }
            let joined = WordHit {
            lemma: None,
            verified: None,
                raw: fragments
                    .iter()
                    .map(|fragment| fragment.raw.as_str())
                    .collect::<Vec<_>>()
                    .join(" "),
                normalized: joined_normalized,
                start: combined_start,
                end: combined_end,
                confidence: fragments
                    .iter()
                    .map(|fragment| fragment.confidence)
                    .fold(f32::INFINITY, f32::min),
            };
            joins.push((start_index, count, joined));
            // Более короткие склейки с этой позиции не пробуем.
            break;
        }
    }

    // Фразовый матчинг: многословные записи ЧС («в ахуе», «полный абзац»)
    // ищутся окном по последовательным словам транскрипции. Иначе такая запись
    // мертва: ASR отдаёт слова по одному, а normalize_word склеивает запись в
    // одно слово без пробела, которое ни с одним словом не совпадёт.
    let phrases: Vec<Vec<String>> = settings
        .custom_words
        .iter()
        .filter(|entry| entry.trim().chars().any(char::is_whitespace))
        .map(|entry| {
            entry
                .split_whitespace()
                .map(normalize_word)
                .filter(|tok| !tok.is_empty())
                .collect::<Vec<_>>()
        })
        .filter(|tokens| tokens.len() >= 2)
        .collect();
    // (первое слово окна, длина окна)
    let mut phrase_hits: Vec<(usize, usize)> = Vec::new();
    for phrase in &phrases {
        let phrase_is_whitelisted = whitelist.contains(&phrase.join(""))
            || phrase.iter().any(|token| whitelist.contains(token));
        if phrase_is_whitelisted {
            continue;
        }
        let k = phrase.len();
        if words.len() < k {
            continue;
        }
        for i in 0..=words.len() - k {
            let window = &words[i..i + k];
            let matches = window.iter().zip(phrase.iter()).all(|(w, tok)| {
                is_valid_word_hit(w)
                    && w.confidence >= exact_match_confidence_threshold(settings)
                    && &w.normalized == tok
            });
            // Слова обязаны идти подряд (пауза <0.6с) — «в … [5с] … ахуе» не фраза.
            let contiguous = window
                .windows(2)
                .all(|pair| pair[1].start - pair[0].end < 0.6);
            if matches && contiguous {
                phrase_hits.push((i, k));
            }
        }
    }

    // Исключения пользователя снимаются с найденных слов до построения
    // спанов: снятое слово дальше служит контекстом для соседей.
    let phrase_label = |&(i, k): &(usize, usize)| {
        words[i..i + k]
            .iter()
            .map(|w| w.raw.as_str())
            .collect::<Vec<_>>()
            .join(" ")
    };
    let muted_indices: Vec<usize> = (0..words.len()).filter(|&i| is_muted_at(i)).collect();
    let candidates: Vec<SpanCandidate> = muted_indices
        .iter()
        .map(|&i| SpanCandidate::new(&words[i].raw, words[i].start, words[i].end))
        .chain(
            joins
                .iter()
                .map(|(_, _, joined)| SpanCandidate::new(&joined.raw, joined.start, joined.end)),
        )
        .chain(phrase_hits.iter().map(|hit| {
            let (i, k) = *hit;
            SpanCandidate::new(&phrase_label(hit), words[i].start, words[i + k - 1].end)
        }))
        .collect();
    let dropped = excluded_candidate_flags(&candidates, excluded_spans);
    let (word_dropped, rest) = dropped.split_at(muted_indices.len());
    let (join_dropped, phrase_dropped) = rest.split_at(joins.len());
    let censored: Vec<bool> = (0..words.len())
        .map(|i| {
            is_muted_at(i)
                && !muted_indices
                    .binary_search(&i)
                    .is_ok_and(|position| word_dropped[position])
        })
        .collect();
    let is_censored_at = |index: usize| censored.get(index).copied().unwrap_or(false);

    let mut spans = Vec::new();
    for (index, word) in words.iter().enumerate() {
        if !is_censored_at(index) {
            continue;
        }
        let previous_context = index
            .checked_sub(1)
            .and_then(|previous| words.get(previous))
            .filter(|previous| is_valid_word_hit(previous) && !is_censored_at(index - 1));
        let next_context = words
            .get(index + 1)
            .filter(|next| is_valid_word_hit(next) && !is_censored_at(index + 1));
        let (start, end) = covered_word_span_with_context(
            word,
            previous_context,
            next_context,
            timing.coverage,
            timing.pre_pad,
            timing.post_pad,
            timing.uncovered_lead_share,
            timing.internal_fades,
            timing.fade_guard,
            timing.fade_in_guard,
            timing.min_mute,
            timing.max_mute,
            timing.max_audible_tail,
        );
        spans.push(MuteSpan {
            word: word.raw.clone(),
            start,
            end,
        });
    }

    for ((start_index, count, joined), _) in joins
        .into_iter()
        .zip(join_dropped)
        .filter(|(_, dropped)| !**dropped)
    {
        let previous_context = start_index
            .checked_sub(1)
            .and_then(|previous| words.get(previous))
            .filter(|previous| is_valid_word_hit(previous) && !is_censored_at(start_index - 1));
        let next_context = words
            .get(start_index + count)
            .filter(|next| is_valid_word_hit(next) && !is_censored_at(start_index + count));
        let (start, end) = covered_word_span_with_context(
            &joined,
            previous_context,
            next_context,
            timing.coverage,
            timing.pre_pad,
            timing.post_pad,
            timing.uncovered_lead_share,
            timing.internal_fades,
            timing.fade_guard,
            timing.fade_in_guard,
            timing.min_mute,
            timing.max_mute,
            timing.max_audible_tail,
        );
        spans.push(MuteSpan {
            word: joined.raw,
            start,
            end,
        });
    }

    for (hit, _) in phrase_hits
        .iter()
        .zip(phrase_dropped)
        .filter(|(_, dropped)| !**dropped)
    {
        let (i, k) = *hit;
        let window = &words[i..i + k];
        let previous_context = i.checked_sub(1).and_then(|previous| words.get(previous));
        let next_context = words.get(i + k);
        let (start, end) = clamp_span_to_context(
            (window[0].start - timing.pre_pad).max(0.0),
            window[k - 1].end + timing.post_pad,
            &window[0],
            &window[k - 1],
            previous_context,
            next_context,
            timing.min_mute,
        );
        spans.push(MuteSpan {
            word: phrase_label(hit),
            start,
            end,
        });
    }

    spans.sort_by(|left, right| {
        left.start
            .partial_cmp(&right.start)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    let mut merged: Vec<MuteSpan> = Vec::with_capacity(spans.len());
    for span in spans {
        if let Some(last) = merged.last_mut() {
            if timing
                .merge_gap
                .is_some_and(|merge_gap| span.start <= last.end + merge_gap)
            {
                last.end = last.end.max(span.end);
                last.word.push(',');
                last.word.push_str(&span.word);
                continue;
            }
        }
        merged.push(span);
    }
    merged
}

/// Насколько итоговый спан может уехать от таймкодов ASR: «Адаптивный»
/// сдвигает спаны на оценку задержки CTC (до ASR_OFFSET_MAX_S), а уточнение
/// по энергетике двигает края слова.
const EXCLUSION_TIME_TOLERANCE_S: f64 = ASR_OFFSET_MAX_S;

/// Найденное слово (CTC-склейка, фраза) до построения и слияния спанов.
#[derive(Debug, Clone)]
struct SpanCandidate {
    /// Нормализованная подпись — та же строка, что попадёт в `MuteSpan::word`.
    label: String,
    start: f64,
    end: f64,
}

impl SpanCandidate {
    fn new(label: &str, start: f64, end: f64) -> Self {
        Self {
            label: normalize_word(label),
            start,
            end: end.max(start),
        }
    }

    fn center(&self) -> f64 {
        (self.start + self.end) * 0.5
    }
}

/// Похоже ли исключение по времени на это слово. Исключение — итоговый спан
/// прошлого прогона (уточнённый, возможно слитый), слово — интервал ASR:
/// центр исключения внутри слова (с допуском на сдвиг), центр слова внутри
/// исключения или перекрытие не меньше половины более короткого.
fn exclusion_overlaps_candidate(candidate: &SpanCandidate, exclusion: &MuteSpan) -> bool {
    let exclusion_center = (exclusion.start + exclusion.end) * 0.5;
    let overlap = candidate.end.min(exclusion.end) - candidate.start.max(exclusion.start);
    let shorter = (candidate.end - candidate.start).min(exclusion.end - exclusion.start);
    (candidate.start - EXCLUSION_TIME_TOLERANCE_S..=candidate.end + EXCLUSION_TIME_TOLERANCE_S)
        .contains(&exclusion_center)
        || (exclusion.start..=exclusion.end).contains(&candidate.center())
        || (overlap > 0.0 && overlap >= shorter * 0.5)
}

/// Какие найденные слова снимает список исключений.
///
/// `MuteSpan::word` исключения — подписи слов, из которых был собран спан
/// (слитый спан — через запятую). Каждая подпись снимает ровно одно слово с
/// той же подписью, ближайшее к исключению по времени и похожее на него по
/// `exclusion_overlaps_candidate`. Так исключение одного слова не задевает
/// соседей, в том числе такое же слово рядом («сука, сука»), а исключение
/// слитого спана снимает все его слова. Исключение без подписи снимает одно
/// ближайшее подходящее слово.
fn excluded_candidate_flags(candidates: &[SpanCandidate], exclusions: &[MuteSpan]) -> Vec<bool> {
    let mut dropped = vec![false; candidates.len()];
    for exclusion in exclusions.iter().filter(|x| x.end > x.start) {
        let exclusion_center = (exclusion.start + exclusion.end) * 0.5;
        let labels: Vec<Option<String>> = {
            let named: Vec<Option<String>> = exclusion
                .word
                .split(',')
                .map(normalize_word)
                .filter(|label| !label.is_empty() && label != "manual")
                .map(Some)
                .collect();
            if named.is_empty() {
                vec![None]
            } else {
                named
            }
        };
        for label in labels {
            let nearest = candidates
                .iter()
                .enumerate()
                .filter(|(index, candidate)| {
                    !dropped[*index]
                        && label.as_ref().map_or(true, |label| &candidate.label == label)
                        && exclusion_overlaps_candidate(candidate, exclusion)
                })
                .min_by(|(_, left), (_, right)| {
                    (left.center() - exclusion_center)
                        .abs()
                        .total_cmp(&(right.center() - exclusion_center).abs())
                })
                .map(|(index, _)| index);
            if let Some(index) = nearest {
                dropped[index] = true;
            }
        }
    }
    dropped
}

/// Вето морфологии: слово известно словарю pymorphy, и его начальная форма
/// чистая — значит, корень попал внутрь обычного слова. Точное словарное
/// совпадение не ветируется: запись в списке — явное решение.
pub(crate) fn lemma_vetoes_match(
    word: &WordHit,
    kind: Option<ProfaneMatchKind>,
    profane_words: &ProfaneDictionary,
    settings: &FetchrMuteSettings,
) -> bool {
    if matches!(kind, None | Some(ProfaneMatchKind::Exact)) {
        return false;
    }
    let Some(lemma) = normalized_lemma(word) else {
        return false;
    };
    if lemma == word.normalized {
        return false;
    }
    !profane_words.contains(&lemma)
        && !(matches!(settings.language, FetchrMuteLanguage::Ru)
            && !settings.only_custom_words
            && is_russian_profane_root(&lemma))
}

/// Лемма pymorphy в той же нормализации, что и словарь (ё → е, без знаков):
/// pymorphy отдаёт «ё», а записи словаря хранятся через «е».
fn normalized_lemma(word: &WordHit) -> Option<String> {
    word.lemma
        .as_deref()
        .map(normalize_word)
        .filter(|lemma| !lemma.is_empty())
}

/// Короче леммой не повышаем: «сук» (ветка) pymorphy разбирает как
/// родительный падеж «сука», а трёхбуквенный мат и так стоит в словаре.
const LEMMA_MATCH_MIN_LEN: usize = 4;

/// Начальная форма слова — запись словаря: «суку», «сукой» → «сука»,
/// «херню» → «херня». Словарь перечисляет не все падежи, поэтому без этого
/// формы вне списка на «Стандарте» проходили незаглушёнными. Слова с чистой
/// основой («страхует», «оскорблять») не повышаются.
fn lemma_is_profane_entry(word: &WordHit, profane_words: &ProfaneDictionary) -> bool {
    if word.normalized.chars().count() < LEMMA_MATCH_MIN_LEN {
        return false;
    }
    let Some(lemma) = normalized_lemma(word) else {
        return false;
    };
    lemma != word.normalized
        && profane_words.contains(&lemma)
        && !CLEAN_STEMS
            .iter()
            .any(|stem| word.normalized.contains(stem) || lemma.contains(stem))
}

/// Белый список действует и по лемме: «Восстановить» для «сука» снимает
/// мут и с «суку», и с «сукой».
fn lemma_is_whitelisted(word: &WordHit, whitelist: &HashSet<String>) -> bool {
    normalized_lemma(word).is_some_and(|lemma| whitelist.contains(&lemma))
}

/// Вид совпадения слова транскрипции с учётом леммы: вето чистой начальной
/// формы и точное совпадение по начальной форме из словаря.
pub(crate) fn word_profane_match_kind(
    word: &WordHit,
    profane_words: &ProfaneDictionary,
    settings: &FetchrMuteSettings,
) -> Option<ProfaneMatchKind> {
    let kind = profane_match_kind(&word.normalized, profane_words, settings);
    if kind == Some(ProfaneMatchKind::Exact) {
        return kind;
    }
    if lemma_is_profane_entry(word, profane_words) {
        return Some(ProfaneMatchKind::Exact);
    }
    if kind.is_some() && lemma_vetoes_match(word, kind, profane_words, settings) {
        return None;
    }
    kind
}

/// Ниже этой уверенности кандидат не мутится без подтверждения второй
/// моделью, но всё ещё отправляется на перепроверку.
pub const VERIFY_MIN_CONFIDENCE: f32 = 0.05;
/// Кандидат с уверенностью ASR не ниже этой не снимается перепроверкой:
/// две модели расходятся, а пропуск мата дороже.
pub const VERIFY_KEEP_CONFIDENCE: f32 = 0.50;

fn censor_confidence_threshold(settings: &FetchrMuteSettings) -> f32 {
    // «Адаптивный» профиль рассчитан на тихую/шёпотную/крикливую речь, где
    // GigaAM занижает confidence даже при верном распознавании. Порог опущен
    // до уровня, при котором слабые слабые гипотезы ещё отсекаются, но тихий
    // мат уже проходит. Ложные муты компенсируются белым списком.
    if is_adaptive(settings) {
        return match settings.censorship_level {
            FetchrMuteCensorshipLevel::Soft => 0.45,
            FetchrMuteCensorshipLevel::Standard => 0.22,
            FetchrMuteCensorshipLevel::Strict => 0.15,
            FetchrMuteCensorshipLevel::Maximum => 0.0,
        };
    }
    match settings.censorship_level {
        FetchrMuteCensorshipLevel::Soft => 0.65,
        FetchrMuteCensorshipLevel::Standard => 0.38,
        FetchrMuteCensorshipLevel::Strict => 0.25,
        FetchrMuteCensorshipLevel::Maximum => 0.0,
    }
}

/// Порог уверенности для ТОЧНЫХ словарных/корневых совпадений. Совпадение со
/// словарём мата — сильный сигнал само по себе: вероятность того, что ASR
/// случайно выдал ровно словарное слово, мала, а вот тихо/быстро произнесённый
/// мат часто получает низкую confidence и раньше отбрасывался общим порогом
/// (0.38 на Standard). Поэтому точные совпадения принимаем при заметно более
/// низкой уверенности. Fuzzy-совпадения по-прежнему проходят по общему
/// порогу (censor_confidence_threshold).
pub(crate) fn exact_match_confidence_threshold(settings: &FetchrMuteSettings) -> f32 {
    // У «Адаптивного» было 0.06: мусорный токен на музыке проходил как мат.
    // Тихий, но настоящий мат ниже порога теперь спасает перепроверка CTC
    // (verified = Some(true)).
    if is_adaptive(settings) {
        return match settings.censorship_level {
            FetchrMuteCensorshipLevel::Soft => 0.35,
            FetchrMuteCensorshipLevel::Standard => 0.30,
            FetchrMuteCensorshipLevel::Strict => 0.20,
            FetchrMuteCensorshipLevel::Maximum => 0.0,
        };
    }
    match settings.censorship_level {
        FetchrMuteCensorshipLevel::Soft => 0.30,
        FetchrMuteCensorshipLevel::Standard => 0.15,
        FetchrMuteCensorshipLevel::Strict => 0.12,
        FetchrMuteCensorshipLevel::Maximum => 0.0,
    }
}

pub(crate) fn is_valid_word_hit(word: &WordHit) -> bool {
    if word.normalized.chars().count() < 2 {
        return false;
    }
    if !word.start.is_finite() || !word.end.is_finite() || word.end <= word.start {
        return false;
    }
    let duration = word.end - word.start;
    (MIN_WORD_DURATION_S..=MAX_WORD_DURATION_S).contains(&duration)
}

fn is_valid_split_fragment(word: &WordHit) -> bool {
    if word.normalized.is_empty()
        || !word.start.is_finite()
        || !word.end.is_finite()
        || word.end <= word.start
    {
        return false;
    }
    (MIN_WORD_DURATION_S..=2.0).contains(&(word.end - word.start))
}

// ---------------------------------------------------------------------------
// «Герметичный» профиль: энергетическое уточнение границ мута.
//
// Разбор готовых файлов (прогон той же GigaAM по результату) показал, что
// привязка мута к ASR-интервалу — корень утечек: акустическое слово шире или
// смещено относительно токенов CTC, и слышимых 50–190 мс головы/хвоста хватает
// распознавателю (а значит — и классификатору YouTube) для узнавания мата.
// При этом тупое расширение мута «съедает» соседние слова и контекст.
//
// Решение: резать по энергетике самого слова. Базовый спан (ASR-интервал +
// запас 80/60 мс) расширяется влево и вправо до БЛИЖАЙШЕГО устойчивого
// провала громкости (≥3 кадров по 10 мс ниже пик−14 дБ). Короткие провалы
// внутри слова (взрывные согласные) перешагиваются. Коридор к соседнему слову
// не пересекается никогда: замер на стриме показал, что выход за него (и
// откат «до середины паузы» без найденного провала) съедал чистые слова.
// ---------------------------------------------------------------------------

const SEALED_ENVELOPE_HOP_S: f64 = 0.010;
// 14 дБ вместо 8: тихие атаки слова («на-» в «нахуй» ≈ −11 дБ от пика
// гласного) раньше отрезались, и голова мата оставалась слышна даже при
// покрытии 100%. Паузы между словами глубже −20 дБ, поэтому скан по-прежнему
// останавливается на реальных границах слова.
const SEALED_DIP_DB: f32 = 14.0;
const SEALED_GUARD_S: f64 = 0.015;
/// Насколько далеко от границы слова ASR может уйти уточнённый край, если
/// соседа нет (начало или конец фразы).
const REFINE_MAX_EXPAND_S: f64 = 0.60;
/// Если провал громкости так и не найден, край уходит не дальше этого: без
/// соседа коридор длинный, и откат на всю его ширину глушил фон (игру,
/// музыку) по полсекунды — это и слышно как «пропал звук».
const REFINE_FALLBACK_EXPAND_S: f64 = 0.20;
const SEALED_PEAK_WINDOW_S: f64 = 0.30;

/// «Адаптивный» профиль сканирует глубже (18 дБ вместо 14), потому что при
/// полном покрытии допустимо захватить часть паузы, но недопустимо оставить
/// слышимый слог. Запас после провала тоже больше.
/// Насколько тише 95-го перцентиля файла должен быть пик внутри спана, чтобы
/// считать, что речи там нет вовсе. Такие спаны — мусорные гипотезы ASR на
/// шуме/музыке, и мут в этом месте слышен как провал в дорожке.
const SPAN_SILENCE_BELOW_P95_DB: f32 = 30.0;

const ADAPTIVE_DIP_DB: f32 = 18.0;
const ADAPTIVE_GUARD_S: f64 = 0.030;

/// Профили, у которых спаны уточняются по энергетике подготовленного WAV.
fn uses_energy_refinement(profile: FetchrMuteProfile) -> bool {
    matches!(
        profile,
        FetchrMuteProfile::Sealed | FetchrMuteProfile::Adaptive
    )
}

fn is_adaptive(settings: &FetchrMuteSettings) -> bool {
    matches!(settings.mute_profile, FetchrMuteProfile::Adaptive)
}

/// Оценка систематического сдвига таймкодов ASR относительно реальной речи.
/// Для каждого валидного слова ищется ближайший энергетический онсет в окне
/// ±ASR_OFFSET_SEARCH_S от word.start; берётся медиана разностей. Медиана
/// устойчива к отдельным промахам распознавателя, а сам сдвиг у CTC-моделей
/// систематический (зависит от размера окна и стрида), поэтому одна поправка
/// на файл убирает основную часть рассинхрона.
const ASR_OFFSET_SEARCH_S: f64 = 0.250;
const ASR_OFFSET_MAX_S: f64 = 0.150;
const ASR_OFFSET_MIN_SAMPLES: usize = 8;

fn estimate_asr_offset(words: &[WordHit], db: &[f32], hop: f64) -> f64 {
    if db.len() < 20 {
        return 0.0;
    }
    let mut sorted = db.to_vec();
    sorted.sort_by(|left, right| left.total_cmp(right));
    let loud = sorted[((sorted.len() as f64 * 0.95) as usize).min(sorted.len() - 1)];
    let gate = loud - 25.0;

    // Кадры, где энергия переходит снизу вверх через gate.
    let onsets: Vec<f64> = (1..db.len())
        .filter(|&i| db[i] > gate && db[i - 1] <= gate)
        .map(|i| i as f64 * hop)
        .collect();
    if onsets.len() < ASR_OFFSET_MIN_SAMPLES {
        return 0.0;
    }

    // `onsets` уже возрастает, поэтому ближайший к слову ищется бинарным
    // поиском по двум соседям, а не фильтрацией всего вектора на каждое слово.
    let mut diffs: Vec<f64> = Vec::new();
    for word in words.iter().filter(|word| is_valid_word_hit(word)) {
        let target = word.start;
        let position = onsets.partition_point(|onset| *onset < target);
        let nearest = [position.checked_sub(1), Some(position)]
            .into_iter()
            .flatten()
            .filter_map(|index| onsets.get(index).copied())
            .filter(|onset| (onset - target).abs() <= ASR_OFFSET_SEARCH_S)
            .min_by(|left, right| (left - target).abs().total_cmp(&(right - target).abs()));
        if let Some(onset) = nearest {
            diffs.push(onset - target);
        }
    }
    if diffs.len() < ASR_OFFSET_MIN_SAMPLES {
        return 0.0;
    }
    diffs.sort_by(f64::total_cmp);
    let median = diffs[diffs.len() / 2];
    median.clamp(-ASR_OFFSET_MAX_S, ASR_OFFSET_MAX_S)
}

/// Per-10ms RMS envelope of the prepared 16 kHz mono audio, in dBFS.
/// `energy_envelope_db(&read_wav_samples(path)?, sample_rate)` computed while
/// reading, one hop at a time. Same operations in the same order, so the same
/// numbers.
fn read_wav_envelope_db(wav_path: &Path, sample_rate: u32) -> Result<Vec<f32>> {
    let hop = ((sample_rate as f64) * SEALED_ENVELOPE_HOP_S) as usize;
    if hop == 0 {
        return Ok(Vec::new());
    }
    let mut reader = hound::WavReader::open(wav_path)
        .with_context(|| format!("open prepared wav {:?}", wav_path))?;
    let spec = reader.spec();
    if spec.channels != 1 {
        return Err(anyhow!("prepared wav is not mono"));
    }
    let mut envelope = EnvelopeBuilder::new(hop, reader.duration() as usize);
    match spec.sample_format {
        hound::SampleFormat::Float => {
            for sample in reader.samples::<f32>() {
                envelope.push(sample.context("read float wav samples")?);
            }
        }
        hound::SampleFormat::Int if spec.bits_per_sample <= 16 => {
            for sample in reader.samples::<i16>() {
                let value = sample.context("read int16 wav samples")?;
                envelope.push(value as f32 / i16::MAX as f32);
            }
        }
        hound::SampleFormat::Int => {
            let denom = ((1i64 << (spec.bits_per_sample.saturating_sub(1) as u32)) - 1) as f32;
            for sample in reader.samples::<i32>() {
                let value = sample.context("read int32 wav samples")?;
                envelope.push(value as f32 / denom.max(1.0));
            }
        }
    }
    Ok(envelope.finish())
}

struct EnvelopeBuilder {
    hop: usize,
    sum: f32,
    count: usize,
    db: Vec<f32>,
}

impl EnvelopeBuilder {
    fn new(hop: usize, total_samples: usize) -> Self {
        Self {
            hop,
            sum: 0.0,
            count: 0,
            db: Vec::with_capacity(total_samples / hop + 1),
        }
    }

    fn push(&mut self, sample: f32) {
        self.sum += sample * sample;
        self.count += 1;
        if self.count == self.hop {
            self.flush();
        }
    }

    fn flush(&mut self) {
        let rms = (self.sum / self.count as f32 + 1e-12).sqrt();
        self.db.push(20.0 * (rms + 1e-9).log10());
        self.sum = 0.0;
        self.count = 0;
    }

    fn finish(mut self) -> Vec<f32> {
        if self.count > 0 {
            self.flush();
        }
        self.db
    }
}

fn energy_envelope_db(samples: &[f32], sample_rate: u32) -> Vec<f32> {
    let hop = ((sample_rate as f64) * SEALED_ENVELOPE_HOP_S) as usize;
    if hop == 0 {
        return Vec::new();
    }
    samples
        .chunks(hop)
        .map(|frame| {
            let rms = (frame.iter().map(|sample| sample * sample).sum::<f32>()
                / frame.len() as f32
                + 1e-12)
                .sqrt();
            20.0 * (rms + 1e-9).log10()
        })
        .collect()
}

/// Уточняет sealed-спаны по энергетике речи. Для остальных профилей — no-op.
/// При покрытии 100% уточнение только РАСШИРЯЕТ базовый спан, никогда не
/// сужает его. При частичном покрытии уточняется внешняя область огибающей
/// (расширением), а нулевое ядро вырезается внутри неё по доле покрытия —
/// поэтому ядро может отличаться от базового спана в обе стороны.
pub fn refine_sealed_spans(
    spans: Vec<MuteSpan>,
    words: &[WordHit],
    samples: &[f32],
    sample_rate: u32,
    settings: &FetchrMuteSettings,
) -> Vec<MuteSpan> {
    if !uses_energy_refinement(settings.mute_profile) || spans.is_empty() || samples.is_empty() {
        return spans;
    }
    let db = energy_envelope_db(samples, sample_rate);
    refine_sealed_spans_with_envelope(spans, words, &db, settings)
}

/// `refine_sealed_spans` from the 10 ms dB envelope alone: that is all the
/// refinement reads, so callers can build it without the whole track in RAM.
fn refine_sealed_spans_with_envelope(
    spans: Vec<MuteSpan>,
    words: &[WordHit],
    db: &[f32],
    settings: &FetchrMuteSettings,
) -> Vec<MuteSpan> {
    if !uses_energy_refinement(settings.mute_profile) || spans.is_empty() || db.is_empty() {
        return spans;
    }
    let adaptive = is_adaptive(settings);
    let dip_db = if adaptive {
        ADAPTIVE_DIP_DB
    } else {
        SEALED_DIP_DB
    };
    let guard_s = if adaptive {
        ADAPTIVE_GUARD_S
    } else {
        SEALED_GUARD_S
    };
    let hop = SEALED_ENVELOPE_HOP_S;
    let frame_of = |t: f64| -> usize { (t / hop) as usize };
    let timing = span_timing(settings);
    let min_core = timing.min_mute.max(MIN_SPAN_S);

    // Компенсация систематической задержки CTC: сдвигаем и слова, и спаны на
    // одну и ту же величину, иначе коридоры пауз считаются по несмещённым
    // соседям и мут снова уезжает на следующее слово.
    let offset = if adaptive {
        estimate_asr_offset(words, &db, hop)
    } else {
        0.0
    };
    let shifted_words: Vec<WordHit>;
    let words: &[WordHit] = if offset.abs() > 0.001 {
        shifted_words = words
            .iter()
            .map(|word| WordHit {
            lemma: None,
            verified: None,
                raw: word.raw.clone(),
                normalized: word.normalized.clone(),
                start: (word.start + offset).max(0.0),
                end: (word.end + offset).max(0.0),
                confidence: word.confidence,
            })
            .collect();
        shifted_words.as_slice()
    } else {
        words
    };
    let spans: Vec<MuteSpan> = if offset.abs() > 0.001 {
        spans
            .into_iter()
            .map(|span| MuteSpan {
                word: span.word,
                start: (span.start + offset).max(0.0),
                end: (span.end + offset).max(0.0),
            })
            .collect()
    } else {
        spans
    };

    let mut sorted: Vec<&WordHit> = words
        .iter()
        .filter(|word| is_valid_word_hit(word))
        .collect();
    sorted.sort_by(|left, right| {
        left.start
            .partial_cmp(&right.start)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    let sustained_below = |idx: isize, step: isize, floor_db: f32| -> bool {
        (0..3).all(|k| {
            let frame = idx + k * step;
            frame >= 0 && (frame as usize) < db.len() && db[frame as usize] <= floor_db
        })
    };

    // Слова отсортированы по началу, поэтому окрестность спана находится
    // бинарным поиском. Раньше на каждый спан приходилось четыре полных
    // прохода по всем словам: на трёхчасовом стриме это спаны × слова.
    // `is_valid_word_hit` гарантирует длительность слова ≤ MAX_WORD_DURATION_S,
    // и это даёт точную левую границу поиска.
    let starts: Vec<f64> = sorted.iter().map(|word| word.start).collect();
    let first_at_or_after = |time: f64| starts.partition_point(|start| *start < time);

    // Ориентир громкости речи по всему файлу: 95-й перцентиль огибающей (тот же
    // приём, что в estimate_asr_offset). Спаны, чей пик тише этого уровня на
    // SPAN_SILENCE_BELOW_P95_DB, речи под собой не имеют.
    // Only the 95th percentile is needed: select it instead of sorting all
    // frames (a million of them on a 3 h stream); the value is the same.
    let mut sorted_db = db.to_vec();
    let p95_index = ((sorted_db.len() as f64 * 0.95) as usize).min(sorted_db.len() - 1);
    let loud_p95 = *sorted_db
        .select_nth_unstable_by(p95_index, |left, right| left.total_cmp(right))
        .1;
    let silence_gate = loud_p95 - SPAN_SILENCE_BELOW_P95_DB;
    let span_peak_db = |from: f64, to: f64| -> f32 {
        let last = db.len().saturating_sub(1);
        let first_frame = frame_of(from.max(0.0)).min(last);
        let last_frame = frame_of(to.max(0.0)).min(last);
        db[first_frame..=last_frame.max(first_frame)]
            .iter()
            .copied()
            .fold(f32::NEG_INFINITY, f32::max)
    };

    spans
        .into_iter()
        .filter(|span| {
            // Мут по тишине/шуму: под спаном нет речи, значит и мьютить нечего.
            span_peak_db(span.start, span.end.max(span.start + 0.005)) > silence_gate
        })
        .map(|span| {
            let base_start = span.start.max(0.0);
            let base_end = span.end.max(base_start + 0.005);
            // Интервалы слов ASR перекрываются на ~0.1 с (запасы на голову и
            // хвост). Касание спана не делает соседа накрытым: иначе регион
            // разрастался на всё соседнее слово и мут съедал чистую речь.
            let is_covered = |word: &WordHit| {
                let overlap = word.end.min(base_end) - word.start.max(base_start);
                let center = (word.start + word.end) * 0.5;
                overlap > 0.0
                    && ((base_start..=base_end).contains(&center)
                        || overlap >= (word.end - word.start) * 0.5)
            };

            // Слова, накрытые этим спаном (спан мог слить несколько слов).
            let search_from = first_at_or_after(base_start - MAX_WORD_DURATION_S);
            let search_to = first_at_or_after(base_end);
            let covered = || {
                sorted[search_from..search_to]
                    .iter()
                    .filter(|word| is_covered(word))
            };
            let word_start = covered()
                .map(|word| word.start.max(0.0))
                .fold(f64::INFINITY, f64::min)
                .min(base_start + timing.pre_pad);
            let word_end = covered()
                .map(|word| word.end)
                .fold(f64::NEG_INFINITY, f64::max)
                .max(base_end - timing.post_pad);

            // Коридоры к ближайшим НЕнакрытым словам — середины пауз, а при
            // перекрытии интервалов — середина перекрытия. Соседом считается
            // ближайшее по началу ненакрытое слово, в том числе перекрывающее:
            // раньше перекрывающий сосед пропускался, и коридор уходил к слову
            // через одно.
            let previous = sorted[..first_at_or_after(word_start)]
                .iter()
                .rev()
                .find(|word| !is_covered(word));
            let corridor_l = previous
                .map(|previous| (previous.end + word_start) * 0.5)
                .unwrap_or(word_start - REFINE_MAX_EXPAND_S)
                .max(0.0);
            let next = sorted[first_at_or_after(word_start + f64::EPSILON)..]
                .iter()
                .find(|word| !is_covered(word));
            let corridor_r = next
                .map(|next| (word_end + next.start) * 0.5)
                .unwrap_or(word_end + REFINE_MAX_EXPAND_S);

            // Пик по расширенному окну: базовый спан может попасть в тихий
            // зазор, и тогда порог провала окажется заниженным.
            let peak_start = frame_of((base_start - SEALED_PEAK_WINDOW_S).max(0.0));
            let peak_end =
                frame_of(base_end + SEALED_PEAK_WINDOW_S).min(db.len().saturating_sub(1));
            let peak = if peak_end > peak_start {
                db[peak_start..=peak_end]
                    .iter()
                    .copied()
                    .fold(f32::NEG_INFINITY, f32::max)
            } else {
                0.0
            };
            let floor_db = peak - dip_db;

            // Левый край: ближайший устойчивый провал, идя влево от базового.
            // За коридор не выходим никогда: громкая энергия у границы — это
            // как раз соседнее слово, а не хвост нашего.
            let limit_l = corridor_l.max(0.0);
            let mut start = base_start;
            // Слово может начинаться за концом огибающей: транскрипция бывает
            // длиннее подготовленного WAV (кэш распознавания от более длинного
            // источника, обрезанный файл). Без зажима это паника по индексу.
            let last_frame = db.len() as isize - 1;
            let i_l1 = (frame_of(base_start) as isize).min(last_frame);
            let i_l0 = (frame_of(limit_l) as isize).min(last_frame);
            let mut hit: Option<isize> = None;
            let mut i = i_l1;
            while i > i_l0 {
                if db[i as usize] <= floor_db && sustained_below(i, -1, floor_db) {
                    hit = Some(i);
                    break;
                }
                i -= 1;
            }
            if let Some(i) = hit {
                start = ((i + 1) as f64 * hop).max(limit_l);
            } else if i_l1 > i_l0 + 1 {
                // Провала нет — слитная речь: край уходит до коридора. Он уже
                // зажат серединой паузы к соседу, так что чужое слово не
                // задевается (замер: граница ASR здесь давала больше утечек).
                start = limit_l.max(word_start - REFINE_FALLBACK_EXPAND_S).min(base_start);
            }
            start = start.max(0.0);

            // Правый край: ближайший устойчивый провал, идя вправо от базового.
            let limit_r = corridor_r;
            let mut end = base_end;
            let i_r0 = (frame_of(base_end) as isize).min(last_frame);
            let i_r1 = (frame_of(limit_r) as isize).min(last_frame);
            let mut hit: Option<isize> = None;
            let mut i = i_r0;
            while i < i_r1 {
                if db[i as usize] <= floor_db && sustained_below(i, 1, floor_db) {
                    hit = Some(i);
                    break;
                }
                i += 1;
            }
            if let Some(i) = hit {
                end = (i as f64 * hop + guard_s).min(limit_r);
            } else if i_r1 > i_r0 + 1 {
                end = limit_r.min(word_end + REFINE_FALLBACK_EXPAND_S).max(base_end);
            }

            // Уточнённая область [start, end] — то, что огибающая полностью
            // контролирует: от реального начала слова до реального конца.
            let region_end = end;
            if timing.internal_fades {
                // Частичное покрытие: нулевое ядро — доля УТОЧНЁННОЙ области,
                // а рампы (fade guards) остаются внутри неё: края слова слышны
                // через затухания, соседи по-прежнему не затронуты, потому что
                // область уже зажата коридорами пауз.
                let refined_word = WordHit {
            lemma: None,
            verified: None,
                    raw: span.word.clone(),
                    normalized: String::new(),
                    start,
                    end: region_end,
                    confidence: 1.0,
                };
                let (core_start, core_end) = covered_word_span_for_timing(
                    &refined_word,
                    timing.coverage,
                    0.0,
                    0.0,
                    0.0,
                    true,
                    timing.fade_guard,
                    timing.fade_in_guard,
                    timing.min_mute,
                    timing.max_mute,
                    timing.max_audible_tail,
                );
                start = core_start;
                end = core_end;
            }

            let wanted_core = min_core.min(base_end - base_start);
            if end < start + wanted_core {
                let core_ceiling = if timing.internal_fades {
                    region_end
                } else {
                    limit_r
                };
                end = (start + wanted_core).min(core_ceiling);
            }
            MuteSpan {
                word: span.word,
                start,
                end: end.max(start + 0.005),
            }
        })
        .collect()
}

/// Общая точка для всех путей обработки: для «Герметичного» профиля уточняет
/// спаны по энергетике подготовленного WAV. Если WAV ещё нет (кэш ASR или
/// быстрый recensor), создаёт его — это быстро и не трогает распознавание.
/// При любой ошибке возвращает базовые спаны: хуже уточнение, чем сбой задачи.
/// Подготовленный 16 кГц WAV, живущий вне временного каталога задачи.
///
/// «Герметичный» и «Адаптивный» профили уточняют границы спанов по энергетике,
/// поэтому каждый пересчёт цензуры (движение ползунка покрытия) требовал WAV.
/// Раньше он лежал в каталоге на новом UUID и удалялся вместе с ним — то есть
/// каждое движение ползунка декодировало исходник целиком. Ключ включает
/// отпечаток источника, так что подменённый файл кэш не переиспользует.
pub fn prepared_wav_path(fingerprint: &str, profile: FetchrMuteProfile, track: u32) -> PathBuf {
    std::env::temp_dir()
        .join("fetchr-mute-wav-cache")
        .join(format!(
            "{}-{}-a{track}.wav",
            safe_path_part(fingerprint),
            safe_path_part(&format!("{profile:?}").to_lowercase())
        ))
}

/// Недописанный `.part` старше этого — остаток прерванной подготовки: идущая
/// запись ffmpeg обновляет время изменения файла постоянно.
const STALE_PARTIAL_WAV_AGE: Duration = Duration::from_secs(10 * 60);

/// Трёхчасовой стрим — это ~350 МБ подготовленного WAV, поэтому в кэше остаются
/// только самые свежие файлы. Недописанные `.part` в счёт не идут: свежие
/// принадлежат идущей подготовке, устаревшие удаляются.
pub fn prune_prepared_wav_cache(keep: &Path, keep_count: usize) {
    let Some(directory) = keep.parent() else {
        return;
    };
    let Ok(entries) = std::fs::read_dir(directory) else {
        return;
    };
    let files: Vec<(std::time::SystemTime, PathBuf)> = entries
        .flatten()
        .filter(|entry| entry.path() != keep)
        .filter_map(|entry| {
            let metadata = entry.metadata().ok()?;
            if !metadata.is_file() {
                return None;
            }
            Some((metadata.modified().ok()?, entry.path()))
        })
        .collect();
    let is_partial = |path: &Path| {
        path.extension()
            .is_some_and(|extension| extension == PARTIAL_FILE_EXTENSION)
    };
    let now = std::time::SystemTime::now();
    for (modified, path) in files.iter().filter(|(_, path)| is_partial(path)) {
        let age = now.duration_since(*modified).unwrap_or_default();
        if age >= STALE_PARTIAL_WAV_AGE {
            let _ = std::fs::remove_file(path);
        }
    }
    let mut complete: Vec<&(std::time::SystemTime, PathBuf)> =
        files.iter().filter(|(_, path)| !is_partial(path)).collect();
    complete.sort_by(|left, right| right.0.cmp(&left.0));
    for (_, path) in complete.into_iter().skip(keep_count.saturating_sub(1)) {
        let _ = std::fs::remove_file(path);
    }
}

/// Сколько начала файла читается для проверки заголовка: ffmpeg пишет перед
/// блоком данных только fmt и короткий LIST.
const WAV_HEADER_PROBE_BYTES: u64 = 64 * 1024;

/// Заголовок подготовленного WAV цел: RIFF/WAVE, PCM 16 бит, 16 кГц, моно,
/// размер RIFF сходится с размером файла, блок данных непустой и целиком
/// лежит в файле. Прерванный ffmpeg оставляет в заголовке заглушки размеров
/// (0xFFFFFFFF) или блок данных длиннее файла.
fn prepared_wav_header_is_complete(header: &[u8], file_len: u64) -> bool {
    let u16_at = |offset: usize| {
        header
            .get(offset..offset + 2)
            .map(|bytes| u16::from_le_bytes([bytes[0], bytes[1]]))
    };
    let u32_at = |offset: usize| {
        header
            .get(offset..offset + 4)
            .map(|bytes| u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]))
    };
    if header.get(0..4) != Some(b"RIFF".as_slice())
        || header.get(8..12) != Some(b"WAVE".as_slice())
        || u32_at(4).map(|riff_size| u64::from(riff_size) + 8) != Some(file_len)
    {
        return false;
    }
    let mut offset = 12usize;
    let mut format_ok = false;
    while let (Some(id), Some(size)) = (header.get(offset..offset + 4), u32_at(offset + 4)) {
        let body = offset + 8;
        if id == b"fmt " {
            format_ok = u16_at(body) == Some(1)
                && u16_at(body + 2) == Some(1)
                && u32_at(body + 4) == Some(SAMPLE_RATE)
                && u16_at(body + 14) == Some(16);
        } else if id == b"data" {
            let data_end = body as u64 + u64::from(size);
            return format_ok && size > 0 && size % 2 == 0 && data_end <= file_len;
        }
        // Блоки RIFF выравниваются до чётной длины.
        offset = body + size as usize + (size as usize & 1);
    }
    false
}

fn prepared_wav_file_is_complete(wav_path: &Path) -> bool {
    let Ok(file) = std::fs::File::open(wav_path) else {
        return false;
    };
    let Ok(metadata) = file.metadata() else {
        return false;
    };
    let mut header = Vec::new();
    if file
        .take(WAV_HEADER_PROBE_BYTES)
        .read_to_end(&mut header)
        .is_err()
    {
        return false;
    }
    metadata.is_file() && prepared_wav_header_is_complete(&header, metadata.len())
}

/// Кэшированный WAV пригоден к использованию. Обрезанный файл (прерванная
/// подготовка старой версии, сбой диска) удаляется, чтобы его пересоздали:
/// раньше проверка «размер > 0» принимала его навсегда, и уточнение границ с
/// CTC-перепроверкой молча отключались.
pub fn prepared_wav_ready(wav_path: &Path) -> bool {
    if prepared_wav_file_is_complete(wav_path) {
        return true;
    }
    if wav_path.exists() {
        let _ = std::fs::remove_file(wav_path);
    }
    false
}

pub async fn refine_spans_for_settings(
    ffmpeg: &Path,
    input_path: &Path,
    wav_path: &Path,
    spans: Vec<MuteSpan>,
    words: &[WordHit],
    settings: &FetchrMuteSettings,
    cancel: Arc<AtomicBool>,
) -> Vec<MuteSpan> {
    if !uses_energy_refinement(settings.mute_profile) || spans.is_empty() {
        return spans;
    }
    if !prepared_wav_ready(wav_path) {
        if convert_to_wav_for_profile(
            ffmpeg,
            input_path,
            wav_path,
            cancel,
            settings.mute_profile,
            selected_audio_track(settings),
        )
            .await
            .is_err()
        {
            return spans;
        }
    }
    // The envelope is streamed off the async workers: reading the whole
    // prepared track as f32 held ~690 MB for a 3 h stream on every run and
    // every re-censor, only to reduce it to a few MB of 10 ms frames.
    let envelope_path = wav_path.to_path_buf();
    let envelope =
        tokio::task::spawn_blocking(move || read_wav_envelope_db(&envelope_path, SAMPLE_RATE))
            .await;
    match envelope {
        Ok(Ok(db)) => refine_sealed_spans_with_envelope(spans, words, &db, settings),
        _ => spans,
    }
}

struct SpanTiming {
    pre_pad: f64,
    post_pad: f64,
    merge_gap: Option<f64>,
    coverage: f64,
    uncovered_lead_share: f64,
    internal_fades: bool,
    fade_guard: f64,
    fade_in_guard: f64,
    min_mute: f64,
    max_mute: f64,
    /// Сколько звука разрешено оставить слышимым ПОСЛЕ ядра, внутри слова.
    max_audible_tail: AudibleTail,
}

fn span_timing(settings: &FetchrMuteSettings) -> SpanTiming {
    if matches!(settings.mute_profile, FetchrMuteProfile::Adaptive) {
        // Форма взята из замеров референсных дорожек (n=27…254 мута на файл):
        //   ядро            med 185–265 мс
        //   рампа вниз      med 82–130 мс
        //   рампа вверх     med 30–55 мс
        // Слово НЕ вырезается целиком: слышна затухающая голова и слышимый
        // хвост в конце — без него обрыв звучит слишком жёстко.
        //
        // Обе рампы живут внутри слова: fade_guard отодвигает начало ядра от
        // начала слова, max_audible_tail — конец ядра от конца слова. Границы
        // самого слова при этом берутся не из таймкода ASR, а из энергетики
        // (refine_sealed_spans) — это и чинит «замьютило не мат, а слово после».
        let (fade_out, _) = reference_fade_seconds(settings);
        return SpanTiming {
            pre_pad: 0.0,
            post_pad: 0.0,
            merge_gap: Some(0.060),
            coverage: (settings.coverage_percent.clamp(20, 100) as f64) / 100.0,
            uncovered_lead_share: 0.0,
            internal_fades: true,
            fade_guard: fade_out,
            fade_in_guard: 0.0,
            min_mute: (settings.min_mute_ms.clamp(20, 500) as f64) / 1000.0,
            max_mute: f64::INFINITY,
            max_audible_tail: AudibleTail::scaled(
                ADAPTIVE_AUDIBLE_TAIL_SHARE,
                ADAPTIVE_AUDIBLE_TAIL_MIN_S,
                ADAPTIVE_AUDIBLE_TAIL_MAX_S,
            ),
        };
    }

    if matches!(settings.mute_profile, FetchrMuteProfile::Sealed) {
        // «Герметичный»: границы огибающей уточняются по энергетике речи
        // (refine_sealed_spans), поэтому слово не выскакивает из-под мута,
        // а соседние слова не страдают (коридоры — середины пауз).
        //
        // coverage 100%: нулевое ядро = всё слово, затухание/возврат выносятся
        // за пределы слова в паузы (их ставит reference-огибающая рендера).
        // coverage < 100%: ядро — доля слова, а затухание/возврат (fade
        // guards) ложатся ВНУТРЬ слова: края слова слышны через рампы
        // (контекст понятен), середина — цифровая тишина.
        //
        // pre_pad/post_pad применяются только при полном покрытии. При
        // частичном они раздули бы ядро сверх запрошенной доли (пады
        // прибавляются к ядру на этапе построения), а выход в паузы не нужен:
        // рампы живут внутри слова. Компенсацию джиттера ASR даёт уточнение
        // по энергетике.
        let coverage = (settings.coverage_percent.clamp(20, 100) as f64) / 100.0;
        let partial = coverage < 0.995;
        return SpanTiming {
            pre_pad: if partial { 0.0 } else { 0.080 },
            post_pad: if partial { 0.0 } else { 0.060 },
            merge_gap: Some(0.060),
            coverage,
            uncovered_lead_share: 0.0,
            internal_fades: partial,
            fade_guard: if partial {
                (settings.fade_out_ms.clamp(1, 500) as f64) / 1000.0
            } else {
                0.0
            },
            fade_in_guard: if partial {
                (settings.fade_in_ms.clamp(1, 200) as f64) / 1000.0
            } else {
                0.0
            },
            min_mute: (settings.min_mute_ms.clamp(20, 500) as f64) / 1000.0,
            max_mute: f64::INFINITY,
            max_audible_tail: AudibleTail::fixed(REFERENCE_MAX_AUDIBLE_TAIL_S),
        };
    }

    if matches!(settings.mute_profile, FetchrMuteProfile::Reference) {
        return SpanTiming {
            // Both ramps live inside the recognized word. This removes the
            // intelligible opening left by partial coverage without fading or
            // zeroing the neighbouring words.
            pre_pad: 0.0,
            post_pad: 0.0,
            // Every detected word keeps its own envelope, even when timestamps
            // overlap. Multiplication in the renderer handles the overlap safely.
            merge_gap: None,
            coverage: (settings.coverage_percent.clamp(20, 100) as f64) / 100.0,
            uncovered_lead_share: 0.0,
            internal_fades: true,
            fade_guard: (settings.fade_out_ms.clamp(1, 500) as f64) / 1000.0,
            fade_in_guard: (settings.fade_in_ms.clamp(1, 200) as f64) / 1000.0,
            min_mute: (settings.min_mute_ms.clamp(20, 500) as f64) / 1000.0,
            max_mute: REFERENCE_MAX_MUTE_S,
            max_audible_tail: AudibleTail::fixed(REFERENCE_MAX_AUDIBLE_TAIL_S),
        };
    }

    // pre_pad/post_pad: минимум, только для компенсации джиттера модели.
    // merge_gap: очень маленький — каждое слово получает собственный плавный мут,
    // иначе близкие маты сливаются в один большой бип и не слышно, какое слово.
    // Пады шире джиттера ASR (~20-30 мс), иначе конец слова «выскакивает» из мута.
    // merge_gap 60 мс: паузы короче не дают услышать речь между мутами,
    // а частичный подъём огибающей в такой паузе звучит как заикание.
    let (pre_pad, post_pad, merge_gap) = match settings.mode {
        FetchrMuteProcessingMode::Precise => (0.030, 0.022, 0.060),
        FetchrMuteProcessingMode::Normal => (0.035, 0.028, 0.060),
    };
    SpanTiming {
        pre_pad,
        post_pad,
        merge_gap: Some(merge_gap),
        coverage: (settings.coverage_percent.clamp(20, 100) as f64) / 100.0,
        uncovered_lead_share: UNCOVERED_LEAD_SHARE,
        internal_fades: false,
        fade_guard: 0.0,
        fade_in_guard: 0.0,
        min_mute: MIN_SPAN_S,
        max_mute: f64::INFINITY,
        max_audible_tail: AudibleTail::fixed(REFERENCE_MAX_AUDIBLE_TAIL_S),
    }
}

/// Паддинги для ручных спанов из панели правок: те же, что у авто-спанов,
/// чтобы ручной мут звучал одинаково плавно (границы слова не «выскакивают»).
pub fn manual_span_padding(settings: &FetchrMuteSettings) -> (f64, f64) {
    let timing = span_timing(settings);
    (timing.pre_pad, timing.post_pad)
}

/// Вычисляет границы заглушки для одного слова.
///
/// Даже при частичном покрытии заглушка начинается с safety-padded начала
/// слова. Так первые узнаваемые фонемы мата никогда не успевают прозвучать;
/// ползунок покрытия оставляет слышимым только хвост слова.
#[cfg(test)]
fn covered_word_span(word: &WordHit, coverage: f64, pre_pad: f64, post_pad: f64) -> (f64, f64) {
    covered_word_span_for_timing(
        word,
        coverage,
        pre_pad,
        post_pad,
        UNCOVERED_LEAD_SHARE,
        false,
        0.0,
        0.0,
        MIN_SPAN_S,
        f64::INFINITY,
        AudibleTail::fixed(REFERENCE_MAX_AUDIBLE_TAIL_S),
    )
}

fn covered_word_span_for_timing(
    word: &WordHit,
    coverage: f64,
    pre_pad: f64,
    post_pad: f64,
    uncovered_lead_share: f64,
    internal_fades: bool,
    fade_guard: f64,
    fade_in_guard: f64,
    min_mute: f64,
    max_mute: f64,
    max_audible_tail: AudibleTail,
) -> (f64, f64) {
    let coverage = coverage.clamp(0.2, 1.0);
    let (emission_start, emission_end) = acoustic_word_bounds(word);
    let word_start = emission_start;
    let word_end = emission_end.max(word_start + MIN_SPAN_S);
    let word_duration = word_end - word_start;
    let covered_duration = (word_duration * coverage)
        .clamp(min_mute.min(max_mute), max_mute)
        .min(word_duration);
    let uncovered_duration = word_duration - covered_duration;
    let (core_start, core_end) = if internal_fades {
        // The renderer applies fade-out before core_start and fade-in after
        // core_end. Start the 100 ms reference fade at the word onset, retain
        // the requested central coverage, and keep at most a short harmless
        // tail. This mirrors the supplied reference audio without swallowing
        // the whole ASR interval.
        let maximum_core_end = (word_end - fade_in_guard).max(word_start + 0.005);
        let available = (maximum_core_end - word_start).max(0.005);
        let minimum_core = min_mute.min(available);
        let core_start = (word_start + fade_guard).min(maximum_core_end - minimum_core);
        let desired_core = covered_duration.min(maximum_core_end - core_start);
        let tail_limited_end = maximum_core_end - max_audible_tail.for_word(word_duration);
        let core_end = (core_start + desired_core)
            .max(tail_limited_end)
            .min(core_start + max_mute)
            .min(maximum_core_end);
        (core_start, core_end.max(core_start + 0.005))
    } else {
        let start = (word_start + uncovered_duration.max(0.0) * uncovered_lead_share).max(0.0);
        (start, start + covered_duration)
    };

    let start = (core_start - pre_pad).max(0.0);
    let end = (core_end + post_pad).max(start + 0.005);
    (start, end)
}

fn acoustic_word_bounds(word: &WordHit) -> (f64, f64) {
    let start = word.start.max(0.0);
    let end = word.end.max(start + MIN_SPAN_S);
    (start, end)
}

fn context_boundary(left: &WordHit, right: &WordHit) -> f64 {
    let (_, left_end) = acoustic_word_bounds(left);
    let (right_start, _) = acoustic_word_bounds(right);
    (left_end + right_start) * 0.5
}

fn clamp_span_to_context(
    mut start: f64,
    mut end: f64,
    first_muted: &WordHit,
    last_muted: &WordHit,
    previous_context: Option<&WordHit>,
    next_context: Option<&WordHit>,
    minimum_span: f64,
) -> (f64, f64) {
    let context_start = previous_context
        .map(|previous| context_boundary(previous, first_muted))
        .unwrap_or(0.0);
    let context_end = next_context
        .map(|next| context_boundary(last_muted, next))
        .unwrap_or(f64::INFINITY);
    start = start.max(context_start);
    end = end.min(context_end);

    if end < start + minimum_span {
        let (acoustic_start, _) = acoustic_word_bounds(first_muted);
        let (_, acoustic_end) = acoustic_word_bounds(last_muted);
        let available = context_end - context_start;
        if available >= minimum_span {
            let center = (acoustic_start + acoustic_end) * 0.5;
            start = (center - minimum_span * 0.5).clamp(context_start, context_end - minimum_span);
            end = start + minimum_span;
        } else {
            // Pathological overlapping timestamps: preserving neighbouring
            // speech is more important than forcing a 50 ms mute.
            start = context_start.max(0.0);
            end = context_end.max(start + 0.005);
        }
    }
    (start.max(0.0), end.max(start + 0.005))
}

fn covered_word_span_with_context(
    word: &WordHit,
    previous_context: Option<&WordHit>,
    next_context: Option<&WordHit>,
    coverage: f64,
    pre_pad: f64,
    post_pad: f64,
    uncovered_lead_share: f64,
    internal_fades: bool,
    fade_guard: f64,
    fade_in_guard: f64,
    min_mute: f64,
    max_mute: f64,
    max_audible_tail: AudibleTail,
) -> (f64, f64) {
    let (start, end) = covered_word_span_for_timing(
        word,
        coverage,
        pre_pad,
        post_pad,
        uncovered_lead_share,
        internal_fades,
        fade_guard,
        fade_in_guard,
        min_mute,
        max_mute,
        max_audible_tail,
    );

    if internal_fades {
        // Reference ramps belong to the censored word, not its neighbours.
        // GigaAM timestamps can overlap by about 20 ms, so protect the entire
        // neighbouring ASR interval (including the ramp), not just its midpoint.
        let protected_start = previous_context
            .map(|previous| acoustic_word_bounds(previous).1 + fade_guard)
            .unwrap_or(0.0);
        let protected_end = next_context
            .map(|next| (acoustic_word_bounds(next).0 - fade_in_guard).max(0.0))
            .unwrap_or(f64::INFINITY);
        let guarded_start = start.max(protected_start);
        let guarded_end = end.min(protected_end);
        if guarded_end >= guarded_start + 0.005 {
            return (guarded_start, guarded_end);
        }
    }

    clamp_span_to_context(
        start,
        end,
        word,
        word,
        previous_context,
        next_context,
        min_mute.min((word.end - word.start).max(0.005)),
    )
}

/// Чистые основы, внутри которых корневые подстроки встречаются случайно:
/// «психуешь», «страхует» (хуе), «гребли», «загребал» (ебли/ебал),
/// «курвиметр», «курвуазье», «ебонит», «скипидар». Основа заменяется разделителем до
/// проверки корней, поэтому корень, пересекающий её, больше не находится.
///
/// Глаголы на «-блять» от «-бить» (оскорбить → оскорблять, употребить →
/// употреблять) содержат «блят» на стыке основы и суффикса. Их основы
/// перечислены до «бл» включительно: «за-», «вы-», «по-» и прочие приставки
/// реального мата («заблядовать», «выблядок») и слитные «нублять» с ними не
/// пересекаются, поэтому мат по корню находится как раньше.
const CLEAN_STEMS: &[&str] = &[
    "псих",
    "страх",
    "греб",
    "курвимет",
    "курвуаз",
    "ебонит",
    "скипидар",
    "скорбл",
    "требл",
    "слабл",
    "глубл",
    "сугубл",
    "злобл",
    "подобл",
    "дробл",
    "собл",
    "любл",
    "грубл",
];

fn is_russian_profane_root(word: &str) -> bool {
    if CLEAN_STEMS.iter().any(|stem| word.contains(stem)) {
        let mut masked = word.to_string();
        for stem in CLEAN_STEMS {
            masked = masked.replace(stem, "|");
        }
        return profane_root_in(&masked);
    }
    profane_root_in(word)
}

fn profane_root_in(word: &str) -> bool {
    // 1. Root: хуй / хуе / хуи / хуя / хуё / хули
    if (word.contains("хуй")
        || word.contains("хуя")
        || word.contains("хуе")
        || word.contains("хуи")
        || word.contains("хуня"))
        && !word.contains("хулиган")
        && !word.contains("хуисус")
    {
        return true;
    }
    if word == "хули" {
        return true;
    }

    // 2. Root: пизд / пизж
    if word.contains("пизд") || word.contains("пизж") {
        return true;
    }

    // 3. Root: бля
    if word == "бля" || word == "бляь" || word.contains("бляд") || word.contains("блят")
    {
        return true;
    }

    // 4. Root: еб / ёб
    // Clean words starting with "еб" or "ёб" do not exist in Russian.
    if word.starts_with("еб") || word.starts_with("ёб") {
        return true;
    }
    if word.contains("заеб")
        || word.contains("выеб")
        || word.contains("наеб")
        || word.contains("проеб")
        || word.contains("съеб")
        || word.contains("уеб")
        || word.contains("разъеб")
        || word.contains("поеб")
        || word.contains("перееб")
        || word.contains("приеб")
        || word.contains("доеб")
        || word.contains("объеб")
        || word.contains("отъеб")
        || word.contains("подъеб")
        || word.contains("въеб")
        || word.contains("ебаш")
        || word.contains("ебуч")
        || word.contains("ебош")
        || (word.contains("ебли") && !word.contains("стебли"))
        || (word.contains("ебал")
            && !word.contains("колебал")
            && !word.contains("xлебал")
            && !word.contains("хлебал"))
    {
        return true;
    }
    if word.contains("долбоеб") || word.contains("долбоящ") {
        return true;
    }

    // 5. Additional obscene root. "сука" and "дебил" are deliberately not
    // censored by the standard profile; users can still add them manually.
    if word.contains("дроч") {
        return true;
    }

    // 6. Other common roots: залуп, мудак, мудил, шлюх, ублюд, пидор, пидар, гондон, гандон, манда (except мандарин/мандат)
    if word.contains("залуп")
        || word.contains("мудак")
        || word.contains("мудил")
        || word.contains("шлюх")
        || word.contains("ублюд")
        || word.contains("пидор")
        || word.contains("пидар")
        || word.contains("гондон")
        || word.contains("гандон")
    {
        return true;
    }
    if (word.starts_with("манда") || word.starts_with("мандо"))
        && !word.starts_with("мандарин")
        && !word.starts_with("мандат")
        && !word.starts_with("мандал")
        && !word.starts_with("мандол")
    {
        return true;
    }

    // 7. Additional requested slang/insult words: пенис, даун
    if word.starts_with("пенис") && !word.starts_with("пенист") {
        return true;
    }
    // «даун» принимается только с реальным русским окончанием. Список
    // исключений (даунгрейд, даунтаун, …) не закрывал случайные склейки вроде
    // «да у нас» → «даунас», поэтому проверяется сам остаток слова.
    if let Some(ending) = word.strip_prefix("даун") {
        const DAUN_ENDINGS: &[&str] = &[
            "", "а", "ам", "ами", "ах", "е", "ов", "ом", "у", "ы", "енок", "енка", "изм", "изма",
            "изме", "ский", "ская", "ские", "ском",
        ];
        if DAUN_ENDINGS.contains(&ending) {
            return true;
        }
    }

    // 8. Словарные семейства, у которых раньше не было корневого правила
    // (252 из 844 записей wordlist): при слитной транскрипции («прямвжопу»)
    // или неточном написании ASR точное совпадение на Standard не срабатывало
    // и слово полностью пропускалось. Чистых русских слов с этими подстроками
    // нет; «епт» — только как префикс, чтобы не задеть «рептилия».
    if word.contains("говн")
        || word.contains("жоп")
        || word.contains("мраз")
        || word.contains("курв")
    {
        return true;
    }
    if word.starts_with("епт") {
        return true;
    }

    false
}

/// Вид совпадения слова с мат-словарём. От вида зависит порог уверенности:
/// точное/корневое совпадение — сильный сигнал и допускает низкую confidence,
/// fuzzy (Левенштейн ≤1) и фонетика — слабые, требуют высокой.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ProfaneMatchKind {
    /// Точное попадание в словарь (включая схлопнутые повторы букв).
    Exact,
    /// Встроенная корневая эвристика (is_russian_profane_root).
    Root,
    /// Написание ASR в пределах Левенштейна ≤1 от словарной записи.
    Fuzzy,
    /// Фонетический ключ совпал: безударные гласные/знаки, которые ASR
    /// систематически путает («ибал» вместо «ебал»).
    Phonetic,
}

pub(crate) fn profane_match_kind(
    normalized: &str,
    profane_words: &ProfaneDictionary,
    settings: &FetchrMuteSettings,
) -> Option<ProfaneMatchKind> {
    if profane_words.contains(normalized) {
        return Some(ProfaneMatchKind::Exact);
    }

    // «Мягкий» — только точные словарные совпадения, у всех профилей.
    if matches!(settings.censorship_level, FetchrMuteCensorshipLevel::Soft) {
        return None;
    }

    // Repeated spellings are common both in speech and in manual dictionaries.
    let collapsed = collapse_repeated_chars(normalized);
    if collapsed != normalized && profane_words.contains(&collapsed) {
        return Some(ProfaneMatchKind::Exact);
    }

    let is_ru = matches!(settings.language, FetchrMuteLanguage::Ru);
    let allow_builtin_heuristics = !settings.only_custom_words;
    if allow_builtin_heuristics
        && is_ru
        && (is_russian_profane_root(normalized)
            || (collapsed != normalized && is_russian_profane_root(&collapsed)))
    {
        return Some(ProfaneMatchKind::Root);
    }

    // Fuzzy и фонетика — только «Строгий» и «Максимум», в том числе у
    // «Адаптивного». На «Стандарте» они глушили чистые слова: «блат» →
    // «блять», «сечка» → «сучка», «блеять» → «блять».
    if matches!(
        settings.censorship_level,
        FetchrMuteCensorshipLevel::Standard
    ) {
        return None;
    }

    // Strict и Maximum additionally accept ASR spellings within Levenshtein
    // distance 1 (оба слова ≥5 букв, совпадающая первая буква — отсекает
    // случайные чистые слова вроде «худо»).
    if fuzzy_profane_match(normalized, profane_words)
        || (collapsed != normalized && fuzzy_profane_match(&collapsed, profane_words))
    {
        return Some(ProfaneMatchKind::Fuzzy);
    }

    // Фонетика: ASR регулярно путает безударные гласные и ь/ъ («ибать» вместо
    // «ебать», «хуи»/«хуе», «бляь»), что Левенштейн ≤1 не покрывает, если замен
    // несколько или перепутана первая буква. Ключ считается от обеих сторон;
    // слова короче 5 букв не участвуют (как и в fuzzy) — слишком легко
    // сталкиваются с чистыми словами. Ложные срабатывания возможны (напр.
    // «драчка» → «дрочка»), поэтому уровень — только Strict/Maximum.
    // Четырёхбуквенные ключи сталкиваются с чистыми словами («блат» → «блят»).
    if normalized.chars().count() >= 5
        && profane_words.contains_phonetic_key(&phonetic_key(normalized))
    {
        return Some(ProfaneMatchKind::Phonetic);
    }

    None
}

fn is_profane_match(
    normalized: &str,
    profane_words: &ProfaneDictionary,
    settings: &FetchrMuteSettings,
) -> bool {
    profane_match_kind(normalized, profane_words, settings).is_some()
}

/// Fuzzy-совпадение со словарём: Левенштейн ≤1, оба слова ≥5 букв,
/// первая буква обязана совпадать, разница длин ≤1.
///
/// Кандидаты приходят из индекса удалений, а не перебором словаря; сами
/// проверки оставлены прежними, чтобы результат не изменился.
fn fuzzy_profane_match(word: &str, profane_words: &ProfaneDictionary) -> bool {
    let wc: Vec<char> = word.chars().collect();
    let n = wc.len();
    if n < FUZZY_MIN_LEN {
        return false;
    }
    let first = wc[0];
    profane_words
        .fuzzy_candidates(&wc)
        .into_iter()
        .any(|candidate| {
            let entry = &profane_words.fuzzy_entries[candidate as usize];
            // Дешёвые отсечки до посимвольного сравнения: первая буква и байтовая
            // длина (кириллица 2 байта/символ, diff >3 байт → diff >1 символа).
            if entry.chars.first() != Some(&first) {
                return false;
            }
            if (entry.bytes as isize - word.len() as isize).abs() > 3 {
                return false;
            }
            let dc = &entry.chars;
            let m = dc.len();
            m >= FUZZY_MIN_LEN
                && (n as isize - m as isize).abs() <= 1
                && levenshtein_le1(&wc, dc)
                && edit_is_plausible_asr_slip(&wc, dc)
                && !is_ehat_family_substitution(&wc, dc)
        })
}

/// Защита от систематического ложного срабатывания fuzzy: вся семья
/// «ехать» (ехать, уехать, поехали, наехал, …) отличается от соответствующей
/// семьи «-ебать» ровно одной заменой х→б в той же позиции. Это частотные
/// чистые слова с высокой confidence ASR — на Strict/Maximum они бы
/// заглушались. Буквы «х» и «б» акустически не похожи, поэтому реальный мат
/// ASR в форму с «х» практически не превращает: считаем такое единственное
/// различие чистым словом, а не ошибкой распознавания.
fn is_ehat_family_substitution(word: &[char], dict: &[char]) -> bool {
    if word.len() != dict.len() {
        return false;
    }
    let mut diff = None;
    for (i, (w, d)) in word.iter().zip(dict.iter()).enumerate() {
        if w != d {
            if diff.is_some() {
                return false;
            }
            diff = Some(i);
        }
    }
    match diff {
        Some(i) => word[i] == 'х' && dict[i] == 'б',
        None => false,
    }
}

/// true, если расстояние Левенштейна ≤1 (равенство тоже true).
fn levenshtein_le1(a: &[char], b: &[char]) -> bool {
    if a.len() == b.len() {
        // 0 или ровно одна замена
        let mut diff = 0;
        for (x, y) in a.iter().zip(b.iter()) {
            if x != y {
                diff += 1;
                if diff > 1 {
                    return false;
                }
            }
        }
        true
    } else {
        // Одна вставка/удаление: длины должны отличаться ровно на 1
        let (short, long) = if a.len() < b.len() { (a, b) } else { (b, a) };
        if long.len() - short.len() != 1 {
            return false;
        }
        let mut i = 0;
        while i < short.len() && short[i] == long[i] {
            i += 1;
        }
        short[i..] == long[i + 1..]
    }
}

/// Фонетический ключ: складывает типичные перепутывания GigaAM — безударные
/// гласные (е/и/э/ы → е, о/я → а, ю → у) и знаки ь/ъ — в одну каноническую
/// форму. Два написания с одинаковым ключом для ASR звучат одинаково
/// («ибал» и «ебал» → «ебал», «хуи» и «хуе» → «хуе»).
fn phonetic_key(word: &str) -> String {
    word.chars()
        .filter_map(|ch| match ch {
            'и' | 'э' | 'ы' => Some('е'),
            'о' | 'я' => Some('а'),
            'ю' => Some('у'),
            'ь' | 'ъ' => None,
            _ => Some(ch),
        })
        .collect()
}

pub fn summarize_matched_spans(spans: &[MuteSpan]) -> String {
    const MAX_LOGGED_SPANS: usize = 12;
    let mut parts = spans
        .iter()
        .take(MAX_LOGGED_SPANS)
        .map(|span| format!("{} [{:.2}-{:.2}s]", span.word, span.start, span.end))
        .collect::<Vec<_>>();
    if spans.len() > MAX_LOGGED_SPANS {
        parts.push(format!("+{} more", spans.len() - MAX_LOGGED_SPANS));
    }
    parts.join(", ")
}

pub fn collapse_repeated_chars(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut prev = None;
    for ch in value.chars() {
        if Some(ch) != prev {
            out.push(ch);
            prev = Some(ch);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Сквозной прогон на реальном файле FETCHR_MUTE_EVAL_DIR/clip15.m4a:
    /// подготовка аудио, ASR, перепроверка. Пишет pipeline_words.json —
    /// дальше `eval_dump_spans` строит по нему спаны (FETCHR_MUTE_EVAL_WORDS).
    #[test]
    #[ignore]
    fn eval_full_pipeline() {
        let dir = PathBuf::from(std::env::var("FETCHR_MUTE_EVAL_DIR").expect("FETCHR_MUTE_EVAL_DIR"));
        let ffmpeg = PathBuf::from(std::env::var("FETCHR_MUTE_EVAL_FFMPEG").expect("FETCHR_MUTE_EVAL_FFMPEG"));
        let input = dir.join("clip15.m4a");
        let wav = dir.join("pipeline16k.wav");
        let settings = FetchrMuteSettings::default();
        let queue = Arc::new(QueueManager::new_mock(crate::app_log::AppLogger::new()));
        let cancel = Arc::new(AtomicBool::new(false));
        let runtime = tokio::runtime::Runtime::new().unwrap();
        let model_root = crate::jobs::asr_models::model_root(settings.asr_model);
        let started = Instant::now();
        let words = runtime.block_on(async {
            ensure_model(&queue, "eval", &model_root, settings.asr_model, false, cancel.clone())
                .await
                .unwrap();
            let silences = convert_to_wav_for_profile(&ffmpeg, &input, &wav, cancel.clone(), settings.mute_profile, 0)
                .await
                .unwrap();
            let dictionary = load_profane_words(&settings).unwrap();
            let hotwords = dictionary.hotwords();
            let asr_started = Instant::now();
            let words = transcribe_wav_blocking(
                &queue, "eval", &model_root, &wav, &silences, &hotwords, cancel.clone(),
                settings.mode, settings.language, settings.asr_model,
            )
            .unwrap();
            eprintln!("ASR: {} words in {:.1}s", words.len(), asr_started.elapsed().as_secs_f64());
            let verify_started = Instant::now();
            let words = verify_words_blocking(
                &queue, "eval", &model_root, &ffmpeg, &input, &wav, &dir, words, &dictionary,
                &settings, cancel.clone(),
            )
            .await
            .unwrap();
            eprintln!("verify: {:.1}s", verify_started.elapsed().as_secs_f64());
            words
        });
        eprintln!("total: {:.1}s", started.elapsed().as_secs_f64());
        let verified: Vec<_> = words.iter().filter(|word| word.verified.is_some()).collect();
        for word in &verified {
            eprintln!("  {:>12} {:.2}-{:.2} c={:.2} verified={:?}", word.raw, word.start, word.end, word.confidence, word.verified);
        }
        eprintln!("lemmas: {}", words.iter().filter(|word| word.lemma.is_some()).count());
        std::fs::write(dir.join("pipeline_words.json"), serde_json::to_string(&words).unwrap()).unwrap();
    }

    /// Офлайн-оценка на реальном материале: FETCHR_MUTE_EVAL_DIR с
    /// rnnt_words.json и asr16k.wav. Пишет spans_<name>.json для скрипта метрик.
    #[test]
    #[ignore]
    fn eval_dump_spans() {
        let dir = PathBuf::from(std::env::var("FETCHR_MUTE_EVAL_DIR").expect("FETCHR_MUTE_EVAL_DIR"));
        #[derive(serde::Deserialize)]
        struct Raw {
            raw: String,
            start: f64,
            end: f64,
            confidence: f32,
        }
        let pipeline_words = std::env::var("FETCHR_MUTE_EVAL_WORDS").ok().map(|name| {
            serde_json::from_str::<Vec<WordHit>>(&std::fs::read_to_string(dir.join(name)).unwrap()).unwrap()
        });
        let raw: Vec<Raw> = if pipeline_words.is_some() {
            Vec::new()
        } else {
            serde_json::from_str(&std::fs::read_to_string(dir.join("rnnt_words.json")).unwrap()).unwrap()
        };
        let mut words: Vec<WordHit> = raw
            .into_iter()
            .map(|word| WordHit {
            lemma: None,
            verified: None,
                normalized: normalize_word(&word.raw),
                raw: word.raw,
                start: word.start,
                end: word.end,
                confidence: word.confidence,
            })
            .filter(|word| !word.normalized.is_empty())
            .collect();
        if let Some(pipeline_words) = pipeline_words {
            words = pipeline_words;
        }
        words.sort_by(|a, b| a.start.total_cmp(&b.start));
        let envelope = read_wav_envelope_db(&dir.join(std::env::var("FETCHR_MUTE_EVAL_ENV").unwrap_or("asr16k.wav".into())), SAMPLE_RATE).unwrap();
        let variants: Vec<(&str, FetchrMuteProfile, u8)> = vec![
            ("adaptive50", FetchrMuteProfile::Adaptive, 50),
            ("adaptive100", FetchrMuteProfile::Adaptive, 100),
            ("sealed100", FetchrMuteProfile::Sealed, 100),
            ("reference100", FetchrMuteProfile::Reference, 100),
            ("classic100", FetchrMuteProfile::Classic, 100),
        ];
        for (name, profile, coverage) in variants {
            let settings = FetchrMuteSettings {
                mute_profile: profile,
                coverage_percent: coverage,
                ..FetchrMuteSettings::default()
            };
            let dictionary = load_profane_words(&settings).unwrap();
            let spans = build_mute_spans(&words, &dictionary, &settings);
            let spans = refine_sealed_spans_with_envelope(spans, &words, &envelope, &settings);
            let (fade_out, fade_in) = reference_fade_seconds(&settings);
            let out = serde_json::json!({
                "fade_out": if matches!(profile, FetchrMuteProfile::Classic) { FADE_S } else { fade_out },
                "fade_in": if matches!(profile, FetchrMuteProfile::Classic) { FADE_S } else { fade_in },
                "offset": estimate_asr_offset(&words, &envelope, SEALED_ENVELOPE_HOP_S),
                "spans": spans,
            });
            std::fs::write(dir.join(format!("spans_{name}.json")), out.to_string()).unwrap();
        }
    }

    #[test]
    fn streamed_envelope_matches_the_in_memory_one_exactly() {
        let path = std::env::temp_dir().join(format!(
            "fetchr-envelope-{}-{}.wav",
            std::process::id(),
            line!()
        ));
        let spec = hound::WavSpec {
            channels: 1,
            sample_rate: SAMPLE_RATE,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };
        let mut writer = hound::WavWriter::create(&path, spec).expect("create wav");
        // 2.345 s: several full hops plus a partial last one.
        for index in 0..(SAMPLE_RATE as usize * 2345 / 1000) {
            let value = ((index as f32 * 0.013).sin() * 12_000.0) as i16;
            writer.write_sample(value).expect("write sample");
        }
        writer.finalize().expect("finalize wav");

        let streamed = read_wav_envelope_db(&path, SAMPLE_RATE).expect("streamed envelope");
        let in_memory =
            energy_envelope_db(&read_wav_samples(&path).expect("read samples"), SAMPLE_RATE);
        let _ = std::fs::remove_file(&path);
        assert_eq!(streamed.len(), in_memory.len());
        assert!(streamed.iter().zip(&in_memory).all(|(a, b)| a.to_bits() == b.to_bits()));
    }

    #[test]
    fn speech_preselection_is_fast_and_does_not_require_onnx_vad() {
        let mut audio = vec![0.0f32; SAMPLE_RATE as usize * 10];
        for (index, sample) in audio[SAMPLE_RATE as usize..SAMPLE_RATE as usize * 4]
            .iter_mut()
            .enumerate()
        {
            *sample = 0.05 * (2.0 * std::f32::consts::PI * 180.0 * index as f32 / 16_000.0).sin();
        }
        let queue = Arc::new(QueueManager::new_mock(crate::app_log::AppLogger::new()));
        let started = Instant::now();
        let segments = detect_speech_segments(
            SpeechLevels::Full(&audio),
            &[],
            &queue,
            "energy-vad-test",
            Arc::new(AtomicBool::new(false)),
            FetchrMuteProcessingMode::Precise,
        )
        .expect("energy speech detection");

        assert!(!segments.is_empty());
        assert!(segments
            .iter()
            .all(|segment| segment.end_sample > segment.start_sample));
        assert!(
            segments[0].start_sample <= SAMPLE_RATE as usize * 4 / 5,
            "speech onset needs enough lead context for the first consonant"
        );
        assert!(started.elapsed() < Duration::from_secs(1));
    }

    #[test]
    fn maximum_level_does_not_match_substrings() {
        let settings = FetchrMuteSettings {
            censorship_level: FetchrMuteCensorshipLevel::Maximum,
            ..FetchrMuteSettings::default()
        };
        let profane_words = ProfaneDictionary::from(["badword".to_string()]);

        assert!(!is_profane_match(
            "prefixbadwordsuffix",
            &profane_words,
            &settings
        ));
    }

    #[test]
    fn strict_level_matches_repeated_letters_only() {
        let settings = FetchrMuteSettings {
            censorship_level: FetchrMuteCensorshipLevel::Strict,
            ..FetchrMuteSettings::default()
        };
        let profane_words = ProfaneDictionary::from(["badword".to_string()]);

        assert!(is_profane_match("baadword", &profane_words, &settings));
    }

    #[test]
    fn fuzzy_matches_misheard_dictionary_words() {
        let settings = FetchrMuteSettings {
            censorship_level: FetchrMuteCensorshipLevel::Maximum,
            ..FetchrMuteSettings::default()
        };

        // Одна замена внутри слова — ловим
        let profane_words = ProfaneDictionary::from(["долбоящер".to_string()]);
        assert!(is_profane_match("долбаящер", &profane_words, &settings));

        // Первая буква не совпадает — не матчим (защита от «мука/сука»)
        let profane_words = ProfaneDictionary::from(["мудак".to_string()]);
        assert!(!is_profane_match("судак", &profane_words, &settings));

        // Короткие слова (<5 букв) в fuzzy не участвуют
        let profane_words = ProfaneDictionary::from(["очко".to_string()]);
        assert!(!is_profane_match("очка", &profane_words, &settings));
    }

    #[test]
    fn fuzzy_skips_ehat_family_clean_words() {
        // Семья «ехать» отличается от «-ебать» одной заменой х→б: это частотные
        // чистые слова, их нельзя глушить ни на одном уровне (поймано на
        // реальных транскриптах: «уехать» conf=0.99, «ехать» conf=0.98).
        let settings = FetchrMuteSettings {
            censorship_level: FetchrMuteCensorshipLevel::Maximum,
            ..FetchrMuteSettings::default()
        };
        let profane_words = ProfaneDictionary::from([
            "ебать".to_string(),
            "уебать".to_string(),
            "поебали".to_string(),
            "наебать".to_string(),
        ]);
        for clean in ["ехать", "уехать", "поехали", "наехать"] {
            assert!(
                !is_profane_match(clean, &profane_words, &settings),
                "clean word {clean} must not be muted"
            );
        }

        // При этом другие одиночные замены/вставки по-прежнему ловятся:
        // «срень» → «срань» (замена е→а), «охенно» → «охуенно» (вставка у).
        let profane_words = ProfaneDictionary::from(["срань".to_string(), "охуенно".to_string()]);
        assert!(is_profane_match("срень", &profane_words, &settings));
        assert!(is_profane_match("охенно", &profane_words, &settings));
    }

    #[test]
    fn phonetic_matches_vowel_confusions_on_strict() {
        let settings = FetchrMuteSettings {
            censorship_level: FetchrMuteCensorshipLevel::Strict,
            ..FetchrMuteSettings::default()
        };
        // Безударная е↔и в начале слова: Левенштейн не помогает (первая буква
        // обязана совпадать), фонетический ключ ловит.
        let profane_words = ProfaneDictionary::from(["ебать".to_string()]);
        assert_eq!(
            profane_match_kind("ибать", &profane_words, &settings),
            Some(ProfaneMatchKind::Phonetic)
        );
        // О↔А внутри слова: «гавна» звучит как «говно».
        let profane_words = ProfaneDictionary::from(["говно".to_string()]);
        assert!(is_profane_match("гавна", &profane_words, &settings));
        // Ключи короче 5 букв в фонетику не идут (как и в fuzzy):
        // «очка»↔«очко» не матчится, «хуе» ловится только корнем.
        let profane_words = ProfaneDictionary::from(["очко".to_string()]);
        let maximum = FetchrMuteSettings {
            censorship_level: FetchrMuteCensorshipLevel::Maximum,
            ..FetchrMuteSettings::default()
        };
        assert!(!is_profane_match("очка", &profane_words, &maximum));
        let profane_words = ProfaneDictionary::from(["хуй".to_string()]);
        assert!(!matches!(
            profane_match_kind("хуе", &profane_words, &settings),
            Some(ProfaneMatchKind::Phonetic)
        ));
        // Standard фонетику не использует.
        let standard = FetchrMuteSettings::default();
        let profane_words = ProfaneDictionary::from(["говно".to_string()]);
        assert!(!is_profane_match("гавна", &profane_words, &standard));
    }

    #[test]
    fn hotwords_keep_only_words_the_model_alphabet_can_spell() {
        let dictionary = ProfaneDictionary::new(
            ["хуй", "бля", "ху", "fuck", "х0й", "ёбаный"]
                .into_iter()
                .map(str::to_string)
                .collect(),
        );
        // «ху» короче трёх букв; «fuck», «х0й» и «ёбаный» не собираются из
        // tokens.txt — там 33 буквы без «ё». Настоящий словарь приходит уже
        // нормализованным (ё→е), фильтр здесь страхует от чужих источников.
        assert_eq!(dictionary.hotwords(), vec!["бля", "хуй"]);
    }

    #[test]
    fn standard_level_matches_wordlist_families_without_fuzz() {
        let settings = FetchrMuteSettings::default();
        let profane_words = ProfaneDictionary::default();
        for word in ["говняный", "прямвжопу", "мразота", "курвился", "епта"]
        {
            assert!(
                is_profane_match(word, &profane_words, &settings),
                "standard mode missed {word}"
            );
        }
        // Префиксная защита: «рептилия» — чистое слово.
        assert!(!is_profane_match("рептилия", &profane_words, &settings));
    }

    #[test]
    fn standard_level_does_not_censor_unlisted_root_names() {
        let settings = FetchrMuteSettings::default();
        let profane_words = ProfaneDictionary::from(["хуй".to_string()]);
        assert!(!is_profane_match("хуисус", &profane_words, &settings));
    }

    #[test]
    fn standard_level_matches_recognized_profane_inflections() {
        let settings = FetchrMuteSettings::default();
        let profane_words = ProfaneDictionary::default();
        for word in [
            "пиздатых",
            "охуею",
            "пиздоболы",
            "ебаными",
            "хуеплетами",
            "нихуя",
            "допиздишься",
            "хули",
            "бляь",
            "дрочить",
        ] {
            assert!(
                is_profane_match(word, &profane_words, &settings),
                "standard mode missed {word}"
            );
        }
    }

    #[test]
    fn split_ctc_fragments_are_joined_for_profanity_matching() {
        let settings = FetchrMuteSettings::default();
        let profane_words = ProfaneDictionary::default();
        let words = vec![
            WordHit {
            lemma: None,
            verified: None,
                raw: "ху".to_string(),
                normalized: "ху".to_string(),
                start: 96.66,
                end: 96.86,
                confidence: 0.99,
            },
            WordHit {
            lemma: None,
            verified: None,
                raw: "еву".to_string(),
                normalized: "еву".to_string(),
                start: 96.84,
                end: 97.40,
                confidence: 0.91,
            },
        ];

        let spans = build_mute_spans(&words, &profane_words, &settings);
        assert_eq!(spans.len(), 1);
        assert_eq!(spans[0].word, "ху еву");
    }

    #[test]
    fn triple_ctc_fragments_are_joined_for_profanity_matching() {
        // CTC иногда рвёт слово на три токена («ху» + «ё» + «вый») — такая
        // склейка тоже должна восстанавливаться.
        let settings = FetchrMuteSettings::default();
        let profane_words = ProfaneDictionary::from(["хуёвый".to_string()]);
        let mk = |raw: &str, start: f64, end: f64| WordHit {
            lemma: None,
            verified: None,
            raw: raw.to_string(),
            normalized: raw.to_string(),
            start,
            end,
            confidence: 0.95,
        };
        let words = vec![
            mk("ну", 10.0, 10.3),
            mk("ху", 10.4, 10.55),
            mk("ё", 10.55, 10.65),
            mk("вый", 10.65, 11.0),
            mk("как", 11.5, 11.9),
        ];
        let spans = build_mute_spans(&words, &profane_words, &settings);
        assert_eq!(spans.len(), 1);
        assert_eq!(spans[0].word, "ху ё вый");
    }

    #[test]
    fn long_neighbours_are_never_joined_into_a_match() {
        // Реальный материал: «картинку» (conf 0.93) + «рвет» (0.99) в беглой
        // речи идут вплотную, склеиваются в «картинкурвет», и корень «курв»
        // ложится ровно на шов. Осколок разорванного слова таким длинным
        // не бывает.
        let settings = FetchrMuteSettings::default();
        let profane_words = ProfaneDictionary::default();
        let mk = |raw: &str, start: f64, end: f64, confidence: f32| WordHit {
            lemma: None,
            verified: None,
            raw: raw.to_string(),
            normalized: raw.to_string(),
            start,
            end,
            confidence,
        };
        let words = vec![
            mk("картинку", 35.61, 36.15, 0.925),
            mk("рвет", 36.13, 36.51, 0.991),
        ];
        assert!(build_mute_spans(&words, &profane_words, &settings).is_empty());

        // Короткие осколки настоящего мата по-прежнему склеиваются.
        let split = vec![mk("уе", 345.4, 345.6, 0.95), mk("бок", 345.58, 345.9, 0.95)];
        assert_eq!(
            build_mute_spans(&split, &profane_words, &settings).len(),
            1
        );
    }

    #[test]
    fn fuzzy_accepts_vowel_slips_but_not_early_consonant_swaps() {
        // Поймано на реальном материале: обе замены дают частотное чистое
        // слово, распознанное уверенно (0.94 и 1.00), — порогом не отсечь.
        let settings = FetchrMuteSettings {
            censorship_level: FetchrMuteCensorshipLevel::Maximum,
            only_custom_words: true,
            ..FetchrMuteSettings::default()
        };
        let kurve = ProfaneDictionary::from(["курве".to_string()]);
        assert!(!is_profane_match("курсе", &kurve, &settings));
        let srat = ProfaneDictionary::from(["срать".to_string()]);
        assert!(!is_profane_match("стать", &srat, &settings));
        // Коверканье окончания — ровно то, ради чего fuzzy и держат.
        let sculo = ProfaneDictionary::from(["сцуко".to_string()]);
        assert!(is_profane_match("сцука", &sculo, &settings));
        // Гласная в корне — тоже описка ASR, а не другое слово.
        let sran = ProfaneDictionary::from(["срань".to_string()]);
        assert!(is_profane_match("срень", &sran, &settings));
        // Согласная ближе к концу слова корень уже не подменяет.
        let dolboyasher = ProfaneDictionary::from(["долбоящер".to_string()]);
        assert!(is_profane_match("долбоящет", &dolboyasher, &settings));
    }

    #[test]
    fn function_words_are_never_joined_into_a_match() {
        // «да» + «у» + «нас» склеивалось в «даунас» и ловилось корнем «даун»:
        // мут ложился на чистую речь. Служебные слова в склейку не берём.
        let settings = FetchrMuteSettings::default();
        let profane_words = ProfaneDictionary::default();
        let mk = |raw: &str, start: f64, end: f64| WordHit {
            lemma: None,
            verified: None,
            raw: raw.to_string(),
            normalized: raw.to_string(),
            start,
            end,
            confidence: 0.95,
        };
        let words = vec![
            mk("наверное", 12.0, 12.45),
            mk("да", 12.5, 12.62),
            mk("у", 12.64, 12.70),
            mk("нас", 12.72, 12.95),
            mk("ролевой", 13.0, 13.4),
        ];
        assert!(build_mute_spans(&words, &profane_words, &settings).is_empty());
    }

    #[test]
    fn joined_fragments_require_confident_recognition() {
        // Склейка — слабый сигнал: на adaptive/standard порог точного
        // совпадения 0.06, но конкатенация принимается только от 0.35.
        let settings = FetchrMuteSettings::default();
        let profane_words = ProfaneDictionary::default();
        let mk = |raw: &str, confidence: f32, start: f64, end: f64| WordHit {
            lemma: None,
            verified: None,
            raw: raw.to_string(),
            normalized: raw.to_string(),
            start,
            end,
            confidence,
        };
        let quiet = vec![mk("ху", 0.20, 96.66, 96.86), mk("еву", 0.91, 96.84, 97.40)];
        assert!(build_mute_spans(&quiet, &profane_words, &settings).is_empty());
        let confident = vec![mk("ху", 0.60, 96.66, 96.86), mk("еву", 0.91, 96.84, 97.40)];
        assert_eq!(
            build_mute_spans(&confident, &profane_words, &settings).len(),
            1
        );
    }

    #[test]
    fn daun_root_requires_a_real_russian_ending() {
        assert!(is_russian_profane_root("даун"));
        assert!(is_russian_profane_root("дауны"));
        assert!(is_russian_profane_root("дауном"));
        assert!(!is_russian_profane_root("даунас"));
        assert!(!is_russian_profane_root("даунлоад"));
        assert!(!is_russian_profane_root("даунтаун"));
        assert!(!is_russian_profane_root("даунгрейд"));
    }

    #[test]
    fn strict_level_accepts_levenshtein1_asr_misspelling() {
        // На Strict ASR-написания в пределах Левенштейна ≤1 от словарной
        // записи ловятся (≥5 букв, та же первая буква); на Standard — нет.
        // only_custom_words отключает корневую эвристику, чтобы тест
        // проверял именно fuzzy-ветку.
        let profane_words = ProfaneDictionary::from(["сцуко".to_string()]);
        let strict = FetchrMuteSettings {
            censorship_level: FetchrMuteCensorshipLevel::Strict,
            only_custom_words: true,
            ..FetchrMuteSettings::default()
        };
        assert!(is_profane_match("сцука", &profane_words, &strict));
        let standard = FetchrMuteSettings {
            only_custom_words: true,
            ..FetchrMuteSettings::default()
        };
        assert!(!is_profane_match("сцука", &profane_words, &standard));
        // Короткие слова (<5 букв) fuzzy не ловит даже на Strict.
        let profane_short = ProfaneDictionary::from(["сука".to_string()]);
        assert!(!is_profane_match("суки", &profane_short, &strict));
    }

    #[test]
    fn low_confidence_exact_match_is_muted_below_generic_threshold() {
        // Точное словарное совпадение — сильный сигнал: на Standard оно
        // мьютится уже при confidence 0.15 (общий порог уровня — 0.38).
        // Совсем слабые распознавания (<0.15) по-прежнему пропускаются.
        let settings = FetchrMuteSettings {
            mute_profile: FetchrMuteProfile::Reference,
            ..FetchrMuteSettings::default()
        };
        let profane_words = ProfaneDictionary::from(["блять".to_string()]);
        let mut word = WordHit {
            lemma: None,
            verified: None,
            raw: "блять".to_string(),
            normalized: "блять".to_string(),
            start: 4.0,
            end: 4.5,
            confidence: 0.10,
        };
        assert!(build_mute_spans(&[word.clone()], &profane_words, &settings).is_empty());
        word.confidence = 0.20;
        assert_eq!(
            build_mute_spans(&[word.clone()], &profane_words, &settings).len(),
            1,
            "точное словарное совпадение должно мьютиться ниже общего порога 0.38"
        );
        word.confidence = 0.90;
        assert_eq!(
            build_mute_spans(&[word], &profane_words, &settings).len(),
            1
        );
    }

    #[test]
    fn phrase_blacklist_entries_match_consecutive_words() {
        let settings = FetchrMuteSettings {
            custom_words: vec!["полный абзац".to_string()],
            only_custom_words: true,
            ..FetchrMuteSettings::default()
        };
        let profane_words = load_profane_words(&settings).unwrap();
        let mk = |raw: &str, start: f64, end: f64| WordHit {
            lemma: None,
            verified: None,
            raw: raw.to_string(),
            normalized: normalize_word(raw),
            start,
            end,
            confidence: 1.0,
        };

        let words = vec![
            mk("ну", 0.0, 0.3),
            mk("полный", 0.4, 0.9),
            mk("абзац", 1.0, 1.5),
            mk("короче", 1.6, 2.0),
        ];
        let spans = build_mute_spans(&words, &profane_words, &settings);
        assert_eq!(spans.len(), 1, "фраза из ЧС должна дать один спан");
        assert!(
            spans[0].start >= 0.35 && spans[0].end <= 1.6,
            "phrase span must stay inside adjacent-word midpoints: {:?}",
            spans[0]
        );

        // Те же слова с большой паузой между ними — не фраза
        let words_gap = vec![mk("полный", 0.4, 0.9), mk("абзац", 3.0, 3.5)];
        let spans_gap = build_mute_spans(&words_gap, &profane_words, &settings);
        assert!(
            spans_gap.is_empty(),
            "слова через паузу не должны матчиться"
        );
    }

    #[test]
    fn mute_span_does_not_consume_neighbouring_context_words() {
        let settings = FetchrMuteSettings {
            mute_profile: FetchrMuteProfile::Classic,
            coverage_percent: 100,
            only_custom_words: true,
            custom_words: vec!["мат".to_string()],
            ..FetchrMuteSettings::default()
        };
        let profane_words = ProfaneDictionary::from(["мат".to_string()]);
        let words = vec![
            WordHit {
            lemma: None,
            verified: None,
                raw: "это".to_string(),
                normalized: "это".to_string(),
                start: 0.82,
                end: 1.42,
                confidence: 1.0,
            },
            WordHit {
            lemma: None,
            verified: None,
                raw: "мат".to_string(),
                normalized: "мат".to_string(),
                start: 1.17,
                end: 1.77,
                confidence: 1.0,
            },
            WordHit {
            lemma: None,
            verified: None,
                raw: "дальше".to_string(),
                normalized: "дальше".to_string(),
                start: 1.52,
                end: 2.12,
                confidence: 1.0,
            },
        ];

        let spans = build_mute_spans(&words, &profane_words, &settings);
        assert_eq!(spans.len(), 1);
        assert!(
            (spans[0].start - 1.295).abs() < 1e-6,
            "previous context was consumed: {:?}",
            spans[0]
        );
        assert!(
            (spans[0].end - 1.645).abs() < 1e-6,
            "next context was consumed: {:?}",
            spans[0]
        );
    }

    #[test]
    fn only_custom_words_disables_builtin_root_heuristics() {
        let settings = FetchrMuteSettings {
            language: FetchrMuteLanguage::Ru,
            only_custom_words: true,
            custom_words: Vec::new(),
            ..FetchrMuteSettings::default()
        };
        let profane_words = load_profane_words(&settings).unwrap();
        assert!(!is_profane_match("хуй", &profane_words, &settings));
    }

    #[test]
    fn english_language_loads_english_profanity_dictionary() {
        let settings = FetchrMuteSettings {
            language: FetchrMuteLanguage::En,
            custom_words: Vec::new(),
            ..FetchrMuteSettings::default()
        };
        let words = load_profane_words(&settings).unwrap();
        assert!(words.contains("fuck"));
        assert!(words.contains("shit"));
        assert!(!words.contains("блять"));
    }

    #[test]
    fn whitelist_overrides_custom_phrase_match() {
        let settings = FetchrMuteSettings {
            custom_words: vec!["полный абзац".to_string()],
            whitelist_words: vec!["абзац".to_string()],
            only_custom_words: true,
            ..FetchrMuteSettings::default()
        };
        let profane_words = load_profane_words(&settings).unwrap();
        let words = vec![
            WordHit {
            lemma: None,
            verified: None,
                raw: "полный".to_string(),
                normalized: "полный".to_string(),
                start: 0.0,
                end: 0.4,
                confidence: 1.0,
            },
            WordHit {
            lemma: None,
            verified: None,
                raw: "абзац".to_string(),
                normalized: "абзац".to_string(),
                start: 0.5,
                end: 0.9,
                confidence: 1.0,
            },
        ];
        assert!(build_mute_spans(&words, &profane_words, &settings).is_empty());
    }

    #[test]
    fn output_paths_are_reserved_without_a_toctou_race() {
        let dir = std::env::temp_dir().join(format!("fetchr-output-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let input = dir.join("clip.mp4");
        std::fs::write(&input, b"source").unwrap();

        let first = fetchr_mute_output_path(&input).unwrap();
        let second = fetchr_mute_output_path(&input).unwrap();
        assert!(first.exists());
        assert!(second.exists());
        assert_ne!(first, second);
        assert!(is_generated_output_for(&input, &first));
        assert!(is_generated_output_for(&input, &second));
        assert!(!is_generated_output_for(
            &input,
            &dir.join("clip_fetchr_mute backup.mp4")
        ));

        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn queue_output_goes_to_chosen_folder_or_next_to_source() {
        let root = std::env::temp_dir().join(format!("fetchr-queue-out-{}", uuid::Uuid::new_v4()));
        let source_dir = root.join("src");
        let chosen = root.join("out");
        std::fs::create_dir_all(&source_dir).unwrap();
        let input = source_dir.join("clip.mp4");
        std::fs::write(&input, b"source").unwrap();

        assert_eq!(custom_output_dir(&input, None), None);
        assert_eq!(custom_output_dir(&input, Some("  ")), None);
        assert_eq!(custom_output_dir(&input, source_dir.to_str()), None);
        assert_eq!(custom_output_dir(&input, chosen.to_str()), Some(chosen.clone()));

        let beside = queue_output_path(&input, None).unwrap();
        assert_eq!(beside, source_dir.join("clip_fetchr_mute.mp4"));
        let first = queue_output_path(&input, chosen.to_str()).unwrap();
        let second = queue_output_path(&input, chosen.to_str()).unwrap();
        assert_eq!(first, chosen.join("clip_fetchr_mute.mp4"));
        assert_eq!(second, chosen.join("clip_fetchr_mute (1).mp4"));

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn source_fingerprint_detects_same_size_replacement() {
        let dir = std::env::temp_dir().join(format!("fetchr-cache-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let input = dir.join("clip.bin");
        std::fs::write(&input, b"original").unwrap();
        let first = source_fingerprint(&input).unwrap();
        std::fs::write(&input, b"replaced").unwrap();
        let second = source_fingerprint(&input).unwrap();
        assert_ne!(first, second);

        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn recognition_cache_requires_matching_language() {
        let settings = FetchrMuteSettings::default();
        let item = HistoryItem {
            id: "cache-id".to_string(),
            file_name: "clip.mp4".to_string(),
            file_path: "C:/media/clip.mp4".to_string(),
            output_path: "C:/media/clip_fetchr_mute.mp4".to_string(),
            date: 0,
            words: Vec::new(),
            spans: Vec::new(),
            manual_spans: Vec::new(),
            excluded_spans: Vec::new(),
            source_fingerprint: Some("fp".to_string()),
            recognition_version: Some(RECOGNITION_CACHE_VERSION),
            settings: settings.clone(),
        };

        // Полное совпадение — кэш попадает.
        assert!(cached_recognition_matches(
            &item,
            "C:/media/clip.mp4",
            &settings,
            "fp"
        ));

        // Смена языка — обязан быть промах: транскрипция другого языка
        // непригодна для словаря и корневой эвристики нового языка.
        let english = FetchrMuteSettings {
            language: FetchrMuteLanguage::En,
            ..settings.clone()
        };
        assert!(!cached_recognition_matches(
            &item,
            "C:/media/clip.mp4",
            &english,
            "fp"
        ));

        // Другой режим, fingerprint или версия кэша — тоже промах. Модель
        // теперь одна на все режимы, поэтому по ней кэш больше не различается.
        let precise = FetchrMuteSettings {
            mode: FetchrMuteProcessingMode::Precise,
            ..settings.clone()
        };
        assert!(!cached_recognition_matches(
            &item,
            "C:/media/clip.mp4",
            &precise,
            "fp"
        ));
        assert!(!cached_recognition_matches(
            &item,
            "C:/media/clip.mp4",
            &settings,
            "other-fp"
        ));
        let mut outdated = item.clone();
        outdated.recognition_version = Some(RECOGNITION_CACHE_VERSION - 1);
        assert!(!cached_recognition_matches(
            &outdated,
            "C:/media/clip.mp4",
            &settings,
            "fp"
        ));
    }

    #[test]
    fn recensor_keeps_the_recognition_cache_key_of_the_original_analysis() {
        let original = FetchrMuteSettings::default();
        let recensor = FetchrMuteSettings {
            language: FetchrMuteLanguage::En,
            audio_track_index: Some(1),
            mute_profile: FetchrMuteProfile::Sealed,
            mode: FetchrMuteProcessingMode::Precise,
            coverage_percent: 80,
            whitelist_words: vec!["сука".to_string()],
            ..FetchrMuteSettings::default()
        };
        let merged = recensor_history_settings(&original, &recensor);

        // Ключ кэша — от анализа, который реально распознал слова.
        assert_eq!(merged.language, original.language);
        assert_eq!(merged.audio_track_index, original.audio_track_index);
        assert_eq!(merged.mode, original.mode);
        assert_eq!(merged.asr_model, original.asr_model);
        assert_eq!(is_adaptive(&merged), is_adaptive(&original));
        // Настройки цензуры — из recensor.
        assert_eq!(merged.coverage_percent, 80);
        assert_eq!(merged.whitelist_words, vec!["сука".to_string()]);

        let item = HistoryItem {
            id: "cache-id".to_string(),
            file_name: "clip.mp4".to_string(),
            file_path: "C:/media/clip.mp4".to_string(),
            output_path: "C:/media/clip_fetchr_mute.mp4".to_string(),
            date: 0,
            words: Vec::new(),
            spans: Vec::new(),
            manual_spans: Vec::new(),
            excluded_spans: Vec::new(),
            source_fingerprint: Some("fp".to_string()),
            recognition_version: Some(RECOGNITION_CACHE_VERSION),
            settings: merged,
        };
        // Транскрипция дорожки 0 не выдаётся за дорожку 1 и наоборот.
        let track_one = FetchrMuteSettings {
            audio_track_index: Some(1),
            ..FetchrMuteSettings::default()
        };
        assert!(!cached_recognition_matches(&item, "C:/media/clip.mp4", &track_one, "fp"));
        assert!(cached_recognition_matches(&item, "C:/media/clip.mp4", &original, "fp"));

        // Профиль того же семейства берётся из recensor.
        let reference = FetchrMuteSettings {
            mute_profile: FetchrMuteProfile::Reference,
            ..FetchrMuteSettings::default()
        };
        let sealed_original = FetchrMuteSettings {
            mute_profile: FetchrMuteProfile::Sealed,
            ..FetchrMuteSettings::default()
        };
        assert_eq!(
            recensor_history_settings(&sealed_original, &reference).mute_profile,
            FetchrMuteProfile::Reference
        );
    }

    #[test]
    fn invalid_word_timestamps_are_ignored() {
        let settings = FetchrMuteSettings::default();
        let profane_words = ProfaneDictionary::from(["badword".to_string()]);
        let words = vec![WordHit {
            lemma: None,
            verified: None,
            raw: "badword".to_string(),
            normalized: "badword".to_string(),
            start: 10.0,
            end: 30.0,
            confidence: 1.0,
        }];

        assert!(build_mute_spans(&words, &profane_words, &settings).is_empty());
    }

    #[test]
    fn test_russian_roots() {
        let settings = FetchrMuteSettings {
            language: FetchrMuteLanguage::Ru,
            censorship_level: FetchrMuteCensorshipLevel::Strict,
            ..FetchrMuteSettings::default()
        };
        let profane_words = ProfaneDictionary::default(); // Empty set to test root matching specifically

        // Obscene words that should match
        let obscene = vec![
            "ебаных",
            "дохуя",
            "ебал",
            "нихуя",
            "ебать",
            "пиздабол",
            "хуй",
            "ебачее",
            "охуительном",
            "хуевый",
            "ебаного",
            "ебашит",
            "ебошить",
            "залупой",
            "долбоебы",
            "ебаные",
            "хуева",
            "ебаная",
            "уебище",
            "ебало",
            "охуельно",
            "хуйню",
            "хуй",
            "пиздюки",
            "хуяре",
            "ебаное",
            "долбоеб",
            "хули",
            "проебал",
            "пизды",
            "хуня",
            "заебаный",
            "ебатиной",
            "уебан",
            "пизжусь",
            "въебу",
            "пиздец",
            "ебанул",
            "съебаться",
            "пиздошатся",
            "разъебать",
            "ебучий",
            "въебали",
            "уебана",
            "разъебешь",
            "хуев",
            "хуевым",
            "онахуй",
            "хуево",
            "хуевый",
            "хуйни",
            "поебать",
            "похуй",
            "ахуел",
            "разъебали",
            "хуячат",
            "пизда",
            "ебут",
            "дрочить",
            // New user requested words
            "пиздюк",
            "пенис",
            "ебанный",
            "ахуеть",
            "ебанутая",
            "пидорас",
            "гандон",
            "ебнутые",
            "дауны",
            "вахуе",
            "в ахуе",
        ];
        for word in obscene {
            let normalized = normalize_word(word);
            assert!(
                is_profane_match(&normalized, &profane_words, &settings),
                "Obscene word '{}' (normalized: '{}') should match",
                word,
                normalized
            );
        }

        // Clean words that should NOT match
        let clean = vec![
            "хлеб",
            "учеба",
            "дебаты",
            "колебания",
            "стебли",
            "команда",
            "мандарин",
            "хулиган",
            "барсук",
            "сук",
            "сукно",
            "суккуб",
            "сука",
            "дебилы",
            "мандат",
            "мандала",
            "мандолина",
            // Exclusions/clean words for the new rules
            "пенистый",
            "пенистые",
            "пенистость",
            "даунгрейд",
            "дауншифтинг",
            "даунтаун",
        ];
        for word in clean {
            let normalized = normalize_word(word);
            assert!(
                !is_profane_match(&normalized, &profane_words, &settings),
                "Clean word '{}' (normalized: '{}') should NOT match",
                word,
                normalized
            );
        }
    }

    #[test]
    fn test_audio_filter_expressions() {
        let spans = vec![MuteSpan {
            word: "test".to_string(),
            start: 1.0,
            end: 2.0,
        }];

        let settings_beep = FetchrMuteSettings {
            mute_profile: FetchrMuteProfile::Classic,
            censor_method: FetchrMuteCensorMethod::Beep,
            ..Default::default()
        };
        let filter_beep = audio_filter_for_method(&settings_beep, &spans).unwrap();
        assert!(
            filter_beep.contains("[bed]"),
            "beep filter must contain [bed]"
        );
        assert!(
            filter_beep.contains("[tone]"),
            "beep filter must contain [tone]"
        );
        assert!(
            filter_beep.contains("amix"),
            "beep filter must contain amix"
        );
        // Smooth expr: original мутируется, тон добавляется
        assert!(filter_beep.contains("0.28*(1-("));

        let settings_mute = FetchrMuteSettings {
            mute_profile: FetchrMuteProfile::Classic,
            censor_method: FetchrMuteCensorMethod::Mute,
            ..Default::default()
        };
        let filter_mute = audio_filter_for_method(&settings_mute, &spans).unwrap();
        // aeval для per-sample smooth fade
        assert!(filter_mute.contains("aeval="), "mute filter must use aeval");
        assert!(
            filter_mute.contains("c=same"),
            "mute filter must preserve channel layout"
        );
        assert!(
            filter_mute.contains("[aout]"),
            "mute filter must produce [aout]"
        );
        assert!(
            filter_mute.contains("min(1,max(0,"),
            "mute filter must contain smooth expr"
        );
    }

    #[test]
    fn smooth_env_handles_many_spans_and_smooths() {
        let spans: Vec<MuteSpan> = (0..1_000)
            .map(|i| MuteSpan {
                word: "w".to_string(),
                start: i as f64 * 2.0 + 1.0,
                end: i as f64 * 2.0 + 1.3,
            })
            .collect();
        let settings = FetchrMuteSettings {
            censor_method: FetchrMuteCensorMethod::Mute,
            ..Default::default()
        };
        let filter = audio_filter_smooth_env(&settings, &spans, 48000, 2).unwrap();
        assert!(filter.contains("[aout]"));
        assert!(filter.contains("exprs='1|1'"));
        assert!(filter.contains("c=stereo"));
        // Двойной lowpass — S-образный фейд без щелчков
        assert_eq!(filter.matches("lowpass=f=").count(), 2);
        // 1000 спанов → mute-гейты разбиты на несколько volume-фильтров.
        assert!(filter.contains("[envgate_0]"));
        assert!(filter.contains("[envgate_8]"));
        assert!(!filter.contains("envduck"));
        assert!(!filter.contains("aeval="), "no per-sample expressions");

        let beep = FetchrMuteSettings {
            censor_method: FetchrMuteCensorMethod::Beep,
            ..Default::default()
        };
        let filter_beep = audio_filter_smooth_env(&beep, &spans, 44100, 1).unwrap();
        assert!(filter_beep.contains("[ienvgate_0]"));
        assert!(filter_beep.contains("amix"));
        assert!(filter_beep.contains("[aout]"));
    }

    #[test]
    fn reference_profile_keeps_both_fades_inside_the_muted_word() {
        let settings = FetchrMuteSettings {
            mute_profile: FetchrMuteProfile::Reference,
            ..FetchrMuteSettings::default()
        };
        let profane_words = ProfaneDictionary::from(["мат".to_string()]);
        let words = vec![
            WordHit {
            lemma: None,
            verified: None,
                raw: "слово".to_string(),
                normalized: "слово".to_string(),
                start: 9.6,
                end: 10.02,
                confidence: 1.0,
            },
            WordHit {
            lemma: None,
            verified: None,
                raw: "мат".to_string(),
                normalized: "мат".to_string(),
                start: 10.0,
                end: 10.6,
                confidence: 1.0,
            },
            WordHit {
            lemma: None,
            verified: None,
                raw: "дальше".to_string(),
                normalized: "дальше".to_string(),
                start: 10.58,
                end: 11.0,
                confidence: 1.0,
            },
        ];

        let spans = build_mute_spans(&words, &profane_words, &settings);
        assert_eq!(spans.len(), 1);
        let span = &spans[0];
        let fade_start = span.start - settings.fade_out_ms as f64 / 1000.0;
        let fade_end = span.end + settings.fade_in_ms as f64 / 1000.0;
        assert!((fade_start - words[0].end).abs() < 1e-9);
        assert!(fade_start >= words[0].end - 1e-9);
        assert!(fade_end <= words[2].start + 1e-9);
        assert!(span.end > span.start);
    }

    #[test]
    fn reference_profile_cannot_bypass_its_envelope() {
        let settings = FetchrMuteSettings {
            mute_profile: FetchrMuteProfile::Reference,
            smooth_mute: false,
            ..FetchrMuteSettings::default()
        };
        assert!(should_use_smooth_envelope(&settings));
    }

    #[test]
    fn sealed_profile_covers_whole_word_with_pads() {
        let mk = |coverage_percent: u8| FetchrMuteSettings {
            mute_profile: FetchrMuteProfile::Sealed,
            coverage_percent,
            only_custom_words: true,
            custom_words: vec!["мат".to_string()],
            ..FetchrMuteSettings::default()
        };
        let profane_words = ProfaneDictionary::from(["мат".to_string()]);
        let words = vec![WordHit {
            lemma: None,
            verified: None,
            raw: "мат".to_string(),
            normalized: "мат".to_string(),
            start: 10.0,
            end: 10.6,
            confidence: 1.0,
        }];

        let spans_full = build_mute_spans(&words, &profane_words, &mk(100));
        assert_eq!(spans_full.len(), 1);
        // Нулевое ядро = всё слово плюс запас 80 мс до и 60 мс после.
        assert!(
            (spans_full[0].start - 9.92).abs() < 1e-9,
            "{:?}",
            spans_full[0]
        );
        assert!(
            (spans_full[0].end - 10.66).abs() < 1e-9,
            "{:?}",
            spans_full[0]
        );

        // Покрытие 20%: ядро — доля слова внутри интервала, затухания внутри
        // слова (пады в паузы не добавляются). Слово [10.0, 10.6] с дефолтными
        // fade 100/5 мс: начало ядра = 10.0 + 100 мс = 10.1; конец — не ближе
        // чем возврат 5 мс + хвост 75 мс до конца слова → 10.52.
        let spans_low = build_mute_spans(&words, &profane_words, &mk(20));
        assert_eq!(spans_low.len(), 1);
        assert!(
            (spans_low[0].start - 10.1).abs() < 1e-9,
            "{:?}",
            spans_low[0]
        );
        assert!(
            (spans_low[0].end - 10.52).abs() < 1e-9,
            "{:?}",
            spans_low[0]
        );
    }

    fn adaptive_settings() -> FetchrMuteSettings {
        FetchrMuteSettings {
            mute_profile: FetchrMuteProfile::Adaptive,
            only_custom_words: true,
            custom_words: vec!["мат".to_string()],
            ..FetchrMuteSettings::default()
        }
    }

    #[test]
    fn adaptive_profile_keeps_audible_head_and_tail() {
        let profane_words = ProfaneDictionary::from(["мат".to_string()]);
        let words = vec![WordHit {
            lemma: None,
            verified: None,
            raw: "мат".to_string(),
            normalized: "мат".to_string(),
            start: 10.0,
            end: 10.6,
            confidence: 1.0,
        }];
        let spans = build_mute_spans(&words, &profane_words, &adaptive_settings());
        assert_eq!(spans.len(), 1);
        // Голова: рампа вниз 55 мс живёт внутри слова, ядро начинается после неё.
        assert!((spans[0].start - 10.055).abs() < 1e-9, "{:?}", spans[0]);
        // Хвост: 35% от 600 мс = 210 мс слова остаются слышимыми.
        assert!((spans[0].end - 10.39).abs() < 1e-9, "{:?}", spans[0]);
    }

    #[test]
    fn adaptive_audible_tail_scales_with_word_length() {
        let profane_words = ProfaneDictionary::from(["мат".to_string()]);
        let tail = |start: f64, end: f64| {
            let words = vec![WordHit {
            lemma: None,
            verified: None,
                raw: "мат".to_string(),
                normalized: "мат".to_string(),
                start,
                end,
                confidence: 1.0,
            }];
            let span = build_mute_spans(&words, &profane_words, &adaptive_settings()).remove(0);
            end - span.end
        };
        // Длинное протяжное слово упирается в верхнюю границу 480 мс.
        assert!((tail(5.0, 6.5) - 0.480).abs() < 1e-9);
        // Среднее — доля 35%.
        assert!((tail(10.0, 10.6) - 0.210).abs() < 1e-9);
        // На коротком слове ограничителем становится покрытие, а не хвост.
        assert!(tail(2.0, 2.25) > 0.0);
        assert!(tail(5.0, 6.5) > tail(10.0, 10.6));
        assert!(tail(10.0, 10.6) > tail(2.0, 2.25));
    }

    #[test]
    fn audible_tail_helper_clamps_to_configured_bounds() {
        let scaled = AudibleTail::scaled(
            ADAPTIVE_AUDIBLE_TAIL_SHARE,
            ADAPTIVE_AUDIBLE_TAIL_MIN_S,
            ADAPTIVE_AUDIBLE_TAIL_MAX_S,
        );
        assert!((scaled.for_word(0.10) - ADAPTIVE_AUDIBLE_TAIL_MIN_S).abs() < 1e-9);
        assert!((scaled.for_word(5.00) - ADAPTIVE_AUDIBLE_TAIL_MAX_S).abs() < 1e-9);
        assert!((scaled.for_word(0.60) - 0.210).abs() < 1e-9);
        let fixed = AudibleTail::fixed(REFERENCE_MAX_AUDIBLE_TAIL_S);
        assert!((fixed.for_word(3.0) - REFERENCE_MAX_AUDIBLE_TAIL_S).abs() < 1e-9);
    }

    #[test]
    fn adaptive_profile_mutes_more_of_the_word_than_reference() {
        let profane_words = ProfaneDictionary::from(["мат".to_string()]);
        let words = vec![WordHit {
            lemma: None,
            verified: None,
            raw: "мат".to_string(),
            normalized: "мат".to_string(),
            start: 4.0,
            end: 4.5,
            confidence: 1.0,
        }];
        let reference = FetchrMuteSettings {
            mute_profile: FetchrMuteProfile::Reference,
            ..adaptive_settings()
        };
        let r = build_mute_spans(&words, &profane_words, &reference).remove(0);
        let a = build_mute_spans(&words, &profane_words, &adaptive_settings()).remove(0);
        // Голова короче (55 против 100 мс), хвост длиннее (175 против 80 мс).
        assert!(a.start < r.start, "a={a:?} r={r:?}");
        assert!(a.end < r.end, "a={a:?} r={r:?}");
        // Обе границы остаются внутри слова: оно не вырезается целиком.
        assert!(a.start > words[0].start && a.end < words[0].end, "{a:?}");
    }

    #[test]
    fn quiet_exact_match_needs_ctc_confirmation() {
        let profane_words = ProfaneDictionary::from(["мат".to_string()]);
        // confidence 0.08 — тихо произнесённое слово или мусор на шуме. Само по
        // себе не мутится; подтверждение второй моделью делает его мутом.
        let mut words = vec![WordHit {
            lemma: None,
            verified: None,
            raw: "мат".to_string(),
            normalized: "мат".to_string(),
            start: 3.0,
            end: 3.4,
            confidence: 0.08,
        }];
        assert!(build_mute_spans(&words, &profane_words, &adaptive_settings()).is_empty());
        words[0].verified = Some(true);
        assert_eq!(build_mute_spans(&words, &profane_words, &adaptive_settings()).len(), 1);
        words[0].verified = Some(false);
        words[0].confidence = 0.6;
        assert!(build_mute_spans(&words, &profane_words, &adaptive_settings()).is_empty());
        // «Максимум» отказом второй модели не смягчается.
        let maximum = FetchrMuteSettings {
            censorship_level: FetchrMuteCensorshipLevel::Maximum,
            ..adaptive_settings()
        };
        assert_eq!(build_mute_spans(&words, &profane_words, &maximum).len(), 1);
    }

    #[test]
    fn adaptive_profile_pins_its_own_ramps() {
        // Ползунки не влияют: профиль описывает фиксированную огибающую.
        let settings = FetchrMuteSettings {
            fade_out_ms: 400,
            fade_in_ms: 180,
            ..adaptive_settings()
        };
        let (fade_out, fade_in) = reference_fade_seconds(&settings);
        assert!((fade_out - ADAPTIVE_FADE_OUT_S).abs() < 1e-9);
        assert!((fade_in - ADAPTIVE_FADE_IN_S).abs() < 1e-9);
    }

    #[test]
    fn asr_offset_is_zero_without_enough_onsets() {
        let db = vec![-60.0f32; 50];
        assert_eq!(estimate_asr_offset(&[], &db, 0.010), 0.0);
    }

    #[test]
    fn asr_offset_recovers_constant_lag() {
        // Огибающая: 12 всплесков по 100 мс, начинающихся на 0.5, 1.5, 2.5 …
        let hop = 0.010;
        let mut db = vec![-60.0f32; 1400];
        let mut onsets = Vec::new();
        for k in 0..12 {
            let onset = 0.5 + k as f64;
            onsets.push(onset);
            let i = (onset / hop) as usize;
            for j in i..i + 10 {
                db[j] = 0.0;
            }
        }
        // ASR отдал таймкоды на 60 мс раньше реальной речи.
        let words: Vec<WordHit> = onsets
            .iter()
            .map(|onset| WordHit {
            lemma: None,
            verified: None,
                raw: "слово".to_string(),
                normalized: "слово".to_string(),
                start: onset - 0.060,
                end: onset - 0.060 + 0.30,
                confidence: 0.9,
            })
            .collect();
        let offset = estimate_asr_offset(&words, &db, hop);
        assert!((offset - 0.060).abs() < 0.015, "offset={offset}");
    }

    #[test]
    fn phonetic_variants_need_strict_level_even_on_adaptive() {
        let profane_words = ProfaneDictionary::from(["ебать".to_string()]);
        let settings = FetchrMuteSettings {
            censorship_level: FetchrMuteCensorshipLevel::Standard,
            only_custom_words: false,
            custom_words: Vec::new(),
            ..adaptive_settings()
        };
        // «ибать» — ошибка ASR на безударной гласной, но фонетика на
        // «Стандарте» глушила и чистые слова («блат» → «блять»).
        assert!(profane_match_kind("ибать", &profane_words, &settings).is_none());
        let strict = FetchrMuteSettings {
            censorship_level: FetchrMuteCensorshipLevel::Strict,
            ..settings
        };
        assert!(profane_match_kind("ибать", &profane_words, &strict).is_some());
    }

    #[test]
    fn clean_words_with_profane_substrings_are_not_muted() {
        let settings = FetchrMuteSettings::default();
        let profane_words = load_profane_words(&settings).unwrap();
        for clean in [
            "психуешь", "психует", "психуй", "психуя", "страхует", "застрахуем", "гребли",
            "погребли", "загребал", "огребал", "выгребали", "курвиметр", "ебонит", "сук", "блат",
            "сечка", "блеять",
        ] {
            assert!(
                profane_match_kind(clean, &profane_words, &settings).is_none(),
                "{clean} must stay clean"
            );
        }
        for profane in ["нахуй", "охуеть", "заебал", "уебан", "долбоеб", "пиздец", "блять"] {
            assert!(
                profane_match_kind(profane, &profane_words, &settings).is_some(),
                "{profane} must match"
            );
        }
    }

    #[test]
    fn known_clean_lemma_vetoes_root_match() {
        let settings = FetchrMuteSettings::default();
        let profane_words = load_profane_words(&settings).unwrap();
        let word = |raw: &str, lemma: Option<&str>| WordHit {
            lemma: lemma.map(str::to_string),
            verified: None,
            raw: raw.to_string(),
            normalized: raw.to_string(),
            start: 1.0,
            end: 1.4,
            confidence: 0.95,
        };
        // Корень «хуе» внутри неизвестной словоформы: без леммы — мат,
        // с чистой леммой из морфословаря — нет.
        assert_eq!(build_mute_spans(&[word("тахуево", None)], &profane_words, &settings).len(), 1);
        assert!(build_mute_spans(&[word("тахуево", Some("тахов"))], &profane_words, &settings).is_empty());
        // Лемма мата не мешает: «нахуй» → «нахуй», «охуел» → «охуеть».
        assert_eq!(build_mute_spans(&[word("охуел", Some("охуеть"))], &profane_words, &settings).len(), 1);
    }

    #[test]
    fn bl_verbs_and_courvoisier_are_not_profane_roots() {
        let settings = FetchrMuteSettings::default();
        let profane_words = load_profane_words(&settings).unwrap();
        for clean in [
            "оскорблять", "оскорбляться", "употреблять", "употребляться", "злоупотреблять",
            "потреблять", "ослаблять", "расслабляться", "углублять", "усугублять", "истреблять",
            "истребляться", "озлоблять", "уподоблять", "раздроблять", "приспособлять",
            "обособлять", "влюблять", "огрублять", "курвуазье", "скипидар",
        ] {
            assert!(!is_russian_profane_root(clean), "{clean}: root must not match");
            assert!(
                profane_match_kind(clean, &profane_words, &settings).is_none(),
                "{clean} must stay clean"
            );
        }
        for profane in [
            "бляд", "блять", "блядь", "блядский", "блядина", "заблядовать", "выблядок",
            "поблядушка", "нублять", "сукаблять", "курва", "курвы",
        ] {
            assert!(
                profane_match_kind(profane, &profane_words, &settings).is_some(),
                "{profane} must match"
            );
        }
        // «блат» — не корень «бля»: прежнее поведение сохраняется.
        assert!(!is_russian_profane_root("приблатненный"));
    }

    #[test]
    fn dictionary_lemma_counts_as_exact_match() {
        let settings = FetchrMuteSettings::default();
        let profane_words = load_profane_words(&settings).unwrap();
        let word = |raw: &str, lemma: Option<&str>| WordHit {
            lemma: lemma.map(str::to_string),
            verified: None,
            raw: raw.to_string(),
            normalized: normalize_word(raw),
            start: 1.0,
            end: 1.4,
            confidence: 0.95,
        };
        for (raw, lemma) in [
            ("суку", "сука"),
            ("сукой", "сука"),
            ("суке", "сука"),
            ("херню", "херня"),
            ("херней", "херня"),
        ] {
            assert_eq!(
                word_profane_match_kind(&word(raw, Some(lemma)), &profane_words, &settings),
                Some(ProfaneMatchKind::Exact),
                "{raw} → {lemma}"
            );
            assert_eq!(
                build_mute_spans(&[word(raw, Some(lemma))], &profane_words, &settings).len(),
                1,
                "{raw} must be muted on Standard"
            );
        }
        // Без леммы словоформа вне списка не находится — повышение даёт лемма.
        assert!(word_profane_match_kind(&word("суку", None), &profane_words, &settings).is_none());
        // pymorphy не знает «нахер»/«похер»: они в словаре как есть.
        for raw in ["нахер", "похер"] {
            assert!(word_profane_match_kind(&word(raw, None), &profane_words, &settings).is_some());
        }
        // «ё» в лемме pymorphy нормализуется так же, как словарь.
        assert_eq!(
            word_profane_match_kind(&word("хуёвенькую", Some("хуёвый")), &profane_words, &settings),
            Some(ProfaneMatchKind::Exact)
        );
        // Короткое «сук» (ветка) pymorphy разбирает как «сука» — не повышаем.
        assert!(word_profane_match_kind(&word("сук", Some("сука")), &profane_words, &settings).is_none());
        // Чистые слова с чистой леммой остаются чистыми.
        for (raw, lemma) in [
            ("сукно", "сукно"),
            ("сукна", "сукно"),
            ("сучья", "сук"),
            ("хлеба", "хлеб"),
            ("страхует", "страховать"),
            ("мандарин", "мандарин"),
            ("команда", "команда"),
            ("оскорбляться", "оскорбляться"),
            ("употреблять", "употреблять"),
        ] {
            assert!(
                build_mute_spans(&[word(raw, Some(lemma))], &profane_words, &settings).is_empty(),
                "{raw} must stay clean"
            );
        }
    }

    #[test]
    fn whitelist_applies_to_inflections_by_lemma() {
        let settings = FetchrMuteSettings {
            whitelist_words: vec!["сука".to_string()],
            ..FetchrMuteSettings::default()
        };
        let profane_words = load_profane_words(&settings).unwrap();
        let word = WordHit {
            lemma: Some("сука".to_string()),
            verified: None,
            raw: "суки".to_string(),
            normalized: "суки".to_string(),
            start: 1.0,
            end: 1.4,
            confidence: 0.95,
        };
        assert!(build_mute_spans(&[word], &profane_words, &settings).is_empty());
    }

    fn exclusion_test_word(raw: &str, start: f64, end: f64) -> WordHit {
        WordHit {
            lemma: None,
            verified: None,
            raw: raw.to_string(),
            normalized: normalize_word(raw),
            start,
            end,
            confidence: 0.95,
        }
    }

    #[test]
    fn exclusion_removes_only_its_word_from_a_merged_span() {
        // «Герметичный» с полным покрытием сливает соседние маты в один спан.
        let settings = FetchrMuteSettings {
            mute_profile: FetchrMuteProfile::Sealed,
            coverage_percent: 100,
            ..FetchrMuteSettings::default()
        };
        let profane_words = load_profane_words(&settings).unwrap();
        let words = vec![
            exclusion_test_word("ну", 0.4, 0.8),
            exclusion_test_word("блять", 1.0, 1.4),
            exclusion_test_word("сука", 1.42, 1.8),
            exclusion_test_word("короче", 2.2, 2.6),
        ];
        let all = build_mute_spans(&words, &profane_words, &settings);
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].word, "блять,сука");

        // Исключение записано, пока «блять» был отдельным спаном.
        let excluded = [MuteSpan {
            word: "блять".to_string(),
            start: 0.95,
            end: 1.45,
        }];
        let spans = build_mute_spans_excluding(&words, &profane_words, &settings, &excluded);
        assert_eq!(spans.len(), 1, "{spans:?}");
        assert_eq!(spans[0].word, "сука");
        // Снятое слово — контекст: мут соседа не заходит в него дальше
        // середины стыка.
        assert!(spans[0].start >= 1.41 - 1e-9, "{spans:?}");

        // Исключение всего слитого спана снимает оба слова.
        assert!(build_mute_spans_excluding(&words, &profane_words, &settings, &all).is_empty());
        // Без исключений результат прежний.
        let unchanged = build_mute_spans_excluding(&words, &profane_words, &settings, &[]);
        assert_eq!(unchanged.len(), 1);
        assert_eq!(unchanged[0].word, all[0].word);
        assert!((unchanged[0].start - all[0].start).abs() < 1e-12);
        assert!((unchanged[0].end - all[0].end).abs() < 1e-12);
    }

    #[test]
    fn exclusion_does_not_touch_the_same_word_nearby() {
        let settings = FetchrMuteSettings::default();
        let profane_words = load_profane_words(&settings).unwrap();
        let words = vec![
            exclusion_test_word("сука", 1.0, 1.3),
            exclusion_test_word("ну", 1.35, 1.5),
            exclusion_test_word("сука", 1.55, 1.85),
        ];
        let all = build_mute_spans(&words, &profane_words, &settings);
        assert_eq!(all.len(), 2, "{all:?}");

        // Итоговый спан сдвинут уточнением (оценка задержки ASR) — всё равно
        // снимается только первое слово.
        let shifted = MuteSpan {
            word: all[0].word.clone(),
            start: all[0].start + 0.12,
            end: all[0].end + 0.12,
        };
        let spans = build_mute_spans_excluding(&words, &profane_words, &settings, &[shifted]);
        assert_eq!(spans.len(), 1, "{spans:?}");
        assert!(spans[0].start >= 1.5, "{spans:?}");

        // Исключение с чужой подписью слово не снимает, даже перекрываясь.
        let foreign = MuteSpan {
            word: "блять".to_string(),
            start: 0.9,
            end: 1.4,
        };
        assert_eq!(
            build_mute_spans_excluding(&words, &profane_words, &settings, &[foreign]).len(),
            2
        );

        // Исключение без подписи снимает одно ближайшее слово.
        let unnamed = MuteSpan {
            word: String::new(),
            start: 1.6,
            end: 1.8,
        };
        let spans = build_mute_spans_excluding(&words, &profane_words, &settings, &[unnamed]);
        assert_eq!(spans.len(), 1, "{spans:?}");
        assert!(spans[0].end <= 1.35, "{spans:?}");
    }

    #[test]
    fn exclusion_far_from_the_word_is_ignored() {
        let candidates = [SpanCandidate::new("сука", 1.0, 1.3)];
        let far = MuteSpan {
            word: "сука".to_string(),
            start: 1.6,
            end: 1.8,
        };
        assert_eq!(excluded_candidate_flags(&candidates, &[far]), vec![false]);
        let near = MuteSpan {
            word: "Сука".to_string(),
            start: 1.05,
            end: 1.25,
        };
        assert_eq!(excluded_candidate_flags(&candidates, &[near]), vec![true]);
    }

    /// WAV так, как его пишет ffmpeg для подготовки ASR: fmt, LIST, data.
    fn prepared_wav_bytes(samples: usize) -> Vec<u8> {
        let list: &[u8] = b"INFOISFT\x0e\x00\x00\x00Lavf61.7.100\x00\x00";
        let data_len = (samples * 2) as u32;
        let mut bytes = Vec::new();
        bytes.extend_from_slice(b"RIFF");
        let riff = 4 + (8 + 16) + (8 + list.len() as u32) + (8 + data_len);
        bytes.extend_from_slice(&riff.to_le_bytes());
        bytes.extend_from_slice(b"WAVEfmt ");
        bytes.extend_from_slice(&16u32.to_le_bytes());
        bytes.extend_from_slice(&1u16.to_le_bytes());
        bytes.extend_from_slice(&1u16.to_le_bytes());
        bytes.extend_from_slice(&SAMPLE_RATE.to_le_bytes());
        bytes.extend_from_slice(&(SAMPLE_RATE * 2).to_le_bytes());
        bytes.extend_from_slice(&2u16.to_le_bytes());
        bytes.extend_from_slice(&16u16.to_le_bytes());
        bytes.extend_from_slice(b"LIST");
        bytes.extend_from_slice(&(list.len() as u32).to_le_bytes());
        bytes.extend_from_slice(list);
        bytes.extend_from_slice(b"data");
        bytes.extend_from_slice(&data_len.to_le_bytes());
        bytes.extend(std::iter::repeat(0u8).take(samples * 2));
        bytes
    }

    fn scratch_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("fetchr-mute-{name}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn prepared_wav_header_must_match_the_file_length() {
        let complete = prepared_wav_bytes(16_000);
        assert!(prepared_wav_header_is_complete(&complete, complete.len() as u64));

        // Обрыв записи: файл короче, чем обещают RIFF и data.
        let truncated = &complete[..complete.len() - 1_000];
        assert!(!prepared_wav_header_is_complete(truncated, truncated.len() as u64));

        // ffmpeg убит до финализации: в размерах остались заглушки.
        let mut placeholder = complete.clone();
        placeholder[4..8].copy_from_slice(&u32::MAX.to_le_bytes());
        let data_size_at = placeholder.len() - 16_000 * 2 - 4;
        placeholder[data_size_at..data_size_at + 4].copy_from_slice(&u32::MAX.to_le_bytes());
        assert!(!prepared_wav_header_is_complete(&placeholder, placeholder.len() as u64));

        // Пустой блок данных и чужой формат тоже не годятся.
        let empty = prepared_wav_bytes(0);
        assert!(!prepared_wav_header_is_complete(&empty, empty.len() as u64));
        let mut stereo = complete.clone();
        stereo[22..24].copy_from_slice(&2u16.to_le_bytes());
        assert!(!prepared_wav_header_is_complete(&stereo, stereo.len() as u64));
        assert!(!prepared_wav_header_is_complete(b"", 0));
    }

    #[test]
    fn truncated_cached_wav_is_deleted_for_rebuild() {
        let dir = scratch_dir("wav-ready");
        let wav = dir.join("cached.wav");

        let complete = prepared_wav_bytes(8_000);
        std::fs::write(&wav, &complete).unwrap();
        assert!(prepared_wav_ready(&wav));
        assert!(wav.exists());

        std::fs::write(&wav, &complete[..complete.len() / 2]).unwrap();
        assert!(!prepared_wav_ready(&wav));
        assert!(!wav.exists(), "truncated cache must be removed");
        assert!(!prepared_wav_ready(&wav));

        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn partial_file_is_moved_only_on_commit() {
        let dir = scratch_dir("partial");
        let wav = dir.join("cached.wav");

        let dropped = partial_output_path(&wav);
        assert_eq!(dropped.parent(), wav.parent());
        assert!(dropped.to_string_lossy().ends_with(".part"));
        std::fs::write(&dropped, b"half").unwrap();
        drop(PartialFileGuard::new(dropped.clone()));
        assert!(!dropped.exists(), "abandoned .part must be removed");
        assert!(!wav.exists());

        let committed = partial_output_path(&wav);
        assert_ne!(committed, dropped);
        std::fs::write(&committed, b"full").unwrap();
        std::fs::write(&wav, b"old").unwrap();
        PartialFileGuard::new(committed.clone()).commit(&wav).unwrap();
        assert!(!committed.exists());
        assert_eq!(std::fs::read(&wav).unwrap(), b"full");

        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn prune_drops_stale_partials_and_ignores_fresh_ones() {
        let dir = scratch_dir("prune");
        let keep = dir.join("keep.wav");
        let other = dir.join("other.wav");
        let older = dir.join("older.wav");
        let fresh_part = dir.join("keep.wav.a.part");
        let stale_part = dir.join("other.wav.b.part");
        for path in [&keep, &other, &older, &fresh_part, &stale_part] {
            std::fs::write(path, b"x").unwrap();
        }
        let set_age = |path: &Path, age: Duration| {
            std::fs::File::options()
                .write(true)
                .open(path)
                .unwrap()
                .set_modified(std::time::SystemTime::now() - age)
                .unwrap();
        };
        set_age(&older, Duration::from_secs(120));
        set_age(&stale_part, STALE_PARTIAL_WAV_AGE + Duration::from_secs(60));

        prune_prepared_wav_cache(&keep, 2);

        assert!(keep.exists());
        assert!(other.exists(), "newest other WAV stays: a fresh .part is not counted");
        assert!(!older.exists());
        assert!(fresh_part.exists(), "a .part being written is left alone");
        assert!(!stale_part.exists());

        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn sealed_profile_clamps_to_context_midpoints() {
        let settings = FetchrMuteSettings {
            mute_profile: FetchrMuteProfile::Sealed,
            coverage_percent: 100,
            only_custom_words: true,
            custom_words: vec!["мат".to_string()],
            ..FetchrMuteSettings::default()
        };
        let profane_words = ProfaneDictionary::from(["мат".to_string()]);
        let mk = |raw: &str, start: f64, end: f64| WordHit {
            lemma: None,
            verified: None,
            raw: raw.to_string(),
            normalized: normalize_word(raw),
            start,
            end,
            confidence: 1.0,
        };
        // Соседние слова вплотную: запас 80/60 мс обязан зажаться серединами
        // пауз, а не съесть хвост предыдущего и голову следующего слова.
        let words = vec![
            mk("слово", 9.4, 9.97),
            mk("мат", 10.0, 10.6),
            mk("дальше", 10.63, 11.2),
        ];
        let spans = build_mute_spans(&words, &profane_words, &settings);
        assert_eq!(spans.len(), 1);
        let left_mid = (9.97 + 10.0) / 2.0;
        let right_mid = (10.6 + 10.63) / 2.0;
        assert!((spans[0].start - left_mid).abs() < 1e-9, "{:?}", spans[0]);
        assert!((spans[0].end - right_mid).abs() < 1e-9, "{:?}", spans[0]);
    }

    #[test]
    fn sealed_profile_forces_smooth_reference_envelope() {
        let settings = FetchrMuteSettings {
            mute_profile: FetchrMuteProfile::Sealed,
            smooth_mute: false,
            ..FetchrMuteSettings::default()
        };
        assert!(should_use_smooth_envelope(&settings));

        // Огибающая валидна и для mute, и для beep (общий reference-рендер).
        let span = MuteSpan {
            word: "мат".to_string(),
            start: 0.92,
            end: 1.26,
        };
        let mute = audio_filter_reference_env(&settings, &[span.clone()], 48_000, 2)
            .expect("sealed mute filter");
        assert!(mute.contains("[refenv]amultiply[aout]"));
        let beep_settings = FetchrMuteSettings {
            censor_method: FetchrMuteCensorMethod::Beep,
            ..settings.clone()
        };
        let beep = audio_filter_reference_env(&beep_settings, &[span], 44_100, 1)
            .expect("sealed beep filter");
        assert!(beep.contains("amix"));
    }

    /// Синтетический 16 кГц сигнал: тишина −80 дБ с тональными всплесками
    /// (start, end, amp), имитирующими слова.
    fn sealed_envelope_samples(events: &[(f64, f64, f32)], duration: f64) -> Vec<f32> {
        let n = (duration * 16_000.0) as usize;
        let mut samples = vec![1e-4f32; n];
        for &(start, end, amp) in events {
            let s = (start * 16_000.0) as usize;
            let e = ((end * 16_000.0) as usize).min(n);
            for (i, sample) in samples.iter_mut().enumerate().take(e).skip(s) {
                *sample = amp * (2.0 * std::f32::consts::PI * 180.0 * i as f32 / 16_000.0).sin();
            }
        }
        samples
    }

    fn sealed_test_settings() -> FetchrMuteSettings {
        FetchrMuteSettings {
            mute_profile: FetchrMuteProfile::Sealed,
            coverage_percent: 100,
            only_custom_words: true,
            custom_words: vec!["мат".to_string()],
            ..FetchrMuteSettings::default()
        }
    }

    fn sealed_partial_test_settings() -> FetchrMuteSettings {
        FetchrMuteSettings {
            mute_profile: FetchrMuteProfile::Sealed,
            only_custom_words: true,
            custom_words: vec!["мат".to_string()],
            coverage_percent: 60,
            fade_out_ms: 60,
            fade_in_ms: 30,
            min_mute_ms: 120,
            ..FetchrMuteSettings::default()
        }
    }

    fn sealed_word(start: f64, end: f64) -> WordHit {
        WordHit {
            lemma: None,
            verified: None,
            raw: "мат".to_string(),
            normalized: "мат".to_string(),
            start,
            end,
            confidence: 1.0,
        }
    }

    #[test]
    fn sealed_refine_extends_to_real_energy_edges() {
        // Энергия слова шире ASR-интервала [1.8, 2.3]: всплеск 1.65–2.40.
        let samples = sealed_envelope_samples(&[(1.65, 2.40, 0.3)], 4.0);
        let words = vec![sealed_word(1.8, 2.3)];
        let settings = sealed_test_settings();
        let spans = build_mute_spans(
            &words,
            &ProfaneDictionary::from(["мат".to_string()]),
            &settings,
        );
        assert_eq!(spans.len(), 1);
        let refined = refine_sealed_spans(spans, &words, &samples, 16_000, &settings);
        assert_eq!(refined.len(), 1);
        assert!(
            (refined[0].start - 1.65).abs() <= 0.02,
            "start={}",
            refined[0].start
        );
        assert!(
            (refined[0].end - 2.415).abs() <= 0.02,
            "end={}",
            refined[0].end
        );
    }

    #[test]
    fn sealed_partial_coverage_base_span_keeps_fades_inside_word() {
        // Покрытие 60% без уточнения: ядро внутри ASR-интервала [1.8, 2.3],
        // затухание 60 мс после начала слова, возврат 30 мс и хвост ≤ 75 мс
        // до конца слова. Пады в паузы не добавляются, иначе ядро раздувается
        // сверх запрошенной доли.
        let words = vec![sealed_word(1.8, 2.3)];
        let settings = sealed_partial_test_settings();
        let spans = build_mute_spans(
            &words,
            &ProfaneDictionary::from(["мат".to_string()]),
            &settings,
        );
        assert_eq!(spans.len(), 1);
        assert!(
            (spans[0].start - 1.86).abs() < 1e-9,
            "start={}",
            spans[0].start
        );
        assert!((spans[0].end - 2.195).abs() < 1e-9, "end={}", spans[0].end);
    }

    #[test]
    fn sealed_partial_coverage_carves_core_inside_refined_region() {
        // Уточнение расширяет ОБЛАСТЬ огибающей до энергетических краёв слова
        // [1.65, 2.415], а ядро 60% вырезается внутри неё: начало через 60 мс
        // рампы, хвост (30 мс рампы + ≤ 75 мс) остаётся слышимым.
        let samples = sealed_envelope_samples(&[(1.65, 2.40, 0.3)], 4.0);
        let words = vec![sealed_word(1.8, 2.3)];
        let settings = sealed_partial_test_settings();
        let spans = build_mute_spans(
            &words,
            &ProfaneDictionary::from(["мат".to_string()]),
            &settings,
        );
        let refined = refine_sealed_spans(spans, &words, &samples, 16_000, &settings);
        assert_eq!(refined.len(), 1);
        assert!(
            (refined[0].start - 1.71).abs() <= 0.02,
            "start={}",
            refined[0].start
        );
        assert!(
            (refined[0].end - 2.31).abs() <= 0.02,
            "end={}",
            refined[0].end
        );
        assert!(
            refined[0].end < 2.40,
            "tail must stay audible: end={}",
            refined[0].end
        );
    }

    #[test]
    fn sealed_partial_coverage_never_leaks_outside_refined_region() {
        // Ядро не выходит за пределы уточнённой области: рампы рендерера ложатся
        // снаружи ядра, но всегда внутри слова, соседи не затрагиваются.
        let samples = sealed_envelope_samples(&[(1.65, 2.40, 0.3)], 4.0);
        let words = vec![sealed_word(1.8, 2.3)];
        let settings = sealed_partial_test_settings();
        let spans = build_mute_spans(
            &words,
            &ProfaneDictionary::from(["мат".to_string()]),
            &settings,
        );
        let refined = refine_sealed_spans(spans, &words, &samples, 16_000, &settings);
        let (fade_out, fade_in) = (
            settings.fade_out_ms as f64 / 1000.0,
            settings.fade_in_ms as f64 / 1000.0,
        );
        assert!(refined[0].start - fade_out >= 1.65 - 1e-9);
        assert!(refined[0].end + fade_in <= 2.415 + 1e-9);
    }

    #[test]
    fn sealed_refine_bridges_intraword_stop_gap() {
        // Всплеск 1.65–2.40 с микропровалом 20 мс на 2.00–2.02 (взрывная
        // согласная): хвост слова 2.02–2.40 обязан попасть в мут.
        let samples = sealed_envelope_samples(&[(1.65, 2.00, 0.3), (2.02, 2.40, 0.3)], 4.0);
        let words = vec![sealed_word(1.8, 1.95)];
        let settings = sealed_test_settings();
        let spans = build_mute_spans(
            &words,
            &ProfaneDictionary::from(["мат".to_string()]),
            &settings,
        );
        let refined = refine_sealed_spans(spans, &words, &samples, 16_000, &settings);
        assert!(
            refined[0].end > 2.3,
            "stop gap must not cut the tail: end={}",
            refined[0].end
        );
    }

    #[test]
    fn sealed_refine_never_crosses_corridor_into_next_word() {
        // Слитная речь: следующее слово начинается внутри нашего всплеска.
        // Громкая энергия у коридора — это уже соседнее слово: край мута
        // остаётся на коридоре и в чужое слово не заходит.
        let samples = sealed_envelope_samples(&[(1.65, 2.55, 0.3), (2.90, 3.20, 0.3)], 4.0);
        let words = vec![
            sealed_word(1.8, 2.3),
            WordHit {
            lemma: None,
            verified: None,
                raw: "дал".to_string(),
                normalized: "дал".to_string(),
                start: 2.45,
                end: 2.6,
                confidence: 1.0,
            },
        ];
        let settings = sealed_test_settings();
        let spans = build_mute_spans(
            &words,
            &ProfaneDictionary::from(["мат".to_string()]),
            &settings,
        );
        let refined = refine_sealed_spans(spans, &words, &samples, 16_000, &settings);
        let corridor = (2.3 + 2.45) / 2.0;
        assert!(
            refined[0].end <= corridor + 1e-9,
            "mute must stop at the corridor: end={}",
            refined[0].end
        );
    }

    #[test]
    fn sealed_refine_keeps_corridor_when_quiet() {
        // Обычная пауза: коридор не переопределяется, край — на провале.
        let samples = sealed_envelope_samples(&[(1.65, 2.40, 0.3), (2.90, 3.20, 0.3)], 4.0);
        let words = vec![
            sealed_word(1.8, 2.3),
            WordHit {
            lemma: None,
            verified: None,
                raw: "дал".to_string(),
                normalized: "дал".to_string(),
                start: 2.9,
                end: 3.1,
                confidence: 1.0,
            },
        ];
        let settings = sealed_test_settings();
        let spans = build_mute_spans(
            &words,
            &ProfaneDictionary::from(["мат".to_string()]),
            &settings,
        );
        let refined = refine_sealed_spans(spans, &words, &samples, 16_000, &settings);
        assert!(
            (refined[0].end - 2.415).abs() <= 0.02,
            "end={}",
            refined[0].end
        );
    }

    #[test]
    fn spans_without_speech_under_them_are_dropped() {
        // Мусорная гипотеза ASR на тишине: под спаном нет речи, мут в этом
        // месте слышен как провал в дорожке.
        let samples = sealed_envelope_samples(&[(0.2, 1.0, 0.3), (3.0, 3.8, 0.3)], 5.0);
        let words = vec![sealed_word(1.8, 2.1)];
        let settings = sealed_test_settings();
        let spans = build_mute_spans(
            &words,
            &ProfaneDictionary::from(["мат".to_string()]),
            &settings,
        );
        assert_eq!(spans.len(), 1);
        let refined = refine_sealed_spans(spans, &words, &samples, 16_000, &settings);
        assert!(refined.is_empty(), "refined={refined:?}");
    }

    #[test]
    fn sealed_refine_never_shrinks_spans_and_ignores_other_profiles() {
        let samples = sealed_envelope_samples(&[(1.65, 2.40, 0.3)], 4.0);
        let words = vec![sealed_word(1.8, 2.3)];
        let settings = sealed_test_settings();
        let spans = build_mute_spans(
            &words,
            &ProfaneDictionary::from(["мат".to_string()]),
            &settings,
        );
        let base = (spans[0].start, spans[0].end);
        let refined = refine_sealed_spans(spans, &words, &samples, 16_000, &settings);
        assert!(refined[0].start <= base.0 + 1e-9);
        assert!(refined[0].end + 1e-9 >= base.1);

        // Reference-профиль: та же функция обязана быть no-op.
        let reference = FetchrMuteSettings {
            mute_profile: FetchrMuteProfile::Reference,
            ..FetchrMuteSettings::default()
        };
        let spans = vec![MuteSpan {
            word: "мат".to_string(),
            start: 1.7,
            end: 2.3,
        }];
        let untouched = refine_sealed_spans(spans, &words, &samples, 16_000, &reference);
        assert_eq!(untouched[0].start, 1.7);
        assert_eq!(untouched[0].end, 2.3);
    }

    #[test]
    fn reference_profile_keeps_adjacent_words_as_separate_spans() {
        let settings = FetchrMuteSettings::default();
        let profane_words = ProfaneDictionary::from(["мат".to_string()]);
        let words = vec![
            WordHit {
            lemma: None,
            verified: None,
                raw: "мат".to_string(),
                normalized: "мат".to_string(),
                start: 5.0,
                end: 5.4,
                confidence: 1.0,
            },
            WordHit {
            lemma: None,
            verified: None,
                raw: "мат".to_string(),
                normalized: "мат".to_string(),
                start: 5.42,
                end: 5.82,
                confidence: 1.0,
            },
        ];

        let spans = build_mute_spans(&words, &profane_words, &settings);
        assert_eq!(spans.len(), 2);
        assert_eq!(spans[0].word, "мат");
        assert_eq!(spans[1].word, "мат");
    }

    #[test]
    fn reference_envelope_matches_asymmetric_timing() {
        use std::process::Command as StdCommand;

        let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let executable = if cfg!(windows) {
            "ffmpeg.exe"
        } else {
            "ffmpeg"
        };
        let candidates = [
            manifest_dir.join(executable),
            manifest_dir
                .parent()
                .unwrap_or(&manifest_dir)
                .join(executable),
        ];
        let Some(ffmpeg) = candidates.into_iter().find(|path| path.is_file()) else {
            eprintln!("Skipping reference envelope test: bundled ffmpeg not found");
            return;
        };

        let settings = FetchrMuteSettings {
            mute_profile: FetchrMuteProfile::Reference,
            ..FetchrMuteSettings::default()
        };
        let filter = audio_filter_reference_env(
            &settings,
            &[MuteSpan {
                word: "test".to_string(),
                start: 0.8,
                end: 1.2,
            }],
            48_000,
            1,
        )
        .expect("reference filter graph");
        let output = StdCommand::new(ffmpeg)
            .args([
                "-hide_banner",
                "-loglevel",
                "error",
                "-f",
                "lavfi",
                "-i",
                "aevalsrc=1:s=48000:d=2",
                "-filter_complex",
                filter.trim(),
                "-map",
                "[aout]",
                "-ac",
                "1",
                "-c:a",
                "pcm_f32le",
                "-f",
                "f32le",
                "pipe:1",
            ])
            .output()
            .expect("run bundled ffmpeg");
        assert!(
            output.status.success(),
            "ffmpeg failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );

        let samples: Vec<f32> = output
            .stdout
            .chunks_exact(4)
            .map(|bytes| f32::from_le_bytes(bytes.try_into().unwrap()))
            .collect();
        let at = |seconds: f64| samples[(seconds * 48_000.0).round() as usize];
        assert!((at(0.700) - 1.0).abs() < 0.001);
        assert!(at(0.800).abs() < 0.001);
        assert!(at(1.200).abs() < 0.001);
        assert!((at(1.205) - 1.0).abs() < 0.01);

        let find_crossing = |from: f64, to: f64, threshold: f32, rising: bool| {
            let start = (from * 48_000.0) as usize;
            let end = (to * 48_000.0) as usize;
            (start..end)
                .find(|&index| {
                    if rising {
                        samples[index] >= threshold
                    } else {
                        samples[index] <= threshold
                    }
                })
                .unwrap()
        };
        let down_90 = find_crossing(0.700, 0.800, 0.9, false);
        let down_10 = find_crossing(0.700, 0.800, 0.1, false);
        let up_10 = find_crossing(1.200, 1.205, 0.1, true);
        let up_90 = find_crossing(1.200, 1.206, 0.9, true);
        let down_ms = (down_10 - down_90) as f64 / 48.0;
        let up_ms = (up_90 - up_10) as f64 / 48.0;
        assert!((55.0..=65.0).contains(&down_ms), "down={down_ms:.2} ms");
        assert!((2.5..=3.5).contains(&up_ms), "up={up_ms:.2} ms");
    }

    #[test]
    fn reference_mute_preserves_both_stereo_channels() {
        use std::process::Command as StdCommand;

        let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let executable = if cfg!(windows) {
            "ffmpeg.exe"
        } else {
            "ffmpeg"
        };
        let candidates = [
            manifest_dir.join(executable),
            manifest_dir
                .parent()
                .unwrap_or(&manifest_dir)
                .join(executable),
        ];
        let Some(ffmpeg) = candidates.into_iter().find(|path| path.is_file()) else {
            eprintln!("Skipping stereo envelope test: bundled ffmpeg not found");
            return;
        };

        let filter = audio_filter_reference_env(
            &FetchrMuteSettings::default(),
            &[MuteSpan {
                word: "test".to_string(),
                start: 0.4,
                end: 0.6,
            }],
            48_000,
            2,
        )
        .expect("stereo reference filter graph");
        assert!(filter.contains(":s=2000:"));
        assert!(filter.contains("pan=stereo|c0=c0|c1=c0"));
        assert!(filter.contains("[0:a:0][refenv]amultiply"));

        let output = StdCommand::new(ffmpeg)
            .args([
                "-hide_banner",
                "-loglevel",
                "error",
                "-f",
                "lavfi",
                "-i",
                "aevalsrc=exprs='0.25|0.5':s=48000:d=1:c=stereo",
                "-filter_complex",
                filter.trim(),
                "-map",
                "[aout]",
                "-ac",
                "2",
                "-c:a",
                "pcm_f32le",
                "-f",
                "f32le",
                "pipe:1",
            ])
            .output()
            .expect("run bundled ffmpeg");
        assert!(
            output.status.success(),
            "ffmpeg failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );

        let samples: Vec<f32> = output
            .stdout
            .chunks_exact(4)
            .map(|bytes| f32::from_le_bytes(bytes.try_into().unwrap()))
            .collect();
        let at = |seconds: f64, channel: usize| {
            let frame = (seconds * 48_000.0).round() as usize;
            samples[frame * 2 + channel]
        };
        assert!((at(0.2, 0) - 0.25).abs() < 0.001);
        assert!((at(0.2, 1) - 0.5).abs() < 0.001);
        assert!(at(0.5, 0).abs() < 0.001);
        assert!(at(0.5, 1).abs() < 0.001);
        assert!((at(0.7, 0) - 0.25).abs() < 0.001);
        assert!((at(0.7, 1) - 0.5).abs() < 0.001);
    }

    #[test]
    fn coverage_slider_is_monotonic_for_different_word_lengths() {
        for padded_duration in [0.35, 0.5, 0.8, 1.4] {
            let word = WordHit {
            lemma: None,
            verified: None,
                raw: "test".to_string(),
                normalized: "test".to_string(),
                start: 10.0,
                end: 10.0 + padded_duration,
                confidence: 1.0,
            };
            let (full_start, full_end) = covered_word_span(&word, 1.0, 0.0, 0.0);
            let full_duration = full_end - full_start;
            let mut previous_duration = 0.0;
            let mut previous_start = f64::INFINITY;
            let mut previous_end = f64::NEG_INFINITY;

            for percent in (20..=100).step_by(5) {
                let coverage = percent as f64 / 100.0;
                let (start, end) = covered_word_span(&word, coverage, 0.0, 0.0);
                let duration = end - start;
                assert!(duration + 1e-9 >= previous_duration);
                assert!(start <= previous_start + 1e-9);
                assert!(end + 1e-9 >= previous_end);
                assert!(
                    (duration / full_duration - coverage).abs() < 1e-8,
                    "duration={padded_duration}, coverage={coverage}, span={duration}, full={full_duration}"
                );
                previous_duration = duration;
                previous_start = start;
                previous_end = end;
            }
        }
    }

    #[test]
    fn context_clamp_survives_tight_and_overlapping_words() {
        let muted = WordHit {
            lemma: None,
            verified: None,
            raw: "bad".to_string(),
            normalized: "bad".to_string(),
            start: 10.0,
            end: 10.65,
            confidence: 1.0,
        };
        for gap in [-0.06, 0.0, 0.02, 0.12] {
            let previous = WordHit {
            lemma: None,
            verified: None,
                raw: "before".to_string(),
                normalized: "before".to_string(),
                start: 9.35,
                end: 10.0 + gap,
                confidence: 1.0,
            };
            let next = WordHit {
            lemma: None,
            verified: None,
                raw: "after".to_string(),
                normalized: "after".to_string(),
                start: 10.65 - gap,
                end: 11.3,
                confidence: 1.0,
            };
            let left_boundary = context_boundary(&previous, &muted);
            let right_boundary = context_boundary(&muted, &next);
            for percent in (20..=100).step_by(5) {
                let (start, end) = covered_word_span_with_context(
                    &muted,
                    Some(&previous),
                    Some(&next),
                    percent as f64 / 100.0,
                    0.03,
                    0.02,
                    UNCOVERED_LEAD_SHARE,
                    false,
                    0.0,
                    0.0,
                    MIN_SPAN_S,
                    f64::INFINITY,
                    AudibleTail::fixed(REFERENCE_MAX_AUDIBLE_TAIL_S),
                );
                assert!(start >= left_boundary - 1e-9);
                assert!(end <= right_boundary + 1e-9);
                assert!(end > start);
            }
        }
    }

    #[test]
    fn ffmpeg_envelope_has_a_smooth_measured_transition() {
        use std::process::Command as StdCommand;

        let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let executable = if cfg!(windows) {
            "ffmpeg.exe"
        } else {
            "ffmpeg"
        };
        let candidates = [
            manifest_dir.join(executable),
            manifest_dir
                .parent()
                .unwrap_or(&manifest_dir)
                .join(executable),
        ];
        let Some(ffmpeg) = candidates.into_iter().find(|path| path.is_file()) else {
            eprintln!("Skipping measured envelope test: bundled ffmpeg not found");
            return;
        };

        let settings = FetchrMuteSettings {
            censor_method: FetchrMuteCensorMethod::Mute,
            ..Default::default()
        };
        let filter = audio_filter_smooth_env(
            &settings,
            &[MuteSpan {
                word: "test".to_string(),
                start: 0.8,
                end: 1.2,
            }],
            48_000,
            1,
        )
        .expect("smooth filter graph");

        let output = StdCommand::new(ffmpeg)
            .args([
                "-hide_banner",
                "-loglevel",
                "error",
                "-f",
                "lavfi",
                "-i",
                "aevalsrc=1:s=48000:d=2",
                "-filter_complex",
                filter.trim(),
                "-map",
                "[aout]",
                "-ac",
                "1",
                "-c:a",
                "pcm_f32le",
                "-f",
                "f32le",
                "pipe:1",
            ])
            .output()
            .expect("run bundled ffmpeg");
        assert!(
            output.status.success(),
            "ffmpeg failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );

        let samples: Vec<f32> = output
            .stdout
            .chunks_exact(4)
            .map(|bytes| f32::from_le_bytes(bytes.try_into().unwrap()))
            .collect();
        assert!(samples.len() >= 48_000 * 2);
        assert!((samples[24_000] - 1.0).abs() < 0.02);
        assert!(samples[48_000].abs() < 0.01);

        let search_start = (0.65 * 48_000.0) as usize;
        let center = 48_000usize;
        let below_90 = (search_start..center)
            .find(|&index| samples[index] <= 0.9)
            .expect("attack reaches 90%");
        let below_10 = (below_90..center)
            .find(|&index| samples[index] <= 0.1)
            .expect("attack reaches 10%");
        let attack_ms = (below_10 - below_90) as f64 * 1000.0 / 48_000.0;
        assert!(
            (16.0..=30.0).contains(&attack_ms),
            "unexpected 90→10% attack: {attack_ms:.2} ms"
        );

        let max_step = samples
            .windows(2)
            .map(|pair| (pair[1] - pair[0]).abs())
            .fold(0.0f32, f32::max);
        assert!(max_step < 0.01, "envelope has an abrupt step: {max_step}");
        assert!(samples.iter().all(|sample| (-0.01..=1.02).contains(sample)));
    }

    #[test]
    fn coverage_expands_around_the_word_core() {
        let word = WordHit {
            lemma: None,
            verified: None,
            raw: "пиздец".to_string(),
            normalized: "пиздец".to_string(),
            start: 20.0,
            end: 20.6,
            confidence: 1.0,
        };

        let (s20, e20) = covered_word_span(&word, 0.2, 0.0, 0.0);
        let (s60, e60) = covered_word_span(&word, 0.6, 0.0, 0.0);
        let (s100, e100) = covered_word_span(&word, 1.0, 0.0, 0.0);
        assert!(s20 > s60 && s60 > s100);
        assert!(e20 < e60 && e60 < e100);
    }

    #[test]
    fn coverage_slider_changes_span_length() {
        let word = WordHit {
            lemma: None,
            verified: None,
            raw: "блять".to_string(),
            normalized: "блять".to_string(),
            start: 30.0,
            end: 30.8,
            confidence: 1.0,
        };
        let (s20, e20) = covered_word_span(&word, 0.2, 0.0, 0.0);
        let (s60, e60) = covered_word_span(&word, 0.6, 0.0, 0.0);
        let (s100, e100) = covered_word_span(&word, 1.0, 0.0, 0.0);
        let full_duration = e100 - s100;
        assert!(((e20 - s20) / full_duration - 0.2).abs() < 1e-9);
        assert!(((e60 - s60) / full_duration - 0.6).abs() < 1e-9);
        assert!(s20 > s60 && s60 > s100);
        assert!(e20 < e60 && e60 < e100);
    }

    #[test]
    fn partial_coverage_uses_asr_alignment_preroll() {
        let word = WordHit {
            lemma: None,
            verified: None,
            raw: "блять".to_string(),
            normalized: "блять".to_string(),
            start: 30.0,
            end: 30.6,
            confidence: 1.0,
        };
        let (start, _end) = covered_word_span(&word, 0.6, 0.030, 0.022);
        let raw_start = 30.0;
        assert!(
            start < raw_start + 0.18,
            "mute starts too late: start={start}, emission_start={raw_start}"
        );
    }

    // -----------------------------------------------------------------------
    // Стоимость обработки. Эти тесты ловят не ошибку в результате, а холостую
    // работу: конвейер обязан платить за длину файла, а не за размер словаря
    // и не за квадрат числа слов.
    // -----------------------------------------------------------------------

    /// Детерминированный словарь из разных первых букв и длин — как настоящий
    /// `wordlist.txt`, но заданного размера.
    fn synthetic_dictionary(size: usize) -> Vec<String> {
        const LETTERS: [char; 29] = [
            'а', 'б', 'в', 'г', 'д', 'е', 'ж', 'з', 'и', 'к', 'л', 'м', 'н', 'о', 'п', 'р', 'с',
            'т', 'у', 'ф', 'х', 'ц', 'ч', 'ш', 'щ', 'ы', 'э', 'ю', 'я',
        ];
        (0..size)
            .map(|index| {
                let mut value = index;
                let length = 5 + index % 4;
                (0..length)
                    .map(|_| {
                        let letter = LETTERS[value % LETTERS.len()];
                        value = value / LETTERS.len() + 1;
                        letter
                    })
                    .collect()
            })
            .collect()
    }

    /// Чистая транскрипция: ни одно слово не должно совпасть со словарём,
    /// то есть каждое проходит матчер по самому длинному пути.
    fn clean_transcript(count: usize) -> Vec<WordHit> {
        const CLEAN: [&str; 8] = [
            "который",
            "сегодня",
            "поэтому",
            "например",
            "конечно",
            "довольно",
            "серьёзно",
            "наверное",
        ];
        (0..count)
            .map(|index| {
                let raw = CLEAN[index % CLEAN.len()].to_string();
                WordHit {
            lemma: None,
            verified: None,
                    normalized: normalize_word(&raw),
                    raw,
                    start: index as f64 * 0.4,
                    end: index as f64 * 0.4 + 0.3,
                    confidence: 0.9,
                }
            })
            .collect()
    }

    fn matching_settings(dictionary: &[String]) -> FetchrMuteSettings {
        FetchrMuteSettings {
            mute_profile: FetchrMuteProfile::Adaptive,
            censorship_level: FetchrMuteCensorshipLevel::Maximum,
            only_custom_words: true,
            custom_words: dictionary.to_vec(),
            ..FetchrMuteSettings::default()
        }
    }

    /// Детерминированная проверка: одно слово обязано сверяться с единицами
    /// словарных записей, а не со всем словарём. Время здесь не участвует,
    /// поэтому тест не зависит от машины и от debug/release.
    #[test]
    fn a_query_touches_only_a_few_dictionary_entries() {
        let entries = synthetic_dictionary(20_000);
        let settings = matching_settings(&entries);
        let dictionary = load_profane_words(&settings).expect("dictionary");
        assert!(dictionary.len() >= 19_000, "dictionary was not built");

        for word in clean_transcript(64) {
            let examined = dictionary.fuzzy_candidates_examined(&word.normalized);
            assert!(
                examined <= 32,
                "«{}» сверяется с {examined} записями словаря из {}",
                word.normalized,
                dictionary.len()
            );
        }
    }

    #[test]
    fn profane_matching_stays_fast_on_a_large_dictionary() {
        let entries = synthetic_dictionary(10_000);
        let settings = matching_settings(&entries);
        let dictionary = load_profane_words(&settings).expect("dictionary");
        let words = clean_transcript(2_000);

        let started = Instant::now();
        let spans = build_mute_spans(&words, &dictionary, &settings);
        let elapsed = started.elapsed();

        assert!(spans.is_empty(), "clean transcript must not be censored");
        assert!(
            elapsed < Duration::from_secs(3),
            "matching 2000 words against a 10k dictionary took {elapsed:?}"
        );
    }

    #[test]
    fn refine_does_not_scale_quadratically_with_words() {
        let settings = adaptive_settings();
        let samples = vec![0.05f32; SAMPLE_RATE as usize * 120];
        let measure = |count: usize| {
            let words: Vec<WordHit> = clean_transcript(count);
            let spans: Vec<MuteSpan> = words
                .iter()
                .step_by(40)
                .map(|word| MuteSpan {
                    word: word.raw.clone(),
                    start: word.start,
                    end: word.end,
                })
                .collect();
            let expected = spans.len();
            let started = Instant::now();
            let refined = refine_sealed_spans(spans, &words, &samples, SAMPLE_RATE, &settings);
            assert_eq!(refined.len(), expected);
            started.elapsed()
        };

        // Прогрев: первый замер платит за прогрев кэшей и аллокатора.
        measure(500);
        let small = measure(1_500);
        let large = measure(6_000);
        // Слов и спанов стало вчетверо больше. Линейный по словам проход даёт
        // примерно ×4, квадратичный — ×16.
        assert!(
            large < small * 8,
            "refine scales quadratically: 1.5k={small:?}, 6k={large:?}"
        );
    }

    #[test]
    fn silence_map_is_parsed_from_ffmpeg_output() {
        let stderr = concat!(
            "  Duration: 00:10:07.28, bitrate: 768 kb/s\n",
            "[Parsed_silencedetect_2 @ 000001] silence_start: 3.00375\n",
            "[Parsed_silencedetect_2 @ 000001] silence_end: 15.000063 | silence_duration: 11.996313\n",
            "[Parsed_silencedetect_2 @ 000001] silence_start: 40.5\n",
        );
        let map = parse_silence_map(stderr);
        assert_eq!(map.len(), 2, "{map:?}");
        assert!((map[0].0 - 3.00375).abs() < 1e-9, "{map:?}");
        assert!((map[0].1 - 15.000063).abs() < 1e-9, "{map:?}");
        // Незакрытая тишина в конце файла тянется до конца.
        assert!((map[1].0 - 40.5).abs() < 1e-9, "{map:?}");
        assert_eq!(map[1].1, f64::MAX, "{map:?}");
        assert!(parse_silence_map("no silence here").is_empty());
    }

    #[test]
    fn silence_map_keeps_silence_out_of_recognition() {
        let queue = Arc::new(QueueManager::new_mock(crate::app_log::AppLogger::new()));
        // Уровень ровный по всему файлу — ровно то, что делает dynaudnorm с
        // паузами. Энергетический порог здесь бессилен, карта тишины — нет.
        let audio: Vec<f32> = (0..SAMPLE_RATE as usize * 18)
            .map(|index| 0.1 * (2.0 * std::f32::consts::PI * 180.0 * index as f32 / 16_000.0).sin())
            .collect();
        let seconds = |segments: &[SpeechSegment]| {
            segments
                .iter()
                .map(|segment| segment.end_sample - segment.start_sample)
                .sum::<usize>() as f64
                / SAMPLE_RATE as f64
        };
        let detect = |silences: &[(f64, f64)]| {
            detect_speech_segments(
                SpeechLevels::Full(&audio),
                silences,
                &queue,
                "silence-map-test",
                Arc::new(AtomicBool::new(false)),
                FetchrMuteProcessingMode::Normal,
            )
            .expect("speech detection")
        };

        let without_map = seconds(&detect(&[]));
        let with_map = seconds(&detect(&[(3.0, 15.0)]));
        assert!(
            without_map > 17.0,
            "энергия обязана оставить весь файл: {without_map}"
        );
        assert!(
            with_map <= 7.0,
            "тишина 3..15 с не отсеклась: подано {with_map} с из 18 с"
        );
    }

    #[test]
    fn aac_output_uses_a_fast_encoder() {
        // Перекодировка AAC — 18 из 26 секунд рендера на замере; дефолтный
        // twoloop здесь недопустим.
        let without_mf = audio_codec_args(Path::new("out.mp4"), false);
        assert!(
            without_mf
                .windows(2)
                .any(|pair| pair == ["-aac_coder", "fast"]),
            "{without_mf:?}"
        );
        let with_mf = audio_codec_args(Path::new("out.mp4"), true);
        assert!(with_mf.contains(&"aac_mf".to_string()), "{with_mf:?}");
        assert!(!with_mf.contains(&"-aac_coder".to_string()), "{with_mf:?}");

        // Остальные форматы не трогаем.
        assert_eq!(
            audio_codec_args(Path::new("out.mp3"), true),
            vec!["-c:a", "libmp3lame", "-b:a", "192k"]
        );
        assert_eq!(
            audio_codec_args(Path::new("out.wav"), true),
            vec!["-c:a", "pcm_s16le"]
        );
        assert_eq!(
            audio_codec_args(Path::new("out.flac"), true),
            vec!["-c:a", "flac"]
        );
    }

    #[test]
    fn generated_envelope_matches_the_expression_shape() {
        let settings = FetchrMuteSettings {
            mute_profile: FetchrMuteProfile::Reference,
            fade_out_ms: 100,
            fade_in_ms: 50,
            ..FetchrMuteSettings::default()
        };
        let (fade_out, fade_in) = reference_fade_seconds(&settings);
        assert!((fade_out - 0.1).abs() < 1e-9 && (fade_in - 0.05).abs() < 1e-9);
        let span = MuteSpan {
            word: "мат".to_string(),
            start: 10.0,
            end: 10.5,
        };
        let at = |time: f64| reference_gain_at(time, &span, fade_out, fade_in);

        // Пять контрольных точек формы: до рампы, середина рампы вниз, ядро,
        // середина возврата, после возврата.
        assert!((at(9.5) - 1.0).abs() < 1e-4, "{}", at(9.5));
        assert!(
            (at(9.95) - 0.5).abs() < 1e-4,
            "середина рампы вниз: {}",
            at(9.95)
        );
        assert!(
            at(10.25).abs() < 1e-6,
            "ядро обязано быть нулём: {}",
            at(10.25)
        );
        assert!(
            (at(10.525) - 0.5).abs() < 1e-4,
            "середина возврата: {}",
            at(10.525)
        );
        assert!((at(11.0) - 1.0).abs() < 1e-4, "{}", at(11.0));
        // Рампа монотонна и не выходит за 0..1.
        let mut previous = 1.0f32;
        for step in 0..=100 {
            let value = at(10.0 - fade_out + fade_out * step as f64 / 100.0);
            assert!((0.0..=1.0).contains(&value));
            assert!(value <= previous + 1e-6, "рампа вниз не монотонна");
            previous = value;
        }
    }

    #[test]
    fn envelope_wav_covers_the_whole_source_and_holds_unity_outside_spans() {
        let settings = FetchrMuteSettings {
            mute_profile: FetchrMuteProfile::Reference,
            ..FetchrMuteSettings::default()
        };
        let spans = vec![MuteSpan {
            word: "мат".to_string(),
            start: 2.0,
            end: 2.4,
        }];
        let path = std::env::temp_dir().join(format!("fetchr-env-{}.wav", uuid::Uuid::new_v4()));
        write_reference_envelope_wav(&path, &settings, &spans, 10.0).unwrap();

        let mut reader = hound::WavReader::open(&path).unwrap();
        assert_eq!(reader.spec().sample_rate, REFERENCE_ENVELOPE_SAMPLE_RATE);
        assert_eq!(reader.spec().channels, 1);
        let samples: Vec<f32> = reader.samples::<f32>().map(|s| s.unwrap()).collect();

        // Огибающая обязана пережить исходник: amultiply кончается по короткому
        // входу, и её недостача молча обрезала бы файл.
        let seconds = samples.len() as f64 / REFERENCE_ENVELOPE_SAMPLE_RATE as f64;
        assert!(
            seconds >= 10.0 + ENVELOPE_TAIL_S,
            "хвост короче источника: {seconds}"
        );

        let at = |time: f64| samples[(time * REFERENCE_ENVELOPE_SAMPLE_RATE as f64) as usize];
        assert!((at(0.5) - 1.0).abs() < 1e-4);
        assert!(at(2.2).abs() < 1e-4, "ядро спана обязано быть нулём");
        assert!((at(9.0) - 1.0).abs() < 1e-4);
        assert!((at(14.0) - 1.0).abs() < 1e-4, "хвост обязан быть единицей");
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn generated_envelope_filter_reads_the_extra_input() {
        let settings = FetchrMuteSettings {
            mute_profile: FetchrMuteProfile::Reference,
            ..FetchrMuteSettings::default()
        };
        let filter = audio_filter_reference_env_from_input(&settings, 48_000, 2, 1).unwrap();
        assert!(filter.contains("[1:a:0]"), "{filter}");
        assert!(filter.contains("amultiply[aout]"), "{filter}");
        // Никаких вычисляемых выражений на всю длину.
        assert!(!filter.contains("aevalsrc"), "{filter}");
    }

    #[test]
    fn envelope_beep_matches_classic_beep_level() {
        let spans = vec![MuteSpan {
            word: "test".to_string(),
            start: 1.0,
            end: 2.0,
        }];
        for profile in [FetchrMuteProfile::Reference, FetchrMuteProfile::Adaptive] {
            let settings = FetchrMuteSettings {
                mute_profile: profile,
                censor_method: FetchrMuteCensorMethod::Beep,
                ..FetchrMuteSettings::default()
            };
            let filters = [
                audio_filter_reference_env_from_input(&settings, 48_000, 2, 1).unwrap(),
                audio_filter_reference_env(&settings, &spans, 48_000, 2).unwrap(),
            ];
            for filter in filters {
                assert!(
                    filter.contains("duration=86400,volume=2.24,"),
                    "{filter}"
                );
                assert!(!filter.contains("volume=0.28"), "{filter}");
            }
        }
    }

    fn spaced_spans(count: usize) -> Vec<MuteSpan> {
        (0..count)
            .map(|index| MuteSpan {
                word: "мат".to_string(),
                start: index as f64 * 2.0 + 1.0,
                end: index as f64 * 2.0 + 1.3,
            })
            .collect()
    }

    fn custom_sound_settings(profile: FetchrMuteProfile) -> FetchrMuteSettings {
        FetchrMuteSettings {
            mute_profile: profile,
            censor_method: FetchrMuteCensorMethod::Custom,
            custom_sound_path: Some("beep.wav".to_string()),
            ..FetchrMuteSettings::default()
        }
    }

    #[test]
    fn broadcast_keeps_mono_and_stereo_and_copies_wider_layouts() {
        assert_eq!(broadcast_mono(1), "aformat=channel_layouts=mono");
        assert_eq!(broadcast_mono(2), "pan=stereo|c0=c0|c1=c0");
        assert_eq!(
            broadcast_mono(6),
            "pan=6c|c0=c0|c1=c0|c2=c0|c3=c0|c4=c0|c5=c0"
        );
        assert_eq!(replacement_layout(1), "aformat=channel_layouts=mono");
        assert_eq!(replacement_layout(2), "aformat=channel_layouts=stereo");
        assert_eq!(
            replacement_layout(8),
            format!("aformat=channel_layouts=mono,{}", broadcast_mono(8))
        );
    }

    #[test]
    fn surround_sources_use_the_envelope_paths_without_per_sample_expressions() {
        let spans = spaced_spans(300);
        let wide = broadcast_mono(6);
        for profile in [FetchrMuteProfile::Reference, FetchrMuteProfile::Adaptive] {
            for method in [
                FetchrMuteCensorMethod::Mute,
                FetchrMuteCensorMethod::Beep,
                FetchrMuteCensorMethod::Custom,
            ] {
                let settings = FetchrMuteSettings {
                    censor_method: method,
                    ..custom_sound_settings(profile)
                };
                let from_wav = audio_filter_reference_env_from_input(&settings, 48_000, 6, 2).unwrap();
                assert!(from_wav.contains(&wide), "{from_wav}");
                assert!(!from_wav.contains("aeval='val(ch)"), "{from_wav}");
                let from_expr = audio_filter_reference_env(&settings, &spans, 48_000, 6).unwrap();
                assert!(from_expr.contains(&wide));
                assert!(!from_expr.contains("aeval='val(ch)"));
            }
        }

        for method in [
            FetchrMuteCensorMethod::Mute,
            FetchrMuteCensorMethod::Beep,
            FetchrMuteCensorMethod::Custom,
        ] {
            let settings = FetchrMuteSettings {
                censor_method: method,
                ..custom_sound_settings(FetchrMuteProfile::Classic)
            };
            let filter = audio_filter_smooth_env(&settings, &spans, 48_000, 6).unwrap();
            assert!(filter.contains("[aout]"), "{filter}");
            assert!(!filter.contains("aeval="), "{filter}");
            // Огибающая считается в моно и раздаётся по каналам в самом конце.
            assert!(filter.contains("exprs='1':s=48000:d=86400:c=mono"), "{filter}");
            assert!(filter.contains(&format!("aformat=channel_layouts=mono,{wide}[env]")));
            // 300 спанов → гейты разбиты на куски, а не одно огромное выражение.
            assert!(filter.contains("[envgate_1]"), "{filter}");
            if !matches!(method, FetchrMuteCensorMethod::Mute) {
                assert!(filter.contains(&format!("{wide}[ienv]")), "{filter}");
            }
        }
    }

    #[test]
    fn stereo_smooth_envelope_is_unchanged_by_the_surround_path() {
        let settings = FetchrMuteSettings {
            censor_method: FetchrMuteCensorMethod::Beep,
            ..FetchrMuteSettings::default()
        };
        let filter = audio_filter_smooth_env(&settings, &spaced_spans(3), 48_000, 2).unwrap();
        assert!(filter.contains("exprs='1|1':s=48000:d=86400:c=stereo[envsrc]"), "{filter}");
        assert!(filter.contains("aformat=channel_layouts=stereo[env]"), "{filter}");
        assert!(!filter.contains("pan="), "{filter}");
    }

    #[test]
    fn filters_on_the_source_count_time_from_its_first_sample() {
        let spans = spaced_spans(250);
        for method in [
            FetchrMuteCensorMethod::Mute,
            FetchrMuteCensorMethod::Beep,
            FetchrMuteCensorMethod::Custom,
        ] {
            let settings = FetchrMuteSettings {
                censor_method: method,
                smooth_mute: false,
                ..custom_sound_settings(FetchrMuteProfile::Classic)
            };
            let chunked = audio_filter_chunked(&settings, &spans, MUTE_FILTER_CHUNK).unwrap();
            let bed = chunked.split(';').next().unwrap();
            assert!(bed.starts_with("[0:a:0]volume=volume='if(between((t-startt),1.000,1.300)"), "{bed}");
            assert!(bed.contains(":eval=frame"), "{bed}");
            // Метки исходника не трогаются — синхронность с видео прежняя.
            assert!(!chunked.contains("asetpts"), "{chunked}");
            assert!(chunked.contains("[aout]"), "{chunked}");
            // 250 спанов → пять кусков по SOURCE_GATE_CHUNK: длиннее выражение
            // `volume` парсер ffmpeg не принимает.
            let bed_label = if matches!(method, FetchrMuteCensorMethod::Mute) { "aout" } else { "bed" };
            assert!(chunked.contains(&format!("[{bed_label}_3]")), "{chunked}");
            assert!(!chunked.contains(&format!("[{bed_label}_4]")), "{chunked}");
            assert!(bed.matches("between(").count() <= SOURCE_GATE_CHUNK, "{bed}");
        }

        for profile in [FetchrMuteProfile::Classic, FetchrMuteProfile::Reference] {
            let settings = FetchrMuteSettings {
                censor_method: FetchrMuteCensorMethod::Mute,
                ..custom_sound_settings(profile)
            };
            let fallback = audio_filter_for_method(&settings, &spans).unwrap();
            assert!(fallback.contains("(n/s)"), "{profile:?}");
            assert!(!fallback.contains("lt(t,"), "{profile:?}");
            assert!(!fallback.contains("(t-"), "{profile:?}");
        }
    }

    #[test]
    fn fallback_expression_is_a_shallow_tree_not_a_product() {
        let spans = spaced_spans(400);
        let max_depth = |text: &str| {
            text.chars()
                .scan(0i32, |depth, ch| {
                    match ch {
                        '(' => *depth += 1,
                        ')' => *depth -= 1,
                        _ => {}
                    }
                    Some(*depth)
                })
                .max()
                .unwrap_or(0)
        };
        let classic = classic_envelope_expr_at(&spans, SOURCE_SAMPLE_TIME);
        // Множители группы склеиваются как `(f1)*(f2)`; у «Классики» это `))*((`.
        assert!(!classic.contains("))*(("), "непересекающиеся спаны не перемножаются");
        assert!(max_depth(&classic) < 60, "глубина {}", max_depth(&classic));

        let settings = FetchrMuteSettings {
            mute_profile: FetchrMuteProfile::Reference,
            ..FetchrMuteSettings::default()
        };
        let reference = reference_envelope_expr_at(&settings, &spans, SOURCE_SAMPLE_TIME);
        assert!(!reference.contains(")*(if("), "непересекающиеся спаны не перемножаются");
        assert!(max_depth(&reference) < 60, "глубина {}", max_depth(&reference));
        // Генерируемая огибающая читает собственное время, как и раньше.
        assert!(reference_envelope_expr(&settings, &spans).starts_with("if(lt(t,"));

        // Пересекающиеся окна остаются в одной группе и перемножаются.
        let overlapping = [
            MuteSpan { word: "a".to_string(), start: 1.0, end: 1.2 },
            MuteSpan { word: "b".to_string(), start: 1.21, end: 1.4 },
        ];
        assert!(classic_envelope_expr_at(&overlapping, "t").contains("))*(("));
        assert_eq!(classic_envelope_expr_at(&[], "t"), "1");
    }

    #[test]
    fn ffmpeg_progress_lines_are_parsed_to_seconds() {
        assert_eq!(parse_ffmpeg_progress_seconds("out_time_us=1500000"), Some(1.5));
        assert_eq!(parse_ffmpeg_progress_seconds("out_time_ms=2500000"), Some(2.5));
        assert_eq!(parse_ffmpeg_progress_seconds("out_time=00:01:02.500000"), Some(62.5));
        assert_eq!(parse_ffmpeg_progress_seconds("out_time=01:00:00.000000"), Some(3600.0));
        assert_eq!(parse_ffmpeg_progress_seconds("out_time=N/A"), None);
        assert_eq!(parse_ffmpeg_progress_seconds("out_time_us=N/A"), None);
        assert_eq!(
            parse_ffmpeg_progress_seconds("out_time_us=-9223372036854775807"),
            None
        );
        assert_eq!(parse_ffmpeg_progress_seconds("out_time=-00:00:00.021333"), None);
        assert_eq!(parse_ffmpeg_progress_seconds("frame=120"), None);
        assert_eq!(parse_ffmpeg_progress_seconds("progress=continue"), None);

        assert_eq!(progress_fraction(30.0, 60.0), 0.5);
        assert_eq!(progress_fraction(90.0, 60.0), 1.0);
        assert_eq!(progress_fraction(5.0, 0.0), 0.0);
        assert_eq!(progress_in_range(90.0, 99.0, 0.5), 94.5);
        assert_eq!(progress_in_range(90.0, 99.0, 2.0), 99.0);
        assert_eq!(progress_in_range(0.0, 100.0, -1.0), 0.0);

        let callback: ProgressCallback = Arc::new(|_| {});
        assert!(ffmpeg_progress(None, Some(callback.clone())).is_none());
        assert!(ffmpeg_progress(Some(0.0), Some(callback.clone())).is_none());
        assert!(ffmpeg_progress(Some(10.0), None).is_none());
        assert!(ffmpeg_progress(Some(10.0), Some(callback)).is_some());
    }

    fn bundled_ffmpeg() -> Option<PathBuf> {
        let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let executable = if cfg!(windows) { "ffmpeg.exe" } else { "ffmpeg" };
        [
            manifest_dir.join(executable),
            manifest_dir.parent().unwrap_or(&manifest_dir).join(executable),
        ]
        .into_iter()
        .find(|path| path.is_file())
    }

    /// Прогоняет `filter` над lavfi-источником и возвращает interleaved f32.
    fn run_filter_f32(ffmpeg: &Path, source: &str, filter: &str, channels: u32) -> Vec<f32> {
        let output = std::process::Command::new(ffmpeg)
            .args(["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", source])
            .args(["-filter_complex", filter.trim(), "-map", "[aout]"])
            .args(["-ac", &channels.to_string(), "-c:a", "pcm_f32le", "-f", "f32le", "pipe:1"])
            .output()
            .expect("run bundled ffmpeg");
        assert!(
            output.status.success(),
            "ffmpeg failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        output
            .stdout
            .chunks_exact(4)
            .map(|bytes| f32::from_le_bytes(bytes.try_into().unwrap()))
            .collect()
    }

    #[test]
    fn reference_mute_covers_every_surround_channel() {
        let Some(ffmpeg) = bundled_ffmpeg() else {
            eprintln!("Skipping surround envelope test: bundled ffmpeg not found");
            return;
        };
        let filter = audio_filter_reference_env(
            &FetchrMuteSettings::default(),
            &[MuteSpan {
                word: "test".to_string(),
                start: 0.4,
                end: 0.6,
            }],
            48_000,
            6,
        )
        .expect("surround reference filter graph");
        let samples = run_filter_f32(
            &ffmpeg,
            "aevalsrc=exprs='0.1|0.2|0.3|0.4|0.5|0.6':s=48000:d=1:c=5.1(side)",
            &filter,
            6,
        );
        let at = |seconds: f64, channel: usize| samples[(seconds * 48_000.0).round() as usize * 6 + channel];
        for channel in 0..6 {
            let level = 0.1 * (channel + 1) as f32;
            assert!((at(0.2, channel) - level).abs() < 0.001, "ch{channel} до спана");
            assert!(at(0.5, channel).abs() < 0.001, "ch{channel} в спане");
            assert!((at(0.8, channel) - level).abs() < 0.001, "ch{channel} после спана");
        }
    }

    #[test]
    fn surround_envelope_has_exactly_the_stereo_shape() {
        let Some(ffmpeg) = bundled_ffmpeg() else {
            eprintln!("Skipping surround shape test: bundled ffmpeg not found");
            return;
        };
        let spans = spaced_spans(3);
        for profile in [FetchrMuteProfile::Adaptive, FetchrMuteProfile::Classic] {
            let settings = FetchrMuteSettings {
                mute_profile: profile,
                ..FetchrMuteSettings::default()
            };
            let build = |channels| match profile {
                FetchrMuteProfile::Classic => audio_filter_smooth_env(&settings, &spans, 48_000, channels),
                _ => audio_filter_reference_env(&settings, &spans, 48_000, channels),
            }
            .unwrap();
            let stereo = run_filter_f32(&ffmpeg, "aevalsrc=exprs='1|1':s=48000:d=7:c=stereo", &build(2), 2);
            let surround = run_filter_f32(
                &ffmpeg,
                "aevalsrc=exprs='1|1|1|1|1|1':s=48000:d=7:c=5.1(side)",
                &build(6),
                6,
            );
            assert_eq!(stereo.len() / 2, surround.len() / 6, "{profile:?}");
            let worst = (0..stereo.len() / 2)
                .flat_map(|frame| (0..6).map(move |channel| (frame, channel)))
                .map(|(frame, channel)| (stereo[frame * 2] - surround[frame * 6 + channel]).abs())
                .fold(0.0f32, f32::max);
            assert!(worst < 1e-6, "{profile:?}: расхождение {worst}");
        }
    }

    #[test]
    fn hard_cut_lands_on_the_word_when_the_track_starts_late() {
        let Some(ffmpeg) = bundled_ffmpeg() else {
            eprintln!("Skipping start-offset test: bundled ffmpeg not found");
            return;
        };
        let settings = FetchrMuteSettings {
            mute_profile: FetchrMuteProfile::Classic,
            smooth_mute: false,
            ..FetchrMuteSettings::default()
        };
        let filter = audio_filter_chunked(
            &settings,
            &[MuteSpan {
                word: "test".to_string(),
                start: 1.0,
                end: 1.5,
            }],
            MUTE_FILTER_CHUNK,
        )
        .unwrap();
        // Дорожка стартует на 0.5 с позже контейнера: PTS первого кадра — 0.5.
        let shifted = format!(
            "aevalsrc=1:s=48000:d=3:n=1024[raw];[raw]asetpts=PTS+0.5/TB[src];{}",
            filter.replace("[0:a:0]", "[src]")
        );
        let output = std::process::Command::new(&ffmpeg)
            .args(["-hide_banner", "-loglevel", "error", "-filter_complex", shifted.trim()])
            .args(["-map", "[aout]", "-c:a", "pcm_f32le", "-f", "f32le", "pipe:1"])
            .output()
            .expect("run bundled ffmpeg");
        assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
        let samples: Vec<f32> = output
            .stdout
            .chunks_exact(4)
            .map(|bytes| f32::from_le_bytes(bytes.try_into().unwrap()))
            .collect();
        // Время слов — от первого сэмпла: тишина на 1.0–1.5, а не на 0.5–1.0.
        let at = |seconds: f64| samples[(seconds * 48_000.0) as usize];
        assert!((at(0.75) - 1.0).abs() < 1e-6, "мут уехал раньше слова");
        assert!(at(1.25).abs() < 1e-6, "слово не заглушено");
        assert!((at(1.75) - 1.0).abs() < 1e-6);
    }

    #[test]
    fn progress_events_are_throttled_and_only_grow() {
        let start = Instant::now();
        let at = |ms: u64| start + Duration::from_millis(ms);
        let mut throttle = ProgressThrottle::new(PROGRESS_EMIT_INTERVAL);
        assert_eq!(throttle.offer(0.1, at(0)), Some(0.1));
        assert_eq!(throttle.offer(0.2, at(100)), None, "чаще 150 мс");
        assert_eq!(throttle.offer(0.3, at(160)), Some(0.3));
        assert_eq!(throttle.offer(0.25, at(400)), None, "назад не идём");
        assert_eq!(throttle.offer(1.0, at(410)), Some(1.0), "конец проходит сразу");
        assert_eq!(throttle.offer(1.0, at(900)), None);
    }

    #[test]
    fn windowed_levels_produce_the_same_segments_as_a_full_read() {
        let queue = Arc::new(QueueManager::new_mock(crate::app_log::AppLogger::new()));
        // Непрерывная речь длиннее max_duration: разрез обязан попасть в тот же
        // тихий кадр, читаем мы весь файл или только окно поиска.
        let audio: Vec<f32> = (0..SAMPLE_RATE as usize * 40)
            .map(|index| {
                let seconds = index as f32 / SAMPLE_RATE as f32;
                // Провал громкости на 10.5 с и на 22.5 с — кандидаты в стык.
                let quiet = (seconds - 10.5).abs() < 0.05 || (seconds - 22.5).abs() < 0.05;
                let gain = if quiet { 0.001 } else { 0.1 };
                gain * (2.0 * std::f32::consts::PI * 180.0 * index as f32 / 16_000.0).sin()
            })
            .collect();

        let path = std::env::temp_dir().join(format!("fetchr-window-{}.wav", uuid::Uuid::new_v4()));
        let spec = hound::WavSpec {
            channels: 1,
            sample_rate: SAMPLE_RATE,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };
        let mut writer = hound::WavWriter::create(&path, spec).unwrap();
        for sample in &audio {
            writer
                .write_sample((sample * i16::MAX as f32) as i16)
                .unwrap();
        }
        writer.finalize().unwrap();

        assert_eq!(wav_sample_count(&path).unwrap(), audio.len());
        let silences = [(0.0, 0.0001)];
        let detect = |levels: SpeechLevels<'_>| {
            detect_speech_segments(
                levels,
                &silences,
                &queue,
                "windowed-test",
                Arc::new(AtomicBool::new(false)),
                FetchrMuteProcessingMode::Normal,
            )
            .expect("speech detection")
            .into_iter()
            .map(|segment| (segment.start_sample, segment.end_sample))
            .collect::<Vec<_>>()
        };

        let from_memory = detect(SpeechLevels::Full(&audio));
        let from_disk = detect(SpeechLevels::Windowed {
            path: &path,
            total_samples: audio.len(),
        });
        assert!(from_memory.len() > 1, "нужен хотя бы один разрез");
        assert_eq!(from_memory, from_disk);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn long_speech_is_cut_with_overlap_but_owned_once() {
        let queue = Arc::new(QueueManager::new_mock(crate::app_log::AppLogger::new()));
        // Непрерывная речь длиннее максимальной длины сегмента: куски идут с
        // нахлёстом (слово на стыке целиком попадает в один из них), а зоны
        // ответственности покрывают речь встык — слово не дублируется.
        let audio: Vec<f32> = (0..SAMPLE_RATE as usize * 40)
            .map(|index| 0.1 * (2.0 * std::f32::consts::PI * 180.0 * index as f32 / 16_000.0).sin())
            .collect();

        for mode in [
            FetchrMuteProcessingMode::Normal,
            FetchrMuteProcessingMode::Precise,
        ] {
            let segments = detect_speech_segments(
                SpeechLevels::Full(&audio),
                &[],
                &queue,
                "segment-overlap-test",
                Arc::new(AtomicBool::new(false)),
                mode,
            )
            .expect("speech detection");
            assert!(segments.len() > 1, "{mode:?} must split long speech");
            for pair in segments.windows(2) {
                assert_eq!(pair[0].keep_end_sample, pair[1].keep_start_sample);
                assert!(pair[1].start_sample < pair[0].end_sample, "{mode:?} needs overlap");
            }
            for segment in &segments {
                assert!(segment.start_sample <= segment.keep_start_sample);
                assert!(segment.keep_end_sample <= segment.end_sample);
            }
            let fed: usize = segments
                .iter()
                .map(|segment| segment.end_sample - segment.start_sample)
                .sum();
            let overlap = (ASR_SEGMENT_OVERLAP_S * SAMPLE_RATE as f64) as usize;
            assert!(
                fed <= audio.len() + 2 * overlap * (segments.len() - 1),
                "{mode:?} feeds {fed} samples of {} to ASR",
                audio.len()
            );
        }
    }
}

/// Cutoff of the TWO cascaded one-pole lowpasses rounding the 1→0→1 mute
/// envelope. Two poles at 24 Hz produce an approximately 20 ms 90%→10%
/// transition. This is audibly softer while retaining the same constant-cost
/// mono-envelope graph as the faster 45 Hz version.
const ENV_LOWPASS_HZ: u32 = 24;
/// Envelope frame size in samples. `enable` is evaluated once per frame, so in
/// Rust we pre-snap gate edges to this grid (start floor, end ceil → the gate
/// only ever widens the mute, never exposes the word). 256 samples keep slider
/// changes precise to about 5 ms at 48 kHz without per-sample expressions.
const ENV_FRAME_SAMPLES: f64 = 256.0;
/// Evaluate the expensive reference envelope at 2 kHz, then let FFmpeg's
/// resampler reconstruct it at the source rate. This retains sub-millisecond
/// timing accuracy while avoiding 48k/96k evaluations per second and channel.
const REFERENCE_ENVELOPE_SAMPLE_RATE: u32 = 2_000;
/// Предел `pan` в ffmpeg: шире огибающую по каналам не раздать.
const MAX_ENVELOPE_CHANNELS: u32 = 64;

/// Форма мута «Адаптивного» профиля. Значения фиксированы, а не берутся из
/// ползунков: профиль описывает конкретную огибающую, снятую с референса и
/// подстроенную на слух: рампа вниз 55 мс, возврат 15 мс, слышимый хвост —
/// динамический (см. ADAPTIVE_AUDIBLE_TAIL_*). Резкий обрыв в конце слова
/// звучит жёстко, поэтому хвост оставлен слышимым.
const ADAPTIVE_FADE_OUT_S: f64 = 0.055;
const ADAPTIVE_FADE_IN_S: f64 = 0.015;
/// Слышимый хвост «Адаптивного» — доля длительности слова, зажатая в 85–480 мс.
/// Фиксированные 55 мс одинаково резали и короткое «бля», и растянутое
/// «оху-и-и-тельно»: у длинного слова обрыв приходился на середину гласной.
const ADAPTIVE_AUDIBLE_TAIL_SHARE: f64 = 0.35;
const ADAPTIVE_AUDIBLE_TAIL_MIN_S: f64 = 0.085;
const ADAPTIVE_AUDIBLE_TAIL_MAX_S: f64 = 0.480;

fn reference_fade_seconds(settings: &FetchrMuteSettings) -> (f64, f64) {
    if is_adaptive(settings) {
        return (ADAPTIVE_FADE_OUT_S, ADAPTIVE_FADE_IN_S);
    }
    (
        (settings.fade_out_ms.clamp(1, 500) as f64) / 1000.0,
        (settings.fade_in_ms.clamp(1, 200) as f64) / 1000.0,
    )
}

/// Числовой двойник `reference_span_gain_expr`. Одна и та же форма затухания:
/// косинусная рампа вниз ДО начала спана, ноль внутри, косинусный возврат ПОСЛЕ
/// конца. Используется генератором огибающей, чтобы кривая не разошлась с той,
/// что вычисляло выражение внутри ffmpeg.
fn reference_gain_at(time: f64, span: &MuteSpan, fade_out: f64, fade_in: f64) -> f32 {
    let fade_start = (span.start - fade_out).max(0.0);
    let ramp_down = (span.start - fade_start).max(0.001);
    let fade_end = span.end + fade_in;
    let gain = if time < fade_start {
        1.0
    } else if time < span.start {
        0.5 * (1.0 + (std::f64::consts::PI * (time - fade_start) / ramp_down).cos())
    } else if time < span.end {
        0.0
    } else if time < fade_end {
        0.5 * (1.0 - (std::f64::consts::PI * (time - span.end) / fade_in).cos())
    } else {
        1.0
    };
    gain.clamp(0.0, 1.0) as f32
}

/// Хвост единиц после конца источника. `amultiply` заканчивается по короткому
/// входу, поэтому огибающая обязана быть длиннее аудио — иначе файл молча
/// обрежется. `apad` тут не годится: он добивает нулями, то есть заглушил бы хвост.
const ENVELOPE_TAIL_S: f64 = 5.0;

/// Записывает огибающую отдельным моно-WAV на `REFERENCE_ENVELOPE_SAMPLE_RATE`.
///
/// Раньше её считал `aevalsrc` по дереву `if()` — 2000 вычислений на секунду по
/// всей длине файла, хотя вне спанов результат всегда 1. Замер: 12.48 с против
/// 8.93 с на срезе 900 с. Сама генерация — 0.02 с на 900 с.
fn write_reference_envelope_wav(
    path: &Path,
    settings: &FetchrMuteSettings,
    spans: &[MuteSpan],
    duration: f64,
) -> Result<()> {
    if !duration.is_finite() || duration <= 0.0 {
        return Err(anyhow!("unknown source duration for the envelope"));
    }
    let rate = REFERENCE_ENVELOPE_SAMPLE_RATE;
    let total = (((duration + ENVELOPE_TAIL_S) * rate as f64).ceil() as usize).max(rate as usize);
    let (fade_out, fade_in) = reference_fade_seconds(settings);

    let mut envelope = vec![1.0f32; total];
    for span in spans {
        let from = (((span.start - fade_out).max(0.0) * rate as f64).floor() as usize).min(total);
        let to = ((((span.end + fade_in) * rate as f64).ceil() as usize) + 1).min(total);
        for (offset, value) in envelope[from..to].iter_mut().enumerate() {
            let time = (from + offset) as f64 / rate as f64;
            *value = value.min(reference_gain_at(time, span, fade_out, fade_in));
        }
    }

    let spec = hound::WavSpec {
        channels: 1,
        sample_rate: rate,
        bits_per_sample: 32,
        sample_format: hound::SampleFormat::Float,
    };
    let mut writer = hound::WavWriter::create(path, spec)
        .with_context(|| format!("create envelope wav {path:?}"))?;
    for value in envelope {
        writer
            .write_sample(value)
            .context("write envelope sample")?;
    }
    writer.finalize().context("finalize envelope wav")?;
    Ok(())
}

/// Тот же граф, что и `audio_filter_reference_env`, но огибающая приходит
/// готовым входом ffmpeg, а не вычисляется выражением.
/// Индекс выбранной аудиодорожки источника (0 = первая).
pub fn selected_audio_track(settings: &FetchrMuteSettings) -> u32 {
    settings.audio_track_index.unwrap_or(0)
}

/// Метка входного аудиопотока для filter_complex: первый вход ffmpeg — всегда
/// исходный файл, меняется только номер дорожки внутри него.
fn audio_input_label(settings: &FetchrMuteSettings) -> String {
    format!("0:a:{}", selected_audio_track(settings))
}

fn audio_filter_reference_env_from_input(
    settings: &FetchrMuteSettings,
    sample_rate: u32,
    channels: u32,
    envelope_index: usize,
) -> Result<String> {
    let ain = audio_input_label(settings);
    let bed = resample_mono_envelope("envin", "refenv", sample_rate, channels);
    match settings.censor_method {
        FetchrMuteCensorMethod::Mute => Ok(format!(
            "[{envelope_index}:a:0]anull[envin];{bed};[{ain}][refenv]amultiply[aout]\n"
        )),
        FetchrMuteCensorMethod::Beep => {
            let inverse = resample_mono_envelope("refinvraw", "refienv", sample_rate, channels);
            let tone_layout = broadcast_mono(channels);
            Ok(format!(
                "[{envelope_index}:a:0]asplit=2[envin][envinv];{bed};\
[envinv]aeval='1-val(0)':c=same[refinvraw];{inverse};\
sine=frequency=1000:sample_rate={sample_rate}:duration=86400,volume={BEEP_SINE_VOLUME},{tone_layout}[tone];\
[{ain}][refenv]amultiply[bed];[tone][refienv]amultiply[tonem];\
[bed][tonem]amix=inputs=2:duration=shortest:normalize=0[aout]\n"
            ))
        }
        FetchrMuteCensorMethod::Custom => {
            if settings
                .custom_sound_path
                .as_deref()
                .unwrap_or("")
                .trim()
                .is_empty()
            {
                return Err(anyhow!("FetchrMute custom sound file is not selected"));
            }
            let inverse = resample_mono_envelope("refinvraw", "refienv", sample_rate, channels);
            let layout = replacement_layout(channels);
            Ok(format!(
                "[{envelope_index}:a:0]asplit=2[envin][envinv];{bed};\
[envinv]aeval='1-val(0)':c=same[refinvraw];{inverse};\
[1:a:0]aresample={sample_rate},{layout}[customsrc];\
[{ain}][refenv]amultiply[bed];[customsrc][refienv]amultiply[customm];\
[bed][customm]amix=inputs=2:duration=shortest:normalize=0[aout]\n"
            ))
        }
    }
}

/// Часы, по которым ставятся спаны: время от первого сэмпла выбранной дорожки.
/// Так считает ASR (подготовленный WAV начинается с этого сэмпла), и так же
/// идут сгенерированные источники (`aevalsrc`, огибающая-WAV), которые
/// `amultiply`/`amix` прикладывают к звуку посэмпльно.
const GENERATED_TIME: &str = "t";
/// Те же часы внутри `aeval`, применённого прямо к исходнику: счётчик сэмплов.
/// Его `t` — PTS исходника, а он сдвинут на старт дорожки относительно
/// контейнера (TS/MKV: сотни мс), и мут ложился раньше слова.
const SOURCE_SAMPLE_TIME: &str = "(n/s)";
/// Те же часы для покадрового `volume`, применённого к исходнику: PTS кадра
/// минус PTS первого кадра. Сами метки не меняются — синхронность с видео та же.
const SOURCE_FRAME_TIME: &str = "(t-startt)";

fn reference_span_gain_expr(span: &MuteSpan, fade_out: f64, fade_in: f64, time: &str) -> String {
    let fade_start = (span.start - fade_out).max(0.0);
    let fade_out = (span.start - fade_start).max(0.001);
    let fade_end = span.end + fade_in;
    format!(
        "if(lt({time},{fade_start:.4}),1,if(lt({time},{start:.4}),0.5*(1+cos(PI*({time}-{fade_start:.4})/{fade_out:.4})),if(lt({time},{end:.4}),0,if(lt({time},{fade_end:.4}),0.5*(1-cos(PI*({time}-{end:.4})/{fade_in:.4})),1))))",
        start = span.start,
        end = span.end,
    )
}

struct ReferenceEnvelopeGroup {
    start: f64,
    end: f64,
    factors: Vec<String>,
}

fn reference_envelope_selection_expr(groups: &[ReferenceEnvelopeGroup], time: &str) -> String {
    if groups.is_empty() {
        return "1".to_string();
    }
    let middle = groups.len() / 2;
    let group = &groups[middle];
    let left = reference_envelope_selection_expr(&groups[..middle], time);
    let right = reference_envelope_selection_expr(&groups[middle + 1..], time);
    let active = group
        .factors
        .iter()
        .map(|factor| format!("({factor})"))
        .collect::<Vec<_>>()
        .join("*");
    format!(
        "if(lt({time},{:.4}),{},if(lte({time},{:.4}),{},{}))",
        group.start, left, group.end, active, right
    )
}

/// Сбалансированное дерево `if()` по окнам `(начало, конец, множитель)`: вне
/// окон множитель каждого спана равен 1, поэтому выражение совпадает с
/// произведением по всем спанам, но на сэмпл стоит O(log n), а не O(n).
fn windowed_envelope_expr(mut windows: Vec<(f64, f64, String)>, time: &str) -> String {
    windows.sort_by(|left, right| left.0.total_cmp(&right.0));

    let mut groups: Vec<ReferenceEnvelopeGroup> = Vec::new();
    for (start, end, factor) in windows {
        if let Some(group) = groups.last_mut() {
            if start <= group.end {
                group.end = group.end.max(end);
                group.factors.push(factor);
                continue;
            }
        }
        groups.push(ReferenceEnvelopeGroup {
            start,
            end,
            factors: vec![factor],
        });
    }
    reference_envelope_selection_expr(&groups, time)
}

fn reference_envelope_expr(settings: &FetchrMuteSettings, spans: &[MuteSpan]) -> String {
    reference_envelope_expr_at(settings, spans, GENERATED_TIME)
}

fn reference_envelope_expr_at(settings: &FetchrMuteSettings, spans: &[MuteSpan], time: &str) -> String {
    let (fade_out, fade_in) = reference_fade_seconds(settings);
    let windows = spans
        .iter()
        .map(|span| {
            (
                (span.start - fade_out).max(0.0),
                span.end + fade_in,
                reference_span_gain_expr(span, fade_out, fade_in, time),
            )
        })
        .collect::<Vec<_>>();
    windowed_envelope_expr(windows, time)
}

/// Моно → `channels` одинаковых каналов. Шире стерео раскладка задаётся числом
/// (`6c`): ffmpeg сводит её с любой раскладкой источника той же ширины, а
/// автоматический апмикс положил бы огибающую только в центральный канал и
/// заглушил бы остальные целиком.
/// ffmpeg `sine` generates at 1/8 full scale; 8 * 0.28 matches the Classic
/// `aevalsrc` beep peak of 0.28 (about -11 dBFS).
const BEEP_SINE_VOLUME: &str = "2.24";

fn broadcast_mono(channels: u32) -> String {
    match channels {
        0 | 1 => "aformat=channel_layouts=mono".to_string(),
        2 => "pan=stereo|c0=c0|c1=c0".to_string(),
        count => {
            let gains = (0..count)
                .map(|channel| format!("c{channel}=c0"))
                .collect::<Vec<_>>()
                .join("|");
            format!("pan={count}c|{gains}")
        }
    }
}

/// Приведение файла замены к ширине источника. Моно и стерео — как раньше;
/// шире стерео звук сводится в моно и раздаётся во все каналы, как и тон.
fn replacement_layout(channels: u32) -> String {
    match channels {
        0 | 1 => "aformat=channel_layouts=mono".to_string(),
        2 => "aformat=channel_layouts=stereo".to_string(),
        count => format!("aformat=channel_layouts=mono,{}", broadcast_mono(count)),
    }
}

fn resample_mono_envelope(
    input_label: &str,
    output_label: &str,
    sample_rate: u32,
    channels: u32,
) -> String {
    format!(
        "[{input_label}]aresample={sample_rate},{}[{output_label}]",
        broadcast_mono(channels)
    )
}

fn fast_reference_envelope(
    expression: &str,
    sample_rate: u32,
    channels: u32,
    output_label: &str,
) -> String {
    let low_label = format!("{output_label}_low");
    let source = format!(
        "aevalsrc=exprs='{expression}':s={REFERENCE_ENVELOPE_SAMPLE_RATE}:d=86400[{low_label}]"
    );
    format!(
        "{source};{}",
        resample_mono_envelope(&low_label, output_label, sample_rate, channels)
    )
}

fn fast_reference_envelope_pair(expression: &str, sample_rate: u32, channels: u32) -> String {
    let bed = resample_mono_envelope("refbedlow", "refenv", sample_rate, channels);
    let inverse = resample_mono_envelope("refinvraw", "refienv", sample_rate, channels);
    format!(
        "aevalsrc=exprs='{expression}':s={REFERENCE_ENVELOPE_SAMPLE_RATE}:d=86400[refenvlow];\
[refenvlow]asplit=2[refbedlow][refinvlow];{bed};\
[refinvlow]aeval='1-val(0)':c=same[refinvraw];{inverse}"
    )
}

fn audio_filter_reference_env(
    settings: &FetchrMuteSettings,
    spans: &[MuteSpan],
    sample_rate: u32,
    channels: u32,
) -> Result<String> {
    let ain = audio_input_label(settings);
    let expression = reference_envelope_expr(settings, spans);

    match settings.censor_method {
        FetchrMuteCensorMethod::Mute => {
            let envelope = fast_reference_envelope(&expression, sample_rate, channels, "refenv");
            Ok(format!("{envelope};[{ain}][refenv]amultiply[aout]\n"))
        }
        FetchrMuteCensorMethod::Beep => {
            let envelopes = fast_reference_envelope_pair(&expression, sample_rate, channels);
            let tone_layout = broadcast_mono(channels);
            let tone = format!(
                "sine=frequency=1000:sample_rate={sample_rate}:duration=86400,volume={BEEP_SINE_VOLUME},{tone_layout}[tone]"
            );
            Ok(format!(
                "{envelopes};{tone};\
[{ain}][refenv]amultiply[bed];[tone][refienv]amultiply[tonem];\
[bed][tonem]amix=inputs=2:duration=shortest:normalize=0[aout]\n"
            ))
        }
        FetchrMuteCensorMethod::Custom => {
            if settings
                .custom_sound_path
                .as_deref()
                .unwrap_or("")
                .trim()
                .is_empty()
            {
                return Err(anyhow!("FetchrMute custom sound file is not selected"));
            }
            let envelopes = fast_reference_envelope_pair(&expression, sample_rate, channels);
            let layout = replacement_layout(channels);
            let custom = format!("[1:a:0]aresample={sample_rate},{layout}[customsrc]");
            Ok(format!(
                "{envelopes};{custom};\
[{ain}][refenv]amultiply[bed];[customsrc][refienv]amultiply[customm];\
[bed][customm]amix=inputs=2:duration=shortest:normalize=0[aout]\n"
            ))
        }
    }
}

/// Probe the first audio stream for (sample_rate, channels). Generated
/// envelopes and replacement sounds must match these parameters so FFmpeg
/// keeps every original channel intact.
/// Длительность источника для итоговой строки. Ноль, если ffprobe недоступен.
async fn media_duration_seconds(ffmpeg: &Path, input: &Path) -> f64 {
    let Some(ffprobe) = resolve_binary(FFPROBE, ffmpeg.parent()) else {
        return 0.0;
    };
    probe_audio_stream(&ffprobe, input, 0)
        .await
        .map(|(_, _, duration)| duration)
        .unwrap_or(0.0)
}

async fn probe_audio_stream(ffprobe: &Path, input: &Path, track: u32) -> Option<(u32, u32, f64)> {
    let mut probe = Command::new(ffprobe);
    crate::platform::hide_console_tokio(&mut probe);
    let output = probe
        .args([
            "-v",
            "error",
            "-select_streams",
            &format!("a:{track}"),
            "-show_entries",
            "stream=sample_rate,channels",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
        ])
        .arg(input)
        .output()
        .await
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let mut values = text.lines().map(str::trim).filter(|line| !line.is_empty());
    let sample_rate = values.next()?.parse::<u32>().ok()?;
    let channels = values.next()?.parse::<u32>().ok()?;
    // Длительность может отсутствовать у потоковых контейнеров — тогда
    // генератор огибающей не используется, работает прежний путь.
    let duration = values
        .next()
        .and_then(|value| value.parse::<f64>().ok())
        .filter(|value| value.is_finite() && *value > 0.0)
        .unwrap_or(0.0);
    if sample_rate == 0 || channels == 0 {
        return None;
    }
    Some((sample_rate, channels, duration))
}

/// Build a click-free "smooth" censor filter.
///
/// Strategy: generate a constant-1 gain envelope at the input sample rate /
/// channel count, gate to 0 over the mute spans (edges snapped to a fine frame
/// grid), then round the square steps with TWO cascaded one-pole lowpasses —
/// a short S-shaped ramp with a
/// continuous derivative, so no clicks and no harsh cut. Multiplying the audio
/// by this envelope (`amultiply`) gives a per-sample smooth fade with NO
/// per-sample expression over the whole stream — so it stays fast (unlike the
/// old `aeval` path which was 5–10× slower).
fn audio_filter_smooth_env(
    settings: &FetchrMuteSettings,
    spans: &[MuteSpan],
    sample_rate: u32,
    channels: u32,
) -> Result<String> {
    let ain = audio_input_label(settings);
    // `enable` is evaluated once per envelope frame (256 samples ≈ 5 ms at 48 kHz), so
    // snap gate edges to the frame grid: start floor / end ceil → a frame pts
    // never lands ON a boundary, gates flip deterministically and only widen
    // outwards, never exposing the word. The fr/4 margin
    // keeps boundaries strictly between frame timestamps.
    let fr = ENV_FRAME_SAMPLES / sample_rate as f64;
    let snap_lo = |t: f64| (t.max(0.0) / fr).floor() * fr - fr * 0.25;
    let snap_hi = |t: f64| (t / fr).ceil() * fr + fr * 0.25;

    let mute_terms: Vec<String> = spans
        .iter()
        .map(|s| format!("between(t,{:.4},{:.4})", snap_lo(s.start), snap_hi(s.end)))
        .collect();
    // Everything OUTSIDE the spans (for silencing the beep/custom bed).
    let mut gap_terms: Vec<String> = Vec::new();
    if let Some(first) = spans.first() {
        gap_terms.push(format!("lt(t,{:.4})", snap_lo(first.start)));
    }
    for pair in spans.windows(2) {
        gap_terms.push(format!(
            "between(t,{:.4},{:.4})",
            snap_hi(pair[0].end),
            snap_lo(pair[1].start)
        ));
    }
    if let Some(last) = spans.last() {
        gap_terms.push(format!("gt(t,{:.4})", snap_hi(last.end)));
    }

    let fc = ENV_LOWPASS_HZ;
    let sr = sample_rate;
    // Шире стерео огибающая и тон считаются в моно и раздаются во все каналы
    // одним `pan`: форма та же, что у стерео, а фильтры не множатся на 6–8.
    let (layout, unity_expr, widen) = match channels {
        1 => ("mono", "1", String::new()),
        2 => ("stereo", "1|1", String::new()),
        count => ("mono", "1", format!(",{}", broadcast_mono(count))),
    };
    // Two cascaded one-pole lowpasses → S-shaped ramp, no derivative jump → no click.
    let smooth = format!(
        "lowpass=f={fc}:p=1,lowpass=f={fc}:p=1,aformat=channel_layouts={layout}{widen}"
    );

    // Envelope: constant 1 → chunked per-frame mute gates → smoothing
    // cascade. Gates are chunked so any span count works without overflowing
    // ffmpeg's expression parser; per-sample cost stays trivial (mono envelope).
    let env_src = format!("aevalsrc=exprs='{unity_expr}':s={sr}:d=86400:c={layout}[envsrc]");
    let gate = gate_chain("envsrc", "envgate", &mute_terms, MUTE_FILTER_CHUNK, "0");
    let env = format!("{env_src};{gate};[envgate]{smooth}[env]");

    // Inverse envelope for beep/custom: silence the replacement bed in the gaps;
    // the same smoothing cascade fades the tone in/out instead of slamming it.
    let ienv = |label: &str| {
        let src = format!("aevalsrc=exprs='{unity_expr}':s={sr}:d=86400:c={layout}[{label}src]");
        let gate = gate_chain(
            &format!("{label}src"),
            &format!("{label}gate"),
            &gap_terms,
            MUTE_FILTER_CHUNK,
            "0",
        );
        format!("{src};{gate};[{label}gate]{smooth}[{label}]")
    };

    match settings.censor_method {
        FetchrMuteCensorMethod::Mute => Ok(format!("{env};[{ain}][env]amultiply[aout]\n")),
        FetchrMuteCensorMethod::Beep => {
            let ienv = ienv("ienv");
            let tone_expr = if channels == 2 {
                "0.28*sin(2*PI*1000*t)|0.28*sin(2*PI*1000*t)"
            } else {
                "0.28*sin(2*PI*1000*t)"
            };
            let tone =
                format!("aevalsrc=exprs='{tone_expr}':s={sr}:d=86400:c={layout}{widen}[tone]");
            Ok(format!(
                "{env};{ienv};{tone};\
[{ain}][env]amultiply[bed];\
[tone][ienv]amultiply[tonem];\
[bed][tonem]amix=inputs=2:duration=shortest:normalize=0[aout]\n"
            ))
        }
        FetchrMuteCensorMethod::Custom => {
            if settings
                .custom_sound_path
                .as_deref()
                .unwrap_or("")
                .trim()
                .is_empty()
            {
                return Err(anyhow!("FetchrMute custom sound file is not selected"));
            }
            let ienv = ienv("ienv");
            let cust = format!("[1:a:0]aresample={sr},{}[cust]", replacement_layout(channels));
            Ok(format!(
                "{env};{ienv};{cust};\
[{ain}][env]amultiply[bed];\
[cust][ienv]amultiply[custm];\
[bed][custm]amix=inputs=2:duration=shortest:normalize=0[aout]\n"
            ))
        }
    }
}

#[allow(clippy::too_many_arguments)]
pub async fn render_censored_media(
    ffmpeg: &Path,
    input_path: &Path,
    output_path: &Path,
    tmp_dir: &Path,
    spans: &[MuteSpan],
    settings: &FetchrMuteSettings,
    cancel: Arc<AtomicBool>,
    progress: Option<ProgressCallback>,
) -> Result<()> {
    if cancel.load(Ordering::SeqCst) {
        return Err(anyhow!("FetchrMute task cancelled"));
    }

    if spans.is_empty() {
        copy_file_cancelable(input_path, output_path, cancel).await?;
        if let Some(callback) = progress {
            callback(1.0);
        }
        return Ok(());
    }

    let filter_script = tmp_dir.join("fetchr_mute_filter.txt");
    let ffprobe = resolve_binary(FFPROBE, ffmpeg.parent());
    let params = match ffprobe {
        Some(ref probe) => probe_audio_stream(probe, input_path, selected_audio_track(settings)).await,
        None => None,
    };
    // The reference profile is defined by its measured asymmetric envelope;
    // allowing the legacy hard-cut flag to bypass it made half-muted words
    // intelligible and contradicted the selected profile.
    let use_smooth_envelope = should_use_smooth_envelope(settings);
    // Готовая огибающая идёт последним входом ffmpeg, поэтому индекс зависит от
    // того, добавлен ли файл замены (метод «свой звук»).
    let envelope_index = if matches!(settings.censor_method, FetchrMuteCensorMethod::Custom) {
        2
    } else {
        1
    };
    let mut envelope_path: Option<PathBuf> = None;
    let filter = if use_smooth_envelope {
        match params {
            // Любая ширина дорожки: огибающая считается в моно и раздаётся по
            // каналам (`broadcast_mono`), так что 5.1 идёт тем же быстрым путём.
            Some((sr, ch, duration)) if (1..=MAX_ENVELOPE_CHANNELS).contains(&ch) => match settings.mute_profile {
                // Sealed и Adaptive используют ту же reference-огибающую: она
                // ставит затухание ДО начала спана и возврат ПОСЛЕ его конца, а
                // их нулевое ядро уже накрывает всё слово с запасом.
                FetchrMuteProfile::Reference
                | FetchrMuteProfile::Sealed
                | FetchrMuteProfile::Adaptive => {
                    // Огибающая считается здесь, а не выражением `aevalsrc`
                    // внутри ffmpeg: то дерево `if()` вычислялось 2000 раз в
                    // секунду по всей длине, хотя вне спанов ответ всегда 1.
                    let generated = tmp_dir.join("fetchr_mute_envelope.wav");
                    match write_reference_envelope_wav(&generated, settings, spans, duration) {
                        Ok(()) => {
                            envelope_path = Some(generated);
                            audio_filter_reference_env_from_input(settings, sr, ch, envelope_index)?
                        }
                        // Не смогли записать огибающую — работает прежний путь.
                        Err(_) => audio_filter_reference_env(settings, spans, sr, ch)?,
                    }
                }
                FetchrMuteProfile::Classic => audio_filter_smooth_env(settings, spans, sr, ch)?,
            },
            // ffprobe is not available (or reported something unusable): the
            // envelope cannot be shaped to the source, so the per-sample path
            // keeps the smoothing. Slower, but never hard-cuts.
            _ => audio_filter_for_method(settings, spans)?,
        }
    } else {
        audio_filter_chunked(settings, spans, MUTE_FILTER_CHUNK)?
    };
    let inline_filter = filter.len() <= 8192;
    if !inline_filter {
        tokio::fs::write(&filter_script, &filter)
            .await
            .with_context(|| format!("write ffmpeg filter script {:?}", filter_script))?;
    }

    let aac_mf = match params {
        Some((sr, ch, _)) => aac_mf_supported(ffmpeg, sr, ch),
        None => false,
    };
    let codec_args = audio_codec_args(output_path, aac_mf);
    let tracker = ffmpeg_progress(params.map(|(_, _, duration)| duration), progress);
    let mut cmd = Command::new(ffmpeg);
    cmd.args(["-y", "-hide_banner", "-loglevel", "error"]);
    if tracker.is_some() {
        cmd.args(FFMPEG_PROGRESS_ARGS);
    }
    cmd.arg("-i").arg(input_path);
    if matches!(settings.censor_method, FetchrMuteCensorMethod::Custom) {
        let custom_sound_path = settings
            .custom_sound_path
            .as_deref()
            .map(Path::new)
            .filter(|path| path.is_file())
            .ok_or_else(|| {
                anyhow!("FetchrMute custom sound file is not selected or does not exist")
            })?;
        cmd.args(["-stream_loop", "-1"])
            .arg("-i")
            .arg(custom_sound_path);
    }
    if let Some(ref envelope) = envelope_path {
        cmd.arg("-i").arg(envelope);
    }
    if inline_filter {
        cmd.arg("-filter_complex").arg(&filter);
    } else {
        cmd.arg(ffmpeg_filter_script_flag(ffmpeg))
            .arg(&filter_script);
    }
    cmd.args(["-map", "0:v?", "-map", "[aout]", "-map", "0:s?"])
        .args(["-c:v", "copy", "-c:s", "copy"])
        .args(&codec_args)
        .args(["-max_muxing_queue_size", "100000"]);
    // `+faststart` переносит moov в начало файла ОТДЕЛЬНЫМ полным проходом:
    // на 3-5-часовом стриме это лишние 10-20 ГБ чтения и записи ради
    // прогрессивной отдачи по HTTP, которая локальному файлу не нужна.
    // Включается FETCHR_MUTE_FASTSTART=1.
    if faststart_enabled()
        && output_path
            .extension()
            .and_then(|value| value.to_str())
            .map(|value| value.eq_ignore_ascii_case("mp4") || value.eq_ignore_ascii_case("m4v"))
            .unwrap_or(false)
    {
        cmd.args(["-movflags", "+faststart"]);
    }
    cmd.arg(output_path)
        .stdout(Stdio::null())
        .stderr(Stdio::piped());

    let output = run_cancelable_command_with_progress(
        &mut cmd,
        cancel,
        "ffmpeg FetchrMute render",
        tracker,
    )
    .await?;
    if !output.status.success() {
        return Err(ffmpeg_failure(
            "сохранить обработанный файл",
            &output,
            Some(output_path),
        ));
    }
    let output_size = tokio::fs::metadata(output_path)
        .await
        .with_context(|| format!("FFmpeg не создал файл {}", output_path.display()))?
        .len();
    if output_size == 0 {
        return Err(anyhow!(
            "FFmpeg создал пустой файл {}. Проверьте свободное место и права записи.",
            output_path.display()
        ));
    }
    // `amultiply` заканчивается по короткому входу: слишком короткая огибающая
    // обрезала бы результат молча. Проверяем длительность, а не только размер.
    if let (Some((_, _, source_duration)), Some(ref probe)) = (params, ffprobe) {
        if source_duration > 0.0 {
            if let Some((_, _, output_duration)) = probe_audio_stream(probe, output_path, 0).await {
                if output_duration > 0.0 && source_duration - output_duration > 1.0 {
                    let _ = tokio::fs::remove_file(output_path).await;
                    return Err(anyhow!(
                        "Результат короче исходника: {output_duration:.1} с против {source_duration:.1} с. Файл удалён."
                    ));
                }
            }
        }
    }
    Ok(())
}

fn faststart_enabled() -> bool {
    std::env::var("FETCHR_MUTE_FASTSTART")
        .map(|value| matches!(value.trim(), "1" | "true" | "on" | "yes"))
        .unwrap_or(false)
}

fn should_use_smooth_envelope(settings: &FetchrMuteSettings) -> bool {
    settings.smooth_mute
        || matches!(
            settings.mute_profile,
            FetchrMuteProfile::Reference | FetchrMuteProfile::Sealed | FetchrMuteProfile::Adaptive
        )
}

fn ffmpeg_failure(
    action: &str,
    output: &std::process::Output,
    output_path: Option<&Path>,
) -> anyhow::Error {
    let status = output
        .status
        .code()
        .map(|code| code.to_string())
        .unwrap_or_else(|| output.status.to_string());
    let stderr = String::from_utf8_lossy(&output.stderr);
    let diagnostics = stderr.trim();
    let destination = output_path
        .map(|path| format!(" Файл: {}.", path.display()))
        .unwrap_or_default();

    if diagnostics.is_empty() {
        anyhow!(
            "FFmpeg не смог {action} (код {status}) и завершился без диагностики.{destination} Проверьте свободное место, права записи и повторите обработку."
        )
    } else {
        anyhow!("FFmpeg не смог {action} (код {status}).{destination} {diagnostics}")
    }
}

/// Volume-выражение «Классики» для запасного пути: линейно (FADE_S) затухает
/// до 0 внутри каждого спана и равно 1 снаружи. Вне окна `[s-f, e+f]`
/// множитель спана равен 1, поэтому дерево по окнам совпадает с прежним
/// произведением по всем спанам. Границы окон считаются от тех же округлённых
/// до мс значений, что и множитель, — на стыке нет скачка.
fn classic_envelope_expr_at(spans: &[MuteSpan], time: &str) -> String {
    let f = FADE_S;
    let millis = |value: f64| (value * 1000.0).round() / 1000.0;
    let windows = spans
        .iter()
        .map(|span| {
            let (s, e) = (millis(span.start), millis(span.end));
            // Линейный fade 1→0 на [s-f, s], держим 0 на [s, e], fade 0→1 на [e, e+f]
            let factor = format!(
                "(1-min(1,max(0,({time}-{s:.3}+{f:.3})/{f:.3}))*min(1,max(0,({e:.3}+{f:.3}-{time})/{f:.3})))"
            );
            (s - f, e + f, factor)
        })
        .collect::<Vec<_>>();
    windowed_envelope_expr(windows, time)
}

/// Запасной путь, когда ffprobe не дал частоту и число каналов: огибающую не
/// подогнать под раскладку, и `aeval` считает её прямо на звуке. Время —
/// счётчик сэмплов (`SOURCE_SAMPLE_TIME`), выражение — дерево по окнам,
/// поэтому сотни спанов не превращаются в сотни множителей на каждый сэмпл.
fn audio_filter_for_method(settings: &FetchrMuteSettings, spans: &[MuteSpan]) -> Result<String> {
    let ain = audio_input_label(settings);
    // aeval оценивает выражение PER-SAMPLE (не per-frame как volume:eval=frame),
    // поэтому fade абсолютно плавный без щелчков.
    // c=same — выходной channel layout совпадает с входным (моно/стерео/surround).
    // val(ch) — семпл входного канала ch; ATTEN зависит только от времени → одинаков для всех каналов.
    let atten = match settings.mute_profile {
        FetchrMuteProfile::Reference | FetchrMuteProfile::Sealed | FetchrMuteProfile::Adaptive => {
            reference_envelope_expr_at(settings, spans, SOURCE_SAMPLE_TIME)
        }
        FetchrMuteProfile::Classic => classic_envelope_expr_at(spans, SOURCE_SAMPLE_TIME),
    };
    match settings.censor_method {
        FetchrMuteCensorMethod::Mute => {
            Ok(format!("[{ain}]aeval='val(ch)*({atten})':c=same[aout]\n"))
        }
        FetchrMuteCensorMethod::Beep => Ok(format!(
            "[{ain}]aeval='val(ch)*({atten})':c=same[bed];\
aevalsrc=sin(2*PI*1000*t):s=48000,aeval='val(0)*0.28*(1-({atten}))'[tone];\
[bed][tone]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[aout]\n"
        )),
        FetchrMuteCensorMethod::Custom => {
            if settings
                .custom_sound_path
                .as_deref()
                .unwrap_or("")
                .trim()
                .is_empty()
            {
                return Err(anyhow!("FetchrMute custom sound file is not selected"));
            }
            Ok(format!(
                "[{ain}]aeval='val(ch)*({atten})':c=same[bed];\
[1:a:0]aresample=48000,aeval='val(ch)*(1-({atten}))':c=same[custom];\
[bed][custom]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[aout]\n"
            ))
        }
    }
}

const MUTE_FILTER_CHUNK: usize = 100;

/// Build the audio filter graph for large span counts by chaining several
/// `volume` filters, each enabled over a chunk of intervals. This avoids one
/// gigantic `enable` expression, which can overflow ffmpeg's expression parser
/// and fail with "Cannot allocate memory".
fn audio_filter_chunked(
    settings: &FetchrMuteSettings,
    spans: &[MuteSpan],
    chunk: usize,
) -> Result<String> {
    let ain = audio_input_label(settings);
    // Intervals where the ORIGINAL audio must be silenced = the spans. They are
    // read on the source itself, so the time is counted from its first frame
    // (`SOURCE_FRAME_TIME`), not from the container start.
    let span_terms: Vec<String> = spans
        .iter()
        .map(|s| format!("between({SOURCE_FRAME_TIME},{:.3},{:.3})", s.start, s.end))
        .collect();

    // Intervals where a replacement bed (tone / custom sound) must be silenced =
    // everything OUTSIDE the spans (head, gaps between spans, tail).
    let mut gap_terms: Vec<String> = Vec::new();
    if let Some(first) = spans.first() {
        gap_terms.push(format!("lt(t,{:.3})", first.start));
    }
    for pair in spans.windows(2) {
        gap_terms.push(format!(
            "between(t,{:.3},{:.3})",
            pair[0].end, pair[1].start
        ));
    }
    if let Some(last) = spans.last() {
        gap_terms.push(format!("gt(t,{:.3})", last.end));
    }

    match settings.censor_method {
        FetchrMuteCensorMethod::Mute => Ok(format!(
            "{}\n",
            source_mute_chain(&ain, "aout", &span_terms, chunk)
        )),
        FetchrMuteCensorMethod::Beep => {
            let bed = source_mute_chain(&ain, "bed", &span_terms, chunk);
            let tone = mute_chain("tonesrc", "tone", &gap_terms, chunk);
            Ok(format!(
                "{bed};aevalsrc=sin(2*PI*1000*t):s=48000,volume=0.28[tonesrc];{tone};[bed][tone]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[aout]\n"
            ))
        }
        FetchrMuteCensorMethod::Custom => {
            if settings
                .custom_sound_path
                .as_deref()
                .unwrap_or("")
                .trim()
                .is_empty()
            {
                return Err(anyhow!("FetchrMute custom sound file is not selected"));
            }
            let bed = source_mute_chain(&ain, "bed", &span_terms, chunk);
            let custom = mute_chain("customsrc", "custom", &gap_terms, chunk);
            Ok(format!(
                "{bed};[1:a:0]aresample=48000[customsrc];{custom};[bed][custom]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[aout]\n"
            ))
        }
    }
}

/// Chain `volume=0` filters silencing `in_label` over each chunk of `terms`,
/// yielding `out_label`. Segments are joined with ';' (no trailing separator).
/// Silencing is cumulative (OR over chunks), so the union of all chunks is muted.
fn mute_chain(in_label: &str, out_label: &str, terms: &[String], chunk: usize) -> String {
    gate_chain(in_label, out_label, terms, chunk, "0")
}

/// Сколько интервалов влезает в одно выражение `volume` на исходнике. Парсер
/// ffmpeg режет глубину: `enable` с `between(t,…)` принимает ровно 100
/// слагаемых, а `if(between((t-startt),…)+…,0,1)` падает уже на ~97
/// («Cannot allocate memory», замер на N-124881). Половина — с запасом.
const SOURCE_GATE_CHUNK: usize = 50;

/// То же для звука исходника: `enable` знает только `t` (PTS со сдвигом на
/// старт дорожки), поэтому гейт — покадровое выражение `volume` с `startt`.
/// Решение по-прежнему принимается на кадр целиком, как и у `enable`.
fn source_mute_chain(in_label: &str, out_label: &str, terms: &[String], chunk: usize) -> String {
    let chunk = chunk.clamp(1, SOURCE_GATE_CHUNK);
    let groups: Vec<String> = terms.chunks(chunk).map(|g| g.join("+")).collect();
    if groups.is_empty() {
        return format!("[{in_label}]anull[{out_label}]");
    }
    let last = groups.len() - 1;
    groups
        .iter()
        .enumerate()
        .map(|(index, group)| {
            let from = if index == 0 {
                in_label.to_string()
            } else {
                format!("{out_label}_{}", index - 1)
            };
            let to = if index == last {
                out_label.to_string()
            } else {
                format!("{out_label}_{index}")
            };
            format!("[{from}]volume=volume='if({group},0,1)':eval=frame[{to}]")
        })
        .collect::<Vec<_>>()
        .join(";")
}

/// Chain `volume={level}` filters applied to `in_label` over each chunk of
/// `terms`, yielding `out_label`. Gating is cumulative (OR over chunks).
fn gate_chain(
    in_label: &str,
    out_label: &str,
    terms: &[String],
    chunk: usize,
    level: &str,
) -> String {
    let groups: Vec<String> = terms.chunks(chunk.max(1)).map(|g| g.join("+")).collect();
    if groups.is_empty() {
        return format!("[{in_label}]anull[{out_label}]");
    }
    let n = groups.len();
    let mut segments: Vec<String> = Vec::with_capacity(n);
    let mut cur = in_label.to_string();
    for (i, g) in groups.iter().enumerate() {
        let next = if i + 1 == n {
            out_label.to_string()
        } else {
            format!("{out_label}_{i}")
        };
        segments.push(format!("[{cur}]volume={level}:enable='{g}'[{next}]"));
        cur = next;
    }
    segments.join(";")
}

/// Аргументы аудиокодека для выходного файла.
///
/// Замер на реальном файле (2696 с, AAC 48 кГц stereo): перекодировка звука
/// занимала 18 из 26 секунд рендера, а само плавное затухание — 5. Дефолтный
/// `aac` (`twoloop`) — самая дорогая часть сохранения. `aac_mf` (кодер
/// Windows MediaFoundation) и `-aac_coder fast` дают ту же дорожку вдвое
/// быстрее: 21.3 с против 9.6/9.9 с на срезе 900 с.
fn audio_codec_args(output_path: &Path, aac_mf_available: bool) -> Vec<String> {
    let owned = |values: &[&str]| values.iter().map(|value| value.to_string()).collect();
    match output_path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase()
        .as_str()
    {
        "mp3" => owned(&["-c:a", "libmp3lame", "-b:a", "192k"]),
        "ogg" => owned(&["-c:a", "libvorbis", "-b:a", "192k"]),
        "opus" | "webm" => owned(&["-c:a", "libopus", "-b:a", "128k"]),
        "flac" => owned(&["-c:a", "flac"]),
        "wav" => owned(&["-c:a", "pcm_s16le"]),
        _ => aac_codec_args(aac_mf_available),
    }
}

fn aac_codec_args(aac_mf_available: bool) -> Vec<String> {
    let owned =
        |values: &[&str]| -> Vec<String> { values.iter().map(|value| value.to_string()).collect() };
    let fast = owned(&["-c:a", "aac", "-b:a", "192k", "-aac_coder", "fast"]);
    let mf = owned(&["-c:a", "aac_mf", "-b:a", "192k"]);
    match std::env::var("FETCHR_MUTE_AAC_CODER")
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase()
        .as_str()
    {
        "twoloop" => owned(&["-c:a", "aac", "-b:a", "192k"]),
        "fast" => fast,
        "mf" => mf,
        _ if aac_mf_available => mf,
        _ => fast,
    }
}

/// Доступность `aac_mf` проверяется коротким пробным кодированием на тех же
/// частоте и числе каналов, что у источника: MediaFoundation поддерживает не
/// все раскладки, а падение на трёхгигабайтном рендере обошлось бы дорого.
/// Результат кэшируется на сессию.
/// FFmpeg 8.0+ removed `-filter_complex_script` in favour of `-/filter_complex`
/// (introduced in FFmpeg 7.0). Pick the flag supported by the installed binary.
fn ffmpeg_filter_script_flag(ffmpeg: &Path) -> &'static str {
    static USE_SLASH_SYNTAX: OnceLock<bool> = OnceLock::new();
    let use_slash = *USE_SLASH_SYNTAX.get_or_init(|| {
        let Ok(out) = crate::platform::hidden_command(ffmpeg)
            .arg("-version")
            .output()
        else {
            return true;
        };
        let first_line = String::from_utf8_lossy(&out.stdout);
        let ver = first_line
            .split_whitespace()
            .nth(2)
            .unwrap_or("")
            .trim_start_matches(['n', 'N']);
        // Git snapshots ("N-123456-...") are modern builds (>= 7.0).
        if ver.starts_with('-') {
            return true;
        }
        ver.split('.')
            .next()
            .and_then(|major| major.parse::<u32>().ok())
            .map(|major| major >= 7)
            .unwrap_or(true)
    });
    if use_slash {
        "-/filter_complex"
    } else {
        "-filter_complex_script"
    }
}

fn aac_mf_supported(ffmpeg: &Path, sample_rate: u32, channels: u32) -> bool {
    static CACHE: OnceLock<parking_lot::Mutex<HashMap<(u32, u32), bool>>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| parking_lot::Mutex::new(HashMap::new()));
    if let Some(known) = cache.lock().get(&(sample_rate, channels)) {
        return *known;
    }
    let layout = if channels == 1 { "mono" } else { "stereo" };
    let mut command = crate::platform::hidden_command(ffmpeg);
    let supported = command
        .args(["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i"])
        .arg(format!("anullsrc=r={sample_rate}:cl={layout}"))
        .args([
            "-t", "0.5", "-c:a", "aac_mf", "-b:a", "192k", "-f", "null", "-",
        ])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|status| status.success())
        .unwrap_or(false);
    cache.lock().insert((sample_rate, channels), supported);
    supported
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct AudioTrackInfo {
    /// Порядковый номер среди аудиодорожек (то же, что "a:<index>" у ffmpeg).
    pub index: u32,
    pub codec: String,
    pub channels: u32,
    pub sample_rate: u32,
    pub language: Option<String>,
    pub title: Option<String>,
    pub is_default: bool,
}

/// Список аудиодорожек файла. Пустой вектор — ffprobe недоступен или дорожек
/// нет; вызывающий код в этом случае работает с первой дорожкой как раньше.
pub async fn list_audio_tracks(ffprobe: &Path, input: &Path) -> Result<Vec<AudioTrackInfo>> {
    let mut probe = Command::new(ffprobe);
    crate::platform::hide_console_tokio(&mut probe);
    let output = probe
        .args([
            "-v",
            "error",
            "-select_streams",
            "a",
            "-show_entries",
            "stream=index,codec_name,channels,sample_rate,disposition=default:stream_tags=language,title",
            "-of",
            "json",
        ])
        .arg(input)
        .output()
        .await
        .with_context(|| format!("probe audio tracks {:?}", input))?;
    if !output.status.success() {
        return Err(anyhow!(
            "ffprobe не смог прочитать аудиодорожки: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    let parsed: serde_json::Value =
        serde_json::from_slice(&output.stdout).context("parse ffprobe audio tracks json")?;
    let streams = parsed
        .get("streams")
        .and_then(|value| value.as_array())
        .cloned()
        .unwrap_or_default();
    Ok(streams
        .iter()
        .enumerate()
        .map(|(order, stream)| {
            let tags = stream.get("tags");
            let tag = |name: &str| {
                tags.and_then(|value| value.get(name))
                    .and_then(|value| value.as_str())
                    .map(|value| value.trim().to_string())
                    .filter(|value| !value.is_empty())
            };
            AudioTrackInfo {
                index: order as u32,
                codec: stream
                    .get("codec_name")
                    .and_then(|value| value.as_str())
                    .unwrap_or("?")
                    .to_string(),
                channels: stream
                    .get("channels")
                    .and_then(|value| value.as_u64())
                    .unwrap_or(0) as u32,
                sample_rate: stream
                    .get("sample_rate")
                    .and_then(|value| value.as_str())
                    .and_then(|value| value.parse::<u32>().ok())
                    .unwrap_or(0),
                language: tag("language"),
                title: tag("title"),
                is_default: stream
                    .get("disposition")
                    .and_then(|value| value.get("default"))
                    .and_then(|value| value.as_i64())
                    .unwrap_or(0)
                    == 1,
            }
        })
        .collect())
}

/// Выходной путь, заданный пользователем («Сохранить как»). Каталог создаётся,
/// имя чистится от разделителей пути, расширение берётся из исходника, если
/// пользователь его не указал. Существующий файл не перетирается — к имени
/// добавляется счётчик, как и у автоматического пути.
pub fn fetchr_mute_output_path_at(
    directory: &Path,
    file_name: &str,
    input_path: &Path,
) -> Result<PathBuf> {
    let fallback_ext = input_path
        .extension()
        .map(|value| value.to_string_lossy().into_owned())
        .unwrap_or_else(|| "mp4".to_string());
    let cleaned = sanitize_output_file_name(file_name);
    if cleaned.is_empty() {
        return Err(anyhow!("Пустое имя файла для сохранения"));
    }
    let candidate_path = Path::new(&cleaned);
    let stem = candidate_path
        .file_stem()
        .map(|value| value.to_string_lossy().into_owned())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| anyhow!("Некорректное имя файла для сохранения"))?;
    let ext = candidate_path
        .extension()
        .map(|value| value.to_string_lossy().into_owned())
        .filter(|value| !value.is_empty())
        .unwrap_or(fallback_ext);

    std::fs::create_dir_all(directory)
        .with_context(|| format!("create output directory {:?}", directory))?;

    let mut n = 0u32;
    loop {
        let candidate = if n == 0 {
            directory.join(format!("{stem}.{ext}"))
        } else {
            directory.join(format!("{stem} ({n}).{ext}"))
        };
        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&candidate)
        {
            Ok(_) => return Ok(candidate),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(error) => {
                return Err(error)
                    .with_context(|| format!("reserve FetchrMute output {:?}", candidate))
            }
        }
        n += 1;
    }
}

/// Имя файла без разделителей пути и символов, запрещённых в Windows.
pub fn sanitize_output_file_name(value: &str) -> String {
    value
        .trim()
        .chars()
        .map(|ch| match ch {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            other if (other as u32) < 0x20 => '_',
            other => other,
        })
        .collect::<String>()
        .trim()
        .trim_end_matches('.')
        .to_string()
}

/// Своя папка результата задачи очереди (пакетная обработка). `None` — папка
/// не задана или совпадает с папкой исходника: тогда прежнее поведение.
pub fn custom_output_dir(input_path: &Path, output_dir: Option<&str>) -> Option<PathBuf> {
    let dir = PathBuf::from(output_dir.map(str::trim).filter(|dir| !dir.is_empty())?);
    (input_path.parent() != Some(dir.as_path())).then_some(dir)
}

/// Путь результата задачи очереди: та же схема имён `{stem}_fetchr_mute`,
/// в выбранной папке или рядом с исходником.
fn queue_output_path(input_path: &Path, output_dir: Option<&str>) -> Result<PathBuf> {
    let Some(dir) = custom_output_dir(input_path, output_dir) else {
        return fetchr_mute_output_path(input_path);
    };
    let stem = input_path
        .file_stem()
        .map(|value| value.to_string_lossy().into_owned())
        .ok_or_else(|| anyhow!("Invalid input path file stem"))?;
    let ext = input_path
        .extension()
        .map(|value| value.to_string_lossy().into_owned())
        .ok_or_else(|| anyhow!("Invalid input path extension"))?;
    fetchr_mute_output_path_at(&dir, &format!("{stem}_fetchr_mute.{ext}"), input_path)
}

pub fn fetchr_mute_output_path(input_path: &Path) -> Result<PathBuf> {
    let file_stem = input_path
        .file_stem()
        .ok_or_else(|| anyhow!("Invalid input path file stem"))?;
    let file_ext = input_path
        .extension()
        .ok_or_else(|| anyhow!("Invalid input path extension"))?;
    let input_dir = input_path
        .parent()
        .ok_or_else(|| anyhow!("Invalid input path parent directory"))?;
    let stem = file_stem.to_string_lossy();
    let ext = file_ext.to_string_lossy();
    let mut n = 0u32;
    loop {
        let candidate = if n == 0 {
            input_dir.join(format!("{stem}_fetchr_mute.{ext}"))
        } else {
            input_dir.join(format!("{stem}_fetchr_mute ({n}).{ext}"))
        };
        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&candidate)
        {
            Ok(_) => return Ok(candidate),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(error) => {
                return Err(error)
                    .with_context(|| format!("reserve FetchrMute output {:?}", candidate))
            }
        }
        n += 1;
    }
}

fn is_generated_output_for(input_path: &Path, candidate: &Path) -> bool {
    let (Some(stem), Some(ext), Some(dir), Some(name)) = (
        input_path.file_stem().and_then(|value| value.to_str()),
        input_path.extension().and_then(|value| value.to_str()),
        input_path.parent(),
        candidate.file_name().and_then(|value| value.to_str()),
    ) else {
        return false;
    };
    if candidate.parent() != Some(dir) {
        return false;
    }
    let base = format!("{stem}_fetchr_mute");
    let suffix = format!(".{ext}");
    let Some(rest) = name.strip_prefix(&base) else {
        return false;
    };
    let Some(mid) = rest.strip_suffix(&suffix) else {
        return false;
    };
    mid.is_empty()
        || (mid.len() > 3
            && mid.starts_with(" (")
            && mid.ends_with(')')
            && mid[2..mid.len() - 1].chars().all(|ch| ch.is_ascii_digit()))
}

/// Removes only the previous output explicitly owned by the history entry.
/// Directory-wide pattern deletion is intentionally forbidden: a matching
/// filename can belong to the user or to another concurrent job.
pub fn cleanup_stale_outputs(input_path: &Path, keep: &Path) {
    let input = input_path.to_string_lossy();
    let Ok(history) = load_history() else {
        return;
    };
    let Some(previous) = history
        .iter()
        .find(|item| item.file_path == input)
        .map(|item| PathBuf::from(&item.output_path))
    else {
        return;
    };
    if previous != keep && is_generated_output_for(input_path, &previous) {
        let _ = std::fs::remove_file(previous);
    }
}

/// Удаляет пустые (0-байтовые) зарезервированные выходные файлы этого исходника,
/// оставшиеся после падения приложения между резервированием имени и рендером.
/// Трогаем только файлы нашего шаблона имён старше 10 минут, чтобы не задеть
/// файл, который прямо сейчас рендерит параллельная задача.
pub fn cleanup_empty_reserved_outputs(input_path: &Path) {
    let Some(dir) = input_path.parent() else {
        return;
    };
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let now = std::time::SystemTime::now();
    for entry in entries.flatten() {
        let path = entry.path();
        if !is_generated_output_for(input_path, &path) {
            continue;
        }
        let Ok(meta) = entry.metadata() else {
            continue;
        };
        if !meta.is_file() || meta.len() != 0 {
            continue;
        }
        let age = meta
            .modified()
            .ok()
            .and_then(|modified| now.duration_since(modified).ok())
            .unwrap_or_default();
        if age >= Duration::from_secs(600) {
            let _ = std::fs::remove_file(&path);
        }
    }
}

async fn copy_file_cancelable(
    input_path: &Path,
    output_path: &Path,
    cancel: Arc<AtomicBool>,
) -> Result<()> {
    let mut input = tokio::fs::File::open(input_path)
        .await
        .with_context(|| format!("open uncensored media {:?}", input_path))?;
    let mut output = tokio::fs::File::create(output_path)
        .await
        .with_context(|| format!("create uncensored copy {:?}", output_path))?;
    let mut buffer = vec![0u8; 1024 * 1024];
    loop {
        if cancel.load(Ordering::SeqCst) {
            return Err(anyhow!("FetchrMute task cancelled"));
        }
        let read = input.read(&mut buffer).await?;
        if read == 0 {
            break;
        }
        output.write_all(&buffer[..read]).await?;
    }
    output.flush().await?;
    Ok(())
}

/// Доля выполнения долгого прохода ffmpeg, 0..=1. Вызывающий сам переводит её
/// в свой участок общей шкалы.
pub type ProgressCallback = Arc<dyn Fn(f32) + Send + Sync>;

/// Машиночитаемый прогресс в stdout вместо строки статистики в stderr: stderr
/// остаётся для диагностики и `silencedetect`.
const FFMPEG_PROGRESS_ARGS: [&str; 3] = ["-progress", "pipe:1", "-nostats"];

/// Не чаще одного события прогресса за этот интервал.
const PROGRESS_EMIT_INTERVAL: Duration = Duration::from_millis(150);

struct FfmpegProgress {
    total_seconds: f64,
    callback: ProgressCallback,
}

/// Прогресс имеет смысл только при известной длительности источника.
fn ffmpeg_progress(
    total_seconds: Option<f64>,
    callback: Option<ProgressCallback>,
) -> Option<FfmpegProgress> {
    let total_seconds = total_seconds.filter(|seconds| seconds.is_finite() && *seconds > 0.0)?;
    callback.map(|callback| FfmpegProgress {
        total_seconds,
        callback,
    })
}

/// Перевод доли этапа в участок общей шкалы `[from, to]`.
pub fn progress_in_range(from: f32, to: f32, fraction: f32) -> f32 {
    from + (to - from) * fraction.clamp(0.0, 1.0)
}

/// Колбэк, который пишет долю этапа в прогресс задачи (очередь или страница —
/// по префиксу `job_id`), переведя её в участок `[from, to]` с тем же текстом.
pub fn progress_reporter(
    queue: &Arc<QueueManager>,
    job_id: &str,
    from: f32,
    to: f32,
    message: String,
) -> ProgressCallback {
    let queue = Arc::clone(queue);
    let job_id = job_id.to_string();
    Arc::new(move |fraction| {
        set_progress(&queue, &job_id, progress_in_range(from, to, fraction), &message)
    })
}

/// Позиция вывода из строки `-progress`, в секундах. `out_time_ms` у ffmpeg
/// исторически тоже в микросекундах. `N/A` и отрицательные значения в начале
/// прохода пропускаются.
fn parse_ffmpeg_progress_seconds(line: &str) -> Option<f64> {
    let (key, value) = line.trim().split_once('=')?;
    let value = value.trim();
    let seconds = match key.trim() {
        "out_time_us" | "out_time_ms" => value.parse::<i64>().ok()? as f64 / 1_000_000.0,
        "out_time" => parse_ffmpeg_clock(value)?,
        _ => return None,
    };
    (seconds.is_finite() && seconds >= 0.0).then_some(seconds)
}

/// `HH:MM:SS.micro` → секунды.
fn parse_ffmpeg_clock(value: &str) -> Option<f64> {
    // До первого кадра ffmpeg печатает отрицательное время (`-00:00:00.02`).
    if value.starts_with('-') {
        return None;
    }
    let mut parts = value.split(':');
    let hours = parts.next()?.parse::<f64>().ok()?;
    let minutes = parts.next()?.parse::<f64>().ok()?;
    let seconds = parts.next()?.parse::<f64>().ok()?;
    if parts.next().is_some() {
        return None;
    }
    Some(hours * 3600.0 + minutes * 60.0 + seconds)
}

fn progress_fraction(seconds: f64, total_seconds: f64) -> f32 {
    if !(total_seconds.is_finite() && total_seconds > 0.0) {
        return 0.0;
    }
    (seconds / total_seconds).clamp(0.0, 1.0) as f32
}

/// Прореживание событий: только рост и не чаще `interval`. Завершение (1.0)
/// проходит всегда, чтобы шкала не застряла чуть ниже конца этапа.
struct ProgressThrottle {
    interval: Duration,
    last_emit: Option<Instant>,
    last_fraction: f32,
}

impl ProgressThrottle {
    fn new(interval: Duration) -> Self {
        Self {
            interval,
            last_emit: None,
            last_fraction: 0.0,
        }
    }

    fn offer(&mut self, fraction: f32, now: Instant) -> Option<f32> {
        let fraction = fraction.clamp(0.0, 1.0);
        if fraction <= self.last_fraction {
            return None;
        }
        let too_soon = self
            .last_emit
            .is_some_and(|last| now.saturating_duration_since(last) < self.interval);
        if too_soon && fraction < 1.0 {
            return None;
        }
        self.last_emit = Some(now);
        self.last_fraction = fraction;
        Some(fraction)
    }
}

async fn forward_ffmpeg_progress(stdout: tokio::process::ChildStdout, progress: FfmpegProgress) {
    use tokio::io::AsyncBufReadExt;

    let mut lines = tokio::io::BufReader::new(stdout).lines();
    let mut throttle = ProgressThrottle::new(PROGRESS_EMIT_INTERVAL);
    while let Ok(Some(line)) = lines.next_line().await {
        let fraction = if line.trim() == "progress=end" {
            Some(1.0)
        } else {
            parse_ffmpeg_progress_seconds(&line)
                .map(|seconds| progress_fraction(seconds, progress.total_seconds))
        };
        if let Some(fraction) = fraction.and_then(|value| throttle.offer(value, Instant::now())) {
            (progress.callback)(fraction);
        }
    }
}

/// Запуск ffmpeg с отменой. С `progress` читает его stdout
/// (`FFMPEG_PROGRESS_ARGS` добавляет вызывающий) и сообщает долю прохода;
/// при отмене процесс снимается, чтение stdout обрывается.
async fn run_cancelable_command_with_progress(
    command: &mut Command,
    cancel: Arc<AtomicBool>,
    label: &str,
    progress: Option<FfmpegProgress>,
) -> Result<std::process::Output> {
    command.kill_on_drop(true);
    crate::platform::hide_console_tokio(command);
    if progress.is_some() {
        command.stdout(Stdio::piped());
    }
    let mut child = command.spawn().with_context(|| format!("spawn {label}"))?;
    let child_pid = child.id();
    // Без явного opt-out Windows 11 держит ffmpeg в EcoQoS вместе со свёрнутым
    // окном приложения и уводит его на E-ядра. Остальные долгие дочерние
    // процессы (runner.rs, chat_overlay) это уже делают.
    crate::win_power::disable_for_pid(child_pid);
    // stdout забирается только под прогресс: без него он остаётся в `Output`.
    let reader = progress.and_then(|progress| {
        child
            .stdout
            .take()
            .map(|stdout| tokio::spawn(forward_ffmpeg_progress(stdout, progress)))
    });
    // Читатель живёт не дольше процесса: при выходе из функции он снимается.
    let mut reader = AbortOnDrop(reader);
    let wait = child.wait_with_output();
    tokio::pin!(wait);

    loop {
        tokio::select! {
            output = &mut wait => {
                // Дочитать хвост stdout (`progress=end`), но не ждать вечно.
                reader.finish(Duration::from_millis(500)).await;
                return output.with_context(|| format!("wait for {label}"));
            }
            _ = tokio::time::sleep(Duration::from_millis(100)) => {
                if cancel.load(Ordering::SeqCst) {
                    // Без явного убийства ffmpeg продолжал дожимать файл в фоне
                    // после «Отмены», держа CPU и диск (kill_on_drop не срабатывает,
                    // пока жив pinned wait).
                    if let Some(pid) = child_pid {
                        terminate_process_tree(pid);
                    }
                    return Err(anyhow!("FetchrMute task cancelled"));
                }
            }
        }
    }
}

struct AbortOnDrop(Option<tokio::task::JoinHandle<()>>);

impl AbortOnDrop {
    async fn finish(&mut self, limit: Duration) {
        if let Some(mut handle) = self.0.take() {
            if tokio::time::timeout(limit, &mut handle).await.is_err() {
                handle.abort();
            }
        }
    }
}

impl Drop for AbortOnDrop {
    fn drop(&mut self) {
        if let Some(handle) = self.0.take() {
            handle.abort();
        }
    }
}

/// Убивает процесс и его дерево (ffmpeg запускает кодеки внутри себя, поэтому
/// важно снять всю ветку). Аналог хелпера из asr_models — держим копию здесь,
/// чтобы не связывать модули приватными функциями.
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

pub(crate) fn normalize_word(word: &str) -> String {
    word.to_lowercase()
        .chars()
        .filter_map(|ch| match ch {
            'ё' => Some('е'),
            ch if ch.is_alphanumeric() => Some(ch),
            _ => None,
        })
        .collect()
}

fn set_progress(queue: &Arc<QueueManager>, job_id: &str, percent: f32, message: &str) {
    queue.set_progress(
        job_id,
        JobProgress {
            percent,
            message: Some(message.to_string()),
            ..JobProgress::default()
        },
    );
}

pub(crate) fn emit_log(queue: &Arc<QueueManager>, job_id: &str, line: &str) {
    emit(queue, job_id, line);
}

fn emit(queue: &Arc<QueueManager>, job_id: &str, line: &str) {
    queue.emit_job_log(job_id, line);
}

fn safe_path_part(value: &str) -> String {
    value
        .chars()
        .map(|ch| {
            if matches!(ch, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') {
                '_'
            } else {
                ch
            }
        })
        .collect()
}

fn format_duration(duration: Duration) -> String {
    let secs = duration.as_secs_f64();
    if secs < 60.0 {
        format!("{secs:.1}s")
    } else {
        format!("{:.1}min", secs / 60.0)
    }
}
