//! What each tool does to the pixels under its stroke.

use super::filters::{box_blur, guided};
use super::mask::{Area, Brush};
use super::{Stroke, Tool};

/// The photo being retouched: tightly packed RGB bytes.
pub struct Image<'a> {
    pub px: &'a mut [u8],
    pub w: usize,
    pub h: usize,
}

impl Image<'_> {
    fn get(&self, x: usize, y: usize) -> [f32; 3] {
        let i = (y * self.w + x) * 3;
        [
            f32::from(self.px[i]) / 255.0,
            f32::from(self.px[i + 1]) / 255.0,
            f32::from(self.px[i + 2]) / 255.0,
        ]
    }

    fn set(&mut self, x: usize, y: usize, c: [f32; 3]) {
        let i = (y * self.w + x) * 3;
        for (k, v) in c.into_iter().enumerate() {
            self.px[i + k] = (v.clamp(0.0, 1.0) * 255.0).round() as u8;
        }
    }

    /// A copy of the pixels in `area`, so a tool can read what was there before it wrote.
    fn copy(&self, area: Area) -> Vec<[f32; 3]> {
        let mut out = Vec::with_capacity(area.w() * area.h());
        for y in area.y0..area.y1 {
            for x in area.x0..area.x1 {
                out.push(self.get(x, y));
            }
        }
        out
    }
}

fn mix(a: [f32; 3], b: [f32; 3], t: f32) -> [f32; 3] {
    [
        a[0] + (b[0] - a[0]) * t,
        a[1] + (b[1] - a[1]) * t,
        a[2] + (b[2] - a[2]) * t,
    ]
}

fn luma(c: [f32; 3]) -> f32 {
    0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]
}

/// The most a healed pixel's colour is shifted to meet its surroundings, of 1.
const MAX_CORRECTION: f32 = 0.2;

/// Log brightness, so a change means the same on dark skin as on fair.
const LOG_FLOOR: f32 = 0.03;

pub fn draw(image: &mut Image, stroke: &Stroke) {
    let brush = Brush::new(
        &stroke.points,
        stroke.radius,
        stroke.softness,
        image.w,
        image.h,
    );
    let area = brush.area(image.w, image.h);
    if brush.path.is_empty() || area.is_empty() {
        return;
    }
    let strength = stroke.strength as f32;
    match stroke.tool {
        Tool::Brighten => tone(image, &brush, area, strength * 0.8),
        Tool::Darken => tone(image, &brush, area, -strength * 0.8),
        Tool::Whiten => whiten(image, &brush, area, strength),
        Tool::RedEye => red_eye(image, &brush, area, strength),
        Tool::Smooth => smooth(image, &brush, area, strength),
        Tool::Clone => {
            if let Some(source) = stroke.source {
                let offset = (
                    (source[0] * image.w as f64).round() as i64,
                    (source[1] * image.h as f64).round() as i64,
                );
                clone(image, &brush, area, offset, strength);
            }
        }
        Tool::Heal => heal(image, &brush, area, strength),
    }
}

/// Multiplies the light under the brush by up to `stops` stops.
fn tone(image: &mut Image, brush: &Brush, area: Area, stops: f32) {
    for y in area.y0..area.y1 {
        for x in area.x0..area.x1 {
            let w = brush.weight_at(brush.distance(x, y));
            if w <= 0.0 {
                continue;
            }
            let k = 2f32.powf(stops * w);
            let c = image.get(x, y);
            image.set(x, y, c.map(|v| v * k));
        }
    }
}

/// Takes yellow out and lifts a little, leaving texture alone.
fn whiten(image: &mut Image, brush: &Brush, area: Area, strength: f32) {
    for y in area.y0..area.y1 {
        for x in area.x0..area.x1 {
            let w = brush.weight_at(brush.distance(x, y)) * strength;
            if w <= 0.0 {
                continue;
            }
            let c = image.get(x, y);
            let l = luma(c);
            let mut cb = (c[2] - l) * 0.564;
            let mut cr = (c[0] - l) * 0.713;
            if cb < 0.0 {
                cb *= 1.0 - 0.85 * w;
            }
            cr *= 1.0 - 0.3 * w;
            let l = l + 0.08 * w * (1.0 - l);
            let r = l + cr / 0.713;
            let b = l + cb / 0.564;
            let g = (l - 0.299 * r - 0.114 * b) / 0.587;
            image.set(x, y, [r, g, b]);
        }
    }
}

/// Turns strongly red pixels under the brush a natural dark, and leaves the rest.
fn red_eye(image: &mut Image, brush: &Brush, area: Area, strength: f32) {
    for y in area.y0..area.y1 {
        for x in area.x0..area.x1 {
            let w = brush.weight_at(brush.distance(x, y));
            if w <= 0.0 {
                continue;
            }
            let c = image.get(x, y);
            let other = c[1].max(c[2]);
            if c[0] < 0.15 {
                continue;
            }
            let redness = ((c[0] / (other + 0.02) - 1.5) / 0.6).clamp(0.0, 1.0);
            if redness <= 0.0 {
                continue;
            }
            let dark = (c[1] + c[2]) * 0.5 * 0.8;
            image.set(
                x,
                y,
                mix(c, [dark, dark, dark * 1.03], w * redness * strength),
            );
        }
    }
}

/// Smooths brightness under the brush, keeping a little fine grain so skin stays skin.
fn smooth(image: &mut Image, brush: &Brush, area: Area, strength: f32) {
    let filter_r = (brush.radius * 0.3).max(2.0) as usize;
    let fine_r = (brush.radius * 0.04).max(1.0) as usize;
    let around = area.grown(filter_r * 2, image.w, image.h);
    let before = image.copy(around);
    let log: Vec<f32> = before.iter().map(|c| (luma(*c) + LOG_FLOOR).ln()).collect();
    let eps = 0.02 + strength * strength * 0.25;
    let base = guided(&log, around.w(), around.h(), filter_r, eps);
    let soft = box_blur(&log, around.w(), around.h(), fine_r);
    for y in area.y0..area.y1 {
        for x in area.x0..area.x1 {
            let k = brush.weight_at(brush.distance(x, y)) * strength;
            if k <= 0.0 {
                continue;
            }
            let i = (y - around.y0) * around.w() + (x - around.x0);
            let fine = log[i] - soft[i];
            let target = base[i] + (log[i] - base[i]) * (1.0 - k) + fine * k * 0.3;
            let l0 = luma(before[i]);
            let l1 = (target.exp() - LOG_FLOOR).max(0.0);
            let scale = if l0 > 1e-4 { l1 / l0 } else { 1.0 };
            image.set(x, y, before[i].map(|v| v * scale));
        }
    }
}

/// The area `offset` away, kept inside the image, or None if any of it falls outside.
fn shifted(area: Area, offset: (i64, i64), w: usize, h: usize) -> Option<Area> {
    let x0 = area.x0 as i64 + offset.0;
    let y0 = area.y0 as i64 + offset.1;
    let x1 = area.x1 as i64 + offset.0;
    let y1 = area.y1 as i64 + offset.1;
    if x0 < 0 || y0 < 0 || x1 > w as i64 || y1 > h as i64 {
        return None;
    }
    Some(Area {
        x0: x0 as usize,
        y0: y0 as usize,
        x1: x1 as usize,
        y1: y1 as usize,
    })
}

fn clone(image: &mut Image, brush: &Brush, area: Area, offset: (i64, i64), strength: f32) {
    // Only the part whose source lies inside the photo can be painted.
    let mut area = area;
    area.x0 = area.x0.max((-offset.0).max(0) as usize);
    area.y0 = area.y0.max((-offset.1).max(0) as usize);
    area.x1 = area.x1.min((image.w as i64 - offset.0).max(0) as usize);
    area.y1 = area.y1.min((image.h as i64 - offset.1).max(0) as usize);
    if area.is_empty() {
        return;
    }
    let Some(from) = shifted(area, offset, image.w, image.h) else {
        return;
    };
    let source = image.copy(from);
    for y in area.y0..area.y1 {
        for x in area.x0..area.x1 {
            let w = brush.weight_at(brush.distance(x, y)) * strength;
            if w <= 0.0 {
                continue;
            }
            let s = source[(y - area.y0) * area.w() + (x - area.x0)];
            let c = image.get(x, y);
            image.set(x, y, mix(c, s, w));
        }
    }
}

/// Spot healing: finds nearby texture whose surroundings match, copies it in, then
/// corrects its brightness and colour so it joins without a seam.
fn heal(image: &mut Image, brush: &Brush, area: Area, strength: f32) {
    let r = brush.radius;
    let band = (r * 0.5).max(2.0);
    let around = area.grown(band.ceil() as usize + 1, image.w, image.h);

    // The ring just outside the stroke: what the copied texture has to match.
    let mut ring: Vec<(usize, usize)> = Vec::new();
    let mut inside: Vec<(usize, usize)> = Vec::new();
    for y in around.y0..around.y1 {
        for x in around.x0..around.x1 {
            let d = brush.distance(x, y);
            if d > r && d <= r + band {
                ring.push((x, y));
            } else if d <= r * 0.7 {
                inside.push((x, y));
            }
        }
    }
    if ring.is_empty() {
        return;
    }
    let sample = |points: &[(usize, usize)], most: usize| -> Vec<(usize, usize)> {
        let step = points.len().div_ceil(most).max(1);
        points.iter().step_by(step).copied().collect()
    };
    let ring_samples = sample(&ring, 600);
    let inside_samples = sample(&inside, 40);

    let offset = best_offset(image, brush, around, &ring_samples, &inside_samples);

    // Boundary just outside the brush, where the healed result must equal the photo.
    let mut edge: Vec<(usize, usize)> = Vec::new();
    for y in around.y0..around.y1 {
        for x in around.x0..around.x1 {
            let d = brush.distance(x, y);
            if d > r && d <= r + 1.5 {
                edge.push((x, y));
            }
        }
    }
    let edge = sample(&edge, 96);
    let source_at = |image: &Image, x: usize, y: usize| -> [f32; 3] {
        match offset {
            Some((dx, dy)) => image.get((x as i64 + dx) as usize, (y as i64 + dy) as usize),
            None => [0.0; 3],
        }
    };
    let differences: Vec<((f32, f32), [f32; 3])> = edge
        .iter()
        .map(|&(x, y)| {
            let t = image.get(x, y);
            let s = source_at(image, x, y);
            (
                (x as f32, y as f32),
                [t[0] - s[0], t[1] - s[1], t[2] - s[2]],
            )
        })
        .collect();
    if differences.is_empty() {
        return;
    }

    // Work out every new pixel from the untouched photo, then write them all.
    let mut writes: Vec<(usize, usize, [f32; 3])> = Vec::new();
    for y in area.y0..area.y1 {
        for x in area.x0..area.x1 {
            let w = brush.weight_at(brush.distance(x, y)) * strength;
            if w <= 0.0 {
                continue;
            }
            // Spread the edge's differences smoothly over the inside (Shepard weights),
            // which makes the copy meet the photo exactly at the edge.
            let (mut sum, mut total) = ([0.0f32; 3], 0.0f32);
            for &((ex, ey), diff) in &differences {
                let d2 = (ex - x as f32).powi(2) + (ey - y as f32).powi(2);
                let k = 1.0 / (d2 + 1.0);
                total += k;
                for c in 0..3 {
                    sum[c] += diff[c] * k;
                }
            }
            // A large correction means no patch really matched; limiting it keeps a poor
            // match from painting a glaring smear.
            let correction = sum.map(|v| (v / total).clamp(-MAX_CORRECTION, MAX_CORRECTION));
            let s = source_at(image, x, y);
            let healed = [
                s[0] + correction[0],
                s[1] + correction[1],
                s[2] + correction[2],
            ];
            writes.push((x, y, mix(image.get(x, y), healed, w)));
        }
    }
    for (x, y, c) in writes {
        image.set(x, y, c);
    }
}

/// The nearby offset whose surroundings best match the stroke's, or None if no clean
/// patch fits inside the photo.
fn best_offset(
    image: &Image,
    brush: &Brush,
    around: Area,
    ring: &[(usize, usize)],
    inside: &[(usize, usize)],
) -> Option<(i64, i64)> {
    let r = brush.radius;
    // What the healed spot should end up looking like: its surroundings.
    let mut ring_mean = [0.0f32; 3];
    for &(x, y) in ring {
        let c = image.get(x, y);
        for k in 0..3 {
            ring_mean[k] += c[k] / ring.len() as f32;
        }
    }
    let mut best: Option<((i64, i64), f32)> = None;
    for distance in [1.6f32, 2.2, 3.0, 4.0] {
        let d = (r * distance).max(3.0);
        for step in 0..32 {
            let angle = step as f32 / 32.0 * std::f32::consts::TAU;
            let offset = (
                (d * angle.cos()).round() as i64,
                (d * angle.sin()).round() as i64,
            );
            if shifted(around, offset, image.w, image.h).is_none() {
                continue;
            }
            // The copied patch must not itself come from the stroke, or the blemish
            // would be copied back over itself.
            let lands_on_stroke = inside.iter().any(|&(x, y)| {
                let sx = (x as i64 + offset.0) as usize;
                let sy = (y as i64 + offset.1) as usize;
                brush.distance(sx, sy) < r
            });
            if lands_on_stroke {
                continue;
            }
            let mut cost = 0.0f32;
            for &(x, y) in ring {
                let t = image.get(x, y);
                let s = image.get(
                    (x as i64 + offset.0) as usize,
                    (y as i64 + offset.1) as usize,
                );
                cost += (t[0] - s[0]).powi(2) + (t[1] - s[1]).powi(2) + (t[2] - s[2]).powi(2);
            }
            let mut cost = cost / ring.len() as f32;
            // The patch itself must look like the spot's surroundings too. Without this,
            // healing beside an edge (a dark finger on a fair cheek) can match the edge
            // well and still copy in the wrong tone.
            if !inside.is_empty() {
                let mut fill = 0.0f32;
                for &(x, y) in inside {
                    let s = image.get(
                        (x as i64 + offset.0) as usize,
                        (y as i64 + offset.1) as usize,
                    );
                    fill += (s[0] - ring_mean[0]).powi(2)
                        + (s[1] - ring_mean[1]).powi(2)
                        + (s[2] - ring_mean[2]).powi(2);
                }
                cost += fill / inside.len() as f32;
            }
            // A slight preference for the nearest patch, where light and grain match best.
            let cost = cost * (1.0 + 0.05 * distance);
            if best.is_none_or(|(_, c)| cost < c) {
                best = Some((offset, cost));
            }
        }
    }
    best.map(|(offset, _)| offset)
}
