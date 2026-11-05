//! Reads the facts Auto Build needs from a photo. Everything stays on this computer.
//!
//! Pictures are read from the grid preview rather than the original, which keeps this
//! quick on a large wedding and means a photo is only ever fully decoded once.

use std::fs::{self, File};
use std::io::BufReader;
use std::path::{Path, PathBuf};

use album_core::autobuild::PhotoFacts;
use image::imageops::FilterType;
use image::{DynamicImage, GrayImage, RgbImage};

use crate::{ensure_preview, preview_path, MediaError, PhotoInfo, PreviewTier};

/// Raised when the rules below change, so older saved results are worked out again.
const FACTS_VERSION: &str = "v1";

const SHARPNESS_TILES: u32 = 8;
/// A sharp subject on a soft background is a good photo, so only the sharpest parts of
/// the picture count, not the average.
const SHARPEST_TILES_USED: usize = 8;

/// How far apart a pixel's channels may be and still look grey.
const GREY_CHANNEL_SPREAD: u8 = 14;
/// A little colour noise, or a stray coloured pixel, does not make a photo colour.
const MAX_COLOURED_SHARE: f64 = 0.02;

const FINGERPRINT_WIDTH: u32 = 9;
const FINGERPRINT_HEIGHT: u32 = 8;

/// Days since 1970 for a calendar date, using the standard civil calendar calculation.
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = year.div_euclid(400);
    let year_of_era = year - era * 400;
    let shifted_month = (month + 9) % 12;
    let day_of_year = (153 * shifted_month + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

/// Reads EXIF's "YYYY:MM:DD HH:MM:SS". Cameras with an unset clock write zeros or spaces.
pub fn parse_exif_time(text: &str) -> Option<i64> {
    let bytes = text.trim().as_bytes();
    if bytes.len() < 19 {
        return None;
    }
    let number = |range: std::ops::Range<usize>| -> Option<i64> {
        std::str::from_utf8(bytes.get(range)?)
            .ok()?
            .trim()
            .parse()
            .ok()
    };
    let (year, month, day) = (number(0..4)?, number(5..7)?, number(8..10)?);
    let (hour, minute, second) = (number(11..13)?, number(14..16)?, number(17..19)?);
    if !(1990..=2200).contains(&year)
        || !(1..=12).contains(&month)
        || !(1..=31).contains(&day)
        || hour > 23
        || minute > 59
        || second > 60
    {
        return None;
    }
    Some(days_from_civil(year, month, day) * 86_400 + hour * 3600 + minute * 60 + second)
}

fn read_capture_details(path: &Path) -> (Option<i64>, Option<String>) {
    let Ok(file) = File::open(path) else {
        return (None, None);
    };
    let Ok(exif) = exif::Reader::new().read_from_container(&mut BufReader::new(file)) else {
        return (None, None);
    };
    let text = |tag: exif::Tag| -> Option<String> {
        let field = exif.get_field(tag, exif::In::PRIMARY)?;
        let exif::Value::Ascii(values) = &field.value else {
            return None;
        };
        let value = String::from_utf8_lossy(values.first()?).trim().to_string();
        (!value.is_empty()).then_some(value)
    };

    let taken_at = [
        exif::Tag::DateTimeOriginal,
        exif::Tag::DateTimeDigitized,
        exif::Tag::DateTime,
    ]
    .into_iter()
    .find_map(|tag| parse_exif_time(&text(tag)?));

    // Two bodies of the same model are different clocks, so the serial matters.
    let parts: Vec<String> = [
        exif::Tag::Make,
        exif::Tag::Model,
        exif::Tag::BodySerialNumber,
    ]
    .into_iter()
    .filter_map(text)
    .collect();
    let camera = (!parts.is_empty()).then(|| parts.join(" "));
    (taken_at, camera)
}

/// How crisp the sharpest parts of a picture are. Only comparable within an album.
pub fn sharpness(gray: &GrayImage) -> f64 {
    let (width, height) = gray.dimensions();
    if width < 3 || height < 3 {
        return 0.0;
    }
    let count = (SHARPNESS_TILES * SHARPNESS_TILES) as usize;
    let mut totals = vec![(0.0_f64, 0.0_f64, 0.0_f64); count];

    for y in 1..height - 1 {
        for x in 1..width - 1 {
            let at = |dx: i32, dy: i32| {
                f64::from(
                    gray.get_pixel((x as i32 + dx) as u32, (y as i32 + dy) as u32)
                        .0[0],
                )
            };
            let edge = at(-1, 0) + at(1, 0) + at(0, -1) + at(0, 1) - 4.0 * at(0, 0);
            let tile_x = x * SHARPNESS_TILES / width;
            let tile_y = y * SHARPNESS_TILES / height;
            let tile = &mut totals[(tile_y * SHARPNESS_TILES + tile_x) as usize];
            tile.0 += 1.0;
            tile.1 += edge;
            tile.2 += edge * edge;
        }
    }

    let mut variances: Vec<f64> = totals
        .iter()
        .filter(|(n, _, _)| *n > 0.0)
        .map(|(n, sum, squares)| squares / n - (sum / n) * (sum / n))
        .collect();
    variances.sort_by(|a, b| b.total_cmp(a));
    let used = &variances[..SHARPEST_TILES_USED.min(variances.len())];
    used.iter().sum::<f64>() / used.len().max(1) as f64
}

/// A 64-bit fingerprint of the picture's broad shapes: each bit says whether a patch is
/// brighter than its neighbour. It survives small shifts and brightness changes.
pub fn fingerprint(image: &DynamicImage) -> u64 {
    let small = image
        .resize_exact(FINGERPRINT_WIDTH, FINGERPRINT_HEIGHT, FilterType::Triangle)
        .into_luma8();
    let mut hash = 0u64;
    for y in 0..FINGERPRINT_HEIGHT {
        for x in 0..FINGERPRINT_WIDTH - 1 {
            hash <<= 1;
            if small.get_pixel(x, y).0[0] > small.get_pixel(x + 1, y).0[0] {
                hash |= 1;
            }
        }
    }
    hash
}

pub fn is_black_and_white(image: &RgbImage) -> bool {
    let coloured = image
        .pixels()
        .filter(|pixel| {
            let [r, g, b] = pixel.0;
            r.max(g).max(b) - r.min(g).min(b) > GREY_CHANNEL_SPREAD
        })
        .count();
    let total = (image.width() * image.height()).max(1);
    (coloured as f64 / f64::from(total)) <= MAX_COLOURED_SHARE
}

fn facts_path(cache_dir: &Path, id: &str) -> PathBuf {
    let preview = preview_path(cache_dir, id, PreviewTier::Grid);
    preview.with_file_name(format!("{id}_facts_{FACTS_VERSION}.json"))
}

/// Works out a photo's facts, or reuses them if this version of the photo was seen before.
pub fn analyze_photo(photo: &PhotoInfo, cache_dir: &Path) -> Result<PhotoFacts, MediaError> {
    let saved_at = facts_path(cache_dir, &photo.id);
    if let Some(saved) = fs::read(&saved_at)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<PhotoFacts>(&bytes).ok())
    {
        return Ok(saved);
    }

    let (taken_at, camera) = read_capture_details(&photo.path);
    let preview = ensure_preview(photo, cache_dir, PreviewTier::Grid)?;
    let image = image::open(&preview).map_err(|e| MediaError::Read {
        path: preview.display().to_string(),
        reason: e.to_string(),
    })?;

    let facts = PhotoFacts {
        id: photo.id.clone(),
        taken_at,
        camera,
        sharpness: Some(sharpness(&image.to_luma8())),
        hash: Some(fingerprint(&image)),
        mono: is_black_and_white(&image.to_rgb8()),
    };

    // Only a time saver, so failing to keep the result must not fail the analysis.
    if let Ok(bytes) = serde_json::to_vec(&facts) {
        let _ = fs::write(&saved_at, bytes);
    }
    Ok(facts)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scan_folder;
    use image::imageops;
    use image::Rgb;
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct TempDir(PathBuf);

    impl TempDir {
        fn new() -> Self {
            static NEXT: AtomicUsize = AtomicUsize::new(0);
            let id = NEXT.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir()
                .join(format!("album-analyze-test-{}-{id}", std::process::id()));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    /// A detailed picture, different for each seed, with no randomness between runs.
    fn textured(seed: u32, width: u32, height: u32) -> RgbImage {
        RgbImage::from_fn(width, height, |x, y| {
            let wave = ((x * (seed + 3) / 7) ^ (y * (seed + 5) / 11)) % 2;
            let block = ((x / (9 + seed % 13)) + (y / (7 + seed % 11)) * (seed + 1)) % 5;
            let level = (40 * block + 60 * wave) as u8;
            Rgb([level, level.saturating_add(20), level / 2 + 30])
        })
    }

    fn gray_of(image: &RgbImage) -> GrayImage {
        DynamicImage::ImageRgb8(image.clone()).to_luma8()
    }

    /// A JPEG carrying the capture details a camera writes.
    fn jpeg_with_exif(path: &Path, image: &RgbImage, make: &str, model: &str, time: &str) {
        let mut jpeg = Vec::new();
        DynamicImage::ImageRgb8(image.clone())
            .write_to(
                &mut std::io::Cursor::new(&mut jpeg),
                image::ImageFormat::Jpeg,
            )
            .unwrap();

        let (make, model) = (format!("{make}\0"), format!("{model}\0"));
        let time = format!("{time}\0");
        let data_start = 8 + 42 + 18;
        let date_at = data_start as u32;
        let make_at = date_at + time.len() as u32;
        let model_at = make_at + make.len() as u32;

        let mut tiff: Vec<u8> = vec![b'I', b'I', 42, 0, 8, 0, 0, 0];
        let entry = |t: &mut Vec<u8>, tag: u16, kind: u16, count: u32, value: u32| {
            t.extend_from_slice(&tag.to_le_bytes());
            t.extend_from_slice(&kind.to_le_bytes());
            t.extend_from_slice(&count.to_le_bytes());
            t.extend_from_slice(&value.to_le_bytes());
        };
        tiff.extend_from_slice(&3u16.to_le_bytes());
        entry(&mut tiff, 0x010F, 2, make.len() as u32, make_at);
        entry(&mut tiff, 0x0110, 2, model.len() as u32, model_at);
        entry(&mut tiff, 0x8769, 4, 1, 50);
        tiff.extend_from_slice(&0u32.to_le_bytes());
        tiff.extend_from_slice(&1u16.to_le_bytes());
        entry(&mut tiff, 0x9003, 2, time.len() as u32, date_at);
        tiff.extend_from_slice(&0u32.to_le_bytes());
        tiff.extend_from_slice(time.as_bytes());
        tiff.extend_from_slice(make.as_bytes());
        tiff.extend_from_slice(model.as_bytes());

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
    fn exif_times_become_seconds_in_the_right_order() {
        let noon = parse_exif_time("2026:11:05 12:00:00").unwrap();
        assert_eq!(parse_exif_time("2026:11:05 12:00:30").unwrap() - noon, 30);
        assert_eq!(parse_exif_time("2026:11:05 13:00:00").unwrap() - noon, 3600);
        assert_eq!(
            parse_exif_time("2026:11:06 12:00:00").unwrap() - noon,
            86_400
        );
        // Across a year end and a leap day, where date arithmetic usually goes wrong.
        let new_year = parse_exif_time("2027:01:01 00:00:00").unwrap();
        assert_eq!(
            new_year - parse_exif_time("2026:12:31 00:00:00").unwrap(),
            86_400
        );
        let march = parse_exif_time("2028:03:01 00:00:00").unwrap();
        assert_eq!(
            march - parse_exif_time("2028:02:28 00:00:00").unwrap(),
            2 * 86_400
        );
        assert_eq!(
            parse_exif_time("1970:01:01 00:00:00"),
            None,
            "before digital cameras"
        );
        assert_eq!(parse_exif_time("2000:01:01 00:00:00"), Some(946_684_800));
    }

    #[test]
    fn unset_or_broken_camera_clocks_count_as_no_time() {
        for bad in [
            "0000:00:00 00:00:00",
            "    :  :     :  :  ",
            "",
            "yesterday",
            "2026:13:01 10:00:00",
            "2026:01:01 25:00:00",
        ] {
            assert_eq!(parse_exif_time(bad), None, "{bad:?}");
        }
    }

    #[test]
    fn capture_time_and_camera_are_read_from_a_real_file() {
        let dir = TempDir::new();
        let cache = TempDir::new();
        jpeg_with_exif(
            &dir.0.join("a.jpg"),
            &textured(1, 200, 150),
            "Canon",
            "EOS R6",
            "2026:11:05 14:30:15",
        );
        let photo = scan_folder(&dir.0).unwrap().photos.remove(0);
        let facts = analyze_photo(&photo, &cache.0).unwrap();
        assert_eq!(facts.taken_at, parse_exif_time("2026:11:05 14:30:15"));
        assert_eq!(facts.camera.as_deref(), Some("Canon EOS R6"));
        assert!(facts.sharpness.is_some() && facts.hash.is_some());
    }

    #[test]
    fn a_photo_with_no_exif_still_gets_the_rest() {
        let dir = TempDir::new();
        let cache = TempDir::new();
        textured(2, 200, 150).save(dir.0.join("a.png")).unwrap();
        let photo = scan_folder(&dir.0).unwrap().photos.remove(0);
        let facts = analyze_photo(&photo, &cache.0).unwrap();
        assert_eq!(facts.taken_at, None);
        assert_eq!(facts.camera, None);
        assert!(facts.sharpness.is_some());
    }

    #[test]
    fn results_are_reused_while_the_photo_is_unchanged() {
        let dir = TempDir::new();
        let cache = TempDir::new();
        textured(3, 200, 150).save(dir.0.join("a.png")).unwrap();
        let photo = scan_folder(&dir.0).unwrap().photos.remove(0);
        let first = analyze_photo(&photo, &cache.0).unwrap();

        // With the file gone, a reused answer is the only way this can succeed.
        fs::remove_file(&photo.path).unwrap();
        assert_eq!(analyze_photo(&photo, &cache.0).unwrap(), first);
    }

    #[test]
    fn a_blurred_photo_scores_far_below_its_sharp_version() {
        let sharp = textured(4, 512, 340);
        let soft = imageops::blur(&sharp, 3.0);
        let (a, b) = (sharpness(&gray_of(&sharp)), sharpness(&gray_of(&soft)));
        assert!(b < a * 0.25, "sharp {a}, soft {b}");
    }

    #[test]
    fn a_sharp_subject_on_a_soft_background_counts_as_sharp() {
        let sharp = textured(5, 512, 340);
        let soft = imageops::blur(&sharp, 6.0);
        let mut portrait = soft.clone();
        imageops::replace(
            &mut portrait,
            &imageops::crop_imm(&sharp, 180, 90, 150, 160).to_image(),
            180,
            90,
        );

        let whole_blur = sharpness(&gray_of(&soft));
        let subject = sharpness(&gray_of(&portrait));
        assert!(
            subject > whole_blur * 4.0,
            "subject {subject}, blur {whole_blur}"
        );
    }

    /// A picture whose broad shapes differ with the seed, as different photos' do.
    fn scene(seed: u32, width: u32, height: u32) -> RgbImage {
        let patch = |column: u32, row: u32| {
            let mixed = (column.wrapping_mul(73_856_093)
                ^ row.wrapping_mul(19_349_663)
                ^ seed.wrapping_mul(83_492_791))
            .wrapping_mul(2_654_435_761);
            (mixed >> 24) as u8
        };
        RgbImage::from_fn(width, height, |x, y| {
            let level = patch(x * 12 / width, y * 8 / height);
            Rgb([level, level / 2 + 40, 255 - level])
        })
    }

    #[test]
    fn near_identical_shots_have_close_fingerprints_and_others_do_not() {
        let base = scene(6, 512, 340);
        let brighter = RgbImage::from_fn(512, 340, |x, y| {
            let [r, g, b] = base.get_pixel(x, y).0;
            Rgb([
                r.saturating_add(12),
                g.saturating_add(12),
                b.saturating_add(12),
            ])
        });
        let shifted = imageops::crop_imm(&base, 4, 3, 508, 337).to_image();
        let print = |image: &RgbImage| fingerprint(&DynamicImage::ImageRgb8(image.clone()));

        assert!((print(&base) ^ print(&brighter)).count_ones() <= 6);
        assert!((print(&base) ^ print(&shifted)).count_ones() <= 6);
        let others: Vec<u32> = (7..47)
            .map(|seed| (print(&base) ^ print(&scene(seed, 512, 340))).count_ones())
            .collect();
        let closest = others.iter().min().copied().unwrap_or(0);
        assert!(
            closest > 12,
            "well clear of the match limit, closest was {closest}: {others:?}"
        );
    }

    #[test]
    fn black_and_white_is_recognised() {
        let colour = textured(8, 200, 150);
        assert!(!is_black_and_white(&colour));

        let mono = DynamicImage::ImageRgb8(colour.clone())
            .grayscale()
            .to_rgb8();
        assert!(is_black_and_white(&mono));

        // A small coloured logo on a black and white photo does not make it colour.
        let mut logo = mono.clone();
        for x in 0..10 {
            for y in 0..10 {
                logo.put_pixel(x, y, Rgb([255, 0, 0]));
            }
        }
        assert!(is_black_and_white(&logo));
    }

    #[test]
    fn a_missing_original_with_no_preview_is_an_error() {
        let dir = TempDir::new();
        let cache = TempDir::new();
        textured(9, 100, 80).save(dir.0.join("a.png")).unwrap();
        let photo = scan_folder(&dir.0).unwrap().photos.remove(0);
        fs::remove_file(&photo.path).unwrap();
        assert!(analyze_photo(&photo, &cache.0).is_err());
    }
}
