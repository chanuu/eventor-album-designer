//! Tone and colour adjustments for a photo.
//!
//! The preview and the exporter both run this one function, so a change on screen is
//! the change that prints. It works on raw RGB bytes, using lookup tables for speed.

use serde::{Deserialize, Serialize};

const MAX_EXPOSURE_STOPS: f64 = 2.0;
const TONE_STRENGTH: f64 = 0.5;
const TEMPERATURE_STRENGTH: f64 = 0.2;
const TINT_STRENGTH: f64 = 0.15;

// Rec. 709 weights: how bright each channel looks to the eye.
const LUMA: [f64; 3] = [0.2126, 0.7152, 0.0722];

/// All sliders run from -1 to 1 with 0 meaning no change, except exposure, in stops.
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
}

fn limited(value: f64, limit: f64) -> f64 {
    if value.is_finite() {
        value.clamp(-limit, limit)
    } else {
        0.0
    }
}

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
        if parts.len() != 8 {
            return Self::default();
        }
        Self {
            exposure: parts[0],
            contrast: parts[1],
            highlights: parts[2],
            shadows: parts[3],
            temperature: parts[4],
            tint: parts[5],
            saturation: parts[6],
            black_and_white: parts[7] != 0.0,
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
        v + TONE_STRENGTH * (self.shadows * shadow_weight + self.highlights * highlight_weight)
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

    /// Applies the adjustments to tightly packed RGB bytes.
    pub fn apply_rgb(&self, pixels: &mut [u8]) {
        let settings = self.sanitized();
        if settings.is_identity() {
            return;
        }
        let tables = settings.lookup_tables();
        let colour = if settings.black_and_white {
            0.0
        } else {
            1.0 + settings.saturation
        };

        for pixel in pixels.as_chunks_mut::<3>().0 {
            let mapped = [
                f64::from(tables[0][usize::from(pixel[0])]),
                f64::from(tables[1][usize::from(pixel[1])]),
                f64::from(tables[2][usize::from(pixel[2])]),
            ];
            let luma = LUMA[0] * mapped[0] + LUMA[1] * mapped[1] + LUMA[2] * mapped[2];
            for (out, value) in pixel.iter_mut().zip(mapped) {
                *out = (luma + (value - luma) * colour).clamp(0.0, 255.0).round() as u8;
            }
        }
    }
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
}
