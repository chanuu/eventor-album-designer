//! Whether anyone in a photo has their eyes closed.
//!
//! Faces are found first, then each is turned upright and its eyelids traced. An eye counts
//! as closed when the gap between its lids is small against the eye's width. Faces too
//! small to measure reliably, such as guests far behind, are not judged at all. See
//! `models/README.md` for where the models come from.

use std::fs;
use std::io::Cursor;
use std::path::Path;
use std::sync::OnceLock;

use image::{imageops::FilterType, DynamicImage, GenericImageView, Rgb, RgbImage};
use tract_onnx::prelude::*;

use crate::{ensure_preview, MediaError, PhotoInfo, PreviewTier};

const FINDER_MODEL: &[u8] = include_bytes!("../models/face_detection_yunet_2023mar.onnx");
const MESH_MODEL: &[u8] = include_bytes!("../models/face_landmarks.onnx");

const FINDER_SIDE: usize = 640;
const MESH_SIDE: usize = 256;
const FACE_CONFIDENCE: f32 = 0.6;
/// The face is taken with this much room around it, as the landmark model expects.
const MESH_MARGIN: f32 = 1.5;
/// Smaller faces than this share of the photo's long edge are too small to judge.
const SMALLEST_FACE_SHARE: f32 = 0.04;
const SMALLEST_FACE_PX: f32 = 40.0;
/// Open eyes measure about 0.25 to 0.35. A blink falls well below this.
const CLOSED_EYE_RATIO: f32 = 0.15;
/// Changing how eyes are judged must not reuse answers judged the old way.
const CACHE_VERSION: &str = "eyes-v1";

type Run = Box<dyn Fn(Tensor) -> TractResult<TVec<TValue>> + Send + Sync>;

struct Models {
    finder: Run,
    mesh: Run,
}

fn load(bytes: &[u8], shape: &[usize]) -> TractResult<Run> {
    let plan = tract_onnx::onnx()
        .model_for_read(&mut Cursor::new(bytes))?
        .with_input_fact(0, f32::fact(shape).into())?
        .into_optimized()?
        .into_runnable()?;
    Ok(Box::new(move |input: Tensor| plan.run(tvec!(input.into()))))
}

fn models() -> Result<&'static Models, MediaError> {
    static MODELS: OnceLock<Result<Models, String>> = OnceLock::new();
    MODELS
        .get_or_init(|| {
            Ok(Models {
                finder: load(FINDER_MODEL, &[1, 3, FINDER_SIDE, FINDER_SIDE])
                    .map_err(|e| e.to_string())?,
                mesh: load(MESH_MODEL, &[1, MESH_SIDE, MESH_SIDE, 3]).map_err(|e| e.to_string())?,
            })
        })
        .as_ref()
        .map_err(|reason| MediaError::Read {
            path: "the face models".to_string(),
            reason: reason.clone(),
        })
}

fn failed(e: impl std::fmt::Display) -> MediaError {
    MediaError::Read {
        path: "the face check".to_string(),
        reason: e.to_string(),
    }
}

struct Face {
    score: f32,
    cx: f32,
    cy: f32,
    w: f32,
    h: f32,
    right_eye: (f32, f32),
    left_eye: (f32, f32),
}

fn find_faces(models: &Models, image: &DynamicImage) -> TractResult<Vec<Face>> {
    let (w, h) = image.dimensions();
    let scale = FINDER_SIDE as f32 / w.max(h) as f32;
    let small = image
        .resize(FINDER_SIDE as u32, FINDER_SIDE as u32, FilterType::Triangle)
        .to_rgb8();
    let mut input = tract_ndarray::Array4::<f32>::zeros((1, 3, FINDER_SIDE, FINDER_SIDE));
    for (x, y, p) in small.enumerate_pixels() {
        // Blue, green, red, as the model was trained.
        for (channel, value) in [p[2], p[1], p[0]].into_iter().enumerate() {
            input[[0, channel, y as usize, x as usize]] = f32::from(value);
        }
    }
    let out = (models.finder)(Tensor::from(input))?;

    // Three grids, at strides 8, 16 and 32: scores, objectness, boxes and five points each.
    let mut faces = Vec::new();
    for (level, stride) in [8usize, 16, 32].into_iter().enumerate() {
        let cells = FINDER_SIDE / stride;
        let views = (0..4)
            .map(|k| out[level + k * 3].to_plain_array_view::<f32>())
            .collect::<Result<Vec<_>, _>>()?;
        let slices: Vec<&[f32]> = views.iter().filter_map(|v| v.as_slice()).collect();
        let [class, object, bbox, points] = slices[..] else {
            continue;
        };
        for i in 0..cells * cells {
            let score = (class[i].clamp(0.0, 1.0) * object[i].clamp(0.0, 1.0)).sqrt();
            if score < FACE_CONFIDENCE {
                continue;
            }
            let (col, row) = ((i % cells) as f32, (i / cells) as f32);
            let s = stride as f32 / scale;
            let point = |n: usize| {
                (
                    (points[i * 10 + n * 2] + col) * s,
                    (points[i * 10 + n * 2 + 1] + row) * s,
                )
            };
            faces.push(Face {
                score,
                cx: (col + bbox[i * 4]) * s,
                cy: (row + bbox[i * 4 + 1]) * s,
                w: bbox[i * 4 + 2].exp() * s,
                h: bbox[i * 4 + 3].exp() * s,
                right_eye: point(0),
                left_eye: point(1),
            });
        }
    }

    // Neighbouring cells see the same face, so only the strongest is kept.
    faces.sort_by(|a, b| b.score.total_cmp(&a.score));
    let mut kept: Vec<Face> = Vec::new();
    for face in faces {
        let same = kept
            .iter()
            .any(|k| (k.cx - face.cx).abs() < k.w * 0.5 && (k.cy - face.cy).abs() < k.h * 0.5);
        if !same {
            kept.push(face);
        }
    }
    Ok(kept)
}

fn sample(rgb: &RgbImage, x: f32, y: f32) -> [f32; 3] {
    let (w, h) = rgb.dimensions();
    let (x, y) = (
        x.clamp(0.0, w as f32 - 1.001),
        y.clamp(0.0, h as f32 - 1.001),
    );
    let (x0, y0) = (x.floor() as u32, y.floor() as u32);
    let (fx, fy) = (x - x0 as f32, y - y0 as f32);
    let at = |xx: u32, yy: u32| -> Rgb<u8> { *rgb.get_pixel(xx.min(w - 1), yy.min(h - 1)) };
    let mut out = [0.0; 3];
    for (channel, value) in out.iter_mut().enumerate() {
        let top =
            f32::from(at(x0, y0)[channel]) * (1.0 - fx) + f32::from(at(x0 + 1, y0)[channel]) * fx;
        let bottom = f32::from(at(x0, y0 + 1)[channel]) * (1.0 - fx)
            + f32::from(at(x0 + 1, y0 + 1)[channel]) * fx;
        *value = top * (1.0 - fy) + bottom * fy;
    }
    out
}

/// How open each eye is, for one face: eyelid gap against eye width.
fn eye_openness(models: &Models, rgb: &RgbImage, face: &Face) -> TractResult<(f32, f32)> {
    let angle = (face.left_eye.1 - face.right_eye.1).atan2(face.left_eye.0 - face.right_eye.0);
    let (sin, cos) = angle.sin_cos();
    let size = face.w.max(face.h) * MESH_MARGIN;
    let side = MESH_SIDE as f32;
    let to_photo = |u: f32, v: f32| {
        let (lx, ly) = ((u / side - 0.5) * size, (v / side - 0.5) * size);
        (face.cx + lx * cos - ly * sin, face.cy + lx * sin + ly * cos)
    };

    let mut input = tract_ndarray::Array4::<f32>::zeros((1, MESH_SIDE, MESH_SIDE, 3));
    for v in 0..MESH_SIDE {
        for u in 0..MESH_SIDE {
            let (x, y) = to_photo(u as f32 + 0.5, v as f32 + 0.5);
            for (channel, value) in sample(rgb, x, y).into_iter().enumerate() {
                input[[0, v, u, channel]] = value / 255.0;
            }
        }
    }
    let out = (models.mesh)(Tensor::from(input))?;
    let landmarks = out
        .iter()
        .find(|t| t.len() == 478 * 3)
        .ok_or_else(|| TractError::msg("the landmark model gave no landmarks"))?;
    let flat = landmarks.to_plain_array_view::<f32>()?;
    let flat = flat
        .as_slice()
        .ok_or_else(|| TractError::msg("unexpected landmark layout"))?;
    let point = |i: usize| to_photo(flat[i * 3], flat[i * 3 + 1]);
    let gap = |a: usize, b: usize| {
        let (p, q) = (point(a), point(b));
        (p.0 - q.0).hypot(p.1 - q.1)
    };
    // MediaPipe's points for each eye's corners and its upper and lower lids.
    let ratio = |corners: (usize, usize), lids: [(usize, usize); 2]| {
        (gap(lids[0].0, lids[0].1) + gap(lids[1].0, lids[1].1))
            / (2.0 * gap(corners.0, corners.1)).max(1e-3)
    };
    Ok((
        ratio((33, 133), [(160, 144), (158, 153)]),
        ratio((362, 263), [(385, 380), (387, 373)]),
    ))
}

/// True when anyone large enough to judge has both eyes closed.
pub fn has_closed_eyes(image: &DynamicImage) -> Result<bool, MediaError> {
    let models = models()?;
    let rgb = image.to_rgb8();
    let long_edge = image.width().max(image.height()) as f32;
    let smallest = SMALLEST_FACE_PX.max(long_edge * SMALLEST_FACE_SHARE);
    for face in find_faces(models, image).map_err(failed)? {
        if face.w.min(face.h) < smallest {
            continue;
        }
        let (a, b) = eye_openness(models, &rgb, &face).map_err(failed)?;
        if (a + b) / 2.0 < CLOSED_EYE_RATIO {
            return Ok(true);
        }
    }
    Ok(false)
}

/// The same, for an imported photo, remembering the answer so each photo is looked at once.
pub fn photo_has_closed_eyes(photo: &PhotoInfo, cache_dir: &Path) -> Result<bool, MediaError> {
    let saved_at = cache_dir.join(format!("{}.{CACHE_VERSION}", photo.id));
    if let Ok(saved) = fs::read_to_string(&saved_at) {
        return Ok(saved == "closed");
    }
    // The larger preview: the grid one is too small to see eyelids.
    let preview = ensure_preview(photo, cache_dir, PreviewTier::Edit)?;
    let image = image::open(&preview).map_err(|e| MediaError::Read {
        path: preview.display().to_string(),
        reason: e.to_string(),
    })?;
    let closed = has_closed_eyes(&image)?;
    // Only a time saver, so failing to keep the answer must not fail the check.
    let _ = fs::write(&saved_at, if closed { "closed" } else { "open" });
    Ok(closed)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn photo(name: &str) -> DynamicImage {
        image::open(
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("testdata")
                .join(name),
        )
        .unwrap()
    }

    #[test]
    fn a_person_with_their_eyes_closed_is_noticed() {
        assert!(has_closed_eyes(&photo("eyes-closed.jpg")).unwrap());
    }

    #[test]
    fn a_person_with_their_eyes_open_is_not() {
        assert!(!has_closed_eyes(&photo("eyes-open.png")).unwrap());
    }

    #[test]
    fn a_photo_with_no_one_in_it_is_not() {
        let empty = DynamicImage::ImageRgb8(RgbImage::from_pixel(800, 600, Rgb([90, 140, 60])));
        assert!(!has_closed_eyes(&empty).unwrap());
    }

    #[test]
    fn eyes_too_small_to_judge_are_left_alone() {
        // The closed-eyed traveller, made tiny in a large frame.
        let small = photo("eyes-closed.jpg").resize(120, 120, FilterType::Triangle);
        let mut frame =
            DynamicImage::ImageRgb8(RgbImage::from_pixel(4000, 3000, Rgb([200, 200, 200])));
        image::imageops::overlay(&mut frame, &small, 100, 100);
        assert!(!has_closed_eyes(&frame).unwrap());
    }
}
