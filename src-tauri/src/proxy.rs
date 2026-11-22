use serde::{Deserialize, Serialize};
use tokio::process::Command;

/// Proxy configuration normalised into an explicit scheme.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ProxyConfig {
    pub enabled: bool,
    /// Raw URL as provided by the user: e.g. "127.0.0.1:2080", "http://...",
    /// "socks5://...", "socks5h://user:pass@host:port".
    pub url: String,
}

impl ProxyConfig {
    /// Return an absolute proxy URL with explicit scheme, suitable for passing to
    /// yt-dlp, N_m3u8DL-RE and environment variables.
    ///
    /// Rules:
    /// - If url is empty or proxy is disabled → None.
    /// - If scheme is missing → default to "http://".
    /// - Accept http, https, socks4, socks5, socks5h as known schemes.
    pub fn resolved(&self) -> Option<String> {
        if !self.enabled {
            return None;
        }
        let raw = self.url.trim();
        if raw.is_empty() {
            return None;
        }
        Some(with_scheme(raw))
    }

    /// The proxy a child process has to tunnel through: the explicit setting,
    /// else whatever the OS is configured with. yt-dlp discovers the OS proxy on
    /// its own, ffmpeg never does — so a `--download-sections` job (ffmpeg is the
    /// downloader there) went direct and died on the TLS handshake wherever the
    /// direct route is blocked.
    pub fn effective(&self) -> Option<String> {
        self.resolved().or_else(system_proxy)
    }

    /// Translate the proxy URL into the form yt-dlp expects for `--proxy`.
    /// yt-dlp natively supports socks5://, so we pass it through unchanged.
    pub fn for_ytdlp(&self) -> Option<String> {
        self.resolved()
    }

    /// N_m3u8DL-RE expects http(s) proxy only. For socks5 we return the URL
    /// unchanged — the latest versions understand it; older versions will
    /// simply ignore and the caller should fall back to yt-dlp for the
    /// segment fetch.
    pub fn for_n_m3u8dl(&self) -> Option<String> {
        self.resolved()
    }
}

/// Export `proxy` the way ffmpeg and yt-dlp read it from the environment. Both
/// spellings: ffmpeg looks up the lowercase name, Windows does not care. ffmpeg
/// tunnels through `http://` proxies only and silently ignores anything else.
pub fn apply_proxy_env(cmd: &mut Command, proxy: &str) {
    for key in ["http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY"] {
        cmd.env(key, proxy);
    }
}

/// Proxy the OS is configured with: the `*_PROXY` environment variables first
/// (what every tool agrees on), then the Windows "Internet Settings" proxy that
/// VPN/proxy clients switch on system-wide.
pub fn system_proxy() -> Option<String> {
    env_proxy().or_else(windows_internet_settings_proxy)
}

fn env_proxy() -> Option<String> {
    ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"]
        .into_iter()
        .filter_map(|key| std::env::var(key).ok())
        .map(|value| value.trim().to_string())
        .find(|value| !value.is_empty())
        .map(|value| with_scheme(&value))
}

#[cfg(windows)]
fn windows_internet_settings_proxy() -> Option<String> {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;

    let key = RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey(r"Software\Microsoft\Windows\CurrentVersion\Internet Settings")
        .ok()?;
    let enabled: u32 = key.get_value("ProxyEnable").ok()?;
    if enabled == 0 {
        return None;
    }
    let server: String = key.get_value("ProxyServer").ok()?;
    parse_internet_settings_proxy(&server)
}

#[cfg(not(windows))]
fn windows_internet_settings_proxy() -> Option<String> {
    None
}

/// `ProxyServer` is either `host:port` (one proxy for every protocol) or a
/// `scheme=host:port;…` list. Windows means an HTTP proxy unless the entry says
/// otherwise, so a SOCKS-only list yields nothing — ffmpeg could not use it.
fn parse_internet_settings_proxy(value: &str) -> Option<String> {
    let value = value.trim();
    if value.is_empty() {
        return None;
    }
    if !value.contains('=') {
        return Some(with_scheme(value));
    }
    let entries: Vec<(&str, &str)> = value
        .split(';')
        .filter_map(|entry| entry.split_once('='))
        .map(|(scheme, target)| (scheme.trim(), target.trim()))
        .filter(|(_, target)| !target.is_empty())
        .collect();
    ["https", "http"].iter().find_map(|wanted| {
        entries
            .iter()
            .find(|(scheme, _)| scheme.eq_ignore_ascii_case(wanted))
            .map(|(_, target)| with_scheme(target))
    })
}

fn with_scheme(raw: &str) -> String {
    if raw.contains("://") {
        raw.to_string()
    } else {
        format!("http://{raw}")
    }
}

#[cfg(test)]
mod tests {
    use super::parse_internet_settings_proxy;

    #[test]
    fn single_entry_gets_http_scheme() {
        assert_eq!(
            parse_internet_settings_proxy("127.0.0.1:10809").as_deref(),
            Some("http://127.0.0.1:10809")
        );
    }

    #[test]
    fn per_protocol_list_prefers_https_entry() {
        assert_eq!(
            parse_internet_settings_proxy("http=10.0.0.1:3128;https=10.0.0.2:3129;ftp=x:1")
                .as_deref(),
            Some("http://10.0.0.2:3129")
        );
        assert_eq!(
            parse_internet_settings_proxy("http=10.0.0.1:3128").as_deref(),
            Some("http://10.0.0.1:3128")
        );
    }

    #[test]
    fn socks_only_or_empty_is_none() {
        assert_eq!(parse_internet_settings_proxy("socks=127.0.0.1:1080"), None);
        assert_eq!(parse_internet_settings_proxy("  "), None);
    }
}
