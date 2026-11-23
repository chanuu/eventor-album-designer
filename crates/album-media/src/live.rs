//! The retoucher's picture, redrawn quickly while the photographer works.
//!
//! Reading a photo from disk and redoing every edit for each small change is what makes
//! a preview lag. This keeps the steps in memory: the photo at the size shown, the photo
//! with Magic skin, and that with every stroke but the newest. A change to the colour or
//! to the stroke being painted then only redoes the end of the work.
//!
//! The result is exactly what `adjusted_preview` draws, before JPEG.

use std::path::{Path, PathBuf};

use album_core::adjust::Adjustments;
use album_core::retouch::{apply_retouch, FaceMakeup, RetouchEdits, SkinMap, SkinSettings, Stroke};
use image::RgbImage;

use crate::MediaError;

/// How many sizes are kept: the quick one and the full one.
const KEPT: usize = 2;

struct Stage {
    preview: PathBuf,
    edge: Option<u32>,
    base: RgbImage,
    skin: SkinSettings,
    skin_skip: Vec<[f64; 2]>,
    /// Whether the faces were known when `skinned` was drawn.
    with_faces: bool,
    skinned: RgbImage,
    makeup: Vec<FaceMakeup>,
    /// `skinned` with `makeup`.
    made_up: RgbImage,
    strokes: Vec<Stroke>,
    /// `made_up` with `strokes`.
    stroked: RgbImage,
}

impl Stage {
    fn open(preview: &Path, edge: Option<u32>) -> Result<Self, MediaError> {
        let base = crate::open_at(preview, edge)?;
        Ok(Self {
            preview: preview.to_path_buf(),
            edge,
            skin: SkinSettings::default(),
            skin_skip: Vec::new(),
            with_faces: false,
            skinned: base.clone(),
            makeup: Vec::new(),
            made_up: base.clone(),
            strokes: Vec::new(),
            stroked: base.clone(),
            base,
        })
    }

    fn draw(&mut self, edits: &RetouchEdits, faces: Option<&SkinMap>) -> RgbImage {
        let edits = edits.sanitized();
        let skin_again = self.skin != edits.skin
            || self.skin_skip != edits.skin_skip
            || self.with_faces != faces.is_some();
        if skin_again {
            self.skinned = self.base.clone();
            let only_skin = RetouchEdits {
                skin: edits.skin,
                skin_skip: edits.skin_skip.clone(),
                ..RetouchEdits::default()
            };
            paint(&mut self.skinned, &only_skin, faces);
            self.skin = edits.skin;
            self.skin_skip.clone_from(&edits.skin_skip);
            self.with_faces = faces.is_some();
        }
        if skin_again || self.makeup != edits.makeup {
            self.made_up = self.skinned.clone();
            let only_makeup = RetouchEdits {
                makeup: edits.makeup.clone(),
                ..RetouchEdits::default()
            };
            paint(&mut self.made_up, &only_makeup, faces);
            self.makeup.clone_from(&edits.makeup);
            self.strokes.clear();
            self.stroked = self.made_up.clone();
        }
        // The newest stroke may still be growing, so it is never kept.
        let settled = edits.strokes.len().saturating_sub(1);
        let (kept, newest) = edits.strokes.split_at(settled);
        if !kept.starts_with(&self.strokes) {
            self.strokes.clear();
            self.stroked = self.made_up.clone();
        }
        let more = kept[self.strokes.len()..].to_vec();
        if !more.is_empty() {
            self.strokes.extend_from_slice(&more);
            paint(&mut self.stroked, &only_strokes(more), None);
        }
        let mut image = self.stroked.clone();
        if !newest.is_empty() {
            paint(&mut image, &only_strokes(newest.to_vec()), None);
        }
        image
    }
}

fn only_strokes(strokes: Vec<Stroke>) -> RetouchEdits {
    RetouchEdits {
        strokes,
        ..RetouchEdits::default()
    }
}

fn paint(image: &mut RgbImage, edits: &RetouchEdits, faces: Option<&SkinMap>) {
    let (w, h) = (image.width() as usize, image.height() as usize);
    apply_retouch(image, w, h, edits, faces);
}

#[derive(Default)]
pub struct LivePreview {
    stages: Vec<Stage>,
}

impl LivePreview {
    /// The photo at `preview` with every edit, at most `edge` pixels on its long side.
    pub fn draw(
        &mut self,
        preview: &Path,
        adjust: &Adjustments,
        edits: &RetouchEdits,
        faces: Option<&SkinMap>,
        edge: Option<u32>,
    ) -> Result<RgbImage, MediaError> {
        // Another photo is open now, so the last one's pictures are only in the way.
        self.stages.retain(|s| s.preview == preview);
        let mut stage = match self.stages.iter().position(|s| s.edge == edge) {
            Some(at) => self.stages.remove(at),
            None => Stage::open(preview, edge)?,
        };
        let mut image = stage.draw(edits, faces);
        self.stages.push(stage);
        if self.stages.len() > KEPT {
            self.stages.remove(0);
        }
        adjust.apply_rgb(&mut image);
        Ok(image)
    }
}

/// Width and height as little-endian u32, then RGBA: what a canvas takes as it is, so
/// neither side spends time on JPEG.
pub fn to_canvas_bytes(image: &RgbImage) -> Vec<u8> {
    let mut out = Vec::with_capacity(8 + (image.width() * image.height()) as usize * 4);
    out.extend_from_slice(&image.width().to_le_bytes());
    out.extend_from_slice(&image.height().to_le_bytes());
    for p in image.pixels() {
        out.extend_from_slice(&[p.0[0], p.0[1], p.0[2], 255]);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use album_core::retouch::{Makeup, Tool};

    fn stroke(tool: Tool, x: f64, radius: f64) -> Stroke {
        Stroke {
            tool,
            points: vec![[x, 0.4], [x + 0.1, 0.5]],
            radius,
            softness: 0.5,
            strength: 0.8,
            source: None,
        }
    }

    fn a_portrait() -> PathBuf {
        std::fs::read_dir(Path::new(env!("CARGO_MANIFEST_DIR")).join("testdata"))
            .unwrap()
            .filter_map(|e| Some(e.ok()?.path()))
            .find(|p| p.extension().is_some_and(|e| e == "jpg"))
            .unwrap()
    }

    /// Whatever order edits arrive in, the kept steps must not change the picture.
    #[test]
    fn kept_steps_draw_what_a_fresh_drawing_does() {
        let photo = a_portrait();
        let faces = crate::skin::find_skin(&image::open(&photo).unwrap()).unwrap();
        let skin = SkinSettings {
            smooth: 0.6,
            brighten: 0.2,
            even: 0.4,
        };
        let a = stroke(Tool::Smooth, 0.3, 0.03);
        let b = stroke(Tool::Heal, 0.5, 0.02);
        let c = stroke(Tool::Darken, 0.2, 0.05);
        let mut longer = c.clone();
        longer.points.push([0.5, 0.7]);
        let colour = Adjustments {
            exposure: 0.3,
            ..Adjustments::default()
        };
        let none = SkinSettings::default();
        let steps = [
            (vec![], none),
            (vec![a.clone()], none),
            (vec![a.clone(), b.clone()], none),
            (vec![a.clone(), b.clone(), c.clone()], skin),
            (vec![a.clone(), b.clone(), longer], skin),
            (vec![a.clone(), b.clone()], skin),
            (vec![c.clone(), b.clone()], skin),
            (vec![a], none),
            (vec![], skin),
        ];
        let mut live = LivePreview::default();
        let middle = faces.faces[0].middle();
        let lips = |lip: f32| FaceMakeup {
            at: middle,
            makeup: Makeup {
                lip,
                blush: 0.5,
                ..Makeup::default()
            },
        };
        let makeup = [vec![], vec![lips(0.4)], vec![lips(0.8)]];
        for (n, (strokes, skin)) in steps.into_iter().enumerate() {
            let edits = RetouchEdits {
                strokes,
                skin,
                makeup: makeup[(n / 2) % 3].clone(),
                skin_skip: if n == 5 { vec![middle] } else { vec![] },
            };
            let known = edits.needs_faces().then_some(&faces);
            for edge in [Some(300), None] {
                let got = live.draw(&photo, &colour, &edits, known, edge).unwrap();
                let mut want = crate::open_at(&photo, edge).unwrap();
                paint(&mut want, &edits, known);
                colour.apply_rgb(&mut want);
                assert!(got == want, "step {n} at {edge:?} differs");
            }
        }
    }

    #[test]
    fn canvas_bytes_carry_the_size_and_opaque_pixels() {
        let image = RgbImage::from_pixel(3, 2, image::Rgb([1, 2, 3]));
        let bytes = to_canvas_bytes(&image);
        assert_eq!(bytes[..12], [3, 0, 0, 0, 2, 0, 0, 0, 1, 2, 3, 255]);
        assert_eq!(bytes.len(), 8 + 3 * 2 * 4);
    }
}
