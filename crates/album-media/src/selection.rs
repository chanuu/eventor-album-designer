//! Finding the photos a customer selected among the originals on the studio's disk.
//!
//! A file name alone cannot be trusted, because two cameras can both produce
//! IMG_0001.JPG. Where the gallery recorded the original's hash, that decides. Otherwise,
//! or when the file has since been edited, the name decides, and a name that fits more
//! than one file is put to the photographer rather than guessed at.

use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::path::Path;

use image::imageops::FilterType;
use image::{codecs::jpeg::JpegEncoder, RgbImage};
use rayon::prelude::*;
use serde::{Deserialize, Serialize};

use crate::{decode_upright, MediaError, PhotoInfo};

const FULL_MAX_EDGE: u32 = 1920;
const THUMB_MAX_EDGE: u32 = 400;
const THUMB_QUALITY: u8 = 70;
/// Tried in turn until the copy fits, as the studio admin does for its uploads.
const FULL_QUALITIES: [u8; 4] = [82, 72, 62, 50];
const MAX_FULL_BYTES: usize = 2 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct WantedPhoto {
    pub file_name: String,
    pub source_hash: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct AmbiguousPhoto {
    pub file_name: String,
    pub options: Vec<PhotoInfo>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct SelectionMatch {
    /// In the order the customer's gallery lists them.
    pub photos: Vec<PhotoInfo>,
    /// Found by name, but no longer the same file that went into the gallery.
    pub changed: Vec<String>,
    pub missing: Vec<String>,
    pub ambiguous: Vec<AmbiguousPhoto>,
}

/// Identifies a file by its whole content. Unreadable files simply never match.
pub fn file_hash(path: &Path) -> Result<String, MediaError> {
    let read_error = |e: std::io::Error| MediaError::Read {
        path: path.display().to_string(),
        reason: e.to_string(),
    };
    let mut hasher = blake3::Hasher::new();
    let file = File::open(path).map_err(read_error)?;
    hasher.update_reader(file).map_err(read_error)?;
    Ok(hasher.finalize().to_hex().to_string())
}

fn stem(name: &str) -> String {
    Path::new(name)
        .file_stem()
        .map_or_else(String::new, |s| s.to_string_lossy().to_lowercase())
}

/// Hashes these files in parallel, leaving out any that cannot be read.
fn hashes_of<'a>(photos: &[&'a PhotoInfo]) -> HashMap<String, &'a PhotoInfo> {
    photos
        .par_iter()
        .filter_map(|photo| file_hash(&photo.path).ok().map(|hash| (hash, *photo)))
        .collect()
}

/// Matches what the customer selected against what was found on disk.
pub fn match_selection(found: &[PhotoInfo], wanted: &[WantedPhoto]) -> SelectionMatch {
    let mut by_name: HashMap<String, Vec<&PhotoInfo>> = HashMap::new();
    let mut by_stem: HashMap<String, Vec<&PhotoInfo>> = HashMap::new();
    for photo in found {
        by_name
            .entry(photo.file_name.to_lowercase())
            .or_default()
            .push(photo);
        by_stem
            .entry(stem(&photo.file_name))
            .or_default()
            .push(photo);
    }

    // Only the files sharing a selected name are read at first, since a folder can hold
    // thousands of originals and a selection only hundreds.
    let named: Vec<&PhotoInfo> = wanted
        .iter()
        .filter(|w| w.source_hash.is_some())
        .flat_map(|w| {
            by_name
                .get(&w.file_name.to_lowercase())
                .map_or(&[][..], Vec::as_slice)
        })
        .copied()
        .collect();
    let mut hashes = hashes_of(&named);

    // A renamed original has no name to go by, so everything else is read only if needed.
    let unnamed_hash = wanted.iter().any(|w| {
        w.source_hash
            .as_ref()
            .is_some_and(|h| !hashes.contains_key(h))
            && !by_name.contains_key(&w.file_name.to_lowercase())
    });
    if unnamed_hash {
        let read: HashSet<&str> = named.iter().map(|p| p.id.as_str()).collect();
        let rest: Vec<&PhotoInfo> = found
            .iter()
            .filter(|p| !read.contains(p.id.as_str()))
            .collect();
        hashes.extend(hashes_of(&rest));
    }

    let mut result = SelectionMatch::default();
    let mut used: HashSet<&str> = HashSet::new();
    for want in wanted {
        if let Some(photo) = want.source_hash.as_ref().and_then(|h| hashes.get(h)) {
            if used.insert(photo.id.as_str()) {
                result.photos.push((*photo).clone());
            }
            continue;
        }

        let by_exact = by_name.get(&want.file_name.to_lowercase());
        let candidates = by_exact.or_else(|| by_stem.get(&stem(&want.file_name)));
        match candidates.map(Vec::as_slice) {
            Some([photo]) => {
                if used.insert(photo.id.as_str()) {
                    result.photos.push((*photo).clone());
                }
                if want.source_hash.is_some() {
                    result.changed.push(want.file_name.clone());
                }
            }
            Some(many) if !many.is_empty() => result.ambiguous.push(AmbiguousPhoto {
                file_name: want.file_name.clone(),
                options: many.iter().map(|p| (*p).clone()).collect(),
            }),
            _ => result.missing.push(want.file_name.clone()),
        }
    }
    result
}

pub struct GalleryCopies {
    pub full: Vec<u8>,
    pub thumb: Vec<u8>,
    pub hash: String,
}

fn jpeg(image: &RgbImage, quality: u8) -> Result<Vec<u8>, MediaError> {
    let mut bytes = Vec::new();
    JpegEncoder::new_with_quality(&mut bytes, quality)
        .encode_image(image)
        .map_err(|e| MediaError::Read {
            path: "the gallery copy".to_string(),
            reason: e.to_string(),
        })?;
    Ok(bytes)
}

/// The two sizes a customer's gallery shows, the same as the studio admin uploads, and the
/// original's hash so the photo can be found again. The original is only ever read.
pub fn make_gallery_copies(photo: &PhotoInfo) -> Result<GalleryCopies, MediaError> {
    let hash = file_hash(&photo.path)?;
    let image = decode_upright(photo)?;
    let shrink = |edge: u32| {
        if image.width().max(image.height()) > edge {
            image.resize(edge, edge, FilterType::Triangle).to_rgb8()
        } else {
            image.to_rgb8()
        }
    };

    let full_image = shrink(FULL_MAX_EDGE);
    let mut full = Vec::new();
    for quality in FULL_QUALITIES {
        full = jpeg(&full_image, quality)?;
        if full.len() <= MAX_FULL_BYTES {
            break;
        }
    }
    let thumb = jpeg(&shrink(THUMB_MAX_EDGE), THUMB_QUALITY)?;
    Ok(GalleryCopies { full, thumb, hash })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scan_folder;
    use std::fs;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct TempDir(PathBuf);

    impl TempDir {
        fn new() -> Self {
            static NEXT: AtomicUsize = AtomicUsize::new(0);
            let id = NEXT.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!("album-sel-{}-{id}", std::process::id()));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    /// A photo whose content is decided by `shade`, so that two can share a name and differ.
    fn write(path: &Path, shade: u8, width: u32, height: u32) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        RgbImage::from_pixel(width, height, image::Rgb([shade, shade, 40]))
            .save(path)
            .unwrap();
    }

    fn wanted(name: &str, hash: Option<String>) -> WantedPhoto {
        WantedPhoto {
            file_name: name.to_string(),
            source_hash: hash,
        }
    }

    #[test]
    fn a_plain_name_finds_its_photo_whatever_the_case_or_subfolder() {
        let dir = TempDir::new();
        write(&dir.0.join("day two/IMG_1.JPG"), 10, 30, 20);
        write(&dir.0.join("IMG_2.jpg"), 20, 30, 20);
        let scan = scan_folder(&dir.0).unwrap();

        let m = match_selection(
            &scan.photos,
            &[wanted("img_1.jpg", None), wanted("IMG_2.JPG", None)],
        );
        let names: Vec<_> = m.photos.iter().map(|p| p.file_name.as_str()).collect();
        assert_eq!(names, ["IMG_1.JPG", "IMG_2.jpg"]);
        assert!(m.missing.is_empty() && m.ambiguous.is_empty() && m.changed.is_empty());
    }

    #[test]
    fn a_name_shared_by_two_cameras_is_settled_by_the_hash() {
        let dir = TempDir::new();
        let a = dir.0.join("camera a/IMG_0001.jpg");
        let b = dir.0.join("camera b/IMG_0001.jpg");
        write(&a, 10, 30, 20);
        write(&b, 200, 30, 20);
        let scan = scan_folder(&dir.0).unwrap();

        let m = match_selection(
            &scan.photos,
            &[wanted("IMG_0001.jpg", Some(file_hash(&b).unwrap()))],
        );
        assert_eq!(m.photos.len(), 1);
        assert_eq!(m.photos[0].path, b);
        assert!(m.ambiguous.is_empty());
    }

    #[test]
    fn a_shared_name_without_a_hash_is_asked_about_not_guessed() {
        let dir = TempDir::new();
        write(&dir.0.join("a/IMG_0001.jpg"), 10, 30, 20);
        write(&dir.0.join("b/IMG_0001.jpg"), 200, 30, 20);
        let scan = scan_folder(&dir.0).unwrap();

        let m = match_selection(&scan.photos, &[wanted("IMG_0001.jpg", None)]);
        assert!(m.photos.is_empty());
        assert_eq!(m.ambiguous.len(), 1);
        assert_eq!(m.ambiguous[0].options.len(), 2);
    }

    #[test]
    fn a_renamed_original_is_found_by_its_hash() {
        let dir = TempDir::new();
        let renamed = dir.0.join("Wedding 0042.jpg");
        write(&renamed, 90, 30, 20);
        write(&dir.0.join("other.jpg"), 10, 30, 20);
        let scan = scan_folder(&dir.0).unwrap();

        let m = match_selection(
            &scan.photos,
            &[wanted("IMG_7.jpg", Some(file_hash(&renamed).unwrap()))],
        );
        assert_eq!(m.photos.len(), 1);
        assert_eq!(m.photos[0].path, renamed);
    }

    #[test]
    fn an_edited_photo_is_kept_and_reported_as_changed() {
        let dir = TempDir::new();
        write(&dir.0.join("IMG_3.jpg"), 90, 30, 20);
        let scan = scan_folder(&dir.0).unwrap();

        let m = match_selection(
            &scan.photos,
            &[wanted("IMG_3.jpg", Some("not-its-hash".to_string()))],
        );
        assert_eq!(m.photos.len(), 1);
        assert_eq!(m.changed, ["IMG_3.jpg"]);
    }

    #[test]
    fn a_different_extension_still_finds_the_photo() {
        let dir = TempDir::new();
        write(&dir.0.join("IMG_4.png"), 90, 30, 20);
        let scan = scan_folder(&dir.0).unwrap();
        let m = match_selection(&scan.photos, &[wanted("IMG_4.CR3", None)]);
        assert_eq!(m.photos.len(), 1);
    }

    #[test]
    fn a_photo_that_is_not_there_is_reported_missing() {
        let dir = TempDir::new();
        write(&dir.0.join("IMG_5.jpg"), 90, 30, 20);
        let scan = scan_folder(&dir.0).unwrap();
        let m = match_selection(&scan.photos, &[wanted("IMG_6.jpg", None)]);
        assert!(m.photos.is_empty());
        assert_eq!(m.missing, ["IMG_6.jpg"]);
    }

    #[test]
    fn the_same_file_is_never_listed_twice() {
        let dir = TempDir::new();
        let only = dir.0.join("IMG_8.jpg");
        write(&only, 90, 30, 20);
        let scan = scan_folder(&dir.0).unwrap();
        let hash = file_hash(&only).unwrap();
        let m = match_selection(
            &scan.photos,
            &[
                wanted("IMG_8.jpg", Some(hash.clone())),
                wanted("copy.jpg", Some(hash)),
            ],
        );
        assert_eq!(m.photos.len(), 1);
    }

    #[test]
    fn gallery_copies_are_small_and_leave_the_original_alone() {
        let dir = TempDir::new();
        let path = dir.0.join("big.jpg");
        write(&path, 90, 3000, 2000);
        let before = fs::read(&path).unwrap();
        let scan = scan_folder(&dir.0).unwrap();

        let copies = make_gallery_copies(&scan.photos[0]).unwrap();
        let full = image::load_from_memory(&copies.full).unwrap();
        let thumb = image::load_from_memory(&copies.thumb).unwrap();
        assert_eq!((full.width(), full.height()), (1920, 1280));
        assert_eq!(thumb.width(), 400);
        assert_eq!(copies.hash, file_hash(&path).unwrap());
        assert_eq!(fs::read(&path).unwrap(), before);
    }

    #[test]
    fn a_small_photo_is_not_enlarged_for_the_gallery() {
        let dir = TempDir::new();
        write(&dir.0.join("small.jpg"), 90, 300, 200);
        let scan = scan_folder(&dir.0).unwrap();
        let copies = make_gallery_copies(&scan.photos[0]).unwrap();
        assert_eq!(image::load_from_memory(&copies.full).unwrap().width(), 300);
    }
}
