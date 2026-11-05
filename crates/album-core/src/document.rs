//! The design document: where photos sit on a spread, never the photos themselves.
//!
//! Everything is in millimetres on the spread canvas, origin top-left, and the crop
//! is resolution-free. That lets the same document render from a preview or from the
//! original file at export without any recalculation.

use serde::{Deserialize, Serialize};

use crate::adjust::Adjustments;

pub const DOCUMENT_VERSION: u32 = 1;

const MM_PER_INCH: f64 = 25.4;

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct SizeMm {
    pub w: f64,
    pub h: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct RectMm {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

/// How a photo sits in its frame.
///
/// `scale` 1.0 means the photo just covers the frame. `cx` and `cy` are the centre of
/// the visible area as fractions of the photo. There are deliberately no pixel values
/// here: a pixel crop would tie the design to whichever preview was loaded.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Fit {
    pub scale: f64,
    pub cx: f64,
    pub cy: f64,
    pub rot_deg: f64,
}

impl Default for Fit {
    fn default() -> Self {
        Self {
            scale: 1.0,
            cx: 0.5,
            cy: 0.5,
            rot_deg: 0.0,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Frame {
    pub id: String,
    pub rect_mm: RectMm,
    #[serde(default)]
    pub corner_radius_mm: f64,
    pub asset_id: Option<String>,
    pub fit: Fit,
    /// Tone and colour for this photo. Absent in albums saved before effects existed.
    #[serde(default)]
    pub adjust: Adjustments,
    #[serde(default)]
    pub z: i32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum Background {
    Color { value: String },
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TextAlign {
    #[default]
    Left,
    Center,
    Right,
}

/// A block of text on a spread, always drawn above the photos.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TextBlock {
    pub id: String,
    pub rect_mm: RectMm,
    pub text: String,
    /// An installed font family. Empty uses the default.
    pub font: String,
    pub size_pt: f64,
    pub colour: String,
    #[serde(default)]
    pub align: TextAlign,
    #[serde(default)]
    pub bold: bool,
    #[serde(default)]
    pub italic: bool,
    pub line_height: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SpreadDesign {
    pub v: u32,
    pub template_id: Option<String>,
    pub size_mm: SizeMm,
    pub background: Background,
    pub frames: Vec<Frame>,
    /// Absent in albums saved before text existed.
    #[serde(default)]
    pub texts: Vec<TextBlock>,
}

/// Album formats studios order, as height x open width in inches: a 12x30 is 12 tall
/// and 30 wide when open, so each page is 15 x 12.
pub const SIZE_PRESETS_IN: &[(f64, f64)] = &[
    (12.0, 30.0),
    (12.0, 36.0),
    (12.0, 28.0),
    (12.0, 24.0),
    (12.0, 20.0),
    (12.0, 18.0),
    (12.0, 16.0),
    (15.0, 24.0),
    (16.0, 24.0),
    (17.0, 24.0),
    (10.0, 30.0),
    (10.0, 28.0),
    (10.0, 24.0),
    (10.0, 22.0),
    (10.0, 20.0),
    (10.0, 15.0),
    (8.0, 30.0),
    (8.0, 24.0),
    (8.0, 22.0),
    (8.0, 20.0),
    (8.0, 18.0),
    (8.0, 16.0),
];

pub const BLEED_OPTIONS_MM: &[f64] = &[0.0, 2.0, 3.0, 5.0];
pub const DPI_OPTIONS: &[f64] = &[200.0, 254.0, 300.0, 400.0];
pub const MARGIN_PRESETS_IN: &[(&str, f64)] = &[
    ("None", 0.0),
    ("Narrow", 0.2),
    ("Standard", 0.35),
    ("Wide", 0.6),
];
pub const GAP_PRESETS_IN: &[(&str, f64)] = &[
    ("None", 0.0),
    ("Fine", 0.05),
    ("Standard", 0.1),
    ("Wide", 0.2),
];
pub const PAPER_COLOURS: &[&str] = &[
    "#FFFFFF", "#F7F3EA", "#EFE7DA", "#E6E6E6", "#2B2B2B", "#000000",
];

/// Below these a photo prints visibly soft. The lab's own limits may replace them.
pub const DPI_WARN: f64 = 220.0;
pub const DPI_TOO_LOW: f64 = 150.0;

/// A margin beyond this share of the page would leave too little room for photos.
const MAX_MARGIN_SHARE: f64 = 0.25;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Binding {
    /// Thick pages that open flat, so photos can cross the fold. Usually fewer spreads.
    Layflat,
    /// Thin pages with more spreads, where the fold swallows some of the picture.
    Magazine,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DpiStatus {
    Good,
    Low,
    TooLow,
}

pub fn dpi_status(dpi: f64) -> DpiStatus {
    if dpi < DPI_TOO_LOW {
        DpiStatus::TooLow
    } else if dpi < DPI_WARN {
        DpiStatus::Low
    } else {
        DpiStatus::Good
    }
}

/// The printed album. Bleed and safe area are assumptions until the lab's real
/// requirements are entered.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ProjectSpec {
    /// One page, not the open book.
    pub trim_w_mm: f64,
    pub trim_h_mm: f64,
    pub bleed_mm: f64,
    pub safe_mm: f64,
    pub target_dpi: f64,
    pub binding: Binding,
    /// Paper left around the photos at the outer edges. Applies to the whole album.
    pub margin_mm: f64,
    /// Paper between neighbouring photos. Applies to the whole album.
    pub gap_mm: f64,
    pub paper: String,
}

impl ProjectSpec {
    /// From the size as studios quote it: a 12x30 is 30 wide when open and 12 tall.
    pub fn from_open_inches(open_width_in: f64, height_in: f64) -> Self {
        Self {
            trim_w_mm: open_width_in * MM_PER_INCH / 2.0,
            trim_h_mm: height_in * MM_PER_INCH,
            bleed_mm: 3.0,
            safe_mm: 6.0,
            target_dpi: 300.0,
            binding: Binding::Layflat,
            margin_mm: 0.35 * MM_PER_INCH,
            gap_mm: 0.1 * MM_PER_INCH,
            paper: "#FFFFFF".to_string(),
        }
    }

    /// For a custom size entered in centimetres.
    pub fn from_open_cm(open_width_cm: f64, height_cm: f64) -> Self {
        Self::from_open_inches(
            open_width_cm * 10.0 / MM_PER_INCH,
            height_cm * 10.0 / MM_PER_INCH,
        )
    }

    /// Catches values typed by hand that would produce a broken page.
    pub fn validate(&self) -> Result<(), String> {
        let sizes = [self.trim_w_mm, self.trim_h_mm, self.target_dpi];
        if sizes.iter().any(|v| !v.is_finite() || *v <= 0.0) {
            return Err("Size and DPI must be greater than zero.".to_string());
        }
        let spacing = [self.bleed_mm, self.safe_mm, self.margin_mm, self.gap_mm];
        if spacing.iter().any(|v| !v.is_finite() || *v < 0.0) {
            return Err("Bleed, margins and gaps cannot be negative.".to_string());
        }
        if self.margin_mm > self.trim_w_mm.min(self.trim_h_mm) * MAX_MARGIN_SHARE {
            return Err("That margin is too large for this album size.".to_string());
        }
        Ok(())
    }

    /// The open book without bleed, which is the shape a layout is judged against.
    pub fn spread_aspect(&self) -> f64 {
        (self.trim_w_mm * 2.0) / self.trim_h_mm
    }

    /// The full printed canvas, including bleed on every outer edge.
    pub fn canvas_mm(&self) -> SizeMm {
        SizeMm {
            w: self.trim_w_mm * 2.0 + self.bleed_mm * 2.0,
            h: self.trim_h_mm + self.bleed_mm * 2.0,
        }
    }
}

/// The part of a photo a frame shows, as fractions of the photo.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct VisibleArea {
    pub sx: f64,
    pub sy: f64,
    pub sw: f64,
    pub sh: f64,
}

/// The single definition of the crop, shared by the preview and the exporter.
pub fn visible_area(photo_aspect: f64, frame_aspect: f64, fit: &Fit) -> VisibleArea {
    let scale = fit.scale.max(1.0);
    let (base_w, base_h) = if photo_aspect > frame_aspect {
        (frame_aspect / photo_aspect, 1.0)
    } else {
        (1.0, photo_aspect / frame_aspect)
    };
    let sw = base_w / scale;
    let sh = base_h / scale;
    VisibleArea {
        sx: (fit.cx - sw / 2.0).clamp(0.0, 1.0 - sw),
        sy: (fit.cy - sh / 2.0).clamp(0.0, 1.0 - sh),
        sw,
        sh,
    }
}

/// The resolution a photo will print at in this frame.
///
/// Previews hide softness, so this number is what warns the photographer before the
/// lab does. Cover-fit keeps the two axes equal, so one axis is enough.
pub fn effective_dpi(photo_width_px: u32, photo_height_px: u32, frame: &Frame) -> f64 {
    let frame_aspect = frame.rect_mm.w / frame.rect_mm.h;
    let photo_aspect = f64::from(photo_width_px) / f64::from(photo_height_px);
    let area = visible_area(photo_aspect, frame_aspect, &frame.fit);
    f64::from(photo_width_px) * area.sw / (frame.rect_mm.w / MM_PER_INCH)
}
