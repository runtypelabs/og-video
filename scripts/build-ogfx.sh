#!/bin/sh
# Builds crates/ogfx to wasm/ogfx.wasm. Needs Rust with the wasm32-unknown-unknown target and
# binaryen's wasm-opt (brew install binaryen / apt install binaryen).
set -e
cd "$(dirname "$0")/.."
(cd crates/ogfx && RUSTFLAGS="-C target-feature=+simd128" cargo build --release --target wasm32-unknown-unknown)
wasm-opt -O3 -g --strip-dwarf --enable-simd crates/ogfx/target/wasm32-unknown-unknown/release/ogfx.wasm -o wasm/ogfx.wasm
ls -l wasm/ogfx.wasm
