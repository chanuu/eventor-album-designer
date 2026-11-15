//! Draws every thank you card design with sample photos, for checking them by eye.
//!
//! cargo run -p album-export --example card_sheet -- <photo folder> <output folder>
//!
//! Writes one JPEG per design and `sheet.jpg` with all of them side by side.

use std::collections::HashMap;
use std::path::PathBuf;

use album_core::autolayout::{apply_layout, Photo, RankedLayout};
use album_core::document::ProjectSpec;
use album_core::pack::cards_pack;
use album_export::render_spread;
use album_media::PhotoInfo;
use image::{imageops, Rgb, RgbImage};

const DPI: f64 = 80.0;
const SHEET_HEIGHT: u32 = 520;
const PER_ROW: u32 = 6;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let (folder, out) = (PathBuf::from(&args[1]), PathBuf::from(&args[2]));
    std::fs::create_dir_all(&out).unwrap();

    let mut photos: Vec<PhotoInfo> = std::fs::read_dir(&folder)
        .unwrap()
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.extension().is_some_and(|x| x.eq_ignore_ascii_case("jpg")))
        .filter_map(|path| {
            let (width, height) = image::image_dimensions(&path).ok()?;
            let name = path.file_name()?.to_string_lossy().into_owned();
            Some(PhotoInfo {
                id: name.clone(),
                path,
                file_name: name,
                width,
                height,
                orientation: 1,
            })
        })
        .collect();
    photos.sort_by(|a, b| a.id.cmp(&b.id));
    let by_id: HashMap<&str, &PhotoInfo> = photos.iter().map(|p| (p.id.as_str(), p)).collect();

    let mut tiles = Vec::new();
    for template in cards_pack().templates {
        // The narrowest shape a design allows, so a 5×8-only design still gets a card.
        let aspect = match template.spread_aspect {
            album_core::pack::AspectRange::Between { min, max } => {
                if (min..=max).contains(&0.75) {
                    0.75
                } else if (min..=max).contains(&1.4) {
                    1.4
                } else {
                    min
                }
            }
            album_core::pack::AspectRange::Any(_) => 0.75,
        };
        // A card is one sheet, so its width is the "open" width of the spec.
        let (width_in, height_in) = if aspect < 1.0 {
            (8.0 * aspect, 8.0)
        } else {
            (8.0, 8.0 / aspect)
        };
        let spec = ProjectSpec {
            margin_mm: 0.0,
            gap_mm: 0.0,
            target_dpi: DPI,
            ..ProjectSpec::from_open_inches(width_in, height_in)
        };
        let used: Vec<Photo> = photos
            .iter()
            .cycle()
            .take(template.frame_count)
            .map(|p| Photo {
                asset_id: p.id.clone(),
                aspect: f64::from(p.width) / f64::from(p.height),
            })
            .collect();
        let layout = RankedLayout {
            template_id: template.id.clone(),
            assignment: (0..template.frame_count).collect(),
            crop_loss: 0.0,
            score: 0.0,
        };
        let mut design = apply_layout(&template, &used, &layout, &spec);
        for text in &mut design.texts {
            text.text = text
                .text
                .replace("{FIRST}", "NIMAL")
                .replace("{SECOND}", "SACHINI")
                .replace("{First}", "Nimal")
                .replace("{Second}", "Sachini")
                .replace("{STUDIO}", "EVENTOR WEDDINGS | 077 000 0000")
                .replace("{MUA}", "SALON NILANI");
            while let Some(start) = text.text.find("{date") {
                let end = text.text[start..]
                    .find('}')
                    .map_or(text.text.len(), |e| start + e + 1);
                text.text.replace_range(start..end, "24 | 10 | 2026");
            }
        }
        let image = render_spread(&design, &spec, &by_id).unwrap();
        let name = template.id.trim_start_matches("eventor-cards/");
        image.save(out.join(format!("{name}.jpg"))).unwrap();
        println!("{name}: {}×{}", image.width(), image.height());
        tiles.push(imageops::resize(
            &image,
            image.width() * SHEET_HEIGHT / image.height(),
            SHEET_HEIGHT,
            imageops::FilterType::Triangle,
        ));
    }

    let gap = 16;
    let rows: Vec<&[RgbImage]> = tiles.chunks(PER_ROW as usize).collect();
    let width = rows
        .iter()
        .map(|row| row.iter().map(|t| t.width() + gap).sum::<u32>() + gap)
        .max()
        .unwrap_or(1);
    let mut sheet = RgbImage::from_pixel(
        width,
        rows.len() as u32 * (SHEET_HEIGHT + gap) + gap,
        Rgb([60, 62, 70]),
    );
    for (r, row) in rows.iter().enumerate() {
        let mut x = gap;
        for tile in *row {
            imageops::replace(
                &mut sheet,
                tile,
                i64::from(x),
                i64::from(gap + r as u32 * (SHEET_HEIGHT + gap)),
            );
            x += tile.width() + gap;
        }
    }
    sheet.save(out.join("sheet.jpg")).unwrap();
}
