//! Where the skin is: every face's outline, the parts never to touch, and its colour.
//!
//! The face models find each face and its 478 points. From those come the face outline,
//! holes for the eyes, brows and lips, and the skin colour sampled on the cheeks and
//! forehead. Positions are kept as shares of the photo, so the map found on a preview
//! fits the full print too. Each photo is looked at once and the answer kept.

use std::fs;
use std::path::Path;

use album_core::retouch::{SkinFace, SkinMap};
use image::{DynamicImage, RgbImage};

use crate::eyes::{face_mesh, failed, find_faces, models};
use crate::{ensure_preview, MediaError, PhotoInfo, PreviewTier};

/// Changing how skin is found must not reuse maps found the old way.
const CACHE_VERSION: &str = "skin-v2";
/// Only faces the finder is this sure of. Below it, an ear or a hand can pass as one.
const SKIN_FACE_CONFIDENCE: f32 = 0.8;
/// Faces smaller than this share of the photo's long edge are left alone.
const SMALLEST_FACE_SHARE: f32 = 0.03;

// MediaPipe face mesh point numbers.
const OUTLINE: [usize; 36] = [
    10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152,
    148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109,
];
const EYES: [[usize; 16]; 2] = [
    [
        33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246,
    ],
    [
        263, 249, 390, 373, 374, 380, 381, 382, 362, 398, 384, 385, 386, 387, 388, 466,
    ],
];
const BROWS: [[usize; 10]; 2] = [
    [70, 63, 105, 66, 107, 55, 65, 52, 53, 46],
    [300, 293, 334, 296, 336, 285, 295, 282, 283, 276],
];
const LIPS: [usize; 20] = [
    61, 146, 91, 181, 84, 17, 314, 405, 321, 375, 291, 409, 270, 269, 267, 0, 37, 39, 40, 185,
];
/// Cheeks and forehead, where the skin colour is sampled.
const SAMPLES: [usize; 5] = [50, 280, 101, 330, 151];

/// A shape grown about its middle, so a hole also covers lashes and lip edges.
fn grown(points: &[(f32, f32)], by: f32) -> Vec<(f32, f32)> {
    let n = points.len() as f32;
    let cx = points.iter().map(|p| p.0).sum::<f32>() / n;
    let cy = points.iter().map(|p| p.1).sum::<f32>() / n;
    points
        .iter()
        .map(|&(x, y)| (cx + (x - cx) * by, cy + (y - cy) * by))
        .collect()
}

fn chroma(rgb: &RgbImage, x: f32, y: f32) -> Option<[f32; 2]> {
    let (w, h) = rgb.dimensions();
    if x < 0.0 || y < 0.0 || x >= w as f32 || y >= h as f32 {
        return None;
    }
    let p = rgb.get_pixel(x as u32, y as u32);
    let [r, g, b] = [p[0], p[1], p[2]].map(|v| f32::from(v) / 255.0);
    let l = 0.299 * r + 0.587 * g + 0.114 * b;
    let (cb, cr) = ((b - l) * 0.564, (r - l) * 0.713);
    // Only skin-like pixels count: not blue, a little red, not black.
    (l > 0.03 && cb <= 0.02 && cr >= 0.0).then_some([cb, cr])
}

/// The skin of every face in a picture.
pub fn find_skin(image: &DynamicImage) -> Result<SkinMap, MediaError> {
    let models = models()?;
    let rgb = image.to_rgb8();
    let (w, h) = rgb.dimensions();
    let long = w.max(h) as f32;
    let share = |p: (f32, f32)| [f64::from(p.0) / f64::from(w), f64::from(p.1) / f64::from(h)];

    let mut faces = Vec::new();
    for face in find_faces(models, image).map_err(failed)? {
        if face.score < SKIN_FACE_CONFIDENCE || face.w.min(face.h) < long * SMALLEST_FACE_SHARE {
            continue;
        }
        let mesh = face_mesh(models, &rgb, &face).map_err(failed)?;
        let pick = |ids: &[usize]| ids.iter().map(|&i| mesh[i]).collect::<Vec<_>>();
        let outline = pick(&OUTLINE);
        let (x0, x1) = outline
            .iter()
            .fold((f32::MAX, f32::MIN), |(a, b), p| (a.min(p.0), b.max(p.0)));
        let width = x1 - x0;
        // A face the mesh could not fit has a tiny or huge outline; skip it.
        if !(width > face.w * 0.4 && width < face.w * 2.5) {
            continue;
        }

        let mut holes: Vec<Vec<[f64; 2]>> = Vec::new();
        for eye in EYES {
            holes.push(grown(&pick(&eye), 1.6).into_iter().map(share).collect());
        }
        for brow in BROWS {
            holes.push(grown(&pick(&brow), 1.3).into_iter().map(share).collect());
        }
        holes.push(grown(&pick(&LIPS), 1.15).into_iter().map(share).collect());

        // The skin colour: an average over small patches, with its spread.
        let radius = (width * 0.04).max(2.0);
        let mut found: Vec<[f32; 2]> = Vec::new();
        for &i in &SAMPLES {
            let (cx, cy) = mesh[i];
            let step = (radius / 3.0).max(1.0);
            let mut y = cy - radius;
            while y <= cy + radius {
                let mut x = cx - radius;
                while x <= cx + radius {
                    found.extend(chroma(&rgb, x, y));
                    x += step;
                }
                y += step;
            }
        }
        if found.len() < 8 {
            continue;
        }
        let n = found.len() as f32;
        let mean = [0, 1].map(|k| found.iter().map(|c| c[k]).sum::<f32>() / n);
        let spread = [0, 1]
            .map(|k| (found.iter().map(|c| (c[k] - mean[k]).powi(2)).sum::<f32>() / n).sqrt());

        faces.push(SkinFace {
            outline: outline.into_iter().map(share).collect(),
            holes,
            chroma: mean.map(f64::from),
            spread: spread.map(f64::from),
            width: f64::from(width / long),
        });
    }
    Ok(SkinMap { faces })
}

/// The same for an imported photo, from its editing preview, kept so each photo is
/// looked at once.
pub fn photo_skin(photo: &PhotoInfo, cache_dir: &Path) -> Result<SkinMap, MediaError> {
    let saved_at = cache_dir.join(format!("{}.{CACHE_VERSION}.json", photo.id));
    if let Some(map) = fs::read_to_string(&saved_at)
        .ok()
        .and_then(|text| serde_json::from_str::<SkinMap>(&text).ok())
    {
        return Ok(map);
    }
    let preview = ensure_preview(photo, cache_dir, PreviewTier::Edit)?;
    let image = image::open(&preview).map_err(|e| MediaError::Read {
        path: preview.display().to_string(),
        reason: e.to_string(),
    })?;
    let map = find_skin(&image)?;
    // Only a time saver, so failing to keep it must not fail the retouch.
    if let Ok(text) = serde_json::to_string(&map) {
        let _ = fs::write(&saved_at, text);
    }
    Ok(map)
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
    fn a_face_is_found_with_its_outline_holes_and_skin_colour() {
        let map = find_skin(&photo("eyes-open.png")).unwrap();
        assert!(!map.faces.is_empty(), "no face found");
        let face = &map.faces[0];
        assert_eq!(face.outline.len(), 36);
        assert_eq!(face.holes.len(), 5);
        // Skin is warm: more red than blue.
        assert!(
            face.chroma[1] > 0.0 && face.chroma[0] < 0.02,
            "{:?}",
            face.chroma
        );
        assert!(face.width > 0.05 && face.width < 1.0);
        for p in face.outline.iter().chain(face.holes.iter().flatten()) {
            assert!(
                (-0.2..=1.2).contains(&p[0]) && (-0.2..=1.2).contains(&p[1]),
                "{p:?}"
            );
        }
    }

    #[test]
    fn a_picture_with_no_face_has_no_skin() {
        let plain =
            DynamicImage::ImageRgb8(RgbImage::from_pixel(320, 240, image::Rgb([40, 60, 200])));
        assert!(find_skin(&plain).unwrap().faces.is_empty());
    }
}
