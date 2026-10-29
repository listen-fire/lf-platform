#!/usr/bin/env bash
# Runs every test corpus with the checks recorder, then folds the harvest
# (./build_fixture.cjs). From packages/legacy-lang:
#
#   checker/harvest/harvest.sh                    # pnpm checks:corpus — assemble target/checks/, then replay it
#   checker/harvest/harvest.sh --assemble         # pnpm checks:assemble — the first half alone (under 10 minutes)
#   checker/harvest/harvest.sh --replay           # pnpm checks:replay — the second half alone, over what --assemble left
#   checker/harvest/harvest.sh --pin --assemble   # pnpm harvest:checks — rewrite the pin, then assemble
#
# The halves are separate so a gate leg capped at ten minutes can run each. Both
# keep the pin unless --pin is given; --pin with --replay is refused, because
# only a harvest can rewrite the pin.
#
# Two passes. The first runs the corpora (the version 1 to 4 conformance
# suites, this package's tests and the engine's) and assembles what it found.
# The second runs the tests that read that corpus (CHECKS_CORPUS=1) and check
# programs of their own made from it: the upgrade loop's rewrites of each
# version 4 program, and the engine oracles' programs respelled to version 5.
# They are pinned too, so their texts are found the same way. Their own
# assertions are about the whole corpus, which the second pass is still
# completing, so they are run (not recorded) once it is complete, last, with
# the checker regression's replay.
#
# A re-harvest rewrites the pin from the first pass alone, before the second
# runs, so the readers see only programs some test writes. They re-check the
# corpus they read; were that the old pin, their re-checks would pin its
# programs again, and a program no test writes would never leave it.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
PACKAGE="$(cd "$HERE/../.." && pwd)"
cd "$PACKAGE"
mode=""
half="both"
for arg in "$@"; do
  case "$arg" in
    --pin) mode="--pin" ;;
    --assemble) half="assemble" ;;
    --replay) half="replay" ;;
    *) echo "usage: $0 [--pin] [--assemble | --replay]" >&2; exit 1 ;;
  esac
done
if [ "$half" = replay ] && [ -n "$mode" ]; then
  echo "--pin rewrites the pin from a harvest; it cannot be combined with --replay" >&2
  exit 1
fi
T="$(mktemp -d)"
JEST=../../node_modules/jest/bin/jest.js
FOLD=(node -r ../../node_modules/ts-node/register/transpile-only checker/harvest/build_fixture.cjs)

harvest() {
  HARVEST_CORPUS="$1" HARVEST_OUT="$T/$1.jsonl" CHECKS_CORPUS="${2:-}" node "$JEST" --config checker/harvest/jest.harvest.cjs
}

if [ "$half" != replay ]; then
  FIRST=(v1 v2 v3 v4 current api-v4 api-current engine)
  for c in "${FIRST[@]}"; do harvest "$c"; done
  first=()
  for c in "${FIRST[@]}"; do first+=("$c=$T/$c.jsonl"); done
  "${FOLD[@]}" "${mode:---partial}" "${first[@]}"

  for c in readers engine-readers; do
    harvest "$c" 1 || echo "($c: its assertions are checked over the complete corpus below)"
  done
  "${FOLD[@]}" ${mode:+"$mode"} "${first[@]}" "readers=$T/readers.jsonl" "engine-readers=$T/engine-readers.jsonl"
fi

if [ "$half" != assemble ]; then
  if [ ! -f ../../target/checks/checks.json ]; then
    echo "no assembled corpus at target/checks/: run the assemble half first" >&2
    exit 1
  fi
  CHECKS_CORPUS=1 node "$JEST" --config jest.config.cjs checker/__test__/checks_regression checker/__test__/upgrade_corpus
  (cd ../legacy-engine && CHECKS_CORPUS=1 node "$JEST" --config jest.config.cjs services/movement_engine/__test__/reachability)
fi
