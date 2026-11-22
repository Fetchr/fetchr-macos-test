//! Собирает установщик: заглушка + tar.zst с файлами приложения + meta + хвост.
//!
//! fetchr-pack --stub fetchr-setup.exe --out Fetchr-Setup-v0.9.0.exe --version 0.9.0
//!             [--level 19] [--list setup/payload.txt] [dest=src ...]
//!
//! Первая пара dest=src — главный exe приложения.

use std::fs::{self, File};
use std::io::{self, BufWriter, Write};
use std::path::PathBuf;
use std::time::Instant;

use fetchr_setup::{safe_relative, Meta, PackedFile, MAGIC, WINDOW_LOG};

struct Args {
    stub: PathBuf,
    out: PathBuf,
    version: String,
    level: i32,
    files: Vec<(String, PathBuf)>,
}

fn parse() -> Result<Args, String> {
    let mut stub = None;
    let mut out = None;
    let mut version = None;
    let mut level = 19;
    let mut files = Vec::new();
    let mut it = std::env::args().skip(1);
    while let Some(arg) = it.next() {
        match arg.as_str() {
            "--stub" => stub = it.next().map(PathBuf::from),
            "--out" => out = it.next().map(PathBuf::from),
            "--version" => version = it.next(),
            "--level" => {
                level = it
                    .next()
                    .and_then(|v| v.parse().ok())
                    .ok_or("--level needs a number")?
            }
            "--list" => {
                let path = it.next().ok_or("--list needs a file")?;
                let text = std::fs::read_to_string(&path).map_err(|err| format!("{path}: {err}"))?;
                for line in text.lines().map(str::trim).filter(|l| !l.is_empty() && !l.starts_with('#')) {
                    files.push(parse_pair(line)?);
                }
            }
            pair => files.push(parse_pair(pair)?),
        }
    }
    Ok(Args {
        stub: stub.ok_or("--stub is required")?,
        out: out.ok_or("--out is required")?,
        version: version.ok_or("--version is required")?,
        level,
        files,
    })
}

fn parse_pair(pair: &str) -> Result<(String, PathBuf), String> {
    let (dest, src) = pair.split_once('=').ok_or_else(|| format!("expected dest=src, got {pair}"))?;
    if safe_relative(dest).is_none() {
        return Err(format!("unsafe destination path: {dest}"));
    }
    Ok((dest.replace('\\', "/"), PathBuf::from(src)))
}

fn run(args: Args) -> Result<(), String> {
    if args.files.is_empty() {
        return Err("no files to pack".into());
    }
    let started = Instant::now();
    let mut packed = Vec::new();
    for (dest, src) in &args.files {
        let size = fs::metadata(src).map_err(|err| format!("{}: {err}", src.display()))?.len();
        packed.push(PackedFile { path: dest.clone(), size });
    }
    let meta = Meta {
        product: "Fetchr".into(),
        version: args.version.clone(),
        main_binary: args.files[0].0.clone(),
        files: packed,
    };

    if let Some(parent) = args.out.parent() {
        fs::create_dir_all(parent).map_err(|err| format!("{}: {err}", parent.display()))?;
    }
    let mut out = BufWriter::with_capacity(1 << 20, File::create(&args.out).map_err(|err| format!("{}: {err}", args.out.display()))?);
    let stub = fs::read(&args.stub).map_err(|err| format!("{}: {err}", args.stub.display()))?;
    out.write_all(&stub).map_err(io_err)?;

    let threads = std::thread::available_parallelism().map(|n| n.get() as u32).unwrap_or(4);
    let mut encoder = zstd::Encoder::new(Counter::new(&mut out), args.level).map_err(io_err)?;
    encoder.multithread(threads).map_err(io_err)?;
    encoder.long_distance_matching(true).map_err(io_err)?;
    encoder.window_log(WINDOW_LOG).map_err(io_err)?;
    encoder.include_checksum(true).map_err(io_err)?;
    {
        let mut tar = tar::Builder::new(&mut encoder);
        tar.mode(tar::HeaderMode::Deterministic);
        for (dest, src) in &args.files {
            let mut file = File::open(src).map_err(|err| format!("{}: {err}", src.display()))?;
            tar.append_file(dest, &mut file).map_err(|err| format!("{dest}: {err}"))?;
            eprintln!("[pack] {dest}");
        }
        tar.finish().map_err(io_err)?;
    }
    let counter = encoder.finish().map_err(io_err)?;
    let payload_len = counter.count;

    let meta_raw = serde_json::to_vec(&meta).map_err(|err| err.to_string())?;
    out.write_all(&meta_raw).map_err(io_err)?;
    out.write_all(&(meta_raw.len() as u64).to_le_bytes()).map_err(io_err)?;
    out.write_all(&payload_len.to_le_bytes()).map_err(io_err)?;
    out.write_all(MAGIC).map_err(io_err)?;
    out.flush().map_err(io_err)?;

    let total = meta.total_size();
    eprintln!(
        "[pack] {} files, {:.1} MB -> {:.1} MB in {:.1}s",
        meta.files.len(),
        total as f64 / 1e6,
        payload_len as f64 / 1e6,
        started.elapsed().as_secs_f64()
    );
    Ok(())
}

fn io_err(err: io::Error) -> String {
    err.to_string()
}

/// Писатель, который считает записанные байты
struct Counter<W> {
    inner: W,
    count: u64,
}

impl<W> Counter<W> {
    fn new(inner: W) -> Self {
        Self { inner, count: 0 }
    }
}

impl<W: Write> Write for Counter<W> {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        let n = self.inner.write(buf)?;
        self.count += n as u64;
        Ok(n)
    }
    fn flush(&mut self) -> io::Result<()> {
        self.inner.flush()
    }
}

/// Распаковывает готовый установщик вхолостую и сверяет файлы с meta
fn verify(path: &std::path::Path) -> Result<(), String> {
    use std::io::{Read, Seek, SeekFrom};
    let pkg = fetchr_setup::locate(path).map_err(io_err)?.ok_or("no package found in the file")?;
    let mut file = File::open(path).map_err(io_err)?;
    file.seek(SeekFrom::Start(pkg.payload_offset)).map_err(io_err)?;
    let mut decoder = zstd::Decoder::new(io::BufReader::new(file.take(pkg.payload_len))).map_err(io_err)?;
    decoder.window_log_max(WINDOW_LOG).map_err(io_err)?;
    let mut archive = tar::Archive::new(decoder);
    let mut seen = Vec::new();
    for entry in archive.entries().map_err(io_err)? {
        let mut entry = entry.map_err(io_err)?;
        let name = entry.path().map_err(io_err)?.to_string_lossy().replace('\\', "/");
        let size = io::copy(&mut entry, &mut io::sink()).map_err(io_err)?;
        seen.push(PackedFile { path: name, size });
    }
    let expected: Vec<(String, u64)> = pkg.meta.files.iter().map(|f| (f.path.clone(), f.size)).collect();
    let actual: Vec<(String, u64)> = seen.into_iter().map(|f| (f.path, f.size)).collect();
    if expected != actual {
        return Err(format!("package mismatch: expected {expected:?}, got {actual:?}"));
    }
    eprintln!("[pack] verified {} files, stub {} bytes", actual.len(), pkg.stub_len);
    Ok(())
}

fn main() {
    let argv: Vec<String> = std::env::args().collect();
    if argv.len() == 3 && argv[1] == "--verify" {
        if let Err(err) = verify(std::path::Path::new(&argv[2])) {
            eprintln!("[pack] error: {err}");
            std::process::exit(1);
        }
        return;
    }
    let result = parse().and_then(|args| {
        let out = args.out.clone();
        run(args)?;
        verify(&out)
    });
    match result {
        Ok(()) => {}
        Err(err) => {
            eprintln!("[pack] error: {err}");
            std::process::exit(1);
        }
    }
}
