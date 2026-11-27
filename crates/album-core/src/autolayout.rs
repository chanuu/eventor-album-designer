//! Picks a layout from the number and shape of the selected photos.
//!
//! Layouts are ranked by how little of the photos they crop away, which is why three
//! portraits get a different layout from three landscapes. Switching layout changes
//! only the geometry and which frame each photo takes, never the set of photos.

use pathfinding::prelude::{kuhn_munkres, Matrix};

use crate::document::{
    Background, Fit, Frame, FrameStyle, ProjectSpec, RectMm, Shape, SpreadDesign, TextBlock,
    DOCUMENT_VERSION,
};
use crate::pack::{RectPct, Template, TemplateFrame, TemplateRegistry};

/// Exact assignment is instant at this size, and beyond it selection order is fine.
const MAX_OPTIMAL_ASSIGNMENT: usize = 8;

/// Turns crop loss into the integers the assignment solver needs.
const COST_SCALE: f64 = 1_000_000.0;

/// Treats near-equal options as equal, so the photographer's order decides between them.
const ORDER_BONUS: i64 = 1;

const UNKNOWN_ASPECT: f64 = 1.5;

/// How much unused paper counts against a layout. Without this, small frames always win,
/// because a small frame can take any photo's shape, and the photos end up tiny.
const EMPTY_PAPER_WEIGHT: f64 = 0.35;

/// Layouts with deliberate open space still come up, through a style or Auto design.
const AIRY_PENALTY: f64 = 0.15;

/// A page with nothing on it looks like a mistake. This is enough to put a full spread
/// first for a photo that suits one, but not to crop an upright photo to a strip.
const BLANK_PAGE_PENALTY: f64 = 0.12;

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
    /// What the ranking sorts on. Lower is better.
    pub score: f64,
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
pub(crate) fn assign(
    photos: &[Photo],
    template: &Template,
    spread_aspect: f64,
) -> (Vec<usize>, f64) {
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

/// What layouts are compared on. Lower is better.
pub(crate) fn layout_score(crop_loss: f64, template: &Template) -> f64 {
    let covered: f64 = template
        .frames
        .iter()
        .map(|f| f.rect_pct.w * f.rect_pct.h)
        .sum();
    // Open space is a choice to make on purpose, not the layout offered first.
    let airy = if template.tags.iter().any(|t| t == "airy") {
        AIRY_PENALTY
    } else {
        0.0
    };
    let blank = if leaves_a_blank_page(template) {
        BLANK_PAGE_PENALTY
    } else {
        0.0
    };
    crop_loss + EMPTY_PAPER_WEIGHT * (1.0 - covered.min(1.0)) + airy + blank
}

/// Whether the left or the right page has no photo on it.
fn leaves_a_blank_page(template: &Template) -> bool {
    const FOLD: f64 = 0.5;
    const EDGE: f64 = 1e-6;
    let rects = || template.frames.iter().map(|f| f.rect_pct);
    !rects().any(|r| r.x < FOLD - EDGE) || !rects().any(|r| r.x + r.w > FOLD + EDGE)
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
            let crop_loss = total / photos.len() as f64;
            RankedLayout {
                template_id: template.id.clone(),
                assignment,
                crop_loss,
                score: layout_score(crop_loss, template),
            }
        })
        .collect();

    // The id tie-break keeps the order stable, so cycling never appears to reshuffle.
    ranked.sort_by(|a, b| {
        a.score
            .total_cmp(&b.score)
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

/// Converts a template frame to millimetres on the printed canvas.
///
/// Layouts run edge to edge, and spacing is applied here, so one margin or gap setting
/// respaces the whole album without touching any layout. A frame that bleeds, or any
/// frame when the margin is zero, is pushed past the trim to the canvas edge, so it
/// prints beyond the cut instead of leaving a white line.
pub fn rect_to_mm(frame: &TemplateFrame, spec: &ProjectSpec) -> RectMm {
    const EDGE: f64 = 1e-6;
    let rect = &frame.rect_pct;
    let bleed = spec.bleed_mm;
    let trim_w = spec.trim_w_mm * 2.0;
    let trim_h = spec.trim_h_mm;
    let to_paper_edge = frame.bleed || spec.margin_mm <= 0.0;
    let half_gap = spec.gap_mm / 2.0;

    let edge = |fraction: f64, trim: f64, inward: f64| {
        if fraction <= EDGE {
            if to_paper_edge {
                0.0
            } else {
                bleed + spec.margin_mm
            }
        } else if fraction >= 1.0 - EDGE {
            if to_paper_edge {
                trim + bleed * 2.0
            } else {
                bleed + trim - spec.margin_mm
            }
        } else {
            bleed + fraction * trim + inward * half_gap
        }
    };

    let left = edge(rect.x, trim_w, 1.0);
    let right = edge(rect.x + rect.w, trim_w, -1.0);
    let top = edge(rect.y, trim_h, 1.0);
    let bottom = edge(rect.y + rect.h, trim_h, -1.0);
    RectMm {
        x: left,
        y: top,
        w: right - left,
        h: bottom - top,
    }
}

const MM_PER_INCH: f64 = 25.4;
const POINTS_PER_INCH: f64 = 72.0;

/// A share of the trimmed canvas in millimetres, with no margin or gap applied.
fn plain_rect_mm(rect: &RectPct, spec: &ProjectSpec) -> RectMm {
    let trim_w = spec.trim_w_mm * 2.0;
    RectMm {
        x: spec.bleed_mm + rect.x * trim_w,
        y: spec.bleed_mm + rect.y * spec.trim_h_mm,
        w: rect.w * trim_w,
        h: rect.h * spec.trim_h_mm,
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
        // A card's words keep the pattern they were made from as their role, so the
        // couple's details can be filled in, and filled in again when they change.
        texts: template
            .texts
            .iter()
            .enumerate()
            .map(|(i, text)| TextBlock {
                id: format!("t{}", i + 1),
                rect_mm: plain_rect_mm(&text.rect_pct, spec),
                text: text.text.clone(),
                font: text.font.clone(),
                size_pt: text.size * spec.trim_h_mm / MM_PER_INCH * POINTS_PER_INCH,
                colour: text.colour.clone(),
                align: text.align,
                bold: text.bold,
                italic: text.italic,
                line_height: text.line_height,
                opacity: 1.0,
                role: if text.message {
                    Some("message".to_string())
                } else if text.text.contains('{') {
                    Some(text.text.clone())
                } else {
                    None
                },
                rot_deg: text.rot_deg,
            })
            .collect(),
        // A panel that reaches the card's edge runs on into the bleed, as a photo does.
        shapes: template
            .panels
            .iter()
            .enumerate()
            .map(|(i, panel)| Shape {
                id: format!("p{}", i + 1),
                rect_mm: rect_to_mm(
                    &TemplateFrame {
                        rect_pct: panel.rect_pct,
                        bleed: true,
                        z: 0,
                        border: 0.0,
                    },
                    &ProjectSpec {
                        gap_mm: 0.0,
                        ..spec.clone()
                    },
                ),
                colour: panel.colour.clone(),
                opacity: panel.opacity,
                z: panel.z,
            })
            .collect(),
        size_mm: spec.canvas_mm(),
        background: Background::Color {
            value: template
                .background
                .clone()
                .unwrap_or_else(|| spec.paper.clone()),
        },
        frames: template
            .frames
            .iter()
            .enumerate()
            .map(|(i, frame)| Frame {
                id: format!("f{}", i + 1),
                rect_mm: rect_to_mm(frame, spec),
                corner_radius_mm: 0.0,
                adjust: Default::default(),
                style: FrameStyle {
                    border_mm: frame.border * spec.trim_h_mm,
                    ..Default::default()
                },
                asset_id: photo_in_frame(i),
                fit: Fit::default(),
                z: frame.z,
            })
            .collect(),
    }
}
