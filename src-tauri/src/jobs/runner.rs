use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime};

use anyhow::{anyhow, Context, Result};
use once_cell::sync::Lazy;
use parking_lot::Mutex;
use regex::Regex;
use serde_json::json;
use tokio::process::{Child, Command};

use crate::binaries::{configure_ytdlp_env, resolve_binary, FFMPEG, FFPROBE, NM3U8DL, YTDLP};
use crate::chat_overlay::blur::render_blur_zones_for_video;
use crate::chat_overlay::kick_live::{is_kick_live_channel_url, start_kick_live_chat_recorder};
use crate::chat_overlay::twitch_live::start_twitch_live_chat_recorder;
use crate::chat_overlay::wtv_live::{is_wtv_live_channel_url, start_wtv_live_chat_recorder};
use crate::chat_overlay::{download_and_render_chat_only, parse_hms, render_and_compose_for_video};
use crate::commands::resolve::{
    apply_youtube_cookie_browser, classify_cookie_browser_failure, cookie_store_error,
    is_youtube_url, resolve_twitch_hls_url, youtube_cookie_auth_error,
    youtube_cookie_failure_message, youtube_cookie_retry_browsers,
};
use crate::hls_proxy;
use crate::jobs::fetchr_mute;
use crate::jobs::queue::QueueManager;
use crate::proxy::apply_proxy_env;
use crate::jobs::types::{
    AudioFormat, DownloadKind, Job, JobKind, JobProgress, JobSpec, Mode, PerformanceSettings,
    VideoCodecPolicy,
};

static RE_PERCENT: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?P<p>\d+(?:\.\d+)?)\s*%").expect("percent regex"));
static RE_SPEED: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?P<s>\d+(?:\.\d+)?\s*[KMG]i?B/s)").expect("speed regex"));
static RE_ETA: Lazy<Regex> = Lazy::new(|| Regex::new(r"ETA\s+(?P<e>[\d:]+)").expect("eta regex"));
static RE_SIZE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"of\s+~?\s*(?P<sz>\d+(?:\.\d+)?\s*[KMGT]i?B)").expect("size regex"));
static RE_SEGMENT: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?i)(?:fragment|segment|frag)\D+(?P<seg>\d+\s*/\s*\d+)").expect("segment regex")
});
static RE_DIMENSIONS: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?P<w>\d{3,5})x(?P<h>\d{3,5})").expect("dimension regex"));
const FETCHR_PROGRESS_PREFIX: &str = "FETCHR_PROGRESS|";

enum LiveChatRecorder {
    Kick(crate::chat_overlay::kick_live::KickLiveChatRecorder),
    Twitch(crate::chat_overlay::twitch_live::TwitchLiveChatRecorder),
    Wtv(crate::chat_overlay::wtv_live::WtvLiveChatRecorder),
}

impl LiveChatRecorder {
    async fn stop_and_wait(self, queue: &Arc<QueueManager>, job_id: &str) -> Result<usize> {
        match self {
            LiveChatRecorder::Kick(r) => {
                let stats = r.stop_and_wait(queue, job_id).await?;
                Ok(stats.parsed_messages)
            }
            LiveChatRecorder::Twitch(r) => {
                let stats = r.stop_and_wait(queue, job_id).await?;
                Ok(stats.parsed_messages)
            }
            LiveChatRecorder::Wtv(r) => r.stop_and_wait(queue, job_id).await,
        }
    }
}

pub async fn run_job(queue: Arc<QueueManager>, job: Job, cancel: Arc<AtomicBool>) -> Result<()> {
    let bin_dir = job.spec.binaries_dir.as_deref().map(Path::new);

    if matches!(job.spec.job_kind, Some(JobKind::Chat)) {
        queue.set_progress_stage(&job.id, 0.0, 100.0, Some("Preparing chat task".to_string()));
        let output = download_and_render_chat_only(&queue, &job, cancel.clone(), bin_dir).await?;
        queue.set_output_path(&job.id, output.to_string_lossy().into_owned());
        queue.set_progress(
            &job.id,
            JobProgress {
                percent: 100.0,
                stage_percent: None,
                stage_start: None,
                stage_end: None,
                stage_started_at: None,
                download_elapsed_ms: None,
                speed: None,
                eta: None,
                size: None,
                message: Some("Chat overlay ready".to_string()),
                ..JobProgress::default()
            },
        );
        return Ok(());
    }

    if matches!(job.spec.job_kind, Some(JobKind::FetchrMute)) {
        queue.set_progress_stage(
            &job.id,
            0.0,
            100.0,
            Some("Очистка аудио от матов (Fetchr Mute)".to_string()),
        );
        let output = run_fetchr_mute_job(&queue, &job, cancel.clone()).await?;
        queue.set_output_path(&job.id, output.to_string_lossy().into_owned());
        queue.set_progress(
            &job.id,
            JobProgress {
                percent: 100.0,
                message: Some("Очистка завершена".to_string()),
                ..JobProgress::default()
            },
        );
        return Ok(());
    }

    if matches!(job.spec.job_kind, Some(JobKind::VpsDownload)) {
        let mut output =
            crate::jobs::vps_download::run_vps_download_job(&queue, &job, cancel.clone()).await?;
        let chat_enabled = job
            .spec
            .chat_overlay
            .as_ref()
            .and_then(|settings| settings.enabled)
            .unwrap_or(false);
        let blur_enabled = job
            .spec
            .blur_zones
            .iter()
            .any(|zone| zone.enabled && zone.width > 0 && zone.height > 0);
        if (chat_enabled || blur_enabled) && !cancel.load(Ordering::SeqCst) {
            queue.set_progress_stage(
                &job.id,
                60.0,
                90.0,
                Some(if chat_enabled {
                    "Встраивание чата из VPS JSON".to_string()
                } else {
                    "Обработка зон Sponsor Blur".to_string()
                }),
            );
            let processed = if chat_enabled {
                render_and_compose_for_video(&queue, &job, &output, cancel.clone(), bin_dir).await?
            } else {
                render_blur_zones_for_video(&queue, &job, &output, cancel.clone(), bin_dir).await?
            };
            remove_replaced_file(&queue, &job.id, &output, &processed);
            output = processed;
        }
        if job.spec.fetchr_mute_enabled && !cancel.load(Ordering::SeqCst) {
            queue.set_progress_stage(&job.id, 90.0, 100.0, Some("Fetchr Mute".to_string()));
            let processed =
                run_fetchr_mute_on_local_file(&queue, &job, &output, cancel.clone()).await?;
            remove_replaced_file(&queue, &job.id, &output, &processed);
            output = processed;
        }
        queue.set_output_path(&job.id, output.to_string_lossy().into_owned());
        queue.set_progress(
            &job.id,
            JobProgress {
                percent: 100.0,
                message: Some("Клип загружен с VPS".to_string()),
                ..JobProgress::default()
            },
        );
        return Ok(());
    }

    // Routing logic:
    // - Direct HLS (plain .m3u8 or twitch cloudfront VOD) -> N_m3u8DL-RE regardless
    //   of the live toggle, because yt-dlp's generic extractor often fails on
    //   cloudfront VOD playlists.
    // - Twitch live/VOD video                             -> Twitch HLS resolver + N_m3u8DL-RE
    //   so "best" can select source resolutions above 1080p when Twitch exposes them.
    // - Otherwise (youtube/kick/clips/audio)               -> yt-dlp.
    let is_direct_hls = is_hls_url(&job.spec.url);
    let is_twitch_vod = is_twitch_vod_url(&job.spec.url);
    let requested_live_mode = matches!(job.spec.mode, Mode::Live);
    let live_mode = effective_live_mode(requested_live_mode, is_twitch_vod);
    if requested_live_mode && is_twitch_vod {
        emit_log(
            &queue,
            &job.id,
            "Twitch VOD URL detected; ignoring LIVE mode and downloading a finite VOD snapshot.",
        );
    }
    validate_download_spec(&queue, &job, is_direct_hls, is_twitch_vod, live_mode)?;
    let chat_enabled = chat_overlay_enabled(&job);
    let fetchr_mute_enabled = job.spec.fetchr_mute_enabled;
    let postprocess_enabled = video_postprocess_enabled(&job);

    // The post-download H.264 re-encode is off: it doubled the job time and
    // showed up as a second "download". Compatibility now comes only from the
    // format choice (avc1/m4a are preferred at no cost); the file is kept as is.
    let transcode_enabled = false;

    let download_end = if postprocess_enabled && fetchr_mute_enabled {
        50.0
    } else if postprocess_enabled {
        60.0
    } else if fetchr_mute_enabled {
        70.0
    } else if job.spec.split {
        95.0
    } else {
        100.0
    };
    // The codec check is a cheap ffprobe in the common case, but a full encoder
    // pass when it is not — reserve a band either way.
    const TRANSCODE_STAGE_SPAN: f32 = 20.0;
    let download_end = if transcode_enabled {
        download_end - TRANSCODE_STAGE_SPAN
    } else {
        download_end
    };

    if postprocess_enabled {
        queue.set_progress_stage(
            &job.id,
            0.0,
            download_end,
            Some("Downloading source video".to_string()),
        );
    } else {
        queue.set_progress_stage(
            &job.id,
            0.0,
            download_end,
            Some("Downloading source".to_string()),
        );
    }

    let download_started = std::time::Instant::now();
    let unmute_requested = job.spec.unmute_video
        && matches!(selected_download_kind(&job), DownloadKind::Video)
        && !live_mode;
    let selected_quality_is_hls = selected_quality_is_hls(&job.spec);
    let strict_twitch_1440 = twitch_video_quality_is_strict_1440(&job.spec);
    let twitch_video_vod =
        is_twitch_vod && matches!(selected_download_kind(&job), DownloadKind::Video);
    let twitch_vod_ytdlp_fallback_allowed =
        allow_twitch_vod_ytdlp_fallback(is_twitch_vod, has_bounded_download_range(&job.spec));
    // W.TV serves only HLS and yt-dlp has no extractor for it.
    let use_nm3u8 = is_direct_hls
        || crate::wtv::is_wtv_url(&job.spec.url)
        || selected_quality_is_hls
        || live_mode
        || twitch_video_vod
        || (is_twitch_vod && unmute_requested);
    let chat_recorder_enabled = live_mode && (chat_enabled || job.spec.record_chat_separate);
    let chat_recorder = if chat_recorder_enabled {
        if is_kick_live_channel_url(&job.spec.url) {
            let sidecar_path = kick_live_chat_sidecar_path(&job.spec);
            match start_kick_live_chat_recorder(
                queue.clone(),
                &job,
                bin_dir,
                sidecar_path,
                cancel.clone(),
            )
            .await
            {
                Ok(recorder) => Some(LiveChatRecorder::Kick(recorder)),
                Err(err) => return Err(err.context("Kick live chat recorder could not start")),
            }
        } else if is_twitch_url(&job.spec.url) {
            let sidecar_path = twitch_live_chat_sidecar_path(&job.spec);
            match start_twitch_live_chat_recorder(queue.clone(), &job, sidecar_path, cancel.clone())
                .await
            {
                Ok(recorder) => Some(LiveChatRecorder::Twitch(recorder)),
                Err(err) => return Err(err.context("Twitch live chat recorder could not start")),
            }
        } else if is_wtv_live_channel_url(&job.spec.url) {
            let sidecar_path = wtv_live_chat_sidecar_path(&job.spec);
            match start_wtv_live_chat_recorder(queue.clone(), &job, sidecar_path, cancel.clone())
                .await
            {
                Ok(recorder) => Some(LiveChatRecorder::Wtv(recorder)),
                Err(err) => return Err(err.context("W.TV live chat recorder could not start")),
            }
        } else {
            None
        }
    } else {
        None
    };

    let download_result: Result<Vec<PathBuf>> = if use_nm3u8 {
        match run_nm3u8_fragments(&queue, &job, cancel.clone(), bin_dir, live_mode).await {
            Ok(paths) => Ok(paths),
            Err(err)
                if unmute_requested
                    && is_twitch_vod
                    && !is_direct_hls
                    && twitch_vod_ytdlp_fallback_allowed =>
            {
                emit_log(
                    &queue,
                    &job.id,
                    &format!(
                        "!! Twitch VOD audio restore failed, falling back to ordinary yt-dlp download: {err:?}"
                    ),
                );
                run_ytdlp_fragments(&queue, &job, cancel.clone(), bin_dir)
                    .await
                    .with_context(|| format!("unmute failed ({err}); ordinary fallback failed"))
            }
            Err(err) if twitch_video_vod && !twitch_vod_ytdlp_fallback_allowed => {
                emit_log(
                    &queue,
                    &job.id,
                    &format!(
                        "!! Twitch VOD HLS download failed; yt-dlp fallback is skipped for full VOD downloads because active Twitch VOD playlists can be recorded endlessly by ffmpeg. Set a time range or retry N_m3u8DL-RE. Error: {err:?}"
                    ),
                );
                Err(err)
            }
            Err(err)
                if twitch_video_vod
                    && !selected_quality_is_hls
                    && !is_direct_hls
                    && !strict_twitch_1440
                    && twitch_vod_ytdlp_fallback_allowed =>
            {
                emit_log(
                    &queue,
                    &job.id,
                    &format!(
                        "!! Twitch HLS source download failed, falling back to yt-dlp: {err:?}"
                    ),
                );
                run_ytdlp_fragments(&queue, &job, cancel.clone(), bin_dir)
                    .await
                    .with_context(|| format!("Twitch HLS failed ({err}); yt-dlp fallback failed"))
            }
            Err(err) => Err(err),
        }
    } else {
        run_ytdlp_fragments(&queue, &job, cancel.clone(), bin_dir).await
    };
    let chat_stats = if let Some(recorder) = chat_recorder {
        Some(recorder.stop_and_wait(&queue, &job.id).await)
    } else {
        None
    };
    let mut saved_paths = download_result?;
    // Chat recording is best-effort: an empty chat or a chat-recorder failure must
    // NOT fail the video recording itself (the stream is already saved).
    if let Some(res) = chat_stats {
        match res {
            Ok(0) => emit_log(
                &queue,
                &job.id,
                "!! Чат: записано 0 сообщений (чат пуст или не активен) — сохраняю запись без чата.",
            ),
            Ok(count) => emit_log(
                &queue,
                &job.id,
                &format!("Чат: записано {count} сообщений."),
            ),
            Err(err) => emit_log(
                &queue,
                &job.id,
                &format!("!! Чат не записан ({err:#}) — сохраняю запись без чата."),
            ),
        }
    }
    let download_elapsed = download_started.elapsed();
    let download_elapsed_ms = download_elapsed.as_millis().min(i64::MAX as u128) as i64;
    queue.set_download_elapsed(&job.id, download_elapsed_ms);
    emit_log(
        &queue,
        &job.id,
        &format!(
            "Source download time: {}",
            format_duration(download_elapsed.as_secs_f64())
        ),
    );

    if transcode_enabled && !cancel.load(Ordering::SeqCst) {
        queue.set_progress_stage(
            &job.id,
            download_end,
            download_end + TRANSCODE_STAGE_SPAN,
            Some("Checking output codecs".to_string()),
        );
        let performance = performance_settings(&job.spec);
        let mut normalized = Vec::new();
        for path in saved_paths.iter() {
            normalized.push(
                crate::jobs::transcode::ensure_compatible(
                    &queue,
                    &job,
                    &cancel,
                    path,
                    bin_dir,
                    &performance,
                )
                .await?,
            );
        }
        if !normalized.is_empty() {
            saved_paths = normalized;
        }
    }

    if postprocess_enabled {
        let chat_end = if fetchr_mute_enabled {
            80.0
        } else if job.spec.split {
            95.0
        } else {
            100.0
        };
        queue.set_progress_stage(
            &job.id,
            download_end,
            chat_end,
            Some(if chat_enabled {
                "Rendering chat overlay".to_string()
            } else {
                "Rendering sponsor blur".to_string()
            }),
        );
        let mut composed_paths = Vec::new();
        for path in saved_paths.iter() {
            let composed = if chat_enabled {
                render_and_compose_for_video(&queue, &job, path, cancel.clone(), bin_dir).await?
            } else {
                render_blur_zones_for_video(&queue, &job, path, cancel.clone(), bin_dir).await?
            };
            remove_replaced_file(&queue, &job.id, path, &composed);
            composed_paths.push(composed);
        }
        if !composed_paths.is_empty() {
            saved_paths = composed_paths;
        }
    }

    if fetchr_mute_enabled && !cancel.load(Ordering::SeqCst) {
        let fm_start = if postprocess_enabled { 80.0 } else { 70.0 };
        let fm_end = if job.spec.split { 95.0 } else { 100.0 };
        queue.set_progress_stage(
            &job.id,
            fm_start,
            fm_end,
            Some("Очистка аудио от матов (Fetchr Mute)".to_string()),
        );
        let mut fetchr_muted_paths = Vec::new();
        for path in saved_paths.iter() {
            let fetchr_muted =
                run_fetchr_mute_on_local_file(&queue, &job, path, cancel.clone()).await?;
            remove_replaced_file(&queue, &job.id, path, &fetchr_muted);
            fetchr_muted_paths.push(fetchr_muted);
        }
        if !fetchr_muted_paths.is_empty() {
            saved_paths = fetchr_muted_paths;
        }
    }

    if job.spec.split && !cancel.load(Ordering::SeqCst) {
        queue.set_progress_stage(
            &job.id,
            95.0,
            100.0,
            Some("Splitting output file".to_string()),
        );
        for path in saved_paths.iter() {
            split_file_path(&queue, &job, path, bin_dir).await?;
        }
    }

    if let Some(first) = saved_paths.first() {
        queue.set_output_path(&job.id, first.to_string_lossy().into_owned());
    }

    Ok(())
}

/// Delete a stage's input file once its replacement was produced, so chained modes
/// (chat overlay -> fetchr mute -> ...) leave a single final file instead of one per stage.
/// The input is kept if the stage returned it unchanged or the output looks invalid.
fn remove_replaced_file(queue: &Arc<QueueManager>, job_id: &str, replaced: &Path, output: &Path) {
    if replaced == output {
        return;
    }
    let output_ok = output
        .metadata()
        .map(|meta| meta.is_file() && meta.len() > 0)
        .unwrap_or(false);
    if !output_ok {
        return;
    }
    match std::fs::remove_file(replaced) {
        Ok(()) => emit_log(
            queue,
            job_id,
            &format!("Удалён промежуточный файл {}", replaced.display()),
        ),
        Err(err) => emit_log(
            queue,
            job_id,
            &format!(
                "!! Не удалось удалить промежуточный файл {}: {err}",
                replaced.display()
            ),
        ),
    }
}

/// Returns true if the URL is a direct HLS media playlist or a known Twitch
/// CDN VOD host that yt-dlp's Generic extractor can't always digest.
fn is_hls_url(url: &str) -> bool {
    let u = url.to_lowercase();
    u.contains(".m3u8") || u.contains("cloudfront.net")
}

fn is_twitch_vod_url(url: &str) -> bool {
    let u = url.to_lowercase();
    (u.contains("twitch.tv/videos/")
        || u.contains("twitch.tv/video/")
        || u.contains("twitch.tv/v/"))
        && !u.contains(".m3u8")
}

fn selected_download_kind(job: &Job) -> DownloadKind {
    job.spec.download_kind.unwrap_or(DownloadKind::Video)
}

fn selected_codec_policy(spec: &JobSpec) -> VideoCodecPolicy {
    spec.video_codec_policy.unwrap_or_default()
}

fn selected_audio_format(spec: &JobSpec) -> AudioFormat {
    spec.audio_format.unwrap_or_default()
}

fn kick_live_chat_sidecar_path(spec: &JobSpec) -> PathBuf {
    PathBuf::from(&spec.directory).join(format!(
        "{}_kick_live_chat.json",
        output_stem(&spec.name, None::<&ActiveFragment>)
    ))
}

fn wtv_live_chat_sidecar_path(spec: &JobSpec) -> PathBuf {
    PathBuf::from(&spec.directory).join(format!(
        "{}_wtv_live_chat.json",
        output_stem(&spec.name, None::<&ActiveFragment>)
    ))
}

fn twitch_live_chat_sidecar_path(spec: &JobSpec) -> PathBuf {
    PathBuf::from(&spec.directory).join(format!(
        "{}_twitch_live_chat.json",
        output_stem(&spec.name, None::<&ActiveFragment>)
    ))
}

fn performance_settings(spec: &JobSpec) -> PerformanceSettings {
    spec.performance.clone().unwrap_or_default().with_defaults()
}

fn effective_nm3u8_thread_count(
    queue: &Arc<QueueManager>,
    job_id: &str,
    requested: u32,
    twitch_vod_archive: bool,
) -> u32 {
    let requested = requested.clamp(1, 64);
    if twitch_vod_archive {
        let effective = requested.min(6);
        if effective != requested {
            emit_log(
                queue,
                job_id,
                &format!(
                    "Twitch VOD archive: limiting HLS download threads to {effective} to reduce CDN 403 errors."
                ),
            );
        }
        return effective;
    }
    requested
}

fn validate_download_spec(
    queue: &Arc<QueueManager>,
    job: &Job,
    is_direct_hls: bool,
    is_twitch_vod: bool,
    live_mode: bool,
) -> Result<()> {
    let spec = &job.spec;
    if spec.url.trim().is_empty() {
        return Err(anyhow!("download URL is empty"));
    }
    if spec.name.trim().is_empty() {
        return Err(anyhow!("output file name is empty"));
    }
    let dir = PathBuf::from(spec.directory.trim());
    if spec.directory.trim().is_empty() {
        return Err(anyhow!("output directory is empty"));
    }
    std::fs::create_dir_all(&dir)
        .with_context(|| format!("create output directory {}", dir.display()))?;
    if !dir.is_dir() {
        return Err(anyhow!("output path is not a directory: {}", dir.display()));
    }
    let probe_path = dir.join(format!(".fetchr-write-test-{}.tmp", job.id));
    std::fs::write(&probe_path, b"write-test")
        .with_context(|| format!("check write access to {}", dir.display()))?;
    let _ = std::fs::remove_file(&probe_path);

    let selected_quality_is_hls = selected_quality_is_hls(spec);
    emit_log(
        queue,
        &job.id,
        &format!(
            "Preflight OK: url={}, direct_hls={}, twitch_vod={}, selected_m3u8={}, live={}, directory={}",
            spec.url.trim(),
            is_direct_hls,
            is_twitch_vod,
            selected_quality_is_hls,
            live_mode,
            dir.display()
        ),
    );
    Ok(())
}

fn selected_quality_is_hls(spec: &JobSpec) -> bool {
    spec.quality
        .as_deref()
        .map(|q| q.to_lowercase().contains(".m3u8"))
        .unwrap_or(false)
}

fn effective_live_mode(requested_live_mode: bool, is_twitch_vod: bool) -> bool {
    requested_live_mode && !is_twitch_vod
}

fn has_bounded_download_range(spec: &JobSpec) -> bool {
    !normalized_fragments(spec).is_empty()
}

fn allow_twitch_vod_ytdlp_fallback(is_twitch_vod: bool, has_bounded_download_range: bool) -> bool {
    !is_twitch_vod || has_bounded_download_range
}

fn twitch_video_quality_is_strict_1440(spec: &JobSpec) -> bool {
    is_twitch_url(&spec.url)
        && matches!(selected_download_kind_from_spec(spec), DownloadKind::Video)
        && requested_spec_height(spec).is_some_and(|height| height >= 1440)
}

fn selected_download_kind_from_spec(spec: &JobSpec) -> DownloadKind {
    spec.download_kind.unwrap_or(DownloadKind::Video)
}

#[derive(Debug, Clone)]
struct ActiveFragment {
    start: String,
    end: String,
    suffix: Option<String>,
}

fn normalized_fragments(spec: &JobSpec) -> Vec<ActiveFragment> {
    let fragments: Vec<_> = spec
        .fragments
        .iter()
        .filter_map(|fragment| {
            let start = fragment.start.trim();
            let end = fragment.end.trim();
            if end.is_empty() {
                return None;
            }
            // An empty start means "from the beginning"; dropping the whole
            // range made the job download the entire recording.
            let start = if start.is_empty() { "00:00:00" } else { start };
            Some((start.to_string(), end.to_string()))
        })
        .collect();

    if !fragments.is_empty() {
        return fragments
            .into_iter()
            .enumerate()
            .map(|(idx, (start, end))| ActiveFragment {
                start,
                end,
                suffix: Some(format!("_part{:02}", idx + 1)),
            })
            .collect();
    }

    let start = spec.start.as_deref().map(str::trim).filter(|s| !s.is_empty());
    let end = spec.end.as_deref().map(str::trim).filter(|s| !s.is_empty());
    match (start.or(end.map(|_| "00:00:00")), end) {
        (Some(start), Some(end)) => {
            vec![ActiveFragment {
                start: start.to_string(),
                end: end.trim().to_string(),
                suffix: None,
            }]
        }
        _ => Vec::new(),
    }
}

fn output_stem(base: &str, fragment: Option<&ActiveFragment>) -> String {
    match fragment.and_then(|f| f.suffix.as_deref()) {
        Some(suffix) => sanitize(&format!("{base}{suffix}")),
        None => sanitize(base),
    }
}

/// Audio half of a video selector. Under [`VideoCodecPolicy::Compatible`] we
/// ask for m4a first: YouTube's default `bestaudio` is Opus, which `--remux-video
/// mp4` will happily copy into an MP4 that Premiere Pro cannot read at all.
/// Costs nothing — it is still a plain stream copy.
fn audio_preference(policy: VideoCodecPolicy) -> &'static [&'static str] {
    match policy {
        VideoCodecPolicy::Compatible => &["bestaudio[ext=m4a]", "bestaudio"],
        VideoCodecPolicy::Best => &["bestaudio"],
    }
}

/// Selector for [`DownloadKind::Audio`]. m4a/opus are copied out of the source
/// untouched; mp3 is the only one that pays for an encoder pass.
fn ytdlp_audio_selector(format: AudioFormat) -> String {
    match format {
        AudioFormat::M4a => "bestaudio[ext=m4a]/bestaudio/best".to_string(),
        AudioFormat::Opus => "bestaudio[ext=webm]/bestaudio/best".to_string(),
        AudioFormat::Mp3 => "bestaudio/best".to_string(),
    }
}

fn ytdlp_format_selector(spec: &JobSpec, download_kind: DownloadKind) -> String {
    let policy = selected_codec_policy(spec);
    let audio = audio_preference(policy);

    match (download_kind, spec.quality.as_deref()) {
        (DownloadKind::Audio, Some(q)) if !q.is_empty() && q != "best" => q.to_string(),
        (DownloadKind::Audio, _) => ytdlp_audio_selector(selected_audio_format(spec)),
        (DownloadKind::Video, Some(q)) if !q.is_empty() && q != "best" => {
            let mut alternatives = Vec::new();

            // The exact format the user picked comes first. This used to be
            // discarded whenever a height was known, which made every rendition
            // of a given resolution download byte-for-byte the same file.
            if spec.quality_has_video == Some(true) && spec.quality_has_audio != Some(true) {
                alternatives.extend(audio.iter().map(|a| format!("{q}+{a}")));
            } else {
                alternatives.push(q.to_string());
            }

            // Everything below is a safety net for when that format id has
            // expired between resolving and downloading.
            if let Some(height) = requested_spec_height(spec) {
                if matches!(policy, VideoCodecPolicy::Compatible) {
                    alternatives.extend(
                        audio
                            .iter()
                            .map(|a| format!("bestvideo[vcodec^=avc1][height<={height}]+{a}")),
                    );
                }
                alternatives.extend(
                    audio
                        .iter()
                        .map(|a| format!("bestvideo[height<={height}]+{a}")),
                );
                alternatives.push(format!("best[height<={height}]"));
            }
            alternatives.extend(audio.iter().map(|a| format!("bestvideo+{a}")));
            alternatives.push("best".to_string());
            alternatives.join("/")
        }
        (DownloadKind::Video, _) => {
            let mut alternatives = Vec::new();
            if matches!(policy, VideoCodecPolicy::Compatible) {
                alternatives.extend(audio.iter().map(|a| format!("bestvideo[vcodec^=avc1]+{a}")));
            }
            alternatives.extend(audio.iter().map(|a| format!("bestvideo+{a}")));
            alternatives.push("best".to_string());
            alternatives.join("/")
        }
    }
}

async fn run_ytdlp_fragments(
    queue: &Arc<QueueManager>,
    job: &Job,
    cancel: Arc<AtomicBool>,
    bin_dir: Option<&Path>,
) -> Result<Vec<PathBuf>> {
    let ytdlp = resolve_binary(YTDLP, bin_dir)
        .ok_or_else(|| anyhow!("yt-dlp.exe not found - set binaries folder in Settings"))?;

    let spec = &job.spec;
    let performance = performance_settings(spec);
    let network_threads = performance.network_threads().to_string();
    let dir = PathBuf::from(&spec.directory);
    let download_kind = selected_download_kind(job);
    let fragments = normalized_fragments(spec);
    let work: Vec<Option<ActiveFragment>> = if fragments.is_empty() {
        vec![None]
    } else {
        fragments.into_iter().map(Some).collect()
    };
    let mut saved_paths = Vec::new();
    let stem_claims = StemClaims::new(job.id.clone());

    for fragment in work.iter() {
        if cancel.load(Ordering::SeqCst) {
            return Err(anyhow!("cancelled"));
        }

        let audio_format = selected_audio_format(spec);
        let expected_ext = match download_kind {
            DownloadKind::Video => "mp4",
            DownloadKind::Audio => audio_format.extension(),
        };
        // Only claim a fresh name when nothing of this job is on disk yet:
        // `--continue` plus a restart must land on the same file, while a
        // brand new job that happens to share a name must not resume someone
        // else's leftover .part.
        let name = unique_download_stem(
            &stem_claims,
            &dir,
            &output_stem(&spec.name, fragment.as_ref()),
            expected_ext,
        );
        let expected_path = dir.join(format!("{name}.{expected_ext}"));
        let out_template = dir.join(format!("{name}.%(ext)s"));

        if let Some(fragment) = fragment.as_ref() {
            emit_log(
                queue,
                &job.id,
                &format!(
                    "Downloading fragment {}-{} as {name}",
                    fragment.start, fragment.end
                ),
            );
        }

        let format_selector = ytdlp_format_selector(spec, download_kind);
        let mut cookie_retry_enabled = false;
        let mut last_cookie_error = None;
        let mut cookie_failures = Vec::new();

        for cookie_browser in
            std::iter::once(None).chain(youtube_cookie_retry_browsers().iter().copied().map(Some))
        {
            if cookie_browser.is_some() && !cookie_retry_enabled {
                break;
            }

            let mut cmd = Command::new(&ytdlp);
            configure_ytdlp_env(&mut cmd);
            cmd.kill_on_drop(true)
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());

            cmd.args([
                "--newline",
                // The frozen yt-dlp.exe ignores PYTHONIOENCODING and drops every
                // non-cp125x character from its console lines, so a Cyrillic
                // destination lost all of its letters in the job log.
                "--encoding",
                "utf-8",
                "-i",
                "--no-check-certificates",
                "--no-warnings",
                // Without this a "watch?v=X&list=Y" link downloads the whole
                // playlist into one -o template, overwriting a single file.
                "--no-playlist",
                "--progress",
                "--progress-template",
                "download:FETCHR_PROGRESS|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s|%(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s|%(progress._total_bytes_str)s",
                "--concurrent-fragments",
                &network_threads,
                "--no-mtime",
                // Keep partial .part files and resume them on restart so a
                // cancelled/failed download continues instead of starting over.
                "--continue",
                "--add-header",
                "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
                "-o",
            ])
            .arg(&out_template);

            match download_kind {
                DownloadKind::Video => {
                    cmd.args(["--merge-output-format", "mp4", "--remux-video", "mp4"]);
                }
                DownloadKind::Audio => {
                    cmd.arg("--extract-audio");
                    if audio_format.needs_reencode() {
                        cmd.args([
                            "--audio-format",
                            audio_format.extension(),
                            "--audio-quality",
                            "0",
                        ]);
                    } else {
                        // "best" keeps the source codec, so m4a/opus are a
                        // stream copy instead of a lossy transcode.
                        cmd.args(["--audio-format", "best"]);
                    }
                }
            }

            if let Some(ff) = resolve_binary(FFMPEG, bin_dir) {
                cmd.arg("--ffmpeg-location").arg(&ff);
            }

            if is_twitch_url(&spec.url) && !spec.url.contains("cloudfront.net") {
                cmd.args(["--add-header", "Referer: https://www.twitch.tv/"]);
            }
            // `--add-header` is global: on a YouTube job the Twitch token went
            // to Google with every request, and its Cookie header made yt-dlp
            // print a cookies warning that tripped the browser-cookie retry loop.
            let twitch_token = spec
                .twitch_auth_token
                .as_deref()
                .map(str::trim)
                .filter(|token| !token.is_empty())
                .filter(|_| is_twitch_url(&spec.url) || is_twitch_cdn_url(&spec.url));
            if let Some(token) = twitch_token {
                cmd.args(["--add-header", &format!("Authorization: OAuth {token}")]);
                cmd.args(["--add-header", &format!("Cookie: auth-token={token}")]);
            }

            if let Some(fragment) = fragment.as_ref() {
                cmd.args([
                    "--download-sections",
                    &format!("*{}-{}", fragment.start, fragment.end),
                ]);
            }

            cmd.args(["-f", &format_selector]);

            if let Some(browser) = cookie_browser {
                emit_log(
                    queue,
                    &job.id,
                    &format!("Retrying YouTube download with cookies from {browser}."),
                );
                apply_youtube_cookie_browser(&mut cmd, browser);
            }

            if let Some(px) = spec.proxy.for_ytdlp() {
                cmd.args(["--proxy", &px]);
            }
            // yt-dlp finds the OS proxy by itself; the ffmpeg it spawns for
            // --download-sections does not and went direct, which is a 20 s
            // TLS timeout wherever the direct route is blocked. Hand it down.
            if let Some(px) = spec.proxy.effective() {
                apply_proxy_env(&mut cmd, &px);
            }

            cmd.arg(&spec.url);

            emit_log(queue, &job.id, &format!("$ {}", debug_cmd(&ytdlp, &cmd)));

            match stream_process(queue, job, cancel.clone(), cmd).await {
                Ok(()) => {
                    last_cookie_error = None;
                    break;
                }
                Err(err)
                    if cookie_browser.is_none()
                        && is_youtube_url(&spec.url)
                        && youtube_cookie_auth_error(&format!("{err:#}")) =>
                {
                    cookie_retry_enabled = true;
                    last_cookie_error = Some(err);
                    continue;
                }
                Err(err) if cookie_retry_enabled => {
                    if let Some(browser) = cookie_browser {
                        cookie_failures.push((browser, classify_cookie_browser_failure(&format!("{err:#}"))));
                    }
                    last_cookie_error = Some(err);
                    continue;
                }
                Err(err) => return Err(err),
            }
        }

        if let Some(err) = last_cookie_error {
            return Err(err.context(youtube_cookie_failure_message(&cookie_failures)));
        }

        let final_path = find_output_file(&dir, &name);
        if let Some(p) = final_path {
            emit_log(queue, &job.id, &format!("saved: {}", p.display()));
            saved_paths.push(p);
        } else {
            return Err(anyhow!(
                "yt-dlp finished but no output file found near {}",
                expected_path.display()
            ));
        }
    }

    if let Some(first) = saved_paths.first() {
        queue.set_output_path(&job.id, first.to_string_lossy().into_owned());
    }
    Ok(saved_paths)
}

/// Find the saved file by sanitized name prefix in the directory.
/// Return `path` if it is free, otherwise append " (1)", " (2)", ... before the
/// extension until an unused name is found. Prevents a new download/render from
/// clobbering an existing file that happens to share its name.
fn unique_output_path(path: &Path) -> PathBuf {
    if !path.exists() {
        return path.to_path_buf();
    }
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    let stem = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("output");
    let ext = path.extension().and_then(|s| s.to_str());
    let mut n = 1u32;
    loop {
        let name = match ext {
            Some(e) => format!("{stem} ({n}).{e}"),
            None => format!("{stem} ({n})"),
        };
        let candidate = parent.join(name);
        if !candidate.exists() {
            return candidate;
        }
        n += 1;
    }
}

/// True when yt-dlp left a resumable artefact for this stem.
fn has_partial_download(dir: &Path, stem: &str) -> bool {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return false;
    };
    let prefix = format!("{stem}.");
    entries.filter_map(|e| e.ok()).any(|entry| {
        let file_name = entry.file_name();
        let Some(name) = file_name.to_str() else {
            return false;
        };
        name.starts_with(&prefix) && (name.ends_with(".part") || name.ends_with(".ytdl"))
    })
}

/// Pick a stem yt-dlp can write to without clobbering an unrelated file.
///
/// Unlike [`unique_output_path`] this has to stay compatible with `--continue`:
/// a leftover `.part` for the stem means an earlier attempt of *this* job, so
/// the name must be reused or the download restarts from zero. Only a finished
/// file of the same name forces a numbered suffix.
///
/// Output names claimed by running jobs, as (lowercase path stem, job id).
/// Two parallel downloads with the same title in one folder used to pick the
/// same name (the second even "resumed" the first one's .part) and fight over
/// one file; a claim lives until its job's download function returns.
static CLAIMED_STEMS: std::sync::Mutex<Vec<(String, String)>> = std::sync::Mutex::new(Vec::new());

struct StemClaims {
    job_id: String,
}

impl StemClaims {
    fn new(job_id: String) -> Self {
        Self { job_id }
    }

    /// True when the stem is free or already ours; claims it in that case.
    fn claim(&self, dir: &Path, stem: &str) -> bool {
        let key = dir.join(stem).to_string_lossy().to_lowercase();
        let mut claims = CLAIMED_STEMS.lock().unwrap_or_else(|e| e.into_inner());
        match claims.iter().find(|(k, _)| *k == key) {
            Some((_, owner)) => *owner == self.job_id,
            None => {
                claims.push((key, self.job_id.clone()));
                true
            }
        }
    }
}

impl Drop for StemClaims {
    fn drop(&mut self) {
        let mut claims = CLAIMED_STEMS.lock().unwrap_or_else(|e| e.into_inner());
        claims.retain(|(_, owner)| *owner != self.job_id);
    }
}

fn unique_download_stem(claims: &StemClaims, dir: &Path, stem: &str, ext: &str) -> String {
    let mut candidate = stem.to_string();
    let mut n = 1u32;
    loop {
        if claims.claim(dir, &candidate) {
            if has_partial_download(dir, &candidate) {
                return candidate;
            }
            if find_output_file(dir, &candidate).is_none()
                && !dir.join(format!("{candidate}.{ext}")).exists()
            {
                return candidate;
            }
        }
        candidate = format!("{stem} ({n})");
        n += 1;
    }
}

fn find_output_file(dir: &Path, name: &str) -> Option<PathBuf> {
    let exact = dir.join(format!("{name}.mp4"));
    if exact.is_file() {
        return Some(exact);
    }
    std::fs::read_dir(dir)
        .ok()?
        .filter_map(|e| e.ok())
        .find_map(|e| {
            let p = e.path();
            let stem = p.file_stem().and_then(|s| s.to_str()).unwrap_or("");
            let ext = p.extension().and_then(|s| s.to_str()).unwrap_or("");
            if p.is_file()
                && stem == name
                && matches!(
                    ext,
                    "mp4"
                        | "mkv"
                        | "ts"
                        | "webm"
                        | "m4a"
                        | "mov"
                        | "mp3"
                        | "aac"
                        | "opus"
                        | "ogg"
                        | "wav"
                        | "flac"
                )
            {
                Some(p)
            } else {
                None
            }
        })
}

fn find_output_file_since(dir: &Path, name: &str, since: SystemTime) -> Option<PathBuf> {
    find_output_file(dir, name).filter(|path| {
        let Ok(meta) = path.metadata() else {
            return false;
        };
        if meta.len() == 0 {
            return false;
        }
        meta.modified()
            .map(|modified| modified >= since)
            .unwrap_or(true)
    })
}

fn debug_cmd(bin: &Path, cmd: &Command) -> String {
    let std = cmd.as_std();
    let mut out = String::new();
    out.push_str(&quote_arg(bin.to_string_lossy().as_ref()));
    for a in std.get_args() {
        out.push(' ');
        out.push_str(&quote_arg(a.to_string_lossy().as_ref()));
    }
    out
}

fn debug_cmd_from_command(cmd: &Command) -> String {
    let std = cmd.as_std();
    let mut out = quote_arg(&std.get_program().to_string_lossy());
    for a in std.get_args() {
        out.push(' ');
        out.push_str(&quote_arg(a.to_string_lossy().as_ref()));
    }
    out
}

fn quote_arg(s: &str) -> String {
    if s.is_empty() {
        return "\"\"".into();
    }
    if s.chars().any(|c| c == ' ' || c == '"') {
        format!("\"{}\"", s.replace('"', "\\\""))
    } else {
        s.to_string()
    }
}

fn chat_overlay_enabled(job: &Job) -> bool {
    job.spec
        .chat_overlay
        .as_ref()
        .and_then(|settings| settings.enabled)
        .unwrap_or(false)
}

/// True when the downloaded video goes through a chat or sponsor-blur render,
/// which re-encodes it into a fresh MP4 anyway.
fn video_postprocess_enabled(job: &Job) -> bool {
    let sponsor_blur_enabled = job
        .spec
        .blur_zones
        .iter()
        .any(|zone| zone.enabled && zone.width > 0 && zone.height > 0);
    matches!(selected_download_kind(job), DownloadKind::Video)
        && (chat_overlay_enabled(job) || sponsor_blur_enabled)
}

/// N_m3u8DL-RE's `-M format=mp4` rewrites the merged download into a second
/// MP4 - a full extra pass over the file (about 5 minutes for a 15 GB VOD).
/// When a render follows, it reads the merged file directly and writes the
/// MP4 itself, so the mux is skipped. Live recordings keep it: their
/// real-time merge relies on it.
fn nm3u8_mux_args(job: &Job, live: bool) -> &'static [&'static str] {
    if !live && video_postprocess_enabled(job) {
        &[]
    } else {
        &["-M", "format=mp4"]
    }
}

/// After this long without file growth the recording is shown as "no signal".
/// N_m3u8DL-RE refreshes the live playlist roughly every ~13s (Twitch's HLS
/// target duration), so the temp file only grows in bursts once per cycle —
/// a 10s threshold was shorter than that normal gap and fired a false "no
/// internet" alarm on every single refresh cycle. Keep this comfortably above
/// the observed refresh interval so only a genuinely missed cycle (or worse)
/// trips it.
const LIVE_STALL_AFTER_MS: i64 = 25_000;
/// After this long without file growth the recorder process is force-killed so
/// the reconnect loop can start a fresh attempt (N_m3u8DL-RE can hang retrying).
const LIVE_FORCE_RESTART_AFTER_MS: i64 = 120_000;
/// Hard cap on automatic reconnect attempts for one recording.
const LIVE_MAX_RECONNECTS: u32 = 500;

fn now_epoch_ms() -> i64 {
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_millis().min(i64::MAX as u128) as i64)
        .unwrap_or(0)
}

fn live_temp_file_candidates(dir: &Path, stem: &str) -> [PathBuf; 4] {
    let work = dir.join(stem);
    [
        dir.join(format!("{stem}.mp4")),
        dir.join(format!("{stem}.ts")),
        work.join(format!("{stem}.mp4")),
        work.join(format!("{stem}.ts")),
    ]
}

fn live_temp_file_size(dir: &Path, stem: &str) -> (u64, Option<PathBuf>) {
    let mut best: (u64, Option<PathBuf>) = (0, None);
    for candidate in live_temp_file_candidates(dir, stem) {
        if let Ok(meta) = candidate.metadata() {
            if meta.is_file() && meta.len() > best.0 {
                best = (meta.len(), Some(candidate));
            }
        }
    }
    best
}

#[cfg(windows)]
fn kill_pid_tree(pid: u32) {
    use std::os::windows::process::CommandExt;
    let _ = std::process::Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .creation_flags(0x0800_0000)
        .status();
}

#[cfg(not(windows))]
fn kill_pid_tree(pid: u32) {
    let _ = std::process::Command::new("kill")
        .args(["-9", &pid.to_string()])
        .status();
}

/// Probe the real quality and media duration of a growing local recording
/// (what is actually being saved, not what was requested).
/// Returns e.g. ("1080p60 · 1920×1080", Some(372.5)).
async fn probe_local_recording_info(
    path: &Path,
    bin_dir: Option<&Path>,
) -> Result<(String, Option<f64>)> {
    let ffprobe = resolve_binary(FFPROBE, bin_dir).ok_or_else(|| anyhow!("ffprobe not found"))?;
    let mut cmd = Command::new(&ffprobe);
    #[cfg(windows)]
    {
        cmd.creation_flags(0x0800_0000);
    }
    cmd.kill_on_drop(true)
        .args(["-v", "error", "-select_streams", "v:0"])
        .args([
            "-show_entries",
            "stream=width,height,avg_frame_rate:format=duration",
        ])
        .args(["-of", "json"])
        .arg(path);
    let output = tokio::time::timeout(Duration::from_secs(20), cmd.output())
        .await
        .context("ffprobe timed out probing local recording")??;
    let json: serde_json::Value =
        serde_json::from_slice(&output.stdout).context("ffprobe returned invalid json")?;
    let stream = json
        .get("streams")
        .and_then(|s| s.as_array())
        .and_then(|a| a.first())
        .ok_or_else(|| anyhow!("ffprobe returned no stream info"))?;
    let width = stream
        .get("width")
        .and_then(|v| v.as_u64())
        .ok_or_else(|| anyhow!("no width"))? as u32;
    let height = stream
        .get("height")
        .and_then(|v| v.as_u64())
        .ok_or_else(|| anyhow!("no height"))? as u32;
    let fps = stream
        .get("avg_frame_rate")
        .and_then(|v| v.as_str())
        .and_then(|rate| {
            let mut nd = rate.split('/');
            let num: f64 = nd.next()?.trim().parse().ok()?;
            let den: f64 = nd.next().unwrap_or("1").trim().parse().unwrap_or(1.0);
            if den > 0.0 && num > 0.0 {
                Some((num / den).round() as u32)
            } else {
                None
            }
        })
        .unwrap_or(0);
    let duration = json
        .get("format")
        .and_then(|f| f.get("duration"))
        .and_then(|d| d.as_str())
        .and_then(|s| s.trim().parse::<f64>().ok())
        .filter(|d| d.is_finite() && *d > 0.0);
    let quality = if fps > 0 {
        format!("{height}p{fps} · {width}×{height}")
    } else {
        format!("{height}p · {width}×{height}")
    };
    Ok((quality, duration))
}

/// Background watcher for a live recording attempt: tracks real file growth to
/// drive the "recording / no signal" indicator, probes the actual quality once
/// data exists, and force-restarts a recorder that hangs without data.
#[allow(clippy::too_many_arguments)]
fn spawn_live_monitor(
    queue: Arc<QueueManager>,
    job_id: String,
    dir: PathBuf,
    temp_stem: String,
    bin_dir: Option<PathBuf>,
    pid_slot: Arc<Mutex<Option<u32>>>,
    quality_probed: Arc<AtomicBool>,
    done: Arc<AtomicBool>,
    cancel: Arc<AtomicBool>,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut last_size: u64 = 0;
        let mut last_growth_at = now_epoch_ms();
        let mut force_killed = false;
        let mut tick: u64 = 0;
        let mut probe_attempts: u32 = 0;
        loop {
            tick += 1;
            for _ in 0..10 {
                if done.load(Ordering::SeqCst) || cancel.load(Ordering::SeqCst) {
                    return;
                }
                tokio::time::sleep(Duration::from_millis(200)).await;
            }
            if done.load(Ordering::SeqCst) || cancel.load(Ordering::SeqCst) {
                return;
            }

            let (size, path) = live_temp_file_size(&dir, &temp_stem);
            let now = now_epoch_ms();
            if size > last_size {
                last_size = size;
                last_growth_at = now;
                force_killed = false;
            }
            let stalled = now - last_growth_at > LIVE_STALL_AFTER_MS;
            queue.set_live_stats(&job_id, |s| {
                s.recorded_bytes = Some(last_size.max(s.recorded_bytes.unwrap_or(0)));
                s.last_data_at = Some(last_growth_at);
                s.stalled = stalled;
            });

            // Probe aggressively until the quality is known once; afterwards
            // keep refreshing the media duration about once a minute so the UI
            // timeline matches the real footage on disk.
            let want_quality_probe = !quality_probed.load(Ordering::SeqCst)
                && size > 256 * 1024
                && tick % 3 == 1
                && probe_attempts < 30;
            let want_duration_probe =
                quality_probed.load(Ordering::SeqCst) && size > 256 * 1024 && tick % 30 == 1;
            if want_quality_probe || want_duration_probe {
                probe_attempts += 1;
                if let Some(path) = path.as_deref() {
                    if let Ok((quality, duration)) =
                        probe_local_recording_info(path, bin_dir.as_deref()).await
                    {
                        if let Some(duration) = duration {
                            queue.set_live_stats(&job_id, |s| {
                                s.media_duration_sec = Some(duration);
                            });
                        }
                        if !quality_probed.load(Ordering::SeqCst) {
                            quality_probed.store(true, Ordering::SeqCst);
                            emit_log(
                                &queue,
                                &job_id,
                                &format!("Фактическое качество записи: {quality}"),
                            );
                            queue.set_live_stats(&job_id, |s| {
                                s.detected_quality = Some(quality);
                            });
                        }
                    }
                }
            }

            if !force_killed && now - last_growth_at > LIVE_FORCE_RESTART_AFTER_MS {
                if let Some(pid) = *pid_slot.lock() {
                    emit_log(
                        &queue,
                        &job_id,
                        "!! Нет данных больше 2 минут — принудительный перезапуск рекордера.",
                    );
                    kill_pid_tree(pid);
                    force_killed = true;
                }
            }
        }
    })
}

async fn run_nm3u8_fragments(
    queue: &Arc<QueueManager>,
    job: &Job,
    cancel: Arc<AtomicBool>,
    bin_dir: Option<&Path>,
    live: bool,
) -> Result<Vec<PathBuf>> {
    let nm3u8 = resolve_binary(NM3U8DL, bin_dir)
        .ok_or_else(|| anyhow!("N_m3u8DL-RE.exe not found - set binaries folder in Settings"))?;

    let spec = &job.spec;
    let performance = performance_settings(spec);
    let direct_url = if spec.url.to_lowercase().contains(".m3u8") {
        spec.url.clone()
    } else {
        resolve_hls_url(queue, job, live, bin_dir)
            .await
            .context("failed to resolve direct HLS URL")?
    };
    let original_hls_url = direct_url.clone();
    let direct_url = maybe_proxy_unmute_hls(queue, spec, &job.id, direct_url, live);
    let is_twitch_vod_archive = !live
        && (original_hls_url.contains("cloudfront.net")
            || original_hls_url.contains("ttvnw.net")
            || is_twitch_vod_url(&spec.url));

    let fragments = normalized_fragments(spec);
    // Twitch DVR playlists carry `#EXT-X-DISCONTINUITY` markers, and
    // N_m3u8DL-RE applies `--custom-range` to each discontinuity part's own
    // timeline instead of the whole VOD, so a cut past the last part's local
    // duration selects zero segments and the run dies with "ERROR: Failed".
    // Ranged jobs therefore get a flattened local playlist.
    let flatten_discontinuities = !fragments.is_empty();
    let materialized_playlist = if is_twitch_vod_archive {
        match materialize_twitch_vod_playlist(
            queue,
            &job.id,
            &direct_url,
            spec.twitch_auth_token.as_deref(),
            flatten_discontinuities,
        )
        .await
        {
            Ok(playlist) => playlist,
            Err(err) => {
                let strict_twitch_1440 = twitch_video_quality_is_strict_1440(spec);
                emit_log(
                    queue,
                    &job.id,
                    &format!(
                        "!! Video HLS materialization failed{}: {err:#}",
                        if strict_twitch_1440 {
                            ""
                        } else {
                            ", trying original HLS URL"
                        }
                    ),
                );
                if strict_twitch_1440 {
                    return Err(
                        err.context("Selected Twitch 1440p HLS URL is not publicly downloadable")
                    );
                }
                None
            }
        }
    } else {
        None
    };
    let download_url = materialized_playlist
        .as_ref()
        .map(|path| path.to_string_lossy().into_owned())
        .unwrap_or_else(|| direct_url.clone());
    let network_threads = effective_nm3u8_thread_count(
        queue,
        &job.id,
        performance.network_threads(),
        is_twitch_vod_archive,
    )
    .to_string();

    emit_log(
        queue,
        &job.id,
        &format!("Video HLS URL resolved: {direct_url}"),
    );
    if let Some(chat_source_url) = spec.chat_source_url.as_deref() {
        emit_log(
            queue,
            &job.id,
            &format!("Chat source URL: {chat_source_url}"),
        );
    }

    let work: Vec<Option<ActiveFragment>> = if fragments.is_empty() {
        vec![None]
    } else {
        fragments.into_iter().map(Some).collect()
    };
    let mut saved_paths = Vec::new();

    for fragment in work.iter() {
        if cancel.load(Ordering::SeqCst) {
            return Err(anyhow!("cancelled"));
        }

        let save_name = output_stem(&spec.name, fragment.as_ref());
        let temp_save_name = match fragment.as_ref() {
            Some(_) => format!("fetchr_tmp_{}_{}", job.id, saved_paths.len()),
            None => format!("fetchr_tmp_{}", job.id),
        };
        if let Some(fragment) = fragment.as_ref() {
            emit_log(
                queue,
                &job.id,
                &format!(
                    "Downloading fragment {}-{} as {save_name}",
                    fragment.start, fragment.end
                ),
            );
        }

        let started_at = SystemTime::now();
        let build_nm3u8_cmd = |save_as: &str, thread_count: &str, retry_count: &str| {
            let mut cmd = Command::new(&nm3u8);
            cmd.kill_on_drop(true)
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .arg(&download_url)
                .args([
                    "--thread-count",
                    thread_count,
                    "--download-retry-count",
                    retry_count,
                    "--http-request-timeout",
                    // Live: a VPN/ISP hiccup of 30-60s must not kill the playlist
                    // refresh — N_m3u8DL-RE treats a timed-out refresh as "stream
                    // over" and exits. 90s rides out typical drops and stays below
                    // the 120s no-data force-restart watchdog.
                    if live { "90" } else { "30" },
                    "--no-ansi-color",
                    "--no-log",
                    "--save-name",
                    save_as,
                    "--save-dir",
                    &spec.directory,
                    // Keep segment temp files next to the output (not the process
                    // CWD, which under `tauri dev` is src-tauri and triggers a
                    // watcher rebuild/restart loop on every downloaded .ts).
                    "--tmp-dir",
                    &spec.directory,
                    "-H",
                    "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
                ])
                .args(nm3u8_mux_args(job, live));

            if let Some(ff) = resolve_binary(FFMPEG, bin_dir) {
                cmd.args(["--ffmpeg-binary-path"]).arg(&ff);
            }

            if is_twitch_vod_archive {
                cmd.args(["--live-perform-as-vod", "true"]);
                cmd.arg("--allow-hls-multi-ext-map");
            } else if live {
                cmd.args(["--live-real-time-merge", "true"]);
            }

            cmd.args(["-H", "Referer: https://www.twitch.tv/"]);

            if let Some(ref token) = spec.twitch_auth_token {
                if !token.trim().is_empty() {
                    cmd.args(["-H", &format!("Authorization: OAuth {}", token.trim())]);
                    cmd.args(["-H", &format!("Cookie: auth-token={}", token.trim())]);
                }
            }

            if let Some(px) = spec.proxy.for_n_m3u8dl() {
                cmd.args(["--custom-proxy", &px]);
            }

            if let Some(fragment) = fragment.as_ref() {
                cmd.args([
                    "--custom-range",
                    &format!("{}-{}", fragment.start, fragment.end),
                ]);
            }

            cmd
        };

        if is_twitch_vod_archive && live {
            emit_log(
                queue,
                &job.id,
                "LIVE toggle: Twitch VOD archive - forcing one-pass VOD mode.",
            );
        }

        // Real live recording: run with a health monitor (actual file growth,
        // detected quality, "no signal" flag) and auto-reconnect on drops.
        if live && !is_twitch_vod_archive && fragment.is_none() {
            let quality_probed = Arc::new(AtomicBool::new(false));
            let dir = PathBuf::from(&spec.directory);
            let mut attempt: u32 = 0;
            loop {
                if cancel.load(Ordering::SeqCst) {
                    break;
                }
                let temp_name = if attempt == 0 {
                    temp_save_name.clone()
                } else {
                    format!("{temp_save_name}_r{attempt}")
                };
                let attempt_started = SystemTime::now();
                let cmd = build_nm3u8_cmd(&temp_name, &network_threads, "15");
                emit_log(queue, &job.id, &format!("$ {}", debug_cmd(&nm3u8, &cmd)));

                let pid_slot = Arc::new(Mutex::new(None::<u32>));
                let attempt_done = Arc::new(AtomicBool::new(false));
                let monitor = spawn_live_monitor(
                    queue.clone(),
                    job.id.clone(),
                    dir.clone(),
                    temp_name.clone(),
                    bin_dir.map(Path::to_path_buf),
                    pid_slot.clone(),
                    quality_probed.clone(),
                    attempt_done.clone(),
                    cancel.clone(),
                );
                let result =
                    stream_process_with_pid(queue, job, cancel.clone(), cmd, Some(pid_slot)).await;
                attempt_done.store(true, Ordering::SeqCst);
                monitor.abort();

                // Keep whatever this attempt recorded — even after an error or
                // a user stop the footage on disk is valuable.
                if let Some(p) = find_output_file_since(&dir, &temp_name, attempt_started) {
                    let ext = p.extension().and_then(|s| s.to_str()).unwrap_or("mp4");
                    let target_path = unique_output_path(&dir.join(format!("{save_name}.{ext}")));
                    match std::fs::rename(&p, &target_path) {
                        Ok(()) => {
                            emit_log(queue, &job.id, &format!("saved: {}", target_path.display()));
                            // `--live-real-time-merge` + N_m3u8DL-RE's binary
                            // MuxAfterDone concatenation can leave the container's
                            // top-level duration stale/wrong (it keeps whatever the
                            // first fragment's moov claimed instead of the real
                            // accumulated length) even though the actual audio/video
                            // content is correct. Re-mux losslessly to force ffmpeg
                            // to recompute it from the real per-fragment sample data.
                            if ext.eq_ignore_ascii_case("mp4") {
                                if let Err(err) = fix_live_recording_container(
                                    queue,
                                    job,
                                    cancel.clone(),
                                    bin_dir,
                                    &target_path,
                                )
                                .await
                                {
                                    emit_log(
                                        queue,
                                        &job.id,
                                        &format!(
                                            "!! Пост-обработка длительности файла пропущена: {err:#}"
                                        ),
                                    );
                                }
                            }
                            saved_paths.push(target_path);
                        }
                        Err(err) => emit_log(
                            queue,
                            &job.id,
                            &format!("!! Не удалось переименовать файл записи: {err}"),
                        ),
                    }
                }

                match result {
                    // Recorder exited cleanly: the stream ended.
                    Ok(()) => break,
                    Err(err) => {
                        if cancel.load(Ordering::SeqCst) {
                            // Stopped by the user; keep the saved parts.
                            if saved_paths.is_empty() {
                                queue.set_live_stats(&job.id, |s| s.stalled = false);
                                return Err(err);
                            }
                            break;
                        }
                        attempt += 1;
                        if attempt > LIVE_MAX_RECONNECTS {
                            return Err(err.context("превышен лимит авто-переподключений"));
                        }
                        queue.set_live_stats(&job.id, |s| {
                            s.reconnects = attempt;
                            s.stalled = true;
                        });
                        emit_log(
                            queue,
                            &job.id,
                            &format!(
                                "!! Обрыв записи ({err:#}). Авто-переподключение через 5 с (попытка {attempt})."
                            ),
                        );
                        let mut user_cancelled = false;
                        for _ in 0..25 {
                            if cancel.load(Ordering::SeqCst) {
                                user_cancelled = true;
                                break;
                            }
                            tokio::time::sleep(Duration::from_millis(200)).await;
                        }
                        if user_cancelled {
                            break;
                        }
                    }
                }
            }
            queue.set_live_stats(&job.id, |s| s.stalled = false);
            if cancel.load(Ordering::SeqCst) && saved_paths.is_empty() {
                return Err(anyhow!("cancelled"));
            }
            emit_unmute_stats(queue, job);
            continue;
        }

        let cmd = build_nm3u8_cmd(&temp_save_name, &network_threads, "15");
        emit_log(queue, &job.id, &format!("$ {}", debug_cmd(&nm3u8, &cmd)));

        if let Err(err) = stream_process(queue, job, cancel.clone(), cmd).await {
            if is_twitch_vod_archive && is_hls_incomplete_download_error(&err) {
                emit_log(
                    queue,
                    &job.id,
                    &format!(
                        "!! Twitch CDN returned incomplete HLS segments ({err:#}); retrying this range with one download thread."
                    ),
                );
                let retry_cmd = build_nm3u8_cmd(&temp_save_name, "1", "50");
                emit_log(
                    queue,
                    &job.id,
                    &format!("$ {}", debug_cmd(&nm3u8, &retry_cmd)),
                );
                stream_process(queue, job, cancel.clone(), retry_cmd)
                    .await
                    .with_context(|| {
                        format!("serial Twitch HLS retry failed after parallel download failed ({err:#})")
                    })?;
            } else {
                return Err(err);
            }
        }
        emit_unmute_stats(queue, job);

        if let Some(p) =
            find_output_file_since(&PathBuf::from(&spec.directory), &temp_save_name, started_at)
        {
            let ext = p.extension().and_then(|s| s.to_str()).unwrap_or("mp4");
            let target_path = unique_output_path(
                &PathBuf::from(&spec.directory).join(format!("{save_name}.{ext}")),
            );
            std::fs::rename(&p, &target_path)?;
            emit_log(queue, &job.id, &format!("saved: {}", target_path.display()));
            saved_paths.push(target_path);
        } else if is_twitch_vod_archive {
            if let Some(fragment) = fragment.as_ref() {
                emit_log(
                    queue,
                    &job.id,
                    "!! N_m3u8DL-RE did not create an output file for this Twitch HLS range; trying ffmpeg fallback.",
                );
                let fallback_path = run_ffmpeg_hls_fragment_fallback(
                    queue,
                    job,
                    cancel.clone(),
                    bin_dir,
                    &download_url,
                    &save_name,
                    fragment,
                    started_at,
                )
                .await?;
                emit_log(
                    queue,
                    &job.id,
                    &format!("saved: {}", fallback_path.display()),
                );
                saved_paths.push(fallback_path);
            } else {
                let msg = format!(
                    "N_m3u8DL-RE finished but did not create a new non-empty output file for {save_name}"
                );
                emit_log(queue, &job.id, &format!("!! {msg}"));
                return Err(anyhow!(msg));
            }
        } else {
            let msg = format!(
                "N_m3u8DL-RE finished but did not create a new non-empty output file for {save_name}"
            );
            emit_log(queue, &job.id, &format!("!! {msg}"));
            return Err(anyhow!(msg));
        }
    }

    if let Some(first) = saved_paths.first() {
        queue.set_output_path(&job.id, first.to_string_lossy().into_owned());
    } else {
        return Err(anyhow!(
            "N_m3u8DL-RE finished without downloaded fragments or output files"
        ));
    }

    Ok(saved_paths)
}

async fn run_ffmpeg_hls_fragment_fallback(
    queue: &Arc<QueueManager>,
    job: &Job,
    cancel: Arc<AtomicBool>,
    bin_dir: Option<&Path>,
    playlist_url: &str,
    save_name: &str,
    fragment: &ActiveFragment,
    started_at: SystemTime,
) -> Result<PathBuf> {
    let ffmpeg = resolve_binary(FFMPEG, bin_dir)
        .ok_or_else(|| anyhow!("ffmpeg.exe not found - set binaries folder in Settings"))?;
    let start = parse_hms(Some(&fragment.start))
        .ok_or_else(|| anyhow!("invalid fragment start time: {}", fragment.start))?;
    let end = parse_hms(Some(&fragment.end))
        .ok_or_else(|| anyhow!("invalid fragment end time: {}", fragment.end))?;
    let duration = end - start;
    if duration <= 0.0 {
        return Err(anyhow!(
            "selected fragment has empty duration: {}-{}",
            fragment.start,
            fragment.end
        ));
    }

    let output =
        unique_output_path(&PathBuf::from(&job.spec.directory).join(format!("{save_name}.mp4")));
    let mut cmd = Command::new(&ffmpeg);
    cmd.kill_on_drop(true)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .args(["-y", "-hide_banner", "-loglevel", "info"])
        .args([
            "-protocol_whitelist",
            "file,http,https,tcp,tls,crypto",
            "-ss",
            &format!("{start:.3}"),
            "-i",
            playlist_url,
            "-t",
            &format!("{duration:.3}"),
            "-map",
            "0:v?",
            "-map",
            "0:a?",
            "-c",
            "copy",
            "-movflags",
            "+faststart",
        ])
        .arg(&output);
    if let Some(px) = job.spec.proxy.effective() {
        apply_proxy_env(&mut cmd, &px);
    }

    emit_log(
        queue,
        &job.id,
        &format!(
            "ffmpeg fallback range: {}-{} ({})",
            fragment.start,
            fragment.end,
            format_duration(duration)
        ),
    );
    emit_log(queue, &job.id, &format!("$ {}", debug_cmd(&ffmpeg, &cmd)));

    stream_process(queue, job, cancel, cmd).await?;

    if output.is_file()
        && output
            .metadata()
            .map(|meta| meta.len() > 0)
            .unwrap_or(false)
        && output
            .metadata()
            .and_then(|meta| meta.modified())
            .map(|modified| modified >= started_at)
            .unwrap_or(true)
    {
        return Ok(output);
    }

    Err(anyhow!(
        "ffmpeg fallback finished but did not create a new non-empty output file for {save_name}"
    ))
}

/// Losslessly re-mux a finished live recording in place to fix a stale/wrong
/// container duration.
///
/// N_m3u8DL-RE's `--live-real-time-merge` binary "MuxAfterDone" merge
/// concatenates already-muxed fragments rather than doing a full ffmpeg
/// remux; the resulting file's top-level `mvhd`/`tkhd` duration can end up
/// reflecting whatever the first fragment/init segment claimed (sometimes a
/// large, unrelated value) instead of the real accumulated length, even
/// though the actual audio/video samples are correct and complete. Demuxing
/// and re-muxing with `-c copy` forces ffmpeg to recompute the duration from
/// the real per-fragment sample tables. Best-effort: any failure leaves the
/// original file untouched (never risk losing the only copy of a recording).
async fn fix_live_recording_container(
    queue: &Arc<QueueManager>,
    job: &Job,
    cancel: Arc<AtomicBool>,
    bin_dir: Option<&Path>,
    path: &Path,
) -> Result<()> {
    let Some(ffmpeg) = resolve_binary(FFMPEG, bin_dir) else {
        return Ok(());
    };
    let fixed = path.with_extension("fixdur.mp4");

    let mut cmd = Command::new(&ffmpeg);
    cmd.kill_on_drop(true)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .args([
            "-y",
            "-hide_banner",
            "-loglevel",
            "warning",
            "-fflags",
            "+genpts",
        ])
        .arg("-i")
        .arg(path)
        // No +faststart: on a multi-hour recording it is one more full
        // rewrite of the file, and local players read the index at the end.
        .args(["-map", "0", "-c", "copy"])
        .arg(&fixed);

    emit_log(
        queue,
        &job.id,
        "Исправляю длительность файла записи (пост-обработка после live-real-time-merge)...",
    );
    emit_log(queue, &job.id, &format!("$ {}", debug_cmd(&ffmpeg, &cmd)));

    if let Err(err) = stream_process(queue, job, cancel, cmd).await {
        let _ = std::fs::remove_file(&fixed);
        return Err(err.context("ffmpeg remux failed"));
    }

    let ok = fixed.metadata().map(|meta| meta.len() > 0).unwrap_or(false);
    if !ok {
        let _ = std::fs::remove_file(&fixed);
        return Err(anyhow!("ffmpeg remux did not produce a non-empty file"));
    }

    if let Err(err) = std::fs::rename(&fixed, path) {
        let _ = std::fs::remove_file(&fixed);
        return Err(anyhow!("could not replace original with fixed file: {err}"));
    }

    Ok(())
}

fn requested_quality_height(quality: &str) -> Option<u32> {
    let lower = quality.trim().to_lowercase();
    if lower.contains(".m3u8") {
        return None;
    }
    static HEIGHT_RE: Lazy<Regex> = Lazy::new(|| {
        Regex::new(r"(?i)(?:height\s*<=\s*|height\s*=\s*|^|[^0-9])(?P<h>[1-9][0-9]{2,3})\s*p?")
            .expect("height regex")
    });
    HEIGHT_RE
        .captures(&lower)
        .and_then(|captures| captures.name("h"))
        .and_then(|height| height.as_str().parse::<u32>().ok())
}

fn requested_spec_height(spec: &JobSpec) -> Option<u32> {
    spec.quality_height
        .or_else(|| spec.quality.as_deref().and_then(requested_quality_height))
}

fn explicit_quality_label_for_height(spec: &JobSpec, height: u32) -> Option<String> {
    match spec.quality.as_deref() {
        Some(quality) if !quality.trim().is_empty() && quality != "best" => {
            if quality.to_lowercase().contains(".m3u8") {
                Some(format!("{height}p"))
            } else {
                Some(quality.to_string())
            }
        }
        _ => Some(format!("{height}p")),
    }
}

async fn materialize_twitch_vod_playlist(
    queue: &Arc<QueueManager>,
    job_id: &str,
    direct_url: &str,
    twitch_auth_token: Option<&str>,
    flatten_discontinuities: bool,
) -> Result<Option<PathBuf>> {
    if !is_twitch_cdn_url(direct_url) {
        return Ok(None);
    }

    let text = fetch_twitch_hls_playlist_text(direct_url, twitch_auth_token).await?;

    let base = url::Url::parse(direct_url).context("parse Twitch VOD media playlist URL")?;
    if text.contains("#EXT-X-ENDLIST")
        && base.query().is_none()
        && !flatten_discontinuities
        && !text.contains("-unmuted.")
    {
        return Ok(None);
    }

    let mut out = String::with_capacity(text.len() + 256);
    for line in text.lines().map(str::trim) {
        if line.is_empty() {
            out.push('\n');
            continue;
        }
        if flatten_discontinuities
            && (line == "#EXT-X-DISCONTINUITY"
                || line.starts_with("#EXT-X-DISCONTINUITY-SEQUENCE"))
        {
            continue;
        }
        if line.starts_with("#EXT-X-PLAYLIST-TYPE:EVENT") {
            out.push_str("#EXT-X-PLAYLIST-TYPE:VOD");
        } else if line.starts_with("#EXT-X-MAP:") || line.starts_with("#EXT-X-KEY:") {
            out.push_str(&absolutize_hls_uri_attrs(line, &base));
        } else if line.starts_with('#') {
            out.push_str(line);
        } else {
            out.push_str(&absolutize_hls_uri(line, &base));
        }
        out.push('\n');
    }
    if !out.contains("#EXT-X-ENDLIST") {
        out.push_str("#EXT-X-ENDLIST\n");
    }

    let out = repoint_dead_unmuted_segments(queue, job_id, out, twitch_auth_token).await;

    let path = std::env::temp_dir().join(format!("fetchr-twitch-vod-{job_id}.m3u8"));
    let mut file = std::fs::File::create(&path)
        .with_context(|| format!("create materialized playlist {}", path.display()))?;
    file.write_all(out.as_bytes())
        .with_context(|| format!("write materialized playlist {}", path.display()))?;

    emit_log(
        queue,
        job_id,
        &format!(
            "Twitch VOD playlist materialized as finite local m3u8: {}",
            path.display()
        ),
    );

    Ok(Some(path))
}

/// Twitch advertises DMCA-muted segments as `N-unmuted.ts`, but for older VODs
/// the CDN only still serves `N-muted.ts` - the advertised name answers 403 and
/// N_m3u8DL-RE burns through every retry before failing the whole range. Probe
/// one such segment and repoint the playlist when it is gone.
async fn repoint_dead_unmuted_segments(
    queue: &Arc<QueueManager>,
    job_id: &str,
    playlist: String,
    twitch_auth_token: Option<&str>,
) -> String {
    let Some(probe) = playlist
        .lines()
        .find(|line| !line.starts_with('#') && line.contains("-unmuted."))
    else {
        return playlist;
    };

    match twitch_segment_is_available(probe, twitch_auth_token).await {
        Ok(true) => playlist,
        Ok(false) => {
            emit_log(
                queue,
                job_id,
                "Twitch CDN no longer serves the advertised -unmuted segments; falling back to -muted ones.",
            );
            playlist.replace("-unmuted.", "-muted.")
        }
        Err(err) => {
            emit_log(
                queue,
                job_id,
                &format!(
                    "!! Could not probe a Twitch -unmuted segment, keeping the playlist as advertised: {err:#}"
                ),
            );
            playlist
        }
    }
}

async fn twitch_segment_is_available(url: &str, twitch_auth_token: Option<&str>) -> Result<bool> {
    let client = reqwest::Client::builder()
        .user_agent(
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 \
             (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        )
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .context("configure Twitch segment probe client")?;
    let mut req = client.get(url).header("Range", "bytes=0-1");
    if let Some(token) = twitch_auth_token {
        if !token.trim().is_empty() {
            req = req.header("Authorization", format!("OAuth {}", token.trim()));
        }
    }
    let resp = req
        .header("Referer", "https://www.twitch.tv/")
        .send()
        .await
        .context("probe Twitch VOD segment")?;
    Ok(resp.status().is_success())
}

async fn fetch_twitch_hls_playlist_text(
    direct_url: &str,
    twitch_auth_token: Option<&str>,
) -> Result<String> {
    let builder = reqwest::Client::builder()
        .user_agent(
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 \
             (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        )
        .timeout(std::time::Duration::from_secs(30));
    // reqwest ignores the Windows system proxy; direct Twitch may be blocked.
    let client = match crate::proxy::system_proxy() {
        Some(proxy_url) => builder.proxy(reqwest::Proxy::all(&proxy_url).context("Twitch playlist proxy")?),
        None => builder,
    }
    .build()
    .context("configure Twitch playlist client")?;
    let token = twitch_auth_token.map(str::trim).filter(|t| !t.is_empty());
    let build_request = || {
        let req = client
            .get(direct_url)
            .header("Referer", "https://www.twitch.tv/")
            .header("Origin", "https://www.twitch.tv")
            .header(
                "Accept",
                "application/vnd.apple.mpegurl,application/x-mpegURL,*/*",
            );
        match token {
            Some(token) => req
                .header("Authorization", format!("OAuth {token}"))
                .header("Cookie", format!("auth-token={token}")),
            None => req,
        }
    };
    let (status, text) = crate::util::fetch_text_with_retry(build_request)
        .await
        .context("fetch Twitch VOD media playlist")?;
    if !status.is_success() {
        return Err(anyhow!("Twitch VOD media playlist returned HTTP {status}"));
    }
    Ok(text)
}

fn absolutize_hls_uri_attrs(line: &str, base: &url::Url) -> String {
    static URI_RE: Lazy<Regex> =
        Lazy::new(|| Regex::new(r#"URI="(?P<uri>[^"]+)""#).expect("HLS URI regex"));
    URI_RE
        .replace_all(line, |captures: &regex::Captures| {
            let uri = captures.name("uri").map(|m| m.as_str()).unwrap_or_default();
            let absolute = absolutize_hls_uri(uri, base);
            format!("URI=\"{absolute}\"")
        })
        .into_owned()
}

fn absolutize_hls_uri(uri: &str, base: &url::Url) -> String {
    let Ok(mut absolute) = base.join(uri) else {
        return uri.to_string();
    };

    // Twitch VOD CDN playlists can be signed on the media playlist URL.
    // Segment/MAP/KEY URIs sometimes are relative, and sometimes are absolute
    // same-CDN URLs without their own query string. Both must inherit the
    // media playlist signature; otherwise N_m3u8DL-RE loads unsigned
    // CloudFront URLs and gets 403 Forbidden.
    if absolute.query().is_none() && should_inherit_twitch_query(uri, base, &absolute) {
        if let Some(query) = base.query() {
            absolute.set_query(Some(query));
        }
    }

    absolute.to_string()
}

fn should_inherit_twitch_query(uri: &str, base: &url::Url, absolute: &url::Url) -> bool {
    uri_is_relative(uri)
        || (is_twitch_cdn_url(absolute.as_str())
            && base.host_str().is_some()
            && absolute.host_str() == base.host_str())
}

fn uri_is_relative(uri: &str) -> bool {
    let trimmed = uri.trim();
    !(trimmed.starts_with("http://")
        || trimmed.starts_with("https://")
        || trimmed.starts_with("data:")
        || trimmed.starts_with("//"))
}

fn is_twitch_cdn_url(url: &str) -> bool {
    let lower = url.to_lowercase();
    lower.contains("cloudfront.net") || lower.contains("ttvnw.net")
}

fn twitch_hls_url_matches_requested_height(url: &str, height: u32) -> bool {
    let lower = url.to_lowercase();
    if height < 1440 {
        return true;
    }
    if lower.contains("chunked")
        || lower.contains("source")
        || lower.contains(&format!("{height}p"))
        || lower.contains(&format!("/{height}/"))
    {
        return true;
    }
    !(lower.contains("1080p")
        || lower.contains("720p")
        || lower.contains("480p")
        || lower.contains("360p")
        || lower.contains("160p"))
}

async fn accept_verified_twitch_hls(
    queue: &Arc<QueueManager>,
    job: &Job,
    bin_dir: Option<&Path>,
    url: String,
    requested_height: u32,
    label: &str,
    twitch_auth_token: Option<&str>,
) -> Result<Option<String>> {
    if is_twitch_cdn_url(&url) {
        match fetch_twitch_hls_playlist_text(&url, twitch_auth_token).await {
            Ok(_) => {}
            Err(err) => {
                emit_log(
                    queue,
                    &job.id,
                    &format!("{label} media playlist is not downloadable: {err:#}"),
                );
                return Ok(None);
            }
        }
    }

    match verify_hls_video_dimensions(queue, job, bin_dir, &url, twitch_auth_token).await {
        Ok((width, height)) => {
            emit_log(
                queue,
                &job.id,
                &format!("Verified video height: {width}x{height}"),
            );
            if height >= requested_height {
                emit_log(
                    queue,
                    &job.id,
                    &format!("Selected video source: {label} ({width}x{height})"),
                );
                Ok(Some(url))
            } else {
                emit_log(
                    queue,
                    &job.id,
                    &format!(
                        "{label} returned {width}x{height}; rejected because {requested_height}p was selected."
                    ),
                );
                Ok(None)
            }
        }
        Err(err) => {
            emit_log(
                queue,
                &job.id,
                &format!("{label} playlist could not be verified: {err:#}"),
            );
            Ok(None)
        }
    }
}

async fn verify_hls_video_dimensions(
    queue: &Arc<QueueManager>,
    job: &Job,
    bin_dir: Option<&Path>,
    url: &str,
    twitch_auth_token: Option<&str>,
) -> Result<(u32, u32)> {
    let ffprobe = resolve_binary(FFPROBE, bin_dir)
        .ok_or_else(|| anyhow!("ffprobe.exe not found; cannot verify Twitch 1440p"))?;
    let mut cmd = Command::new(&ffprobe);
    crate::platform::hide_console_tokio(&mut cmd);
    cmd.kill_on_drop(true)
        .arg("-v")
        .arg("error")
        .args([
            "-headers",
            &if let Some(token) = twitch_auth_token.filter(|t| !t.trim().is_empty()) {
                format!("Referer: https://www.twitch.tv/\r\nUser-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36\r\nAuthorization: OAuth {}\r\nCookie: auth-token={}\r\n", token.trim(), token.trim())
            } else {
                "Referer: https://www.twitch.tv/\r\nUser-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36\r\n".to_string()
            }
        ])
        .args(["-select_streams", "v:0"])
        .args(["-show_entries", "stream=width,height"])
        .args(["-of", "csv=s=x:p=0"])
        .arg(url);

    let command_line = debug_cmd_from_command(&cmd);
    queue.log_command_started(
        &job.id,
        command_line.clone(),
        Some(json!({
            "action": "verify_hls_video_dimensions",
            "url": redact_signed_url(url),
        })),
    );
    let output = tokio::time::timeout(Duration::from_secs(25), cmd.output())
        .await
        .context("ffprobe timed out while verifying HLS")?
        .context("spawn ffprobe")?;
    queue.log_command_finished(&job.id, command_line, output.status.code());

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    for line in stdout.lines() {
        queue.log_stdout(&job.id, line);
    }
    for line in stderr.lines() {
        queue.log_stderr(&job.id, line);
    }

    if !output.status.success() {
        return Err(anyhow!(
            "ffprobe failed while verifying HLS: {}",
            stderr.trim()
        ));
    }

    parse_dimensions(&stdout)
        .ok_or_else(|| anyhow!("ffprobe did not return video dimensions: {}", stdout.trim()))
}

fn parse_dimensions(output: &str) -> Option<(u32, u32)> {
    output.lines().find_map(|line| {
        let captures = RE_DIMENSIONS.captures(line.trim())?;
        let width = captures.name("w")?.as_str().parse::<u32>().ok()?;
        let height = captures.name("h")?.as_str().parse::<u32>().ok()?;
        Some((width, height))
    })
}

fn redact_signed_url(url: &str) -> String {
    match url.find('?') {
        Some(index) => format!("{}?<redacted>", &url[..index]),
        None => url.to_string(),
    }
}

async fn resolve_hls_url(
    queue: &Arc<QueueManager>,
    job: &Job,
    live: bool,
    bin_dir: Option<&Path>,
) -> Result<String> {
    let spec = &job.spec;
    let requested_height = requested_spec_height(spec);
    if let Some(q) = spec
        .quality
        .as_deref()
        .filter(|q| !q.is_empty() && *q != "best")
    {
        if q.to_lowercase().contains(".m3u8") {
            if is_twitch_url(&spec.url) && requested_height.is_some_and(|height| height >= 1440) {
                emit_log(
                    queue,
                    &job.id,
                    "Ignoring UI-provided Twitch m3u8 quality URL; resolving through Twitch Usher like TwitchDownloader.",
                );
            } else {
                return Ok(q.to_string());
            }
        }
    }

    if crate::wtv::is_wtv_url(&spec.url) {
        let resolved = crate::wtv::resolve(&spec.url).await?;
        if live && resolved.stream.as_ref().is_some_and(|stream| !stream.is_live()) {
            return Err(anyhow!("W.TV: канал сейчас не в эфире"));
        }
        if let Some(stream) = resolved.stream.as_ref() {
            emit_log(
                queue,
                &job.id,
                &format!(
                    "W.TV: {} трансляция «{}»",
                    if stream.is_live() { "live" } else { "архивная" },
                    stream.title
                ),
            );
        }
        return Ok(resolved.playback_url);
    }

    if is_twitch_url(&spec.url) {
        if requested_height.is_some_and(|height| height >= 1440) {
            let height = requested_height.unwrap_or(1440);
            let resolver_quality = explicit_quality_label_for_height(spec, height);
            emit_log(queue, &job.id, &format!("Trying Twitch usher {height}p"));
            match resolve_twitch_hls_url(
                &spec.url,
                resolver_quality.as_deref(),
                live,
                &spec.proxy,
                spec.twitch_auth_token.as_deref(),
            )
            .await
            {
                Ok(Some(url)) => {
                    if let Some(url) = accept_verified_twitch_hls(
                        queue,
                        job,
                        bin_dir,
                        url,
                        height,
                        "Twitch usher",
                        spec.twitch_auth_token.as_deref(),
                    )
                    .await?
                    {
                        return Ok(url);
                    }
                }
                Ok(None) => emit_log(
                    queue,
                    &job.id,
                    &format!("Twitch usher did not return a {height}p playlist."),
                ),
                Err(err) => emit_log(
                    queue,
                    &job.id,
                    &format!("Twitch usher {height}p resolver failed: {err}"),
                ),
            }
        }

        match resolve_twitch_hls_url(
            &spec.url,
            spec.quality.as_deref(),
            live || !is_twitch_vod_url(&spec.url),
            &spec.proxy,
            spec.twitch_auth_token.as_deref(),
        )
        .await
        {
            Ok(Some(url)) => match requested_height.filter(|height| *height >= 1440) {
                // URL names lie (`chunked` can be 1080p): measure the stream.
                Some(height) => {
                    if let Some(url) = accept_verified_twitch_hls(
                        queue,
                        job,
                        bin_dir,
                        url,
                        height,
                        "Twitch HLS",
                        spec.twitch_auth_token.as_deref(),
                    )
                    .await?
                    {
                        return Ok(url);
                    }
                    emit_log(
                        queue,
                        &job.id,
                        "!! Twitch HLS resolver returned a lower variant for requested 1440p.",
                    );
                }
                None => return Ok(url),
            },
            Ok(None) => {}
            Err(err) => emit_log(
                queue,
                &job.id,
                &format!("!! Twitch HLS resolver fallback to yt-dlp -g: {err}"),
            ),
        }
    }

    let ytdlp = resolve_binary(YTDLP, bin_dir).ok_or_else(|| anyhow!("yt-dlp.exe not found"))?;
    let should_retry_with_cookies = is_youtube_url(&spec.url) || is_twitch_url(&spec.url);
    let mut cookie_retry_enabled = false;
    let mut last_stderr = String::new();
    let mut best_resolved: Option<String> = None;

    for cookie_browser in
        std::iter::once(None).chain(youtube_cookie_retry_browsers().iter().copied().map(Some))
    {
        if cookie_browser.is_some() && !cookie_retry_enabled {
            break;
        }

        let mut cmd = Command::new(&ytdlp);
        configure_ytdlp_env(&mut cmd);
        cmd.arg("-g")
            .arg("--no-check-certificates")
            .arg("--no-warnings")
            .arg("-f");

        let format_selector = spec
            .quality
            .as_deref()
            .filter(|q| !q.is_empty() && *q != "best")
            .map(|q| {
                requested_spec_height(spec)
                    .map(|height| {
                        format!(
                            "best[height<={height}][protocol^=m3u8]/best[height<={height}]/best"
                        )
                    })
                    .unwrap_or_else(|| q.to_string())
            })
            .unwrap_or_else(|| "best[protocol^=m3u8]/best".to_string());
        cmd.arg(format_selector);

        if let Some(ref token) = spec.twitch_auth_token {
            if !token.trim().is_empty() {
                cmd.args([
                    "--add-header",
                    &format!("Authorization: OAuth {}", token.trim()),
                ]);
                cmd.args([
                    "--add-header",
                    &format!("Cookie: auth-token={}", token.trim()),
                ]);
            }
        }

        if let Some(browser) = cookie_browser {
            apply_youtube_cookie_browser(&mut cmd, browser);
        }

        if let Some(px) = spec.proxy.for_ytdlp() {
            cmd.args(["--proxy", &px]);
        }
        cmd.arg(&spec.url);

        let command_line = debug_cmd(&ytdlp, &cmd);
        emit_log(
            queue,
            &job.id,
            &format!("Resolving direct HLS URL with: {command_line}"),
        );
        queue.log_command_started(
            &job.id,
            command_line.clone(),
            Some(json!({
                "action": "resolve_hls_url",
                "url": spec.url.clone(),
                "quality": spec.quality.clone(),
                "live": live,
                "cookie_browser": cookie_browser,
            })),
        );

        let output = cmd.output().await.context("spawning yt-dlp -g")?;
        queue.log_command_finished(&job.id, command_line, output.status.code());

        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);
        for line in stdout.lines() {
            queue.log_stdout(&job.id, line);
        }
        for line in stderr.lines() {
            queue.log_stderr(&job.id, line);
        }

        if output.status.success() {
            let resolved = stdout
                .lines()
                .map(str::trim)
                .find(|l| !l.is_empty())
                .map(|s| s.to_string())
                .ok_or_else(|| anyhow!("yt-dlp -g returned empty output"));

            if let Ok(resolved_url) = resolved {
                // Check if Twitch returned 1080p when 1440p was requested
                let is_under_resolved = is_twitch_url(&spec.url)
                    && requested_height.is_some_and(|height| {
                        height >= 1440
                            && !twitch_hls_url_matches_requested_height(&resolved_url, height)
                    });

                if !is_under_resolved {
                    return Ok(resolved_url);
                }

                if best_resolved.is_none() {
                    best_resolved = Some(resolved_url.clone());
                }

                if cookie_browser.is_none() && should_retry_with_cookies {
                    emit_log(
                        queue,
                        &job.id,
                        "Twitch returned a lower resolution. Retrying with browser cookies to get 1440p...",
                    );
                    cookie_retry_enabled = true;
                    last_stderr =
                        format!("Twitch returned a lower resolution (not 1440p): {resolved_url}");
                    continue;
                }
            }
        } else {
            last_stderr = stderr.to_string();
        }

        if crate::commands::resolve::cookies_cannot_help(&last_stderr) {
            break;
        }
        let is_auth_err = youtube_cookie_auth_error(&last_stderr)
            || last_stderr.contains("download_web_play_token")
            || last_stderr.contains("403")
            || (is_twitch_url(&spec.url) && requested_height.is_some_and(|height| height >= 1440));

        if cookie_browser.is_none() && should_retry_with_cookies && is_auth_err {
            cookie_retry_enabled = true;
            continue;
        }
        if cookie_browser.is_some() && cookie_retry_enabled {
            continue;
        }

        if best_resolved.is_some() {
            continue;
        }

        return Err(anyhow!("yt-dlp -g failed: {}", last_stderr));
    }

    if let Some(resolved_url) = best_resolved {
        emit_log(
            queue,
            &job.id,
            "!! Twitch returned 1080p for requested 1440p. Запись продолжится в 1080p. Для записи в 1440p убедитесь, что стрим идет в 1440p и вы авторизованы в Twitch в браузере.",
        );
        return Ok(resolved_url);
    }

    if is_twitch_url(&spec.url) && requested_height.is_some_and(|height| height >= 1440) {
        return Err(anyhow!(
            "Twitch returned 1080p (or failed) for requested 1440p. Для 1440p Twitch требует авторизованную браузерную сессию: закрой Edge/Chrome перед скачиванием или войди в Twitch в Firefox/Chrome/Edge, затем повтори."
        ));
    }

    Err(anyhow!(
        "yt-dlp -g failed after trying browser cookies: {}",
        last_stderr
    ))
}

fn is_twitch_url(url: &str) -> bool {
    url.to_lowercase().contains("twitch.tv")
}

fn maybe_proxy_unmute_hls(
    queue: &Arc<QueueManager>,
    spec: &JobSpec,
    job_id: &str,
    direct_url: String,
    live: bool,
) -> String {
    if spec.unmute_video && !live && is_twitch_unmute_candidate(&spec.url, &direct_url) {
        hls_proxy::reset_unmute_stats(job_id);
        let proxied = match hls_proxy::proxied_hls_url_internal(
            direct_url.clone(),
            Some("https://www.twitch.tv/".to_string()),
            true,
            Some(job_id),
        ) {
            Ok(url) => url,
            Err(err) => {
                emit_log(
                    queue,
                    job_id,
                    &format!("!! Unmute Video unavailable, using ordinary HLS URL instead: {err}"),
                );
                return direct_url;
            }
        };
        emit_log(
            queue,
            job_id,
            &format!("Twitch VOD audio restore: routing HLS through local muted/unmuted segment proxy: {proxied}"),
        );
        return proxied;
    }
    if spec.unmute_video && live {
        emit_log(
            queue,
            job_id,
            "!! Twitch VOD audio restore is disabled for live streams.",
        );
    } else if spec.unmute_video {
        emit_log(
            queue,
            job_id,
            "!! Twitch VOD audio restore is unavailable for this URL; using ordinary download.",
        );
    }
    direct_url
}

fn is_twitch_unmute_candidate(input_url: &str, direct_url: &str) -> bool {
    is_twitch_vod_url(input_url)
        || direct_url.contains("cloudfront.net")
        || direct_url.contains("ttvnw.net")
        || direct_url.contains("twitch.tv")
}

fn emit_unmute_stats(queue: &Arc<QueueManager>, job: &Job) {
    if !job.spec.unmute_video {
        return;
    }
    let stats = hls_proxy::take_unmute_stats(&job.id);
    emit_log(
        queue,
        &job.id,
        &format!(
            "Twitch VOD audio restore: checked {} segments, restored {}, fell back to muted {}. Restore manifests found: {}. Segment -unmuted hits: {}.",
            stats.checked_segments,
            stats.restored_segments,
            stats.muted_fallback_segments,
            stats.restore_manifests_found,
            stats.unmuted_segments
        ),
    );
    if stats.checked_segments == 0 {
        emit_log(
            queue,
            &job.id,
            "Twitch VOD audio restore: в выбранном диапазоне не найдено AP-muted сегментов для восстановления.",
        );
    } else if stats.restored_segments == 0 {
        emit_log(
            queue,
            &job.id,
            "!! Для выбранного диапазона Twitch не отдаёт unmuted/original сегменты.",
        );
    }
    if let Some(url) = stats.restore_manifest_url {
        emit_log(
            queue,
            &job.id,
            &format!("Twitch VOD audio restore manifest: {url}"),
        );
    }
    if !stats.failed_candidates.is_empty() {
        emit_log(
            queue,
            &job.id,
            &format!(
                "Twitch VOD audio restore failed candidate examples: {}",
                stats.failed_candidates.join(" | ")
            ),
        );
    }
}

async fn split_file_path(
    queue: &Arc<QueueManager>,
    job: &Job,
    input: &Path,
    bin_dir: Option<&Path>,
) -> Result<()> {
    let ffmpeg = resolve_binary(FFMPEG, bin_dir)
        .ok_or_else(|| anyhow!("ffmpeg.exe not found - set binaries folder in Settings"))?;

    if !input.is_file() {
        return Ok(());
    }
    let stem = input
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("video");
    let pattern = input
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join(format!("{stem}_part%03d.mp4"));
    let split_seconds = job.spec.split_interval_minutes.unwrap_or(1).clamp(1, 120) * 60;

    emit_log(
        queue,
        &job.id,
        &format!(
            "Splitting {} into {split_seconds}-second parts...",
            input.display()
        ),
    );

    let mut cmd = Command::new(&ffmpeg);
    cmd.args(["-y", "-hide_banner", "-i"])
        .arg(input)
        .args([
            "-f",
            "segment",
            "-segment_time",
            &split_seconds.to_string(),
            "-c",
            "copy",
            "-reset_timestamps",
            "1",
        ])
        .arg(&pattern)
        .kill_on_drop(true)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    stream_process(queue, job, Arc::new(AtomicBool::new(false)), cmd).await?;
    let _ = std::fs::remove_file(input);
    Ok(())
}

async fn read_lines_cr_lf<R, F>(mut reader: R, mut on_line: F) -> std::io::Result<String>
where
    R: tokio::io::AsyncRead + Unpin,
    F: FnMut(&str) + Send,
{
    use tokio::io::AsyncReadExt;
    let mut buf = Vec::with_capacity(4096);
    let mut temp = [0u8; 4096];
    let mut captured = String::new();
    loop {
        let n = reader.read(&mut temp).await?;
        if n == 0 {
            if !buf.is_empty() {
                let line = String::from_utf8_lossy(&buf);
                let trimmed = line.trim();
                if !trimmed.is_empty() {
                    on_line(trimmed);
                    if !captured.is_empty() {
                        captured.push('\n');
                    }
                    captured.push_str(trimmed);
                }
            }
            break;
        }
        buf.extend_from_slice(&temp[..n]);
        let mut start = 0;
        for i in 0..buf.len() {
            if buf[i] == b'\n' || buf[i] == b'\r' {
                if i > start {
                    let line = String::from_utf8_lossy(&buf[start..i]);
                    let trimmed = line.trim();
                    if !trimmed.is_empty() {
                        on_line(trimmed);
                        if !captured.is_empty() {
                            captured.push('\n');
                        }
                        captured.push_str(trimmed);
                    }
                }
                start = i + 1;
            }
        }
        if start > 0 {
            buf.drain(0..start);
        }
    }
    Ok(captured)
}

async fn stream_process(
    queue: &Arc<QueueManager>,
    job: &Job,
    cancel: Arc<AtomicBool>,
    cmd: Command,
) -> Result<()> {
    stream_process_with_pid(queue, job, cancel, cmd, None).await
}

async fn stream_process_with_pid(
    queue: &Arc<QueueManager>,
    job: &Job,
    cancel: Arc<AtomicBool>,
    mut cmd: Command,
    pid_slot: Option<Arc<Mutex<Option<u32>>>>,
) -> Result<()> {
    // Hide console window on Windows.
    #[cfg(windows)]
    {
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }

    let command_line = debug_cmd_from_command(&cmd);
    queue.log_command_started(&job.id, command_line.clone(), None);

    let mut child: Child = cmd.spawn().context("spawn process")?;
    if let Some(slot) = &pid_slot {
        *slot.lock() = child.id();
    }
    crate::win_power::disable_for_pid(child.id());
    let stdout = child.stdout.take().context("stdout handle")?;
    let stderr = child.stderr.take().context("stderr handle")?;

    let id = job.id.clone();
    let q1 = queue.clone();
    let q2 = queue.clone();
    let zero_exit_failure = Arc::new(Mutex::new(None::<String>));

    let stdout_task = tokio::spawn({
        let id = id.clone();
        let zero_exit_failure = zero_exit_failure.clone();
        async move {
            let _ = read_lines_cr_lf(stdout, |line| {
                q1.log_stdout(&id, line);
                // yt-dlp's progress template prints a machine line per tick:
                // it feeds the progress bar, not the job log in the UI.
                if !is_progress_template_line(line) {
                    if is_process_error_line(line) {
                        emit_log(&q1, &id, &format!("!! {line}"));
                    } else {
                        emit_log(&q1, &id, line);
                    }
                    if let Some(message) = detect_zero_exit_process_failure(line) {
                        remember_process_failure(&zero_exit_failure, message);
                    }
                }
                if let Some(p) = parse_progress(line) {
                    q1.set_progress(&id, p);
                }
            })
            .await;
        }
    });

    let stderr_task = tokio::spawn({
        let id = id.clone();
        let zero_exit_failure = zero_exit_failure.clone();
        async move {
            read_lines_cr_lf(stderr, |line| {
                q2.log_stderr(&id, line);
                // yt-dlp's progress template prints a machine line per tick:
                // it feeds the progress bar, not the job log in the UI.
                if !is_progress_template_line(line) {
                    if is_process_error_line(line) {
                        emit_log(&q2, &id, &format!("!! {line}"));
                    } else {
                        emit_log(&q2, &id, line);
                    }
                    if let Some(message) = detect_zero_exit_process_failure(line) {
                        remember_process_failure(&zero_exit_failure, message);
                    }
                }
                if let Some(p) = parse_progress(line) {
                    q2.set_progress(&id, p);
                }
            })
            .await
            .unwrap_or_default()
        }
    });

    // Cancel watcher
    let cancel_flag = cancel.clone();
    let pid = child.id();
    let watcher = tokio::spawn(async move {
        loop {
            if cancel_flag.load(Ordering::SeqCst) {
                #[cfg(windows)]
                if let Some(pid) = pid {
                    use std::os::windows::process::CommandExt;
                    let _ = std::process::Command::new("taskkill")
                        .args(["/PID", &pid.to_string(), "/T", "/F"])
                        .creation_flags(0x0800_0000)
                        .status();
                }
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        }
    });

    let status = child.wait().await?;
    if let Some(slot) = &pid_slot {
        *slot.lock() = None;
    }
    queue.log_command_finished(&job.id, command_line, status.code());
    watcher.abort();
    let _ = stdout_task.await;
    let stderr = stderr_task.await.unwrap_or_default();

    if cancel.load(Ordering::SeqCst) {
        return Err(anyhow!("cancelled"));
    }
    if !status.success() {
        if let Some(message) = friendly_process_error(job, &stderr) {
            emit_log(queue, &job.id, &format!("!! {message}"));
            return Err(anyhow!(message));
        }
        return Err(anyhow!("process exited with {}", status));
    }
    if let Some(message) = zero_exit_failure.lock().clone() {
        let message = friendly_zero_exit_process_failure(&message);
        emit_log(queue, &job.id, &format!("!! {message}"));
        return Err(anyhow!(message));
    }
    Ok(())
}

fn remember_process_failure(slot: &Arc<Mutex<Option<String>>>, message: String) {
    let mut guard = slot.lock();
    if guard.is_none() {
        *guard = Some(message);
    }
}

fn detect_zero_exit_process_failure(line: &str) -> Option<String> {
    line.split(|ch| ch == '\r' || ch == '\n')
        .map(str::trim)
        .filter(|part| !part.is_empty())
        .find_map(|part| {
            let lower = part.to_lowercase();
            if lower.contains("error: segment count check not pass")
                || lower.contains("error: failed")
                // N_m3u8DL-RE (.NET) can exit with code 0 after a network drop:
                // a failed live-playlist refresh is treated internally as "stream
                // over", the partial recording is muxed and the process exits
                // "cleanly". These exception signatures are the only trace that
                // the ending was a network failure, so surface them as errors —
                // the live reconnect loop then resumes instead of stopping.
                || lower.contains("taskcanceledexception")
                || lower.contains("timeoutexception")
                || lower.contains("socketexception")
                || lower.contains("httprequestexception")
                || lower.contains("httpclient.timeout")
                || lower.contains("unable to read data from the transport connection")
                || lower.contains("refreshplaylistasync")
            {
                Some(part.to_string())
            } else {
                None
            }
        })
}

fn friendly_zero_exit_process_failure(message: &str) -> String {
    let lower = message.to_lowercase();
    if lower.contains("segment count check not pass") {
        return format!(
            "HLS range download is incomplete: {message}. Retry the task; Fetchr now uses fewer HLS threads and more retries for Twitch VOD archives."
        );
    }
    if lower.contains("taskcanceledexception")
        || lower.contains("timeoutexception")
        || lower.contains("socketexception")
        || lower.contains("httprequestexception")
        || lower.contains("httpclient.timeout")
        || lower.contains("unable to read data from the transport connection")
        || lower.contains("refreshplaylistasync")
    {
        return format!("Сетевой сбой во время загрузки (таймаут или обрыв соединения): {message}");
    }
    format!("External downloader reported failure: {message}")
}

fn is_hls_incomplete_download_error(err: &anyhow::Error) -> bool {
    let text = format!("{err:#}").to_lowercase();
    text.contains("hls range download is incomplete")
        || text.contains("segment count check not pass")
}

fn friendly_process_error(job: &Job, stderr: &str) -> Option<String> {
    let lower = stderr.to_lowercase();
    if is_youtube_url(&job.spec.url) && youtube_cookie_auth_error(stderr) {
        return Some(format!(
            "YouTube requested browser cookies (--cookies-from-browser): {}",
            stderr.trim()
        ));
    }
    // Keep the reason a browser's cookies could not be read; a bare exit code
    // left the final message unable to say "close Brave".
    if is_youtube_url(&job.spec.url) && cookie_store_error(stderr) {
        return Some(stderr.trim().to_string());
    }
    if is_twitch_vod_url(&job.spec.url)
        && lower.contains("nonetype")
        && lower.contains("not subscriptable")
    {
        return Some(
            "yt-dlp не смог получить Twitch access token; обновите yt-dlp или проверьте доступность VOD в браузере."
                .to_string(),
        );
    }
    None
}

fn is_process_error_line(line: &str) -> bool {
    let lower = line.to_lowercase();
    if is_benign_process_stderr_line(&lower) {
        return false;
    }
    lower.contains("error")
        || lower.contains("failed")
        || lower.contains("exception")
        || lower.contains("invalid data")
        || lower.contains("403")
        || lower.contains("forbidden")
        || lower.contains("cannot")
        || lower.contains("unable")
}

fn is_benign_process_stderr_line(lower: &str) -> bool {
    lower.starts_with("ffmpeg version")
        || lower.starts_with("libav")
        || lower.starts_with("configuration:")
        || lower.starts_with("built with")
        || lower.starts_with("input #")
        || lower.starts_with("output #")
        || lower.starts_with("metadata:")
        || lower.starts_with("encoder")
        || lower.starts_with("stream #")
        || lower.starts_with("duration:")
        || lower.starts_with("press [q]")
        || lower.starts_with("frame=")
        || lower.contains(" opening 'http")
        || lower.contains("found duplicated moov atom")
        || lower.contains("handler_name")
        || lower.contains("major_brand")
        || lower.contains("minor_version")
        || lower.contains("compatible_brands")
        || lower.contains("variant_bitrate")
        || lower.contains("video:")
}

fn is_progress_template_line(line: &str) -> bool {
    line.contains(FETCHR_PROGRESS_PREFIX)
}

fn parse_progress(line: &str) -> Option<JobProgress> {
    if let Some(progress) = parse_fetchr_progress(line) {
        return Some(progress);
    }

    let percent = RE_PERCENT
        .captures(line)
        .and_then(|c| c.name("p"))
        .and_then(|m| m.as_str().parse::<f32>().ok());

    let Some(p) = percent else {
        return None;
    };

    let speed = RE_SPEED
        .captures(line)
        .and_then(|c| c.name("s"))
        .map(|m| m.as_str().to_string());
    let eta = RE_ETA
        .captures(line)
        .and_then(|c| c.name("e"))
        .map(|m| m.as_str().to_string());
    let size = RE_SIZE
        .captures(line)
        .and_then(|c| c.name("sz"))
        .map(|m| m.as_str().to_string());
    let total_bytes = size.as_deref().and_then(parse_byte_amount);
    let downloaded_bytes =
        total_bytes.map(|total| ((total as f64) * (p as f64 / 100.0)).round() as u64);
    let speed_bps = speed
        .as_deref()
        .and_then(|value| parse_byte_amount(value.strip_suffix("/s").unwrap_or(value)))
        .map(|bytes| bytes as f64);
    let current_segment = RE_SEGMENT
        .captures(line)
        .and_then(|c| c.name("seg"))
        .map(|m| format!("Segment {}", m.as_str().replace(' ', "")));

    // N_m3u8DL-RE prints "0.00Bps" in the gaps between threaded bursts. Emitting
    // those as real readings makes the UI speed blink 0↔peak. Drop zero readings
    // so the last real speed is kept (QueueManager::set_progress falls back to
    // the previous value when these are None).
    let (speed, speed_bps) = match speed_bps {
        Some(b) if b <= 0.0 => (None, None),
        _ => (speed, speed_bps),
    };

    Some(JobProgress {
        percent: p.clamp(0.0, 100.0),
        stage_percent: None,
        stage_start: None,
        stage_end: None,
        stage_started_at: None,
        download_elapsed_ms: None,
        downloaded_bytes,
        total_bytes,
        speed_bps,
        current_segment,
        speed,
        eta,
        size,
        message: None,
    })
}

fn parse_fetchr_progress(line: &str) -> Option<JobProgress> {
    let start = line.find(FETCHR_PROGRESS_PREFIX)?;
    let payload = &line[start + FETCHR_PROGRESS_PREFIX.len()..];
    let mut parts = payload.split('|').map(str::trim);
    let downloaded_bytes = parts.next().and_then(parse_optional_u64);
    let total_bytes = parts.next().and_then(parse_optional_u64);
    let total_bytes_estimate = parts.next().and_then(parse_optional_u64);
    let speed_bps = parts.next().and_then(parse_optional_f64);
    let eta_seconds = parts.next().and_then(parse_optional_u64);
    let percent = parts.next().and_then(parse_optional_percent).or_else(|| {
        match (downloaded_bytes, total_bytes.or(total_bytes_estimate)) {
            (Some(done), Some(total)) if total > 0 => Some((done as f32 / total as f32) * 100.0),
            _ => None,
        }
    })?;
    let speed = parts.next().and_then(clean_progress_label);
    let eta = parts
        .next()
        .and_then(clean_progress_label)
        .or_else(|| eta_seconds.map(|seconds| format_duration(seconds as f64)));
    let size = parts.next().and_then(clean_progress_label);
    let total = total_bytes.or(total_bytes_estimate);

    Some(JobProgress {
        percent: percent.clamp(0.0, 100.0),
        stage_percent: None,
        stage_start: None,
        stage_end: None,
        stage_started_at: None,
        download_elapsed_ms: None,
        downloaded_bytes,
        total_bytes: total,
        speed_bps,
        current_segment: None,
        speed,
        eta,
        size,
        message: None,
    })
}

fn parse_optional_u64(value: &str) -> Option<u64> {
    let cleaned = value.trim();
    if is_missing_progress_value(cleaned) {
        return None;
    }
    cleaned
        .parse::<f64>()
        .ok()
        .map(|number| number.max(0.0).round() as u64)
}

fn parse_optional_f64(value: &str) -> Option<f64> {
    let cleaned = value.trim();
    if is_missing_progress_value(cleaned) {
        return None;
    }
    cleaned
        .parse::<f64>()
        .ok()
        .filter(|number| number.is_finite() && *number >= 0.0)
}

fn parse_optional_percent(value: &str) -> Option<f32> {
    let cleaned = value.trim().trim_end_matches('%').trim();
    if is_missing_progress_value(cleaned) {
        return None;
    }
    cleaned
        .parse::<f32>()
        .ok()
        .filter(|number| number.is_finite())
}

fn clean_progress_label(value: &str) -> Option<String> {
    let cleaned = value.trim();
    if is_missing_progress_value(cleaned) {
        return None;
    }
    Some(cleaned.to_string())
}

fn is_missing_progress_value(value: &str) -> bool {
    value.is_empty()
        || matches!(
            value.to_ascii_lowercase().as_str(),
            "none" | "na" | "n/a" | "unknown" | "null"
        )
}

fn parse_byte_amount(value: &str) -> Option<u64> {
    let captures = Regex::new(r"(?i)(?P<n>\d+(?:\.\d+)?)\s*(?P<u>[KMGT]?i?B)")
        .ok()?
        .captures(value.trim())?;
    let amount = captures.name("n")?.as_str().parse::<f64>().ok()?;
    let unit = captures.name("u")?.as_str().to_ascii_lowercase();
    let multiplier = if unit.starts_with('k') {
        1024_f64
    } else if unit.starts_with('m') {
        1024_f64.powi(2)
    } else if unit.starts_with('g') {
        1024_f64.powi(3)
    } else if unit.starts_with('t') {
        1024_f64.powi(4)
    } else {
        1.0
    };
    Some((amount * multiplier).round() as u64)
}

use crate::util::format_duration;

fn emit_log(queue: &Arc<QueueManager>, id: &str, line: &str) {
    queue.emit_job_log(id, line);
}

fn sanitize(name: &str) -> String {
    let mut out = String::with_capacity(name.len());
    for ch in name.chars() {
        if matches!(ch, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') {
            out.push('_');
        } else {
            out.push(ch);
        }
    }
    let trimmed = out.trim().trim_matches('.').to_string();
    if trimmed.is_empty() {
        "download".to_string()
    } else {
        trimmed
    }
}

async fn run_fetchr_mute_on_local_file(
    queue: &Arc<QueueManager>,
    job: &Job,
    input_path: &Path,
    cancel: Arc<AtomicBool>,
) -> Result<PathBuf> {
    fetchr_mute::run_on_local_file(queue, job, input_path, cancel).await
}

pub async fn run_fetchr_mute_job(
    queue: &Arc<QueueManager>,
    job: &Job,
    cancel: Arc<AtomicBool>,
) -> Result<PathBuf> {
    let input_path = PathBuf::from(&job.spec.url);
    if !input_path.exists() {
        return Err(anyhow!(
            "Input file for FetchrMute does not exist: {:?}",
            input_path
        ));
    }
    run_fetchr_mute_on_local_file(queue, job, &input_path, cancel).await
}

#[cfg(test)]
mod tests {
    use super::{
        allow_twitch_vod_ytdlp_fallback, detect_zero_exit_process_failure, effective_live_mode,
        is_hls_incomplete_download_error, normalized_fragments, ytdlp_format_selector, DownloadKind,
        JobSpec,
    };

    /// Every optional field carries `#[serde(default)]`, so a fixture only has
    /// to name what the test is actually about.
    fn spec(overrides: serde_json::Value) -> JobSpec {
        let mut value = serde_json::json!({
            "url": "https://www.youtube.com/watch?v=abc",
            "name": "video",
            "directory": ".",
            "mode": "vod",
        });
        let target = value.as_object_mut().expect("object fixture");
        for (key, override_value) in overrides.as_object().expect("object overrides") {
            target.insert(key.clone(), override_value.clone());
        }
        serde_json::from_value(value).expect("job spec fixture")
    }

    #[test]
    fn detects_nm3u8_segment_count_failure_after_progress_text() {
        let line = "Vid Kbps ------------------------------ 971/1064 91.26% 9.67GB/10.60GB 7.33MBps 00:00:23  \r\r22:51:16.307 ERROR: Segment count check not pass, total: 1064, downloaded: 971.\r";

        assert_eq!(
            detect_zero_exit_process_failure(line).as_deref(),
            Some("22:51:16.307 ERROR: Segment count check not pass, total: 1064, downloaded: 971.")
        );
    }

    #[test]
    fn ignores_retryable_nm3u8_403_warning() {
        let line =
            "22:51:15.825 WARN : Response status code does not indicate success: 403 (Forbidden).";

        assert!(detect_zero_exit_process_failure(line).is_none());
    }

    #[test]
    fn recognizes_hls_incomplete_download_error_for_serial_retry() {
        let err = anyhow::anyhow!(
            "HLS range download is incomplete: 22:51:16.307 ERROR: Segment count check not pass, total: 1064, downloaded: 971."
        );

        assert!(is_hls_incomplete_download_error(&err));
    }

    #[test]
    fn twitch_vod_urls_ignore_requested_live_mode() {
        assert!(!effective_live_mode(true, true));
        assert!(effective_live_mode(true, false));
        assert!(!effective_live_mode(false, false));
    }

    #[test]
    fn full_twitch_vod_disables_yt_dlp_fallback() {
        assert!(!allow_twitch_vod_ytdlp_fallback(true, false));
        assert!(allow_twitch_vod_ytdlp_fallback(true, true));
        assert!(allow_twitch_vod_ytdlp_fallback(false, false));
    }

    #[test]
    fn compatible_policy_pins_avc1_and_m4a() {
        let selector = ytdlp_format_selector(&spec(serde_json::json!({})), DownloadKind::Video);

        assert!(selector.starts_with("bestvideo[vcodec^=avc1]+bestaudio[ext=m4a]"));
        // Still degrades to something playable if avc1 is unavailable.
        assert!(selector.ends_with("/best"));
    }

    #[test]
    fn best_policy_leaves_codecs_alone() {
        let selector = ytdlp_format_selector(
            &spec(serde_json::json!({ "video_codec_policy": "best" })),
            DownloadKind::Video,
        );

        assert_eq!(selector, "bestvideo+bestaudio/best");
    }

    #[test]
    fn picked_format_id_survives_a_known_height() {
        // Regression: the height branch used to discard the format id outright,
        // so every rendition of a resolution downloaded the same bytes.
        let selector = ytdlp_format_selector(
            &spec(serde_json::json!({
                "quality": "137",
                "quality_has_video": true,
                "quality_has_audio": false,
                "quality_height": 1080,
            })),
            DownloadKind::Video,
        );

        assert!(selector.starts_with("137+bestaudio[ext=m4a]/137+bestaudio/"));
        assert!(selector.contains("bestvideo[vcodec^=avc1][height<=1080]"));
    }

    #[test]
    fn muxed_format_id_is_used_verbatim() {
        let selector = ytdlp_format_selector(
            &spec(serde_json::json!({
                "quality": "22",
                "quality_has_video": true,
                "quality_has_audio": true,
                "quality_height": 720,
            })),
            DownloadKind::Video,
        );

        assert!(selector.starts_with("22/"));
    }

    #[test]
    fn audio_formats_pick_their_own_container() {
        let m4a = ytdlp_format_selector(
            &spec(serde_json::json!({ "audio_format": "m4a" })),
            DownloadKind::Audio,
        );
        let opus = ytdlp_format_selector(
            &spec(serde_json::json!({ "audio_format": "opus" })),
            DownloadKind::Audio,
        );
        let mp3 = ytdlp_format_selector(
            &spec(serde_json::json!({ "audio_format": "mp3" })),
            DownloadKind::Audio,
        );

        assert_eq!(m4a, "bestaudio[ext=m4a]/bestaudio/best");
        assert_eq!(opus, "bestaudio[ext=webm]/bestaudio/best");
        assert_eq!(mp3, "bestaudio/best");
    }
    #[test]
    fn range_without_start_begins_at_zero() {
        let fragments = normalized_fragments(&spec(serde_json::json!({ "end": "0:10:00" })));

        assert_eq!(fragments.len(), 1);
        assert_eq!(fragments[0].start, "00:00:00");
        assert_eq!(fragments[0].end, "0:10:00");
    }

    #[test]
    fn range_without_end_stays_whole_recording() {
        let fragments = normalized_fragments(&spec(serde_json::json!({ "start": "0:10:00" })));

        assert!(fragments.is_empty());
    }
}
