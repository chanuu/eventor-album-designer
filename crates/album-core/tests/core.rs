use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};

use album_core::autobuild::{gallery_left_out, PhotoFacts};
use album_core::autolayout::{
    apply_layout, crop_loss, cycle_index, rank_layouts, rect_to_mm, Photo,
};
use album_core::document::{
    dpi_status, effective_dpi, visible_area, Background, DpiStatus, Fit, Frame, ProjectSpec,
    RectMm, BLEED_OPTIONS_MM, DPI_OPTIONS, SIZE_PRESETS_IN,
};
use album_core::layoutvary::vary_layout;
use album_core::pack::{builtin_pack, load_pack_dir, RectPct, TemplateFrame, TemplateRegistry};

const LANDSCAPE: f64 = 1.5;
const PORTRAIT: f64 = 2.0 / 3.0;

fn spec() -> ProjectSpec {
    ProjectSpec::from_open_inches(30.0, 12.0)
}

fn photos(aspects: &[f64]) -> Vec<Photo> {
    aspects
        .iter()
        .enumerate()
        .map(|(i, &aspect)| Photo {
            asset_id: format!("p{i}"),
            aspect,
        })
        .collect()
}

#[test]
fn builtin_pack_has_choices_for_every_count_and_valid_geometry() {
    let pack = builtin_pack();
    assert!(pack.templates.len() >= 15);

    let registry = TemplateRegistry::with_builtin();
    for count in 1..=8 {
        assert!(
            registry.with_frame_count(count).count() >= 3,
            "too few for {count}"
        );
    }

    for t in &pack.templates {
        let frames: Vec<RectPct> = t.frames.iter().map(|f| f.rect_pct).collect();
        for (i, a) in frames.iter().enumerate() {
            assert!(a.x >= 0.0 && a.y >= 0.0 && a.x + a.w <= 1.0 + 1e-9 && a.y + a.h <= 1.0 + 1e-9);

            // Only a layout meant to run across the binding may put a photo on the fold.
            let crosses_fold = a.x < 0.5 - 1e-6 && a.x + a.w > 0.5 + 1e-6;
            assert!(
                !crosses_fold || t.tags.iter().any(|tag| tag == "panorama"),
                "{}",
                t.id
            );

            for b in &frames[i + 1..] {
                let overlap_w = (a.x + a.w).min(b.x + b.w) - a.x.max(b.x);
                let overlap_h = (a.y + a.h).min(b.y + b.h) - a.y.max(b.y);
                assert!(
                    overlap_w <= 1e-9 || overlap_h <= 1e-9,
                    "overlap in {}",
                    t.id
                );
            }
        }
    }
}

#[test]
fn photo_shape_changes_which_layout_wins() {
    let registry = TemplateRegistry::with_builtin();
    let wide = rank_layouts(&registry, &photos(&[LANDSCAPE; 3]), &spec());
    let tall = rank_layouts(&registry, &photos(&[PORTRAIT; 3]), &spec());
    assert_ne!(wide[0].template_id, tall[0].template_id);
    assert!(wide.windows(2).all(|w| w[0].score <= w[1].score));
}

#[test]
fn the_first_choice_uses_the_page_rather_than_leaving_it_empty() {
    let registry = TemplateRegistry::with_builtin();
    for count in 2..=8 {
        let selection = photos(&vec![LANDSCAPE; count]);
        let best = &rank_layouts(&registry, &selection, &spec())[0];
        let template = registry.get(&best.template_id).unwrap();
        let covered: f64 = template
            .frames
            .iter()
            .map(|f| f.rect_pct.w * f.rect_pct.h)
            .sum();
        assert!(
            covered > 0.75,
            "{count} photos picked {} at {covered:.2}",
            best.template_id
        );
    }
}

#[test]
fn each_photo_gets_a_frame_of_its_own_shape() {
    let registry = TemplateRegistry::with_builtin();
    let selection = photos(&[PORTRAIT, LANDSCAPE, PORTRAIT]);
    let layout = rank_layouts(&registry, &selection, &spec())
        .into_iter()
        .find(|l| l.template_id.ends_with("3-two-tall-one-wide"))
        .unwrap();
    // The two tall frames must go to the two portraits, wherever they were selected.
    assert_eq!(layout.assignment[1], 2);
}

#[test]
fn switching_layout_never_changes_the_photo_set() {
    let registry = TemplateRegistry::with_builtin();
    let selection = photos(&[LANDSCAPE, PORTRAIT, LANDSCAPE, LANDSCAPE]);
    let ranked = rank_layouts(&registry, &selection, &spec());
    assert!(ranked.len() >= 3);

    let mut expected: Vec<String> = selection.iter().map(|p| p.asset_id.clone()).collect();
    expected.sort();
    for layout in &ranked {
        let template = registry.get(&layout.template_id).unwrap();
        let design = apply_layout(template, &selection, layout, &spec());
        let mut placed: Vec<String> = design
            .frames
            .iter()
            .map(|f| f.asset_id.clone().unwrap())
            .collect();
        placed.sort();
        assert_eq!(placed, expected, "{}", layout.template_id);
        assert!(design.frames.iter().all(|f| f.fit == Fit::default()));
    }
}

#[test]
fn a_count_with_no_template_is_an_empty_answer_not_an_error() {
    let registry = TemplateRegistry::with_builtin();
    assert!(rank_layouts(&registry, &photos(&[LANDSCAPE; 11]), &spec()).is_empty());
    assert!(rank_layouts(&registry, &[], &spec()).is_empty());
}

#[test]
fn a_broken_aspect_does_not_break_ranking() {
    let registry = TemplateRegistry::with_builtin();
    let ranked = rank_layouts(&registry, &photos(&[f64::NAN, 0.0, LANDSCAPE]), &spec());
    assert!(!ranked.is_empty());
    assert!(ranked.iter().all(|l| l.crop_loss.is_finite()));
}

#[test]
fn cycling_wraps_both_ways() {
    assert_eq!(cycle_index(0, 3, -1), 2);
    assert_eq!(cycle_index(2, 3, 1), 0);
    assert_eq!(cycle_index(1, 3, 1), 2);
    assert_eq!(cycle_index(0, 0, 1), 0);
}

#[test]
fn crop_loss_is_zero_for_a_matching_shape() {
    assert_eq!(crop_loss(1.5, 1.5), 0.0);
    assert!((crop_loss(1.0, 2.0) - 0.5).abs() < 1e-12);
}

#[test]
fn crop_never_leaves_the_photo_or_distorts_it() {
    for &(photo, frame) in &[(1.5, 0.7), (0.66, 1.8), (1.0, 1.0), (2.4, 2.4)] {
        for &(scale, cx, cy) in &[
            (1.0, 0.5, 0.5),
            (1.7, 0.95, 0.05),
            (3.0, 0.0, 1.0),
            (0.2, 0.5, 0.5),
        ] {
            let a = visible_area(
                photo,
                frame,
                &Fit {
                    scale,
                    cx,
                    cy,
                    rot_deg: 0.0,
                },
            );
            assert!(a.sx >= 0.0 && a.sy >= 0.0);
            assert!(a.sx + a.sw <= 1.0 + 1e-12 && a.sy + a.sh <= 1.0 + 1e-12);
            let shown = a.sw * photo / a.sh;
            assert!(
                (shown - frame).abs() < 1e-9,
                "distorted: {shown} vs {frame}"
            );
        }
    }
}

fn frame(x: f64, y: f64, w: f64, h: f64, bleed: bool) -> TemplateFrame {
    TemplateFrame {
        rect_pct: RectPct { x, y, w, h },
        bleed,
        z: 0,
    }
}

#[test]
fn bleeding_frames_reach_past_the_trim_and_others_stop_at_the_margin() {
    let s = spec();
    let canvas = s.canvas_mm();

    let full = rect_to_mm(&frame(0.0, 0.0, 1.0, 1.0, true), &s);
    assert_eq!(
        full,
        RectMm {
            x: 0.0,
            y: 0.0,
            w: canvas.w,
            h: canvas.h
        }
    );

    let inside = rect_to_mm(&frame(0.0, 0.0, 1.0, 1.0, false), &s);
    assert!((inside.x - (s.bleed_mm + s.margin_mm)).abs() < 1e-9);
    assert!((inside.w - (canvas.w - 2.0 * (s.bleed_mm + s.margin_mm))).abs() < 1e-9);
}

#[test]
fn a_zero_margin_prints_past_the_cut_rather_than_leaving_a_white_line() {
    let s = ProjectSpec {
        margin_mm: 0.0,
        ..spec()
    };
    let rect = rect_to_mm(&frame(0.0, 0.0, 0.5, 1.0, false), &s);
    assert_eq!((rect.x, rect.y), (0.0, 0.0));
    assert!((rect.h - s.canvas_mm().h).abs() < 1e-9);
}

#[test]
fn neighbours_are_one_gap_apart_and_centred_on_the_fold() {
    let s = spec();
    let left = rect_to_mm(&frame(0.0, 0.0, 0.5, 1.0, false), &s);
    let right = rect_to_mm(&frame(0.5, 0.0, 0.5, 1.0, false), &s);
    let space = right.x - (left.x + left.w);
    assert!((space - s.gap_mm).abs() < 1e-9);

    let fold = s.canvas_mm().w / 2.0;
    assert!((left.x + left.w + s.gap_mm / 2.0 - fold).abs() < 1e-9);
}

#[test]
fn changing_spacing_respaces_a_layout_without_changing_its_photos() {
    let registry = TemplateRegistry::with_builtin();
    let selection = photos(&[LANDSCAPE; 4]);
    let layout = &rank_layouts(&registry, &selection, &spec())[0];
    let template = registry.get(&layout.template_id).unwrap();

    let tight = ProjectSpec {
        gap_mm: 0.0,
        ..spec()
    };
    let wide = ProjectSpec {
        gap_mm: 10.0,
        paper: "#000000".to_string(),
        ..spec()
    };
    let a = apply_layout(template, &selection, layout, &tight);
    let b = apply_layout(template, &selection, layout, &wide);
    assert_ne!(a.frames[0].rect_mm, b.frames[0].rect_mm);
    for (x, y) in a.frames.iter().zip(&b.frames) {
        assert_eq!(x.asset_id, y.asset_id);
    }
    assert_eq!(
        b.background,
        Background::Color {
            value: "#000000".to_string()
        }
    );
}

#[test]
fn every_builtin_layout_stays_on_the_canvas_with_the_widest_settings() {
    let s = ProjectSpec {
        margin_mm: 0.6 * 25.4,
        gap_mm: 0.2 * 25.4,
        bleed_mm: 5.0,
        ..ProjectSpec::from_open_inches(16.0, 8.0)
    };
    let canvas = s.canvas_mm();
    for template in builtin_pack().templates {
        for f in &template.frames {
            let r = rect_to_mm(f, &s);
            assert!(r.w > 0.0 && r.h > 0.0, "{}", template.id);
            assert!(r.x >= 0.0 && r.y >= 0.0, "{}", template.id);
            assert!(r.x + r.w <= canvas.w + 1e-9, "{}", template.id);
            assert!(r.y + r.h <= canvas.h + 1e-9, "{}", template.id);
        }
    }
}

#[test]
fn size_presets_produce_the_right_pages_and_valid_specs() {
    assert_eq!(SIZE_PRESETS_IN.len(), 22);
    for &(height, open_width) in SIZE_PRESETS_IN {
        ProjectSpec::from_open_inches(open_width, height)
            .validate()
            .unwrap();
    }
    let s = spec();
    assert!((s.trim_w_mm - 15.0 * 25.4).abs() < 1e-9);
    assert!((s.trim_h_mm - 12.0 * 25.4).abs() < 1e-9);

    let cm = ProjectSpec::from_open_cm(76.2, 30.48);
    assert!((cm.trim_w_mm - s.trim_w_mm).abs() < 1e-9);
    assert_eq!(BLEED_OPTIONS_MM, &[0.0, 2.0, 3.0, 5.0]);
    assert_eq!(DPI_OPTIONS, &[200.0, 254.0, 300.0, 400.0]);
}

#[test]
fn bad_hand_typed_settings_are_refused() {
    let zero = ProjectSpec::from_open_inches(0.0, 12.0);
    assert!(zero.validate().is_err());
    let not_a_number = ProjectSpec::from_open_inches(f64::NAN, 12.0);
    assert!(not_a_number.validate().is_err());
    let negative = ProjectSpec {
        gap_mm: -1.0,
        ..spec()
    };
    assert!(negative.validate().is_err());
    let huge = ProjectSpec {
        margin_mm: 500.0,
        ..spec()
    };
    assert!(huge.validate().is_err());
}

#[test]
fn dpi_status_marks_soft_photos() {
    assert_eq!(dpi_status(300.0), DpiStatus::Good);
    assert_eq!(dpi_status(220.0), DpiStatus::Good);
    assert_eq!(dpi_status(181.0), DpiStatus::Low);
    assert_eq!(dpi_status(149.0), DpiStatus::TooLow);
}
#[test]
fn twelve_by_thirty_has_the_expected_canvas() {
    let canvas = spec().canvas_mm();
    assert!((canvas.w - (30.0 * 25.4 + 6.0)).abs() < 1e-9);
    assert!((canvas.h - (12.0 * 25.4 + 6.0)).abs() < 1e-9);
}

#[test]
fn effective_dpi_flags_a_proof_sized_photo() {
    let page = Frame {
        id: "f1".into(),
        rect_mm: RectMm {
            x: 0.0,
            y: 0.0,
            w: 381.0,
            h: 304.8,
        }, // 15 x 12 in
        corner_radius_mm: 0.0,
        adjust: Default::default(),
        style: Default::default(),
        asset_id: None,
        fit: Fit::default(),
        z: 0,
    };
    assert!(
        effective_dpi(1920, 1280, &page) < 150.0,
        "a gallery proof cannot print here"
    );
    assert!(
        effective_dpi(6000, 4000, &page) > 250.0,
        "a camera original can"
    );

    // Zooming in spends resolution.
    let zoomed = Frame {
        fit: Fit {
            scale: 2.0,
            ..Fit::default()
        },
        ..page.clone()
    };
    let before = effective_dpi(6000, 4000, &page);
    assert!((effective_dpi(6000, 4000, &zoomed) - before / 2.0).abs() < 1e-6);
}

// ─── Untrusted packs ─────────────────────────────────────────────────────────

/// A scratch folder for one test, removed when the test ends.
struct TempPack(PathBuf);

impl TempPack {
    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempPack {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn write_pack(files: &[(&str, &str)]) -> TempPack {
    static NEXT: AtomicUsize = AtomicUsize::new(0);
    let id = NEXT.fetch_add(1, Ordering::Relaxed);
    let dir =
        TempPack(std::env::temp_dir().join(format!("album-core-test-{}-{id}", std::process::id())));
    fs::create_dir_all(dir.path().join("templates")).unwrap();
    fs::write(
        dir.path().join("pack.toml"),
        "id = \"studio\"\nname = \"Studio\"\nversion = \"1\"\n",
    )
    .unwrap();
    for (name, json) in files {
        fs::write(dir.path().join("templates").join(name), json).unwrap();
    }
    dir
}

const GOOD: &str = r#"{ "id": "studio/one", "name": "One", "frame_count": 1, "spread_aspect": "any",
  "frames": [{ "rect_pct": { "x": 0.1, "y": 0.1, "w": 0.3, "h": 0.8 } }] }"#;

#[test]
fn a_third_party_pack_loads_without_a_rebuild_and_can_override() {
    let dir = write_pack(&[("one.json", GOOD)]);
    let pack = load_pack_dir(dir.path()).unwrap();
    assert_eq!(pack.templates.len(), 1);
    assert!(pack.rejected.is_empty());

    let mut registry = TemplateRegistry::with_builtin();
    let before = registry.with_frame_count(1).count();
    registry.add_pack(pack);
    assert_eq!(registry.with_frame_count(1).count(), before + 1);

    // Same id with a different frame count must leave the old index entry behind.
    let moved = r#"{ "id": "studio/one", "name": "One", "frame_count": 2, "spread_aspect": "any",
      "frames": [{ "rect_pct": { "x": 0, "y": 0, "w": 0.4, "h": 1 } },
                 { "rect_pct": { "x": 0.6, "y": 0, "w": 0.4, "h": 1 } }] }"#;
    let dir = write_pack(&[("one.json", moved)]);
    registry.add_pack(load_pack_dir(dir.path()).unwrap());
    assert_eq!(registry.with_frame_count(1).count(), before);
    assert_eq!(registry.get("studio/one").unwrap().frame_count, 2);
}

#[test]
fn malformed_templates_are_rejected_without_losing_the_good_ones() {
    let script = r#"{ "id": "studio/s", "name": "S", "frame_count": 1, "spread_aspect": "any",
      "script": "rm -rf /", "frames": [{ "rect_pct": { "x": 0, "y": 0, "w": 1, "h": 1 } }] }"#;
    let huge = r#"{ "id": "studio/h", "name": "H", "frame_count": 500, "spread_aspect": "any", "frames": [] }"#;
    let mismatch = r#"{ "id": "studio/m", "name": "M", "frame_count": 2, "spread_aspect": "any",
      "frames": [{ "rect_pct": { "x": 0, "y": 0, "w": 1, "h": 1 } }] }"#;
    let off_spread = r#"{ "id": "studio/o", "name": "O", "frame_count": 1, "spread_aspect": "any",
      "frames": [{ "rect_pct": { "x": 5, "y": 5, "w": 1, "h": 1 } }] }"#;
    let wrong_owner = r#"{ "id": "eventor-essentials/x", "name": "X", "frame_count": 1, "spread_aspect": "any",
      "frames": [{ "rect_pct": { "x": 0, "y": 0, "w": 1, "h": 1 } }] }"#;

    let dir = write_pack(&[
        ("good.json", GOOD),
        ("script.json", script),
        ("huge.json", huge),
        ("mismatch.json", mismatch),
        ("off.json", off_spread),
        ("owner.json", wrong_owner),
        ("garbage.json", "not json at all {"),
    ]);
    let pack = load_pack_dir(dir.path()).unwrap();
    assert_eq!(pack.templates.len(), 1);
    assert_eq!(pack.rejected.len(), 6, "{:?}", pack.rejected);
}

#[test]
fn frames_hanging_off_the_spread_are_clamped_onto_it() {
    let hanging = r#"{ "id": "studio/c", "name": "C", "frame_count": 1, "spread_aspect": "any",
      "frames": [{ "rect_pct": { "x": -0.2, "y": 0.5, "w": 0.5, "h": 2 } }] }"#;
    let dir = write_pack(&[("c.json", hanging)]);
    let rect = load_pack_dir(dir.path()).unwrap().templates[0].frames[0].rect_pct;
    assert_eq!((rect.x, rect.y), (0.0, 0.5));
    assert!((rect.w - 0.3).abs() < 1e-12);
    assert!((rect.h - 0.5).abs() < 1e-12);
}

#[test]
fn an_oversized_template_file_is_rejected() {
    let big = format!(
        r#"{{ "id": "studio/b", "name": "{}" }}"#,
        "x".repeat(300 * 1024)
    );
    let dir = write_pack(&[("big.json", &big)]);
    let pack = load_pack_dir(dir.path()).unwrap();
    assert!(pack.templates.is_empty());
    assert_eq!(pack.rejected[0].reason, "file is too large");
}

#[test]
fn a_bad_manifest_or_pack_id_fails_cleanly() {
    let dir = write_pack(&[]);
    fs::write(
        dir.path().join("pack.toml"),
        "id = \"../evil\"\nname = \"x\"\nversion = \"1\"\n",
    )
    .unwrap();
    assert!(load_pack_dir(dir.path()).is_err());

    fs::write(dir.path().join("pack.toml"), "not toml =").unwrap();
    assert!(load_pack_dir(dir.path()).is_err());
    assert!(load_pack_dir(&dir.path().join("missing")).is_err());
}

#[test]
fn aspect_limits_filter_out_templates_for_other_album_shapes() {
    let square_only = r#"{ "id": "studio/sq", "name": "Sq", "frame_count": 1,
      "spread_aspect": { "min": 1.9, "max": 2.1 },
      "frames": [{ "rect_pct": { "x": 0, "y": 0, "w": 1, "h": 1 } }] }"#;
    let dir = write_pack(&[("sq.json", square_only)]);
    let mut registry = TemplateRegistry::default();
    registry.add_pack(load_pack_dir(dir.path()).unwrap());

    let photo = photos(&[LANDSCAPE]);
    assert!(rank_layouts(&registry, &photo, &spec()).is_empty());
    let twelve_by_twentyfour = ProjectSpec::from_open_inches(24.0, 12.0);
    assert_eq!(
        rank_layouts(&registry, &photo, &twelve_by_twentyfour).len(),
        1
    );
}

fn gallery_fact(id: &str, sharpness: f64, blown: f64, crushed: f64) -> PhotoFacts {
    PhotoFacts {
        id: id.to_string(),
        taken_at: None,
        camera: None,
        sharpness: Some(sharpness),
        hash: None,
        mono: false,
        blown,
        crushed,
    }
}

fn gallery_reasons(facts: &[PhotoFacts], edges: &[(String, u32)], id: &str) -> Vec<String> {
    gallery_left_out(facts, edges, &[])
        .into_iter()
        .find(|item| item.id == id)
        .map_or_else(Vec::new, |item| item.reasons)
}

fn normal_gallery() -> Vec<PhotoFacts> {
    (0..6)
        .map(|i| gallery_fact(&format!("p{i}"), 100.0, 0.02, 0.02))
        .collect()
}

#[test]
fn a_gallery_keeps_ordinary_photos() {
    assert!(gallery_left_out(&normal_gallery(), &[], &[]).is_empty());
}

#[test]
fn a_gallery_leaves_out_overexposed_photos_but_not_a_white_dress() {
    let mut facts = normal_gallery();
    facts.push(gallery_fact("burnt", 100.0, 0.5, 0.0));
    facts.push(gallery_fact("dress", 100.0, 0.15, 0.0));
    assert_eq!(gallery_reasons(&facts, &[], "burnt"), ["Overexposed"]);
    assert!(gallery_reasons(&facts, &[], "dress").is_empty());
}

#[test]
fn a_gallery_leaves_out_blurry_dark_and_small_photos() {
    let mut facts = normal_gallery();
    facts.push(gallery_fact("soft", 5.0, 0.02, 0.02));
    facts.push(gallery_fact("night", 100.0, 0.0, 0.8));
    facts.push(gallery_fact("tiny", 100.0, 0.02, 0.02));
    let edges = vec![("tiny".to_string(), 640), ("p0".to_string(), 6000)];
    assert_eq!(gallery_reasons(&facts, &edges, "soft"), ["Blurry"]);
    assert_eq!(gallery_reasons(&facts, &edges, "night"), ["Too dark"]);
    assert_eq!(gallery_reasons(&facts, &edges, "tiny"), ["Low resolution"]);
    assert!(gallery_reasons(&facts, &edges, "p0").is_empty());
}

#[test]
fn a_gallery_photo_can_have_more_than_one_problem() {
    let mut facts = normal_gallery();
    facts.push(gallery_fact("both", 5.0, 0.6, 0.0));
    assert_eq!(
        gallery_reasons(&facts, &[], "both"),
        ["Overexposed", "Blurry"]
    );
}

fn every_builtin_layout() -> Vec<album_core::pack::Template> {
    let registry = TemplateRegistry::with_builtin();
    (1..=12)
        .flat_map(|count| {
            registry
                .with_frame_count(count)
                .cloned()
                .collect::<Vec<_>>()
        })
        .collect()
}

fn mm_rects(template: &album_core::pack::Template, spec: &ProjectSpec) -> Vec<RectMm> {
    template
        .frames
        .iter()
        .map(|f| rect_to_mm(f, spec))
        .collect()
}

fn overlap(a: &RectMm, b: &RectMm) -> bool {
    const TOUCHING: f64 = 0.01;
    a.x + TOUCHING < b.x + b.w
        && b.x + TOUCHING < a.x + a.w
        && a.y + TOUCHING < b.y + b.h
        && b.y + TOUCHING < a.y + a.h
}

#[test]
fn varying_keeps_every_layouts_style() {
    let spec = spec();
    let fold = spec.canvas_mm().w / 2.0;
    let mut varied = 0;
    for template in every_builtin_layout() {
        let shots = photos(&vec![LANDSCAPE; template.frames.len()]);
        let before = mm_rects(&template, &spec);
        for seed in 0..8 {
            let Some((made, layout)) = vary_layout(&template, &shots, &spec, &before, seed) else {
                continue;
            };
            varied += 1;
            assert_eq!(made.id, template.id);
            assert_eq!(layout.assignment.len(), shots.len());
            let after = mm_rects(&made, &spec);
            let canvas = spec.canvas_mm();
            for (i, (now, was)) in after.iter().zip(&before).enumerate() {
                assert!(
                    now.w > 0.0 && now.h > 0.0,
                    "{} frame {i} has no size",
                    template.id
                );
                assert!(
                    now.x >= -0.01
                        && now.y >= -0.01
                        && now.x + now.w <= canvas.w + 0.01
                        && now.y + now.h <= canvas.h + 0.01,
                    "{} frame {i} left the canvas",
                    template.id
                );
                let side = |r: &RectMm| (r.x + r.w <= fold + 0.01, r.x >= fold - 0.01);
                assert_eq!(
                    side(now),
                    side(was),
                    "{} frame {i} changed page",
                    template.id
                );
                for (j, (other_now, other_was)) in after.iter().zip(&before).enumerate() {
                    if i != j && !overlap(was, other_was) {
                        assert!(
                            !overlap(now, other_now),
                            "{}: {i} now overlaps {j}",
                            template.id
                        );
                    }
                }
            }
        }
    }
    assert!(varied > 500, "only {varied} arrangements were made");
}

#[test]
fn varying_gives_something_visibly_new_each_time() {
    let spec = spec();
    let registry = TemplateRegistry::with_builtin();
    let shots = photos(&[PORTRAIT, PORTRAIT, PORTRAIT, LANDSCAPE]);
    let template = registry.with_frame_count(4).next().unwrap();

    let mut current = mm_rects(template, &spec);
    let mut seen: Vec<Vec<RectMm>> = vec![current.clone()];
    for seed in 0..40 {
        let (made, _) = vary_layout(template, &shots, &spec, &current, seed).unwrap();
        let next = mm_rects(&made, &spec);
        let moved = next
            .iter()
            .zip(&current)
            .map(|(a, b)| {
                (a.x - b.x)
                    .abs()
                    .max((a.y - b.y).abs())
                    .max((a.w - b.w).abs())
                    .max((a.h - b.h).abs())
            })
            .fold(0.0, f64::max);
        assert!(moved >= 4.0, "seed {seed} moved only {moved} mm");
        assert!(!seen.contains(&next), "seed {seed} repeated an arrangement");
        seen.push(next.clone());
        current = next;
    }
}

#[test]
fn varying_is_repeatable_from_its_seed() {
    let spec = spec();
    let registry = TemplateRegistry::with_builtin();
    let shots = photos(&[LANDSCAPE, PORTRAIT, LANDSCAPE]);
    let template = registry.with_frame_count(3).next().unwrap();
    let current = mm_rects(template, &spec);
    let a = vary_layout(template, &shots, &spec, &current, 7).unwrap();
    let b = vary_layout(template, &shots, &spec, &current, 7).unwrap();
    assert_eq!(a.0, b.0);
    assert_eq!(a.1, b.1);
}

#[test]
fn varying_crops_no_more_than_the_layout_it_started_from_on_average() {
    let spec = spec();
    let registry = TemplateRegistry::with_builtin();
    let shots = photos(&[LANDSCAPE, LANDSCAPE, LANDSCAPE]);
    let ranked = rank_layouts(&registry, &shots, &spec);
    let worst = ranked
        .iter()
        .max_by(|a, b| a.crop_loss.total_cmp(&b.crop_loss))
        .unwrap();
    let template = registry.get(&worst.template_id).unwrap();
    let current = mm_rects(template, &spec);
    let total: f64 = (0..30)
        .map(|seed| {
            vary_layout(template, &shots, &spec, &current, seed)
                .unwrap()
                .1
                .crop_loss
        })
        .sum();
    assert!(
        total / 30.0 < worst.crop_loss,
        "{} against {}",
        total / 30.0,
        worst.crop_loss
    );
}

#[test]
fn a_layout_with_nothing_to_move_says_so() {
    let spec = spec();
    let mut template = every_builtin_layout().remove(0);
    let frame = template.frames[0];
    template.frames = vec![TemplateFrame {
        rect_pct: RectPct {
            x: 0.0,
            y: 0.0,
            w: 1.0,
            h: 1.0,
        },
        ..frame
    }];
    let current = mm_rects(&template, &spec);
    assert!(vary_layout(&template, &photos(&[LANDSCAPE]), &spec, &current, 1).is_none());
}

#[test]
fn varying_refuses_the_wrong_number_of_photos() {
    let spec = spec();
    let template = every_builtin_layout().remove(0);
    let wrong = photos(&vec![LANDSCAPE; template.frames.len() + 1]);
    assert!(vary_layout(&template, &wrong, &spec, &[], 1).is_none());
    assert!(vary_layout(&template, &[], &spec, &[], 1).is_none());
}

#[test]
fn a_gallery_leaves_out_photos_where_someone_blinked() {
    let facts = normal_gallery();
    let left = gallery_left_out(&facts, &[], &["p2".to_string()]);
    assert_eq!(left.len(), 1);
    assert_eq!(left[0].id, "p2");
    assert_eq!(left[0].reasons, ["Eyes closed"]);
}
