use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{anyhow, Context, Result};
use ort::session::Session;
use ort::value::Value;
use realfft::{num_complex::Complex, ComplexToReal, RealFftPlanner, RealToComplex};
use tokio::process::Command;

use crate::jobs::music_detect::{
    self, DetectedMusic, MusicFrame, StemTimeline, YamnetSession, YAMNET_SAMPLE_RATE,
};
use crate::jobs::queue::QueueManager;
use crate::jobs::types::{
    JobProgress, VocalRemoverMode, VocalRemoverSettings, VocalRemoverWorkflow,
};

const SAMPLE_RATE: u32 = 44_100;
const CHANNELS: u16 = 2;

// MDX-Net Kim Inst (fast mode): spectrogram-domain model, input [1, 4, dim_f, dim_t].
// Same export geometry as the Kim Vocal 2 it replaces, so speed is unchanged.
const MDX_N_FFT: usize = 7680;
const MDX_HOP: usize = 1024;
const MDX_DIM_F: usize = 3072;
const MDX_DIM_T: usize = 256;
const MDX_SEGMENT_SAMPLES: usize = MDX_HOP * (MDX_DIM_T - 1); // 261120 (~5.9 s)
const MDX_HOP_SAMPLES: usize = MDX_SEGMENT_SAMPLES / 4 * 3; // 25% overlap

// UVR's per-model output gain for the MDX prediction.
const MDX_COMPENSATE: f32 = 1.009;
// The fast model predicts the *instrumental* stem, so vocals are the spectral
// residual `mix - compensate * prediction`. A model trained to capture all of
// the music leaves less music in that residual than a vocals-primary model
// leaves inside its own prediction, which is what Content ID picks up on.
const MDX_PRIMARY_IS_INSTRUMENTAL: bool = true;

// Anti-copyright tuning: the music stem is thrown away there, so the mask may
// lean toward removing music at the cost of a little vocal body.
const MUSIC_OVERSUBTRACT: f32 = 1.05;
const MUSIC_GATE_STRENGTH: f32 = 1.25;
// A soft Wiener gate only scales bins, so whatever music it leaves behind is
// a quieter but structurally intact copy: its spectral peaks still line up
// with the original track, which is exactly what fingerprinting matches on.
// Bins where the vocal estimate holds less than this share of the energy
// (after the gate weighting) are therefore zeroed outright. Measured on
// speech + background music: fingerprint-peak overlap with the source track
// drops from ~70% to ~40% (chance level is ~33%) for ~2 dB of speech SNR.
const HARD_MASK_MIN_VOCAL_SHARE: f32 = 0.6;
// After separation, stretches where the kept audio is this quiet contain no
// intelligible speech, only residual music at -60…-75 dBFS. They are faded to
// digital silence instead of being left as a faint, still-fingerprintable
// copy of the track. The ramp runs from `RESIDUAL_MUTE_OPEN_DB` (unity gain)
// down to `RESIDUAL_MUTE_CLOSE_DB` (silence).
const RESIDUAL_MUTE_OPEN_DB: f32 = -58.0;
const RESIDUAL_MUTE_CLOSE_DB: f32 = -68.0;
const RESIDUAL_MUTE_WINDOW_SAMPLES: usize = 1024; // ~23 ms
const RESIDUAL_MUTE_HOP_SAMPLES: usize = 512;
const RESIDUAL_MUTE_SMOOTH_HOPS: usize = 5; // ~58 ms of gain smoothing

// Windowed RoFormer (studio mode): block-local attention instead of the full
// time attention of BS-Roformer, which is what makes it affordable here. The
// graph takes and returns a spectrogram, [1, 2, freqs, dim_t, 2] with the last
// axis holding (re, im); the output is the separated vocals, not a mask.
const WRF_N_FFT: usize = 2048;
const WRF_HOP: usize = 441;
const WRF_FREQS: usize = WRF_N_FFT / 2 + 1; // 1025
const WRF_SEGMENT_SAMPLES: usize = 352_800; // 8 s, fixed by the exported graph
const WRF_DIM_T: usize = WRF_SEGMENT_SAMPLES / WRF_HOP + 1; // 801
// Both heavy models run on the CPU on machines whose GPU cannot hold them, so
// they overlap chunks by an eighth (1 s of crossfade) instead of a quarter.
const WRF_HOP_SAMPLES: usize = WRF_SEGMENT_SAMPLES / 8 * 7;

// Mel-Band RoFormer SYHFT (ultra mode, Kim Vocal lineage): mask-domain model,
// input [1, freqs*2, dim_t, 2] with packed bin index 2*freq + channel.
const MBR_N_FFT: usize = 2048;
const MBR_HOP: usize = 441;
const MBR_FREQS: usize = MBR_N_FFT / 2 + 1; // 1025
const MBR_DIM_T: usize = 1101; // frames per chunk, fixed by the exported graph
const MBR_SEGMENT_SAMPLES: usize = MBR_HOP * (MBR_DIM_T - 1); // 485100 (~11 s)
const MBR_HOP_SAMPLES: usize = MBR_SEGMENT_SAMPLES / 8 * 7;

// Stems workflow processes long files in bounded blocks so multi-hour streams
// do not exhaust RAM (context margin of one segment on each side of a block).
const STEMS_BLOCK_SAMPLES: usize = SAMPLE_RATE as usize * 60 * 5; // 5 min

// Music detection runs the separator over seed neighbourhoods in bounded
// blocks so a stream with music everywhere does not pull hours of audio into
// RAM at once.
const DETECTION_BLOCK_SAMPLES: usize = SAMPLE_RATE as usize * 180; // 3 min
const ANTI_COPYRIGHT_CROSSFADE_SAMPLES: usize = SAMPLE_RATE as usize / 20;
// Music segments are cleaned in blocks of this size (plus context) so a long
// stretch of music never has to sit in RAM as one piece.
const ANTI_COPYRIGHT_BLOCK_SAMPLES: usize = SAMPLE_RATE as usize * 180; // 3 min

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct AudioSegment {
    pub start_sec: f64,
    pub end_sec: f64,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct VocalRemoverResult {
    pub vocals_path: String,
    pub instrumental_path: String,
    pub mode: VocalRemoverMode,
    #[serde(default)]
    pub workflow: VocalRemoverWorkflow,
    #[serde(default, rename = "antiCopyrightPath")]
    pub anti_copyright_path: Option<String>,
    #[serde(default, rename = "musicSegments")]
    pub music_segments: Vec<AudioSegment>,
    #[serde(default, rename = "processedMs")]
    pub processed_ms: u64,
    pub elapsed_ms: u64,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct HistoryItem {
    pub id: String,
    #[serde(rename = "fileName")]
    pub file_name: String,
    #[serde(rename = "filePath")]
    pub file_path: String,
    #[serde(rename = "vocalsPath")]
    pub vocals_path: String,
    #[serde(rename = "instrumentalPath")]
    pub instrumental_path: String,
    pub date: u64,
    pub mode: VocalRemoverMode,
    #[serde(default)]
    pub workflow: VocalRemoverWorkflow,
    #[serde(default, rename = "antiCopyrightPath")]
    pub anti_copyright_path: Option<String>,
    #[serde(default, rename = "musicSegments")]
    pub music_segments: Vec<AudioSegment>,
    #[serde(default, rename = "processedMs")]
    pub processed_ms: u64,
    #[serde(rename = "elapsedMs")]
    pub elapsed_ms: u64,
}

#[derive(Debug, Clone, Copy)]
struct ModelFile {
    url: &'static str,
    local_name: &'static str,
    label: &'static str,
    size: u64,
    sha256: &'static str,
}

const FAST_MODEL_FILES: &[ModelFile] = &[ModelFile {
    // Kim Inst (MDX-Net family): the instrumental-primary sibling of Kim Vocal
    // 2, identical export geometry and therefore identical CPU cost. Predicting
    // the music stem and subtracting it strips far more instrumental bleed from
    // the kept vocals than predicting the vocals directly.
    url: "https://huggingface.co/Politrees/UVR_resources/resolve/main/models/MDXNet/Kim_Inst.onnx",
    local_name: "kim_inst.onnx",
    label: "Kim Inst",
    size: 66_759_214,
    sha256: "86b1940e7122fbdd2beadc65507cbff6c352d79012a8a7e60d56db98532af5f7",
}];

const STUDIO_MODEL_FILES: &[ModelFile] = &[ModelFile {
    // Windowed RoFormer (Smule, checkpoint `mbr-win10-sink8`, MIT): separates
    // as cleanly as BS-Roformer on speech-over-music material at roughly twice
    // the throughput, because the attention is block-local.
    url: "https://huggingface.co/mtsmfm/windowed-roformer-onnx/resolve/main/windowed-roformer.onnx",
    local_name: "windowed_roformer.onnx",
    label: "Windowed RoFormer",
    size: 973_309_489,
    sha256: "1cc4853c1496dce1532d8d555fec518d6d0912db6bad8ebacfa4041c47c03d32",
}];

// Mel-Band RoFormer SYHFT ("Kim Vocal" big-model lineage, fp16): current
// top-quality vocal model. Shipped as a graph + external weights pair; the
// graph references the .data file by exact filename, so names must match.
const ULTRA_MODEL_FILES: &[ModelFile] = &[
    ModelFile {
        url: "https://huggingface.co/silverdaw/mel-band-roformer-vocals-onnx/resolve/main/syhft_core_folded_fp16_webgpu.onnx",
        local_name: "syhft_core_folded_fp16_webgpu.onnx",
        label: "Mel-Band RoFormer (graph)",
        size: 5_308_300,
        sha256: "dde2bfe8f85d2c12efa24ce4d45cc13e8709b8a72e277a93f130d496d948e918",
    },
    ModelFile {
        url: "https://huggingface.co/silverdaw/mel-band-roformer-vocals-onnx/resolve/main/syhft_core_folded_fp16_webgpu.onnx.data",
        local_name: "syhft_core_folded_fp16_webgpu.onnx.data",
        label: "Mel-Band RoFormer (weights)",
        size: 741_190_540,
        sha256: "b08cfc80905e3560a4dd5d30f641299a47dd96d309ebbe9524d9d6c9d2a0356f",
    },
];

#[derive(Debug, Clone)]
struct StereoAudio {
    left: Vec<f32>,
    right: Vec<f32>,
}

impl StereoAudio {
    fn new(samples: usize) -> Self {
        Self {
            left: vec![0.0; samples],
            right: vec![0.0; samples],
        }
    }

    fn len(&self) -> usize {
        self.left.len().min(self.right.len())
    }
}

#[derive(Debug, Clone)]
struct OutputPaths {
    vocals: PathBuf,
    instrumental: PathBuf,
    anti_copyright: PathBuf,
}

/// Removes the temp workspace on drop, including early error/cancel exits.
struct TempDirGuard(PathBuf);

impl Drop for TempDirGuard {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// Deletes a partially written output file unless `keep` is set on success.
struct PartialFileGuard {
    path: PathBuf,
    keep: bool,
}

impl PartialFileGuard {
    fn new(path: PathBuf) -> Self {
        Self { path, keep: false }
    }

    fn keep(&mut self) {
        self.keep = true;
    }
}

impl Drop for PartialFileGuard {
    fn drop(&mut self) {
        if !self.keep {
            let _ = std::fs::remove_file(&self.path);
        }
    }
}

/// Cross-platform per-user data dir (`%LOCALAPPDATA%` on Windows,
/// `~/Library/Application Support` on macOS, `~/.local/share` on Linux).
fn app_data_root() -> PathBuf {
    dirs::data_local_dir()
        .or_else(|| std::env::var("LOCALAPPDATA").map(PathBuf::from).ok())
        .unwrap_or_else(std::env::temp_dir)
        .join("Fetchr")
}

pub async fn run_on_local_file(
    queue: &Arc<QueueManager>,
    job_id: &str,
    input_path: &Path,
    ffmpeg: &Path,
    settings: VocalRemoverSettings,
    cancel: Arc<AtomicBool>,
) -> Result<VocalRemoverResult> {
    if cancel.load(Ordering::SeqCst) {
        return Err(anyhow!("Vocal Remover task cancelled"));
    }
    if !input_path.is_file() {
        return Err(anyhow!(
            "Input media file does not exist: {}",
            input_path.display()
        ));
    }

    let started = Instant::now();
    let output_paths = output_paths_for_input(input_path)?;
    let model_dir = model_dir_for_mode(settings.mode);
    let tmp_dir = std::env::temp_dir()
        .join("fetchr-vocal-remover")
        .join(safe_path_part(job_id));
    let wav_path = tmp_dir.join("source_44100_stereo.wav");

    tokio::fs::create_dir_all(&tmp_dir)
        .await
        .with_context(|| format!("create Vocal Remover temp dir {}", tmp_dir.display()))?;
    let _tmp_guard = TempDirGuard(tmp_dir.clone());

    queue.set_progress_stage(
        job_id,
        0.0,
        30.0,
        Some("Extracting 44.1 kHz stereo audio...".to_string()),
    );
    // The automatic anti-copyright workflow also needs the 16 kHz mix for
    // the classifier; decode once for both.
    let needs_detection = settings.workflow == VocalRemoverWorkflow::AntiCopyright
        && settings.custom_segments.is_none();
    let wav16_path = tmp_dir.join("source_16000_mono_norm.wav");
    if needs_detection {
        extract_scan_audio(ffmpeg, input_path, &wav_path, Some(&wav16_path), None).await?;
    } else if !reuse_scanned_source_audio(input_path, &wav_path) {
        extract_audio_to_wav(ffmpeg, input_path, &wav_path).await?;
    }

    if cancel.load(Ordering::SeqCst) {
        return Err(anyhow!("Vocal Remover task cancelled"));
    }

    let mut anti_copyright_path = None;
    let mut music_segments = Vec::new();
    let mut processed_ms = 0;
    // Fast-mode cleanup reuses the separator output of the detection pass:
    // the scan leaves it in the per-file cache, the automatic workflow in
    // the job's temp dir.
    let mut separation_cache_dir: Option<PathBuf> = None;

    match settings.workflow {
        VocalRemoverWorkflow::Stems => {
            queue.set_progress_stage(
                job_id,
                30.0,
                40.0,
                Some("Checking Vocal Remover models...".to_string()),
            );
            ensure_models(queue, job_id, settings.mode, &model_dir, cancel.clone()).await?;

            if cancel.load(Ordering::SeqCst) {
                return Err(anyhow!("Vocal Remover task cancelled"));
            }

            queue.set_progress_stage(
                job_id,
                40.0,
                92.0,
                Some("Separating vocals and instrumental...".to_string()),
            );
            let queue_for_worker = Arc::clone(queue);
            let job_id_for_worker = job_id.to_string();
            let model_dir_for_worker = model_dir.clone();
            let wav_path_for_worker = wav_path.clone();
            let output_paths_for_worker = output_paths.clone();
            let cancel_for_worker = cancel.clone();
            tokio::task::spawn_blocking(move || {
                separate_wav_blocking(
                    &queue_for_worker,
                    &job_id_for_worker,
                    &model_dir_for_worker,
                    &wav_path_for_worker,
                    &output_paths_for_worker,
                    settings.mode,
                    cancel_for_worker,
                )
            })
            .await
            .context("Vocal Remover worker panicked")??;

            queue.set_progress_stage(
                job_id,
                92.0,
                100.0,
                Some("Saving separated stems...".to_string()),
            );
            set_progress(queue, job_id, 100.0, "Vocal Remover finished.");
        }
        VocalRemoverWorkflow::AntiCopyright => {
            let (segments, processed) = if let Some(custom) = settings.custom_segments.clone() {
                let processed_ms = custom
                    .iter()
                    .map(|segment| {
                        ((segment.end_sec - segment.start_sec).max(0.0) * 1000.0).round() as u64
                    })
                    .sum();
                if let Ok(dir) = SeparationCache::dir_for(input_path) {
                    if dir.is_dir() {
                        separation_cache_dir = Some(dir);
                    }
                }
                (custom, processed_ms)
            } else {
                // Detection always uses the fast model regardless of the
                // separation mode picked for the cleanup itself.
                queue.set_progress_stage(
                    job_id,
                    30.0,
                    33.0,
                    Some("Checking music detection models...".to_string()),
                );
                let yamnet_path = music_detect::yamnet_model_path();
                {
                    let queue_for_progress = Arc::clone(queue);
                    let job_id_for_progress = job_id.to_string();
                    let mut on_progress = move |percent: f32, message: &str| {
                        set_progress(&queue_for_progress, &job_id_for_progress, percent, message);
                    };
                    music_detect::ensure_yamnet_model(&yamnet_path, cancel.clone(), &mut on_progress)
                        .await?;
                }
                queue.set_progress_stage(
                    job_id,
                    33.0,
                    36.0,
                    Some("Checking the fast separation model...".to_string()),
                );
                let fast_model_dir = model_dir_for_mode(VocalRemoverMode::FastHtdemucs);
                ensure_models(
                    queue,
                    job_id,
                    VocalRemoverMode::FastHtdemucs,
                    &fast_model_dir,
                    cancel.clone(),
                )
                .await?;

                queue.set_progress_stage(
                    job_id,
                    36.0,
                    58.0,
                    Some("Audio detection: music under speech...".to_string()),
                );
                let queue_for_worker = Arc::clone(queue);
                let job_id_for_worker = job_id.to_string();
                let wav_path_for_worker = wav_path.clone();
                let tmp_dir_for_worker = tmp_dir.clone();
                let cancel_for_worker = cancel.clone();
                let fast_model_path = detection_model_path();
                // The separator output of the detection pass is kept so the
                // fast-mode cleanup below never runs the model a second time.
                let cache_dir_for_worker = tmp_dir.join("separation-cache");
                let cache_dir_for_cleanup = cache_dir_for_worker.clone();
                let wav16_for_worker = wav16_path.clone();
                let analysis = tokio::task::spawn_blocking(move || {
                    let mut on_progress = |percent: f32, message: &str| {
                        set_progress(&queue_for_worker, &job_id_for_worker, percent, message);
                    };
                    let models = DetectionModels {
                        fast_model_path: &fast_model_path,
                        yamnet_path: &yamnet_path,
                    };
                    analyze_wav_for_music(
                        &models,
                        &wav_path_for_worker,
                        &wav16_for_worker,
                        &tmp_dir_for_worker,
                        &cache_dir_for_worker,
                        &cancel_for_worker,
                        &mut on_progress,
                    )
                })
                .await
                .context("Vocal Remover anti-copyright analysis worker panicked")??;
                separation_cache_dir = Some(cache_dir_for_cleanup);
                (analysis.segments, analysis.processed_ms)
            };

            music_segments = segments;
            processed_ms = processed;

            if !music_segments.is_empty() {
                queue.set_progress_stage(
                    job_id,
                    58.0,
                    60.0,
                    Some("Checking ONNX models for selected regions...".to_string()),
                );
                ensure_models(queue, job_id, settings.mode, &model_dir, cancel.clone()).await?;
            }

            if cancel.load(Ordering::SeqCst) {
                return Err(anyhow!("Vocal Remover task cancelled"));
            }

            queue.set_progress_stage(
                job_id,
                60.0,
                96.0,
                Some("Selective ONNX inference on music regions...".to_string()),
            );
            // The self-check needs the classifier; when it is missing
            // (offline, cache wiped) the cleanup still runs, just without it.
            let yamnet_path = music_detect::yamnet_model_path();
            let verify_yamnet = if yamnet_path.is_file() {
                Some(yamnet_path)
            } else {
                tracing::warn!("anti-copyright self-check skipped: YAMNet model missing");
                None
            };
            let queue_for_worker = Arc::clone(queue);
            let job_id_for_worker = job_id.to_string();
            let model_dir_for_worker = model_dir.clone();
            let wav_path_for_worker = wav_path.clone();
            let output_paths_for_worker = output_paths.clone();
            let segments_for_worker = music_segments.clone();
            let cache_dir_for_worker = separation_cache_dir.clone();
            let cancel_for_worker = cancel.clone();
            let stats = tokio::task::spawn_blocking(move || {
                let total_frames = WavStream::open(&wav_path_for_worker)?.total_frames();
                let cache = match (settings.mode, cache_dir_for_worker.as_deref()) {
                    (VocalRemoverMode::FastHtdemucs, Some(dir)) => {
                        SeparationCache::open(dir, total_frames)
                            .map_err(|err| tracing::warn!("separation cache unusable: {err}"))
                            .ok()
                            .flatten()
                    }
                    _ => None,
                };
                anti_copyright_wav_blocking(
                    &queue_for_worker,
                    &job_id_for_worker,
                    &model_dir_for_worker,
                    &wav_path_for_worker,
                    &output_paths_for_worker,
                    settings.mode,
                    segments_for_worker,
                    verify_yamnet.as_deref(),
                    cache,
                    cancel_for_worker,
                )
            })
            .await
            .context("Vocal Remover anti-copyright worker panicked")??;
            tracing::info!(
                "anti-copyright: {} block(s), {} from the separation cache, second pass on {}",
                stats.blocks,
                stats.cached_blocks,
                format_duration_ms(stats.second_pass_ms)
            );

            queue.set_progress_stage(
                job_id,
                96.0,
                100.0,
                Some("Seamless recomposition finished.".to_string()),
            );
            set_progress(queue, job_id, 100.0, "Anti-Copyright WAV finished.");
            anti_copyright_path = Some(output_paths.anti_copyright.to_string_lossy().into_owned());
        }
    }

    let elapsed_ms = started.elapsed().as_millis().min(u64::MAX as u128) as u64;
    let result = VocalRemoverResult {
        vocals_path: output_paths.vocals.to_string_lossy().into_owned(),
        instrumental_path: output_paths.instrumental.to_string_lossy().into_owned(),
        mode: settings.mode,
        workflow: settings.workflow,
        anti_copyright_path,
        music_segments,
        processed_ms,
        elapsed_ms,
    };
    add_history_item(HistoryItem {
        id: uuid::Uuid::new_v4().to_string(),
        file_name: input_path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or_default()
            .to_string(),
        file_path: input_path.to_string_lossy().into_owned(),
        vocals_path: result.vocals_path.clone(),
        instrumental_path: result.instrumental_path.clone(),
        date: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64,
        mode: settings.mode,
        workflow: settings.workflow,
        anti_copyright_path: result.anti_copyright_path.clone(),
        music_segments: result.music_segments.clone(),
        processed_ms: result.processed_ms,
        elapsed_ms,
    })?;

    Ok(result)
}

pub fn get_history_file_path() -> PathBuf {
    app_data_root().join("vocal_remover_history.json")
}

pub fn load_history() -> Result<Vec<HistoryItem>> {
    let path = get_history_file_path();
    if !path.exists() {
        return Ok(Vec::new());
    }
    let content = std::fs::read_to_string(&path)?;
    Ok(serde_json::from_str(&content).unwrap_or_default())
}

pub fn save_history(history: &[HistoryItem]) -> Result<()> {
    let path = get_history_file_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&path, serde_json::to_string_pretty(history)?)?;
    Ok(())
}

pub fn add_history_item(item: HistoryItem) -> Result<()> {
    let mut history = load_history().unwrap_or_default();
    history.retain(|existing| {
        existing.file_path != item.file_path
            || existing.mode != item.mode
            || existing.workflow != item.workflow
    });
    history.insert(0, item);
    if history.len() > 20 {
        history.truncate(20);
    }
    save_history(&history)
}

pub fn delete_history_item(id: &str) -> Result<()> {
    let mut history = load_history().unwrap_or_default();
    history.retain(|item| item.id != id);
    save_history(&history)
}

async fn ensure_models(
    queue: &Arc<QueueManager>,
    job_id: &str,
    mode: VocalRemoverMode,
    model_dir: &Path,
    cancel: Arc<AtomicBool>,
) -> Result<()> {
    let queue = Arc::clone(queue);
    let job_id = job_id.to_string();
    let mut on_progress = move |percent: f32, message: &str| {
        set_progress(&queue, &job_id, percent, message);
    };
    ensure_models_with_progress(mode, model_dir, cancel, &mut on_progress).await
}

/// Downloads the model files for `mode` unless they are already cached.
/// Progress is reported as 0–100 for the whole download step.
pub(crate) async fn ensure_models_with_progress(
    mode: VocalRemoverMode,
    model_dir: &Path,
    cancel: Arc<AtomicBool>,
    on_progress: &mut (dyn FnMut(f32, &str) + Send),
) -> Result<()> {
    tokio::fs::create_dir_all(model_dir)
        .await
        .with_context(|| format!("create Vocal Remover model dir {}", model_dir.display()))?;

    for dir in retired_model_dirs(mode) {
        if let Err(err) = tokio::fs::remove_dir_all(&dir).await {
            if err.kind() != std::io::ErrorKind::NotFound {
                tracing::warn!("retired model dir {} left in place: {err}", dir.display());
            }
        }
    }

    let files = model_files_for_mode(mode);
    for (index, file) in files.iter().enumerate() {
        if cancel.load(Ordering::SeqCst) {
            return Err(anyhow!("Vocal Remover task cancelled"));
        }

        let local_path = model_dir.join(file.local_name);
        if is_non_empty_file(&local_path).await {
            continue;
        }

        let start = (index as f32 / files.len() as f32) * 100.0;
        let end = ((index + 1) as f32 / files.len() as f32) * 100.0;
        download_model_file(
            on_progress,
            file,
            &local_path,
            start,
            end,
            cancel.clone(),
        )
        .await?;
    }

    on_progress(100.0, "Vocal Remover model cache is ready.");
    Ok(())
}

/// Frame count of a 44.1 kHz stereo WAV produced by `extract_audio_to_wav`.
pub(crate) fn wav_total_frames(wav_path: &Path) -> Result<usize> {
    Ok(WavStream::open(wav_path)?.total_frames())
}

/// Model file of the fast separator, which music detection always uses.
pub(crate) fn detection_model_path() -> PathBuf {
    model_dir_for_mode(VocalRemoverMode::FastHtdemucs)
        .join(model_files_for_mode(VocalRemoverMode::FastHtdemucs)[0].local_name)
}

async fn download_model_file(
    on_progress: &mut (dyn FnMut(f32, &str) + Send),
    file: &ModelFile,
    target: &Path,
    progress_start: f32,
    progress_end: f32,
    cancel: Arc<AtomicBool>,
) -> Result<()> {
    let mut report = |downloaded: u64, total: u64| {
        let ratio = downloaded as f32 / total.max(1) as f32;
        let message = format!(
            "Downloading {}: {} / {}",
            file.label,
            format_bytes(downloaded),
            format_bytes(total)
        );
        on_progress(progress_start + (progress_end - progress_start) * ratio, &message);
    };
    crate::jobs::model_download::download(
        crate::jobs::model_download::DownloadRequest {
            urls: crate::jobs::model_download::with_mirror(file.url),
            target,
            size: file.size,
            sha256: file.sha256,
            label: file.label,
        },
        &cancel,
        &mut report,
    )
    .await
    .map_err(|error| {
        if crate::jobs::model_download::is_cancelled(&error) {
            anyhow!("Vocal Remover task cancelled")
        } else {
            error
        }
    })
}

async fn is_non_empty_file(path: &Path) -> bool {
    tokio::fs::metadata(path)
        .await
        .map(|meta| meta.is_file() && meta.len() > 1024 * 1024)
        .unwrap_or(false)
}

/// Extracts the first audio stream as 44.1 kHz stereo 16-bit WAV, the
/// format every separation model here is fed from. 16-bit keeps the file at
/// half the size of float (6.7 h fit under the 4 GiB WAV limit instead of
/// 3.4 h) and its -96 dBFS floor is far below anything the models care about.
/// The copyright scan's full 44.1 kHz stereo decode, kept in the per-file cache.
const SCANNED_SOURCE_WAV: &str = "source_44100_stereo.wav";

/// Moves a finished scan's 44.1 kHz decode into the per-file separation cache.
/// It is made with exactly the arguments of `extract_audio_to_wav`, so the
/// "remove music" that usually follows the scan reuses it instead of decoding
/// the whole source again. Best effort: without it the cleanup decodes as before.
pub(crate) fn keep_scanned_source_audio(input: &Path, wav44: &Path) {
    let Ok(dir) = SeparationCache::dir_for(input) else {
        return;
    };
    // Only next to a cache this scan created; it goes away with that cache.
    if dir.is_dir() {
        let _ = std::fs::rename(wav44, dir.join(SCANNED_SOURCE_WAV));
    }
}

/// Links the scan's decode of this source into `wav_path`. The cache entry is
/// dropped right away (the link keeps the data for this run), so the extra
/// copy only lives between the scan and its cleanup.
fn reuse_scanned_source_audio(input: &Path, wav_path: &Path) -> bool {
    let Ok(dir) = SeparationCache::dir_for(input) else {
        return false;
    };
    let cached = dir.join(SCANNED_SOURCE_WAV);
    if !cached.is_file() || std::fs::hard_link(&cached, wav_path).is_err() {
        return false;
    }
    if WavStream::open(wav_path).is_err() {
        let _ = std::fs::remove_file(wav_path);
        return false;
    }
    let _ = std::fs::remove_file(&cached);
    true
}

pub(crate) async fn extract_audio_to_wav(
    ffmpeg: &Path,
    input_path: &Path,
    wav_path: &Path,
) -> Result<()> {
    let mut cmd = Command::new(ffmpeg);
    cmd.args(["-y", "-hide_banner", "-loglevel", "error"])
        .arg("-i")
        .arg(input_path)
        .args([
            "-map",
            "0:a:0",
            "-vn",
            "-ac",
            "2",
            "-ar",
            "44100",
            "-c:a",
            "pcm_s16le",
        ])
        .arg(wav_path)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());

    #[cfg(windows)]
    {
        cmd.creation_flags(0x0800_0000);
    }

    let output = cmd
        .output()
        .await
        .context("spawn ffmpeg Vocal Remover audio extract")?;
    if !output.status.success() {
        return Err(anyhow!(
            "ffmpeg audio extract failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    ensure_wav_within_limit(wav_path).await
}

/// A plain WAV header cannot describe more than 4 GiB; ffmpeg writes the data
/// anyway and the reader then sees a wrapped, much shorter duration. Refuse
/// such files with a clear message instead of silently processing a tail.
async fn ensure_wav_within_limit(wav_path: &Path) -> Result<()> {
    let size = tokio::fs::metadata(wav_path)
        .await
        .with_context(|| format!("stat {}", wav_path.display()))?
        .len();
    if size >= u32::MAX as u64 {
        return Err(anyhow!(
            "Audio is too long for a single WAV (about 6.7 h at 44.1 kHz): split the file first"
        ));
    }
    Ok(())
}

/// One ffmpeg decode, three outputs: the 44.1 kHz stereo source for the
/// separator, the level-flattened 16 kHz mono for the classifier and the
/// plain 16 kHz mono for Shazam. Decoding a multi-hour VOD once instead of
/// three times is the whole point.
pub(crate) async fn extract_scan_audio(
    ffmpeg: &Path,
    input_path: &Path,
    wav44_path: &Path,
    wav16_norm_path: Option<&Path>,
    wav16_plain_path: Option<&Path>,
) -> Result<()> {
    let mut cmd = Command::new(ffmpeg);
    cmd.args(["-y", "-hide_banner", "-loglevel", "error"])
        .arg("-i")
        .arg(input_path)
        .args(["-map", "0:a:0", "-vn", "-ac", "2", "-ar", "44100", "-c:a", "pcm_s16le"])
        .arg(wav44_path);
    if let Some(path) = wav16_norm_path {
        cmd.args(["-map", "0:a:0", "-vn", "-af", "dynaudnorm"])
            .args(["-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le"])
            .arg(path);
    }
    if let Some(path) = wav16_plain_path {
        cmd.args(["-map", "0:a:0", "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le"])
            .arg(path);
    }
    cmd.stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());

    #[cfg(windows)]
    {
        cmd.creation_flags(0x0800_0000);
    }

    let output = cmd
        .output()
        .await
        .context("spawn ffmpeg scan audio extract")?;
    if !output.status.success() {
        return Err(anyhow!(
            "ffmpeg audio extract failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    ensure_wav_within_limit(wav44_path).await?;
    if let Some(path) = wav16_norm_path {
        ensure_wav_within_limit(path).await?;
    }
    if let Some(path) = wav16_plain_path {
        ensure_wav_within_limit(path).await?;
    }
    Ok(())
}

#[derive(Debug, Clone)]
struct AntiCopyrightAnalysis {
    segments: Vec<AudioSegment>,
    processed_ms: u64,
}

/// Everything the two-stage music detector needs on disk.
pub(crate) struct DetectionModels<'a> {
    /// Fast separator (Kim Inst); its instrumental stem is what gets classified.
    pub fast_model_path: &'a Path,
    pub yamnet_path: &'a Path,
}

/// Automatic anti-copyright detection (no user review): the same two-stage
/// detector as the interactive scan, with the safety margin already applied.
fn analyze_wav_for_music(
    models: &DetectionModels,
    wav_path: &Path,
    wav16_norm_path: &Path,
    tmp_dir: &Path,
    cache_dir: &Path,
    cancel: &Arc<AtomicBool>,
    on_progress: &mut dyn FnMut(f32, &str),
) -> Result<AntiCopyrightAnalysis> {
    let total_frames = WavStream::open(wav_path)?.total_frames();
    let total_sec = total_frames as f64 / SAMPLE_RATE as f64;
    if total_sec <= 0.0 {
        return Err(anyhow!("Input audio is empty"));
    }
    let mut cache = SeparationCache::create(cache_dir, total_frames)?;
    let regions = detect_music_regions_blocking(
        models,
        wav_path,
        wav16_norm_path,
        tmp_dir,
        None,
        Some(&mut cache),
        cancel,
        on_progress,
        None,
    )?;
    let segments: Vec<AudioSegment> = music_detect::pad_and_merge(regions, total_sec)
        .into_iter()
        .map(|region| AudioSegment {
            start_sec: region.start_sec,
            end_sec: region.end_sec,
        })
        .collect();
    let processed_ms = segments
        .iter()
        .map(|segment| ((segment.end_sec - segment.start_sec).max(0.0) * 1000.0).round() as u64)
        .sum();
    on_progress(
        100.0,
        &format!(
            "Audio detection finished: {} music region(s), {} selected.",
            segments.len(),
            format_duration_ms(processed_ms)
        ),
    );
    Ok(AntiCopyrightAnalysis {
        segments,
        processed_ms,
    })
}

/// What the stem pass produces for one slice.
struct StemScores {
    frames: Vec<MusicFrame>,
    /// Instrumental residual as 16 kHz mono (Shazam probes it voice-free).
    stem16: Vec<f32>,
    /// Neutral (un-gated) vocals, cached so the cleanup can skip the model.
    vocals: StereoAudio,
}

/// Stem-pass classifier: separates a slice with the fast model, downmixes
/// and resamples the instrumental residual to 16 kHz in-process and scores
/// it with YAMNet. Used to find music and, in tests, to audit a cleanup.
pub(crate) struct StemClassifier {
    yamnet: YamnetSession,
}

impl StemClassifier {
    fn new(models: &DetectionModels) -> Result<Self> {
        Ok(Self {
            yamnet: YamnetSession::load(models.yamnet_path)?,
        })
    }

    /// Scores the instrumental residual of `slice` (44.1 kHz stereo starting
    /// at `offset_sec`) patch by patch.
    fn score_slice(
        &mut self,
        session: &mut VocalSession,
        slice: &StereoAudio,
        offset_sec: f64,
        cancel: &Arc<AtomicBool>,
        on_chunk: impl FnMut(usize, usize),
    ) -> Result<StemScores> {
        let vocals = run_vocals_model(
            session,
            VocalRemoverMode::FastHtdemucs,
            slice,
            SeparationIntent::Detect,
            None,
            cancel,
            on_chunk,
        )?;
        let stem = subtract_stems(slice, &vocals);
        let stem16 = music_detect::resample_44100_to_16000(&downmix(&stem));
        let frames = self
            .yamnet
            .score_samples(&stem16, offset_sec, true, cancel, &mut |_, _| {})?;
        Ok(StemScores {
            frames,
            stem16,
            vocals,
        })
    }
}

fn downmix(audio: &StereoAudio) -> Vec<f32> {
    (0..audio.len())
        .map(|index| (audio.left[index] + audio.right[index]) * 0.5)
        .collect()
}

/// Neutral fast-model vocals for the analysed ranges of one source file: a
/// pre-sized 44.1 kHz stereo 16-bit WAV written at block offsets plus the
/// list of covered ranges. The detection pass fills it, the fast-mode
/// cleanup reads it back and derives the gated result with a couple of
/// STFTs instead of a second model run over the same audio.
pub(crate) struct SeparationCache {
    wav_path: PathBuf,
    meta_path: PathBuf,
    total_frames: usize,
    generation: u64,
    covered: Vec<(usize, usize)>,
}

#[derive(serde::Serialize, serde::Deserialize)]
struct SeparationCacheMeta {
    model: String,
    total_frames: usize,
    /// Random id minted by `create`; a cache instance whose id no longer
    /// matches the file on disk was re-created underneath it (a second scan
    /// of the same file) and must stop trusting or touching it.
    generation: u64,
    covered: Vec<(usize, usize)>,
}

impl SeparationCache {
    const HEADER_BYTES: u64 = 44;
    const FRAME_BYTES: u64 = 4; // stereo i16
    /// Bump when the cached content changes meaning (model, intent, layout).
    const MODEL_TAG: &'static str = "kim_inst/detect/v1";
    const MAX_AGE: Duration = Duration::from_secs(24 * 60 * 60);

    /// Per-file cache directory under the app data dir, keyed by the source
    /// fingerprint (size + mtime + head/tail bytes).
    pub(crate) fn dir_for(input: &Path) -> Result<PathBuf> {
        let fingerprint = crate::jobs::fetchr_mute::source_fingerprint(input)?;
        Ok(app_data_root()
            .join("temp")
            .join("separation-cache")
            .join(safe_path_part(&fingerprint)))
    }

    /// Deletes cache directories older than `MAX_AGE` (a scan that was never
    /// followed by a cleanup).
    pub(crate) fn sweep_stale() {
        let root = app_data_root().join("temp").join("separation-cache");
        let Ok(entries) = std::fs::read_dir(&root) else {
            return;
        };
        for entry in entries.flatten() {
            let age = entry
                .metadata()
                .and_then(|meta| meta.modified())
                .ok()
                .and_then(|modified| modified.elapsed().ok());
            if age.map(|age| age > Self::MAX_AGE).unwrap_or(false) {
                let _ = std::fs::remove_dir_all(entry.path());
            }
        }
    }

    pub(crate) fn create(dir: &Path, total_frames: usize) -> Result<Self> {
        use std::io::Write;
        let _ = std::fs::remove_dir_all(dir);
        std::fs::create_dir_all(dir)
            .with_context(|| format!("create separation cache {}", dir.display()))?;
        let data_bytes = total_frames as u64 * Self::FRAME_BYTES;
        if Self::HEADER_BYTES + data_bytes > u32::MAX as u64 {
            return Err(anyhow!("separation cache would exceed the 4 GiB WAV limit"));
        }
        let wav_path = dir.join("vocals_44100_stereo.wav");
        let mut file = std::fs::File::create(&wav_path)
            .with_context(|| format!("create {}", wav_path.display()))?;
        let mut header = Vec::with_capacity(Self::HEADER_BYTES as usize);
        header.extend_from_slice(b"RIFF");
        header.extend_from_slice(&((36 + data_bytes) as u32).to_le_bytes());
        header.extend_from_slice(b"WAVE");
        header.extend_from_slice(b"fmt ");
        header.extend_from_slice(&16u32.to_le_bytes());
        header.extend_from_slice(&1u16.to_le_bytes()); // PCM
        header.extend_from_slice(&CHANNELS.to_le_bytes());
        header.extend_from_slice(&SAMPLE_RATE.to_le_bytes());
        header.extend_from_slice(&(SAMPLE_RATE * Self::FRAME_BYTES as u32).to_le_bytes());
        header.extend_from_slice(&(Self::FRAME_BYTES as u16).to_le_bytes());
        header.extend_from_slice(&16u16.to_le_bytes());
        header.extend_from_slice(b"data");
        header.extend_from_slice(&(data_bytes as u32).to_le_bytes());
        file.write_all(&header)?;
        file.set_len(Self::HEADER_BYTES + data_bytes)?;
        let cache = Self {
            wav_path,
            meta_path: dir.join("meta.json"),
            total_frames,
            generation: uuid::Uuid::new_v4().as_u128() as u64,
            covered: Vec::new(),
        };
        cache.save_meta()?;
        Ok(cache)
    }

    /// Opens an existing cache when it belongs to a source of `total_frames`
    /// frames and was written by the current model/layout.
    pub(crate) fn open(dir: &Path, total_frames: usize) -> Result<Option<Self>> {
        let meta_path = dir.join("meta.json");
        let wav_path = dir.join("vocals_44100_stereo.wav");
        if !meta_path.is_file() || !wav_path.is_file() {
            return Ok(None);
        }
        let meta: SeparationCacheMeta = serde_json::from_slice(&std::fs::read(&meta_path)?)
            .with_context(|| format!("parse {}", meta_path.display()))?;
        if meta.model != Self::MODEL_TAG || meta.total_frames != total_frames {
            return Ok(None);
        }
        Ok(Some(Self {
            wav_path,
            meta_path,
            total_frames,
            generation: meta.generation,
            covered: meta.covered,
        }))
    }

    fn save_meta(&self) -> Result<()> {
        let meta = SeparationCacheMeta {
            model: Self::MODEL_TAG.to_string(),
            total_frames: self.total_frames,
            generation: self.generation,
            covered: self.covered.clone(),
        };
        std::fs::write(&self.meta_path, serde_json::to_vec(&meta)?)
            .with_context(|| format!("write {}", self.meta_path.display()))
    }

    /// Re-reads the on-disk state; fails when the cache was re-created by
    /// someone else since this instance was opened.
    fn refresh(&mut self) -> Result<()> {
        let meta: SeparationCacheMeta = serde_json::from_slice(&std::fs::read(&self.meta_path)?)
            .with_context(|| format!("parse {}", self.meta_path.display()))?;
        if meta.generation != self.generation
            || meta.model != Self::MODEL_TAG
            || meta.total_frames != self.total_frames
        {
            return Err(anyhow!("separation cache was replaced by another scan"));
        }
        self.covered = meta.covered;
        Ok(())
    }

    /// Stores `vocals` at `start` (frames) and records the covered range.
    fn write_block(&mut self, start: usize, vocals: &StereoAudio) -> Result<()> {
        use std::io::{Seek, SeekFrom, Write};
        if start >= self.total_frames {
            return Ok(());
        }
        self.refresh()?;
        let count = vocals.len().min(self.total_frames - start);
        let mut bytes = Vec::with_capacity(count * Self::FRAME_BYTES as usize);
        for index in 0..count {
            bytes.extend_from_slice(&float_to_i16(vocals.left[index]).to_le_bytes());
            bytes.extend_from_slice(&float_to_i16(vocals.right[index]).to_le_bytes());
        }
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .open(&self.wav_path)
            .with_context(|| format!("open {}", self.wav_path.display()))?;
        file.seek(SeekFrom::Start(
            Self::HEADER_BYTES + start as u64 * Self::FRAME_BYTES,
        ))?;
        file.write_all(&bytes)?;
        self.covered.push((start, start + count));
        self.covered.sort_by_key(|range| range.0);
        let mut merged: Vec<(usize, usize)> = Vec::with_capacity(self.covered.len());
        for range in self.covered.drain(..) {
            match merged.last_mut() {
                Some(last) if range.0 <= last.1 => last.1 = last.1.max(range.1),
                _ => merged.push(range),
            }
        }
        self.covered = merged;
        self.save_meta()
    }

    /// Reads the cached vocals for `[start, end)` together with the parts of
    /// that range the cache actually holds (relative to `start`); anything
    /// outside them is silence and must go through the model.
    fn read_block(&mut self, start: usize, end: usize) -> Result<Option<CachedVocals>> {
        self.refresh()?;
        let covered: Vec<(usize, usize)> = self
            .covered
            .iter()
            .filter(|(from, to)| *to > start && *from < end)
            .map(|(from, to)| ((*from).max(start) - start, (*to).min(end) - start))
            .collect();
        if covered.is_empty() {
            return Ok(None);
        }
        let mut stream = WavStream::open(&self.wav_path)?;
        stream.seek(start)?;
        let block = stream.read_frames(end.saturating_sub(start))?;
        if block.len() != end.saturating_sub(start) {
            return Err(anyhow!("separation cache is truncated"));
        }
        Ok(Some(CachedVocals {
            vocals: block,
            covered,
        }))
    }
}

/// Cached neutral vocals for one slice plus the sample ranges (relative to
/// the slice) that are valid.
struct CachedVocals {
    vocals: StereoAudio,
    covered: Vec<(usize, usize)>,
}

impl CachedVocals {
    fn covers(&self, start: usize, end: usize) -> bool {
        self.covered
            .iter()
            .any(|(from, to)| *from <= start && end <= *to)
    }
}

/// Two-stage music detection over a 44.1 kHz stereo source WAV.
///
/// Stage 1 scores the 16 kHz normalised mix with YAMNet and seeds
/// neighbourhoods wherever music merely flickers through the speech. Stage 2
/// runs the fast separator over those neighbourhoods, resamples the
/// instrumental stem and classifies *that*, which sees background music the
/// mix classifier cannot. Returned regions are unpadded and sorted.
pub(crate) fn detect_music_regions_blocking(
    models: &DetectionModels,
    wav_path: &Path,
    wav16_norm_path: &Path,
    tmp_dir: &Path,
    stem_timeline_path: Option<&Path>,
    mut separation_cache: Option<&mut SeparationCache>,
    cancel: &Arc<AtomicBool>,
    on_progress: &mut dyn FnMut(f32, &str),
    mut on_neighbourhood: Option<&mut dyn FnMut(Vec<DetectedMusic>)>,
) -> Result<Vec<DetectedMusic>> {
    const COARSE_END: f32 = 10.0;

    if cancel.load(Ordering::SeqCst) {
        return Err(anyhow!("Music detection cancelled"));
    }
    let _ = tmp_dir;
    let started = Instant::now();
    on_progress(0.0, "Загрузка ИИ-классификатора (YAMNet)...");
    let mut classifier = StemClassifier::new(models)?;
    let total_sec = music_detect::wav_mono16_duration_sec(wav16_norm_path)?;

    let mut coarse_progress = |done: usize, total: usize| {
        let percent = COARSE_END * done as f32 / total.max(1) as f32;
        on_progress(
            percent,
            &format!(
                "Быстрый поиск музыки: {} / {}",
                format_duration_ms((total_sec * done as f64 / total.max(1) as f64 * 1000.0) as u64),
                format_duration_ms((total_sec * 1000.0) as u64)
            ),
        );
    };
    let coarse = classifier
        .yamnet
        .score_wav(wav16_norm_path, false, cancel, &mut coarse_progress)?;
    let seeds = music_detect::seed_windows(&coarse);
    let neighbourhoods = music_detect::seed_neighbourhoods(&seeds, total_sec);
    let coarse_elapsed = started.elapsed();
    if neighbourhoods.is_empty() {
        on_progress(100.0, "Музыка не обнаружена.");
        return Ok(Vec::new());
    }

    on_progress(COARSE_END, "Загрузка модели разделения (Kim Inst)...");
    let mut session = build_fast_session(models.fast_model_path)?;
    let mut stream = WavStream::open(wav_path)?;
    let total_frames = stream.total_frames();
    let mut stem_timeline = match stem_timeline_path {
        Some(path) => Some(StemTimeline::create(path, total_sec)?),
        None => None,
    };

    // Blocks get a second of context on each side so separator edge
    // artefacts (the last half chunk overlap plus the STFT edge) never reach
    // the classifier; only the interior is scored.
    let context = SAMPLE_RATE as usize;
    let work_total: f64 = neighbourhoods.iter().map(|(s, e)| e - s).sum();
    let mut work_done = 0.0f64;
    let mut regions: Vec<DetectedMusic> = Vec::new();
    let to_frames = |sec: f64| ((sec * SAMPLE_RATE as f64) as usize).min(total_frames);
    let to_sec = |frames: usize| frames as f64 / SAMPLE_RATE as f64;

    // Separates `[range_start, range_end)` block by block and appends the
    // stem frames; also feeds the stem timeline and the separation cache.
    let mut analyse_range = |range_start: usize,
                             range_end: usize,
                             stem_frames: &mut Vec<MusicFrame>,
                             work_done: &mut f64|
     -> Result<()> {
        let mut block_start = range_start;
        while block_start < range_end {
            if cancel.load(Ordering::SeqCst) {
                return Err(anyhow!("Music detection cancelled"));
            }
            let block_end = (block_start + DETECTION_BLOCK_SAMPLES).min(range_end);
            let ctx_start = block_start.saturating_sub(context);
            let ctx_end = (block_end + context).min(total_frames);
            stream.seek(ctx_start)?;
            let slice = stream.read_frames(ctx_end - ctx_start)?;
            if slice.len() != ctx_end - ctx_start {
                return Err(anyhow!(
                    "Extracted WAV is truncated at {}",
                    format_duration_ms((to_sec(ctx_start) * 1000.0) as u64)
                ));
            }
            let block_sec = to_sec(block_end - block_start);
            let base_done = *work_done;
            let offset_sec = to_sec(ctx_start);
            let StemScores {
                frames,
                stem16,
                vocals,
            } = classifier.score_slice(
                &mut session,
                &slice,
                offset_sec,
                cancel,
                |chunk, chunks| {
                    let local = chunk as f64 / chunks.max(1) as f64 * block_sec;
                    let percent = (COARSE_END
                        + ((base_done + local) / work_total.max(1.0)) as f32 * (100.0 - COARSE_END))
                        .min(99.0);
                    on_progress(
                        percent,
                        &format!(
                            "ИИ-анализ фоновой музыки: {} / {}",
                            format_duration_ms(((base_done + local) * 1000.0) as u64),
                            format_duration_ms((work_total * 1000.0) as u64)
                        ),
                    );
                },
            )?;
            let interior_start_sec = to_sec(block_start);
            let interior_end_sec = to_sec(block_end);
            stem_frames.extend(frames.into_iter().filter(|frame| {
                frame.start_sec >= interior_start_sec - 1e-6 && frame.start_sec < interior_end_sec
            }));
            // Both side outputs are accelerators for later steps; losing one
            // (disk full, cache re-created by another scan) must not fail
            // the detection itself.
            if let Some(timeline) = stem_timeline.as_mut() {
                let skip = (to_sec(block_start - ctx_start) * YAMNET_SAMPLE_RATE as f64) as usize;
                let take = (block_sec * YAMNET_SAMPLE_RATE as f64) as usize;
                let interior: Vec<f32> = stem16.iter().skip(skip).take(take).copied().collect();
                if let Err(err) = timeline.write_at(interior_start_sec, &interior) {
                    tracing::warn!("stem timeline dropped: {err}");
                    stem_timeline = None;
                }
            }
            if let Some(cache) = separation_cache.as_deref_mut() {
                let interior = slice_audio(
                    &vocals,
                    block_start - ctx_start,
                    block_end - ctx_start,
                );
                if let Err(err) = cache.write_block(block_start, &interior) {
                    tracing::warn!("separation cache dropped: {err}");
                    separation_cache = None;
                }
            }

            *work_done += block_sec;
            block_start = block_end;
        }
        Ok(())
    };

    // A region that reaches the edge of its neighbourhood most likely
    // continues beyond it (a long track with sparse seeds in the mix), so
    // the neighbourhood grows in that direction until the music ends.
    let grow_frames = (music_detect::NEIGHBOURHOOD_GROW_SEC * SAMPLE_RATE as f64) as usize;
    let edge_sec = music_detect::NEIGHBOURHOOD_EDGE_SEC;
    let mut analysed_until = 0usize;
    for (index, (start_sec, end_sec)) in neighbourhoods.iter().enumerate() {
        let floor = analysed_until;
        let ceiling = neighbourhoods
            .get(index + 1)
            .map(|(next_start, _)| to_frames(*next_start))
            .unwrap_or(total_frames);
        let mut start = to_frames(*start_sec).max(floor);
        let mut end = to_frames(*end_sec).min(ceiling);
        let (seeded_start, seeded_end) = (to_sec(start), to_sec(end));
        let mut stem_frames: Vec<MusicFrame> = Vec::new();
        analyse_range(start, end, &mut stem_frames, &mut work_done)?;
        loop {
            let found = music_detect::regions_from_stem_frames(&stem_frames);
            let touches_end = end < ceiling
                && found.iter().any(|region| region.end_sec >= to_sec(end) - edge_sec);
            let touches_start = start > floor
                && found.iter().any(|region| region.start_sec <= to_sec(start) + edge_sec);
            if !touches_end && !touches_start {
                break;
            }
            if touches_end {
                let new_end = (end + grow_frames).min(ceiling);
                analyse_range(end, new_end, &mut stem_frames, &mut work_done)?;
                end = new_end;
            }
            if touches_start {
                let new_start = start.saturating_sub(grow_frames).max(floor);
                analyse_range(new_start, start, &mut stem_frames, &mut work_done)?;
                start = new_start;
            }
        }
        // The cleanup pads every region and needs the separation of the
        // padding too; analyse that much extra so the cache covers it.
        let reach = ((music_detect::SAFETY_PAD_SEC * SAMPLE_RATE as f64) as usize)
            + mode_segment_params(VocalRemoverMode::FastHtdemucs).0;
        let found = music_detect::regions_from_stem_frames(&stem_frames);
        if let Some(last_end) = found.iter().map(|region| to_frames(region.end_sec)).max() {
            let wanted_end = (last_end + reach).min(ceiling);
            if wanted_end > end {
                analyse_range(end, wanted_end, &mut stem_frames, &mut work_done)?;
                end = wanted_end;
            }
        }
        if let Some(first_start) = found.iter().map(|region| to_frames(region.start_sec)).min() {
            let wanted_start = first_start.saturating_sub(reach).max(floor);
            if wanted_start < start {
                analyse_range(wanted_start, start, &mut stem_frames, &mut work_done)?;
                start = wanted_start;
            }
        }
        analysed_until = end;
        // Regions never span neighbourhoods (nothing was analysed between
        // them), so each one is final as soon as its stem pass ends and can
        // be handed on (Shazam probes it while the next one separates).
        // Only regions inside the original, seed-derived range have to be
        // vouched for by a seed; whatever the growth found beyond it was
        // reached through music and is kept.
        let (inside, grown): (Vec<DetectedMusic>, Vec<DetectedMusic>) =
            music_detect::regions_from_stem_frames(&stem_frames)
                .into_iter()
                .partition(|region| {
                    region.start_sec >= seeded_start - 1e-6 && region.end_sec <= seeded_end + 1e-6
                });
        let mut found = music_detect::keep_seeded(inside, &seeds);
        found.extend(grown);
        found.sort_by(|a, b| a.start_sec.total_cmp(&b.start_sec));
        if let Some(callback) = on_neighbourhood.as_deref_mut() {
            callback(found.clone());
        }
        regions.extend(found);
    }
    tracing::info!(
        "music detection: coarse pass {:.1} s, stem pass {:.1} s over {} of audio",
        coarse_elapsed.as_secs_f64(),
        (started.elapsed() - coarse_elapsed).as_secs_f64(),
        format_duration_ms((work_done * 1000.0) as u64)
    );

    on_progress(
        100.0,
        &format!("Найдено участков с музыкой: {}", regions.len()),
    );
    Ok(regions)
}

/// Self-check for the cleanup: classifies the cleaned slice itself (level
/// normalised, so residual music in speech pauses is judged on content, not
/// loudness) and returns the sample ranges (relative to the slice) where
/// music still survives, each widened by a second so the second pass gets
/// context. Under continuous speech the classifier is blind, but there the
/// hard mask has already zeroed every music-dominated bin.
fn residual_music_ranges(
    yamnet: &mut YamnetSession,
    cleaned: &StereoAudio,
    cancel: &Arc<AtomicBool>,
) -> Result<Vec<(usize, usize)>> {
    const MARGIN: usize = SAMPLE_RATE as usize;
    let mono16 = music_detect::resample_44100_to_16000(&downmix(cleaned));
    let frames = yamnet.score_samples(&mono16, 0.0, true, cancel, &mut |_, _| {})?;
    let len = cleaned.len();
    Ok(music_detect::regions_from_stem_frames(&frames)
        .into_iter()
        .map(|region| {
            let start = ((region.start_sec * SAMPLE_RATE as f64) as usize).saturating_sub(MARGIN);
            let end = ((region.end_sec * SAMPLE_RATE as f64) as usize + MARGIN).min(len);
            (start.min(len), end)
        })
        .filter(|(start, end)| end > start)
        .collect())
}

fn slice_audio(audio: &StereoAudio, start: usize, end: usize) -> StereoAudio {
    StereoAudio {
        left: audio.left[start..end].to_vec(),
        right: audio.right[start..end].to_vec(),
    }
}

/// Streaming anti-copyright: the source WAV is never loaded into memory as a
/// whole. Clean regions are streamed straight to the output file; music
/// segments are processed in bounded blocks (with one model chunk of context
/// on each side and a short crossfade between blocks), so memory stays flat
/// even when music plays for an hour straight.
#[derive(Debug, Default, Clone, Copy)]
struct CleanupStats {
    blocks: usize,
    cached_blocks: usize,
    second_pass_ms: u64,
}

fn anti_copyright_wav_blocking(
    queue: &Arc<QueueManager>,
    job_id: &str,
    model_dir: &Path,
    wav_path: &Path,
    output_paths: &OutputPaths,
    mode: VocalRemoverMode,
    segments: Vec<AudioSegment>,
    verify_yamnet: Option<&Path>,
    mut cache: Option<SeparationCache>,
    cancel: Arc<AtomicBool>,
) -> Result<CleanupStats> {
    let mut stream = WavStream::open(wav_path)?;
    let total_frames = stream.total_frames();
    if total_frames == 0 {
        return Err(anyhow!("Input audio is empty"));
    }

    // Sanitize segment list: clamp to file bounds, sort, merge overlaps.
    let mut ranges: Vec<(usize, usize)> = segments
        .iter()
        .filter_map(|segment| segment_to_samples(segment, total_frames))
        .collect();
    ranges.sort_by_key(|range| range.0);
    let mut merged: Vec<(usize, usize)> = Vec::new();
    for range in ranges {
        if let Some(last) = merged.last_mut() {
            if range.0 <= last.1 {
                last.1 = last.1.max(range.1);
                continue;
            }
        }
        merged.push(range);
    }

    if let Some(parent) = output_paths.anti_copyright.parent() {
        std::fs::create_dir_all(parent)?;
    }
    // If the task is cancelled or fails mid-write, drop the half-written WAV
    // instead of leaving a corrupt file next to the source.
    let mut output_guard = PartialFileGuard::new(output_paths.anti_copyright.clone());
    let writer_spec = hound::WavSpec {
        channels: CHANNELS,
        sample_rate: SAMPLE_RATE,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let mut writer = hound::WavWriter::create(&output_paths.anti_copyright, writer_spec)
        .with_context(|| format!("create WAV {}", output_paths.anti_copyright.display()))?;

    if merged.is_empty() {
        set_progress(
            queue,
            job_id,
            50.0,
            "No music regions detected; copying original audio...",
        );
        stream_copy(&mut stream, &mut writer, total_frames, &cancel)?;
        writer.finalize()?;
        output_guard.keep();
        return Ok(CleanupStats::default());
    }

    let model_path = model_dir.join(model_files_for_mode(mode)[0].local_name);
    let label = mode_label(mode);
    let mut session = if mode == VocalRemoverMode::FastHtdemucs {
        build_fast_session(&model_path)?
    } else {
        build_session(&model_path, mode)?
    };
    if mode != VocalRemoverMode::FastHtdemucs {
        cache = None;
    }

    // Self-check after every block: the classifier looks for music that
    // survived the pass and only those stretches get a second pass.
    let mut verifier = match verify_yamnet {
        Some(path) => Some(YamnetSession::load(path)?),
        None => None,
    };
    let mut stats = CleanupStats::default();

    let context = mode_segment_params(mode).0;
    let total_work: usize = merged.iter().map(|(start, end)| end - start).sum();
    let mut done_work = 0usize;
    let mut cursor = 0usize;

    for (seg_index, (seg_start, seg_end)) in merged.iter().copied().enumerate() {
        if seg_start > cursor {
            stream.seek(cursor)?;
            stream_copy(&mut stream, &mut writer, seg_start - cursor, &cancel)?;
        }

        // Tail of the previous block, still unwritten, crossfaded with the
        // start of the next block so block seams stay inaudible.
        let mut held_tail: Option<StereoAudio> = None;
        let mut block_start = seg_start;
        while block_start < seg_end {
            if cancel.load(Ordering::SeqCst) {
                return Err(anyhow!("Vocal Remover task cancelled"));
            }
            let mut block_end = (block_start + ANTI_COPYRIGHT_BLOCK_SAMPLES).min(seg_end);
            if seg_end - block_end < context {
                block_end = seg_end; // do not leave a sliver for a separate block
            }
            let ctx_start = block_start.saturating_sub(context).max(seg_start);
            let ctx_end = (block_end + context).min(seg_end);
            stream.seek(ctx_start)?;
            let slice = stream.read_frames(ctx_end - ctx_start)?;
            if slice.len() != ctx_end - ctx_start {
                return Err(anyhow!(
                    "Extracted WAV is truncated at {}",
                    format_duration_ms((ctx_start as f64 / SAMPLE_RATE as f64 * 1000.0) as u64)
                ));
            }

            let block_len = block_end - block_start;
            let base_work = done_work;
            // Phases of one block: pass 1 → self-check → optional pass 2.
            let report = |chunk: usize, chunks: usize, phase: CleanPhase| {
                let (from, to) = match phase {
                    CleanPhase::Pass1 => (0.0, 0.6),
                    CleanPhase::Verify => (0.6, 0.85),
                    CleanPhase::Pass2 => (0.85, 1.0),
                };
                let frac = from + (to - from) * chunk as f64 / chunks.max(1) as f64;
                let percent =
                    ((base_work as f64 + frac * block_len as f64) / total_work.max(1) as f64 * 95.0)
                        as f32;
                set_progress(
                    queue,
                    job_id,
                    percent,
                    &format!(
                        "{label}: участок {} / {}{}",
                        seg_index + 1,
                        merged.len(),
                        phase.suffix()
                    ),
                );
            };
            // The cache is an accelerator, never a requirement: on any
            // problem the block simply goes through the model.
            let cached = match cache.as_mut() {
                Some(active) => match active.read_block(ctx_start, ctx_end) {
                    Ok(block) => block,
                    Err(err) => {
                        tracing::warn!("separation cache dropped: {err}");
                        cache = None;
                        None
                    }
                },
                None => None,
            };
            stats.blocks += 1;
            stats.cached_blocks += usize::from(
                cached
                    .as_ref()
                    .map(|cached| cached.covers(0, slice.len()))
                    .unwrap_or(false),
            );
            let vocals = clean_slice(
                &mut session,
                mode,
                &slice,
                cached.as_ref(),
                verifier.as_mut(),
                seg_index,
                &cancel,
                &report,
                &mut stats,
            )?;

            // Fade between original and cleaned audio only where the block
            // touches the real segment boundary.
            let mut cleaned = slice;
            blend_replacement_with_fades(
                &mut cleaned,
                &vocals,
                ctx_start == seg_start,
                ctx_end == seg_end,
            );

            // Write the block interior, crossfading its head with the held
            // tail of the previous block and holding its own tail.
            let overlap = if held_tail.is_some() {
                ANTI_COPYRIGHT_CROSSFADE_SAMPLES.min(block_start - ctx_start)
            } else {
                0
            };
            let write_from = block_start - ctx_start - overlap;
            let hold = if block_end < seg_end {
                ANTI_COPYRIGHT_CROSSFADE_SAMPLES.min(block_len)
            } else {
                0
            };
            let write_to = block_end - ctx_start - hold;
            let mut out = slice_audio(&cleaned, write_from, write_to);
            if let Some(tail) = held_tail.take() {
                let fade = overlap.min(tail.len());
                for index in 0..fade {
                    let weight = (index + 1) as f32 / (fade + 1) as f32;
                    let tail_index = tail.len() - fade + index;
                    out.left[index] = tail.left[tail_index] * (1.0 - weight) + out.left[index] * weight;
                    out.right[index] =
                        tail.right[tail_index] * (1.0 - weight) + out.right[index] * weight;
                }
            }
            write_audio(&mut writer, &out)?;
            if hold > 0 {
                held_tail = Some(slice_audio(&cleaned, write_to, write_to + hold));
            }

            done_work += block_len;
            block_start = block_end;
        }
        if let Some(tail) = held_tail.take() {
            write_audio(&mut writer, &tail)?;
        }
        cursor = seg_end;
    }

    if cursor < total_frames {
        stream.seek(cursor)?;
        stream_copy(&mut stream, &mut writer, total_frames - cursor, &cancel)?;
    }

    set_progress(
        queue,
        job_id,
        98.0,
        "Seamless recomposition: writing clean WAV...",
    );
    writer.finalize()?;
    output_guard.keep();
    Ok(stats)
}

#[derive(Debug, Clone, Copy)]
enum CleanPhase {
    Pass1,
    Verify,
    Pass2,
}

impl CleanPhase {
    fn suffix(self) -> &'static str {
        match self {
            CleanPhase::Pass1 => "",
            CleanPhase::Verify => " — проверка остатков",
            CleanPhase::Pass2 => " — второй проход",
        }
    }
}

/// One cleanup pass over `slice` (from the cached separation when
/// available) plus the optional self-check that re-runs the model only where
/// music survived.
#[allow(clippy::too_many_arguments)]
fn clean_slice(
    session: &mut VocalSession,
    mode: VocalRemoverMode,
    slice: &StereoAudio,
    cached: Option<&CachedVocals>,
    verifier: Option<&mut YamnetSession>,
    seg_index: usize,
    cancel: &Arc<AtomicBool>,
    report: &dyn Fn(usize, usize, CleanPhase),
    stats: &mut CleanupStats,
) -> Result<StereoAudio> {
    let started = Instant::now();
    let mut vocals = run_vocals_model(
        session,
        mode,
        slice,
        SeparationIntent::AntiCopyright,
        cached,
        cancel,
        |chunk, chunks| report(chunk, chunks, CleanPhase::Pass1),
    )?;
    mute_quiet_residual(&mut vocals);
    let pass1 = started.elapsed();

    let Some(yamnet) = verifier else {
        return Ok(vocals);
    };
    report(0, 1, CleanPhase::Verify);
    let residual = residual_music_ranges(yamnet, &vocals, cancel)?;
    let verify = started.elapsed() - pass1;
    if !residual.is_empty() {
        tracing::info!(
            "anti-copyright: music survived pass 1 in {} stretch(es) of segment {}, running pass 2",
            residual.len(),
            seg_index + 1
        );
    }
    for (sub_start, sub_end) in residual {
        if cancel.load(Ordering::SeqCst) {
            return Err(anyhow!("Vocal Remover task cancelled"));
        }
        let sub = slice_audio(&vocals, sub_start, sub_end);
        let mut sub_clean = run_vocals_model(
            session,
            mode,
            &sub,
            SeparationIntent::AntiCopyright,
            None,
            cancel,
            |chunk, chunks| report(chunk, chunks, CleanPhase::Pass2),
        )?;
        mute_quiet_residual(&mut sub_clean);
        blend_replacement(&mut vocals, &sub_clean, sub_start);
        stats.second_pass_ms += ((sub_end - sub_start) as f64 / SAMPLE_RATE as f64 * 1000.0) as u64;
    }
    tracing::debug!(
        "anti-copyright block: pass 1 {:.1} s ({}), self-check {:.1} s, pass 2 {:.1} s",
        pass1.as_secs_f64(),
        if cached.is_some() { "cached" } else { "model" },
        verify.as_secs_f64(),
        (started.elapsed() - pass1 - verify).as_secs_f64()
    );
    Ok(vocals)
}

fn mode_label(mode: VocalRemoverMode) -> &'static str {
    match mode {
        VocalRemoverMode::FastHtdemucs => "Kim Inst",
        VocalRemoverMode::StudioHtdemucsFt => "Windowed RoFormer",
        VocalRemoverMode::UltraMelband => "Mel-Band RoFormer",
    }
}

/// Sequential WAV frame reader: pulls stereo f32 frames from disk without
/// keeping the whole file in memory.
struct WavStream {
    reader: hound::WavReader<std::io::BufReader<std::fs::File>>,
    format: hound::SampleFormat,
    bits: u16,
}

impl WavStream {
    fn open(path: &Path) -> Result<Self> {
        let reader = hound::WavReader::open(path)
            .with_context(|| format!("open extracted WAV {}", path.display()))?;
        let spec = reader.spec();
        if spec.channels != CHANNELS || spec.sample_rate != SAMPLE_RATE {
            return Err(anyhow!(
                "Unexpected WAV format: {} channels at {} Hz",
                spec.channels,
                spec.sample_rate
            ));
        }
        Ok(Self {
            format: spec.sample_format,
            bits: spec.bits_per_sample,
            reader,
        })
    }

    fn total_frames(&self) -> usize {
        self.reader.duration() as usize
    }

    /// Moves the read position to an absolute frame index.
    fn seek(&mut self, frame: usize) -> Result<()> {
        let frame = u32::try_from(frame.min(self.total_frames()))
            .map_err(|_| anyhow!("WAV position {frame} does not fit the format"))?;
        self.reader
            .seek(frame)
            .with_context(|| format!("seek extracted WAV to frame {frame}"))
    }

    /// Read up to `frames` stereo frames from the current position.
    fn read_frames(&mut self, frames: usize) -> Result<StereoAudio> {
        let mut left = Vec::with_capacity(frames);
        let mut right = Vec::with_capacity(frames);
        match self.format {
            hound::SampleFormat::Float => {
                let mut samples = self.reader.samples::<f32>();
                for _ in 0..frames {
                    let Some(l) = samples.next() else { break };
                    let Some(r) = samples.next() else { break };
                    left.push(l?);
                    right.push(r?);
                }
            }
            hound::SampleFormat::Int if self.bits <= 16 => {
                let scale = (1i32 << (self.bits.saturating_sub(1) as u32)) as f32;
                let mut samples = self.reader.samples::<i16>();
                for _ in 0..frames {
                    let Some(l) = samples.next() else { break };
                    let Some(r) = samples.next() else { break };
                    left.push(l? as f32 / scale);
                    right.push(r? as f32 / scale);
                }
            }
            hound::SampleFormat::Int => {
                let scale = (1i64 << (self.bits.saturating_sub(1) as u32)) as f32;
                let mut samples = self.reader.samples::<i32>();
                for _ in 0..frames {
                    let Some(l) = samples.next() else { break };
                    let Some(r) = samples.next() else { break };
                    left.push(l? as f32 / scale);
                    right.push(r? as f32 / scale);
                }
            }
        }
        Ok(StereoAudio { left, right })
    }
}

fn write_audio(
    writer: &mut hound::WavWriter<std::io::BufWriter<std::fs::File>>,
    audio: &StereoAudio,
) -> Result<()> {
    let frames = audio.len();
    let mut chunk_start = 0usize;
    while chunk_start < frames {
        // Bounded so the unchecked writer's sample count fits in u32.
        let chunk_end = (chunk_start + (1 << 20)).min(frames);
        let mut sink = writer.get_i16_writer(((chunk_end - chunk_start) * 2) as u32);
        for index in chunk_start..chunk_end {
            sink.write_sample(float_to_i16(audio.left[index]));
            sink.write_sample(float_to_i16(audio.right[index]));
        }
        sink.flush()?;
        chunk_start = chunk_end;
    }
    Ok(())
}

/// Stream `frames` frames from reader to writer in bounded chunks.
fn stream_copy(
    stream: &mut WavStream,
    writer: &mut hound::WavWriter<std::io::BufWriter<std::fs::File>>,
    frames: usize,
    cancel: &Arc<AtomicBool>,
) -> Result<()> {
    const COPY_CHUNK_FRAMES: usize = 1 << 20; // ~8 MB per channel pair
    let mut remaining = frames;
    while remaining > 0 {
        if cancel.load(Ordering::SeqCst) {
            return Err(anyhow!("Vocal Remover task cancelled"));
        }
        let take = remaining.min(COPY_CHUNK_FRAMES);
        let chunk = stream.read_frames(take)?;
        if chunk.len() == 0 {
            break;
        }
        write_audio(writer, &chunk)?;
        remaining = remaining.saturating_sub(chunk.len());
    }
    Ok(())
}

/// Block-wise stems separation: the source WAV is streamed in ~5-minute
/// blocks (plus one segment of context on each side), so peak memory stays
/// flat (~a few hundred MB) even for multi-hour streams.
fn separate_wav_blocking(
    queue: &Arc<QueueManager>,
    job_id: &str,
    model_dir: &Path,
    wav_path: &Path,
    output_paths: &OutputPaths,
    mode: VocalRemoverMode,
    cancel: Arc<AtomicBool>,
) -> Result<()> {
    let mut stream = WavStream::open(wav_path)?;
    let total_frames = stream.total_frames();
    if total_frames == 0 {
        return Err(anyhow!("Input audio is empty"));
    }

    let label = mode_label(mode);
    let (segment, _) = mode_segment_params(mode);
    let margin = segment; // one full chunk of context on each block side
    let mut session = build_session(&model_dir.join(model_files_for_mode(mode)[0].local_name), mode)?;

    if let Some(parent) = output_paths.vocals.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let writer_spec = hound::WavSpec {
        channels: CHANNELS,
        sample_rate: SAMPLE_RATE,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    // Partial outputs are deleted on cancel/error instead of being left corrupt.
    let mut vocals_guard = PartialFileGuard::new(output_paths.vocals.clone());
    let mut inst_guard = PartialFileGuard::new(output_paths.instrumental.clone());
    let mut vocals_writer = hound::WavWriter::create(&output_paths.vocals, writer_spec)
        .with_context(|| format!("create WAV {}", output_paths.vocals.display()))?;
    let mut inst_writer = hound::WavWriter::create(&output_paths.instrumental, writer_spec)
        .with_context(|| format!("create WAV {}", output_paths.instrumental.display()))?;

    let mut retained = StereoAudio::new(0); // tail of the previous slice, <= 2*margin frames
    let mut read_end = 0usize; // stream position
    let mut write_pos = 0usize; // first unwritten frame

    while write_pos < total_frames {
        if cancel.load(Ordering::SeqCst) {
            return Err(anyhow!("Vocal Remover task cancelled"));
        }

        let slice_start = write_pos.saturating_sub(margin);
        let slice_end = (write_pos + STEMS_BLOCK_SAMPLES + margin).min(total_frames);

        // Assemble the block: retained left context + freshly read frames.
        let mut slice = StereoAudio::new(slice_end - slice_start);
        let ctx = (read_end - slice_start).min(retained.len());
        if ctx > 0 {
            let tail = retained.len() - ctx;
            slice.left[..ctx].copy_from_slice(&retained.left[tail..]);
            slice.right[..ctx].copy_from_slice(&retained.right[tail..]);
        }
        let fresh = stream.read_frames(slice_end - read_end)?;
        slice.left[ctx..ctx + fresh.len()].copy_from_slice(&fresh.left);
        slice.right[ctx..ctx + fresh.len()].copy_from_slice(&fresh.right);
        let got = ctx + fresh.len();
        if got == 0 {
            break;
        }
        slice.left.truncate(got);
        slice.right.truncate(got);
        read_end += fresh.len();

        let write_end = (write_pos + STEMS_BLOCK_SAMPLES).min(slice_start + got);
        let base = write_pos;
        let span = (write_end - write_pos).max(1) as f64;
        let total = total_frames as f64;
        let vocals = run_vocals_model(
            &mut session,
            mode,
            &slice,
            SeparationIntent::Stems,
            None,
            &cancel,
            |chunk, chunks| {
                let frac = chunk as f64 / chunks.max(1) as f64;
                let percent = ((base as f64 + frac * span) / total * 100.0) as f32;
                set_progress(
                    queue,
                    job_id,
                    percent,
                    &format!("{label}: chunk {chunk} / {chunks}"),
                );
            },
        )?;
        // run_vocals_model always returns vocals; instrumental is the residual.
        let instrumental = subtract_stems(&slice, &vocals);

        let off = write_pos - slice_start;
        let len = write_end - write_pos;
        write_range(&mut vocals_writer, &vocals, off, len)?;
        write_range(&mut inst_writer, &instrumental, off, len)?;
        write_pos = write_end;

        // Retain the tail so the next block gets left context + lookahead.
        let keep = (2 * margin).min(slice.len());
        retained = StereoAudio {
            left: slice.left[slice.len() - keep..].to_vec(),
            right: slice.right[slice.len() - keep..].to_vec(),
        };
    }

    set_progress(
        queue,
        job_id,
        99.0,
        "Finalizing vocal and instrumental WAV files...",
    );
    vocals_writer.finalize()?;
    inst_writer.finalize()?;
    vocals_guard.keep();
    inst_guard.keep();
    Ok(())
}

fn write_range(
    writer: &mut hound::WavWriter<std::io::BufWriter<std::fs::File>>,
    audio: &StereoAudio,
    start: usize,
    len: usize,
) -> Result<()> {
    for index in start..start + len {
        writer.write_sample(float_to_i16(audio.left[index]))?;
        writer.write_sample(float_to_i16(audio.right[index]))?;
    }
    Ok(())
}

/// Session plus everything needed to rebuild it on CPU: hardware execution
/// providers can build a valid session and still fail at `Run` time (e.g.
/// `DmlFusedNode_0_0` when DirectML runs out of device memory), so the
/// fallback has to be available during inference, not only at load time.
struct VocalSession {
    session: Session,
    /// Plain-CPU copy of the same model that chews on chunks in parallel
    /// with an accelerated `session`: the GPU thread barely loads the CPU,
    /// so the cores would otherwise sit idle. Only built for the fast model.
    helper: Option<Session>,
    model_path: PathBuf,
    threads: usize,
    accelerated: bool,
}

impl VocalSession {
    /// Rebuilds the session on plain CPU. Returns false when already on CPU.
    fn fall_back_to_cpu(&mut self) -> Result<bool> {
        if !self.accelerated {
            return Ok(false);
        }
        self.session = match self.helper.take() {
            Some(helper) => helper,
            None => build_cpu_session(&self.model_path, self.threads)?,
        };
        self.accelerated = false;
        Ok(true)
    }
}

fn is_gpu_memory_error(err: &anyhow::Error) -> bool {
    let text = format!("{err:#}").to_ascii_lowercase();
    ["8007000e", "e_outofmemory", "out of memory", "not enough memory"]
        .iter()
        .any(|needle| text.contains(needle))
}

/// Thread budget for a session. The fast model stops scaling past 8 threads,
/// while the heavy ones keep gaining (Windowed RoFormer: 0.72x realtime on 8
/// threads, 0.84x on 16), so they get every core but one.
fn session_threads(mode: VocalRemoverMode) -> usize {
    let cap = match mode {
        VocalRemoverMode::FastHtdemucs => 8,
        VocalRemoverMode::StudioHtdemucsFt | VocalRemoverMode::UltraMelband => 32,
    };
    // Leave one core for the OS so the machine stays usable during inference.
    std::thread::available_parallelism()
        .map(|value| value.get().saturating_sub(1).clamp(1, cap))
        .unwrap_or(4)
}

fn build_session(model_path: &Path, mode: VocalRemoverMode) -> Result<VocalSession> {
    build_session_with_threads(model_path, session_threads(mode))
}

/// Fast-model session that, when the primary runs on a GPU, also gets a CPU
/// helper so both work through the chunk queue at once.
fn build_fast_session(model_path: &Path) -> Result<VocalSession> {
    let mut session = build_session(model_path, VocalRemoverMode::FastHtdemucs)?;
    if session.accelerated && std::env::var_os("FETCHR_NO_CPU_HELPER").is_none() {
        // Leave two threads for the GPU feeder and the OS, and stay small: on
        // the i5-13500H + Iris Xe the helper measured +7 % at best and a net
        // slowdown from 8 threads up, because its pool competes with the
        // feeder's STFT work.
        let helper_threads = std::env::var("FETCHR_CPU_HELPER_THREADS")
            .ok()
            .and_then(|value| value.parse::<usize>().ok())
            .unwrap_or_else(|| {
                std::thread::available_parallelism()
                    .map(|value| value.get().saturating_sub(2).clamp(1, 4))
                    .unwrap_or(4)
            });
        match build_cpu_session(model_path, helper_threads) {
            Ok(helper) => session.helper = Some(helper),
            Err(err) => tracing::warn!("CPU helper session unavailable: {err}"),
        }
    }
    Ok(session)
}

fn build_cpu_session(model_path: &Path, intra_threads: usize) -> Result<Session> {
    Session::builder()
        .map_err(|err| anyhow!("create ONNX session builder: {err}"))?
        .with_intra_threads(intra_threads.max(1))
        .map_err(|err| anyhow!("set ONNX intra threads: {err}"))?
        .with_inter_threads(1)
        .map_err(|err| anyhow!("set ONNX inter threads: {err}"))?
        .commit_from_file(model_path)
        .map_err(|err| anyhow!("load ONNX model {}: {err}", model_path.display()))
}

fn build_session_with_threads(model_path: &Path, intra_threads: usize) -> Result<VocalSession> {
    if !model_path.is_file() {
        return Err(anyhow!(
            "Vocal Remover model is missing: {}",
            model_path.display()
        ));
    }

    // Hardware execution providers first (GPU/NPU acceleration), then a plain
    // CPU session as the always-working fallback.
    #[cfg(target_os = "windows")]
    if !super::gpu_blocklist::is_blocked(&app_data_root(), model_path) {
        let accelerated = (|| -> Result<Session> {
            Ok(Session::builder()
                .map_err(|err| anyhow!("create ONNX session builder: {err}"))?
                .with_intra_threads(intra_threads.max(1))
                .map_err(|err| anyhow!("set ONNX intra threads: {err}"))?
                .with_inter_threads(1)
                .map_err(|err| anyhow!("set ONNX inter threads: {err}"))?
                // DirectML mandates sequential execution and no memory-pattern
                // planning; with them on the session builds but the fused DML
                // graph node fails on the first Run.
                .with_parallel_execution(false)
                .map_err(|err| anyhow!("set ONNX execution mode: {err}"))?
                .with_memory_pattern(false)
                .map_err(|err| anyhow!("disable ONNX memory pattern: {err}"))?
                .with_execution_providers([
                    ort::ep::DirectML::default().build(),
                    ort::ep::OpenVINO::default().build(),
                    ort::ep::CPU::default().build(),
                ])
                .map_err(|err| anyhow!("register execution providers: {err}"))?
                .commit_from_file(model_path)
                .map_err(|err| anyhow!("commit accelerated session: {err}"))?)
        })();
        match accelerated {
            Ok(session) => {
                return Ok(VocalSession {
                    session,
                    helper: None,
                    model_path: model_path.to_path_buf(),
                    threads: intra_threads,
                    accelerated: true,
                })
            }
            // An unsupported GPU is expected, not a bug: the CPU path covers it.
            Err(err) => {
                let reason = super::gpu_blocklist::clean_ort_message(&err.to_string());
                tracing::info!("GPU ONNX session failed, using CPU from now on: {reason}");
                super::gpu_blocklist::block(&app_data_root(), model_path, &reason);
            }
        }
    }

    #[cfg(target_os = "macos")]
    {
        let accelerated = (|| -> Result<Session> {
            Ok(Session::builder()
                .map_err(|err| anyhow!("create ONNX session builder: {err}"))?
                .with_intra_threads(intra_threads.max(1))
                .map_err(|err| anyhow!("set ONNX intra threads: {err}"))?
                .with_inter_threads(1)
                .map_err(|err| anyhow!("set ONNX inter threads: {err}"))?
                .with_execution_providers([
                    ort::ep::CoreML::default().build(),
                    ort::ep::CPU::default().build(),
                ])
                .map_err(|err| anyhow!("register execution providers: {err}"))?
                .commit_from_file(model_path)
                .map_err(|err| anyhow!("commit accelerated session: {err}"))?)
        })();
        match accelerated {
            Ok(session) => {
                return Ok(VocalSession {
                    session,
                    helper: None,
                    model_path: model_path.to_path_buf(),
                    threads: intra_threads,
                    accelerated: true,
                })
            }
            Err(err) => tracing::warn!("CoreML ONNX session failed, falling back to CPU: {err}"),
        }
    }

    Ok(VocalSession {
        session: build_cpu_session(model_path, intra_threads)?,
        helper: None,
        model_path: model_path.to_path_buf(),
        threads: intra_threads,
        accelerated: false,
    })
}

/// STFT/ISTFT engine matching `torch.stft`/`torch.istft` with `center=true`,
/// reflect padding and a periodic Hann window (`win_length == n_fft`).
struct StftEngine {
    n_fft: usize,
    hop: usize,
    window: Vec<f32>,
    fft: std::sync::Arc<dyn RealToComplex<f32>>,
    ifft: std::sync::Arc<dyn ComplexToReal<f32>>,
}

impl StftEngine {
    fn new(n_fft: usize, hop: usize) -> Self {
        let mut planner = RealFftPlanner::<f32>::new();
        let fft = planner.plan_fft_forward(n_fft);
        let ifft = planner.plan_fft_inverse(n_fft);
        let window = (0..n_fft)
            .map(|i| {
                let phase = (std::f32::consts::TAU * i as f32) / n_fft as f32;
                0.5 - 0.5 * phase.cos()
            })
            .collect();
        Self {
            n_fft,
            hop,
            window,
            fft,
            ifft,
        }
    }

    fn num_frames(&self, len: usize) -> usize {
        len / self.hop + 1
    }

    /// Frames-major spectrogram: `[num_frames][n_fft / 2 + 1]`.
    fn stft(&self, signal: &[f32]) -> Vec<Vec<Complex<f32>>> {
        let half = (self.n_fft / 2) as isize;
        let len = signal.len() as isize;
        let sample_at = |idx: isize| -> f32 {
            if len == 0 {
                return 0.0;
            }
            let mut i = idx;
            if i < 0 {
                i = -i;
            }
            if i >= len {
                i = 2 * (len - 1) - i;
            }
            signal[i.clamp(0, len - 1) as usize]
        };

        let frames = self.num_frames(signal.len());
        let mut input = self.fft.make_input_vec();
        let mut output = self.fft.make_output_vec();
        let mut scratch = self.fft.make_scratch_vec();
        let mut result = Vec::with_capacity(frames);
        for t in 0..frames {
            let start = (t * self.hop) as isize - half;
            for (i, value) in input.iter_mut().enumerate() {
                *value = sample_at(start + i as isize) * self.window[i];
            }
            let _ = self
                .fft
                .process_with_scratch(&mut input, &mut output, &mut scratch);
            result.push(output.clone());
        }
        result
    }

    fn istft(&self, frames: &[Vec<Complex<f32>>], length: usize) -> Vec<f32> {
        if frames.is_empty() {
            return vec![0.0; length];
        }
        let half = self.n_fft / 2;
        let total = (frames.len() - 1) * self.hop + self.n_fft;
        let mut acc = vec![0.0f32; total];
        let mut wsum = vec![0.0f32; total];
        let mut spec = self.ifft.make_input_vec();
        let mut out = self.ifft.make_output_vec();
        let mut scratch = self.ifft.make_scratch_vec();
        let scale = 1.0 / self.n_fft as f32;
        for (t, frame) in frames.iter().enumerate() {
            spec.copy_from_slice(frame);
            // realfft requires purely real DC and Nyquist bins.
            spec[0].im = 0.0;
            let last = spec.len() - 1;
            spec[last].im = 0.0;
            let _ = self
                .ifft
                .process_with_scratch(&mut spec, &mut out, &mut scratch);
            let offset = t * self.hop;
            for i in 0..self.n_fft {
                acc[offset + i] += out[i] * scale * self.window[i];
                wsum[offset + i] += self.window[i] * self.window[i];
            }
        }
        let mut result = vec![0.0f32; length];
        for (i, value) in result.iter_mut().enumerate() {
            let j = i + half;
            if j < total && wsum[j] > 1e-8 {
                *value = acc[j] / wsum[j];
            }
        }
        result
    }
}

fn session_io_names(session: &Session) -> Result<(String, String)> {
    let input = session
        .inputs()
        .first()
        .map(|i| i.name().to_string())
        .ok_or_else(|| anyhow!("ONNX model has no inputs"))?;
    let output = session
        .outputs()
        .first()
        .map(|o| o.name().to_string())
        .ok_or_else(|| anyhow!("ONNX model has no outputs"))?;
    Ok((input, output))
}

/// What the caller intends to do with the separation, which decides both the
/// chunk overlap and how hard residual music is suppressed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SeparationIntent {
    /// Both stems are kept: full 25% overlap, neutral masking.
    Stems,
    /// Only the vocal side survives, so the chunk overlap shrinks to ~0.5 s
    /// (seams are masked by the crossfade) and residual music is gated hard —
    /// leftover instrumental is exactly what a Content ID match latches onto.
    AntiCopyright,
    /// Music detection: neutral masking like `Stems` (the instrumental
    /// residual must stay honest) with the short overlap of `AntiCopyright`
    /// (only a coarse per-second envelope is needed from it).
    Detect,
}

/// Run the vocals model for the current mode over the full audio with
/// overlapped chunks. Returns the predicted vocals stem.
/// One chunk's separated vocals, indexed by chunk position.
type ChunkResult = (usize, Vec<f32>, Vec<f32>);

/// Work shared between the inference workers of one `run_vocals_model` call.
struct ChunkQueue<'a> {
    audio: &'a StereoAudio,
    starts: &'a [usize],
    segment: usize,
    mode: VocalRemoverMode,
    intent: SeparationIntent,
    cancel: &'a Arc<AtomicBool>,
    pending: std::sync::Mutex<std::collections::VecDeque<usize>>,
    results: std::sync::Mutex<Vec<ChunkResult>>,
    completed: std::sync::atomic::AtomicUsize,
}

impl ChunkQueue<'_> {
    fn next(&self) -> Option<usize> {
        self.pending.lock().ok()?.pop_front()
    }

    fn requeue(&self, chunk_index: usize) {
        if let Ok(mut pending) = self.pending.lock() {
            pending.push_front(chunk_index);
        }
    }

    fn chunk_input(&self, chunk_index: usize) -> (Vec<f32>, Vec<f32>, usize) {
        let start = self.starts[chunk_index];
        let usable = self.segment.min(self.audio.len().saturating_sub(start));
        let mut left = vec![0.0f32; self.segment];
        let mut right = vec![0.0f32; self.segment];
        left[..usable].copy_from_slice(&self.audio.left[start..start + usable]);
        right[..usable].copy_from_slice(&self.audio.right[start..start + usable]);
        (left, right, usable)
    }

    fn push(&self, chunk_index: usize, left: Vec<f32>, right: Vec<f32>) {
        if let Ok(mut results) = self.results.lock() {
            results.push((chunk_index, left, right));
        }
        self.completed
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    }
}

fn engine_for_mode(mode: VocalRemoverMode) -> StftEngine {
    match mode {
        VocalRemoverMode::FastHtdemucs => StftEngine::new(MDX_N_FFT, MDX_HOP),
        VocalRemoverMode::StudioHtdemucsFt => StftEngine::new(WRF_N_FFT, WRF_HOP),
        VocalRemoverMode::UltraMelband => StftEngine::new(MBR_N_FFT, MBR_HOP),
    }
}

/// Per-session state a worker needs besides the session itself.
struct WorkerContext {
    engine: StftEngine,
    input_name: String,
    output_name: String,
    /// Mel-Band RoFormer ships as an fp16 graph; the other two are fp32.
    input_is_f16: bool,
    output_is_f16: bool,
}

impl WorkerContext {
    fn new(session: &Session, mode: VocalRemoverMode) -> Result<Self> {
        let (input_name, output_name) = session_io_names(session)?;
        let is_f16 = |dtype: Option<&ort::value::ValueType>| {
            matches!(
                dtype,
                Some(ort::value::ValueType::Tensor {
                    ty: ort::value::TensorElementType::Float16,
                    ..
                })
            )
        };
        Ok(Self {
            engine: engine_for_mode(mode),
            input_name,
            output_name,
            input_is_f16: is_f16(session.inputs().first().map(|input| input.dtype())),
            output_is_f16: is_f16(session.outputs().first().map(|output| output.dtype())),
        })
    }
}

fn separate_one_chunk(
    session: &mut Session,
    context: &WorkerContext,
    queue: &ChunkQueue,
    chunk_index: usize,
) -> Result<(Vec<f32>, Vec<f32>)> {
    let (left, right, _) = queue.chunk_input(chunk_index);
    let prepared = prepare_chunk(queue.mode, &context.engine, &left, &right);
    let flat = infer_chunk(session, queue.mode, context, prepared.input.clone())?;
    Ok(finish_chunk(
        queue.mode,
        &context.engine,
        queue.intent,
        &prepared,
        &flat,
        left.len(),
    ))
}

/// Runs one session over the queue until it is empty. On an inference error
/// the chunk goes back to the queue and the error is returned, so a failing
/// session stops while the other one finishes the work.
fn separate_chunks_worker(session: &mut Session, queue: &ChunkQueue) -> Result<()> {
    let context = WorkerContext::new(session, queue.mode)?;
    while let Some(chunk_index) = queue.next() {
        if queue.cancel.load(Ordering::SeqCst) {
            queue.requeue(chunk_index);
            return Err(anyhow!("Vocal Remover task cancelled"));
        }
        match separate_one_chunk(session, &context, queue, chunk_index) {
            Ok((voc_l, voc_r)) => queue.push(chunk_index, voc_l, voc_r),
            Err(err) => {
                queue.requeue(chunk_index);
                return Err(err);
            }
        }
    }
    Ok(())
}

/// Run the vocals model for the current mode over the full audio with
/// overlapped chunks. Returns the predicted vocals stem.
///
/// `cached`: neutral (`Detect` intent) fast-model vocals aligned with
/// `audio`. When given for the fast mode, every chunk's prediction is
/// recovered from it and the model is not run at all.
fn run_vocals_model(
    session: &mut VocalSession,
    mode: VocalRemoverMode,
    audio: &StereoAudio,
    intent: SeparationIntent,
    cached: Option<&CachedVocals>,
    cancel: &Arc<AtomicBool>,
    mut on_chunk: impl FnMut(usize, usize),
) -> Result<StereoAudio> {
    let (segment, default_hop) = mode_segment_params(mode);
    let seg_hop = match intent {
        SeparationIntent::AntiCopyright | SeparationIntent::Detect => {
            segment - SAMPLE_RATE as usize / 2
        }
        SeparationIntent::Stems => default_hop,
    };
    let samples = audio.len();
    let starts = chunk_starts(samples, segment, seg_hop);
    let mut vocals = StereoAudio::new(samples);
    let mut weights = vec![0.0f32; samples];
    let mut accumulate = |start: usize, voc_l: &[f32], voc_r: &[f32]| {
        let usable = segment.min(samples.saturating_sub(start));
        for i in 0..usable {
            vocals.left[start + i] += voc_l[i];
            vocals.right[start + i] += voc_r[i];
            weights[start + i] += 1.0;
        }
    };

    // Cached separation first: chunks the cache holds need no inference,
    // just the STFT-domain post-processing. The rest go to the model.
    let mut pending: std::collections::VecDeque<usize> = std::collections::VecDeque::new();
    let mut cached_chunks = 0usize;
    match (cached, mode) {
        (Some(cache), VocalRemoverMode::FastHtdemucs) if cache.vocals.len() >= samples => {
            let engine = StftEngine::new(MDX_N_FFT, MDX_HOP);
            for (chunk_index, start) in starts.iter().copied().enumerate() {
                let usable = segment.min(samples.saturating_sub(start));
                if !cache.covers(start, start + usable) {
                    pending.push_back(chunk_index);
                    continue;
                }
                if cancel.load(Ordering::SeqCst) {
                    return Err(anyhow!("Vocal Remover task cancelled"));
                }
                let mut left = vec![0.0f32; segment];
                let mut right = vec![0.0f32; segment];
                let mut cache_l = vec![0.0f32; segment];
                let mut cache_r = vec![0.0f32; segment];
                left[..usable].copy_from_slice(&audio.left[start..start + usable]);
                right[..usable].copy_from_slice(&audio.right[start..start + usable]);
                cache_l[..usable].copy_from_slice(&cache.vocals.left[start..start + usable]);
                cache_r[..usable].copy_from_slice(&cache.vocals.right[start..start + usable]);
                let (voc_l, voc_r) =
                    run_mdx_chunk_cached(&engine, intent, &left, &right, &cache_l, &cache_r);
                accumulate(start, &voc_l, &voc_r);
                cached_chunks += 1;
                on_chunk(cached_chunks, starts.len());
            }
        }
        _ => pending.extend(0..starts.len()),
    }
    if pending.is_empty() {
        normalize_by_weights(&mut vocals, &weights);
        return Ok(vocals);
    }
    let model_chunks = pending.len();

    let queue = ChunkQueue {
        audio,
        starts: &starts,
        segment,
        mode,
        intent,
        cancel,
        pending: std::sync::Mutex::new(pending),
        results: std::sync::Mutex::new(Vec::with_capacity(model_chunks)),
        completed: std::sync::atomic::AtomicUsize::new(0),
    };

    let VocalSession {
        session: primary,
        helper,
        ..
    } = &mut *session;
    let mut primary_error: Option<anyhow::Error> = None;
    let helper_result = std::thread::scope(|scope| {
        let helper_thread = helper
            .as_mut()
            .map(|helper| scope.spawn(|| separate_chunks_worker(helper, &queue)));
        // The primary works on this thread and reports progress for both.
        if std::env::var_os("FETCHR_NO_PIPELINE").is_none() {
            let total = starts.len();
            let mut report = |completed: usize| on_chunk(cached_chunks + completed, total);
            if let Err(err) = separate_pipelined(primary, &queue, &mut report) {
                primary_error = Some(err);
            }
        } else {
            match WorkerContext::new(primary, mode) {
                Ok(context) => {
                    let mut last_reported = 0usize;
                    while let Some(chunk_index) = queue.next() {
                        if cancel.load(Ordering::SeqCst) {
                            queue.requeue(chunk_index);
                            primary_error = Some(anyhow!("Vocal Remover task cancelled"));
                            break;
                        }
                        match separate_one_chunk(primary, &context, &queue, chunk_index) {
                            Ok((voc_l, voc_r)) => queue.push(chunk_index, voc_l, voc_r),
                            Err(err) => {
                                queue.requeue(chunk_index);
                                primary_error = Some(err);
                                break;
                            }
                        }
                        let completed = queue.completed.load(std::sync::atomic::Ordering::SeqCst);
                        if completed != last_reported {
                            last_reported = completed;
                            on_chunk(cached_chunks + completed, starts.len());
                        }
                    }
                }
                Err(err) => primary_error = Some(err),
            }
        }
        match helper_thread {
            Some(thread) => thread
                .join()
                .unwrap_or_else(|_| Err(anyhow!("CPU helper panicked"))),
            None => Ok(()),
        }
    });

    if cancel.load(Ordering::SeqCst) {
        return Err(anyhow!("Vocal Remover task cancelled"));
    }
    if let Some(err) = primary_error {
        // Heavy models build fine on a small iGPU and then run out of its
        // memory on the first chunk. Remember that like a failed build, so the
        // next jobs skip the doomed GPU attempt (session build + one chunk).
        // Only out-of-memory is remembered: it repeats on every run, while a
        // device reset (driver update, a game, sleep) is transient and must not
        // push the model onto the CPU for weeks. The fast model does run on
        // DirectML, so it is never blocked from here.
        if session.accelerated
            && mode != VocalRemoverMode::FastHtdemucs
            && is_gpu_memory_error(&err)
        {
            let reason = super::gpu_blocklist::clean_ort_message(&err.to_string());
            super::gpu_blocklist::block(&app_data_root(), &session.model_path, &reason);
        }
        // A GPU EP can fail mid-inference (DirectML OOM / fused-node errors);
        // rebuild on CPU once and finish whatever is left instead of failing.
        if session.fall_back_to_cpu()? {
            // Heavy models do not fit the memory of a small integrated GPU, so
            // this is the normal path there rather than an exceptional one.
            tracing::warn!(
                "{} could not run on the GPU ({err}); the rest of this job runs on the CPU, which is far slower",
                mode_label(mode)
            );
        } else {
            return Err(err);
        }
    } else if let Err(err) = helper_result {
        tracing::warn!("CPU helper failed, primary finishes the queue: {err}");
    }
    if !queue.pending.lock().map(|p| p.is_empty()).unwrap_or(true) {
        separate_chunks_worker(&mut session.session, &queue)?;
    }

    let results = queue
        .results
        .into_inner()
        .map_err(|_| anyhow!("chunk results poisoned"))?;
    if results.len() != model_chunks {
        return Err(anyhow!(
            "separation produced {} of {} chunks",
            results.len(),
            model_chunks
        ));
    }
    for (chunk_index, voc_l, voc_r) in &results {
        accumulate(starts[*chunk_index], voc_l, voc_r);
    }
    on_chunk(starts.len(), starts.len());
    normalize_by_weights(&mut vocals, &weights);
    Ok(vocals)
}

/// Wiener-style gate over one bin: keeps it where the vocal estimate dominates
/// and pulls it toward silence where the music estimate does. `strength` of 0
/// is a no-op; larger values strip more residual music (and more vocal body).
/// Bins the vocal estimate does not clearly own are zeroed rather than merely
/// attenuated (see `HARD_MASK_MIN_VOCAL_SHARE`).
fn suppress_music(vocals: Complex<f32>, music: Complex<f32>, strength: f32) -> Complex<f32> {
    if strength <= 0.0 {
        return vocals;
    }
    let vocal_energy = vocals.norm_sqr();
    let music_energy = music.norm_sqr() * strength * strength;
    let total = vocal_energy + music_energy;
    if total <= 1e-12 {
        return vocals;
    }
    let vocal_share = vocal_energy / total;
    if vocal_share < HARD_MASK_MIN_VOCAL_SHARE {
        return Complex::new(0.0, 0.0);
    }
    vocals * vocal_share
}

fn gate_strength(intent: SeparationIntent) -> f32 {
    match intent {
        SeparationIntent::AntiCopyright => MUSIC_GATE_STRENGTH,
        SeparationIntent::Stems | SeparationIntent::Detect => 0.0,
    }
}

/// Fades near-silent stretches of the separated vocals to digital silence.
/// Where nothing intelligible is left, what remains is residual music at
/// -60…-75 dBFS: quiet, but still a level-invariant copy of the track.
fn mute_quiet_residual(audio: &mut StereoAudio) {
    let samples = audio.len();
    if samples == 0 {
        return;
    }
    let hops = samples.div_ceil(RESIDUAL_MUTE_HOP_SAMPLES);
    let mut raw_gain = Vec::with_capacity(hops);
    for hop in 0..hops {
        let center = hop * RESIDUAL_MUTE_HOP_SAMPLES + RESIDUAL_MUTE_HOP_SAMPLES / 2;
        let start = center.saturating_sub(RESIDUAL_MUTE_WINDOW_SAMPLES / 2);
        let end = (center + RESIDUAL_MUTE_WINDOW_SAMPLES / 2).min(samples);
        let mut energy = 0.0f64;
        for index in start..end {
            let mid = (audio.left[index] + audio.right[index]) * 0.5;
            energy += (mid * mid) as f64;
        }
        let rms = (energy / (end - start).max(1) as f64).sqrt() as f32;
        let level_db = 20.0 * (rms + 1e-9).log10();
        let gain = ((level_db - RESIDUAL_MUTE_CLOSE_DB)
            / (RESIDUAL_MUTE_OPEN_DB - RESIDUAL_MUTE_CLOSE_DB))
            .clamp(0.0, 1.0);
        raw_gain.push(gain);
    }

    // Moving-average smoothing keeps the gate from chattering on breaths and
    // reverb tails; the max with the raw gain makes it open instantly.
    let radius = RESIDUAL_MUTE_SMOOTH_HOPS / 2;
    let smoothed: Vec<f32> = (0..hops)
        .map(|hop| {
            let lo = hop.saturating_sub(radius);
            let hi = (hop + radius + 1).min(hops);
            let mean = raw_gain[lo..hi].iter().sum::<f32>() / (hi - lo) as f32;
            mean.max(raw_gain[hop])
        })
        .collect();

    for index in 0..samples {
        let position = index as f32 / RESIDUAL_MUTE_HOP_SAMPLES as f32 - 0.5;
        let lower = position.floor().max(0.0) as usize;
        let upper = (lower + 1).min(hops - 1);
        let frac = (position - lower as f32).clamp(0.0, 1.0);
        let gain = smoothed[lower.min(hops - 1)] * (1.0 - frac) + smoothed[upper] * frac;
        if gain < 1.0 {
            audio.left[index] *= gain;
            audio.right[index] *= gain;
        }
    }
}

/// Packs one chunk for `mode`. CPU-only, so the pipeline runs it on the
/// feeding thread while the model works on the previous chunk.
fn prepare_chunk(
    mode: VocalRemoverMode,
    engine: &StftEngine,
    left: &[f32],
    right: &[f32],
) -> PreparedChunk {
    match mode {
        VocalRemoverMode::FastHtdemucs => mdx_prepare(engine, left, right),
        VocalRemoverMode::StudioHtdemucsFt => wrf_prepare(engine, left, right),
        VocalRemoverMode::UltraMelband => mbr_prepare(engine, left, right),
    }
}

/// Runs the model on a packed chunk and returns its flat output as f32.
fn infer_chunk(
    session: &mut Session,
    mode: VocalRemoverMode,
    context: &WorkerContext,
    input: Vec<f32>,
) -> Result<Vec<f32>> {
    match mode {
        VocalRemoverMode::FastHtdemucs => {
            mdx_infer(session, &context.input_name, &context.output_name, input)
        }
        VocalRemoverMode::StudioHtdemucsFt => {
            wrf_infer(session, &context.input_name, &context.output_name, input)
        }
        VocalRemoverMode::UltraMelband => mbr_infer(session, context, input),
    }
}

/// Turns a flat model output back into two channels of separated audio.
fn finish_chunk(
    mode: VocalRemoverMode,
    engine: &StftEngine,
    intent: SeparationIntent,
    prepared: &PreparedChunk,
    flat: &[f32],
    len: usize,
) -> (Vec<f32>, Vec<f32>) {
    match mode {
        VocalRemoverMode::FastHtdemucs => mdx_finish(engine, intent, prepared, flat, len),
        VocalRemoverMode::StudioHtdemucsFt => wrf_finish(engine, intent, prepared, flat, len),
        VocalRemoverMode::UltraMelband => mbr_finish(engine, intent, prepared, flat, len),
    }
}

/// A chunk's mix spectrogram plus the flat tensor the model expects. The
/// packing differs per model but the spectrogram is always kept so the
/// post-processing can rebuild the stems from it.
struct PreparedChunk {
    spec_l: Vec<Vec<Complex<f32>>>,
    spec_r: Vec<Vec<Complex<f32>>>,
    t_frames: usize,
    input: Vec<f32>,
}

fn mdx_prepare(engine: &StftEngine, left: &[f32], right: &[f32]) -> PreparedChunk {
    let spec_l = engine.stft(left);
    let spec_r = engine.stft(right);
    let t_frames = MDX_DIM_T.min(spec_l.len());
    let mut input = vec![0.0f32; 4 * MDX_DIM_F * MDX_DIM_T];
    let plane = MDX_DIM_F * MDX_DIM_T;
    for t in 0..t_frames {
        for f in 0..MDX_DIM_F {
            let base = f * MDX_DIM_T + t;
            input[base] = spec_l[t][f].re;
            input[plane + base] = spec_l[t][f].im;
            input[2 * plane + base] = spec_r[t][f].re;
            input[3 * plane + base] = spec_r[t][f].im;
        }
    }
    PreparedChunk {
        spec_l,
        spec_r,
        t_frames,
        input,
    }
}

/// Runs the model on a packed chunk and returns its flat prediction.
fn mdx_infer(
    session: &mut Session,
    input_name: &str,
    output_name: &str,
    input: Vec<f32>,
) -> Result<Vec<f32>> {
    let tensor = ndarray::Array4::from_shape_vec((1, 4, MDX_DIM_F, MDX_DIM_T), input)?;
    let value = Value::from_array(tensor)?;
    let outputs = session.run(ort::inputs![input_name => &value])?;
    let flat = match outputs.get(output_name) {
        Some(value) => value.try_extract_tensor::<f32>()?.1.to_vec(),
        None => outputs
            .values()
            .next()
            .ok_or_else(|| anyhow!("MDX ONNX output '{output_name}' not found"))?
            .try_extract_tensor::<f32>()?
            .1
            .to_vec(),
    };
    let expected = 4 * MDX_DIM_F * MDX_DIM_T;
    if flat.len() < expected {
        return Err(anyhow!(
            "MDX output is too small: {} values, expected {expected}",
            flat.len()
        ));
    }
    Ok(flat)
}

fn mdx_finish(
    engine: &StftEngine,
    intent: SeparationIntent,
    prepared: &PreparedChunk,
    flat: &[f32],
    len: usize,
) -> (Vec<f32>, Vec<f32>) {
    let plane = MDX_DIM_F * MDX_DIM_T;
    let pred = |t: usize, f: usize| {
        let base = f * MDX_DIM_T + t;
        (
            Complex::new(flat[base], flat[plane + base]),
            Complex::new(flat[2 * plane + base], flat[3 * plane + base]),
        )
    };
    if gate_strength(intent) <= 0.0 {
        // Linear post-processing: whatever the inverse STFT cancels out of
        // the prediction cancels out of the result as well.
        return mdx_postprocess(
            engine,
            intent,
            &prepared.spec_l,
            &prepared.spec_r,
            prepared.t_frames,
            pred,
            len,
        );
    }
    // The model is trained on waveforms, so most of its raw spectrogram lives
    // in components that cancel out in the overlap-add (16-31 dB above its
    // audible part on real speech, most of it high up). The gate compares
    // magnitudes bin by bin and took that energy for music: it stripped the
    // voice's upper range and left smeared, echo-like artifacts. Only the
    // audible part of the prediction may reach the gate, so it goes to audio
    // and back first - what the cached path gets from the stored vocals.
    let frames = prepared.spec_l.len();
    let bins = MDX_N_FFT / 2 + 1;
    let mut raw_l = vec![vec![Complex::<f32>::new(0.0, 0.0); bins]; frames];
    let mut raw_r = raw_l.clone();
    for t in 0..prepared.t_frames {
        for f in 0..MDX_DIM_F {
            let (left, right) = pred(t, f);
            raw_l[t][f] = left;
            raw_r[t][f] = right;
        }
    }
    let audible_l = engine.stft(&engine.istft(&raw_l, len));
    let audible_r = engine.stft(&engine.istft(&raw_r, len));
    mdx_postprocess(
        engine,
        intent,
        &prepared.spec_l,
        &prepared.spec_r,
        prepared.t_frames,
        |t, f| (audible_l[t][f], audible_r[t][f]),
        len,
    )
}

/// Chunks through one session with the CPU stages (STFT/packing before,
/// mask/ISTFT after) on this thread and inference on a second one: while the
/// model works on chunk N, this thread finishes N-1 and prepares N+1. Worth
/// ~15% on an integrated GPU, and as much again for the heavy models, whose
/// ONNX session saturates around 8 threads and leaves the rest of the cores
/// free for the spectrogram work.
fn separate_pipelined(
    session: &mut Session,
    queue: &ChunkQueue,
    on_progress: &mut dyn FnMut(usize),
) -> Result<()> {
    let context = WorkerContext::new(session, queue.mode)?;
    let infer_context = WorkerContext::new(session, queue.mode)?;
    let mode = queue.mode;
    let (to_gpu, gpu_in) = std::sync::mpsc::sync_channel::<(usize, PreparedChunk)>(1);
    let (from_gpu, gpu_out) = std::sync::mpsc::sync_channel::<(usize, PreparedChunk, Result<Vec<f32>>)>(1);

    std::thread::scope(|scope| -> Result<()> {
        let gpu = scope.spawn(move || {
            while let Ok((chunk_index, prepared)) = gpu_in.recv() {
                let result =
                    infer_chunk(session, mode, &infer_context, prepared.input.clone());
                if from_gpu.send((chunk_index, prepared, result)).is_err() {
                    break;
                }
            }
        });

        let mut in_flight: std::collections::VecDeque<usize> = std::collections::VecDeque::new();
        let mut failure: Option<anyhow::Error> = None;
        // Post-processes one finished chunk; a failed one goes back to the
        // queue and is reported through `failure`.
        let mut finish = |chunk_index: usize,
                          prepared: PreparedChunk,
                          result: Result<Vec<f32>>|
         -> Option<anyhow::Error> {
            match result {
                Ok(flat) => {
                    let (voc_l, voc_r) = finish_chunk(
                        mode,
                        &context.engine,
                        queue.intent,
                        &prepared,
                        &flat,
                        queue.segment,
                    );
                    queue.push(chunk_index, voc_l, voc_r);
                    on_progress(queue.completed.load(std::sync::atomic::Ordering::SeqCst));
                    None
                }
                Err(err) => {
                    queue.requeue(chunk_index);
                    Some(err)
                }
            }
        };

        loop {
            if queue.cancel.load(Ordering::SeqCst) || failure.is_some() {
                break;
            }
            match queue.next() {
                Some(chunk_index) => {
                    let (left, right, _) = queue.chunk_input(chunk_index);
                    let prepared = prepare_chunk(mode, &context.engine, &left, &right);
                    if to_gpu.send((chunk_index, prepared)).is_err() {
                        queue.requeue(chunk_index);
                        failure = Some(anyhow!("inference thread stopped"));
                        break;
                    }
                    in_flight.push_back(chunk_index);
                    // Keep one chunk queued ahead of the GPU; finish the
                    // older one while it runs.
                    if in_flight.len() >= 2 {
                        match gpu_out.recv() {
                            Ok((index, prepared, result)) => {
                                in_flight.retain(|pending| *pending != index);
                                failure = finish(index, prepared, result);
                            }
                            Err(_) => {
                                failure = Some(anyhow!("inference thread stopped"));
                                break;
                            }
                        }
                    }
                }
                None => break,
            }
        }
        drop(to_gpu);
        while !in_flight.is_empty() {
            match gpu_out.recv() {
                Ok((index, prepared, result)) => {
                    in_flight.retain(|pending| *pending != index);
                    if failure.is_none() {
                        failure = finish(index, prepared, result);
                    } else {
                        queue.requeue(index);
                    }
                }
                Err(_) => break,
            }
        }
        // Whatever never came back goes to the queue for the fallback.
        for index in in_flight.drain(..) {
            queue.requeue(index);
        }
        if gpu.join().is_err() {
            failure.get_or_insert_with(|| anyhow!("inference thread panicked"));
        }
        if let Some(err) = failure {
            return Err(err);
        }
        if queue.cancel.load(Ordering::SeqCst) {
            return Err(anyhow!("Vocal Remover task cancelled"));
        }
        Ok(())
    })
}

/// The fast model's raw primary-stem prediction, recovered from cached
/// neutral vocals instead of a model run: with `V = X - c * P` (see
/// `run_mdx_chunk`), `P = (X - V) / c` bin by bin.
fn run_mdx_chunk_cached(
    engine: &StftEngine,
    intent: SeparationIntent,
    left: &[f32],
    right: &[f32],
    cached_left: &[f32],
    cached_right: &[f32],
) -> (Vec<f32>, Vec<f32>) {
    let spec_l = engine.stft(left);
    let spec_r = engine.stft(right);
    let cache_l = engine.stft(cached_left);
    let cache_r = engine.stft(cached_right);
    let t_frames = MDX_DIM_T.min(spec_l.len());
    let pred = |t: usize, f: usize| {
        if MDX_PRIMARY_IS_INSTRUMENTAL {
            (
                (spec_l[t][f] - cache_l[t][f]) / MDX_COMPENSATE,
                (spec_r[t][f] - cache_r[t][f]) / MDX_COMPENSATE,
            )
        } else {
            (cache_l[t][f] / MDX_COMPENSATE, cache_r[t][f] / MDX_COMPENSATE)
        }
    };
    mdx_postprocess(engine, intent, &spec_l, &spec_r, t_frames, pred, left.len())
}

/// Turns the mix spectrogram and the model's primary-stem prediction into
/// the vocals waveform for `intent` (compensation, over-subtraction, gate).
fn mdx_postprocess(
    engine: &StftEngine,
    intent: SeparationIntent,
    spec_l: &[Vec<Complex<f32>>],
    spec_r: &[Vec<Complex<f32>>],
    t_frames: usize,
    pred: impl Fn(usize, usize) -> (Complex<f32>, Complex<f32>),
    len: usize,
) -> (Vec<f32>, Vec<f32>) {
    let full_bins = MDX_N_FFT / 2 + 1;
    let empty = vec![Complex::<f32>::new(0.0, 0.0); full_bins];
    let mut out_l = vec![empty.clone(); spec_l.len()];
    let mut out_r = vec![empty; spec_r.len()];
    let over = match intent {
        SeparationIntent::AntiCopyright if MDX_PRIMARY_IS_INSTRUMENTAL => MUSIC_OVERSUBTRACT,
        _ => 1.0,
    };
    let compensate = MDX_COMPENSATE * over;
    let gate = gate_strength(intent);
    for t in 0..t_frames {
        for f in 0..MDX_DIM_F {
            let (raw_l, raw_r) = pred(t, f);
            let pred_l = raw_l * compensate;
            let pred_r = raw_r * compensate;
            let (voc_l, music_l, voc_r, music_r) = if MDX_PRIMARY_IS_INSTRUMENTAL {
                (
                    spec_l[t][f] - pred_l,
                    pred_l,
                    spec_r[t][f] - pred_r,
                    pred_r,
                )
            } else {
                (
                    pred_l,
                    spec_l[t][f] - pred_l,
                    pred_r,
                    spec_r[t][f] - pred_r,
                )
            };
            out_l[t][f] = suppress_music(voc_l, music_l, gate);
            out_r[t][f] = suppress_music(voc_r, music_r, gate);
        }
    }

    (engine.istft(&out_l, len), engine.istft(&out_r, len))
}

/// Chunk length and hop for one mode, in samples. The hop is what decides how
/// much audio is separated twice: the models with a fixed 8-11 s graph overlap
/// by an eighth, the fast model by a quarter.
fn mode_segment_params(mode: VocalRemoverMode) -> (usize, usize) {
    match mode {
        VocalRemoverMode::FastHtdemucs => (MDX_SEGMENT_SAMPLES, MDX_HOP_SAMPLES),
        VocalRemoverMode::StudioHtdemucsFt => (WRF_SEGMENT_SAMPLES, WRF_HOP_SAMPLES),
        VocalRemoverMode::UltraMelband => (MBR_SEGMENT_SAMPLES, MBR_HOP_SAMPLES),
    }
}

/// Extracts a mask tensor as f32, converting from fp16 when the model output
/// uses half precision. Generic over the value marker so both `&Value` and
/// `ValueRef` outputs are accepted.
fn extract_mask_f32<Type: ort::value::TensorValueTypeMarker + ?Sized>(
    value: &ort::value::Value<Type>,
    is_f16: bool,
) -> Result<Vec<f32>> {
    if is_f16 {
        Ok(value
            .try_extract_tensor::<half::f16>()?
            .1
            .iter()
            .map(|v| v.to_f32())
            .collect())
    } else {
        Ok(value.try_extract_tensor::<f32>()?.1.to_vec())
    }
}

fn wrf_prepare(engine: &StftEngine, left: &[f32], right: &[f32]) -> PreparedChunk {
    let spec_l = engine.stft(left);
    let spec_r = engine.stft(right);
    let t_frames = WRF_DIM_T.min(spec_l.len());
    let plane = WRF_FREQS * WRF_DIM_T * 2;
    let mut input = vec![0.0f32; 2 * plane];
    for t in 0..t_frames {
        for f in 0..WRF_FREQS {
            let base = (f * WRF_DIM_T + t) * 2;
            input[base] = spec_l[t][f].re;
            input[base + 1] = spec_l[t][f].im;
            input[plane + base] = spec_r[t][f].re;
            input[plane + base + 1] = spec_r[t][f].im;
        }
    }
    PreparedChunk {
        spec_l,
        spec_r,
        t_frames,
        input,
    }
}

fn wrf_infer(
    session: &mut Session,
    input_name: &str,
    output_name: &str,
    input: Vec<f32>,
) -> Result<Vec<f32>> {
    let expected = input.len();
    let tensor = ndarray::Array5::from_shape_vec((1, 2, WRF_FREQS, WRF_DIM_T, 2), input)?;
    let value = Value::from_array(tensor)?;
    let outputs = session.run(ort::inputs![input_name => &value])?;
    let stem = match outputs.get(output_name) {
        Some(value) => value.try_extract_tensor::<f32>()?.1.to_vec(),
        None => outputs
            .values()
            .next()
            .ok_or_else(|| anyhow!("Windowed RoFormer ONNX output '{output_name}' not found"))?
            .try_extract_tensor::<f32>()?
            .1
            .to_vec(),
    };
    if stem.len() < expected {
        return Err(anyhow!(
            "Windowed RoFormer output is too small: {} values, expected {expected}",
            stem.len()
        ));
    }
    Ok(stem)
}

fn wrf_finish(
    engine: &StftEngine,
    intent: SeparationIntent,
    prepared: &PreparedChunk,
    stem: &[f32],
    len: usize,
) -> (Vec<f32>, Vec<f32>) {
    let plane = WRF_FREQS * WRF_DIM_T * 2;
    let spec_l = &prepared.spec_l;
    let spec_r = &prepared.spec_r;
    let empty = vec![Complex::<f32>::new(0.0, 0.0); WRF_FREQS];
    let mut out_l = vec![empty.clone(); spec_l.len()];
    let mut out_r = vec![empty; spec_r.len()];
    let gate = gate_strength(intent);
    for f in 0..WRF_FREQS {
        for t in 0..prepared.t_frames {
            let base = (f * WRF_DIM_T + t) * 2;
            let voc_l = Complex::new(stem[base], stem[base + 1]);
            let voc_r = Complex::new(stem[plane + base], stem[plane + base + 1]);
            out_l[t][f] = suppress_music(voc_l, spec_l[t][f] - voc_l, gate);
            out_r[t][f] = suppress_music(voc_r, spec_r[t][f] - voc_r, gate);
        }
    }
    (engine.istft(&out_l, len), engine.istft(&out_r, len))
}

fn mbr_prepare(engine: &StftEngine, left: &[f32], right: &[f32]) -> PreparedChunk {
    let spec_l = engine.stft(left);
    let spec_r = engine.stft(right);
    let t_frames = MBR_DIM_T.min(spec_l.len());
    let width = MBR_FREQS * 2 * MBR_DIM_T * 2;
    let mut input = vec![0.0f32; width];
    for t in 0..t_frames {
        for f in 0..MBR_FREQS {
            let l = spec_l[t][f];
            let r = spec_r[t][f];
            let base_l = ((f * 2) * MBR_DIM_T + t) * 2;
            let base_r = ((f * 2 + 1) * MBR_DIM_T + t) * 2;
            input[base_l] = l.re;
            input[base_l + 1] = l.im;
            input[base_r] = r.re;
            input[base_r + 1] = r.im;
        }
    }
    PreparedChunk {
        spec_l,
        spec_r,
        t_frames,
        input,
    }
}

fn mbr_infer(session: &mut Session, context: &WorkerContext, input: Vec<f32>) -> Result<Vec<f32>> {
    let width = input.len();
    let input_name = context.input_name.as_str();
    let output_name = context.output_name.as_str();
    let outputs = if context.input_is_f16 {
        let input_f16: Vec<half::f16> = input.iter().map(|v| half::f16::from_f32(*v)).collect();
        let tensor = ndarray::Array4::from_shape_vec((1, MBR_FREQS * 2, MBR_DIM_T, 2), input_f16)?;
        let value = Value::from_array(tensor)?;
        session.run(ort::inputs![input_name => &value])?
    } else {
        let tensor = ndarray::Array4::from_shape_vec((1, MBR_FREQS * 2, MBR_DIM_T, 2), input)?;
        let value = Value::from_array(tensor)?;
        session.run(ort::inputs![input_name => &value])?
    };

    let mask: Vec<f32> = match outputs.get(output_name) {
        Some(value) => extract_mask_f32(value, context.output_is_f16)?,
        None => {
            let value = outputs
                .values()
                .next()
                .ok_or_else(|| anyhow!("Mel-Band RoFormer ONNX output '{output_name}' not found"))?;
            extract_mask_f32(&value, context.output_is_f16)?
        }
    };
    if mask.len() < width {
        return Err(anyhow!(
            "Mel-Band RoFormer mask is too small: {} values, expected {width}",
            mask.len()
        ));
    }
    Ok(mask)
}

fn mbr_finish(
    engine: &StftEngine,
    intent: SeparationIntent,
    prepared: &PreparedChunk,
    mask: &[f32],
    len: usize,
) -> (Vec<f32>, Vec<f32>) {
    let spec_l = &prepared.spec_l;
    let spec_r = &prepared.spec_r;
    let empty = vec![Complex::<f32>::new(0.0, 0.0); MBR_FREQS];
    let mut out_l = vec![empty.clone(); spec_l.len()];
    let mut out_r = vec![empty; spec_r.len()];
    let gate = gate_strength(intent);
    for f in 0..MBR_FREQS {
        for t in 0..prepared.t_frames {
            // mask layout: [(f s), t, c] with s = stereo channel
            let base_l = ((f * 2) * MBR_DIM_T + t) * 2;
            let base_r = ((f * 2 + 1) * MBR_DIM_T + t) * 2;
            let m_l = Complex::new(mask[base_l], mask[base_l + 1]);
            let m_r = Complex::new(mask[base_r], mask[base_r + 1]);
            let voc_l = spec_l[t][f] * m_l;
            let voc_r = spec_r[t][f] * m_r;
            out_l[t][f] = suppress_music(voc_l, spec_l[t][f] - voc_l, gate);
            out_r[t][f] = suppress_music(voc_r, spec_r[t][f] - voc_r, gate);
        }
    }
    (engine.istft(&out_l, len), engine.istft(&out_r, len))
}

fn output_paths_for_input(input_path: &Path) -> Result<OutputPaths> {
    let parent = input_path
        .parent()
        .ok_or_else(|| anyhow!("Input path has no parent directory"))?;
    let stem = input_path
        .file_stem()
        .and_then(|value| value.to_str())
        .ok_or_else(|| anyhow!("Input path has no file stem"))?;
    Ok(OutputPaths {
        vocals: parent.join(format!("{stem}_vocals.wav")),
        instrumental: parent.join(format!("{stem}_instrumental.wav")),
        anti_copyright: parent.join(format!("{stem}_anti_copyright.wav")),
    })
}

fn segment_to_samples(segment: &AudioSegment, total_samples: usize) -> Option<(usize, usize)> {
    let start = (segment.start_sec.max(0.0) * SAMPLE_RATE as f64).round() as usize;
    let end = (segment.end_sec.max(0.0) * SAMPLE_RATE as f64).round() as usize;
    let start = start.min(total_samples);
    let end = end.min(total_samples);
    if end > start {
        Some((start, end))
    } else {
        None
    }
}

/// Like `blend_replacement` at offset 0, but each edge fade can be switched
/// off — a block in the middle of a segment must not dip back into the
/// original (music-bearing) audio at its seams.
fn blend_replacement_with_fades(
    target: &mut StereoAudio,
    replacement: &StereoAudio,
    fade_in: bool,
    fade_out: bool,
) {
    let samples = replacement.len().min(target.len());
    if samples == 0 {
        return;
    }
    let fade = ANTI_COPYRIGHT_CROSSFADE_SAMPLES.min(samples / 2);
    for index in 0..samples {
        let mut weight = 1.0f32;
        if fade > 0 {
            if fade_in && index < fade {
                weight = index as f32 / fade as f32;
            } else if fade_out && samples - index < fade {
                weight = (samples - index) as f32 / fade as f32;
            }
        }
        target.left[index] = target.left[index] * (1.0 - weight) + replacement.left[index] * weight;
        target.right[index] =
            target.right[index] * (1.0 - weight) + replacement.right[index] * weight;
    }
}

fn blend_replacement(target: &mut StereoAudio, replacement: &StereoAudio, start_sample: usize) {
    if start_sample >= target.len() {
        return;
    }
    let samples = replacement.len().min(target.len() - start_sample);
    if samples == 0 {
        return;
    }
    let fade = ANTI_COPYRIGHT_CROSSFADE_SAMPLES.min(samples / 2);
    for index in 0..samples {
        let target_index = start_sample + index;
        let mut weight = 1.0f32;
        if fade > 0 {
            if index < fade {
                weight = index as f32 / fade as f32;
            } else {
                let tail = samples - index;
                if tail < fade {
                    weight = tail as f32 / fade as f32;
                }
            }
        }
        target.left[target_index] =
            target.left[target_index] * (1.0 - weight) + replacement.left[index] * weight;
        target.right[target_index] =
            target.right[target_index] * (1.0 - weight) + replacement.right[index] * weight;
    }
}

/// Путь к быстрой модели разделения, если она уже скачана. Перепроверка мата
/// сама ничего не качает: 66 МБ ради неё одной не оправданы.
pub(crate) fn fast_model_if_present() -> Option<PathBuf> {
    let path = model_dir_for_mode(VocalRemoverMode::FastHtdemucs)
        .join(model_files_for_mode(VocalRemoverMode::FastHtdemucs)[0].local_name);
    std::fs::metadata(&path)
        .map(|meta| meta.is_file() && meta.len() > 0)
        .unwrap_or(false)
        .then_some(path)
}

/// Голос из коротких клипов 44.1 кГц стерео, сведённый в моно 16 кГц. Нужен
/// перепроверке мата: под музыкой и звуком игры вторая модель слышит мусор,
/// а на чистом голосе — само слово. Одна сессия на все клипы.
pub(crate) fn isolate_vocals_16k(
    model_path: &Path,
    clips: &[(Vec<f32>, Vec<f32>)],
    cancel: &Arc<AtomicBool>,
) -> Result<Vec<Vec<f32>>> {
    let mut session = build_session(model_path, VocalRemoverMode::FastHtdemucs)?;
    clips
        .iter()
        .map(|(left, right)| {
            if cancel.load(Ordering::SeqCst) {
                return Err(anyhow!("FetchrMute task cancelled"));
            }
            let audio = StereoAudio {
                left: left.clone(),
                right: right.clone(),
            };
            let vocals = run_vocals_model(
                &mut session,
                VocalRemoverMode::FastHtdemucs,
                &audio,
                SeparationIntent::Detect,
                None,
                cancel,
                |_, _| {},
            )?;
            Ok(music_detect::resample_44100_to_16000(&downmix(&vocals)))
        })
        .collect()
}

pub(crate) fn model_dir_for_mode(mode: VocalRemoverMode) -> PathBuf {
    let root = app_data_root().join("models");
    match mode {
        VocalRemoverMode::FastHtdemucs => root.join("vocal-remover").join("kim-vocal-2"),
        VocalRemoverMode::StudioHtdemucsFt => root.join("vocal-remover").join("windowed-roformer"),
        VocalRemoverMode::UltraMelband => root.join("vocal-remover").join("melband-roformer"),
    }
}

/// Model directories from earlier releases, deleted the next time the mode
/// that used them is prepared so a swapped-out model stops taking up disk.
fn retired_model_dirs(mode: VocalRemoverMode) -> Vec<PathBuf> {
    let root = app_data_root().join("models").join("vocal-remover");
    match mode {
        // Studio ran BS-Roformer ep317 (166 MB) before Windowed RoFormer.
        VocalRemoverMode::StudioHtdemucsFt => vec![root.join("bs-roformer")],
        VocalRemoverMode::FastHtdemucs | VocalRemoverMode::UltraMelband => Vec::new(),
    }
}

fn model_files_for_mode(mode: VocalRemoverMode) -> &'static [ModelFile] {
    match mode {
        VocalRemoverMode::FastHtdemucs => FAST_MODEL_FILES,
        VocalRemoverMode::StudioHtdemucsFt => STUDIO_MODEL_FILES,
        VocalRemoverMode::UltraMelband => ULTRA_MODEL_FILES,
    }
}

fn chunk_starts(samples: usize, segment: usize, hop: usize) -> Vec<usize> {
    if samples <= segment {
        return vec![0];
    }

    let mut starts = Vec::new();
    let mut start = 0usize;
    loop {
        starts.push(start);
        if start + segment >= samples {
            break;
        }
        let next = (start + hop).min(samples.saturating_sub(segment));
        if next == start {
            break;
        }
        start = next;
    }
    starts
}

fn normalize_by_weights(audio: &mut StereoAudio, weights: &[f32]) {
    for index in 0..audio.len() {
        let weight = weights.get(index).copied().unwrap_or(0.0);
        if weight > 0.0 {
            audio.left[index] /= weight;
            audio.right[index] /= weight;
        }
    }
}

fn subtract_stems(mix: &StereoAudio, stem: &StereoAudio) -> StereoAudio {
    let samples = mix.len().min(stem.len());
    let mut out = StereoAudio::new(samples);
    for index in 0..samples {
        out.left[index] = mix.left[index] - stem.left[index];
        out.right[index] = mix.right[index] - stem.right[index];
    }
    out
}

fn float_to_i16(value: f32) -> i16 {
    (value.clamp(-1.0, 1.0) * i16::MAX as f32).round() as i16
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

use crate::util::format_bytes;

fn format_duration_ms(ms: u64) -> String {
    let seconds = ms / 1000;
    if seconds < 60 {
        format!("{seconds}s")
    } else {
        format!("{}m {}s", seconds / 60, seconds % 60)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn output_paths_are_written_next_to_input() {
        let paths = output_paths_for_input(Path::new(r"C:\media\clip.mp4")).unwrap();
        assert!(paths.vocals.ends_with("clip_vocals.wav"));
        assert!(paths.instrumental.ends_with("clip_instrumental.wav"));
        assert!(paths.anti_copyright.ends_with("clip_anti_copyright.wav"));
    }

    #[test]
    fn music_gate_keeps_vocal_bins_and_kills_music_bins() {
        let loud = Complex::new(1.0f32, 0.0);
        let quiet = Complex::new(0.01f32, 0.0);

        // Neutral strength is a pass-through, used by the stems workflow.
        assert_eq!(suppress_music(loud, loud, 0.0), loud);

        let vocal_bin = suppress_music(loud, quiet, MUSIC_GATE_STRENGTH);
        assert!(vocal_bin.norm() > 0.99 * loud.norm());

        let music_bin = suppress_music(quiet, loud, MUSIC_GATE_STRENGTH);
        assert!(music_bin.norm() < 0.01 * quiet.norm());

        assert_eq!(
            suppress_music(
                Complex::new(0.0, 0.0),
                Complex::new(0.0, 0.0),
                MUSIC_GATE_STRENGTH
            ),
            Complex::new(0.0, 0.0)
        );
    }

    #[test]
    fn registries_use_expected_models() {
        let fast_models = model_files_for_mode(VocalRemoverMode::FastHtdemucs);
        let studio_models = model_files_for_mode(VocalRemoverMode::StudioHtdemucsFt);
        let ultra_models = model_files_for_mode(VocalRemoverMode::UltraMelband);
        assert_eq!(fast_models.len(), 1);
        assert_eq!(studio_models.len(), 1);
        assert_eq!(ultra_models.len(), 2);
        assert!(fast_models[0].url.contains("Kim_Inst"));
        assert!(studio_models[0].url.contains("windowed-roformer"));
        // A single self-contained graph: no external weights to keep in sync.
        assert!(studio_models[0].local_name.ends_with(".onnx"));
        assert!(ultra_models[0].local_name.ends_with(".onnx"));
        // The Mel-Band graph references its external weights by exact filename.
        assert!(ultra_models[1]
            .local_name
            .starts_with(ultra_models[0].local_name));
        assert!(ultra_models[1].local_name.ends_with(".onnx.data"));
    }

    #[test]
    fn chunk_starts_cover_tail() {
        let samples = MDX_SEGMENT_SAMPLES + 10;
        let starts = chunk_starts(samples, MDX_SEGMENT_SAMPLES, MDX_HOP_SAMPLES);
        assert_eq!(starts.first().copied(), Some(0));
        assert_eq!(starts.last().copied(), Some(samples - MDX_SEGMENT_SAMPLES));
    }

    #[test]
    fn subtract_stems_returns_residual_and_output_clips_to_i16() {
        let mix = StereoAudio {
            left: vec![0.5, 0.25],
            right: vec![0.2, -0.4],
        };
        let vocals = StereoAudio {
            left: vec![0.7, -0.5],
            right: vec![0.9, -0.8],
        };
        let residual = subtract_stems(&mix, &vocals);
        let expected_left = [-0.2f32, 0.75];
        let expected_right = [-0.7f32, 0.4];
        for (got, want) in residual.left.iter().zip(expected_left.iter()) {
            assert!((got - want).abs() < 1e-6);
        }
        for (got, want) in residual.right.iter().zip(expected_right.iter()) {
            assert!((got - want).abs() < 1e-6);
        }
        assert_eq!(float_to_i16(2.0), i16::MAX);
        assert_eq!(float_to_i16(-2.0), -i16::MAX);
    }

    #[test]
    fn stft_istft_roundtrip_is_lossless_enough() {
        let engine = StftEngine::new(WRF_N_FFT, WRF_HOP);
        let len = WRF_HOP * 200;
        let signal: Vec<f32> = (0..len)
            .map(|i| {
                let t = i as f32 / SAMPLE_RATE as f32;
                (t * 220.0 * std::f32::consts::TAU).sin() * 0.5
                    + (t * 3001.0 * std::f32::consts::TAU).sin() * 0.25
            })
            .collect();
        let spec = engine.stft(&signal);
        assert_eq!(spec.len(), len / WRF_HOP + 1);
        assert_eq!(spec[0].len(), WRF_FREQS);
        let restored = engine.istft(&spec, len);
        let mut max_err = 0.0f32;
        for (a, b) in signal.iter().zip(restored.iter()) {
            max_err = max_err.max((a - b).abs());
        }
        assert!(max_err < 1e-3, "roundtrip error too large: {max_err}");
    }

    #[test]
    fn music_gate_zeroes_ambiguous_bins_instead_of_scaling_them() {
        // Equal vocal and music energy: a plain Wiener gate would keep half of
        // the bin, which is still a recognisable copy of the track.
        let shared = Complex::new(0.5f32, 0.5);
        assert_eq!(
            suppress_music(shared, shared, MUSIC_GATE_STRENGTH),
            Complex::new(0.0, 0.0)
        );
        // Vocals clearly dominating: kept with only a mild attenuation.
        let vocal = Complex::new(1.0f32, 0.0);
        let faint_music = Complex::new(0.3f32, 0.0);
        let kept = suppress_music(vocal, faint_music, MUSIC_GATE_STRENGTH);
        assert!(kept.norm() > 0.8 && kept.norm() < 1.0);
        // The stems workflow never gates.
        assert_eq!(suppress_music(shared, shared, 0.0), shared);
    }

    #[test]
    fn quiet_residual_is_muted_but_speech_level_audio_is_untouched() {
        let seconds = 3 * SAMPLE_RATE as usize;
        let mut audio = StereoAudio::new(seconds);
        for index in 0..seconds {
            let t = index as f32 / SAMPLE_RATE as f32;
            let tone = (t * 440.0 * std::f32::consts::TAU).sin();
            // Speech-level tone for the first second, then a -70 dBFS
            // residual, then speech level again.
            let amplitude = if (SAMPLE_RATE as usize..2 * SAMPLE_RATE as usize).contains(&index) {
                0.000_45
            } else {
                0.1
            };
            audio.left[index] = tone * amplitude;
            audio.right[index] = tone * amplitude;
        }
        let before = audio.clone();
        mute_quiet_residual(&mut audio);

        let rms = |samples: &[f32]| {
            (samples.iter().map(|v| v * v).sum::<f32>() / samples.len() as f32).sqrt()
        };
        let loud = SAMPLE_RATE as usize / 4..SAMPLE_RATE as usize * 3 / 4;
        let quiet = SAMPLE_RATE as usize * 5 / 4..SAMPLE_RATE as usize * 7 / 4;
        assert!((rms(&audio.left[loud.clone()]) - rms(&before.left[loud])).abs() < 1e-6);
        assert!(rms(&audio.left[quiet]) < 1e-7);
    }

    /// Real-file end-to-end run of detection → cleanup → independent
    /// residual check. Needs the cached models and ffmpeg; run by hand:
    ///
    /// `FETCHR_E2E_AUDIO=<media> FETCHR_E2E_FFMPEG=<ffmpeg.exe>
    ///  [FETCHR_E2E_MODES=fast,studio] [FETCHR_E2E_OUT=<dir>]
    ///  cargo test --lib e2e_detect_clean_and_verify -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn e2e_detect_clean_and_verify_real_file() {
        let Ok(input) = std::env::var("FETCHR_E2E_AUDIO") else {
            eprintln!("FETCHR_E2E_AUDIO not set, skipping");
            return;
        };
        let ffmpeg = PathBuf::from(
            std::env::var("FETCHR_E2E_FFMPEG").expect("FETCHR_E2E_FFMPEG must point to ffmpeg"),
        );
        let modes: Vec<VocalRemoverMode> = std::env::var("FETCHR_E2E_MODES")
            .unwrap_or_else(|_| "fast".to_string())
            .split(',')
            .filter_map(|name| match name.trim() {
                "fast" => Some(VocalRemoverMode::FastHtdemucs),
                "studio" => Some(VocalRemoverMode::StudioHtdemucsFt),
                "ultra" => Some(VocalRemoverMode::UltraMelband),
                _ => None,
            })
            .collect();
        let out_dir = std::env::var("FETCHR_E2E_OUT")
            .map(PathBuf::from)
            .unwrap_or_else(|_| std::env::temp_dir().join("fetchr-e2e-vocal-remover"));
        std::fs::create_dir_all(&out_dir).unwrap();
        let tmp_dir = out_dir.join("tmp");
        std::fs::create_dir_all(&tmp_dir).unwrap();

        let input = Path::new(&input);
        let wav44 = tmp_dir.join("source_44100_stereo.wav");
        let wav16 = tmp_dir.join("source_16000_mono_norm.wav");
        let runtime = tokio::runtime::Runtime::new().unwrap();
        runtime
            .block_on(extract_scan_audio(&ffmpeg, input, &wav44, Some(&wav16), None))
            .unwrap();

        let fast_model = detection_model_path();
        let yamnet = music_detect::yamnet_model_path();
        assert!(fast_model.is_file(), "fast model missing: {}", fast_model.display());
        assert!(yamnet.is_file(), "YAMNet missing: {}", yamnet.display());
        let models = DetectionModels {
            fast_model_path: &fast_model,
            yamnet_path: &yamnet,
        };
        let cancel = Arc::new(AtomicBool::new(false));
        let fmt = |sec: f64| format!("{}:{:04.1}", (sec / 60.0).floor() as u64, sec % 60.0);
        let _ = tracing_subscriber::fmt()
            .with_env_filter("fetchr=debug")
            .with_writer(std::io::stderr)
            .try_init();

        let started = Instant::now();
        let mut last = String::new();
        let cache_dir = tmp_dir.join("separation-cache");
        let mut cache = SeparationCache::create(&cache_dir, {
            WavStream::open(&wav44).unwrap().total_frames()
        })
        .unwrap();
        let regions = detect_music_regions_blocking(
            &models,
            &wav44,
            &wav16,
            &tmp_dir,
            None,
            Some(&mut cache),
            &cancel,
            &mut |percent, message| {
                if message != last {
                    eprintln!("[detect {percent:5.1}%] {message}");
                    last = message.to_string();
                }
            },
            None,
        )
        .unwrap();
        eprintln!("detection took {:?}", started.elapsed());
        for region in &regions {
            eprintln!(
                "  music {} – {} (confidence {:.2})",
                fmt(region.start_sec),
                fmt(region.end_sec),
                region.confidence
            );
        }
        let total_sec = WavStream::open(&wav44).unwrap().total_frames() as f64 / SAMPLE_RATE as f64;
        let segments: Vec<AudioSegment> = music_detect::pad_and_merge(regions, total_sec)
            .into_iter()
            .map(|region| AudioSegment {
                start_sec: region.start_sec,
                end_sec: region.end_sec,
            })
            .collect();
        for segment in &segments {
            eprintln!(
                "  padded segment {} – {}",
                fmt(segment.start_sec),
                fmt(segment.end_sec)
            );
        }
        assert!(!segments.is_empty(), "no music detected in the test file");

        let queue = Arc::new(QueueManager::new_mock(crate::app_log::AppLogger::new()));
        let mut failures = Vec::new();
        for mode in modes {
            let model_dir = model_dir_for_mode(mode);
            if !model_dir
                .join(model_files_for_mode(mode)[0].local_name)
                .is_file()
            {
                eprintln!("mode {mode:?}: model not cached, skipping");
                continue;
            }
            let output_paths = OutputPaths {
                vocals: tmp_dir.join("unused_vocals.wav"),
                instrumental: tmp_dir.join("unused_instrumental.wav"),
                anti_copyright: out_dir.join(format!("clean_{}.wav", mode_label(mode))),
            };
            let started = Instant::now();
            let stats = anti_copyright_wav_blocking(
                &queue,
                "e2e",
                &model_dir,
                &wav44,
                &output_paths,
                mode,
                segments.clone(),
                Some(&yamnet),
                SeparationCache::open(&cache_dir, WavStream::open(&wav44).unwrap().total_frames())
                    .unwrap(),
                cancel.clone(),
            )
            .unwrap();
            eprintln!(
                "mode {mode:?}: cleanup took {:?} ({stats:?}) -> {}",
                started.elapsed(),
                output_paths.anti_copyright.display()
            );

            // Independent check with the separator (not the cheap in-product
            // self-check): does it still hear music inside the processed
            // segments of the output?
            let mut classifier = StemClassifier::new(&models).unwrap();
            let mut fast_session =
                build_session(&fast_model, VocalRemoverMode::FastHtdemucs).unwrap();
            let mut stream = WavStream::open(&output_paths.anti_copyright).unwrap();
            let mut residual = Vec::new();
            for segment in &segments {
                let (start, end) = segment_to_samples(segment, stream.total_frames()).unwrap();
                stream.seek(start).unwrap();
                let slice = stream.read_frames(end - start).unwrap();
                let scored = classifier
                    .score_slice(&mut fast_session, &slice, segment.start_sec, &cancel, |_, _| {})
                    .unwrap();
                residual.extend(music_detect::regions_from_stem_frames(&scored.frames));
            }
            for region in &residual {
                eprintln!(
                    "  RESIDUAL music {} – {} (confidence {:.2})",
                    fmt(region.start_sec),
                    fmt(region.end_sec),
                    region.confidence
                );
            }
            if residual.is_empty() {
                eprintln!("mode {mode:?}: no residual music detected");
            } else {
                failures.push(format!("{mode:?}: {} residual region(s)", residual.len()));
            }
        }
        assert!(failures.is_empty(), "residual music after cleanup: {failures:?}");
    }

    /// Aggregate throughput of N plain-CPU sessions working at once: ORT
    /// saturates around 8 intra threads, so the remaining cores are only
    /// reachable through a second session.
    /// `FETCHR_BENCH_MODEL=... FETCHR_BENCH_PARALLEL=2 FETCHR_BENCH_THREADS=8
    ///  cargo test --release --lib bench_parallel_cpu -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn bench_parallel_cpu_sessions() {
        let model = PathBuf::from(
            std::env::var("FETCHR_BENCH_MODEL").expect("FETCHR_BENCH_MODEL is required"),
        );
        assert!(model.is_file(), "model missing: {}", model.display());
        let sessions = std::env::var("FETCHR_BENCH_PARALLEL")
            .ok()
            .and_then(|value| value.parse::<usize>().ok())
            .unwrap_or(2);
        let threads = std::env::var("FETCHR_BENCH_THREADS")
            .ok()
            .and_then(|value| value.parse::<usize>().ok())
            .unwrap_or(8);
        let chunk_sec = std::env::var("FETCHR_BENCH_CHUNK_SEC")
            .ok()
            .and_then(|value| value.parse::<f64>().ok())
            .unwrap_or(8.0);
        let passes = 2usize;
        let started = Instant::now();
        std::thread::scope(|scope| {
            for _ in 0..sessions {
                let model = model.clone();
                scope.spawn(move || {
                    let mut session = build_cpu_session(&model, threads).expect("cpu session");
                    let (name, dims) = {
                        let input = session.inputs().first().expect("input");
                        let dims = match input.dtype() {
                            ort::value::ValueType::Tensor { shape, .. } => shape
                                .iter()
                                .map(|dim| if *dim > 0 { *dim as usize } else { 1 })
                                .collect::<Vec<_>>(),
                            _ => panic!("input is not a tensor"),
                        };
                        (input.name().to_string(), dims)
                    };
                    let count: usize = dims.iter().product();
                    for _ in 0..passes {
                        let tensor = ndarray::ArrayD::from_shape_vec(
                            ndarray::IxDyn(&dims),
                            vec![0.0f32; count],
                        )
                        .expect("shape");
                        let value = Value::from_array(tensor).expect("value");
                        session
                            .run(ort::inputs![name.as_str() => &value])
                            .expect("run");
                    }
                });
            }
        });
        let elapsed = started.elapsed().as_secs_f64();
        let audio = (sessions * passes) as f64 * chunk_sec;
        eprintln!(
            "{sessions} sessions x {threads} threads: {:.1} s for {audio:.0} s of audio = {:.2}x realtime",
            elapsed,
            audio / elapsed
        );
    }

    /// Which execution provider can actually build a session for each model.
    /// `FETCHR_BENCH_MODE=studio cargo test --release --lib probe_providers -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn probe_providers() {
        let mode = match std::env::var("FETCHR_BENCH_MODE").ok().as_deref() {
            Some("studio") => VocalRemoverMode::StudioHtdemucsFt,
            Some("ultra") => VocalRemoverMode::UltraMelband,
            _ => VocalRemoverMode::FastHtdemucs,
        };
        let model = std::env::var("FETCHR_BENCH_MODEL")
            .map(PathBuf::from)
            .unwrap_or_else(|_| {
                model_dir_for_mode(mode).join(model_files_for_mode(mode)[0].local_name)
            });
        assert!(model.is_file(), "model missing: {}", model.display());
        eprintln!("model: {}", model.display());
        type ProviderFn = Box<dyn Fn() -> ort::ep::ExecutionProviderDispatch>;
        let mut providers: Vec<(String, ProviderFn, Vec<(String, String)>)> = vec![
            (
                "DirectML".to_string(),
                Box::new(|| ort::ep::DirectML::default().build()),
                Vec::new(),
            ),
            (
                "DirectML no-fusion".to_string(),
                Box::new(|| ort::ep::DirectML::default().build()),
                vec![("ep.dml.disable_graph_fusion".to_string(), "1".to_string())],
            ),
            (
                "OpenVINO".to_string(),
                Box::new(|| ort::ep::OpenVINO::default().build()),
                Vec::new(),
            ),
            (
                "OpenVINO GPU".to_string(),
                Box::new(|| ort::ep::OpenVINO::default().with_device_type("GPU").build()),
                Vec::new(),
            ),
            (
                "OpenVINO GPU fp16".to_string(),
                Box::new(|| {
                    ort::ep::OpenVINO::default()
                        .with_device_type("GPU")
                        .with_precision("FP16")
                        .build()
                }),
                Vec::new(),
            ),
            (
                "CPU".to_string(),
                Box::new(|| ort::ep::CPU::default().build()),
                Vec::new(),
            ),
        ];
        if let Ok(only) = std::env::var("FETCHR_BENCH_ONLY") {
            providers.retain(|(label, _, _)| label.contains(&only));
        }
        for (label, provider, config) in providers {
            let started = Instant::now();
            let built = (|| -> Result<Session> {
                let mut builder = Session::builder().map_err(|err| anyhow!("builder: {err}"))?;
                for (key, value) in &config {
                    builder = builder
                        .with_config_entry(key, value)
                        .map_err(|err| anyhow!("config {key}: {err}"))?;
                }
                let intra = std::env::var("FETCHR_BENCH_THREADS")
                    .ok()
                    .and_then(|value| value.parse::<usize>().ok())
                    .unwrap_or(4);
                Ok(builder
                    .with_intra_threads(intra)
                    .map_err(|err| anyhow!("intra threads: {err}"))?
                    .with_inter_threads(1)
                    .map_err(|err| anyhow!("inter threads: {err}"))?
                    .with_parallel_execution(false)
                    .map_err(|err| anyhow!("execution mode: {err}"))?
                    .with_memory_pattern(false)
                    .map_err(|err| anyhow!("memory pattern: {err}"))?
                    .with_execution_providers([provider()])
                    .map_err(|err| anyhow!("register provider: {err}"))?
                    .commit_from_file(&model)
                    .map_err(|err| anyhow!("commit: {err}"))?)
            })();
            let mut session = match built {
                Ok(session) => {
                    eprintln!("{label}: session OK in {:.1} s", started.elapsed().as_secs_f64());
                    session
                }
                Err(err) => {
                    eprintln!(
                        "{label}: session FAILED after {:.1} s: {err}",
                        started.elapsed().as_secs_f64()
                    );
                    continue;
                }
            };
            // Raw mode feeds zeros shaped like the graph's own input, so a
            // model the pipeline does not support yet can still be measured.
            if std::env::var_os("FETCHR_BENCH_RAW").is_some() {
                let (name, dims) = match session.inputs().first() {
                    Some(input) => {
                        let dims = match input.dtype() {
                            ort::value::ValueType::Tensor { shape, .. } => shape
                                .iter()
                                .map(|dim| if *dim > 0 { *dim as usize } else { 1 })
                                .collect::<Vec<_>>(),
                            _ => {
                                eprintln!("{label}: input is not a tensor");
                                continue;
                            }
                        };
                        (input.name().to_string(), dims)
                    }
                    None => {
                        eprintln!("{label}: no inputs");
                        continue;
                    }
                };
                let count: usize = dims.iter().product();
                let seconds = std::env::var("FETCHR_BENCH_CHUNK_SEC")
                    .ok()
                    .and_then(|value| value.parse::<f64>().ok())
                    .unwrap_or(8.0);
                eprintln!("{label}: input {name} {dims:?}");
                for pass in 0..2 {
                    let tensor = match ndarray::ArrayD::from_shape_vec(
                        ndarray::IxDyn(&dims),
                        vec![0.0f32; count],
                    ) {
                        Ok(tensor) => tensor,
                        Err(err) => {
                            eprintln!("{label}: shape: {err}");
                            break;
                        }
                    };
                    let value = match Value::from_array(tensor) {
                        Ok(value) => value,
                        Err(err) => {
                            eprintln!("{label}: value: {err}");
                            break;
                        }
                    };
                    let started = Instant::now();
                    match session.run(ort::inputs![name.as_str() => &value]) {
                        Ok(_) => eprintln!(
                            "{label}: chunk {pass} in {:.1} s ({:.2}x realtime)",
                            started.elapsed().as_secs_f64(),
                            seconds / started.elapsed().as_secs_f64()
                        ),
                        Err(err) => {
                            eprintln!("{label}: chunk {pass} FAILED: {err}");
                            break;
                        }
                    }
                }
                continue;
            }

            // One real chunk: a provider can build a session and still fail
            // at Run time (DirectML out of device memory, fused-node errors).
            let segment = mode_segment_params(mode).0;
            let chunk = StereoAudio::new(segment);
            let context = match WorkerContext::new(&session, mode) {
                Ok(context) => context,
                Err(err) => {
                    eprintln!("{label}: io names failed: {err}");
                    continue;
                }
            };
            for pass in 0..2 {
                let started = Instant::now();
                let prepared = prepare_chunk(mode, &context.engine, &chunk.left, &chunk.right);
                match infer_chunk(&mut session, mode, &context, prepared.input.clone()).map(|flat| {
                    finish_chunk(
                        mode,
                        &context.engine,
                        SeparationIntent::Detect,
                        &prepared,
                        &flat,
                        chunk.left.len(),
                    )
                }) {
                    Ok(_) => eprintln!(
                        "{label}: chunk {pass} in {:.1} s ({:.2}x realtime)",
                        started.elapsed().as_secs_f64(),
                        segment as f64 / SAMPLE_RATE as f64 / started.elapsed().as_secs_f64()
                    ),
                    Err(err) => {
                        eprintln!("{label}: chunk {pass} FAILED: {err}");
                        break;
                    }
                }
            }
        }
    }

    /// Throughput of one mode per execution-provider setup, over synthetic
    /// audio. Run by hand:
    /// `FETCHR_BENCH_MODE=studio cargo test --release --lib bench_separator -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn bench_separator_configs() {
        let mode = match std::env::var("FETCHR_BENCH_MODE").ok().as_deref() {
            Some("studio") => VocalRemoverMode::StudioHtdemucsFt,
            Some("ultra") => VocalRemoverMode::UltraMelband,
            _ => VocalRemoverMode::FastHtdemucs,
        };
        let model = std::env::var("FETCHR_BENCH_MODEL")
            .map(PathBuf::from)
            .unwrap_or_else(|_| {
                model_dir_for_mode(mode).join(model_files_for_mode(mode)[0].local_name)
            });
        assert!(model.is_file(), "model missing: {}", model.display());
        let seconds = std::env::var("FETCHR_BENCH_SECONDS")
            .ok()
            .and_then(|value| value.parse::<usize>().ok())
            .unwrap_or(match mode {
                VocalRemoverMode::FastHtdemucs => 60,
                _ => 30,
            });
        let mut audio = StereoAudio::new(SAMPLE_RATE as usize * seconds);
        let mut seed = 0x1234_5678u32;
        for index in 0..audio.len() {
            seed = seed.wrapping_mul(1_103_515_245).wrapping_add(12_345);
            let noise = ((seed >> 8) as f32 / (1u32 << 24) as f32 - 0.5) * 0.05;
            let t = index as f32 / SAMPLE_RATE as f32;
            let tone = (t * 220.0 * std::f32::consts::TAU).sin() * 0.1
                + (t * 3_000.0 * std::f32::consts::TAU).sin() * 0.03;
            audio.left[index] = tone + noise;
            audio.right[index] = tone * 0.8 + noise;
        }
        let cancel = Arc::new(AtomicBool::new(false));
        let threads = std::thread::available_parallelism()
            .map(|v| v.get())
            .unwrap_or(8);
        let configs: Vec<(String, Box<dyn Fn() -> Result<VocalSession>>)> = vec![
            ("gpu + cpu helper".to_string(), Box::new({
                let model = model.clone();
                move || build_fast_session(&model)
            })),
            ("default (accelerated first)".to_string(), Box::new({
                let model = model.clone();
                move || build_session(&model, mode)
            })),
            (format!("cpu {} threads", threads.saturating_sub(1).clamp(1, 8)), Box::new({
                let model = model.clone();
                move || {
                    Ok(VocalSession {
                        session: build_cpu_session(&model, threads.saturating_sub(1).clamp(1, 8))?,
                        helper: None,
                        model_path: model.clone(),
                        threads: 8,
                        accelerated: false,
                    })
                }
            })),
            (format!("cpu {} threads", threads), Box::new({
                let model = model.clone();
                move || {
                    Ok(VocalSession {
                        session: build_cpu_session(&model, threads)?,
                        helper: None,
                        model_path: model.clone(),
                        threads,
                        accelerated: false,
                    })
                }
            })),
        ];
        let configs: Vec<(String, Box<dyn Fn() -> Result<VocalSession>>)> =
            match std::env::var("FETCHR_BENCH_ONLY").ok().as_deref() {
                Some(only) => configs
                    .into_iter()
                    .filter(|(label, _)| label.contains(only))
                    .collect(),
                None => configs,
            };
        for (label, build) in configs {
            let mut session = match build() {
                Ok(session) => session,
                Err(err) => {
                    eprintln!("{label}: session failed: {err}");
                    continue;
                }
            };
            // Warm-up chunk, then the timed run.
            let warm = slice_audio(&audio, 0, mode_segment_params(mode).0);
            let _ = run_vocals_model(
                &mut session,
                mode,
                &warm,
                SeparationIntent::Detect,
                None,
                &cancel,
                |_, _| {},
            )
            .unwrap();
            let started = Instant::now();
            let _ = run_vocals_model(
                &mut session,
                mode,
                &audio,
                SeparationIntent::Detect,
                None,
                &cancel,
                |_, _| {},
            )
            .unwrap();
            let elapsed = started.elapsed().as_secs_f64();
            eprintln!(
                "{label}: accelerated={} {:.1} s for {seconds} s of audio = {:.1}x realtime",
                session.accelerated,
                elapsed,
                seconds as f64 / elapsed
            );
        }
    }

    /// Raw model throughput per batch size (inference only, no STFT).
    /// `cargo test --release --lib bench_batch -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn bench_batch_sizes() {
        let model = detection_model_path();
        let mut session = build_session(&model, VocalRemoverMode::FastHtdemucs).unwrap();
        let (input_name, _) = session_io_names(&session.session).unwrap();
        let plane = MDX_DIM_F * MDX_DIM_T;
        for batch in [1usize, 2, 4] {
            let mut input = vec![0.0f32; batch * 4 * plane];
            for (index, value) in input.iter_mut().enumerate() {
                *value = ((index % 97) as f32 / 97.0 - 0.5) * 0.01;
            }
            let tensor =
                ndarray::Array4::from_shape_vec((batch, 4, MDX_DIM_F, MDX_DIM_T), input).unwrap();
            let value = Value::from_array(tensor).unwrap();
            // Warm-up, then time.
            let _ = session
                .session
                .run(ort::inputs![input_name.as_str() => &value])
                .unwrap();
            let runs = 6usize;
            let started = Instant::now();
            for _ in 0..runs {
                let _ = session
                    .session
                    .run(ort::inputs![input_name.as_str() => &value])
                    .unwrap();
            }
            let per_chunk = started.elapsed().as_secs_f64() / (runs * batch) as f64;
            eprintln!(
                "batch {batch}: {:.0} ms per chunk = {:.1}x realtime",
                per_chunk * 1000.0,
                MDX_SEGMENT_SAMPLES as f64 / SAMPLE_RATE as f64 / per_chunk
            );
        }
    }

    /// Kim Inst is trained on waveforms, so much of its raw spectrogram output
    /// sits in components that cancel out in the inverse STFT (16-31 dB more
    /// than its audible part on real speech, rising with frequency). Those
    /// must not steer the anti-copyright gate: fed the same audible
    /// prediction, the cleaned voice has to come out the same with or without
    /// them. It used to lose ~20 dB above 8 kHz and pick up smeared,
    /// echo-like artifacts.
    #[test]
    fn anti_copyright_gate_ignores_prediction_energy_that_cancels_in_the_istft() {
        use std::f32::consts::TAU;
        let engine = StftEngine::new(MDX_N_FFT, MDX_HOP);
        let len = MDX_SEGMENT_SAMPLES;
        let mut voice = vec![0.0f32; len];
        let mut music = vec![0.0f32; len];
        for index in 0..len {
            let t = index as f32 / SAMPLE_RATE as f32;
            let syllables = 0.5 + 0.5 * (t * 4.0 * TAU).sin();
            let harmonics: f32 = (1..=60)
                .map(|h| (t * 180.0 * h as f32 * TAU).sin() / h as f32)
                .sum();
            voice[index] = 0.05 * syllables * harmonics;
            music[index] = 0.004 * ((t * 440.0 * TAU).sin() + (t * 659.0 * TAU).sin());
        }
        let mix: Vec<f32> = voice.iter().zip(&music).map(|(v, m)| v + m).collect();
        let prepared = prepare_chunk(VocalRemoverMode::FastHtdemucs, &engine, &mix, &mix);

        let plane = MDX_DIM_F * MDX_DIM_T;
        let pack = |flat: &mut [f32], spec: &[Vec<Complex<f32>>]| {
            for t in 0..prepared.t_frames {
                for f in 0..MDX_DIM_F {
                    let base = f * MDX_DIM_T + t;
                    let value = spec[t][f] / MDX_COMPENSATE;
                    for channel in 0..2 {
                        flat[(2 * channel) * plane + base] += value.re;
                        flat[(2 * channel + 1) * plane + base] += value.im;
                    }
                }
            }
        };
        let mut audible = vec![0.0f32; 4 * plane];
        pack(&mut audible, &engine.stft(&music));

        // Random spectrogram minus its consistent part: large in every bin,
        // yet (almost) nothing of it survives the overlap-add.
        let frames = prepared.spec_l.len();
        let bins = MDX_N_FFT / 2 + 1;
        let mut seed = 0x2545_f491u32;
        let mut noise = vec![vec![Complex::<f32>::new(0.0, 0.0); bins]; frames];
        for frame in noise.iter_mut().take(prepared.t_frames) {
            for bin in frame.iter_mut().take(MDX_DIM_F) {
                let mut next = || {
                    seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                    (seed >> 8) as f32 / (1u32 << 24) as f32 - 0.5
                };
                *bin = Complex::new(next(), next()) * 40.0;
            }
        }
        let consistent = engine.stft(&engine.istft(&noise, len));
        let null: Vec<Vec<Complex<f32>>> = noise
            .iter()
            .zip(&consistent)
            .map(|(row, kept)| {
                row.iter()
                    .zip(kept)
                    .enumerate()
                    .map(|(f, (n, c))| if f < MDX_DIM_F { n - c } else { Complex::new(0.0, 0.0) })
                    .collect()
            })
            .collect();
        let null_energy: f64 = null.iter().flatten().map(|v| v.norm_sqr() as f64).sum();
        let mix_energy: f64 = prepared.spec_l.iter().flatten().map(|v| v.norm_sqr() as f64).sum();
        assert!(null_energy > mix_energy * 10.0, "the inaudible part must dwarf the mix");
        let mut raw = audible.clone();
        pack(&mut raw, &null);

        let (clean, _) = mdx_finish(&engine, SeparationIntent::AntiCopyright, &prepared, &audible, len);
        let (noisy, _) = mdx_finish(&engine, SeparationIntent::AntiCopyright, &prepared, &raw, len);
        let edge = MDX_N_FFT;
        let signal: f64 = clean[edge..len - edge].iter().map(|v| (*v as f64).powi(2)).sum();
        let error: f64 = clean[edge..len - edge]
            .iter()
            .zip(&noisy[edge..len - edge])
            .map(|(a, b)| ((a - b) as f64).powi(2))
            .sum();
        let error_db = 10.0 * (error / signal).log10();
        assert!(error_db < -25.0, "inaudible prediction energy changed the voice: {error_db:.1} dB");
    }

    #[test]
    fn blend_replacement_preserves_edges_and_replaces_center() {
        let mut target = StereoAudio::new(ANTI_COPYRIGHT_CROSSFADE_SAMPLES * 4);
        let mut replacement = StereoAudio::new(target.len());
        for index in 0..target.len() {
            target.left[index] = 1.0;
            target.right[index] = 1.0;
            replacement.left[index] = 0.0;
            replacement.right[index] = 0.0;
        }

        blend_replacement(&mut target, &replacement, 0);
        assert!(target.left[0] > 0.9);
        assert!(target.left[target.len() / 2] < 0.10);
        assert!(target.left[target.len() - 1] > 0.90);
    }
}
