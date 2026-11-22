//! Native macOS menu bar. Apple's HIG expects every Mac app to ship the
//! standard menus (app, File, Edit, View, Window, Help); without an Edit menu
//! the webview does not even receive Cmd+C / Cmd+V. Custom items are forwarded
//! to the frontend as a `mac-menu` event carrying the item id.
//!
//! The builder compiles on every platform so `cargo check` on Windows covers
//! it; it is only installed on macOS.

use tauri::menu::{
    AboutMetadataBuilder, Menu, MenuBuilder, MenuItem, MenuItemBuilder, SubmenuBuilder,
};
use tauri::{AppHandle, Emitter, Manager, Runtime};

pub const MENU_EVENT: &str = "mac-menu";

/// Sections in View, in the same order as the sidebar. `nav:` ids are
/// resolved to routes by the frontend.
const SECTIONS: &[(&str, &str, &str)] = &[
    ("nav:download", "Скачать", "CmdOrCtrl+1"),
    ("nav:queue", "Загрузки", "CmdOrCtrl+2"),
    ("nav:live-recorder", "Запись стримов", "CmdOrCtrl+3"),
    ("nav:vps-recorder", "Архив VPS", "CmdOrCtrl+4"),
    ("nav:chat-render", "Рендер чата", "CmdOrCtrl+5"),
    ("nav:fetchr-mute", "Удалить маты", "CmdOrCtrl+6"),
    ("nav:vocal-remover", "Vocal Remover", "CmdOrCtrl+7"),
    ("nav:sponsor-blur", "Блюр спонсоров", "CmdOrCtrl+8"),
    ("nav:logs", "Логи", "CmdOrCtrl+9"),
];

fn item<R: Runtime, M: Manager<R>>(
    manager: &M,
    id: &str,
    text: &str,
    accelerator: Option<&str>,
) -> tauri::Result<MenuItem<R>> {
    let builder = MenuItemBuilder::with_id(id, text);
    let builder = match accelerator {
        Some(accel) => builder.accelerator(accel),
        None => builder,
    };
    builder.build(manager)
}

pub fn build<R: Runtime, M: Manager<R>>(manager: &M) -> tauri::Result<Menu<R>> {
    let version = manager.package_info().version.to_string();
    let about = AboutMetadataBuilder::new()
        .name(Some("Fetchr"))
        .version(Some(version))
        .website(Some("https://fetchr.fun"))
        .build();

    let app_menu = SubmenuBuilder::new(manager, "Fetchr")
        .about(Some(about))
        .separator()
        .item(&item(manager, "settings", "Настройки…", Some("CmdOrCtrl+,"))?)
        .item(&item(manager, "check-updates", "Проверить обновления…", None)?)
        .item(&item(manager, "whats-new", "Что нового", None)?)
        .separator()
        .services()
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .quit()
        .build()?;

    let file_menu = SubmenuBuilder::new(manager, "Файл")
        .item(&item(manager, "add", "Добавить ссылку…", Some("CmdOrCtrl+N"))?)
        .item(&item(manager, "palette", "Найти…", Some("CmdOrCtrl+K"))?)
        .separator()
        .item(&item(manager, "start-queue", "Запустить очередь", Some("CmdOrCtrl+Return"))?)
        .separator()
        .close_window()
        .build()?;

    let edit_menu = SubmenuBuilder::new(manager, "Правка")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;

    let mut view_builder = SubmenuBuilder::new(manager, "Вид")
        .item(&item(manager, "toggle-sidebar", "Показать/скрыть боковую панель", Some("Ctrl+CmdOrCtrl+S"))?)
        .separator();
    for (id, text, accel) in SECTIONS {
        view_builder = view_builder.item(&item(manager, id, text, Some(accel))?);
    }
    let view_menu = view_builder
        .item(&item(manager, "nav:presets", "Пресеты", None)?)
        .separator()
        .fullscreen()
        .build()?;

    let window_menu = SubmenuBuilder::new(manager, "Окно")
        .minimize()
        .maximize()
        .separator()
        .close_window()
        .build()?;

    let help_menu = SubmenuBuilder::new(manager, "Справка")
        .item(&item(manager, "help-site", "Сайт Fetchr", None)?)
        .item(&item(manager, "help-tour", "Обучение по интерфейсу", None)?)
        .build()?;

    MenuBuilder::new(manager)
        .items(&[&app_menu, &file_menu, &edit_menu, &view_menu, &window_menu, &help_menu])
        .build()
}

/// Installs the menu bar and forwards custom items to the webview.
/// No-op outside macOS: Windows and Linux keep the in-window chrome.
pub fn install<R: Runtime>(app: &AppHandle<R>) {
    if !cfg!(target_os = "macos") {
        return;
    }
    match build(app) {
        Ok(menu) => {
            if let Err(err) = app.set_menu(menu) {
                tracing::warn!("Failed to set macOS menu: {err}");
                return;
            }
            app.on_menu_event(|app, event| {
                if let Err(err) = app.emit(MENU_EVENT, event.id().as_ref()) {
                    tracing::warn!("Failed to forward menu event: {err}");
                }
            });
        }
        Err(err) => tracing::warn!("Failed to build macOS menu: {err}"),
    }
}
