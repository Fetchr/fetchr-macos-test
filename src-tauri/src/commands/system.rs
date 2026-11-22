use serde::Serialize;

use crate::jobs::types::{GpuEncoderMode, PerformanceProfile, PerformanceSettings};

#[derive(Debug, Clone, Serialize)]
pub struct HardwarePreset {
    pub cpu_logical_cores: usize,
    pub gpu_names: Vec<String>,
    pub summary: String,
    pub performance: PerformanceSettings,
}

#[cfg(target_os = "windows")]
#[repr(C)]
struct MEMORYSTATUSEX {
    dw_length: u32,
    dw_memory_load: u32,
    ull_total_phys: u64,
    ull_avail_phys: u64,
    ull_total_page_file: u64,
    ull_avail_page_file: u64,
    ull_total_virtual: u64,
    ull_avail_virtual: u64,
    ull_avail_extended_virtual: u64,
}

#[cfg(target_os = "windows")]
fn get_system_ram_gb() -> u32 {
    let mut mem_info = MEMORYSTATUSEX {
        dw_length: std::mem::size_of::<MEMORYSTATUSEX>() as u32,
        dw_memory_load: 0,
        ull_total_phys: 0,
        ull_avail_phys: 0,
        ull_total_page_file: 0,
        ull_avail_page_file: 0,
        ull_total_virtual: 0,
        ull_avail_virtual: 0,
        ull_avail_extended_virtual: 0,
    };
    unsafe {
        extern "system" {
            fn GlobalMemoryStatusEx(lpBuffer: *mut MEMORYSTATUSEX) -> i32;
        }
        if GlobalMemoryStatusEx(&mut mem_info) != 0 {
            let bytes = mem_info.ull_total_phys;
            return ((bytes + (1024 * 1024 * 1024 / 2)) / (1024 * 1024 * 1024)) as u32;
        }
    }
    16
}

#[cfg(not(target_os = "windows"))]
fn get_system_ram_gb() -> u32 {
    16
}

/// Async: the GPU probe runs PowerShell (about a second), and a sync command
/// would run it on the main thread and freeze the window.
#[tauri::command]
pub async fn detect_hardware_preset() -> Result<HardwarePreset, String> {
    tauri::async_runtime::spawn_blocking(hardware_preset)
        .await
        .map_err(|err| format!("Hardware detection failed: {err}"))
}

/// Starts the GPU probe in the background so the preset is ready when the UI asks.
pub fn prefetch_gpu_names() {
    gpu_names();
}

/// Display adapters do not change while the app runs; probe once per process.
fn gpu_names() -> &'static [String] {
    static NAMES: std::sync::OnceLock<Vec<String>> = std::sync::OnceLock::new();
    NAMES.get_or_init(detect_gpu_names)
}

fn hardware_preset() -> HardwarePreset {
    let cpu_logical_cores = std::thread::available_parallelism()
        .map(|cores| cores.get())
        .unwrap_or(4);
    let gpu_names = gpu_names().to_vec();
    let gpu_encoder_mode = recommend_encoder(&gpu_names);

    let ram_gb = get_system_ram_gb();

    // Determine performance parameters based on RAM and CPU Cores
    let (cpu_threads, render_workers, network_concurrent_fragments, ffmpeg_preset) = if ram_gb <= 8
    {
        (
            (cpu_logical_cores / 2).max(2) as u32,
            (cpu_logical_cores / 2).max(2) as u32,
            8u32,
            Some("ultrafast".to_string()),
        )
    } else if ram_gb <= 16 {
        (
            (cpu_logical_cores * 3 / 4).max(4) as u32,
            (cpu_logical_cores * 3 / 4).max(4) as u32,
            16u32,
            Some("veryfast".to_string()),
        )
    } else if ram_gb <= 32 {
        (
            cpu_logical_cores as u32,
            cpu_logical_cores as u32,
            24u32,
            Some("faster".to_string()),
        )
    } else {
        (
            cpu_logical_cores as u32,
            ((cpu_logical_cores * 5) / 4).max(cpu_logical_cores) as u32,
            32u32,
            Some("fast".to_string()),
        )
    };

    let summary = format!(
        "CPU: {} cores, RAM: {} GB, GPU: {}, encoder: {:?}, render workers: {}, net: {}",
        cpu_logical_cores,
        ram_gb,
        if gpu_names.is_empty() {
            "not detected".to_string()
        } else {
            gpu_names.join(" / ")
        },
        gpu_encoder_mode,
        render_workers,
        network_concurrent_fragments,
    );

    HardwarePreset {
        cpu_logical_cores,
        gpu_names,
        summary,
        performance: PerformanceSettings {
            profile: Some(PerformanceProfile::Maximum),
            network_concurrent_fragments: Some(network_concurrent_fragments),
            cpu_threads: Some(cpu_threads),
            render_workers: Some(render_workers),
            gpu_encoder_mode: Some(gpu_encoder_mode),
            ffmpeg_preset,
        },
    }
}

fn recommend_encoder(gpu_names: &[String]) -> GpuEncoderMode {
    let joined = gpu_names.join(" ").to_ascii_lowercase();
    if joined.contains("nvidia") || joined.contains("geforce") || joined.contains("rtx") {
        return GpuEncoderMode::Nvenc;
    }
    if joined.contains("intel") && (joined.contains("xe") || joined.contains("arc")) {
        return GpuEncoderMode::IntelXeQsv;
    }
    if joined.contains("intel") {
        return GpuEncoderMode::Qsv;
    }
    if joined.contains("amd") || joined.contains("radeon") {
        return GpuEncoderMode::Amf;
    }
    GpuEncoderMode::Cpu
}

fn detect_gpu_names() -> Vec<String> {
    #[cfg(target_os = "windows")]
    {
        let output = hidden_command("powershell")
            .args([
                "-NoProfile",
                "-ExecutionPolicy",
                "Bypass",
                "-Command",
                "Get-CimInstance Win32_VideoController | ForEach-Object { $_.Name }",
            ])
            .output();

        if let Ok(output) = output {
            if output.status.success() {
                let text = String::from_utf8_lossy(&output.stdout);
                let names = text
                    .lines()
                    .map(str::trim)
                    .filter(|line| !line.is_empty())
                    .map(ToOwned::to_owned)
                    .collect::<Vec<_>>();
                if !names.is_empty() {
                    return names;
                }
            }
        }
    }

    Vec::new()
}

#[cfg(target_os = "windows")]
fn hidden_command(program: &str) -> std::process::Command {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x08000000;
    let mut cmd = std::process::Command::new(program);
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd
}

/// Exceptions the webview could not handle; they join the error reports.
#[tauri::command]
pub fn report_client_error(kind: String, message: String, stack: Option<String>) {
    crate::error_reports::report_frontend(&kind, &message, stack.as_deref());
}
