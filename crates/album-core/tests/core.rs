use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};

use album_core::autolayout::{
    apply_layout, crop_loss, cycle_index, rank_layouts, rect_to_mm, Photo,
};
use album_core::document::{effective_dpi, visible_area, Fit, Frame, ProjectSpec, RectMm};
use album_core::pack::{builtin_pack, load_pack_dir, RectPct, TemplateRegistry};

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
    for count in 1..=6 {
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
    assert!(wide.windows(2).all(|w| w[0].crop_loss <= w[1].crop_loss));
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

#[test]
fn full_bleed_edges_reach_past_the_trim_and_inner_edges_do_not() {
    let s = spec();
    let canvas = s.canvas_mm();

    let full = rect_to_mm(
        &RectPct {
            x: 0.0,
            y: 0.0,
            w: 1.0,
            h: 1.0,
        },
        &s,
    );
    assert_eq!(
        full,
        RectMm {
            x: 0.0,
            y: 0.0,
            w: canvas.w,
            h: canvas.h
        }
    );

    // The fold stays in the middle of the canvas, however much bleed there is.
    let left = rect_to_mm(
        &RectPct {
            x: 0.0,
            y: 0.0,
            w: 0.5,
            h: 1.0,
        },
        &s,
    );
    assert!((left.x + left.w - canvas.w / 2.0).abs() < 1e-9);
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
