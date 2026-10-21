#!/usr/bin/env bash
# Check-answer parity: what the language's committed wasm answers the engine
# besides its diagnostics (the stamps it settles on nodes, the import link)
# against the platform's TypeScript (legacy-engine's ts_program_check
# `checkAnswer`), over the checker parity's corpus. Needs reference.jsonl from
# run.sh first.
#
#   packages/legacy-lang/parity/answers.sh
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
PACKAGE="$(cd "$HERE/.." && pwd)"
ROOT="$(cd "$PACKAGE/../.." && pwd)"
WORK="${PARITY_WORK:-$ROOT/target/parity}"
TS_NODE=(node -r "$ROOT/apps/api/node_modules/ts-node/register/transpile-only")
(cd "$PACKAGE" && "${TS_NODE[@]}" parity/answer_reference.ts "$WORK")
(cd "$PACKAGE" && "${TS_NODE[@]}" parity/answer_compare.ts "$WORK")
