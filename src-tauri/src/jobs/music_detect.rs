//! Music-presence detection shared by the copyright scanner and the automatic
//! anti-copyright workflow.
//!
//! Two stages, both built on YAMNet (AudioSet classifier, 0.96 s windows):
//!
//! 1. A cheap coarse pass over the mix. YAMNet is nearly blind to quiet
//!    background music while someone talks over it (the `Music` score sits at
//!    0.00–0.10 under speech), so this pass only *seeds* neighbourhoods with a
//!    very low threshold instead of deciding anything.
//! 2. A precise pass over the *instrumental stem* produced by the vocal
//!    separation model inside those neighbourhoods. With the voice removed,
//!    YAMNet scores the remaining music at 0.5–1.0 even when it sits 25 dB
//!    below the speech, which is what Content ID matches on.
//!
//! The pure range arithmetic lives here so it can be unit-tested without
//! models or audio files.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use anyhow::{anyhow, Context, Result};
use ort::session::Session;

pub const YAMNET_SAMPLE_RATE: u32 = 16_000;
/// YAMNet patch length: 0.96 s at 16 kHz.
pub const YAMNET_WINDOW_SAMPLES: usize = 15_360;
pub const YAMNET_WINDOW_SEC: f64 = YAMNET_WINDOW_SAMPLES as f64 / YAMNET_SAMPLE_RATE as f64;
/// The exported graph frames a long waveform itself, one patch every 0.48 s;
/// feeding it seconds of audio per call is ~10x cheaper than one window per
/// call and gives twice the time resolution.
const YAMNET_PATCH_HOP_SAMPLES: usize = 7_680;
/// Feed length for level-normalised scoring (separated stems, cleaned
/// audio): short enough that one normalisation gain fits the whole feed.
const YAMNET_FEED_NORMALIZED_SAMPLES: usize = YAMNET_SAMPLE_RATE as usize * 48 / 10; // 4.8 s
/// Feed length for the plain mix (already level-flattened by ffmpeg); a
/// whole number of patch hops so consecutive feeds tile exactly.
const YAMNET_FEED_PLAIN_SAMPLES: usize = YAMNET_PATCH_HOP_SAMPLES * 64; // 30.72 s

// AudioSet class indices (yamnet_class_map.csv).
const CLASS_MUSIC: usize = 132;
const CLASS_BACKGROUND_MUSIC: usize = 262;
const CLASS_COUNT: usize = 521;

/// Coarse pass: a window with at least this much `Music` evidence in the mix
/// seeds a neighbourhood for the stem pass. Deliberately tiny: under speech
/// real music only flickers to 0.05–0.15 every few seconds.
pub const SEED_MIN_MUSIC: f32 = 0.05;
/// How far a neighbourhood extends around each seed window. Small on
/// purpose: a region that reaches the edge of its neighbourhood makes the
/// detector grow it (see `NEIGHBOURHOOD_GROW_SEC`), so the radius only has
/// to cover the gap between a track's first audible seed and its start.
pub const SEED_RADIUS_SEC: f64 = 12.0;
/// Step by which a neighbourhood grows when a detected region touches its
/// edge, and how close to the edge counts as touching.
pub const NEIGHBOURHOOD_GROW_SEC: f64 = 30.0;
pub const NEIGHBOURHOOD_EDGE_SEC: f64 = 1.5;
/// Stem pass: a window of the separated instrumental counts as music when it
/// is classified as music at this confidence...
pub const STEM_MIN_MUSIC: f32 = 0.25;
/// ...and is actually audible. Music streamers keep in the background sits
/// at -45…-58 dBFS in the stem, fade-ins and outros a few dB lower; leakage
/// of loud speech lands at -57…-70 dBFS but is classified as speech, not
/// music, so this level guard only has to reject the noise floor.
pub const STEM_MIN_LEVEL_DB: f32 = -64.0;
/// Gaps up to this long between stem music windows are bridged (drops, breaks,
/// windows where the classifier hesitates).
pub const STEM_BRIDGE_GAP_SEC: f64 = 6.0;
/// Regions shorter than this after bridging are ignored.
pub const STEM_MIN_REGION_SEC: f64 = 2.0;
/// Safety margin added to both ends of every detected region. Content ID
/// matched a track from ~9 s before the separator could hear it (a quiet
/// fade-in), and processing a few seconds of plain speech through the
/// separator is harmless.
pub const SAFETY_PAD_SEC: f64 = 10.0;
/// A seed window must fall within this distance of a stem region for the
/// region to be kept; it rejects stem-classifier hallucinations far from any
/// evidence in the mix.
pub const SEED_MATCH_TOLERANCE_SEC: f64 = 5.0;

const YAMNET_URL: &str =
    "https://huggingface.co/zeropointnine/yamnet-onnx/resolve/main/yamnet.onnx";
const YAMNET_SIZE: u64 = 16_093_603;
const YAMNET_SHA256: &str = "1510041dce24a2e9e84ec546807ac408ae496da6d1ed41bc3ccba649623f8e19";

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct MusicFrame {
    pub start_sec: f64,
    pub end_sec: f64,
    /// max(Music, Background music)
    pub music: f32,
    /// RMS level of the window before any normalisation, dBFS.
    pub level_db: f32,
}

#[derive(Debug, Clone, PartialEq)]
pub struct DetectedMusic {
    pub start_sec: f64,
    pub end_sec: f64,
    /// Highest stem music score inside the region.
    pub confidence: f32,
}

pub fn yamnet_model_path() -> PathBuf {
    let base = dirs::data_local_dir()
        .or_else(|| std::env::var("LOCALAPPDATA").map(PathBuf::from).ok())
        .unwrap_or_else(std::env::temp_dir);
    base.join("Fetchr")
        .join("models")
        .join("copyright")
        .join("yamnet.onnx")
}

/// Downloads YAMNet on first use. Progress is reported as 0–100 of the
/// download itself; the caller maps it into its own stage.
pub async fn ensure_yamnet_model(
    model_path: &Path,
    cancel: Arc<AtomicBool>,
    on_progress: &mut (dyn FnMut(f32, &str) + Send),
) -> Result<()> {
    if model_path.is_file() {
        return Ok(());
    }
    let mut report = |downloaded: u64, total: u64| {
        let message = format!(
            "Скачивание YAMNet: {} / {}",
            crate::util::format_bytes(downloaded),
            crate::util::format_bytes(total)
        );
        on_progress(downloaded as f32 / total.max(1) as f32 * 100.0, &message);
    };
    crate::jobs::model_download::download(
        crate::jobs::model_download::DownloadRequest {
            urls: crate::jobs::model_download::with_mirror(YAMNET_URL),
            target: model_path,
            size: YAMNET_SIZE,
            sha256: YAMNET_SHA256,
            label: "YAMNet",
        },
        &cancel,
        &mut report,
    )
    .await?;
    Ok(())
}

type WavFileReader = hound::WavReader<std::io::BufReader<std::fs::File>>;

fn open_wav_mono16(path: &Path) -> Result<WavFileReader> {
    let reader = hound::WavReader::open(path)
        .with_context(|| format!("open 16 kHz WAV {}", path.display()))?;
    let spec = reader.spec();
    if spec.sample_rate != YAMNET_SAMPLE_RATE || spec.channels != 1 {
        return Err(anyhow!(
            "Expected 16 kHz mono WAV, got {} Hz / {} channel(s)",
            spec.sample_rate,
            spec.channels
        ));
    }
    Ok(reader)
}

/// Appends up to `count` samples from the reader's current position as
/// normalised f32.
fn read_samples_f32(
    reader: &mut WavFileReader,
    spec: &hound::WavSpec,
    count: usize,
    out: &mut Vec<f32>,
) -> Result<()> {
    match spec.sample_format {
        hound::SampleFormat::Float => {
            for sample in reader.samples::<f32>().take(count) {
                out.push(sample.context("read float WAV")?);
            }
        }
        hound::SampleFormat::Int if spec.bits_per_sample <= 16 => {
            for sample in reader.samples::<i16>().take(count) {
                out.push(sample.context("read int16 WAV")? as f32 / i16::MAX as f32);
            }
        }
        hound::SampleFormat::Int => {
            let scale = (1i64 << (spec.bits_per_sample.saturating_sub(1) as u32)) as f32;
            for sample in reader.samples::<i32>().take(count) {
                out.push(sample.context("read int32 WAV")? as f32 / scale);
            }
        }
    }
    Ok(())
}

/// Reads a whole 16 kHz mono WAV (as produced by ffmpeg with `-ac 1 -ar
/// 16000`) into normalised f32 samples. Only for short files such as the
/// resampled stem of one block; the coarse pass streams instead.
pub fn read_wav_mono16(path: &Path) -> Result<Vec<f32>> {
    let mut reader = open_wav_mono16(path)?;
    let spec = reader.spec();
    let total = reader.duration() as usize;
    let mut out = Vec::with_capacity(total);
    read_samples_f32(&mut reader, &spec, total, &mut out)?;
    Ok(out)
}

/// Duration of a 16 kHz mono WAV in seconds.
pub fn wav_mono16_duration_sec(path: &Path) -> Result<f64> {
    let reader = open_wav_mono16(path)?;
    Ok(reader.duration() as f64 / YAMNET_SAMPLE_RATE as f64)
}

/// Reads `len_sec` seconds starting at `start_sec` from a 16 kHz mono
/// 16-bit WAV via seek, so probing a long file never loads it whole.
pub fn read_wav_mono16_window(path: &Path, start_sec: f64, len_sec: f64) -> Result<Vec<i16>> {
    let mut reader = open_wav_mono16(path)?;
    let spec = reader.spec();
    if spec.sample_format != hound::SampleFormat::Int || spec.bits_per_sample != 16 {
        return Err(anyhow!("Expected 16-bit PCM WAV at {}", path.display()));
    }
    let total = reader.duration() as usize;
    let start = ((start_sec.max(0.0) * YAMNET_SAMPLE_RATE as f64) as usize).min(total);
    let count = ((len_sec.max(0.0) * YAMNET_SAMPLE_RATE as f64) as usize).min(total - start);
    reader
        .seek(u32::try_from(start).map_err(|_| anyhow!("WAV position {start} out of range"))?)
        .with_context(|| format!("seek {} to sample {start}", path.display()))?;
    reader
        .samples::<i16>()
        .take(count)
        .collect::<Result<Vec<_>, _>>()
        .context("read int16 WAV window")
}

/// 16 kHz mono 16-bit WAV of a fixed length, pre-filled with silence and
/// written at arbitrary offsets. The detector stores the instrumental stem of
/// every analysed block here so Shazam can probe the music without the voice
/// on top of it.
pub struct StemTimeline {
    file: std::fs::File,
    total_samples: u64,
}

impl StemTimeline {
    const HEADER_BYTES: u64 = 44;

    pub fn create(path: &Path, total_sec: f64) -> Result<Self> {
        use std::io::Write;
        let total_samples = (total_sec.max(0.0) * YAMNET_SAMPLE_RATE as f64).ceil() as u64;
        let data_bytes = total_samples * 2;
        if Self::HEADER_BYTES + data_bytes > u32::MAX as u64 {
            return Err(anyhow!("stem timeline would exceed the 4 GiB WAV limit"));
        }
        let mut file = std::fs::File::create(path)
            .with_context(|| format!("create stem timeline {}", path.display()))?;
        let mut header = Vec::with_capacity(Self::HEADER_BYTES as usize);
        header.extend_from_slice(b"RIFF");
        header.extend_from_slice(&((36 + data_bytes) as u32).to_le_bytes());
        header.extend_from_slice(b"WAVE");
        header.extend_from_slice(b"fmt ");
        header.extend_from_slice(&16u32.to_le_bytes());
        header.extend_from_slice(&1u16.to_le_bytes()); // PCM
        header.extend_from_slice(&1u16.to_le_bytes()); // mono
        header.extend_from_slice(&YAMNET_SAMPLE_RATE.to_le_bytes());
        header.extend_from_slice(&(YAMNET_SAMPLE_RATE * 2).to_le_bytes());
        header.extend_from_slice(&2u16.to_le_bytes());
        header.extend_from_slice(&16u16.to_le_bytes());
        header.extend_from_slice(b"data");
        header.extend_from_slice(&(data_bytes as u32).to_le_bytes());
        file.write_all(&header)?;
        file.set_len(Self::HEADER_BYTES + data_bytes)?;
        Ok(Self {
            file,
            total_samples,
        })
    }

    /// Writes `samples` starting `offset_sec` into the timeline (clamped).
    pub fn write_at(&mut self, offset_sec: f64, samples: &[f32]) -> Result<()> {
        use std::io::{Seek, SeekFrom, Write};
        let start = (offset_sec.max(0.0) * YAMNET_SAMPLE_RATE as f64).round() as u64;
        if start >= self.total_samples {
            return Ok(());
        }
        let count = samples.len().min((self.total_samples - start) as usize);
        let mut bytes = Vec::with_capacity(count * 2);
        for value in &samples[..count] {
            bytes.extend_from_slice(
                &((value.clamp(-1.0, 1.0) * i16::MAX as f32).round() as i16).to_le_bytes(),
            );
        }
        self.file
            .seek(SeekFrom::Start(Self::HEADER_BYTES + start * 2))?;
        self.file.write_all(&bytes)?;
        Ok(())
    }
}

pub struct YamnetSession {
    session: Session,
    input_name: String,
    input_is_2d: bool,
}

impl YamnetSession {
    pub fn load(model_path: &Path) -> Result<Self> {
        let threads = std::thread::available_parallelism()
            .map(|t| t.get().min(4))
            .unwrap_or(2);
        let session = Session::builder()
            .map_err(|e| anyhow!("create YAMNet session builder: {e}"))?
            .with_intra_threads(threads)
            .map_err(|e| anyhow!("set YAMNet intra threads: {e}"))?
            .with_inter_threads(1)
            .map_err(|e| anyhow!("set YAMNet inter threads: {e}"))?
            .commit_from_file(model_path)
            .map_err(|e| anyhow!("load YAMNet model {}: {e}", model_path.display()))?;
        let (input_name, input_is_2d) = {
            let input = session
                .inputs()
                .first()
                .ok_or_else(|| anyhow!("YAMNet model has no inputs"))?;
            let is_2d = match input.dtype() {
                ort::value::ValueType::Tensor { shape, .. } => shape.len() == 2,
                _ => false,
            };
            (input.name().to_string(), is_2d)
        };
        Ok(Self {
            session,
            input_name,
            input_is_2d,
        })
    }

    /// Runs the classifier over one feed and returns the music probability
    /// (`max(Music, Background music)`) of every patch the graph produced.
    fn score_feed(&mut self, samples: &[f32]) -> Result<Vec<f32>> {
        let mut feed = samples.to_vec();
        if feed.len() < YAMNET_WINDOW_SAMPLES {
            feed.resize(YAMNET_WINDOW_SAMPLES, 0.0);
        }
        let len = feed.len();
        let outputs = if self.input_is_2d {
            let array = ndarray::Array2::from_shape_vec((1, len), feed)?;
            let value = ort::value::Value::from_array(array)?;
            self.session
                .run(ort::inputs![self.input_name.as_str() => &value])?
        } else {
            let array = ndarray::Array1::from_shape_vec(len, feed)?;
            let value = ort::value::Value::from_array(array)?;
            self.session
                .run(ort::inputs![self.input_name.as_str() => &value])?
        };
        let scores = match ["scores", "output_0"]
            .iter()
            .find_map(|name| outputs.get(name))
        {
            Some(value) => value.try_extract_tensor::<f32>()?.1.to_vec(),
            None => outputs
                .values()
                .next()
                .ok_or_else(|| anyhow!("YAMNet output scores not found"))?
                .try_extract_tensor::<f32>()?
                .1
                .to_vec(),
        };
        if scores.len() < CLASS_COUNT {
            return Err(anyhow!(
                "YAMNet returned {} scores, expected at least {CLASS_COUNT}",
                scores.len()
            ));
        }
        Ok(scores
            .chunks_exact(CLASS_COUNT)
            .map(|patch| patch[CLASS_MUSIC].max(patch[CLASS_BACKGROUND_MUSIC]))
            .collect())
    }

    /// Scores `samples` (16 kHz mono) in long feeds and returns one frame per
    /// 0.48 s patch. `normalize` brings every feed to -20 dBFS first, which
    /// lets the classifier judge quiet separated stems on their content
    /// instead of their level; `offset_sec` shifts the reported timestamps.
    pub fn score_samples(
        &mut self,
        samples: &[f32],
        offset_sec: f64,
        normalize: bool,
        cancel: &Arc<AtomicBool>,
        on_progress: &mut dyn FnMut(usize, usize),
    ) -> Result<Vec<MusicFrame>> {
        let feed_hop = if normalize {
            YAMNET_FEED_NORMALIZED_SAMPLES
        } else {
            YAMNET_FEED_PLAIN_SAMPLES
        };
        // Each feed carries one extra patch hop of lookahead so the last
        // patch of a feed is scored on real audio rather than zero padding.
        let feed_len = feed_hop + YAMNET_PATCH_HOP_SAMPLES;
        let feed_count = samples.len().div_ceil(feed_hop);
        let mut frames = Vec::with_capacity(samples.len() / YAMNET_PATCH_HOP_SAMPLES + 1);
        for feed_index in 0..feed_count {
            if cancel.load(Ordering::SeqCst) {
                return Err(anyhow!("Music detection cancelled"));
            }
            let start = feed_index * feed_hop;
            let end = (start + feed_len).min(samples.len());
            let feed_offset = offset_sec + start as f64 / YAMNET_SAMPLE_RATE as f64;
            self.score_one_feed(&samples[start..end], feed_hop, feed_offset, normalize, &mut frames)?;
            on_progress(feed_index, feed_count);
        }
        Ok(frames)
    }

    /// Scores one feed (`feed_hop` samples plus lookahead) and appends a
    /// frame per patch that starts inside the hop.
    fn score_one_feed(
        &mut self,
        feed: &[f32],
        feed_hop: usize,
        offset_sec: f64,
        normalize: bool,
        frames: &mut Vec<MusicFrame>,
    ) -> Result<()> {
        let scores = if normalize {
            let level_db = rms_db(feed);
            if level_db > -90.0 {
                let gain = 10f32.powf((-20.0 - level_db) / 20.0);
                let scaled: Vec<f32> = feed.iter().map(|v| v * gain).collect();
                self.score_feed(&scaled)?
            } else {
                self.score_feed(feed)?
            }
        } else {
            self.score_feed(feed)?
        };
        for (patch, music) in scores.into_iter().enumerate() {
            let patch_start = patch * YAMNET_PATCH_HOP_SAMPLES;
            if patch_start >= feed_hop || patch_start >= feed.len() {
                break;
            }
            let patch_end = (patch_start + YAMNET_WINDOW_SAMPLES).min(feed.len());
            frames.push(MusicFrame {
                start_sec: offset_sec + patch_start as f64 / YAMNET_SAMPLE_RATE as f64,
                end_sec: offset_sec + patch_end as f64 / YAMNET_SAMPLE_RATE as f64,
                music,
                level_db: rms_db(&feed[patch_start..patch_end]),
            });
        }
        Ok(())
    }

    /// Streams a 16 kHz mono WAV feed by feed without loading it: a
    /// multi-hour stream is scored with seconds of audio in memory.
    pub fn score_wav(
        &mut self,
        path: &Path,
        normalize: bool,
        cancel: &Arc<AtomicBool>,
        on_progress: &mut dyn FnMut(usize, usize),
    ) -> Result<Vec<MusicFrame>> {
        let mut reader = open_wav_mono16(path)?;
        let spec = reader.spec();
        let total_samples = reader.duration() as usize;
        // Feeds overlap by one patch hop (see `score_samples`); read the
        // file in hop-sized pieces and keep the previous tail as lookahead.
        let feed_hop = if normalize {
            YAMNET_FEED_NORMALIZED_SAMPLES
        } else {
            YAMNET_FEED_PLAIN_SAMPLES
        };
        let feed_count = total_samples.div_ceil(feed_hop);
        let mut frames = Vec::with_capacity(total_samples / YAMNET_PATCH_HOP_SAMPLES + 1);
        let mut buffer: Vec<f32> = Vec::with_capacity(feed_hop + YAMNET_PATCH_HOP_SAMPLES);
        read_samples_f32(&mut reader, &spec, feed_hop + YAMNET_PATCH_HOP_SAMPLES, &mut buffer)?;
        let mut consumed = 0usize;
        for feed_index in 0..feed_count {
            if cancel.load(Ordering::SeqCst) {
                return Err(anyhow!("Music detection cancelled"));
            }
            if buffer.is_empty() {
                break;
            }
            let offset_sec = consumed as f64 / YAMNET_SAMPLE_RATE as f64;
            self.score_one_feed(&buffer, feed_hop, offset_sec, normalize, &mut frames)?;
            let advance = feed_hop.min(buffer.len());
            buffer.drain(..advance);
            consumed += advance;
            read_samples_f32(&mut reader, &spec, advance, &mut buffer)?;
            if feed_index % 4 == 0 {
                on_progress(feed_index, feed_count);
            }
        }
        Ok(frames)
    }
}

/// 44.1 kHz → 16 kHz windowed-sinc resampler for mono f32 audio. Good enough
/// for classification and fingerprinting (Blackman window, 49 taps, ~-60 dB
/// stopband) and avoids an ffmpeg round trip per block. The 441:160 ratio
/// repeats every 160 output samples, so the filter is a 160-phase table
/// computed once; each output sample is then 49 multiply-adds.
pub fn resample_44100_to_16000(input: &[f32]) -> Vec<f32> {
    const IN_RATE: usize = 44_100;
    const OUT_RATE: usize = 16_000;
    const PHASES: usize = 160; // OUT_RATE / gcd(IN_RATE, OUT_RATE)
    const IN_PER_CYCLE: usize = 441; // IN_RATE / gcd
    const HALF_TAPS: isize = 24;
    const TAPS: usize = (2 * HALF_TAPS + 1) as usize;
    // Cutoff below the 8 kHz Nyquist of the output, in cycles per input sample.
    const CUTOFF: f64 = 7_200.0 / IN_RATE as f64;

    if input.is_empty() {
        return Vec::new();
    }
    // Phase p: output sample n = k * PHASES + p sits at input position
    // k * IN_PER_CYCLE + p * IN_PER_CYCLE / PHASES; the fractional part only
    // depends on p.
    let mut table = vec![0.0f32; PHASES * TAPS];
    let mut first_offsets = vec![0isize; PHASES];
    for phase in 0..PHASES {
        let center = phase as f64 * IN_PER_CYCLE as f64 / PHASES as f64;
        let first = center.ceil() as isize - HALF_TAPS;
        first_offsets[phase] = first;
        let mut sum = 0.0f64;
        let weights = &mut table[phase * TAPS..(phase + 1) * TAPS];
        for (tap, weight) in weights.iter_mut().enumerate() {
            let x = (first + tap as isize) as f64 - center;
            let sinc = if x.abs() < 1e-9 {
                1.0
            } else {
                let arg = std::f64::consts::PI * 2.0 * CUTOFF * x;
                arg.sin() / arg
            };
            let window_phase = std::f64::consts::PI * (x / HALF_TAPS as f64);
            let window = if x.abs() > HALF_TAPS as f64 {
                0.0
            } else {
                0.42 + 0.5 * window_phase.cos() + 0.08 * (2.0 * window_phase).cos()
            };
            let value = sinc * window;
            *weight = value as f32;
            sum += value;
        }
        if sum.abs() > 1e-12 {
            for weight in weights.iter_mut() {
                *weight = (*weight as f64 / sum) as f32;
            }
        }
    }

    let output_len = input.len() * OUT_RATE / IN_RATE;
    let mut output = Vec::with_capacity(output_len);
    for n in 0..output_len {
        let phase = n % PHASES;
        let base = (n / PHASES * IN_PER_CYCLE) as isize + first_offsets[phase];
        let weights = &table[phase * TAPS..(phase + 1) * TAPS];
        let mut value = 0.0f32;
        if base >= 0 && (base as usize + TAPS) <= input.len() {
            // Common case: all taps inside the signal, no bounds checks.
            let window = &input[base as usize..base as usize + TAPS];
            for (sample, weight) in window.iter().zip(weights) {
                value += sample * weight;
            }
        } else {
            for (tap, weight) in weights.iter().enumerate() {
                let index = base + tap as isize;
                if index >= 0 && (index as usize) < input.len() {
                    value += input[index as usize] * weight;
                }
            }
        }
        output.push(value);
    }
    output
}

fn rms_db(samples: &[f32]) -> f32 {
    if samples.is_empty() {
        return -120.0;
    }
    let energy: f64 = samples.iter().map(|v| (*v as f64) * (*v as f64)).sum();
    let rms = (energy / samples.len() as f64).sqrt() as f32;
    20.0 * (rms + 1e-9).log10()
}

/// Sorts ranges and merges any pair closer than `gap` seconds.
pub fn merge_ranges(mut ranges: Vec<(f64, f64)>, gap: f64) -> Vec<(f64, f64)> {
    ranges.retain(|(start, end)| end > start);
    ranges.sort_by(|a, b| a.0.total_cmp(&b.0));
    let mut merged: Vec<(f64, f64)> = Vec::with_capacity(ranges.len());
    for (start, end) in ranges {
        match merged.last_mut() {
            Some(last) if start <= last.1 + gap => last.1 = last.1.max(end),
            _ => merged.push((start, end)),
        }
    }
    merged
}

/// Coarse pass output: windows of the mix with a trace of music.
pub fn seed_windows(frames: &[MusicFrame]) -> Vec<(f64, f64)> {
    frames
        .iter()
        .filter(|frame| frame.music >= SEED_MIN_MUSIC)
        .map(|frame| (frame.start_sec, frame.end_sec))
        .collect()
}

/// Gaps between neighbourhoods shorter than this are analysed too: the
/// separator restarts with fresh context on every range, so a short gap
/// costs less than two more edges.
const NEIGHBOURHOOD_MERGE_GAP_SEC: f64 = 8.0;

/// Expands seed windows by `SEED_RADIUS_SEC` on both sides and merges them
/// into the neighbourhoods the separation model has to look at.
pub fn seed_neighbourhoods(seeds: &[(f64, f64)], total_sec: f64) -> Vec<(f64, f64)> {
    let padded = seeds
        .iter()
        .map(|(start, end)| {
            (
                (start - SEED_RADIUS_SEC).max(0.0),
                (end + SEED_RADIUS_SEC).min(total_sec),
            )
        })
        .collect();
    merge_ranges(padded, NEIGHBOURHOOD_MERGE_GAP_SEC)
}

/// Stem pass output: contiguous music regions from the separated instrumental.
pub fn regions_from_stem_frames(frames: &[MusicFrame]) -> Vec<DetectedMusic> {
    let music: Vec<(f64, f64)> = frames
        .iter()
        .filter(|frame| frame.music >= STEM_MIN_MUSIC && frame.level_db >= STEM_MIN_LEVEL_DB)
        .map(|frame| (frame.start_sec, frame.end_sec))
        .collect();
    merge_ranges(music, STEM_BRIDGE_GAP_SEC)
        .into_iter()
        .filter(|(start, end)| end - start >= STEM_MIN_REGION_SEC)
        .map(|(start, end)| {
            let confidence = frames
                .iter()
                .filter(|frame| frame.end_sec > start && frame.start_sec < end)
                .map(|frame| frame.music)
                .fold(0.0f32, f32::max);
            DetectedMusic {
                start_sec: start,
                end_sec: end,
                confidence,
            }
        })
        .collect()
}

/// Keeps only regions with a coarse-pass seed nearby.
pub fn keep_seeded(regions: Vec<DetectedMusic>, seeds: &[(f64, f64)]) -> Vec<DetectedMusic> {
    regions
        .into_iter()
        .filter(|region| {
            seeds.iter().any(|(seed_start, seed_end)| {
                *seed_start < region.end_sec + SEED_MATCH_TOLERANCE_SEC
                    && *seed_end > region.start_sec - SEED_MATCH_TOLERANCE_SEC
            })
        })
        .collect()
}

/// Adds the safety margin to every region and merges the ones that now touch.
pub fn pad_and_merge(regions: Vec<DetectedMusic>, total_sec: f64) -> Vec<DetectedMusic> {
    let mut padded: Vec<DetectedMusic> = regions
        .into_iter()
        .map(|region| DetectedMusic {
            start_sec: (region.start_sec - SAFETY_PAD_SEC).max(0.0),
            end_sec: (region.end_sec + SAFETY_PAD_SEC).min(total_sec),
            confidence: region.confidence,
        })
        .filter(|region| region.end_sec > region.start_sec)
        .collect();
    padded.sort_by(|a, b| a.start_sec.total_cmp(&b.start_sec));
    let mut merged: Vec<DetectedMusic> = Vec::with_capacity(padded.len());
    for region in padded {
        match merged.last_mut() {
            Some(last) if region.start_sec <= last.end_sec => {
                last.end_sec = last.end_sec.max(region.end_sec);
                last.confidence = last.confidence.max(region.confidence);
            }
            _ => merged.push(region),
        }
    }
    merged
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(start: f64, music: f32, level_db: f32) -> MusicFrame {
        MusicFrame {
            start_sec: start,
            end_sec: start + YAMNET_WINDOW_SEC,
            music,
            level_db,
        }
    }

    #[test]
    fn merge_ranges_bridges_gaps_and_sorts() {
        let merged = merge_ranges(vec![(10.0, 12.0), (0.0, 2.0), (3.0, 4.0)], 1.5);
        assert_eq!(merged, vec![(0.0, 4.0), (10.0, 12.0)]);
        assert!(merge_ranges(vec![(5.0, 5.0), (7.0, 6.0)], 0.0).is_empty());
    }

    #[test]
    fn faint_music_under_speech_still_seeds_a_neighbourhood() {
        let frames = vec![frame(0.0, 0.0, -30.0), frame(100.0, 0.06, -30.0)];
        let seeds = seed_windows(&frames);
        assert_eq!(seeds.len(), 1);
        let neighbourhoods = seed_neighbourhoods(&seeds, 110.0);
        assert_eq!(neighbourhoods.len(), 1);
        assert!((neighbourhoods[0].0 - (100.0 - SEED_RADIUS_SEC)).abs() < 1e-9);
        assert!((neighbourhoods[0].1 - 110.0).abs() < 1e-9);
    }

    #[test]
    fn stem_regions_bridge_short_dips_and_ignore_quiet_leakage() {
        let mut frames = Vec::new();
        // 20 s of music with a 3-window dip in the middle...
        for index in 0..21 {
            let start = index as f64 * YAMNET_WINDOW_SEC;
            let music = if (9..12).contains(&index) { 0.05 } else { 0.8 };
            frames.push(frame(start, music, -52.0));
        }
        // ...then loud-speech leakage that YAMNet also calls music.
        for index in 40..50 {
            frames.push(frame(index as f64 * YAMNET_WINDOW_SEC, 0.7, -66.0));
        }
        let regions = regions_from_stem_frames(&frames);
        assert_eq!(regions.len(), 1);
        assert!(regions[0].start_sec.abs() < 1e-9);
        assert!((regions[0].end_sec - 21.0 * YAMNET_WINDOW_SEC).abs() < 1e-9);
        assert!((regions[0].confidence - 0.8).abs() < 1e-6);
    }

    #[test]
    fn regions_without_nearby_seeds_are_dropped() {
        let regions = vec![
            DetectedMusic {
                start_sec: 100.0,
                end_sec: 130.0,
                confidence: 0.9,
            },
            DetectedMusic {
                start_sec: 400.0,
                end_sec: 410.0,
                confidence: 0.9,
            },
        ];
        let kept = keep_seeded(regions, &[(133.0, 134.0)]);
        assert_eq!(kept.len(), 1);
        assert!((kept[0].start_sec - 100.0).abs() < 1e-9);
    }

    #[test]
    fn resampler_keeps_a_tone_and_the_length_ratio() {
        let seconds = 2.0f64;
        let input: Vec<f32> = (0..(44_100.0 * seconds) as usize)
            .map(|i| ((i as f64 / 44_100.0) * 1_000.0 * std::f64::consts::TAU).sin() as f32 * 0.5)
            .collect();
        let output = resample_44100_to_16000(&input);
        assert_eq!(output.len(), (16_000.0 * seconds) as usize);
        // Same 1 kHz tone at the output rate, ignoring the filter's edges.
        let mut max_err = 0.0f32;
        for (i, value) in output.iter().enumerate().skip(100).take(output.len() - 200) {
            let expected = ((i as f64 / 16_000.0) * 1_000.0 * std::f64::consts::TAU).sin() as f32 * 0.5;
            max_err = max_err.max((value - expected).abs());
        }
        assert!(max_err < 0.02, "resampled tone error {max_err}");
        // A tone above the output Nyquist is rejected instead of aliasing.
        let high: Vec<f32> = (0..44_100)
            .map(|i| ((i as f64 / 44_100.0) * 12_000.0 * std::f64::consts::TAU).sin() as f32)
            .collect();
        let rejected = resample_44100_to_16000(&high);
        let rms = (rejected.iter().map(|v| v * v).sum::<f32>() / rejected.len() as f32).sqrt();
        assert!(rms < 0.02, "aliased energy {rms}");
    }

    #[test]
    fn stem_timeline_round_trips_through_hound() {
        let dir = std::env::temp_dir().join("fetchr-stem-timeline-test");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("timeline.wav");
        {
            let mut timeline = StemTimeline::create(&path, 3.0).unwrap();
            let tone: Vec<f32> = (0..YAMNET_SAMPLE_RATE)
                .map(|i| ((i as f32 / 40.0) * std::f32::consts::TAU).sin() * 0.5)
                .collect();
            timeline.write_at(1.0, &tone).unwrap();
        }
        assert!((wav_mono16_duration_sec(&path).unwrap() - 3.0).abs() < 1e-6);
        let silent = read_wav_mono16_window(&path, 0.0, 1.0).unwrap();
        assert!(silent.iter().all(|s| *s == 0));
        let written = read_wav_mono16_window(&path, 1.0, 1.0).unwrap();
        assert_eq!(written.len(), YAMNET_SAMPLE_RATE as usize);
        assert!(written.iter().any(|s| s.unsigned_abs() > 10_000));
        let tail = read_wav_mono16_window(&path, 2.5, 5.0).unwrap();
        assert_eq!(tail.len(), YAMNET_SAMPLE_RATE as usize / 2);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn padding_clamps_to_file_and_merges_neighbours() {
        let regions = vec![
            DetectedMusic {
                start_sec: 3.0,
                end_sec: 20.0,
                confidence: 0.5,
            },
            DetectedMusic {
                start_sec: 30.0,
                end_sec: 40.0,
                confidence: 0.9,
            },
            DetectedMusic {
                start_sec: 90.0,
                end_sec: 99.0,
                confidence: 0.7,
            },
        ];
        let padded = pad_and_merge(regions, 100.0);
        assert_eq!(padded.len(), 2);
        assert!(padded[0].start_sec.abs() < 1e-9);
        assert!((padded[0].end_sec - 50.0).abs() < 1e-9);
        assert!((padded[0].confidence - 0.9).abs() < 1e-6);
        assert!((padded[1].start_sec - 80.0).abs() < 1e-9);
        assert!((padded[1].end_sec - 100.0).abs() < 1e-9);
    }
}
