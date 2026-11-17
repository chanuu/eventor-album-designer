//! Retouching: spot healing, clone stamp, brushes and red eye.
//!
//! A retouch is a list of strokes, never a changed file. Positions and sizes are a share
//! of the photo, so the same list draws the same result on a screen-sized preview and on
//! the full photo at print size. The preview and the exporter both run `apply_edits`, so
//! what the photographer sees is what prints.
//!
//! Like `adjust`, this works on tightly packed RGB bytes, so it needs no image library.

mod filters;
mod mask;
mod tools;

use serde::{Deserialize, Serialize};

/// The most strokes one photo may carry. A file asking for more is cut to this.
const MAX_STROKES: usize = 2000;
/// The most points one stroke may carry.
const MAX_POINTS: usize = 4000;
/// The smallest and largest brush, as a share of the photo's long edge.
const MIN_RADIUS: f64 = 0.0005;
const MAX_RADIUS: f64 = 0.25;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Tool {
    /// Replaces what is painted with matching texture from nearby.
    Heal,
    /// Copies from `source`, an offset from the stroke.
    Clone,
    /// Smooths skin under the brush, keeping some fine grain.
    Smooth,
    Brighten,
    Darken,
    /// Takes the yellow out of teeth and the whites of eyes.
    Whiten,
    /// A click on an eye: turns a red pupil a natural dark.
    RedEye,
}

fn half() -> f64 {
    0.5
}

fn one() -> f64 {
    1.0
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Stroke {
    pub tool: Tool,
    /// Where the brush went, each `[x, y]` a share of the photo's width and height.
    pub points: Vec<[f64; 2]>,
    /// Brush radius as a share of the photo's long edge.
    pub radius: f64,
    /// 0 is a hard edge, 1 fades all the way from the centre.
    #[serde(default = "half")]
    pub softness: f64,
    /// 0 does nothing, 1 is the tool's full effect.
    #[serde(default = "one")]
    pub strength: f64,
    /// For the clone stamp: where to copy from, as an offset from each point, in the
    /// same shares as `points`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<[f64; 2]>,
}

/// Everything done to one photo in the retoucher.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct RetouchEdits {
    pub strokes: Vec<Stroke>,
}

fn finite_share(v: f64) -> bool {
    v.is_finite() && (-1.0..=2.0).contains(&v)
}

impl Stroke {
    /// A copy safe to draw, or None when the stroke could not mean anything.
    fn sanitized(&self) -> Option<Stroke> {
        let points: Vec<[f64; 2]> = self
            .points
            .iter()
            .filter(|p| finite_share(p[0]) && finite_share(p[1]))
            .take(MAX_POINTS)
            .copied()
            .collect();
        if points.is_empty() || !self.radius.is_finite() || self.radius <= 0.0 {
            return None;
        }
        let source = match (self.tool, self.source) {
            (Tool::Clone, Some(s)) if s[0].is_finite() && s[1].is_finite() => {
                Some([s[0].clamp(-1.0, 1.0), s[1].clamp(-1.0, 1.0)])
            }
            // A clone stamp with nowhere to copy from does nothing.
            (Tool::Clone, _) => return None,
            _ => None,
        };
        let unit = |v: f64, fallback: f64| {
            if v.is_finite() {
                v.clamp(0.0, 1.0)
            } else {
                fallback
            }
        };
        Some(Stroke {
            tool: self.tool,
            points,
            radius: self.radius.clamp(MIN_RADIUS, MAX_RADIUS),
            softness: unit(self.softness, 0.5),
            strength: unit(self.strength, 1.0),
            source,
        })
    }
}

impl RetouchEdits {
    pub fn is_empty(&self) -> bool {
        self.strokes.is_empty()
    }

    /// Keeps a list from a file or a request inside sensible limits.
    pub fn sanitized(&self) -> Self {
        Self {
            strokes: self
                .strokes
                .iter()
                .filter_map(Stroke::sanitized)
                .take(MAX_STROKES)
                .collect(),
        }
    }
}

/// Draws every stroke, in order, onto tightly packed RGB bytes `width` by `height`,
/// which must be the whole photo (any size).
pub fn apply_edits(pixels: &mut [u8], width: usize, height: usize, edits: &RetouchEdits) {
    if width == 0 || height == 0 || pixels.len() != width * height * 3 {
        return;
    }
    let edits = edits.sanitized();
    let mut image = tools::Image {
        px: pixels,
        w: width,
        h: height,
    };
    for stroke in &edits.strokes {
        tools::draw(&mut image, stroke);
    }
}

#[cfg(test)]
mod tests;
