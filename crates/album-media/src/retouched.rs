//! Photos retouched outside an album: a finished copy beside the original.
//!
//! The camera original is never written. The copy goes in a `Retouched` folder next to
//! it with the same name, where photographers will look for it, and a small file beside
//! the copy keeps the edits so the photo can be opened again and changed.

use std::fs;
use std::path::{Path, PathBuf};

use album_core::adjust::Adjustments;
use album_core::retouch::{apply_retouch, RetouchEdits};
use serde::{Deserialize, Serialize};

use crate::{decode_upright, MediaError, PhotoInfo};

pub const RETOUCHED_FOLDER: &str = "Retouched";
const EDITS_SUFFIX: &str = ".retouch.json";
const SAVE_QUALITY: u8 = 95;
/// An edits file larger than this is not one the app wrote.
const MAX_EDITS_BYTES: u64 = 8 * 1024 * 1024;

/// What the retoucher keeps for one photo: its strokes and its colour.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct SavedRetouch {
    pub edits: RetouchEdits,
    pub adjust: Adjustments,
}

fn folder(photo: &PhotoInfo) -> PathBuf {
    photo
        .path
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join(RETOUCHED_FOLDER)
}

/// Where the finished copy of a photo goes.
pub fn retouched_path(photo: &PhotoInfo) -> PathBuf {
    let stem = photo
        .path
        .file_stem()
        .map_or_else(|| photo.id.clone(), |s| s.to_string_lossy().into_owned());
    folder(photo).join(format!("{stem}.jpg"))
}

/// Where a photo's edits are kept. It uses the whole file name, so IMG_1.jpg and
/// IMG_1.png in one folder keep separate edits.
pub fn edits_path(photo: &PhotoInfo) -> PathBuf {
    folder(photo).join(format!("{}{EDITS_SUFFIX}", photo.file_name))
}

/// The edits saved for a photo last time, if any. A damaged file reads as none.
pub fn read_saved(photo: &PhotoInfo) -> Option<SavedRetouch> {
    let path = edits_path(photo);
    let meta = fs::metadata(&path).ok()?;
    if meta.len() > MAX_EDITS_BYTES {
        return None;
    }
    let saved: SavedRetouch = serde_json::from_str(&fs::read_to_string(path).ok()?).ok()?;
    Some(SavedRetouch {
        edits: saved.edits.sanitized(),
        adjust: saved.adjust.sanitized(),
    })
}

fn same_file(a: &Path, b: &Path) -> bool {
    match (fs::canonicalize(a), fs::canonicalize(b)) {
        (Ok(a), Ok(b)) => a == b,
        _ => a == b,
    }
}

/// Draws the photo at full size with its edits and colour, and writes the copy and the
/// edits. Returns where the copy went.
pub fn save_retouched(photo: &PhotoInfo, saved: &SavedRetouch) -> Result<PathBuf, MediaError> {
    let write_error = |e: &dyn std::fmt::Display| MediaError::Write(e.to_string());
    let target = retouched_path(photo);
    if same_file(&target, &photo.path) {
        return Err(MediaError::Write(
            "the retouched copy would replace the original".to_string(),
        ));
    }

    let decoded = decode_upright(photo)?;
    let faces = if saved.edits.needs_faces() {
        Some(crate::skin::find_skin(&decoded)?)
    } else {
        None
    };
    let mut image = decoded.into_rgb8();
    let (w, h) = (image.width() as usize, image.height() as usize);
    apply_retouch(&mut image, w, h, &saved.edits, faces.as_ref());
    saved.adjust.apply_rgb(&mut image);

    fs::create_dir_all(folder(photo)).map_err(|e| write_error(&e))?;
    // Written under a temporary name and moved into place, so a crash never leaves half
    // a photo where the finished one should be.
    let temp = target.with_extension("jpg.tmp");
    let result = (|| {
        let file = fs::File::create(&temp).map_err(|e| write_error(&e))?;
        let encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(
            std::io::BufWriter::new(file),
            SAVE_QUALITY,
        );
        image
            .write_with_encoder(encoder)
            .map_err(|e| write_error(&e))?;
        fs::rename(&temp, &target).map_err(|e| write_error(&e))
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result?;

    let json = serde_json::to_string_pretty(saved).map_err(|e| write_error(&e))?;
    fs::write(edits_path(photo), json).map_err(|e| write_error(&e))?;
    Ok(target)
}

#[cfg(test)]
mod tests {
    use super::*;
    use album_core::retouch::{Stroke, Tool};

    fn temp_dir(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("album-retouched-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn photo_in(dir: &Path) -> PhotoInfo {
        let path = dir.join("bride.png");
        image::RgbImage::from_pixel(60, 40, image::Rgb([120, 100, 90]))
            .save(&path)
            .unwrap();
        crate::read_photo_file(&path).unwrap()
    }

    #[test]
    fn saving_writes_a_copy_and_its_edits_and_leaves_the_original() {
        let dir = temp_dir("save");
        let photo = photo_in(&dir);
        let before = fs::read(&photo.path).unwrap();
        let saved = SavedRetouch {
            edits: RetouchEdits {
                strokes: vec![Stroke {
                    tool: Tool::Brighten,
                    points: vec![[0.5, 0.5]],
                    radius: 0.25,
                    softness: 0.2,
                    strength: 1.0,
                    source: None,
                }],
                ..Default::default()
            },
            adjust: Adjustments::default(),
        };
        let copy = save_retouched(&photo, &saved).unwrap();
        assert_eq!(copy, dir.join("Retouched").join("bride.jpg"));
        assert_eq!(
            fs::read(&photo.path).unwrap(),
            before,
            "the original changed"
        );
        let out = image::open(&copy).unwrap().to_rgb8();
        assert_eq!(out.dimensions(), (60, 40));
        assert!(out.get_pixel(30, 20)[0] > 130, "the edit was not drawn");
        assert_eq!(read_saved(&photo), Some(saved));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_photo_never_retouched_has_no_saved_edits_and_a_damaged_file_reads_as_none() {
        let dir = temp_dir("none");
        let photo = photo_in(&dir);
        assert_eq!(read_saved(&photo), None);
        fs::create_dir_all(dir.join("Retouched")).unwrap();
        fs::write(edits_path(&photo), "{not json").unwrap();
        assert_eq!(read_saved(&photo), None);
        let _ = fs::remove_dir_all(&dir);
    }
}
