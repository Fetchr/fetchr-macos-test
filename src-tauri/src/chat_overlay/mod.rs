pub mod appear;
pub mod badge_art;
pub mod benchmark;
pub mod blur;
pub mod blur_filter;
pub mod cache;
pub mod composer;
pub mod diagnostics;
pub mod ffmpeg_metrics;
pub mod fast_blend;
pub mod fonts;
pub mod import_formats;
pub mod kick_history;
pub mod kick_live;
pub mod layout;
pub mod live_flush;
pub mod mirror;
pub mod model;
pub mod providers;
pub mod renderer;
pub mod settings;
pub mod twitch_live;
pub mod wtv_chat;
pub mod wtv_live;

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Instant;

use anyhow::{anyhow, Context, Result};

use crate::binaries::{resolve_binary, FFMPEG, YTDLP};
use crate::chat_overlay::blur_filter::{map_blur_zones_to_fragments, offset_blur_zone_times};
use crate::chat_overlay::kick_live::is_kick_live_channel_url;
use crate::jobs::queue::QueueManager;
use crate::jobs::types::{
    AlphaOutputFormat, ChatComposeMode, ChatRenderCodec, Job, JobKind, JobProgress, Mode,
};

use self::composer::ChatOverlayComposer;
use self::model::read_chat_messages;
use self::providers::{apply_third_party_emotes, provider_for_job, resolve_chat_channel};
use self::renderer::ChatOverlayRenderer;
use self::settings::EffectiveChatOverlaySettings;

/// Resolve the chat channel from the job URL and overlay channel-specific 7TV/BTTV/FFZ emotes
/// onto `messages`. Applied centrally (before writing chat.json) so every chat source — VOD
/// download, live-recorded sidecar, generic yt-dlp, local json import — is handled the same way.
/// On a channel that cannot be resolved from the URL it logs and leaves messages untouched.
///
/// `streamer` is the identity read from the chat json being rendered; it carries a local file
/// render, where the job URL is a path and names no channel. Returns the identity to stamp on the
/// chat json we write, so the next render of that file resolves the channel straight away.
async fn enrich_third_party_emotes(
    job: &Job,
    effective: &EffectiveChatOverlaySettings,
    messages: &mut [model::ChatMessage],
    streamer: Option<&model::ChatStreamer>,
    queue: &Arc<QueueManager>,
) -> Option<model::ChatStreamer> {
    if !(effective.show_bttv || effective.show_ffz || effective.show_7tv) {
        return streamer.cloned();
    }
    let (client, proxy_client) = chat_http_clients(&job.spec.proxy);
    match resolve_chat_channel(job, streamer, &client, proxy_client.as_ref()).await {
        Some(channel) => {
            apply_third_party_emotes(
                &client,
                proxy_client.as_ref(),
                &channel,
                effective,
                messages,
                queue,
                &job.id,
            )
            .await;
            // Only a Twitch identity is worth recording: the chat json format states the
            // streamer as a Twitch login/id, so stamping a Kick id there would send the next
            // render to a different channel's emotes.
            if channel.platform != providers::EmotePlatform::Twitch {
                return streamer.cloned();
            }
            Some(model::ChatStreamer {
                login: streamer
                    .and_then(|streamer| streamer.login.clone())
                    .or_else(|| {
                        twitch_live::parse_twitch_channel_url(&job.spec.url).or_else(|| {
                            job.spec
                                .chat_source_url
                                .as_deref()
                                .and_then(twitch_live::parse_twitch_channel_url)
                        })
                    }),
                id: Some(channel.id.clone()),
            })
        }
        None => {
            emit_log(
                queue,
                &job.id,
                "Chat overlay: channel not resolved from URL — third-party emotes skipped",
            );
            streamer.cloned()
        }
    }
}

/// Scratch folder of one render (chat cache, intermediate frames). It sits next to
/// the output for disk space, and is removed when the render ends, whatever the
/// outcome, so no `*.chat_overlay` folders pile up in the user's folders.
struct ScratchDir(PathBuf);

impl ScratchDir {
    fn create(path: PathBuf) -> Result<Self> {
        std::fs::create_dir_all(&path).with_context(|| format!("create {}", path.display()))?;
        Ok(Self(path))
    }
}

impl std::ops::Deref for ScratchDir {
    type Target = Path;

    fn deref(&self) -> &Path {
        &self.0
    }
}

impl Drop for ScratchDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

pub async fn render_and_compose_for_video(
    queue: &Arc<QueueManager>,
    job: &Job,
    input_video: &Path,
    cancel: Arc<AtomicBool>,
    bin_dir: Option<&Path>,
) -> Result<PathBuf> {
    let total_started = Instant::now();
    let settings = job
        .spec
        .chat_overlay
        .clone()
        .unwrap_or_default()
        .with_defaults();
    let mut effective = EffectiveChatOverlaySettings::from(settings.clone());
    apply_render_codec_defaults(&mut effective);

    let ffmpeg = resolve_binary(FFMPEG, bin_dir)
        .ok_or_else(|| anyhow!("ffmpeg.exe not found - set binaries folder in Settings"))?;
    let ytdlp = resolve_binary(YTDLP, bin_dir);

    let stem = input_video
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("video");
    let work_dir = ScratchDir::create(
        input_video
            .parent()
            .unwrap_or_else(|| Path::new("."))
            .join(format!("{stem}.chat_overlay")),
    )?;

    emit_log(queue, &job.id, "Chat overlay: preparing chat source...");
    queue.set_progress_stage(
        &job.id,
        60.0,
        64.0,
        Some("Preparing chat source".to_string()),
    );
    queue.set_progress(
        &job.id,
        JobProgress {
            percent: 0.0,
            stage_percent: None,
            stage_start: None,
            stage_end: None,
            stage_started_at: None,
            download_elapsed_ms: None,
            speed: None,
            eta: None,
            size: None,
            message: Some("Preparing chat source".to_string()),
            ..JobProgress::default()
        },
    );

    let chat_json = work_dir.join("chat.json");
    let chat_started = Instant::now();
    let recorded_chat_path = find_recorded_chat_for_video(job, input_video);
    // The recorded sidecar is the only place a VPS/live job states its channel: its job URL can
    // be a bare agent endpoint, which resolves to no channel at all.
    let chat_streamer = recorded_chat_path
        .as_deref()
        .and_then(model::read_chat_streamer);
    let recorded_messages =
        if let Some(recorded_chat) = recorded_chat_path.as_deref() {
            emit_log(
                queue,
                &job.id,
                &format!(
                    "Chat overlay: using recorded chat sidecar {}",
                    recorded_chat.display()
                ),
            );
            if let Some(messages) = read_non_empty_recorded_chat(recorded_chat)
                .with_context(|| format!("read recorded chat {}", recorded_chat.display()))?
            {
                model::write_chat_messages_for_streamer(
                    &chat_json,
                    &messages,
                    chat_streamer.as_ref(),
                )
                .with_context(|| format!("write {}", chat_json.display()))?;
                Some(messages)
            } else {
                if is_kick_live_job(job) || is_wtv_job(job) || is_vps_download_job(job) {
                    return Err(anyhow!(
                        "recorded chat sidecar is empty: {}",
                        recorded_chat.display()
                    ));
                }
                emit_log(
                    queue,
                    &job.id,
                    &format!(
                        "!! Chat overlay: recorded Kick chat sidecar is empty, ignoring {}",
                        recorded_chat.display()
                    ),
                );
                None
            }
        } else {
            None
        };
    let mut messages = if let Some(messages) = recorded_messages {
        messages
    } else if is_wtv_job(job) && !matches!(job.spec.mode, Mode::Live) {
        return Err(anyhow!(
            "W.TV не хранит чат прошедших трансляций: чат можно записать только во время эфира (запись с w.tv/<канал>)."
        ));
    } else if is_kick_live_job(job) || is_wtv_job(job) || is_vps_download_job(job) {
        return Err(anyhow!(
            "recorded chat sidecar was not found for {}. The recorder did not capture chat.",
            input_video.display()
        ));
    } else {
        emit_log(queue, &job.id, "Chat overlay: downloading chat replay...");
        queue.set_progress_stage(
            &job.id,
            64.0,
            72.0,
            Some("Downloading chat replay".to_string()),
        );
        let provider = provider_for_job(job, ytdlp);
        provider
            .download_chat(job, &effective, &chat_json, queue, cancel.clone())
            .await
            .map_err(|err| anyhow!("download chat replay: {err:#}"))?
    };
    emit_log(
        queue,
        &job.id,
        &format!(
            "Chat overlay: chat download time {}",
            format_duration(chat_started.elapsed().as_secs_f64())
        ),
    );

    if cancel.load(Ordering::SeqCst) {
        return Err(anyhow!("cancelled"));
    }

    queue.set_progress_stage(
        &job.id,
        72.0,
        74.0,
        Some("Normalizing chat timestamps".to_string()),
    );
    let trim_start = parse_hms(job.spec.start.as_deref()).unwrap_or(0.0);
    let trim_end = parse_hms(job.spec.end.as_deref());
    let duration = trim_end
        .map(|end| (end - trim_start).max(0.0))
        .or(job.spec.meta.duration)
        .or_else(|| infer_duration_from_messages(&messages, &effective));

    normalize_chat_timestamps(&mut messages, trim_start, duration);
    if messages.is_empty() {
        return Err(anyhow!(
            "chat source is empty after timestamp normalization"
        ));
    }
    let chat_streamer = enrich_third_party_emotes(
        job,
        &effective,
        &mut messages,
        chat_streamer.as_ref(),
        queue,
    )
    .await;
    self::model::write_chat_messages_for_streamer(&chat_json, &messages, chat_streamer.as_ref())
        .with_context(|| format!("write {}", chat_json.display()))?;

    let alpha_overlay = input_video.with_file_name(format!(
        "{stem}_chat_overlay.{}",
        alpha_extension(effective.alpha_output_format)
    ));
    let render_duration = duration.unwrap_or_else(|| {
        let tail = effective.message_lifetime_sec.min(10.0);
        messages.last().map(|m| m.timestamp + tail).unwrap_or(tail)
    });

    emit_log(
        queue,
        &job.id,
        &format!("Chat overlay: rendering transparent layer ({render_duration:.1}s)..."),
    );
    queue.set_progress_stage(
        &job.id,
        74.0,
        96.0,
        Some("Rendering chat frames".to_string()),
    );
    queue.set_progress(
        &job.id,
        JobProgress {
            percent: 0.0,
            stage_percent: None,
            stage_start: None,
            stage_end: None,
            stage_started_at: None,
            download_elapsed_ms: None,
            speed: None,
            eta: None,
            size: None,
            message: Some("Rendering chat overlay".to_string()),
            ..JobProgress::default()
        },
    );

    let performance = job
        .spec
        .performance
        .clone()
        .unwrap_or_default()
        .with_defaults();
    let mut renderer = ChatOverlayRenderer::new(
        effective.clone(),
        ffmpeg.clone(),
        work_dir.to_path_buf(),
        performance.render_workers,
        performance.profile,
        Some(performance.network_threads()),
        performance.gpu_encoder_mode,
        job.spec.proxy.resolved(),
    )?;
    let output_video = input_video.with_file_name(format!("{stem}_chat.mp4"));
    let compose_blur_zones = if job.spec.fragments.is_empty() {
        offset_blur_zone_times(&job.spec.blur_zones, blur_timeline_offset_seconds(job))
    } else {
        let (mapped, disabled) =
            map_blur_zones_to_fragments(&job.spec.blur_zones, &job.spec.fragments);
        if disabled > 0 {
            emit_log(
                queue,
                &job.id,
                &format!(
                    "Sponsor blur: {disabled} tracked zone(s) disabled - all keyframes fall outside the cut fragments"
                ),
            );
        }
        mapped
    };

    if effective.compose_mode == ChatComposeMode::Direct {
        queue.set_progress_stage(
            &job.id,
            74.0,
            100.0,
            Some("Direct render: video + blur + chat".to_string()),
        );
        let direct_started = Instant::now();
        let alpha_output = effective
            .save_alpha_overlay
            .then_some(alpha_overlay.as_path());
        renderer
            .render_direct_outputs(
                &messages,
                render_duration,
                input_video,
                alpha_output,
                &output_video,
                performance,
                &compose_blur_zones,
                queue,
                &job.id,
                cancel,
            )
            .await?;
        emit_log(
            queue,
            &job.id,
            &format!(
                "Chat overlay: direct total time {}",
                format_duration(direct_started.elapsed().as_secs_f64())
            ),
        );
    } else {
        queue.set_progress_stage(
            &job.id,
            74.0,
            88.0,
            Some("Rendering chat alpha overlay".to_string()),
        );
        let overlay_started = Instant::now();
        let chat_pipe_metrics = renderer
            .render_to_mov(
                &messages,
                render_duration,
                &alpha_overlay,
                queue,
                &job.id,
                cancel.clone(),
            )
            .await?;
        emit_log(
            queue,
            &job.id,
            &format!(
                "Chat overlay: MOV overlay stage time {}",
                format_duration(overlay_started.elapsed().as_secs_f64())
            ),
        );

        if cancel.load(Ordering::SeqCst) {
            return Err(anyhow!("cancelled"));
        }

        emit_log(queue, &job.id, "Chat overlay: composing final MP4...");
        queue.set_progress_stage(
            &job.id,
            88.0,
            100.0,
            Some("Compositing final video".to_string()),
        );
        queue.set_progress(
            &job.id,
            JobProgress {
                percent: 0.0,
                stage_percent: None,
                stage_start: None,
                stage_end: None,
                stage_started_at: None,
                download_elapsed_ms: None,
                speed: None,
                eta: None,
                size: None,
                message: Some("Compositing chat overlay".to_string()),
                ..JobProgress::default()
            },
        );

        let composer = ChatOverlayComposer::new(effective, ffmpeg, performance, compose_blur_zones);
        let compose_started = Instant::now();
        composer
            .compose(
                input_video,
                &alpha_overlay,
                &output_video,
                render_duration,
                Some(chat_pipe_metrics),
                queue,
                &job.id,
                cancel,
            )
            .await?;
        emit_log(
            queue,
            &job.id,
            &format!(
                "Chat overlay: compose time {}",
                format_duration(compose_started.elapsed().as_secs_f64())
            ),
        );
    }

    emit_log(
        queue,
        &job.id,
        &format!(
            "Chat overlay: total with chat {}",
            format_duration(total_started.elapsed().as_secs_f64())
        ),
    );
    Ok(output_video)
}

pub async fn download_and_render_chat_only(
    queue: &Arc<QueueManager>,
    job: &Job,
    cancel: Arc<AtomicBool>,
    bin_dir: Option<&Path>,
) -> Result<PathBuf> {
    let total_started = Instant::now();
    let settings = job
        .spec
        .chat_overlay
        .clone()
        .unwrap_or_default()
        .with_defaults();
    let mut effective = EffectiveChatOverlaySettings::from(settings);
    apply_render_codec_defaults(&mut effective);

    let ffmpeg = resolve_binary(FFMPEG, bin_dir)
        .ok_or_else(|| anyhow!("ffmpeg.exe not found - set binaries folder in Settings"))?;
    let ytdlp = resolve_binary(YTDLP, bin_dir);
    let output_dir = PathBuf::from(&job.spec.directory);
    std::fs::create_dir_all(&output_dir)
        .with_context(|| format!("create {}", output_dir.display()))?;

    let stem = sanitize_file_stem(&job.spec.name);
    let work_dir = ScratchDir::create(output_dir.join(format!("{stem}.chat_overlay")))?;

    emit_log(queue, &job.id, "Chat-only: downloading chat replay...");
    queue.set_progress(
        &job.id,
        JobProgress {
            percent: 0.0,
            stage_percent: None,
            stage_start: None,
            stage_end: None,
            stage_started_at: None,
            download_elapsed_ms: None,
            speed: None,
            eta: None,
            size: None,
            message: Some("Downloading chat replay".to_string()),
            ..JobProgress::default()
        },
    );

    let chat_json = output_dir.join(format!("{stem}_chat.json"));
    let local_source = Some(Path::new(&job.spec.url)).filter(|path| path.is_file());
    // Rendering a saved chat json: the job URL is that file, so the channel behind the chat can
    // only come from the file itself.
    let chat_streamer = local_source.and_then(model::read_chat_streamer);
    let mut messages = if let Some(local_source) = local_source {
        emit_log(queue, &job.id, "Chat-only: reading local chat JSON file...");
        read_chat_messages(local_source)
            .with_context(|| format!("read local chat json from {}", job.spec.url))?
    } else if is_wtv_job(job) {
        return Err(anyhow!(
            "W.TV не хранит чат прошедших трансляций. Откройте JSON, записанный во время эфира (*_wtv_live_chat.json)."
        ));
    } else {
        let provider = provider_for_job(job, ytdlp);
        let cache_json = work_dir.join("chat.json");
        provider
            .download_chat(job, &effective, &cache_json, queue, cancel.clone())
            .await
            .map_err(|err| anyhow!("download chat replay: {err:#}"))?
    };

    if cancel.load(Ordering::SeqCst) {
        return Err(anyhow!("cancelled"));
    }

    let trim_start = parse_hms(job.spec.start.as_deref()).unwrap_or(0.0);
    let trim_end = parse_hms(job.spec.end.as_deref());
    let duration = trim_end
        .map(|end| (end - trim_start).max(0.0))
        .or(job.spec.meta.duration)
        .or_else(|| infer_duration_from_messages(&messages, &effective));
    normalize_chat_timestamps(&mut messages, trim_start, duration);
    let chat_streamer = enrich_third_party_emotes(
        job,
        &effective,
        &mut messages,
        chat_streamer.as_ref(),
        queue,
    )
    .await;
    self::model::write_chat_messages_for_streamer(&chat_json, &messages, chat_streamer.as_ref())
        .with_context(|| format!("write {}", chat_json.display()))?;

    if effective.json_only {
        queue.set_progress(
            &job.id,
            JobProgress {
                percent: 100.0,
                message: Some("Chat JSON saved".to_string()),
                ..JobProgress::default()
            },
        );
        emit_log(
            queue,
            &job.id,
            &format!(
                "Chat-only (JSON only): saved {} ({} messages) in {}",
                chat_json.display(),
                messages.len(),
                format_duration(total_started.elapsed().as_secs_f64())
            ),
        );
        return Ok(chat_json);
    }

    let render_duration = duration.unwrap_or_else(|| {
        let tail = effective.message_lifetime_sec.min(10.0);
        messages.last().map(|m| m.timestamp + tail).unwrap_or(tail)
    });
    let output = output_dir.join(format!(
        "{stem}_chat_overlay.{}",
        alpha_extension(effective.alpha_output_format)
    ));

    emit_log(
        queue,
        &job.id,
        &format!("Chat-only: rendering transparent layer ({render_duration:.1}s)..."),
    );
    queue.set_progress_stage(
        &job.id,
        10.0,
        100.0,
        Some("Rendering chat overlay".to_string()),
    );
    queue.set_progress(
        &job.id,
        JobProgress {
            percent: 0.0,
            stage_percent: None,
            stage_start: None,
            stage_end: None,
            stage_started_at: None,
            download_elapsed_ms: None,
            speed: None,
            eta: None,
            size: None,
            message: Some("Rendering chat overlay".to_string()),
            ..JobProgress::default()
        },
    );

    let performance = job
        .spec
        .performance
        .clone()
        .unwrap_or_default()
        .with_defaults();
    let mut renderer = ChatOverlayRenderer::new(
        effective,
        ffmpeg,
        work_dir.to_path_buf(),
        performance.render_workers,
        performance.profile,
        Some(performance.network_threads()),
        performance.gpu_encoder_mode,
        job.spec.proxy.resolved(),
    )?;
    renderer
        .render_to_mov(&messages, render_duration, &output, queue, &job.id, cancel)
        .await?;

    emit_log(
        queue,
        &job.id,
        &format!(
            "Chat-only: saved {} and {} in {}",
            output.display(),
            chat_json.display(),
            format_duration(total_started.elapsed().as_secs_f64())
        ),
    );
    Ok(output)
}

fn alpha_extension(format: AlphaOutputFormat) -> &'static str {
    match format {
        AlphaOutputFormat::MovPng => "mov",
        AlphaOutputFormat::MovQtrle => "mov",
        AlphaOutputFormat::WebmVp9 | AlphaOutputFormat::WebmVp8 => "webm",
        AlphaOutputFormat::Ffv1Mkv => "mkv",
        AlphaOutputFormat::Prores4444 => "mov",
        AlphaOutputFormat::LagarithAvi => "avi",
    }
}
fn apply_render_codec_defaults(settings: &mut EffectiveChatOverlaySettings) {
    match settings.render_codec {
        ChatRenderCodec::RawRgbaPipe | ChatRenderCodec::SolidBgFast => {
            settings.compose_mode = ChatComposeMode::Direct;
            settings.save_alpha_overlay = false;
        }
        ChatRenderCodec::QtrleMovRle => {
            settings.compose_mode = ChatComposeMode::Intermediate;
            settings.alpha_output_format = AlphaOutputFormat::MovQtrle;
            settings.save_alpha_overlay = true;
        }
        ChatRenderCodec::Ffv1MkvAlpha => {
            settings.compose_mode = ChatComposeMode::Intermediate;
            settings.alpha_output_format = AlphaOutputFormat::Ffv1Mkv;
            settings.save_alpha_overlay = true;
        }
        ChatRenderCodec::Prores4444 => {
            settings.compose_mode = ChatComposeMode::Intermediate;
            settings.alpha_output_format = AlphaOutputFormat::Prores4444;
            settings.save_alpha_overlay = true;
        }
        ChatRenderCodec::Vp9WebmAlpha => {
            settings.compose_mode = ChatComposeMode::Intermediate;
            settings.alpha_output_format = AlphaOutputFormat::WebmVp9;
            settings.save_alpha_overlay = true;
        }
        ChatRenderCodec::LagarithAvi => {
            settings.compose_mode = ChatComposeMode::Intermediate;
            settings.alpha_output_format = AlphaOutputFormat::LagarithAvi;
            settings.save_alpha_overlay = true;
        }
    }
}

fn sanitize_file_stem(name: &str) -> String {
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
        "chat".to_string()
    } else {
        trimmed
    }
}

fn find_recorded_chat_for_video(job: &Job, input_video: &Path) -> Option<PathBuf> {
    if !is_kick_job(job) && !is_wtv_job(job) && !is_vps_download_job(job) {
        return None;
    }
    let stem = input_video.file_stem().and_then(|s| s.to_str())?;
    let parent = input_video.parent().unwrap_or_else(|| Path::new("."));
    let output_stem = sanitize_file_stem(&job.spec.name);
    let output_dir = PathBuf::from(&job.spec.directory);
    [
        parent.join(format!("{stem}_kick_live_chat.json")),
        parent.join(format!("{stem}.kick_live_chat.json")),
        parent.join(format!("{output_stem}_kick_live_chat.json")),
        output_dir.join(format!("{output_stem}_kick_live_chat.json")),
        parent.join(format!("{stem}_wtv_live_chat.json")),
        parent.join(format!("{output_stem}_wtv_live_chat.json")),
        output_dir.join(format!("{output_stem}_wtv_live_chat.json")),
        output_dir.join(format!("{output_stem}_chat.json")),
    ]
    .into_iter()
    .find(|path| path.is_file())
}

fn is_vps_download_job(job: &Job) -> bool {
    matches!(job.spec.job_kind, Some(JobKind::VpsDownload))
}

fn read_non_empty_recorded_chat(path: &Path) -> Result<Option<Vec<model::ChatMessage>>> {
    let messages = read_chat_messages(path)?;
    if messages.is_empty() {
        Ok(None)
    } else {
        Ok(Some(messages))
    }
}

fn is_kick_job(job: &Job) -> bool {
    job.spec.url.to_ascii_lowercase().contains("kick.com")
        || job
            .spec
            .meta
            .platform
            .as_deref()
            .unwrap_or("")
            .to_ascii_lowercase()
            .contains("kick")
}

fn is_wtv_job(job: &Job) -> bool {
    crate::wtv::is_wtv_url(&job.spec.url)
        || job
            .spec
            .meta
            .platform
            .as_deref()
            .is_some_and(|platform| platform.eq_ignore_ascii_case("wtv"))
}

fn is_kick_live_job(job: &Job) -> bool {
    is_kick_job(job)
        && matches!(job.spec.mode, Mode::Live)
        && is_kick_live_channel_url(&job.spec.url)
}

pub(crate) fn blur_timeline_offset_seconds(job: &Job) -> f64 {
    if !job.spec.fragments.is_empty() {
        return 0.0;
    }
    parse_hms(job.spec.start.as_deref()).unwrap_or(0.0)
}

pub fn emit_log(queue: &Arc<QueueManager>, id: &str, line: &str) {
    queue.emit_job_log(id, line);
}

/// HTTP client for chat-asset traffic (emote/badge metadata and images). Unlike the
/// default client it has explicit timeouts: the 7TV/BTTV/FFZ endpoints are frequently
/// blackholed by DPI, and a timeout-less reqwest client stalls the whole render.
/// When `proxy_url` is set traffic goes through it.
pub(crate) fn chat_http_client(proxy_url: Option<&str>) -> reqwest::Client {
    let mut builder = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(8))
        .timeout(std::time::Duration::from_secs(25))
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36");
    if let Some(url) = proxy_url.filter(|url| !url.trim().is_empty()) {
        match reqwest::Proxy::all(url) {
            Ok(proxy) => {
                builder = builder.proxy(proxy);
            }
            Err(err) => {
                tracing::warn!("invalid proxy url for chat assets ({url}): {err}");
            }
        }
    }
    builder
        .build()
        .unwrap_or_else(|_| reqwest::Client::new())
}

/// Build the (direct, via-proxy) client pair for chat-asset traffic. The proxy client is
/// only created when a proxy is configured; callers try the direct client first and fall
/// back to the proxy one on failure.
pub(crate) fn chat_http_clients(
    proxy: &crate::proxy::ProxyConfig,
) -> (reqwest::Client, Option<reqwest::Client>) {
    let direct = chat_http_client(None);
    let proxied = proxy.resolved().map(|url| chat_http_client(Some(&url)));
    (direct, proxied)
}

pub fn parse_hms(value: Option<&str>) -> Option<f64> {
    let value = value?.trim();
    if value.is_empty() {
        return None;
    }
    let parts: Vec<_> = value.split(':').collect();
    if parts.len() != 3 {
        return None;
    }
    let h = parts[0].parse::<f64>().ok()?;
    let m = parts[1].parse::<f64>().ok()?;
    let s = parts[2].parse::<f64>().ok()?;
    Some(h * 3600.0 + m * 60.0 + s)
}

fn normalize_chat_timestamps(
    messages: &mut Vec<model::ChatMessage>,
    trim_start: f64,
    duration: Option<f64>,
) {
    let trim_end = duration.map(|d| trim_start + d);
    messages.retain(|message| {
        message.timestamp >= trim_start
            && trim_end.map(|end| message.timestamp <= end).unwrap_or(true)
    });
    for message in messages.iter_mut() {
        message.timestamp = (message.timestamp - trim_start).max(0.0);
    }
    messages.sort_by(|a, b| a.timestamp.total_cmp(&b.timestamp));
}

fn infer_duration_from_messages(
    messages: &[model::ChatMessage],
    settings: &EffectiveChatOverlaySettings,
) -> Option<f64> {
    let tail = settings.message_lifetime_sec.min(10.0);
    messages.last().map(|message| message.timestamp + tail)
}

use crate::util::format_duration;

#[cfg(test)]
mod tests {
    use super::read_non_empty_recorded_chat;

    #[test]
    fn empty_recorded_chat_sidecar_is_not_valid() {
        let path =
            std::env::temp_dir().join(format!("fetchr-empty-chat-{}.json", std::process::id()));
        std::fs::write(&path, "[]").expect("write empty sidecar");
        let loaded = read_non_empty_recorded_chat(&path).expect("read empty sidecar");
        let _ = std::fs::remove_file(&path);
        assert!(loaded.is_none());
    }
}
