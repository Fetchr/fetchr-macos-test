use std::path::Path;

use crate::chat_overlay::parse_hms;
use crate::jobs::types::{
    BlurEffect, BlurQuality, BlurShape, BlurZone, BlurZoneKeyframe, ImageFit, TimeFragment,
};

/// Zones are authored on a 1920x1080 reference frame in the UI; all stored
/// coordinates (including tracking keyframes) live in this design space.
pub const BLUR_DESIGN_WIDTH: u32 = 1920;
pub const BLUR_DESIGN_HEIGHT: u32 = 1080;

pub(crate) fn normalized_blur_zones(zones: &[BlurZone], width: u32, height: u32) -> Vec<BlurZone> {
    // Scale design-space coordinates to the actual output resolution. Without
    // this, rendering to anything other than 1920x1080 misplaced every zone.
    let scale_x = width as f64 / BLUR_DESIGN_WIDTH as f64;
    let scale_y = height as f64 / BLUR_DESIGN_HEIGHT as f64;
    let needs_scale = (scale_x - 1.0).abs() > 0.001 || (scale_y - 1.0).abs() > 0.001;
    zones
        .iter()
        .filter(|zone| zone.enabled && zone.width > 0 && zone.height > 0)
        .filter_map(|zone| {
            let mut scaled = zone.clone();
            if needs_scale {
                scaled.x = (zone.x as f64 * scale_x).round() as i32;
                scaled.y = (zone.y as f64 * scale_y).round() as i32;
                scaled.width = ((zone.width as f64 * scale_x).round() as u32).max(1);
                scaled.height = ((zone.height as f64 * scale_y).round() as u32).max(1);
                if let Some(tracking) = scaled.tracking.as_mut() {
                    for frame in tracking.keyframes.iter_mut() {
                        frame.x = (frame.x as f64 * scale_x).round() as i32;
                        frame.y = (frame.y as f64 * scale_y).round() as i32;
                        frame.width = ((frame.width as f64 * scale_x).round() as u32).max(1);
                        frame.height = ((frame.height as f64 * scale_y).round() as u32).max(1);
                    }
                }
            }
            let x = scaled.x.clamp(0, width.saturating_sub(1) as i32);
            let y = scaled.y.clamp(0, height.saturating_sub(1) as i32);
            let max_w = width.saturating_sub(x as u32);
            let max_h = height.saturating_sub(y as u32);
            let w = scaled.width.min(max_w);
            let h = scaled.height.min(max_h);
            if w == 0 || h == 0 {
                return None;
            }
            let mut next = scaled;
            next.x = x;
            next.y = y;
            next.width = w;
            next.height = h;
            next.intensity = next.intensity.max(1.0);
            next.image_fit.get_or_insert(ImageFit::Contain);
            Some(next)
        })
        .collect()
}

/// Remap zone tracking times from the original video timeline onto the cut
/// timeline produced by concatenating `fragments`. Keyframes that fall outside
/// every fragment are dropped; a tracked zone that loses all of its keyframes
/// is disabled (otherwise it would render as a static blur over the whole
/// video). Returns the mapped zones plus how many zones were disabled.
pub(crate) fn map_blur_zones_to_fragments(
    zones: &[BlurZone],
    fragments: &[TimeFragment],
) -> (Vec<BlurZone>, usize) {
    // (fragment_start, fragment_end, cumulative_start_on_cut_timeline)
    let mut spans: Vec<(f64, f64, f64)> = Vec::with_capacity(fragments.len());
    let mut cumulative = 0.0_f64;
    for fragment in fragments {
        let start = parse_hms(Some(fragment.start.as_str()));
        let end = parse_hms(Some(fragment.end.as_str()));
        if let (Some(start), Some(end)) = (start, end) {
            if end > start {
                spans.push((start, end, cumulative));
                cumulative += end - start;
            }
        }
    }
    if spans.is_empty() {
        return (zones.to_vec(), 0);
    }

    let map_time = |time_sec: f64| -> Option<f64> {
        for (start, end, offset) in &spans {
            if time_sec >= *start && time_sec < *end {
                return Some(offset + (time_sec - start));
            }
        }
        // A timestamp exactly at the end of the last fragment maps to the end
        // of the cut timeline.
        if let Some((start, end, offset)) = spans.last() {
            if (time_sec - *end).abs() < 0.001 {
                return Some(offset + (end - start));
            }
        }
        None
    };

    let mut disabled = 0usize;
    let mapped = zones
        .iter()
        .cloned()
        .map(|mut zone| {
            let Some(tracking) = zone.tracking.as_mut().filter(|t| t.enabled) else {
                return zone;
            };
            if tracking.keyframes.is_empty() {
                return zone;
            }
            tracking.keyframes = tracking
                .keyframes
                .iter()
                .filter_map(|frame| {
                    map_time(frame.time_sec).map(|mapped_time| BlurZoneKeyframe {
                        time_sec: mapped_time,
                        ..*frame
                    })
                })
                .collect();
            tracking.keyframes.sort_by(|a, b| a.time_sec.total_cmp(&b.time_sec));
            if tracking.keyframes.is_empty() {
                disabled += 1;
                zone.enabled = false;
                zone.tracking = None;
                return zone;
            }
            tracking.start_time_sec = tracking
                .keyframes
                .first()
                .map(|frame| frame.time_sec)
                .unwrap_or(0.0);
            tracking.end_time_sec = tracking
                .end_time_sec
                .and_then(map_time)
                .or_else(|| tracking.keyframes.last().map(|frame| frame.time_sec));
            // A gap may straddle a cut; keep the piece inside each fragment.
            tracking.gaps = tracking
                .gaps
                .iter()
                .flat_map(|[gap_start, gap_end]| {
                    spans.iter().filter_map(move |(start, end, offset)| {
                        let from = gap_start.max(*start);
                        let to = gap_end.min(*end);
                        (to > from).then(|| [offset + (from - start), offset + (to - start)])
                    })
                })
                .collect();
            zone
        })
        .collect();
    (mapped, disabled)
}

pub(crate) fn offset_blur_zone_times(zones: &[BlurZone], offset_sec: f64) -> Vec<BlurZone> {
    if offset_sec <= 0.0 {
        return zones.to_vec();
    }
    zones
        .iter()
        .cloned()
        .map(|mut zone| {
            if let Some(tracking) = zone.tracking.as_mut() {
                tracking.start_time_sec -= offset_sec;
                tracking.end_time_sec = tracking.end_time_sec.map(|value| value - offset_sec);
                for frame in tracking.keyframes.iter_mut() {
                    frame.time_sec -= offset_sec;
                }
                for gap in tracking.gaps.iter_mut() {
                    gap[0] -= offset_sec;
                    gap[1] -= offset_sec;
                }
            }
            zone
        })
        .collect()
}

pub(crate) fn append_blur_zone_filters(
    filter: &mut String,
    current: &mut String,
    zones: &[BlurZone],
    image_input: &mut usize,
) {
    for (idx, zone) in zones.iter().enumerate() {
        let next = format!("base{}", idx + 1);
        let placement = zone_placement(zone);
        // The crop is what actually gets processed, so the mask must match the
        // cropped size, not the authored zone size (they differ once tracking
        // clamps the geometry).
        let (mask_w, mask_h) = (placement.width, placement.height);
        let th = zone_threads(placement.width, placement.height);
        match zone.effect {
            BlurEffect::GaussianBlur => {
                let sigma = zone.intensity.clamp(1.0, 64.0) as f64;
                let chain = gated_gaussian_chain(
                    zone.quality_or_default(),
                    sigma,
                    mask_w,
                    mask_h,
                    &placement.enable,
                );
                filter.push_str(&format!(
                    "[{current}]split=2[{current}m][{current}c];\
[{current}c]crop=w={w}:h={h}:x='{crop_x}':y='{crop_y}',{chain}[zone{idx}];",
                    w = placement.width,
                    h = placement.height,
                    crop_x = placement.crop_x,
                    crop_y = placement.crop_y,
                ));
                let source = append_zone_mask(filter, zone, idx, mask_w, mask_h);
                filter.push_str(&format!(
                    "[{current}m][{source}]overlay=x='{overlay_x}':y='{overlay_y}':enable='{enable}'{th}[{next}];",
                    overlay_x = placement.overlay_x,
                    overlay_y = placement.overlay_y,
                    enable = placement.enable,
                ));
            }
            BlurEffect::Mosaic => {
                let factor = zone.intensity.round().clamp(2.0, 80.0) as u32;
                let down_w = (placement.width / factor).max(1);
                let down_h = (placement.height / factor).max(1);
                // `high` upscales the tiny image bilinearly, which turns hard
                // mosaic squares into a soft pixel-gradient; the cost is the
                // same (the expensive step is the downscale, not the upscale).
                let up_flags = match zone.quality_or_default() {
                    BlurQuality::High => "bilinear",
                    _ => "neighbor",
                };
                filter.push_str(&format!(
                    "[{current}]split=2[{current}m][{current}c];\
[{current}c]crop=w={w}:h={h}:x='{crop_x}':y='{crop_y}',scale={dw}:{dh}:flags=neighbor{th},scale={w}:{h}:flags={up_flags}{th}[zone{idx}];",
                    w = placement.width,
                    h = placement.height,
                    crop_x = placement.crop_x,
                    crop_y = placement.crop_y,
                    dw = down_w,
                    dh = down_h,
                ));
                let source = append_zone_mask(filter, zone, idx, mask_w, mask_h);
                filter.push_str(&format!(
                    "[{current}m][{source}]overlay=x='{overlay_x}':y='{overlay_y}':enable='{enable}'{th}[{next}];",
                    overlay_x = placement.overlay_x,
                    overlay_y = placement.overlay_y,
                    enable = placement.enable,
                ));
            }
            BlurEffect::ImageOverlay => {
                if zone
                    .image_path
                    .as_deref()
                    .filter(|path| Path::new(path).is_file())
                    .is_none()
                {
                    continue;
                }
                filter.push_str(&image_fit_filter(
                    *image_input,
                    idx,
                    placement.width,
                    placement.height,
                    zone.image_fit.unwrap_or(ImageFit::Contain),
                ));
                // An image already carries its own alpha, so a shape mask would
                // clobber it. Only opacity is applied here, by scaling the
                // existing alpha channel.
                let opacity = zone.opacity_clamped();
                let source = if opacity < 0.999 {
                    filter.push_str(&format!(
                        "[zone{idx}]colorchannelmixer=aa={opacity:.3}[zone{idx}o];"
                    ));
                    format!("zone{idx}o")
                } else {
                    format!("zone{idx}")
                };
                filter.push_str(&format!(
                    "[{current}][{source}]overlay=x='{overlay_x}':y='{overlay_y}':enable='{enable}'{th}[{next}];",
                    overlay_x = placement.overlay_x,
                    overlay_y = placement.overlay_y,
                    enable = placement.enable,
                ));
                *image_input += 1;
            }
        }
        *current = next;
    }
}

/// The bundled ffmpeg's x86 SIMD `gblur` (any SSE2+ path) writes zeroed
/// chroma into planes shorter than 16 lines, which shows up as a staircase of
/// bright green bars across the blurred crop. On 4:2:0 input that is any frame
/// under 32px tall, so every `gblur` in the graph runs on a frame at least this
/// tall; tiny crops are scaled up to reach it and back down afterwards.
const MIN_GBLUR_HEIGHT: u32 = 32;

/// Crops up to this many pixels run their filters single-threaded. Slice
/// threading a 200x100 region spends more on waking and joining workers than
/// on the pixels: measured on the bundled ffmpeg, `threads=1` halved the CPU
/// time of a zone chain with bit-identical output, and leaves the cores to the
/// encoder. Large crops keep ffmpeg's default.
const SMALL_ZONE_PX: u64 = 400_000;

fn zone_threads(width: u32, height: u32) -> &'static str {
    if width as u64 * height as u64 <= SMALL_ZONE_PX {
        ":threads=1"
    } else {
        ""
    }
}

/// Blur kernel chain for a `width x height` crop.
///
/// The expensive part of a gaussian is that its cost grows with the area it
/// covers. Downscaling the crop by `f`, blurring with `sigma/f`, then scaling
/// back bilinearly is visually near-identical for large sigma but costs ~f^2
/// less work — plus the bilinear upscale itself contributes smoothing. `High`
/// keeps the exact full-resolution `gblur` for cases where fidelity matters.
///
/// Whatever the quality, the frame handed to `gblur` never drops below
/// [`MIN_GBLUR_HEIGHT`]; a crop shorter than that is blurred on an upscaled
/// copy (factor below 1) with the sigma enlarged to match.
pub(crate) fn gaussian_chain(quality: BlurQuality, sigma: f64, width: u32, height: u32) -> String {
    gated_gaussian_chain(quality, sigma, width, height, "1")
}

/// [`gaussian_chain`] whose `gblur` only runs while `enable` holds. The
/// overlay already ignores the blurred crop outside that window, so skipping
/// the kernel there changes no output pixel; `crop`/`scale` have no timeline
/// support and stay, but they are cheap next to the blur itself.
fn gated_gaussian_chain(
    quality: BlurQuality,
    sigma: f64,
    width: u32,
    height: u32,
    enable: &str,
) -> String {
    let gate = if enable == "1" {
        String::new()
    } else {
        format!(":enable='{enable}'")
    };
    let th = zone_threads(width, height);
    let (target_residual, max_factor): (f64, f64) = match quality {
        BlurQuality::High => (sigma, 1.0),
        // Leaving ~4px of true gaussian after the downscale keeps the falloff
        // smooth; ~1.5px is enough once bilinear upscaling adds its own blur.
        BlurQuality::Balanced => (4.0, 8.0),
        BlurQuality::Fast => (1.5, 32.0),
    };
    // Cap the factor so neither side falls below 4px; clamping the sides
    // independently instead would distort the aspect ratio and smear the blur
    // along one axis.
    let side_limit = (width.min(height) as f64 / 4.0).max(1.0);
    // ...and so the blurred frame keeps the minimum height. For crops shorter
    // than that the limit is below 1, which turns the chain into an upscale.
    let height_limit = height.max(1) as f64 / MIN_GBLUR_HEIGHT as f64;
    let factor = (sigma / target_residual)
        .clamp(1.0, max_factor.min(side_limit))
        .min(height_limit);
    if (0.95..=1.05).contains(&factor) {
        return format!("gblur=sigma={sigma:.1}{th}{gate}");
    }
    // Even dimensions keep the chroma planes happy on yuv420 input.
    let blur_w = (((width as f64 / factor).round() as u32) & !1).max(4);
    let blur_h = (((height as f64 / factor).round() as u32) & !1).max(MIN_GBLUR_HEIGHT);
    // Recover the factor actually achieved so the residual sigma stays honest.
    let effective = (width as f64 / blur_w as f64).min(height as f64 / blur_h as f64);
    let residual = (sigma / effective).max(0.4);
    format!(
        "scale={blur_w}:{blur_h}:flags=bilinear{th},gblur=sigma={residual:.2}{th}{gate},scale={width}:{height}:flags=bilinear{th}"
    )
}

/// Emit an alpha mask for the zone and merge it onto `[zone{idx}]`, returning the
/// label to overlay. Returns `zone{idx}` untouched for plain hard rectangles so
/// the common case pays nothing.
///
/// The mask is a single static frame (`trim=end_frame=1`): `geq` is a per-pixel
/// interpreted expression and would be ruinous per frame, but `alphamerge` is a
/// framesync filter with `repeatlast` on by default, so one frame is reused for
/// the whole video and `geq` runs exactly once.
fn append_zone_mask(
    filter: &mut String,
    zone: &BlurZone,
    idx: usize,
    width: u32,
    height: u32,
) -> String {
    if zone.is_hard_rectangle() {
        return format!("zone{idx}");
    }
    let expr = mask_lum_expr(
        zone.shape_or_default(),
        width,
        height,
        zone.edge_softness_px().min(width.min(height) / 2),
        zone.opacity_clamped(),
    );
    filter.push_str(&format!(
        "color=c=black:s={width}x{height}:d=1:r=1,format=gray,geq=lum='{expr}',trim=end_frame=1[mask{idx}];\
[zone{idx}][mask{idx}]alphamerge[zone{idx}a];"
    ));
    format!("zone{idx}a")
}

/// `geq` luminance expression for the zone mask. Commas are escaped because the
/// filtergraph parser splits option values on them.
fn mask_lum_expr(
    shape: BlurShape,
    width: u32,
    height: u32,
    softness: u32,
    opacity: f32,
) -> String {
    let peak = (255.0 * opacity as f64).round().clamp(0.0, 255.0);
    match shape {
        BlurShape::Rectangle => {
            if softness == 0 {
                return format!("{peak:.0}");
            }
            // Distance to the nearest edge, ramped over `softness` pixels.
            format!(
                "{peak:.0}*clip(min(min(X\\,W-1-X)\\,min(Y\\,H-1-Y))/{softness}\\,0\\,1)"
            )
        }
        BlurShape::Ellipse => {
            // Normalised radius: 1.0 exactly on the ellipse boundary.
            let radius = "hypot((X-W/2)/(W/2)\\,(Y-H/2)/(H/2))";
            if softness == 0 {
                return format!("{peak:.0}*lte({radius}\\,1)");
            }
            // Convert the pixel feather into normalised-radius units.
            let span = (2.0 * softness as f64 / width.min(height).max(1) as f64).max(0.001);
            format!("{peak:.0}*clip((1-{radius})/{span:.5}\\,0\\,1)")
        }
    }
}

/// Time ranges where at least one zone actually draws something, merged and
/// clamped to `[0, duration]`. An untracked zone covers the whole video, so the
/// result is a single full-length span and segmented rendering is pointless.
///
/// Adjacent spans closer than `MERGE_GAP` are fused: each extra span costs two
/// ffmpeg invocations plus a concat join, so a handful of long spans beats many
/// short ones.
pub(crate) fn blur_active_intervals(zones: &[BlurZone], duration: f64) -> Vec<(f64, f64)> {
    const MERGE_GAP: f64 = 2.0;
    let mut spans: Vec<(f64, f64)> = Vec::new();
    for zone in zones.iter().filter(|zone| zone.enabled) {
        let keyframes = active_keyframes(zone);
        if keyframes.is_empty() {
            return vec![(0.0, duration)];
        }
        spans.extend(
            zone_visible_spans(zone, &keyframes)
                .into_iter()
                .map(|(start, end)| (start, end.min(duration)))
                .filter(|(start, end)| end > start),
        );
    }
    if spans.is_empty() {
        return Vec::new();
    }
    spans.sort_by(|a, b| a.0.total_cmp(&b.0));
    let mut merged: Vec<(f64, f64)> = Vec::with_capacity(spans.len());
    for (start, end) in spans {
        match merged.last_mut() {
            Some(last) if start <= last.1 + MERGE_GAP => last.1 = last.1.max(end),
            _ => merged.push((start, end)),
        }
    }
    merged
}

/// Frosted-glass chat backdrop: blur the video region behind the chat box on the current
/// base chain, before the chat (with its semi-transparent background) is overlaid on top.
pub(crate) fn append_chat_background_blur(
    filter: &mut String,
    current: &mut String,
    chat_x: i32,
    chat_y: i32,
    chat_width: u32,
    chat_height: u32,
) {
    const CHAT_BACKDROP_BLUR_SIGMA: f64 = 18.0;
    let next = format!("{current}bg");
    let (w, h) = (chat_width.max(1), chat_height.max(1));
    filter.push_str(&format!(
        "[{current}]split=2[{current}m][{current}c];\
[{current}c]crop=w={w}:h={h}:x={x}:y={y},{chain}[{current}blur];\
[{current}m][{current}blur]overlay=x={x}:y={y}[{next}];",
        x = chat_x,
        y = chat_y,
        chain = gaussian_chain(BlurQuality::Balanced, CHAT_BACKDROP_BLUR_SIGMA, w, h),
    ));
    *current = next;
}

pub(crate) fn image_fit_filter(
    input: usize,
    idx: usize,
    width: u32,
    height: u32,
    fit: ImageFit,
) -> String {
    match fit {
        ImageFit::Contain => format!(
            "[{input}:v]scale={width}:{height}:force_original_aspect_ratio=decrease,format=rgba,\
pad={width}:{height}:(ow-iw)/2:(oh-ih)/2:color=black@0[zone{idx}];"
        ),
        ImageFit::Cover => format!(
            "[{input}:v]scale={width}:{height}:force_original_aspect_ratio=increase,crop={width}:{height},format=rgba[zone{idx}];"
        ),
        ImageFit::Stretch => {
            format!("[{input}:v]scale={width}:{height},format=rgba[zone{idx}];")
        }
    }
}

struct ZonePlacement {
    width: u32,
    height: u32,
    crop_x: String,
    crop_y: String,
    overlay_x: String,
    overlay_y: String,
    enable: String,
}

fn zone_placement(zone: &BlurZone) -> ZonePlacement {
    let keyframes = simplify_keyframes(&active_keyframes(zone), TRACK_SIMPLIFY_TOLERANCE_PX);
    if keyframes.is_empty() {
        let x = zone.x.to_string();
        let y = zone.y.to_string();
        return ZonePlacement {
            width: zone.width,
            height: zone.height,
            crop_x: x.clone(),
            crop_y: y.clone(),
            overlay_x: x,
            overlay_y: y,
            enable: "1".to_string(),
        };
    }

    let first = keyframes.first().expect("checked non-empty");
    let width = first.width.max(1);
    let height = first.height.max(1);
    let x_expr = timeline_expr(&keyframes, |frame| frame.x);
    let y_expr = timeline_expr(&keyframes, |frame| frame.y);
    let spans = zone_visible_spans(zone, &keyframes);
    ZonePlacement {
        width,
        height,
        crop_x: x_expr.clone(),
        crop_y: y_expr.clone(),
        overlay_x: x_expr,
        overlay_y: y_expr,
        enable: spans_expr(&spans, 0, spans.len()),
    }
}

/// A tracker gap opens on the first frame below the confidence threshold, so a
/// short dip (motion blur, a flash) is a gap too. Only gaps that stay long
/// after trimming this margin off both ends are trusted to mean "banner gone";
/// the margin also covers the banner sliding in or out around the gap.
const GAP_EDGE_MARGIN_SEC: f64 = 0.5;
const MIN_UNBLURRED_GAP_SEC: f64 = 1.5;

/// `[start, end]` spans where a tracked zone is drawn: from its first keyframe
/// to its tracking end, minus the long tracker gaps. Never empty for a tracked
/// zone, so one whose every moment falls in a gap keeps its original span.
fn zone_visible_spans(zone: &BlurZone, keyframes: &[BlurZoneKeyframe]) -> Vec<(f64, f64)> {
    let (Some(first), Some(last)) = (keyframes.first(), keyframes.last()) else {
        return Vec::new();
    };
    let tracking = zone.tracking.as_ref();
    let start = first.time_sec.max(0.0);
    let end = tracking
        .and_then(|tracking| tracking.end_time_sec)
        .unwrap_or(last.time_sec)
        .max(first.time_sec);
    let mut gaps: Vec<(f64, f64)> = tracking
        .map(|tracking| tracking.gaps.as_slice())
        .unwrap_or_default()
        .iter()
        .map(|[a, b]| (*a, *b))
        .collect();
    gaps.sort_by(|a, b| a.0.total_cmp(&b.0));
    // A gap split by a cut comes back as two touching pieces; rejoin them so
    // the margin is not taken out of the middle.
    let mut merged: Vec<(f64, f64)> = Vec::with_capacity(gaps.len());
    for (a, b) in gaps {
        match merged.last_mut() {
            Some(last) if a <= last.1 + 0.001 => last.1 = last.1.max(b),
            _ => merged.push((a, b)),
        }
    }
    let hidden: Vec<(f64, f64)> = merged
        .into_iter()
        .map(|(a, b)| (a + GAP_EDGE_MARGIN_SEC, b - GAP_EDGE_MARGIN_SEC))
        .filter(|(a, b)| b - a >= MIN_UNBLURRED_GAP_SEC)
        .collect();

    let mut spans = Vec::new();
    let mut cursor = start;
    for (from, to) in hidden {
        if from > cursor && from < end {
            spans.push((cursor, from));
        }
        cursor = cursor.max(to);
    }
    if cursor < end {
        spans.push((cursor, end));
    }
    if spans.is_empty() {
        spans.push((start, end));
    }
    spans
}

/// `enable` expression true inside any of the sorted, disjoint `spans`, as a
/// binary search so a zone with many gaps still costs O(log n) per frame.
fn spans_expr(spans: &[(f64, f64)], lo: usize, hi: usize) -> String {
    if hi - lo == 1 {
        let (start, end) = spans[lo];
        return format!("between(t\\,{start:.3}\\,{end:.3})");
    }
    let mid = lo + (hi - lo) / 2;
    format!(
        "if(lt(t\\,{:.3})\\,{}\\,{})",
        spans[mid].0,
        spans_expr(spans, lo, mid),
        spans_expr(spans, mid, hi)
    )
}

fn active_keyframes(zone: &BlurZone) -> Vec<BlurZoneKeyframe> {
    let Some(tracking) = zone.tracking.as_ref().filter(|tracking| tracking.enabled) else {
        return Vec::new();
    };
    let mut frames = tracking
        .keyframes
        .iter()
        .filter(|frame| frame.width > 0 && frame.height > 0 && frame.time_sec.is_finite())
        .cloned()
        .collect::<Vec<_>>();
    frames.sort_by(|a, b| a.time_sec.total_cmp(&b.time_sec));
    frames
}

/// Max distance, in output pixels, a simplified track may stray from the
/// tracker's own piecewise-linear path. Below one pixel the blur box lands on
/// the same pixels, so the render is visually identical.
const TRACK_SIMPLIFY_TOLERANCE_PX: f64 = 0.75;

/// Drop keyframes that linear interpolation between their neighbours already
/// reproduces (Ramer-Douglas-Peucker over time). Both paths are piecewise
/// linear with vertices at the original keyframes, so checking the deviation
/// at those keyframes bounds the error everywhere.
fn simplify_keyframes(keyframes: &[BlurZoneKeyframe], tolerance: f64) -> Vec<BlurZoneKeyframe> {
    if keyframes.len() <= 2 {
        return keyframes.to_vec();
    }
    let mut keep = vec![false; keyframes.len()];
    keep[0] = true;
    keep[keyframes.len() - 1] = true;
    let mut stack = vec![(0usize, keyframes.len() - 1)];
    while let Some((lo, hi)) = stack.pop() {
        if hi <= lo + 1 {
            continue;
        }
        let (a, b) = (&keyframes[lo], &keyframes[hi]);
        let span = b.time_sec - a.time_sec;
        let (mut worst, mut worst_idx) = (0.0_f64, lo);
        for (idx, frame) in keyframes.iter().enumerate().take(hi).skip(lo + 1) {
            let ratio = if span > 0.0 {
                (frame.time_sec - a.time_sec) / span
            } else {
                0.0
            };
            let lerp = |av: i32, bv: i32| av as f64 + (bv - av) as f64 * ratio;
            let dev = (frame.x as f64 - lerp(a.x, b.x))
                .abs()
                .max((frame.y as f64 - lerp(a.y, b.y)).abs());
            if dev > worst {
                worst = dev;
                worst_idx = idx;
            }
        }
        if worst > tolerance {
            keep[worst_idx] = true;
            stack.push((lo, worst_idx));
            stack.push((worst_idx, hi));
        }
    }
    keyframes
        .iter()
        .zip(keep)
        .filter_map(|(frame, kept)| kept.then(|| frame.clone()))
        .collect()
}

/// Per-frame position expression for a tracked zone.
///
/// ffmpeg evaluates this on every frame, and `crop`/`overlay` each carry an x
/// and a y copy. A flat `if(between(...))` chain costs O(keyframes) per frame;
/// a balanced binary search over the segment start times costs O(log n), since
/// `if()` only evaluates the branch it takes.
fn timeline_expr(
    keyframes: &[BlurZoneKeyframe],
    value: impl Fn(&BlurZoneKeyframe) -> i32,
) -> String {
    if keyframes.len() == 1 {
        return value(&keyframes[0]).to_string();
    }
    let first = keyframes.first().expect("checked non-empty");
    let last = keyframes.last().expect("checked non-empty");
    let tree = segment_tree_expr(keyframes, &value, 0, keyframes.len() - 1);
    format!(
        "if(lt(t\\,{:.3})\\,{}\\,if(gte(t\\,{:.3})\\,{}\\,{}))",
        first.time_sec,
        value(first),
        last.time_sec,
        value(last),
        tree
    )
}

/// Expression for segments `lo..hi` (segment `i` spans keyframes `i..=i+1`).
fn segment_tree_expr(
    keyframes: &[BlurZoneKeyframe],
    value: &impl Fn(&BlurZoneKeyframe) -> i32,
    lo: usize,
    hi: usize,
) -> String {
    if hi - lo == 1 {
        let (a, b) = (&keyframes[lo], &keyframes[lo + 1]);
        let (av, bv) = (value(a), value(b));
        if av == bv {
            return av.to_string();
        }
        let start = a.time_sec;
        let dt = (b.time_sec - start).max(0.001);
        return format!("{av}+({})*(t-{start:.3})/{dt:.3}", bv - av);
    }
    let mid = lo + (hi - lo) / 2;
    format!(
        "if(lt(t\\,{:.3})\\,{}\\,{})",
        keyframes[mid].time_sec,
        segment_tree_expr(keyframes, value, lo, mid),
        segment_tree_expr(keyframes, value, mid, hi)
    )
}


#[cfg(test)]
mod tests {
    use super::*;
    use crate::jobs::types::BlurZoneTracking;

    fn keyframe(time_sec: f64, x: i32, y: i32) -> BlurZoneKeyframe {
        BlurZoneKeyframe {
            time_sec,
            x,
            y,
            width: 100,
            height: 50,
            confidence: 0.9,
        }
    }

    fn zone_with_tracking(times: &[(f64, i32, i32)]) -> BlurZone {
        BlurZone {
            id: "zone-1".to_string(),
            enabled: true,
            x: 10,
            y: 10,
            width: 100,
            height: 50,
            effect: BlurEffect::Mosaic,
            intensity: 8.0,
            image_path: None,
            image_fit: None,
            shape: None,
            edge_softness: None,
            quality: None,
            opacity: None,
            tracking: Some(BlurZoneTracking {
                enabled: true,
                start_time_sec: times.first().map(|key| key.0).unwrap_or(0.0),
                end_time_sec: times.last().map(|key| key.0),
                sample_interval_sec: 0.5,
                search_radius: 220,
                confidence_threshold: 0.72,
                keyframes: times
                    .iter()
                    .map(|(time, x, y)| keyframe(*time, *x, *y))
                    .collect(),
                gaps: Vec::new(),
            }),
        }
    }

    fn fragment(start: &str, end: &str) -> TimeFragment {
        TimeFragment {
            start: start.to_string(),
            end: end.to_string(),
        }
    }

    #[test]
    fn timeline_expr_single_keyframe_is_constant() {
        let frames = vec![keyframe(1.5, 120, 60)];
        assert_eq!(timeline_expr(&frames, |frame| frame.x), "120");
        assert_eq!(timeline_expr(&frames, |frame| frame.y), "60");
    }

    #[test]
    fn timeline_expr_interpolates_between_keyframes() {
        let frames = vec![keyframe(0.0, 0, 0), keyframe(2.0, 200, 100)];
        let expr = timeline_expr(&frames, |frame| frame.x);
        assert!(expr.contains("if(gte(t\\,2.000)\\,200"), "expected tail guard: {expr}");
        assert!(expr.contains("0+(200)*(t-0.000)/2.000"), "expected lerp: {expr}");
        assert!(expr.starts_with("if(lt(t"), "expected head guard: {expr}");
    }

    /// Reference evaluator for the subset of ffmpeg's expression syntax that
    /// `timeline_expr` emits, so the tree can be checked against plain lerp.
    fn eval_expr(expr: &str, t: f64) -> f64 {
        let expr = expr.replace("\\,", ",");
        let (value, rest) = eval_at(&expr, t);
        assert!(rest.is_empty(), "trailing input: {rest}");
        value
    }

    fn eval_at(s: &str, t: f64) -> (f64, &str) {
        for (name, cmp) in [("lt(t,", 0), ("gte(t,", 1)] {
            if let Some(rest) = s.strip_prefix("if(").and_then(|r| r.strip_prefix(name)) {
                let (bound, rest) = rest.split_once("),").expect("condition");
                let bound: f64 = bound.parse().expect("bound");
                let (yes, rest) = eval_at(rest, t);
                let (no, rest) = eval_at(rest.strip_prefix(',').expect("comma"), t);
                let rest = rest.strip_prefix(')').expect("close");
                let taken = if cmp == 0 { t < bound } else { t >= bound };
                return (if taken { yes } else { no }, rest);
            }
        }
        // A lerp term has its own parens, so stop at the first unbalanced ')'.
        let mut depth = 0i32;
        let end = s
            .char_indices()
            .find(|&(_, c)| match c {
                '(' => {
                    depth += 1;
                    false
                }
                ')' if depth > 0 => {
                    depth -= 1;
                    false
                }
                ')' | ',' => true,
                _ => false,
            })
            .map_or(s.len(), |(idx, _)| idx);
        let term = &s[..end];
        let value = match term.split_once("+(") {
            None => term.parse().expect("constant"),
            Some((base, tail)) => {
                let (delta, tail) = tail.split_once(")*(t-").expect("lerp");
                let (start, dt) = tail.split_once(")/").expect("lerp dt");
                base.parse::<f64>().unwrap()
                    + delta.parse::<f64>().unwrap() * (t - start.parse::<f64>().unwrap())
                        / dt.parse::<f64>().unwrap()
            }
        };
        (value, &s[end..])
    }

    fn reference_lerp(frames: &[BlurZoneKeyframe], t: f64) -> f64 {
        let first = frames.first().unwrap();
        let last = frames.last().unwrap();
        if t < first.time_sec {
            return first.x as f64;
        }
        if t >= last.time_sec {
            return last.x as f64;
        }
        let pair = frames
            .windows(2)
            .find(|pair| t >= pair[0].time_sec && t < pair[1].time_sec)
            .unwrap();
        let (a, b) = (&pair[0], &pair[1]);
        a.x as f64 + (b.x - a.x) as f64 * (t - a.time_sec) / (b.time_sec - a.time_sec)
    }

    #[test]
    fn timeline_expr_tree_matches_linear_interpolation() {
        let frames: Vec<_> = (0..37)
            .map(|i| keyframe(i as f64 * 0.4, (i * i * 7 % 500) as i32, 0))
            .collect();
        let expr = timeline_expr(&frames, |frame| frame.x);
        for step in -5..400 {
            let t = step as f64 * 0.037;
            let got = eval_expr(&expr, t);
            let want = reference_lerp(&frames, t);
            assert!((got - want).abs() < 1e-6, "t={t}: {got} vs {want}");
        }
    }

    #[test]
    fn timeline_expr_nesting_is_logarithmic() {
        let frames: Vec<_> = (0..4000)
            .map(|i| keyframe(i as f64 * 0.2, i as i32, 0))
            .collect();
        let expr = timeline_expr(&frames, |frame| frame.x);
        let mut depth = 0i32;
        let mut max_depth = 0i32;
        for c in expr.chars() {
            match c {
                '(' => {
                    depth += 1;
                    max_depth = max_depth.max(depth);
                }
                ')' => depth -= 1,
                _ => {}
            }
        }
        // log2(4000) ~ 12 levels of if() plus a few parens per level.
        assert!(max_depth < 60, "depth {max_depth}");
    }

    #[test]
    fn simplify_drops_collinear_keyframes_and_keeps_corners() {
        let frames = vec![
            keyframe(0.0, 0, 0),
            keyframe(1.0, 10, 0),
            keyframe(2.0, 20, 0),
            keyframe(3.0, 20, 0),
            keyframe(4.0, 20, 0),
        ];
        let simplified = simplify_keyframes(&frames, TRACK_SIMPLIFY_TOLERANCE_PX);
        let times: Vec<f64> = simplified.iter().map(|frame| frame.time_sec).collect();
        assert_eq!(times, vec![0.0, 2.0, 4.0]);
    }

    #[test]
    fn simplify_stays_within_tolerance_of_the_original_path() {
        let frames: Vec<_> = (0..300)
            .map(|i| {
                let t = i as f64 * 0.2;
                keyframe(t, (t * 13.0).sin().mul_add(40.0, t * 5.0) as i32, (t * 3.0) as i32)
            })
            .collect();
        let simplified = simplify_keyframes(&frames, TRACK_SIMPLIFY_TOLERANCE_PX);
        assert!(simplified.len() < frames.len());
        for frame in &frames {
            let got = reference_lerp(&simplified, frame.time_sec);
            assert!(
                (got - frame.x as f64).abs() <= TRACK_SIMPLIFY_TOLERANCE_PX + 1e-9,
                "t={}",
                frame.time_sec
            );
        }
    }

    #[test]
    fn tracked_gaussian_zone_gates_the_blur_kernel() {
        let mut zone = zone_with_tracking(&[(10.0, 1, 1), (20.0, 50, 50)]);
        zone.effect = BlurEffect::GaussianBlur;
        zone.intensity = 24.0;
        let mut filter = String::new();
        let mut current = "base0".to_string();
        let mut image_input = 1;
        append_blur_zone_filters(&mut filter, &mut current, &[zone], &mut image_input);
        assert!(
            filter.contains(":enable='between(t\\,10.000\\,20.000)'"),
            "{filter}"
        );
        assert_eq!(filter.matches("enable=").count(), 2, "gblur + overlay: {filter}");
    }

    #[test]
    fn large_crops_keep_default_threading() {
        let chain = gaussian_chain(BlurQuality::High, 24.0, 1200, 600);
        assert_eq!(chain, "gblur=sigma=24.0");
    }

    fn zone_with_gaps(gaps: &[[f64; 2]]) -> BlurZone {
        let mut zone = zone_with_tracking(&[(10.0, 1, 1), (40.0, 2, 2)]);
        zone.tracking.as_mut().unwrap().gaps = gaps.to_vec();
        zone
    }

    #[test]
    fn long_gaps_are_cut_out_with_a_margin() {
        let zone = zone_with_gaps(&[[20.0, 25.0]]);
        let keyframes = active_keyframes(&zone);
        assert_eq!(
            zone_visible_spans(&zone, &keyframes),
            vec![(10.0, 20.5), (24.5, 40.0)]
        );
    }

    #[test]
    fn short_gaps_stay_blurred() {
        // 2s gap minus 0.5s on each side leaves 1s: a dip, not a disappearance.
        let zone = zone_with_gaps(&[[20.0, 22.0]]);
        let keyframes = active_keyframes(&zone);
        assert_eq!(zone_visible_spans(&zone, &keyframes), vec![(10.0, 40.0)]);
    }

    #[test]
    fn gap_enable_expr_selects_the_visible_spans() {
        let zone = zone_with_gaps(&[[15.0, 18.0], [25.0, 30.0]]);
        let placement = zone_placement(&zone);
        let spans = zone_visible_spans(&zone, &active_keyframes(&zone));
        assert_eq!(spans.len(), 3);
        let expr = placement.enable.replace("\\,", ",");
        let eval = |t: f64| -> bool {
            // Tiny evaluator for `if(lt(t,X),A,B)` / `between(t,a,b)`.
            fn go(s: &str, t: f64) -> (bool, &str) {
                if let Some(rest) = s.strip_prefix("if(lt(t,") {
                    let (bound, rest) = rest.split_once("),").unwrap();
                    let (a, rest) = go(rest, t);
                    let (b, rest) = go(rest.strip_prefix(',').unwrap(), t);
                    let rest = rest.strip_prefix(')').unwrap();
                    return (if t < bound.parse::<f64>().unwrap() { a } else { b }, rest);
                }
                let rest = s.strip_prefix("between(t,").unwrap();
                let (args, rest) = rest.split_once(')').unwrap();
                let (lo, hi) = args.split_once(',').unwrap();
                let inside = t >= lo.parse::<f64>().unwrap() && t <= hi.parse::<f64>().unwrap();
                (inside, rest)
            }
            go(&expr, t).0
        };
        for (t, want) in [
            (9.0, false),
            (12.0, true),
            (16.5, false),
            (20.0, true),
            (26.0, false),
            (35.0, true),
            (41.0, false),
        ] {
            assert_eq!(eval(t), want, "t={t}: {expr}");
        }
    }

    #[test]
    fn active_intervals_skip_long_gaps() {
        let zone = zone_with_gaps(&[[20.0, 30.0]]);
        assert_eq!(
            blur_active_intervals(&[zone], 120.0),
            vec![(10.0, 20.5), (29.5, 40.0)]
        );
    }

    #[test]
    fn gaps_follow_offsets_and_fragment_cuts() {
        let zone = zone_with_gaps(&[[18.0, 34.0]]);
        let shifted = offset_blur_zone_times(&[zone.clone()], 5.0);
        assert_eq!(shifted[0].tracking.as_ref().unwrap().gaps, vec![[13.0, 29.0]]);

        let fragments = vec![fragment("00:00:10", "00:00:20"), fragment("00:00:30", "00:00:40")];
        let (mapped, _) = map_blur_zones_to_fragments(&[zone], &fragments);
        // 18-20 lands at 8-10 on the cut timeline, 30-34 at 10-14.
        assert_eq!(
            mapped[0].tracking.as_ref().unwrap().gaps,
            vec![[8.0, 10.0], [10.0, 14.0]]
        );
    }

    #[test]
    fn untracked_gaussian_zone_has_no_gate() {
        assert!(!gaussian_chain(BlurQuality::Balanced, 24.0, 800, 400).contains("enable"));
    }

    #[test]
    fn normalized_zones_scale_to_output_resolution() {
        let mut zone = zone_with_tracking(&[(1.0, 960, 540)]);
        zone.x = 960;
        zone.y = 540;
        zone.width = 192;
        zone.height = 108;
        let zones = normalized_blur_zones(&[zone], 1280, 720);
        assert_eq!(zones.len(), 1);
        let scaled = &zones[0];
        assert_eq!((scaled.x, scaled.y), (640, 360));
        assert_eq!((scaled.width, scaled.height), (128, 72));
        let tracking = scaled.tracking.as_ref().expect("tracking kept");
        assert_eq!((tracking.keyframes[0].x, tracking.keyframes[0].y), (640, 360));
    }

    #[test]
    fn normalized_zones_keep_coordinates_at_design_resolution() {
        let mut zone = zone_with_tracking(&[]);
        zone.x = 100;
        zone.y = 200;
        zone.width = 300;
        zone.height = 150;
        let zones = normalized_blur_zones(&[zone], BLUR_DESIGN_WIDTH, BLUR_DESIGN_HEIGHT);
        assert_eq!(zones.len(), 1);
        assert_eq!((zones[0].x, zones[0].y), (100, 200));
        assert_eq!((zones[0].width, zones[0].height), (300, 150));
    }

    #[test]
    fn map_fragments_remaps_and_drops_keyframes() {
        let fragments = vec![fragment("00:00:10", "00:00:20"), fragment("00:00:30", "00:00:40")];
        // t=5 is outside every fragment, t=15 -> 5, t=35 -> 15 on the cut timeline.
        let zone = zone_with_tracking(&[(5.0, 1, 1), (15.0, 2, 2), (35.0, 3, 3)]);
        let (mapped, disabled) = map_blur_zones_to_fragments(&[zone], &fragments);
        assert_eq!(disabled, 0);
        let tracking = mapped[0].tracking.as_ref().expect("tracking kept");
        let times: Vec<f64> = tracking.keyframes.iter().map(|frame| frame.time_sec).collect();
        assert_eq!(times, vec![5.0, 15.0]);
        assert_eq!(tracking.start_time_sec, 5.0);
    }

    #[test]
    fn map_fragments_disables_zone_without_any_keyframe_inside() {
        let fragments = vec![fragment("00:00:10", "00:00:20")];
        let zone = zone_with_tracking(&[(0.0, 1, 1), (30.0, 2, 2)]);
        let (mapped, disabled) = map_blur_zones_to_fragments(&[zone], &fragments);
        assert_eq!(disabled, 1);
        assert!(!mapped[0].enabled);
        assert!(mapped[0].tracking.is_none());
    }

    #[test]
    fn map_fragments_keeps_untracked_zones_untouched() {
        let fragments = vec![fragment("00:00:10", "00:00:20")];
        let mut zone = zone_with_tracking(&[]);
        zone.tracking = None;
        let (mapped, disabled) = map_blur_zones_to_fragments(&[zone], &fragments);
        assert_eq!(disabled, 0);
        assert!(mapped[0].enabled);
        assert!(mapped[0].tracking.is_none());
    }

    #[test]
    fn gaussian_chain_high_keeps_full_resolution_gblur() {
        let chain = gaussian_chain(BlurQuality::High, 24.0, 800, 400);
        assert_eq!(chain, "gblur=sigma=24.0:threads=1");
    }

    #[test]
    fn gaussian_chain_fast_downscales_before_blurring() {
        let chain = gaussian_chain(BlurQuality::Fast, 24.0, 800, 400);
        assert!(chain.starts_with("scale="), "expected downscale first: {chain}");
        assert!(chain.ends_with("scale=800:400:flags=bilinear:threads=1"), "expected upscale back: {chain}");
        // sigma 24 / residual 1.5 asks for 16x, but 400px tall can only shrink
        // 12.5x before the frame drops under the gblur height floor.
        assert!(chain.contains("scale=64:32:flags=bilinear"), "unexpected factor: {chain}");
    }

    #[test]
    fn gaussian_chain_small_sigma_skips_the_downscale() {
        // Nothing to gain when the residual would be as large as the input sigma.
        assert_eq!(
            gaussian_chain(BlurQuality::Balanced, 3.0, 800, 400),
            "gblur=sigma=3.0:threads=1"
        );
    }

    /// `scale=W:H:...` -> (W, H) of the frame the chain hands to `gblur`.
    fn blurred_dims(chain: &str) -> (u32, u32) {
        let scale = chain.split(',').next().expect("chain has parts");
        let dims: Vec<u32> = scale
            .trim_start_matches("scale=")
            .split(':')
            .take(2)
            .filter_map(|part| part.parse().ok())
            .collect();
        assert_eq!(dims.len(), 2, "unexpected chain: {chain}");
        (dims[0], dims[1])
    }

    #[test]
    fn gaussian_chain_never_shrinks_below_the_gblur_minimum() {
        let chain = gaussian_chain(BlurQuality::Fast, 64.0, 400, 80);
        let (w, h) = blurred_dims(&chain);
        assert_eq!(h, MIN_GBLUR_HEIGHT, "height floor lost: {chain}");
        // Aspect ratio is preserved rather than clamped per-axis (400:80 = 5:1).
        assert!(w > h * 4, "aspect lost: {chain}");
    }

    #[test]
    fn gaussian_chain_keeps_the_reported_zone_tall_enough() {
        // 229x74 at sigma 12 used to blur a 76x24 frame, whose 12-line chroma
        // planes come back from SIMD gblur with zeroed rows (green bars).
        let chain = gaussian_chain(BlurQuality::Balanced, 12.0, 229, 74);
        let (_, h) = blurred_dims(&chain);
        assert!(h >= MIN_GBLUR_HEIGHT, "{chain}");
        assert!(chain.ends_with("scale=229:74:flags=bilinear:threads=1"), "{chain}");
    }

    #[test]
    fn gaussian_chain_upscales_crops_shorter_than_the_minimum() {
        for quality in [BlurQuality::High, BlurQuality::Balanced, BlurQuality::Fast] {
            let chain = gaussian_chain(quality, 10.0, 200, 20);
            let (w, h) = blurred_dims(&chain);
            assert_eq!(h, MIN_GBLUR_HEIGHT, "{chain}");
            assert!(w > 200, "width must scale with the height: {chain}");
            // Blurring a 1.6x upscale needs a 1.6x sigma to look the same.
            assert!(chain.contains("gblur=sigma=16.00"), "{chain}");
            assert!(chain.ends_with("scale=200:20:flags=bilinear:threads=1"), "{chain}");
        }
    }

    #[test]
    fn mask_expr_escapes_commas_for_the_filtergraph_parser() {
        let expr = mask_lum_expr(BlurShape::Rectangle, 200, 100, 20, 1.0);
        assert!(expr.contains("\\,"), "commas must be escaped: {expr}");
        assert!(!expr.contains(", "), "raw commas would split the filter option: {expr}");
        assert!(expr.starts_with("255*clip("), "{expr}");
    }

    #[test]
    fn mask_expr_hard_rectangle_is_a_constant() {
        assert_eq!(mask_lum_expr(BlurShape::Rectangle, 200, 100, 0, 1.0), "255");
        assert_eq!(mask_lum_expr(BlurShape::Rectangle, 200, 100, 0, 0.5), "128");
    }

    #[test]
    fn mask_expr_ellipse_uses_normalised_radius() {
        let hard = mask_lum_expr(BlurShape::Ellipse, 200, 100, 0, 1.0);
        assert!(hard.contains("lte(hypot("), "{hard}");
        let soft = mask_lum_expr(BlurShape::Ellipse, 200, 100, 25, 1.0);
        assert!(soft.contains("clip((1-hypot("), "{soft}");
    }

    #[test]
    fn hard_rectangle_detection_drives_the_no_mask_fast_path() {
        let mut zone = zone_with_tracking(&[]);
        assert!(zone.is_hard_rectangle());
        zone.edge_softness = Some(10);
        assert!(!zone.is_hard_rectangle());
        zone.edge_softness = None;
        zone.shape = Some(BlurShape::Ellipse);
        assert!(!zone.is_hard_rectangle());
        zone.shape = None;
        zone.opacity = Some(0.5);
        assert!(!zone.is_hard_rectangle());
    }

    #[test]
    fn edge_softness_cannot_exceed_half_the_shorter_side() {
        let mut zone = zone_with_tracking(&[]);
        zone.width = 100;
        zone.height = 50;
        zone.edge_softness = Some(999);
        assert_eq!(zone.edge_softness_px(), 25);
    }

    #[test]
    fn hard_rectangle_zone_emits_no_mask_branch() {
        let zone = zone_with_tracking(&[]);
        let mut filter = String::new();
        let mut current = "base0".to_string();
        let mut image_input = 1;
        append_blur_zone_filters(&mut filter, &mut current, &[zone], &mut image_input);
        assert!(!filter.contains("alphamerge"), "{filter}");
        assert!(!filter.contains("geq"), "{filter}");
        assert_eq!(current, "base1");
    }

    #[test]
    fn soft_ellipse_zone_emits_a_single_frame_mask() {
        let mut zone = zone_with_tracking(&[]);
        zone.shape = Some(BlurShape::Ellipse);
        zone.edge_softness = Some(12);
        let mut filter = String::new();
        let mut current = "base0".to_string();
        let mut image_input = 1;
        append_blur_zone_filters(&mut filter, &mut current, &[zone], &mut image_input);
        assert!(filter.contains("alphamerge"), "{filter}");
        // A static mask is essential: geq per frame would cost more than the blur.
        assert!(filter.contains("trim=end_frame=1"), "{filter}");
        assert!(filter.contains("[zone0a]"), "{filter}");
    }

    #[test]
    fn active_intervals_cover_everything_for_an_untracked_zone() {
        let mut zone = zone_with_tracking(&[]);
        zone.tracking = None;
        assert_eq!(blur_active_intervals(&[zone], 120.0), vec![(0.0, 120.0)]);
    }

    #[test]
    fn active_intervals_merge_nearby_spans() {
        let a = zone_with_tracking(&[(10.0, 1, 1), (20.0, 2, 2)]);
        let b = zone_with_tracking(&[(21.0, 1, 1), (30.0, 2, 2)]);
        // 1s apart, so they fuse into one span instead of two render passes.
        assert_eq!(blur_active_intervals(&[a, b], 120.0), vec![(10.0, 30.0)]);
    }

    #[test]
    fn active_intervals_keep_distant_spans_separate() {
        let a = zone_with_tracking(&[(10.0, 1, 1), (20.0, 2, 2)]);
        let b = zone_with_tracking(&[(80.0, 1, 1), (90.0, 2, 2)]);
        assert_eq!(
            blur_active_intervals(&[a, b], 120.0),
            vec![(10.0, 20.0), (80.0, 90.0)]
        );
    }

    #[test]
    fn active_intervals_clamp_to_the_video_duration() {
        let zone = zone_with_tracking(&[(10.0, 1, 1), (500.0, 2, 2)]);
        assert_eq!(blur_active_intervals(&[zone], 120.0), vec![(10.0, 120.0)]);
    }

    #[test]
    fn offset_zone_times_shifts_tracking() {
        let zone = zone_with_tracking(&[(10.0, 1, 1), (20.0, 2, 2)]);
        let mapped = offset_blur_zone_times(&[zone], 5.0);
        let tracking = mapped[0].tracking.as_ref().expect("tracking kept");
        let times: Vec<f64> = tracking.keyframes.iter().map(|frame| frame.time_sec).collect();
        assert_eq!(times, vec![5.0, 15.0]);
    }
}
