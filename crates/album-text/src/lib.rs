//! Draws text blocks, for both the preview and the print.
//!
//! One engine does both, so text can never wrap differently on paper. Lines are always
//! worked out at one fixed resolution and then drawn at whatever size is needed. Shaping
//! is what makes Sinhala and Tamil letters join correctly.
//!
//! Fonts come from this computer and end up as pixels in the output, so no font file is
//! copied into an album or shipped to the lab.

use std::sync::{Mutex, OnceLock};

use album_core::document::{TextAlign, TextBlock};
use cosmic_text::{
    Align, Attrs, Buffer, Color, Family, FontSystem, Metrics, Shaping, Stretch, Style, SwashCache,
    Weight,
};
use image::{Rgba, RgbaImage};

const MM_PER_INCH: f64 = 25.4;
const POINTS_PER_INCH: f64 = 72.0;
const LAYOUT_DPI: f64 = 300.0;
const FALLBACK_COLOUR: [u8; 3] = [0, 0, 0];
/// Room inside the box, because some letters reach a little past their start and end.
const INSET_MM: f64 = 1.0;
/// Bigger than this and a single text block would hold a lot of memory.
const MAX_SIDE_PIXELS: u32 = 12_000;

struct Engine {
    fonts: FontSystem,
    cache: SwashCache,
}

/// Finding the system's fonts takes a moment, so it happens once, on first use.
fn engine() -> &'static Mutex<Engine> {
    static ENGINE: OnceLock<Mutex<Engine>> = OnceLock::new();
    ENGINE.get_or_init(|| {
        Mutex::new(Engine {
            fonts: FontSystem::new(),
            cache: SwashCache::new(),
        })
    })
}

/// The font families installed on this computer, sorted by name.
pub fn font_families() -> Vec<String> {
    let Ok(engine) = engine().lock() else {
        return Vec::new();
    };
    let mut names: Vec<String> = engine
        .fonts
        .db()
        .faces()
        .filter_map(|face| face.families.first().map(|(name, _)| name.clone()))
        .collect();
    names.sort_by_key(|name| name.to_lowercase());
    names.dedup();
    names
}

fn parse_colour(value: &str) -> [u8; 3] {
    let hex = value.trim().trim_start_matches('#');
    let channel = |at: usize| {
        hex.get(at..at + 2)
            .and_then(|pair| u8::from_str_radix(pair, 16).ok())
    };
    match (hex.len(), channel(0), channel(2), channel(4)) {
        (6, Some(r), Some(g), Some(b)) => [r, g, b],
        _ => FALLBACK_COLOUR,
    }
}

fn pixels(mm: f64, dpi: f64) -> u32 {
    ((mm / MM_PER_INCH) * dpi)
        .round()
        .clamp(1.0, f64::from(MAX_SIDE_PIXELS)) as u32
}

/// A drawn block, and whether its text ran past the bottom of the box.
pub struct RenderedText {
    pub image: RgbaImage,
    pub overflowed: bool,
}

/// Draws one block with a transparent background, at the given resolution.
pub fn render_block(block: &TextBlock, dpi: f64) -> Result<RenderedText, String> {
    let mut engine = engine().lock().map_err(|e| e.to_string())?;
    let Engine { fonts, cache } = &mut *engine;

    let size_px = (block.size_pt / POINTS_PER_INCH * LAYOUT_DPI).max(1.0) as f32;
    let line_px = size_px * block.line_height.clamp(0.5, 4.0) as f32;
    let inset_px = (INSET_MM / MM_PER_INCH * LAYOUT_DPI) as f32;
    let box_width = (block.rect_mm.w / MM_PER_INCH * LAYOUT_DPI) as f32 - inset_px * 2.0;
    let box_height = (block.rect_mm.h / MM_PER_INCH * LAYOUT_DPI) as f32 - inset_px * 2.0;

    let family = if block.font.trim().is_empty() {
        Family::SansSerif
    } else {
        Family::Name(block.font.as_str())
    };
    let attrs = Attrs::new()
        .family(family)
        .stretch(Stretch::Normal)
        .weight(if block.bold {
            Weight::BOLD
        } else {
            Weight::NORMAL
        })
        .style(if block.italic {
            Style::Italic
        } else {
            Style::Normal
        });

    let mut buffer = Buffer::new(fonts, Metrics::new(size_px, line_px));
    buffer.set_size(fonts, Some(box_width.max(1.0)), None);
    let align = match block.align {
        TextAlign::Left => Align::Left,
        TextAlign::Center => Align::Center,
        TextAlign::Right => Align::Right,
    };
    buffer.set_text(fonts, &block.text, &attrs, Shaping::Advanced);
    for line in &mut buffer.lines {
        line.set_align(Some(align));
    }
    buffer.shape_until_scroll(fonts, false);

    let scale = (dpi / LAYOUT_DPI) as f32;
    let (width, height) = (pixels(block.rect_mm.w, dpi), pixels(block.rect_mm.h, dpi));
    let mut image = RgbaImage::new(width, height);
    let [r, g, b] = parse_colour(&block.colour);
    let ink = Color::rgb(r, g, b);
    let mut overflowed = false;

    for run in buffer.layout_runs() {
        if run.line_top + run.line_height > box_height + 0.5 {
            overflowed = true;
        }
        for glyph in run.glyphs {
            let physical = glyph.physical((inset_px * scale, inset_px * scale), scale);
            let baseline = (run.line_y * scale).round() as i32;
            cache.with_pixels(fonts, physical.cache_key, ink, |dx, dy, colour| {
                let x = physical.x + dx;
                let y = baseline + physical.y + dy;
                if x >= 0 && y >= 0 && (x as u32) < width && (y as u32) < height {
                    let [cr, cg, cb, ca] = colour.as_rgba();
                    blend(image.get_pixel_mut(x as u32, y as u32), [cr, cg, cb, ca]);
                }
            });
        }
    }
    Ok(RenderedText { image, overflowed })
}

/// A block as a PNG, the form the preview shows.
pub fn render_block_png(block: &TextBlock, dpi: f64) -> Result<(Vec<u8>, bool), String> {
    let drawn = render_block(block, dpi)?;
    let mut bytes = Vec::new();
    drawn
        .image
        .write_to(
            &mut std::io::Cursor::new(&mut bytes),
            image::ImageFormat::Png,
        )
        .map_err(|e| e.to_string())?;
    Ok((bytes, drawn.overflowed))
}

/// Where glyphs overlap, as Sinhala marks do, the coverage adds up rather than replacing.
fn blend(pixel: &mut Rgba<u8>, [r, g, b, a]: [u8; 4]) {
    let over = u16::from(a);
    let under = u16::from(pixel.0[3]);
    let alpha = over + under * (255 - over) / 255;
    if alpha == 0 {
        return;
    }
    let mix = |top: u8, bottom: u8| {
        let top = u32::from(top) * u32::from(over);
        let bottom = u32::from(bottom) * u32::from(under) * u32::from(255 - over) / 255;
        ((top + bottom) / u32::from(alpha)).min(255) as u8
    };
    *pixel = Rgba([
        mix(r, pixel.0[0]),
        mix(g, pixel.0[1]),
        mix(b, pixel.0[2]),
        alpha.min(255) as u8,
    ]);
}

#[cfg(test)]
mod tests {
    use super::*;
    use album_core::document::RectMm;

    fn block(text: &str) -> TextBlock {
        TextBlock {
            id: "t1".to_string(),
            rect_mm: RectMm {
                x: 0.0,
                y: 0.0,
                w: 120.0,
                h: 60.0,
            },
            text: text.to_string(),
            font: String::new(),
            size_pt: 24.0,
            colour: "#102030".to_string(),
            align: TextAlign::Left,
            bold: false,
            italic: false,
            line_height: 1.3,
            opacity: 1.0,
        }
    }

    fn inked(image: &RgbaImage) -> usize {
        image.pixels().filter(|p| p.0[3] > 128).count()
    }

    /// The left edge of ink, the far right edge, and the top and bottom.
    fn bounds(image: &RgbaImage) -> (u32, u32, u32, u32) {
        let (mut l, mut r, mut t, mut b) = (u32::MAX, 0, u32::MAX, 0);
        for (x, y, p) in image.enumerate_pixels() {
            if p.0[3] > 128 {
                l = l.min(x);
                r = r.max(x);
                t = t.min(y);
                b = b.max(y);
            }
        }
        (l, r, t, b)
    }

    #[test]
    fn the_image_is_exactly_the_box_at_print_size() {
        let drawn = render_block(&block("Hello"), 300.0).unwrap();
        assert_eq!(
            drawn.image.dimensions(),
            (pixels(120.0, 300.0), pixels(60.0, 300.0))
        );
    }

    #[test]
    fn text_makes_ink_in_its_colour_and_the_rest_stays_clear() {
        let drawn = render_block(&block("Hello"), 300.0).unwrap();
        assert!(inked(&drawn.image) > 200);
        let solid = drawn.image.pixels().find(|p| p.0[3] == 255).unwrap();
        assert_eq!(&solid.0[..3], &[0x10, 0x20, 0x30]);
        assert_eq!(
            drawn
                .image
                .get_pixel(drawn.image.width() - 1, drawn.image.height() - 1)
                .0[3],
            0
        );
    }

    #[test]
    fn empty_text_draws_nothing() {
        assert_eq!(inked(&render_block(&block(""), 300.0).unwrap().image), 0);
    }

    #[test]
    fn sinhala_is_drawn_with_a_real_font_not_empty_boxes() {
        let sinhala = render_block(&block("තුන් වේල ටියුෂන්"), 300.0).unwrap();
        assert!(
            inked(&sinhala.image) > 200,
            "Sinhala needs a font with those letters"
        );

        // Shaping changes the result: the joined form is not the letters side by side.
        let joined = render_block(&block("ශ්‍රී"), 300.0).unwrap();
        let apart = render_block(&block("ශ ් ර ී"), 300.0).unwrap();
        let (l1, r1, _, _) = bounds(&joined.image);
        let (l2, r2, _, _) = bounds(&apart.image);
        assert!(r1 - l1 < r2 - l2, "joined {} apart {}", r1 - l1, r2 - l2);
    }

    #[test]
    fn long_text_wraps_inside_the_box() {
        let one = render_block(&block("short"), 300.0).unwrap();
        let many = render_block(&block(&"word ".repeat(40)), 300.0).unwrap();
        assert!(
            bounds(&many.image).3 > bounds(&one.image).3 * 2,
            "it runs onto more lines"
        );
        assert!(bounds(&many.image).1 < many.image.width());
    }

    #[test]
    fn lines_break_in_the_same_places_at_every_resolution() {
        let text = "The same words must wrap the same way on screen and on paper, always.";
        let line_tops = |dpi: f64| {
            let image = render_block(&block(text), dpi).unwrap().image;
            let height = image.height();
            let filled: Vec<bool> = (0..height)
                .map(|y| (0..image.width()).any(|x| image.get_pixel(x, y).0[3] > 128))
                .collect();
            let starts = filled.windows(2).filter(|w| !w[0] && w[1]).count();
            let last = bounds(&image).3;
            (starts, f64::from(last) / dpi)
        };
        let (preview_lines, preview_end) = line_tops(150.0);
        let (print_lines, print_end) = line_tops(300.0);
        assert_eq!(preview_lines, print_lines);
        assert!(
            (preview_end - print_end).abs() < 0.03,
            "{preview_end} {print_end}"
        );
    }

    #[test]
    fn alignment_moves_the_text_within_the_box() {
        let at = |align| {
            let drawn = render_block(
                &TextBlock {
                    align,
                    ..block("Hi")
                },
                300.0,
            )
            .unwrap();
            bounds(&drawn.image)
        };
        let (left, center, right) = (
            at(TextAlign::Left),
            at(TextAlign::Center),
            at(TextAlign::Right),
        );
        assert!(left.0 < center.0 && center.0 < right.0);
    }

    #[test]
    fn bold_uses_more_ink() {
        let normal = render_block(&block("Weight"), 300.0).unwrap();
        let bold = render_block(
            &TextBlock {
                bold: true,
                ..block("Weight")
            },
            300.0,
        )
        .unwrap();
        assert!(inked(&bold.image) > inked(&normal.image));
    }

    #[test]
    fn text_too_long_for_its_box_is_reported() {
        assert!(!render_block(&block("short"), 300.0).unwrap().overflowed);
        assert!(
            render_block(&block(&"word ".repeat(400)), 300.0)
                .unwrap()
                .overflowed
        );
    }

    #[test]
    fn an_unknown_font_or_colour_does_not_fail() {
        let drawn = render_block(
            &TextBlock {
                font: "No Such Font".to_string(),
                colour: "nonsense".to_string(),
                ..block("Hi")
            },
            150.0,
        )
        .unwrap();
        assert!(inked(&drawn.image) > 0);
    }

    #[test]
    fn this_computer_has_fonts_to_offer() {
        assert!(!font_families().is_empty());
    }
}
