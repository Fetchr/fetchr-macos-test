use std::collections::HashMap;
#[cfg(target_os = "windows")]
use std::path::PathBuf;
#[cfg(target_os = "windows")]
use std::process::Command;
use std::time::Duration;

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use serde::{Deserialize, Serialize};

mod download;

#[cfg(target_os = "windows")]
use download::{InstallGuard, UpdatePhase, UpdateProgress, UPDATE_CANCELLED};

/// Domain separator for the update-manifest signature, so a signature produced
/// for one purpose can never be replayed as another.
const UPDATE_SIGNATURE_CONTEXT: &str = "fetchr-update-v1";

/// How long the splash shows the install step before this process leaves.
#[cfg(target_os = "windows")]
const INSTALL_BEAT: Duration = Duration::from_millis(1200);

/// Страница окна «Что нового»: категория, заголовок, пункты и картинка
/// или GIF сверху. Только для показа: на то, что устанавливается, не влияет,
/// поэтому в подпись манифеста не входит.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdatePage {
    #[serde(default)]
    pub category: Option<String>,
    pub title: String,
    #[serde(default)]
    pub items: Vec<String>,
    /// https-адрес картинки, GIF или короткого видео (mp4/webm).
    #[serde(default)]
    pub media: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct UpdateStatus {
    pub configured: bool,
    pub available: bool,
    /// `install_update` would accept this manifest on this platform. The
    /// launch splash installs on its own only when this is set.
    pub installable: bool,
    pub current_version: String,
    pub version: Option<String>,
    pub notes: Option<String>,
    pub notes_i18n: Option<HashMap<String, String>>,
    pub pages_i18n: Option<HashMap<String, Vec<UpdatePage>>>,
    pub installer_url: Option<String>,
    pub installer_sha256: Option<String>,
    pub size_bytes: Option<u64>,
    pub published_at: Option<String>,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct RemoteUpdate {
    #[serde(default)]
    available: Option<bool>,
    #[serde(default)]
    version: Option<String>,
    #[serde(default)]
    notes: Option<String>,
    #[serde(default)]
    notes_i18n: Option<HashMap<String, String>>,
    #[serde(default)]
    pages_i18n: Option<HashMap<String, Vec<UpdatePage>>>,
    #[serde(default)]
    installer_url: Option<String>,
    #[serde(default)]
    installer_sha256: Option<String>,
    #[serde(default)]
    sha256: Option<String>,
    #[serde(default)]
    size_bytes: Option<u64>,
    #[serde(default)]
    published_at: Option<String>,
    #[serde(default)]
    signature: Option<String>,
}

/// Public half of the release signing key, baked in at build time. The private
/// half never touches the update server, so taking over the server is not
/// enough to push an installer: without a matching signature the client refuses.
fn update_public_key() -> Option<&'static str> {
    option_env!("FETCHR_UPDATE_PUBKEY")
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

/// Exact bytes the signature covers. Only the fields that decide *what gets
/// executed* are included — notes, size and timestamps are cosmetic and stay
/// unsigned. Keep this in sync with `signedPayload()` in
/// `scripts/write-latest-update-manifest.mjs`.
fn signed_payload(version: &str, installer_url: &str, installer_sha256: &str) -> String {
    format!(
        "{UPDATE_SIGNATURE_CONTEXT}\n{}\n{}\n{}\n{}",
        crate::remote::APP_CHANNEL,
        version.trim(),
        installer_url.trim(),
        installer_sha256.trim().to_ascii_lowercase(),
    )
}

/// Fail-closed: any missing key, missing signature or mismatch is an error.
/// A build without `FETCHR_UPDATE_PUBKEY` can never install an update.
fn verify_manifest_signature(remote: &RemoteUpdate) -> Result<(), String> {
    let Some(public_key_base64) = update_public_key() else {
        return Err(
            "This build has no update signing key (FETCHR_UPDATE_PUBKEY was not set at build \
             time), so update manifests cannot be trusted."
                .to_string(),
        );
    };

    let field = |value: Option<&String>| {
        value
            .map(|text| text.trim())
            .filter(|text| !text.is_empty())
            .map(ToOwned::to_owned)
    };
    let signature_part = field(remote.signature.as_ref())
        .ok_or_else(|| "Update manifest is not signed.".to_string())?;
    let version =
        field(remote.version.as_ref()).ok_or_else(|| "Update manifest has no version.".to_string())?;
    let installer_url = field(remote.installer_url.as_ref())
        .ok_or_else(|| "Update manifest has no installer URL.".to_string())?;
    let installer_sha256 = field(remote.installer_sha256.as_ref())
        .or_else(|| field(remote.sha256.as_ref()))
        .ok_or_else(|| "Update manifest has no installer checksum.".to_string())?;

    let public_key_bytes = base64::engine::general_purpose::STANDARD
        .decode(public_key_base64)
        .map_err(|_| "Embedded update public key is not valid base64.".to_string())?;
    let public_key_array: [u8; 32] = public_key_bytes
        .try_into()
        .map_err(|_| "Embedded update public key has invalid length.".to_string())?;
    let verifying_key = VerifyingKey::from_bytes(&public_key_array)
        .map_err(|_| "Embedded update public key cannot be loaded.".to_string())?;

    let signature_bytes = URL_SAFE_NO_PAD
        .decode(&signature_part)
        .map_err(|_| "Update manifest signature is not valid base64url.".to_string())?;
    let signature = Signature::from_slice(&signature_bytes)
        .map_err(|_| "Update manifest signature has invalid length.".to_string())?;

    verifying_key
        .verify(
            signed_payload(&version, &installer_url, &installer_sha256).as_bytes(),
            &signature,
        )
        .map_err(|_| "Update manifest signature does not match.".to_string())
}

/// Картинки страниц грузятся только по https: манифест не подписывает их,
/// и адрес вида file:// или http:// показывать незачем.
fn sanitize_pages(pages: HashMap<String, Vec<UpdatePage>>) -> HashMap<String, Vec<UpdatePage>> {
    pages
        .into_iter()
        .map(|(lang, list)| {
            let list = list
                .into_iter()
                .take(12)
                .map(|page| UpdatePage {
                    media: page.media.filter(|url| url.starts_with("https://")),
                    ..page
                })
                .collect();
            (lang, list)
        })
        .collect()
}

#[tauri::command]
pub async fn check_for_update() -> Result<UpdateStatus, String> {
    let current_version = crate::remote::app_version();
    let Some(base) = crate::remote::api_base_url() else {
        return Ok(UpdateStatus {
            configured: false,
            available: false,
            installable: false,
            current_version,
            version: None,
            notes: None,
            notes_i18n: None,
            pages_i18n: None,
            installer_url: None,
            installer_sha256: None,
            size_bytes: None,
            published_at: None,
            message: Some(
                "Update server is not configured. Set FETCHR_VPS_API_URL during build.".to_string(),
            ),
        });
    };

    let remote = request_latest_update(&base, &current_version).await?;

    // An unsigned or badly signed manifest is reported as "no update", never as
    // an offer the user could accept: the installer URL and checksum it carries
    // are exactly what an attacker would control.
    if let Err(reason) = verify_manifest_signature(&remote) {
        return Ok(UpdateStatus {
            configured: true,
            available: false,
            installable: false,
            current_version,
            version: None,
            notes: None,
            notes_i18n: None,
            pages_i18n: None,
            installer_url: None,
            installer_sha256: None,
            size_bytes: None,
            published_at: None,
            message: Some(reason),
        });
    }

    let version = remote.version.clone();
    let installer_url = remote.installer_url.clone();
    let available = remote.available.unwrap_or_else(|| {
        version
            .as_deref()
            .map(|next| version_is_newer(next, &current_version))
            .unwrap_or(false)
    }) && installer_url
        .as_deref()
        .map(|value| !value.trim().is_empty())
        .unwrap_or(false);

    let installable = cfg!(target_os = "windows")
        && available
        && install_plan(&remote, &current_version).is_ok();

    Ok(UpdateStatus {
        configured: true,
        available,
        installable,
        current_version,
        version,
        notes: remote.notes,
        notes_i18n: remote.notes_i18n,
        pages_i18n: remote.pages_i18n.map(sanitize_pages),
        installer_url,
        installer_sha256: remote.installer_sha256.or(remote.sha256),
        size_bytes: remote.size_bytes,
        published_at: remote.published_at,
        message: if available {
            Some("Update is available.".to_string())
        } else {
            Some("Current version is up to date.".to_string())
        },
    })
}

/// Stops install attempt `attempt` before the installer is launched. Works
/// even when the attempt has not reached the backend yet.
#[tauri::command]
pub fn cancel_update(attempt: u64) {
    download::request_cancel(attempt);
}

/// What `install_update` runs, checked the same way for the "installable" flag
/// in `check_for_update`, so the launch splash never starts an install that
/// the backend would refuse.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
struct InstallPlan<'a> {
    version: &'a str,
    url: url::Url,
    sha256: &'a str,
}

fn install_plan<'a>(remote: &'a RemoteUpdate, current_version: &str) -> Result<InstallPlan<'a>, String> {
    let version = remote
        .version
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "Update server did not provide a version.".to_string())?;
    if !version_is_newer(version, current_version) || remote.available == Some(false) {
        return Err("No newer update is available.".to_string());
    }

    let installer_url = remote
        .installer_url
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "Update server did not provide an installer URL.".to_string())?;
    let sha256 = remote
        .installer_sha256
        .as_deref()
        .or(remote.sha256.as_deref())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "Update server did not provide an installer checksum.".to_string())?;
    if sha256.len() != 64 || !sha256.chars().all(|character| character.is_ascii_hexdigit()) {
        return Err("Update server provided an invalid SHA-256 checksum.".to_string());
    }

    let url =
        url::Url::parse(installer_url).map_err(|err| format!("Installer URL is invalid: {err}"))?;
    if url.scheme() != "https" {
        return Err("Installer URL must use https.".to_string());
    }
    if !url.path().to_ascii_lowercase().ends_with(".exe") {
        return Err("Windows updater must be an EXE installer.".to_string());
    }

    Ok(InstallPlan {
        version,
        url,
        sha256,
    })
}

#[cfg(target_os = "windows")]
const ACTIVE_WORK_ERROR: &str =
    "Finish or cancel active downloads and processing before installing an update.";

#[cfg(target_os = "windows")]
fn has_active_work(state: &crate::AppState) -> bool {
    state
        .queue
        .list()
        .iter()
        .any(|job| job.status == crate::jobs::types::JobStatus::Running)
        || !state.in_page_cancels.lock().is_empty()
}

#[cfg(target_os = "windows")]
#[tauri::command]
pub async fn install_update(
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::AppState>,
    attempt: u64,
) -> Result<(), String> {
    let guard = InstallGuard::acquire(attempt)?;
    if has_active_work(&state) {
        return Err(ACTIVE_WORK_ERROR.to_string());
    }

    let current_version = crate::remote::app_version();
    let base = crate::remote::api_base_url()
        .ok_or_else(|| "Update server is not configured in this build.".to_string())?;
    let remote =
        download::unless_cancelled(&guard, request_latest_update(&base, &current_version)).await?;
    verify_manifest_signature(&remote)?;
    let plan = install_plan(&remote, &current_version)?;

    let dir = std::env::temp_dir().join("Fetchr Updates");
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|err| format!("Could not create update directory: {err}"))?;
    let path = installer_path(&dir, plan.version);
    let partial = path.with_extension("exe.part");

    let fetched =
        download::fetch_installer(&app, &guard, plan.url, remote.size_bytes, &partial).await;
    let (actual, received) = match fetched {
        Ok(fetched) => fetched,
        Err(err) => {
            let _ = tokio::fs::remove_file(&partial).await;
            return Err(err);
        }
    };

    download::emit(&app, UpdateProgress::finished(UpdatePhase::Verify, received));
    if !actual.eq_ignore_ascii_case(plan.sha256) {
        let _ = tokio::fs::remove_file(&partial).await;
        return Err(format!(
            "Installer checksum mismatch: expected {}, got {actual}",
            plan.sha256
        ));
    }
    if let Err(err) = tokio::fs::rename(&partial, &path).await {
        let _ = tokio::fs::remove_file(&partial).await;
        return Err(format!("Could not save installer: {err}"));
    }

    download::emit(&app, UpdateProgress::finished(UpdatePhase::Install, received));
    tokio::time::sleep(INSTALL_BEAT).await;
    if guard.cancelled() {
        let _ = tokio::fs::remove_file(&path).await;
        return Err(UPDATE_CANCELLED.to_string());
    }
    // The download can take minutes: a queued job or a scheduled recording may
    // have started meanwhile, and leaving now would kill it.
    if has_active_work(&state) {
        return Err(ACTIVE_WORK_ERROR.to_string());
    }

    // process::exit below skips RunEvent::Exit, so flush the error log here.
    // Its cleanup is skipped on purpose: it deletes "Fetchr Updates".
    let _ = tokio::task::spawn_blocking(crate::error_reports::persist_before_exit).await;

    // Silent NSIS run: the launch splash already showed the progress, so no
    // installer window. /UPDATE installs in place, /R starts the new build.
    Command::new(&path)
        .args(["/S", "/R", "/UPDATE"])
        .spawn()
        .map_err(|err| format!("Could not launch installer: {err}"))?;

    // Leave at once: the installer's pre-install hook runs `taskkill /T` on
    // fetchr.exe, which would also kill the installer while it is our child.
    std::process::exit(0);
}

#[cfg(not(target_os = "windows"))]
#[tauri::command]
pub async fn install_update(attempt: u64) -> Result<(), String> {
    let _ = attempt;
    Err("Automatic update installation is currently supported only on Windows.".to_string())
}

async fn request_latest_update(base: &str, current_version: &str) -> Result<RemoteUpdate, String> {
    let url = format!(
        "{base}/updates/latest?platform={}&channel={}&current_version={}",
        std::env::consts::OS,
        crate::remote::APP_CHANNEL,
        current_version
    );
    // Recovery updates must remain reachable after a server certificate or key
    // changes. The manifest signature authenticates the version, URL and hash.
    let client = reqwest::Client::builder()
        .https_only(true)
        .timeout(Duration::from_secs(12))
        .build()
        .map_err(|err| format!("Could not create update client: {err}"))?;
    let response = client
        .get(url)
        .send()
        .await
        .map_err(|err| format!("Could not check update server: {err}"))?;
    response
        .error_for_status()
        .map_err(|err| format!("Update server returned an error: {err}"))?
        .json::<RemoteUpdate>()
        .await
        .map_err(|err| format!("Could not parse update response: {err}"))
}

#[cfg(target_os = "windows")]
fn installer_path(dir: &std::path::Path, version: &str) -> PathBuf {
    let version = version
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '-' | '_') {
                ch
            } else {
                '_'
            }
        })
        .collect::<String>();
    dir.join(format!("Fetchr-Setup-v{version}.exe"))
}

fn version_is_newer(candidate: &str, current: &str) -> bool {
    let candidate_parts = parse_version(candidate);
    let current_parts = parse_version(current);

    for index in 0..candidate_parts.len().max(current_parts.len()) {
        let left = *candidate_parts.get(index).unwrap_or(&0);
        let right = *current_parts.get(index).unwrap_or(&0);
        if left > right {
            return true;
        }
        if left < right {
            return false;
        }
    }

    false
}

fn parse_version(value: &str) -> Vec<u64> {
    value
        .trim()
        .trim_start_matches('v')
        .split(['.', '-', '+'])
        .map(|part| {
            part.chars()
                .take_while(|ch| ch.is_ascii_digit())
                .collect::<String>()
        })
        .map(|part| part.parse::<u64>().unwrap_or(0))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::{install_plan, signed_payload, version_is_newer, RemoteUpdate};

    // The Node signing script rebuilds this exact string; if this test changes,
    // scripts/write-latest-update-manifest.mjs must change with it.
    #[test]
    fn signed_payload_is_canonical() {
        let payload = signed_payload(
            "  0.5.8 ",
            " https://cdn.example/Fetchr-Setup-v0.5.8.exe ",
            "  ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789 ",
        );
        assert_eq!(
            payload,
            "fetchr-update-v1\nbeta\n0.5.8\nhttps://cdn.example/Fetchr-Setup-v0.5.8.exe\n\
             abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789"
        );
    }

    #[test]
    fn compares_numeric_versions() {
        assert!(version_is_newer("0.2.1", "0.2.0"));
        assert!(version_is_newer("0.10.0", "0.2.9"));
        assert!(!version_is_newer("0.2.0", "0.2.0"));
        assert!(!version_is_newer("0.1.9", "0.2.0"));
    }

    fn manifest(version: &str, url: &str, sha256: &str) -> RemoteUpdate {
        RemoteUpdate {
            available: None,
            version: Some(version.to_string()),
            notes: None,
            notes_i18n: None,
            pages_i18n: None,
            installer_url: Some(url.to_string()),
            installer_sha256: Some(sha256.to_string()),
            sha256: None,
            size_bytes: None,
            published_at: None,
            signature: None,
        }
    }

    const URL: &str = "https://cdn.example/Fetchr-Setup-v0.6.7.exe";
    const SHA: &str = "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";

    #[test]
    fn install_plan_accepts_a_newer_signed_style_exe() {
        let remote = manifest("0.6.7", URL, SHA);
        let plan = install_plan(&remote, "0.6.6").expect("installable");
        assert_eq!(plan.version, "0.6.7");
        assert_eq!(plan.sha256, SHA);
        assert_eq!(plan.url.as_str(), URL);
    }

    // Everything install_update would refuse must also clear "installable",
    // or the launch splash would start an install that is bound to fail.
    #[test]
    fn install_plan_rejects_what_install_update_refuses() {
        assert!(install_plan(&manifest("0.6.6", URL, SHA), "0.6.6").is_err());
        let mut withdrawn = manifest("0.6.7", URL, SHA);
        withdrawn.available = Some(false);
        assert!(install_plan(&withdrawn, "0.6.6").is_err());
        assert!(install_plan(&manifest("0.6.7", "http://cdn.example/Fetchr.exe", SHA), "0.6.6").is_err());
        assert!(install_plan(&manifest("0.6.7", "https://cdn.example/Fetchr.dmg", SHA), "0.6.6").is_err());
        assert!(install_plan(&manifest("0.6.7", URL, "abc"), "0.6.6").is_err());
        assert!(install_plan(&manifest("0.6.7", URL, &"z".repeat(64)), "0.6.6").is_err());
        assert!(install_plan(&manifest("  ", URL, SHA), "0.6.6").is_err());
    }
}
