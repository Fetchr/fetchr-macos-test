//! Скачивание моделей: докачка, переключение на зеркало и защита от зависаний.
//!
//! Hugging Face часто недоступен или обрезан по скорости. Раньше из-за этого
//! установка либо падала, либо молча висела. Здесь каждый источник получает
//! ограничение на простой, а содержимое с любого источника сверяется с SHA-256:
//! зеркалу не приходится доверять.

use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use anyhow::{anyhow, bail, Context, Result};
use reqwest::header::{CONTENT_RANGE, RANGE};
use reqwest::StatusCode;
use sha2::{Digest, Sha256};
use tokio::io::AsyncWriteExt;

const HF_HOST: &str = "https://huggingface.co/";
const HF_MIRROR_HOST: &str = "https://hf-mirror.com/";
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const STALL_TIMEOUT: Duration = Duration::from_secs(30);
const CANCEL_POLL: Duration = Duration::from_millis(250);
const PROGRESS_INTERVAL: Duration = Duration::from_millis(500);
/// Обрыв на большом файле — обычное дело, поэтому источники проходятся дважды.
const SOURCE_ROUNDS: usize = 2;

pub const CANCELLED: &str = "Download cancelled";

pub struct DownloadRequest<'a> {
    pub urls: Vec<String>,
    pub target: &'a Path,
    pub size: u64,
    pub sha256: &'a str,
    pub label: &'a str,
}

pub fn hf_url(repo: &str, revision: &str, file: &str) -> String {
    format!("{HF_HOST}{repo}/resolve/{revision}/{file}")
}

/// Исходный адрес и, для Hugging Face, его копия на зеркале.
pub fn with_mirror(url: &str) -> Vec<String> {
    let mut urls = vec![url.to_string()];
    if let Some(path) = url.strip_prefix(HF_HOST) {
        urls.push(format!("{HF_MIRROR_HOST}{path}"));
    }
    urls
}

pub fn client(user_agent: &str) -> Result<reqwest::Client> {
    reqwest::Client::builder()
        .user_agent(user_agent)
        .connect_timeout(CONNECT_TIMEOUT)
        .build()
        .context("create download client")
}

/// Ждёт `future`, пока не сработает отмена или не истечёт `limit`.
pub async fn until_stalled<F: Future>(
    future: F,
    limit: Duration,
    cancel: &AtomicBool,
) -> Result<F::Output> {
    tokio::pin!(future);
    let started = Instant::now();
    loop {
        tokio::select! {
            output = &mut future => return Ok(output),
            _ = tokio::time::sleep(CANCEL_POLL) => {
                if cancel.load(Ordering::SeqCst) {
                    bail!(CANCELLED);
                }
                if started.elapsed() >= limit {
                    bail!("нет ответа {} с", limit.as_secs());
                }
            }
        }
    }
}

pub async fn download(
    request: DownloadRequest<'_>,
    cancel: &AtomicBool,
    on_progress: &mut (dyn FnMut(u64, u64) + Send),
) -> Result<()> {
    if let Some(parent) = request.target.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .with_context(|| format!("create {}", parent.display()))?;
    }
    let part = part_path(request.target);
    let client = client("Fetchr Model Downloader")?;
    let mut failures = Vec::new();

    for _ in 0..SOURCE_ROUNDS {
        for url in &request.urls {
            let attempt = fetch(&client, url, &part, request.size, cancel, on_progress).await;
            let outcome = match attempt {
                Ok(()) => verify(&part, request.sha256).await,
                Err(error) => Err(error),
            };
            match outcome {
                Ok(()) => return install(&part, request.target).await,
                Err(error) if is_cancelled(&error) => return Err(error),
                Err(error) => failures.push(format!("{}: {error:#}", host(url))),
            }
        }
    }
    Err(anyhow!(
        "Не удалось скачать {}. Проверьте интернет или VPN. {}",
        request.label,
        failures.join("; ")
    ))
}

pub fn is_cancelled(error: &anyhow::Error) -> bool {
    error.chain().any(|cause| cause.to_string() == CANCELLED)
}

fn part_path(target: &Path) -> PathBuf {
    let mut name = target.as_os_str().to_os_string();
    name.push(".part");
    PathBuf::from(name)
}

fn host(url: &str) -> &str {
    url.split("://")
        .nth(1)
        .and_then(|rest| rest.split('/').next())
        .unwrap_or(url)
}

async fn fetch(
    client: &reqwest::Client,
    url: &str,
    part: &Path,
    size: u64,
    cancel: &AtomicBool,
    on_progress: &mut (dyn FnMut(u64, u64) + Send),
) -> Result<()> {
    let existing = tokio::fs::metadata(part).await.map(|m| m.len()).unwrap_or(0);
    if existing == size {
        return Ok(());
    }
    // Часть длиннее файла докачать нельзя: она точно от чего-то другого.
    let offset = if existing > size { 0 } else { existing };
    if existing > size {
        tokio::fs::remove_file(part).await?;
    }

    let mut builder = client.get(url);
    if offset > 0 {
        builder = builder.header(RANGE, format!("bytes={offset}-"));
    }
    let mut response = until_stalled(builder.send(), STALL_TIMEOUT, cancel)
        .await?
        .context("запрос не прошёл")?;

    if response.status() == StatusCode::RANGE_NOT_SATISFIABLE {
        tokio::fs::remove_file(part).await?;
        bail!("сервер отклонил докачку");
    }
    let response_ref = response.error_for_status_ref().context("ошибка сервера")?;
    let resumed = offset > 0 && resume_matches(response_ref, offset);

    let mut file = if resumed {
        tokio::fs::OpenOptions::new().append(true).open(part).await?
    } else {
        tokio::fs::File::create(part).await?
    };
    let mut downloaded = if resumed { offset } else { 0 };
    let mut last_report = Instant::now() - PROGRESS_INTERVAL;

    while let Some(chunk) = until_stalled(response.chunk(), STALL_TIMEOUT, cancel)
        .await?
        .context("соединение оборвалось")?
    {
        file.write_all(&chunk).await?;
        downloaded += chunk.len() as u64;
        if downloaded > size {
            drop(file);
            tokio::fs::remove_file(part).await?;
            bail!("файл больше ожидаемого");
        }
        if last_report.elapsed() >= PROGRESS_INTERVAL {
            on_progress(downloaded, size);
            last_report = Instant::now();
        }
    }
    file.flush().await?;
    on_progress(downloaded, size);
    if downloaded != size {
        bail!("получено {downloaded} из {size} байт");
    }
    Ok(())
}

fn resume_matches(response: &reqwest::Response, offset: u64) -> bool {
    response.status() == StatusCode::PARTIAL_CONTENT
        && response
            .headers()
            .get(CONTENT_RANGE)
            .and_then(|value| value.to_str().ok())
            .is_some_and(|value| value.starts_with(&format!("bytes {offset}-")))
}

async fn verify(part: &Path, expected: &str) -> Result<()> {
    let path = part.to_path_buf();
    let actual = tokio::task::spawn_blocking(move || sha256_of(&path))
        .await
        .context("hash worker panicked")??;
    if actual.eq_ignore_ascii_case(expected) {
        return Ok(());
    }
    tokio::fs::remove_file(part).await?;
    bail!("контрольная сумма не совпала")
}

fn sha256_of(path: &Path) -> Result<String> {
    let mut file =
        std::fs::File::open(path).with_context(|| format!("open {}", path.display()))?;
    let mut hasher = Sha256::new();
    std::io::copy(&mut file, &mut hasher)?;
    Ok(hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
}

async fn install(part: &Path, target: &Path) -> Result<()> {
    let _ = tokio::fs::remove_file(target).await;
    tokio::fs::rename(part, target)
        .await
        .with_context(|| format!("move model file to {}", target.display()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::AsyncReadExt;
    use tokio::net::TcpListener;

    const BODY: &[u8] = b"fetchr model payload";

    fn sha(body: &[u8]) -> String {
        Sha256::digest(body)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect()
    }

    /// Минимальный HTTP-сервер: отдаёт `body`, понимает `Range`.
    async fn serve(body: Vec<u8>) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move {
            while let Ok((mut socket, _)) = listener.accept().await {
                let body = body.clone();
                tokio::spawn(async move {
                    let mut buffer = [0u8; 2048];
                    let read = socket.read(&mut buffer).await.unwrap_or(0);
                    let head = String::from_utf8_lossy(&buffer[..read]).to_lowercase();
                    let start = head
                        .split("range: bytes=")
                        .nth(1)
                        .and_then(|rest| rest.split('-').next())
                        .and_then(|value| value.parse::<usize>().ok());
                    let response = match start {
                        Some(start) => format!(
                            "HTTP/1.1 206 Partial Content\r\nContent-Range: bytes {start}-{}/{}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                            body.len() - 1,
                            body.len(),
                            body.len() - start
                        ),
                        None => format!(
                            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                            body.len()
                        ),
                    };
                    let _ = socket.write_all(response.as_bytes()).await;
                    let _ = socket.write_all(&body[start.unwrap_or(0)..]).await;
                });
            }
        });
        format!("http://{address}/model")
    }

    fn temp_target() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("fetchr-dl-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir.join("model.onnx")
    }

    async fn run(urls: Vec<String>, target: &Path, sha256: &str) -> Result<()> {
        download(
            DownloadRequest {
                urls,
                target,
                size: BODY.len() as u64,
                sha256,
                label: "test",
            },
            &AtomicBool::new(false),
            &mut |_, _| {},
        )
        .await
    }

    #[test]
    fn mirror_is_added_only_for_hugging_face() {
        let urls = with_mirror(&hf_url("a/b", "main", "c.onnx"));
        assert_eq!(urls[1], "https://hf-mirror.com/a/b/resolve/main/c.onnx");
        assert_eq!(with_mirror("https://example.com/x").len(), 1);
    }

    #[tokio::test]
    async fn dead_source_falls_through_to_the_next() {
        let target = temp_target();
        let good = serve(BODY.to_vec()).await;
        run(
            vec!["http://127.0.0.1:1/model".to_string(), good],
            &target,
            &sha(BODY),
        )
        .await
        .unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), BODY);
    }

    #[tokio::test]
    async fn partial_file_is_resumed() {
        let target = temp_target();
        std::fs::write(part_path(&target), &BODY[..6]).unwrap();
        let url = serve(BODY.to_vec()).await;
        run(vec![url], &target, &sha(BODY)).await.unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), BODY);
        assert!(!part_path(&target).exists());
    }

    #[tokio::test]
    async fn tampered_source_is_rejected_and_next_one_used() {
        let target = temp_target();
        let tampered = serve(b"evil model payload!!".to_vec()).await;
        let good = serve(BODY.to_vec()).await;
        run(vec![tampered, good], &target, &sha(BODY)).await.unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), BODY);
    }

    #[tokio::test]
    async fn tampered_only_source_leaves_no_model() {
        let target = temp_target();
        let tampered = serve(b"evil model payload!!".to_vec()).await;
        assert!(run(vec![tampered], &target, &sha(BODY)).await.is_err());
        assert!(!target.exists());
    }

    #[tokio::test]
    async fn cancel_stops_a_stalled_wait() {
        let cancel = AtomicBool::new(true);
        let error = until_stalled(std::future::pending::<()>(), STALL_TIMEOUT, &cancel)
            .await
            .unwrap_err();
        assert!(is_cancelled(&error));
    }
}
