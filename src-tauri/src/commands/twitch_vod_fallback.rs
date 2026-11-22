//! Fallback for Twitch VODs that usher refuses (HTTP 403: subscriber-only or
//! otherwise restricted). The VOD's storyboard URL (`seekPreviewsURL`) points
//! at the same CloudFront folder that holds the public variant playlists, so
//! the playlists can be addressed directly, the way TwitchDownloader does it.

/// Variant folders Twitch writes for an archived broadcast, best first.
/// `chunked` is the source rendition (1440p for Enhanced Broadcasting).
const FALLBACK_GROUPS: [&str; 8] = [
    "chunked", "1080p60", "1080p30", "720p60", "720p30", "480p30", "360p30", "160p30",
];

pub const SEEK_PREVIEWS_QUERY: &str =
    "query($id:ID!){video(id:$id){broadcastType seekPreviewsURL}}";

/// `https://host/<hash>_<login>_<id>_<ts>/storyboards/<vod>-strip-0.jpg`
/// becomes `https://host/<hash>_<login>_<id>_<ts>`.
pub fn vod_base_from_seek_previews(seek_previews_url: &str) -> Option<String> {
    let parsed = url::Url::parse(seek_previews_url.trim()).ok()?;
    if !matches!(parsed.scheme(), "https" | "http") {
        return None;
    }
    let host = parsed.host_str()?;
    let segments: Vec<&str> = parsed.path_segments()?.collect();
    let storyboard_at = segments.iter().position(|segment| *segment == "storyboards")?;
    if storyboard_at == 0 {
        return None;
    }
    let prefix = segments[..storyboard_at].join("/");
    Some(format!("{}://{host}/{prefix}", parsed.scheme()))
}

/// Highlights keep their segments under `highlight-<id>.m3u8`; archives and
/// uploads under `index-dvr.m3u8`.
fn playlist_name(vod_id: &str, broadcast_type: Option<&str>) -> String {
    match broadcast_type.map(str::to_ascii_lowercase).as_deref() {
        Some("highlight") => format!("highlight-{vod_id}.m3u8"),
        _ => "index-dvr.m3u8".to_string(),
    }
}

/// `(group, playlist url)` for every variant the VOD may have.
pub fn fallback_variant_urls(
    base: &str,
    vod_id: &str,
    broadcast_type: Option<&str>,
) -> Vec<(&'static str, String)> {
    let name = playlist_name(vod_id, broadcast_type);
    let base = base.trim_end_matches('/');
    FALLBACK_GROUPS
        .iter()
        .map(|group| (*group, format!("{base}/{group}/{name}")))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::{fallback_variant_urls, vod_base_from_seek_previews};

    const STORYBOARD: &str = "https://d1m7jfoe9zdc1j.cloudfront.net/0f1e2d3c4b5a69788796_streamer_41234567890_1700000000/storyboards/2012345678-strip-0.jpg";

    #[test]
    fn storyboard_url_gives_the_vod_folder() {
        assert_eq!(
            vod_base_from_seek_previews(STORYBOARD).as_deref(),
            Some("https://d1m7jfoe9zdc1j.cloudfront.net/0f1e2d3c4b5a69788796_streamer_41234567890_1700000000")
        );
    }

    #[test]
    fn urls_without_a_storyboard_folder_are_rejected() {
        assert_eq!(vod_base_from_seek_previews("https://host/storyboards/x.jpg"), None);
        assert_eq!(vod_base_from_seek_previews("https://host/a/b/x.jpg"), None);
        assert_eq!(vod_base_from_seek_previews("file:///a/storyboards/x.jpg"), None);
        assert_eq!(vod_base_from_seek_previews("not a url"), None);
    }

    #[test]
    fn archive_variants_start_with_the_source_rendition() {
        let urls = fallback_variant_urls("https://host/base/", "2012345678", Some("ARCHIVE"));
        assert_eq!(urls[0], ("chunked", "https://host/base/chunked/index-dvr.m3u8".to_string()));
        assert_eq!(urls[1].0, "1080p60");
        assert_eq!(urls.len(), 8);
    }

    #[test]
    fn highlights_use_their_own_playlist_name() {
        let urls = fallback_variant_urls("https://host/base", "77", Some("HIGHLIGHT"));
        assert_eq!(urls[0].1, "https://host/base/chunked/highlight-77.m3u8");
    }
}
