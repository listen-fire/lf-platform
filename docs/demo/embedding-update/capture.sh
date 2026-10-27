#!/bin/bash
# The embedding update demo (see README.md): listen-fire as a library inside a
# small demo product of our own (host/), built on @listen-fire/embed from a
# listen-fire checkout. One customer, Brightline Freight, whose Company has
# Stage and Onboarding selects of its own and a Slack workspace (a fake). Its
# agent authors an automation over the customer's MCP endpoint: when a deal's
# Stage becomes Won, set the same record's Onboarding and post to #deals. Then
# a person changes the record through the product's own route: Stage to Won
# fires one run in the product's process, which updates the record and posts;
# a change to Owner alone fires nothing.
# Every output lands in .work/capture/, which build_data.cjs turns into the
# video's data.js in the site repo. Re-runnable: each run starts from nothing.
#
#   LF_SRC  a listen-fire checkout with examples/embed-saas and its packages
#           installed (default: the listen-fire checkout beside this repo).
#           The product runs on that example's node_modules, so on the
#           checkout's own packages. Its version, branch and commit are recorded.
#
# No model is reached: the automation makes no model call.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
WORK="$HERE/.work"
CAP="$WORK/capture"
LF_SRC="$(cd "${LF_SRC:-$REPO/../listen-fire}" && pwd)"
EX="$LF_SRC/examples/embed-saas"
NAME="Kick off won deals"
TENANT="$(jq -r .tenant "$HERE/programs/tenant.json")"

rm -rf "$WORK"
mkdir -p "$CAP/host" "$WORK/fake" "$WORK/product"

PIDS=()
cleanup() { for pid in "${PIDS[@]+"${PIDS[@]}"}"; do kill "$pid" 2>/dev/null || true; done; wait 2>/dev/null || true; }
trap cleanup EXIT INT TERM

# What was built from: the core's version, the embed package's, the branch and commit.
[ -z "$(git -C "$LF_SRC" status --porcelain -- examples packages modules)" ] || { echo "$LF_SRC has local changes"; exit 1; }
jq -n \
  --arg version "$(jq -r .version "$LF_SRC/packages/movement-engine/package.json")" \
  --arg embed "$(jq -r .version "$LF_SRC/packages/embed/package.json")" \
  --arg branch "$(git -C "$LF_SRC" for-each-ref --points-at HEAD --format='%(refname:short)' refs/heads | head -1)" \
  --arg commit "$(git -C "$LF_SRC" rev-parse --short HEAD)" \
  '{version: $version, embed: $embed, branch: (if $branch == "" then null else $branch end), commit: $commit}' >"$CAP/00_lf.json"
cp "$HERE/programs/request.txt" "$CAP/01_request.txt"
# The product's code, run from a copy beside the checkout's packages.
cp "$HERE"/host/*.ts "$WORK/product/"
cp "$HERE"/host/*.ts "$CAP/host/"
ln -s "$EX/node_modules" "$WORK/node_modules"

# The customer's Slack: one fake workspace on a free port, with its channels.
(cd "$WORK/fake" && FAKE_CHANNELS_PORT=0 exec node "$LF_SRC/packages/fake-channels/bin/fake-channels.cjs") >"$WORK/fake.log" 2>&1 &
PIDS+=($!)
for _ in $(seq 120); do grep -q 'running on http://localhost:' "$WORK/fake.log" && break; sleep 0.25; done
SLACK="http://127.0.0.1:$(sed -n 's/.*running on http:\/\/localhost:\([0-9]*\).*/\1/p' "$WORK/fake.log" | head -1)"
[ "$SLACK" != "http://127.0.0.1:" ] || { echo "fake-channels did not start (see $WORK/fake.log)"; exit 1; }
curl -sf -XPOST "$SLACK/admin/slack/seed" -H 'content-type: application/json' -d @"$HERE/programs/$(jq -r .slack "$HERE/programs/tenant.json")" >/dev/null
curl -sf "$SLACK/admin/slack/channel/state" >"$CAP/02_slack_channels.json"

# The customer's CRM API key (also its MCP bearer token) and Slack bot token:
# fresh random values, kept in .work only.
jq -n --arg t "$TENANT" --arg seed "$(openssl rand -hex 16)" \
  '{($t): {crm: "\($t)-\($seed[0:12])", slack: "xoxb-\($t)-\($seed[12:24])"}}' >"$WORK/keys.json"

# The product, in this process: the customer's fields, key and Slack.
node "$HERE/host.cjs" "$LF_SRC" "$WORK/product" "$HERE/programs/tenant.json" "$WORK/keys.json" "$SLACK" >"$WORK/host.log" 2>&1 &
PIDS+=($!)
for _ in $(seq 120); do grep -q '^listening ' "$WORK/host.log" && break; sleep 0.25; done
grep -q '^listening ' "$WORK/host.log" || { echo "the product did not start (see $WORK/host.log)"; exit 1; }
printf 'http://127.0.0.1:%s\n' "$(sed -n 's/^listening //p' "$WORK/host.log")" >"$WORK/base"
BASE="$(cat "$WORK/base")"
mcp() { "$HERE/mcp.sh" "$CAP/$1" "$TENANT" "$2" "${3:-}"; }

# The agent's loop over the customer's MCP endpoint: what it can reach, the
# Company schema, the automation saved (checked against those fields first).
mcp 10_getStarted getStarted
mcp 11_describe describeConnection '{"system":"crm","types":["Company"]}'
mcp 20_save saveAutomation "$(jq -Rsc --arg n "$NAME" '{name: $n, source: .}' "$HERE/programs/automation.mvt")"
mcp 21_list listAutomations
jq -e '.saved' "$CAP/20_save.txt" >/dev/null || { echo "the automation did not save"; cat "$CAP/20_save.txt"; exit 1; }

# The product's state, from its own route, and the customer's Slack.
state() { # <prefix>
  curl -sf "$BASE/customers/$TENANT/companies" >"$CAP/$1_companies.json"
  curl -sf "$SLACK/admin/slack/message/state" >"$CAP/$1_slack_messages.json"
}
# One request through the product's route: the state before and after, its
# answer and time, the product's log lines for it, the automation's runs.
change() { # <prefix> <method> <path> <fields json>
  state "$1_before"
  local logged
  logged="$(wc -l <"$WORK/host.log")"
  node "$HERE/change.cjs" "$BASE" "$2" "$3" "$4" >"$CAP/$1_answer.json"
  sleep 0.5
  tail -n "+$((logged + 1))" "$WORK/host.log" >"$CAP/$1_host.log"
  state "$1_after"
  mcp "$1_runs" listRuns "$(jq -nc --arg n "$NAME" '{idOrName: $n, limit: 10}')"
  jq -c '{ms, status, runs: .body.runs}' "$CAP/$1_answer.json"
}

# A person adds Halden Marine, a qualified deal: company.created, which nothing listens for.
change 30_create POST "/customers/$TENANT/companies" "$(jq -c .create "$HERE/programs/changes.json")"
ID="$(jq -r .body.company.id "$CAP/30_create_answer.json")"
[ -n "$ID" ] && [ "$ID" != null ] || { echo "the company was not created"; exit 1; }
printf '%s\n' "$ID" >"$WORK/company_id"

# Then changes it: Stage to Won (the automation runs), then Owner alone (nothing runs).
jq -c '.changes[]' "$HERE/programs/changes.json" | while read -r c; do
  change "$(jq -r '"\(.n)_\(.name)"' <<<"$c")" PATCH "/customers/$TENANT/companies/$ID" "$(jq -c .fields <<<"$c")"
done

# The one run, as the agent's tools show it.
run="$(jq -r '.runs[0].runId // empty' "$CAP/41_owner_runs.txt")"
[ -n "$run" ] || { echo "no run of $NAME"; exit 1; }
mcp 50_inspect inspectRun "$(jq -nc --arg r "$run" '{runId: $r}')"

# What the product printed, verbatim but for colour codes and the checkout's path.
sed -E -e $'s/\x1b\\[[0-9;?]*[A-Za-z]//g' -e "s#$LF_SRC/##g" -e "s#$WORK/##g" "$WORK/host.log" >"$CAP/60_host.log"
echo "captured in $CAP"
