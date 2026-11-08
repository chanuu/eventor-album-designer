//! Finds photos on disk and makes the preview copies the designer works from.
//!
//! Originals are only ever read here. They are referenced, never copied or changed,
//! and previews live in a cache that is safe to delete.

use std::fs::{self, File};
use std::io::BufReader;
use std::path::{Path, PathBuf};

pub mod analyze;
pub mod eyes;

use album_core::adjust::Adjustments;
use image::metadata::Orientation;
use image::{DynamicImage, ImageReader};
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use thiserror::Error;
use walkdir::WalkDir;

pub mod selection;

const PHOTO_EXTENSIONS: &[&str] = &["jpg", "jpeg", "jpe", "png", "webp"];
const PREVIEW_JPEG_QUALITY: u8 = 85;

#[derive(Debug, Error)]
pub enum MediaError {
    #[error("could not read {path}: {reason}")]
    Read { path: String, reason: String },
    #[error("could not write the preview: {0}")]
    Write(String),
}

/// One photo on disk. `width` and `height` are as displayed, after EXIF rotation.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PhotoInfo {
    pub id: String,
    pub path: PathBuf,
    pub file_name: String,
    pub width: u32,
    pub height: u32,
    pub orientation: u8,
}

/// A photo the scan could not use, so the user can be told rather than left guessing.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SkippedFile {
    pub file_name: String,
    pub reason: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct ScanResult {
    pub photos: Vec<PhotoInfo>,
    pub skipped: Vec<SkippedFile>,
}

/// The two preview sizes. Anything else would multiply what the cache has to hold.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PreviewTier {
    /// For the photo grid.
    Grid,
    /// For a photo placed in a frame. The largest size editing ever loads.
    Edit,
}

impl PreviewTier {
    pub fn from_width(width: u32) -> Self {
        if width <= Self::Grid.long_edge() {
            Self::Grid
        } else {
            Self::Edit
        }
    }

    pub fn long_edge(self) -> u32 {
        match self {
            Self::Grid => 512,
            Self::Edit => 2048,
        }
    }
}

pub fn is_photo(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| PHOTO_EXTENSIONS.contains(&e.to_ascii_lowercase().as_str()))
}

/// Identifies a file by where it is and which version it is, without reading it all,
/// so a photo edited in Photoshop gets a fresh preview.
fn photo_id(path: &Path, size: u64, modified_ns: u128) -> String {
    let mut hasher = blake3::Hasher::new();
    hasher.update(path.as_os_str().as_encoded_bytes());
    hasher.update(&size.to_le_bytes());
    hasher.update(&modified_ns.to_le_bytes());
    hasher.finalize().to_hex()[..32].to_string()
}

fn read_orientation(path: &Path) -> u8 {
    let Ok(file) = File::open(path) else { return 1 };
    let Ok(exif) = exif::Reader::new().read_from_container(&mut BufReader::new(file)) else {
        return 1;
    };
    exif.get_field(exif::Tag::Orientation, exif::In::PRIMARY)
        .and_then(|field| field.value.get_uint(0))
        .and_then(|value| u8::try_from(value).ok())
        .filter(|value| (1..=8).contains(value))
        .unwrap_or(1)
}

/// Reads only the file header, which keeps a large folder quick.
fn read_photo(path: &Path) -> Result<PhotoInfo, String> {
    let meta = fs::metadata(path).map_err(|e| e.to_string())?;
    let modified_ns = meta
        .modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or(0, |duration| duration.as_nanos());
    let (raw_width, raw_height) = ImageReader::open(path)
        .map_err(|e| e.to_string())?
        .with_guessed_format()
        .map_err(|e| e.to_string())?
        .into_dimensions()
        .map_err(|e| e.to_string())?;
    if raw_width == 0 || raw_height == 0 {
        return Err("the image has no size".to_string());
    }

    let orientation = read_orientation(path);
    // EXIF values 5 to 8 turn the photo on its side.
    let (width, height) = if orientation >= 5 {
        (raw_height, raw_width)
    } else {
        (raw_width, raw_height)
    };

    Ok(PhotoInfo {
        id: photo_id(path, meta.len(), modified_ns),
        path: path.to_path_buf(),
        file_name: display_name(path),
        width,
        height,
        orientation,
    })
}

fn display_name(path: &Path) -> String {
    path.file_name().map_or_else(
        || path.display().to_string(),
        |name| name.to_string_lossy().into_owned(),
    )
}

/// Finds every usable photo in a folder and its subfolders, sorted by file name.
pub fn scan_folder(dir: &Path) -> Result<ScanResult, MediaError> {
    if !dir.is_dir() {
        return Err(MediaError::Read {
            path: dir.display().to_string(),
            reason: "not a folder".to_string(),
        });
    }

    let candidates: Vec<PathBuf> = WalkDir::new(dir)
        .into_iter()
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_file() && is_photo(entry.path()))
        .map(walkdir::DirEntry::into_path)
        .collect();

    let results: Vec<_> = candidates
        .par_iter()
        .map(|path| read_photo(path).map_err(|reason| (display_name(path), reason)))
        .collect();

    let mut scan = ScanResult::default();
    for result in results {
        match result {
            Ok(photo) => scan.photos.push(photo),
            Err((file_name, reason)) => scan.skipped.push(SkippedFile { file_name, reason }),
        }
    }
    scan.photos
        .sort_by_key(|photo| photo.file_name.to_lowercase());
    Ok(scan)
}

/// False when a photo carries a colour profile other than sRGB, such as Adobe RGB.
///
/// Export does not convert colours yet, so such a photo would print with shifted colour
/// and the photographer needs to know. A photo with no profile is assumed to be sRGB.
pub fn colour_profile_is_srgb(path: &Path) -> bool {
    use image::ImageDecoder;
    let profile = ImageReader::open(path)
        .ok()
        .and_then(|reader| reader.with_guessed_format().ok())
        .and_then(|reader| reader.into_decoder().ok())
        .and_then(|mut decoder| decoder.icc_profile().ok().flatten());
    profile.is_none_or(|bytes| bytes.windows(4).any(|w| w == b"sRGB"))
}

/// Where a preview is kept. The name comes from the id, never from a request's text.
pub fn preview_path(cache_dir: &Path, id: &str, tier: PreviewTier) -> PathBuf {
    let shard = id.get(..2).unwrap_or("00");
    cache_dir
        .join(shard)
        .join(format!("{id}_{}.jpg", tier.long_edge()))
}

/// Decodes the original at full size, turned the way it should be displayed.
pub fn decode_upright(photo: &PhotoInfo) -> Result<DynamicImage, MediaError> {
    let read_error = |reason: String| MediaError::Read {
        path: photo.path.display().to_string(),
        reason,
    };
    let mut image = ImageReader::open(&photo.path)
        .map_err(|e| read_error(e.to_string()))?
        .with_guessed_format()
        .map_err(|e| read_error(e.to_string()))?
        .decode()
        .map_err(|e| read_error(e.to_string()))?;
    if let Some(orientation) = Orientation::from_exif(photo.orientation) {
        image.apply_orientation(orientation);
    }
    Ok(image)
}

/// Returns the preview's file, making it if needed.
///
/// It is written to a temporary name and then moved into place, so a crash or a second
/// request can never serve a half-written image.
pub fn ensure_preview(
    photo: &PhotoInfo,
    cache_dir: &Path,
    tier: PreviewTier,
) -> Result<PathBuf, MediaError> {
    let target = preview_path(cache_dir, &photo.id, tier);
    if target.is_file() {
        return Ok(target);
    }

    let write_error = |e: &dyn std::fmt::Display| MediaError::Write(e.to_string());
    let edge = tier.long_edge();
    let image = decode_upright(photo)?;
    let scaled = if image.width().max(image.height()) > edge {
        image.thumbnail(edge, edge)
    } else {
        image
    };

    let folder = target
        .parent()
        .ok_or_else(|| MediaError::Write("the cache path has no folder".to_string()))?;
    fs::create_dir_all(folder).map_err(|e| write_error(&e))?;

    let temp = folder.join(format!(
        "{}.{:?}.tmp",
        photo.id,
        std::thread::current().id()
    ));
    let write = || -> Result<(), MediaError> {
        let file = File::create(&temp).map_err(|e| write_error(&e))?;
        let encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(
            std::io::BufWriter::new(file),
            PREVIEW_JPEG_QUALITY,
        );
        scaled
            .to_rgb8()
            .write_with_encoder(encoder)
            .map_err(|e| write_error(&e))?;
        fs::rename(&temp, &target).map_err(|e| write_error(&e))
    };
    let result = write();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result.map(|()| target)
}

/// A preview with adjustments applied, as JPEG bytes.
///
/// Not cached, because it changes with every slider movement and starts from a preview
/// that already is. This runs the same function as the exporter, so it shows what prints.
pub fn adjusted_preview(preview: &Path, adjust: &Adjustments) -> Result<Vec<u8>, MediaError> {
    let mut image = image::open(preview)
        .map_err(|e| MediaError::Read {
            path: preview.display().to_string(),
            reason: e.to_string(),
        })?
        .into_rgb8();
    adjust.apply_rgb(&mut image);

    let mut bytes = Vec::new();
    let encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(
        std::io::Cursor::new(&mut bytes),
        PREVIEW_JPEG_QUALITY,
    );
    image
        .write_with_encoder(encoder)
        .map_err(|e| MediaError::Write(e.to_string()))?;
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct TempDir(PathBuf);

    impl TempDir {
        fn new() -> Self {
            static NEXT: AtomicUsize = AtomicUsize::new(0);
            let id = NEXT.fetch_add(1, Ordering::Relaxed);
            let path =
                std::env::temp_dir().join(format!("album-media-test-{}-{id}", std::process::id()));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn jpeg_bytes(width: u32, height: u32) -> Vec<u8> {
        let mut bytes = Vec::new();
        DynamicImage::new_rgb8(width, height)
            .write_to(
                &mut std::io::Cursor::new(&mut bytes),
                image::ImageFormat::Jpeg,
            )
            .unwrap();
        bytes
    }

    fn write_jpeg(path: &Path, width: u32, height: u32) {
        fs::write(path, jpeg_bytes(width, height)).unwrap();
    }

    /// A JPEG carrying an EXIF orientation, as cameras write when held sideways.
    fn write_rotated_jpeg(path: &Path, width: u32, height: u32, orientation: u8) {
        let jpeg = jpeg_bytes(width, height);
        let tiff = [
            b'I',
            b'I',
            42,
            0,
            8,
            0,
            0,
            0, // little-endian header, first block at 8
            1,
            0, // one entry
            0x12,
            0x01,
            3,
            0,
            1,
            0,
            0,
            0,
            orientation,
            0,
            0,
            0, // Orientation
            0,
            0,
            0,
            0, // no next block
        ];
        let mut app1 = b"Exif\0\0".to_vec();
        app1.extend_from_slice(&tiff);
        let length = u16::try_from(app1.len() + 2).unwrap().to_be_bytes();

        let mut out = jpeg[..2].to_vec();
        out.extend_from_slice(&[0xFF, 0xE1, length[0], length[1]]);
        out.extend_from_slice(&app1);
        out.extend_from_slice(&jpeg[2..]);
        fs::write(path, out).unwrap();
    }

    #[test]
    fn scan_finds_photos_in_subfolders_sorted_and_ignores_other_files() {
        let dir = TempDir::new();
        fs::create_dir(dir.0.join("day two")).unwrap();
        write_jpeg(&dir.0.join("b.JPG"), 60, 40);
        write_jpeg(&dir.0.join("day two").join("a.jpeg"), 40, 60);
        fs::write(dir.0.join("notes.txt"), "not a photo").unwrap();

        let scan = scan_folder(&dir.0).unwrap();
        let names: Vec<_> = scan.photos.iter().map(|p| p.file_name.as_str()).collect();
        assert_eq!(names, ["a.jpeg", "b.JPG"]);
        assert_eq!((scan.photos[0].width, scan.photos[0].height), (40, 60));
        assert!(scan.skipped.is_empty());
    }

    #[test]
    fn a_corrupt_photo_is_reported_and_does_not_stop_the_scan() {
        let dir = TempDir::new();
        write_jpeg(&dir.0.join("good.jpg"), 30, 20);
        fs::write(dir.0.join("broken.jpg"), "not really a jpeg").unwrap();

        let scan = scan_folder(&dir.0).unwrap();
        assert_eq!(scan.photos.len(), 1);
        assert_eq!(scan.skipped.len(), 1);
        assert_eq!(scan.skipped[0].file_name, "broken.jpg");
    }

    #[test]
    fn a_missing_folder_is_an_error() {
        let dir = TempDir::new();
        assert!(scan_folder(&dir.0.join("missing")).is_err());
    }

    #[test]
    fn sideways_photos_report_their_displayed_shape_and_previews_come_out_upright() {
        let dir = TempDir::new();
        let cache = TempDir::new();
        // Stored wide, displayed tall.
        write_rotated_jpeg(&dir.0.join("sideways.jpg"), 60, 40, 6);

        let scan = scan_folder(&dir.0).unwrap();
        let photo = &scan.photos[0];
        assert_eq!(photo.orientation, 6);
        assert_eq!((photo.width, photo.height), (40, 60));

        let preview = ensure_preview(photo, &cache.0, PreviewTier::Grid).unwrap();
        let (width, height) = image::image_dimensions(preview).unwrap();
        assert_eq!((width, height), (40, 60));
    }

    #[test]
    fn previews_shrink_to_their_tier_keep_shape_and_are_reused() {
        let dir = TempDir::new();
        let cache = TempDir::new();
        write_jpeg(&dir.0.join("big.jpg"), 3000, 2000);
        let photo = scan_folder(&dir.0).unwrap().photos.remove(0);

        let path = ensure_preview(&photo, &cache.0, PreviewTier::Grid).unwrap();
        assert_eq!(image::image_dimensions(&path).unwrap(), (512, 341));

        // A reused preview is not rewritten, so its contents can be swapped to prove it.
        fs::write(&path, "already here").unwrap();
        let again = ensure_preview(&photo, &cache.0, PreviewTier::Grid).unwrap();
        assert_eq!(fs::read_to_string(again).unwrap(), "already here");

        let edit = ensure_preview(&photo, &cache.0, PreviewTier::Edit).unwrap();
        assert_eq!(image::image_dimensions(edit).unwrap(), (2048, 1365));
    }

    #[test]
    fn small_photos_are_not_enlarged() {
        let dir = TempDir::new();
        let cache = TempDir::new();
        write_jpeg(&dir.0.join("small.jpg"), 100, 50);
        let photo = scan_folder(&dir.0).unwrap().photos.remove(0);
        let path = ensure_preview(&photo, &cache.0, PreviewTier::Edit).unwrap();
        assert_eq!(image::image_dimensions(path).unwrap(), (100, 50));
    }

    #[test]
    fn editing_a_photo_gives_it_a_new_identity() {
        let dir = TempDir::new();
        let path = dir.0.join("photo.jpg");
        write_jpeg(&path, 30, 20);
        let before = scan_folder(&dir.0).unwrap().photos.remove(0);
        write_jpeg(&path, 90, 20);
        let after = scan_folder(&dir.0).unwrap().photos.remove(0);
        assert_ne!(before.id, after.id);
    }

    #[test]
    fn the_original_file_is_left_untouched() {
        let dir = TempDir::new();
        let cache = TempDir::new();
        let path = dir.0.join("original.jpg");
        write_jpeg(&path, 800, 600);
        let before = fs::read(&path).unwrap();
        let photo = scan_folder(&dir.0).unwrap().photos.remove(0);
        ensure_preview(&photo, &cache.0, PreviewTier::Grid).unwrap();
        assert_eq!(fs::read(&path).unwrap(), before);
    }

    #[test]
    fn tiers_are_chosen_from_the_requested_width() {
        assert_eq!(PreviewTier::from_width(200), PreviewTier::Grid);
        assert_eq!(PreviewTier::from_width(512), PreviewTier::Grid);
        assert_eq!(PreviewTier::from_width(513), PreviewTier::Edit);
    }
}
