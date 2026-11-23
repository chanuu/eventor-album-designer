//! Sample sheets: each face of some photos with each look. `faces <out dir> <photo>...`
use album_core::retouch::{apply_retouch, facing, FaceMakeup, Makeup, RetouchEdits, SkinSettings};
use image::ImageDecoder;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let looks = [
        None,
        Some(Makeup {
            lip_rgb: [196, 98, 98],
            lip: 0.5,
            gloss: 0.2,
            blush_rgb: [226, 122, 118],
            blush: 0.5,
            contour: 0.4,
            highlight: 0.4,
        }),
        Some(Makeup {
            lip_rgb: [178, 62, 84],
            lip: 0.75,
            gloss: 0.35,
            blush_rgb: [226, 110, 120],
            blush: 0.7,
            contour: 0.65,
            highlight: 0.65,
        }),
        Some(Makeup {
            lip_rgb: [165, 22, 44],
            lip: 0.9,
            gloss: 0.35,
            blush_rgb: [220, 95, 105],
            blush: 0.8,
            contour: 0.8,
            highlight: 0.8,
        }),
    ];
    let mut n = 0;
    for path in &args[2..] {
        let mut d = image::ImageReader::open(path)
            .unwrap()
            .with_guessed_format()
            .unwrap()
            .into_decoder()
            .unwrap();
        let o = d.orientation().unwrap();
        let mut im = image::DynamicImage::from_decoder(d).unwrap();
        im.apply_orientation(o);
        let im = im.resize(4096, 4096, image::imageops::FilterType::Triangle);
        let map = album_media::skin::find_skin(&im).unwrap();
        let base = im.to_rgb8();
        let (w, h) = (base.width() as usize, base.height() as usize);
        let t = std::time::Instant::now();
        let pics: Vec<_> = looks
            .iter()
            .map(|m| {
                let mut o = base.clone();
                if let Some(m) = m {
                    let edits = RetouchEdits {
                        skin: SkinSettings {
                            smooth: 0.4,
                            brighten: 0.1,
                            even: 0.3,
                        },
                        makeup: map
                            .faces
                            .iter()
                            .map(|f| FaceMakeup {
                                at: f.middle(),
                                makeup: *m,
                            })
                            .collect(),
                        ..Default::default()
                    };
                    apply_retouch(&mut o, w, h, &edits, Some(&map));
                }
                o
            })
            .collect();
        println!(
            "{path}: {} faces, {:?} a look",
            map.faces.len(),
            t.elapsed() / 3
        );
        for f in &map.faces {
            println!("  {n} facing {:.2}", facing(&f.points, w as f64 / h as f64));
            let [bx, by, bw, bh] = f.bounds();
            let s = (bh * h as f64 * 1.35) as u32;
            let x = ((bx + bw / 2.0) * w as f64 - f64::from(s) / 2.0).max(0.0) as u32;
            let y = ((by + bh / 2.0) * h as f64 - f64::from(s) / 2.0).max(0.0) as u32;
            let mut sheet = image::RgbImage::new(2800, 700);
            for (k, p) in pics.iter().enumerate() {
                let c = image::imageops::crop_imm(p, x, y, s, s).to_image();
                let c =
                    image::imageops::resize(&c, 700, 700, image::imageops::FilterType::CatmullRom);
                image::imageops::overlay(&mut sheet, &c, 700 * k as i64, 0);
            }
            sheet.save(format!("{}/face{n:02}.png", args[1])).unwrap();
            n += 1;
        }
    }
}
