//! Digital Logic Sim simulation engine in Rust.
//!
//! Same semantics as the TypeScript port of the original simulator (src/dls/simulation/Simulator.ts), plus:
//! - a compiled flat program for the common (non-reorder) frames (program.rs)
//! - exact truth tables for combinational custom chips (tables.rs)
//!
//! Built natively for tests/benchmarks and as a WebAssembly module for the browser (api.rs).
pub mod audio;
pub mod desc;
pub mod engine;
pub mod program;
pub mod rng;
pub mod tables;

#[cfg(target_arch = "wasm32")]
pub mod api;

pub use desc::{Command, SimChipDesc};
pub use engine::Engine;
