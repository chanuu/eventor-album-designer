//! Tone and colour adjustments for a photo.
//!
//! The preview and the exporter both run this one function, so a change on screen is
//! the change that prints. It works on raw RGB bytes, using lookup tables for speed.

use rayon::prelude::*;
use serde::{Deserialize, Serialize};

const MAX_EXPOSURE_STOPS: f64 = 2.0;
const TONE_STRENGTH: f64 = 0.5;
const END_STRENGTH: f64 = 0.35;
const TEMPERATURE_STRENGTH: f64 = 0.2;
const TINT_STRENGTH: f64 = 0.15;
/// How far the colour mixer can turn one colour's hue, in degrees.
const MIX_HUE_DEGREES: f64 = 30.0;
const MIX_LUMINANCE_STRENGTH: f64 = 0.3;
const LIGHTNESS_STRENGTH: f64 = 0.5;

/// Red, orange, yellow, green, aqua, blue, purple and magenta, as hues in degrees.
pub const MIX_BANDS: [f64; 8] = [0.0, 30.0, 60.0, 120.0, 180.0, 240.0, 270.0, 300.0];

// Rec. 709 weights: how bright each channel looks to the eye.
const LUMA: [f64; 3] = [0.2126, 0.7152, 0.0722];

/// One colour wheel of colour grading: a tint for shadows, midtones or highlights.
#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Grade {
    /// Degrees round the colour wheel.
    pub hue: f64,
    /// How much of that colour, 0 to 1.
    pub saturation: f64,
    /// Lighter or darker, -1 to 1.
    pub luminance: f64,
}

impl Grade {
    fn sanitized(&self) -> Self {
        Self {
            hue: if self.hue.is_finite() {
                self.hue.rem_euclid(360.0)
            } else {
                0.0
            },
            saturation: if self.saturation.is_finite() {
                self.saturation.clamp(0.0, 1.0)
            } else {
                0.0
            },
            luminance: limited(self.luminance, 1.0),
        }
    }

    fn is_none(&self) -> bool {
        self.saturation == 0.0 && self.luminance == 0.0
    }
}

/// How strongly a full-saturation grade tints, and a full luminance lifts, of 1.
const GRADE_TINT: f64 = 0.22;
const GRADE_LIFT: f64 = 0.2;

/// All sliders run from -1 to 1 with 0 meaning no change, except exposure, in stops.
/// Anything missing from an older album file means no change.
#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Adjustments {
    pub exposure: f64,
    pub contrast: f64,
    pub highlights: f64,
    pub shadows: f64,
    pub temperature: f64,
    pub tint: f64,
    pub saturation: f64,
    pub black_and_white: bool,
    pub whites: f64,
    pub blacks: f64,
    /// Like saturation, but gentle on colours that are already strong, such as skin.
    pub vibrance: f64,
    /// Turns every colour round the colour wheel, by up to half a turn either way.
    pub hue: f64,
    pub lightness: f64,
    /// Per colour, in the order of `MIX_BANDS`.
    pub mix_hue: [f64; 8],
    pub mix_saturation: [f64; 8],
    pub mix_luminance: [f64; 8],
    /// Colour grading, as in Lightroom: a tint for each tonal range.
    pub grade_shadows: Grade,
    pub grade_midtones: Grade,
    pub grade_highlights: Grade,
    /// How much the three ranges overlap: 0 is Lightroom's 50, -1 hard edges, 1 soft.
    pub grade_blending: f64,
    /// Moves the split between shadows and highlights: above 0 favours highlights.
    pub grade_balance: f64,
}

fn limited(value: f64, limit: f64) -> f64 {
    if value.is_finite() {
        value.clamp(-limit, limit)
    } else {
        0.0
    }
}

fn limited_all(values: [f64; 8]) -> [f64; 8] {
    values.map(|v| limited(v, 1.0))
}

/// How many numbers the preview address carries, old and new.
const QUERY_BASIC: usize = 8;
const QUERY_FULL: usize = 8 + 5 + 24;
const QUERY_GRADED: usize = QUERY_FULL + 9 + 2;

impl Adjustments {
    /// Keeps values from a file or a request inside their ranges.
    pub fn sanitized(&self) -> Self {
        Self {
            exposure: limited(self.exposure, MAX_EXPOSURE_STOPS),
            contrast: limited(self.contrast, 1.0),
            highlights: limited(self.highlights, 1.0),
            shadows: limited(self.shadows, 1.0),
            temperature: limited(self.temperature, 1.0),
            tint: limited(self.tint, 1.0),
            saturation: limited(self.saturation, 1.0),
            black_and_white: self.black_and_white,
            whites: limited(self.whites, 1.0),
            blacks: limited(self.blacks, 1.0),
            vibrance: limited(self.vibrance, 1.0),
            hue: limited(self.hue, 1.0),
            lightness: limited(self.lightness, 1.0),
            mix_hue: limited_all(self.mix_hue),
            mix_saturation: limited_all(self.mix_saturation),
            mix_luminance: limited_all(self.mix_luminance),
            grade_shadows: self.grade_shadows.sanitized(),
            grade_midtones: self.grade_midtones.sanitized(),
            grade_highlights: self.grade_highlights.sanitized(),
            grade_blending: limited(self.grade_blending, 1.0),
            grade_balance: limited(self.grade_balance, 1.0),
        }
    }

    pub fn is_identity(&self) -> bool {
        *self == Self::default()
    }

    /// Reads the compact form used in preview addresses. Bad input means no change.
    pub fn from_query(value: &str) -> Self {
        let parts: Vec<f64> = value
            .split(',')
            .map(|part| part.parse().unwrap_or(0.0))
            .collect();
        if ![QUERY_BASIC, QUERY_FULL, QUERY_GRADED].contains(&parts.len()) {
            return Self::default();
        }
        let at = |i: usize| parts.get(i).copied().unwrap_or(0.0);
        let eight = |from: usize| std::array::from_fn(|i| at(from + i));
        Self {
            exposure: at(0),
            contrast: at(1),
            highlights: at(2),
            shadows: at(3),
            temperature: at(4),
            tint: at(5),
            saturation: at(6),
            black_and_white: at(7) != 0.0,
            whites: at(8),
            blacks: at(9),
            vibrance: at(10),
            hue: at(11),
            lightness: at(12),
            mix_hue: eight(13),
            mix_saturation: eight(21),
            mix_luminance: eight(29),
            grade_shadows: Grade {
                hue: at(37),
                saturation: at(38),
                luminance: at(39),
            },
            grade_midtones: Grade {
                hue: at(40),
                saturation: at(41),
                luminance: at(42),
            },
            grade_highlights: Grade {
                hue: at(43),
                saturation: at(44),
                luminance: at(45),
            },
            grade_blending: at(46),
            grade_balance: at(47),
        }
        .sanitized()
    }

    fn tone_curve(&self, value: f64) -> f64 {
        // Exposure is measured in light, so it is applied in linear values.
        let mut v = to_srgb(to_linear(value) * 2f64.powf(self.exposure));
        v = (v - 0.5) * (1.0 + self.contrast) + 0.5;
        v = v.clamp(0.0, 1.0);
        // Both weights are zero at pure black and white, so those stay put.
        let shadow_weight = 4.0 * v * (1.0 - v) * (1.0 - v);
        let highlight_weight = 4.0 * v * v * (1.0 - v);
        v += TONE_STRENGTH * (self.shadows * shadow_weight + self.highlights * highlight_weight);
        // Whites and blacks move the ends themselves, fading out towards the middle.
        let near_white = v.clamp(0.0, 1.0).powi(3);
        let near_black = (1.0 - v.clamp(0.0, 1.0)).powi(3);
        v + END_STRENGTH * (self.whites * near_white + self.blacks * near_black)
    }

    fn lookup_tables(&self) -> [[u8; 256]; 3] {
        let gains = [
            1.0 + TEMPERATURE_STRENGTH * self.temperature,
            1.0 - TINT_STRENGTH * self.tint,
            1.0 - TEMPERATURE_STRENGTH * self.temperature,
        ];
        let mut tables = [[0u8; 256]; 3];
        for (table, gain) in tables.iter_mut().zip(gains) {
            for (input, output) in table.iter_mut().enumerate() {
                // White balance comes first. Contrast applied before it would stretch a
                // colour cast, which the balance could then only partly undo.
                let balanced = (input as f64 / 255.0 * gain).clamp(0.0, 1.0);
                let value = self.tone_curve(balanced);
                *output = (value.clamp(0.0, 1.0) * 255.0).round() as u8;
            }
        }
        tables
    }

    /// Whether any control needs each pixel's hue, which costs more than the rest.
    fn works_on_hue(&self) -> bool {
        let any = |values: &[f64; 8]| values.iter().any(|v| *v != 0.0);
        self.hue != 0.0
            || self.vibrance != 0.0
            || self.lightness != 0.0
            || any(&self.mix_hue)
            || any(&self.mix_saturation)
            || any(&self.mix_luminance)
    }

    /// The hue, vibrance, lightness and colour mixer controls, for one pixel from 0 to 1.
    fn shift_colour(&self, rgb: [f64; 3]) -> [f64; 3] {
        let (hue, mut sat, mut light) = to_hsl(rgb);
        let weights = band_weights(hue);
        let mix = |values: &[f64; 8]| weights.iter().zip(values).map(|(w, v)| w * v).sum::<f64>();

        // Grey has no hue, so the mixer only works as far as a colour is a colour.
        let new_hue = hue + self.hue * 180.0 + mix(&self.mix_hue) * MIX_HUE_DEGREES;
        sat *= 1.0 + mix(&self.mix_saturation);
        sat += self.vibrance * sat * (1.0 - sat);
        light +=
            mix(&self.mix_luminance) * MIX_LUMINANCE_STRENGTH * sat * light * (1.0 - light) * 4.0;
        light = if self.lightness >= 0.0 {
            light + self.lightness * LIGHTNESS_STRENGTH * (1.0 - light)
        } else {
            light * (1.0 + self.lightness * LIGHTNESS_STRENGTH)
        };
        from_hsl(new_hue, sat.clamp(0.0, 1.0), light.clamp(0.0, 1.0))
    }

    fn grades(&self) -> bool {
        !(self.grade_shadows.is_none()
            && self.grade_midtones.is_none()
            && self.grade_highlights.is_none())
    }

    /// Colour grading for one pixel, 0 to 255. Each range's tint has no brightness of its
    /// own, so a tint changes colour and only Luminance changes light.
    fn grade(&self, rgb: [f64; 3]) -> [f64; 3] {
        let l = (LUMA[0] * rgb[0] + LUMA[1] * rgb[1] + LUMA[2] * rgb[2]) / 255.0;
        let soft = 0.18 + 0.14 * (self.grade_blending + 1.0);
        let (low, high) = (
            0.33 - 0.15 * self.grade_balance,
            0.67 - 0.15 * self.grade_balance,
        );
        let shadows = 1.0 - smoothstep(low - soft / 2.0, low + soft / 2.0, l);
        let highlights = smoothstep(high - soft / 2.0, high + soft / 2.0, l);
        let midtones = (1.0 - shadows - highlights).max(0.0);
        let mut out = rgb;
        for (grade, weight) in [
            (self.grade_shadows, shadows),
            (self.grade_midtones, midtones),
            (self.grade_highlights, highlights),
        ] {
            if weight <= 0.0 || grade.is_none() {
                continue;
            }
            let pure = from_hsl(grade.hue, 1.0, 0.5);
            let pure_luma = LUMA[0] * pure[0] + LUMA[1] * pure[1] + LUMA[2] * pure[2];
            for (k, v) in out.iter_mut().enumerate() {
                *v += 255.0
                    * weight
                    * (grade.saturation * GRADE_TINT * (pure[k] - pure_luma)
                        + grade.luminance * GRADE_LIFT);
            }
        }
        out
    }

    /// Applies the adjustments to tightly packed RGB bytes.
    pub fn apply_rgb(&self, pixels: &mut [u8]) {
        let settings = self.sanitized();
        if settings.is_identity() {
            return;
        }
        let tables = settings.lookup_tables();
        let hue_work = settings.works_on_hue();
        let grading = settings.grades();
        let colour = if settings.black_and_white {
            0.0
        } else {
            1.0 + settings.saturation
        };

        let each = |pixel: &mut [u8; 3]| {
            let mut mapped = [
                f64::from(tables[0][usize::from(pixel[0])]),
                f64::from(tables[1][usize::from(pixel[1])]),
                f64::from(tables[2][usize::from(pixel[2])]),
            ];
            if hue_work {
                let shifted = settings.shift_colour(mapped.map(|v| v / 255.0));
                mapped = shifted.map(|v| v * 255.0);
            }
            if grading {
                mapped = settings.grade(mapped);
            }
            let luma = LUMA[0] * mapped[0] + LUMA[1] * mapped[1] + LUMA[2] * mapped[2];
            for (out, value) in pixel.iter_mut().zip(mapped) {
                *out = (luma + (value - luma) * colour).clamp(0.0, 255.0).round() as u8;
            }
        };
        pixels
            .as_chunks_mut::<3>()
            .0
            .par_chunks_mut(8192)
            .for_each(|block| block.iter_mut().for_each(each));
    }
}

fn smoothstep(a: f64, b: f64, x: f64) -> f64 {
    let t = ((x - a) / (b - a).max(1e-9)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

/// The Temperature and Tint that make a colour neutral grey: for a white-balance
/// eyedropper. `rgb` is 0 to 1, and the answer is limited to the sliders' range.
pub fn neutralise(rgb: [f64; 3]) -> (f64, f64) {
    let [r, g, b] = rgb.map(|v| v.max(1e-4));
    // Temperature scales red up and blue down by the same amount: solve red = blue.
    let temperature = ((b - r) / (TEMPERATURE_STRENGTH * (r + b))).clamp(-1.0, 1.0);
    let target = r * (1.0 + TEMPERATURE_STRENGTH * temperature);
    // Tint scales green: solve green = that.
    let tint = ((1.0 - target / g) / TINT_STRENGTH).clamp(-1.0, 1.0);
    (temperature, tint)
}

/// How much a hue belongs to each of the mixer's colours. Neighbouring colours share the
/// hues between them, so the weights always add up to one and nothing jumps.
fn band_weights(hue: f64) -> [f64; 8] {
    let hue = hue.rem_euclid(360.0);
    let mut weights = [0.0; 8];
    for i in 0..MIX_BANDS.len() {
        let next = (i + 1) % MIX_BANDS.len();
        let start = MIX_BANDS[i];
        let end = if next == 0 { 360.0 } else { MIX_BANDS[next] };
        if hue >= start && hue < end {
            let t = (hue - start) / (end - start);
            weights[i] = 1.0 - t;
            weights[next] = t;
            break;
        }
    }
    weights
}

fn to_hsl([r, g, b]: [f64; 3]) -> (f64, f64, f64) {
    let max = r.max(g).max(b);
    let min = r.min(g).min(b);
    let light = (max + min) / 2.0;
    let delta = max - min;
    if delta <= f64::EPSILON {
        return (0.0, 0.0, light);
    }
    let sat = delta / (1.0 - (2.0 * light - 1.0).abs()).max(f64::EPSILON);
    let hue = if max == r {
        60.0 * ((g - b) / delta).rem_euclid(6.0)
    } else if max == g {
        60.0 * ((b - r) / delta + 2.0)
    } else {
        60.0 * ((r - g) / delta + 4.0)
    };
    (hue, sat.min(1.0), light)
}

fn from_hsl(hue: f64, sat: f64, light: f64) -> [f64; 3] {
    let chroma = (1.0 - (2.0 * light - 1.0).abs()) * sat;
    let h = hue.rem_euclid(360.0) / 60.0;
    let x = chroma * (1.0 - (h.rem_euclid(2.0) - 1.0).abs());
    let (r, g, b) = match h as u32 {
        0 => (chroma, x, 0.0),
        1 => (x, chroma, 0.0),
        2 => (0.0, chroma, x),
        3 => (0.0, x, chroma),
        4 => (x, 0.0, chroma),
        _ => (chroma, 0.0, x),
    };
    let m = light - chroma / 2.0;
    [r + m, g + m, b + m]
}

fn to_linear(v: f64) -> f64 {
    if v <= 0.04045 {
        v / 12.92
    } else {
        ((v + 0.055) / 1.055).powf(2.4)
    }
}

fn to_srgb(v: f64) -> f64 {
    let v = v.clamp(0.0, 1.0);
    if v <= 0.003_130_8 {
        v * 12.92
    } else {
        1.055 * v.powf(1.0 / 2.4) - 0.055
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn apply(adjust: Adjustments, pixel: [u8; 3]) -> [u8; 3] {
        let mut out = pixel;
        adjust.apply_rgb(&mut out);
        out
    }

    #[test]
    fn no_adjustment_leaves_every_value_unchanged() {
        let mut pixels: Vec<u8> = (0..=255).flat_map(|v| [v, v, v]).collect();
        let before = pixels.clone();
        Adjustments::default().apply_rgb(&mut pixels);
        assert_eq!(pixels, before);
    }

    #[test]
    fn a_tiny_change_does_not_shift_colours_through_rounding() {
        let nearly = Adjustments {
            contrast: 1e-9,
            ..Adjustments::default()
        };
        for v in 0..=255u8 {
            assert_eq!(apply(nearly, [v, v, v]), [v, v, v]);
        }
    }

    #[test]
    fn one_stop_of_exposure_doubles_the_light() {
        let up = Adjustments {
            exposure: 1.0,
            ..Adjustments::default()
        };
        let [r, _, _] = apply(up, [100, 100, 100]);
        let light = |v: u8| to_linear(f64::from(v) / 255.0);
        assert!((light(r) / light(100) - 2.0).abs() < 0.05);
    }

    #[test]
    fn contrast_pushes_tones_apart() {
        let up = Adjustments {
            contrast: 0.5,
            ..Adjustments::default()
        };
        assert!(apply(up, [60, 60, 60])[0] < 60);
        assert!(apply(up, [200, 200, 200])[0] > 200);
    }

    #[test]
    fn shadows_and_highlights_leave_black_and_white_alone() {
        let both = Adjustments {
            shadows: 1.0,
            highlights: -1.0,
            ..Adjustments::default()
        };
        assert_eq!(apply(both, [0, 0, 0]), [0, 0, 0]);
        assert_eq!(apply(both, [255, 255, 255]), [255, 255, 255]);
        assert!(apply(both, [50, 50, 50])[0] > 50);
        assert!(apply(both, [205, 205, 205])[0] < 205);
    }

    #[test]
    fn tone_controls_never_invert_the_image() {
        for adjust in [
            Adjustments {
                contrast: 1.0,
                ..Adjustments::default()
            },
            Adjustments {
                contrast: -1.0,
                ..Adjustments::default()
            },
            Adjustments {
                shadows: 1.0,
                ..Adjustments::default()
            },
            Adjustments {
                shadows: -1.0,
                ..Adjustments::default()
            },
            Adjustments {
                highlights: 1.0,
                ..Adjustments::default()
            },
            Adjustments {
                highlights: -1.0,
                ..Adjustments::default()
            },
            Adjustments {
                exposure: 2.0,
                ..Adjustments::default()
            },
            Adjustments {
                exposure: -2.0,
                ..Adjustments::default()
            },
        ] {
            let table = adjust.lookup_tables()[1];
            assert!(table.windows(2).all(|w| w[0] <= w[1]), "{adjust:?}");
        }
    }

    #[test]
    fn warmth_adds_red_and_removes_blue() {
        let warm = Adjustments {
            temperature: 1.0,
            ..Adjustments::default()
        };
        let [r, g, b] = apply(warm, [120, 120, 120]);
        assert!(r > 120 && b < 120);
        assert_eq!(g, 120);
    }

    #[test]
    fn white_balance_happens_before_contrast() {
        let both = Adjustments {
            temperature: -1.0,
            contrast: 0.5,
            ..Adjustments::default()
        };
        let balance_only = Adjustments {
            temperature: -1.0,
            ..Adjustments::default()
        };
        let contrast_only = Adjustments {
            contrast: 0.5,
            ..Adjustments::default()
        };
        // Balancing a warm pixel to neutral, then adding contrast, must stay neutral.
        let warm = [125, 100, 83];
        let balanced = apply(balance_only, warm);
        assert!(
            (i32::from(balanced[0]) - i32::from(balanced[2])).abs() <= 2,
            "{balanced:?}"
        );
        let [r, _, b] = apply(both, warm);
        let spread = (i32::from(r) - i32::from(b)).abs();
        let [r0, _, b0] = apply(contrast_only, warm);
        assert!(
            spread < (i32::from(r0) - i32::from(b0)).abs() / 4,
            "{spread}"
        );
    }

    #[test]
    fn tint_moves_green_and_magenta() {
        let magenta = Adjustments {
            tint: 1.0,
            ..Adjustments::default()
        };
        assert!(apply(magenta, [120, 120, 120])[1] < 120);
    }

    #[test]
    fn saturation_and_black_and_white_change_colour_but_not_grey() {
        let more = Adjustments {
            saturation: 1.0,
            ..Adjustments::default()
        };
        let [r, _, b] = apply(more, [200, 100, 50]);
        assert!(r > 200 && b < 50);
        assert_eq!(apply(more, [90, 90, 90]), [90, 90, 90]);

        let mono = Adjustments {
            black_and_white: true,
            ..Adjustments::default()
        };
        let [r, g, b] = apply(mono, [200, 100, 50]);
        assert!(r == g && g == b);
    }

    #[test]
    fn the_preview_address_form_is_read_safely() {
        let read = Adjustments::from_query("0.5,0.1,0,0,-0.2,0,0.3,1");
        assert_eq!(read.exposure, 0.5);
        assert_eq!(read.temperature, -0.2);
        assert!(read.black_and_white);

        assert!(Adjustments::from_query("nonsense").is_identity());
        assert!(Adjustments::from_query("1,2").is_identity());
        assert_eq!(Adjustments::from_query("99,0,0,0,0,0,0,0").exposure, 2.0);
        assert_eq!(Adjustments::from_query("NaN,0,0,0,0,0,0,0").exposure, 0.0);
    }

    #[test]
    fn out_of_range_values_from_a_file_are_limited() {
        let wild = Adjustments {
            contrast: 500.0,
            exposure: f64::INFINITY,
            ..Adjustments::default()
        }
        .sanitized();
        assert_eq!(wild.contrast, 1.0);
        assert_eq!(wild.exposure, 0.0);
    }

    #[test]
    fn the_colour_wheel_conversion_round_trips() {
        for rgb in [
            [0.8, 0.2, 0.1],
            [0.1, 0.7, 0.3],
            [0.2, 0.3, 0.9],
            [0.5, 0.5, 0.5],
            [1.0, 1.0, 0.0],
        ] {
            let (h, s, l) = to_hsl(rgb);
            let back = from_hsl(h, s, l);
            for (a, b) in rgb.iter().zip(back) {
                assert!((a - b).abs() < 1e-9, "{rgb:?} came back as {back:?}");
            }
        }
    }

    #[test]
    fn neighbouring_mixer_colours_share_hues_smoothly() {
        let w = band_weights(45.0);
        assert!((w[1] - 0.5).abs() < 1e-9 && (w[2] - 0.5).abs() < 1e-9);
        for hue in (0..360).map(f64::from) {
            assert!(
                (band_weights(hue).iter().sum::<f64>() - 1.0).abs() < 1e-9,
                "{hue}"
            );
        }
        assert_eq!(band_weights(0.0)[0], 1.0);
        assert!(band_weights(350.0)[0] > 0.0 && band_weights(350.0)[7] > 0.0);
    }

    #[test]
    fn the_mixer_changes_only_the_colour_it_is_asked_to() {
        let mut less_red = Adjustments::default();
        less_red.mix_saturation[0] = -1.0;
        let red = apply(less_red, [200, 30, 30]);
        assert!(red[0].abs_diff(red[1]) < 8, "red stayed red: {red:?}");
        assert_eq!(
            apply(less_red, [30, 40, 200]),
            [30, 40, 200],
            "blue was touched"
        );
        assert_eq!(
            apply(less_red, [120, 120, 120]),
            [120, 120, 120],
            "grey was touched"
        );
    }

    #[test]
    fn mixer_luminance_brightens_one_colour() {
        let mut brighter_blue = Adjustments::default();
        brighter_blue.mix_luminance[5] = 1.0;
        let before = [30u8, 40, 200];
        let after = apply(brighter_blue, before);
        let sum = |p: [u8; 3]| p.iter().map(|v| u32::from(*v)).sum::<u32>();
        assert!(sum(after) > sum(before) + 30, "{after:?}");
        assert_eq!(apply(brighter_blue, [200, 30, 30]), [200, 30, 30]);
    }

    #[test]
    fn mixer_hue_turns_one_colour_towards_its_neighbour() {
        let mut greener = Adjustments::default();
        greener.mix_hue[3] = 1.0;
        let (h, _, _) = to_hsl(apply(greener, [40, 200, 40]).map(|v| f64::from(v) / 255.0));
        assert!(h > 135.0, "hue {h}");
    }

    #[test]
    fn hue_turns_every_colour_round_the_wheel() {
        let half_turn = Adjustments {
            hue: 1.0,
            ..Default::default()
        };
        let out = apply(half_turn, [200, 30, 30]);
        assert!(
            out[1] > out[0] && out[2] > out[0],
            "red should become cyan: {out:?}"
        );
        assert_eq!(apply(half_turn, [90, 90, 90]), [90, 90, 90]);
    }

    #[test]
    fn vibrance_lifts_dull_colours_more_than_strong_ones() {
        let more = Adjustments {
            vibrance: 1.0,
            ..Default::default()
        };
        let gain = |p: [u8; 3]| {
            let before = to_hsl(p.map(|v| f64::from(v) / 255.0)).1;
            let after = to_hsl(apply(more, p).map(|v| f64::from(v) / 255.0)).1;
            after - before
        };
        assert!(gain([150, 120, 110]) > gain([240, 20, 20]));
    }

    #[test]
    fn lightness_brightens_and_darkens_without_clipping_to_one_colour() {
        let up = apply(
            Adjustments {
                lightness: 0.5,
                ..Default::default()
            },
            [100, 60, 40],
        );
        let down = apply(
            Adjustments {
                lightness: -0.5,
                ..Default::default()
            },
            [100, 60, 40],
        );
        assert!(up[0] > 100 && down[0] < 100);
        assert!(
            up[0] > up[2] && down[0] > down[2],
            "the colour should survive"
        );
    }

    #[test]
    fn whites_and_blacks_move_the_ends_more_than_the_middle() {
        let lift = Adjustments {
            blacks: 1.0,
            ..Default::default()
        };
        let dark = apply(lift, [20, 20, 20])[0] - 20;
        let mid = apply(lift, [128, 128, 128])[0].saturating_sub(128);
        assert!(dark > mid, "{dark} {mid}");
        let lower = Adjustments {
            whites: -1.0,
            ..Default::default()
        };
        assert!(apply(lower, [240, 240, 240])[0] < 240);
        assert_eq!(apply(lower, [0, 0, 0]), [0, 0, 0]);
    }

    #[test]
    fn the_full_preview_address_form_is_read() {
        let mut parts = vec!["0"; QUERY_FULL];
        parts[10] = "0.4";
        parts[13 + 2] = "-0.5";
        parts[29 + 7] = "9";
        let read = Adjustments::from_query(&parts.join(","));
        assert_eq!(read.vibrance, 0.4);
        assert_eq!(read.mix_hue[2], -0.5);
        assert_eq!(read.mix_luminance[7], 1.0);
        assert!(Adjustments::from_query(&vec!["0"; 20].join(",")).is_identity());
    }

    #[test]
    fn no_grading_changes_nothing_and_a_shadow_tint_spares_white() {
        let blue_shadows = Adjustments {
            grade_shadows: Grade {
                hue: 220.0,
                saturation: 1.0,
                luminance: 0.0,
            },
            ..Default::default()
        };
        let dark = apply(blue_shadows, [40, 40, 40]);
        assert!(dark[2] > dark[0] + 10, "shadows not tinted: {dark:?}");
        assert_eq!(apply(blue_shadows, [250, 250, 250]), [250, 250, 250]);
        // A tint changes colour, not light.
        let luma = |p: [u8; 3]| {
            LUMA[0] * f64::from(p[0]) + LUMA[1] * f64::from(p[1]) + LUMA[2] * f64::from(p[2])
        };
        assert!((luma(dark) - 40.0).abs() < 2.0, "{dark:?}");
    }

    #[test]
    fn a_highlight_tint_spares_black_and_luminance_lifts_its_range() {
        let warm = Adjustments {
            grade_highlights: Grade {
                hue: 35.0,
                saturation: 1.0,
                luminance: 0.0,
            },
            ..Default::default()
        };
        let bright = apply(warm, [220, 220, 220]);
        assert!(bright[0] > bright[2] + 10, "{bright:?}");
        assert_eq!(apply(warm, [10, 10, 10]), [10, 10, 10]);
        let mut lift = Adjustments::default();
        lift.grade_midtones.luminance = 1.0;
        assert!(apply(lift, [128, 128, 128])[1] > 150);
    }

    #[test]
    fn the_eyedropper_makes_a_tinted_grey_neutral() {
        let warm_grey = [140u8, 125, 105];
        let (temperature, tint) = neutralise(warm_grey.map(|v| f64::from(v) / 255.0));
        let fixed = apply(
            Adjustments {
                temperature,
                tint,
                ..Default::default()
            },
            warm_grey,
        );
        let spread = fixed.iter().max().unwrap() - fixed.iter().min().unwrap();
        assert!(spread <= 3, "{fixed:?} from {temperature} {tint}");
    }

    #[test]
    fn the_graded_preview_address_is_read() {
        let mut parts = vec!["0"; QUERY_GRADED];
        parts[37] = "200";
        parts[38] = "0.5";
        parts[47] = "-0.3";
        let read = Adjustments::from_query(&parts.join(","));
        assert_eq!(read.grade_shadows.hue, 200.0);
        assert_eq!(read.grade_shadows.saturation, 0.5);
        assert_eq!(read.grade_balance, -0.3);
    }

    #[test]
    fn an_older_album_without_the_new_controls_reads_as_no_change() {
        let old: Adjustments =
            serde_json::from_str(r#"{"exposure":0.5,"black_and_white":false}"#).unwrap();
        assert_eq!(old.exposure, 0.5);
        assert_eq!(old.mix_saturation, [0.0; 8]);
        assert_eq!(old.vibrance, 0.0);
    }
}
