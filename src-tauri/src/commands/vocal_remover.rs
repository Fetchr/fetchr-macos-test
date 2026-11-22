use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use tauri::State;

use crate::jobs::types::VocalRemoverSettings;
use crate::jobs::vocal_remover::{HistoryItem, VocalRemoverResult};
use crate::AppState;

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
pub async fn run_vocal_remover_in_page(
    state: State<'_, AppState>,
    task_id: String,
    input_path: String,
    binaries_dir: Option<String>,
    settings: VocalRemoverSettings,
) -> Result<VocalRemoverResult, String> {
    let cancel_flag = Arc::new(AtomicBool::new(false));
    state
        .in_page_cancels
        .lock()
        .insert(task_id.clone(), cancel_flag.clone());

    let _cleanup = CleanupCancel {
        cancels: state.in_page_cancels.clone(),
        task_id: task_id.clone(),
    };

    let bin_dir = binaries_dir.as_deref().map(Path::new);
    let ffmpeg = crate::binaries::resolve_binary(crate::binaries::FFMPEG, bin_dir)
        .ok_or_else(|| "ffmpeg.exe not found - set binaries folder in Settings".to_string())?;
    let job_id = format!("vocal_remover_in_page_{task_id}");

    crate::jobs::vocal_remover::run_on_local_file(
        &state.queue,
        &job_id,
        Path::new(&input_path),
        &ffmpeg,
        settings,
        cancel_flag,
    )
    .await
    .map_err(|err| err.to_string())
}

#[tauri::command]
pub fn cancel_vocal_remover_in_page(state: State<'_, AppState>, task_id: String) {
    if let Some(flag) = state.in_page_cancels.lock().get(&task_id) {
        flag.store(true, Ordering::SeqCst);
    }
}

#[tauri::command]
pub async fn get_vocal_remover_history() -> Result<Vec<HistoryItem>, String> {
    crate::jobs::vocal_remover::load_history().map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn delete_vocal_remover_history_item(id: String) -> Result<(), String> {
    crate::jobs::vocal_remover::delete_history_item(&id).map_err(|err| err.to_string())
}

/// Обложка и сведения об опознанном треке для списка найденной музыки.
#[derive(serde::Serialize)]
pub struct TrackArtwork {
    pub title: String,
    pub artist: String,
    pub album: Option<String>,
    pub year: Option<String>,
    pub artwork_url: Option<String>,
}

/// Ищет трек по названию и возвращает обложку, исполнителя и альбом.
/// Название из распознавания бывает склеено из нескольких треков
/// («A - X · A - Y») — берётся первый. Сначала каталог iTunes, при
/// неудаче Deezer; оба без ключа. Ничего не нашлось — `None`.
#[tauri::command]
pub async fn lookup_track_artwork(query: String) -> Result<Option<TrackArtwork>, String> {
    let first = query.split(" · ").next().unwrap_or("").trim().to_string();
    if first.is_empty() {
        return Ok(None);
    }
    let (artist, title) = match first.split_once(" - ") {
        Some((artist, title)) => (artist.trim().to_string(), title.trim().to_string()),
        None => (String::new(), first.clone()),
    };
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(8))
        .user_agent("Fetchr")
        .build()
        .map_err(|e| e.to_string())?;

    // Каталоги ищут по-разному: где-то находится только название, где-то
    // исполнитель и первое слово. Пробуем несколько запросов и принимаем
    // только результат того же исполнителя, чтобы не показать чужую обложку.
    let full = if artist.is_empty() { title.clone() } else { format!("{artist} {title}") };
    let short = title.split_whitespace().next().unwrap_or("").to_string();
    let mut terms = vec![full.clone(), title.clone()];
    if !artist.is_empty() && !short.is_empty() {
        terms.push(format!("{artist} {short}"));
    }
    let matches = |found: &TrackArtwork| {
        artist.is_empty() || found.artist.to_lowercase().contains(&artist.to_lowercase())
    };
    for term in &terms {
        if let Some(found) = itunes_lookup(&client, term).await.filter(|f| matches(f)) {
            return Ok(Some(found));
        }
        if let Some(found) = deezer_lookup(&client, term).await.filter(|f| matches(f)) {
            return Ok(Some(found));
        }
    }
    Ok(None)
}

async fn itunes_lookup(client: &reqwest::Client, term: &str) -> Option<TrackArtwork> {
    let body: serde_json::Value = client
        .get("https://itunes.apple.com/search")
        .query(&[("term", term), ("entity", "song"), ("limit", "1")])
        .send()
        .await
        .ok()?
        .json()
        .await
        .ok()?;
    let item = body.get("results")?.as_array()?.first()?;
    let text = |key: &str| item.get(key).and_then(|v| v.as_str()).map(str::to_string);
    Some(TrackArtwork {
        title: text("trackName")?,
        artist: text("artistName").unwrap_or_default(),
        album: text("collectionName"),
        year: text("releaseDate").map(|date| date.chars().take(4).collect()),
        // Каталог отдаёт 100×100; тот же адрес с другим размером даёт крупную обложку.
        artwork_url: text("artworkUrl100").map(|url| url.replace("100x100bb", "600x600bb")),
    })
}

async fn deezer_lookup(client: &reqwest::Client, term: &str) -> Option<TrackArtwork> {
    let body: serde_json::Value = client
        .get("https://api.deezer.com/search")
        .query(&[("q", term), ("limit", "1")])
        .send()
        .await
        .ok()?
        .json()
        .await
        .ok()?;
    let item = body.get("data")?.as_array()?.first()?;
    let text = |value: Option<&serde_json::Value>| value.and_then(|v| v.as_str()).map(str::to_string);
    let album = item.get("album");
    Some(TrackArtwork {
        title: text(item.get("title"))?,
        artist: text(item.get("artist").and_then(|a| a.get("name"))).unwrap_or_default(),
        album: text(album.and_then(|a| a.get("title"))),
        year: None,
        artwork_url: text(album.and_then(|a| a.get("cover_xl")))
            .or_else(|| text(album.and_then(|a| a.get("cover_big")))),
    })
}
