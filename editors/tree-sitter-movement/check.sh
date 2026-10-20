#!/usr/bin/env bash
# Regenerates the parser and parses every .mvt in the repository (plus any
# directories given as arguments). Fails when a file has an ERROR or MISSING
# node: the grammar then needs widening (it is for highlighting; `lf check`
# decides what is valid). Needs the tree-sitter CLI.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
# ABI 14: older editors (Zed before tree-sitter 0.25) panic on ABI 15.
(cd "$here" && tree-sitter generate --abi 14)
failed=0
count=0
while IFS= read -r file; do
  count=$((count + 1))
  # tree-sitter exits non-zero on a bad parse; the tree is what is judged.
  tree="$(tree-sitter parse -p "$here" "$file" 2>/dev/null || true)"
  if grep -qE 'ERROR|MISSING' <<<"$tree"; then
    echo "does not parse cleanly: $file"
    failed=1
  fi
done < <(find "$repo" "$@" -name '*.mvt' -not -path '*/node_modules/*' -not -path "$repo/.claude/*")
echo "$count files parsed"
exit $failed
