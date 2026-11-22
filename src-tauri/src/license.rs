use std::{fs, io::Read, path::PathBuf, process::Command, sync::OnceLock, time::Duration};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

const PRODUCT_ID: &str = "fetchr-beta";
const LICENSE_PREFIX: &str = "FTR1";
const PUBLIC_KEY_BASE64: &str = "kRQxqcBho2NMB2GG8lCX9c8A+RJKhBR1CDtC74OEID4=";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LicensePayload {
    pub v: u8,
    pub product: String,
    pub machine_id: String,
    pub name: Option<String>,
    pub note: Option<String>,
    pub issued_at: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct LicenseStatus {
    pub state: String,
    pub machine_id: String,
    pub license: Option<LicensePayload>,
    pub runtime_config: Option<RemoteRuntimeConfig>,
    pub message: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
struct StoredLicense {
    key: String,
}

#[derive(Debug, Serialize)]
struct RemoteLicenseStatusRequest {
    machine_id: String,
    license_key: String,
    app_version: String,
    hwid_sha256: String,
    executable_sha256: Option<String>,
}

#[derive(Debug, Deserialize)]
struct RemoteLicenseStatus {
    active: bool,
    reason: Option<String>,
    message: Option<String>,
    runtime_config: Option<RemoteRuntimeConfig>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RemoteRuntimeConfig {
    product: String,
    channel: String,
    features: Vec<String>,
    lease_expires_at: Option<String>,
}

/// Computing the identity spawns PowerShell (seconds on a cold start). Sync
/// Tauri commands run on the main thread, so every command that needs it is
/// async and waits here, off both the UI thread and the async runtime.
async fn machine_id_off_thread() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(current_machine_id)
        .await
        .map_err(|err| format!("Failed to read machine id: {err}"))
}

/// Computes the identity now (blocking), so the first command that needs it
/// does not pay for the PowerShell probes. Called from a start-up thread.
pub fn warm_hardware_identity() {
    hardware_identity();
}

#[tauri::command]
pub async fn get_machine_id() -> Result<String, String> {
    machine_id_off_thread().await
}

#[derive(Debug, Clone, Serialize)]
pub struct BetaActivationLink {
    pub machine_id: String,
    pub telegram_url: Option<String>,
    pub start_parameter: String,
    pub configured: bool,
    pub message: Option<String>,
}

#[tauri::command]
pub async fn beta_activation_link() -> Result<BetaActivationLink, String> {
    let machine_id = machine_id_off_thread().await?;
    let start_parameter = format!("fetchr_{machine_id}");
    let telegram_url = crate::remote::telegram_bot_name()
        .map(|bot| format!("https://t.me/{bot}?start={start_parameter}"));
    let configured = telegram_url.is_some();

    Ok(BetaActivationLink {
        machine_id,
        telegram_url,
        start_parameter,
        configured,
        message: if configured {
            None
        } else {
            Some("Telegram bot is not configured. Set FETCHR_TG_BETA_BOT during build.".to_string())
        },
    })
}

#[tauri::command]
pub async fn license_status() -> Result<LicenseStatus, String> {
    let machine_id = machine_id_off_thread().await?;
    let path = license_file_path()?;

    if !path.is_file() {
        return Ok(LicenseStatus {
            state: "missing".to_string(),
            machine_id,
            license: None,
            runtime_config: None,
            message: None,
        });
    }

    let raw =
        fs::read_to_string(&path).map_err(|err| format!("Failed to read license file: {err}"))?;
    let stored: StoredLicense =
        serde_json::from_str(&raw).map_err(|err| format!("Failed to parse license file: {err}"))?;

    let payload = match verify_license_key(&stored.key, &machine_id) {
        Ok(payload) => payload,
        Err(err) => {
            return Ok(LicenseStatus {
                state: "invalid".to_string(),
                machine_id,
                license: None,
                runtime_config: None,
                message: Some(err),
            });
        }
    };

    match validate_remote_license(&machine_id, &stored.key).await {
        Ok(Some(remote)) if !remote.active => {
            let _ = fs::remove_file(&path);
            let reason = remote.reason.as_deref().unwrap_or("unknown");
            Ok(LicenseStatus {
                state: "invalid".to_string(),
                machine_id,
                license: None,
                runtime_config: None,
                message: Some(remote.message.unwrap_or_else(|| {
                    format!("License is no longer active ({reason}). Subscribe to the official Telegram channel and request a new key.")
                })),
            })
        }
        Ok(Some(remote)) => match validated_runtime_config(remote) {
            Ok(runtime_config) => Ok(LicenseStatus {
                state: "active".to_string(),
                machine_id,
                license: Some(payload),
                runtime_config: Some(runtime_config),
                message: None,
            }),
            Err(err) => Ok(LicenseStatus {
                state: "invalid".to_string(),
                machine_id,
                license: None,
                runtime_config: None,
                message: Some(err),
            }),
        },
        Ok(None) => Ok(LicenseStatus {
            state: "active".to_string(),
            machine_id,
            license: Some(payload),
            runtime_config: None,
            message: None,
        }),
        Err(err) => Ok(LicenseStatus {
            state: "invalid".to_string(),
            machine_id,
            license: None,
            runtime_config: None,
            message: Some(err),
        }),
    }
}

#[tauri::command]
pub async fn activate_license(key: String) -> Result<LicenseStatus, String> {
    let machine_id = machine_id_off_thread().await?;
    let normalized = normalize_key(&key);
    let payload = verify_license_key(&normalized, &machine_id)?;
    let path = license_file_path()?;

    let runtime_config = if let Some(remote) =
        validate_remote_license(&machine_id, &normalized).await?
    {
        if !remote.active {
            let reason = remote.reason.as_deref().unwrap_or("unknown");
            return Err(remote.message.unwrap_or_else(|| {
                format!("License is not active ({reason}). Subscribe to the official Telegram channel and request a new key.")
            }));
        }
        Some(validated_runtime_config(remote)?)
    } else {
        None
    };

    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|err| format!("Failed to create license directory: {err}"))?;
    }

    let stored = StoredLicense { key: normalized };
    let raw = serde_json::to_string_pretty(&stored)
        .map_err(|err| format!("Failed to serialize license: {err}"))?;
    fs::write(&path, raw).map_err(|err| format!("Failed to save license: {err}"))?;

    Ok(LicenseStatus {
        state: "active".to_string(),
        machine_id,
        license: Some(payload),
        runtime_config,
        message: None,
    })
}

async fn validate_remote_license(
    machine_id: &str,
    license_key: &str,
) -> Result<Option<RemoteLicenseStatus>, String> {
    let Some(base) = crate::remote::api_base_url() else {
        return Ok(None);
    };

    let executable_sha256 = tauri::async_runtime::spawn_blocking(current_exe_sha256)
        .await
        .ok()
        .flatten();
    let client = crate::remote::secure_client(Duration::from_secs(10))?;
    let response = client
        .post(format!("{base}/license/status"))
        .json(&RemoteLicenseStatusRequest {
            machine_id: machine_id.to_string(),
            license_key: license_key.to_string(),
            app_version: crate::remote::app_version(),
            hwid_sha256: current_hwid_sha256(),
            executable_sha256,
        })
        .send()
        .await
        .map_err(|err| format!("Could not check beta access: {err}"))?;
    crate::remote::verify_tls_pin(&response)?;
    let response = response
        .error_for_status()
        .map_err(|err| format!("Beta access server returned an error: {err}"))?
        .json::<RemoteLicenseStatus>()
        .await
        .map_err(|err| format!("Could not parse beta access response: {err}"))?;

    Ok(Some(response))
}

fn validated_runtime_config(remote: RemoteLicenseStatus) -> Result<RemoteRuntimeConfig, String> {
    let config = remote.runtime_config.ok_or_else(|| {
        "Beta access server did not return the protected runtime configuration.".to_string()
    })?;

    if config.product != PRODUCT_ID {
        return Err("Protected runtime configuration is for another product.".to_string());
    }
    if config.channel != crate::remote::APP_CHANNEL {
        return Err("Protected runtime configuration is for another release channel.".to_string());
    }
    if !config
        .features
        .iter()
        .any(|feature| feature == "license_gate")
    {
        return Err("Protected runtime configuration is incomplete.".to_string());
    }

    Ok(config)
}

#[tauri::command]
pub async fn reset_license() -> Result<LicenseStatus, String> {
    let machine_id = machine_id_off_thread().await?;
    let path = license_file_path()?;

    if path.is_file() {
        fs::remove_file(&path).map_err(|err| format!("Failed to remove license: {err}"))?;
    }

    Ok(LicenseStatus {
        state: "missing".to_string(),
        machine_id,
        license: None,
        runtime_config: None,
        message: None,
    })
}

fn verify_license_key(key: &str, machine_id: &str) -> Result<LicensePayload, String> {
    verify_key_signed_by(key, machine_id, PUBLIC_KEY_BASE64)
}

fn verify_key_signed_by(
    key: &str,
    machine_id: &str,
    public_key_base64: &str,
) -> Result<LicensePayload, String> {
    let normalized = normalize_key(key);
    if normalized.is_empty() {
        return Err("License key is empty".to_string());
    }

    let mut parts = normalized.split('.');
    let prefix = parts.next().unwrap_or_default();
    let payload_part = parts.next().unwrap_or_default();
    let signature_part = parts.next().unwrap_or_default();
    if parts.next().is_some()
        || prefix != LICENSE_PREFIX
        || payload_part.is_empty()
        || signature_part.is_empty()
    {
        return Err("License key format is invalid".to_string());
    }

    let payload_bytes = URL_SAFE_NO_PAD
        .decode(payload_part)
        .map_err(|_| "License payload is not valid base64".to_string())?;
    let signature_bytes = URL_SAFE_NO_PAD
        .decode(signature_part)
        .map_err(|_| "License signature is not valid base64".to_string())?;

    let public_key_bytes = base64::engine::general_purpose::STANDARD
        .decode(public_key_base64)
        .map_err(|_| "Embedded public key is invalid".to_string())?;
    let public_key_array: [u8; 32] = public_key_bytes
        .try_into()
        .map_err(|_| "Embedded public key has invalid length".to_string())?;
    let verifying_key = VerifyingKey::from_bytes(&public_key_array)
        .map_err(|_| "Embedded public key cannot be loaded".to_string())?;
    let signature = Signature::from_slice(&signature_bytes)
        .map_err(|_| "License signature has invalid length".to_string())?;

    verifying_key
        .verify(payload_part.as_bytes(), &signature)
        .map_err(|_| {
            "Для этой версии нужен новый ключ: получите его в Telegram-боте.".to_string()
        })?;

    let payload: LicensePayload = serde_json::from_slice(&payload_bytes)
        .map_err(|_| "License payload JSON is invalid".to_string())?;

    if payload.v != 1 {
        return Err("License version is unsupported".to_string());
    }
    if payload.product != PRODUCT_ID {
        return Err("License is for a different product".to_string());
    }
    if payload.machine_id != machine_id {
        return Err("License is bound to another computer".to_string());
    }

    Ok(payload)
}

/// The saved licence key, for services that authenticate this machine by it.
pub(crate) fn stored_license_key() -> Option<String> {
    let raw = fs::read_to_string(license_file_path().ok()?).ok()?;
    let stored: StoredLicense = serde_json::from_str(&raw).ok()?;
    Some(stored.key).filter(|key| !key.is_empty())
}

fn normalize_key(key: &str) -> String {
    key.chars().filter(|ch| !ch.is_whitespace()).collect()
}

fn license_file_path() -> Result<PathBuf, String> {
    let base = dirs::config_dir()
        .ok_or_else(|| "Could not locate Windows config directory".to_string())?;
    Ok(base.join("Fetchr").join("license.json"))
}

#[derive(Debug, Clone)]
struct HardwareIdentity {
    machine_id: String,
    hwid_sha256: String,
}

pub(crate) fn current_machine_id() -> String {
    hardware_identity().machine_id.clone()
}

pub(crate) fn current_hwid_sha256() -> String {
    hardware_identity().hwid_sha256.clone()
}

fn hardware_identity() -> &'static HardwareIdentity {
    static IDENTITY: OnceLock<HardwareIdentity> = OnceLock::new();
    IDENTITY.get_or_init(compute_hardware_identity)
}

fn compute_hardware_identity() -> HardwareIdentity {
    let mut parts = Vec::new();

    #[cfg(target_os = "windows")]
    {
        // Each probe is its own PowerShell start (~1-2 s). The commands stay
        // exactly as they were, so the identity (and every issued license) is
        // unchanged; they only run side by side instead of one after another.
        let (cpu_id, board_uuid, disk_serial) = std::thread::scope(|scope| {
            let cpu_id = scope.spawn(|| {
                powershell_first_line(
                    "Get-CimInstance Win32_Processor | Select-Object -First 1 -ExpandProperty ProcessorId",
                )
            });
            let board_uuid = scope.spawn(|| {
                powershell_first_line(
                    "Get-CimInstance Win32_ComputerSystemProduct | Select-Object -ExpandProperty UUID",
                )
            });
            let disk_serial = scope.spawn(|| {
                powershell_first_line(
                    "Get-CimInstance Win32_DiskDrive | Sort-Object Index | Select-Object -First 1 -ExpandProperty SerialNumber",
                )
            });
            (
                cpu_id.join().ok().flatten(),
                board_uuid.join().ok().flatten(),
                disk_serial.join().ok().flatten(),
            )
        });
        push_if_some(&mut parts, "cpu_id", cpu_id);
        push_if_some(&mut parts, "board_uuid", board_uuid);
        push_if_some(&mut parts, "disk_serial", disk_serial);
    }

    #[cfg(target_os = "macos")]
    {
        push_if_some(&mut parts, "platform_uuid", macos_platform_uuid());
    }

    #[cfg(target_os = "linux")]
    {
        push_if_some(&mut parts, "machine_id", linux_machine_id());
    }

    if parts.is_empty() {
        #[cfg(target_os = "windows")]
        {
            push_if_some(&mut parts, "machine_guid", windows_registry_machine_guid());
        }
    }

    parts.sort();
    let joined = parts.join("|");
    let mut hasher = Sha256::new();
    hasher.update(PRODUCT_ID.as_bytes());
    hasher.update(b"|");
    hasher.update(joined.as_bytes());
    let digest = hasher.finalize();
    let hwid_sha256 = hex::encode_upper(digest);
    let machine_id = hwid_sha256[..32].to_string();
    HardwareIdentity {
        machine_id,
        hwid_sha256,
    }
}

fn push_if_some(parts: &mut Vec<String>, label: &str, value: Option<String>) {
    if let Some(value) = value {
        let trimmed = value.trim();
        if !trimmed.is_empty()
            && trimmed != "To be filled by O.E.M."
            && trimmed != "Default string"
            && trimmed != "System Serial Number"
            && trimmed != "Unknown"
            && trimmed != "None"
            && trimmed != "00000000-0000-0000-0000-000000000000"
        {
            parts.push(format!("{label}={trimmed}"));
        }
    }
}

/// The running image cannot change under the process, so it is hashed once.
fn current_exe_sha256() -> Option<String> {
    static HASH: OnceLock<Option<String>> = OnceLock::new();
    HASH.get_or_init(hash_current_exe).clone()
}

fn hash_current_exe() -> Option<String> {
    let path = std::env::current_exe().ok()?;
    let mut file = fs::File::open(path).ok()?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];

    loop {
        let read = file.read(&mut buffer).ok()?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }

    Some(hex::encode_upper(hasher.finalize()))
}

/// macOS hardware ID: the `IOPlatformUUID` reported by IOKit. Stable per machine.
#[cfg(target_os = "macos")]
fn macos_platform_uuid() -> Option<String> {
    let output = std::process::Command::new("ioreg")
        .args(["-rd1", "-c", "IOPlatformExpertDevice"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    text.lines().find_map(|line| {
        let rest = line.trim().strip_prefix("\"IOPlatformUUID\"")?;
        let start = rest.find('"')? + 1;
        let tail = &rest[start..];
        let end = tail.find('"')?;
        Some(tail[..end].to_string())
    })
}

/// Linux hardware ID: the systemd/D-Bus machine-id. Stable per installation.
#[cfg(target_os = "linux")]
fn linux_machine_id() -> Option<String> {
    for path in ["/etc/machine-id", "/var/lib/dbus/machine-id"] {
        if let Ok(content) = std::fs::read_to_string(path) {
            let trimmed = content.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
    }
    None
}

#[cfg(target_os = "windows")]
fn windows_registry_machine_guid() -> Option<String> {
    let output = hidden_command("reg")
        .args([
            "query",
            r"HKLM\SOFTWARE\Microsoft\Cryptography",
            "/v",
            "MachineGuid",
        ])
        .output()
        .ok()?;

    if !output.status.success() {
        return None;
    }

    let text = String::from_utf8_lossy(&output.stdout);
    text.lines().find_map(|line| {
        if !line.contains("MachineGuid") {
            return None;
        }
        let columns = line.split_whitespace().collect::<Vec<_>>();
        columns.last().map(|value| (*value).to_string())
    })
}

#[cfg(target_os = "windows")]
fn powershell_first_line(command: &str) -> Option<String> {
    let output = hidden_command("powershell")
        .args([
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            command,
        ])
        .output()
        .ok()?;

    if !output.status.success() {
        return None;
    }

    String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(ToOwned::to_owned)
}

#[cfg(target_os = "windows")]
fn hidden_command(program: &str) -> Command {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x08000000;
    let mut cmd = Command::new(program);
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};

    const MACHINE_ID: &str = "0123456789ABCDEF0123456789ABCDEF";

    fn signing_key() -> SigningKey {
        SigningKey::from_bytes(&[7u8; 32])
    }

    fn public_key_base64() -> String {
        base64::engine::general_purpose::STANDARD.encode(signing_key().verifying_key().to_bytes())
    }

    fn signed_key() -> String {
        let payload = URL_SAFE_NO_PAD.encode(format!(
            r#"{{"v":1,"product":"{PRODUCT_ID}","machine_id":"{MACHINE_ID}","name":null,"note":null,"issued_at":"2026-11-04T00:00:00.000Z"}}"#
        ));
        let signature = URL_SAFE_NO_PAD.encode(signing_key().sign(payload.as_bytes()).to_bytes());
        format!("{LICENSE_PREFIX}.{payload}.{signature}")
    }

    #[test]
    fn accepts_signed_key_for_matching_machine() {
        let payload =
            verify_key_signed_by(&signed_key(), MACHINE_ID, &public_key_base64()).expect("valid key");
        assert_eq!(payload.product, PRODUCT_ID);
        assert_eq!(payload.machine_id, MACHINE_ID);
    }

    #[test]
    fn rejects_signed_key_for_other_machine() {
        let err = verify_key_signed_by(
            &signed_key(),
            "FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF",
            &public_key_base64(),
        )
        .expect_err("bad id");
        assert!(err.contains("another computer"));
    }

    #[test]
    fn key_from_the_previous_pair_asks_for_a_new_one() {
        let err = verify_license_key(&signed_key(), MACHINE_ID).expect_err("foreign signature");
        assert!(err.contains("новый ключ"));
    }
}
