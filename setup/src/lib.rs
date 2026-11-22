//! Формат пакета установщика.
//!
//! setup.exe = заглушка (сам установщик) + payload + meta + хвост:
//!
//! ```text
//! [stub][payload: tar, сжатый zstd][meta: JSON][meta_len u64][payload_len u64][MAGIC 8 байт]
//! ```
//!
//! Хвост читается с конца файла, поэтому заглушка ничего не знает о своём
//! размере заранее. uninstall.exe — та же заглушка без пакета: хвоста нет.

use std::fs::File;
use std::io::{self, Read, Seek, SeekFrom};
use std::path::Path;

use serde::{Deserialize, Serialize};

pub const MAGIC: &[u8; 8] = b"FTCHRPK1";
const TRAILER_LEN: u64 = 8 + 8 + 8;
/// Список файлов — единицы килобайт; больше — значит хвост битый
const MAX_META_LEN: u64 = 1 << 20;
/// Окно long-distance matching: ffmpeg и ffprobe делят большую часть кода,
/// и только окно больше размера одного файла находит эти повторы.
pub const WINDOW_LOG: u32 = 28;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PackedFile {
    /// Путь внутри папки установки, через '/'
    pub path: String,
    pub size: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Meta {
    pub product: String,
    pub version: String,
    /// Главный exe приложения внутри папки установки
    pub main_binary: String,
    pub files: Vec<PackedFile>,
}

impl Meta {
    pub fn total_size(&self) -> u64 {
        self.files.iter().map(|f| f.size).sum()
    }
}

/// Где в файле лежит пакет
#[derive(Debug, Clone)]
pub struct Located {
    pub stub_len: u64,
    pub payload_offset: u64,
    pub payload_len: u64,
    pub meta: Meta,
}

/// Ищет пакет в конце файла. Ok(None) — пакета нет (это uninstall.exe).
pub fn locate(path: &Path) -> io::Result<Option<Located>> {
    let mut file = File::open(path)?;
    let len = file.metadata()?.len();
    if len < TRAILER_LEN {
        return Ok(None);
    }
    file.seek(SeekFrom::Start(len - TRAILER_LEN))?;
    let mut trailer = [0u8; TRAILER_LEN as usize];
    file.read_exact(&mut trailer)?;
    if &trailer[16..24] != MAGIC {
        return Ok(None);
    }
    let meta_len = u64::from_le_bytes(trailer[0..8].try_into().expect("8 bytes"));
    let payload_len = u64::from_le_bytes(trailer[8..16].try_into().expect("8 bytes"));
    let tail = TRAILER_LEN.checked_add(meta_len).and_then(|n| n.checked_add(payload_len));
    if meta_len > MAX_META_LEN || tail.is_none_or(|tail| tail > len) {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "installer package is truncated"));
    }
    let meta_offset = len - TRAILER_LEN - meta_len;
    file.seek(SeekFrom::Start(meta_offset))?;
    let mut raw = vec![0u8; meta_len as usize];
    file.read_exact(&mut raw)?;
    let meta: Meta = serde_json::from_slice(&raw)
        .map_err(|err| io::Error::new(io::ErrorKind::InvalidData, format!("installer meta: {err}")))?;
    let payload_offset = meta_offset - payload_len;
    Ok(Some(Located { stub_len: payload_offset, payload_offset, payload_len, meta }))
}

/// Читатель, который считает прочитанные байты
pub struct Counting<R> {
    inner: R,
    pub count: u64,
}

impl<R> Counting<R> {
    pub fn new(inner: R) -> Self {
        Self { inner, count: 0 }
    }
}

impl<R: Read> Read for Counting<R> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let n = self.inner.read(buf)?;
        self.count += n as u64;
        Ok(n)
    }
}

/// Безопасный относительный путь внутри папки установки: без "..", корня и дисков
pub fn safe_relative(path: &str) -> Option<std::path::PathBuf> {
    let mut out = std::path::PathBuf::new();
    for part in path.split(['/', '\\']) {
        match part {
            "" | "." => continue,
            ".." => return None,
            p if p.contains(':') => return None,
            p => out.push(p),
        }
    }
    if out.as_os_str().is_empty() {
        None
    } else {
        Some(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_escaping_paths() {
        assert!(safe_relative("../evil.exe").is_none());
        assert!(safe_relative("C:/Windows/evil.exe").is_none());
        assert!(safe_relative("").is_none());
        assert_eq!(safe_relative("resources/ffmpeg.exe").unwrap(), Path::new("resources").join("ffmpeg.exe"));
    }
}
