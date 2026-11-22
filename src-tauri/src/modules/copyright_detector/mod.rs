pub mod commands;

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use tauri::Emitter;

use crate::jobs::music_detect::{self, DetectedMusic};
use crate::jobs::types::VocalRemoverMode;
use crate::jobs::vocal_remover::{self, DetectionModels, SeparationCache};

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct CopyrightTimelineSegment {
    pub start_sec: f64,
    pub end_sec: f64,
    pub confidence: f64,
    pub is_commercial: bool,
    pub track_title: Option<String>,
}

#[derive(Default)]
pub struct CopyrightState {
    pub cancels: Arc<parking_lot::Mutex<std::collections::HashMap<String, Arc<AtomicBool>>>>,
}

#[derive(serde::Serialize, Clone)]
struct ProgressPayload {
    percent: f32,
    message: String,
    #[serde(rename = "taskId")]
    task_id: String,
}

/// Shazam matches ~12-second snippets against its commercial catalogue.
const SHAZAM_WINDOW_SEC: f64 = 12.0;
/// Long regions are probed every this many seconds so a DJ set or a playlist
/// gets every track named, not just the one in the middle.
const SHAZAM_PROBE_STEP_SEC: f64 = 60.0;
const SHAZAM_MAX_PROBES_PER_REGION: usize = 5;
/// Pause between requests: the unofficial endpoint is rate-limited.
const SHAZAM_PAUSE_MS: u64 = 400;
/// Shazam needs at least this much audio to build a signature.
const SHAZAM_MIN_PROBE_SEC: f64 = 3.0;

/// Where scan progress goes: the Tauri event in the app, stderr in tests.
type ProgressFn = Arc<dyn Fn(f32, &str) + Send + Sync>;

#[derive(Clone)]
struct Progress {
    report: ProgressFn,
}

impl Progress {
    fn emit(&self, percent: f32, message: impl Into<String>) {
        (self.report)(percent, &message.into());
    }

    /// Progress sink for a sub-step reporting its own 0–100.
    fn stage(&self, from: f32, to: f32) -> impl FnMut(f32, &str) + Send + 'static {
        let report = Arc::clone(&self.report);
        move |local: f32, message: &str| {
            let percent = from + (to - from) * (local / 100.0).clamp(0.0, 1.0);
            report(percent, message);
        }
    }
}

/// Removes the scan workspace on every exit path.
struct TempDirGuard(PathBuf);

impl Drop for TempDirGuard {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn check_cancel(cancel: &AtomicBool) -> Result<(), String> {
    if cancel.load(Ordering::SeqCst) {
        Err("Scanning cancelled".to_string())
    } else {
        Ok(())
    }
}

/// Full copyright scan of one media file:
///
/// 1. models: YAMNet classifier + fast separator (downloaded on first use);
/// 2. one ffmpeg decode gives the audio three ways (44.1 kHz stereo for the
///    separator, 16 kHz normalised mono for the classifier, 16 kHz plain
///    mono for Shazam);
/// 3. two-stage music detection (see `jobs::music_detect`): the classifier
///    seeds neighbourhoods, the separator's instrumental stem decides —
///    this is what finds a track playing 25 dB under the streamer's voice.
///    The separator output is cached per file so the fast-mode cleanup that
///    follows never runs the model again;
/// 4. Shazam names the commercial tracks;
/// 5. same-track regions are glued, unnamed fragments next to a named track
///    are absorbed, and a safety margin is added to every region.
pub async fn run_copyright_scan(
    app: tauri::AppHandle,
    task_id: String,
    input_path: String,
    binaries_dir: Option<String>,
    cancel: Arc<AtomicBool>,
) -> Result<Vec<CopyrightTimelineSegment>, String> {
    let bin_dir = binaries_dir.as_deref().map(Path::new);
    let ffmpeg_path = crate::binaries::resolve_binary(crate::binaries::FFMPEG, bin_dir)
        .ok_or_else(|| "ffmpeg.exe not found - set binaries folder in Settings".to_string())?;
    let event_task_id = task_id.clone();
    let report: ProgressFn = Arc::new(move |percent: f32, message: &str| {
        let _ = app.emit(
            "vocal_remover:progress",
            ProgressPayload {
                percent,
                message: message.to_string(),
                task_id: event_task_id.clone(),
            },
        );
    });
    scan_with_progress(
        report,
        &task_id,
        Path::new(&input_path),
        &ffmpeg_path,
        cancel,
    )
    .await
}

/// The scan itself, independent of Tauri so tests can drive the whole
/// pipeline (including the pipelined Shazam step) on a real file.
pub(crate) async fn scan_with_progress(
    report: ProgressFn,
    task_id: &str,
    input: &Path,
    ffmpeg_path: &Path,
    cancel: Arc<AtomicBool>,
) -> Result<Vec<CopyrightTimelineSegment>, String> {
    let progress = Progress { report };
    check_cancel(&cancel)?;

    // 1. Models (0% - 10%)
    progress.emit(0.0, "Проверка ИИ-моделей...");
    let yamnet_path = music_detect::yamnet_model_path();
    {
        let mut sink = progress.stage(0.0, 5.0);
        music_detect::ensure_yamnet_model(&yamnet_path, cancel.clone(), &mut sink)
            .await
            .map_err(|e| e.to_string())?;
    }
    let fast_model_path = vocal_remover::detection_model_path();
    {
        let model_dir = fast_model_path
            .parent()
            .ok_or_else(|| "detection model path has no parent".to_string())?
            .to_path_buf();
        let mut sink = progress.stage(5.0, 10.0);
        vocal_remover::ensure_models_with_progress(
            VocalRemoverMode::FastHtdemucs,
            &model_dir,
            cancel.clone(),
            &mut sink,
        )
        .await
        .map_err(|e| e.to_string())?;
    }
    check_cancel(&cancel)?;

    // 2. Audio extraction (10% - 20%)
    progress.emit(10.0, "Извлечение аудио...");
    let temp_dir = std::env::temp_dir()
        .join("fetchr-copyright")
        .join(safe_path_part(task_id));
    tokio::fs::create_dir_all(&temp_dir)
        .await
        .map_err(|e| format!("Failed to create temp directory: {e}"))?;
    let _temp_guard = TempDirGuard(temp_dir.clone());

    let wav44_path = temp_dir.join("source_44100_stereo.wav");
    let wav16_norm_path = temp_dir.join("source_16000_mono_norm.wav");
    let wav16_fp_path = temp_dir.join("source_16000_mono_fp.wav");

    vocal_remover::extract_scan_audio(
        ffmpeg_path,
        input,
        &wav44_path,
        Some(&wav16_norm_path),
        Some(&wav16_fp_path),
    )
    .await
    .map_err(|e| e.to_string())?;
    check_cancel(&cancel)?;

    // 3 + 4. Music detection (20% - 80%) with Shazam recognition (80% - 98%)
    // pipelined behind it: every neighbourhood's regions are handed over as
    // soon as its stem pass ends and probed while the next one separates.
    // The separated instrumental of every analysed block is kept in a
    // voice-free timeline for the probes, and the separated vocals in the
    // per-file cache for the cleanup.
    let stem_timeline_path = temp_dir.join("stem_timeline_16000_mono.wav");
    let total_sec = music_detect::wav_mono16_duration_sec(&wav16_fp_path)
        .map_err(|e| e.to_string())?;
    let probe_sources = ProbeSources {
        stem: Some(stem_timeline_path.clone()),
        mix: wav16_fp_path.clone(),
    };
    let (region_tx, mut region_rx) = tokio::sync::mpsc::unbounded_channel::<Vec<DetectedMusic>>();
    let detection = {
        let mut sink = progress.stage(20.0, 80.0);
        let yamnet = yamnet_path.clone();
        let fast_model = fast_model_path.clone();
        let wav44 = wav44_path.clone();
        let wav16 = wav16_norm_path.clone();
        let tmp = temp_dir.clone();
        let timeline = stem_timeline_path.clone();
        let input = input.to_path_buf();
        let cancel = cancel.clone();
        tokio::task::spawn_blocking(move || -> Result<Vec<DetectedMusic>, String> {
            let models = DetectionModels {
                fast_model_path: &fast_model,
                yamnet_path: &yamnet,
            };
            SeparationCache::sweep_stale();
            let total_frames = vocal_remover::wav_total_frames(&wav44).map_err(|e| e.to_string())?;
            let mut cache = SeparationCache::dir_for(&input)
                .and_then(|dir| SeparationCache::create(&dir, total_frames))
                .map_err(|err| tracing::warn!("separation cache disabled: {err}"))
                .ok();
            let mut emit = |regions: Vec<DetectedMusic>| {
                let _ = region_tx.send(regions);
            };
            vocal_remover::detect_music_regions_blocking(
                &models,
                &wav44,
                &wav16,
                &tmp,
                Some(&timeline),
                cache.as_mut(),
                &cancel,
                &mut sink,
                Some(&mut emit),
            )
            .map_err(|e| e.to_string())
        })
    };

    // Recognise regions as they arrive; the channel closes when detection
    // returns, which also ends this loop. Any failure here first stops the
    // detection thread (it would otherwise keep the GPU busy and outlive the
    // temp dir) before the error propagates.
    let mut segments: Vec<CopyrightTimelineSegment> = Vec::new();
    let mut probed = 0usize;
    let probing: Result<(), String> = async {
        while let Some(regions) = region_rx.recv().await {
            for region in regions {
                check_cancel(&cancel)?;
                if detection.is_finished() {
                    progress.emit(
                        80.0 + 18.0 * (probed as f32 / (probed + 3) as f32),
                        format!("Распознавание трека (Shazam): участок {}...", probed + 1),
                    );
                }
                let titles = recognize_tracks(
                    &probe_sources,
                    total_sec,
                    region.start_sec,
                    region.end_sec,
                    &temp_dir,
                    probed,
                    &cancel,
                )
                .await?;
                probed += 1;
                segments.push(CopyrightTimelineSegment {
                    start_sec: region.start_sec,
                    end_sec: region.end_sec,
                    confidence: region.confidence as f64,
                    is_commercial: !titles.is_empty(),
                    track_title: if titles.is_empty() {
                        None
                    } else {
                        Some(titles.join(" · "))
                    },
                });
            }
        }
        Ok(())
    }
    .await;
    if let Err(err) = probing {
        cancel.store(true, Ordering::SeqCst);
        let _ = detection.await;
        return Err(err);
    }
    let detected = detection
        .await
        .map_err(|e| format!("Music detection worker panicked: {e}"))??;
    check_cancel(&cancel)?;
    if detected.len() != segments.len() {
        // Should not happen (every region is emitted exactly once); fall
        // back to the unnamed list rather than dropping regions.
        tracing::warn!(
            "copyright scan: {} regions detected, {} probed",
            detected.len(),
            segments.len()
        );
        segments = detected
            .into_iter()
            .map(|region| CopyrightTimelineSegment {
                start_sec: region.start_sec,
                end_sec: region.end_sec,
                confidence: region.confidence as f64,
                is_commercial: false,
                track_title: None,
            })
            .collect();
    }
    segments.sort_by(|a, b| a.start_sec.total_cmp(&b.start_sec));

    // 5. Post-processing.
    let glued = merge_same_track(absorb_small_untitled(merge_same_track(segments)));
    let final_segments = pad_segments(glued, total_sec);

    // The next step is usually "remove music" on these segments: keep the
    // decode so it does not have to extract the whole source again. Nothing
    // found means nothing to remove, so nothing is kept.
    if !final_segments.is_empty() {
        vocal_remover::keep_scanned_source_audio(input, &wav44_path);
    }

    progress.emit(100.0, "Сканирование успешно завершено");
    Ok(final_segments)
}

/// Where Shazam probes read from: the voice-free instrumental timeline first
/// (music 25 dB under speech is unrecognisable in the mix but clean there),
/// then the plain mix as a fallback.
struct ProbeSources {
    stem: Option<PathBuf>,
    mix: PathBuf,
}

/// Probe positions inside a region: the middle first (cleanest music), then
/// every `SHAZAM_PROBE_STEP_SEC` from the start so long regions get every
/// track named. Positions closer than a second to an earlier one are skipped.
fn shazam_probe_starts(start_sec: f64, end_sec: f64, total_sec: f64) -> Vec<f64> {
    let max_start = (total_sec - SHAZAM_WINDOW_SEC).max(0.0);
    let clamp = |value: f64| value.clamp(0.0, max_start);
    let duration = end_sec - start_sec;
    let mut starts = vec![clamp(start_sec + duration / 2.0 - SHAZAM_WINDOW_SEC / 2.0)];
    if duration > SHAZAM_WINDOW_SEC * 2.0 {
        let mut cursor = start_sec + 2.0;
        while cursor + SHAZAM_WINDOW_SEC <= end_sec - 1.0
            && starts.len() < SHAZAM_MAX_PROBES_PER_REGION
        {
            let candidate = clamp(cursor);
            if starts.iter().all(|known| (known - candidate).abs() >= 1.0) {
                starts.push(candidate);
            }
            cursor += SHAZAM_PROBE_STEP_SEC;
        }
    }
    starts
}

/// Runs Shazam over the probe windows of one region and returns the distinct
/// track titles it named, in the order they were found.
async fn recognize_tracks(
    sources: &ProbeSources,
    total_sec: f64,
    start_sec: f64,
    end_sec: f64,
    temp_dir: &Path,
    region_index: usize,
    cancel: &Arc<AtomicBool>,
) -> Result<Vec<String>, String> {
    let mut titles: Vec<String> = Vec::new();
    let mut requests = 0usize;
    for (probe_index, win_start) in shazam_probe_starts(start_sec, end_sec, total_sec)
        .into_iter()
        .enumerate()
    {
        let mut candidates: Vec<(&str, &Path)> = Vec::new();
        if let Some(stem) = sources.stem.as_deref() {
            candidates.push(("stem", stem));
        }
        candidates.push(("mix", &sources.mix));

        for (source_label, source_path) in candidates {
            check_cancel(cancel)?;
            let window = music_detect::read_wav_mono16_window(
                source_path,
                win_start,
                SHAZAM_WINDOW_SEC,
            )
            .map_err(|e| e.to_string())?;
            if window.len() < (16_000.0 * SHAZAM_MIN_PROBE_SEC) as usize
                || window.iter().all(|sample| sample.unsigned_abs() < 8)
            {
                continue; // too short, or the timeline has no stem here
            }
            if requests > 0 {
                // Be gentle with the unofficial Shazam endpoint.
                tokio::time::sleep(std::time::Duration::from_millis(SHAZAM_PAUSE_MS)).await;
            }
            requests += 1;

            let probe_path = temp_dir.join(format!(
                "probe_{region_index}_{probe_index}_{source_label}.wav"
            ));
            let probe_path_str = probe_path.to_string_lossy().to_string();
            // Signature generation + HTTP lookup are blocking: run off the async runtime.
            let recognize_res = tokio::task::spawn_blocking(move || {
                let wav_spec = hound::WavSpec {
                    channels: 1,
                    sample_rate: 16_000,
                    bits_per_sample: 16,
                    sample_format: hound::SampleFormat::Int,
                };
                let mut writer = hound::WavWriter::create(&probe_path_str, wav_spec)
                    .map_err(|e| format!("Failed to create probe WAV: {e}"))?;
                for sample in &window {
                    writer
                        .write_sample(*sample)
                        .map_err(|e| format!("Failed to write probe WAV: {e}"))?;
                }
                writer
                    .finalize()
                    .map_err(|e| format!("Failed to finalize probe WAV: {e}"))?;

                let config = songrec::Config::default().with_quiet_mode(true);
                songrec::SongRec::new(config)
                    .recognize_from_file(&probe_path_str)
                    .map_err(|e| format!("{e}"))
            })
            .await;
            let _ = tokio::fs::remove_file(&probe_path).await;

            match recognize_res {
                Ok(Ok(rec)) => {
                    let title = if rec.artist_name.is_empty() || rec.artist_name == "Unknown" {
                        rec.song_name
                    } else {
                        format!("{} - {}", rec.artist_name, rec.song_name)
                    };
                    if !titles.contains(&title) {
                        titles.push(title);
                    }
                    break; // this probe position is resolved
                }
                Ok(Err(e)) => {
                    // "No track found" is the normal miss case; try the next source/probe.
                    tracing::debug!(
                        "Shazam: no match for region {} probe {} ({source_label}): {}",
                        region_index + 1,
                        probe_index + 1,
                        e
                    );
                }
                Err(e) => {
                    tracing::warn!(
                        "Shazam task join failed for region {}: {}",
                        region_index + 1,
                        e
                    );
                }
            }
        }
    }
    Ok(titles)
}

/// Glue neighbouring segments recognized as the same track (including gaps
/// between them) into one continuous segment.
fn merge_same_track(segments: Vec<CopyrightTimelineSegment>) -> Vec<CopyrightTimelineSegment> {
    const SAME_TRACK_MERGE_GAP_SEC: f64 = 30.0;
    let mut out: Vec<CopyrightTimelineSegment> = Vec::new();
    for seg in segments {
        if let Some(last) = out.last_mut() {
            let same_track = last.track_title.is_some() && last.track_title == seg.track_title;
            if same_track && seg.start_sec - last.end_sec <= SAME_TRACK_MERGE_GAP_SEC {
                last.end_sec = last.end_sec.max(seg.end_sec);
                last.confidence = last.confidence.max(seg.confidence);
                continue;
            }
        }
        out.push(seg);
    }
    out
}

/// Absorb short unrecognized music fragments sitting right before or after a
/// recognized track into that track's segment: they are almost always the
/// same song that the detector saw but Shazam missed at the edges.
fn absorb_small_untitled(segments: Vec<CopyrightTimelineSegment>) -> Vec<CopyrightTimelineSegment> {
    const ABSORB_GAP_SEC: f64 = 12.0;
    const ABSORB_MAX_LEN_SEC: f64 = 20.0;

    let mut out: Vec<CopyrightTimelineSegment> = Vec::new();
    for seg in segments {
        if seg.track_title.is_some() {
            // Pull in small untitled fragments directly before this track.
            let mut seg = seg;
            while let Some(last) = out.last() {
                let last_len = last.end_sec - last.start_sec;
                let gap = seg.start_sec - last.end_sec;
                if last.track_title.is_none()
                    && last_len <= ABSORB_MAX_LEN_SEC
                    && gap <= ABSORB_GAP_SEC
                {
                    let absorbed = out.pop().expect("checked by last()");
                    seg.start_sec = seg.start_sec.min(absorbed.start_sec);
                    seg.confidence = seg.confidence.max(absorbed.confidence);
                } else {
                    break;
                }
            }
            out.push(seg);
            continue;
        }

        // Untitled fragment: attach to the preceding track when small enough.
        if let Some(last) = out.last_mut() {
            let seg_len = seg.end_sec - seg.start_sec;
            let gap = seg.start_sec - last.end_sec;
            if last.track_title.is_some() && seg_len <= ABSORB_MAX_LEN_SEC && gap <= ABSORB_GAP_SEC
            {
                last.end_sec = last.end_sec.max(seg.end_sec);
                last.confidence = last.confidence.max(seg.confidence);
                continue;
            }
        }
        out.push(seg);
    }
    out
}

/// Adds the safety margin around every segment and merges the ones that now
/// overlap, keeping track names from both sides.
fn pad_segments(
    segments: Vec<CopyrightTimelineSegment>,
    total_sec: f64,
) -> Vec<CopyrightTimelineSegment> {
    let mut padded: Vec<CopyrightTimelineSegment> = segments
        .into_iter()
        .map(|seg| {
            let region = music_detect::pad_and_merge(
                vec![DetectedMusic {
                    start_sec: seg.start_sec,
                    end_sec: seg.end_sec,
                    confidence: seg.confidence as f32,
                }],
                total_sec,
            );
            let (start_sec, end_sec) = region
                .first()
                .map(|r| (r.start_sec, r.end_sec))
                .unwrap_or((seg.start_sec, seg.end_sec));
            CopyrightTimelineSegment {
                start_sec,
                end_sec,
                ..seg
            }
        })
        .collect();
    padded.sort_by(|a, b| a.start_sec.total_cmp(&b.start_sec));

    let mut out: Vec<CopyrightTimelineSegment> = Vec::with_capacity(padded.len());
    for seg in padded {
        if let Some(last) = out.last_mut() {
            if seg.start_sec <= last.end_sec {
                last.end_sec = last.end_sec.max(seg.end_sec);
                last.confidence = last.confidence.max(seg.confidence);
                last.is_commercial |= seg.is_commercial;
                last.track_title = match (last.track_title.take(), seg.track_title) {
                    (Some(a), Some(b)) if a != b => Some(format!("{a} · {b}")),
                    (Some(a), _) => Some(a),
                    (None, b) => b,
                };
                continue;
            }
        }
        out.push(seg);
    }
    out
}

fn safe_path_part(part: &str) -> String {
    part.chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seg(start: f64, end: f64, title: Option<&str>) -> CopyrightTimelineSegment {
        CopyrightTimelineSegment {
            start_sec: start,
            end_sec: end,
            confidence: 0.5,
            is_commercial: title.is_some(),
            track_title: title.map(str::to_string),
        }
    }

    #[test]
    fn probes_cover_long_regions_and_stay_inside_the_file() {
        let short = shazam_probe_starts(100.0, 120.0, 600.0);
        assert_eq!(short.len(), 1);
        assert!((short[0] - 104.0).abs() < 1e-9);

        let long = shazam_probe_starts(100.0, 220.0, 600.0);
        assert!(long.len() >= 3);
        assert!(long.iter().all(|s| *s >= 100.0 && *s + SHAZAM_WINDOW_SEC <= 220.0));
        for (i, a) in long.iter().enumerate() {
            for b in &long[i + 1..] {
                assert!((a - b).abs() >= 1.0, "duplicate probe positions: {long:?}");
            }
        }
        // mid == start + 42 for a 96 s region coincides with the second step probe.
        let coincident = shazam_probe_starts(100.0, 196.0, 600.0);
        assert_eq!(coincident.iter().filter(|s| (**s - 142.0).abs() < 1.0).count(), 1);

        let tail = shazam_probe_starts(590.0, 600.0, 600.0);
        assert!(tail.iter().all(|s| *s + SHAZAM_WINDOW_SEC <= 600.0));
    }

    #[test]
    fn padding_merges_touching_segments_and_keeps_both_titles() {
        let padded = pad_segments(
            vec![
                seg(20.0, 40.0, Some("A - One")),
                seg(50.0, 60.0, None),
                seg(200.0, 210.0, Some("B - Two")),
            ],
            215.0,
        );
        assert_eq!(padded.len(), 2);
        assert!((padded[0].start_sec - 10.0).abs() < 1e-9);
        assert!((padded[0].end_sec - 70.0).abs() < 1e-9);
        assert_eq!(padded[0].track_title.as_deref(), Some("A - One"));
        assert!(padded[0].is_commercial);
        assert!((padded[1].end_sec - 215.0).abs() < 1e-9);
    }

    /// Real-file scan without the Tauri app: the full pipeline (extraction,
    /// detection with the stem timeline and separation cache, pipelined
    /// Shazam probes, padding). Needs network. Run by hand:
    ///
    /// `FETCHR_E2E_AUDIO=<media> FETCHR_E2E_FFMPEG=<ffmpeg.exe>
    ///  cargo test --lib e2e_scan_real_file -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn e2e_scan_real_file() {
        let Ok(input) = std::env::var("FETCHR_E2E_AUDIO") else {
            eprintln!("FETCHR_E2E_AUDIO not set, skipping");
            return;
        };
        let ffmpeg = PathBuf::from(
            std::env::var("FETCHR_E2E_FFMPEG").expect("FETCHR_E2E_FFMPEG must point to ffmpeg"),
        );
        let _ = tracing_subscriber::fmt()
            .with_env_filter("fetchr=info")
            .with_writer(std::io::stderr)
            .try_init();
        let runtime = tokio::runtime::Runtime::new().unwrap();
        let started = std::time::Instant::now();
        let last = std::sync::Mutex::new(String::new());
        let report: ProgressFn = Arc::new(move |percent: f32, message: &str| {
            let mut last = last.lock().unwrap();
            if *last != message {
                eprintln!("[scan {percent:5.1}% +{:5.1}s] {message}", started.elapsed().as_secs_f64());
                *last = message.to_string();
            }
        });
        let cancel = Arc::new(AtomicBool::new(false));
        let segments = runtime
            .block_on(scan_with_progress(
                report,
                "e2e-scan",
                Path::new(&input),
                &ffmpeg,
                cancel,
            ))
            .unwrap();
        let fmt = |sec: f64| format!("{}:{:04.1}", (sec / 60.0).floor() as u64, sec % 60.0);
        for segment in &segments {
            eprintln!(
                "segment {} – {}: {:?}",
                fmt(segment.start_sec),
                fmt(segment.end_sec),
                segment.track_title
            );
        }
        eprintln!(
            "{} segments, {} named, scan took {:?}",
            segments.len(),
            segments.iter().filter(|s| s.is_commercial).count(),
            started.elapsed()
        );
        assert!(!segments.is_empty());
    }

    #[test]
    fn same_track_fragments_are_glued() {
        let glued = merge_same_track(vec![
            seg(0.0, 10.0, Some("X")),
            seg(30.0, 40.0, Some("X")),
            seg(300.0, 310.0, Some("X")),
        ]);
        assert_eq!(glued.len(), 2);
        assert!((glued[0].end_sec - 40.0).abs() < 1e-9);
    }
}
