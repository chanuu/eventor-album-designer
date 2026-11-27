#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use album_core::adjust::{neutralise, Adjustments};
use album_core::autobuild::{
    gallery_left_out, plan_album, rate_photos, AlbumPlan, GalleryLeftOut, PhotoFacts, PhotoRating,
    PlanOptions,
};
use album_core::autolayout::{apply_layout, rank_layouts, Photo};
use album_core::document::{
    Binding, ProjectSpec, RectMm, SpreadDesign, TextBlock, BLEED_OPTIONS_MM, DPI_OPTIONS,
    DPI_TOO_LOW, DPI_WARN, GAP_PRESETS_IN, MARGIN_PRESETS_IN, PAPER_COLOURS, SIZE_PRESETS_IN,
};
use album_core::layoutvary::vary_layout;
use album_core::pack::{load_pack_dir, TemplateRegistry};
use album_core::pagelayout::{page_layouts, PageSide};
use album_core::retouch::{facing, RetouchEdits, SIDE_ON};
use album_export::{
    check_album, export_album, is_upload_address, render_web_spread, ExportFormats, ExportResult,
    Issue,
};
use album_media::analyze::{analyze_photo, auto_adjust};
use album_media::eyes::{photo_faces, photo_has_closed_eyes};
use album_media::live::{to_canvas_bytes, LivePreview};
use album_media::retouched::{read_saved, save_retouched, SavedRetouch, RETOUCHED_FOLDER};
use album_media::selection::{make_gallery_copies, match_selection, SelectionMatch, WantedPhoto};
use album_media::skin::photo_skin;
use album_media::{
    adjusted_preview, ensure_preview, read_photo_file, scan_folder, PhotoInfo, PreviewTier,
    ScanResult,
};
use album_store::{load_project, music_type, save_project, Project, StoreError};
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use tauri::http::{header, Response, StatusCode};
use tauri::{AppHandle, Emitter, Manager, State};

mod device;
mod update;

const MM_PER_INCH: f64 = 25.4;

/// Decoding a large photo is heavy on memory, so previews are made a few at a time.
const MAX_PREVIEW_WORKERS: usize = 4;

/// Thousands of per-photo updates would freeze the screen they are meant to inform.
const PROGRESS_INTERVAL: Duration = Duration::from_millis(100);

/// Sharp on a large screen, without the cost of print resolution.
const TEXT_PREVIEW_DPI: f64 = 150.0;

/// The same limit as adding music in Eventor itself.
const MAX_MUSIC_BYTES: u64 = 10 * 1024 * 1024;

/// A cover drawn for the web is a fraction of this.
const MAX_COVER_BYTES: usize = 8 * 1024 * 1024;

struct AppState {
    /// Only photos the user imported can be served, so the preview address can never be
    /// used to read any other file on the computer.
    photos: Arc<Mutex<HashMap<String, PhotoInfo>>>,
    facts: Arc<Mutex<HashMap<String, PhotoFacts>>>,
    /// The open album's retouch edits, by photo id, so every preview shows them.
    retouches: Arc<Mutex<HashMap<String, RetouchEdits>>>,
    /// The retoucher's picture, with its steps kept so that changes show at once.
    live: Arc<Mutex<LivePreview>>,
    registry: TemplateRegistry,
    /// Thank you card designs, kept apart so an album is never offered one.
    cards: TemplateRegistry,
    preview_pool: Arc<rayon::ThreadPool>,
    cache_dir: PathBuf,
}

#[derive(Serialize)]
struct PrintOptions {
    sizes_in: Vec<(f64, f64)>,
    bleed_mm: Vec<f64>,
    dpi: Vec<f64>,
    margins_in: Vec<(String, f64)>,
    gaps_in: Vec<(String, f64)>,
    paper: Vec<String>,
    dpi_warn: f64,
    dpi_too_low: f64,
}

fn named(presets: &[(&str, f64)]) -> Vec<(String, f64)> {
    presets
        .iter()
        .map(|(name, value)| ((*name).to_string(), *value))
        .collect()
}

#[tauri::command]
fn print_options() -> PrintOptions {
    PrintOptions {
        sizes_in: SIZE_PRESETS_IN.to_vec(),
        bleed_mm: BLEED_OPTIONS_MM.to_vec(),
        dpi: DPI_OPTIONS.to_vec(),
        margins_in: named(MARGIN_PRESETS_IN),
        gaps_in: named(GAP_PRESETS_IN),
        paper: PAPER_COLOURS.iter().map(|c| (*c).to_string()).collect(),
        dpi_warn: DPI_WARN,
        dpi_too_low: DPI_TOO_LOW,
    }
}

#[derive(Deserialize)]
struct NewAlbumSettings {
    open_width_in: f64,
    height_in: f64,
    binding: Binding,
    margin_in: f64,
    gap_in: f64,
    bleed_mm: f64,
    target_dpi: f64,
    paper: String,
}

#[tauri::command]
fn make_spec(settings: NewAlbumSettings) -> Result<ProjectSpec, String> {
    let spec = ProjectSpec {
        binding: settings.binding,
        margin_mm: settings.margin_in * MM_PER_INCH,
        gap_mm: settings.gap_in * MM_PER_INCH,
        bleed_mm: settings.bleed_mm,
        target_dpi: settings.target_dpi,
        paper: settings.paper,
        ..ProjectSpec::from_open_inches(settings.open_width_in, settings.height_in)
    };
    spec.validate()?;
    Ok(spec)
}

#[tauri::command]
async fn import_folder(path: String, state: State<'_, AppState>) -> Result<ScanResult, String> {
    let folder = PathBuf::from(path);
    let scan = tauri::async_runtime::spawn_blocking(move || scan_folder(&folder))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;

    let mut photos = state.photos.lock().map_err(|e| e.to_string())?;
    for photo in &scan.photos {
        photos.insert(photo.id.clone(), photo.clone());
    }
    Ok(scan)
}

/// Tells the preview server the open album's retouch edits. Called when an album opens
/// and whenever a photo is retouched; the whole set replaces the last one.
#[tauri::command]
fn set_retouches(
    edits: HashMap<String, RetouchEdits>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let cleaned = edits
        .into_iter()
        .map(|(id, e)| (id, e.sanitized()))
        .filter(|(_, e)| !e.is_empty())
        .collect();
    *state.retouches.lock().map_err(|e| e.to_string())? = cleaned;
    Ok(())
}

/// A photo opened in the retoucher outside an album, with what was saved for it last time.
#[derive(Serialize)]
struct RetouchPhoto {
    photo: PhotoInfo,
    saved: Option<SavedRetouch>,
}

#[derive(Serialize)]
struct OpenedToRetouch {
    photos: Vec<RetouchPhoto>,
    skipped: Vec<String>,
}

/// Whether a photo is one of the app's own retouched copies.
fn is_retouched_copy(photo: &PhotoInfo) -> bool {
    photo
        .path
        .parent()
        .and_then(|d| d.file_name())
        .is_some_and(|n| n == RETOUCHED_FOLDER)
}

/// Opens photos for retouching: each path is a photo or a folder of them. Photos that
/// cannot be read are skipped and named.
#[tauri::command]
async fn open_to_retouch(
    paths: Vec<String>,
    state: State<'_, AppState>,
) -> Result<OpenedToRetouch, String> {
    let (found, skipped) = tauri::async_runtime::spawn_blocking(move || {
        let mut found: Vec<PhotoInfo> = Vec::new();
        let mut skipped: Vec<String> = Vec::new();
        for path in paths.iter().map(PathBuf::from) {
            if path.is_dir() {
                match scan_folder(&path) {
                    Ok(scan) => {
                        // A folder's own retouched copies are not offered back for retouching.
                        found.extend(scan.photos.into_iter().filter(|p| !is_retouched_copy(p)));
                        skipped.extend(scan.skipped.into_iter().map(|s| s.file_name));
                    }
                    Err(e) => skipped.push(e.to_string()),
                }
            } else {
                match read_photo_file(&path) {
                    Ok(photo) => found.push(photo),
                    Err(e) => skipped.push(e.to_string()),
                }
            }
        }
        (found, skipped)
    })
    .await
    .map_err(|e| e.to_string())?;

    {
        let mut photos = state.photos.lock().map_err(|e| e.to_string())?;
        for photo in &found {
            photos.insert(photo.id.clone(), photo.clone());
        }
    }
    let photos = found
        .into_iter()
        .map(|photo| RetouchPhoto {
            saved: read_saved(&photo),
            photo,
        })
        .collect();
    Ok(OpenedToRetouch { photos, skipped })
}

fn known_photo(state: &AppState, id: &str) -> Result<PhotoInfo, String> {
    state
        .photos
        .lock()
        .map_err(|e| e.to_string())?
        .get(id)
        .cloned()
        .ok_or_else(|| "That photo is not open.".to_string())
}

/// The retoucher's picture: the editing preview with these edits and this colour.
#[tauri::command]
async fn retouch_preview(
    photo_id: String,
    edits: RetouchEdits,
    adjust: Adjustments,
    max_edge: Option<u32>,
    state: State<'_, AppState>,
) -> Result<tauri::ipc::Response, String> {
    let photo = known_photo(&state, &photo_id)?;
    let cache_dir = state.cache_dir.clone();
    let live = Arc::clone(&state.live);
    let bytes = tauri::async_runtime::spawn_blocking(move || {
        let preview = ensure_preview(&photo, &cache_dir, PreviewTier::Edit)?;
        let faces = if edits.needs_faces() {
            Some(photo_skin(&photo, &cache_dir)?)
        } else {
            None
        };
        live.lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .draw(&preview, &adjust, &edits, faces.as_ref(), max_edge)
            .map(|image| to_canvas_bytes(&image))
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e: album_media::MediaError| e.to_string())?;
    Ok(tauri::ipc::Response::new(bytes))
}

/// White balance from a spot that should be grey or white: the Temperature and Tint that
/// make it neutral. `x` and `y` are shares of the photo; a small patch is averaged so
/// one noisy pixel cannot throw it off.
#[tauri::command]
async fn neutral_at(
    photo_id: String,
    x: f64,
    y: f64,
    state: State<'_, AppState>,
) -> Result<(f64, f64), String> {
    let photo = known_photo(&state, &photo_id)?;
    let cache_dir = state.cache_dir.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let preview =
            ensure_preview(&photo, &cache_dir, PreviewTier::Edit).map_err(|e| e.to_string())?;
        let image = image::open(preview).map_err(|e| e.to_string())?.into_rgb8();
        let (w, h) = image.dimensions();
        let cx = (x.clamp(0.0, 1.0) * f64::from(w - 1)).round() as i64;
        let cy = (y.clamp(0.0, 1.0) * f64::from(h - 1)).round() as i64;
        let mut sum = [0.0f64; 3];
        let mut n = 0.0f64;
        for dy in -2..=2 {
            for dx in -2..=2 {
                let (px, py) = (cx + dx, cy + dy);
                if px < 0 || py < 0 || px >= i64::from(w) || py >= i64::from(h) {
                    continue;
                }
                let p = image.get_pixel(px as u32, py as u32);
                for k in 0..3 {
                    sum[k] += f64::from(p[k]) / 255.0;
                }
                n += 1.0;
            }
        }
        Ok(neutralise(sum.map(|v| v / n.max(1.0))))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// A face that can be chosen in the retoucher.
#[derive(Serialize)]
struct RetouchFace {
    /// Its middle, which is how edits name it.
    at: [f64; 2],
    /// Left, top, width and height. All are shares of the photo.
    bounds: [f64; 4],
    /// Too far turned for makeup to be put on.
    side_on: bool,
}

/// Finds the faces in a photo for Magic skin and makeup, ahead of time, left to right.
#[tauri::command]
async fn prepare_skin(
    photo_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<RetouchFace>, String> {
    let photo = known_photo(&state, &photo_id)?;
    let aspect = f64::from(photo.width) / f64::from(photo.height.max(1));
    let cache_dir = state.cache_dir.clone();
    let map = tauri::async_runtime::spawn_blocking(move || photo_skin(&photo, &cache_dir))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;
    Ok(map
        .faces
        .iter()
        .map(|face| RetouchFace {
            at: face.middle(),
            bounds: face.bounds(),
            side_on: facing(&face.points, aspect) < SIDE_ON,
        })
        .collect())
}

/// Saves a full-size retouched copy beside the original. Returns where it went.
#[tauri::command]
async fn save_retouched_photo(
    photo_id: String,
    saved: SavedRetouch,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let photo = known_photo(&state, &photo_id)?;
    let saved = SavedRetouch {
        edits: saved.edits.sanitized(),
        adjust: saved.adjust.sanitized(),
    };
    tauri::async_runtime::spawn_blocking(move || save_retouched(&photo, &saved))
        .await
        .map_err(|e| e.to_string())?
        .map(|path| path.display().to_string())
        .map_err(|e| e.to_string())
}

#[derive(Deserialize)]
struct PhotoInput {
    asset_id: String,
    aspect: f64,
}

/// A new arrangement in the style of this layout. None if the style has nothing to move.
#[tauri::command]
fn vary_spread_layout(
    template_id: String,
    photos: Vec<PhotoInput>,
    spec: ProjectSpec,
    current: Vec<RectMm>,
    seed: u32,
    state: State<'_, AppState>,
) -> Option<LayoutOption> {
    let photos: Vec<Photo> = photos
        .into_iter()
        .map(|p| Photo {
            asset_id: p.asset_id,
            aspect: p.aspect,
        })
        .collect();
    let template = state.registry.get(&template_id)?;
    let (made, layout) = vary_layout(template, &photos, &spec, &current, u64::from(seed))?;
    Some(LayoutOption {
        template_id: layout.template_id.clone(),
        name: made.name.clone(),
        tags: made.tags.clone(),
        crop_loss: layout.crop_loss,
        design: apply_layout(&made, &photos, &layout, &spec),
    })
}

/// New arrangements for one page, leaving the other as it is. Each holds only that page.
#[tauri::command]
fn shuffle_page_layouts(
    photos: Vec<PhotoInput>,
    spec: ProjectSpec,
    side: PageSide,
    current: Vec<RectMm>,
    fine_art: bool,
    seed: u32,
    state: State<'_, AppState>,
) -> Vec<LayoutOption> {
    let photos: Vec<Photo> = photos
        .into_iter()
        .map(|p| Photo {
            asset_id: p.asset_id,
            aspect: p.aspect,
        })
        .collect();
    page_layouts(
        &state.registry,
        &photos,
        &spec,
        side,
        &current,
        fine_art,
        u64::from(seed),
    )
    .into_iter()
    .map(|page| LayoutOption {
        template_id: page.template_id,
        name: page.name,
        tags: page.tags,
        crop_loss: page.crop_loss,
        design: page.design,
    })
    .collect()
}

#[derive(Serialize)]
struct LayoutOption {
    template_id: String,
    name: String,
    tags: Vec<String>,
    crop_loss: f64,
    design: SpreadDesign,
}

/// Every layout for these photos, best first, each ready to display.
#[tauri::command]
fn suggest_layouts(
    photos: Vec<PhotoInput>,
    spec: ProjectSpec,
    state: State<'_, AppState>,
) -> Vec<LayoutOption> {
    let photos: Vec<Photo> = photos
        .into_iter()
        .map(|p| Photo {
            asset_id: p.asset_id,
            aspect: p.aspect,
        })
        .collect();

    rank_layouts(&state.registry, &photos, &spec)
        .into_iter()
        .filter_map(|layout| {
            let template = state.registry.get(&layout.template_id)?;
            Some(LayoutOption {
                template_id: layout.template_id.clone(),
                name: template.name.clone(),
                tags: template.tags.clone(),
                crop_loss: layout.crop_loss,
                design: apply_layout(template, &photos, &layout, &spec),
            })
        })
        .collect()
}

/// Every card design for these photos and this card's shape, best first.
#[tauri::command]
fn suggest_card_layouts(
    photos: Vec<PhotoInput>,
    spec: ProjectSpec,
    state: State<'_, AppState>,
) -> Vec<LayoutOption> {
    let photos: Vec<Photo> = photos
        .into_iter()
        .map(|p| Photo {
            asset_id: p.asset_id,
            aspect: p.aspect,
        })
        .collect();

    rank_layouts(&state.cards, &photos, &spec)
        .into_iter()
        .filter_map(|layout| {
            let template = state.cards.get(&layout.template_id)?;
            Some(LayoutOption {
                template_id: layout.template_id.clone(),
                name: template.name.clone(),
                tags: template.tags.clone(),
                crop_loss: layout.crop_loss,
                design: apply_layout(template, &photos, &layout, &spec),
            })
        })
        .collect()
}

/// How many photos each card design takes, so the app can say what to select.
#[tauri::command]
fn card_photo_counts(spec: ProjectSpec, state: State<'_, AppState>) -> Vec<usize> {
    let aspect = spec.spread_aspect();
    (1..=album_core::pack::MAX_FRAMES_PER_TEMPLATE)
        .filter(|&count| {
            state
                .cards
                .with_frame_count(count)
                .any(|t| t.spread_aspect.contains(aspect))
        })
        .collect()
}

#[derive(Serialize)]
struct AnalysisSummary {
    analyzed: usize,
    /// Photos that could not be read, which are still placed, just without judgement.
    unreadable: Vec<String>,
}

/// Reads what Auto Build needs from each photo. All of it stays on this computer.
#[tauri::command]
async fn analyze_photos(
    app: AppHandle,
    ids: Vec<String>,
    state: State<'_, AppState>,
) -> Result<AnalysisSummary, String> {
    let photos: Vec<PhotoInfo> = {
        let known = state.photos.lock().map_err(|e| e.to_string())?;
        ids.iter().filter_map(|id| known.get(id).cloned()).collect()
    };
    let facts_store = state.facts.clone();
    let cache_dir = state.cache_dir.clone();
    let pool = state.preview_pool.clone();

    tauri::async_runtime::spawn_blocking(move || {
        let total = photos.len();
        let done = AtomicUsize::new(0);
        let last_update = Mutex::new(Instant::now());
        let results: Vec<(&PhotoInfo, Option<PhotoFacts>)> = pool.install(|| {
            photos
                .par_iter()
                .map(|photo| {
                    let facts = analyze_photo(photo, &cache_dir).ok();
                    // Found now, under the progress bar, so that building need not wait.
                    let _ = photo_faces(photo, &cache_dir);
                    let finished = done.fetch_add(1, Ordering::Relaxed) + 1;
                    if let Ok(mut last) = last_update.try_lock() {
                        if last.elapsed() >= PROGRESS_INTERVAL {
                            *last = Instant::now();
                            let _ = app.emit("analysis-progress", (finished, total));
                        }
                    }
                    (photo, facts)
                })
                .collect()
        });

        let mut store = facts_store.lock().map_err(|e| e.to_string())?;
        let mut unreadable = Vec::new();
        for (photo, facts) in results {
            let facts = facts.unwrap_or_else(|| {
                unreadable.push(photo.id.clone());
                PhotoFacts {
                    id: photo.id.clone(),
                    taken_at: None,
                    camera: None,
                    sharpness: None,
                    hash: None,
                    mono: false,
                    blown: 0.0,
                    crushed: 0.0,
                }
            });
            store.insert(photo.id.clone(), facts);
        }
        Ok(AnalysisSummary {
            analyzed: total,
            unreadable,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Lays out the album from what analysis found. Quick enough to run on every option change.
#[tauri::command]
fn plan_for_album(
    ids: Vec<String>,
    options: PlanOptions,
    state: State<'_, AppState>,
) -> Result<AlbumPlan, String> {
    let store = state.facts.lock().map_err(|e| e.to_string())?;
    let facts: Vec<PhotoFacts> = ids.iter().filter_map(|id| store.get(id).cloned()).collect();
    Ok(plan_album(&facts, &options))
}

/// Suggested ratings for photos that have already been analysed.
#[tauri::command]
fn suggest_ratings(
    ids: Vec<String>,
    state: State<'_, AppState>,
) -> Result<Vec<PhotoRating>, String> {
    let store = state.facts.lock().map_err(|e| e.to_string())?;
    let facts: Vec<PhotoFacts> = ids.iter().filter_map(|id| store.get(id).cloned()).collect();
    Ok(rate_photos(&facts))
}

/// Which of these analysed photos not to offer a customer, and why. Looking for closed eyes
/// takes a moment per photo, so it runs on every core, and each answer is kept.
#[tauri::command]
async fn check_for_gallery(
    ids: Vec<String>,
    state: State<'_, AppState>,
) -> Result<Vec<GalleryLeftOut>, String> {
    let facts: Vec<PhotoFacts> = {
        let store = state.facts.lock().map_err(|e| e.to_string())?;
        ids.iter().filter_map(|id| store.get(id).cloned()).collect()
    };
    let photos: Vec<PhotoInfo> = {
        let known = state.photos.lock().map_err(|e| e.to_string())?;
        ids.iter().filter_map(|id| known.get(id).cloned()).collect()
    };
    let cache_dir = state.cache_dir.clone();
    let pool = state.preview_pool.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let edges: Vec<(String, u32)> = photos
            .iter()
            .map(|p| (p.id.clone(), p.width.max(p.height)))
            .collect();
        // A photo that cannot be checked is offered, rather than hidden for no reason.
        let closed: Vec<String> = pool.install(|| {
            photos
                .par_iter()
                .filter(|photo| photo_has_closed_eyes(photo, &cache_dir).unwrap_or(false))
                .map(|photo| photo.id.clone())
                .collect()
        });
        Ok(gallery_left_out(&facts, &edges, &closed))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Where the faces are in these photos, by photo id, for crops that keep them in view. A
/// photo that cannot be looked at has none.
#[tauri::command]
async fn find_photo_faces(
    ids: Vec<String>,
    state: State<'_, AppState>,
) -> Result<HashMap<String, Vec<[f64; 4]>>, String> {
    let photos: Vec<PhotoInfo> = {
        let known = state.photos.lock().map_err(|e| e.to_string())?;
        ids.iter().filter_map(|id| known.get(id).cloned()).collect()
    };
    let cache_dir = state.cache_dir.clone();
    let pool = state.preview_pool.clone();
    tauri::async_runtime::spawn_blocking(move || {
        pool.install(|| {
            photos
                .par_iter()
                .map(|p| {
                    (
                        p.id.clone(),
                        photo_faces(p, &cache_dir).unwrap_or_default(),
                    )
                })
                .collect()
        })
    })
    .await
    .map_err(|e| e.to_string())
}

/// Suggested white balance and levels for one photo.
#[tauri::command]
async fn suggest_colour(id: String, state: State<'_, AppState>) -> Result<Adjustments, String> {
    let photo = state
        .photos
        .lock()
        .map_err(|e| e.to_string())?
        .get(&id)
        .cloned()
        .ok_or_else(|| "Unknown photo".to_string())?;
    let cache_dir = state.cache_dir.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let preview =
            ensure_preview(&photo, &cache_dir, PreviewTier::Grid).map_err(|e| e.to_string())?;
        let image = image::open(preview).map_err(|e| e.to_string())?;
        Ok(auto_adjust(&image.to_rgb8()))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn list_fonts() -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(album_text::font_families)
        .await
        .map_err(|e| e.to_string())
}

/// A preview of a text block. The first byte says whether the text overflowed its box,
/// and the rest is the PNG, which saves encoding the image as text to send it across.
#[tauri::command]
async fn preview_text(block: TextBlock) -> Result<tauri::ipc::Response, String> {
    let (png, overflowed) = tauri::async_runtime::spawn_blocking(move || {
        album_text::render_block_png(&block, TEXT_PREVIEW_DPI)
    })
    .await
    .map_err(|e| e.to_string())??;
    let mut bytes = Vec::with_capacity(png.len() + 1);
    bytes.push(u8::from(overflowed));
    bytes.extend_from_slice(&png);
    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command]
async fn save_album(path: String, project: Project) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || save_project(&PathBuf::from(path), &project))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
}

#[derive(Serialize)]
struct OpenedAlbum {
    project: Project,
    missing: Vec<String>,
}

#[tauri::command]
async fn open_album(path: String, state: State<'_, AppState>) -> Result<OpenedAlbum, String> {
    let opened = tauri::async_runtime::spawn_blocking(move || {
        let project = load_project(&PathBuf::from(path))?;
        let missing = project.missing_photos();
        Ok::<_, StoreError>(OpenedAlbum { project, missing })
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())?;

    let mut photos = state.photos.lock().map_err(|e| e.to_string())?;
    for photo in &opened.project.photos {
        photos.insert(photo.id.clone(), photo.clone());
    }
    Ok(opened)
}

/// Finds moved originals in a folder by file name and size.
///
/// A photo keeps its id, so the design and its previews carry on working unchanged.
#[tauri::command]
async fn relink_photos(
    folder: String,
    ids: Vec<String>,
    state: State<'_, AppState>,
) -> Result<Vec<PhotoInfo>, String> {
    let folder = PathBuf::from(folder);
    let scan = tauri::async_runtime::spawn_blocking(move || scan_folder(&folder))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;

    let mut photos = state.photos.lock().map_err(|e| e.to_string())?;
    let mut found = Vec::new();
    for id in ids {
        let Some(known) = photos.get_mut(&id) else {
            continue;
        };
        let matched = scan.photos.iter().find(|p| {
            p.file_name == known.file_name && p.width == known.width && p.height == known.height
        });
        if let Some(matched) = matched {
            known.path.clone_from(&matched.path);
            found.push(known.clone());
        }
    }
    Ok(found)
}

#[tauri::command]
async fn check_for_export(project: Project) -> Result<Vec<Issue>, String> {
    project.validate().map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || check_album(&project))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn export_print_files(
    app: AppHandle,
    project: Project,
    folder: String,
    formats: ExportFormats,
) -> Result<ExportResult, String> {
    project.validate().map_err(|e| e.to_string())?;
    let version = app.package_info().version.to_string();
    tauri::async_runtime::spawn_blocking(move || {
        export_album(
            &project,
            &PathBuf::from(folder),
            formats,
            &version,
            |done, total| {
                // Progress is only a courtesy, so a failed update must not stop the export.
                let _ = app.emit("export-progress", (done, total));
            },
        )
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())
}

/// Sends one finished image to the address `storage` gave for it. These headers are part
/// of what that address was signed with, and a dropped connection is normal on a long
/// upload. Errors leave the address out, because it is a working credential for minutes.
fn upload_image(address: &str, bytes: &[u8]) -> Result<(), String> {
    upload_bytes(address, bytes, "image/jpeg")
}

fn upload_bytes(address: &str, bytes: &[u8], content_type: &str) -> Result<(), String> {
    const ATTEMPTS: u32 = 3;
    let mut problem = String::new();
    for attempt in 0..ATTEMPTS {
        if attempt > 0 {
            std::thread::sleep(std::time::Duration::from_millis(500 * u64::from(attempt)));
        }
        let sent = ureq::put(address)
            .set("Content-Type", content_type)
            .set("Cache-Control", "public, max-age=31536000, immutable")
            .send_bytes(bytes);
        match sent {
            Ok(_) => return Ok(()),
            Err(ureq::Error::Status(code, _)) => {
                problem = format!("Storage refused the upload (error {code}).");
            }
            Err(ureq::Error::Transport(_)) => {
                problem = "Could not reach storage. Check your internet connection.".to_string();
            }
        }
    }
    Err(problem)
}

/// Finds what a customer selected among the photos in this folder.
#[tauri::command]
async fn match_customer_selection(
    folder: String,
    wanted: Vec<WantedPhoto>,
    state: State<'_, AppState>,
) -> Result<SelectionMatch, String> {
    let path = PathBuf::from(folder);
    let (scan, matched) = tauri::async_runtime::spawn_blocking(move || {
        let scan = scan_folder(&path).map_err(|e| e.to_string())?;
        let matched = match_selection(&scan.photos, &wanted);
        Ok::<_, String>((scan, matched))
    })
    .await
    .map_err(|e| e.to_string())??;

    let mut photos = state.photos.lock().map_err(|e| e.to_string())?;
    for photo in &scan.photos {
        photos.insert(photo.id.clone(), photo.clone());
    }
    Ok(matched)
}

/// Uploads a photo's two gallery sizes, and returns the hash of the original.
#[tauri::command]
async fn upload_gallery_photo(
    photo_id: String,
    full_url: String,
    thumb_url: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    if !is_upload_address(&full_url) || !is_upload_address(&thumb_url) {
        return Err("That upload address is not allowed.".to_string());
    }
    // Only a photo already imported, so that no other file on the computer can be sent.
    let photo = state
        .photos
        .lock()
        .map_err(|e| e.to_string())?
        .get(&photo_id)
        .cloned()
        .ok_or_else(|| "That photo has not been imported.".to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        let copies = make_gallery_copies(&photo).map_err(|e| e.to_string())?;
        upload_image(&full_url, &copies.full)?;
        upload_image(&thumb_url, &copies.thumb)?;
        Ok(copies.hash)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Draws one spread for the web and uploads it. Returns how many bytes were sent.
#[tauri::command]
async fn publish_spread(
    project: Project,
    spread_id: String,
    upload_url: String,
) -> Result<usize, String> {
    project.validate().map_err(|e| e.to_string())?;
    if !is_upload_address(&upload_url) {
        return Err("That upload address is not allowed.".to_string());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let bytes = render_web_spread(&project, &spread_id).map_err(|e| e.to_string())?;
        upload_image(&upload_url, &bytes)?;
        Ok(bytes.len())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Uploads a cover the cover designer has drawn.
#[tauri::command]
async fn upload_cover(upload_url: String, jpeg: Vec<u8>) -> Result<(), String> {
    if !is_upload_address(&upload_url) {
        return Err("That upload address is not allowed.".to_string());
    }
    if jpeg.len() > MAX_COVER_BYTES || !jpeg.starts_with(&[0xFF, 0xD8, 0xFF]) {
        return Err("The cover could not be prepared for upload.".to_string());
    }
    tauri::async_runtime::spawn_blocking(move || upload_image(&upload_url, &jpeg))
        .await
        .map_err(|e| e.to_string())?
}

#[derive(Serialize)]
struct MusicFile {
    name: String,
    ext: String,
    content_type: String,
    /// Changes when the file does, so a replaced track is sent again.
    stamp: String,
}

/// Only a music file of a sensible size, so that no other file can be read or sent.
fn music_file(path: &str) -> Result<MusicFile, String> {
    let (ext, content_type) =
        music_type(path).ok_or_else(|| "Choose an MP3, M4A, AAC, OGG or WAV file.".to_string())?;
    let details =
        fs::metadata(path).map_err(|_| "That music file could not be found.".to_string())?;
    if !details.is_file() {
        return Err("That music file could not be found.".to_string());
    }
    if details.len() > MAX_MUSIC_BYTES {
        return Err("That track is over 10 MB.".to_string());
    }
    let modified = details
        .modified()
        .ok()
        .and_then(|at| at.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or(0, |since| since.as_secs());
    let name = PathBuf::from(path)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    Ok(MusicFile {
        name,
        ext: ext.to_string(),
        content_type: content_type.to_string(),
        stamp: format!("{}-{modified}", details.len()),
    })
}

#[tauri::command]
fn music_details(path: String) -> Result<MusicFile, String> {
    music_file(&path)
}

/// The track itself, to play in the album preview.
#[tauri::command]
async fn read_music(path: String) -> Result<tauri::ipc::Response, String> {
    music_file(&path)?;
    let bytes = tauri::async_runtime::spawn_blocking(move || fs::read(path))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|_| "That music file could not be read.".to_string())?;
    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command]
async fn upload_music(path: String, upload_url: String) -> Result<(), String> {
    if !is_upload_address(&upload_url) {
        return Err("That upload address is not allowed.".to_string());
    }
    let file = music_file(&path)?;
    tauri::async_runtime::spawn_blocking(move || {
        let bytes = fs::read(path).map_err(|_| "That music file could not be read.".to_string())?;
        upload_bytes(&upload_url, &bytes, &file.content_type)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Layout packs a studio has added, alongside the built-in one.
fn load_registry(packs_dir: &PathBuf) -> TemplateRegistry {
    let mut registry = TemplateRegistry::with_builtin();
    let Ok(entries) = fs::read_dir(packs_dir) else {
        return registry;
    };
    for entry in entries.flatten() {
        match load_pack_dir(&entry.path()) {
            Ok(pack) => {
                for bad in &pack.rejected {
                    eprintln!(
                        "Pack {}: left out {}: {}",
                        pack.manifest.id, bad.file, bad.reason
                    );
                }
                registry.add_pack(pack);
            }
            Err(e) => eprintln!("Skipped pack {}: {e}", entry.path().display()),
        }
    }
    registry
}

fn plain_response(status: StatusCode, message: &str) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "text/plain")
        .body(message.as_bytes().to_vec())
        .unwrap_or_default()
}

/// Requested width from `?w=512`. A bad value just gets the smaller preview.
fn requested_width(query: Option<&str>) -> u32 {
    query
        .into_iter()
        .flat_map(|q| q.split('&'))
        .find_map(|pair| pair.strip_prefix("w="))
        .and_then(|value| value.parse().ok())
        .unwrap_or(0)
}

/// Adjustments from `?fx=...`. A bad value just means no change.
fn requested_adjustments(query: Option<&str>) -> Adjustments {
    query
        .into_iter()
        .flat_map(|q| q.split('&'))
        .find_map(|pair| pair.strip_prefix("fx="))
        .map(Adjustments::from_query)
        .unwrap_or_default()
}

fn serve_preview(
    photos: &Mutex<HashMap<String, PhotoInfo>>,
    retouches: &Mutex<HashMap<String, RetouchEdits>>,
    cache_dir: &std::path::Path,
    id: &str,
    width: u32,
    adjust: &Adjustments,
) -> Response<Vec<u8>> {
    let photo = photos.lock().ok().and_then(|map| map.get(id).cloned());
    let retouch = retouches.lock().ok().and_then(|map| map.get(id).cloned());
    let Some(photo) = photo else {
        return plain_response(StatusCode::NOT_FOUND, "unknown photo");
    };
    // Magic skin needs the photo's faces; finding them is kept, so it happens once.
    let faces = match &retouch {
        Some(edits) if edits.needs_faces() => photo_skin(&photo, cache_dir).ok(),
        _ => None,
    };

    let bytes = ensure_preview(&photo, cache_dir, PreviewTier::from_width(width))
        .map_err(|e| e.to_string())
        .and_then(|path| {
            if adjust.is_identity() && retouch.is_none() {
                fs::read(path).map_err(|e| e.to_string())
            } else {
                adjusted_preview(&path, adjust, retouch.as_ref(), faces.as_ref(), None)
                    .map_err(|e| e.to_string())
            }
        });
    match bytes {
        Ok(bytes) => Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, "image/jpeg")
            // The id changes when the file changes, and the address carries a stamp of
            // the photo's retouch edits, so a preview never goes stale.
            .header(header::CACHE_CONTROL, "max-age=31536000, immutable")
            .body(bytes)
            .unwrap_or_default(),
        Err(reason) => plain_response(StatusCode::INTERNAL_SERVER_ERROR, &reason),
    }
}

/// This computer's id for Eventor's per-plan device limit, with a name the studio will recognise.
#[tauri::command]
fn device_identity(app: AppHandle) -> Result<device::DeviceIdentity, String> {
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(device::identity(&data_dir))
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(update::FoundUpdate::default())
        .register_asynchronous_uri_scheme_protocol("album", |ctx, request, responder| {
            let state = ctx.app_handle().state::<AppState>();
            let photos = state.photos.clone();
            let retouches = state.retouches.clone();
            let cache_dir = state.cache_dir.clone();
            let pool = state.preview_pool.clone();
            let id = request
                .uri()
                .path()
                .strip_prefix("/preview/")
                .unwrap_or_default()
                .to_string();
            let width = requested_width(request.uri().query());
            let adjust = requested_adjustments(request.uri().query());
            pool.spawn(move || {
                responder.respond(serve_preview(
                    &photos, &retouches, &cache_dir, &id, width, &adjust,
                ));
            });
        })
        .setup(|app| {
            let cache_dir = app.path().app_cache_dir()?.join("previews");
            let packs_dir = app.path().app_data_dir()?.join("packs");
            let workers = std::thread::available_parallelism()
                .map_or(2, |n| n.get().saturating_sub(1))
                .clamp(1, MAX_PREVIEW_WORKERS);
            app.manage(AppState {
                photos: Arc::new(Mutex::new(HashMap::new())),
                facts: Arc::new(Mutex::new(HashMap::new())),
                retouches: Arc::new(Mutex::new(HashMap::new())),
                live: Arc::new(Mutex::new(LivePreview::default())),
                registry: load_registry(&packs_dir),
                cards: TemplateRegistry::with_cards(),
                preview_pool: Arc::new(
                    rayon::ThreadPoolBuilder::new()
                        .num_threads(workers)
                        .build()?,
                ),
                cache_dir,
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            print_options,
            make_spec,
            import_folder,
            set_retouches,
            open_to_retouch,
            retouch_preview,
            prepare_skin,
            find_photo_faces,
            neutral_at,
            save_retouched_photo,
            suggest_layouts,
            suggest_card_layouts,
            card_photo_counts,
            vary_spread_layout,
            shuffle_page_layouts,
            save_album,
            open_album,
            relink_photos,
            suggest_ratings,
            check_for_gallery,
            suggest_colour,
            list_fonts,
            preview_text,
            analyze_photos,
            plan_for_album,
            check_for_export,
            export_print_files,
            publish_spread,
            upload_cover,
            music_details,
            read_music,
            upload_music,
            match_customer_selection,
            upload_gallery_photo,
            device_identity,
            update::app_version,
            update::check_for_update,
            update::install_update
        ])
        .run(tauri::generate_context!())
        .expect("the app window could not start");
}
