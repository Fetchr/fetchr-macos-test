use std::path::PathBuf;

use serde::Deserialize;
use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

#[tauri::command]
pub fn open_folder(app: AppHandle, path: String) -> Result<(), String> {
    app.opener()
        .open_path(path, None::<&str>)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn reveal_file(app: AppHandle, path: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    let target = if p.is_file() {
        p.parent().map(|x| x.to_path_buf()).unwrap_or(p.clone())
    } else {
        p
    };
    app.opener()
        .open_path(target.to_string_lossy().to_string(), None::<&str>)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn default_download_dir() -> String {
    dirs::download_dir()
        .or_else(dirs::home_dir)
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default()
}

#[tauri::command]
pub async fn choose_directory(app: AppHandle) -> Option<String> {
    let (tx, rx) = tokio::sync::oneshot::channel::<Option<String>>();
    let tx = std::sync::Mutex::new(Some(tx));
    app.dialog().file().pick_folder(move |path| {
        let p = path
            .and_then(|fp| fp.into_path().ok())
            .map(|pb| pb.to_string_lossy().into_owned());
        if let Some(sender) = tx.lock().ok().and_then(|mut g| g.take()) {
            let _ = sender.send(p);
        }
    });
    rx.await.ok().flatten()
}

#[tauri::command]
pub async fn choose_image_file(app: AppHandle) -> Option<String> {
    let (tx, rx) = tokio::sync::oneshot::channel::<Option<String>>();
    let tx = std::sync::Mutex::new(Some(tx));
    app.dialog()
        .file()
        .add_filter("Images", &["png", "jpg", "jpeg", "webp"])
        .pick_file(move |path| {
            let p = path
                .and_then(|fp| fp.into_path().ok())
                .map(|pb| pb.to_string_lossy().into_owned());
            if let Some(sender) = tx.lock().ok().and_then(|mut g| g.take()) {
                let _ = sender.send(p);
            }
        });
    rx.await.ok().flatten()
}

/// Raw bytes (an ArrayBuffer on the JS side). A `Vec<u8>` in a struct went
/// over IPC as a JSON array of numbers: ~3.5 characters per byte to build and
/// parse, which stalled the webview on filmstrip sprites and frames.
const LINK_FILE_MAX_BYTES: u64 = 256 * 1024;
const LINK_FILE_EXTENSIONS: [&str; 4] = ["url", "txt", "webloc", "m3u8"];

fn is_link_file(path: &std::path::Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| LINK_FILE_EXTENSIONS.contains(&ext.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

/// Text of a file dropped onto the download window (.url shortcut, .txt list,
/// .webloc, .m3u8). Only these extensions and only small files are read, so a
/// stray video dropped on the window never gets loaded into memory.
#[tauri::command]
pub async fn read_link_file(path: String) -> Result<String, String> {
    let path = PathBuf::from(&path);
    if !is_link_file(&path) {
        return Err("Unsupported file type".into());
    }
    let meta = tokio::fs::metadata(&path)
        .await
        .map_err(|err| format!("Failed to read file: {err}"))?;
    if !meta.is_file() || meta.len() > LINK_FILE_MAX_BYTES {
        return Err("File is too large".into());
    }
    let bytes = tokio::fs::read(&path)
        .await
        .map_err(|err| format!("Failed to read file: {err}"))?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

#[tauri::command]
pub async fn read_image_file(path: String) -> Result<tauri::ipc::Response, String> {
    let bytes = tokio::fs::read(PathBuf::from(&path))
        .await
        .map_err(|err| format!("Failed to read image file: {err}"))?;
    Ok(tauri::ipc::Response::new(bytes))
}

async fn write_text_file(path: String, contents: String) -> Result<(), String> {
    let path_buf = PathBuf::from(&path);
    if let Some(parent) = path_buf.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|err| format!("Failed to prepare output directory: {err}"))?;
    }
    tokio::fs::write(&path_buf, contents)
        .await
        .map_err(|err| format!("Failed to write file: {err}"))
}

/// Фильтр диалога сохранения от фронтенда: подпись и расширения без точки.
#[derive(Debug, Clone, Deserialize)]
pub struct SaveFileFilter {
    pub name: String,
    pub extensions: Vec<String>,
}

const DEFAULT_TEXT_FILTER_NAME: &str = "Text logs";
const DEFAULT_TEXT_EXTENSIONS: [&str; 3] = ["txt", "jsonl", "log"];

/// Расширения без точки и мусора; пустой результат — фильтр по умолчанию.
fn clean_filter_extensions(extensions: &[String]) -> Vec<String> {
    extensions
        .iter()
        .map(|ext| ext.trim().trim_start_matches('.').to_ascii_lowercase())
        .filter(|ext| !ext.is_empty() && ext.chars().all(|ch| ch.is_ascii_alphanumeric()))
        .collect()
}

fn resolve_save_filter(filter: Option<SaveFileFilter>) -> (String, Vec<String>) {
    let custom = filter.and_then(|filter| {
        let extensions = clean_filter_extensions(&filter.extensions);
        let name = filter.name.trim().to_string();
        (!extensions.is_empty()).then(|| {
            let name = if name.is_empty() { extensions.join(", ") } else { name };
            (name, extensions)
        })
    });
    custom.unwrap_or_else(|| {
        (
            DEFAULT_TEXT_FILTER_NAME.to_string(),
            DEFAULT_TEXT_EXTENSIONS.iter().map(|ext| ext.to_string()).collect(),
        )
    })
}

#[tauri::command]
pub async fn save_text_file_dialog(
    app: AppHandle,
    default_name: String,
    contents: String,
    filter: Option<SaveFileFilter>,
) -> Result<Option<String>, String> {
    let (filter_name, extensions) = resolve_save_filter(filter);
    let extension_refs: Vec<&str> = extensions.iter().map(String::as_str).collect();
    let (tx, rx) = tokio::sync::oneshot::channel::<Option<String>>();
    let tx = std::sync::Mutex::new(Some(tx));
    app.dialog()
        .file()
        .set_file_name(&default_name)
        .add_filter(&filter_name, &extension_refs)
        .save_file(move |path| {
            let p = path
                .and_then(|fp| fp.into_path().ok())
                .map(|pb| pb.to_string_lossy().into_owned());
            if let Some(sender) = tx.lock().ok().and_then(|mut g| g.take()) {
                let _ = sender.send(p);
            }
        });
    let Some(path) = rx.await.ok().flatten() else {
        return Ok(None);
    };
    write_text_file(path.clone(), contents).await?;
    Ok(Some(path))
}

/// Save a captured video frame. The frontend hands over a canvas data URL
/// (`data:image/png;base64,...`), which cannot go through `write_text_file`
/// without corrupting the bytes.
#[tauri::command]
pub async fn save_image_dialog(
    app: AppHandle,
    default_name: String,
    data_url: String,
) -> Result<Option<String>, String> {
    use base64::Engine as _;

    let payload = data_url
        .split_once("base64,")
        .map(|(_, rest)| rest)
        .unwrap_or(&data_url);
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(payload.trim())
        .map_err(|err| format!("decode frame: {err}"))?;

    let (tx, rx) = tokio::sync::oneshot::channel::<Option<String>>();
    let tx = std::sync::Mutex::new(Some(tx));
    app.dialog()
        .file()
        .set_file_name(&default_name)
        .add_filter("Images", &["png", "jpg", "jpeg"])
        .save_file(move |path| {
            let p = path
                .and_then(|fp| fp.into_path().ok())
                .map(|pb| pb.to_string_lossy().into_owned());
            if let Some(sender) = tx.lock().ok().and_then(|mut g| g.take()) {
                let _ = sender.send(p);
            }
        });
    let Some(path) = rx.await.ok().flatten() else {
        return Ok(None);
    };
    tokio::fs::write(&path, bytes)
        .await
        .map_err(|err| format!("write {path}: {err}"))?;
    Ok(Some(path))
}

const MEDIA_FILE_EXTENSIONS: [&str; 10] = [
    "mp4", "mkv", "mp3", "wav", "mov", "avi", "flac", "ogg", "m4a", "webm",
];

#[tauri::command]
pub async fn choose_media_file(app: AppHandle) -> Option<String> {
    let (tx, rx) = tokio::sync::oneshot::channel::<Option<String>>();
    let tx = std::sync::Mutex::new(Some(tx));
    app.dialog()
        .file()
        .add_filter("Media Files", &MEDIA_FILE_EXTENSIONS)
        .pick_file(move |path| {
            let p = path
                .and_then(|fp| fp.into_path().ok())
                .map(|pb| pb.to_string_lossy().into_owned());
            if let Some(sender) = tx.lock().ok().and_then(|mut g| g.take()) {
                let _ = sender.send(p);
            }
        });
    rx.await.ok().flatten()
}

/// Несколько медиафайлов сразу (пакетная обработка «Удалить маты»).
/// Отмена диалога — пустой список.
#[tauri::command]
pub async fn choose_media_files(app: AppHandle) -> Vec<String> {
    let (tx, rx) = tokio::sync::oneshot::channel::<Vec<String>>();
    let tx = std::sync::Mutex::new(Some(tx));
    app.dialog()
        .file()
        .add_filter("Media Files", &MEDIA_FILE_EXTENSIONS)
        .pick_files(move |paths| {
            let picked = paths
                .unwrap_or_default()
                .into_iter()
                .filter_map(|fp| fp.into_path().ok())
                .map(|pb| pb.to_string_lossy().into_owned())
                .collect();
            if let Some(sender) = tx.lock().ok().and_then(|mut g| g.take()) {
                let _ = sender.send(picked);
            }
        });
    rx.await.unwrap_or_default()
}

/// Размеры файлов в байтах в том же порядке; `None` — файла нет или он не читается.
#[tauri::command]
pub async fn media_file_sizes(paths: Vec<String>) -> Vec<Option<u64>> {
    let mut sizes = Vec::with_capacity(paths.len());
    for path in &paths {
        let size = tokio::fs::metadata(path)
            .await
            .ok()
            .filter(|meta| meta.is_file())
            .map(|meta| meta.len());
        sizes.push(size);
    }
    sizes
}

#[tauri::command]
pub async fn choose_json_file(app: AppHandle) -> Option<String> {
    let (tx, rx) = tokio::sync::oneshot::channel::<Option<String>>();
    let tx = std::sync::Mutex::new(Some(tx));
    app.dialog()
        .file()
        .add_filter("Chat JSON Files", &["json"])
        .pick_file(move |path| {
            let p = path
                .and_then(|fp| fp.into_path().ok())
                .map(|pb| pb.to_string_lossy().into_owned());
            if let Some(sender) = tx.lock().ok().and_then(|mut g| g.take()) {
                let _ = sender.send(p);
            }
        });
    rx.await.ok().flatten()
}

/// Pick an OpenSSH private key for the VPS connection. No filter: keys usually
/// have no extension (`id_ed25519`), and providers hand out `.pem` too.
#[tauri::command]
pub async fn choose_ssh_key_file(app: AppHandle) -> Option<String> {
    let (tx, rx) = tokio::sync::oneshot::channel::<Option<String>>();
    let tx = std::sync::Mutex::new(Some(tx));
    app.dialog().file().pick_file(move |path| {
        let p = path
            .and_then(|fp| fp.into_path().ok())
            .map(|pb| pb.to_string_lossy().into_owned());
        if let Some(sender) = tx.lock().ok().and_then(|mut g| g.take()) {
            let _ = sender.send(p);
        }
    });
    rx.await.ok().flatten()
}

#[tauri::command]
pub async fn choose_cookies_file(app: AppHandle) -> Option<String> {
    let (tx, rx) = tokio::sync::oneshot::channel::<Option<String>>();
    let tx = std::sync::Mutex::new(Some(tx));
    app.dialog()
        .file()
        .add_filter("Cookies", &["txt"])
        .pick_file(move |path| {
            let p = path
                .and_then(|fp| fp.into_path().ok())
                .map(|pb| pb.to_string_lossy().into_owned());
            if let Some(sender) = tx.lock().ok().and_then(|mut g| g.take()) {
                let _ = sender.send(p);
            }
        });
    rx.await.ok().flatten()
}

#[tauri::command]
pub async fn read_chat_messages_preview(
    path: String,
) -> Result<Vec<crate::chat_overlay::model::ChatMessage>, String> {
    let path_buf = PathBuf::from(&path);
    let messages = crate::chat_overlay::model::read_chat_messages(&path_buf)
        .map_err(|err| format!("Failed to read chat JSON: {err}"))?;

    // Return a maximum of 30 messages for preview
    let preview_msgs = messages.into_iter().take(30).collect::<Vec<_>>();
    Ok(preview_msgs)
}

#[cfg(test)]
mod tests {
    use super::{is_link_file, resolve_save_filter, SaveFileFilter};

    #[test]
    fn link_file_accepts_only_text_link_extensions() {
        assert!(is_link_file(std::path::Path::new("C:/a/stream.URL")));
        assert!(is_link_file(std::path::Path::new("links.txt")));
        assert!(!is_link_file(std::path::Path::new("video.mp4")));
        assert!(!is_link_file(std::path::Path::new("noext")));
    }

    #[test]
    fn save_filter_uses_frontend_extensions_or_falls_back() {
        let (name, exts) = resolve_save_filter(None);
        assert_eq!(name, "Text logs");
        assert_eq!(exts, vec!["txt", "jsonl", "log"]);

        let srt = SaveFileFilter { name: "SRT".into(), extensions: vec![".SRT".into()] };
        assert_eq!(resolve_save_filter(Some(srt)), ("SRT".to_string(), vec!["srt".to_string()]));

        let junk = SaveFileFilter { name: "Bad".into(), extensions: vec!["*.*".into(), "".into()] };
        assert_eq!(resolve_save_filter(Some(junk)).0, "Text logs");
    }
}
