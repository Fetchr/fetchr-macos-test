//! Download of VPS-recorder clips (video.mp4 + chat.json) as a queue job.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{anyhow, Context, Result};
use futures::StreamExt;
use tokio::io::AsyncWriteExt;

use super::queue::QueueManager;
use super::types::{Job, JobProgress};

/// Record the channel in the chat sidecar the agent hands us.
///
/// The agent sends a bare message array, which names no channel; rendering that file later then
/// resolves no channel and silently drops every 7TV/BTTV/FFZ emote. Best effort: a sidecar that
/// cannot be re-read is left exactly as downloaded.
fn stamp_chat_streamer(path: &Path, job: &Job) {
    use crate::chat_overlay::model::{
        read_chat_messages, write_chat_messages_for_streamer, ChatStreamer,
    };

    let Some(login) = crate::chat_overlay::twitch_live::parse_twitch_channel_url(&job.spec.url)
    else {
        return;
    };
    let Ok(messages) = read_chat_messages(path) else {
        return;
    };
    let streamer = ChatStreamer {
        login: Some(login),
        id: None,
    };
    let _ = write_chat_messages_for_streamer(path, &messages, Some(&streamer));
}

fn sanitize_file_name(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    for ch in raw.chars() {
        if matches!(ch, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') {
            out.push('_');
        } else {
            out.push(ch);
        }
    }
    let trimmed = out.trim().trim_matches('.');
    if trimmed.is_empty() {
        "vps_clip".to_string()
    } else {
        trimmed.to_string()
    }
}

fn format_bytes(bytes: u64) -> String {
    const UNITS: [&str; 4] = ["B", "KiB", "MiB", "GiB"];
    let mut value = bytes as f64;
    let mut idx = 0usize;
    while value >= 1024.0 && idx + 1 < UNITS.len() {
        value /= 1024.0;
        idx += 1;
    }
    if idx == 0 {
        format!("{bytes} B")
    } else {
        format!("{value:.1} {}", UNITS[idx])
    }
}

/// Segments fetched at once. Enough to hide the round-trip latency of the SSH
/// tunnel without swamping a small VPS.
const SEGMENT_CONCURRENCY: usize = 16;

/// One segment, resuming a partial file. Bytes go to the shared `done`
/// counter; a ticker turns that into the job's progress, since several of
/// these run at once and would fight over the bar.
async fn fetch_segment(
    client: &reqwest::Client,
    url: &str,
    token: &str,
    path: &Path,
    done: &AtomicU64,
    cancel: &AtomicBool,
) -> Result<()> {
    let have = tokio::fs::metadata(path).await.map(|m| m.len()).unwrap_or(0);
    let mut request = client.get(url).header("X-Token", token);
    if have > 0 {
        request = request.header("Range", format!("bytes={have}-"));
    }
    let response = request.send().await.context(CONNECT_ERROR)?;
    let status = response.status();
    if status == reqwest::StatusCode::RANGE_NOT_SATISFIABLE {
        return Ok(()); // already complete
    }
    let append = status == reqwest::StatusCode::PARTIAL_CONTENT;
    if !append && !status.is_success() {
        return Err(anyhow!("VPS вернул HTTP {status} на сегмент"));
    }
    let mut file = if append {
        tokio::fs::OpenOptions::new().append(true).open(path).await?
    } else {
        // The server ignored the range: what we had gets rewritten.
        done.fetch_sub(have.min(done.load(Ordering::Relaxed)), Ordering::Relaxed);
        tokio::fs::File::create(path).await?
    };
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        if cancel.load(Ordering::SeqCst) {
            return Err(anyhow!("Отменено пользователем"));
        }
        let chunk = chunk.context("read chunk")?;
        file.write_all(&chunk).await?;
        done.fetch_add(chunk.len() as u64, Ordering::Relaxed);
    }
    file.flush().await?;
    Ok(())
}

fn format_speed(bps: f64) -> String {
    format!("{}/s", format_bytes(bps as u64))
}

fn format_eta(seconds: f64) -> String {
    if !seconds.is_finite() || seconds < 0.0 {
        return String::new();
    }
    let s = seconds as u64;
    if s >= 3600 {
        format!("{}:{:02}:{:02}", s / 3600, (s % 3600) / 60, s % 60)
    } else {
        format!("{}:{:02}", s / 60, s % 60)
    }
}

pub async fn run_vps_download_job(
    queue: &Arc<QueueManager>,
    job: &Job,
    cancel: Arc<AtomicBool>,
) -> Result<PathBuf> {
    let spec = job
        .spec
        .vps_download
        .clone()
        .context("vps_download spec missing")?;
    let mut base = spec.base_url.trim_end_matches('/').to_string();
    // Queued on the direct route, but that network may have lost it since (or
    // the job was restored on another one): fall back to the relay.
    if let Some(relay) = crate::archive_route::relay_base(&base) {
        if !crate::archive_route::probe(&base, &spec.token).await {
            crate::archive_route::mark_direct_failed(&relay);
            queue.emit_job_log(&job.id, "Прямой сервер архива недоступен — качаю через fetchr.fun");
            base = relay;
        }
    }
    let base = base.as_str();
    // A queue restored after a restart reaches here before the VPS page has
    // been opened; the chat render that follows still wants the emote relay.
    crate::chat_overlay::mirror::set_agent(base, &spec.token);
    let dir = PathBuf::from(&job.spec.directory);
    std::fs::create_dir_all(&dir).with_context(|| format!("create dir {}", dir.display()))?;
    let name = sanitize_file_name(&job.spec.name);
    let video_path = dir.join(format!("{name}.mp4"));
    let chat_path = dir.join(format!("{name}_chat.json"));
    let _target = TargetLock::acquire(&video_path).ok_or_else(|| {
        anyhow!(
            "Этот клип уже скачивается другой задачей: {}",
            video_path.display()
        )
    })?;

    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(60 * 60))
        .build()?;

    let processing_enabled = job
        .spec
        .chat_overlay
        .as_ref()
        .and_then(|settings| settings.enabled)
        .unwrap_or(false)
        || job.spec.blur_zones.iter().any(|zone| zone.enabled)
        || job.spec.fetchr_mute_enabled;
    let video_stage_end = if processing_enabled { 55.0 } else { 95.0 };
    let chat_stage_end = if processing_enabled { 60.0 } else { 100.0 };

    queue.set_progress_stage(
        &job.id,
        0.0,
        video_stage_end,
        Some("Загрузка видео с VPS".to_string()),
    );

    if let Some(session) = spec.session.as_deref() {
        queue.emit_job_log(&job.id, &format!("Загрузка записи {session} с VPS"));
        download_session(
            queue,
            job,
            &client,
            base,
            session,
            &spec.token,
            &video_path,
            cancel.clone(),
        )
        .await?;
    } else {
        queue.emit_job_log(&job.id, &format!("Загрузка клипа {} с VPS", spec.clip_id));
        download_clip(
            queue,
            job,
            &client,
            &format!("{base}/clips/{}/video.mp4", spec.clip_id),
            &spec.token,
            &video_path,
            cancel.clone(),
        )
        .await?;
    }

    if spec.include_chat {
        queue.set_progress_stage(
            &job.id,
            video_stage_end,
            chat_stage_end,
            Some("Загрузка чата".to_string()),
        );
        let url = match spec.session.as_deref() {
            Some(session) => format!("{base}/recordings/{session}/chat.json"),
            None => format!("{base}/clips/{}/chat.json", spec.clip_id),
        };
        match client.get(&url).header("X-Token", &spec.token).send().await {
            Ok(resp) if resp.status().is_success() => {
                let bytes = resp.bytes().await?;
                // "[]" (2 bytes) means the clip had no chat messages — skip the file.
                if bytes.len() > 2 {
                    tokio::fs::write(&chat_path, &bytes).await?;
                    stamp_chat_streamer(&chat_path, job);
                    queue.emit_job_log(
                        &job.id,
                        &format!("Чат отрезка сохранён: {}", chat_path.display()),
                    );
                }
            }
            Ok(resp) => {
                queue.emit_job_log(
                    &job.id,
                    &format!("!! Чат не скачан: HTTP {}", resp.status()),
                );
            }
            Err(err) => {
                queue.emit_job_log(&job.id, &format!("!! Чат не скачан: {err}"));
            }
        }
    }

    Ok(video_path)
}

/// Segment URIs from an HLS media playlist, in order, each paired with whether
/// an `#EXT-X-DISCONTINUITY` precedes it. Lines that are not tags and not empty
/// are URIs; the agent emits them relative to the playlist.
///
/// The flag matters at mux time: segments not separated by a discontinuity are
/// consecutive slices of one continuous MPEG-TS stream and must be rejoined as
/// such (see `mux_parts`).
fn playlist_segments(playlist: &str) -> Vec<(String, bool)> {
    let mut out = Vec::new();
    let mut discontinuity = false;
    for line in playlist.lines().map(str::trim) {
        if line.is_empty() {
            continue;
        }
        if line.starts_with('#') {
            if line.starts_with("#EXT-X-DISCONTINUITY") {
                discontinuity = true;
            }
            continue;
        }
        out.push((line.to_string(), discontinuity));
        discontinuity = false;
    }
    out
}

/// Split staged parts into runs: maximal stretches with no discontinuity
/// between them. Index 0 never starts a new run on its own.
fn split_runs(parts: &[PathBuf], breaks: &[bool]) -> Vec<Vec<PathBuf>> {
    let mut runs: Vec<Vec<PathBuf>> = Vec::new();
    for (index, part) in parts.iter().enumerate() {
        if index == 0 || breaks.get(index).copied().unwrap_or(false) {
            runs.push(Vec::new());
        }
        runs.last_mut().expect("first index opens a run").push(part.clone());
    }
    runs
}

/// Join the staged parts into `video_path`.
///
/// MPEG-TS is designed to be concatenated bytewise: the segments of one
/// streamlink run carry a single continuous PTS/DTS timeline, and gluing the
/// bytes reproduces exactly the stream the segmenter cut up. Feeding the parts
/// to ffmpeg's concat *demuxer* instead makes it re-base timestamps per file,
/// which leaves a rounding hole at every single boundary — measured on a
/// 10-minute recording: 59 holes, +1.294 s of invented duration, and video that
/// is no longer constant frame rate. Editors that conform VFR video to a fixed
/// rate while reading audio by sample count (Premiere does) then drift audio
/// against picture, progressively and unfixably.
///
/// A discontinuity is a real gap — the stream dropped and streamlink
/// reconnected with a fresh timeline — so runs are joined with the concat
/// demuxer, which is what it is for. `-fflags +genpts` stays off either way:
/// the source timestamps are correct and regenerating them is what stretched
/// them in the first place.
async fn mux_parts(
    ffmpeg: &Path,
    stage_dir: &Path,
    parts: &[PathBuf],
    breaks: &[bool],
    video_path: &Path,
) -> Result<()> {
    let runs = split_runs(parts, breaks);
    let join_dir = stage_dir.to_path_buf();
    // Byte-joining a multi-gigabyte session is blocking file I/O: it runs on
    // the blocking pool instead of holding an async worker for minutes.
    let run_files = tokio::task::spawn_blocking(move || -> Result<Vec<PathBuf>> {
        let mut run_files: Vec<PathBuf> = Vec::new();
        for (index, run) in runs.iter().enumerate() {
            let joined = join_dir.join(format!("run_{index:03}.ts"));
            let mut out = std::fs::File::create(&joined)
                .with_context(|| format!("create {}", joined.display()))?;
            for part in run {
                let mut input = std::fs::File::open(part)
                    .with_context(|| format!("open {}", part.display()))?;
                std::io::copy(&mut input, &mut out)
                    .with_context(|| format!("append {}", part.display()))?;
            }
            drop(out);
            for part in run {
                let _ = std::fs::remove_file(part);
            }
            run_files.push(joined);
        }
        Ok(run_files)
    })
    .await
    .context("join parts task")??;

    let mut command = tokio::process::Command::new(ffmpeg);
    crate::platform::hide_console_tokio(&mut command);
    command.args(["-hide_banner", "-loglevel", "error", "-y"]);
    let list_path = stage_dir.join("concat.txt");
    if run_files.len() == 1 {
        command.arg("-i").arg(&run_files[0]);
    } else {
        let list = run_files
            .iter()
            .map(|run| {
                format!(
                    "file '{}'",
                    run.display().to_string().replace('\'', r"'\''")
                )
            })
            .collect::<Vec<_>>()
            .join("\n");
        std::fs::write(&list_path, list).context("write concat list")?;
        command
            .args(["-f", "concat", "-safe", "0", "-i"])
            .arg(&list_path);
    }
    let output = command
        .args([
            "-c",
            "copy",
            "-bsf:a",
            "aac_adtstoasc",
        ])
        .arg(video_path)
        .output()
        .await
        .context("run ffmpeg")?;
    if !output.status.success() {
        return Err(anyhow!(
            "ffmpeg не собрал запись: {}",
            String::from_utf8_lossy(&output.stderr)
                .lines()
                .last()
                .unwrap_or_default()
        ));
    }
    Ok(())
}

/// Pull a whole recording as its raw segments and mux them here.
///
/// Deliberately not "ask the server for one big mp4": that would need as much
/// free space on the VPS as the recording itself, which is the disk pressure
/// this whole feature is trying to avoid.
#[allow(clippy::too_many_arguments)]
async fn download_session(
    queue: &Arc<QueueManager>,
    job: &Job,
    client: &reqwest::Client,
    base: &str,
    session: &str,
    token: &str,
    video_path: &Path,
    cancel: Arc<AtomicBool>,
) -> Result<()> {
    let playlist = client
        .get(format!("{base}/recordings/{session}/playlist.m3u8"))
        .header("X-Token", token)
        .send()
        .await
        .context("Не удалось связаться с сервером fetchr.fun: проверьте интернет, VPN или прокси и повторите")?;
    if !playlist.status().is_success() {
        return Err(anyhow!("VPS вернул HTTP {} на плейлист", playlist.status()));
    }
    let segments = playlist_segments(&playlist.text().await?);
    if segments.is_empty() {
        return Err(anyhow!("У записи нет доступных сегментов"));
    }

    let stage_dir = video_path.with_extension("vpsparts");
    std::fs::create_dir_all(&stage_dir)
        .with_context(|| format!("create dir {}", stage_dir.display()))?;
    let spec_token = token.to_string();
    let job_id = job.id.clone();
    let parts: Vec<PathBuf> = (0..segments.len())
        .map(|index| stage_dir.join(format!("part_{index:05}.ts")))
        .collect();

    // Segments are small and the tunnel is latency-bound, so one request at a
    // time spent most of the transfer waiting. Fetching a few at once turns a
    // thousand round trips into a fraction of the wall time; they land in
    // separate files, so order does not matter.
    //
    // Everything the tasks touch is owned: borrowing locals here makes the
    // whole job future non-'static and the queue can no longer spawn it.
    let finished = Arc::new(AtomicUsize::new(0));
    let total = segments.len();
    let resumed: u64 = parts
        .iter()
        .map(|part| std::fs::metadata(part).map(|m| m.len()).unwrap_or(0))
        .sum();
    if resumed > 0 {
        queue.emit_job_log(&job.id, &format!("Докачка с {}", format_bytes(resumed)));
    }
    let bytes = Arc::new(AtomicU64::new(resumed));
    let work: Vec<(String, PathBuf)> = segments
        .iter()
        .enumerate()
        .map(|(index, (uri, _))| {
            (
                format!("{base}/recordings/{session}/{uri}"),
                parts[index].clone(),
            )
        })
        .collect();

    let mut tasks = futures::stream::iter(work.into_iter().map(|(url, part)| {
        let client = client.clone();
        let token = spec_token.clone();
        let cancel = cancel.clone();
        let finished = finished.clone();
        let bytes = bytes.clone();
        async move {
            // Already-complete parts survive a retry of the job; the agent
            // serves Range requests so a half file resumes. A blip on one
            // segment out of thousands must not fail the whole download.
            let mut attempt = 0;
            loop {
                if cancel.load(Ordering::SeqCst) {
                    return Err(anyhow!("Отменено пользователем"));
                }
                attempt += 1;
                match fetch_segment(&client, &url, &token, &part, &bytes, &cancel).await {
                    Ok(()) => break,
                    Err(err) if attempt >= PART_ATTEMPTS || cancel.load(Ordering::SeqCst) => {
                        return Err(err)
                    }
                    Err(_) => tokio::time::sleep(Duration::from_millis(700 * attempt as u64)).await,
                }
            }
            finished.fetch_add(1, Ordering::Relaxed);
            Ok::<(), anyhow::Error>(())
        }
    }))
    .buffer_unordered(SEGMENT_CONCURRENCY);

    let started = Instant::now();
    let mut tick = tokio::time::interval(Duration::from_millis(800));
    loop {
        tokio::select! {
            next = tasks.next() => match next {
                Some(Ok(())) => {}
                // The staged parts stay: retrying the job resumes from them.
                Some(Err(err)) => return Err(err),
                None => break,
            },
            _ = tick.tick() => {
                let count = finished.load(Ordering::Relaxed);
                let got = bytes.load(Ordering::Relaxed);
                // Sizes are not known up front; finished segments give the average.
                let estimate = (count > 0).then(|| {
                    (got as f64 / count.max(1) as f64 * total as f64).max(got as f64) as u64
                });
                let speed = got.saturating_sub(resumed) as f64
                    / started.elapsed().as_secs_f64().max(0.1);
                let eta = estimate
                    .map(|t| format_eta(t.saturating_sub(got) as f64 / speed.max(1.0)))
                    .unwrap_or_default();
                queue.set_progress(
                    &job_id,
                    JobProgress {
                        percent: (count as f32 / total as f32) * 100.0,
                        message: Some(format!("Сегмент {count}/{total}")),
                        speed: Some(format_speed(speed)),
                        eta: if eta.is_empty() { None } else { Some(eta) },
                        size: estimate.map(|t| format!("~{}", format_bytes(t))),
                        downloaded_bytes: Some(got),
                        total_bytes: estimate,
                        speed_bps: Some(speed),
                        ..JobProgress::default()
                    },
                );
            }
        }
    }
    drop(tasks);

    queue.emit_job_log(&job.id, "Сборка записи из сегментов");
    let ffmpeg = crate::binaries::resolve_binary(
        crate::binaries::FFMPEG,
        job.spec.binaries_dir.as_deref().map(Path::new),
    )
    .ok_or_else(|| anyhow!("ffmpeg не найден"))?;
    let breaks: Vec<bool> = segments.iter().map(|(_, brk)| *brk).collect();
    let result = mux_parts(&ffmpeg, &stage_dir, &parts, &breaks, video_path).await;
    let _ = std::fs::remove_dir_all(&stage_dir);
    result?;
    Ok(())
}

/// Chunks of one clip in flight at once. A single connection abroad tops out
/// around 7 MB/s on Russian networks while a dozen side by side reach 30+.
const CLIP_CONCURRENCY: usize = 16;
/// A clip is cut into chunks of this size and workers take the next free one,
/// so one slow connection holds up a chunk, not a twelfth of the file.
const CHUNK_BYTES: u64 = 8 * 1024 * 1024;
const PART_ATTEMPTS: usize = 4;
const CONNECT_ERROR: &str =
    "Не удалось связаться с сервером fetchr.fun: проверьте интернет, VPN или прокси и повторите";

/// Total size of `url`, or `None` when the server ignores ranges.
async fn probe_size(client: &reqwest::Client, url: &str, token: &str) -> Result<Option<u64>> {
    let response = client
        .get(url)
        .header("X-Token", token)
        .header("Range", "bytes=0-0")
        .send()
        .await
        .context(CONNECT_ERROR)?;
    let status = response.status();
    if status == reqwest::StatusCode::PARTIAL_CONTENT {
        return Ok(response
            .headers()
            .get("content-range")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.rsplit('/').next())
            .and_then(|v| v.parse::<u64>().ok()));
    }
    if status.is_success() {
        return Ok(None);
    }
    Err(anyhow!("VPS вернул HTTP {status}"))
}

/// Split `total` bytes into inclusive `(start, end)` chunks of `CHUNK_BYTES`.
fn split_ranges(total: u64) -> Vec<(u64, u64)> {
    (0..total.div_ceil(CHUNK_BYTES))
        .map(|index| (index * CHUNK_BYTES, ((index + 1) * CHUNK_BYTES).min(total) - 1))
        .collect()
}

/// One byte range into its own file, resuming what an earlier attempt left.
async fn fetch_range(
    client: &reqwest::Client,
    url: &str,
    token: &str,
    path: &Path,
    (start, end): (u64, u64),
    done: &AtomicU64,
    cancel: &AtomicBool,
) -> Result<()> {
    let expected = end - start + 1;
    let have = tokio::fs::metadata(path).await.map(|m| m.len()).unwrap_or(0);
    if have == expected {
        return Ok(());
    }
    let have = if have > expected {
        // Left over from a different split; start the part over.
        done.fetch_sub(have, Ordering::Relaxed);
        tokio::fs::File::create(path).await?;
        0
    } else {
        have
    };
    let response = client
        .get(url)
        .header("X-Token", token)
        .header("Range", format!("bytes={}-{end}", start + have))
        .send()
        .await
        .context(CONNECT_ERROR)?;
    if response.status() != reqwest::StatusCode::PARTIAL_CONTENT {
        return Err(anyhow!("VPS вернул HTTP {} на часть файла", response.status()));
    }
    let mut file = tokio::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .await?;
    let mut written = have;
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        if cancel.load(Ordering::SeqCst) {
            return Err(anyhow!("Отменено пользователем"));
        }
        let chunk = chunk.context("read chunk")?;
        file.write_all(&chunk).await?;
        written += chunk.len() as u64;
        done.fetch_add(chunk.len() as u64, Ordering::Relaxed);
    }
    file.flush().await?;
    if written != expected {
        return Err(anyhow!(
            "Скачано {} из {} — обрыв соединения",
            format_bytes(written),
            format_bytes(expected)
        ));
    }
    Ok(())
}

/// Output paths with a download in flight. Two jobs for the same clip share
/// the `.vpsdl` staging folder, and since every chunk resumes by appending,
/// both writing at once interleave their bytes into a corrupt MP4 (seen when a
/// job restored after a restart ran next to a freshly queued copy of it).
fn active_targets() -> &'static parking_lot::Mutex<std::collections::HashSet<PathBuf>> {
    static ACTIVE: std::sync::OnceLock<parking_lot::Mutex<std::collections::HashSet<PathBuf>>> =
        std::sync::OnceLock::new();
    ACTIVE.get_or_init(Default::default)
}

/// Held for the whole download; releases its path on drop, error or cancel.
struct TargetLock(PathBuf);

impl TargetLock {
    fn acquire(path: &Path) -> Option<Self> {
        let path = path.to_path_buf();
        active_targets()
            .lock()
            .insert(path.clone())
            .then(|| Self(path))
    }
}

impl Drop for TargetLock {
    fn drop(&mut self) {
        active_targets().lock().remove(&self.0);
    }
}

/// Download a clip as parallel ranges into a staging folder, then join them.
///
/// Staging also fixes resume: the old code appended to whatever file already
/// had the clip's name, so a different clip saved under the same name earlier
/// was silently glued in front of the new one.
async fn download_clip(
    queue: &Arc<QueueManager>,
    job: &Job,
    client: &reqwest::Client,
    url: &str,
    token: &str,
    video_path: &Path,
    cancel: Arc<AtomicBool>,
) -> Result<()> {
    let stage = video_path.with_extension("vpsdl");
    std::fs::create_dir_all(&stage).with_context(|| format!("create dir {}", stage.display()))?;
    let total = probe_size(client, url, token).await?;
    let ranges = match total {
        Some(total) if total >= 2 * CHUNK_BYTES => split_ranges(total),
        _ => {
            let whole = stage.join("whole.mp4");
            download_with_resume(queue, job, client, url, token, &whole, cancel).await?;
            return finish_parts(&stage, &[whole], video_path).await;
        }
    };
    let total = total.unwrap_or_default();
    // Named by offset: a resume after a change of chunk size must not mistake
    // an old part for a new one.
    let parts: Vec<PathBuf> = ranges
        .iter()
        .map(|(start, end)| stage.join(format!("chunk_{start:012}_{end:012}")))
        .collect();
    let resumed: u64 = parts
        .iter()
        .map(|part| std::fs::metadata(part).map(|m| m.len()).unwrap_or(0))
        .sum();
    if resumed > 0 {
        queue.emit_job_log(&job.id, &format!("Докачка с {}", format_bytes(resumed)));
    }
    let done = Arc::new(AtomicU64::new(resumed));

    // Owned per task, so the job future stays 'static for the queue.
    let jobs: Vec<((u64, u64), PathBuf)> = ranges.iter().copied().zip(parts.clone()).collect();
    let mut work = futures::stream::iter(jobs.into_iter().map(|(range, part)| {
        let client = client.clone();
        let url = url.to_string();
        let token = token.to_string();
        let done = done.clone();
        let cancel = cancel.clone();
        async move {
            let mut attempt = 0;
            loop {
                attempt += 1;
                match fetch_range(&client, &url, &token, &part, range, &done, &cancel).await {
                    Ok(()) => return Ok::<(), anyhow::Error>(()),
                    Err(err) if attempt >= PART_ATTEMPTS || cancel.load(Ordering::SeqCst) => {
                        return Err(err)
                    }
                    Err(_) => tokio::time::sleep(Duration::from_millis(700 * attempt as u64)).await,
                }
            }
        }
    }))
    .buffer_unordered(CLIP_CONCURRENCY);

    let started = Instant::now();
    let mut tick = tokio::time::interval(Duration::from_millis(800));
    let result: Result<()> = loop {
        tokio::select! {
            next = work.next() => match next {
                Some(Ok(())) => {}
                Some(Err(err)) => break Err(err),
                None => break Ok(()),
            },
            _ = tick.tick() => {
                let downloaded = done.load(Ordering::Relaxed).min(total);
                let speed = downloaded.saturating_sub(resumed) as f64
                    / started.elapsed().as_secs_f64().max(0.1);
                let eta = format_eta(total.saturating_sub(downloaded) as f64 / speed.max(1.0));
                queue.set_progress(
                    &job.id,
                    JobProgress {
                        percent: (downloaded as f64 / total.max(1) as f64 * 100.0) as f32,
                        speed: Some(format_speed(speed)),
                        eta: if eta.is_empty() { None } else { Some(eta) },
                        size: Some(format_bytes(total)),
                        downloaded_bytes: Some(downloaded),
                        total_bytes: Some(total),
                        speed_bps: Some(speed),
                        ..JobProgress::default()
                    },
                );
            }
        }
    };
    drop(work);
    result?;
    finish_parts(&stage, &parts, video_path).await
}

/// Join the staged parts into `video_path` and drop the staging folder.
async fn finish_parts(stage: &Path, parts: &[PathBuf], video_path: &Path) -> Result<()> {
    let parts = parts.to_vec();
    let target = video_path.to_path_buf();
    let stage = stage.to_path_buf();
    tokio::task::spawn_blocking(move || -> Result<()> {
        let tmp = target.with_extension("mp4.tmp");
        let mut out =
            std::fs::File::create(&tmp).with_context(|| format!("create {}", tmp.display()))?;
        for part in &parts {
            let mut input =
                std::fs::File::open(part).with_context(|| format!("open {}", part.display()))?;
            std::io::copy(&mut input, &mut out)
                .with_context(|| format!("append {}", part.display()))?;
        }
        drop(out);
        std::fs::rename(&tmp, &target)
            .with_context(|| format!("rename to {}", target.display()))?;
        let _ = std::fs::remove_dir_all(&stage);
        Ok(())
    })
    .await
    .context("join clip parts task")?
}

async fn download_with_resume(
    queue: &Arc<QueueManager>,
    job: &Job,
    client: &reqwest::Client,
    url: &str,
    token: &str,
    path: &Path,
    cancel: Arc<AtomicBool>,
) -> Result<()> {
    let mut downloaded = tokio::fs::metadata(path)
        .await
        .map(|m| m.len())
        .unwrap_or(0);

    let mut req = client.get(url).header("X-Token", token);
    if downloaded > 0 {
        req = req.header("Range", format!("bytes={downloaded}-"));
        queue.emit_job_log(
            &job.id,
            &format!("Докачка с позиции {}", format_bytes(downloaded)),
        );
    }
    let resp = req.send().await.context("Не удалось связаться с сервером fetchr.fun: проверьте интернет, VPN или прокси и повторите")?;
    let status = resp.status();

    let (total, append) = if status == reqwest::StatusCode::PARTIAL_CONTENT {
        // bytes <start>-<end>/<total>
        let total = resp
            .headers()
            .get("content-range")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.rsplit('/').next())
            .and_then(|v| v.parse::<u64>().ok());
        (total, true)
    } else if status.is_success() {
        downloaded = 0;
        (resp.content_length(), false)
    } else {
        return Err(anyhow!("VPS вернул HTTP {status}"));
    };

    let mut file = if append {
        tokio::fs::OpenOptions::new()
            .append(true)
            .open(path)
            .await?
    } else {
        tokio::fs::File::create(path).await?
    };

    let mut stream = resp.bytes_stream();
    let started = Instant::now();
    let mut last_emit = Instant::now() - Duration::from_millis(900);
    while let Some(chunk) = stream.next().await {
        if cancel.load(Ordering::SeqCst) {
            return Err(anyhow!("Отменено пользователем"));
        }
        let chunk = chunk.context("read chunk")?;
        file.write_all(&chunk).await?;
        downloaded += chunk.len() as u64;

        if last_emit.elapsed() >= Duration::from_millis(800) {
            last_emit = Instant::now();
            let elapsed = started.elapsed().as_secs_f64().max(0.1);
            let speed = downloaded as f64 / elapsed;
            let percent = total
                .map(|t| (downloaded as f64 / t.max(1) as f64 * 100.0).min(100.0))
                .unwrap_or(0.0);
            let eta = total
                .map(|t| format_eta((t.saturating_sub(downloaded)) as f64 / speed.max(1.0)))
                .unwrap_or_default();
            queue.set_progress(
                &job.id,
                JobProgress {
                    percent: percent as f32,
                    speed: Some(format_speed(speed)),
                    eta: if eta.is_empty() { None } else { Some(eta) },
                    size: total.map(format_bytes),
                    downloaded_bytes: Some(downloaded),
                    total_bytes: total,
                    speed_bps: Some(speed),
                    ..JobProgress::default()
                },
            );
        }
    }
    file.flush().await?;

    if let Some(t) = total {
        if downloaded < t {
            return Err(anyhow!(
                "Скачано {} из {} — обрыв соединения",
                format_bytes(downloaded),
                format_bytes(t)
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_second_download_of_the_same_clip_is_refused_until_the_first_ends() {
        let path = std::env::temp_dir().join("fetchr_target_lock_test.mp4");
        let first = TargetLock::acquire(&path).expect("free path locks");
        assert!(TargetLock::acquire(&path).is_none(), "duplicate must be refused");
        drop(first);
        assert!(TargetLock::acquire(&path).is_some(), "released on drop");
    }

    const PLAYLIST: &str = "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:10\n\
        #EXTINF:10.0,\nseg_00000.ts\n#EXTINF:10.0,\nseg_00001.ts\n\
        #EXT-X-DISCONTINUITY\n#EXTINF:10.0,\nseg_00002.ts\n\
        #EXTINF:10.0,\nseg_00003.ts\n#EXT-X-ENDLIST\n";

    #[test]
    fn split_ranges_covers_every_byte_once() {
        for total in [2 * CHUNK_BYTES, 3 * CHUNK_BYTES + 7, 553_312_183] {
            let ranges = split_ranges(total);
            assert_eq!(ranges.len() as u64, total.div_ceil(CHUNK_BYTES));
            assert_eq!(ranges[0].0, 0);
            assert_eq!(ranges.last().unwrap().1, total - 1);
            for pair in ranges.windows(2) {
                assert_eq!(pair[0].1 + 1, pair[1].0);
            }
        }
    }

    #[test]
    fn playlist_segments_flags_the_uri_after_a_discontinuity() {
        let segments = playlist_segments(PLAYLIST);
        assert_eq!(
            segments,
            vec![
                ("seg_00000.ts".to_string(), false),
                ("seg_00001.ts".to_string(), false),
                ("seg_00002.ts".to_string(), true),
                ("seg_00003.ts".to_string(), false),
            ]
        );
    }

    #[test]
    fn a_discontinuity_before_the_first_uri_does_not_open_an_empty_run() {
        let segments = playlist_segments("#EXT-X-DISCONTINUITY\n#EXTINF:10.0,\nseg_00000.ts\n");
        assert_eq!(segments, vec![("seg_00000.ts".to_string(), true)]);
        let parts: Vec<PathBuf> = vec!["a.ts".into()];
        let breaks: Vec<bool> = segments.iter().map(|(_, brk)| *brk).collect();
        assert_eq!(split_runs(&parts, &breaks).len(), 1);
    }

    #[test]
    fn split_runs_cuts_only_at_discontinuities() {
        let parts: Vec<PathBuf> = (0..4).map(|i| PathBuf::from(format!("p{i}.ts"))).collect();
        let runs = split_runs(&parts, &[false, false, true, false]);
        assert_eq!(runs.len(), 2);
        assert_eq!(runs[0], parts[0..2].to_vec());
        assert_eq!(runs[1], parts[2..4].to_vec());
    }

    #[test]
    fn split_runs_keeps_one_run_when_nothing_is_discontinuous() {
        let parts: Vec<PathBuf> = (0..3).map(|i| PathBuf::from(format!("p{i}.ts"))).collect();
        let runs = split_runs(&parts, &[false, false, false]);
        assert_eq!(runs.len(), 1);
        assert_eq!(runs[0].len(), 3);
    }

    /// The whole point of the byte-join: parts of one run must reach ffmpeg as a
    /// single input, never as a concat list, or every boundary gains a hole.
    #[tokio::test]
    async fn mux_parts_joins_a_single_run_bytewise() {
        let dir = std::env::temp_dir().join(format!("fetchr_mux_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let parts: Vec<PathBuf> = ["aaa", "bbb", "ccc"]
            .iter()
            .enumerate()
            .map(|(index, body)| {
                let path = dir.join(format!("part_{index:05}.ts"));
                std::fs::write(&path, body).unwrap();
                path
            })
            .collect();
        // A missing ffmpeg makes the spawn fail, but only after the joining has
        // happened; that is the half this test is about.
        let _ = mux_parts(
            Path::new("fetchr-no-such-ffmpeg"),
            &dir,
            &parts,
            &[false, false, false],
            &dir.join("out.mp4"),
        )
        .await;
        assert_eq!(std::fs::read_to_string(dir.join("run_000.ts")).unwrap(), "aaabbbccc");
        assert!(!dir.join("run_001.ts").exists());
        assert!(!parts[0].exists(), "staged parts are freed as they are joined");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn mux_parts_keeps_runs_apart_across_a_discontinuity() {
        let dir = std::env::temp_dir().join(format!("fetchr_mux_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let parts: Vec<PathBuf> = ["aaa", "bbb", "ccc"]
            .iter()
            .enumerate()
            .map(|(index, body)| {
                let path = dir.join(format!("part_{index:05}.ts"));
                std::fs::write(&path, body).unwrap();
                path
            })
            .collect();
        let _ = mux_parts(
            Path::new("fetchr-no-such-ffmpeg"),
            &dir,
            &parts,
            &[false, true, false],
            &dir.join("out.mp4"),
        )
        .await;
        assert_eq!(std::fs::read_to_string(dir.join("run_000.ts")).unwrap(), "aaa");
        assert_eq!(std::fs::read_to_string(dir.join("run_001.ts")).unwrap(), "bbbccc");
        let list = std::fs::read_to_string(dir.join("concat.txt")).unwrap();
        assert_eq!(list.lines().count(), 2, "one concat entry per run, not per part");
        std::fs::remove_dir_all(&dir).ok();
    }
}
