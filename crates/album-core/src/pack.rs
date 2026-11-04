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

pub const MAX_FRAMES_PER_TEMPLATE: usize = 12;
const MAX_TEMPLATE_FILE_BYTES: u64 = 256 * 1024;
const MAX_TEMPLATES_PER_PACK: usize = 2000;
/// Smaller than this and a frame cannot hold a recognisable photo.
const MIN_FRAME_FRACTION: f64 = 0.01;

const BUILTIN_MANIFEST: &str = include_str!("../packs/eventor-essentials/pack.toml");

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
    #[serde(default)]
    pub z: i32,
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
        let r = frame.rect_pct;
        if ![r.x, r.y, r.w, r.h].iter().all(|v| v.is_finite()) {
            return Err("a frame has a value that is not a number".to_string());
        }
        let left = r.x.clamp(0.0, 1.0);
        let top = r.y.clamp(0.0, 1.0);
        let right = (r.x + r.w).clamp(0.0, 1.0);
        let bottom = (r.y + r.h).clamp(0.0, 1.0);
        if right - left < MIN_FRAME_FRACTION || bottom - top < MIN_FRAME_FRACTION {
            return Err("a frame is empty once kept on the spread".to_string());
        }
        frame.rect_pct = RectPct {
            x: left,
            y: top,
            w: right - left,
            h: bottom - top,
        };
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
