#!/bin/bash
# The recruiting demo, recorded on the open-source `lf` CLI (see README.md).
# A fresh lf project under .work/, the repository's fakes for Airtable, Google
# Drive, Slack and Gmail, the draft refused and the fix checked clean, then
# two edits to the Hiring base through `lf serve` and what they did. Every
# output lands in .work/capture/, which build_data.cjs turns into the video's
# data.js in the site repo. Re-runnable: each run starts from nothing.
#
#   LF_BIN       the lf binary (default: `lf` on PATH, a release)
#   LF_SRC       a listen-fire checkout. When set, lf serves the modules from
#                its sources (LF_MODULES_DIR, and its module kit's
#                serve-module), and its commit is recorded beside lf's
#                version. The fakes always come from it (default: the
#                listen-fire checkout beside this repo).
#   LF_BRANCHES  the listen-fire branches LF_SRC was built from, merged
#                (space separated). Each must be in LF_SRC's history; each is
#                recorded as <branch>@<its commit>.
#
# No model is called: the program has no extraction, so no model key is given.
# The current recording: LF_BRANCHES=main.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
WORK="$HERE/.work"
CAP="$WORK/capture"
PROJECT="$WORK/recruiting"
LF_BIN="${LF_BIN:-lf}"
FAKES_SRC="${LF_SRC:-$REPO/../listen-fire}"
MAILBOX=hannah.lowe@haldenrobotics.com

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
cp "$HERE/programs/request.txt" "$CAP/01_request.txt"

# The fakes, on a free port, their state in a folder of their own. The fakes
# start with sample data of their own for every service; the services this
# demo uses are emptied and given the recruiting team's instead.
(cd "$WORK/fakes" && FAKE_CHANNELS_PORT=0 exec node "$FAKES_SRC/packages/fake-channels/bin/fake-channels.cjs") >"$WORK/fakes.log" 2>&1 &
PIDS+=($!)
for _ in $(seq 120); do grep -q 'running on http://localhost:' "$WORK/fakes.log" && break; sleep 0.25; done
F="http://127.0.0.1:$(sed -n 's/.*running on http:\/\/localhost:\([0-9]*\).*/\1/p' "$WORK/fakes.log" | head -1)"
[ "$F" != "http://127.0.0.1:" ] || { echo "fake-channels did not start (see $WORK/fakes.log)"; exit 1; }
for kind in airtable/base airtable/table:appTEST001 airtable/table:appTEST002 gdrive/file slack/channel slack/user slack/message; do
  curl -sf -XDELETE "$F/admin/$kind/state" >/dev/null
done
seed() { curl -sf -XPOST "$F/admin/$1/seed" -H 'content-type: application/json' -d @"$HERE/programs/$2" >/dev/null; }
seed airtable hiring_base.json
seed gdrive drive.json
seed slack hiring_channel.json
seed gmail mailbox.json

# The project, as a person sets it up.
(cd "$WORK" && "$LF_BIN" init recruiting >/dev/null)
rm -f "$PROJECT/movements/"*.mvt
cd "$PROJECT"
# What a person sees in the terminal, verbatim but for colour codes and the
# temporary project's own path (shown relative to the project, as from inside it).
REAL_PROJECT="$(pwd -P)"
human() {
  sed -E -e $'s/\x1b\\[[0-9;?]*[A-Za-z]//g' -e "s#$REAL_PROJECT/##g" -e "s#$PROJECT/##g" -e "s#$REAL_PROJECT#.#g" -e "s#$PROJECT#.#g"
}
oauth() { echo --oauth-authorize-url "$F/oauth/authorize" --oauth-token-url "$F/oauth/token"; }
printf 'stub-airtable-client\nstub-airtable-secret\n8978\n' | "$LF_BIN" connect @lf/airtable --yes --base-url "$F/airtable" $(oauth) >/dev/null
node "$HERE/signin.cjs" "$LF_BIN" @lf/airtable hannah_airtable airtable '' '' >/dev/null
printf 'stub-drive-client\nstub-drive-secret\n8977\n' | "$LF_BIN" connect @lf/google-drive --yes --base-url "$F" $(oauth) >/dev/null
node "$HERE/signin.cjs" "$LF_BIN" @lf/google-drive hannah_drive google '' '' >/dev/null
printf 'stub-gmail-client\nstub-gmail-secret\n8979\n' | "$LF_BIN" connect @lf/gmail --yes --base-url "$F" $(oauth) >/dev/null
# Drafts are opt-in at sign-in: the gmail_drafts credential asks for Gmail's compose scope.
node "$HERE/signin.cjs" "$LF_BIN" gmail hannah_mail gmail_drafts "$MAILBOX" '' '' '' '' '' '' >/dev/null
printf '\n' | "$LF_BIN" connect @lf/slack --base-url "$F/slack" >/dev/null
printf 'xoxb-stub\n\n\n\n' | "$LF_BIN" credential add --module slack hiring_slack >/dev/null
# Under drive.file a file reaches the module only once the user picks it. lf
# has no picker: the picks are the module's own kv, which lf gives a module
# through MODULE_STATE_DIR (tenant "local").
printf 'env:\n  MODULE_STATE_DIR: "{lf}"\n' >>externals/google_drive/lf-external.yaml
mkdir -p .lf/externals/google_drive
jq '{entries: [.entities[].data | {key: "granted/\(.id)", value: {mimeType, name}}]}' "$HERE/programs/drive.json" \
  >.lf/externals/google_drive/local.json

# The draft, refused; the fix, clean.
cp "$HERE/programs/draft.mvt" movements/schedule_interview.mvt
"$LF_BIN" check --json >"$CAP/10_check_draft.json" || true
{ "$LF_BIN" check 2>&1 || true; } | human >"$CAP/10_check_draft.txt"
cp "$HERE/programs/fixed.mvt" movements/schedule_interview.mvt
"$LF_BIN" check --json >"$CAP/11_check_fixed.json" || true
{ "$LF_BIN" check 2>&1 || true; } | human >"$CAP/11_check_fixed.txt"
jq -e ".errors == 1" "$CAP/10_check_draft.json" >/dev/null || { echo "the draft was not refused with exactly one error"; cat "$CAP/10_check_draft.txt"; exit 1; }
jq -e ".ok" "$CAP/11_check_fixed.json" >/dev/null || { echo "the fix does not check clean"; cat "$CAP/11_check_fixed.txt"; exit 1; }
cp lf.yaml "$CAP/12_lf.yaml"
[ -n "${STOP_AFTER_CHECK:-}" ] && exit 0

# lf serve, where the fake Airtable's webhook pings reach it.
PORT=$(node -e 'const s=require("net").createServer().listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')
echo "publicUrl: http://127.0.0.1:$PORT" >>lf.yaml
"$LF_BIN" serve --port "$PORT" >"$WORK/serve.log" 2>&1 &
PIDS+=($!)
for _ in $(seq 120); do grep -q '^lf serving on' "$WORK/serve.log" && break; sleep 0.25; done
grep -q '^lf serving on' "$WORK/serve.log" || { echo "lf serve did not start (see $WORK/serve.log)"; exit 1; }
# What lf serve prints up to being ready, before any edit reaches it.
sed '/^lf serving on/q' "$WORK/serve.log" | human >"$CAP/14_serve_ready.txt"
# The webhook's signing secret is left out of the capture.
curl -sf "$F/admin/airtable/webhook/state" | jq 'map(del(.macSecretBase64))' >"$CAP/13_airtable_webhooks.json"
curl -sf "$F/admin/slack/channel/state" >"$CAP/13_slack_channels.json"

state() {
  curl -sf "$F/admin/airtable/record:appHIRE01:tblCAND01/state" >"$CAP/$1_airtable_candidates.json"
  curl -sf "$F/admin/gdrive/file/state" >"$CAP/$1_drive_files.json"
  curl -sf "$F/admin/slack/message/state" >"$CAP/$1_slack_messages.json"
  curl -sf "$F/fake-gmail/state" >"$CAP/$1_gmail.json"
  "$LF_BIN" runs --json >"$CAP/$1_lf_runs.json"
  "$LF_BIN" deliveries --json >"$CAP/$1_lf_deliveries.json"
}

# One edit: the fakes' and lf's state before and after, the run (if any), and how long it took.
edit() { # <n> <name> <record id> <from> <to> <expect: run|none>
  state "$1_before"
  jq -n --arg record "$3" --arg from "$4" --arg to "$5" '{record: $record, field: "Stage", from: $from, to: $to}' >"$CAP/$1_$2_edit.json"
  node "$HERE/deliver.cjs" "$F" "$WORK/serve.log" "$3" Stage "$4" "$5" "$6" >"$CAP/$1_$2_delivery.json"
  local run; run="$(jq -r '.runId // empty' "$CAP/$1_$2_delivery.json")"
  [ -n "$run" ] && "$LF_BIN" runs show "$run" --json >"$CAP/$1_$2_run.json"
  state "$1_after"
  [ -n "$run" ] && jq -c '.run | {status, writes, costMicrodollars}' "$CAP/$1_$2_run.json" || echo "$2: no run"
}
edit 20 screen recTOMAS01 Applied Screen none
edit 30 interview recPRIYA01 Screen Interview run
human <"$WORK/serve.log" >"$CAP/40_serve.txt"
echo "captured in $CAP"
