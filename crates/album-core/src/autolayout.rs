//! Picks a layout from the number and shape of the selected photos.
//!
//! Layouts are ranked by how little of the photos they crop away, which is why three
//! portraits get a different layout from three landscapes. Switching layout changes
//! only the geometry and which frame each photo takes, never the set of photos.

use pathfinding::prelude::{kuhn_munkres, Matrix};

use crate::document::{
    Background, Fit, Frame, ProjectSpec, RectMm, SpreadDesign, DOCUMENT_VERSION,
};
use crate::pack::{RectPct, Template, TemplateRegistry};

/// Exact assignment is instant at this size, and beyond it selection order is fine.
const MAX_OPTIMAL_ASSIGNMENT: usize = 8;

/// Turns crop loss into the integers the assignment solver needs.
const COST_SCALE: f64 = 1_000_000.0;

/// Treats near-equal options as equal, so the photographer's order decides between them.
const ORDER_BONUS: i64 = 1;

const UNKNOWN_ASPECT: f64 = 1.5;

#[derive(Debug, Clone, PartialEq)]
pub struct Photo {
    pub asset_id: String,
    /// Width over height, after EXIF rotation.
    pub aspect: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct RankedLayout {
    pub template_id: String,
    /// For each photo, in selection order, the index of the frame it takes.
    pub assignment: Vec<usize>,
    /// Average share of each photo lost to cropping, from 0 to 1.
    pub crop_loss: f64,
}

/// The share of a photo that cover-fit throws away in a frame of this shape.
pub fn crop_loss(photo_aspect: f64, frame_aspect: f64) -> f64 {
    1.0 - photo_aspect.min(frame_aspect) / photo_aspect.max(frame_aspect)
}

fn usable_aspect(aspect: f64) -> f64 {
    if aspect.is_finite() && aspect > 0.0 {
        aspect
    } else {
        UNKNOWN_ASPECT
    }
}

fn frame_aspect(rect: &RectPct, spread_aspect: f64) -> f64 {
    (rect.w * spread_aspect) / rect.h
}

/// Which frame each photo takes, and the total crop loss of doing so.
fn assign(photos: &[Photo], template: &Template, spread_aspect: f64) -> (Vec<usize>, f64) {
    let n = photos.len();
    let loss = |photo: usize, frame: usize| {
        crop_loss(
            usable_aspect(photos[photo].aspect),
            frame_aspect(&template.frames[frame].rect_pct, spread_aspect),
        )
    };

    let assignment: Vec<usize> = if n > MAX_OPTIMAL_ASSIGNMENT {
        (0..n).collect()
    } else {
        let weights = Matrix::from_fn(n, n, |(photo, frame)| {
            let cost = -((loss(photo, frame) * COST_SCALE).round() as i64);
            if photo == frame {
                cost + ORDER_BONUS
            } else {
                cost
            }
        });
        kuhn_munkres(&weights).1
    };

    let total = assignment
        .iter()
        .enumerate()
        .map(|(p, &f)| loss(p, f))
        .sum();
    (assignment, total)
}

/// Every layout that fits these photos and this album, best first.
///
/// An empty result is a normal answer: a pack may have nothing for this photo count.
pub fn rank_layouts(
    registry: &TemplateRegistry,
    photos: &[Photo],
    spec: &ProjectSpec,
) -> Vec<RankedLayout> {
    if photos.is_empty() {
        return Vec::new();
    }
    let spread_aspect = spec.spread_aspect();

    let mut ranked: Vec<RankedLayout> = registry
        .with_frame_count(photos.len())
        .filter(|t| t.spread_aspect.contains(spread_aspect))
        .map(|template| {
            let (assignment, total) = assign(photos, template, spread_aspect);
            RankedLayout {
                template_id: template.id.clone(),
                assignment,
                crop_loss: total / photos.len() as f64,
            }
        })
        .collect();

    // The id tie-break keeps the order stable, so cycling never appears to reshuffle.
    ranked.sort_by(|a, b| {
        a.crop_loss
            .total_cmp(&b.crop_loss)
            .then_with(|| a.template_id.cmp(&b.template_id))
    });
    ranked
}

/// Moves through the ranked list, wrapping at either end. `[` is -1 and `]` is +1.
pub fn cycle_index(current: usize, len: usize, step: isize) -> usize {
    if len == 0 {
        return 0;
    }
    (current as isize + step).rem_euclid(len as isize) as usize
}

/// Converts template fractions to millimetres on the printed canvas.
///
/// Fractions describe the trimmed spread, and bleed sits outside it. An edge touching
/// the trim is pushed out to the canvas edge, so a full-bleed frame really does print
/// past the cut instead of leaving a white line.
pub fn rect_to_mm(rect: &RectPct, spec: &ProjectSpec) -> RectMm {
    const EDGE: f64 = 1e-6;
    let bleed = spec.bleed_mm;
    let trim_w = spec.trim_w_mm * 2.0;
    let trim_h = spec.trim_h_mm;

    let edge = |fraction: f64, trim: f64| {
        if fraction <= EDGE {
            0.0
        } else if fraction >= 1.0 - EDGE {
            trim + bleed * 2.0
        } else {
            bleed + fraction * trim
        }
    };

    let left = edge(rect.x, trim_w);
    let right = edge(rect.x + rect.w, trim_w);
    let top = edge(rect.y, trim_h);
    let bottom = edge(rect.y + rect.h, trim_h);
    RectMm {
        x: left,
        y: top,
        w: right - left,
        h: bottom - top,
    }
}

/// Writes a chosen layout as an ordinary document, which can then be edited by hand.
pub fn apply_layout(
    template: &Template,
    photos: &[Photo],
    layout: &RankedLayout,
    spec: &ProjectSpec,
) -> SpreadDesign {
    let photo_in_frame = |frame: usize| {
        layout
            .assignment
            .iter()
            .position(|&assigned| assigned == frame)
            .and_then(|photo| photos.get(photo))
            .map(|photo| photo.asset_id.clone())
    };

    SpreadDesign {
        v: DOCUMENT_VERSION,
        template_id: Some(template.id.clone()),
        size_mm: spec.canvas_mm(),
        background: Background::Color {
            value: "#FFFFFF".to_string(),
        },
        frames: template
            .frames
            .iter()
            .enumerate()
            .map(|(i, frame)| Frame {
                id: format!("f{}", i + 1),
                rect_mm: rect_to_mm(&frame.rect_pct, spec),
                corner_radius_mm: 0.0,
                asset_id: photo_in_frame(i),
                fit: Fit::default(),
                z: frame.z,
            })
            .collect(),
    }
}
