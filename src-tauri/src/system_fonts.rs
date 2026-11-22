//! Scan of the installed fonts, shared by the whole process.
//!
//! `load_system_fonts` opens and parses every font file on the machine
//! (hundreds on a typical Windows install). Doing it per request froze the
//! font picker and repeated the scan for every font a chat render loads. The
//! scan is redone only when a font folder changes (a font was installed or
//! removed while the app runs).

use std::sync::{Arc, OnceLock};
use std::time::SystemTime;

use parking_lot::Mutex;

struct Scan {
    db: Arc<fontdb::Database>,
    folders_modified: Vec<Option<SystemTime>>,
}

pub fn database() -> Arc<fontdb::Database> {
    static SCAN: OnceLock<Mutex<Option<Scan>>> = OnceLock::new();
    let folders_modified = font_folders_modified();
    let mut scan = SCAN.get_or_init(|| Mutex::new(None)).lock();
    if let Some(current) = scan.as_ref() {
        if current.folders_modified == folders_modified {
            return current.db.clone();
        }
    }
    let mut db = fontdb::Database::new();
    db.load_system_fonts();
    let db = Arc::new(db);
    *scan = Some(Scan {
        db: db.clone(),
        folders_modified,
    });
    db
}

/// Modification times of the folders fonts get installed into. Adding or
/// removing a file changes its folder's time.
fn font_folders_modified() -> Vec<Option<SystemTime>> {
    let mut folders: Vec<std::path::PathBuf> = Vec::new();
    #[cfg(target_os = "windows")]
    {
        if let Some(windows) = std::env::var_os("WINDIR") {
            folders.push(std::path::PathBuf::from(windows).join("Fonts"));
        }
        if let Some(local) = dirs::data_local_dir() {
            folders.push(local.join("Microsoft").join("Windows").join("Fonts"));
        }
    }
    folders
        .iter()
        .map(|folder| std::fs::metadata(folder).and_then(|meta| meta.modified()).ok())
        .collect()
}
