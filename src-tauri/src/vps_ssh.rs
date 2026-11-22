//! SSH access to the VPS recorder: one-shot provisioning and the tunnel the
//! app talks to the agent over.
//!
//! The agent binds loopback only. Instead of publishing it behind TLS (which
//! would need a domain and a certificate), the app forwards a local port to it
//! over SSH: everything including the `?token=` the media player needs in the
//! URL stays inside the encrypted channel, and `ensure_secure_base_url` accepts
//! the resulting `http://127.0.0.1:PORT` because it is loopback.
//!
//! The root password is only ever held in memory and in the OS credential
//! store — never in `vps-config.json`, never in a log line.

use std::sync::Arc;

use once_cell::sync::Lazy;
use parking_lot::Mutex;
use russh::client::{self, Handle, KeyboardInteractiveAuthResponse};
use russh::keys::HashAlg;
use russh::{ChannelMsg, MethodKind};
use serde::{Deserialize, Serialize};
use tokio::io::AsyncWriteExt;
use tokio::net::TcpListener;

const KEYRING_SERVICE: &str = "fetchr-vps-ssh";
const AGENT_DIR: &str = "/opt/fetchr-agent";
const AGENT_ROOT: &str = "/srv/fetchr";

/// Agent sources shipped inside the app binary, so provisioning needs nothing
/// on disk next to the installer.
///
/// `fetchr-api.service` is deliberately absent: on the production host that
/// name belongs to the *updates/licences* node service, not the recorder.
/// Uploading ours under that name would take fetchr.fun/api down for everyone.
/// The recorder API unit is `fetchr-rec-api.service`.
const AGENT_FILES: &[(&str, &str)] = &[
    ("agent.py", include_str!("../../vps-recorder/agent.py")),
    ("api.py", include_str!("../../vps-recorder/api.py")),
    (
        "session_io.py",
        include_str!("../../vps-recorder/session_io.py"),
    ),
    ("hot_tier.py", include_str!("../../vps-recorder/hot_tier.py")),
    (
        "config.json",
        include_str!("../../vps-recorder/config.json"),
    ),
];
const AGENT_UNITS: &[(&str, &str)] = &[
    (
        "fetchr-agent.service",
        include_str!("../../vps-recorder/fetchr-agent.service"),
    ),
    (
        "fetchr-rec-api.service",
        include_str!("../../vps-recorder/fetchr-rec-api.service"),
    ),
];

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SshTarget {
    pub host: String,
    #[serde(default = "default_ssh_port")]
    pub port: u16,
    #[serde(default = "default_user")]
    pub user: String,
}

/// How to prove who we are. Cloud images increasingly ship with
/// `PasswordAuthentication no`, so a private key is not an exotic option.
#[derive(Debug, Clone)]
pub enum Credential {
    Password(String),
    /// Path to an OpenSSH private key, plus the passphrase protecting it.
    Key {
        path: String,
        passphrase: Option<String>,
    },
}

impl Credential {
    /// The secret to persist for reconnects: the password itself, or the
    /// key's passphrase (the key path lives in the config).
    fn stored_secret(&self) -> &str {
        match self {
            Credential::Password(value) => value,
            Credential::Key { passphrase, .. } => passphrase.as_deref().unwrap_or(""),
        }
    }
}

fn default_ssh_port() -> u16 {
    22
}

fn default_user() -> String {
    "root".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct PreflightReport {
    pub host_key_fingerprint: String,
    pub os: String,
    pub arch: String,
    pub has_systemd: bool,
    pub has_python: bool,
    pub has_ffmpeg: bool,
    pub has_streamlink: bool,
    pub disk_total: u64,
    pub disk_free: u64,
    /// Packages provisioning will install to close the gaps above.
    pub missing: Vec<String>,
    /// SSH auth methods the server actually offers, asked for before any secret
    /// is sent. Lets the UI say "this server wants a key" instead of "wrong
    /// password" when `PasswordAuthentication no` is set.
    pub auth_methods: Vec<String>,
    pub password_auth: bool,
    pub key_auth: bool,
}

/// What the server is willing to accept for this user, probed with the `none`
/// method — no password or key leaves the machine.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AuthMethods {
    pub host_key_fingerprint: String,
    pub server_version: String,
    pub methods: Vec<String>,
    pub password: bool,
    pub key: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ProvisionReport {
    pub token: String,
    pub agent_port: u16,
    pub host_key_fingerprint: String,
    pub loopback_only: bool,
    pub log: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TunnelPhase {
    Disconnected,
    Connecting,
    Online,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TunnelState {
    pub phase: TunnelPhase,
    pub local_port: Option<u16>,
    pub error: Option<String>,
    pub since: Option<u64>,
}

impl Default for TunnelState {
    fn default() -> Self {
        Self {
            phase: TunnelPhase::Disconnected,
            local_port: None,
            error: None,
            since: None,
        }
    }
}

/// SSH connections the tunnel spreads forwarded streams over. One TCP
/// connection does not saturate the link; a handful does.
const TUNNEL_SESSIONS: usize = 4;

static TUNNEL: Lazy<Mutex<TunnelState>> = Lazy::new(|| Mutex::new(TunnelState::default()));
/// Extra pool connections, filled in the background after the tunnel is up.
static EXTRA_SESSIONS: Lazy<Mutex<Vec<Arc<Handle<Client>>>>> = Lazy::new(|| Mutex::new(Vec::new()));
/// Bumped on every stop/start so a superseded reconnect loop exits instead of
/// racing the new one for the listener.
static TUNNEL_GENERATION: Lazy<Mutex<u64>> = Lazy::new(|| Mutex::new(0));

pub fn tunnel_state() -> TunnelState {
    TUNNEL.lock().clone()
}

/// Base URL of the agent as reachable right now, or `None` when the tunnel is
/// not up. Callers must not fall back to the public address: the token would
/// then travel in clear text.
pub fn tunnel_base_url() -> Option<String> {
    let state = TUNNEL.lock();
    match (state.phase, state.local_port) {
        (TunnelPhase::Online, Some(port)) => Some(format!("http://127.0.0.1:{port}")),
        _ => None,
    }
}

fn set_state(state: TunnelState) {
    *TUNNEL.lock() = state;
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

// --- credential storage ------------------------------------------------------

fn keyring_entry(host: &str, user: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, &format!("{user}@{host}"))
        .map_err(|e| format!("Хранилище паролей недоступно: {e}"))
}

pub fn store_password(host: &str, user: &str, password: &str) -> Result<(), String> {
    keyring_entry(host, user)?
        .set_password(password)
        .map_err(|e| format!("Не удалось сохранить пароль: {e}"))
}

pub fn load_password(host: &str, user: &str) -> Result<String, String> {
    keyring_entry(host, user)?
        .get_password()
        .map_err(|_| "Пароль от VPS не найден — подключитесь заново".to_string())
}

pub fn forget_password(host: &str, user: &str) -> Result<(), String> {
    match keyring_entry(host, user)?.delete_credential() {
        Ok(()) => Ok(()),
        // Nothing stored is the state we wanted anyway.
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("Не удалось удалить пароль: {e}")),
    }
}

// --- ssh plumbing ------------------------------------------------------------

/// Trust-on-first-use: the first connection records the server's key, later
/// ones must match it. `expected` is `None` only on the very first connect.
struct Client {
    expected: Option<String>,
    seen: Arc<Mutex<Option<String>>>,
}

impl client::Handler for Client {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &russh::keys::ssh_key::PublicKey,
    ) -> Result<bool, Self::Error> {
        let fingerprint = server_public_key.fingerprint(HashAlg::Sha256).to_string();
        let accepted = match &self.expected {
            Some(known) => known == &fingerprint,
            None => true,
        };
        *self.seen.lock() = Some(fingerprint);
        Ok(accepted)
    }
}

struct Session {
    handle: Handle<Client>,
    fingerprint: String,
}

async fn connect(
    target: &SshTarget,
    credential: &Credential,
    expected_fingerprint: Option<String>,
) -> Result<Session, String> {
    let config = Arc::new(client::Config {
        inactivity_timeout: Some(std::time::Duration::from_secs(120)),
        keepalive_interval: Some(std::time::Duration::from_secs(20)),
        // Defaults (2 MB window, 100 buffered messages) are sized for shells,
        // not for pulling gigabytes: the channel spends its time waiting for
        // window adjustments instead of sending.
        window_size: 32 * 1024 * 1024,
        channel_buffer_size: 2048,
        ..Default::default()
    });
    let seen = Arc::new(Mutex::new(None));
    let handler = Client {
        expected: expected_fingerprint.clone(),
        seen: seen.clone(),
    };

    let mut handle = client::connect(config, (target.host.as_str(), target.port), handler)
        .await
        .map_err(|e| {
            let seen_now = seen.lock().clone();
            match (&expected_fingerprint, seen_now) {
                (Some(known), Some(actual)) if known != &actual => format!(
                    "Ключ сервера изменился: ожидался {known}, получен {actual}. \
                     Подключение отклонено — это может быть подмена сервера."
                ),
                _ => format!(
                    "Не удалось подключиться к {}:{}: {e}",
                    target.host, target.port
                ),
            }
        })?;

    authenticate(&mut handle, &target.user, credential).await?;

    let fingerprint = seen.lock().clone().unwrap_or_default();
    Ok(Session {
        handle,
        fingerprint,
    })
}

fn method_names(methods: &[MethodKind]) -> String {
    methods
        .iter()
        .map(|method| <&str>::from(method))
        .collect::<Vec<_>>()
        .join(", ")
}

/// Authenticate with whatever the user supplied, trying every method the
/// server is willing to accept.
///
/// A password goes out as the plain `password` method first, then as answers to
/// `keyboard-interactive` prompts: stock images running `UsePAM yes` reject the
/// former and offer the latter, and OpenSSH/paramiko paper over that difference
/// silently, so a password that works in a normal SSH client would otherwise
/// look "wrong" here.
async fn authenticate(
    handle: &mut Handle<Client>,
    user: &str,
    credential: &Credential,
) -> Result<(), String> {
    let password = match credential {
        Credential::Password(value) => value.clone(),
        Credential::Key { path, passphrase } => {
            let key =
                russh::keys::load_secret_key(path, passphrase.as_deref().filter(|p| !p.is_empty()))
                    .map_err(|e| format!("Не удалось прочитать ключ {path}: {e}"))?;
            let auth = handle
                .authenticate_publickey(
                    user,
                    russh::keys::PrivateKeyWithHashAlg::new(
                        std::sync::Arc::new(key),
                        // RSA keys must be signed with SHA-256 or newer; OpenSSH 8.8+
                        // refuses the legacy SHA-1 signature that `None` selects.
                        Some(HashAlg::Sha256),
                    ),
                )
                .await
                .map_err(|e| format!("Ошибка аутентификации по ключу: {e}"))?;
            return match auth {
                russh::client::AuthResult::Success => Ok(()),
                russh::client::AuthResult::Failure {
                    remaining_methods, ..
                } => Err(format!(
                    "Сервер отклонил SSH-ключ для {user}. Проверьте, что открытая часть ключа \
                     есть в ~/.ssh/authorized_keys на сервере. Доступные способы: {}.",
                    method_names(&remaining_methods)
                )),
            };
        }
    };

    let auth = handle
        .authenticate_password(user, password.clone())
        .await
        .map_err(|e| format!("Ошибка аутентификации: {e}"))?;
    let remaining = match auth {
        russh::client::AuthResult::Success => return Ok(()),
        russh::client::AuthResult::Failure {
            remaining_methods, ..
        } => remaining_methods,
    };

    if remaining.contains(&MethodKind::KeyboardInteractive) {
        let mut response = handle
            .authenticate_keyboard_interactive_start(user, None)
            .await
            .map_err(|e| format!("Ошибка аутентификации: {e}"))?;
        // The server may ask several times ("Password:", then "Verification
        // code:" on 2FA hosts). We can only answer password prompts.
        for _ in 0..8 {
            match response {
                KeyboardInteractiveAuthResponse::Success => return Ok(()),
                KeyboardInteractiveAuthResponse::InfoRequest { prompts, .. } => {
                    let answers = prompts.iter().map(|_| password.clone()).collect();
                    response = handle
                        .authenticate_keyboard_interactive_respond(answers)
                        .await
                        .map_err(|e| format!("Ошибка аутентификации: {e}"))?;
                }
                KeyboardInteractiveAuthResponse::Failure {
                    remaining_methods, ..
                } => {
                    return Err(auth_failure_message(user, &remaining_methods));
                }
            }
        }
        return Err("Сервер запрашивает слишком много подтверждений — похоже, включена двухфакторная аутентификация".to_string());
    }

    Err(auth_failure_message(user, &remaining))
}

fn auth_failure_message(user: &str, remaining: &[MethodKind]) -> String {
    let password_offered = remaining.contains(&MethodKind::Password)
        || remaining.contains(&MethodKind::KeyboardInteractive);
    if remaining.is_empty() {
        return format!("Сервер отклонил вход для пользователя {user}");
    }
    if !password_offered {
        return format!(
            "Сервер не принимает вход по паролю для {user} — разрешён только {}. \
             Выберите вход по SSH-ключу, либо разрешите пароль на сервере: в \
             /etc/ssh/sshd_config.d/*.conf и /etc/ssh/sshd_config поставьте \
             PasswordAuthentication yes и PermitRootLogin yes, затем systemctl restart ssh.",
            method_names(remaining)
        );
    }
    format!("Неверный логин или пароль SSH для {user}")
}

struct CommandOutput {
    code: u32,
    stdout: String,
    stderr: String,
}

impl CommandOutput {
    fn ok(&self) -> bool {
        self.code == 0
    }

    fn trimmed(&self) -> &str {
        self.stdout.trim()
    }
}

async fn run(session: &Session, command: &str) -> Result<CommandOutput, String> {
    exec(session, command, None).await
}

/// Run `command`, optionally piping `stdin` into it. Uploading a file is
/// `exec("cat > path")` plus its bytes — no sftp subsystem required.
async fn exec(
    session: &Session,
    command: &str,
    stdin: Option<&[u8]>,
) -> Result<CommandOutput, String> {
    let mut channel = session
        .handle
        .channel_open_session()
        .await
        .map_err(|e| format!("SSH-канал: {e}"))?;
    channel
        .exec(true, command)
        .await
        .map_err(|e| format!("SSH exec: {e}"))?;

    if let Some(bytes) = stdin {
        channel
            .data(bytes)
            .await
            .map_err(|e| format!("SSH stdin: {e}"))?;
        channel.eof().await.map_err(|e| format!("SSH eof: {e}"))?;
    }

    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    let mut code = 0u32;
    while let Some(message) = channel.wait().await {
        match message {
            ChannelMsg::Data { data } => stdout.extend_from_slice(&data),
            ChannelMsg::ExtendedData { data, .. } => stderr.extend_from_slice(&data),
            ChannelMsg::ExitStatus { exit_status } => code = exit_status,
            _ => {}
        }
    }
    Ok(CommandOutput {
        code,
        stdout: String::from_utf8_lossy(&stdout).into_owned(),
        stderr: String::from_utf8_lossy(&stderr).into_owned(),
    })
}

/// Single-quote for `sh` so a password or path can never break out of the
/// command we build.
fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', r"'\''"))
}

async fn upload(session: &Session, path: &str, content: &str, mode: &str) -> Result<(), String> {
    let command = format!(
        "umask 077 && cat > {p} && chmod {mode} {p}",
        p = shell_quote(path)
    );
    let result = exec(session, &command, Some(content.as_bytes())).await?;
    if !result.ok() {
        return Err(format!(
            "Не удалось записать {path}: {}",
            result.stderr.trim()
        ));
    }
    Ok(())
}

// --- preflight & provisioning ------------------------------------------------

/// Ask the server which auth methods it accepts, without sending a secret.
///
/// Worth its own round trip: current Ubuntu cloud images ship
/// `PasswordAuthentication no`, and without this the user only ever sees
/// "wrong password" for a password that is perfectly correct.
pub async fn auth_methods(target: &SshTarget) -> Result<AuthMethods, String> {
    let config = Arc::new(client::Config {
        inactivity_timeout: Some(std::time::Duration::from_secs(30)),
        ..Default::default()
    });
    let seen = Arc::new(Mutex::new(None));
    let handler = Client {
        expected: None,
        seen: seen.clone(),
    };
    let mut handle = client::connect(config, (target.host.as_str(), target.port), handler)
        .await
        .map_err(|e| {
            format!(
                "Не удалось подключиться к {}:{}: {e}",
                target.host, target.port
            )
        })?;

    let offered = match handle
        .authenticate_none(&target.user)
        .await
        .map_err(|e| format!("Опрос сервера: {e}"))?
    {
        // A server that lets anyone in without credentials accepts everything.
        russh::client::AuthResult::Success => russh::MethodSet::all(),
        russh::client::AuthResult::Failure {
            remaining_methods, ..
        } => remaining_methods,
    };
    let fingerprint = seen.lock().clone().unwrap_or_default();
    Ok(AuthMethods {
        host_key_fingerprint: fingerprint,
        server_version: String::new(),
        methods: offered
            .iter()
            .map(|method| <&str>::from(method).to_string())
            .collect(),
        password: offered.contains(&MethodKind::Password)
            || offered.contains(&MethodKind::KeyboardInteractive),
        key: offered.contains(&MethodKind::PublicKey),
    })
}

pub async fn preflight(
    target: &SshTarget,
    credential: &Credential,
    expected_fingerprint: Option<String>,
) -> Result<PreflightReport, String> {
    let offered = auth_methods(target).await.ok();
    let session = connect(target, credential, expected_fingerprint).await?;
    let mut report = PreflightReport {
        host_key_fingerprint: session.fingerprint.clone(),
        auth_methods: offered
            .as_ref()
            .map(|a| a.methods.clone())
            .unwrap_or_default(),
        password_auth: offered.as_ref().map(|a| a.password).unwrap_or(true),
        key_auth: offered.as_ref().map(|a| a.key).unwrap_or(true),
        ..Default::default()
    };

    report.os = run(
        &session,
        "sh -c '. /etc/os-release 2>/dev/null && echo \"$PRETTY_NAME\"'",
    )
    .await?
    .trimmed()
    .to_string();
    report.arch = run(&session, "uname -m").await?.trimmed().to_string();
    report.has_systemd = run(&session, "command -v systemctl").await?.ok();
    report.has_python = run(&session, "command -v python3").await?.ok();
    report.has_ffmpeg = run(&session, "command -v ffmpeg").await?.ok();
    report.has_streamlink = run(
        &session,
        &format!("test -x {AGENT_DIR}/venv/bin/streamlink"),
    )
    .await?
    .ok();

    // `df -P` keeps the output on one line even for long device names.
    let disk = run(&session, "df -Pk / | tail -1").await?;
    let fields: Vec<&str> = disk.trimmed().split_whitespace().collect();
    if fields.len() >= 4 {
        report.disk_total = fields[1].parse::<u64>().unwrap_or(0) * 1024;
        report.disk_free = fields[3].parse::<u64>().unwrap_or(0) * 1024;
    }

    if !report.has_python {
        report.missing.push("python3".to_string());
    }
    if !report.has_ffmpeg {
        report.missing.push("ffmpeg".to_string());
    }
    if !report.has_streamlink {
        report.missing.push("streamlink".to_string());
    }
    if !report.has_systemd {
        report
            .missing
            .push("systemd (обязателен — агент ставится как служба)".to_string());
    }
    Ok(report)
}

pub async fn provision(
    target: &SshTarget,
    credential: &Credential,
    agent_port: u16,
    expected_fingerprint: Option<String>,
    reuse_token: Option<String>,
    on_step: &(dyn Fn(&str) + Send + Sync),
) -> Result<ProvisionReport, String> {
    on_step("Подключаюсь к серверу");
    let session = connect(target, credential, expected_fingerprint).await?;
    let mut log = Vec::new();

    if !run(&session, "command -v systemctl").await?.ok() {
        return Err("На сервере нет systemd — агент установить нельзя".to_string());
    }

    on_step("Создаю папки для записей");
    let result = run(
        &session,
        &format!(
            "mkdir -p {AGENT_DIR} {AGENT_ROOT}/buffer {AGENT_ROOT}/chat {AGENT_ROOT}/clips \
             {AGENT_ROOT}/schedules {AGENT_ROOT}/recordings {AGENT_ROOT}/posters"
        ),
    )
    .await?;
    if !result.ok() {
        return Err(format!(
            "Не удалось создать каталоги: {}",
            result.stderr.trim()
        ));
    }
    log.push("Созданы каталоги агента".to_string());

    // Only install when something is actually missing: apt-get on every
    // reconnect would turn a reconfigure into a minutes-long wait.
    if !run(&session, "command -v ffmpeg").await?.ok()
        || !run(&session, "command -v python3").await?.ok()
    {
        on_step("Устанавливаю ffmpeg и python3 — это может занять несколько минут");
        let result = run(
            &session,
            "DEBIAN_FRONTEND=noninteractive apt-get update -qq && \
             DEBIAN_FRONTEND=noninteractive apt-get install -y -qq ffmpeg python3 python3-venv",
        )
        .await?;
        if !result.ok() {
            return Err(format!(
                "Не удалось установить ffmpeg/python3: {}",
                result.stderr.trim()
            ));
        }
        log.push("Установлены ffmpeg и python3".to_string());
    }

    if !run(
        &session,
        &format!("test -x {AGENT_DIR}/venv/bin/streamlink"),
    )
    .await?
    .ok()
    {
        on_step("Устанавливаю streamlink — это может занять пару минут");
        let result = run(
            &session,
            &format!(
                "python3 -m venv {AGENT_DIR}/venv && \
                 {AGENT_DIR}/venv/bin/pip install -q --upgrade pip && \
                 {AGENT_DIR}/venv/bin/pip install -q streamlink fastapi uvicorn"
            ),
        )
        .await?;
        if !result.ok() {
            return Err(format!("Не удалось создать venv: {}", result.stderr.trim()));
        }
        log.push("Установлены streamlink, fastapi, uvicorn".to_string());
    }

    on_step("Загружаю программу записи");
    for (name, content) in AGENT_FILES {
        upload(&session, &format!("{AGENT_DIR}/{name}"), content, "644").await?;
    }
    for (name, content) in AGENT_UNITS {
        upload(
            &session,
            &format!("/etc/systemd/system/{name}"),
            content,
            "644",
        )
        .await?;
    }
    log.push(format!(
        "Загружено файлов: {}",
        AGENT_FILES.len() + AGENT_UNITS.len()
    ));

    // Reuse the token on a reconfigure so already-open previews keep working.
    let token = match reuse_token.filter(|value| value.len() >= 32) {
        Some(existing) => existing,
        None => format!(
            "{}{}",
            uuid::Uuid::new_v4().simple(),
            uuid::Uuid::new_v4().simple()
        ),
    };
    upload(&session, &format!("{AGENT_DIR}/token"), &token, "600").await?;

    // The units run as `fetchr`, not root: that user owns the data and reads
    // the token. Older installs ran as root, so their files are handed over.
    let result = run(
        &session,
        &format!(
            "{{ id -u fetchr >/dev/null 2>&1 || useradd --system --user-group --no-create-home              --home-dir /nonexistent --shell /usr/sbin/nologin fetchr; }} &&              mkdir -p {AGENT_ROOT}/.cache && chown -R fetchr:fetchr {AGENT_ROOT} &&              chown fetchr:fetchr {AGENT_DIR}/token"
        ),
    )
    .await?;
    if !result.ok() {
        return Err(format!(
            "Не удалось создать пользователя fetchr: {}",
            result.stderr.trim()
        ));
    }

    // `enable --now` leaves an already-running unit alone, so a re-provision
    // would keep serving the old code and the *old* token — api.py reads it
    // once at import. Restart explicitly.
    on_step("Запускаю службы записи");
    let result = run(
        &session,
        "systemctl daemon-reload && systemctl enable fetchr-agent fetchr-rec-api && \
         systemctl restart fetchr-agent fetchr-rec-api",
    )
    .await?;
    if !result.ok() {
        return Err(format!(
            "Не удалось запустить службы: {}",
            result.stderr.trim()
        ));
    }
    log.push("Службы fetchr-agent и fetchr-rec-api перезапущены".to_string());

    for unit in ["fetchr-agent", "fetchr-rec-api"] {
        let active = run(&session, &format!("systemctl is-active {unit}")).await?;
        if active.trimmed() != "active" {
            let why = run(
                &session,
                &format!("journalctl -u {unit} -n 15 --no-pager 2>/dev/null | tail -15"),
            )
            .await?;
            return Err(format!(
                "Служба {unit} не запустилась ({}). Последние строки журнала:\n{}",
                active.trimmed(),
                why.trimmed()
            ));
        }
    }

    on_step("Проверяю, что сервер отвечает");
    // Prove the freshly written token is the one the API is serving with. The
    // token is piped into curl's config on stdin, so it never appears in the
    // server's process list.
    let probe = exec(
        &session,
        &format!(
            "{{ printf 'url = \"http://127.0.0.1:{agent_port}/status\"\\nheader = \"X-Token: '; \
             cat {AGENT_DIR}/token; printf '\"\\n'; }} | \
             curl -sS -o /dev/null -w '%{{http_code}}' --max-time 20 --config -"
        ),
        None,
    )
    .await?;
    match probe.trimmed() {
        "200" => log.push("Агент отвечает, токен принят".to_string()),
        "401" => {
            return Err(
                "Агент запущен, но отклоняет токен — перезапустите fetchr-rec-api вручную"
                    .to_string(),
            )
        }
        other => log.push(format!("Проверка агента вернула HTTP {other}")),
    }

    // The agent must not be reachable from the internet — the tunnel is the
    // only intended path in.
    let listening = run(
        &session,
        &format!("ss -tlnH 'sport = :{agent_port}' 2>/dev/null || true"),
    )
    .await?;
    let loopback_only = listening
        .trimmed()
        .lines()
        .all(|line| line.contains("127.0.0.1") || line.contains("[::1]"));
    if !listening.trimmed().is_empty() && !loopback_only {
        log.push(format!(
            "ВНИМАНИЕ: порт {agent_port} слушается не только на loopback"
        ));
    }

    Ok(ProvisionReport {
        token,
        agent_port,
        host_key_fingerprint: session.fingerprint,
        loopback_only,
        log,
    })
}

// --- tunnel ------------------------------------------------------------------

pub fn tunnel_stop() {
    *TUNNEL_GENERATION.lock() += 1;
    EXTRA_SESSIONS.lock().clear();
    set_state(TunnelState::default());
}

/// Bring the tunnel up and keep it up. Returns once the first connection is
/// established (so callers can immediately talk to the agent); the reconnect
/// loop then lives in a background task.
pub async fn tunnel_start(
    target: SshTarget,
    credential: Credential,
    agent_port: u16,
    fingerprint: Option<String>,
) -> Result<u16, String> {
    tunnel_stop();
    let generation = {
        let mut gen = TUNNEL_GENERATION.lock();
        *gen += 1;
        *gen
    };

    set_state(TunnelState {
        phase: TunnelPhase::Connecting,
        local_port: None,
        error: None,
        since: Some(now_secs()),
    });

    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .map_err(|e| format!("Не удалось открыть локальный порт: {e}"))?;
    let local_port = listener
        .local_addr()
        .map_err(|e| format!("Локальный порт: {e}"))?
        .port();

    // A pool, not one connection. Every forwarded stream shares the tunnel's
    // single TCP connection, and this path tops out well below what the link
    // can carry: measured against this VPS, one SSH connection reached
    // 11.5 MB/s while several in parallel reached 16.5 MB/s. Spreading the
    // forwarded connections over independent sessions buys that difference.
    let mut pool = Vec::with_capacity(TUNNEL_SESSIONS);
    pool.push(connect(&target, &credential, fingerprint.clone()).await?);
    set_state(TunnelState {
        phase: TunnelPhase::Online,
        local_port: Some(local_port),
        error: None,
        since: Some(now_secs()),
    });

    // The rest are opened in the background: the first one is enough to serve
    // requests, and waiting for all of them would delay the page.
    {
        let target = target.clone();
        let credential = credential.clone();
        let fingerprint = fingerprint.clone();
        tokio::spawn(async move {
            for _ in 1..TUNNEL_SESSIONS {
                if *TUNNEL_GENERATION.lock() != generation {
                    return;
                }
                match connect(&target, &credential, fingerprint.clone()).await {
                    Ok(extra) => EXTRA_SESSIONS.lock().push(Arc::new(extra.handle)),
                    // One connection is enough to work; the pool is an
                    // optimisation, not a requirement.
                    Err(_) => return,
                }
            }
        });
    }

    tokio::spawn(async move {
        let mut primary = Arc::new(pool.pop().expect("primary session").handle);
        let mut backoff = 1u64;
        let mut next = 0usize;
        loop {
            if *TUNNEL_GENERATION.lock() != generation {
                return;
            }
            let accepted = listener.accept().await;
            let Ok((mut inbound, _)) = accepted else {
                continue;
            };

            // Round-robin over the primary plus whatever extra sessions have
            // finished connecting.
            let extras = EXTRA_SESSIONS.lock().clone();
            let handle = if extras.is_empty() {
                primary.clone()
            } else {
                next = next.wrapping_add(1);
                match next % (extras.len() + 1) {
                    0 => primary.clone(),
                    index => extras[index - 1].clone(),
                }
            };

            let channel = handle
                .channel_open_direct_tcpip(
                    "127.0.0.1",
                    agent_port as u32,
                    "127.0.0.1",
                    local_port as u32,
                )
                .await;
            match channel {
                Ok(channel) => {
                    backoff = 1;
                    tokio::spawn(async move {
                        let mut stream = channel.into_stream();
                        // tokio's default copy buffer is 8 KB; at these rates
                        // that is mostly per-chunk overhead.
                        let _ = tokio::io::copy_bidirectional_with_sizes(
                            &mut inbound,
                            &mut stream,
                            256 * 1024,
                            256 * 1024,
                        )
                        .await;
                        let _ = inbound.shutdown().await;
                    });
                }
                Err(err) => {
                    // The SSH session died under us — drop the caller and
                    // rebuild it before serving anything else. Extra sessions
                    // are dropped too: they were opened with the same link.
                    let _ = inbound.shutdown().await;
                    EXTRA_SESSIONS.lock().clear();
                    set_state(TunnelState {
                        phase: TunnelPhase::Connecting,
                        local_port: Some(local_port),
                        error: Some(err.to_string()),
                        since: Some(now_secs()),
                    });
                    loop {
                        if *TUNNEL_GENERATION.lock() != generation {
                            return;
                        }
                        tokio::time::sleep(std::time::Duration::from_secs(backoff)).await;
                        backoff = (backoff * 2).min(30);
                        match connect(&target, &credential, fingerprint.clone()).await {
                            Ok(fresh) => {
                                primary = Arc::new(fresh.handle);
                                set_state(TunnelState {
                                    phase: TunnelPhase::Online,
                                    local_port: Some(local_port),
                                    error: None,
                                    since: Some(now_secs()),
                                });
                                break;
                            }
                            Err(message) => set_state(TunnelState {
                                phase: TunnelPhase::Connecting,
                                local_port: Some(local_port),
                                error: Some(message),
                                since: Some(now_secs()),
                            }),
                        }
                    }
                }
            }
        }
    });

    Ok(local_port)
}

/// Cheap liveness probe used by the UI: does the forwarded port answer at all.
pub async fn tunnel_probe() -> bool {
    let Some(port) = TUNNEL.lock().local_port else {
        return false;
    };
    tokio::net::TcpStream::connect(("127.0.0.1", port))
        .await
        .is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shell_quote_neutralises_quotes() {
        assert_eq!(shell_quote("plain"), "'plain'");
        // A password containing a quote must not be able to end the argument.
        assert_eq!(shell_quote("a'b"), r"'a'\''b'");
        // Metacharacters stay inside the quotes, so they are data, not syntax.
        assert_eq!(shell_quote("; rm -rf /"), "'; rm -rf /'");
        // Every quote in the output is either the wrapper or part of the \'\''
        // escape — never a bare one that could close the string early.
        let quoted = shell_quote("a'b'c");
        assert!(quoted.starts_with('\'') && quoted.ends_with('\''));
        assert_eq!(quoted.matches(r"'\''").count(), 2);
    }

    #[test]
    fn tunnel_base_url_is_none_while_offline() {
        set_state(TunnelState::default());
        assert!(tunnel_base_url().is_none());
        set_state(TunnelState {
            phase: TunnelPhase::Online,
            local_port: Some(41234),
            error: None,
            since: None,
        });
        assert_eq!(tunnel_base_url().as_deref(), Some("http://127.0.0.1:41234"));
        set_state(TunnelState::default());
    }

    #[test]
    fn agent_sources_are_embedded() {
        assert!(AGENT_FILES.iter().any(|(name, _)| *name == "session_io.py"));
        for (name, content) in AGENT_FILES {
            assert!(!content.is_empty(), "{name} embedded empty");
        }
        // Shipping our own fetchr-api.service would overwrite the unrelated
        // updates/licences service on the production host.
        assert!(AGENT_UNITS
            .iter()
            .all(|(name, _)| *name != "fetchr-api.service"));
    }
}
