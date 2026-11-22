use std::collections::{BTreeMap, BTreeSet};

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct SystemFont {
    pub family: String,
    pub weights: Vec<u16>,
    pub styles: Vec<String>,
}

/// Async: the first call scans every installed font, which must not run on
/// the main thread.
#[tauri::command]
pub async fn list_system_fonts() -> Result<Vec<SystemFont>, String> {
    tauri::async_runtime::spawn_blocking(collect_system_fonts)
        .await
        .map_err(|err| format!("Font scan failed: {err}"))
}

fn collect_system_fonts() -> Vec<SystemFont> {
    let db = crate::system_fonts::database();

    let mut families = BTreeMap::<String, (BTreeSet<u16>, BTreeSet<String>)>::new();
    for face in db.faces() {
        for (family, _) in &face.families {
            let entry = families.entry(family.clone()).or_default();
            entry.0.insert(face.weight.0);
            entry.1.insert(font_style_name(face.style).to_string());
        }
    }

    families
        .into_iter()
        .map(|(family, (weights, styles))| SystemFont {
            family,
            weights: weights.into_iter().collect(),
            styles: styles.into_iter().collect(),
        })
        .collect()
}

fn font_style_name(style: fontdb::Style) -> &'static str {
    match style {
        fontdb::Style::Normal => "normal",
        fontdb::Style::Italic => "italic",
        fontdb::Style::Oblique => "oblique",
    }
}
