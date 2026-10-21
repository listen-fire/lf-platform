#!/usr/bin/env bash
# Rebuilds the two committed movement artifacts and prints each one's sha256
# and size:
#
#  - movement.wasm, from crates/movement-engine (which links in
#    crates/movement-parser): the parser and the engine, which the API loads;
#  - movement_parser.wasm, from crates/movement-parser alone: the parser, the
#    lowering and the catalog, which the browser loads (it never runs a
#    movement, so it never downloads the engine).
#
# CI (.github/workflows/movement-wasm.yml) runs this and fails if either
# differs from what is committed, so commit both with any change to either
# crate, the lockfile, the profile or the toolchain.
#
# Two things differ on a macOS machine, and the script handles both so a
# rebuild there reproduces CI's bytes with no environment of its own:
#
#  - the pinned toolchain's `rust-lld` cannot find `libLLVM.dylib` (it looks
#    beside itself; the library sits in the toolchain's `lib`), so linking
#    fails. On macOS the build links through a `rust-lld` wrapper that sets
#    DYLD_LIBRARY_PATH (macOS drops that variable on its way into a script,
#    so only a wrapper can set it for the linker).
#  - an installed `rust-src` component makes rustc name the standard
#    library's sources by their local path instead of `/rustc/<commit>`, and
#    panic strings carry that path into the artifact. The remap below maps it
#    back on every machine (where `rust-src` is absent, as on CI, it matches
#    nothing).
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CARGO_HOME_DIR="${CARGO_HOME:-$HOME/.cargo}"

cd "$ROOT_DIR"
# Panic-location strings embed source paths; remapping the machine-specific
# prefixes is what lets a CI rebuild reproduce a laptop's bytes.
#
# The shadow stack goes first in linear memory (`--stack-first`, also rustc's
# default for this target) so an overflow traps instead of silently
# overwriting static data, and is 2 MiB: at the parser's depth limit
# (MAX_DEPTH in crates/movement-parser/src/lexer.rs) the deepest texts need
# between 512 and 768 KiB of it (measured 2026-10-06), so about a third.
SYSROOT="$(rustc --print sysroot)"
RUSTC_COMMIT="$(rustc -vV | sed -n 's/^commit-hash: //p')"
RUSTFLAGS="--remap-path-prefix=$ROOT_DIR=/listen-fire --remap-path-prefix=$CARGO_HOME_DIR=/cargo --remap-path-prefix=$SYSROOT/lib/rustlib/src/rust=/rustc/$RUSTC_COMMIT -C link-arg=--stack-first -C link-arg=-zstack-size=2097152"
export RUSTFLAGS
# Cargo's per-crate hashes depend on the build machine's target triple; the
# wrapper replaces them for the wasm crates (see its header). It takes the
# place of any wrapper set in the environment.
#
# The build has a target directory of its own: cargo does not see what the
# wrapper changes, so in a directory shared with builds made without it, it
# would reuse their dependencies, hashes and all.
RUSTC_WRAPPER="$ROOT_DIR/scripts/build-movement-wasm-rustc.sh"
CARGO_TARGET_DIR="$ROOT_DIR/target/movement-wasm"
export RUSTC_WRAPPER CARGO_TARGET_DIR

if [ "$(uname -s)" = "Darwin" ]; then
  # Named `rust-lld` so rustc still reads it as the wasm lld flavour.
  linker_dir="$CARGO_TARGET_DIR/macos-linker"
  mkdir -p "$linker_dir"
  host="$(rustc -vV | sed -n 's/^host: //p')"
  cat > "$linker_dir/rust-lld" <<WRAPPER
#!/bin/sh
DYLD_LIBRARY_PATH="$SYSROOT/lib" exec "$SYSROOT/lib/rustlib/$host/bin/rust-lld" "\$@"
WRAPPER
  chmod 755 "$linker_dir/rust-lld"
  CARGO_TARGET_WASM32_UNKNOWN_UNKNOWN_LINKER="$linker_dir/rust-lld"
  export CARGO_TARGET_WASM32_UNKNOWN_UNKNOWN_LINKER
fi
cargo build --locked --release --target wasm32-unknown-unknown -p listen-fire-engine
cargo build --locked --release --target wasm32-unknown-unknown -p listen-fire-parser

WASM_DIR="$ROOT_DIR/packages/movement-lang/wasm"
for artifact in movement_engine:movement movement_parser:movement_parser; do
  built="${artifact%%:*}"
  out="$WASM_DIR/${artifact##*:}.wasm"
  cp "$CARGO_TARGET_DIR/wasm32-unknown-unknown/release/$built.wasm" "$out"
  chmod 644 "$out"
  if command -v sha256sum >/dev/null; then
    sha256sum "$out"
  else
    shasum -a 256 "$out"
  fi
  echo "raw $(wc -c < "$out" | tr -d ' ') bytes, gzipped $(gzip -9 -c "$out" | wc -c | tr -d ' ') bytes"
done
