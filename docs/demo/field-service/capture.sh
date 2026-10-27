#!/bin/bash
# The field-service demo, recorded on the open-source `lf` CLI (see README.md).
# A fresh lf project under .work/, the repository's fakes for WhatsApp, Google
# Sheets and Slack, the draft refused and the fix checked clean, then two
# signed WhatsApp deliveries through `lf serve` and what their runs did.
# Every output lands in .work/capture/, which build_data.cjs turns into the
# video's data.js in the site repo. Re-runnable: each run starts from nothing.
#
#   LF_BIN  the lf binary (default: `lf` on PATH, a release)
#   LF_SRC  a listen-fire checkout. When set, lf serves the modules from its
#           sources (LF_MODULES_DIR, and its module kit's serve-module), and
#           its commit is recorded beside lf's version. The fakes always come
#           from it (default: the listen-fire checkout beside this repo).
#
# The runs make real model calls: ANTHROPIC_API_KEY is read from
# apps/api/.env and handed to lf through the environment only.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
WORK="$HERE/.work"
CAP="$WORK/capture"
PROJECT="$WORK/field-service"
LF_BIN="${LF_BIN:-lf}"
FAKES_SRC="${LF_SRC:-$REPO/../listen-fire}"
APP_SECRET=field-service-demo-app-secret   # the stub Meta app's secret: lf checks it, deliver.cjs signs with it

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
[ -n "${LF_SRC:-}" ] && COMMIT="$(git -C "$LF_SRC" rev-parse --short HEAD)"
jq -n --arg version "$LF_VERSION" --arg commit "$COMMIT" \
  '{version: $version, commit: (if $commit == "" then null else $commit end)}' >"$CAP/00_lf.json"
cp "$HERE/programs/request.txt" "$CAP/01_request.txt"

# The fakes, on a free port, their state in a folder of their own.
(cd "$WORK/fakes" && FAKE_CHANNELS_PORT=0 exec node "$FAKES_SRC/packages/fake-channels/bin/fake-channels.cjs") >"$WORK/fakes.log" 2>&1 &
PIDS+=($!)
for _ in $(seq 120); do grep -q 'running on http://localhost:' "$WORK/fakes.log" && break; sleep 0.25; done
F="http://127.0.0.1:$(sed -n 's/.*running on http:\/\/localhost:\([0-9]*\).*/\1/p' "$WORK/fakes.log" | head -1)"
[ "$F" != "http://127.0.0.1:" ] || { echo "fake-channels did not start (see $WORK/fakes.log)"; exit 1; }
curl -sf -XPOST "$F/admin/sheets/seed" -H 'content-type: application/json' -d @"$HERE/programs/job_log.json" >/dev/null
curl -sf -XPOST "$F/admin/slack/seed" -H 'content-type: application/json' -d @"$HERE/programs/on_call.json" >/dev/null

# The project, as a person sets it up.
(cd "$WORK" && "$LF_BIN" init field-service >/dev/null)
rm -f "$PROJECT/movements/"*.mvt
cd "$PROJECT"
# What a person sees in the terminal, verbatim but for colour codes and the
# temporary project's own path (shown relative to the project, as from inside it).
REAL_PROJECT="$(pwd -P)"
human() {
  sed -E -e $'s/\x1b\\[[0-9;?]*[A-Za-z]//g' -e "s#$REAL_PROJECT/##g" -e "s#$PROJECT/##g" -e "s#$REAL_PROJECT#.#g" -e "s#$PROJECT#.#g"
}
printf '%s\n' "$APP_SECRET" | "$LF_BIN" connect @lf/whatsapp --base-url "$F/whatsapp/graph" >/dev/null
printf 'stub-meta-token\n100200300\n\n\n\n\n' | "$LF_BIN" credential add --module whatsapp customers >/dev/null
printf '\n' | "$LF_BIN" connect @lf/slack --base-url "$F/slack" >/dev/null
printf 'xoxb-stub\n\n\n\n' | "$LF_BIN" credential add --module slack ops_slack >/dev/null
printf 'stub-client\nstub-client-secret\n8976\nn\n' | "$LF_BIN" connect @lf/google-sheets --base-url "$F/sheets" \
  --oauth-authorize-url "$F/oauth/authorize" --oauth-token-url "$F/oauth/token" >/dev/null
node "$HERE/signin.cjs" "$LF_BIN" google_sheets job_log >/dev/null
# Under drive.file a spreadsheet reaches the module only once the user picks
# it. lf has no picker: the pick is the module's own kv, which lf gives a
# module through MODULE_STATE_DIR (tenant "local").
printf 'env:\n  MODULE_STATE_DIR: "{lf}"\n' >>externals/google_sheets/lf-external.yaml
mkdir -p .lf/externals/google_sheets
jq -n '{entries: [{key: "granted/job-log", value: {mimeType: "application/vnd.google-apps.spreadsheet", name: "Job log"}}]}' \
  >.lf/externals/google_sheets/local.json

# The draft, refused; the fix, clean.
cp "$HERE/programs/draft.mvt" movements/job_intake.mvt
"$LF_BIN" check --json >"$CAP/10_check_draft.json" || true
{ "$LF_BIN" check 2>&1 || true; } | human >"$CAP/10_check_draft.txt"
cp "$HERE/programs/fixed.mvt" movements/job_intake.mvt
"$LF_BIN" check --json >"$CAP/11_check_fixed.json" || true
{ "$LF_BIN" check 2>&1 || true; } | human >"$CAP/11_check_fixed.txt"
jq -e '.errors == 1' "$CAP/10_check_draft.json" >/dev/null || { echo "the draft was not refused with exactly one error"; exit 1; }
jq -e '.ok' "$CAP/11_check_fixed.json" >/dev/null || { echo "the fix does not check clean"; jq . "$CAP/11_check_fixed.json"; exit 1; }
cp lf.yaml "$CAP/12_lf.yaml"

# lf serve, where the fake WhatsApp's deliveries reach it.
PORT=$(node -e 'const s=require("net").createServer().listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')
echo "publicUrl: http://127.0.0.1:$PORT" >>lf.yaml
ANTHROPIC_KEY="$(sed -n 's/^ANTHROPIC_API_KEY=//p' "$REPO/apps/api/.env" | head -1 | tr -d "\"'")"
[ -n "$ANTHROPIC_KEY" ] || { echo "no ANTHROPIC_API_KEY in apps/api/.env"; exit 1; }
LF_SECRET__ANTHROPIC__MODULE=@lf/anthropic LF_SECRET__ANTHROPIC__API_KEY="$ANTHROPIC_KEY" \
  "$LF_BIN" serve --port "$PORT" >"$WORK/serve.log" 2>&1 &
PIDS+=($!)
unset ANTHROPIC_KEY
for _ in $(seq 120); do grep -q '^lf serving on' "$WORK/serve.log" && break; sleep 0.25; done
grep -q '^lf serving on' "$WORK/serve.log" || { echo "lf serve did not start (see $WORK/serve.log)"; exit 1; }
# What lf serve prints up to being ready, before any delivery reaches it.
sed '/^lf serving on/q' "$WORK/serve.log" | human >"$CAP/14_serve_ready.txt"
DOOR="http://127.0.0.1:$PORT/api/public/webhook-sync/whatsapp/customers"

state() {
  curl -sf "$F/admin/sheets/row/state" >"$CAP/$1_sheet_rows.json"
  curl -sf "$F/admin/slack/message/state" >"$CAP/$1_slack_messages.json"
}
curl -sf "$F/admin/slack/channel/state" >"$CAP/13_slack_channels.json"

# One delivery: the fakes' state before and after, the run, and how long it took.
deliver() { # <n> <name> <from> <profile name> <text>
  state "$1_before"
  jq -n --arg from "$3" --arg name "$4" --arg text "$5" '{from: $from, profileName: $name, text: $text}' >"$CAP/$1_$2_message.json"
  node "$HERE/deliver.cjs" "$DOOR" "$APP_SECRET" "$WORK/serve.log" "$3" "$4" "$5" >"$CAP/$1_$2_delivery.json"
  "$LF_BIN" runs show "$(jq -r .runId "$CAP/$1_$2_delivery.json")" --json >"$CAP/$1_$2_run.json"
  state "$1_after"
  jq -c '.run | {status, writes, costMicrodollars}' "$CAP/$1_$2_run.json"
}
deliver 20 routine 447700900456 "Tom Hale" "Hi, could someone look at a dripping kitchen tap next week? 14 Elm Road"
deliver 30 urgent 447700900123 "Ruth Okafor" "Water pouring through the ceiling from upstairs, can someone come now? 3 Mill Lane"
echo "captured in $CAP"
