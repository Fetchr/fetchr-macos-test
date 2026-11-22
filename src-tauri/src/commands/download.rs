use std::sync::Arc;

use tauri::State;

use crate::jobs::types::{Job, JobSpec};
use crate::AppState;

#[tauri::command]
pub fn enqueue_job(state: State<'_, AppState>, spec: JobSpec) -> Job {
    state.queue.enqueue(spec)
}

/// Free (available) bytes on the volume containing `path`. Walks up to the
/// first existing ancestor when the folder itself does not exist yet. Used by
/// the live recorder page to warn before a long recording fills the disk.
#[tauri::command]
pub fn get_disk_free_space(path: String) -> Result<u64, String> {
    let mut probe = std::path::PathBuf::from(&path);
    while !probe.exists() {
        if !probe.pop() {
            return Err(format!("Путь не существует: {path}"));
        }
    }
    fs2::available_space(&probe).map_err(|e| format!("Не удалось узнать свободное место: {e}"))
}

/// Strip characters that are invalid in Windows file names (same rules the
/// runner uses for output stems).
fn sanitize_file_name(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    for ch in raw.chars() {
        if matches!(ch, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') {
            out.push('_');
        } else {
            out.push(ch);
        }
    }
    out.trim().trim_matches('.').to_string()
}

/// Remux (and optionally trim) the growing live recording into `output`.
///
/// ffmpeg reads the recording in place, so a clip reads only its own range
/// instead of the whole multi-gigabyte file. Only if that fails does it fall
/// back to the old way: copy the whole recording to `temp_copy` first.
/// No `+faststart`: it would rewrite the finished file once more, and the
/// local player and editors read the index from the end just as well.
async fn remux_live_snapshot(
    ffmpeg: &std::path::Path,
    input: &std::path::Path,
    temp_copy: &std::path::Path,
    output: &std::path::Path,
    start_sec: Option<f64>,
    end_sec: Option<f64>,
) -> Result<(), String> {
    let run = |source: std::path::PathBuf| {
        let mut cmd = tokio::process::Command::new(ffmpeg);
        #[cfg(windows)]
        {
            cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        }
        cmd.arg("-y").arg("-hide_banner");
        if let Some(start) = start_sec {
            cmd.arg("-ss").arg(format!("{:.3}", start));
        }
        if let Some(end) = end_sec {
            cmd.arg("-to").arg(format!("{:.3}", end));
        }
        cmd.arg("-i")
            .arg(source)
            .args(["-c", "copy"])
            .arg(output)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null());
        async move { cmd.status().await.map(|status| status.success()).unwrap_or(false) }
    };

    if run(input.to_path_buf()).await {
        return Ok(());
    }
    let _ = tokio::fs::remove_file(output).await;

    let (from, to) = (input.to_path_buf(), temp_copy.to_path_buf());
    tokio::task::spawn_blocking(move || std::fs::copy(from, to))
        .await
        .map_err(|e| format!("Не удалось скопировать файл: {e}"))?
        .map_err(|e| format!("Не удалось скопировать файл: {e}"))?;
    let ok = run(temp_copy.to_path_buf()).await;
    let _ = tokio::fs::remove_file(temp_copy).await;
    if ok {
        Ok(())
    } else {
        Err("ffmpeg не смог обработать файл".to_string())
    }
}

/// Locate the in-progress live recording file. N_m3u8DL-RE records to
/// `fetchr_tmp_<job id>.mp4` (its `--save-name`); auto-reconnect attempts use
/// `fetchr_tmp_<job id>_r<N>`. The newest matching file wins, falling back to
/// the post-rename task-name file (`<name>.mp4` / `<name> (N).mp4`).
fn live_recording_file(
    dir: &std::path::Path,
    job: &Job,
    sanitized_name: &str,
) -> Option<std::path::PathBuf> {
    let tmp_prefix = format!("fetchr_tmp_{}", job.id);
    let mut best: Option<(std::time::SystemTime, std::path::PathBuf)> = None;
    let mut consider = |p: std::path::PathBuf| {
        if let Ok(meta) = std::fs::metadata(&p) {
            if meta.is_file() && meta.len() > 0 {
                let modified = meta.modified().unwrap_or(std::time::SystemTime::UNIX_EPOCH);
                if best.as_ref().map(|(t, _)| modified > *t).unwrap_or(true) {
                    best = Some((modified, p));
                }
            }
        }
    };
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            let path = entry.path();
            if !name.starts_with(&tmp_prefix) {
                continue;
            }
            if path.is_dir() {
                // N_m3u8DL-RE keeps the growing intermediate inside a working
                // folder named after the save-name while merging in real time.
                consider(path.join(format!("{name}.mp4")));
                consider(path.join(format!("{name}.ts")));
            } else if name.ends_with(".mp4") || name.ends_with(".ts") {
                consider(path);
            }
        }
    }
    // Renamed final/parts (after stop or between reconnect attempts).
    consider(dir.join(format!("{sanitized_name}.mp4")));
    consider(dir.join(format!("{sanitized_name}.ts")));
    for n in 1..=30u32 {
        consider(dir.join(format!("{sanitized_name} ({n}).mp4")));
        consider(dir.join(format!("{sanitized_name} ({n}).ts")));
    }
    best.map(|(_, p)| p)
}

#[tauri::command]
pub fn start_queue(state: State<'_, AppState>, max_concurrent: Option<usize>) {
    let q: Arc<_> = state.queue.clone();
    // reset the paused flag and start draining
    let limit = max_concurrent.unwrap_or_else(|| q.max_concurrent());
    q.clone().resume(limit);
}

#[tauri::command]
pub fn set_queue_concurrency(state: State<'_, AppState>, max_concurrent: usize) {
    state.queue.set_max_concurrent(max_concurrent);
}

#[tauri::command]
pub fn pause_queue(state: State<'_, AppState>) {
    state.queue.pause();
}

#[tauri::command]
pub fn cancel_job(state: State<'_, AppState>, id: String) {
    state.queue.cancel(&id);
}

#[tauri::command]
pub fn restart_job(state: State<'_, AppState>, id: String, max_concurrent: Option<usize>) -> bool {
    let restarted = state.queue.restart(&id);
    if restarted {
        let q: Arc<_> = state.queue.clone();
        let limit = max_concurrent.unwrap_or_else(|| q.max_concurrent());
        q.resume(limit);
    }
    restarted
}

#[tauri::command]
pub fn remove_job(state: State<'_, AppState>, id: String) -> bool {
    state.queue.remove(&id)
}

#[tauri::command]
pub fn job_log_text(state: State<'_, AppState>, id: String) -> Option<String> {
    state.queue.job_log_text(&id)
}

#[tauri::command]
pub fn move_job(state: State<'_, AppState>, id: String, direction: String) -> bool {
    state.queue.move_job(&id, &direction)
}

#[tauri::command]
pub fn set_job_priority(state: State<'_, AppState>, id: String, priority: i32) -> bool {
    state.queue.set_priority(&id, priority)
}

#[tauri::command]
pub fn list_jobs(state: State<'_, AppState>) -> Vec<Job> {
    state.queue.list()
}

#[tauri::command]
pub fn clear_completed(state: State<'_, AppState>) {
    state.queue.clear_completed();
}

/// Format seconds as `HH-MM-SS` (file-name safe).
fn format_ts_for_name(sec: f64) -> String {
    let total = sec.max(0.0).round() as u64;
    format!(
        "{:02}-{:02}-{:02}",
        total / 3600,
        (total % 3600) / 60,
        total % 60
    )
}

#[tauri::command]
pub async fn split_live_recording(
    state: State<'_, AppState>,
    id: String,
    fetchr_mute_enabled: bool,
    sponsor_blur_enabled: bool,
    vocal_remover_enabled: bool,
    record_chat_separate: bool,
    start_time_sec: Option<f64>,
    end_time_sec: Option<f64>,
    label: Option<String>,
) -> Result<String, String> {
    let queue = state.queue.clone();
    let jobs = queue.list();
    let job = jobs
        .iter()
        .find(|j| j.id == id)
        .ok_or_else(|| "Задача не найдена".to_string())?;

    if job.status != crate::jobs::types::JobStatus::Running {
        return Err("Запись не запущена".to_string());
    }

    let dir = std::path::PathBuf::from(&job.spec.directory);

    // Sanitize the spec name just like runner.rs
    let sanitized_name = sanitize_file_name(&job.spec.name);
    let sanitized_name = if sanitized_name.is_empty() {
        "download".to_string()
    } else {
        sanitized_name
    };

    let input_file = live_recording_file(&dir, job, &sanitized_name)
        .ok_or_else(|| "Файл записи еще не создан. Подождите несколько секунд.".to_string())?;

    // File name carries the manual label and the time range, so the chronology
    // is visible right in the file explorer:
    //   "Стрим — Смешной момент [01-15-30 → 01-42-10].mp4"
    let clean_label = label
        .as_deref()
        .map(sanitize_file_name)
        .filter(|l| !l.is_empty());
    let range = match (start_time_sec, end_time_sec) {
        (Some(s), Some(e)) => Some(format!(
            "[{} → {}]",
            format_ts_for_name(s),
            format_ts_for_name(e)
        )),
        _ => None,
    };
    let stem = match (&clean_label, &range) {
        (Some(l), Some(r)) => format!("{sanitized_name} — {l} {r}"),
        (Some(l), None) => format!("{sanitized_name} — {l}"),
        (None, Some(r)) => format!("{sanitized_name} {r}"),
        (None, None) => format!("{sanitized_name}_part"),
    };
    let mut output_file = dir.join(format!("{stem}.mp4"));
    let mut index = 1u32;
    while output_file.exists() {
        index += 1;
        output_file = dir.join(format!("{stem} ({index}).mp4"));
    }

    let temp_file = dir.join(format!("{}_temp_split.mp4", sanitized_name));
    let bin_dir = job.spec.binaries_dir.as_deref().map(std::path::Path::new);
    let ffmpeg = crate::binaries::resolve_binary(crate::binaries::FFMPEG, bin_dir)
        .ok_or_else(|| "Утилита ffmpeg не найдена в настройках".to_string())?;
    remux_live_snapshot(
        &ffmpeg,
        &input_file,
        &temp_file,
        &output_file,
        start_time_sec,
        end_time_sec,
    )
    .await?;

    // Run post-processing pipeline
    let url_lower = job.spec.url.to_lowercase();
    let chat_sidecar_path = if url_lower.contains("kick.com") {
        Some(dir.join(format!("{}_kick_live_chat.json", sanitized_name)))
    } else if url_lower.contains("twitch.tv") {
        Some(dir.join(format!("{}_twitch_live_chat.json", sanitized_name)))
    } else {
        None
    };

    // The recorder rewrites the chat sidecar only every so often on a busy
    // stream; the clip is usually the last minute, so ask for a fresh write.
    if chat_sidecar_path.is_some() {
        crate::chat_overlay::live_flush::flush_live_chat(
            &job.id,
            std::time::Duration::from_secs(3),
        )
        .await;
    }

    let processed_file = post_process_file(
        &queue,
        &output_file,
        job,
        fetchr_mute_enabled,
        sponsor_blur_enabled,
        vocal_remover_enabled,
        record_chat_separate,
        chat_sidecar_path.as_deref(),
        start_time_sec,
        end_time_sec,
    )
    .await
    .map_err(|e| format!("Ошибка постобработки: {}", e))?;

    let result_name = processed_file
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .into_owned();
    Ok(result_name)
}

/// Build a seekable snapshot of the in-progress recording so the user can
/// review/scrub everything captured so far while recording keeps running.
/// Returns a local URL (served by the HLS proxy with Range support).
#[tauri::command]
pub async fn prepare_recording_review(
    state: State<'_, AppState>,
    id: String,
) -> Result<String, String> {
    let queue = state.queue.clone();
    let jobs = queue.list();
    let job = jobs
        .iter()
        .find(|j| j.id == id)
        .ok_or_else(|| "Задача не найдена".to_string())?;

    let dir = std::path::PathBuf::from(&job.spec.directory);

    let mut out = String::with_capacity(job.spec.name.len());
    for ch in job.spec.name.chars() {
        if matches!(ch, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') {
            out.push('_');
        } else {
            out.push(ch);
        }
    }
    let sanitized_name = out.trim().trim_matches('.').to_string();
    let sanitized_name = if sanitized_name.is_empty() {
        "download".to_string()
    } else {
        sanitized_name
    };

    let input_file = live_recording_file(&dir, job, &sanitized_name)
        .ok_or_else(|| "Файл записи еще не создан. Подождите несколько секунд.".to_string())?;

    // URL-safe output name (the recording name may contain spaces / unicode).
    let safe_id: String = id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    let temp_file = dir.join(format!("fetchr_review_{safe_id}_temp.mp4"));
    let review_name = format!("fetchr_review_{safe_id}.mp4");
    let review_file = dir.join(&review_name);

    let bin_dir = job.spec.binaries_dir.as_deref().map(std::path::Path::new);
    let ffmpeg = crate::binaries::resolve_binary(crate::binaries::FFMPEG, bin_dir)
        .ok_or_else(|| "Утилита ffmpeg не найдена в настройках".to_string())?;

    remux_live_snapshot(&ffmpeg, &input_file, &temp_file, &review_file, None, None)
        .await
        .map_err(|_| "ffmpeg не смог подготовить предпросмотр записи".to_string())?;

    let review_id = format!("review-{safe_id}");
    crate::hls_proxy::register_preview_file(&review_id, &dir, &review_name)
}

#[tauri::command]
pub async fn stop_and_process_live_recording(
    state: State<'_, AppState>,
    id: String,
    fetchr_mute_enabled: bool,
    sponsor_blur_enabled: bool,
    vocal_remover_enabled: bool,
    record_chat_separate: bool,
) -> Result<String, String> {
    let queue = state.queue.clone();
    let jobs = queue.list();
    let job = jobs
        .iter()
        .find(|j| j.id == id)
        .ok_or_else(|| "Задача не найдена".to_string())?
        .clone();

    // 1. Cancel the active job
    queue.cancel(&id);

    // 2. Wait up to 5 seconds for the job to stop running
    let mut stopped = false;
    for _ in 0..25 {
        tokio::time::sleep(tokio::time::Duration::from_millis(200)).await;
        if let Some(j) = queue.list().iter().find(|j| j.id == id) {
            if j.status != crate::jobs::types::JobStatus::Running {
                stopped = true;
                break;
            }
        } else {
            stopped = true;
            break;
        }
    }

    if !stopped {
        return Err("Не удалось остановить запись вовремя".to_string());
    }

    // Give a brief moment for locks to release
    tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;

    // 3. Locate input file
    let dir = std::path::PathBuf::from(&job.spec.directory);
    let mut out = String::with_capacity(job.spec.name.len());
    for ch in job.spec.name.chars() {
        if matches!(ch, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') {
            out.push('_');
        } else {
            out.push(ch);
        }
    }
    let sanitized_name = out.trim().trim_matches('.').to_string();
    let sanitized_name = if sanitized_name.is_empty() {
        "download".to_string()
    } else {
        sanitized_name
    };

    let input_file = live_recording_file(&dir, &job, &sanitized_name)
        .ok_or_else(|| "Файл записи не найден.".to_string())?;

    // 4. Run post-processing
    let url_lower = job.spec.url.to_lowercase();
    let chat_sidecar_path = if url_lower.contains("kick.com") {
        Some(dir.join(format!("{}_kick_live_chat.json", sanitized_name)))
    } else if url_lower.contains("twitch.tv") {
        Some(dir.join(format!("{}_twitch_live_chat.json", sanitized_name)))
    } else {
        None
    };

    let processed_file = post_process_file(
        &queue,
        &input_file,
        &job,
        fetchr_mute_enabled,
        sponsor_blur_enabled,
        vocal_remover_enabled,
        record_chat_separate,
        chat_sidecar_path.as_deref(),
        None,
        None,
    )
    .await
    .map_err(|e| format!("Ошибка постобработки: {}", e))?;

    let result_name = processed_file
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .into_owned();
    Ok(result_name)
}

pub async fn post_process_file(
    queue: &std::sync::Arc<crate::jobs::queue::QueueManager>,
    input_file: &std::path::Path,
    job: &crate::jobs::types::Job,
    fetchr_mute_enabled: bool,
    sponsor_blur_enabled: bool,
    vocal_remover_enabled: bool,
    record_chat_separate: bool,
    chat_sidecar_path: Option<&std::path::Path>,
    start_time_sec: Option<f64>,
    end_time_sec: Option<f64>,
) -> anyhow::Result<std::path::PathBuf> {
    use std::sync::atomic::AtomicBool;
    let mut current_file = input_file.to_path_buf();
    let bin_dir = job.spec.binaries_dir.as_deref().map(std::path::Path::new);
    let cancel = Arc::new(AtomicBool::new(false));

    // 1. Sponsor Blurring
    if sponsor_blur_enabled {
        let blurred = crate::chat_overlay::blur::render_blur_zones_for_video(
            queue,
            job,
            &current_file,
            cancel.clone(),
            bin_dir,
        )
        .await?;
        current_file = blurred;
    }

    // 2. Vocal Remover (HTDemucs + remuxing back into video)
    if vocal_remover_enabled {
        let ffmpeg = crate::binaries::resolve_binary(crate::binaries::FFMPEG, bin_dir)
            .ok_or_else(|| anyhow::anyhow!("ffmpeg.exe not found"))?;

        let vr_settings = job.spec.vocal_remover_settings.clone().unwrap_or_else(|| {
            crate::jobs::types::VocalRemoverSettings {
                mode: crate::jobs::types::VocalRemoverMode::FastHtdemucs,
                workflow: crate::jobs::types::VocalRemoverWorkflow::AntiCopyright,
                custom_segments: None,
            }
        });

        let vr_result = crate::jobs::vocal_remover::run_on_local_file(
            queue,
            &job.id,
            &current_file,
            &ffmpeg,
            vr_settings,
            cancel.clone(),
        )
        .await?;

        if let Some(clean_audio_path) = vr_result
            .anti_copyright_path
            .as_deref()
            .map(std::path::Path::new)
        {
            let remuxed_file = current_file.with_file_name(format!(
                "{}_clean.mp4",
                current_file
                    .file_stem()
                    .and_then(|s| s.to_str())
                    .unwrap_or("video")
            ));

            let mut cmd = tokio::process::Command::new(&ffmpeg);
            #[cfg(windows)]
            {
                cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
            }
            cmd.arg("-y")
                .arg("-hide_banner")
                .arg("-i")
                .arg(&current_file)
                .arg("-i")
                .arg(clean_audio_path)
                .args([
                    "-map",
                    "0:v:0",
                    "-map",
                    "1:a:0",
                    "-c:v",
                    "copy",
                    // The native encoder's fast coder: the default twoloop
                    // search was the slowest step of this remux (~2x).
                    "-c:a",
                    "aac",
                    "-b:a",
                    "192k",
                    "-aac_coder",
                    "fast",
                    "-shortest",
                ])
                .arg(&remuxed_file);

            let status = cmd.status().await?;
            if status.success() {
                current_file = remuxed_file;
            }
        }
    }

    // 3. Swear word removal (Fetchr Mute)
    if fetchr_mute_enabled {
        let fetchr_muted =
            crate::jobs::fetchr_mute::run_on_local_file(queue, job, &current_file, cancel.clone())
                .await?;
        current_file = fetchr_muted;
    }

    // 4. Chat log as JSON only (no video render). The full sidecar json is
    // written continuously during recording; here we only produce a trimmed
    // json next to a saved fragment so its timestamps start at 0.
    if record_chat_separate {
        if let Some(chat_path) = chat_sidecar_path {
            let has_range = start_time_sec.is_some() || end_time_sec.is_some();
            if chat_path.is_file() && has_range {
                let output_dir = input_file.parent().unwrap_or(std::path::Path::new("."));
                let output_name = format!(
                    "{}_chat.json",
                    current_file
                        .file_stem()
                        .and_then(|s| s.to_str())
                        .unwrap_or("video")
                );

                if let Ok(mut messages) = crate::chat_overlay::model::read_chat_messages(chat_path)
                {
                    let start = start_time_sec.unwrap_or(0.0);
                    messages.retain(|m| {
                        m.timestamp >= start
                            && end_time_sec.map(|end| m.timestamp <= end).unwrap_or(true)
                    });
                    for m in &mut messages {
                        m.timestamp -= start;
                    }

                    let out_json = output_dir.join(&output_name);
                    // Carry the channel over from the full sidecar, or the trimmed copy renders
                    // without the channel's 7TV/BTTV/FFZ emotes.
                    let streamer = crate::chat_overlay::model::read_chat_streamer(chat_path);
                    match crate::chat_overlay::model::write_chat_messages_for_streamer(
                        &out_json,
                        &messages,
                        streamer.as_ref(),
                    ) {
                        Ok(()) => queue.emit_job_log(
                            &job.id,
                            &format!(
                                "Чат отрезка сохранён: {} ({} сообщений)",
                                out_json.display(),
                                messages.len()
                            ),
                        ),
                        Err(err) => queue.emit_job_log(
                            &job.id,
                            &format!("!! Не удалось сохранить json чата отрезка: {err:#}"),
                        ),
                    }
                }
            }
        }
    }

    Ok(current_file)
}
