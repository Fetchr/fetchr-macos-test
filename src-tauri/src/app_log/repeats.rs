//! Collapses runs of the same process line in the log file.
//!
//! ffmpeg reading a damaged h264 stream prints "Invalid NAL unit size (N > N)"
//! and friends for every packet: one render left 38 000 records (8.6 MB) that
//! said nothing after the first few. Lines are compared with their numbers
//! masked; past `KEEP_PER_LINE` copies the rest are only counted, and the count
//! is written when the job's command finishes.

use std::collections::HashMap;

pub const KEEP_PER_LINE: u32 = 5;
const MAX_TRACKED: usize = 20_000;

#[derive(Default)]
pub struct RepeatFilter {
    seen: HashMap<(String, String), Seen>,
}

struct Seen {
    sample: String,
    count: u32,
}

/// What became of the lines suppressed for one job.
#[derive(Debug, PartialEq, Eq)]
pub struct Suppressed {
    pub sample: String,
    pub dropped: u32,
}

impl RepeatFilter {
    /// `true` when this line should be written.
    pub fn admit(&mut self, job_id: &str, text: &str) -> bool {
        if self.seen.len() >= MAX_TRACKED {
            self.seen.clear();
        }
        let entry = self
            .seen
            .entry((job_id.to_string(), mask_numbers(text)))
            .or_insert_with(|| Seen {
                sample: text.to_string(),
                count: 0,
            });
        entry.count += 1;
        entry.count <= KEEP_PER_LINE
    }

    /// Forget the job's lines, returning those that went over the limit.
    pub fn finish_job(&mut self, job_id: &str) -> Vec<Suppressed> {
        let keys: Vec<_> = self
            .seen
            .keys()
            .filter(|(job, _)| job == job_id)
            .cloned()
            .collect();
        let mut out: Vec<Suppressed> = keys
            .into_iter()
            .filter_map(|key| self.seen.remove(&key))
            .filter(|seen| seen.count > KEEP_PER_LINE)
            .map(|seen| Suppressed {
                sample: seen.sample,
                dropped: seen.count - KEEP_PER_LINE,
            })
            .collect();
        out.sort_by(|a, b| b.dropped.cmp(&a.dropped));
        out
    }
}

/// Numbers and hex addresses (`0x1fa`, `000001ab`) become `#`; words stay.
fn mask_numbers(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut word = String::new();
    for ch in text.chars().chain(std::iter::once(' ')) {
        if ch.is_ascii_alphanumeric() {
            word.push(ch);
            continue;
        }
        out.push_str(&mask_word(&word));
        word.clear();
        out.push(ch);
    }
    out.pop();
    out
}

fn mask_word(word: &str) -> String {
    let hex = word.strip_prefix("0x").unwrap_or(word);
    if !hex.is_empty()
        && hex.chars().all(|c| c.is_ascii_hexdigit())
        && word.chars().any(|c| c.is_ascii_digit())
    {
        return "#".to_string();
    }
    let mut out = String::with_capacity(word.len());
    for ch in word.chars() {
        if !ch.is_ascii_digit() {
            out.push(ch);
        } else if !out.ends_with('#') {
            out.push('#');
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn repeats_past_the_limit_are_counted_not_written() {
        let mut filter = RepeatFilter::default();
        let written = (0..40)
            .filter(|i| filter.admit("job", &format!("[h264 @ 0x{i:x}a] Invalid NAL unit size ({i} > 9)")))
            .count();
        assert_eq!(written, KEEP_PER_LINE as usize);
        assert!(filter.admit("job", "a different line"));
        assert!(filter.admit("other-job", "[h264 @ 0x1a] Invalid NAL unit size (1 > 9)"));

        let suppressed = filter.finish_job("job");
        assert_eq!(suppressed.len(), 1);
        assert_eq!(suppressed[0].dropped, 40 - KEEP_PER_LINE);
        assert!(filter.finish_job("job").is_empty());
        assert!(filter.admit("job", "[h264 @ 0x1a] Invalid NAL unit size (1 > 9)"));
    }

    #[test]
    fn words_with_hex_letters_are_not_masked() {
        assert_eq!(mask_numbers("decoder face 12 at 0x1f"), "decoder face # at #");
        assert_eq!(mask_numbers("[h264 @ 000001ab] seg12.ts"), "[h# @ #] seg#.ts");
    }
}
