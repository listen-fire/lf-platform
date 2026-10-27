#!/bin/bash
# The invoices demo, recorded on the open-source `lf` CLI (see README.md).
# A fresh lf project under .work/, the repository's fakes for Gmail, Google
# Drive, Google Sheets and Slack, the draft refused and the fix checked clean,
# then two supplier emails polled in by `lf serve` and what their runs did.
# Every output lands in .work/capture/, which build_data.cjs turns into the
# video's data.js in the site repo. Re-runnable: each run starts from nothing.
#
#   LF_BIN  the lf binary (default: `lf` on PATH, a release)
#   LF_SRC  a listen-fire checkout. When set, lf serves the modules from its
#           sources (LF_MODULES_DIR, and its module kit's serve-module), and
#           its commit is recorded beside lf's version. The fakes always come
#           from it (default: the listen-fire checkout beside this repo).
#   CHROME  the Chrome that prints the invoice PDFs (default: macOS's).
#
# The runs make real model calls: ANTHROPIC_API_KEY is read from
# apps/api/.env and handed to lf through the environment only.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
WORK="$HERE/.work"
CAP="$WORK/capture"
PROJECT="$WORK/invoices"
LF_BIN="${LF_BIN:-lf}"
FAKES_SRC="${LF_SRC:-$REPO/../listen-fire}"
CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"

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
BRANCH=""
DIRTY=""
if [ -n "${LF_SRC:-}" ]; then
  COMMIT="$(git -C "$LF_SRC" rev-parse --short HEAD)"
  # A detached worktree names its branch by a branch whose tip it is; several
  # can share a tip, so main wins when it is one of them.
  if [ "$(git -C "$LF_SRC" rev-parse HEAD)" = "$(git -C "$LF_SRC" rev-parse --verify -q main || true)" ]; then
    BRANCH=main
  else
    BRANCH="$(git -C "$LF_SRC" name-rev --name-only --refs='refs/heads/*' --no-undefined HEAD 2>/dev/null | sed 's/[~^].*//' || true)"
  fi
  git -C "$LF_SRC" diff --quiet HEAD -- || DIRTY="uncommitted changes"
fi
jq -n --arg version "$LF_VERSION" --arg commit "$COMMIT" --arg branch "$BRANCH" --arg dirty "$DIRTY" \
  '{version: $version, branch: (if $branch == "" then null else $branch end), commit: (if $commit == "" then null else $commit end), uncommitted: (if $dirty == "" then null else $dirty end)}' >"$CAP/00_lf.json"
cp "$HERE/programs/request.txt" "$CAP/01_request.txt"

# The two invoices, printed fresh from their figures (invoices/*.json).
node "$HERE/invoices/make_invoices.cjs" "$CHROME" "$WORK/pdf" >/dev/null
for pdf in "$WORK/pdf/"*.pdf; do
  jq -n --arg name "$(basename "$pdf")" --argjson bytes "$(stat -f %z "$pdf")" --arg sha256 "$(shasum -a 256 "$pdf" | cut -d' ' -f1)" \
    '{name: $name, bytes: $bytes, sha256: $sha256}'
done | jq -s . >"$CAP/02_pdfs.json"

# The fakes, on a free port, their state in a folder of their own.
(cd "$WORK/fakes" && FAKE_CHANNELS_PORT=0 exec node "$FAKES_SRC/packages/fake-channels/bin/fake-channels.cjs") >"$WORK/fakes.log" 2>&1 &
PIDS+=($!)
for _ in $(seq 120); do grep -q 'running on http://localhost:' "$WORK/fakes.log" && break; sleep 0.25; done
F="http://127.0.0.1:$(sed -n 's/.*running on http:\/\/localhost:\([0-9]*\).*/\1/p' "$WORK/fakes.log" | head -1)"
[ "$F" != "http://127.0.0.1:" ] || { echo "fake-channels did not start (see $WORK/fakes.log)"; exit 1; }
seed() { curl -sf -XPOST "$F/admin/$1/seed" -H 'content-type: application/json' -d @"$HERE/programs/$2" >/dev/null; }
seed sheets ledger.json
seed slack finance.json
seed gdrive drive.json
seed gmail mailbox.json

# The project, as a person sets it up.
(cd "$WORK" && "$LF_BIN" init invoices >/dev/null)
rm -f "$PROJECT/movements/"*.mvt
cd "$PROJECT"
# What a person sees in the terminal, verbatim but for colour codes and the
# temporary project's own path (shown relative to the project, as from inside it).
REAL_PROJECT="$(pwd -P)"
human() {
  sed -E -e $'s/\x1b\\[[0-9;?]*[A-Za-z]//g' -e "s#$REAL_PROJECT/##g" -e "s#$PROJECT/##g" -e "s#$REAL_PROJECT#.#g" -e "s#$PROJECT#.#g"
}
google() { # <module> <api root>: an OAuth app at the fake provider
  printf 'stub-client\nstub-client-secret\n8976\nn\n' | "$LF_BIN" connect "@lf/$1" --base-url "$2" \
    --oauth-authorize-url "$F/oauth/authorize" --oauth-token-url "$F/oauth/token" >/dev/null
}
# Gmail and Drive are served at the fakes' root, as googleapis resolves paths
# against the root URL's origin; Sheets at its own prefix.
google gmail "$F"
google google-drive "$F"
google google-sheets "$F/sheets"
printf '\n' | "$LF_BIN" connect @lf/slack --base-url "$F/slack" >/dev/null
node "$HERE/signin.cjs" "$LF_BIN" gmail:gmail finance_inbox mailbox=accounts@fenwickshaw.co.uk >/dev/null
node "$HERE/signin.cjs" "$LF_BIN" google_drive finance_drive >/dev/null
node "$HERE/signin.cjs" "$LF_BIN" google_sheets ledger >/dev/null
printf 'xoxb-stub\n\n\n\n' | "$LF_BIN" credential add --module slack finance_slack >/dev/null
# Under drive.file a spreadsheet or folder reaches the module only once the
# user picks it. lf has no picker: the pick is the module's own kv, which lf
# gives a module through MODULE_STATE_DIR (tenant "local").
grant() { # <module> <item id> <mime type> <name>
  printf 'env:\n  MODULE_STATE_DIR: "{lf}"\n' >>"externals/$1/lf-external.yaml"
  mkdir -p ".lf/externals/$1"
  jq -n --arg key "granted/$2" --arg mime "$3" --arg name "$4" '{entries: [{key: $key, value: {mimeType: $mime, name: $name}}]}' \
    >".lf/externals/$1/local.json"
}
grant google_sheets ledger application/vnd.google-apps.spreadsheet Ledger
grant google_drive fold-invoices application/vnd.google-apps.folder Invoices

# The draft, refused; the fix, clean.
cp "$HERE/programs/draft.mvt" movements/file_invoice.mvt
"$LF_BIN" check --json >"$CAP/10_check_draft.json" || true
{ "$LF_BIN" check 2>&1 || true; } | human >"$CAP/10_check_draft.txt"
cp "$HERE/programs/fixed.mvt" movements/file_invoice.mvt
"$LF_BIN" check --json >"$CAP/11_check_fixed.json" || true
{ "$LF_BIN" check 2>&1 || true; } | human >"$CAP/11_check_fixed.txt"
jq -e '.errors == 1' "$CAP/10_check_draft.json" >/dev/null || { echo "the draft was not refused with exactly one error"; exit 1; }
jq -e '.ok' "$CAP/11_check_fixed.json" >/dev/null || { echo "the fix does not check clean"; jq . "$CAP/11_check_fixed.json"; exit 1; }
cp lf.yaml "$CAP/12_lf.yaml"

# lf serve, which polls the mailbox.
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
# What lf serve prints up to being ready, before any mail reaches it.
sed '/^lf serving on/q' "$WORK/serve.log" | human >"$CAP/14_serve_ready.txt"
# Gmail's first poll only sets the mark (mail already there never fires), so
# mail is sent once lf serve says the listen is armed.
for _ in $(seq 240); do grep -q '^lf: .* armed; it fires on changes from now' "$WORK/serve.log" && break; sleep 0.25; done
grep -q '^lf: .* armed; it fires on changes from now' "$WORK/serve.log" || { echo "Gmail's first poll never armed the listen (see $WORK/serve.log)"; exit 1; }
curl -sf "$F/admin/slack/channel/state" >"$CAP/13_slack_channels.json"

state() {
  curl -sf "$F/admin/gdrive/file/state" | jq 'map(del(.content, .contentBase64))' >"$CAP/$1_drive_files.json"
  curl -sf "$F/admin/sheets/row/state" >"$CAP/$1_sheet_rows.json"
  curl -sf "$F/admin/slack/message/state" >"$CAP/$1_slack_messages.json"
}

# One supplier's email: the fakes' state before and after, the run, and how long it took.
mail() { # <n> <name> <email json> <pdf>
  state "$1_before"
  cp "$HERE/programs/$3" "$CAP/$1_$2_email.json"
  node "$HERE/mail.cjs" "$F" "$WORK/serve.log" "$HERE/programs/$3" "$WORK/pdf/$4" >"$CAP/$1_$2_delivery.json"
  "$LF_BIN" runs show "$(jq -r .runId "$CAP/$1_$2_delivery.json")" --json >"$CAP/$1_$2_run.json"
  state "$1_after"
  jq -c '.run | {status, writes, costMicrodollars, error}' "$CAP/$1_$2_run.json"
}
mail 20 small paperworks_email.json PW-20417.pdf
mail 30 large ashdown_email.json ABC-1186.pdf
echo "captured in $CAP"
