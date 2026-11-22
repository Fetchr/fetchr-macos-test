use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::State;

use super::{run_copyright_scan, CopyrightState, CopyrightTimelineSegment};

struct CleanupCancel {
    cancels: Arc<parking_lot::Mutex<std::collections::HashMap<String, Arc<AtomicBool>>>>,
    task_id: String,
}

impl Drop for CleanupCancel {
    fn drop(&mut self) {
        self.cancels.lock().remove(&self.task_id);
    }
}

#[tauri::command]
pub async fn scan_video_for_copyright(
    app: tauri::AppHandle,
    state: State<'_, CopyrightState>,
    task_id: String,
    input_path: String,
    binaries_dir: Option<String>,
) -> Result<Vec<CopyrightTimelineSegment>, String> {
    let cancel_flag = Arc::new(AtomicBool::new(false));
    state
        .cancels
        .lock()
        .insert(task_id.clone(), cancel_flag.clone());

    let _cleanup = CleanupCancel {
        cancels: state.cancels.clone(),
        task_id: task_id.clone(),
    };

    run_copyright_scan(app, task_id, input_path, binaries_dir, cancel_flag).await
}

#[tauri::command]
pub fn cancel_copyright_scan(state: State<'_, CopyrightState>, task_id: String) {
    if let Some(flag) = state.cancels.lock().get(&task_id) {
        flag.store(true, Ordering::SeqCst);
    }
}
