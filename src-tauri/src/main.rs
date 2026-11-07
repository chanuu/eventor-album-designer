#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use album_core::adjust::Adjustments;
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
use album_export::{
    check_album, export_album, is_upload_address, render_web_spread, ExportFormats, ExportResult,
    Issue,
};
use album_media::analyze::{analyze_photo, auto_adjust};
use album_media::selection::{make_gallery_copies, match_selection, SelectionMatch, WantedPhoto};
use album_media::{
    adjusted_preview, ensure_preview, scan_folder, PhotoInfo, PreviewTier, ScanResult,
};
use album_store::{load_project, save_project, Project, StoreError};
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use tauri::http::{header, Response, StatusCode};
use tauri::{AppHandle, Emitter, Manager, State};

const MM_PER_INCH: f64 = 25.4;

/// Decoding a large photo is heavy on memory, so previews are made a few at a time.
const MAX_PREVIEW_WORKERS: usize = 4;

/// Thousands of per-photo updates would freeze the screen they are meant to inform.
const PROGRESS_INTERVAL: Duration = Duration::from_millis(100);

/// Sharp on a large screen, without the cost of print resolution.
const TEXT_PREVIEW_DPI: f64 = 150.0;

struct AppState {
    /// Only photos the user imported can be served, so the preview address can never be
    /// used to read any other file on the computer.
    photos: Arc<Mutex<HashMap<String, PhotoInfo>>>,
    facts: Arc<Mutex<HashMap<String, PhotoFacts>>>,
    registry: TemplateRegistry,
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

/// Which of these analysed photos not to offer a customer, and why.
#[tauri::command]
fn check_for_gallery(
    ids: Vec<String>,
    state: State<'_, AppState>,
) -> Result<Vec<GalleryLeftOut>, String> {
    let store = state.facts.lock().map_err(|e| e.to_string())?;
    let photos = state.photos.lock().map_err(|e| e.to_string())?;
    let facts: Vec<PhotoFacts> = ids.iter().filter_map(|id| store.get(id).cloned()).collect();
    let edges: Vec<(String, u32)> = ids
        .iter()
        .filter_map(|id| photos.get(id).map(|p| (id.clone(), p.width.max(p.height))))
        .collect();
    Ok(gallery_left_out(&facts, &edges))
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
    const ATTEMPTS: u32 = 3;
    let mut problem = String::new();
    for attempt in 0..ATTEMPTS {
        if attempt > 0 {
            std::thread::sleep(std::time::Duration::from_millis(500 * u64::from(attempt)));
        }
        let sent = ureq::put(address)
            .set("Content-Type", "image/jpeg")
            .set("Cache-Control", "public, max-age=31536000, immutable")
            .send_bytes(bytes);
        match sent {
            Ok(_) => return Ok(()),
            Err(ureq::Error::Status(code, _)) => {
                problem = format!("Storage refused the image (error {code}).");
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
    cache_dir: &std::path::Path,
    id: &str,
    width: u32,
    adjust: &Adjustments,
) -> Response<Vec<u8>> {
    let photo = photos.lock().ok().and_then(|map| map.get(id).cloned());
    let Some(photo) = photo else {
        return plain_response(StatusCode::NOT_FOUND, "unknown photo");
    };

    let bytes = ensure_preview(&photo, cache_dir, PreviewTier::from_width(width))
        .map_err(|e| e.to_string())
        .and_then(|path| {
            if adjust.is_identity() {
                fs::read(path).map_err(|e| e.to_string())
            } else {
                adjusted_preview(&path, adjust).map_err(|e| e.to_string())
            }
        });
    match bytes {
        Ok(bytes) => Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, "image/jpeg")
            // The id changes when the file changes, so a preview never goes stale.
            .header(header::CACHE_CONTROL, "max-age=31536000, immutable")
            .body(bytes)
            .unwrap_or_default(),
        Err(reason) => plain_response(StatusCode::INTERNAL_SERVER_ERROR, &reason),
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .register_asynchronous_uri_scheme_protocol("album", |ctx, request, responder| {
            let state = ctx.app_handle().state::<AppState>();
            let photos = state.photos.clone();
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
                responder.respond(serve_preview(&photos, &cache_dir, &id, width, &adjust));
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
                registry: load_registry(&packs_dir),
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
            suggest_layouts,
            vary_spread_layout,
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
            match_customer_selection,
            upload_gallery_photo
        ])
        .run(tauri::generate_context!())
        .expect("the app window could not start");
}
