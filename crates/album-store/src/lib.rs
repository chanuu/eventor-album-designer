//! Saving and opening album files.
//!
//! An album file holds the design and where the photos are, never the photos. It may
//! come from someone else, so opening one treats its contents as untrusted.

use std::fs;
use std::path::Path;

use album_core::document::{ProjectSpec, SpreadDesign};
use album_media::{is_photo, PhotoInfo};
use serde::{Deserialize, Serialize};
use thiserror::Error;

pub const PROJECT_VERSION: u32 = 1;
pub const PROJECT_EXTENSION: &str = "evalbum";

const MAX_PROJECT_BYTES: u64 = 64 * 1024 * 1024;

#[derive(Debug, Error)]
pub enum StoreError {
    #[error("could not read the album: {0}")]
    Read(String),
    #[error("could not save the album: {0}")]
    Write(String),
    #[error("this is not a valid album file: {0}")]
    Invalid(String),
    #[error("this album was made by a newer version of the app. Please update to open it.")]
    TooNew,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SavedSpread {
    pub id: String,
    pub photo_ids: Vec<String>,
    pub option_index: usize,
    pub design: SpreadDesign,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Project {
    pub version: u32,
    pub name: String,
    pub size_label: String,
    pub spec: ProjectSpec,
    pub photos: Vec<PhotoInfo>,
    pub spreads: Vec<SavedSpread>,
}

fn invalid(reason: impl Into<String>) -> StoreError {
    StoreError::Invalid(reason.into())
}

impl Project {
    /// Checks everything the rest of the app relies on being sensible.
    pub fn validate(&self) -> Result<(), StoreError> {
        if self.version > PROJECT_VERSION {
            return Err(StoreError::TooNew);
        }
        self.spec.validate().map_err(invalid)?;

        // A file can name any path, so only photo files may be read through it.
        if let Some(photo) = self.photos.iter().find(|p| !is_photo(&p.path)) {
            return Err(invalid(format!("{} is not a photo", photo.file_name)));
        }
        if self.photos.iter().any(|p| p.width == 0 || p.height == 0) {
            return Err(invalid("a photo has no size"));
        }

        for spread in &self.spreads {
            let size = spread.design.size_mm;
            if !(size.w.is_finite() && size.h.is_finite() && size.w > 0.0 && size.h > 0.0) {
                return Err(invalid("a spread has no size"));
            }
            for frame in &spread.design.frames {
                let r = frame.rect_mm;
                let f = frame.fit;
                let finite = [r.x, r.y, r.w, r.h, f.scale, f.cx, f.cy, f.rot_deg]
                    .iter()
                    .all(|v| v.is_finite());
                if !finite || r.w <= 0.0 || r.h <= 0.0 {
                    return Err(invalid("a frame has an impossible size"));
                }
            }
        }
        Ok(())
    }

    /// The ids of photos whose original file cannot be found right now.
    pub fn missing_photos(&self) -> Vec<String> {
        self.photos
            .iter()
            .filter(|p| !p.path.is_file())
            .map(|p| p.id.clone())
            .collect()
    }
}

/// Saves by writing a temporary file and moving it into place, so a crash or a full
/// disk can never leave a damaged album where a good one was.
pub fn save_project(path: &Path, project: &Project) -> Result<(), StoreError> {
    let write_error = |e: &dyn std::fmt::Display| StoreError::Write(e.to_string());
    project.validate()?;
    let json = serde_json::to_vec_pretty(project).map_err(|e| write_error(&e))?;

    let mut temp = path.as_os_str().to_owned();
    temp.push(".saving");
    let temp = std::path::PathBuf::from(temp);
    fs::write(&temp, json).map_err(|e| write_error(&e))?;
    fs::rename(&temp, path).map_err(|e| {
        let _ = fs::remove_file(&temp);
        write_error(&e)
    })
}

pub fn load_project(path: &Path) -> Result<Project, StoreError> {
    let read_error = |e: &dyn std::fmt::Display| StoreError::Read(e.to_string());
    let size = fs::metadata(path).map_err(|e| read_error(&e))?.len();
    if size > MAX_PROJECT_BYTES {
        return Err(invalid("the file is too large"));
    }
    let bytes = fs::read(path).map_err(|e| read_error(&e))?;

    // Read the version alone first, so a newer album gets a helpful message and not a
    // confusing complaint about a field this version has never heard of.
    #[derive(Deserialize)]
    struct VersionOnly {
        version: u32,
    }
    let version: VersionOnly =
        serde_json::from_slice(&bytes).map_err(|e| invalid(e.to_string()))?;
    if version.version > PROJECT_VERSION {
        return Err(StoreError::TooNew);
    }

    let project: Project = serde_json::from_slice(&bytes).map_err(|e| invalid(e.to_string()))?;
    project.validate()?;
    Ok(project)
}

#[cfg(test)]
mod tests {
    use super::*;
    use album_core::document::{Background, Fit, Frame, RectMm, SizeMm};
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct TempDir(PathBuf);

    impl TempDir {
        fn new() -> Self {
            static NEXT: AtomicUsize = AtomicUsize::new(0);
            let id = NEXT.fetch_add(1, Ordering::Relaxed);
            let path =
                std::env::temp_dir().join(format!("album-store-test-{}-{id}", std::process::id()));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn photo(path: &Path) -> PhotoInfo {
        PhotoInfo {
            id: "photo-1".into(),
            path: path.to_path_buf(),
            file_name: "a.jpg".into(),
            width: 300,
            height: 200,
            orientation: 1,
        }
    }

    fn project(photo_path: &Path) -> Project {
        Project {
            version: PROJECT_VERSION,
            name: "Nimal & Sachini".into(),
            size_label: "12×30 in".into(),
            spec: ProjectSpec::from_open_inches(30.0, 12.0),
            photos: vec![photo(photo_path)],
            spreads: vec![SavedSpread {
                id: "s1".into(),
                photo_ids: vec!["photo-1".into()],
                option_index: 0,
                design: SpreadDesign {
                    v: 1,
                    template_id: Some("eventor-essentials/1-full-spread".into()),
                    size_mm: SizeMm { w: 768.0, h: 310.8 },
                    background: Background::Color {
                        value: "#FFFFFF".into(),
                    },
                    frames: vec![Frame {
                        id: "f1".into(),
                        rect_mm: RectMm {
                            x: 0.0,
                            y: 0.0,
                            w: 768.0,
                            h: 310.8,
                        },
                        corner_radius_mm: 0.0,
                        asset_id: Some("photo-1".into()),
                        fit: Fit {
                            scale: 1.5,
                            cx: 0.4,
                            cy: 0.6,
                            rot_deg: 0.0,
                        },
                        z: 0,
                    }],
                },
            }],
        }
    }

    #[test]
    fn an_album_survives_saving_and_opening_exactly() {
        let dir = TempDir::new();
        let file = dir.0.join("wedding.evalbum");
        let original = project(&dir.0.join("a.jpg"));

        save_project(&file, &original).unwrap();
        assert_eq!(load_project(&file).unwrap(), original);
    }

    #[test]
    fn saving_again_replaces_the_file_and_leaves_nothing_behind() {
        let dir = TempDir::new();
        let file = dir.0.join("wedding.evalbum");
        let mut album = project(&dir.0.join("a.jpg"));
        save_project(&file, &album).unwrap();
        album.name = "Renamed".into();
        save_project(&file, &album).unwrap();

        assert_eq!(load_project(&file).unwrap().name, "Renamed");
        let names: Vec<_> = fs::read_dir(&dir.0).unwrap().flatten().collect();
        assert_eq!(names.len(), 1, "only the album file should remain");
    }

    #[test]
    fn a_failed_save_keeps_the_previous_album() {
        let dir = TempDir::new();
        let file = dir.0.join("wedding.evalbum");
        let good = project(&dir.0.join("a.jpg"));
        save_project(&file, &good).unwrap();

        let mut bad = good.clone();
        bad.spec.trim_w_mm = -1.0;
        assert!(save_project(&file, &bad).is_err());
        assert_eq!(load_project(&file).unwrap(), good);
    }

    #[test]
    fn damaged_or_newer_files_get_clear_errors() {
        let dir = TempDir::new();
        let file = dir.0.join("x.evalbum");

        fs::write(&file, "not an album {").unwrap();
        assert!(matches!(load_project(&file), Err(StoreError::Invalid(_))));

        fs::write(&file, r#"{"version": 999, "future_field": true}"#).unwrap();
        assert!(matches!(load_project(&file), Err(StoreError::TooNew)));

        assert!(matches!(
            load_project(&dir.0.join("missing.evalbum")),
            Err(StoreError::Read(_))
        ));
    }

    #[test]
    fn an_album_cannot_point_at_files_that_are_not_photos() {
        let dir = TempDir::new();
        let album = project(Path::new("C:/Windows/win.ini"));
        let file = dir.0.join("x.evalbum");
        fs::write(&file, serde_json::to_vec(&album).unwrap()).unwrap();
        assert!(matches!(load_project(&file), Err(StoreError::Invalid(_))));
    }

    #[test]
    fn impossible_values_in_a_file_are_refused() {
        let dir = TempDir::new();
        let mut album = project(&dir.0.join("a.jpg"));
        album.spreads[0].design.frames[0].rect_mm.w = -5.0;
        assert!(album.validate().is_err());

        let mut album = project(&dir.0.join("a.jpg"));
        album.photos[0].width = 0;
        assert!(album.validate().is_err());
    }

    #[test]
    fn moved_photos_are_reported_as_missing() {
        let dir = TempDir::new();
        let present = dir.0.join("a.jpg");
        let album = project(&present);
        assert_eq!(album.missing_photos(), ["photo-1"]);

        fs::write(&present, "x").unwrap();
        assert!(album.missing_photos().is_empty());
    }
}
