pub const APP_CHANNEL: &str = "beta";
/// SHA-256 of the leaf certificate fetchr.fun serves.
///
/// Let's Encrypt issues a fresh certificate roughly every 60 days, and this
/// hash covers the whole certificate — serial and validity included — so it
/// changes on every renewal and has to be updated in the next build. Extra
/// pins can be supplied at build time via `FETCHR_TLS_CERT_SHA256_PINS`, which
/// is how a renewal can be rolled out ahead of time: ship both the current and
/// the upcoming fingerprint.
const FETCHR_TLS_CERT_SHA256: &str =
    "BF4541F4CF48CD8F2C03E5E1B3EFF0027B93F489F0DA0CA9ADD4011489868FA3";

/// SHA-256 of fetchr.fun's SubjectPublicKeyInfo. The server renews its
/// certificate with this same key, so unlike the certificate hash above this
/// pin survives renewals. Extra key pins: `FETCHR_TLS_SPKI_SHA256_PINS`.
const FETCHR_TLS_SPKI_SHA256: &str =
    "999EF653485127F3A6038613DFAD0CE82BCDFFC7D9A91CDE204D1BDBA3C8B76C";

use std::time::Duration;

use sha2::{Digest, Sha256};

pub fn api_base_url() -> Option<String> {
    option_env!("FETCHR_VPS_API_URL")
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.trim_end_matches('/').to_string())
}

pub fn telegram_bot_name() -> Option<String> {
    option_env!("FETCHR_TG_BETA_BOT")
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| {
            value
                .trim_start_matches("https://t.me/")
                .trim_start_matches('@')
                .trim_matches('/')
                .to_string()
        })
        .filter(|value| !value.is_empty())
        .or_else(|| Some("fetchr_beta_bot".to_string()))
}

pub fn app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

pub fn join_api_url(path: &str) -> Option<String> {
    let base = api_base_url()?;
    Some(format!("{base}/{}", path.trim_start_matches('/')))
}

pub fn secure_client(timeout: Duration) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(timeout)
        .tls_info(true)
        .build()
        .map_err(|err| format!("Could not create secure VPS client: {err}"))
}

pub fn verify_tls_pin(response: &reqwest::Response) -> Result<(), String> {
    let Some(api_base) = api_base_url() else {
        return Ok(());
    };
    let Ok(api_url) = url::Url::parse(&api_base) else {
        return Ok(());
    };
    if api_url.scheme() != "https" {
        return Ok(());
    }

    // A redirect to another host (or a downgrade to plain http) would hand the
    // answer to a server whose certificate is never checked against the pin.
    let response_url = response.url();
    if response_url.scheme() != "https" || response_url.host_str() != api_url.host_str() {
        return Err("Secure VPS check failed: request was redirected away from the API host.".to_string());
    }

    let Some(tls_info) = response.extensions().get::<reqwest::tls::TlsInfo>() else {
        return Err("Secure VPS check failed: TLS certificate info is unavailable.".to_string());
    };
    let Some(peer_certificate) = tls_info.peer_certificate() else {
        return Err("Secure VPS check failed: server certificate is unavailable.".to_string());
    };

    let actual = hex::encode_upper(Sha256::digest(peer_certificate));
    if tls_cert_pins()
        .iter()
        .any(|pin| pin.eq_ignore_ascii_case(&actual))
    {
        return Ok(());
    }
    if let Some(spki) = crate::tls_pin::spki_der(peer_certificate) {
        let key = hex::encode_upper(Sha256::digest(spki));
        if tls_spki_pins().iter().any(|pin| pin.eq_ignore_ascii_case(&key)) {
            return Ok(());
        }
    }

    Err(
        "Secure VPS check failed: server certificate fingerprint does not match Fetchr pin."
            .to_string(),
    )
}

fn tls_cert_pins() -> Vec<String> {
    pins_with_extra(FETCHR_TLS_CERT_SHA256, option_env!("FETCHR_TLS_CERT_SHA256_PINS"))
}

fn tls_spki_pins() -> Vec<String> {
    pins_with_extra(FETCHR_TLS_SPKI_SHA256, option_env!("FETCHR_TLS_SPKI_SHA256_PINS"))
}

fn pins_with_extra(builtin: &str, extra: Option<&str>) -> Vec<String> {
    let mut pins = vec![builtin.to_string()];
    if let Some(extra) = extra {
        pins.extend(
            extra
                .split([',', ';', ' ', '\n', '\r', '\t'])
                .map(str::trim)
                .filter(|pin| !pin.is_empty())
                .map(ToOwned::to_owned),
        );
    }
    pins
}
