pub mod app_log;
pub mod archive_route;
pub mod binaries;
pub mod chat_overlay;
mod commands;
mod error_reports;
mod hls_proxy;
mod job_logs;
pub mod jobs;
mod license;
mod mac_menu;
pub mod platform;
mod privacy;
mod proxy;
mod remote;
mod tls_pin;
pub mod system_fonts;
mod telemetry;
mod updater;
pub mod util;
pub mod vps_ssh;
pub mod win_power;
pub mod wtv;
pub mod ytdlp_runtime;

mod modules;

use modules::copyright_detector::CopyrightState;
use std::sync::Arc;

use app_log::AppLogger;
use jobs::queue::QueueManager;
use tauri::Manager;

pub struct AppState {
    pub queue: Arc<QueueManager>,
    pub in_page_cancels: Arc<
        parking_lot::Mutex<std::collections::HashMap<String, Arc<std::sync::atomic::AtomicBool>>>,
    >,
    /// Separate from `in_page_cancels` on purpose: building the timeline
    /// filmstrip must not be cancelled by starting a tracker run, and vice
    /// versa — both can legitimately be in flight at the same time.
    pub timeline_cancels: Arc<
        parking_lot::Mutex<std::collections::HashMap<String, Arc<std::sync::atomic::AtomicBool>>>,
    >,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    telemetry::note_earlier_install();
    {
        use tracing_subscriber::prelude::*;
        tracing_subscriber::registry()
            .with(
                tracing_subscriber::EnvFilter::try_from_default_env()
                    .unwrap_or_else(|_| "info,fetchr_lib=debug".into()),
            )
            .with(tracing_subscriber::fmt::layer())
            .with(error_reports::ErrorReportLayer)
            .init();
    }
    // The hardware probes spawn PowerShell for seconds. Start them before the
    // window exists, so the license check and the performance preset find
    // them ready instead of waiting on them.
    let _ = std::thread::Builder::new()
        .name("fetchr-hw-probe".to_string())
        .spawn(|| {
            license::warm_hardware_identity();
            commands::system::prefetch_gpu_names();
            // Scan leftovers (vocals cache, kept source decode) older than a
            // day; before, only the next scan swept them.
            jobs::vocal_remover::SeparationCache::sweep_stale();
        });
    error_reports::start();
    error_reports::install_panic_hook();

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            // Record the bundle resource dir so bundled tools resolve correctly on
            // macOS (.app/Contents/Resources) and Linux, not just next to the exe.
            if let Ok(dir) = app.path().resource_dir() {
                binaries::set_resource_dir(dir);
            }
            // Keep full speed when the window is minimized (Windows EcoQoS opt-out).
            win_power::disable_for_current_process();
            if let Err(err) = hls_proxy::start() {
                tracing::error!("Failed to start local HLS proxy: {err}");
            }
            mac_menu::install(app.handle());
            let handle = app.handle().clone();
            let logger = AppLogger::new();
            let queue = Arc::new(QueueManager::new(handle, logger));
            queue.start_progress_flusher();
            app.manage(AppState {
                queue: queue.clone(),
                in_page_cancels: Arc::new(parking_lot::Mutex::new(std::collections::HashMap::new())),
                timeline_cancels: Arc::new(parking_lot::Mutex::new(std::collections::HashMap::new())),
            });
            app.manage(CopyrightState::default());
            telemetry::track_app_launch();
            tauri::async_runtime::spawn(async {
                if let Err(e) = binaries::ensure_ffmpeg().await {
                    tracing::warn!("ensure_ffmpeg failed: {e}");
                }
            });
            tauri::async_runtime::spawn(async {
                ytdlp_runtime::update_ytdlp_if_stale().await;
                if let Err(e) = ytdlp_runtime::ensure_js_runtime().await {
                    tracing::warn!("ensure_js_runtime failed: {e}");
                }
            });
            Ok(())
        })
        .invoke_handler({
            let commands: fn(tauri::ipc::Invoke<tauri::Wry>) -> bool = tauri::generate_handler![
            commands::resolve::resolve_stream,
            commands::system::report_client_error,
            commands::resolve::probe_duration,
            commands::preview::start_stream_preview,
            commands::preview::stop_stream_preview,
            commands::preview::capture_preview_frame,
            commands::preview::chat_render_log_action,
            commands::sponsor_blur::track_sponsor_zone,
            commands::sponsor_blur::cancel_sponsor_tracker,
            commands::sponsor_timeline::capture_timeline_thumbnails,
            commands::sponsor_timeline::cancel_timeline_thumbnails,
            hls_proxy::proxied_hls_url,
            commands::download::enqueue_job,
            commands::download::start_queue,
            commands::download::set_queue_concurrency,
            commands::download::pause_queue,
            commands::download::cancel_job,
            commands::download::restart_job,
            commands::download::remove_job,
            commands::download::job_log_text,
            commands::download::move_job,
            commands::download::set_job_priority,
            commands::download::list_jobs,
            commands::download::clear_completed,
            commands::download::split_live_recording,
            commands::download::prepare_recording_review,
            commands::download::get_disk_free_space,
            commands::download::stop_and_process_live_recording,
            commands::fs_ops::open_folder,
            commands::fs_ops::reveal_file,
            commands::fs_ops::default_download_dir,
            commands::fs_ops::choose_directory,
            commands::fs_ops::choose_image_file,
            commands::fs_ops::choose_media_file,
            commands::fs_ops::choose_media_files,
            commands::fs_ops::media_file_sizes,
            commands::fs_ops::choose_json_file,
            commands::fs_ops::read_chat_messages_preview,
            commands::fs_ops::read_image_file,
            commands::fs_ops::read_link_file,
            commands::fs_ops::save_text_file_dialog,
            commands::fs_ops::save_image_dialog,
            commands::fonts::list_system_fonts,
            commands::system::detect_hardware_preset,
            commands::channel_avatars::channel_avatars,
            commands::twitch::twitch_parse_url,
            commands::twitch::twitch_public_vods,
            commands::twitch::twitch_find_m3u8,
            commands::twitch::twitch_tracker_fetch,
            commands::twitch::twitch_tracker_streams,
            commands::twitch::twitch_validate_auth_token,
            commands::resolve::twitch_extract_browser_token,
            commands::resolve::twitch_extract_token_from_cookies_file,
            commands::fs_ops::choose_cookies_file,
            commands::fs_ops::choose_ssh_key_file,
            commands::vps::vps_get_config,
            commands::vps::vps_set_config,
            commands::vps::vps_status,
            commands::vps::vps_recordings_list,
            commands::vps::vps_schedules_list,
            commands::vps::vps_schedule_create,
            commands::vps::vps_schedule_delete,
            commands::vps::vps_recording_preview_url,
            commands::vps::vps_clip_preview_url,
            commands::vps::vps_recording_poster_url,
            commands::vps::vps_clip_poster_url,
            commands::vps::vps_clip_set_keep,
            commands::vps::vps_recording_peaks,
            commands::vps::vps_recording_chat,
            commands::vps::vps_channel_emotes,
            commands::vps::vps_recording_delete,
            commands::vps::vps_auth_methods,
            commands::vps::vps_preflight,
            commands::vps::vps_provision,
            commands::vps::vps_connect,
            commands::vps::vps_managed_connect,
            commands::vps::vps_managed_state,
            commands::vps::vps_managed_select,
            commands::vps::vps_managed_probe,
            commands::vps::vps_managed_forget,
            commands::vps::vps_disconnect,
            commands::vps::vps_tunnel_state,
            commands::vps::vps_forget,
            commands::vps::vps_marker_add,
            commands::vps::vps_marker_delete,
            commands::vps::vps_session_start,
            commands::vps::vps_session_stop,
            commands::vps::vps_clip_create,
            commands::vps::vps_clips_list,
            commands::vps::vps_clip_delete,
            commands::vps::vps_buffer_clear,
            commands::vps::vps_download_clip,
            commands::vps::vps_unlock,
            commands::vps::vps_unlock_status,
            binaries::detect_binaries,
            license::get_machine_id,
            license::beta_activation_link,
            privacy::get_privacy_settings,
            telemetry::track_screen,
            privacy::set_privacy_settings,
            license::license_status,
            license::activate_license,
            license::reset_license,
            updater::check_for_update,
            updater::install_update,
            updater::cancel_update,
            commands::setup::setup_components_status,
            commands::setup::setup_install_component,
            commands::fetchr_mute::run_mute_in_page,
            commands::fetchr_mute::recensor_in_page,
            commands::fetchr_mute::cancel_mute_in_page,
            commands::fetchr_mute::probe_mute_audio_tracks,
            commands::fetchr_mute::audio_waveform_peaks,
            commands::fetchr_mute::get_mute_history,
            commands::fetchr_mute::get_mute_history_words,
            commands::fetchr_mute::delete_mute_history_item,
            commands::fetchr_mute::mute_paths_exist,
            commands::fetchr_mute::mute_recognition_version,
            commands::fetchr_mute::suggest_mute_words,
            commands::vocal_remover::run_vocal_remover_in_page,
            commands::vocal_remover::cancel_vocal_remover_in_page,
            commands::vocal_remover::get_vocal_remover_history,
            commands::vocal_remover::lookup_track_artwork,
            commands::vocal_remover::delete_vocal_remover_history_item,
            modules::copyright_detector::commands::scan_video_for_copyright,
            modules::copyright_detector::commands::cancel_copyright_scan,
            commands::cf_scrape::cf_scrape_deliver,
            ];
            // The Cloudflare solver window loads third-party tracker pages, and
            // Tauri hands every webview the IPC bridge. Let that window deliver a
            // scraped page and nothing else, so a hostile script on a tracker site
            // cannot reach the rest of the app's commands.
            move |invoke: tauri::ipc::Invoke<tauri::Wry>| {
                let from_solver = invoke
                    .message
                    .webview_ref()
                    .label()
                    .starts_with(commands::cf_scrape::SOLVER_LABEL_PREFIX);
                if from_solver && invoke.message.command() != commands::cf_scrape::DELIVER_COMMAND {
                    invoke
                        .resolver
                        .reject("IPC is disabled in the Cloudflare solver webview");
                    return true;
                }
                commands(invoke)
            }
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let state = window.state::<AppState>();
                let has_active_queue = state.queue.list().iter().any(|j| j.status == crate::jobs::types::JobStatus::Running);
                let has_active_mute = !state.in_page_cancels.lock().is_empty();

                if has_active_queue || has_active_mute {
                    use tauri_plugin_dialog::DialogExt;
                    let confirm = window.dialog()
                        .message("Идет активный процесс обработки или скачивания. Вы уверены, что хотите закрыть программу?")
                        .title("Подтверждение выхода")
                        .buttons(tauri_plugin_dialog::MessageDialogButtons::OkCancel)
                        .blocking_show();
                    if !confirm {
                        api.prevent_close();
                    }
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|_, event| {
        if let tauri::RunEvent::Exit = event {
            error_reports::persist_before_exit();
            perform_cleanup();
        }
    });
}

fn perform_cleanup() {
    tracing::info!("Performing temporary directory cleanup...");

    // 1. Clean per-user data temp dir (yt-dlp PyInstaller cache)
    if let Some(temp_dir) = crate::platform::app_data_dir().map(|d| d.join("temp")) {
        if temp_dir.exists() {
            if let Err(err) = std::fs::remove_dir_all(&temp_dir) {
                tracing::warn!("Failed to clean app data temp dir: {err}");
            }
        }
    }

    // 2. Clean preview and updates folders under system temp
    let system_temp = std::env::temp_dir();
    for folder_name in &[
        "fetchr-preview-frame",
        "fetchr-chat-render-screenshot",
        "fetchr-preview",
        "Fetchr Updates",
    ] {
        let path = system_temp.join(folder_name);
        if path.exists() {
            let _ = std::fs::remove_dir_all(&path);
        }
    }

    // 3. Clean individual fetchr- files in system temp
    if let Ok(entries) = std::fs::read_dir(&system_temp) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_file() {
                if let Some(filename) = path.file_name().and_then(|f| f.to_str()) {
                    if filename.starts_with("fetchr-") {
                        let _ = std::fs::remove_file(&path);
                    }
                }
            }
        }
    }
}
