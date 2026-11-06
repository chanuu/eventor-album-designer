//! Turns a design into print files, using the original photos.
//!
//! This is the only place originals are decoded at full size. Spreads are rendered one
//! at a time and released, so a long album exports in roughly constant memory.

use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::io::BufWriter;
use std::path::{Path, PathBuf};

use album_core::document::{
    dpi_status, effective_dpi, visible_area, Background, DpiStatus, Frame, ProjectSpec,
    SpreadDesign,
};
use album_media::{colour_profile_is_srgb, decode_upright, PhotoInfo};
use album_store::Project;
use album_text::render_block;
use fast_image_resize as fr;
use image::codecs::jpeg::{JpegEncoder, PixelDensity};
use image::{imageops, Rgb, RgbImage, RgbaImage};
use pdf_writer::{Content, Filter, Name, Pdf, Rect, Ref};
use serde::{Deserialize, Serialize};
use thiserror::Error;

const MM_PER_INCH: f64 = 25.4;
const POINTS_PER_INCH: f64 = 72.0;
const JPEG_QUALITY: u8 = 95;
const FALLBACK_PAPER: [u8; 3] = [255, 255, 255];
/// Line breaks do not depend on resolution, so a quick low one is enough for checking.
const TEXT_CHECK_DPI: f64 = 30.0;

#[derive(Debug, Error)]
pub enum ExportError {
    #[error("{0}")]
    Render(String),
    #[error("could not write {path}: {reason}")]
    Write { path: String, reason: String },
    #[error("{0} original photo(s) cannot be found. Find them before exporting.")]
    MissingOriginals(usize),
}

fn write_error(path: &Path, reason: impl std::fmt::Display) -> ExportError {
    ExportError::Write {
        path: path.display().to_string(),
        reason: reason.to_string(),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    /// Export cannot go ahead.
    Blocker,
    /// Export can go ahead, but the result may disappoint.
    Warning,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Issue {
    pub severity: Severity,
    /// One-based, as the photographer sees it. None when it concerns the whole album.
    pub spread: Option<usize>,
    pub message: String,
}

fn photos_by_id(project: &Project) -> HashMap<&str, &PhotoInfo> {
    project.photos.iter().map(|p| (p.id.as_str(), p)).collect()
}

/// Everything worth knowing before a long export, and before paying for a print.
pub fn check_album(project: &Project) -> Vec<Issue> {
    let photos = photos_by_id(project);
    let mut issues = Vec::new();
    let mut seen: HashSet<&str> = HashSet::new();
    let mut profiles_checked: HashSet<&str> = HashSet::new();

    if project.spreads.is_empty() {
        issues.push(Issue {
            severity: Severity::Blocker,
            spread: None,
            message: "The album has no spreads yet.".to_string(),
        });
    }

    for (i, spread) in project.spreads.iter().enumerate() {
        let number = Some(i + 1);
        for block in &spread.design.texts {
            if let Ok(drawn) = render_block(block, TEXT_CHECK_DPI) {
                if drawn.overflowed {
                    issues.push(Issue {
                        severity: Severity::Warning,
                        spread: number,
                        message: "Some text does not fit in its box and will be cut off."
                            .to_string(),
                    });
                }
            }
        }
        let mut push = |severity, message| {
            issues.push(Issue {
                severity,
                spread: number,
                message,
            });
        };

        for frame in &spread.design.frames {
            let Some(id) = frame.asset_id.as_deref() else {
                push(Severity::Warning, "This spread has an empty frame.".into());
                continue;
            };
            let Some(photo) = photos.get(id) else {
                push(
                    Severity::Blocker,
                    "A photo in this spread is unknown.".into(),
                );
                continue;
            };

            if !seen.insert(id) {
                push(
                    Severity::Warning,
                    format!("{} is used more than once in the album.", photo.file_name),
                );
            }
            if !photo.path.is_file() {
                push(
                    Severity::Blocker,
                    format!("The original of {} cannot be found.", photo.file_name),
                );
                continue;
            }
            let dpi = effective_dpi(photo.width, photo.height, frame).round();
            match dpi_status(dpi) {
                DpiStatus::Good => {}
                DpiStatus::Low => push(
                    Severity::Warning,
                    format!("{} prints at {dpi} DPI and may look soft.", photo.file_name),
                ),
                DpiStatus::TooLow => push(
                    Severity::Warning,
                    format!(
                        "{} prints at only {dpi} DPI and will look blurry.",
                        photo.file_name
                    ),
                ),
            }
            if profiles_checked.insert(id) && !colour_profile_is_srgb(&photo.path) {
                push(
                    Severity::Warning,
                    format!(
                        "{} is not in sRGB, so its colours may shift. Convert it first.",
                        photo.file_name
                    ),
                );
            }
        }
    }
    issues
}

fn parse_colour(value: &str) -> [u8; 3] {
    let hex = value.trim().trim_start_matches('#');
    let channel = |at: usize| {
        hex.get(at..at + 2)
            .and_then(|pair| u8::from_str_radix(pair, 16).ok())
    };
    match (hex.len(), channel(0), channel(2), channel(4)) {
        (6, Some(r), Some(g), Some(b)) => [r, g, b],
        _ => FALLBACK_PAPER,
    }
}

/// The size in pixels of a printed spread at the album's DPI.
pub fn canvas_pixels(design: &SpreadDesign, spec: &ProjectSpec) -> (u32, u32) {
    let px = |mm: f64| ((mm / MM_PER_INCH) * spec.target_dpi).round().max(1.0) as u32;
    (px(design.size_mm.w), px(design.size_mm.h))
}

/// Crops a photo with sub-pixel accuracy and scales it to exactly fill a frame.
fn crop_and_resize(
    source: RgbImage,
    (left, top, width, height): (f64, f64, f64, f64),
    target: (u32, u32),
) -> Result<RgbImage, ExportError> {
    let render_error = |e: &dyn std::fmt::Display| ExportError::Render(e.to_string());
    let (source_w, source_h) = source.dimensions();
    let src =
        fr::images::Image::from_vec_u8(source_w, source_h, source.into_raw(), fr::PixelType::U8x3)
            .map_err(|e| render_error(&e))?;
    let mut dst = fr::images::Image::new(target.0, target.1, fr::PixelType::U8x3);

    let options = fr::ResizeOptions::new()
        .resize_alg(fr::ResizeAlg::Convolution(fr::FilterType::Lanczos3))
        .crop(left, top, width, height);
    fr::Resizer::new()
        .resize(&src, &mut dst, &options)
        .map_err(|e| render_error(&e))?;

    RgbImage::from_raw(target.0, target.1, dst.into_vec())
        .ok_or_else(|| ExportError::Render("the resized photo has the wrong size".to_string()))
}

/// Draws one spread at full print resolution, from the original files.
pub fn render_spread(
    design: &SpreadDesign,
    spec: &ProjectSpec,
    photos: &HashMap<&str, &PhotoInfo>,
) -> Result<RgbImage, ExportError> {
    let (width, height) = canvas_pixels(design, spec);
    let Background::Color { value } = &design.background;
    let mut canvas = RgbImage::from_pixel(width, height, Rgb(parse_colour(value)));

    let scale_x = f64::from(width) / design.size_mm.w;
    let scale_y = f64::from(height) / design.size_mm.h;

    let mut frames: Vec<_> = design.frames.iter().collect();
    frames.sort_by_key(|f| f.z);

    for frame in frames {
        let Some(photo) = frame.asset_id.as_deref().and_then(|id| photos.get(id)) else {
            continue;
        };
        let r = frame.rect_mm;
        // Rounding the edges, not the sizes, keeps neighbouring frames exactly aligned.
        let left = (r.x * scale_x).round() as i64;
        let right = ((r.x + r.w) * scale_x).round() as i64;
        let top = (r.y * scale_y).round() as i64;
        let bottom = ((r.y + r.h) * scale_y).round() as i64;
        let (pixel_w, pixel_h) = (right - left, bottom - top);
        if pixel_w <= 0 || pixel_h <= 0 {
            continue;
        }

        let original = decode_upright(photo)
            .map_err(|e| ExportError::Render(e.to_string()))?
            .into_rgb8();
        let (photo_w, photo_h) = original.dimensions();
        let area = visible_area(
            f64::from(photo_w) / f64::from(photo_h),
            r.w / r.h,
            &frame.fit,
        );
        let crop = (
            area.sx * f64::from(photo_w),
            area.sy * f64::from(photo_h),
            area.sw * f64::from(photo_w),
            area.sh * f64::from(photo_h),
        );
        let mut tile = crop_and_resize(original, crop, (pixel_w as u32, pixel_h as u32))?;
        frame.adjust.apply_rgb(&mut tile);
        composite_frame(&mut canvas, &tile, left, top, frame, scale_x);
    }

    // Text sits above every photo, whatever order the frames are in.
    for block in &design.texts {
        let drawn = render_block(block, spec.target_dpi).map_err(ExportError::Render)?;
        let left = (block.rect_mm.x * scale_x).round() as i64;
        let top = (block.rect_mm.y * scale_y).round() as i64;
        lay_over(&mut canvas, &drawn.image, left, top, block.opacity);
    }
    Ok(canvas)
}

/// Draws a frame with its rounded corners, border and opacity.
///
/// `px_per_mm` turns the frame's millimetres into pixels. A plain frame takes a fast path,
/// because almost every frame in an album is one.
fn composite_frame(
    canvas: &mut RgbImage,
    tile: &RgbImage,
    left: i64,
    top: i64,
    frame: &Frame,
    px_per_mm: f64,
) {
    let style = &frame.style;
    let opacity = style.opacity.clamp(0.0, 1.0);
    let border = (style.border_mm * px_per_mm).max(0.0);
    let (tile_w, tile_h) = (f64::from(tile.width()), f64::from(tile.height()));
    let radius = (frame.corner_radius_mm * px_per_mm).clamp(0.0, tile_w.min(tile_h) / 2.0);
    if opacity >= 1.0 && border <= 0.0 && radius <= 0.0 {
        imageops::replace(canvas, tile, left, top);
        return;
    }

    let border_colour = parse_colour(&style.border_colour);
    let (canvas_w, canvas_h) = (i64::from(canvas.width()), i64::from(canvas.height()));
    for (x, y, pixel) in tile.enumerate_pixels() {
        let (cx, cy) = (left + i64::from(x), top + i64::from(y));
        if cx < 0 || cy < 0 || cx >= canvas_w || cy >= canvas_h {
            continue;
        }
        // How far this pixel is inside the rounded shape, for smooth edges.
        let qx = (f64::from(x) + 0.5 - tile_w / 2.0).abs() - (tile_w / 2.0 - radius);
        let qy = (f64::from(y) + 0.5 - tile_h / 2.0).abs() - (tile_h / 2.0 - radius);
        let outside = qx.max(0.0).hypot(qy.max(0.0)) + qx.max(qy).min(0.0) - radius;
        let inside = -outside;
        let coverage = (inside + 0.5).clamp(0.0, 1.0);
        if coverage <= 0.0 {
            continue;
        }
        let on_border = if border > 0.0 {
            (border - inside + 0.5).clamp(0.0, 1.0)
        } else {
            0.0
        };
        let alpha = coverage * opacity;
        let under = canvas.get_pixel_mut(cx as u32, cy as u32);
        for (channel, border_level) in border_colour.iter().enumerate() {
            let photo = f64::from(pixel.0[channel]);
            let drawn = photo + (f64::from(*border_level) - photo) * on_border;
            let base = f64::from(under.0[channel]);
            under.0[channel] = (base + (drawn - base) * alpha).round() as u8;
        }
    }
}

/// Blends a transparent image onto the canvas, clipping whatever falls outside it.
fn lay_over(canvas: &mut RgbImage, layer: &RgbaImage, left: i64, top: i64, opacity: f64) {
    let (width, height) = canvas.dimensions();
    let opacity = opacity.clamp(0.0, 1.0);
    for (x, y, pixel) in layer.enumerate_pixels() {
        let [r, g, b, a] = pixel.0;
        let a = (f64::from(a) * opacity).round() as u8;
        if a == 0 {
            continue;
        }
        let (cx, cy) = (left + i64::from(x), top + i64::from(y));
        if cx < 0 || cy < 0 || cx >= i64::from(width) || cy >= i64::from(height) {
            continue;
        }
        let under = canvas.get_pixel_mut(cx as u32, cy as u32);
        let mix = |over: u8, base: u8| {
            let (over, base, a) = (u32::from(over), u32::from(base), u32::from(a));
            ((over * a + base * (255 - a) + 127) / 255) as u8
        };
        *under = Rgb([mix(r, under.0[0]), mix(g, under.0[1]), mix(b, under.0[2])]);
    }
}

fn write_jpeg(image: &RgbImage, path: &Path, dpi: f64) -> Result<(), ExportError> {
    let file = File::create(path).map_err(|e| write_error(path, e))?;
    let mut encoder = JpegEncoder::new_with_quality(BufWriter::new(file), JPEG_QUALITY);
    // Labs read this to know the print size, without having to ask.
    encoder.set_pixel_density(PixelDensity::dpi(dpi.round() as u16));
    image
        .write_with_encoder(encoder)
        .map_err(|e| write_error(path, e))
}

struct PdfPage {
    jpeg: PathBuf,
    pixels: (u32, u32),
}

/// Builds a PDF that embeds the JPEGs byte for byte, so there is no second compression.
fn write_pdf(pages: &[PdfPage], spec: &ProjectSpec, path: &Path) -> Result<(), ExportError> {
    let points = |mm: f64| (mm / MM_PER_INCH * POINTS_PER_INCH) as f32;
    let canvas = spec.canvas_mm();
    let (page_w, page_h) = (points(canvas.w), points(canvas.h));
    let bleed = points(spec.bleed_mm);
    let full = Rect::new(0.0, 0.0, page_w, page_h);
    let trim = Rect::new(bleed, bleed, page_w - bleed, page_h - bleed);

    let catalog_id = Ref::new(1);
    let tree_id = Ref::new(2);
    let id_for = |page: usize, part: i32| Ref::new(3 + page as i32 * 3 + part);
    let kids: Vec<Ref> = (0..pages.len()).map(|i| id_for(i, 0)).collect();

    let mut pdf = Pdf::new();
    pdf.catalog(catalog_id).pages(tree_id);
    pdf.pages(tree_id)
        .kids(kids)
        .count(i32::try_from(pages.len()).unwrap_or(i32::MAX));

    let image_name = Name(b"Spread");
    for (i, page) in pages.iter().enumerate() {
        let (page_id, image_id, content_id) = (id_for(i, 0), id_for(i, 1), id_for(i, 2));

        {
            let mut entry = pdf.page(page_id);
            entry
                .media_box(full)
                .bleed_box(full)
                .trim_box(trim)
                .parent(tree_id)
                .contents(content_id);
            entry.resources().x_objects().pair(image_name, image_id);
        }

        let bytes = fs::read(&page.jpeg).map_err(|e| write_error(&page.jpeg, e))?;
        {
            let mut image = pdf.image_xobject(image_id, &bytes);
            image.filter(Filter::DctDecode);
            image.width(i32::try_from(page.pixels.0).unwrap_or(i32::MAX));
            image.height(i32::try_from(page.pixels.1).unwrap_or(i32::MAX));
            image.color_space().device_rgb();
            image.bits_per_component(8);
        }

        let mut content = Content::new();
        content.save_state();
        content.transform([page_w, 0.0, 0.0, page_h, 0.0, 0.0]);
        content.x_object(image_name);
        content.restore_state();
        pdf.stream(content_id, &content.finish());
    }

    fs::write(path, pdf.finish()).map_err(|e| write_error(path, e))
}

/// Removes characters Windows forbids, and anything that could escape the folder.
fn safe_file_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '-',
            c if c.is_control() => '-',
            c => c,
        })
        .collect();
    let trimmed = cleaned.trim().trim_matches('.').trim();
    if trimmed.is_empty() {
        "album".to_string()
    } else {
        trimmed.to_string()
    }
}

/// A new folder for this export, so earlier exports are never overwritten.
fn new_export_folder(parent: &Path, name: &str) -> Result<PathBuf, ExportError> {
    let base = format!("{} export", safe_file_name(name));
    for attempt in 1..=999 {
        let folder = if attempt == 1 {
            parent.join(&base)
        } else {
            parent.join(format!("{base} {attempt}"))
        };
        match fs::create_dir(&folder) {
            Ok(()) => return Ok(folder),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(e) => return Err(write_error(&folder, e)),
        }
    }
    Err(write_error(parent, "too many exports with this name"))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
pub struct ExportFormats {
    pub jpeg: bool,
    pub pdf: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ManifestFile {
    pub file: String,
    pub blake3: String,
}

/// Recorded next to the files, because labs lose files and people forget settings.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Manifest {
    pub album: String,
    pub app_version: String,
    pub trim_mm: (f64, f64),
    pub bleed_mm: f64,
    pub dpi: f64,
    pub spreads: usize,
    pub files: Vec<ManifestFile>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ExportResult {
    pub folder: PathBuf,
    pub files: Vec<String>,
}

fn hash_file(path: &Path) -> Result<String, ExportError> {
    let bytes = fs::read(path).map_err(|e| write_error(path, e))?;
    Ok(blake3::hash(&bytes).to_hex().to_string())
}

/// Writes the album's print files. `on_progress` gets (spreads done, total).
pub fn export_album(
    project: &Project,
    parent: &Path,
    formats: ExportFormats,
    app_version: &str,
    mut on_progress: impl FnMut(usize, usize),
) -> Result<ExportResult, ExportError> {
    if !formats.jpeg && !formats.pdf {
        return Err(ExportError::Render("Choose JPG, PDF or both.".to_string()));
    }

    // Found now, rather than failing at spread 38 of a long export.
    let blockers = check_album(project)
        .into_iter()
        .filter(|i| i.severity == Severity::Blocker)
        .count();
    if blockers > 0 {
        return Err(ExportError::MissingOriginals(blockers));
    }

    let photos = photos_by_id(project);
    let safe_name = safe_file_name(&project.name);
    let folder = new_export_folder(parent, &project.name)?;
    let total = project.spreads.len();

    let mut pages = Vec::with_capacity(total);
    for (i, spread) in project.spreads.iter().enumerate() {
        let image = render_spread(&spread.design, &project.spec, &photos)?;
        let jpeg = folder.join(format!("{safe_name}_spread_{:02}.jpg", i + 1));
        write_jpeg(&image, &jpeg, project.spec.target_dpi)?;
        pages.push(PdfPage {
            jpeg,
            pixels: image.dimensions(),
        });
        on_progress(i + 1, total);
    }

    let mut written: Vec<PathBuf> = Vec::new();
    if formats.pdf {
        let pdf = folder.join(format!("{safe_name}.pdf"));
        write_pdf(&pages, &project.spec, &pdf)?;
        written.push(pdf);
    }
    for page in pages {
        if formats.jpeg {
            written.push(page.jpeg);
        } else {
            // Only needed to build the PDF.
            fs::remove_file(&page.jpeg).map_err(|e| write_error(&page.jpeg, e))?;
        }
    }

    let name_of = |path: &Path| {
        path.file_name()
            .map_or_else(String::new, |n| n.to_string_lossy().into_owned())
    };
    let mut files = Vec::with_capacity(written.len());
    for path in &written {
        files.push(ManifestFile {
            file: name_of(path),
            blake3: hash_file(path)?,
        });
    }
    let manifest = Manifest {
        album: project.name.clone(),
        app_version: app_version.to_string(),
        trim_mm: (project.spec.trim_w_mm * 2.0, project.spec.trim_h_mm),
        bleed_mm: project.spec.bleed_mm,
        dpi: project.spec.target_dpi,
        spreads: total,
        files: files.clone(),
    };
    let manifest_path = folder.join("manifest.json");
    let json = serde_json::to_vec_pretty(&manifest).map_err(|e| write_error(&manifest_path, e))?;
    fs::write(&manifest_path, json).map_err(|e| write_error(&manifest_path, e))?;

    Ok(ExportResult {
        folder,
        files: files.into_iter().map(|f| f.file).collect(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use album_core::document::{Fit, Frame, RectMm, SizeMm};
    use album_store::{SavedSpread, PROJECT_VERSION};
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct TempDir(PathBuf);

    impl TempDir {
        fn new() -> Self {
            static NEXT: AtomicUsize = AtomicUsize::new(0);
            let id = NEXT.fetch_add(1, Ordering::Relaxed);
            let path =
                std::env::temp_dir().join(format!("album-export-test-{}-{id}", std::process::id()));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    const RED: [u8; 3] = [230, 20, 20];
    const BLUE: [u8; 3] = [20, 20, 230];

    /// Left half red, right half blue, saved without loss so colours can be checked.
    fn split_photo(dir: &Path, name: &str, width: u32, height: u32) -> PhotoInfo {
        let path = dir.join(name);
        RgbImage::from_fn(width, height, |x, _| {
            Rgb(if x < width / 2 { RED } else { BLUE })
        })
        .save(&path)
        .unwrap();
        PhotoInfo {
            id: name.to_string(),
            path,
            file_name: name.to_string(),
            width,
            height,
            orientation: 1,
        }
    }

    fn close_to(pixel: &Rgb<u8>, expected: [u8; 3]) -> bool {
        pixel
            .0
            .iter()
            .zip(expected)
            .all(|(a, b)| a.abs_diff(b) < 12)
    }

    fn spec() -> ProjectSpec {
        ProjectSpec {
            target_dpi: 100.0,
            ..ProjectSpec::from_open_inches(10.0, 5.0)
        }
    }

    fn design(frames: Vec<Frame>, paper: &str) -> SpreadDesign {
        SpreadDesign {
            v: 1,
            template_id: None,
            texts: Vec::new(),
            size_mm: spec().canvas_mm(),
            background: Background::Color {
                value: paper.to_string(),
            },
            frames,
        }
    }

    fn frame(rect_mm: RectMm, id: &str, fit: Fit) -> Frame {
        Frame {
            id: format!("frame-{id}"),
            rect_mm,
            corner_radius_mm: 0.0,
            adjust: Default::default(),
            style: Default::default(),
            asset_id: Some(id.to_string()),
            fit,
            z: 0,
        }
    }

    fn whole_canvas() -> RectMm {
        let c = spec().canvas_mm();
        RectMm {
            x: 0.0,
            y: 0.0,
            w: c.w,
            h: c.h,
        }
    }

    fn project(photos: Vec<PhotoInfo>, frames: Vec<Frame>) -> Project {
        Project {
            version: PROJECT_VERSION,
            name: "Test / Album?".to_string(),
            size_label: "5×10 in".to_string(),
            ratings: Default::default(),
            spec: spec(),
            photos,
            spreads: vec![SavedSpread {
                id: "s1".to_string(),
                photo_ids: Vec::new(),
                option_index: 0,
                design: design(frames, "#FFFFFF"),
            }],
        }
    }

    #[test]
    fn the_canvas_has_the_exact_print_size_including_bleed() {
        let d = design(Vec::new(), "#FFFFFF");
        // 10 x 5 in plus 3 mm bleed on each side, at 100 DPI.
        let expected_w = ((254.0_f64 + 6.0) / 25.4 * 100.0).round() as u32;
        let expected_h = ((127.0_f64 + 6.0) / 25.4 * 100.0).round() as u32;
        assert_eq!(canvas_pixels(&d, &spec()), (expected_w, expected_h));
    }

    #[test]
    fn a_photo_fills_its_frame_and_paper_shows_elsewhere() {
        let dir = TempDir::new();
        let photo = split_photo(&dir.0, "a.png", 800, 400);
        let photos = HashMap::from([("a.png", &photo)]);
        let c = spec().canvas_mm();
        // A frame on the left half of the canvas only.
        let rect = RectMm {
            x: 0.0,
            y: 0.0,
            w: c.w / 2.0,
            h: c.h,
        };
        let d = design(vec![frame(rect, "a.png", Fit::default())], "#102030");
        let image = render_spread(&d, &spec(), &photos).unwrap();
        let (w, h) = image.dimensions();

        assert!(
            close_to(image.get_pixel(0, 0), RED),
            "the frame reaches the corner"
        );
        assert!(
            close_to(image.get_pixel(w / 2 - 2, h - 1), BLUE),
            "and the far edge of the frame"
        );
        assert_eq!(
            image.get_pixel(w / 2 + 2, h / 2).0,
            [0x10, 0x20, 0x30],
            "paper"
        );
        assert_eq!(image.get_pixel(w - 1, h - 1).0, [0x10, 0x20, 0x30], "paper");
    }

    #[test]
    fn the_crop_matches_the_design() {
        let dir = TempDir::new();
        let photo = split_photo(&dir.0, "a.png", 2000, 500);
        let photos = HashMap::from([("a.png", &photo)]);

        // Panning to the left edge shows only the red half.
        let left = Fit {
            cx: 0.0,
            ..Fit::default()
        };
        let d = design(vec![frame(whole_canvas(), "a.png", left)], "#FFFFFF");
        let image = render_spread(&d, &spec(), &photos).unwrap();
        let (w, h) = image.dimensions();
        assert!(close_to(image.get_pixel(w - 1, h / 2), RED));

        // Panning to the right edge shows only the blue half.
        let right = Fit {
            cx: 1.0,
            ..Fit::default()
        };
        let d = design(vec![frame(whole_canvas(), "a.png", right)], "#FFFFFF");
        let image = render_spread(&d, &spec(), &photos).unwrap();
        assert!(close_to(image.get_pixel(0, h / 2), BLUE));
    }

    #[test]
    fn zooming_in_magnifies_around_the_chosen_centre() {
        let dir = TempDir::new();
        let photo = split_photo(&dir.0, "a.png", 800, 400);
        let photos = HashMap::from([("a.png", &photo)]);
        let zoomed = Fit {
            scale: 3.0,
            cx: 0.1,
            cy: 0.5,
            rot_deg: 0.0,
        };
        let d = design(vec![frame(whole_canvas(), "a.png", zoomed)], "#FFFFFF");
        let image = render_spread(&d, &spec(), &photos).unwrap();
        let (w, h) = image.dimensions();
        assert!(close_to(image.get_pixel(0, h / 2), RED));
        assert!(
            close_to(image.get_pixel(w - 1, h / 2), RED),
            "blue is zoomed out of view"
        );
    }

    #[test]
    fn effects_reach_the_print() {
        let dir = TempDir::new();
        let photo = split_photo(&dir.0, "a.png", 800, 400);
        let photos = HashMap::from([("a.png", &photo)]);
        let mut mono = frame(whole_canvas(), "a.png", Fit::default());
        mono.adjust.black_and_white = true;
        let d = design(vec![mono], "#FFFFFF");
        let image = render_spread(&d, &spec(), &photos).unwrap();
        let [r, g, b] = image.get_pixel(0, image.height() / 2).0;
        assert!(r == g && g == b, "expected grey, got {r} {g} {b}");
    }

    #[test]
    fn text_prints_above_the_photos_at_print_resolution() {
        use album_core::document::{TextAlign, TextBlock};
        let dir = TempDir::new();
        let photo = split_photo(&dir.0, "a.png", 800, 400);
        let photos = HashMap::from([("a.png", &photo)]);
        let block = TextBlock {
            id: "t".to_string(),
            rect_mm: RectMm {
                x: 10.0,
                y: 10.0,
                w: 100.0,
                h: 40.0,
            },
            text: "█████".to_string(),
            font: String::new(),
            size_pt: 40.0,
            colour: "#00FF00".to_string(),
            align: TextAlign::Left,
            bold: false,
            italic: false,
            line_height: 1.2,
            opacity: 1.0,
        };
        let mut d = design(
            vec![frame(whole_canvas(), "a.png", Fit::default())],
            "#FFFFFF",
        );
        d.texts = vec![block];
        let image = render_spread(&d, &spec(), &photos).unwrap();
        let green = image
            .pixels()
            .filter(|p| p.0[1] > 200 && p.0[0] < 60 && p.0[2] < 60)
            .count();
        assert!(green > 200, "only {green} green pixels");
        let px = |mm: f64| (mm / 25.4 * 100.0).round() as u32;
        assert!(
            close_to(image.get_pixel(px(5.0), px(5.0)), RED),
            "outside the box stays photo"
        );
    }

    /// A red frame on black paper, inset so its edges and corners can be examined.
    fn styled_render(change: impl Fn(&mut Frame)) -> (RgbImage, (u32, u32, u32, u32)) {
        let dir = TempDir::new();
        let path = dir.0.join("red.png");
        RgbImage::from_pixel(600, 300, Rgb(RED))
            .save(&path)
            .unwrap();
        let photo = PhotoInfo {
            id: "red".to_string(),
            path,
            file_name: "red.png".to_string(),
            width: 600,
            height: 300,
            orientation: 1,
        };
        let photos = HashMap::from([("red", &photo)]);
        let rect = RectMm {
            x: 25.4,
            y: 25.4,
            w: 127.0,
            h: 63.5,
        };
        let mut f = frame(rect, "red", Fit::default());
        change(&mut f);
        let d = design(vec![f], "#000000");
        let image = render_spread(&d, &spec(), &photos).unwrap();
        // At 100 DPI that rectangle is 100, 100 to 600, 350.
        (image, (100, 100, 600, 350))
    }

    #[test]
    fn opacity_lets_the_paper_show_through() {
        let (image, _) = styled_render(|f| f.style.opacity = 0.5);
        let [r, _, _] = image.get_pixel(300, 200).0;
        assert!((i32::from(r) - i32::from(RED[0]) / 2).abs() <= 3, "got {r}");
    }

    #[test]
    fn a_border_is_drawn_inside_the_frame_in_its_colour() {
        let (image, (l, t, _, _)) = styled_render(|f| {
            f.style.border_mm = 2.54; // 10 pixels at this DPI
            f.style.border_colour = "#00FF00".to_string();
        });
        assert_eq!(
            image.get_pixel(l + 4, t + 100).0,
            [0, 255, 0],
            "on the border"
        );
        assert!(
            close_to(image.get_pixel(l + 14, t + 100), RED),
            "just inside it"
        );
        assert_eq!(
            image.get_pixel(l - 3, t + 100).0,
            [0, 0, 0],
            "the frame has not grown"
        );
    }

    #[test]
    fn rounded_corners_cut_away_the_corner_and_nothing_else() {
        let (image, (l, t, r, b)) = styled_render(|f| f.corner_radius_mm = 12.7); // 50 pixels
        assert_eq!(
            image.get_pixel(l + 2, t + 2).0,
            [0, 0, 0],
            "the corner is gone"
        );
        assert_eq!(image.get_pixel(r - 3, b - 3).0, [0, 0, 0]);
        assert!(
            close_to(image.get_pixel(l + 25, t + 25), RED),
            "inside the curve"
        );
        assert!(
            close_to(image.get_pixel(l + 2, t + 100), RED),
            "the straight edge stays"
        );
    }

    #[test]
    fn a_frame_partly_off_the_canvas_is_clipped_not_lost() {
        let dir = TempDir::new();
        let photo = split_photo(&dir.0, "a.png", 800, 400);
        let photos = HashMap::from([("a.png", &photo)]);
        let c = spec().canvas_mm();
        let rect = RectMm {
            x: -30.0,
            y: -20.0,
            w: c.w / 2.0,
            h: c.h,
        };
        let mut styled = frame(rect, "a.png", Fit::default());
        styled.style.opacity = 0.9;
        let plain = frame(
            RectMm {
                x: c.w - 40.0,
                y: 10.0,
                w: 80.0,
                h: 40.0,
            },
            "a.png",
            Fit::default(),
        );
        let d = design(vec![styled, plain], "#FFFFFF");
        let image = render_spread(&d, &spec(), &photos).unwrap();
        assert_ne!(image.get_pixel(0, 0).0, [255, 255, 255]);
        assert_ne!(image.get_pixel(image.width() - 1, 60).0, [255, 255, 255]);
    }

    #[test]
    fn text_opacity_reaches_the_print() {
        use album_core::document::{TextAlign, TextBlock};
        let dir = TempDir::new();
        let photo = split_photo(&dir.0, "a.png", 400, 200);
        let photos = HashMap::from([("a.png", &photo)]);
        let block = |opacity| TextBlock {
            id: "t".to_string(),
            rect_mm: RectMm {
                x: 10.0,
                y: 10.0,
                w: 100.0,
                h: 40.0,
            },
            text: "█████".to_string(),
            font: String::new(),
            size_pt: 40.0,
            colour: "#000000".to_string(),
            align: TextAlign::Left,
            bold: false,
            italic: false,
            line_height: 1.2,
            opacity,
        };
        let darkest = |opacity| {
            let mut d = design(Vec::new(), "#FFFFFF");
            d.texts = vec![block(opacity)];
            let image = render_spread(&d, &spec(), &photos).unwrap();
            image.pixels().map(|p| p.0[0]).min().unwrap()
        };
        assert!(darkest(1.0) < 10);
        assert!(
            (i32::from(darkest(0.5)) - 128).abs() < 6,
            "{}",
            darkest(0.5)
        );
    }

    #[test]
    fn neighbouring_frames_leave_exactly_the_gap_between_them() {
        let dir = TempDir::new();
        let photo = split_photo(&dir.0, "a.png", 400, 400);
        let photos = HashMap::from([("a.png", &photo)]);
        let c = spec().canvas_mm();
        let rect = |x: f64, w: f64| RectMm {
            x,
            y: 0.0,
            w,
            h: c.h,
        };
        let gap = 25.4; // one inch, so 100 pixels at this DPI
        let half = (c.w - gap) / 2.0;
        let d = design(
            vec![
                frame(rect(0.0, half), "a.png", Fit::default()),
                frame(rect(half + gap, half), "a.png", Fit::default()),
            ],
            "#000000",
        );
        let image = render_spread(&d, &spec(), &photos).unwrap();
        let row = image.height() / 2;
        let black = (0..image.width())
            .filter(|&x| image.get_pixel(x, row).0 == [0, 0, 0])
            .count();
        assert_eq!(black, 100);
    }

    #[test]
    fn exif_rotation_is_applied_to_the_print() {
        let dir = TempDir::new();
        // Stored with red on the left. Orientation 3 means rotated 180 degrees.
        let mut photo = split_photo(&dir.0, "a.png", 800, 400);
        photo.orientation = 3;
        let photos = HashMap::from([("a.png", &photo)]);
        let d = design(
            vec![frame(whole_canvas(), "a.png", Fit::default())],
            "#FFFFFF",
        );
        let image = render_spread(&d, &spec(), &photos).unwrap();
        let h = image.height();
        assert!(close_to(image.get_pixel(0, h / 2), BLUE));
    }

    #[test]
    fn an_export_writes_jpegs_a_pdf_and_a_manifest() {
        let dir = TempDir::new();
        let out = TempDir::new();
        let photo = split_photo(&dir.0, "a.png", 800, 400);
        let album = project(
            vec![photo],
            vec![frame(whole_canvas(), "a.png", Fit::default())],
        );

        let mut progress = Vec::new();
        let result = export_album(
            &album,
            &out.0,
            ExportFormats {
                jpeg: true,
                pdf: true,
            },
            "9.9.9",
            |done, total| progress.push((done, total)),
        )
        .unwrap();
        assert_eq!(progress, [(1, 1)]);

        // The album's name had characters Windows forbids.
        let folder_name = result
            .folder
            .file_name()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        assert_eq!(folder_name, "Test - Album- export");

        let jpeg = result.folder.join("Test - Album-_spread_01.jpg");
        let (w, h) = image::image_dimensions(&jpeg).unwrap();
        assert_eq!((w, h), canvas_pixels(&album.spreads[0].design, &album.spec));

        // A JFIF header with density units of DPI (1), then 100 x 100.
        let bytes = fs::read(&jpeg).unwrap();
        assert_eq!(&bytes[6..11], b"JFIF\0");
        assert_eq!(&bytes[13..18], &[1, 0, 100, 0, 100]);

        let pdf = fs::read(result.folder.join("Test - Album-.pdf")).unwrap();
        assert!(pdf.starts_with(b"%PDF-"));
        assert!(contains(&pdf, b"/TrimBox"), "labs need the trim box");
        assert!(contains(&pdf, b"/BleedBox"));
        assert!(contains(&pdf, b"/DCTDecode"));
        assert!(contains(&pdf, &bytes), "the JPEG is embedded byte for byte");

        let manifest: serde_json::Value =
            serde_json::from_slice(&fs::read(result.folder.join("manifest.json")).unwrap())
                .unwrap();
        assert_eq!(manifest["spreads"], 1);
        assert_eq!(manifest["dpi"], 100.0);
        assert_eq!(manifest["files"].as_array().unwrap().len(), 2);
        assert_eq!(manifest["app_version"], "9.9.9");
    }

    fn contains(haystack: &[u8], needle: &[u8]) -> bool {
        haystack.windows(needle.len()).any(|w| w == needle)
    }

    #[test]
    fn pdf_only_leaves_no_loose_jpegs() {
        let dir = TempDir::new();
        let out = TempDir::new();
        let photo = split_photo(&dir.0, "a.png", 400, 200);
        let album = project(
            vec![photo],
            vec![frame(whole_canvas(), "a.png", Fit::default())],
        );
        let result = export_album(
            &album,
            &out.0,
            ExportFormats {
                jpeg: false,
                pdf: true,
            },
            "1",
            |_, _| {},
        )
        .unwrap();
        let names: Vec<_> = fs::read_dir(&result.folder)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        assert!(!names.iter().any(|n| n.ends_with(".jpg")), "{names:?}");
        assert_eq!(result.files, ["Test - Album-.pdf"]);
    }

    #[test]
    fn a_second_export_never_overwrites_the_first() {
        let dir = TempDir::new();
        let out = TempDir::new();
        let photo = split_photo(&dir.0, "a.png", 400, 200);
        let album = project(
            vec![photo],
            vec![frame(whole_canvas(), "a.png", Fit::default())],
        );
        let formats = ExportFormats {
            jpeg: true,
            pdf: false,
        };
        let first = export_album(&album, &out.0, formats, "1", |_, _| {}).unwrap();
        let second = export_album(&album, &out.0, formats, "1", |_, _| {}).unwrap();
        assert_ne!(first.folder, second.folder);
    }

    #[test]
    fn missing_originals_stop_the_export_before_it_starts() {
        let dir = TempDir::new();
        let out = TempDir::new();
        let photo = split_photo(&dir.0, "a.png", 400, 200);
        fs::remove_file(&photo.path).unwrap();
        let album = project(
            vec![photo],
            vec![frame(whole_canvas(), "a.png", Fit::default())],
        );

        let issues = check_album(&album);
        assert!(issues.iter().any(|i| i.severity == Severity::Blocker));
        let result = export_album(
            &album,
            &out.0,
            ExportFormats {
                jpeg: true,
                pdf: true,
            },
            "1",
            |_, _| {},
        );
        assert!(matches!(result, Err(ExportError::MissingOriginals(1))));
        assert_eq!(
            fs::read_dir(&out.0).unwrap().count(),
            0,
            "nothing was written"
        );
    }

    #[test]
    fn the_check_warns_about_soft_and_repeated_photos() {
        let dir = TempDir::new();
        let photo = split_photo(&dir.0, "a.png", 300, 150);
        let album = project(
            vec![photo],
            vec![
                frame(whole_canvas(), "a.png", Fit::default()),
                frame(whole_canvas(), "a.png", Fit::default()),
            ],
        );
        let messages: Vec<_> = check_album(&album).into_iter().map(|i| i.message).collect();
        assert!(
            messages.iter().any(|m| m.contains("blurry")),
            "{messages:?}"
        );
        assert!(
            messages.iter().any(|m| m.contains("more than once")),
            "{messages:?}"
        );
    }

    #[test]
    fn a_good_album_has_nothing_to_report() {
        let dir = TempDir::new();
        let photo = split_photo(&dir.0, "a.png", 3000, 1500);
        let album = project(
            vec![photo],
            vec![frame(whole_canvas(), "a.png", Fit::default())],
        );
        assert_eq!(check_album(&album), []);
    }

    #[test]
    fn an_album_with_no_spreads_cannot_be_exported() {
        let album = Project {
            spreads: Vec::new(),
            ..project(Vec::new(), Vec::new())
        };
        assert!(check_album(&album)
            .iter()
            .any(|i| i.severity == Severity::Blocker));
    }

    #[test]
    fn unsafe_names_become_safe_file_names() {
        assert_eq!(safe_file_name("../../evil"), "-..-evil");
        assert_eq!(safe_file_name("a:b*c?"), "a-b-c-");
        assert_eq!(safe_file_name("..."), "album");
        assert_eq!(safe_file_name("   "), "album");
        assert_eq!(safe_file_name("Nimal & Sachini"), "Nimal & Sachini");
    }

    #[test]
    fn a_bad_paper_colour_falls_back_to_white() {
        assert_eq!(parse_colour("#102030"), [0x10, 0x20, 0x30]);
        assert_eq!(parse_colour("nonsense"), FALLBACK_PAPER);
        assert_eq!(parse_colour("#FFF"), FALLBACK_PAPER);
        assert_eq!(parse_colour("#ÿÿÿÿÿÿ"), FALLBACK_PAPER);
    }

    #[test]
    fn size_is_taken_from_the_design_itself() {
        let d = SpreadDesign {
            size_mm: SizeMm { w: 25.4, h: 25.4 },
            ..design(Vec::new(), "#FFFFFF")
        };
        assert_eq!(canvas_pixels(&d, &spec()), (100, 100));
    }
}
