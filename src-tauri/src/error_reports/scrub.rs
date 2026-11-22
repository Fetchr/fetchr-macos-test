//! Strips personal data out of error text before it leaves the machine, and
//! reduces a message to the shape that identifies the error rather than the
//! occurrence (so one bug with many file names still lands in one group).
//!
//! Anything that could name the user, their files, streams or network is
//! replaced: paths (with spaces, quoted, escaped, UNC), URLs and proxy
//! credentials, addresses, ids, tokens, and the account and computer names
//! themselves as a last line of defence.

use once_cell::sync::Lazy;
use regex::{Captures, Regex};
use sha2::{Digest, Sha256};

pub const MAX_MESSAGE_CHARS: usize = 600;
pub const MAX_LINE_CHARS: usize = 300;
/// Input beyond this is cut before any pattern runs over it.
const MAX_INPUT_CHARS: usize = 8_000;

/// Header values run to the end of the line: a cookie holds several secrets.
static HEADER_SECRET: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r#"(?i)\b(proxy-authorization|authorization|set-cookie|cookie)\b\s*[:=]\s*[^\r\n"']*"#).unwrap()
});
static BEARER: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?i)\bbearer\s+[a-z0-9._~+/=-]+").unwrap());
/// `token=short` and `"password": "x"`: too short for `TOKEN_CANDIDATE` to see.
static KEY_VALUE_SECRET: Lazy<Regex> = Lazy::new(|| {
    Regex::new(
        r#"(?i)\b(access[_-]?token|refresh[_-]?token|auth[_-]?token|client[_-]?secret|api[_-]?key|x-api-key|password|passwd|pwd|secret|signature|sig|token)\b(["']?\s*[:=]\s*["']?)[^\s"'&,;<][^\s"'&,;]*"#,
    )
    .unwrap()
});
/// "session: started" is a log line; "session=abc" is a value.
static SESSION_VALUE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r#"(?i)\b(session(?:_?id)?|sid)=[^\s"'&,;<][^\s"'&,;]*"#).unwrap());
/// A URL written without its scheme keeps its host and path, not its query.
static QUERY_WITHOUT_SCHEME: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r#"(?i)\b((?:[a-z0-9-]+\.)+[a-z]{2,}/[^\s"'<>?]*)\?[^\s"'<>]+"#).unwrap()
});
static LICENSE_KEY: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"\b(?:FTR1|SCB1)\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+").unwrap());
static CONTROL: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]").unwrap());
static URL: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r#"(?i)\b[a-z][a-z0-9+.-]{1,15}://[^\s"'<>()]+"#).unwrap()
});
/// `user:pass@host` without a scheme, as proxies are often written.
static CREDENTIALS: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r#"(?i)[^\s:@/"'<>]+:[^\s@/"'<>]+@(\[[0-9a-f:]+\]|[a-z0-9.-]+)"#).unwrap()
});
static QUOTED: Lazy<Regex> =
    Lazy::new(|| Regex::new(r#""[^"\r\n]*"|'[^'\r\n]*'|«[^»\r\n]*»|`[^`\r\n]*`"#).unwrap());
/// Where a Windows path starts: a drive (optionally `\\?\`-prefixed), a UNC
/// share, or a profile directory written without its drive.
static WINDOWS_PATH_START: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?i)(?:\\\\\?\\)?\b[a-z]:[\\/]+|\\\\[^\\\s]+\\+|\\+(?:users|documents and settings)\\+")
        .unwrap()
});
static DRIVE: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?i)\b[a-z]:[\\/]+").unwrap());
static UNIX_PATH: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r#"(?:^|[\s"'(=])(/(?:[^/\s"'<>]+/)+[^/\s"'<>]*)"#).unwrap()
});
static FILE_EXTENSION: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"\.[A-Za-z][A-Za-z0-9]{0,4}").unwrap());
static EMAIL: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?i)\b[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}\b").unwrap());
static UUID: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?i)\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b").unwrap()
});
static IPV6: Lazy<Regex> = Lazy::new(|| {
    Regex::new(
        // Compressed form first: the full form would stop at the `::`.
        r"(?i)\b(?:[0-9a-f]{1,4}:){1,7}:(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4}){0,6})?|\b(?:[0-9a-f]{1,4}:){3,7}[0-9a-f]{1,4}\b",
    )
    .unwrap()
});
static IPV4: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b").unwrap());
/// `[youtube] dQw4w9WgXcQ:` / `[twitch:vod] v123:` — the id says what the
/// user was downloading.
static EXTRACTOR_ID: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"\[([A-Za-z0-9:_ -]{2,30})\]\s+([^\s:\[\]]+):").unwrap()
});
static TOKEN_CANDIDATE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"[A-Za-z0-9_+=/-]{20,}").unwrap());

static DIGITS: Lazy<Regex> = Lazy::new(|| Regex::new(r"\d+").unwrap());
static SPACES: Lazy<Regex> = Lazy::new(|| Regex::new(r"\s+").unwrap());

/// The account, profile folder and computer name, matched anywhere: if a
/// path slips past the patterns above, the name in it still does not.
static IDENTITY: Lazy<Option<Regex>> = Lazy::new(|| {
    let mut names: Vec<String> = ["USERNAME", "COMPUTERNAME", "USER", "HOSTNAME"]
        .iter()
        .filter_map(|var| std::env::var(var).ok())
        .collect();
    if let Ok(profile) = std::env::var("USERPROFILE") {
        if let Some(leaf) = std::path::Path::new(&profile).file_name() {
            names.push(leaf.to_string_lossy().into_owned());
        }
    }
    let escaped: Vec<String> = names
        .into_iter()
        .map(|name| name.trim().to_string())
        .filter(|name| name.chars().count() >= 3)
        .map(|name| regex::escape(&name))
        .collect();
    if escaped.is_empty() {
        return None;
    }
    Regex::new(&format!("(?i){}", escaped.join("|"))).ok()
});

/// Hosts that serve the app itself: their paths point into the bundle, which
/// is what a frontend stack trace needs, and carry nothing about the user.
const APP_HOSTS: &[&str] = &["localhost", "127.0.0.1", "tauri.localhost", "ipc.localhost"];

/// Removes paths, URLs, credentials, addresses, ids and secrets, and caps
/// the length.
pub fn scrub(text: &str, max_chars: usize) -> String {
    let text: String = text.chars().take(MAX_INPUT_CHARS).collect();
    // `{path:?}` and JSON double every separator; the path patterns accept
    // runs of them instead of rewriting the text, which would turn a UNC
    // share into something that no longer looks like one.
    let text = CONTROL.replace_all(&text, "");
    let text = URL.replace_all(&text, |caps: &Captures| redact_url(&caps[0]));
    let text = HEADER_SECRET.replace_all(&text, "$1: <secret>");
    let text = BEARER.replace_all(&text, "<secret>");
    let text = KEY_VALUE_SECRET.replace_all(&text, "$1$2<secret>");
    let text = SESSION_VALUE.replace_all(&text, "$1=<secret>");
    let text = QUERY_WITHOUT_SCHEME.replace_all(&text, "$1?<query>");
    let text = LICENSE_KEY.replace_all(&text, "<license>");
    let text = CREDENTIALS.replace_all(&text, |caps: &Captures| format!("<credentials>@{}", &caps[1]));
    let text = QUOTED.replace_all(&text, |caps: &Captures| redact_quoted(&caps[0]));
    let text = redact_windows_paths(&text);
    let text = UNIX_PATH.replace_all(&text, |caps: &Captures| {
        let whole = &caps[0];
        let path = &caps[1];
        format!("{}{}", &whole[..whole.len() - path.len()], redact_path(path))
    });
    let text = match IDENTITY.as_ref() {
        Some(identity) => identity.replace_all(&text, "<user>").into_owned(),
        None => text.into_owned(),
    };
    let text = EMAIL.replace_all(&text, "<email>");
    let text = UUID.replace_all(&text, "<id>");
    let text = IPV6.replace_all(&text, |caps: &Captures| {
        let found = &caps[0];
        if found.chars().any(|ch| ch.is_ascii_digit()) {
            "<ip>".to_string()
        } else {
            found.to_string()
        }
    });
    let text = IPV4.replace_all(&text, "<ip>");
    let text = EXTRACTOR_ID.replace_all(&text, |caps: &Captures| {
        let id = &caps[2];
        // yt-dlp's own words ("[download] Destination:") are not ids.
        let is_word = id.chars().next().is_some_and(char::is_uppercase)
            && id.chars().all(char::is_alphabetic);
        if is_word {
            caps[0].to_string()
        } else {
            format!("[{}] <id>:", &caps[1])
        }
    });
    let text = TOKEN_CANDIDATE.replace_all(&text, |caps: &Captures| {
        let found = &caps[0];
        if looks_like_token(found) {
            "<token>".to_string()
        } else {
            found.to_string()
        }
    });
    truncate(text.trim(), max_chars)
}

/// For lines from external tools: whatever they quote is usually a stream
/// title, a channel or a file name, so quoted text is dropped (placeholders
/// the scrubber already put there stay).
pub fn mask_quoted(scrubbed: &str) -> String {
    QUOTED
        .replace_all(scrubbed, |caps: &Captures| {
            let quoted = &caps[0];
            let inner_starts_with_placeholder = quoted.chars().nth(1) == Some('<');
            if inner_starts_with_placeholder {
                quoted.to_string()
            } else {
                "<q>".to_string()
            }
        })
        .into_owned()
}

/// The part of a scrubbed message that stays the same between occurrences
/// of one error: numbers and quoted values are placeholders.
pub fn shape(scrubbed: &str) -> String {
    let lower = scrubbed.to_lowercase();
    let text = QUOTED.replace_all(&lower, "<q>");
    let text = DIGITS.replace_all(&text, "#");
    SPACES.replace_all(text.trim(), " ").into_owned()
}

/// Stable group id: the same bug gives the same fingerprint on every machine
/// and every run.
pub fn fingerprint(source: &str, code: &str, shaped: &str) -> String {
    let digest = Sha256::digest(format!("{source}|{code}|{shaped}").as_bytes());
    hex::encode(&digest[..16])
}

/// Keys and session ids mix letters and digits; code identifiers such as
/// `anti_copyright_wav_blocking` do not, and stay readable.
fn looks_like_token(candidate: &str) -> bool {
    let digits = candidate.chars().filter(char::is_ascii_digit).count();
    let letters = candidate.chars().filter(char::is_ascii_alphabetic).count();
    (digits >= 2 && letters >= 2) || candidate.len() >= 40
}

fn redact_url(url: &str) -> String {
    let Ok(parsed) = url::Url::parse(url) else {
        return "<url>".to_string();
    };
    let Some(host) = parsed.host_str() else {
        return "<url>".to_string();
    };
    if APP_HOSTS.contains(&host) {
        // Line and column of a bundle frame survive; queries never do.
        return format!("app:{}", parsed.path());
    }
    format!("<url:{host}>")
}

/// A quoted value that holds a path is replaced whole, spaces and all.
fn redact_quoted(quoted: &str) -> String {
    let open = quoted.chars().next().unwrap_or('"');
    let close = quoted.chars().last().unwrap_or('"');
    let inner = &quoted[open.len_utf8()..quoted.len() - close.len_utf8()];
    let is_path = WINDOWS_PATH_START.is_match(inner)
        || inner.starts_with('/') && inner[1..].contains('/');
    if is_path {
        format!("{open}{}{close}", redact_path(inner))
    } else {
        quoted.to_string()
    }
}

/// Unquoted Windows paths. Directory names may contain spaces ("WW кризис"),
/// so a path runs to its last separator on the line; the file name after it
/// ends with its extension ("Streamer Name - Big Final.mp4"), or at the
/// first space when it has none.
fn redact_windows_paths(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut cursor = 0;
    while let Some(found) = WINDOWS_PATH_START.find_at(text, cursor) {
        out.push_str(&text[cursor..found.start()]);
        let end = path_end(text, found.end());
        out.push_str(&redact_path(&text[found.start()..end]));
        cursor = end;
    }
    out.push_str(&text[cursor..]);
    out
}

fn path_end(text: &str, from: usize) -> usize {
    let rest = &text[from..];
    let mut limit = rest
        .find(['\r', '\n', '"', '\'', '<', '>', '|', '*', '?', '`', '«', '»'])
        .unwrap_or(rest.len());
    // A second path on the same line starts a new match.
    if let Some(next) = DRIVE.find(&rest[..limit]) {
        limit = next.start();
    }
    let region = &rest[..limit];
    let name_start = region.rfind(['\\', '/']).map(|index| index + 1).unwrap_or(0);
    let name = &region[name_start..];
    for extension in FILE_EXTENSION.find_iter(name) {
        let after = name[extension.end()..].chars().next();
        if after.is_none_or(|ch| ch.is_whitespace() || ",;:)]".contains(ch)) {
            return from + name_start + extension.end();
        }
    }
    let first_space = name.find(char::is_whitespace).unwrap_or(name.len());
    from + name_start + first_space
}

fn redact_path(path: &str) -> String {
    let trimmed = path.trim_end_matches([',', ';', ':', ')', ']', '.', ' ']);
    let file = trimmed.rsplit(['\\', '/']).next().unwrap_or("");
    match file.rfind('.') {
        Some(dot)
            if (2..=6).contains(&(file.len() - dot))
                && file[dot + 1..].chars().all(|ch| ch.is_ascii_alphanumeric())
                && file[dot + 1..].chars().next().is_some_and(|ch| ch.is_ascii_alphabetic()) =>
        {
            format!("<path>.{}", file[dot + 1..].to_lowercase())
        }
        _ => "<path>".to_string(),
    }
}

fn truncate(text: &str, max_chars: usize) -> String {
    if text.chars().count() <= max_chars {
        return text.to_string();
    }
    let mut cut: String = text.chars().take(max_chars).collect();
    cut.push('…');
    cut
}

#[cfg(test)]
mod tests {
    #[test]
    fn secrets_in_headers_and_parameters_are_removed() {
        for (line, leak) in [
            ("Authorization: Bearer abc.def", "abc.def"),
            ("Cookie: auth-token=one; persistent=two", "two"),
            ("--add-header Cookie:a=one;b=two", "one"),
            ("got token=short now", "short"),
            (r#"{"password": "hunter2"}"#, "hunter2"),
            ("fetch usher.ttvnw.net/vod/x.m3u8?sig=abc&token=def", "def"),
            ("key FTR1.eyJwYXlsb2Fk.c2lnbmF0dXJl", "eyJwYXlsb2Fk"),
            ("old SCB1.eyJwYXlsb2Fk.c2lnbmF0dXJl", "eyJwYXlsb2Fk"),
        ] {
            let scrubbed = scrub(line, 600);
            assert!(!scrubbed.contains(leak), "{line} -> {scrubbed}");
        }
    }

    #[test]
    fn ordinary_words_near_secrets_survive() {
        assert_eq!(scrub("tokenizer failed to load", 600), "tokenizer failed to load");
        assert_eq!(scrub("session: started", 600), "session: started");
        assert_eq!(scrub("session=abc", 600), "session=<secret>");
    }

    use super::*;

    #[test]
    fn paths_with_spaces_and_cyrillic_are_removed_but_keep_the_extension() {
        let text = r"open extracted WAV C:\Рачел\WW кризис\мут_fetchr_mute.wav: access denied";
        assert_eq!(scrub(text, 600), "open extracted WAV <path>.wav: access denied");
        let profile = r"model missing: C:\Users\Bob Smith\AppData\Local\Fetchr\models\kim_inst.onnx";
        assert_eq!(scrub(profile, 600), "model missing: <path>.onnx");
    }

    #[test]
    fn file_names_with_spaces_do_not_leak() {
        let text = r"cannot open C:\Streams\Streamer Name - Big Final.mp4 for reading";
        assert_eq!(scrub(text, 600), "cannot open <path>.mp4 for reading");
        let quoted = r"failed on 'D:\Видео\мой стрим с друзьями.mkv' twice";
        assert_eq!(scrub(quoted, 600), "failed on '<path>.mkv' twice");
    }

    #[test]
    fn debug_formatted_and_json_escaped_paths_are_removed() {
        let debug = r#"Failed to open "C:\\Users\\Bob Smith\\Videos\\clip one.mp4": denied"#;
        assert_eq!(scrub(debug, 600), r#"Failed to open "<path>.mp4": denied"#);
    }

    #[test]
    fn unc_verbatim_and_driveless_profile_paths_are_removed() {
        assert_eq!(
            scrub(r"missing \\nas\share\Bob Smith\clip one.mp4 now", 600),
            "missing <path>.mp4 now"
        );
        assert_eq!(scrub(r"read \\?\C:\Users\Bob\file name.mkv", 600), "read <path>.mkv");
        assert_eq!(scrub(r"in \Users\Bob Smith\notes.txt", 600), "in <path>.txt");
    }

    #[test]
    fn urls_keep_only_the_host_and_drop_embedded_credentials() {
        let text = "proxy http://user:secret@10.0.0.2:8080/x failed for https://usher.ttvnw.net/api/channel/hls/somebody.m3u8?sig=abc"; // secret-scan: allow
        let clean = scrub(text, 600);
        assert!(!clean.contains("secret"), "{clean}");
        assert!(!clean.contains("somebody"), "{clean}");
        assert!(clean.contains("<url:usher.ttvnw.net>"), "{clean}");
        let socks = scrub("socks5://alice:hunter2@1.2.3.4:1080 refused", 600); // secret-scan: allow
        assert!(!socks.contains("hunter2") && !socks.contains("alice"), "{socks}");
        let bare = scrub("proxy alice:hunter2@10.0.0.1:1080 refused", 600);
        assert!(!bare.contains("hunter2") && !bare.contains("alice"), "{bare}");
    }

    #[test]
    fn app_bundle_frames_stay_readable() {
        let frame = "at render (http://127.0.0.1:1420/src/ui/Page.tsx?t=123:45:12)";
        assert_eq!(scrub(frame, 600), "at render (app:/src/ui/Page.tsx)");
    }

    #[test]
    fn secrets_addresses_and_ids_are_masked() {
        let text = "token ghp_0123456789abcdefghijklmnopqrstuvwxyzAB from 192.168.1.20:22 job 3f2b8c1e-9a7d-4c3e-8f1a-2b3c4d5e6f70 mail a.b@example.com";
        let clean = scrub(text, 600);
        assert_eq!(clean, "token <token> from <ip> job <id> mail <email>");
        let oauth = scrub("oauth kd8f9s7d6f5g4h3j2k1l0z9x8c7v6b refused", 600);
        assert_eq!(oauth, "oauth <token> refused");
        let v6 = scrub("USER-IP=2a02:6b8:0:1::1f and fe80:0:0:0:1:2:3:4", 600);
        assert_eq!(v6, "USER-IP=<ip> and <ip>");
    }

    #[test]
    fn code_identifiers_and_times_survive() {
        let text = "anti_copyright_wav_blocking failed at 12:34:56 in fetchr_lib::jobs";
        assert_eq!(scrub(text, 600), text);
    }

    #[test]
    fn downloader_ids_are_masked_but_its_words_are_not() {
        assert_eq!(
            scrub("ERROR: [youtube] dQw4w9WgXcQ: Video unavailable", 600),
            "ERROR: [youtube] <id>: Video unavailable"
        );
        assert_eq!(
            scrub("[twitch:stream] somechannel: The channel is not live", 600),
            "[twitch:stream] <id>: The channel is not live"
        );
        assert_eq!(scrub("[download] Destination: x", 600), "[download] Destination: x");
    }

    #[test]
    fn terminal_control_sequences_are_stripped() {
        assert_eq!(scrub("bad \u{1b}]52;c;ZXZpbA==\u{7}input", 600), "bad ]52;c;ZXZpbA==input");
    }

    #[test]
    fn quoted_titles_in_tool_output_are_dropped_but_placeholders_stay() {
        let line = scrub(r#"ERROR: unable to download "Мой стрим 18+" to 'C:\a\b.mp4'"#, 600);
        assert_eq!(mask_quoted(&line), "ERROR: unable to download <q> to '<path>.mp4'");
    }

    #[test]
    fn unix_paths_are_removed() {
        assert_eq!(
            scrub("cannot read /home/alice/Videos/stream.mkv now", 600),
            "cannot read <path>.mkv now"
        );
    }

    #[test]
    fn long_text_is_capped() {
        let clean = scrub(&"x ".repeat(1000), 50);
        assert_eq!(clean.chars().count(), 51);
    }

    #[test]
    fn occurrences_of_one_error_share_a_fingerprint() {
        let a = shape(&scrub(r"ffmpeg exited with code 1 after 12.5 s on 'C:\a\b.mp4'", 600));
        let b = shape(&scrub(r"ffmpeg exited with code 1 after 97.0 s on 'D:\x y\z.mp4'", 600));
        assert_eq!(a, b);
        assert_eq!(
            fingerprint("log", "log.command_finished", &a),
            fingerprint("log", "log.command_finished", &b)
        );
        let other = shape("ffmpeg could not find an encoder");
        assert_ne!(
            fingerprint("log", "log.command_finished", &a),
            fingerprint("log", "log.command_finished", &other)
        );
    }
}
