//! The album designer's core: what a design is, and how layouts are chosen.
//!
//! This crate does no file decoding, drawing or networking, so everything in it can
//! be tested without a window or a photo. The only I/O is reading layout packs.

pub mod adjust;
pub mod autobuild;
pub mod autolayout;
pub mod document;
pub mod pack;

mod builtin_list;
