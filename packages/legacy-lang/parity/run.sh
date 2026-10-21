#!/usr/bin/env bash
# The parity harness: runs the platform's TypeScript checker (reference.ts)
# and the language's committed wasm (compare.ts, through movement-lang's
# `checkSourceInRust`) over every version 5 program the repository pins, and
# writes the per-code comparison to PARITY.md beside this file. Both checkers
# answer live; the pin's diagnostics are not read. The pin holds no program
# text, so the checks corpus comes from a harvest of the tests that check them
# (`pnpm checks:corpus`, which assembles target/checks/checks.json).
#
#   packages/legacy-lang/parity/run.sh             # harvest, both sides, then the table
#   packages/legacy-lang/parity/run.sh --corpus    # both sides over the corpus the last harvest assembled
#   packages/legacy-lang/parity/run.sh --patterns  # both sides over the engine's pattern programs alone (no harvest)
#   packages/legacy-lang/parity/run.sh --wasm      # the wasm side only, against the last reference
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
PACKAGE="$(cd "$HERE/.." && pwd)"
ROOT="$(cd "$PACKAGE/../.." && pwd)"
WORK="${PARITY_WORK:-$ROOT/target/parity}"
TS_NODE=(node -r "$ROOT/node_modules/ts-node/register/transpile-only")
# The engine's pattern programs are the language's: read from a checkout of
# listen-fire (LISTEN_FIRE_REPO, by default a sibling of this repository).
LANGUAGE_REPO="${LISTEN_FIRE_REPO:-$(cd "$ROOT/.." && pwd)/listen-fire}"
PATTERNS="$LANGUAGE_REPO/crates/movement-engine/tests/oracle/patterns.json"
case "${1:-}" in "" | --corpus | --patterns | --wasm) ;; *) echo "usage: $0 [--corpus | --patterns | --wasm]" >&2; exit 1 ;; esac
mkdir -p "$WORK"
if [ "${1:-}" = "" ]; then
  (cd "$PACKAGE" && checker/harvest/harvest.sh)
fi
# The pattern programs' oracle reaches apps/api modules that read env at
# load: the jest suites' inert defaults stand in.
case "${1:-}" in
  "" | --corpus)
    (cd "$PACKAGE" && "${TS_NODE[@]}" -r "$ROOT/apps/api/src/test/test-env-defaults.ts" parity/reference.ts "$WORK" --checks "$ROOT/target/checks/checks.json" --patterns "$PATTERNS") ;;
  --patterns)
    (cd "$PACKAGE" && "${TS_NODE[@]}" -r "$ROOT/apps/api/src/test/test-env-defaults.ts" parity/reference.ts "$WORK" --patterns "$PATTERNS") ;;
esac
(cd "$PACKAGE" && "${TS_NODE[@]}" parity/compare.ts "$WORK")
