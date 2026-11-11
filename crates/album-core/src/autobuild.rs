//! Plans a whole album from what is known about each photo.
//!
//! This only decides which photos go where. It reads no files, so every rule here can
//! be tested with made-up facts. The layout for each spread is chosen afterwards.

use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};

/// Layouts exist for up to this many photos on a spread.
pub const MAX_PER_SPREAD: usize = 8;
const USUAL_PER_SPREAD: f64 = 4.0;

/// A pause this long usually means the day has moved on to something new.
const PART_GAP_SECONDS: i64 = 20 * 60;
const MAX_PARTS: usize = 12;

/// Blur is judged against this album's own photos, because a fixed score would suit
/// one camera and lens but not another.
const BLURRY_SHARE_OF_MEDIAN: f64 = 0.25;
const MIN_PHOTOS_TO_JUDGE_BLUR: usize = 4;

/// Bits out of 64 that may differ for two photos to count as the same shot.
const SIMILAR_HASH_BITS: u32 = 6;
const SIMILAR_WITHIN_SECONDS: i64 = 60;

/// Below this, a run of black and white photos is not worth a spread of its own.
const MIN_MONO_RUN: usize = 2;

/// Above these, part of the picture has probably lost its detail. Weddings have white
/// dresses and dark rooms, so these only ever ask for a look, never reject.
const BLOWN_WARNING_SHARE: f64 = 0.08;
const CRUSHED_WARNING_SHARE: f64 = 0.45;

const SECONDS_PER_MINUTE: i64 = 60;
const MIN_PHOTOS_FOR_CLOCK_CHECK: usize = 5;
const MAX_CLOCK_SHIFT_MINUTES: i64 = 24 * 60;
const MIN_CLOCK_SHIFT_MINUTES: i64 = 2;
const MIN_CLOCK_MATCH: f64 = 0.5;
const MIN_CLOCK_IMPROVEMENT: f64 = 0.2;
const NEAR_BEST_SHARE: f64 = 0.8;
/// If many shifts fit almost as well, the match means nothing and the clock is left alone.
const MAX_NEAR_BEST_SHIFTS: usize = 3;

/// What analysis learned about a photo. Anything unknown is simply left out of the rules.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PhotoFacts {
    pub id: String,
    /// When the camera says it was taken, as seconds in the camera's own clock.
    pub taken_at: Option<i64>,
    pub camera: Option<String>,
    pub sharpness: Option<f64>,
    /// A fingerprint of the picture, close for similar pictures.
    pub hash: Option<u64>,
    #[serde(default)]
    pub mono: bool,
    /// Share of the picture that is pure white, with no detail left.
    #[serde(default)]
    pub blown: f64,
    /// Share of the picture that is pure black.
    #[serde(default)]
    pub crushed: f64,
}

/// A suggestion only. The photographer can change any rating, and nothing is ever deleted.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Rating {
    /// Probably not worth using.
    Red,
    /// Worth a look.
    Yellow,
    Green,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PhotoRating {
    pub id: String,
    pub rating: Rating,
    pub reasons: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct PlanOptions {
    /// None uses the suggested number.
    pub spreads: Option<usize>,
    pub split_by_time: bool,
    pub sync_clocks: bool,
    pub keep_mono_together: bool,
    pub leave_out_blurry: bool,
    pub leave_out_similar: bool,
    /// Photos the photographer has chosen to keep, whatever the rules say.
    pub keep: Vec<String>,
    /// Open and close on a single photo, and give each long part of the day a feature spread.
    #[serde(default)]
    pub tell_story: bool,
}

/// Fewer photos than this make too short an album for single-photo spreads.
const STORY_MIN_PHOTOS: usize = 10;
/// A part of the day needs this many photos to earn a feature spread of its own.
const STORY_MIN_PART: usize = 6;
/// The opening and closing spreads can come from shorter parts.
const STORY_MIN_END_PART: usize = 3;
/// Single-photo spreads stay a minority, or the album feels empty.
const STORY_MAX_SHARE: f64 = 0.34;

/// One photo given a spread of its own, and whether it closes its part instead of opening it.
struct Feature {
    run: usize,
    photo: usize,
    closing: bool,
}

/// How strong a photo is as a feature: sharp, and neither burnt out nor lost in shadow.
fn feature_score(fact: &PhotoFacts) -> f64 {
    fact.sharpness.unwrap_or(0.0) * (1.0 - fact.blown.min(1.0)) * (1.0 - fact.crushed.min(1.0))
}

/// Chooses the feature photos, opening first, then closing, then the longest parts, only as
/// far as the album still has room for every other photo.
fn choose_features(kept: &[Placed], runs: &[Run], spreads_wanted: usize) -> Vec<Feature> {
    if kept.len() < STORY_MIN_PHOTOS || runs.is_empty() {
        return Vec::new();
    }
    // A black and white group stays together on its spreads, so it gives up no feature.
    let colour: Vec<usize> = (0..runs.len())
        .filter(|&r| !runs[r].photos.iter().all(|&i| kept[i].fact.mono))
        .collect();
    let (Some(&first), Some(&last)) = (colour.first(), colour.last()) else {
        return Vec::new();
    };
    let mut order: Vec<(usize, bool, usize)> = Vec::new();
    order.push((first, false, STORY_MIN_END_PART));
    if last != first {
        order.push((last, true, STORY_MIN_END_PART));
    }
    let mut middle: Vec<usize> = colour
        .iter()
        .copied()
        .filter(|&r| r != first && r != last)
        .collect();
    middle.sort_by_key(|&r| std::cmp::Reverse(runs[r].photos.len()));
    order.extend(middle.into_iter().map(|r| (r, false, STORY_MIN_PART)));

    let most = ((spreads_wanted as f64 * STORY_MAX_SHARE).floor() as usize).max(1);
    let mut features: Vec<Feature> = Vec::new();
    for (run, closing, needed) in order {
        let photos = &runs[run].photos;
        if features.len() >= most || photos.len() < needed {
            continue;
        }
        // Every other photo must still fit in the spreads that are left.
        let rest: usize = runs
            .iter()
            .enumerate()
            .map(|(r, other)| {
                let taken = features.iter().filter(|f| f.run == r).count() + usize::from(r == run);
                (other.photos.len() - taken).div_ceil(MAX_PER_SPREAD)
            })
            .sum();
        if rest + features.len() + 1 > spreads_wanted {
            continue;
        }
        let best = photos
            .iter()
            .copied()
            .max_by(|&a, &b| feature_score(kept[a].fact).total_cmp(&feature_score(kept[b].fact)));
        if let Some(photo) = best {
            features.push(Feature {
                run,
                photo,
                closing,
            });
        }
    }
    features
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "reason", rename_all = "snake_case")]
pub enum LeftOutReason {
    Blurry,
    Similar { kept: String },
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct LeftOut {
    pub id: String,
    #[serde(flatten)]
    pub reason: LeftOutReason,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ClockFix {
    pub camera: String,
    pub shift_seconds: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PlanPart {
    pub start: Option<i64>,
    pub end: Option<i64>,
    pub photos: usize,
    pub spreads: usize,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct AlbumPlan {
    pub spreads: Vec<Vec<String>>,
    pub parts: Vec<PlanPart>,
    pub left_out: Vec<LeftOut>,
    pub clock_fixes: Vec<ClockFix>,
    pub photos_without_time: usize,
    pub min_spreads: usize,
    pub max_spreads: usize,
    pub suggested_spreads: usize,
}

/// Looks for a camera whose clock is off, by lining up when each camera was shooting.
///
/// Two cameras at one event tend to fire in the same bursts. A shift is only trusted if
/// it stands out clearly, because cameras that simply shot at different times can fit
/// many shifts equally well, and a wrong correction would scramble the story.
pub fn find_clock_fixes(facts: &[PhotoFacts]) -> Vec<ClockFix> {
    let mut by_camera: HashMap<&str, Vec<i64>> = HashMap::new();
    for fact in facts {
        if let (Some(camera), Some(time)) = (fact.camera.as_deref(), fact.taken_at) {
            by_camera.entry(camera).or_default().push(time);
        }
    }

    // The camera with the most photos sets the time. The name settles a tie.
    let Some(reference) = by_camera
        .iter()
        .max_by_key(|(name, times)| (times.len(), *name))
        .map(|(name, _)| *name)
    else {
        return Vec::new();
    };
    let reference_minutes: HashSet<i64> = by_camera[reference]
        .iter()
        .map(|t| t.div_euclid(SECONDS_PER_MINUTE))
        .collect();

    let mut fixes = Vec::new();
    let mut cameras: Vec<_> = by_camera.iter().filter(|(n, _)| **n != reference).collect();
    cameras.sort_by_key(|(name, _)| **name);

    for (camera, times) in cameras {
        if times.len() < MIN_PHOTOS_FOR_CLOCK_CHECK {
            continue;
        }
        let minutes: HashSet<i64> = times
            .iter()
            .map(|t| t.div_euclid(SECONDS_PER_MINUTE))
            .collect();
        let match_at = |shift: i64| {
            let hits = minutes
                .iter()
                .filter(|m| reference_minutes.contains(&(**m + shift)))
                .count();
            hits as f64 / minutes.len() as f64
        };

        let scores: Vec<(i64, f64)> = (-MAX_CLOCK_SHIFT_MINUTES..=MAX_CLOCK_SHIFT_MINUTES)
            .map(|shift| (shift, match_at(shift)))
            .collect();
        // The smallest shift wins a tie: a small error is the likelier one.
        let (best_shift, best) = scores
            .iter()
            .copied()
            .max_by(|a, b| a.1.total_cmp(&b.1).then(b.0.abs().cmp(&a.0.abs())))
            .unwrap_or((0, 0.0));
        let near_best = scores
            .iter()
            .filter(|(_, score)| *score >= best * NEAR_BEST_SHARE)
            .count();

        if best_shift.abs() >= MIN_CLOCK_SHIFT_MINUTES
            && best >= MIN_CLOCK_MATCH
            && best >= match_at(0) + MIN_CLOCK_IMPROVEMENT
            && near_best <= MAX_NEAR_BEST_SHIFTS
        {
            fixes.push(ClockFix {
                camera: (*camera).to_string(),
                shift_seconds: best_shift * SECONDS_PER_MINUTE,
            });
        }
    }
    fixes
}

/// A photo in album order.
struct Placed<'a> {
    fact: &'a PhotoFacts,
    time: Option<i64>,
}

/// Puts photos in the order they were taken. A photo with no time stays beside its
/// neighbour in the file order, which is the best evidence there is.
fn in_time_order<'a>(facts: &'a [PhotoFacts], fixes: &[ClockFix]) -> Vec<Placed<'a>> {
    let shift_of: HashMap<&str, i64> = fixes
        .iter()
        .map(|f| (f.camera.as_str(), f.shift_seconds))
        .collect();
    let corrected = |fact: &PhotoFacts| {
        fact.taken_at.map(|time| {
            let shift = fact.camera.as_deref().and_then(|c| shift_of.get(c));
            time + shift.copied().unwrap_or(0)
        })
    };

    let first_known = facts.iter().find_map(corrected);
    let mut last_known = first_known;
    let mut placed: Vec<(Placed, Option<i64>)> = facts
        .iter()
        .map(|fact| {
            let own = corrected(fact);
            if own.is_some() {
                last_known = own;
            }
            (Placed { fact, time: own }, last_known)
        })
        .collect();
    // The sort is stable, so equal times keep their file order.
    placed.sort_by_key(|(_, sort_time)| *sort_time);
    placed.into_iter().map(|(p, _)| p).collect()
}

fn blur_limit(facts: &[PhotoFacts]) -> Option<f64> {
    let mut scores: Vec<f64> = facts.iter().filter_map(|f| f.sharpness).collect();
    if scores.len() < MIN_PHOTOS_TO_JUDGE_BLUR {
        return None;
    }
    scores.sort_by(f64::total_cmp);
    Some(scores[scores.len() / 2] * BLURRY_SHARE_OF_MEDIAN)
}

/// Chooses what to leave out, and returns the rest in order.
fn choose_photos<'a>(
    ordered: Vec<Placed<'a>>,
    options: &PlanOptions,
    left_out: &mut Vec<LeftOut>,
) -> Vec<Placed<'a>> {
    let keep: HashSet<&str> = options.keep.iter().map(String::as_str).collect();
    let all: Vec<PhotoFacts> = ordered.iter().map(|p| p.fact.clone()).collect();
    let limit = if options.leave_out_blurry {
        blur_limit(&all)
    } else {
        None
    };

    let mut sharp_enough = Vec::with_capacity(ordered.len());
    for placed in ordered {
        let blurry = limit
            .zip(placed.fact.sharpness)
            .is_some_and(|(limit, score)| score < limit);
        if blurry && !keep.contains(placed.fact.id.as_str()) {
            left_out.push(LeftOut {
                id: placed.fact.id.clone(),
                reason: LeftOutReason::Blurry,
            });
        } else {
            sharp_enough.push(placed);
        }
    }
    if !options.leave_out_similar {
        return sharp_enough;
    }

    // Each photo joins the group of an earlier one it matches, moments apart.
    let mut groups: Vec<Vec<usize>> = Vec::new();
    for (index, placed) in sharp_enough.iter().enumerate() {
        let matching = groups
            .iter_mut()
            .rev()
            .take(MAX_PER_SPREAD * 2)
            .find(|group| {
                let first = &sharp_enough[group[0]];
                let last = &sharp_enough[group[group.len() - 1]];
                let close_in_time = match (placed.time, last.time) {
                    (Some(a), Some(b)) => (a - b).abs() <= SIMILAR_WITHIN_SECONDS,
                    // With no times, only a direct neighbour in the file order can match.
                    _ => group[group.len() - 1] + 1 == index,
                };
                let looks_alike = placed
                    .fact
                    .hash
                    .zip(first.fact.hash)
                    .is_some_and(|(a, b)| (a ^ b).count_ones() <= SIMILAR_HASH_BITS);
                close_in_time && looks_alike
            });
        match matching {
            Some(group) => group.push(index),
            None => groups.push(vec![index]),
        }
    }

    let mut dropped = HashSet::new();
    for group in groups.iter().filter(|g| g.len() > 1) {
        let best = group
            .iter()
            .copied()
            .max_by(|a, b| {
                let score = |i: usize| sharp_enough[i].fact.sharpness.unwrap_or(0.0);
                score(*a).total_cmp(&score(*b)).then(b.cmp(a))
            })
            .unwrap_or(group[0]);
        for &index in group {
            let id = sharp_enough[index].fact.id.as_str();
            if index != best && !keep.contains(id) {
                dropped.insert(index);
                left_out.push(LeftOut {
                    id: id.to_string(),
                    reason: LeftOutReason::Similar {
                        kept: sharp_enough[best].fact.id.clone(),
                    },
                });
            }
        }
    }
    sharp_enough
        .into_iter()
        .enumerate()
        .filter(|(index, _)| !dropped.contains(index))
        .map(|(_, placed)| placed)
        .collect()
}

/// The start of each part of the day, as positions in the photo list.
fn part_starts(kept: &[Placed], options: &PlanOptions) -> Vec<usize> {
    if !options.split_by_time {
        return vec![0];
    }
    let gaps: Vec<(usize, i64)> = kept
        .windows(2)
        .enumerate()
        .filter_map(|(i, pair)| Some((i + 1, pair[1].time? - pair[0].time?)))
        .filter(|(_, gap)| *gap >= PART_GAP_SECONDS)
        .collect();

    // A day with constant pauses should not become dozens of tiny parts.
    let most_parts = MAX_PARTS.min(kept.len().div_ceil(3)).max(1);
    let mut largest = gaps;
    largest.sort_by_key(|(_, gap)| std::cmp::Reverse(*gap));
    largest.truncate(most_parts - 1);

    let mut starts: Vec<usize> = largest.into_iter().map(|(at, _)| at).collect();
    starts.push(0);
    starts.sort_unstable();
    starts
}

/// A run of photos that fills its own spreads.
struct Run {
    part: usize,
    photos: Vec<usize>,
}

fn make_runs(kept: &[Placed], starts: &[usize], options: &PlanOptions) -> Vec<Run> {
    let mut runs = Vec::new();
    for (part, &start) in starts.iter().enumerate() {
        let end = starts.get(part + 1).copied().unwrap_or(kept.len());
        let all: Vec<usize> = (start..end).collect();
        let mono: Vec<usize> = all.iter().copied().filter(|&i| kept[i].fact.mono).collect();

        // Black and white photos next to colour ones look like a mistake on one spread.
        if options.keep_mono_together && mono.len() >= MIN_MONO_RUN && mono.len() < all.len() {
            let colour = all.into_iter().filter(|&i| !kept[i].fact.mono).collect();
            runs.push(Run {
                part,
                photos: colour,
            });
            runs.push(Run { part, photos: mono });
        } else {
            runs.push(Run { part, photos: all });
        }
    }
    runs
}

/// Shares spreads between runs in proportion to their photos.
fn share_spreads(runs: &[Run], spreads: usize) -> Vec<usize> {
    let mut shares: Vec<usize> = runs
        .iter()
        .map(|r| r.photos.len().div_ceil(MAX_PER_SPREAD))
        .collect();
    let mut left = spreads.saturating_sub(shares.iter().sum());
    while left > 0 {
        let fullest = runs
            .iter()
            .zip(&shares)
            .enumerate()
            .filter(|(_, (run, share))| **share < run.photos.len())
            .max_by(|(_, (a, x)), (_, (b, y))| {
                let density = |run: &Run, share: usize| run.photos.len() as f64 / share as f64;
                density(a, **x).total_cmp(&density(b, **y))
            })
            .map(|(index, _)| index);
        let Some(index) = fullest else { break };
        shares[index] += 1;
        left -= 1;
    }
    shares
}

/// Cuts a run into spreads, preferring to cut where there is a pause in the shooting.
fn cut_run(run: &Run, count: usize, kept: &[Placed]) -> Vec<Vec<usize>> {
    let len = run.photos.len();
    let gap_before = |at: usize| {
        let time = |i: usize| kept[run.photos[i]].time;
        time(at).zip(time(at - 1)).map_or(0, |(a, b)| a - b)
    };

    let mut result = Vec::with_capacity(count);
    let mut previous = 0;
    for k in 1..count {
        let ideal = (k * len + count / 2) / count;
        let spreads_after = count - k;
        // Whatever is cut, every later spread must still be possible.
        let lowest = (previous + 1).max(len.saturating_sub(spreads_after * MAX_PER_SPREAD));
        let highest = (previous + MAX_PER_SPREAD).min(len - spreads_after);
        let near = ideal.saturating_sub(1).max(lowest)..=(ideal + 1).min(highest);
        let cut = near
            .clone()
            .max_by_key(|&at| (gap_before(at), std::cmp::Reverse(at.abs_diff(ideal))))
            .unwrap_or_else(|| ideal.clamp(lowest, highest));
        result.push(run.photos[previous..cut].to_vec());
        previous = cut;
    }
    result.push(run.photos[previous..].to_vec());
    result
}

/// More pure white than this has lost too much to offer a customer. Much stricter than the
/// warning above, because a white dress or a bright sky is a normal part of a good photo.
const GALLERY_BLOWN_SHARE: f64 = 0.25;
/// More pure black than this is too dark to judge, even for a night reception.
const GALLERY_CRUSHED_SHARE: f64 = 0.6;
/// Smaller than this along its long edge, a photo is a copy and not a usable original.
const GALLERY_SMALLEST_EDGE_PX: u32 = 1200;

/// A photo left out of a customer's gallery, and why. The photographer can put any back.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct GalleryLeftOut {
    pub id: String,
    pub reasons: Vec<String>,
}

/// Which photos not to offer a customer: overexposed, blurry, too dark, too small, or with
/// someone's eyes closed. `long_edges` gives each photo's longest side in pixels, and
/// `closed_eyes` the photos where someone blinked.
pub fn gallery_left_out(
    facts: &[PhotoFacts],
    long_edges: &[(String, u32)],
    closed_eyes: &[String],
) -> Vec<GalleryLeftOut> {
    let plan = plan_album(
        facts,
        &PlanOptions {
            spreads: None,
            split_by_time: false,
            sync_clocks: false,
            keep_mono_together: false,
            leave_out_blurry: true,
            leave_out_similar: false,
            keep: Vec::new(),
            tell_story: false,
        },
    );
    let blurry: HashSet<&str> = plan
        .left_out
        .iter()
        .filter(|item| matches!(item.reason, LeftOutReason::Blurry))
        .map(|item| item.id.as_str())
        .collect();
    let edges: HashMap<&str, u32> = long_edges
        .iter()
        .map(|(id, edge)| (id.as_str(), *edge))
        .collect();
    let blinked: HashSet<&str> = closed_eyes.iter().map(String::as_str).collect();

    facts
        .iter()
        .filter_map(|fact| {
            let mut reasons = Vec::new();
            if fact.blown > GALLERY_BLOWN_SHARE {
                reasons.push("Overexposed".to_string());
            }
            if fact.crushed > GALLERY_CRUSHED_SHARE {
                reasons.push("Too dark".to_string());
            }
            if blurry.contains(fact.id.as_str()) {
                reasons.push("Blurry".to_string());
            }
            if edges
                .get(fact.id.as_str())
                .is_some_and(|edge| *edge < GALLERY_SMALLEST_EDGE_PX)
            {
                reasons.push("Low resolution".to_string());
            }
            if blinked.contains(fact.id.as_str()) {
                reasons.push("Eyes closed".to_string());
            }
            (!reasons.is_empty()).then(|| GalleryLeftOut {
                id: fact.id.clone(),
                reasons,
            })
        })
        .collect()
}

/// Suggests a rating for each photo, using the same judgements as Auto Build.
pub fn rate_photos(facts: &[PhotoFacts]) -> Vec<PhotoRating> {
    let plan = plan_album(
        facts,
        &PlanOptions {
            spreads: None,
            split_by_time: false,
            sync_clocks: true,
            keep_mono_together: false,
            leave_out_blurry: true,
            leave_out_similar: true,
            keep: Vec::new(),
            tell_story: false,
        },
    );
    let left_out: HashMap<&str, &LeftOutReason> = plan
        .left_out
        .iter()
        .map(|item| (item.id.as_str(), &item.reason))
        .collect();

    facts
        .iter()
        .map(|fact| {
            let mut rating = Rating::Green;
            let mut reasons = Vec::new();
            match left_out.get(fact.id.as_str()) {
                Some(LeftOutReason::Blurry) => {
                    rating = Rating::Red;
                    reasons.push("Looks blurry".to_string());
                }
                Some(LeftOutReason::Similar { .. }) => {
                    rating = Rating::Yellow;
                    reasons.push("A sharper, similar shot exists".to_string());
                }
                None => {}
            }
            if fact.blown > BLOWN_WARNING_SHARE {
                reasons.push("Highlights may have lost detail".to_string());
            }
            if fact.crushed > CRUSHED_WARNING_SHARE {
                reasons.push("Shadows may have lost detail".to_string());
            }
            if rating == Rating::Green && !reasons.is_empty() {
                rating = Rating::Yellow;
            }
            PhotoRating {
                id: fact.id.clone(),
                rating,
                reasons,
            }
        })
        .collect()
}

pub fn plan_album(facts: &[PhotoFacts], options: &PlanOptions) -> AlbumPlan {
    let clock_fixes = if options.sync_clocks {
        find_clock_fixes(facts)
    } else {
        Vec::new()
    };
    let ordered = in_time_order(facts, &clock_fixes);
    let photos_without_time = ordered.iter().filter(|p| p.time.is_none()).count();

    let mut left_out = Vec::new();
    let kept = choose_photos(ordered, options, &mut left_out);
    if kept.is_empty() {
        return AlbumPlan {
            left_out,
            clock_fixes,
            photos_without_time,
            ..AlbumPlan::default()
        };
    }

    let starts = part_starts(&kept, options);
    let runs = make_runs(&kept, &starts, options);
    let min_spreads: usize = runs
        .iter()
        .map(|r| r.photos.len().div_ceil(MAX_PER_SPREAD))
        .sum();
    let max_spreads = kept.len();
    let suggested_spreads =
        ((kept.len() as f64 / USUAL_PER_SPREAD).round() as usize).clamp(min_spreads, max_spreads);
    let spreads_wanted = options
        .spreads
        .unwrap_or(suggested_spreads)
        .clamp(min_spreads, max_spreads);

    // A story opens and closes on a single photo, and gives each long part its own.
    let features = if options.tell_story {
        choose_features(&kept, &runs, spreads_wanted)
    } else {
        Vec::new()
    };
    let mut runs = runs;
    for feature in &features {
        runs[feature.run].photos.retain(|&i| i != feature.photo);
    }
    let shares = share_spreads(&runs, spreads_wanted - features.len());
    let mut spreads = Vec::new();
    let mut parts: Vec<PlanPart> = starts
        .iter()
        .enumerate()
        .map(|(part, &start)| {
            let end = starts.get(part + 1).copied().unwrap_or(kept.len());
            let span = &kept[start..end];
            PlanPart {
                start: span.iter().find_map(|p| p.time),
                end: span.iter().rev().find_map(|p| p.time),
                photos: span.len(),
                spreads: 0,
            }
        })
        .collect();
    let mut closing: Option<(Vec<String>, usize)> = None;
    for (index, (run, &share)) in runs.iter().zip(&shares).enumerate() {
        parts[run.part].spreads += share;
        let feature = features.iter().find(|f| f.run == index);
        let alone = |f: &Feature| vec![kept[f.photo].fact.id.clone()];
        if let Some(f) = feature.filter(|f| !f.closing) {
            spreads.push(alone(f));
            parts[run.part].spreads += 1;
        }
        for group in cut_run(run, share, &kept) {
            spreads.push(group.iter().map(|&i| kept[i].fact.id.clone()).collect());
        }
        if let Some(f) = feature.filter(|f| f.closing) {
            closing = Some((alone(f), run.part));
        }
    }
    // The last word, even when a black and white group follows its part of the day.
    if let Some((spread, part)) = closing {
        spreads.push(spread);
        parts[part].spreads += 1;
    }

    AlbumPlan {
        spreads,
        parts,
        left_out,
        clock_fixes,
        photos_without_time,
        min_spreads,
        max_spreads,
        suggested_spreads,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const HOUR: i64 = 3600;

    fn shot(id: &str, at: i64, sharpness: f64) -> PhotoFacts {
        PhotoFacts {
            id: id.to_string(),
            taken_at: Some(at),
            camera: None,
            sharpness: Some(sharpness),
            hash: None,
            mono: false,
            blown: 0.0,
            crushed: 0.0,
        }
    }

    /// Three parts of the day, an hour apart, with one clearly best photo in each.
    fn day(per_part: usize) -> Vec<PhotoFacts> {
        (0..3)
            .flat_map(|part| {
                (0..per_part).map(move |i| {
                    let sharp = if i == per_part / 2 {
                        400.0
                    } else {
                        100.0 + i as f64
                    };
                    shot(
                        &format!("p{part}-{i}"),
                        part as i64 * HOUR * 3 + i as i64 * 60,
                        sharp,
                    )
                })
            })
            .collect()
    }

    fn story(spreads: Option<usize>) -> PlanOptions {
        PlanOptions {
            spreads,
            split_by_time: true,
            sync_clocks: false,
            keep_mono_together: false,
            leave_out_blurry: false,
            leave_out_similar: false,
            keep: Vec::new(),
            tell_story: true,
        }
    }

    #[test]
    fn a_story_opens_and_closes_on_a_single_photo() {
        let plan = plan_album(&day(12), &story(None));
        assert_eq!(plan.spreads.first().unwrap(), &["p0-6"]);
        assert_eq!(plan.spreads.last().unwrap(), &["p2-6"]);
    }

    #[test]
    fn each_long_part_of_the_day_gets_its_own_feature() {
        let plan = plan_album(&day(12), &story(None));
        let middle = plan.spreads.iter().position(|s| s == &["p1-6"]);
        assert!(middle.is_some(), "{:?}", plan.spreads);
        // It opens its part: the spread before it is from the part before.
        let before = &plan.spreads[middle.unwrap() - 1];
        assert!(before.iter().all(|id| id.starts_with("p0-")), "{before:?}");
    }

    #[test]
    fn a_story_never_puts_two_single_photos_side_by_side() {
        for per_part in [6, 8, 12, 20] {
            let plan = plan_album(&day(per_part), &story(None));
            for pair in plan.spreads.windows(2) {
                assert!(
                    pair[0].len() > 1 || pair[1].len() > 1,
                    "{per_part}: {:?}",
                    plan.spreads
                );
            }
        }
    }

    #[test]
    fn a_story_places_every_photo_once_and_in_the_spreads_asked_for() {
        let facts = day(12);
        for wanted in [6, 9, 12] {
            let plan = plan_album(&facts, &story(Some(wanted)));
            assert_eq!(plan.spreads.len(), wanted);
            let mut ids: Vec<&String> = plan.spreads.iter().flatten().collect();
            ids.sort();
            ids.dedup();
            assert_eq!(ids.len(), facts.len());
            assert!(plan
                .spreads
                .iter()
                .all(|s| !s.is_empty() && s.len() <= MAX_PER_SPREAD));
        }
    }

    #[test]
    fn single_photo_spreads_stay_a_minority() {
        let plan = plan_album(&day(20), &story(Some(6)));
        let singles = plan.spreads.iter().filter(|s| s.len() == 1).count();
        assert!(
            singles * 3 <= plan.spreads.len() + 1,
            "{singles} of {}",
            plan.spreads.len()
        );
    }

    #[test]
    fn black_and_white_photos_are_never_split_off_as_a_feature() {
        let mut facts = day(12);
        for fact in facts.iter_mut().filter(|f| f.id.starts_with("p2-")).take(4) {
            fact.mono = true;
        }
        let options = PlanOptions {
            keep_mono_together: true,
            ..story(None)
        };
        let plan = plan_album(&facts, &options);
        let mono: Vec<&Vec<String>> = plan
            .spreads
            .iter()
            .filter(|s| {
                s.iter()
                    .any(|id| facts.iter().any(|f| &f.id == id && f.mono))
            })
            .collect();
        assert_eq!(mono.len(), 1, "{mono:?}");
        assert_eq!(mono[0].len(), 4);
        // Even with the black and white group last, the album still ends on its feature.
        assert_eq!(plan.spreads.last().unwrap().len(), 1, "{:?}", plan.spreads);
    }

    #[test]
    fn a_short_album_has_no_single_photo_spreads() {
        let plan = plan_album(&day(3), &story(None));
        assert!(
            plan.spreads.iter().all(|s| s.len() > 1),
            "{:?}",
            plan.spreads
        );
    }

    #[test]
    fn without_a_story_nothing_is_given_a_spread_of_its_own() {
        let plan = plan_album(
            &day(12),
            &PlanOptions {
                tell_story: false,
                ..story(None)
            },
        );
        assert!(
            plan.spreads.iter().all(|s| s.len() > 1),
            "{:?}",
            plan.spreads
        );
    }

    fn photo(id: &str, taken_at: Option<i64>) -> PhotoFacts {
        PhotoFacts {
            id: id.to_string(),
            taken_at,
            camera: None,
            sharpness: Some(100.0),
            hash: None,
            mono: false,
            blown: 0.0,
            crushed: 0.0,
        }
    }

    #[test]
    fn ratings_suggest_and_explain() {
        let mut facts = session("a", 0, 8);
        facts[1].sharpness = Some(5.0);
        facts[3].hash = facts[2].hash;
        facts[3].sharpness = Some(50.0);
        facts[5].blown = 0.2;
        facts[6].crushed = 0.6;
        let rated = rate_photos(&facts);
        let of = |i: usize| &rated[i];

        assert_eq!(of(0).rating, Rating::Green);
        assert!(of(0).reasons.is_empty());
        assert_eq!(of(1).rating, Rating::Red);
        assert_eq!(of(2).rating, Rating::Green, "the sharper of the pair");
        assert_eq!(of(3).rating, Rating::Yellow);
        assert_eq!(of(5).rating, Rating::Yellow);
        assert!(of(5).reasons[0].contains("Highlights"));
        assert_eq!(of(6).rating, Rating::Yellow);
        assert!(of(6).reasons[0].contains("Shadows"));
    }

    #[test]
    fn a_rejected_photo_still_mentions_its_exposure() {
        let mut facts = session("a", 0, 8);
        facts[1].sharpness = Some(5.0);
        facts[1].blown = 0.5;
        let rated = rate_photos(&facts);
        assert_eq!(rated[1].rating, Rating::Red);
        assert_eq!(rated[1].reasons.len(), 2);
    }

    fn options() -> PlanOptions {
        PlanOptions {
            spreads: None,
            split_by_time: true,
            sync_clocks: true,
            keep_mono_together: true,
            leave_out_blurry: true,
            leave_out_similar: true,
            keep: Vec::new(),
            tell_story: false,
        }
    }

    /// Photos a minute apart, with distinct fingerprints so none look alike.
    fn session(prefix: &str, start: i64, count: usize) -> Vec<PhotoFacts> {
        (0..count)
            .map(|i| PhotoFacts {
                hash: Some(unique_hash(prefix, i)),
                ..photo(&format!("{prefix}{i:02}"), Some(start + i as i64 * 60))
            })
            .collect()
    }

    fn unique_hash(prefix: &str, i: usize) -> u64 {
        let seed = prefix
            .bytes()
            .fold(i as u64 + 1, |h, b| h.wrapping_mul(31) ^ u64::from(b));
        seed.wrapping_mul(0x9E37_79B9_7F4A_7C15)
    }

    fn placed_ids(plan: &AlbumPlan) -> Vec<String> {
        plan.spreads.iter().flatten().cloned().collect()
    }

    fn left_out_ids(plan: &AlbumPlan) -> Vec<&str> {
        plan.left_out.iter().map(|l| l.id.as_str()).collect()
    }

    #[test]
    fn photos_end_up_in_the_order_they_were_taken() {
        let facts = vec![
            photo("evening", Some(20 * HOUR)),
            photo("morning", Some(8 * HOUR)),
            photo("noon", Some(12 * HOUR)),
        ];
        assert_eq!(
            placed_ids(&plan_album(&facts, &options())),
            ["morning", "noon", "evening"]
        );
    }

    #[test]
    fn a_long_pause_starts_a_new_part_and_spreads_do_not_cross_it() {
        let mut facts = session("a", 0, 8);
        facts.extend(session("b", 5 * HOUR, 8));
        let plan = plan_album(&facts, &options());

        assert_eq!(plan.parts.len(), 2);
        assert_eq!(plan.parts[0].photos, 8);
        assert_eq!(plan.parts[0].start, Some(0));
        assert_eq!(plan.parts[1].start, Some(5 * HOUR));
        for spread in &plan.spreads {
            let first = spread[0].as_bytes()[0];
            assert!(
                spread.iter().all(|id| id.as_bytes()[0] == first),
                "{spread:?}"
            );
        }
    }

    #[test]
    fn splitting_by_time_can_be_turned_off() {
        let mut facts = session("a", 0, 8);
        facts.extend(session("b", 5 * HOUR, 8));
        let plan = plan_album(
            &facts,
            &PlanOptions {
                split_by_time: false,
                ..options()
            },
        );
        assert_eq!(plan.parts.len(), 1);
    }

    #[test]
    fn nothing_is_lost_and_no_spread_is_too_full_or_empty() {
        for count in [1, 2, 5, 6, 7, 13, 26, 100, 301] {
            let mut facts = session("a", 0, count);
            facts.extend(session("b", 9 * HOUR, count / 2));
            for spreads in [None, Some(1), Some(3), Some(40), Some(9999)] {
                let plan = plan_album(
                    &facts,
                    &PlanOptions {
                        spreads,
                        ..options()
                    },
                );
                let mut placed = placed_ids(&plan);
                placed.sort();
                let mut expected: Vec<String> = facts.iter().map(|f| f.id.clone()).collect();
                expected.sort();
                assert_eq!(placed, expected, "{count} photos, {spreads:?} spreads");
                assert!(plan
                    .spreads
                    .iter()
                    .all(|s| !s.is_empty() && s.len() <= MAX_PER_SPREAD));
                assert!(
                    plan.min_spreads <= plan.spreads.len()
                        && plan.spreads.len() <= plan.max_spreads
                );
            }
        }
    }

    #[test]
    fn the_spread_count_asked_for_is_used_when_possible() {
        let facts = session("a", 0, 24);
        assert_eq!(
            plan_album(
                &facts,
                &PlanOptions {
                    spreads: Some(5),
                    ..options()
                }
            )
            .spreads
            .len(),
            5
        );
        assert_eq!(
            plan_album(&facts, &options()).spreads.len(),
            6,
            "suggested is about four a spread"
        );
    }

    #[test]
    fn spreads_are_cut_at_pauses_in_the_shooting() {
        let times = [0, 10, 20, 30, 300, 310, 320, 330];
        let facts: Vec<_> = times
            .iter()
            .enumerate()
            .map(|(i, t)| PhotoFacts {
                hash: Some(unique_hash("a", i)),
                ..photo(&format!("p{i}"), Some(*t))
            })
            .collect();
        // Even division would cut at the fifth photo too, but check one off the middle.
        let plan = plan_album(
            &facts,
            &PlanOptions {
                spreads: Some(2),
                ..options()
            },
        );
        assert_eq!(plan.spreads[0].len(), 4);

        let uneven = [0, 10, 20, 300, 310, 320, 330, 340];
        let facts: Vec<_> = uneven
            .iter()
            .enumerate()
            .map(|(i, t)| PhotoFacts {
                hash: Some(unique_hash("a", i)),
                ..photo(&format!("p{i}"), Some(*t))
            })
            .collect();
        let plan = plan_album(
            &facts,
            &PlanOptions {
                spreads: Some(2),
                ..options()
            },
        );
        assert_eq!(plan.spreads[0].len(), 3, "the cut moves to the pause");
    }

    #[test]
    fn photos_with_no_time_stay_beside_their_neighbours() {
        let facts = vec![
            photo("a", Some(100)),
            photo("b-no-time", None),
            photo("c", Some(200)),
            photo("d-no-time", None),
        ];
        let plan = plan_album(&facts, &options());
        assert_eq!(placed_ids(&plan), ["a", "b-no-time", "c", "d-no-time"]);
        assert_eq!(plan.photos_without_time, 2);
    }

    #[test]
    fn with_no_times_at_all_the_file_order_is_kept() {
        let facts = vec![photo("a", None), photo("b", None), photo("c", None)];
        let plan = plan_album(&facts, &options());
        assert_eq!(placed_ids(&plan), ["a", "b", "c"]);
        assert_eq!(plan.parts.len(), 1);
        assert_eq!(plan.parts[0].start, None);
    }

    #[test]
    fn blur_is_judged_against_the_album_itself() {
        let mut facts = session("a", 0, 8);
        facts[3].sharpness = Some(5.0);
        let plan = plan_album(&facts, &options());
        assert_eq!(left_out_ids(&plan), ["a03"]);
        assert_eq!(plan.left_out[0].reason, LeftOutReason::Blurry);

        // A soft lens makes every score low, and that alone must not reject anything.
        let mut soft = session("a", 0, 8);
        for fact in &mut soft {
            fact.sharpness = Some(5.0);
        }
        assert!(plan_album(&soft, &options()).left_out.is_empty());
    }

    #[test]
    fn too_few_photos_are_not_judged_for_blur() {
        let mut facts = session("a", 0, 3);
        facts[1].sharpness = Some(1.0);
        assert!(plan_album(&facts, &options()).left_out.is_empty());
    }

    #[test]
    fn of_similar_shots_the_sharpest_stays() {
        let mut facts = session("a", 0, 6);
        facts[1].hash = Some(0b1111_0000);
        facts[2].hash = Some(0b1111_0001);
        facts[3].hash = Some(0b1111_0011);
        facts[2].sharpness = Some(150.0);
        for (fact, t) in facts[1..4].iter_mut().zip([100, 110, 120]) {
            fact.taken_at = Some(t);
        }
        let plan = plan_album(&facts, &options());
        let mut out = left_out_ids(&plan);
        out.sort_unstable();
        assert_eq!(out, ["a01", "a03"]);
        assert!(
            matches!(&plan.left_out[0].reason, LeftOutReason::Similar { kept } if kept == "a02")
        );
    }

    #[test]
    fn similar_pictures_taken_far_apart_are_both_kept() {
        let mut facts = session("a", 0, 6);
        facts[0].hash = Some(42);
        facts[5].hash = Some(42);
        facts[5].taken_at = Some(10 * HOUR);
        assert!(plan_album(&facts, &options()).left_out.is_empty());
    }

    #[test]
    fn the_photographer_can_keep_anything() {
        let mut facts = session("a", 0, 8);
        facts[3].sharpness = Some(5.0);
        facts[5].hash = facts[4].hash;
        let plan = plan_album(
            &facts,
            &PlanOptions {
                keep: vec!["a03".to_string(), "a04".to_string(), "a05".to_string()],
                ..options()
            },
        );
        assert!(plan.left_out.is_empty());
        assert_eq!(placed_ids(&plan).len(), 8);
    }

    #[test]
    fn leaving_photos_out_can_be_turned_off() {
        let mut facts = session("a", 0, 8);
        facts[3].sharpness = Some(5.0);
        facts[5].hash = facts[4].hash;
        let plan = plan_album(
            &facts,
            &PlanOptions {
                leave_out_blurry: false,
                leave_out_similar: false,
                ..options()
            },
        );
        assert!(plan.left_out.is_empty());
    }

    #[test]
    fn black_and_white_photos_stay_together_in_their_part() {
        let mut facts = session("a", 0, 12);
        for at in [2, 6, 10] {
            facts[at].mono = true;
        }
        let plan = plan_album(&facts, &options());
        let mono_spreads: Vec<_> = plan
            .spreads
            .iter()
            .filter(|s| {
                s.iter()
                    .any(|id| ["a02", "a06", "a10"].contains(&id.as_str()))
            })
            .collect();
        assert_eq!(mono_spreads.len(), 1);
        assert_eq!(mono_spreads[0].len(), 3, "no colour photos beside them");

        let apart = plan_album(
            &facts,
            &PlanOptions {
                keep_mono_together: false,
                ..options()
            },
        );
        assert_eq!(placed_ids(&apart)[2], "a02");
    }

    #[test]
    fn a_single_black_and_white_photo_gets_no_spread_of_its_own() {
        let mut facts = session("a", 0, 8);
        facts[3].mono = true;
        assert_eq!(placed_ids(&plan_album(&facts, &options()))[3], "a03");
    }

    /// Minutes with an uneven rhythm, the way real shooting comes in bursts.
    const BURSTS: [i64; 16] = [0, 1, 5, 6, 7, 13, 14, 22, 23, 24, 31, 40, 41, 52, 58, 59];

    fn camera_shots(camera: &str, minutes: &[i64], offset_seconds: i64) -> Vec<PhotoFacts> {
        minutes
            .iter()
            .enumerate()
            .map(|(i, m)| PhotoFacts {
                camera: Some(camera.to_string()),
                hash: Some(unique_hash(camera, i)),
                ..photo(&format!("{camera}{i:02}"), Some(m * 60 + offset_seconds))
            })
            .collect()
    }

    #[test]
    fn a_camera_with_a_wrong_clock_is_found_and_corrected() {
        let mut facts = camera_shots("main", &BURSTS, 8 * HOUR);
        facts.extend(camera_shots("second", &BURSTS[2..10], 8 * HOUR - HOUR));
        let fixes = find_clock_fixes(&facts);
        assert_eq!(
            fixes,
            [ClockFix {
                camera: "second".to_string(),
                shift_seconds: HOUR
            }]
        );

        let plan = plan_album(&facts, &options());
        assert_eq!(
            plan.parts.len(),
            1,
            "both cameras are one part of the day again"
        );

        let unsynced = plan_album(
            &facts,
            &PlanOptions {
                sync_clocks: false,
                ..options()
            },
        );
        assert!(unsynced.clock_fixes.is_empty());
        assert_eq!(unsynced.parts.len(), 2);
    }

    #[test]
    fn cameras_already_in_step_are_left_alone() {
        let mut facts = camera_shots("main", &BURSTS, 0);
        facts.extend(camera_shots("second", &BURSTS[2..10], 0));
        assert!(find_clock_fixes(&facts).is_empty());
    }

    #[test]
    fn cameras_that_shot_at_different_times_are_not_shifted_together() {
        let steady: Vec<i64> = (0..120).collect();
        let mut facts = camera_shots("main", &steady, 0);
        facts.extend(camera_shots("second", &[0, 1, 2, 3, 4, 5], 5 * HOUR));
        assert!(
            find_clock_fixes(&facts).is_empty(),
            "many shifts fit, so none can be trusted"
        );
    }

    #[test]
    fn a_camera_with_few_photos_is_not_guessed_at() {
        let mut facts = camera_shots("main", &BURSTS, 0);
        facts.extend(camera_shots("second", &BURSTS[0..3], HOUR));
        assert!(find_clock_fixes(&facts).is_empty());
    }

    #[test]
    fn an_empty_album_gives_an_empty_plan() {
        let plan = plan_album(&[], &options());
        assert!(plan.spreads.is_empty());
        assert!(plan.parts.is_empty());
    }

    #[test]
    fn a_day_of_constant_pauses_does_not_become_dozens_of_parts() {
        let facts: Vec<_> = (0..60)
            .map(|i| PhotoFacts {
                hash: Some(unique_hash("a", i)),
                ..photo(&format!("p{i:02}"), Some(i as i64 * HOUR))
            })
            .collect();
        let plan = plan_album(&facts, &options());
        assert!(plan.parts.len() <= MAX_PARTS, "{}", plan.parts.len());
        assert_eq!(placed_ids(&plan).len(), 60);
    }
}
