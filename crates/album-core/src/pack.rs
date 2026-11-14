//! Layout packs: layouts as data, loaded at runtime, so new designs can be added
//! without shipping a new app.
//!
//! A pack is untrusted input. It is parsed against a strict schema and has no way to
//! run code: an unknown field such as a script hook gets the template rejected.

use std::collections::HashMap;
use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::builtin_list::BUILTIN_TEMPLATES;
use crate::card_list::CARD_TEMPLATES;
use crate::document::TextAlign;

pub const MAX_FRAMES_PER_TEMPLATE: usize = 12;
const MAX_TEMPLATE_FILE_BYTES: u64 = 256 * 1024;
const MAX_TEMPLATES_PER_PACK: usize = 2000;
/// Smaller than this and a frame cannot hold a recognisable photo.
const MIN_FRAME_FRACTION: f64 = 0.01;

const BUILTIN_MANIFEST: &str = include_str!("../packs/eventor-essentials/pack.toml");
const CARDS_MANIFEST: &str = include_str!("../packs/eventor-cards/pack.toml");

const MAX_PANELS_PER_TEMPLATE: usize = 12;
const MAX_TEXTS_PER_TEMPLATE: usize = 16;
const MAX_TEMPLATE_TEXT_BYTES: usize = 600;
/// Text taller than this share of the card is a mistake, not a heading.
const MAX_TEXT_SIZE: f64 = 0.3;

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PackManifest {
    pub id: String,
    pub name: String,
    pub version: String,
    pub author: Option<String>,
    pub min_app_version: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RectPct {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TemplateFrame {
    pub rect_pct: RectPct,
    /// Runs past the paper edge instead of stopping at the album's margin.
    #[serde(default)]
    pub bleed: bool,
    #[serde(default)]
    pub z: i32,
    /// A white line inside the photo's edge, as a share of the card's height.
    #[serde(default)]
    pub border: f64,
}

/// A flat panel of colour on a card.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TemplatePanel {
    pub rect_pct: RectPct,
    pub colour: String,
    #[serde(default = "solid")]
    pub opacity: f64,
    #[serde(default)]
    pub z: i32,
}

fn solid() -> f64 {
    1.0
}

fn usual_line_height() -> f64 {
    1.2
}

/// Text a card comes with.
///
/// `text` may hold places for the couple's details, such as `{FIRST} & {SECOND}` or
/// `{date:dd | mm | yy}`, which the app fills in. Text with `message` set is a
/// placeholder for the studio's own words.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TemplateText {
    pub rect_pct: RectPct,
    pub text: String,
    #[serde(default)]
    pub message: bool,
    #[serde(default)]
    pub font: String,
    /// Letter height as a share of the card's height, so one template suits every size.
    pub size: f64,
    pub colour: String,
    #[serde(default)]
    pub align: TextAlign,
    #[serde(default)]
    pub bold: bool,
    #[serde(default)]
    pub italic: bool,
    #[serde(default = "usual_line_height")]
    pub line_height: f64,
    #[serde(default)]
    pub rot_deg: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub enum AnyAspect {
    #[serde(rename = "any")]
    Any,
}

/// Which album shapes a template suits.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum AspectRange {
    Any(AnyAspect),
    Between { min: f64, max: f64 },
}

impl AspectRange {
    pub fn contains(&self, aspect: f64) -> bool {
        match self {
            Self::Any(_) => true,
            Self::Between { min, max } => (*min..=*max).contains(&aspect),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Template {
    pub id: String,
    pub name: String,
    pub frame_count: usize,
    pub spread_aspect: AspectRange,
    #[serde(default)]
    pub tags: Vec<String>,
    /// Fractions of the trimmed spread, so one pack suits every album size.
    pub frames: Vec<TemplateFrame>,
    /// The paper colour a card is designed on. Albums use the album's own paper.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub background: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub panels: Vec<TemplatePanel>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub texts: Vec<TemplateText>,
}

fn is_colour(value: &str) -> bool {
    value.len() == 7 && value.starts_with('#') && value[1..].chars().all(|c| c.is_ascii_hexdigit())
}

/// Keeps a rectangle on the card, or says why it cannot be.
fn kept_on_card(r: RectPct, what: &str) -> Result<RectPct, String> {
    if ![r.x, r.y, r.w, r.h].iter().all(|v| v.is_finite()) {
        return Err(format!("{what} has a value that is not a number"));
    }
    let left = r.x.clamp(0.0, 1.0);
    let top = r.y.clamp(0.0, 1.0);
    let right = (r.x + r.w).clamp(0.0, 1.0);
    let bottom = (r.y + r.h).clamp(0.0, 1.0);
    if right - left < MIN_FRAME_FRACTION || bottom - top < MIN_FRAME_FRACTION {
        return Err(format!("{what} is empty once kept on the spread"));
    }
    Ok(RectPct {
        x: left,
        y: top,
        w: right - left,
        h: bottom - top,
    })
}

#[derive(Debug, Error)]
pub enum PackError {
    #[error("could not read {path}: {source}")]
    Read {
        path: String,
        source: std::io::Error,
    },
    #[error("invalid pack manifest: {0}")]
    Manifest(#[from] toml::de::Error),
    #[error("pack id {0:?} may only use lowercase letters, digits and hyphens")]
    BadPackId(String),
    #[error("too many templates: the limit is {MAX_TEMPLATES_PER_PACK}")]
    TooManyTemplates,
}

/// A template that was left out, and why. One bad file must not lose the whole pack.
#[derive(Debug, Clone, PartialEq)]
pub struct RejectedTemplate {
    pub file: String,
    pub reason: String,
}

#[derive(Debug, Clone)]
pub struct LoadedPack {
    pub manifest: PackManifest,
    pub templates: Vec<Template>,
    pub rejected: Vec<RejectedTemplate>,
}

fn valid_pack_id(id: &str) -> bool {
    !id.is_empty()
        && id
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

/// Checks a template and clamps its frames onto the spread.
pub fn validate_template(mut template: Template, pack_id: &str) -> Result<Template, String> {
    if !template.id.starts_with(&format!("{pack_id}/")) {
        return Err(format!(
            "id {:?} must start with \"{pack_id}/\"",
            template.id
        ));
    }
    if template.frame_count == 0 || template.frame_count > MAX_FRAMES_PER_TEMPLATE {
        return Err(format!(
            "frame_count {} is outside 1 to {MAX_FRAMES_PER_TEMPLATE}",
            template.frame_count
        ));
    }
    if template.frames.len() != template.frame_count {
        return Err(format!(
            "frame_count says {} but there are {} frames",
            template.frame_count,
            template.frames.len()
        ));
    }
    if let AspectRange::Between { min, max } = template.spread_aspect {
        if !(min.is_finite() && max.is_finite() && min > 0.0 && min <= max) {
            return Err("spread_aspect needs 0 < min <= max".to_string());
        }
    }

    for frame in &mut template.frames {
        frame.rect_pct = kept_on_card(frame.rect_pct, "a frame")?;
        if !(frame.border.is_finite() && (0.0..=0.05).contains(&frame.border)) {
            return Err("a frame's border is out of range".to_string());
        }
    }

    if let Some(colour) = &template.background {
        if !is_colour(colour) {
            return Err(format!(
                "background {colour:?} is not a colour like #1A2B3C"
            ));
        }
    }
    if template.panels.len() > MAX_PANELS_PER_TEMPLATE {
        return Err(format!("more than {MAX_PANELS_PER_TEMPLATE} panels"));
    }
    for panel in &mut template.panels {
        panel.rect_pct = kept_on_card(panel.rect_pct, "a panel")?;
        if !is_colour(&panel.colour) {
            return Err(format!("panel colour {:?} is not a colour", panel.colour));
        }
        if !(panel.opacity.is_finite() && (0.0..=1.0).contains(&panel.opacity)) {
            return Err("a panel's opacity is outside 0 to 1".to_string());
        }
    }
    if template.texts.len() > MAX_TEXTS_PER_TEMPLATE {
        return Err(format!("more than {MAX_TEXTS_PER_TEMPLATE} text blocks"));
    }
    for text in &mut template.texts {
        text.rect_pct = kept_on_card(text.rect_pct, "a text block")?;
        if !is_colour(&text.colour) {
            return Err(format!("text colour {:?} is not a colour", text.colour));
        }
        if !(text.size.is_finite() && text.size > 0.0 && text.size <= MAX_TEXT_SIZE) {
            return Err("a text block's size is out of range".to_string());
        }
        if !(text.line_height.is_finite() && (0.5..=4.0).contains(&text.line_height)) {
            return Err("a text block's line height is out of range".to_string());
        }
        if ![0.0, 90.0, 270.0].contains(&text.rot_deg) {
            return Err("text can only be turned by 90 or 270 degrees".to_string());
        }
        if text.text.is_empty() || text.text.len() > MAX_TEMPLATE_TEXT_BYTES {
            return Err("a text block is empty or too long".to_string());
        }
    }
    Ok(template)
}

fn parse_template(file: &str, json: &str, pack_id: &str) -> Result<Template, RejectedTemplate> {
    let reject = |reason: String| RejectedTemplate {
        file: file.to_string(),
        reason,
    };
    let template: Template = serde_json::from_str(json).map_err(|e| reject(e.to_string()))?;
    validate_template(template, pack_id).map_err(reject)
}

fn read_error(path: &Path, source: std::io::Error) -> PackError {
    PackError::Read {
        path: path.display().to_string(),
        source,
    }
}

/// Loads a pack directory: `pack.toml` plus `templates/*.json`.
pub fn load_pack_dir(dir: &Path) -> Result<LoadedPack, PackError> {
    let manifest_path = dir.join("pack.toml");
    let manifest_text =
        fs::read_to_string(&manifest_path).map_err(|e| read_error(&manifest_path, e))?;
    let manifest: PackManifest = toml::from_str(&manifest_text)?;
    if !valid_pack_id(&manifest.id) {
        return Err(PackError::BadPackId(manifest.id));
    }

    let templates_dir = dir.join("templates");
    let mut entries = fs::read_dir(&templates_dir)
        .map_err(|e| read_error(&templates_dir, e))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| read_error(&templates_dir, e))?;
    entries.sort_by_key(|e| e.file_name());
    if entries.len() > MAX_TEMPLATES_PER_PACK {
        return Err(PackError::TooManyTemplates);
    }

    let mut templates = Vec::new();
    let mut rejected = Vec::new();
    for entry in entries {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let file = entry.file_name().to_string_lossy().into_owned();
        let reject = |reason: String| RejectedTemplate {
            file: file.clone(),
            reason,
        };

        // Not following links keeps a pack from reading files outside its own folder.
        let meta = match fs::symlink_metadata(&path) {
            Ok(meta) => meta,
            Err(e) => {
                rejected.push(reject(e.to_string()));
                continue;
            }
        };
        if !meta.file_type().is_file() {
            rejected.push(reject("not a regular file".to_string()));
            continue;
        }
        if meta.len() > MAX_TEMPLATE_FILE_BYTES {
            rejected.push(reject("file is too large".to_string()));
            continue;
        }

        match fs::read_to_string(&path) {
            Ok(json) => match parse_template(&file, &json, &manifest.id) {
                Ok(template) => templates.push(template),
                Err(bad) => rejected.push(bad),
            },
            Err(e) => rejected.push(reject(e.to_string())),
        }
    }

    Ok(LoadedPack {
        manifest,
        templates,
        rejected,
    })
}

/// The pack compiled into the app, so a fresh install has layouts straight away.
pub fn builtin_pack() -> LoadedPack {
    let manifest: PackManifest =
        toml::from_str(BUILTIN_MANIFEST).expect("the built-in manifest is valid");
    let templates = BUILTIN_TEMPLATES
        .iter()
        .map(|(file, json)| {
            parse_template(file, json, &manifest.id)
                .unwrap_or_else(|bad| panic!("built-in template {}: {}", bad.file, bad.reason))
        })
        .collect();
    LoadedPack {
        manifest,
        templates,
        rejected: Vec::new(),
    }
}

/// The thank you card designs that come with the app.
pub fn cards_pack() -> LoadedPack {
    let manifest: PackManifest =
        toml::from_str(CARDS_MANIFEST).expect("the cards manifest is valid");
    let templates = CARD_TEMPLATES
        .iter()
        .map(|(file, json)| {
            parse_template(file, json, &manifest.id)
                .unwrap_or_else(|bad| panic!("card template {}: {}", bad.file, bad.reason))
        })
        .collect();
    LoadedPack {
        manifest,
        templates,
        rejected: Vec::new(),
    }
}

/// Every available template, indexed by frame count so auto-pick is a lookup.
#[derive(Debug, Default, Clone)]
pub struct TemplateRegistry {
    templates: HashMap<String, Template>,
    by_count: HashMap<usize, Vec<String>>,
}

impl TemplateRegistry {
    pub fn with_builtin() -> Self {
        let mut registry = Self::default();
        registry.add_pack(builtin_pack());
        registry
    }

    /// Card designs are kept apart from album layouts, so neither is offered for the other.
    pub fn with_cards() -> Self {
        let mut registry = Self::default();
        registry.add_pack(cards_pack());
        registry
    }

    /// Later packs win on the same id, so a studio can replace a built-in layout.
    pub fn add_pack(&mut self, pack: LoadedPack) {
        for template in pack.templates {
            if let Some(old) = self.templates.get(&template.id) {
                if let Some(ids) = self.by_count.get_mut(&old.frame_count) {
                    ids.retain(|id| id != &template.id);
                }
            }
            self.by_count
                .entry(template.frame_count)
                .or_default()
                .push(template.id.clone());
            self.templates.insert(template.id.clone(), template);
        }
    }

    pub fn get(&self, id: &str) -> Option<&Template> {
        self.templates.get(id)
    }

    pub fn with_frame_count(&self, count: usize) -> impl Iterator<Item = &Template> {
        self.by_count
            .get(&count)
            .into_iter()
            .flatten()
            .filter_map(|id| self.templates.get(id))
    }

    pub fn len(&self) -> usize {
        self.templates.len()
    }

    pub fn is_empty(&self) -> bool {
        self.templates.is_empty()
    }
}
