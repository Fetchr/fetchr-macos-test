//! Перепроверка сомнительных кандидатов в мат второй моделью.
//!
//! RNN-T выдаёт мусорные токены на музыке и шуме, и часть из них совпадает с
//! корнями мата: мут ложится на пустой фон. Тихий настоящий мат, наоборот,
//! приходит с низкой уверенностью и отсекается порогом. Кандидат с уверенностью
//! в полосе [VERIFY_MIN_CONFIDENCE, VERIFY_KEEP_CONFIDENCE) распознаётся заново
//! CTC-головой GigaAM по окну вокруг слова: мат подтверждён — мутится даже
//! тихий, не подтверждён — снимается. Неподтверждённые ещё раз проверяются на
//! голосе, отделённом от фона, если модель разделения уже скачана.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{anyhow, Context, Result};

use crate::jobs::asr_models::{self, CtcWord, VerifyWindow};
use crate::jobs::fetchr_mute::{
    is_valid_word_hit, normalize_word, profane_match_kind, word_profane_match_kind,
    ProfaneDictionary, ProfaneMatchKind, WordHit, VERIFY_KEEP_CONFIDENCE, VERIFY_MIN_CONFIDENCE,
};
use crate::jobs::queue::QueueManager;
use crate::jobs::types::{FetchrMuteAsrModel, FetchrMuteLanguage, FetchrMuteSettings};

const SAMPLE_RATE: usize = 16_000;
/// Контекст вокруг слова для CTC: модели нужна фраза, а не одно слово.
const WINDOW_CONTEXT_S: f64 = 1.0;
/// Контекст для разделения голоса: модель работает кусками ~6 с, короткий
/// клип она всё равно добивает тишиной.
const VOCAL_CONTEXT_S: f64 = 1.5;
/// Таймкоды RNN-T и CTC расходятся до ~0.4 с: на стриме замерено до 0.5 с.
const MATCH_TOLERANCE_S: f64 = 0.45;
/// Верхняя граница повторов на голосе: разделение — самая дорогая часть.
const MAX_VOCAL_RETRIES: usize = 80;
const VOCAL_SAMPLE_RATE: u32 = 44_100;

pub struct VerifyContext<'a> {
    pub queue: &'a Arc<QueueManager>,
    pub job_id: &'a str,
    pub model_root: &'a Path,
    pub model: FetchrMuteAsrModel,
    pub ffmpeg: &'a Path,
    pub input_path: &'a Path,
    /// Подготовленный 16 кГц WAV, по которому шло распознавание.
    pub wav_path: &'a Path,
    pub work_dir: &'a Path,
    pub track: u32,
    pub cancel: Arc<AtomicBool>,
}

#[derive(Debug, Default, Clone, Copy)]
pub struct VerifyStats {
    pub candidates: usize,
    pub confirmed: usize,
    pub rejected: usize,
    pub confirmed_on_vocals: usize,
    pub elapsed: Duration,
}

impl VerifyStats {
    pub fn summary(&self) -> String {
        format!(
            "FetchrMute CTC verify: candidates={} confirmed={} (on isolated vocals {}) rejected={} in {:.1}s",
            self.candidates,
            self.confirmed,
            self.confirmed_on_vocals,
            self.rejected,
            self.elapsed.as_secs_f64()
        )
    }
}

/// Слова, которые решит перепроверка: похожи на мат, не отсечены леммой и
/// распознаны с уверенностью ниже той, при которой RNN-T верят без вопросов.
pub fn candidate_indices(
    words: &[WordHit],
    profane_words: &ProfaneDictionary,
    settings: &FetchrMuteSettings,
) -> Vec<usize> {
    words
        .iter()
        .enumerate()
        .filter(|(_, word)| {
            word.verified.is_none()
                && is_valid_word_hit(word)
                && (VERIFY_MIN_CONFIDENCE..VERIFY_KEEP_CONFIDENCE).contains(&word.confidence)
        })
        .filter(|(_, word)| word_profane_match_kind(word, profane_words, settings).is_some())
        .map(|(index, _)| index)
        .collect()
}

/// Слова, похожие на мат: к ним CTC-мат приписывается при подтверждении.
pub fn profane_like_indices(
    words: &[WordHit],
    profane_words: &ProfaneDictionary,
    settings: &FetchrMuteSettings,
) -> Vec<usize> {
    words
        .iter()
        .enumerate()
        .filter(|(_, word)| is_valid_word_hit(word))
        .filter(|(_, word)| word_profane_match_kind(word, profane_words, settings).is_some())
        .map(|(index, _)| index)
        .collect()
}

fn center(start: f64, end: f64) -> f64 {
    (start + end) * 0.5
}

/// Подтвердила ли CTC мат именно в слове `index`. Только точное или
/// корневое совпадение: fuzzy по второй модели снова пускал бы мусор.
///
/// Таймкоды двух моделей расходятся до ~0.45 с, поэтому допуск широкий. Но
/// найденный CTC мат приписывается ближайшему похожему на мат слову RNN-T:
/// мусорный токен рядом с настоящим матом больше не «подтверждается» чужим
/// словом — мат в окне принадлежит соседу, а не ему.
pub fn ctc_confirms(
    words: &[WordHit],
    index: usize,
    profane_like: &[usize],
    ctc_words: &[CtcWord],
    profane_words: &ProfaneDictionary,
    settings: &FetchrMuteSettings,
) -> bool {
    let word = &words[index];
    ctc_words.iter().any(|candidate| {
        if candidate.end <= word.start - MATCH_TOLERANCE_S
            || candidate.start >= word.end + MATCH_TOLERANCE_S
            || !matches!(
                profane_match_kind(&normalize_word(&candidate.raw), profane_words, settings),
                Some(ProfaneMatchKind::Exact | ProfaneMatchKind::Root)
            )
        {
            return false;
        }
        let ctc_center = center(candidate.start, candidate.end);
        let distance =
            |other: usize| (center(words[other].start, words[other].end) - ctc_center).abs();
        let own = distance(index);
        profane_like
            .iter()
            .filter(|&&other| other != index)
            .all(|&other| distance(other) >= own)
    })
}

/// Проставляет `verified` у сомнительных кандидатов. Без CTC-модели ничего
/// не делает: тогда работает один порог уверенности, как раньше.
pub fn verify_uncertain_words(
    context: &VerifyContext<'_>,
    words: &mut [WordHit],
    profane_words: &ProfaneDictionary,
    settings: &FetchrMuteSettings,
) -> Result<VerifyStats> {
    let started = Instant::now();
    // CTC-модель русская: английское слово она не подтвердит никогда, и
    // перепроверка сняла бы весь английский мат из полосы уверенности.
    if !matches!(settings.language, FetchrMuteLanguage::Ru) {
        return Ok(VerifyStats::default());
    }
    let candidates = candidate_indices(words, profane_words, settings);
    let mut stats = VerifyStats {
        candidates: candidates.len(),
        ..VerifyStats::default()
    };
    if candidates.is_empty() || !asr_models::ctc_model_ready() {
        return Ok(stats);
    }

    let total_samples = crate::jobs::fetchr_mute::wav_sample_count(context.wav_path)?;
    let windows: Vec<VerifyWindow> = candidates
        .iter()
        .map(|&index| {
            let word = &words[index];
            let start = ((word.start - WINDOW_CONTEXT_S).max(0.0) * SAMPLE_RATE as f64) as usize;
            let end = (((word.end + WINDOW_CONTEXT_S) * SAMPLE_RATE as f64) as usize)
                .min(total_samples);
            VerifyWindow {
                id: index.to_string(),
                wav: context.wav_path.to_path_buf(),
                start_sample: start.min(end),
                end_sample: end,
                base_time: start.min(end) as f64 / SAMPLE_RATE as f64,
            }
        })
        .collect();
    let results = run_verify(context, &windows)?;
    let profane_like = profane_like_indices(words, profane_words, settings);

    let mut rejected = Vec::new();
    for &index in &candidates {
        let confirmed = results.get(&index.to_string()).is_some_and(|ctc| {
            ctc_confirms(words, index, &profane_like, ctc, profane_words, settings)
        });
        if confirmed {
            words[index].verified = Some(true);
            stats.confirmed += 1;
        } else {
            rejected.push(index);
        }
    }

    // Под музыкой CTC слышит мусор так же, как RNN-T. Перед тем как снять
    // кандидата, его окно проверяется на отделённом голосе.
    if let Some(model_path) = crate::jobs::vocal_remover::fast_model_if_present() {
        let retry: Vec<usize> = rejected.iter().copied().take(MAX_VOCAL_RETRIES).collect();
        match confirm_on_vocals(
            context,
            &model_path,
            words,
            &retry,
            &profane_like,
            profane_words,
            settings,
        ) {
            Ok(confirmed) => {
                for index in confirmed {
                    words[index].verified = Some(true);
                    stats.confirmed_on_vocals += 1;
                    stats.confirmed += 1;
                    rejected.retain(|&rejected_index| rejected_index != index);
                }
            }
            Err(error) if context.cancel.load(Ordering::SeqCst) => return Err(error),
            Err(error) => crate::jobs::fetchr_mute::emit_log(
                context.queue,
                context.job_id,
                &format!("FetchrMute vocal re-check skipped: {error:#}"),
            ),
        }
    }

    for &index in &rejected {
        words[index].verified = Some(false);
    }
    stats.rejected = rejected.len();
    stats.elapsed = started.elapsed();
    Ok(stats)
}

fn run_verify(
    context: &VerifyContext<'_>,
    windows: &[VerifyWindow],
) -> Result<HashMap<String, Vec<CtcWord>>> {
    // Замок только на время обращения к серверу: ffmpeg и разделение голоса
    // идут без него и не держат распознавание других задач.
    let _guard = crate::jobs::fetchr_mute::lock_asr_execution(&context.cancel)?;
    asr_models::verify_windows(
        context.queue,
        context.job_id,
        context.model_root,
        context.model,
        context.work_dir,
        context.wav_path,
        windows,
        context.cancel.clone(),
    )
}

fn confirm_on_vocals(
    context: &VerifyContext<'_>,
    model_path: &Path,
    words: &[WordHit],
    indices: &[usize],
    profane_like: &[usize],
    profane_words: &ProfaneDictionary,
    settings: &FetchrMuteSettings,
) -> Result<Vec<usize>> {
    if indices.is_empty() {
        return Ok(Vec::new());
    }
    let audio_offset = audio_start_offset(context);
    let mut clips = Vec::with_capacity(indices.len());
    let mut offsets = Vec::with_capacity(indices.len());
    for &index in indices {
        if context.cancel.load(Ordering::SeqCst) {
            return Err(anyhow!("FetchrMute task cancelled"));
        }
        let word = &words[index];
        let from = (word.start - VOCAL_CONTEXT_S).max(0.0);
        let duration = word.end + VOCAL_CONTEXT_S - from;
        clips.push(read_stereo_clip(context, from + audio_offset, duration)?);
        offsets.push(from);
    }
    let vocals = crate::jobs::vocal_remover::isolate_vocals_16k(model_path, &clips, &context.cancel)?;

    let mut windows = Vec::with_capacity(indices.len());
    let mut files = TempFiles(Vec::with_capacity(indices.len()));
    for ((&index, samples), offset) in indices.iter().zip(&vocals).zip(&offsets) {
        let path = context.work_dir.join(format!("ctc-vocals-{index}.wav"));
        files.0.push(path.clone());
        write_pcm16_mono(&path, samples)?;
        windows.push(VerifyWindow {
            id: index.to_string(),
            wav: path,
            start_sample: 0,
            end_sample: samples.len(),
            base_time: *offset,
        });
    }
    let results = run_verify(context, &windows)?;
    Ok(indices
        .iter()
        .copied()
        .filter(|index| {
            results
                .get(&index.to_string())
                .is_some_and(|ctc| {
                    ctc_confirms(words, *index, profane_like, ctc, profane_words, settings)
                })
        })
        .collect())
}

/// Удаляет временные файлы при выходе из области, в том числе по ошибке.
struct TempFiles(Vec<PathBuf>);

impl Drop for TempFiles {
    fn drop(&mut self) {
        for path in &self.0 {
            let _ = std::fs::remove_file(path);
        }
    }
}

/// На сколько секунд первая аудиовыборка дорожки позже начала контейнера.
///
/// Время слов отсчитывается от первого сэмпла дорожки (так устроен
/// подготовленный WAV), а `-ss` у ffmpeg — от начала контейнера. У TS и MKV
/// звук нередко стартует позже (сотни миллисекунд), и без поправки окно
/// повторной проверки уезжало от слова. Ошибка пробы — ноль, как раньше.
fn audio_start_offset(context: &VerifyContext<'_>) -> f64 {
    let Some(ffprobe) =
        crate::binaries::resolve_binary(crate::binaries::FFPROBE, context.ffmpeg.parent())
    else {
        return 0.0;
    };
    let output = crate::platform::hidden_command(ffprobe)
        .args(["-v", "error", "-select_streams"])
        .arg(format!("a:{}", context.track))
        .args([
            "-show_entries",
            "stream=start_time:format=start_time",
            "-of",
            "json",
        ])
        .arg(context.input_path)
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output();
    let Ok(output) = output else {
        return 0.0;
    };
    parse_audio_start_offset(&String::from_utf8_lossy(&output.stdout))
}

fn parse_audio_start_offset(json: &str) -> f64 {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(json) else {
        return 0.0;
    };
    let seconds = |value: Option<&serde_json::Value>| {
        value
            .and_then(|value| value.as_str())
            .and_then(|text| text.parse::<f64>().ok())
            .filter(|seconds| seconds.is_finite())
    };
    let stream = seconds(value.pointer("/streams/0/start_time"));
    let format = seconds(value.pointer("/format/start_time"));
    match (stream, format) {
        (Some(stream), Some(format)) => (stream - format).clamp(0.0, 30.0),
        _ => 0.0,
    }
}

/// Клип исходника 44.1 кГц стерео f32 — формат входа модели разделения.
fn read_stereo_clip(
    context: &VerifyContext<'_>,
    from: f64,
    duration: f64,
) -> Result<(Vec<f32>, Vec<f32>)> {
    let output = crate::platform::hidden_command(context.ffmpeg)
        .args(["-hide_banner", "-loglevel", "error", "-ss"])
        .arg(format!("{from:.3}"))
        .arg("-t")
        .arg(format!("{duration:.3}"))
        .arg("-i")
        .arg(context.input_path)
        .args(["-map", &format!("0:a:{}", context.track), "-vn", "-ac", "2", "-ar"])
        .arg(VOCAL_SAMPLE_RATE.to_string())
        .args(["-f", "f32le", "-"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .context("ffmpeg clip for vocal re-check")?;
    if !output.status.success() {
        return Err(anyhow!(
            "ffmpeg clip failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    let interleaved: Vec<f32> = output
        .stdout
        .chunks_exact(4)
        .map(|bytes| f32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]))
        .collect();
    let left = interleaved.iter().step_by(2).copied().collect();
    let right = interleaved.iter().skip(1).step_by(2).copied().collect();
    Ok((left, right))
}

fn write_pcm16_mono(path: &Path, samples: &[f32]) -> Result<()> {
    let spec = hound::WavSpec {
        channels: 1,
        sample_rate: SAMPLE_RATE as u32,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let mut writer =
        hound::WavWriter::create(path, spec).with_context(|| format!("create {path:?}"))?;
    for sample in samples {
        writer.write_sample((sample.clamp(-1.0, 1.0) * i16::MAX as f32) as i16)?;
    }
    writer.finalize().context("finalize vocals wav")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn word(raw: &str, start: f64, end: f64, confidence: f32) -> WordHit {
        WordHit {
            lemma: None,
            verified: None,
            raw: raw.to_string(),
            normalized: normalize_word(raw),
            start,
            end,
            confidence,
        }
    }

    fn ctc(raw: &str, start: f64, end: f64) -> CtcWord {
        CtcWord {
            raw: raw.to_string(),
            start,
            end,
        }
    }

    #[test]
    fn only_uncertain_profane_words_are_candidates() {
        let settings = FetchrMuteSettings::default();
        let dictionary = crate::jobs::fetchr_mute::load_profane_words(&settings).unwrap();
        let words = vec![
            word("блять", 1.0, 1.4, 0.95),
            word("блять", 2.0, 2.4, 0.40),
            word("блять", 3.0, 3.4, 0.10),
            word("блять", 4.0, 4.4, 0.01),
            word("привет", 5.0, 5.4, 0.20),
        ];
        assert_eq!(candidate_indices(&words, &dictionary, &settings), vec![1, 2]);
    }

    #[test]
    fn ctc_confirmation_tolerates_timestamp_drift_but_not_other_places() {
        let settings = FetchrMuteSettings::default();
        let dictionary = crate::jobs::fetchr_mute::load_profane_words(&settings).unwrap();
        let words = vec![word("блять", 10.0, 10.4, 0.3)];
        let like = profane_like_indices(&words, &dictionary, &settings);
        let confirms = |ctc_words: &[CtcWord]| {
            ctc_confirms(&words, 0, &like, ctc_words, &dictionary, &settings)
        };
        assert!(confirms(&[ctc("блять", 10.3, 10.6)]));
        assert!(!confirms(&[ctc("блять", 11.2, 11.5)]));
        assert!(!confirms(&[ctc("бляха", 10.0, 10.4)]));
    }

    #[test]
    fn neighbouring_real_profanity_does_not_confirm_garbage_token() {
        let settings = FetchrMuteSettings::default();
        let dictionary = crate::jobs::fetchr_mute::load_profane_words(&settings).unwrap();
        // Мусорный «хуе» (0.2) в 0.4 с от уверенного «блять» (0.95). CTC слышит
        // только «блять» — это мат соседа, мусор подтверждаться не должен.
        let words = vec![word("хуе", 10.0, 10.25, 0.2), word("блять", 10.45, 10.85, 0.95)];
        let like = profane_like_indices(&words, &dictionary, &settings);
        let heard = [ctc("блять", 10.5, 10.85)];
        assert!(!ctc_confirms(&words, 0, &like, &heard, &dictionary, &settings));
        assert!(ctc_confirms(&words, 1, &like, &heard, &dictionary, &settings));
    }

    #[test]
    fn audio_start_offset_is_stream_minus_container_start() {
        let json = "{\"streams\":[{\"start_time\":\"1.433000\"}],\"format\":{\"start_time\":\"1.400000\"}}";
        assert!((parse_audio_start_offset(json) - 0.033).abs() < 1e-9);
        assert_eq!(parse_audio_start_offset("{\"streams\":[{}],\"format\":{}}"), 0.0);
        assert_eq!(parse_audio_start_offset("not json"), 0.0);
        let early = "{\"streams\":[{\"start_time\":\"0.0\"}],\"format\":{\"start_time\":\"0.5\"}}";
        assert_eq!(parse_audio_start_offset(early), 0.0);
    }
}
