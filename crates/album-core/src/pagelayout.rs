//! New arrangements for one page of a spread, leaving the other page as it is.
//!
//! A layout that keeps its photos clear of the fold is two page layouts side by side, so
//! every one of those is a source of pages, on either side.

use std::collections::HashSet;

use serde::Deserialize;

use crate::autolayout::{apply_layout, assign, layout_score, rect_to_mm, Photo, RankedLayout};
use crate::document::{ProjectSpec, RectMm, SpreadDesign};
use crate::layoutvary::vary_layout;
use crate::pack::{
    AnyAspect, AspectRange, RectPct, Template, TemplateFrame, TemplateRegistry,
    MAX_FRAMES_PER_TEMPLATE,
};

const FOLD: f64 = 0.5;
const EDGE: f64 = 1e-6;

/// How many of the best pages are offered.
const OFFERED: usize = 12;

/// With fewer pages than this to draw on, plain rows and columns are added to them.
const ENOUGH_PAGES: usize = 6;

/// A page must differ from the one on screen by this much, or nothing would seem to happen.
const LEAST_VISIBLE_CHANGE_MM: f64 = 8.0;

const FINE_ART: &str = "fineart";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PageSide {
    Left,
    Right,
}

#[derive(Debug, Clone, PartialEq)]
pub struct PageLayout {
    pub template_id: String,
    pub name: String,
    pub tags: Vec<String>,
    pub crop_loss: f64,
    /// Only this page's photos, where they go on the spread.
    pub design: SpreadDesign,
}

fn side_of(r: &RectPct) -> Option<PageSide> {
    if r.x + r.w <= FOLD + EDGE {
        Some(PageSide::Left)
    } else if r.x >= FOLD - EDGE {
        Some(PageSide::Right)
    } else {
        None
    }
}

fn mirrored(mut frame: TemplateFrame) -> TemplateFrame {
    frame.rect_pct.x = 1.0 - frame.rect_pct.x - frame.rect_pct.w;
    frame
}

/// Where a page's frames are, whatever order they are in.
fn shape_key(frames: &[TemplateFrame]) -> Vec<[i64; 5]> {
    let round = |v: f64| (v * 1000.0).round() as i64;
    let mut key: Vec<_> = frames
        .iter()
        .map(|f| {
            let r = f.rect_pct;
            [
                round(r.x),
                round(r.y),
                round(r.w),
                round(r.h),
                i64::from(f.bleed),
            ]
        })
        .collect();
    key.sort_unstable();
    key
}

/// Every way to write `count` as 2 to 4 rows of 1 to 4 photos.
fn rows_of(count: usize) -> Vec<Vec<usize>> {
    let mut found = Vec::new();
    let mut open = vec![Vec::new()];
    while let Some(rows) = open.pop() {
        let left = count - rows.iter().sum::<usize>();
        if left == 0 {
            if rows.len() >= 2 {
                found.push(rows);
            }
        } else if rows.len() < 4 {
            for take in 1..=left.min(4) {
                let mut more = rows.clone();
                more.push(take);
                open.push(more);
            }
        }
    }
    found
}

/// Rows, or columns, that fill the page.
fn grid(rows: &[usize], columns: bool, side: PageSide) -> Template {
    let start = if side == PageSide::Left { 0.0 } else { FOLD };
    let deep = 1.0 / rows.len() as f64;
    let mut frames = Vec::new();
    for (i, &across) in rows.iter().enumerate() {
        let wide = 1.0 / across as f64;
        for j in 0..across {
            let (along, down) = (j as f64 * wide, i as f64 * deep);
            let (x, y, w, h) = if columns {
                (down, along, deep, wide)
            } else {
                (along, down, wide, deep)
            };
            frames.push(TemplateFrame {
                rect_pct: RectPct {
                    x: start + x * FOLD,
                    y,
                    w: w * FOLD,
                    h,
                },
                bleed: false,
                z: 0,
                border: 0.0,
            });
        }
    }
    Template {
        id: format!("page-grid/{}{rows:?}", if columns { "c" } else { "r" }),
        name: "Grid".to_string(),
        frame_count: frames.len(),
        spread_aspect: AspectRange::Any(AnyAspect::Any),
        tags: Vec::new(),
        frames,
        background: None,
        panels: Vec::new(),
        texts: Vec::new(),
    }
}

/// Every page layout for this many photos, drawn on the given side.
fn pages(registry: &TemplateRegistry, side: PageSide, count: usize, aspect: f64) -> Vec<Template> {
    let mut seen = HashSet::new();
    let mut found = Vec::new();
    for total in count..=MAX_FRAMES_PER_TEMPLATE {
        for template in registry.with_frame_count(total) {
            if !template.spread_aspect.contains(aspect) {
                continue;
            }
            let Some(sides) = template
                .frames
                .iter()
                .map(|f| side_of(&f.rect_pct))
                .collect::<Option<Vec<_>>>()
            else {
                continue;
            };
            for from in [PageSide::Left, PageSide::Right] {
                let frames: Vec<TemplateFrame> = template
                    .frames
                    .iter()
                    .zip(&sides)
                    .filter(|(_, s)| **s == from)
                    .map(|(f, _)| if from == side { *f } else { mirrored(*f) })
                    .collect();
                if frames.len() != count || !seen.insert(shape_key(&frames)) {
                    continue;
                }
                found.push(Template {
                    frame_count: count,
                    frames,
                    background: None,
                    panels: Vec::new(),
                    texts: Vec::new(),
                    ..template.clone()
                });
            }
        }
    }
    if found.len() < ENOUGH_PAGES && count <= MAX_FRAMES_PER_TEMPLATE {
        for rows in rows_of(count) {
            for columns in [false, true] {
                let made = grid(&rows, columns, side);
                if seen.insert(shape_key(&made.frames)) {
                    found.push(made);
                }
            }
        }
    }
    found
}

/// Whether two arrangements put their frames in visibly different places.
fn looks_different(a: &[RectMm], b: &[RectMm]) -> bool {
    let near = |p: &RectMm, q: &RectMm| {
        [
            p.x - q.x,
            p.y - q.y,
            p.x + p.w - q.x - q.w,
            p.y + p.h - q.y - q.h,
        ]
        .into_iter()
        .all(|d| d.abs() < LEAST_VISIBLE_CHANGE_MM)
    };
    a.len() != b.len() || !a.iter().all(|p| b.iter().any(|q| near(p, q)))
}

/// New arrangements for one page, best first. `current` is what is on that page now.
///
/// Fine art pages are used as drawn, since moving their lines would undo their margins.
pub fn page_layouts(
    registry: &TemplateRegistry,
    photos: &[Photo],
    spec: &ProjectSpec,
    side: PageSide,
    current: &[RectMm],
    fine_art: bool,
    seed: u64,
) -> Vec<PageLayout> {
    if photos.is_empty() {
        return Vec::new();
    }
    let aspect = spec.spread_aspect();
    let rank = |template: &Template| {
        let (assignment, total) = assign(photos, template, aspect);
        let crop_loss = total / photos.len() as f64;
        RankedLayout {
            template_id: template.id.clone(),
            assignment,
            crop_loss,
            score: layout_score(crop_loss, template),
        }
    };
    let rects = |template: &Template| -> Vec<RectMm> {
        template
            .frames
            .iter()
            .map(|f| rect_to_mm(f, spec))
            .collect()
    };
    let different = |template: &Template| looks_different(&rects(template), current);

    let mut found = pages(registry, side, photos.len(), aspect);
    let is_fine_art = |t: &Template| t.tags.iter().any(|tag| tag == FINE_ART);
    let as_drawn = fine_art && found.iter().any(|t| is_fine_art(t) && different(t));
    if as_drawn {
        found.retain(is_fine_art);
    }

    let mut made: Vec<(Template, RankedLayout)> = found
        .into_iter()
        .enumerate()
        .filter_map(|(i, template)| {
            let varied = if as_drawn {
                None
            } else {
                vary_layout(&template, photos, spec, &[], seed.wrapping_add(i as u64))
            };
            let (template, layout) = varied.unwrap_or_else(|| {
                let layout = rank(&template);
                (template, layout)
            });
            different(&template).then_some((template, layout))
        })
        .collect();
    made.sort_by(|a, b| a.1.score.total_cmp(&b.1.score));
    // Many spreads share a page, so pages that look the same are offered once.
    let mut offered: Vec<Vec<RectMm>> = Vec::new();
    made.retain(|(template, _)| {
        let now = rects(template);
        let new = offered.len() < OFFERED && offered.iter().all(|o| looks_different(&now, o));
        if new {
            offered.push(now);
        }
        new
    });
    made.into_iter()
        .map(|(template, layout)| PageLayout {
            design: apply_layout(&template, photos, &layout, spec),
            template_id: template.id,
            name: template.name,
            tags: template.tags,
            crop_loss: layout.crop_loss,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec() -> ProjectSpec {
        serde_json::from_value(serde_json::json!({
            "trim_w_mm": 300.0, "trim_h_mm": 300.0, "bleed_mm": 3.0, "safe_mm": 5.0,
            "target_dpi": 300.0, "binding": "layflat", "margin_mm": 8.0, "gap_mm": 4.0,
            "paper": "#ffffff"
        }))
        .unwrap()
    }

    fn photos(n: usize) -> Vec<Photo> {
        (0..n)
            .map(|i| Photo {
                asset_id: format!("p{i:02}"),
                aspect: if i % 2 == 0 { 1.5 } else { 0.667 },
            })
            .collect()
    }

    #[test]
    fn no_two_pages_offered_look_the_same() {
        let registry = TemplateRegistry::with_builtin();
        for n in 1..=4 {
            let made = page_layouts(
                &registry,
                &photos(n),
                &spec(),
                PageSide::Right,
                &[],
                false,
                5,
            );
            assert!(made.len() >= 6, "{n} photos: {} pages", made.len());
            for (i, a) in made.iter().enumerate() {
                for b in &made[..i] {
                    assert!(looks_different(&rects(a), &rects(b)));
                }
            }
        }
    }

    fn rects(page: &PageLayout) -> Vec<RectMm> {
        page.design.frames.iter().map(|f| f.rect_mm).collect()
    }

    #[test]
    fn every_page_stays_on_its_side_and_keeps_its_photos() {
        let registry = TemplateRegistry::with_builtin();
        let spec = spec();
        let fold = spec.canvas_mm().w / 2.0;
        for n in 1..=MAX_FRAMES_PER_TEMPLATE {
            for side in [PageSide::Left, PageSide::Right] {
                let photos = photos(n);
                let made = page_layouts(&registry, &photos, &spec, side, &[], false, 7);
                assert!(made.len() >= 3, "{n} photos: {} pages", made.len());
                for page in made {
                    let mut ids: Vec<String> = page
                        .design
                        .frames
                        .iter()
                        .map(|f| f.asset_id.clone().unwrap())
                        .collect();
                    ids.sort();
                    let want: Vec<String> = photos.iter().map(|p| p.asset_id.clone()).collect();
                    assert_eq!(ids, want);
                    for r in rects(&page) {
                        assert!(r.w > 0.0 && r.h > 0.0);
                        match side {
                            PageSide::Left => assert!(r.x + r.w <= fold + 1e-6),
                            PageSide::Right => assert!(r.x >= fold - 1e-6),
                        }
                    }
                }
            }
        }
    }

    #[test]
    fn the_page_on_screen_is_not_offered_again() {
        let registry = TemplateRegistry::with_builtin();
        let (spec, photos) = (spec(), photos(2));
        let offer = |current: &[RectMm], fine_art| {
            let side = PageSide::Left;
            page_layouts(&registry, &photos, &spec, side, current, fine_art, 3)
        };
        for fine_art in [false, true] {
            for first in offer(&[], fine_art) {
                let now = rects(&first);
                for next in offer(&now, fine_art) {
                    assert!(looks_different(&rects(&next), &now));
                }
            }
        }
    }
}
