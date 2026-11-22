#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// Multi-threaded chat rasterization allocates/frees large RGBA buffers on every worker
// thread; the default Windows heap serializes these on a global lock (threads spin on the
// lock, burning CPU without progress). mimalloc has per-thread heaps and removes that
// contention, which is the dominant cost of the parallel frame renderer on Windows.
#[global_allocator]
static GLOBAL: mimalloc::MiMalloc = mimalloc::MiMalloc;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.contains(&"--benchmark".to_string()) {
        let mut input_video = None;
        let mut chat_json = None;
        let mut output_dir = None;
        let mut duration = 30.0;
        let mut preset = None;
        let mut gpu_mode = None;

        let mut i = 0;
        while i < args.len() {
            match args[i].as_str() {
                "--input-video" if i + 1 < args.len() => {
                    input_video = Some(args[i + 1].clone());
                    i += 2;
                }
                "--chat-json" if i + 1 < args.len() => {
                    chat_json = Some(args[i + 1].clone());
                    i += 2;
                }
                "--output-dir" if i + 1 < args.len() => {
                    output_dir = Some(args[i + 1].clone());
                    i += 2;
                }
                "--duration" if i + 1 < args.len() => {
                    if let Ok(d) = args[i + 1].parse::<f64>() {
                        duration = d;
                    }
                    i += 2;
                }
                "--preset" if i + 1 < args.len() => {
                    preset = Some(args[i + 1].clone());
                    i += 2;
                }
                "--gpu-mode" if i + 1 < args.len() => {
                    gpu_mode = Some(args[i + 1].clone());
                    i += 2;
                }
                _ => {
                    i += 1;
                }
            }
        }

        let input_video = match input_video {
            Some(v) => std::path::PathBuf::from(v),
            None => {
                eprintln!("Error: --input-video <path> is required");
                std::process::exit(1);
            }
        };

        let chat_json = match chat_json {
            Some(j) => std::path::PathBuf::from(j),
            None => {
                eprintln!("Error: --chat-json <path> is required");
                std::process::exit(1);
            }
        };

        let output_dir = match output_dir {
            Some(o) => std::path::PathBuf::from(o),
            None => std::path::PathBuf::from("."),
        };

        // Initialize tokio runtime and run
        let rt = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .unwrap();

        rt.block_on(async {
            println!("Resolving ffmpeg...");
            let ffmpeg = fetchr_lib::binaries::resolve_binary(fetchr_lib::binaries::FFMPEG, None);
            let ffmpeg = match ffmpeg {
                Some(f) => f,
                None => {
                    // Try to resolve in managed folder
                    if let Some(dir) = fetchr_lib::binaries::managed_bin_dir() {
                        let path = dir.join(fetchr_lib::binaries::FFMPEG);
                        if path.is_file() {
                            path
                        } else {
                            eprintln!("Error: ffmpeg.exe not found");
                            std::process::exit(1);
                        }
                    } else {
                        eprintln!("Error: ffmpeg.exe not found");
                        std::process::exit(1);
                    }
                }
            };

            let chat_overlay = fetchr_lib::jobs::types::ChatOverlaySettings::default();
            let mut performance = fetchr_lib::jobs::types::PerformanceSettings::default();
            performance.ffmpeg_preset = preset;
            if let Some(mode_str) = gpu_mode {
                let mode = match mode_str.to_ascii_lowercase().as_str() {
                    "qsv" => fetchr_lib::jobs::types::GpuEncoderMode::Qsv,
                    "intelxeqsv" => fetchr_lib::jobs::types::GpuEncoderMode::IntelXeQsv,
                    "nvenc" => fetchr_lib::jobs::types::GpuEncoderMode::Nvenc,
                    "amf" => fetchr_lib::jobs::types::GpuEncoderMode::Amf,
                    "vulkan" => fetchr_lib::jobs::types::GpuEncoderMode::Vulkan,
                    "cpu" => fetchr_lib::jobs::types::GpuEncoderMode::Cpu,
                    _ => fetchr_lib::jobs::types::GpuEncoderMode::Auto,
                };
                performance.gpu_encoder_mode = Some(mode);
            }

            let logger = fetchr_lib::chat_overlay::benchmark::ConsoleBenchmarkLogger;
            match fetchr_lib::chat_overlay::benchmark::run_all_benchmarks(
                &input_video,
                &chat_json,
                &output_dir,
                duration,
                chat_overlay,
                performance,
                &ffmpeg,
                &logger,
            )
            .await
            {
                Ok(_) => {
                    println!("Benchmarks finished successfully!");
                }
                Err(e) => {
                    eprintln!("Error running benchmarks: {:?}", e);
                    std::process::exit(1);
                }
            }
        });
        return;
    }

    fetchr_lib::run();
}
