use std::collections::HashMap;
use std::time::Duration;

use once_cell::sync::Lazy;
use parking_lot::Mutex;
use serde_json::{json, Value};

use crate::chat_overlay::kick_live::{default_user_agent, fetch_kick_channel_json};

const TWITCH_WEB_CLIENT_ID: &str = "kimne78kx3ncx6brgo4mv6wki5h1ko";
const MAX_CHANNELS: usize = 100;
const TWITCH_BATCH: usize = 50;

static CACHE: Lazy<Mutex<HashMap<String, Option<String>>>> = Lazy::new(|| Mutex::new(HashMap::new()));

fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 40
        && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

/// Profile pictures for archive channels: `name` is Twitch, `kick:slug` is Kick.
/// Unknown platforms and failed lookups map to `None` so the UI keeps its letter.
#[tauri::command]
pub async fn channel_avatars(channels: Vec<String>) -> Result<HashMap<String, Option<String>>, String> {
    let wanted: Vec<String> = channels.into_iter().take(MAX_CHANNELS).collect();
    let cached = CACHE.lock().clone();
    let missing: Vec<&String> = wanted.iter().filter(|c| !cached.contains_key(*c)).collect();

    let twitch: Vec<String> = missing
        .iter()
        .filter(|c| !c.contains(':'))
        .map(|c| c.to_ascii_lowercase())
        .filter(|c| valid_name(c))
        .collect();
    let kick: Vec<String> = missing
        .iter()
        .filter_map(|c| c.strip_prefix("kick:"))
        .map(str::to_string)
        .filter(|c| valid_name(c))
        .collect();

    let twitch_found = fetch_twitch(&twitch).await;
    let kick_found = fetch_kick(&kick).await;

    let fresh: HashMap<String, Option<String>> = missing
        .iter()
        .map(|channel| {
            let url = match channel.strip_prefix("kick:") {
                Some(slug) => kick_found.get(slug).cloned().flatten(),
                None if channel.contains(':') => None,
                None => twitch_found.get(&channel.to_ascii_lowercase()).cloned().flatten(),
            };
            ((*channel).clone(), url)
        })
        .collect();
    {
        let mut cache = CACHE.lock();
        for (key, url) in &fresh {
            // Remember misses only when the lookup itself answered, so a network blip retries later.
            if url.is_some() || !(twitch_found.is_empty() && kick_found.is_empty()) {
                cache.insert(key.clone(), url.clone());
            }
        }
    }

    Ok(wanted
        .into_iter()
        .map(|c| {
            let url = fresh.get(&c).cloned().or_else(|| cached.get(&c).cloned()).flatten();
            (c, url)
        })
        .collect())
}

async fn fetch_twitch(logins: &[String]) -> HashMap<String, Option<String>> {
    let Ok(client) = reqwest::Client::builder().timeout(Duration::from_secs(8)).build() else {
        return HashMap::new();
    };
    let mut found = HashMap::new();
    for chunk in logins.chunks(TWITCH_BATCH) {
        let payload = json!({
            "query": "query($logins:[String!]){users(logins:$logins){login profileImageURL(width:70)}}",
            "variables": { "logins": chunk },
        });
        let response = client
            .post("https://gql.twitch.tv/gql")
            .header("Client-ID", TWITCH_WEB_CLIENT_ID)
            .json(&payload)
            .send()
            .await;
        let Ok(body) = (match response {
            Ok(resp) => resp.json::<Value>().await,
            Err(err) => Err(err),
        }) else {
            tracing::info!("channel_avatars: Twitch lookup failed");
            continue;
        };
        for login in chunk {
            found.insert(login.clone(), None);
        }
        let users = body.pointer("/data/users").and_then(Value::as_array).cloned().unwrap_or_default();
        for user in users {
            let login = user.get("login").and_then(Value::as_str);
            let url = user.get("profileImageURL").and_then(Value::as_str);
            if let (Some(login), Some(url)) = (login, url) {
                found.insert(login.to_ascii_lowercase(), Some(url.to_string()));
            }
        }
    }
    found
}

async fn fetch_kick(slugs: &[String]) -> HashMap<String, Option<String>> {
    let agent = default_user_agent();
    let lookups = slugs.iter().map(|slug| {
        let agent = agent.clone();
        async move {
            let result = fetch_kick_channel_json(slug, None, &agent).await;
            (slug.clone(), result)
        }
    });
    futures::future::join_all(lookups)
        .await
        .into_iter()
        .filter_map(|(slug, result)| {
            let value = result.ok()?;
            let url = value
                .pointer("/user/profile_pic")
                .or_else(|| value.pointer("/user/profilepic"))
                .and_then(Value::as_str)
                .filter(|u| u.starts_with("https://"))
                .map(str::to_string);
            Some((slug, url))
        })
        .collect()
}
