# Feature roadmap

What the album designer should do, in the order to build it. It extends the
milestones in the original plan.

## Status

Built: album setup, photo import, auto-layout, a first Auto Build that fills spreads in
file name order, tone and colour effects, saving, undo, the print check and JPG and PDF
export.

Still to build from the first milestones: saved presets, star ratings and colour labels,
quick preview, changing one page on its own, rotation, and an album overview. Effects
still need whites, blacks, fade, the colour mixer and selective colour.

The feature ideas come partly from studying AR ALBUM, a competing app. Ideas and
workflows are fine to learn from. Its layouts, text designs, code, names and look are
not ours to reuse, so everything here gets its own design and original content.

## Milestone 1: design and export locally

No login or cloud.

### New album
- Couple names and wedding date
- Binding: lay-flat (thick pages, fewer spreads) or magazine (thin pages, more spreads)
- Size presets, plus a custom size in inches or cm
- Margin, gap, bleed, print DPI and paper colour, with a live preview
- Layout filters: straight corners only, inside the margins, no photo on top of a photo
- Saved presets for a studio's usual settings
- Recent albums on the start screen

### Photos
- Import a folder or individual photos
- Thumbnail grid with a size slider, search and sorting
- Filter by all, used, unused, missing or rated
- Star ratings and colour labels
- Used and unused counts
- Quick preview with the space bar
- Replace a photo, show it in File Explorer, and relink moved files

### Layout
- Spread timeline with drag to reorder
- Add selected photos to a spread, or as a new spread
- Layout picked automatically by photo count, with next and previous alternatives
- Change the left or right page on its own
- Mirror a spread, redesign a spread, duplicate a layout
- Zoom and reposition within a frame, swap photos, reset crop
- Rotate in small steps, flip
- Album overview showing every spread
- Undo and redo
- Keyboard shortcuts for everything common, and a way to change them

### Print check
- Live DPI on each photo, with low-resolution frames marked in red
- Overlays for the safe area, fold and low resolution, with a legend
- Design check before export: empty frames, empty spreads, a photo used twice,
  content across the fold, and missing originals

### Export
- JPG per spread at the album's DPI, with quality options
- PDF for labs that want one
- File naming that follows the lab's rules

## Milestone 2: smarter building

- Auto Build for a whole album: a style, a spread count, photos per spread and how
  often a layout may repeat
- Group photos by time, and start a new spread at each part of the day
- Correct the clocks between cameras
- Keep black and white photos together
- Leave out blurry and closed-eye photos, and keep the best of similar shots
- A choice between using every photo and only the best ones
- All analysis stays on the computer, and photos are never uploaded for it

The original plan left this out of the first version. It's a large feature, and it
depends on the photo pipeline from milestone 1.

## Milestone 3: designer tools

- Text on spreads, including Sinhala and Tamil
- Free placement of boxes, with guides and snapping
- Backgrounds: colour, pattern or photo, for one page or both
- Page borders
- Tone adjustments: exposure, contrast, highlights, shadows, whites, blacks and fade
- Colour: temperature, tint, vibrance, saturation, a colour mixer and black and white
- Adjust one photo or a whole spread, and copy adjustments between photos
- Open a photo in Photoshop
- Layered PSD export
- Save your own layouts as templates, and share them as packs
- Original text and graphic packs

Fonts need checking first, because most commercial fonts don't allow being embedded
in or shipped with an app.

## Milestone 4: Eventor connection

This is what a standalone app can't offer, so it should be the main reason to choose
this tool.

- Sign in with an Eventor account
- Open a job and import the photos the client selected
- Match those photos to the full-size originals on the computer
- Publish spreads to the client flipbook in the portal
- Client proofs with comments on each spread and an approval step, kept with the job
- The job's task board updates as the album moves through design and proofing
- Access controlled by the studio's Eventor plan

## Release requirements

Needed before any studio installs it, not at the end:

- **Code signing:** an unsigned installer triggers SmartScreen and antivirus warnings,
  and studios shouldn't be told to click through them
- **Installer:** includes everything, so it doesn't download parts during setup
- **Updates and crash reports:** a desktop app can't be fixed from a server

## Print settings

| Setting | Options | Default |
|---|---|---|
| Size, height x open width (in) | 12x30, 12x36, 12x28, 12x24, 12x20, 12x18, 12x16, 15x24, 16x24, 17x24, 10x30, 10x28, 10x24, 10x22, 10x20, 10x15, 8x30, 8x24, 8x22, 8x20, 8x18, 8x16, or custom | 12x30 |
| Bleed | 0, 2, 3 or 5 mm | 3 mm |
| Print DPI | 200, 254, 300 or 400 | 300 |
| Margin | None, 0.2, 0.35 or 0.6 in, or a slider | 0.35 in |
| Gap | None, 0.05, 0.1 or 0.2 in, or a slider | 0.1 in |
| Paper | White, two creams, grey, charcoal or black | White |
| DPI warning | Below 220 is low, below 150 is too low | |

The defaults are starting points. They should be replaced with the lab's real
requirements, which are still needed: file format, bleed, colour, allowed page counts,
paper thickness and file naming.
