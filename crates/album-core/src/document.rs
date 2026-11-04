//! The design document: where photos sit on a spread, never the photos themselves.
//!
//! Everything is in millimetres on the spread canvas, origin top-left, and the crop
//! is resolution-free. That lets the same document render from a preview or from the
//! original file at export without any recalculation.

use serde::{Deserialize, Serialize};

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
    #[serde(default)]
    pub z: i32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum Background {
    Color { value: String },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SpreadDesign {
    pub v: u32,
    pub template_id: Option<String>,
    pub size_mm: SizeMm,
    pub background: Background,
    pub frames: Vec<Frame>,
}

/// The printed album. Defaults for bleed and safe area are assumptions until the
/// lab's real requirements are entered.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct ProjectSpec {
    /// One page, not the open book.
    pub trim_w_mm: f64,
    pub trim_h_mm: f64,
    pub bleed_mm: f64,
    pub safe_mm: f64,
    pub target_dpi: f64,
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
        }
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
