//! Makes new arrangements within a layout's style, as many as the photographer asks for.
//!
//! A layout is a set of lines that its frames' edges sit on. Moving those lines, while
//! keeping them in order, changes every proportion but cannot change the style: frames
//! that sat side by side still do, and frames that did not overlap still do not. The
//! paper's edges and the fold stay where they are, so nothing new crosses the fold.

use crate::autolayout::{assign, layout_score, rect_to_mm, Photo, RankedLayout};
use crate::document::{ProjectSpec, RectMm};
use crate::pack::Template;

/// How many arrangements to try for each one that is offered.
const CANDIDATES: usize = 64;

/// One of this many best arrangements is chosen, so asking again gives something else.
const CHOOSE_AMONG: usize = 6;

/// How much each stretch between two lines may shrink or grow.
const SMALLEST_STRETCH: f64 = 0.5;
const LARGEST_STRETCH: f64 = 1.8;

/// An arrangement must move something by this much, or it would look like nothing happened.
const LEAST_VISIBLE_CHANGE_MM: f64 = 8.0;

/// Lines closer than this are the same line.
const SAME_LINE: f64 = 1e-4;

/// The smallest a frame may become, as a share of the spread's width and height.
const SMALLEST_WIDTH: f64 = 0.07;
const SMALLEST_HEIGHT: f64 = 0.15;

/// Without this, a frame that started small could never be offered at all.
const SMALLEST_SHARE_OF_ORIGINAL: f64 = 0.8;

/// Small and repeatable, so that a seed always gives the same arrangement.
struct SplitMix(u64);

impl SplitMix {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }

    fn unit(&mut self) -> f64 {
        (self.next() >> 11) as f64 / (1u64 << 53) as f64
    }
}

/// The lines between the fixed positions that frames' edges sit on, in order.
fn lines_between(mut edges: Vec<f64>, fixed: &[f64]) -> Vec<f64> {
    edges.sort_by(f64::total_cmp);
    edges.dedup_by(|a, b| (*a - *b).abs() < SAME_LINE);
    edges
        .into_iter()
        .filter(|edge| !fixed.iter().any(|f| (edge - f).abs() < SAME_LINE))
        .collect()
}

/// For each movable line, where it goes. Every stretch changes size, and each run between
/// two fixed positions still adds up to the same length.
fn moved_lines(lines: &[f64], fixed: &[f64], rng: &mut SplitMix) -> Vec<(f64, f64)> {
    let mut moved = Vec::with_capacity(lines.len());
    for pair in fixed.windows(2) {
        let (start, end) = (pair[0], pair[1]);
        let inside: Vec<f64> = lines
            .iter()
            .copied()
            .filter(|line| *line > start && *line < end)
            .collect();
        if inside.is_empty() {
            continue;
        }

        let mut stretches = Vec::with_capacity(inside.len() + 1);
        let mut previous = start;
        for line in inside.iter().copied().chain(std::iter::once(end)) {
            let factor = SMALLEST_STRETCH + rng.unit() * (LARGEST_STRETCH - SMALLEST_STRETCH);
            stretches.push((line - previous) * factor);
            previous = line;
        }
        let scale = (end - start) / stretches.iter().sum::<f64>();

        let mut at = start;
        for (line, stretch) in inside.iter().zip(&stretches) {
            at += stretch * scale;
            moved.push((*line, at));
        }
    }
    moved
}

fn place(value: f64, moved: &[(f64, f64)]) -> f64 {
    moved
        .iter()
        .find(|(line, _)| (line - value).abs() < SAME_LINE)
        .map_or(value, |(_, to)| *to)
}

/// One new arrangement of this template's frames, or None if the frames are too small.
fn rearranged(template: &Template, xs: &[(f64, f64)], ys: &[(f64, f64)]) -> Option<Template> {
    let mut made = template.clone();
    for frame in &mut made.frames {
        let r = frame.rect_pct;
        let (left, right) = (place(r.x, xs), place(r.x + r.w, xs));
        let (top, bottom) = (place(r.y, ys), place(r.y + r.h, ys));
        let (w, h) = (right - left, bottom - top);
        if w < SMALLEST_WIDTH.min(r.w * SMALLEST_SHARE_OF_ORIGINAL)
            || h < SMALLEST_HEIGHT.min(r.h * SMALLEST_SHARE_OF_ORIGINAL)
        {
            return None;
        }
        frame.rect_pct.x = left;
        frame.rect_pct.y = top;
        frame.rect_pct.w = w;
        frame.rect_pct.h = h;
    }
    Some(made)
}

/// The furthest any frame's edge moved from where it is now.
fn largest_change(template: &Template, spec: &ProjectSpec, current: &[RectMm]) -> f64 {
    if current.len() != template.frames.len() {
        return f64::INFINITY;
    }
    template
        .frames
        .iter()
        .zip(current)
        .map(|(frame, now)| {
            let r = rect_to_mm(frame, spec);
            [
                (r.x - now.x).abs(),
                (r.y - now.y).abs(),
                (r.x + r.w - now.x - now.w).abs(),
                (r.y + r.h - now.y - now.h).abs(),
            ]
            .into_iter()
            .fold(0.0, f64::max)
        })
        .fold(0.0, f64::max)
}

/// A new arrangement in this template's style that crops these photos as little as it can.
///
/// `current` is what is on the spread now, so the result can be seen to differ from it. None
/// means this style has nothing to move, as with one photo filling the spread.
pub fn vary_layout(
    template: &Template,
    photos: &[Photo],
    spec: &ProjectSpec,
    current: &[RectMm],
    seed: u64,
) -> Option<(Template, RankedLayout)> {
    if photos.is_empty() || photos.len() != template.frames.len() {
        return None;
    }

    let fixed_x = [0.0, 0.5, 1.0];
    let fixed_y = [0.0, 1.0];
    let rects = || template.frames.iter().map(|f| f.rect_pct);
    let xs = lines_between(rects().flat_map(|r| [r.x, r.x + r.w]).collect(), &fixed_x);
    let ys = lines_between(rects().flat_map(|r| [r.y, r.y + r.h]).collect(), &fixed_y);
    if xs.is_empty() && ys.is_empty() {
        return None;
    }

    let mut rng = SplitMix(seed);
    let spread_aspect = spec.spread_aspect();
    let mut found: Vec<(Template, RankedLayout)> = (0..CANDIDATES)
        .filter_map(|_| {
            let moved_x = moved_lines(&xs, &fixed_x, &mut rng);
            let moved_y = moved_lines(&ys, &fixed_y, &mut rng);
            let made = rearranged(template, &moved_x, &moved_y)?;
            if largest_change(&made, spec, current) < LEAST_VISIBLE_CHANGE_MM {
                return None;
            }
            let (assignment, total) = assign(photos, &made, spread_aspect);
            let crop_loss = total / photos.len() as f64;
            let layout = RankedLayout {
                template_id: made.id.clone(),
                assignment,
                crop_loss,
                score: layout_score(crop_loss, &made),
            };
            Some((made, layout))
        })
        .collect();

    found.sort_by(|a, b| a.1.score.total_cmp(&b.1.score));
    found.truncate(CHOOSE_AMONG);
    if found.is_empty() {
        return None;
    }
    let chosen = rng.next() as usize % found.len();
    Some(found.swap_remove(chosen))
}
