//! The soft shape a brush stroke covers, in pixels.

/// A rectangle of pixels, `x0..x1` by `y0..y1`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Area {
    pub x0: usize,
    pub y0: usize,
    pub x1: usize,
    pub y1: usize,
}

impl Area {
    pub fn w(&self) -> usize {
        self.x1 - self.x0
    }
    pub fn h(&self) -> usize {
        self.y1 - self.y0
    }
    pub fn is_empty(&self) -> bool {
        self.x1 <= self.x0 || self.y1 <= self.y0
    }
    /// This area grown by `by` pixels on every side, kept inside `w` by `h`.
    pub fn grown(&self, by: usize, w: usize, h: usize) -> Area {
        Area {
            x0: self.x0.saturating_sub(by),
            y0: self.y0.saturating_sub(by),
            x1: (self.x1 + by).min(w),
            y1: (self.y1 + by).min(h),
        }
    }
}

/// A stroke turned into pixels: its path, its radius and how its edge fades.
pub struct Brush {
    pub path: Vec<(f32, f32)>,
    pub radius: f32,
    pub softness: f32,
}

impl Brush {
    /// The stroke's points, given as shares of the photo, in this image's pixels. Points
    /// closer than a quarter of the radius are merged, which bounds the work per pixel.
    pub fn new(points: &[[f64; 2]], radius_share: f64, softness: f64, w: usize, h: usize) -> Brush {
        let long = w.max(h) as f64;
        let radius = (radius_share * long).max(0.75) as f32;
        let spacing = (radius * 0.25).max(0.5);
        let mut path: Vec<(f32, f32)> = Vec::new();
        for p in points {
            let q = ((p[0] * w as f64) as f32, (p[1] * h as f64) as f32);
            if path
                .last()
                .is_none_or(|l| (l.0 - q.0).hypot(l.1 - q.1) >= spacing)
            {
                path.push(q);
            }
        }
        if let (Some(last), Some(first)) = (points.last(), path.first().copied()) {
            let q = ((last[0] * w as f64) as f32, (last[1] * h as f64) as f32);
            if path.len() == 1 && (first.0 - q.0).hypot(first.1 - q.1) > 0.0 {
                path.push(q);
            }
        }
        Brush {
            path,
            radius,
            softness: softness as f32,
        }
    }

    /// The pixels the brush can touch, inside the image.
    pub fn area(&self, w: usize, h: usize) -> Area {
        let (mut x0, mut y0, mut x1, mut y1) = (f32::MAX, f32::MAX, f32::MIN, f32::MIN);
        for &(x, y) in &self.path {
            x0 = x0.min(x);
            y0 = y0.min(y);
            x1 = x1.max(x);
            y1 = y1.max(y);
        }
        let r = self.radius + 1.0;
        let clamp = |v: f32, max: usize| (v.max(0.0) as usize).min(max);
        Area {
            x0: clamp((x0 - r).floor(), w),
            y0: clamp((y0 - r).floor(), h),
            x1: clamp((x1 + r).ceil() + 1.0, w),
            y1: clamp((y1 + r).ceil() + 1.0, h),
        }
    }

    /// Distance from a pixel centre to the stroke's path.
    pub fn distance(&self, x: usize, y: usize) -> f32 {
        let p = (x as f32 + 0.5, y as f32 + 0.5);
        if self.path.len() == 1 {
            let a = self.path[0];
            return (p.0 - a.0).hypot(p.1 - a.1);
        }
        self.path
            .windows(2)
            .map(|s| segment_distance(p, s[0], s[1]))
            .fold(f32::MAX, f32::min)
    }

    /// How much of the brush lands on a pixel at `distance`: 1 in the hard core, fading
    /// smoothly to 0 at the radius.
    pub fn weight_at(&self, distance: f32) -> f32 {
        if distance >= self.radius {
            return 0.0;
        }
        let core = self.radius * (1.0 - self.softness);
        if distance <= core {
            return 1.0;
        }
        let t = (distance - core) / (self.radius - core).max(1e-3);
        let s = 1.0 - t;
        s * s * (3.0 - 2.0 * s)
    }
}

fn segment_distance(p: (f32, f32), a: (f32, f32), b: (f32, f32)) -> f32 {
    let (dx, dy) = (b.0 - a.0, b.1 - a.1);
    let len2 = dx * dx + dy * dy;
    let t = if len2 > 0.0 {
        (((p.0 - a.0) * dx + (p.1 - a.1) * dy) / len2).clamp(0.0, 1.0)
    } else {
        0.0
    };
    (p.0 - (a.0 + t * dx)).hypot(p.1 - (a.1 + t * dy))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_dab_is_full_in_its_core_and_empty_beyond_its_radius() {
        let brush = Brush::new(&[[0.5, 0.5]], 0.1, 0.5, 100, 100);
        assert_eq!(brush.radius, 10.0);
        assert_eq!(brush.weight_at(0.0), 1.0);
        assert_eq!(brush.weight_at(4.9), 1.0);
        let fading = brush.weight_at(7.5);
        assert!(fading > 0.0 && fading < 1.0);
        assert_eq!(brush.weight_at(10.0), 0.0);
    }

    #[test]
    fn a_line_covers_its_length_and_its_area_stays_in_the_image() {
        let brush = Brush::new(&[[0.1, 0.5], [0.9, 0.5]], 0.02, 0.0, 200, 100);
        assert!(brush.distance(100, 50) < 1.0);
        assert!(brush.distance(100, 60) > 9.0);
        let area = brush.area(200, 100);
        assert!(area.x0 <= 16 && area.x1 >= 184 && area.x1 <= 200);
        let edge = Brush::new(&[[0.0, 0.0]], 0.1, 0.5, 50, 50);
        let a = edge.area(50, 50);
        assert_eq!((a.x0, a.y0), (0, 0));
    }
}
