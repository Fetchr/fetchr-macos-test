//! First-run setup: installs what the tools picked in the welcome wizard need,
//! so the first real task does not stall on a multi-hundred-megabyte download.
//!
//! Every component is idempotent: an already installed one finishes at once.
//! Progress goes out as `setup:progress` through the queue's in-page channel
//! (job id `setup_<component>`).

use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use serde::Serialize;
use tauri::State;

use crate::binaries::{resolve_binary, FFMPEG, FFPROBE};
use crate::jobs::queue::QueueManager;
use crate::jobs::types::{FetchrMuteAsrModel, JobProgress, VocalRemoverMode};
use crate::modules::tracker::{self, ProgressSink};
use crate::AppState;

#[derive(Debug, Clone, Serialize)]
pub struct SetupComponentStatus {
    pub id: &'static str,
    pub ready: bool,
}

/// Which components are already on disk. `asr` has no cheap check and is
/// reported as not ready; installing it again is a quick no-op.
#[tauri::command]
pub fn setup_components_status() -> Vec<SetupComponentStatus> {
    vec![
        SetupComponentStatus {
            id: "ffmpeg",
            ready: resolve_binary(FFMPEG, None).is_some() && resolve_binary(FFPROBE, None).is_some(),
        },
        SetupComponentStatus {
            id: "tracker",
            ready: tracker::model_is_ready(),
        },
        SetupComponentStatus {
            id: "asr",
            ready: false,
        },
        SetupComponentStatus {
            id: "vocal",
            ready: false,
        },
    ]
}

#[tauri::command]
pub async fn setup_install_component(
    state: State<'_, AppState>,
    component: String,
) -> Result<(), String> {
    let queue = state.queue.clone();
    let job_id = format!("setup_{component}");
    report(&queue, &job_id, 0.0, "Подготовка");
    match component.as_str() {
        "ffmpeg" => crate::binaries::ensure_ffmpeg()
            .await
            .map_err(|err| err.to_string())?,
        "tracker" => {
            let sink_queue = queue.clone();
            let sink_id = job_id.clone();
            let sink: ProgressSink = Arc::new(move |percent: f32, message: String| {
                report(&sink_queue, &sink_id, percent, &message);
            });
            tracker::ensure_model(&sink).await?;
        }
        "asr" => {
            let model = FetchrMuteAsrModel::default();
            let model_dir = crate::jobs::asr_models::model_root(model);
            crate::jobs::fetchr_mute::ensure_model(
                &queue,
                &job_id,
                &model_dir,
                model,
                false,
                Arc::new(AtomicBool::new(false)),
            )
            .await
            .map_err(|err| format!("{err:#}"))?;
        }
        "vocal" => {
            let mode = VocalRemoverMode::default();
            let model_dir = crate::jobs::vocal_remover::model_dir_for_mode(mode);
            let progress_queue = queue.clone();
            let progress_id = job_id.clone();
            let mut on_progress = move |percent: f32, message: &str| {
                report(&progress_queue, &progress_id, percent, message);
            };
            crate::jobs::vocal_remover::ensure_models_with_progress(
                mode,
                &model_dir,
                Arc::new(AtomicBool::new(false)),
                &mut on_progress,
            )
            .await
            .map_err(|err| format!("{err:#}"))?;
        }
        other => return Err(format!("Unknown setup component: {other}")),
    }
    report(&queue, &job_id, 100.0, "Готово");
    Ok(())
}

fn report(queue: &Arc<QueueManager>, job_id: &str, percent: f32, message: &str) {
    queue.set_progress(
        job_id,
        JobProgress {
            percent,
            message: Some(message.to_string()),
            ..JobProgress::default()
        },
    );
}
