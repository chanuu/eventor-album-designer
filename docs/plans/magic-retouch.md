# Magic Retouch: a photo retouch editor in the album tool

## Context

Studios retouch wedding photos in Photoshop or Lightroom before they design an album. The user wants that done inside the album tool:

- a **Magic Retouch** card on the home screen, to retouch any photos, album or not;
- **right-click any photo on a spread → Open in Magic Retouch**, to fix one album photo while designing;
- a **spot healing tool** and other useful retouch tools;
- the one-click skin retouch planned on 2026-11-17 (smooth, brighten, even), which becomes one tool in this editor.

The user sent a screenshot of another album product's image editor as a reference for the kind of screen: tools down the left, the photo in the middle, settings on the right, Close and Save. It is a feature reference only. The layout and look stay Eventor's own, and none of its artwork, brushes or wording is reused.

Repo: `eventor-album-designer`. Branch `magic-retouch`, from `thank-you-cards`, because it builds on that unpushed work. Commit step by step and do not push until asked. There is no Eventor backend or database change.

## What the photographer gets

### Ways in
- **Home:** a new card, **Magic Retouch**, with a line like "Fix skin, spots and red eyes". It opens a file picker for one or more photos (or a folder), and the editor opens with those photos in a strip at the bottom.
- **Album:** right-click a photo on a spread, or a photo in the photo list → **Open in Magic Retouch**. When done, the album shows the retouched photo everywhere it is used.

There is no right-click menu in the tool today. A small shared `ContextMenu` component is added for this. It opens on right-click, and also from a "⋯" button on the selected photo for trackpads. Esc or a click outside closes it.

### The editor screen (`src/Retoucher.tsx`)
- **Left: tools**, one icon each, with a tooltip and a keyboard key:
  | Tool | Key | What it does |
  |---|---|---|
  | Magic skin | M | One click: smooths, brightens and evens every face's skin (sliders: Smooth, Brighten, Even tone). |
  | Spot healing | J | Paint over a pimple, mark or stray hair; it is replaced with matching skin from around it. |
  | Clone stamp | S | Alt-click a source, then paint to copy it, for things healing gets wrong (a sign behind a head, a wire). |
  | Smooth brush | B | Paint smoothing only where you want it, at your chosen strength. |
  | Brighten / Darken | O | Lift under-eye circles or a face in shadow, or calm a shiny forehead. Alt switches between them. |
  | Whiten | W | Teeth and the whites of eyes: removes yellow and lifts a little, keeping texture. |
  | Red eye | R | Click an eye; the red pupil turns natural dark. |
  | Zoom / Hand | Z / H | Zoom with the wheel, and drag to pan. |
- **Centre:** the photo, with zoom (fit, 100%, wheel) and pan. A brush cursor shows its size and softness.
- **Right: settings** for the chosen tool: Size, Softness and Strength for the brushes, the three sliders for Magic skin, and one plain sentence on what the tool does.
- **Right, below the tool settings: a Lightroom-style Colour panel**, in collapsible sections. It is always available, whatever tool is chosen:
  - **White balance:** Temperature and Tint, plus a white-balance eyedropper (click something that should be neutral grey or white).
  - **Tone:** Exposure, Contrast, Highlights, Shadows, Whites and Blacks.
  - **Presence:** Vibrance and Saturation.
  - **Colour mixer (HSL):** Hue, Saturation and Luminance for eight colours, with a "point and drag" mode: drag up or down on the photo to change the colour under the pointer.
  - **Colour grading:** three colour wheels (Shadows, Midtones and Highlights) with a Luminance slider each, plus Blending and Balance, for warm skin, teal shadows and other wedding looks.
  - **Auto** (the existing Auto colour and levels), **Black and white** and **Reset**.
  - **Copy / Paste settings**, to apply one photo's colour to the next in the strip, or to every selected album photo.

  All but the eyedropper, point-and-drag and colour grading already exist in `Adjustments` (`crates/album-core/src/adjust.rs`) and `src/EffectsPanel.tsx`, so the panel reuses them. The values are the photo's existing `adjust`, so they show the same in the album and the editor.
- **Bottom bar:** Undo / Redo (Ctrl+Z / Ctrl+Shift+Z), a **before/after** drag split and a press-and-hold "\" for the original, **Reset photo**, then **Close** and **Save**.
- **Strip** of the other open photos in Home mode; arrow keys move between them. Unsaved changes are asked about before leaving a photo.

### Where results go: originals are never changed
- **Album:** each photo keeps its original file, plus its list of retouch edits. The album preview and the print export draw the retouched photo. Reopening the editor shows the same edits, still undoable, and **Reset photo** goes back to the original.
- **Home mode:** **Save** writes a full-size JPEG (quality 95, EXIF orientation applied) to a `Retouched` folder beside the original, with the same file name, so photographers find it next to their shoot. Next to it goes a small `<name>.retouch.json` holding the edits, so opening that photo again in Magic Retouch picks them back up.
- Nothing ever writes over a camera original.

## Approach

### 1. The edit list (`crates/album-core/src/retouch/edits.rs`)
- `RetouchEdits { magic: SkinSettings, strokes: Vec<Stroke> }`, serde with defaults. It goes on `PhotoInfo` as `retouch: Option<RetouchEdits>` (`#[serde(default)]`), so old album files open unchanged.
- `Stroke { tool, points, radius, softness, strength, clone_offset }`. Points and radius are a share of the photo (0–1), so the same edits apply at preview size and at full print size.
- Undo/redo is the edit list itself (pop and re-push). It reuses the pattern in `src/history.ts`.

### 2. The renderer (`crates/album-core/src/retouch/`, pure Rust, no models)
`apply_edits(image, edits, skin: Option<&SkinMap>)` runs the magic skin first, then each stroke in order:
- **Spot healing:**
  1. Build the stroke's mask.
  2. Search nearby offsets (rings at 1.5–4× the brush size, 32 directions) for the patch whose surrounding border best matches.
  3. Copy it in and blend it with a gradient-domain (Poisson) fill over the small region, so brightness and colour join seamlessly.
- **Clone stamp:** copy from the offset and feather by the brush softness.
- **Smooth brush:** the same log-brightness frequency separation as Magic skin, limited to the brushed mask.
- **Brighten / Darken:** a curve on log brightness inside the mask.
- **Whiten:** reduce yellow (Cb towards neutral) and lift lightness a little inside the mask.
- **Red eye:** inside the click radius, find strongly red pixels (red well above green and blue), then desaturate and darken them, feathered.
- Every brush's softness is a smooth falloff, and strength scales the result.

### 3. Magic skin (`crates/album-media/src/skin.rs`, `crates/album-core/src/retouch/skin.rs`)
This is the earlier skin plan, unchanged in method:
- **Faces:** found with the existing YuNet and 478-point mesh from `eyes.rs`. The mesh step is shared, so `eye_openness` reads from it.
- **`SkinMap`:** per face, the face outline, holes for the eyes, brows and lips, the sampled skin colour and the face width. It is cached as `<id>.skin-v1`.
- **Skin mask:** the face, plus neck, arms and hands nearby where the colour matches. It passes the hard "never blue, always a little red" gate, and is feathered by about 2% of the face width.
- **Smooth:** a guided filter on log brightness. Its radius is about 3% of the face width, and its edge threshold grows with the slider. Mid-frequency blemishes go first; fine pores fade out only above 0.5.
- **Even:** pull colour towards the local average (a wide blur), so shading survives.
- **Brighten:** a gentle lift with slightly less red.

### 3b. Colour grading and the colour panel extras
- **Colour grading** in `adjust.rs`. Add `grade_shadows`, `grade_midtones` and `grade_highlights` (each hue in degrees, saturation 0–1 and luminance −1–1), plus `grade_blending` and `grade_balance`, all `#[serde(default)]` so old albums open unchanged.
  - Each pixel's brightness gives its weight in each of the three ranges. Smooth weights are shaped by Balance (which moves the split point) and Blending (how much the ranges overlap).
  - The chosen tint is added in a way that keeps the pixel's brightness. Luminance shifts that range up or down.
  - It runs in `apply_rgb` after white balance and tone, and before saturation, so the preview and export stay one function. The query form grows to match, and the old lengths still parse.
- **White-balance eyedropper:** a Tauri command samples a 5×5 average at the click on the unadjusted preview. It then solves for the Temperature and Tint that make that sample neutral, reusing the maths in `auto_adjust` (`crates/album-media/src/analyze.rs`).
- **Point and drag:** the editor reads the colour under the pointer and finds its band weights (`band_weights` in `adjust.rs`). Dragging changes those bands' HSL values in proportion.
- **UI:** split `EffectsPanel.tsx` into reusable sections, so the album's Effects panel and the editor share the same sliders. Add `ColourWheel.tsx`, a round hue and saturation picker, keyboard accessible, double-click to reset. Copy and paste settings use `adjust` only, never retouch strokes.

### 4. Hooking it in
- **Preview:** `album-media/src/lib.rs` makes a retouched preview, cached by photo id plus a hash of the edits, so every view (spread, strip, the published album's export) uses it without recomputing.
- **Export:** `album-export/src/lib.rs` runs `apply_edits` on the full-resolution decode before `crop_and_resize`.
- **Tauri commands in `src-tauri/src/main.rs`:**
  - `retouch_preview(photo, edits) -> jpeg`, for the editor, at about screen size;
  - `prepare_skin(photo) -> faces_found`;
  - `set_photo_retouch(photo_id, edits)`, for the album;
  - `open_for_retouch(paths)` and `save_retouched(path, edits)`, for Home mode, which writes the `Retouched` copy and the json.
- **Live brushing:** the stroke is drawn on a canvas overlay while the mouse is down. When it is released, the stroke is sent to Rust and the rendered result replaces the overlay. Brushing therefore always feels instant, and the result is exactly what prints.

### 5. Screens
- `Home.tsx`: the Magic Retouch card, and `App.tsx` routes to the `Retoucher` screen.
- `Designer.tsx` and `Workspace.tsx`: the right-click menu on photos → Open in Magic Retouch. The editor opens over the workspace; on Save the photo's edits are stored and the spread refreshes.
- `ContextMenu.tsx` (new, small, keyboard accessible).
- `api.ts`: the new commands and the `RetouchEdits` type.

## Not in this round
- Removing a background or cutting a person out (the reference editor's eraser). That is a different job and needs a segmentation model.
- Reshaping or slimming, eye enlarging and makeup tools.
- An AI retouch model. The classic methods above run offline and fast. A model can come later if results fall short.
- Crop and straighten in the editor; frames already crop in the album.
- Retouching in the client portal or web album.

## Commits (in order)
1. The edit list on `PhotoInfo`, and the renderer for healing, clone, brushes and red eye, with tests.
2. Face mesh points shared with `eyes.rs`, `skin.rs` with the `SkinMap` cache, and Magic skin, with tests.
3. Retouched previews and export, plus the Tauri commands, including Home-mode save to `Retouched/`.
4. `ContextMenu` and the right-click "Open in Magic Retouch" in the album.
5. Colour grading in `adjust.rs`, with tests, and the white-balance eyedropper command.
6. The `Retoucher` screen: tools, settings, the Colour panel (shared sections, wheels, point and drag, copy and paste), zoom and pan, undo, before/after, Save and Close.
7. The Home card and the multi-photo strip.

## Verification
- `cargo test --workspace`, with existing tests passing (old albums read as no change). New tests:
  - a photo with no edits is byte-identical;
  - healing a dark dot on smooth skin leaves no visible dot and no seam (low local variance across the patch edge);
  - the clone stamp copies the source exactly at full strength;
  - red eye turns a red disc dark and leaves a nearby red flower alone (outside the radius);
  - edits look the same at preview size and print size once scaled;
  - Magic skin: no face means no change; eyes and lips untouched; the background is unchanged.
  - Colour grading: zero grading is byte-identical; a shadow tint changes dark pixels and leaves white alone; a highlight tint the reverse; brightness is kept; an old album file reads as no grading.
  - The eyedropper on a warm grey patch gives Temperature and Tint that make it neutral.
- Test photos:
  - `crates/album-media/testdata` has only two fair-skinned faces. Add a freely licensed dark-skinned portrait, with its licence in `testdata/README.md`.
  - The user's reference photo is used to judge the look locally only, never committed.
- `npx tsc --noEmit`.
- App test over CDP (`app-test/retouch.mjs`):
  1. Home → Magic Retouch → open two photos.
  2. Heal a spot, run Magic skin, Undo and Redo.
  3. Save, and check that `Retouched/<name>.jpg` and the json exist and the original is unchanged.
  4. Reopen the photo and see its edits.
  5. In an album, right-click a photo → Open in Magic Retouch → heal → Save. Check the spread preview changed.
  6. Export, and check the pixels changed only where edited.
- Re-run `cover.mjs`, `publish.mjs` and `cards.mjs`.
- Before/after sheets of each tool on the test photos, sent to the user.
- Rebuild the real-Eventor debug copy for the user to try.
