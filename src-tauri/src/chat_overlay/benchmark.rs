use anyhow::{anyhow, Context, Result};
use std::path::Path;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use std::time::Instant;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

use crate::app_log::AppLogger;
use crate::chat_overlay::model::read_chat_messages;
use crate::chat_overlay::renderer::ChatOverlayRenderer;
use crate::chat_overlay::settings::EffectiveChatOverlaySettings;
use crate::jobs::queue::QueueManager;
use crate::jobs::types::{
    AlphaOutputFormat, ChatComposeMode, ChatOverlaySettings, GpuEncoderMode, PerformanceSettings,
};

pub trait BenchmarkLogger: Send + Sync {
    fn log(&self, line: &str);
}

// Console logger implementation
pub struct ConsoleBenchmarkLogger;
impl BenchmarkLogger for ConsoleBenchmarkLogger {
    fn log(&self, line: &str) {
        println!("{}", line);
    }
}

pub async fn run_all_benchmarks(
    input_video: &Path,
    chat_json: &Path,
    output_dir: &Path,
    duration_sec: f64,
    chat_overlay_settings: ChatOverlaySettings,
    performance: PerformanceSettings,
    ffmpeg_path: &Path,
    logger: &dyn BenchmarkLogger,
) -> Result<()> {
    logger.log("=== ЗАПУСК МИНИ-БЕНЧМАРКОВ ЧАТА ===");
    logger.log(&format!("Входное видео: {}", input_video.display()));
    logger.log(&format!("Входной чат JSON: {}", chat_json.display()));
    logger.log(&format!("Папка результатов: {}", output_dir.display()));
    logger.log(&format!("Длительность: {} сек", duration_sec));

    let settings = EffectiveChatOverlaySettings::from(chat_overlay_settings.with_defaults());
    let performance = performance.with_defaults();

    // 1. encode без чата
    logger.log("\n--- БЕНЧМАРК 1: encode без чата (input -> h264_qsv) ---");
    let out_bench1 = output_dir.join("bench1_encode_no_chat.mp4");
    let (fps1, speed1) = run_transcode_bench(
        input_video,
        &out_bench1,
        duration_sec,
        &performance,
        ffmpeg_path,
        true,
        logger,
    )
    .await?;
    logger.log(&format!(
        ">> Результат 1: {:.1} fps, скорость {:.2}x",
        fps1, speed1
    ));

    // 2. decode + encode без overlay
    logger.log("\n--- БЕНЧМАРК 2: decode + encode без overlay (CPU decode) ---");
    let out_bench2 = output_dir.join("bench2_decode_encode_no_overlay.mp4");
    let (fps2, speed2) = run_transcode_bench(
        input_video,
        &out_bench2,
        duration_sec,
        &performance,
        ffmpeg_path,
        false,
        logger,
    )
    .await?;
    logger.log(&format!(
        ">> Результат 2: {:.1} fps, скорость {:.2}x",
        fps2, speed2
    ));

    // 3. fake overlay через lavfi color
    logger.log("\n--- БЕНЧМАРК 3: fake overlay через lavfi color ---");
    let out_bench3 = output_dir.join("bench3_fake_overlay.mp4");
    let (fps3, speed3) = run_fake_overlay_bench(
        input_video,
        &out_bench3,
        duration_sec,
        &settings,
        &performance,
        ffmpeg_path,
        logger,
    )
    .await?;
    logger.log(&format!(
        ">> Результат 3: {:.1} fps, скорость {:.2}x",
        fps3, speed3
    ));

    // For direct/intermediate compose benchmarks, we need to read chat messages
    let messages = read_chat_messages(chat_json).context("read chat messages for benchmark")?;

    // Create a mock QueueManager if we need it
    let mock_queue = Arc::new(QueueManager::new_mock(AppLogger::new()));
    let mock_job_id = "chat_benchmark_job".to_string();

    // 4. реальный Direct
    logger.log("\n--- БЕНЧМАРК 4: реальный Direct ---");
    let out_bench4 = output_dir.join("bench4_real_direct.mp4");
    let mut direct_settings = settings.clone();
    direct_settings.compose_mode = ChatComposeMode::Direct;

    let mut renderer = ChatOverlayRenderer::new(
        direct_settings.clone(),
        ffmpeg_path.to_path_buf(),
        output_dir.join("work_direct"),
        performance.render_workers,
        performance.profile,
        Some(performance.network_threads()),
        performance.gpu_encoder_mode,
        None,
    )?;

    let start_direct = Instant::now();
    let direct_res = renderer
        .render_direct_outputs(
            &messages,
            duration_sec,
            input_video,
            None,
            &out_bench4,
            performance.clone(),
            &[],
            &mock_queue,
            &mock_job_id,
            Arc::new(AtomicBool::new(false)),
        )
        .await;

    match direct_res {
        Ok(_) => {
            let elapsed = start_direct.elapsed().as_secs_f64().max(0.001);
            let wall_speed = duration_sec / elapsed;
            logger.log(&format!(
                ">> Результат 4: total wall-clock speed {:.2}x (общее время {:.1}s); video-fps/ffmpeg speed см. в логе Direct",
                wall_speed,
                elapsed
            ));
        }
        Err(e) => {
            logger.log(&format!(">> Ошибка реального Direct: {e:#}"));
        }
    }

    // 5. реальный Intermediate
    logger.log("\n--- БЕНЧМАРК 5: реальный Intermediate ---");
    let out_bench5_mov = output_dir.join("bench5_real_intermediate.mov");
    let out_bench5_mp4 = output_dir.join("bench5_real_intermediate.mp4");

    let mut intermediate_settings = settings.clone();
    intermediate_settings.compose_mode = ChatComposeMode::Intermediate;
    intermediate_settings.alpha_output_format = AlphaOutputFormat::MovQtrle;

    let mut renderer_int = ChatOverlayRenderer::new(
        intermediate_settings.clone(),
        ffmpeg_path.to_path_buf(),
        output_dir.join("work_int"),
        performance.render_workers,
        performance.profile,
        Some(performance.network_threads()),
        performance.gpu_encoder_mode,
        None,
    )?;

    let start_int = Instant::now();
    logger.log("Запуск Pass 1: рендер прозрачного MOV...");
    let mov_res = renderer_int
        .render_to_mov(
            &messages,
            duration_sec,
            &out_bench5_mov,
            &mock_queue,
            &mock_job_id,
            Arc::new(AtomicBool::new(false)),
        )
        .await;

    match mov_res {
        Ok(chat_pipe_metrics) => {
            let pass1_elapsed = start_int.elapsed().as_secs_f64().max(0.001);
            logger.log(&format!(
                "Pass 1 завершен за {:.1}s: {:.1} chat pipe fps (pipe speed {:.2}x)",
                pass1_elapsed,
                chat_pipe_metrics.fps,
                chat_pipe_metrics.speed_ratio()
            ));

            logger.log("Запуск Pass 2: композиция с видео...");
            let start_pass2 = Instant::now();
            let composer = crate::chat_overlay::composer::ChatOverlayComposer::new(
                intermediate_settings.clone(),
                ffmpeg_path.to_path_buf(),
                performance.clone(),
                vec![],
            );
            let compose_res = composer
                .compose(
                    input_video,
                    &out_bench5_mov,
                    &out_bench5_mp4,
                    duration_sec,
                    Some(chat_pipe_metrics),
                    &mock_queue,
                    &mock_job_id,
                    Arc::new(AtomicBool::new(false)),
                )
                .await;

            match compose_res {
                Ok(_) => {
                    let pass2_elapsed = start_pass2.elapsed().as_secs_f64().max(0.001);
                    let total_elapsed = start_int.elapsed().as_secs_f64().max(0.001);
                    let wall_speed = duration_sec / total_elapsed;
                    logger.log(&format!("Pass 2 завершен за {:.1}s", pass2_elapsed));
                    logger.log(&format!(
                        ">> Результат 5: total wall-clock speed {:.2}x (общее время {:.1}s); video-fps/ffmpeg speed см. в логе Intermediate Pass 2",
                        wall_speed,
                        total_elapsed
                    ));
                }
                Err(e) => {
                    logger.log(&format!(">> Ошибка Pass 2: {e:#}"));
                }
            }
        }
        Err(e) => {
            logger.log(&format!(">> Ошибка Pass 1: {e:#}"));
        }
    }

    logger.log("\n=== БЕНЧМАРК ЗАВЕРШЕН ===");
    Ok(())
}

async fn run_transcode_bench(
    input_video: &Path,
    output_video: &Path,
    duration_sec: f64,
    performance: &PerformanceSettings,
    ffmpeg_path: &Path,
    hw_decode: bool,
    logger: &dyn BenchmarkLogger,
) -> Result<(f64, f64)> {
    let direct_encoder_attempts = direct_encoder_attempts_for_bench(performance);
    let encoder = direct_encoder_attempts
        .first()
        .ok_or_else(|| anyhow!("no encoder configured"))?;

    let mut cmd = Command::new(ffmpeg_path);
    cmd.kill_on_drop(true)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .args(["-y", "-hide_banner"]);

    if hw_decode {
        cmd.args(["-hwaccel", "auto"]);
    } else {
        cmd.args(["-hwaccel", "none"]);
    }

    cmd.arg("-i").arg(input_video);
    cmd.args(&encoder.args);
    cmd.args(["-an", "-t", &duration_sec.to_string()]);
    cmd.arg(output_video);

    #[cfg(windows)]
    {
        cmd.creation_flags(0x0800_0000);
    }

    logger.log(&format!("$ {:?}", cmd));
    run_ffmpeg_command_and_parse_speed(cmd).await
}

async fn run_fake_overlay_bench(
    input_video: &Path,
    output_video: &Path,
    duration_sec: f64,
    settings: &EffectiveChatOverlaySettings,
    performance: &PerformanceSettings,
    ffmpeg_path: &Path,
    logger: &dyn BenchmarkLogger,
) -> Result<(f64, f64)> {
    let direct_encoder_attempts = direct_encoder_attempts_for_bench(performance);
    let encoder = direct_encoder_attempts
        .first()
        .ok_or_else(|| anyhow!("no encoder configured"))?;

    let mut cmd = Command::new(ffmpeg_path);
    cmd.kill_on_drop(true)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .args(["-y", "-hide_banner", "-hwaccel", "auto"]);

    cmd.arg("-i").arg(input_video);

    // Filter using color generator instead of raw pipe
    let chat_w = settings.chat_width;
    let chat_h = settings.chat_height;
    let fps = settings.chat_overlay_fps.max(1);
    let x = settings.chat_x;
    let y = settings.chat_y;
    let filter = format!(
        "color=c=black@0:s={chat_w}x{chat_h}:r={fps}:d={duration_sec}[fake_chat]; \
         [0:v][fake_chat]overlay={x}:{y}:format=auto[v]"
    );

    cmd.args(["-filter_complex", &filter, "-map", "[v]"]);
    cmd.args(&encoder.args);
    cmd.args(["-an", "-t", &duration_sec.to_string()]);
    cmd.arg(output_video);

    #[cfg(windows)]
    {
        cmd.creation_flags(0x0800_0000);
    }

    logger.log(&format!("$ {:?}", cmd));
    run_ffmpeg_command_and_parse_speed(cmd).await
}

async fn run_ffmpeg_command_and_parse_speed(mut cmd: Command) -> Result<(f64, f64)> {
    let mut child = cmd.spawn().context("spawn ffmpeg benchmark")?;
    let stderr = child.stderr.take().context("stderr handle")?;

    let mut reader = BufReader::new(stderr).lines();
    let re_fps = regex::Regex::new(r"fps=\s*(\d+(?:\.\d+)?)").unwrap();
    let re_speed = regex::Regex::new(r"speed=\s*(\d+(?:\.\d+)?)x").unwrap();

    let mut last_fps = 0.0;
    let mut last_speed = 0.0;

    while let Ok(Some(line)) = reader.next_line().await {
        if let Some(caps) = re_fps.captures(&line) {
            if let Ok(fps) = caps.get(1).unwrap().as_str().parse::<f64>() {
                last_fps = fps;
            }
        }
        if let Some(caps) = re_speed.captures(&line) {
            if let Ok(speed) = caps.get(1).unwrap().as_str().parse::<f64>() {
                last_speed = speed;
            }
        }
    }

    let status = child.wait().await?;
    if !status.success() {
        return Err(anyhow!("ffmpeg exited with error status: {status}"));
    }

    Ok((last_fps, last_speed))
}

// Simple copy of encoder attempt generator for benchmark
struct BenchEncoderAttempt {
    args: Vec<String>,
}

fn direct_encoder_attempts_for_bench(
    performance: &PerformanceSettings,
) -> Vec<BenchEncoderAttempt> {
    let mode = performance.gpu_encoder_mode.unwrap_or(GpuEncoderMode::Auto);
    let preset = performance
        .ffmpeg_preset
        .clone()
        .filter(|v| !v.trim().is_empty());

    let qsv_args = vec![
        "-c:v".into(),
        "h264_qsv".into(),
        "-preset".into(),
        preset.clone().unwrap_or_else(|| "veryfast".into()),
        "-async_depth".into(),
        "8".into(),
        "-global_quality".into(),
        "18".into(),
        "-pix_fmt".into(),
        "nv12".into(),
    ];
    let nvenc_args = vec![
        "-c:v".into(),
        "h264_nvenc".into(),
        "-preset".into(),
        preset.clone().unwrap_or_else(|| "p4".into()),
        "-cq".into(),
        "18".into(),
        "-b:v".into(),
        "0".into(),
        "-pix_fmt".into(),
        "yuv420p".into(),
    ];
    let amf_args = vec![
        "-c:v".into(),
        "h264_amf".into(),
        "-quality".into(),
        preset.clone().unwrap_or_else(|| "speed".into()),
        "-qp_i".into(),
        "18".into(),
        "-qp_p".into(),
        "18".into(),
        "-pix_fmt".into(),
        "yuv420p".into(),
    ];
    let cpu_args = vec![
        "-c:v".into(),
        "libx264".into(),
        "-crf".into(),
        "18".into(),
        "-preset".into(),
        preset.unwrap_or_else(|| "medium".into()),
        "-pix_fmt".into(),
        "yuv420p".into(),
    ];

    match mode {
        GpuEncoderMode::Auto => vec![
            BenchEncoderAttempt { args: qsv_args },
            BenchEncoderAttempt { args: nvenc_args },
            BenchEncoderAttempt { args: amf_args },
            BenchEncoderAttempt { args: cpu_args },
        ],
        GpuEncoderMode::IntelXeQsv | GpuEncoderMode::Qsv => vec![
            BenchEncoderAttempt { args: qsv_args },
            BenchEncoderAttempt { args: cpu_args },
        ],
        GpuEncoderMode::Nvenc => vec![
            BenchEncoderAttempt { args: nvenc_args },
            BenchEncoderAttempt { args: cpu_args },
        ],
        GpuEncoderMode::Amf => vec![
            BenchEncoderAttempt { args: amf_args },
            BenchEncoderAttempt { args: cpu_args },
        ],
        GpuEncoderMode::Vulkan => vec![
            BenchEncoderAttempt {
                args: vec![
                    "-c:v".into(),
                    "h264_vulkan".into(),
                    "-pix_fmt".into(),
                    "vulkan".into(),
                ],
            },
            BenchEncoderAttempt { args: cpu_args },
        ],
        GpuEncoderMode::Cpu => vec![BenchEncoderAttempt { args: cpu_args }],
    }
}
