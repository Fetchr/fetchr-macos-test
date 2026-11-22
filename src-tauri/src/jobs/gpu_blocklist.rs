//! Remembers models whose accelerated ONNX session failed to initialise on
//! this machine, so later runs go straight to CPU instead of paying for a
//! doomed GPU attempt (and reporting the same warning) every time. The mark
//! expires, because a driver update can fix the GPU path.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

const MARK_TTL: Duration = Duration::from_secs(14 * 24 * 60 * 60);

fn mark_path(root: &Path, model_path: &Path) -> Option<PathBuf> {
    let name = model_path.file_name()?.to_string_lossy();
    Some(root.join("gpu-blocklist").join(format!("{name}.txt")))
}

/// True when the GPU session for this model failed here recently.
pub fn is_blocked(root: &Path, model_path: &Path) -> bool {
    is_blocked_at(root, model_path, SystemTime::now())
}

fn is_blocked_at(root: &Path, model_path: &Path, now: SystemTime) -> bool {
    let Some(path) = mark_path(root, model_path) else {
        return false;
    };
    std::fs::metadata(&path)
        .and_then(|meta| meta.modified())
        .ok()
        .and_then(|marked| now.duration_since(marked).ok())
        .is_some_and(|age| age < MARK_TTL)
}

/// Records the failure. Best effort: a read-only data dir only costs a retry.
pub fn block(root: &Path, model_path: &Path, reason: &str) {
    let Some(path) = mark_path(root, model_path) else {
        return;
    };
    let written = path
        .parent()
        .map_or(Ok(()), std::fs::create_dir_all)
        .and_then(|()| std::fs::write(&path, reason));
    if let Err(err) = written {
        tracing::debug!("could not remember GPU failure at {}: {err}", path.display());
    }
}

/// ONNX Runtime decodes Windows error text (ANSI code page) as UTF-8, so a
/// localised message arrives as a run of U+FFFD. Those bytes are already
/// gone; drop the noise and keep the HRESULT, which is what identifies it.
pub fn clean_ort_message(message: &str) -> String {
    let mut out = String::with_capacity(message.len());
    for word in message.split(' ') {
        if word.is_empty() || word.chars().all(|ch| ch == '\u{FFFD}' || ch.is_ascii_punctuation()) {
            continue;
        }
        if !out.is_empty() {
            out.push(' ');
        }
        out.push_str(word);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_fresh_mark_blocks_and_an_old_one_expires() {
        let root = std::env::temp_dir().join(format!("fetchr-gpu-blocklist-{}", std::process::id()));
        let model = Path::new("C:/models/htdemucs.onnx");
        assert!(!is_blocked(&root, model));

        block(&root, model, "80070057");
        assert!(is_blocked(&root, model));
        assert!(!is_blocked(&root, Path::new("C:/models/other.onnx")));
        assert!(!is_blocked_at(&root, model, SystemTime::now() + MARK_TTL + Duration::from_secs(1)));

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn garbled_windows_text_is_dropped() {
        let raw = "Exception(3) tid(4484) 80070057 \u{FFFD}\u{FFFD}\u{FFFD} \u{FFFD}\u{FFFD}\u{FFFD}\u{FFFD}.";
        assert_eq!(clean_ort_message(raw), "Exception(3) tid(4484) 80070057");
        assert_eq!(clean_ort_message("The parameter is incorrect."), "The parameter is incorrect.");
    }
}
