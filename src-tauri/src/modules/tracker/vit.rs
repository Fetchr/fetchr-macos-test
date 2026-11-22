//! VitTrack — the lightweight ViT single-object tracker from OpenCV Zoo, run
//! directly through ONNX Runtime instead of OpenCV's DNN module.
//!
//! The network is a two-stream transformer: a 128x128 `template` crop taken
//! once around the user's rectangle, and a 256x256 `search` crop re-taken each
//! frame around the last known box. It emits a 16x16 confidence map plus
//! per-cell size and offset maps, which decode into a box in search-crop space.
//!
//! Model: `object_tracking_vittrack_2023sep.onnx`, ~700 KB. Roughly 1-3 ms per
//! frame on a CPU core, and unlike the old MSE template match it is invariant
//! to lighting, compression noise, and moderate scale change, and its score is
//! a usable "is the target still here" signal.
//!
//! Crop geometry and output decoding mirror OpenCV's `TrackerVit` reference
//! implementation (`modules/video/src/tracking/tracker_vit.cpp`).

use std::path::Path;

use ndarray::Array4;
use ort::session::Session;
use ort::value::Value;

const TEMPLATE_SIZE: usize = 128;
const SEARCH_SIZE: usize = 256;
const MAP_SIZE: usize = 16;
const TEMPLATE_FACTOR: f64 = 2.0;
const SEARCH_FACTOR: f64 = 4.0;

/// Per-channel input normalisation: `blob = (pixel - mean) * scale`.
///
/// Two candidates exist for this model and picking wrong costs accuracy:
///
/// * `IMAGENET` — textbook `(x/255 - mean) / std` folded into pixel units.
/// * `OPENCV` — what OpenCV's `TrackerVit` actually computes. It builds the
///   scale as `(1.0 / stdvalue) * (1/255)` where `stdvalue` is a `cv::Scalar`,
///   and `double / Scalar` in OpenCV is *quaternion* division, not element-wise,
///   so the reference path ends up with a different magnitude and a sign flip on
///   two channels.
///
/// Rather than bet on which one the published weights were validated against,
/// `VitSession::init` runs both on the very first frame — where the target is
/// known to be present and centred — and keeps whichever scores higher. It
/// costs two extra inferences once per run and cannot silently pick wrong.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Normalization {
    pub mean: [f32; 3],
    pub scale: [f32; 3],
    pub label: &'static str,
}

pub const IMAGENET: Normalization = Normalization {
    mean: [0.485 * 255.0, 0.456 * 255.0, 0.406 * 255.0],
    scale: [
        1.0 / (0.229 * 255.0),
        1.0 / (0.224 * 255.0),
        1.0 / (0.225 * 255.0),
    ],
    label: "imagenet",
};

pub const OPENCV: Normalization = Normalization {
    mean: [0.485 * 255.0, 0.456 * 255.0, 0.406 * 255.0],
    // conj(std) / |std|^2 / 255, i.e. the quaternion reciprocal OpenCV computes.
    scale: [0.005_860_268, -0.005_732_315, -0.005_757_905],
    label: "opencv",
};

/// Axis-aligned box in frame pixels, kept in floating point so the Kalman pass
/// downstream is not fighting per-frame integer rounding.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct BoxF {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

impl BoxF {
    pub fn center(&self) -> (f64, f64) {
        (self.x + self.w / 2.0, self.y + self.h / 2.0)
    }

    pub fn from_center(cx: f64, cy: f64, w: f64, h: f64) -> Self {
        Self {
            x: cx - w / 2.0,
            y: cy - h / 2.0,
            w,
            h,
        }
    }
}

/// A BGR24 frame plus its dimensions.
#[derive(Clone, Copy)]
pub struct FrameView<'a> {
    pub data: &'a [u8],
    pub width: usize,
    pub height: usize,
}

impl FrameView<'_> {
    #[inline]
    fn pixel(&self, x: i64, y: i64, channel: usize) -> f32 {
        if x < 0 || y < 0 || x >= self.width as i64 || y >= self.height as i64 {
            // Matches OpenCV's BORDER_CONSTANT zero padding around the crop.
            return 0.0;
        }
        let index = (y as usize * self.width + x as usize) * 3 + channel;
        self.data[index] as f32
    }

    #[inline]
    fn bilinear(&self, x: f64, y: f64, channel: usize) -> f32 {
        let x0 = x.floor();
        let y0 = y.floor();
        let fx = (x - x0) as f32;
        let fy = (y - y0) as f32;
        let (xi, yi) = (x0 as i64, y0 as i64);
        let p00 = self.pixel(xi, yi, channel);
        let p10 = self.pixel(xi + 1, yi, channel);
        let p01 = self.pixel(xi, yi + 1, channel);
        let p11 = self.pixel(xi + 1, yi + 1, channel);
        let top = p00 + (p10 - p00) * fx;
        let bottom = p01 + (p11 - p01) * fx;
        top + (bottom - top) * fy
    }
}

pub struct VitTracker {
    session: Session,
    /// Kept as a plain array rather than an `ort` tensor: the concrete tensor
    /// type name churns between ONNX Runtime release candidates, and rebuilding
    /// a 1x3x128x128 blob per frame is a rounding error next to inference.
    template: Array4<f32>,
    names: IoNames,
    norm: Normalization,
    hann: [f32; MAP_SIZE * MAP_SIZE],
    last: BoxF,
    /// True once DirectML/CoreML accepted the graph; purely informational.
    pub accelerated: bool,
}

impl VitTracker {
    /// Loads the model. `prefer_gpu` registers the platform hardware execution
    /// provider first; the CPU provider always stays as the fallback, and a
    /// hardware session that fails to build silently degrades to CPU.
    pub fn load(model_path: &Path, prefer_gpu: bool) -> Result<VitSession, String> {
        if !model_path.is_file() {
            return Err(format!(
                "VitTrack model is missing: {}",
                model_path.display()
            ));
        }
        // The model is tiny; more than a couple of threads only adds contention.
        let threads = std::thread::available_parallelism()
            .map(|value| value.get().saturating_sub(1).clamp(1, 4))
            .unwrap_or(2);

        if prefer_gpu {
            if let Ok(session) = build_accelerated_session(model_path, threads) {
                return VitSession::new(session, true);
            }
        }
        let session = build_cpu_session(model_path, threads)?;
        VitSession::new(session, false)
    }

    pub fn normalization(&self) -> &'static str {
        self.norm.label
    }

    pub fn last_box(&self) -> BoxF {
        self.last
    }

    /// Re-seeds the tracker after a re-detection. The appearance template is
    /// left alone, so it stays anchored to the user's original selection and
    /// cannot drift onto whatever the tracker locked onto by mistake.
    pub fn reseed(&mut self, target: BoxF) {
        self.last = target;
    }

    /// Advances one frame. Returns the new box and the raw confidence peak.
    pub fn update(&mut self, frame: FrameView<'_>) -> Result<(BoxF, f32), String> {
        let target = self.last;
        self.infer(frame, target)
    }

    fn infer(&mut self, frame: FrameView<'_>, from: BoxF) -> Result<(BoxF, f32), String> {
        let (blob, crop_size, crop_x, crop_y) =
            crop_blob(frame, from, SEARCH_FACTOR, SEARCH_SIZE, self.norm);
        let (conf, size_map, offset_map) = run_graph(
            &mut self.session,
            &self.names,
            self.template.clone(),
            blob,
        )?;

        // The Hann window penalises peaks far from the search-crop centre; it is
        // what keeps the tracker from jumping to a similar object nearby.
        let mut best_index = 0usize;
        let mut best_score = f32::MIN;
        for index in 0..MAP_SIZE * MAP_SIZE {
            let score = conf[index] * self.hann[index];
            if score > best_score {
                best_score = score;
                best_index = index;
            }
        }
        let row = best_index / MAP_SIZE;
        let col = best_index % MAP_SIZE;
        let plane = MAP_SIZE * MAP_SIZE;

        let cx = (col as f64 + offset_map[best_index] as f64) / MAP_SIZE as f64;
        let cy = (row as f64 + offset_map[plane + best_index] as f64) / MAP_SIZE as f64;
        let w = size_map[best_index] as f64;
        let h = size_map[plane + best_index] as f64;

        let result = BoxF {
            x: crop_x + (cx - w / 2.0) * crop_size,
            y: crop_y + (cy - h / 2.0) * crop_size,
            w: (w * crop_size).max(1.0),
            h: (h * crop_size).max(1.0),
        };
        self.last = result;
        Ok((result, best_score.max(0.0)))
    }
}

/// Two-phase construction: the session must exist before the template blob can
/// be built, and the template needs the first frame.
pub struct VitSession {
    session: Session,
    accelerated: bool,
    names: IoNames,
}

impl VitSession {
    fn new(session: Session, accelerated: bool) -> Result<Self, String> {
        let names = IoNames::resolve(&session)?;
        Ok(Self {
            session,
            accelerated,
            names,
        })
    }

    /// Builds the appearance template from `target` in `frame` and returns a
    /// ready tracker, picking the input normalisation that scores best on this
    /// frame (see [`Normalization`]).
    pub fn init(mut self, frame: FrameView<'_>, target: BoxF) -> Result<VitTracker, String> {
        let mut best: Option<(Normalization, f32, Array4<f32>)> = None;
        for norm in [IMAGENET, OPENCV] {
            let (template, _, _, _) =
                crop_blob(frame, target, TEMPLATE_FACTOR, TEMPLATE_SIZE, norm);
            let (search, _, _, _) = crop_blob(frame, target, SEARCH_FACTOR, SEARCH_SIZE, norm);
            let (conf, _, _) =
                run_graph(&mut self.session, &self.names, template.clone(), search)?;
            let peak = conf.iter().copied().fold(f32::MIN, f32::max);
            if best.as_ref().map_or(true, |(_, score, _)| peak > *score) {
                best = Some((norm, peak, template));
            }
        }
        let (norm, _, template) = best.expect("at least one normalisation was evaluated");

        Ok(VitTracker {
            session: self.session,
            template,
            names: self.names,
            norm,
            hann: hann2d(),
            last: target,
            accelerated: self.accelerated,
        })
    }
}

struct IoNames {
    input_template: String,
    input_search: String,
    output_conf: String,
    output_size: String,
    output_offset: String,
}

impl IoNames {
    fn resolve(session: &Session) -> Result<Self, String> {
        let inputs: Vec<String> = session
            .inputs()
            .iter()
            .map(|input| input.name().to_string())
            .collect();
        let outputs: Vec<String> = session
            .outputs()
            .iter()
            .map(|output| output.name().to_string())
            .collect();
        if inputs.len() < 2 || outputs.len() < 3 {
            return Err(format!(
                "unexpected VitTrack graph: {} inputs / {} outputs",
                inputs.len(),
                outputs.len()
            ));
        }
        // Prefer the documented names, fall back to declaration order so a
        // re-exported or quantised copy of the model still loads.
        let pick = |names: &[String], wanted: &str, fallback: usize| -> String {
            names
                .iter()
                .find(|name| name.as_str() == wanted)
                .cloned()
                .unwrap_or_else(|| names[fallback].clone())
        };
        Ok(Self {
            input_template: pick(&inputs, "template", 0),
            input_search: pick(&inputs, "search", 1),
            output_conf: pick(&outputs, "output1", 0),
            output_size: pick(&outputs, "output2", 1),
            output_offset: pick(&outputs, "output3", 2),
        })
    }
}

/// Runs one forward pass and returns `(conf 16x16, size 2x16x16, offset 2x16x16)`.
fn run_graph(
    session: &mut Session,
    names: &IoNames,
    template: Array4<f32>,
    search: Array4<f32>,
) -> Result<(Vec<f32>, Vec<f32>, Vec<f32>), String> {
    let template =
        Value::from_array(template).map_err(|err| format!("build template tensor: {err}"))?;
    let search = Value::from_array(search).map_err(|err| format!("build search tensor: {err}"))?;
    let outputs = session
        .run(ort::inputs![
            names.input_template.as_str() => &template,
            names.input_search.as_str() => &search,
        ])
        .map_err(|err| format!("VitTrack inference failed: {err}"))?;

    // A closure keeps `ort`'s output-container type unnamed, which insulates
    // this file from the type churn between ONNX Runtime release candidates.
    let take = |name: &str, expected: usize| -> Result<Vec<f32>, String> {
        let value = outputs
            .get(name)
            .ok_or_else(|| format!("VitTrack output '{name}' is missing"))?;
        let values = value
            .try_extract_tensor::<f32>()
            .map_err(|err| format!("read VitTrack output '{name}': {err}"))?
            .1
            .to_vec();
        if values.len() < expected {
            return Err(format!(
                "VitTrack output '{name}' has {} values, expected {expected}",
                values.len()
            ));
        }
        Ok(values)
    };
    let plane = MAP_SIZE * MAP_SIZE;
    Ok((
        take(names.output_conf.as_str(), plane)?,
        take(names.output_size.as_str(), 2 * plane)?,
        take(names.output_offset.as_str(), 2 * plane)?,
    ))
}

/// Crops a square region of `factor * sqrt(area)` around `target`, resizes it to
/// `size`, and normalises it into an NCHW blob. Returns the blob plus the crop
/// geometry needed to map the network's output back into frame coordinates.
///
/// Channel order stays BGR, matching how OpenCV feeds video frames to the model.
fn crop_blob(
    frame: FrameView<'_>,
    target: BoxF,
    factor: f64,
    size: usize,
    norm: Normalization,
) -> (Array4<f32>, f64, f64, f64) {
    let crop_size = ((target.w.max(1.0) * target.h.max(1.0)).sqrt() * factor)
        .ceil()
        .max(2.0);
    let crop_x = target.x + (target.w - crop_size) / 2.0;
    let crop_y = target.y + (target.h - crop_size) / 2.0;
    let scale = crop_size / size as f64;

    let mut blob = Array4::<f32>::zeros((1, 3, size, size));
    {
        let plane = blob.as_slice_mut().expect("contiguous blob");
        for channel in 0..3 {
            let mean = norm.mean[channel];
            let gain = norm.scale[channel];
            let base = channel * size * size;
            for oy in 0..size {
                let sy = crop_y + (oy as f64 + 0.5) * scale - 0.5;
                let row = base + oy * size;
                for ox in 0..size {
                    let sx = crop_x + (ox as f64 + 0.5) * scale - 0.5;
                    plane[row + ox] = (frame.bilinear(sx, sy, channel) - mean) * gain;
                }
            }
        }
    }
    (blob, crop_size, crop_x, crop_y)
}

/// Centred 2-D Hann window, matching OpenCV's `hann2d(size, centered = true)`.
fn hann2d() -> [f32; MAP_SIZE * MAP_SIZE] {
    let mut window1d = [0.0f32; MAP_SIZE];
    for (index, value) in window1d.iter_mut().enumerate() {
        let phase = (2.0 * std::f32::consts::PI / (MAP_SIZE as f32 + 1.0)) * (index as f32 + 1.0);
        *value = 0.5 * (1.0 - phase.cos());
    }
    let mut window = [0.0f32; MAP_SIZE * MAP_SIZE];
    for row in 0..MAP_SIZE {
        for col in 0..MAP_SIZE {
            window[row * MAP_SIZE + col] = window1d[row] * window1d[col];
        }
    }
    window
}

fn build_cpu_session(model_path: &Path, threads: usize) -> Result<Session, String> {
    Session::builder()
        .map_err(|err| format!("create ONNX session builder: {err}"))?
        .with_intra_threads(threads.max(1))
        .map_err(|err| format!("set ONNX intra threads: {err}"))?
        .with_inter_threads(1)
        .map_err(|err| format!("set ONNX inter threads: {err}"))?
        .commit_from_file(model_path)
        .map_err(|err| format!("load VitTrack model {}: {err}", model_path.display()))
}

#[cfg(target_os = "windows")]
fn build_accelerated_session(model_path: &Path, threads: usize) -> Result<Session, String> {
    Session::builder()
        .map_err(|err| format!("create ONNX session builder: {err}"))?
        .with_intra_threads(threads.max(1))
        .map_err(|err| format!("set ONNX intra threads: {err}"))?
        .with_inter_threads(1)
        .map_err(|err| format!("set ONNX inter threads: {err}"))?
        // DirectML requires sequential execution with memory-pattern planning
        // off, otherwise the fused DML node fails on the first Run.
        .with_parallel_execution(false)
        .map_err(|err| format!("set ONNX execution mode: {err}"))?
        .with_memory_pattern(false)
        .map_err(|err| format!("disable ONNX memory pattern: {err}"))?
        .with_execution_providers([
            ort::ep::DirectML::default().build(),
            ort::ep::CPU::default().build(),
        ])
        .map_err(|err| format!("register execution providers: {err}"))?
        .commit_from_file(model_path)
        .map_err(|err| format!("load VitTrack model {}: {err}", model_path.display()))
}

#[cfg(target_os = "macos")]
fn build_accelerated_session(model_path: &Path, threads: usize) -> Result<Session, String> {
    Session::builder()
        .map_err(|err| format!("create ONNX session builder: {err}"))?
        .with_intra_threads(threads.max(1))
        .map_err(|err| format!("set ONNX intra threads: {err}"))?
        .with_inter_threads(1)
        .map_err(|err| format!("set ONNX inter threads: {err}"))?
        .with_execution_providers([
            ort::ep::CoreML::default().build(),
            ort::ep::CPU::default().build(),
        ])
        .map_err(|err| format!("register execution providers: {err}"))?
        .commit_from_file(model_path)
        .map_err(|err| format!("load VitTrack model {}: {err}", model_path.display()))
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
fn build_accelerated_session(_model_path: &Path, _threads: usize) -> Result<Session, String> {
    Err("no hardware execution provider on this platform".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The crop/decode pair must round-trip: a network answer of "dead centre,
    /// size 1/factor" has to reproduce the box the crop was taken from.
    #[test]
    fn crop_geometry_round_trips() {
        let target = BoxF {
            x: 300.0,
            y: 120.0,
            w: 160.0,
            h: 90.0,
        };
        let crop_size = ((target.w * target.h).sqrt() * SEARCH_FACTOR).ceil().max(2.0);
        let crop_x = target.x + (target.w - crop_size) / 2.0;
        let crop_y = target.y + (target.h - crop_size) / 2.0;

        // Normalised box of the target inside the crop.
        let cx = (target.x + target.w / 2.0 - crop_x) / crop_size;
        let cy = (target.y + target.h / 2.0 - crop_y) / crop_size;
        let w = target.w / crop_size;
        let h = target.h / crop_size;

        let decoded = BoxF {
            x: crop_x + (cx - w / 2.0) * crop_size,
            y: crop_y + (cy - h / 2.0) * crop_size,
            w: w * crop_size,
            h: h * crop_size,
        };
        assert!((decoded.x - target.x).abs() < 1e-6);
        assert!((decoded.y - target.y).abs() < 1e-6);
        assert!((decoded.w - target.w).abs() < 1e-6);
        assert!((decoded.h - target.h).abs() < 1e-6);
    }

    #[test]
    fn hann_window_peaks_at_centre() {
        let window = hann2d();
        let centre = window[8 * MAP_SIZE + 8];
        assert!(centre > window[0]);
        assert!(centre > window[MAP_SIZE * MAP_SIZE - 1]);
        assert!(window.iter().all(|value| *value >= 0.0));
    }

    /// A uniform grey frame must normalise to a constant blob; catches sign and
    /// stride mistakes in the channel loop.
    #[test]
    fn blob_is_constant_for_flat_input() {
        let data = vec![128u8; 64 * 64 * 3];
        let frame = FrameView {
            data: &data,
            width: 64,
            height: 64,
        };
        let target = BoxF {
            x: 16.0,
            y: 16.0,
            w: 16.0,
            h: 16.0,
        };
        let (blob, _, _, _) = crop_blob(frame, target, 1.0, 8, IMAGENET);
        let slice = blob.as_slice().expect("contiguous");
        for channel in 0..3 {
            let expected = (128.0 - IMAGENET.mean[channel]) * IMAGENET.scale[channel];
            for index in 0..8 * 8 {
                assert!((slice[channel * 64 + index] - expected).abs() < 1e-4);
            }
        }
    }
}
