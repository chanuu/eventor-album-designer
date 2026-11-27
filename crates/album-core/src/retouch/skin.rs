//! Magic skin: smooths, brightens and evens the skin of every face at once.
//!
//! Where the faces are comes from outside (album-media finds them with its face models),
//! as a `SkinMap` whose positions are shares of the photo, so one map serves a preview
//! and the full print alike. Everything here is plain arithmetic.
//!
//! Lessons from trying this on real photos, all kept below:
//! - skin is never blue and always a little red, which keeps backgrounds out;
//! - smoothing works on log brightness, so dark skin is treated like fair skin;
//! - the edge threshold grows with the slider, or strong settings keep the bumps;
//! - evening pulls towards the nearby colour, not one face average, so shading stays.

use serde::{Deserialize, Serialize};

use rayon::prelude::*;

use super::filters::{box_blur, guided};

/// How much of each, 0 to 1. All zero is no change.
#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct SkinSettings {
    pub smooth: f64,
    pub brighten: f64,
    pub even: f64,
}

impl SkinSettings {
    pub fn is_none(&self) -> bool {
        self.smooth <= 0.0 && self.brighten <= 0.0 && self.even <= 0.0
    }

    pub fn sanitized(&self) -> Self {
        let unit = |v: f64| {
            if v.is_finite() {
                v.clamp(0.0, 1.0)
            } else {
                0.0
            }
        };
        Self {
            smooth: unit(self.smooth),
            brighten: unit(self.brighten),
            even: unit(self.even),
        }
    }
}

/// One face, as found in the photo. Points are `[x, y]` shares of the photo's width and
/// height; `width` is the face's width as a share of the photo's long edge.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SkinFace {
    /// All 478 points of the face, for makeup. Empty in maps made before it.
    #[serde(default)]
    pub points: Vec<[f64; 2]>,
    /// The outline of the face, in order around it.
    pub outline: Vec<[f64; 2]>,
    /// Eyes, brows and lips: never touched.
    pub holes: Vec<Vec<[f64; 2]>>,
    /// The face's skin colour as YCbCr chroma (Cb, Cr), and how much it varies.
    pub chroma: [f64; 2],
    pub spread: [f64; 2],
    pub width: f64,
}

/// Every face in a photo.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct SkinMap {
    pub faces: Vec<SkinFace>,
}

impl SkinFace {
    /// Left, top, width and height of the face's outline, as shares of the photo.
    pub fn bounds(&self) -> [f64; 4] {
        let fold = |k: usize| {
            self.outline
                .iter()
                .fold((f64::MAX, f64::MIN), |(a, b), p| (a.min(p[k]), b.max(p[k])))
        };
        let ((x0, x1), (y0, y1)) = (fold(0), fold(1));
        [x0, y0, x1 - x0, y1 - y0]
    }

    pub fn middle(&self) -> [f64; 2] {
        let [x, y, w, h] = self.bounds();
        [x + w / 2.0, y + h / 2.0]
    }
}

impl SkinMap {
    /// The face whose middle is nearest this spot, if the spot is on that face.
    pub fn at(&self, spot: [f64; 2]) -> Option<usize> {
        let off = |f: &SkinFace| {
            let [x, y, w, h] = f.bounds();
            let dx = (spot[0] - x - w / 2.0) / w.max(1e-9);
            let dy = (spot[1] - y - h / 2.0) / h.max(1e-9);
            dx.hypot(dy)
        };
        (0..self.faces.len())
            .map(|i| (i, off(&self.faces[i])))
            .filter(|(_, d)| *d < 0.5)
            .min_by(|a, b| a.1.total_cmp(&b.1))
            .map(|(i, _)| i)
    }
}

/// Brightness is smoothed as a logarithm offset by this, so black does not blow up.
const LOG_FLOOR: f32 = 0.03;
/// Around a face, skin-coloured pixels count as skin this far out: neck, shoulders and
/// hands near the face. As multiples of the face's width (across) and height (down).
const ZONE_ACROSS: f64 = 1.25;
const ZONE_DOWN: f64 = 3.0;
const ZONE_UP: f64 = 0.8;

fn to_ycc(c: [f32; 3]) -> [f32; 3] {
    let y = 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];
    [y, (c[2] - y) * 0.564, (c[0] - y) * 0.713]
}

fn from_ycc(c: [f32; 3]) -> [f32; 3] {
    let r = c[0] + c[2] / 0.713;
    let b = c[0] + c[1] / 0.564;
    let g = (c[0] - 0.299 * r - 0.114 * b) / 0.587;
    [r, g, b]
}

struct Placed {
    outline: Vec<(f32, f32)>,
    holes: Vec<Vec<(f32, f32)>>,
    chroma: [f32; 2],
    spread: [f32; 2],
    /// The box skin may be found in, in pixels.
    zone: (f32, f32, f32, f32),
    centre: (f32, f32),
    half: (f32, f32),
}

fn place(face: &SkinFace, w: usize, h: usize) -> Option<Placed> {
    let px = |p: &[f64; 2]| ((p[0] * w as f64) as f32, (p[1] * h as f64) as f32);
    let outline: Vec<(f32, f32)> = face.outline.iter().map(px).collect();
    if outline.len() < 3 {
        return None;
    }
    let (mut x0, mut y0, mut x1, mut y1) = (f32::MAX, f32::MAX, f32::MIN, f32::MIN);
    for &(x, y) in &outline {
        x0 = x0.min(x);
        y0 = y0.min(y);
        x1 = x1.max(x);
        y1 = y1.max(y);
    }
    let (fw, fh) = (x1 - x0, y1 - y0);
    if !(fw > 1.0 && fh > 1.0) {
        return None;
    }
    let spread = |v: f64| (v as f32).clamp(0.012, 0.03);
    Some(Placed {
        holes: face
            .holes
            .iter()
            .map(|hole| hole.iter().map(px).collect())
            .collect(),
        chroma: [face.chroma[0] as f32, face.chroma[1] as f32],
        spread: [spread(face.spread[0]), spread(face.spread[1])],
        zone: (
            x0 - fw * ZONE_ACROSS as f32,
            y0 - fh * ZONE_UP as f32,
            x1 + fw * ZONE_ACROSS as f32,
            y1 + fh * ZONE_DOWN as f32,
        ),
        centre: ((x0 + x1) / 2.0, (y0 + y1) / 2.0),
        half: (
            fw / 2.0 + fw * ZONE_ACROSS as f32,
            fh / 2.0 + fh * ZONE_DOWN as f32,
        ),
        outline,
    })
}

/// Fills a polygon into a mask of the region, setting `value` inside it. Scanline, so
/// each pixel costs one write rather than a test against every edge.
fn fill(
    mask: &mut [u8],
    rw: usize,
    rh: usize,
    origin: (usize, usize),
    poly: &[(f32, f32)],
    value: u8,
) {
    if poly.len() < 3 {
        return;
    }
    let (y0, y1) = poly
        .iter()
        .fold((f32::MAX, f32::MIN), |(a, b), p| (a.min(p.1), b.max(p.1)));
    let first = (y0.floor().max(origin.1 as f32) as usize).saturating_sub(origin.1);
    let last = ((y1.ceil() as usize).saturating_sub(origin.1)).min(rh);
    let mut crossings: Vec<f32> = Vec::with_capacity(16);
    for ry in first..last {
        let y = (ry + origin.1) as f32 + 0.5;
        crossings.clear();
        let mut j = poly.len() - 1;
        for i in 0..poly.len() {
            let (xi, yi) = poly[i];
            let (xj, yj) = poly[j];
            if (yi > y) != (yj > y) {
                crossings.push((xj - xi) * (y - yi) / (yj - yi) + xi);
            }
            j = i;
        }
        crossings.sort_by(f32::total_cmp);
        for pair in crossings.as_chunks::<2>().0 {
            // Pixel centres strictly between the two crossings.
            let from =
                ((pair[0] - 0.5).ceil().max(origin.0 as f32) as usize).saturating_sub(origin.0);
            let to = (((pair[1] - 0.5).ceil().max(0.0) as usize).saturating_sub(origin.0)).min(rw);
            if from < to {
                mask[ry * rw + from..ry * rw + to].fill(value);
            }
        }
    }
}

const OUTSIDE: u8 = 0;
const FACE: u8 = 1;
const HOLE: u8 = 2;

/// How much a pixel is skin, 0 to 1, for one face, given where it lies.
fn skin_weight(face: &Placed, x: f32, y: f32, ycc: [f32; 3], place: u8) -> f32 {
    // Skin is never blue, and always a little red.
    if place == HOLE || ycc[0] < 0.02 || ycc[1] > 0.03 || ycc[2] < -0.005 {
        return 0.0;
    }
    let z = ((ycc[1] - face.chroma[0]) / (face.spread[0] * 2.5)).powi(2)
        + ((ycc[2] - face.chroma[1]) / (face.spread[1] * 2.5)).powi(2);
    // Red spots are skin too: the colour test is looser towards red.
    let z = if ycc[2] > face.chroma[1] { z * 0.5 } else { z };
    let colour = (-0.5 * z).exp();
    if place == FACE {
        // Inside the face, trust the outline more than the colour, which shine and
        // shadow can throw off.
        return (colour * 2.0).min(1.0);
    }
    // Outside it, fade out towards the edge of the zone.
    let d = (((x - face.centre.0) / face.half.0).powi(2)
        + ((y - face.centre.1) / face.half.1).powi(2))
    .sqrt();
    if d >= 1.0 {
        return 0.0;
    }
    colour * (1.0 - d.powi(4))
}

/// Detail in log brightness bigger than this is shape, such as the shadow beside a nose
/// or the line of a lip, not a blemish, and smoothing leaves it alone.
const SHAPE: f32 = 0.09;

/// Retouches the skin of every face in `skin`, on tightly packed RGB bytes `w` by `h`.
pub fn apply_skin(pixels: &mut [u8], w: usize, h: usize, skin: &SkinMap, settings: SkinSettings) {
    let settings = settings.sanitized();
    if settings.is_none() || skin.faces.is_empty() || pixels.len() != w * h * 3 {
        return;
    }
    let faces: Vec<Placed> = skin.faces.iter().filter_map(|f| place(f, w, h)).collect();
    if faces.is_empty() {
        return;
    }
    let long = w.max(h) as f32;
    let mut widths: Vec<f32> = skin.faces.iter().map(|f| f.width as f32 * long).collect();
    widths.sort_by(f32::total_cmp);
    let face_w = widths[widths.len() / 2].max(8.0);

    // Work only inside the zones, with room for the filters around them.
    let pad = face_w * 0.12;
    let clampx = |v: f32| (v.max(0.0) as usize).min(w);
    let clampy = |v: f32| (v.max(0.0) as usize).min(h);
    let rx0 = clampx(faces.iter().map(|f| f.zone.0).fold(f32::MAX, f32::min) - pad);
    let ry0 = clampy(faces.iter().map(|f| f.zone.1).fold(f32::MAX, f32::min) - pad);
    let rx1 = clampx(faces.iter().map(|f| f.zone.2).fold(f32::MIN, f32::max) + pad);
    let ry1 = clampy(faces.iter().map(|f| f.zone.3).fold(f32::MIN, f32::max) + pad);
    if rx1 <= rx0 || ry1 <= ry0 {
        return;
    }
    let (rw, rh) = (rx1 - rx0, ry1 - ry0);

    let ycc: Vec<[f32; 3]> = (0..rw * rh)
        .into_par_iter()
        .map(|i| {
            let (x, y) = (rx0 + i % rw, ry0 + i / rw);
            let p = (y * w + x) * 3;
            to_ycc([
                f32::from(pixels[p]) / 255.0,
                f32::from(pixels[p + 1]) / 255.0,
                f32::from(pixels[p + 2]) / 255.0,
            ])
        })
        .collect();

    // Where skin is: each face's outline and holes filled in once, then the colour test.
    let mut mask = vec![0.0f32; rw * rh];
    let mut places = vec![OUTSIDE; rw * rh];
    for face in &faces {
        places.fill(OUTSIDE);
        fill(&mut places, rw, rh, (rx0, ry0), &face.outline, FACE);
        for hole in &face.holes {
            fill(&mut places, rw, rh, (rx0, ry0), hole, HOLE);
        }
        mask.par_chunks_mut(rw).enumerate().for_each(|(ry, row)| {
            let fy = (ry0 + ry) as f32 + 0.5;
            if fy < face.zone.1 || fy > face.zone.3 {
                return;
            }
            for (rx, m) in row.iter_mut().enumerate() {
                let fx = (rx0 + rx) as f32 + 0.5;
                if fx < face.zone.0 || fx > face.zone.2 {
                    continue;
                }
                let i = ry * rw + rx;
                *m = m.max(skin_weight(face, fx, fy, ycc[i], places[i]));
            }
        });
    }
    let feather = (face_w * 0.02).max(1.0) as usize;
    let mask = box_blur(&box_blur(&mask, rw, rh, feather), rw, rh, feather);

    let smooth = settings.smooth as f32;
    let even = settings.even as f32;
    let brighten = settings.brighten as f32;
    let log: Vec<f32> = ycc
        .par_iter()
        .map(|c| (c[0].max(0.0) + LOG_FLOOR).ln())
        .collect();
    // The filters are independent of each other, so they run side by side.
    let ((base, soft), (cb_near, cr_near)) = rayon::join(
        || {
            if smooth <= 0.0 {
                return (Vec::new(), Vec::new());
            }
            // Blemish-sized, so the shape of the face is kept.
            let r = (face_w * 0.015).max(2.0) as usize;
            let fine = (face_w * 0.003).max(1.0) as usize;
            rayon::join(
                || guided(&log, rw, rh, r, 0.008 + smooth * smooth * 0.05),
                || box_blur(&log, rw, rh, fine),
            )
        },
        || {
            if even <= 0.0 {
                return (Vec::new(), Vec::new());
            }
            // Wide enough to see past a blotch to the skin around it.
            let r = (face_w * 0.1).max(3.0) as usize;
            let cb: Vec<f32> = ycc.iter().map(|c| c[1]).collect();
            let cr: Vec<f32> = ycc.iter().map(|c| c[2]).collect();
            rayon::join(|| box_blur(&cb, rw, rh, r), || box_blur(&cr, rw, rh, r))
        },
    );
    // Blemishes go first; fine pores only fade above halfway, for the polished look.
    let s_mid = (smooth * 1.6).min(1.0);
    let s_fine = ((smooth - 0.4) / 0.6).clamp(0.0, 1.0) * 0.6;

    let region = &mut pixels[ry0 * w * 3..ry1 * w * 3];
    region
        .par_chunks_mut(w * 3)
        .enumerate()
        .for_each(|(ry, row)| {
            for rx in 0..rw {
                let i = ry * rw + rx;
                let m = mask[i];
                if m <= 0.002 {
                    continue;
                }
                let [y0, mut cb, mut cr] = ycc[i];
                let mut l = y0;
                if smooth > 0.0 {
                    let fine = log[i] - soft[i];
                    let mid = (log[i] - base[i]) - fine;
                    // Small detail is blemish and goes; large detail is shape and stays.
                    let keep_shape = (-(mid / SHAPE).powi(2)).exp();
                    l = (log[i] - m * (s_mid * keep_shape * mid + s_fine * fine)).exp() - LOG_FLOOR;
                }
                if even > 0.0 {
                    // Redder than the skin around it is a blotch: take most of it out. Other
                    // differences are evened more gently, so natural colour stays.
                    let red = cr - cr_near[i];
                    cr -= red * even * m * if red > 0.0 { 1.0 } else { 0.4 };
                    cb += (cb_near[i] - cb) * even * m * 0.5;
                }
                if brighten > 0.0 {
                    l += brighten * m * 0.35 * l * (1.0 - l);
                    cr -= brighten * m * 0.08 * cr.max(0.0);
                }
                let out = from_ycc([l, cb, cr]);
                let p = (rx0 + rx) * 3;
                for (k, v) in out.into_iter().enumerate() {
                    row[p + k] = (v.clamp(0.0, 1.0) * 255.0).round() as u8;
                }
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A warm "face" disc on a blue background, with grain and dark eye and lip shapes.
    fn portrait(w: usize, h: usize) -> (Vec<u8>, SkinMap) {
        let mut px = vec![0u8; w * h * 3];
        let (cx, cy, r) = (w as f32 / 2.0, h as f32 / 2.0, h as f32 * 0.3);
        for y in 0..h {
            for x in 0..w {
                let i = (y * w + x) * 3;
                let d = ((x as f32 - cx).powi(2) + (y as f32 - cy).powi(2)).sqrt();
                let c = if d < r {
                    let n = ((x * 73 + y * 151) % 17) as f32 - 8.0;
                    [200.0 + n * 2.0, 150.0 + n * 2.0, 125.0 + n * 2.0]
                } else {
                    [30.0, 40.0, 180.0]
                };
                px[i..i + 3].copy_from_slice(&c.map(|v: f32| v.clamp(0.0, 255.0) as u8));
            }
        }
        let share = |x: f32, y: f32| [f64::from(x) / w as f64, f64::from(y) / h as f64];
        let outline: Vec<[f64; 2]> = (0..36)
            .map(|k| {
                let a = k as f32 / 36.0 * std::f32::consts::TAU;
                share(cx + a.cos() * r * 0.95, cy + a.sin() * r * 0.95)
            })
            .collect();
        let eye = vec![
            share(cx - 20.0, cy - 12.0),
            share(cx - 8.0, cy - 12.0),
            share(cx - 8.0, cy - 6.0),
            share(cx - 20.0, cy - 6.0),
        ];
        let ycc = to_ycc([200.0 / 255.0, 150.0 / 255.0, 125.0 / 255.0]);
        let map = SkinMap {
            faces: vec![SkinFace {
                points: Vec::new(),
                outline,
                holes: vec![eye],
                chroma: [f64::from(ycc[1]), f64::from(ycc[2])],
                spread: [0.02, 0.02],
                width: f64::from(r * 2.0) / w.max(h) as f64,
            }],
        };
        (px, map)
    }

    fn at(px: &[u8], w: usize, x: usize, y: usize) -> [u8; 3] {
        let i = (y * w + x) * 3;
        [px[i], px[i + 1], px[i + 2]]
    }

    fn variance(px: &[u8], w: usize, x0: usize, y: usize) -> f32 {
        let v: Vec<f32> = (x0..x0 + 12)
            .map(|x| f32::from(at(px, w, x, y)[1]))
            .collect();
        let m = v.iter().sum::<f32>() / v.len() as f32;
        v.iter().map(|a| (a - m).powi(2)).sum::<f32>() / v.len() as f32
    }

    #[test]
    fn no_settings_or_no_faces_change_nothing() {
        let (mut px, map) = portrait(160, 120);
        let before = px.clone();
        apply_skin(&mut px, 160, 120, &map, SkinSettings::default());
        apply_skin(
            &mut px,
            160,
            120,
            &SkinMap::default(),
            SkinSettings {
                smooth: 1.0,
                ..Default::default()
            },
        );
        assert_eq!(px, before);
    }

    #[test]
    fn smoothing_softens_skin_and_leaves_the_background_and_eyes_alone() {
        let (w, h) = (160, 120);
        let (original, map) = portrait(w, h);
        let mut px = original.clone();
        apply_skin(
            &mut px,
            w,
            h,
            &map,
            SkinSettings {
                smooth: 1.0,
                ..Default::default()
            },
        );
        assert!(variance(&px, w, 74, 70) < variance(&original, w, 74, 70) * 0.5);
        assert_eq!(
            at(&px, w, 3, 3),
            at(&original, w, 3, 3),
            "the blue background changed"
        );
        assert_eq!(
            at(&px, w, 66, 51),
            at(&original, w, 66, 51),
            "the eye changed"
        );
    }

    #[test]
    fn brightening_lifts_skin_and_keeps_it_warm() {
        let (w, h) = (160, 120);
        let (original, map) = portrait(w, h);
        let mut px = original.clone();
        apply_skin(
            &mut px,
            w,
            h,
            &map,
            SkinSettings {
                brighten: 1.0,
                ..Default::default()
            },
        );
        let (a, b) = (at(&original, w, 80, 75), at(&px, w, 80, 75));
        assert!(b[1] > a[1] + 5, "{a:?} -> {b:?}");
        assert!(b[0] > b[2]);
    }

    #[test]
    fn settings_from_a_file_are_limited() {
        let s = SkinSettings {
            smooth: 7.0,
            brighten: f64::NAN,
            even: -1.0,
        }
        .sanitized();
        assert_eq!(
            s,
            SkinSettings {
                smooth: 1.0,
                brighten: 0.0,
                even: 0.0
            }
        );
    }
}
