# Eventor Album Designer

A desktop app for designing photo albums, built with Rust and Tauri. A photographer
selects photos, gets a layout picked automatically for that number of photos,
switches between alternatives, and exports press-ready files for the lab. Designs can
later be published to the client flipbook in Eventor.

## Status

Milestone 1 is in progress. The app runs, and you can:

- set up an album: size, binding, margin, gap, bleed, DPI and paper
- import a folder of photos, with previews made on demand
- lay out a whole album with Auto Build, or select photos and get a layout picked
  automatically, then switch with `[` and `]`
- drag photos onto a spread, swap them, zoom and reposition them, and reorder spreads
- adjust tone and colour for one photo or a whole spread, as previewed by the same code
  that prints
- see the print DPI of each photo, with print guides for the trim, safe area and fold
- save and reopen albums, undo and redo, and find originals that have moved
- export JPGs and a PDF for the lab, with a check for problems first

Auto Build does not judge photos yet. See
[docs/feature-roadmap.md](docs/feature-roadmap.md) for what comes next.

## Setup on Windows

1. Install Rust from <https://rustup.rs>, Node.js, and pnpm.
2. Install the C++ tools, which Tauri needs to build. Close Visual Studio first:

   ```
   winget install --id Microsoft.VisualStudio.2022.BuildTools --override "--passive --wait --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
   ```

3. Install the packages and start the app:

   ```
   pnpm install
   pnpm tauri dev
   ```

The first build takes several minutes.

## Tests

```
cargo test --workspace
```

## Layout of the code

- `crates/album-core`: the design document, layout packs and auto-layout. No UI.
- `crates/album-media`: finding photos and making preview copies. Originals are never
  changed.
- `crates/album-store`: saving and opening album files.
- `crates/album-export`: rendering spreads from the originals and writing print files.
- `src-tauri`: the desktop app, which connects these to the screens.
- `src`: the screens, in React.

## Layout packs

A pack is a folder containing `pack.toml` and `templates/*.json`. Frame positions are
fractions of the trimmed open spread, so one pack suits every album size. See
`crates/album-core/packs/eventor-essentials` for an example.

Packs are data and can never run code. A template with an unknown field, such as a
script hook, is rejected. Bundled layouts must be original work or properly licensed.
