#!/bin/bash
# The agents demo, recorded on the open-source `lf` CLI (see README.md).
#
#   1. The program: the draft refused by `lf check`, the fix checked clean,
#      `lf serve`.
#   2. Day 1: 20 signed Stripe deliveries through `lf serve`, and what each
#      run did.
#   3. The next morning: the agent's daily review, a real model session, run
#      three times from the same state (copies of the project). The first
#      attempt whose revision checks clean and handles the day's exceptions
#      (a dry run of each) is put live under the running `lf serve`.
#   4. Day 2: 20 more deliveries, through the revised program.
#   5. The comparison: day 1's 20 events, each handled by a fresh agent with
#      tools on the same stand-ins (reset first).
#
# Every output lands in .work/capture/, which build_data.cjs turns into the
# video's data.js in the site repo. Re-runnable: each run starts from nothing.
#
#   LF_BIN       the lf binary (default: `lf` on PATH, a release)
#   LF_SRC       a listen-fire checkout. When set, lf serves the modules from
#                its sources (LF_MODULES_DIR, and its module kit's
#                serve-module), and its commit is recorded beside lf's
#                version. The fakes always come from it (default: the
#                listen-fire checkout beside this repo).
#   LF_BRANCHES  the listen-fire branches LF_SRC was built from (space
#                separated). Each must be in LF_SRC's history; each is
#                recorded as <branch>@<its commit>.
#
# The program makes no model call. The review and the comparison do:
# ANTHROPIC_API_KEY is read from apps/api/.env and handed to them through the
# environment only.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
WORK="$HERE/.work"
CAP="$WORK/capture"
PROJECT="$WORK/billing"
LF_BIN="${LF_BIN:-lf}"
FAKES_SRC="${LF_SRC:-$REPO/../listen-fire}"
STRIPE_SECRET=whsec_ledgerline_stand_in_7d1c2b   # the stand-in Stripe endpoint's signing secret: lf checks it, deliver.cjs signs with it
CRM_TOKEN=crm-stand-in-token
PROGRAM=movements/payment_failed.mvt
ATTEMPTS="${ATTEMPTS:-3}"

rm -rf "$WORK"
mkdir -p "$CAP" "$WORK/fakes"

PIDS=()
cleanup() { for pid in "${PIDS[@]+"${PIDS[@]}"}"; do kill "$pid" 2>/dev/null || true; done; wait 2>/dev/null || true; }
trap cleanup EXIT INT TERM

if [ -n "${LF_SRC:-}" ]; then
  LF_SRC="$(cd "$LF_SRC" && pwd)"
  export LF_MODULES_DIR="$LF_SRC/modules"
  # lf hands a module process only PATH, so the path here is absolute.
  printf '#!/bin/sh\nexec node %s/packages/module-kit/bin/serve-module.cjs "$@"\n' "$LF_SRC" >"$WORK/serve-module"
  chmod +x "$WORK/serve-module"
  export LF_SERVE_MODULE="$WORK/serve-module"
fi
export LF_BIN
LF_VERSION="$("$LF_BIN" --version | sed -n 's/^lf //p' | head -1)"
COMMIT=""
BRANCHES="[]"
if [ -n "${LF_SRC:-}" ]; then
  COMMIT="$(git -C "$LF_SRC" rev-parse --short HEAD)"
  for b in ${LF_BRANCHES:-}; do
    git -C "$LF_SRC" merge-base --is-ancestor "$b" HEAD || { echo "$b is not in LF_SRC's history"; exit 1; }
    BRANCHES="$(jq -c --arg b "$b" --arg c "$(git -C "$LF_SRC" rev-parse --short "$b")" '. + [{branch: $b, commit: $c}]' <<<"$BRANCHES")"
  done
fi
jq -n --arg version "$LF_VERSION" --arg commit "$COMMIT" --argjson branches "$BRANCHES" \
  '{version: $version, commit: (if $commit == "" then null else $commit end), branches: $branches}' >"$CAP/00_lf.json"
cp "$HERE/programs/request_review.txt" "$CAP/01_request.txt"

ANTHROPIC_KEY="$(sed -n 's/^ANTHROPIC_API_KEY=//p' "$REPO/apps/api/.env" | head -1 | tr -d "\"'")"
[ -n "$ANTHROPIC_KEY" ] || { echo "no ANTHROPIC_API_KEY in apps/api/.env"; exit 1; }

# The fakes, on a free port, their state in a folder of their own: Gmail and
# Slack emptied and given Ledgerline's billing mailbox and #accounts channel.
(cd "$WORK/fakes" && FAKE_CHANNELS_PORT=0 exec node "$FAKES_SRC/packages/fake-channels/bin/fake-channels.cjs") >"$WORK/fakes.log" 2>&1 &
PIDS+=($!)
for _ in $(seq 120); do grep -q 'running on http://localhost:' "$WORK/fakes.log" && break; sleep 0.25; done
F="http://127.0.0.1:$(sed -n 's/.*running on http:\/\/localhost:\([0-9]*\).*/\1/p' "$WORK/fakes.log" | head -1)"
[ "$F" != "http://127.0.0.1:" ] || { echo "fake-channels did not start (see $WORK/fakes.log)"; exit 1; }
for kind in slack/channel slack/user slack/message gmail/message; do curl -sf -XDELETE "$F/admin/$kind/state" >/dev/null; done
seed() { curl -sf -XPOST "$F/admin/$1/seed" -H 'content-type: application/json' -d @"$HERE/programs/$2" >/dev/null; }
seed slack accounts_channel.json
seed gmail mailbox.json

# The CRM, an MCP server of its own; every tool call it answers is logged.
CRM_CALLS="$WORK/crm_calls.jsonl"
: >"$CRM_CALLS"
CRM_TOKEN="$CRM_TOKEN" node "$HERE/crm_server.cjs" "$CRM_CALLS" >"$WORK/crm.log" 2>&1 &
PIDS+=($!)
for _ in $(seq 120); do grep -q '^listening ' "$WORK/crm.log" && break; sleep 0.25; done
CRM_URL="http://127.0.0.1:$(sed -n 's/^listening //p' "$WORK/crm.log")/mcp"
[ "$CRM_URL" != "http://127.0.0.1:/mcp" ] || { echo "the CRM did not start (see $WORK/crm.log)"; exit 1; }

# The project, as a person sets it up.
(cd "$WORK" && "$LF_BIN" init billing >/dev/null)
rm -f "$PROJECT/movements/"*.mvt
cd "$PROJECT"
# What a person sees in the terminal, verbatim but for colour codes and the
# temporary project's own path (shown relative to the project, as from inside it).
REAL_PROJECT="$(pwd -P)"
human() {
  sed -E -e $'s/\x1b\\[[0-9;?]*[A-Za-z]//g' -e "s#$REAL_PROJECT/##g" -e "s#$PROJECT/##g" -e "s#$REAL_PROJECT#.#g" -e "s#$PROJECT#.#g"
}
"$LF_BIN" connect @lf/webhook --yes >/dev/null
# Asked as a person answers: scheme, secret, header, encoding, idField.
printf 'stripe\n%s\n\n\n\n' "$STRIPE_SECRET" | "$LF_BIN" credential add --module webhook stripe_events >/dev/null
"$LF_BIN" connect @lf/mcp --yes >/dev/null
printf '%s\n%s\n\n' "$CRM_URL" "$CRM_TOKEN" | "$LF_BIN" credential add --module @lf/mcp crm --credential mcp_token >/dev/null
printf 'stub-gmail-client\nstub-gmail-secret\n8979\n' | "$LF_BIN" connect @lf/gmail --yes --base-url "$F" \
  --oauth-authorize-url "$F/oauth/authorize" --oauth-token-url "$F/oauth/token" >/dev/null
node "$HERE/signin.cjs" "$LF_BIN" gmail billing_mail gmail billing@ledgerline.io '' '' '' '' '' '' >/dev/null
printf '\n' | "$LF_BIN" connect @lf/slack --base-url "$F/slack" >/dev/null
printf 'xoxb-stub\n\n\n\n' | "$LF_BIN" credential add --module slack team_slack >/dev/null

# The draft, refused; the fix, clean.
cp "$HERE/programs/draft.mvt" "$PROGRAM"
"$LF_BIN" check --json >"$CAP/10_check_draft.json" || true
{ "$LF_BIN" check 2>&1 || true; } | human >"$CAP/10_check_draft.txt"
cp "$HERE/programs/fixed.mvt" "$PROGRAM"
"$LF_BIN" check --json >"$CAP/11_check_fixed.json" || true
{ "$LF_BIN" check 2>&1 || true; } | human >"$CAP/11_check_fixed.txt"
jq -e '.errors == 1' "$CAP/10_check_draft.json" >/dev/null || { echo "the draft was not refused with exactly one error"; cat "$CAP/10_check_draft.txt"; exit 1; }
jq -e '.ok' "$CAP/11_check_fixed.json" >/dev/null || { echo "the fix does not check clean"; cat "$CAP/11_check_fixed.txt"; exit 1; }
cp lf.yaml "$CAP/12_lf.yaml"
curl -sf "$F/admin/slack/channel/state" >"$CAP/13_slack_channels.json"

# lf serve, where the stand-in Stripe's deliveries reach it.
PORT=$(node -e 'const s=require("net").createServer().listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')
echo "publicUrl: http://127.0.0.1:$PORT" >>lf.yaml
SERVE_LOG="$WORK/serve.log"
"$LF_BIN" serve --port "$PORT" >"$SERVE_LOG" 2>&1 &
SERVE_PID=$!
PIDS+=($SERVE_PID)
for _ in $(seq 120); do grep -q '^webhook stripe_events: ' "$SERVE_LOG" && break; sleep 0.25; done
grep -q '^webhook stripe_events: ' "$SERVE_LOG" || { echo "lf serve did not start (see $SERVE_LOG)"; exit 1; }
# What lf serve prints up to being ready, before any delivery reaches it.
sed '/^webhook stripe_events: /q' "$SERVE_LOG" | human >"$CAP/14_serve_ready.txt"
HOOK="$(sed -n 's/^webhook stripe_events: //p' "$SERVE_LOG" | head -1)"

state() { # <prefix>
  curl -sf "$F/fake-gmail/state" >"$1_gmail.json"
  curl -sf "$F/admin/slack/message/state" >"$1_slack_messages.json"
  wc -l <"$CRM_CALLS" | tr -d ' ' >"$1_crm_calls.txt"
}

# One day of deliveries: each event signed and sent, the fakes' state before
# and after, the run, and how long it took.
day() { # <day> <dir>
  local dir="$2"
  mkdir -p "$dir/events"
  node "$HERE/make_events.cjs" "$1" "$dir/events" >/dev/null
  for event in "$dir/events/"*.json; do
    local n; n="$(basename "$event" .json)"
    state "$dir/${n}_before"
    node "$HERE/deliver.cjs" "$HOOK" "$STRIPE_SECRET" "$SERVE_LOG" "$event" >"$dir/${n}_delivery.json"
    "$LF_BIN" runs show "$(jq -r .runId "$dir/${n}_delivery.json")" --json >"$dir/${n}_run.json"
    state "$dir/${n}_after"
  done
  "$LF_BIN" runs | human >"$dir/lf_runs.txt"
  jq -r '.line' "$dir/"*_delivery.json | human >"$dir/serve_lines.txt"
}

day 1 "$CAP/20_day1"
echo "day 1: $(grep -c ' completed' "$CAP/20_day1/serve_lines.txt") completed, $(grep -c ' failed' "$CAP/20_day1/serve_lines.txt") failed"

# The next morning. Each attempt starts from a copy of the project as it
# stands after day 1 (its run store copied whole with sqlite's backup, since
# lf serve is still running on it). The review sees the runs through the real
# `lf runs`, and the CRM through its MCP tools.
mkdir -p "$CAP/40_review"
"$LF_BIN" runs | human >"$CAP/40_review/lf_runs_at_review.txt"
FAILED_RUNS="$(jq -r 'select(.run.status == "failed") | .run.runId' "$CAP/20_day1/"*_run.json)"
CHOSEN=""
for k in $(seq "$ATTEMPTS"); do
  copy="$WORK/review/$k/billing"
  mkdir -p "$(dirname "$copy")"
  rsync -a --exclude '.lf/state.db*' "$PROJECT/" "$copy/"
  sqlite3 "$PROJECT/.lf/state.db" ".backup '$copy/.lf/state.db'"
  ANTHROPIC_API_KEY="$ANTHROPIC_KEY" node "$HERE/review.cjs" "$copy" "$PROGRAM" "$CRM_URL" "$CRM_TOKEN" "$CAP/40_review/attempt_$k.json" | tee "$CAP/40_review/attempt_${k}_summary.txt"
  # The revision, checked; then each of the day's exceptions run against it
  # as a dry run (reads made, nothing written).
  (cd "$copy" && { "$LF_BIN" check --json >"$CAP/40_review/attempt_${k}_check.json" || true; })
  (cd "$copy" && { "$LF_BIN" check 2>&1 || true; }) | sed -E -e $'s/\x1b\\[[0-9;?]*[A-Za-z]//g' -e "s#$(cd "$copy" && pwd -P)/##g" -e "s#$copy/##g" >"$CAP/40_review/attempt_${k}_check.txt"
  diff -u --label "a/$PROGRAM" --label "b/$PROGRAM" "$HERE/programs/fixed.mvt" "$copy/$PROGRAM" >"$CAP/40_review/attempt_${k}.diff" || true
  : >"$CAP/40_review/attempt_${k}_dry_runs.txt"
  for run in $FAILED_RUNS; do
    jq --arg id "$run" 'select(.run.runId == $id) | {external: "webhook", credential: "stripe_events", event: .run.event}' "$CAP/20_day1/"*_run.json >"$WORK/review/$k/exception_$run.json"
    (cd "$copy" && { "$LF_BIN" run --event "$WORK/review/$k/exception_$run.json" --dry-run 2>&1 || true; }) >>"$CAP/40_review/attempt_${k}_dry_runs.txt"
  done
  if [ -z "$CHOSEN" ] && jq -e '.ok' "$CAP/40_review/attempt_${k}_check.json" >/dev/null \
    && [ "$(grep -c '^run .* completed' "$CAP/40_review/attempt_${k}_dry_runs.txt")" = "$(echo "$FAILED_RUNS" | wc -w | tr -d ' ')" ]; then
    CHOSEN=$k
  fi
done
echo "${CHOSEN:-none}" >"$CAP/40_review/chosen.txt"
[ -n "$CHOSEN" ] || { echo "no review attempt produced a revision that checks clean and handles the exceptions"; exit 1; }

# The chosen revision, put live: lf serve picks up the edited file.
mark=$(wc -l <"$SERVE_LOG")
cp "$WORK/review/$CHOSEN/billing/$PROGRAM" "$PROGRAM"
for _ in $(seq 40); do tail -n +"$((mark + 1))" "$SERVE_LOG" | grep -q 'changed' && break; sleep 0.25; done
sleep 2
tail -n +"$((mark + 1))" "$SERVE_LOG" | human >"$CAP/41_redeploy_serve.txt"
grep -q 'do not check' "$CAP/41_redeploy_serve.txt" && { echo "lf serve kept the old program"; cat "$CAP/41_redeploy_serve.txt"; exit 1; }
"$LF_BIN" check --json >"$CAP/42_check_revised.json" || true
{ "$LF_BIN" check 2>&1 || true; } | human >"$CAP/42_check_revised.txt"
cp "$PROGRAM" "$CAP/43_revised.mvt"

day 2 "$CAP/50_day2"
echo "day 2: $(grep -c ' completed' "$CAP/50_day2/serve_lines.txt") completed, $(grep -c ' failed' "$CAP/50_day2/serve_lines.txt") failed"
kill "$SERVE_PID" 2>/dev/null || true

# The comparison: the stand-ins reset (sent mail and Slack messages cleared),
# then day 1's events exactly as they were delivered, one fresh agent each.
for kind in slack/message gmail/message; do curl -sf -XDELETE "$F/admin/$kind/state" >/dev/null; done
seed gmail mailbox.json
mkdir -p "$CAP/60_baseline/events"
for d in "$CAP/20_day1/"*_delivery.json; do jq '.body' "$d" >"$CAP/60_baseline/events/$(basename "$d" _delivery.json).json"; done
wc -l <"$CRM_CALLS" | tr -d ' ' >"$CAP/60_baseline/crm_calls_before.txt"
ANTHROPIC_API_KEY="$ANTHROPIC_KEY" node "$HERE/baseline.cjs" "$F" "$CRM_URL" "$CRM_TOKEN" "$CAP/60_baseline/baseline.json" "$CAP/60_baseline/events/"*.json
unset ANTHROPIC_KEY
cp "$CRM_CALLS" "$CAP/crm_calls.jsonl"
echo "captured in $CAP"
