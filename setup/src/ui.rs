//! Окно установщика: tao + WebView2 (wry). Страница ui/index.html играет
//! «Проявку» и показывает прогресс; Rust ставит файлы в отдельном потоке.
//!
//! Страница → Rust: window.ipc.postMessage("ready" | "start" | "launch" |
//! "close" | "minimize" | "drag").
//! Rust → страница: window.__setup({ type, ... }) — см. ui/index.html.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use fetchr_setup::Located;
use serde_json::json;
use tao::dpi::{LogicalSize, PhysicalPosition};
use tao::event::{Event, WindowEvent};
use tao::event_loop::{ControlFlow, EventLoopBuilder, EventLoopProxy};
use tao::platform::windows::{IconExtWindows, WindowBuilderExtWindows, WindowExtWindows};
use tao::window::{Icon, WindowBuilder};
use wry::{WebContext, WebViewBuilder};

use crate::install::{self, Event as InstallEvent};
use crate::win;

const PAGE: &str = include_str!("../ui/index.html");
const GSAP: &str = include_str!("../../node_modules/gsap/dist/gsap.min.js");
const WEBVIEW2_BOOTSTRAPPER: &str = "https://go.microsoft.com/fwlink/p/?LinkId=2124703";

enum UserEvent {
    Ipc(String),
    Push(serde_json::Value),
    Finished(Result<PathBuf, String>),
}

#[derive(PartialEq, Eq)]
enum Phase {
    Waiting,
    Installing,
    Done,
    Failed,
}

pub fn run(exe: PathBuf, pkg: Located) -> ! {
    if wry::webview_version().is_err() && !ensure_webview2() {
        // Без WebView2 окна не будет: ставим без него, как обновление
        if win::confirm(
            "Установка Fetchr",
            "Не удалось установить Microsoft Edge WebView2, без него окно установщика не откроется.\n\nУстановить Fetchr без окна?",
        ) {
            let code = crate::silent_install(&exe, &pkg, false, true);
            if code != 0 {
                win::message("Установка Fetchr", "Установка не удалась. Подробности — в %TEMP%\\Fetchr Updates\\setup.log", true);
            }
            std::process::exit(code);
        }
        std::process::exit(1);
    }

    let event_loop = EventLoopBuilder::<UserEvent>::with_user_event().build();
    let proxy = event_loop.create_proxy();
    let window = WindowBuilder::new()
        .with_title("Установка Fetchr")
        .with_inner_size(LogicalSize::new(760.0, 470.0))
        .with_resizable(false)
        .with_decorations(false)
        .with_undecorated_shadow(true)
        .with_visible(false)
        .with_window_icon(Icon::from_resource(1, None).ok())
        .build(&event_loop)
        .unwrap_or_else(|err| crate::fail(&format!("Не удалось открыть окно: {err}")));
    round_corners(window.hwnd());
    if let Some(monitor) = window.current_monitor() {
        let area = monitor.size();
        let size = window.outer_size();
        let origin = monitor.position();
        window.set_outer_position(PhysicalPosition::new(
            origin.x + (area.width as i32 - size.width as i32) / 2,
            origin.y + (area.height as i32 - size.height as i32) / 2,
        ));
    }

    let mut context = WebContext::new(Some(std::env::temp_dir().join("fetchr-setup-webview")));
    let ipc_proxy = proxy.clone();
    let html = PAGE.replace("/*__GSAP__*/", GSAP);
    let webview = WebViewBuilder::new_with_web_context(&mut context)
        .with_html(html)
        .with_background_color((6, 7, 10, 255))
        .with_devtools(cfg!(debug_assertions))
        .with_ipc_handler(move |req| {
            let _ = ipc_proxy.send_event(UserEvent::Ipc(req.body().clone()));
        })
        .build(&window)
        .unwrap_or_else(|err| crate::fail(&format!("Не удалось открыть окно установщика: {err}")));

    let exe = Arc::new(exe);
    let pkg = Arc::new(pkg);
    let cancel = Arc::new(AtomicBool::new(false));
    let mut phase = Phase::Waiting;
    let mut closing = false;
    let mut fresh = true;
    let mut installed: Option<PathBuf> = None;
    let push = |webview: &wry::WebView, value: serde_json::Value| {
        let _ = webview.evaluate_script(&format!("window.__setup && window.__setup({value})"));
    };

    event_loop.run(move |event, _, control_flow| {
        *control_flow = ControlFlow::Wait;
        let _ = &context;
        match event {
            Event::WindowEvent { event: WindowEvent::CloseRequested, .. } => {
                let _ = proxy.send_event(UserEvent::Ipc("close".into()));
            }
            Event::UserEvent(UserEvent::Push(value)) => push(&webview, value),
            Event::UserEvent(UserEvent::Finished(result)) => {
                if closing {
                    *control_flow = ControlFlow::Exit;
                    return;
                }
                match result {
                    Ok(dir) => {
                        phase = Phase::Done;
                        push(&webview, json!({ "type": "done", "dir": dir.to_string_lossy() }));
                        installed = Some(dir);
                    }
                    Err(err) => {
                        phase = Phase::Failed;
                        push(&webview, json!({ "type": "error", "message": err }));
                    }
                }
            }
            Event::UserEvent(UserEvent::Ipc(message)) => match message.as_str() {
                "ready" => {
                    window.set_visible(true);
                    window.set_focus();
                    let cpu = match win::cpu() {
                        win::Cpu::Ok => "ok",
                        win::Cpu::NoAvx => "no-avx",
                        win::Cpu::NoAvx2 => "no-avx2",
                    };
                    push(&webview, json!({
                        "type": "init",
                        "version": pkg.meta.version,
                        "dir": install::install_dir().to_string_lossy(),
                        "update": install::is_installed(),
                        "cpu": cpu,
                    }));
                }
                "start" if phase == Phase::Waiting || phase == Phase::Failed => {
                    if win::cpu() == win::Cpu::NoAvx {
                        return;
                    }
                    phase = Phase::Installing;
                    fresh = !install::is_installed();
                    cancel.store(false, Ordering::Relaxed);
                    spawn_install(proxy.clone(), exe.clone(), pkg.clone(), cancel.clone());
                }
                "launch" => {
                    if let Some(dir) = &installed {
                        win::spawn_detached(&dir.join(&pkg.meta.main_binary), dir);
                    }
                    *control_flow = ControlFlow::Exit;
                }
                "close" if phase == Phase::Installing && !fresh => {
                    // Поверх старой версии отмена сломала бы установку
                    push(&webview, json!({ "type": "busy" }));
                }
                "close" => {
                    if phase == Phase::Installing {
                        closing = true;
                        cancel.store(true, Ordering::Relaxed);
                        push(&webview, json!({ "type": "cancelling" }));
                    } else {
                        *control_flow = ControlFlow::Exit;
                    }
                }
                "minimize" => window.set_minimized(true),
                "drag" => {
                    let _ = window.drag_window();
                }
                _ => {}
            },
            _ => {}
        }
    })
}

fn spawn_install(proxy: EventLoopProxy<UserEvent>, exe: Arc<PathBuf>, pkg: Arc<Located>, cancel: Arc<AtomicBool>) {
    std::thread::spawn(move || {
        let events = proxy.clone();
        let emit = move |event: InstallEvent| {
            let value = match event {
                InstallEvent::Step(label) => json!({ "type": "step", "label": label }),
                InstallEvent::Progress { done, total, label } => {
                    json!({ "type": "progress", "done": done, "total": total, "label": label })
                }
            };
            let _ = events.send_event(UserEvent::Push(value));
        };
        let opts = install::Options { update: false };
        let result = install::install(&exe, &pkg, &opts, &cancel, &emit);
        if let Err(err) = &result {
            crate::log(&format!("install failed: {err}"));
        }
        let _ = proxy.send_event(UserEvent::Finished(result));
    });
}

/// Скругление углов окна без рамки (Windows 11)
fn round_corners(hwnd: isize) {
    use windows_sys::Win32::Graphics::Dwm::{DwmSetWindowAttribute, DWMWA_WINDOW_CORNER_PREFERENCE, DWMWCP_ROUND};
    let preference = DWMWCP_ROUND;
    unsafe {
        DwmSetWindowAttribute(
            hwnd as _,
            DWMWA_WINDOW_CORNER_PREFERENCE as u32,
            &preference as *const _ as *const _,
            std::mem::size_of_val(&preference) as u32,
        );
    }
}

/// Ставит WebView2 через официальный загрузчик Microsoft
fn ensure_webview2() -> bool {
    let path = std::env::temp_dir().join("MicrosoftEdgeWebview2Setup.exe");
    let path_s = path.to_string_lossy().to_string();
    let _ = win::run_hidden(
        "curl.exe",
        &["-fsSL", "--retry", "2", "--connect-timeout", "20", "--max-time", "300", "-o", &path_s, WEBVIEW2_BOOTSTRAPPER],
    );
    if !path.exists() {
        return false;
    }
    if !crate::install::signed_by_microsoft(&path) {
        let _ = std::fs::remove_file(&path);
        return false;
    }
    let _ = win::run_hidden(&path_s, &["/silent", "/install"]);
    let _ = std::fs::remove_file(&path);
    wry::webview_version().is_ok()
}
