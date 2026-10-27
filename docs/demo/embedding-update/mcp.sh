#!/bin/bash
# Call one authoring tool on a customer's MCP endpoint, exactly as an agent
# would: one JSON-RPC `tools/call` over streamable HTTP, the customer's API key
# as its bearer token.
#   mcp.sh <out prefix> <tenant> <tool> ['<json args>']
# Writes <out prefix>.request.json (the JSON-RPC body; the key is a header and
# is not written) and <out prefix>.txt (the tool's text result, verbatim).
set -euo pipefail
WORK="$(cd "$(dirname "$0")" && pwd)/.work"
OUT="$1" TENANT="$2" TOOL="$3" ARGS="${4:-}"
[ -n "$ARGS" ] || ARGS='{}'
BASE="$(cat "$WORK/base")"
KEY="$(jq -r --arg t "$TENANT" '.[$t].crm' "$WORK/keys.json")"
jq -n --arg n "$TOOL" --argjson a "$ARGS" '{jsonrpc: "2.0", id: 1, method: "tools/call", params: {name: $n, arguments: $a}}' >"$OUT.request.json"
curl -s "$BASE/customers/$TENANT/mcp" -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' -d @"$OUT.request.json" \
  | sed -n 's/^data: //p' | jq -r '.result.content[0].text // .error' >"$OUT.txt"
