use super::*;

/// A skin-like test picture: a warm tone with gentle shading and fine grain.
fn skin(w: usize, h: usize) -> Vec<u8> {
    let mut px = Vec::with_capacity(w * h * 3);
    for y in 0..h {
        for x in 0..w {
            let shade = 0.85 + 0.15 * (x as f32 / w as f32);
            // Grain from a cheap hash, the same at any position on every run.
            let n = ((x * 73 + y * 151) % 17) as f32 / 17.0 - 0.5;
            let base = [200.0, 150.0, 125.0];
            for c in base {
                px.push(((c * shade) + n * 6.0).clamp(0.0, 255.0) as u8);
            }
        }
    }
    px
}

fn at(px: &[u8], w: usize, x: usize, y: usize) -> [u8; 3] {
    let i = (y * w + x) * 3;
    [px[i], px[i + 1], px[i + 2]]
}

fn put_disc(px: &mut [u8], w: usize, cx: usize, cy: usize, r: usize, colour: [u8; 3]) {
    let h = px.len() / 3 / w;
    for y in cy.saturating_sub(r)..(cy + r + 1).min(h) {
        for x in cx.saturating_sub(r)..(cx + r + 1).min(w) {
            let d = ((x as f32 - cx as f32).powi(2) + (y as f32 - cy as f32).powi(2)).sqrt();
            if d <= r as f32 {
                let i = (y * w + x) * 3;
                px[i..i + 3].copy_from_slice(&colour);
            }
        }
    }
}

fn dab(tool: Tool, x: f64, y: f64, radius: f64) -> Stroke {
    Stroke {
        tool,
        points: vec![[x, y]],
        radius,
        softness: 0.4,
        strength: 1.0,
        source: None,
    }
}

fn edits(strokes: Vec<Stroke>) -> RetouchEdits {
    RetouchEdits {
        strokes,
        ..Default::default()
    }
}

#[test]
fn no_edits_leave_the_photo_exactly_as_it_was() {
    let mut px = skin(64, 48);
    let before = px.clone();
    apply_edits(&mut px, 64, 48, &RetouchEdits::default());
    assert_eq!(px, before);
}

#[test]
fn healing_removes_a_spot_without_leaving_a_seam() {
    let (w, h) = (160, 120);
    let mut px = skin(w, h);
    let clean = px.clone();
    put_disc(&mut px, w, 80, 60, 4, [90, 40, 40]);
    apply_edits(
        &mut px,
        w,
        h,
        &edits(vec![dab(Tool::Heal, 0.5, 0.5, 8.0 / 160.0)]),
    );

    // The spot is gone: its centre is back close to the skin around it.
    let healed = at(&px, w, 80, 60);
    let expected = at(&clean, w, 80, 60);
    for c in 0..3 {
        assert!(
            (i32::from(healed[c]) - i32::from(expected[c])).abs() < 14,
            "spot remains: {healed:?} vs {expected:?}"
        );
    }
    // No seam: across the brush's edge, neighbours differ no more than the grain does.
    for x in 66..95 {
        let a = at(&px, w, x, 51);
        let b = at(&px, w, x, 52);
        assert!(
            a.iter().zip(b).all(|(p, q)| p.abs_diff(q) < 16),
            "seam at {x}: {a:?} {b:?}"
        );
    }
    // Far away, nothing changed.
    assert_eq!(at(&px, w, 5, 5), at(&clean, w, 5, 5));
}

#[test]
fn a_full_strength_hard_clone_copies_the_source_exactly() {
    let (w, h) = (100, 100);
    let mut px = skin(w, h);
    put_disc(&mut px, w, 70, 50, 6, [10, 200, 30]);
    let mut stroke = dab(Tool::Clone, 0.3, 0.5, 0.05);
    stroke.softness = 0.0;
    stroke.source = Some([0.4, 0.0]);
    apply_edits(&mut px, w, h, &edits(vec![stroke]));
    assert_eq!(at(&px, w, 30, 50), [10, 200, 30]);
}

#[test]
fn a_clone_stamp_without_a_source_does_nothing() {
    let mut px = skin(50, 50);
    let before = px.clone();
    apply_edits(
        &mut px,
        50,
        50,
        &edits(vec![dab(Tool::Clone, 0.5, 0.5, 0.1)]),
    );
    assert_eq!(px, before);
}

#[test]
fn red_eye_darkens_the_pupil_and_spares_red_outside_the_click() {
    let (w, h) = (120, 80);
    let mut px = skin(w, h);
    put_disc(&mut px, w, 40, 40, 5, [210, 30, 35]);
    put_disc(&mut px, w, 100, 40, 5, [210, 30, 35]); // a red flower, not clicked
    apply_edits(
        &mut px,
        w,
        h,
        &edits(vec![dab(Tool::RedEye, 40.0 / 120.0, 0.5, 8.0 / 120.0)]),
    );
    let pupil = at(&px, w, 40, 40);
    assert!(
        pupil[0] < 60 && pupil[0].abs_diff(pupil[1]) < 12,
        "still red: {pupil:?}"
    );
    assert_eq!(at(&px, w, 100, 40), [210, 30, 35]);
    // Skin inside the click is not red enough to be touched.
    let skin_px = skin(w, h);
    assert_eq!(at(&px, w, 40, 33), at(&skin_px, w, 40, 33));
}

#[test]
fn brighten_and_darken_change_light_but_keep_the_colour() {
    let (w, h) = (60, 60);
    let original = skin(w, h);
    for (tool, lighter) in [(Tool::Brighten, true), (Tool::Darken, false)] {
        let mut px = original.clone();
        apply_edits(&mut px, w, h, &edits(vec![dab(tool, 0.5, 0.5, 0.2)]));
        let (a, b) = (at(&original, w, 30, 30), at(&px, w, 30, 30));
        assert_eq!(b[0] > a[0], lighter, "{tool:?}: {a:?} -> {b:?}");
        // Still warmer than it is blue: red stays the largest channel.
        assert!(b[0] > b[2]);
    }
}

#[test]
fn whitening_takes_out_yellow() {
    let (w, h) = (40, 40);
    let mut px = vec![0u8; w * h * 3];
    for p in px.chunks_mut(3) {
        p.copy_from_slice(&[220, 200, 140]); // yellowed tooth
    }
    apply_edits(
        &mut px,
        w,
        h,
        &edits(vec![dab(Tool::Whiten, 0.5, 0.5, 0.3)]),
    );
    let [r, g, b] = at(&px, w, 20, 20);
    assert!(
        i32::from(r) - i32::from(b) < 50,
        "still yellow: {r} {g} {b}"
    );
}

#[test]
fn smoothing_reduces_grain_only_under_the_brush() {
    let (w, h) = (120, 120);
    let original = skin(w, h);
    let mut px = original.clone();
    apply_edits(
        &mut px,
        w,
        h,
        &edits(vec![dab(Tool::Smooth, 0.5, 0.5, 0.2)]),
    );
    let spread = |p: &[u8], x0: usize| {
        let values: Vec<f32> = (x0..x0 + 10)
            .map(|x| f32::from(at(p, w, x, 60)[1]))
            .collect();
        let mean = values.iter().sum::<f32>() / values.len() as f32;
        values.iter().map(|v| (v - mean).powi(2)).sum::<f32>() / values.len() as f32
    };
    assert!(spread(&px, 55) < spread(&original, 55) * 0.5);
    assert_eq!(at(&px, w, 5, 5), at(&original, w, 5, 5));
}

#[test]
fn the_same_edits_look_the_same_at_preview_and_print_size() {
    let stroke = dab(Tool::Brighten, 0.5, 0.5, 0.1);
    let flat = |w: usize, h: usize| vec![120u8; w * h * 3];
    let mut small = flat(100, 80);
    let mut large = flat(400, 320);
    apply_edits(&mut small, 100, 80, &edits(vec![stroke.clone()]));
    apply_edits(&mut large, 400, 320, &edits(vec![stroke]));
    for (sx, sy) in [(50, 40), (55, 40), (58, 40), (50, 47)] {
        let a = at(&small, 100, sx, sy);
        let b = at(&large, 400, sx * 4 + 2, sy * 4 + 2);
        assert!(a[0].abs_diff(b[0]) <= 6, "at {sx},{sy}: {a:?} vs {b:?}");
    }
}

#[test]
fn bad_strokes_from_a_file_are_dropped_or_limited() {
    let wild = RetouchEdits {
        strokes: vec![
            Stroke {
                radius: f64::NAN,
                ..dab(Tool::Heal, 0.5, 0.5, 0.1)
            },
            Stroke {
                points: vec![],
                ..dab(Tool::Heal, 0.5, 0.5, 0.1)
            },
            Stroke {
                points: vec![[f64::INFINITY, 0.5]],
                ..dab(Tool::Heal, 0.5, 0.5, 0.1)
            },
            Stroke {
                radius: 50.0,
                strength: 9.0,
                ..dab(Tool::Brighten, 0.5, 0.5, 0.1)
            },
        ],
        ..Default::default()
    }
    .sanitized();
    assert_eq!(wild.strokes.len(), 1);
    assert_eq!(wild.strokes[0].radius, MAX_RADIUS);
    assert_eq!(wild.strokes[0].strength, 1.0);
    // And drawing it all is safe on any buffer, including a wrong-sized one.
    let mut px = skin(20, 20);
    apply_edits(&mut px, 20, 20, &wild);
    apply_edits(&mut px, 21, 20, &wild);
}

#[test]
fn an_edit_list_reads_back_from_json_with_defaults() {
    let read: RetouchEdits =
        serde_json::from_str(r#"{"strokes":[{"tool":"heal","points":[[0.2,0.3]],"radius":0.01}]}"#)
            .unwrap();
    assert_eq!(read.strokes[0].softness, 0.5);
    assert_eq!(read.strokes[0].strength, 1.0);
    let empty: RetouchEdits = serde_json::from_str("{}").unwrap();
    assert!(empty.is_empty());
}
