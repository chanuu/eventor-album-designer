//! Makeup: lip colour, blush, contour and highlight, placed by a face's 478 points.
//!
//! Colour is laid on in a perceptual space as a soft change to what is there, never as
//! paint over it, so skin and lip texture stay. How strong each part is follows the
//! face's own skin, so the same setting suits fair and dark skin.

use rayon::prelude::*;
use serde::{Deserialize, Serialize};

type Pt = (f32, f32);

/// What is put on one face. Each amount is 0 to 1.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Makeup {
    pub lip_rgb: [u8; 3],
    pub lip: f32,
    pub gloss: f32,
    pub blush_rgb: [u8; 3],
    pub blush: f32,
    pub contour: f32,
    pub highlight: f32,
}

impl Default for Makeup {
    fn default() -> Self {
        Self {
            lip_rgb: [178, 62, 84],
            lip: 0.0,
            gloss: 0.0,
            blush_rgb: [226, 110, 120],
            blush: 0.0,
            contour: 0.0,
            highlight: 0.0,
        }
    }
}

impl Makeup {
    /// Whether it changes nothing.
    pub fn is_none(&self) -> bool {
        [
            self.lip,
            self.gloss,
            self.blush,
            self.contour,
            self.highlight,
        ]
        .iter()
        .all(|v| *v <= 0.0)
    }

    pub fn sanitized(&self) -> Self {
        let unit = |v: f32| {
            if v.is_finite() {
                v.clamp(0.0, 1.0)
            } else {
                0.0
            }
        };
        Self {
            lip: unit(self.lip),
            gloss: unit(self.gloss),
            blush: unit(self.blush),
            contour: unit(self.contour),
            highlight: unit(self.highlight),
            ..*self
        }
    }
}

/// How far a face is turned: 1 looks straight out, 0 is fully from the side.
pub fn facing(points: &[[f64; 2]], aspect: f64) -> f64 {
    let far = |a: usize, b: usize| {
        ((points[a][0] - points[b][0]) * aspect).hypot(points[a][1] - points[b][1])
    };
    if points.len() < 468 {
        return 0.0;
    }
    let (r, l) = (far(1, 234), far(1, 454));
    r.min(l) / r.max(l).max(1e-9)
}

/// Below this, makeup on a face would hardly show.
pub const SIDE_ON: f64 = 0.18;

/// A polygon with the box around it, so that far pixels cost almost nothing.
struct Shape {
    points: Vec<Pt>,
    min: Pt,
    max: Pt,
}

impl Shape {
    fn new(points: Vec<Pt>) -> Self {
        let min = points
            .iter()
            .fold((f32::MAX, f32::MAX), |m, p| (m.0.min(p.0), m.1.min(p.1)));
        let max = points
            .iter()
            .fold((f32::MIN, f32::MIN), |m, p| (m.0.max(p.0), m.1.max(p.1)));
        Self { points, min, max }
    }

    /// Signed distance, exact within `near` of the shape and at least `near` beyond it.
    fn distance(&self, p: Pt, near: f32) -> f32 {
        let outside = (self.min.0 - p.0)
            .max(p.0 - self.max.0)
            .max(self.min.1 - p.1)
            .max(p.1 - self.max.1);
        if outside > near {
            outside
        } else {
            signed(&self.points, p)
        }
    }
}

const OUTLINE: [usize; 36] = [
    10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152,
    148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109,
];
const EYE_R: [usize; 16] = [
    33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246,
];
const EYE_L: [usize; 16] = [
    263, 249, 390, 373, 374, 380, 381, 382, 362, 398, 384, 385, 386, 387, 388, 466,
];
const BROW_R: [usize; 10] = [70, 63, 105, 66, 107, 55, 65, 52, 53, 46];
const BROW_L: [usize; 10] = [300, 293, 334, 296, 336, 285, 295, 282, 283, 276];
const LIP_OUT: [usize; 20] = [
    61, 146, 91, 181, 84, 17, 314, 405, 321, 375, 291, 409, 270, 269, 267, 0, 37, 39, 40, 185,
];
const LIP_IN: [usize; 20] = [
    78, 95, 88, 178, 87, 14, 317, 402, 318, 324, 308, 415, 310, 311, 312, 13, 82, 81, 80, 191,
];

fn lin(v: u8) -> f32 {
    let c = f32::from(v) / 255.0;
    if c <= 0.04045 {
        c / 12.92
    } else {
        ((c + 0.055) / 1.055).powf(2.4)
    }
}
fn unlin(c: f32) -> u8 {
    let c = c.clamp(0.0, 1.0);
    let v = if c <= 0.003_130_8 {
        c * 12.92
    } else {
        1.055 * c.powf(1.0 / 2.4) - 0.055
    };
    (v * 255.0).round() as u8
}
fn to_lab(p: [u8; 3]) -> [f32; 3] {
    let [r, g, b] = p.map(lin);
    let l = (0.412_221_46 * r + 0.536_332_55 * g + 0.051_445_995 * b).cbrt();
    let m = (0.211_903_5 * r + 0.680_699_5 * g + 0.107_396_96 * b).cbrt();
    let s = (0.088_302_46 * r + 0.281_718_85 * g + 0.629_978_7 * b).cbrt();
    [
        0.210_454_26 * l + 0.793_617_8 * m - 0.004_072_047 * s,
        1.977_998_5 * l - 2.428_592_2 * m + 0.450_593_7 * s,
        0.025_904_037 * l + 0.782_771_77 * m - 0.808_675_77 * s,
    ]
}
fn from_lab([l, a, b]: [f32; 3]) -> [u8; 3] {
    let p = (l + 0.396_337_78 * a + 0.215_803_76 * b).powi(3);
    let q = (l - 0.105_561_346 * a - 0.063_854_17 * b).powi(3);
    let r = (l - 0.089_484_18 * a - 1.291_485_5 * b).powi(3);
    [
        unlin(4.076_741_7 * p - 3.307_711_6 * q + 0.230_969_94 * r),
        unlin(-1.268_438 * p + 2.609_757_4 * q - 0.341_319_38 * r),
        unlin(-0.004_196_086 * p - 0.703_418_6 * q + 1.707_614_7 * r),
    ]
}

fn dist(a: Pt, b: Pt) -> f32 {
    (a.0 - b.0).hypot(a.1 - b.1)
}
fn mix(a: Pt, b: Pt, t: f32) -> Pt {
    (a.0 + (b.0 - a.0) * t, a.1 + (b.1 - a.1) * t)
}
fn smooth(a: f32, b: f32, x: f32) -> f32 {
    let t = ((x - a) / (b - a)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

/// Signed distance to a polygon: negative inside.
fn signed(poly: &[Pt], p: Pt) -> f32 {
    let (mut d, mut inside) = (f32::MAX, false);
    let mut j = poly.len() - 1;
    for i in 0..poly.len() {
        let (a, b) = (poly[i], poly[j]);
        let (ex, ey) = (b.0 - a.0, b.1 - a.1);
        let (wx, wy) = (p.0 - a.0, p.1 - a.1);
        let t = ((wx * ex + wy * ey) / (ex * ex + ey * ey).max(1e-6)).clamp(0.0, 1.0);
        d = d.min((wx - ex * t).hypot(wy - ey * t));
        if (a.1 > p.1) != (b.1 > p.1) && p.0 < (b.0 - a.0) * (p.1 - a.1) / (b.1 - a.1) + a.0 {
            inside = !inside;
        }
        j = i;
    }
    if inside {
        -d
    } else {
        d
    }
}

/// Rounds a lip outline, whose 20 points would show as corners.
fn rounded(poly: &[Pt]) -> Vec<Pt> {
    let n = poly.len();
    let mut out = Vec::with_capacity(n * 4);
    for i in 0..n {
        let [a, b, c, d] = [
            poly[(i + n - 1) % n],
            poly[i],
            poly[(i + 1) % n],
            poly[(i + 2) % n],
        ];
        for k in 0..4 {
            let t = k as f32 / 4.0;
            let f = |a: f32, b: f32, c: f32, d: f32| {
                0.5 * (2.0 * b
                    + (c - a) * t
                    + (2.0 * a - 5.0 * b + 4.0 * c - d) * t * t
                    + (3.0 * b - a - 3.0 * c + d) * t * t * t)
            };
            out.push((f(a.0, b.0, c.0, d.0), f(a.1, b.1, c.1, d.1)));
        }
    }
    out
}

/// A soft stroke along a line: 1 on it, fading over `s`.
fn stroke(points: &[Pt], s: f32, p: Pt) -> f32 {
    let mut d = f32::MAX;
    for pair in points.windows(2) {
        let (a, b) = (pair[0], pair[1]);
        let (ex, ey) = (b.0 - a.0, b.1 - a.1);
        let t =
            (((p.0 - a.0) * ex + (p.1 - a.1) * ey) / (ex * ex + ey * ey).max(1e-6)).clamp(0.0, 1.0);
        d = d.min(dist(p, (a.0 + ex * t, a.1 + ey * t)));
    }
    (-(d / s).powi(2)).exp()
}

/// A soft dab, `along` towards `to` and `across` the other way.
fn dab(c: Pt, to: Pt, along: f32, across: f32, p: Pt) -> f32 {
    let len = dist(c, to).max(1e-3);
    let (ux, uy) = ((to.0 - c.0) / len, (to.1 - c.1) / len);
    let (dx, dy) = (p.0 - c.0, p.1 - c.1);
    let (u, v) = (dx * ux + dy * uy, -dx * uy + dy * ux);
    (-(u / along).powi(2) - (v / across).powi(2)).exp()
}

/// Draws makeup on one face, on tightly packed RGB bytes. `points` are in pixels.
pub fn apply_makeup(px: &mut [u8], w: usize, h: usize, points: &[Pt], m: &Makeup) {
    let m = &m.sanitized();
    if m.is_none() || points.len() < 468 || px.len() != w * h * 3 {
        return;
    }
    let at = |i: usize| points[i];
    let pick = |ids: &[usize]| ids.iter().map(|&i| points[i]).collect::<Vec<_>>();
    let outline = pick(&OUTLINE);
    // Height hardly changes as a head turns, so it sets the sizes; width tells the turn.
    let fw = dist(at(10), at(152)) * 0.78;
    let nose = at(1);
    let (right_w, left_w) = (dist(nose, at(234)), dist(nose, at(454)));
    let widest = right_w.max(left_w).max(1.0);
    // The far cheek of a turned head gets less, and none once it is out of sight.
    let side = |v: f32| smooth(0.22, 0.6, v / widest);
    let (rs, ls) = (side(right_w), side(left_w));
    // The points of a face seen from the side are guesses, so makeup there would miss.
    let turn = right_w.min(left_w) / widest;
    let facing = smooth(0.12, 0.35, turn);
    if facing <= 0.0 {
        return;
    }

    let lab_at = |p: Pt| -> Option<[f32; 3]> {
        let (x, y) = (p.0 as isize, p.1 as isize);
        if x < 0 || y < 0 || x as usize >= w || y as usize >= h {
            return None;
        }
        let i = (y as usize * w + x as usize) * 3;
        Some(to_lab([px[i], px[i + 1], px[i + 2]]))
    };
    // The face's own skin, from patches of cheek and forehead: a median, so a hair or a
    // shine in one of them does not count.
    let mut seen: Vec<[f32; 3]> = Vec::new();
    for i in [50, 280, 101, 330, 151, 205, 425] {
        let r = fw * 0.03;
        for k in 0..49 {
            let (dx, dy) = ((k % 7) as f32 / 3.0 - 1.0, (k / 7) as f32 / 3.0 - 1.0);
            seen.extend(lab_at((at(i).0 + dx * r, at(i).1 + dy * r)));
        }
    }
    if seen.len() < 40 {
        return;
    }
    let mut median = |k: usize| {
        seen.sort_by(|a, b| a[k].total_cmp(&b[k]));
        seen[seen.len() / 2][k]
    };
    let skin = [median(0), median(1), median(2)];

    let holes: Vec<Vec<Pt>> = [&EYE_R[..], &EYE_L, &BROW_R, &BROW_L, &LIP_OUT]
        .iter()
        .map(|ids| pick(ids))
        .collect();
    let lip_out = rounded(&holes[4]);
    let shapes: Vec<Shape> = holes.iter().map(|h| Shape::new(h.clone())).collect();
    let lip_shape = Shape::new(lip_out.clone());
    let lip_in = rounded(&pick(&LIP_IN));
    // How far the mouth is open, so that a shut one keeps its colour across the middle.
    let open = dist(at(13), at(14)) / fw;

    // Average lip lightness, so a shade changes the lips' colour but not their modelling.
    let mut lips: Vec<[f32; 3]> = Vec::new();
    let steps = 40;
    let (lx0, lx1) = lip_out
        .iter()
        .fold((f32::MAX, f32::MIN), |(a, b), p| (a.min(p.0), b.max(p.0)));
    let (ly0, ly1) = lip_out
        .iter()
        .fold((f32::MAX, f32::MIN), |(a, b), p| (a.min(p.1), b.max(p.1)));
    for k in 0..steps * steps {
        let p = (
            lx0 + (lx1 - lx0) * (k % steps) as f32 / steps as f32,
            ly0 + (ly1 - ly0) * (k / steps) as f32 / steps as f32,
        );
        if signed(&lip_out, p) < -fw * 0.008 && (open < 0.015 || signed(&lip_in, p) > 0.0) {
            lips.extend(lab_at(p));
        }
    }
    if lips.len() < 20 {
        return;
    }
    let mut lip_median = |k: usize| {
        lips.sort_by(|a, b| a[k].total_cmp(&b[k]));
        lips[lips.len() / 2][k]
    };
    let (lip_mean, lip_red) = (lip_median(0), lip_median(1));
    // Teeth and the dark between the lips, judged against these lips. The points often
    // say a slightly open mouth is shut, so the colours near the seam decide instead.
    let before: Vec<u8> = px.to_vec();
    // Redness averaged over a small disc: photos store colour in coarse blocks, whose steps
    // would show along an edge.
    let redness = |x: usize, y: usize, r: f32| -> f32 {
        let (mut sum, mut n) = (0.0f32, 0.0f32);
        for (dx, dy) in (-3i32..=3).flat_map(|i| (-3i32..=3).map(move |j| (i, j))) {
            let far = ((dx * dx + dy * dy) as f32) / 9.0;
            if far > 1.2 {
                continue;
            }
            let nx = (x as f32 + dx as f32 / 3.0 * r).round() as isize;
            let ny = (y as f32 + dy as f32 / 3.0 * r).round() as isize;
            if nx >= 0 && ny >= 0 && (nx as usize) < w && (ny as usize) < h {
                let i = (ny as usize * w + nx as usize) * 3;
                let k = (-1.5 * far).exp();
                sum += k * to_lab([before[i], before[i + 1], before[i + 2]])[1];
                n += k;
            }
        }
        if n > 0.0 {
            sum / n
        } else {
            0.0
        }
    };
    let mouth = |x: usize, y: usize, c: [f32; 3], seam: f32| -> f32 {
        // The wider open the mouth, the better the points know where its edge is, and a
        // shine on the lip beyond it is not a tooth.
        let band = fw * (0.05 - 0.04 * smooth(0.02, 0.05, open));
        let near = smooth(band, band * 0.6, seam);
        if near <= 0.0 {
            return 0.0;
        }
        let red = redness(x, y, fw * 0.003);
        // Lips with little red in them cannot be told apart by it; there, teeth are pale.
        let tells = smooth(0.02, 0.05, lip_red);
        let grey = smooth(lip_red * 0.82, lip_red * 0.5, red) * tells;
        let pale = smooth(lip_mean + 0.12, lip_mean + 0.2, c[0]) * (1.0 - tells);
        let gap = smooth(lip_mean * 0.62, lip_mean * 0.45, c[0]);
        near * grey.max(pale).max(gap)
    };
    let shade = to_lab(m.lip_rgb);
    let rouge = to_lab(m.blush_rgb);
    // On darker skin the same pale shade would look chalky, so shades follow the skin down.
    let deep = smooth(0.62, 0.3, skin[0]);

    let cheek_r = mix(at(50), at(205), 0.25);
    let cheek_l = mix(at(280), at(425), 0.25);
    let hollow_r = [
        mix(at(93), at(132), 0.25),
        at(147),
        mix(at(187), at(207), 0.3),
    ];
    let hollow_l = [
        mix(at(323), at(361), 0.25),
        at(376),
        mix(at(411), at(427), 0.3),
    ];
    let jaw = |ids: &[usize]| -> Vec<Pt> { ids.iter().map(|&i| mix(at(i), nose, 0.04)).collect() };
    let jaw_r = jaw(&[58, 172, 136, 150, 149, 176]);
    let jaw_l = jaw(&[288, 397, 365, 379, 378, 400]);
    let temple_r = [mix(at(54), nose, 0.1), mix(at(103), nose, 0.07)];
    let temple_l = [mix(at(284), nose, 0.1), mix(at(332), nose, 0.07)];
    let bridge: Vec<Pt> = pick(&[6, 197, 195, 5]);
    let (dx, dy) = (at(454).0 - at(234).0, at(454).1 - at(234).1);
    let len = dx.hypot(dy).max(1e-3);
    let across = (dx / len * fw * 0.075, dy / len * fw * 0.075);
    let turned = rs.min(ls);
    let nose_r: Vec<Pt> = bridge
        .iter()
        .map(|p| (p.0 - across.0, p.1 - across.1))
        .collect();
    let nose_l: Vec<Pt> = bridge
        .iter()
        .map(|p| (p.0 + across.0, p.1 + across.1))
        .collect();
    let high_r = [mix(at(117), at(50), 0.3), mix(at(116), at(123), 0.3)];
    let high_l = [mix(at(346), at(280), 0.3), mix(at(345), at(352), 0.3)];

    let (mut x0, mut y0, mut x1, mut y1) = (f32::MAX, f32::MAX, f32::MIN, f32::MIN);
    for p in outline.iter() {
        x0 = x0.min(p.0);
        y0 = y0.min(p.1);
        x1 = x1.max(p.0);
        y1 = y1.max(p.1);
    }
    let (x0, y0) = (x0.max(0.0) as usize, y0.max(0.0) as usize);
    let (x1, y1) = ((x1.max(0.0) as usize).min(w), (y1.max(0.0) as usize).min(h));
    if x0 >= x1 || y0 >= y1 {
        return;
    }
    px[y0 * w * 3..y1 * w * 3]
        .par_chunks_mut(w * 3)
        .enumerate()
        .for_each(|(row, line)| {
            let y = (y0 + row) as f32 + 0.5;
            for x in x0..x1 {
                let p = (x as f32 + 0.5, y);
                let edge = signed(&outline, p);
                if edge >= 0.0 {
                    continue;
                }
                let out = &mut line[x * 3..x * 3 + 3];
                let mut c = to_lab([out[0], out[1], out[2]]);

                // Skin: inside the face, clear of eyes, brows and lips, and skin-coloured,
                // so strands of hair and a hand of another colour are left alone.
                let mut on_skin = facing * smooth(0.0, fw * 0.07, -edge);
                for hole in &shapes {
                    on_skin *= smooth(0.0, fw * 0.025, hole.distance(p, fw * 0.04) - fw * 0.006);
                }
                let off = ((c[1] - skin[1]).powi(2) + (c[2] - skin[2]).powi(2)).sqrt();
                on_skin *= smooth(0.085, 0.04, off) * smooth(skin[0] * 0.5, skin[0] * 0.75, c[0]);
                if on_skin > 0.002 {
                    let shade = (rs * stroke(&hollow_r, fw * 0.075, p))
                        .max(ls * stroke(&hollow_l, fw * 0.075, p))
                        .max(0.8 * rs * stroke(&jaw_r, fw * 0.06, p))
                        .max(0.8 * ls * stroke(&jaw_l, fw * 0.06, p))
                        .max(0.6 * rs * stroke(&temple_r, fw * 0.09, p))
                        .max(0.6 * ls * stroke(&temple_l, fw * 0.09, p))
                        .max(0.55 * turned * stroke(&nose_r, fw * 0.022, p))
                        .max(0.55 * turned * stroke(&nose_l, fw * 0.022, p));
                    let light = (rs * stroke(&high_r, fw * 0.05, p))
                        .max(ls * stroke(&high_l, fw * 0.05, p))
                        .max(0.8 * stroke(&bridge, fw * 0.018, p))
                        .max(0.6 * dab(at(151), at(10), fw * 0.1, fw * 0.14, p))
                        .max(0.5 * dab(at(199), at(152), fw * 0.045, fw * 0.06, p));
                    let rosy = (rs * dab(cheek_r, at(127), fw * 0.17, fw * 0.1, p))
                        .max(ls * dab(cheek_l, at(356), fw * 0.17, fw * 0.1, p));
                    let dark = m.contour * shade * on_skin;
                    c[0] *= 1.0 - 0.09 * dark;
                    c[2] += 0.008 * dark;
                    let lift = m.highlight * light * on_skin * (1.0 - smooth(0.8, 0.95, c[0]));
                    c[0] += 0.055 * lift * (0.7 + 0.3 * c[0]);
                    c[2] += 0.004 * lift;
                    let k = m.blush * rosy * on_skin;
                    // A softly graded photo has pale skin, and full colour on it looks painted.
                    let rich = (skin[1].hypot(skin[2]) / 0.085).clamp(0.35, 1.1);
                    let length = rouge[1].hypot(rouge[2]).max(0.02);
                    c[1] += 0.034 * rich * k * rouge[1] / length;
                    c[2] += 0.016 * rich * k * rouge[2] / length;
                    c[0] -= 0.012 * k;
                }

                if m.lip > 0.0 {
                    let rim = lip_shape.distance(p, fw * 0.04);
                    // The points can fall short of the lip's edge, so a little beyond them
                    // counts too where it is as red as lip and not as skin.
                    let lip_like = if rim > -fw * 0.012 && rim < fw * 0.028 {
                        let red = redness(x, row + y0, fw * 0.009);
                        smooth(0.3, 0.8, (red - skin[1]) / (lip_red - skin[1]).max(0.015))
                    } else {
                        0.0
                    };
                    let outer = smooth(fw * 0.004, -fw * 0.012, rim)
                        .max(lip_like * smooth(fw * 0.028, fw * 0.004, rim));
                    if outer > 0.002 {
                        let seam = signed(&lip_in, p);
                        // Well open, what is inside the lips is mouth whatever its colour.
                        let wide = smooth(0.025, 0.05, open);
                        let inner = 1.0 - wide * smooth(fw * 0.002, -fw * 0.006, seam);
                        let teeth = mouth(x, row + y0, c, seam);
                        // Lips are never blue or green, whatever is behind a turned face.
                        let lippy =
                            facing * smooth(-0.05, -0.01, c[2]) * smooth(-0.03, 0.005, c[1]);
                        let k = m.lip * outer * inner * (1.0 - teeth) * lippy;
                        let aim = shade[0] * (1.0 - 0.25 * deep);
                        // Highlights keep more of themselves, or lips look like felt.
                        let shine = smooth(lip_mean + 0.06, lip_mean + 0.22, c[0]);
                        let keep = 1.0 - 0.35 * shine;
                        let ratio = (aim / lip_mean.max(0.15)).clamp(0.6, 1.2);
                        c[0] *= 1.0 + (ratio - 1.0) * 0.65 * k * keep;
                        c[1] += (shade[1] - c[1]) * 0.85 * k * keep;
                        c[2] += (shade[2] - c[2]) * 0.85 * k * keep;
                        let lit = smooth(
                            lip_mean,
                            lip_mean + 0.15,
                            c[0] / (1.0 + (ratio - 1.0) * 0.65),
                        );
                        c[0] += 0.1 * m.gloss * lit * outer * inner * (1.0 - teeth) * lippy;
                    }
                }
                out.copy_from_slice(&from_lab(c));
            }
        });
}
