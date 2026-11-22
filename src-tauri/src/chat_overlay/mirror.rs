//! Emote traffic relayed through the user's own recorder agent.
//!
//! 7TV/BTTV/FFZ are routinely unreachable from the user's network (DPI,
//! throttling) while the recorder, abroad, reaches them fine. One timed-out
//! request used to cost a render every channel emote, so once a VPS is known,
//! emote metadata and images fall back to its `/mirror` endpoint.

use std::sync::RwLock;

use anyhow::{anyhow, Context, Result};

/// Hosts the agent relays. Mirrors its own allow-list; anything else is never
/// sent there.
const HOSTS: &[&str] = &[
    "7tv.io",
    "cdn.7tv.app",
    "api.betterttv.net",
    "cdn.betterttv.net",
    "cdn.frankerfacez.com",
    "static-cdn.jtvnw.net",
];

#[derive(Debug, Clone, PartialEq, Eq)]
struct Agent {
    base: String,
    token: String,
}

static AGENT: RwLock<Option<Agent>> = RwLock::new(None);

/// Remember the agent to relay through. Called wherever the app talks to it.
pub fn set_agent(base: &str, token: &str) {
    let base = base.trim_end_matches('/');
    if base.is_empty() || token.is_empty() {
        return;
    }
    if let Ok(mut slot) = AGENT.write() {
        *slot = Some(Agent {
            base: base.to_string(),
            token: token.to_string(),
        });
    }
}

fn agent() -> Option<Agent> {
    AGENT.read().ok().and_then(|slot| slot.clone())
}

fn relayable(url: &str) -> bool {
    url.strip_prefix("https://")
        .and_then(|rest| rest.split('/').next())
        .is_some_and(|host| HOSTS.contains(&host))
}

/// Whether `fetch` could be tried for `url` at all.
pub fn available_for(url: &str) -> bool {
    relayable(url) && agent().is_some()
}

/// GET `url` through the agent.
pub async fn fetch(client: &reqwest::Client, url: &str) -> Result<Vec<u8>> {
    if !relayable(url) {
        return Err(anyhow!("{url} is not relayed by the recorder"));
    }
    let agent = agent().ok_or_else(|| anyhow!("no recorder to relay through"))?;
    let relay = format!(
        "{}/mirror?url={}",
        agent.base,
        urlencoding::encode(url)
    );
    let bytes = client
        .get(&relay)
        .header("X-Token", &agent.token)
        .send()
        .await
        .with_context(|| format!("relay {url}"))?
        .error_for_status()
        .with_context(|| format!("relay {url}"))?
        .bytes()
        .await
        .with_context(|| format!("relay {url}"))?;
    Ok(bytes.to_vec())
}

#[cfg(test)]
mod tests {
    use super::relayable;

    #[test]
    fn only_emote_hosts_are_relayed() {
        assert!(relayable("https://7tv.io/v3/emote-sets/global"));
        assert!(relayable("https://cdn.7tv.app/emote/abc/2x.webp"));
        assert!(!relayable("http://7tv.io/v3/emote-sets/global"));
        assert!(!relayable("https://7tv.io.evil.example/x"));
        assert!(!relayable("https://gql.twitch.tv/gql"));
    }
}
