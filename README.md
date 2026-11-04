# Eventor Album Designer

A desktop app for designing photo albums, built with Rust and Tauri. A photographer
selects photos, gets a layout picked automatically for that number of photos,
switches between alternatives, and exports press-ready files for the lab. Designs can
later be published to the client flipbook in Eventor.

## Status

Milestone 1 is in progress. So far there is only `crates/album-core`:

- the design document and the crop maths
- layout packs, loaded as data and validated as untrusted input
- auto-picking a layout by photo count and shape
- the built-in pack, `eventor-essentials`, with 19 layouts for 1 to 6 photos

There is no app window, photo import or export yet.

## Setup on Windows

1. Install Rust from <https://rustup.rs>.
2. In Visual Studio Installer, add the **Desktop development with C++** workload.
   Tauri needs it to build.

```
cargo test
```

Until the C++ tools are installed, `album-core` can be tested with the GNU toolchain:

```
rustup toolchain install stable-x86_64-pc-windows-gnu
cargo +stable-x86_64-pc-windows-gnu test
```

## Layout packs

A pack is a folder containing `pack.toml` and `templates/*.json`. Frame positions are
fractions of the trimmed open spread, so one pack suits every album size. See
`crates/album-core/packs/eventor-essentials` for an example.

Packs are data and can never run code. A template with an unknown field, such as a
script hook, is rejected. Bundled layouts must be original work or properly licensed.
