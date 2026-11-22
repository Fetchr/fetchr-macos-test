//! Zero-mean normalised cross-correlation over a sparse sample grid.
//!
//! Two jobs in the pipeline:
//!   * verify what VitTrack returned still looks like the user's selection,
//!     which is what stops slow drift onto a similar-looking background;
//!   * re-acquire the banner with a full-frame scan after it was occluded or
//!     the scene cut away.
//!
//! ZNCC replaces the old raw-MSE score. MSE collapses whenever the scene gets
//! brighter or darker — a fade, a bitrate spike, a lighting change — even
//! though the banner never moved. ZNCC subtracts the mean and divides by the
//! standard deviation on both sides, so it only measures *pattern* agreement
//! and is invariant to gain and offset. On a synthetic banner under a 1.4x gain
//! and +60 offset, ZNCC scores 0.92 where the old MSE score reads 0.69 — under
//! the old default threshold of 0.72, i.e. the old tracker dropped the banner.

use rayon::prelude::*;

use super::vit::BoxF;

/// How many coarse peaks are carried into the full-resolution check.
const REDETECT_CANDIDATES: usize = 16;
/// Half-resolution scan step, in half-resolution pixels.
const COARSE_STEP: i64 = 2;
/// Refinement window around each candidate, in full-resolution pixels.
const REFINE_RADIUS: i64 = 6;

/// Single-channel 8-bit image.
pub struct GrayFrame {
    pub data: Vec<u8>,
    pub width: usize,
    pub height: usize,
}

impl GrayFrame {
    /// Rec.601 luma from a packed BGR24 buffer, using integer weights.
    pub fn from_bgr24(data: &[u8], width: usize, height: usize) -> Self {
        let mut gray = vec![0u8; width * height];
        for (index, pixel) in gray.iter_mut().enumerate() {
            let base = index * 3;
            let b = data[base] as u32;
            let g = data[base + 1] as u32;
            let r = data[base + 2] as u32;
            *pixel = ((r * 77 + g * 150 + b * 29) >> 8) as u8;
        }
        Self {
            data: gray,
            width,
            height,
        }
    }

    #[inline]
    fn at(&self, x: i64, y: i64) -> f32 {
        let x = x.clamp(0, self.width as i64 - 1) as usize;
        let y = y.clamp(0, self.height as i64 - 1) as usize;
        self.data[y * self.width + x] as f32
    }

    /// Box-filtered half-resolution copy used for the coarse re-detection pass.
    fn halved(&self) -> GrayFrame {
        let width = (self.width / 2).max(1);
        let height = (self.height / 2).max(1);
        let mut data = vec![0u8; width * height];
        for y in 0..height {
            let y0 = (y * 2).min(self.height - 1);
            let y1 = (y * 2 + 1).min(self.height - 1);
            for x in 0..width {
                let x0 = (x * 2).min(self.width - 1);
                let x1 = (x * 2 + 1).min(self.width - 1);
                let sum = self.data[y0 * self.width + x0] as u32
                    + self.data[y0 * self.width + x1] as u32
                    + self.data[y1 * self.width + x0] as u32
                    + self.data[y1 * self.width + x1] as u32;
                data[y * width + x] = (sum / 4) as u8;
            }
        }
        GrayFrame {
            data,
            width,
            height,
        }
    }
}

/// Sampled pixel values with their mean and standard deviation.
struct Stats {
    values: Vec<f32>,
    mean: f32,
    std: f32,
}

impl Stats {
    fn new(values: Vec<f32>) -> Self {
        let count = values.len().max(1) as f32;
        let mean = values.iter().sum::<f32>() / count;
        let std = (values.iter().map(|v| (v - mean) * (v - mean)).sum::<f32>() / count).sqrt();
        Self { values, mean, std }
    }
}

/// A sampled patch with its statistics precomputed at two scales.
pub struct Template {
    /// Sample positions in normalised patch coordinates, shared by both scales.
    offsets: Vec<(f32, f32)>,
    full: Stats,
    /// Sampled from a half-resolution copy of the reference frame. Comparing
    /// half-resolution pixels against full-resolution samples looks like it
    /// should work — the grid is normalised — but downscaling changes the
    /// pixel statistics, and on fine-detail banners the correlation at the
    /// true position collapses to ~0.36 and a spurious peak elsewhere wins.
    coarse: Stats,
    pub width: f64,
    pub height: f64,
}

impl Template {
    /// Samples `target` out of `frame` on a grid of at most 40x24 points. A
    /// sparse grid is enough to identify a banner and keeps the full-frame scan
    /// affordable; the grid is stored in normalised patch coordinates so the
    /// same template can be matched at a different box size.
    pub fn extract(frame: &GrayFrame, target: BoxF) -> Result<Self, String> {
        let cols = 40usize.min(target.w.max(1.0) as usize).max(2);
        let rows = 24usize.min(target.h.max(1.0) as usize).max(2);
        let mut offsets = Vec::with_capacity(cols * rows);
        for row in 0..rows {
            let fy = row as f32 / (rows - 1) as f32;
            for col in 0..cols {
                offsets.push((col as f32 / (cols - 1) as f32, fy));
            }
        }

        let full = Stats::new(sample(frame, &offsets, target));
        if full.std < 1.0 {
            // A flat patch correlates with everything; refuse it up front rather
            // than letting the tracker chase noise.
            return Err(
                "the selected rectangle has almost no contrast — pick an area with visible detail"
                    .to_string(),
            );
        }
        let half = frame.halved();
        let coarse = Stats::new(sample(
            &half,
            &offsets,
            BoxF {
                x: target.x / 2.0,
                y: target.y / 2.0,
                w: (target.w / 2.0).max(2.0),
                h: (target.h / 2.0).max(2.0),
            },
        ));

        Ok(Self {
            offsets,
            full,
            coarse,
            width: target.w,
            height: target.h,
        })
    }

    /// ZNCC of this template against the patch at `target`, in `[-1, 1]`.
    pub fn score_at(&self, frame: &GrayFrame, target: BoxF) -> f32 {
        self.score(frame, target, &self.full)
    }

    fn score(&self, frame: &GrayFrame, target: BoxF, reference: &Stats) -> f32 {
        if reference.std < 1e-3 {
            return 0.0;
        }
        let count = reference.values.len() as f32;
        let mut sum = 0.0f32;
        let mut sum_sq = 0.0f32;
        let mut cross = 0.0f32;
        let span_x = (target.w - 1.0).max(0.0);
        let span_y = (target.h - 1.0).max(0.0);
        for (index, (fx, fy)) in self.offsets.iter().enumerate() {
            let px = target.x + *fx as f64 * span_x;
            let py = target.y + *fy as f64 * span_y;
            let value = frame.at(px.round() as i64, py.round() as i64);
            sum += value;
            sum_sq += value * value;
            cross += value * reference.values[index];
        }
        let mean = sum / count;
        let variance = (sum_sq / count - mean * mean).max(0.0);
        let std = variance.sqrt();
        if std < 1e-3 {
            return 0.0;
        }
        ((cross / count) - reference.mean * mean) / (reference.std * std)
    }

    /// Best match within `radius` pixels of `seed`, coarse-to-fine. This is the
    /// per-frame search for the correlation-only engine and the local fallback
    /// when the model is unavailable.
    pub fn search_local(&self, frame: &GrayFrame, seed: BoxF, radius: i64) -> (BoxF, f32) {
        let limit_x = (frame.width as f64 - self.width).max(0.0);
        let limit_y = (frame.height as f64 - self.height).max(0.0);
        let mut best = (seed.x, seed.y, f32::MIN);
        for step in [4i64, 1i64] {
            let (cx, cy) = (best.0, best.1);
            let span = if step == 4 { radius } else { step * 4 };
            let mut dy = -span;
            while dy <= span {
                let mut dx = -span;
                while dx <= span {
                    let x = (cx + dx as f64).clamp(0.0, limit_x);
                    let y = (cy + dy as f64).clamp(0.0, limit_y);
                    let score = self.score_at(frame, self.box_at(x, y));
                    if score > best.2 {
                        best = (x, y, score);
                    }
                    dx += step;
                }
                dy += step;
            }
        }
        (self.box_at(best.0, best.1), best.2)
    }

    /// Scans the whole frame for the best match at the template's own size.
    ///
    /// A single coarse peak is not trustworthy: at half resolution the score
    /// separation shrinks and the true position can lose to background clutter.
    /// So the coarse pass is treated purely as a proposal generator — the top
    /// [`REDETECT_CANDIDATES`] spatially-separated peaks are each re-scored at
    /// full resolution and the best of those wins.
    pub fn redetect(&self, frame: &GrayFrame) -> Option<(BoxF, f32)> {
        let half = frame.halved();
        let coarse_w = (self.width / 2.0).max(2.0);
        let coarse_h = (self.height / 2.0).max(2.0);
        let max_x = (half.width as f64 - coarse_w).max(0.0) as i64;
        let max_y = (half.height as f64 - coarse_h).max(0.0) as i64;

        // Rayon's parallel ranges over i64 are not indexed, so `step_by` is not
        // available on them; collect the row seeds first.
        let rows: Vec<i64> = (0..=max_y).step_by(COARSE_STEP as usize).collect();
        let mut candidates: Vec<(f32, i64, i64)> = rows
            .par_iter()
            .flat_map_iter(|&y| {
                let mut row = Vec::new();
                let mut x = 0i64;
                while x <= max_x {
                    let score = self.score(
                        &half,
                        BoxF {
                            x: x as f64,
                            y: y as f64,
                            w: coarse_w,
                            h: coarse_h,
                        },
                        &self.coarse,
                    );
                    row.push((score, x, y));
                    x += COARSE_STEP;
                }
                row
            })
            .collect();
        if candidates.is_empty() {
            return None;
        }
        candidates.sort_unstable_by(|a, b| b.0.total_cmp(&a.0));

        // Non-maximum suppression so the shortlist covers distinct locations
        // instead of sixteen samples of the same peak.
        let sep_x = (self.width / 8.0).max(2.0);
        let sep_y = (self.height / 8.0).max(2.0);
        let mut shortlist: Vec<(i64, i64)> = Vec::with_capacity(REDETECT_CANDIDATES);
        for (_, x, y) in candidates {
            let distinct = shortlist.iter().all(|(kx, ky)| {
                (x - kx).abs() as f64 > sep_x || (y - ky).abs() as f64 > sep_y
            });
            if distinct {
                shortlist.push((x, y));
                if shortlist.len() >= REDETECT_CANDIDATES {
                    break;
                }
            }
        }

        let limit_x = (frame.width as f64 - self.width).max(0.0);
        let limit_y = (frame.height as f64 - self.height).max(0.0);
        let best = shortlist
            .par_iter()
            .map(|(cx, cy)| {
                let (seed_x, seed_y) = ((cx * 2) as f64, (cy * 2) as f64);
                let mut best = (0.0f64, 0.0f64, f32::MIN);
                for dy in -REFINE_RADIUS..=REFINE_RADIUS {
                    for dx in -REFINE_RADIUS..=REFINE_RADIUS {
                        let x = (seed_x + dx as f64).clamp(0.0, limit_x);
                        let y = (seed_y + dy as f64).clamp(0.0, limit_y);
                        let score = self.score_at(frame, self.box_at(x, y));
                        if score > best.2 {
                            best = (x, y, score);
                        }
                    }
                }
                best
            })
            .reduce(
                || (0.0f64, 0.0f64, f32::MIN),
                |a, b| if b.2 > a.2 { b } else { a },
            );
        if best.2 == f32::MIN {
            return None;
        }
        Some((self.box_at(best.0, best.1), best.2))
    }

    fn box_at(&self, x: f64, y: f64) -> BoxF {
        BoxF {
            x,
            y,
            w: self.width,
            h: self.height,
        }
    }
}

fn sample(frame: &GrayFrame, offsets: &[(f32, f32)], target: BoxF) -> Vec<f32> {
    let span_x = (target.w - 1.0).max(0.0);
    let span_y = (target.h - 1.0).max(0.0);
    offsets
        .iter()
        .map(|(fx, fy)| {
            let px = target.x + *fx as f64 * span_x;
            let py = target.y + *fy as f64 * span_y;
            frame.at(px.round() as i64, py.round() as i64)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame_with_banner(width: usize, height: usize, at: (usize, usize), gain: f32, offset: f32) -> GrayFrame {
        // Deterministic pseudo-random background plus a high-contrast patch.
        let mut data = vec![0u8; width * height * 3];
        let mut seed = 12345u32;
        for pixel in data.chunks_mut(3) {
            seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
            let value = (60 + (seed >> 24) % 30) as f32;
            let value = (value * gain + offset).clamp(0.0, 255.0) as u8;
            pixel[0] = value;
            pixel[1] = value;
            pixel[2] = value;
        }
        for row in 0..32 {
            for col in 0..96 {
                let dark = (col / 8) % 2 == 0 && (6..26).contains(&row);
                let value = if dark { 30.0 } else { 235.0 };
                let value = (value * gain + offset).clamp(0.0, 255.0) as u8;
                let index = ((at.1 + row) * width + at.0 + col) * 3;
                data[index] = value;
                data[index + 1] = value;
                data[index + 2] = value;
            }
        }
        GrayFrame::from_bgr24(&data, width, height)
    }

    fn banner_box(at: (usize, usize)) -> BoxF {
        BoxF {
            x: at.0 as f64,
            y: at.1 as f64,
            w: 96.0,
            h: 32.0,
        }
    }

    #[test]
    fn score_is_invariant_to_gain_and_offset() {
        let reference = frame_with_banner(480, 270, (60, 40), 1.0, 0.0);
        let template = Template::extract(&reference, banner_box((60, 40))).expect("template");
        let brighter = frame_with_banner(480, 270, (60, 40), 1.4, 60.0);
        let score = template.score_at(&brighter, banner_box((60, 40)));
        assert!(score > 0.85, "gain/offset changed the score too much: {score}");
    }

    #[test]
    fn score_rejects_the_wrong_position() {
        let reference = frame_with_banner(480, 270, (60, 40), 1.0, 0.0);
        let template = Template::extract(&reference, banner_box((60, 40))).expect("template");
        let score = template.score_at(&reference, banner_box((200, 150)));
        assert!(score < 0.4, "background scored too high: {score}");
    }

    #[test]
    fn redetect_finds_a_moved_banner_under_a_brightness_change() {
        let reference = frame_with_banner(480, 270, (60, 40), 1.0, 0.0);
        let template = Template::extract(&reference, banner_box((60, 40))).expect("template");
        let moved = frame_with_banner(480, 270, (210, 150), 0.7, -20.0);
        let (found, score) = template.redetect(&moved).expect("redetect");
        assert!(score > 0.8, "weak re-detection score: {score}");
        assert!((found.x - 210.0).abs() <= 2.0, "x off by {}", found.x - 210.0);
        assert!((found.y - 150.0).abs() <= 2.0, "y off by {}", found.y - 150.0);
    }

    #[test]
    fn flat_selection_is_rejected() {
        let mut data = vec![128u8; 64 * 64 * 3];
        data[0] = 128;
        let frame = GrayFrame::from_bgr24(&data, 64, 64);
        let result = Template::extract(
            &frame,
            BoxF {
                x: 8.0,
                y: 8.0,
                w: 16.0,
                h: 16.0,
            },
        );
        assert!(result.is_err());
    }
}
