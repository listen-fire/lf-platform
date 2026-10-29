#!/bin/bash
# The three options, each set up for success, then put through the same
# stressors, against the same stand-ins, each from a reset state:
#
#   1. the per-event agent: a fresh agent session for each delivery, behind a
#      webhook endpoint (receivers.cjs agent, baseline.cjs);
#   2. JavaScript: the model writes a sandbox handler (author_js.cjs); the
#      sandbox stores each delivery, acknowledges it, then runs the handler
#      (receivers.cjs js, sandbox.cjs);
#   3. listen-fire: the model writes the program (author_lf.cjs) with the
#      connected systems described up front, the listen-fire cheat sheet, the
#      listen-fire-builder skill, the handbook, `listen-fire check` and a dry run;
#      Stripe is connected through @lf/stripe, whose door checks the Stripe
#      signature; `listen-fire serve --doors-only` stores and acknowledges each
#      delivery, and the host's worker (`listen-fire drain`) runs it. @lf/stripe's
#      reads (an invoice's customer or subscription) reach listen-fire's fake
#      Stripe API, seeded with the same world (stripe_api.cjs).
#
# Every option is told the same request, retry email and operating
# environment (prompts.cjs). For JavaScript and listen-fire a failed run is
# not run again by itself: the host wakes the agent (wake.cjs), which decides
# what to do. For listen-fire the host also runs `listen-fire check` every 30 s and
# wakes the agent on new errors. stress.cjs is the host.
#
# The stressors, the same for all three (day 1's 20 payments and 5 of day 2's,
# every Stripe email the CRM's, made with make_events.cjs plain):
#   1. the 3rd, 8th and 17th payment delivered twice (Stripe's redelivery);
#   2. the CRM answers one call about the 5th payment's customer 503 and one
#      about the 15th's 429, each with Retry-After: 1 (the next call succeeds);
#   3. the CRM renames `yearly` to `annual_plan` (its data and its tools'
#      output schemas); 45 s later 5 more payments arrive, 2 on that plan.
#
# JavaScript and listen-fire are authored three times each from the same
# state; every attempt goes through the stressors. Outputs land in
# .work/compare/capture/; build_data.cjs reads them beside capture.sh's
# review recording (.work/capture/), so run capture.sh first. Re-runnable:
# each run starts .work/compare/ from nothing.
#
#   LF_BIN, LF_SRC, LF_BRANCHES   as capture.sh (a merged and deleted branch
#                                 as <name>=<commit>)
#   SCENARIO                      mcp (default) or attio, the CRM every option
#                                 reaches:
#                                 mcp    an MCP server whose tools are generic
#                                        (crm_server.cjs, CRM_SCHEMA=generic):
#                                        plan a plain string, the workspace's
#                                        options answered as data by
#                                        describe_fields. lf through @lf/mcp,
#                                        JavaScript and the per-event agent
#                                        through the MCP SDK's client.
#                                 attio  Attio (fake-channels' Attio behind
#                                        attio_crm.cjs): plan a select
#                                        attribute. listen-fire through its native
#                                        connector @lf/attio, JavaScript and
#                                        the per-event agent through Attio's
#                                        REST API with a plain HTTP helper
#                                        (crm_access.cjs).
#                                 Outputs land in .work/compare/<scenario>/.
#   ATTEMPTS                      authoring attempts per option (default 3)
#   ONLY_LF                       re-record listen-fire alone: the scenario's
#                                 per-event agent and JavaScript recordings
#                                 (capture/agent, capture/js) are kept as they
#                                 are, and everything else is made anew (the
#                                 events are the same: make_events.cjs is
#                                 seeded)
#   REHEARSE_JS, REHEARSE_LF      a rehearsal of the stressors with no
#                                 authoring: this handler and this program
#                                 stand in for every attempt, and the
#                                 per-event agent is left out (a woken agent
#                                 still calls the model)
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
SCENARIO="${SCENARIO:-mcp}"
case "$SCENARIO" in mcp) export CRM_KIND=mcp ;; attio) export CRM_KIND=rest ;; *) echo "SCENARIO is mcp or attio"; exit 1 ;; esac
WORK="$HERE/.work/compare/$SCENARIO"
CAP="$WORK/capture"
TEMPLATE="$WORK/template/billing"
LF_BIN="${LF_BIN:-listen-fire}"
FAKES_SRC="${LF_SRC:-$REPO/../listen-fire}"
STRIPE_SECRET=whsec_ledgerline_stand_in_7d1c2b
STRIPE_API_KEY=rk_test_ledgerline_stand_in_4e9a0f
CRM_TOKEN=crm-stand-in-token
PROGRAM=movements/payment_failed.mvt
ATTEMPTS="${ATTEMPTS:-3}"

KEPT="$HERE/.work/compare/.kept_$SCENARIO"
if [ -n "${ONLY_LF:-}" ]; then
  [ -d "$CAP/agent" ] && [ -d "$CAP/js" ] || { echo "ONLY_LF keeps $CAP/agent and $CAP/js, and there are none"; exit 1; }
  rm -rf "$KEPT" && mkdir -p "$KEPT" && mv "$CAP/agent" "$CAP/js" "$KEPT/"
fi
rm -rf "$WORK"
mkdir -p "$CAP" "$WORK/fakes" "$WORK/template"
if [ -n "${ONLY_LF:-}" ]; then mv "$KEPT/agent" "$KEPT/js" "$CAP/" && rmdir "$KEPT"; fi

PIDS=()
cleanup() { for pid in "${PIDS[@]+"${PIDS[@]}"}"; do kill "$pid" 2>/dev/null || true; done; wait 2>/dev/null || true; }
trap cleanup EXIT INT TERM

if [ -n "${LF_SRC:-}" ]; then
  LF_SRC="$(cd "$LF_SRC" && pwd)"
  export LF_MODULES_DIR="$LF_SRC/modules"
  printf '#!/bin/sh\nexec node %s/packages/module-kit/bin/serve-module.cjs "$@"\n' "$LF_SRC" >"$WORK/serve-module"
  chmod +x "$WORK/serve-module"
  export LF_SERVE_MODULE="$WORK/serve-module"
  export LF_SRC
fi
export LF_BIN
LF_VERSION="$("$LF_BIN" --version | sed -n 's/^listen-fire //p' | head -1)"
BRANCHES="[]"
COMMIT=""
if [ -n "${LF_SRC:-}" ]; then
  COMMIT="$(git -C "$LF_SRC" rev-parse --short HEAD)"
  # A branch is named as it is now, or as <name>=<commit> once it is gone
  # (merged and deleted): the commit is recorded under the branch's name.
  for b in ${LF_BRANCHES:-}; do
    name="${b%%=*}"; ref="${b#*=}"
    git -C "$LF_SRC" merge-base --is-ancestor "$ref" HEAD || { echo "$b is not in LF_SRC's history"; exit 1; }
    BRANCHES="$(jq -c --arg b "$name" --arg c "$(git -C "$LF_SRC" rev-parse --short "$ref")" '. + [{branch: $b, commit: $c}]' <<<"$BRANCHES")"
  done
fi
jq -n --arg version "$LF_VERSION" --arg commit "$COMMIT" --argjson branches "$BRANCHES" --arg scenario "$SCENARIO" \
  '{version: $version, commit: (if $commit == "" then null else $commit end), branches: $branches, scenario: $scenario}' >"$CAP/00_lf.json"
cp "$HERE/programs/request.txt" "$CAP/01_request.txt"
cp "$HERE/programs/retry_email.txt" "$CAP/02_retry_email.txt"

ANTHROPIC_KEY="$(sed -n 's/^ANTHROPIC_API_KEY=//p' "$REPO/apps/api/.env" | head -1 | tr -d "\"'")"
[ -n "$ANTHROPIC_KEY" ] || { echo "no ANTHROPIC_API_KEY in apps/api/.env"; exit 1; }

# The stand-ins, as capture.sh starts them.
(cd "$WORK/fakes" && FAKE_CHANNELS_PORT=0 exec node "$FAKES_SRC/packages/fake-channels/bin/fake-channels.cjs") >"$WORK/fakes.log" 2>&1 &
PIDS+=($!)
for _ in $(seq 120); do grep -q 'running on http://localhost:' "$WORK/fakes.log" && break; sleep 0.25; done
F="http://127.0.0.1:$(sed -n 's/.*running on http:\/\/localhost:\([0-9]*\).*/\1/p' "$WORK/fakes.log" | head -1)"
[ "$F" != "http://127.0.0.1:" ] || { echo "fake-channels did not start (see $WORK/fakes.log)"; exit 1; }
seed() { curl -sf -XPOST "$F/admin/$1/seed" -H 'content-type: application/json' -d @"$HERE/programs/$2" >/dev/null; }
for kind in slack/channel slack/user slack/message gmail/message; do curl -sf -XDELETE "$F/admin/$kind/state" >/dev/null; done
seed slack accounts_channel.json
seed gmail mailbox.json
curl -sf "$F/admin/slack/channel/state" >"$CAP/03_slack_channels.json"
# Every option starts from this: no mail sent, no Slack messages.
reset() {
  for kind in slack/message gmail/message; do curl -sf -XDELETE "$F/admin/$kind/state" >/dev/null; done
  seed gmail mailbox.json
}

CRM_CALLS="$WORK/crm_calls.jsonl"
: >"$CRM_CALLS"
if [ "$SCENARIO" = attio ]; then
  CRM_TOKEN="$CRM_TOKEN" node "$HERE/attio_crm.cjs" "$F" "$CRM_CALLS" >"$WORK/crm.log" 2>&1 &
else
  CRM_SCHEMA=generic CRM_TOKEN="$CRM_TOKEN" node "$HERE/crm_server.cjs" "$CRM_CALLS" >"$WORK/crm.log" 2>&1 &
fi
PIDS+=($!)
for _ in $(seq 120); do grep -q '^listening ' "$WORK/crm.log" && break; sleep 0.25; done
grep -q '^listening ' "$WORK/crm.log" || { echo "the CRM did not start (see $WORK/crm.log)"; exit 1; }
CRM_URL="http://127.0.0.1:$(sed -n 's/^listening //p' "$WORK/crm.log")"
[ "$SCENARIO" = attio ] || CRM_URL="$CRM_URL/mcp"

# The 20 payments, and the example event (the first of them).
mkdir -p "$CAP/events"
node "$HERE/make_events.cjs" 1 "$CAP/events" plain >/dev/null
EVENTS=("$CAP/events/"*.json)
EXAMPLE="$CAP/events/01.json"
mkdir -p "$WORK/day2"
node "$HERE/make_events.cjs" 2 "$WORK/day2" plain >/dev/null

# Stripe's API, for whatever @lf/stripe reads beyond the event itself.
STRIPE_READS="$WORK/stripe_reads.jsonl"
: >"$STRIPE_READS"
LF_SRC="${LF_SRC:-$FAKES_SRC}" node "$HERE/stripe_api.cjs" "$STRIPE_API_KEY" "$STRIPE_READS" "$CAP/events" "$WORK/day2" >"$WORK/stripe_api.log" 2>&1 &
PIDS+=($!)
for _ in $(seq 120); do grep -q '^listening ' "$WORK/stripe_api.log" && break; sleep 0.25; done
grep -q '^listening ' "$WORK/stripe_api.log" || { echo "the Stripe API did not start (see $WORK/stripe_api.log)"; exit 1; }
STRIPE_API_URL="http://127.0.0.1:$(sed -n 's/^listening //p' "$WORK/stripe_api.log")"

# The listen-fire project with its connections and no program, as capture.sh
# sets one up; each listen-fire attempt starts from a copy of it.
(cd "$WORK/template" && "$LF_BIN" init billing >/dev/null)
rm -f "$TEMPLATE/movements/"*.mvt
(
  cd "$TEMPLATE"
  "$LF_BIN" connect @lf/stripe --yes --base-url "$STRIPE_API_URL" >/dev/null
  printf '%s\n%s\n' "$STRIPE_API_KEY" "$STRIPE_SECRET" | "$LF_BIN" credential add --module stripe stripe_account >/dev/null
  if [ "$SCENARIO" = attio ]; then
    printf '\n\n' | "$LF_BIN" connect @lf/attio --yes >/dev/null
    printf '%s\n%s\n' "$CRM_TOKEN" "$CRM_URL" | "$LF_BIN" credential add --module attio crm --credential attio_token >/dev/null
  else
    "$LF_BIN" connect @lf/mcp --yes >/dev/null
    printf '%s\n%s\n\n' "$CRM_URL" "$CRM_TOKEN" | "$LF_BIN" credential add --module @lf/mcp crm --credential mcp_token >/dev/null
  fi
  printf 'stub-gmail-client\nstub-gmail-secret\n8979\n' | "$LF_BIN" connect @lf/gmail --yes --base-url "$F" \
    --oauth-authorize-url "$F/oauth/authorize" --oauth-token-url "$F/oauth/token" >/dev/null
  node "$HERE/signin.cjs" "$LF_BIN" gmail billing_mail gmail billing@ledgerline.io '' '' '' '' '' '' >/dev/null
  printf '\n' | "$LF_BIN" connect @lf/slack --base-url "$F/slack" >/dev/null
  printf 'xoxb-stub\n\n\n\n' | "$LF_BIN" credential add --module slack team_slack >/dev/null
)
[ -n "${STOP_AFTER_SETUP:-}" ] && { echo "F=$F CRM_URL=$CRM_URL PIDS=${PIDS[*]}"; trap - EXIT; exit 0; }

# What every system looks like before any program exists: `listen-fire catalog` over
# a scratch program that imports every credential the project has, made from
# the empty project's own catalog (its credentials and their adapters).
scratch="$WORK/describe/billing"
mkdir -p "$(dirname "$scratch")"
cp -R "$TEMPLATE" "$scratch"
(
  cd "$scratch"
  "$LF_BIN" catalog | jq -r '
    .credentials | to_entries as $c
    | "import { \([$c[].value.adapters[0]] | unique | join(", ")) } from adapters",
      "import { \([$c[].key] | join(", ")) } from credentials",
      "",
      ($c[] | "\(.key)_connection = connect \(.value.adapters[0]) using \(.key)")' >movements/describe.mvt
  cp movements/describe.mvt "$CAP/04_describe_scratch.mvt"
  "$LF_BIN" catalog >"$CAP/04_describe_systems.json"
)
if [ "$SCENARIO" = attio ]; then crm_described='.credentials.crm'; else crm_described='.adapters.mcp.schemas.crm'; fi
jq -e "$crm_described" "$CAP/04_describe_systems.json" >/dev/null || { echo "describe_systems has no CRM"; exit 1; }

# The stressors' plan: day 1's 20 payments (3 of them twice, a 503 before the
# 5th and a 429 before the 15th), then the rename and 5 of day 2's payments.
crm_id() { node -e 'const {customers}=require(process.argv[1]);const e=require(process.argv[2]);console.log(customers.find((c)=>c.stripe.id===e.data.object.customer).crm.crm_id)' "$HERE/programs/customers.cjs" "$1"; }
mkdir -p "$CAP/events_after_rename"
i=0
for id in C-10533 C-10544 C-10549 C-10578 C-10555; do
  i=$((i + 1))
  for f in "$WORK/day2/"*.json; do [ "$(crm_id "$f")" = "$id" ] && cp "$f" "$CAP/events_after_rename/$(printf '%02d' $i).json"; done
done
ITEMS="$WORK/items.json"
{
  n=0
  for f in "${EVENTS[@]}"; do
    n=$((n + 1))
    case $n in
      5) jq -nc --argjson n $n --arg f "$f" --arg c "$(crm_id "$f")" '{payment: $n, kind: "original", file: $f, failCrm: $c, failStatus: 503}' ;;
      15) jq -nc --argjson n $n --arg f "$f" --arg c "$(crm_id "$f")" '{payment: $n, kind: "original", file: $f, failCrm: $c, failStatus: 429}' ;;
      *) jq -nc --argjson n $n --arg f "$f" '{payment: $n, kind: "original", file: $f}' ;;
    esac
    case $n in 3 | 8 | 17) jq -nc --argjson n $n --arg f "$f" '{payment: $n, kind: "duplicate", file: $f}' ;; esac
  done
  for f in "$CAP/events_after_rename/"*.json; do
    n=$((n + 1))
    if [ $n = 21 ]; then
      jq -nc --argjson n $n --arg f "$f" '{payment: $n, kind: "original", phase: "after rename", file: $f, renamePlan: {from: "yearly", to: "annual_plan"}}'
    else
      jq -nc --argjson n $n --arg f "$f" '{payment: $n, kind: "original", phase: "after rename", file: $f}'
    fi
  done
} | jq -s . >"$ITEMS"
cp "$ITEMS" "$CAP/plan_items.json"
stress() { # <mode> <url> <out dir> [extra config json]
  local extra="${4:-}"
  [ -n "$extra" ] || extra='{}'
  jq -n --arg mode "$1" --arg url "$2" --arg out "$3" --arg secret "$STRIPE_SECRET" --arg fakes "$F" --arg crm "${CRM_URL%/mcp}" --arg calls "$CRM_CALLS" \
    --slurpfile items "$ITEMS" --argjson extra "$extra" \
    '{mode: $mode, url: $url, out: $out, secret: $secret, fakes: $fakes, crm: $crm, crmCalls: $calls, items: $items[0], renameWaitMs: 45000} + $extra' >"$3.config.json"
  ANTHROPIC_API_KEY="$ANTHROPIC_KEY" node "$HERE/stress.cjs" "$3.config.json" | tee "$3.summary.txt"
}
rename_back() { curl -sf -XPOST "${CRM_URL%/mcp}/admin/rename-plan" -d '{"from":"annual_plan","to":"yearly"}' >/dev/null; }
receiver() { # <log> <args…>: starts receivers.cjs, sets RECEIVER_PID and RECEIVER_BASE
  local log="$1"; shift
  ANTHROPIC_API_KEY="$ANTHROPIC_KEY" node "$HERE/receivers.cjs" "$@" >"$log" 2>&1 &
  RECEIVER_PID=$!
  PIDS+=($RECEIVER_PID)
  for _ in $(seq 120); do grep -q '^listening ' "$log" && break; sleep 0.25; done
  RECEIVER_BASE="http://127.0.0.1:$(sed -n 's/^listening //p' "$log")"
}

# 1. The per-event agent.
if [ -z "${REHEARSE_JS:-}" ] && [ -z "${ONLY_LF:-}" ]; then
  reset
  mkdir -p "$CAP/agent"
  receiver "$WORK/agent_receiver.log" agent "$WORK/agent_memory.json" "$CAP/agent/sessions.jsonl" "$F" "$CRM_URL" "$CRM_TOKEN" "$STRIPE_SECRET"
  stress agent "$RECEIVER_BASE/stripe" "$CAP/agent/stress"
  kill "$RECEIVER_PID"
  rename_back
  [ -f "$WORK/agent_memory.json" ] && cp "$WORK/agent_memory.json" "$CAP/agent/memory.json"
fi

# 2. JavaScript.
mkdir -p "$CAP/js"
for k in $( [ -n "${ONLY_LF:-}" ] || seq "$ATTEMPTS"); do
  reset
  if [ -n "${REHEARSE_JS:-}" ]; then cp "$REHEARSE_JS" "$CAP/js/handler_$k.js"; else
    ANTHROPIC_API_KEY="$ANTHROPIC_KEY" node "$HERE/author_js.cjs" "$F" "$CRM_URL" "$CRM_TOKEN" "$EXAMPLE" "$CAP/js/handler_$k.js" "$CAP/js/attempt_$k.json" | tee "$CAP/js/attempt_${k}_summary.txt"
  fi
  [ -f "$CAP/js/handler_$k.js" ] || { echo "js attempt $k wrote no handler"; continue; }
  cp "$CAP/js/handler_$k.js" "$CAP/js/handler_${k}_authored.js"
  reset
  live="$WORK/js_$k"
  mkdir -p "$live"
  receiver "$live/receiver.log" js "$CAP/js/handler_$k.js" "$live/kv.json" "$CAP/js/store_$k.jsonl" "$CAP/js/invocations_$k.jsonl" "$F" "$CRM_URL" "$CRM_TOKEN" "$STRIPE_SECRET"
  stress js "$RECEIVER_BASE/stripe" "$CAP/js/stress_$k" "$(jq -nc --arg r "$RECEIVER_BASE" --arg h "$CAP/js/handler_$k.js" --arg s "$CAP/js/store_$k.jsonl" --arg l "$CAP/js/invocations_$k.jsonl" --arg u "$CRM_URL" --arg t "$CRM_TOKEN" \
    '{js: {receiver: $r, handlerFile: $h, storeFile: $s, logFile: $l, crmUrl: $u, crmToken: $t}}')"
  kill "$RECEIVER_PID"
  rename_back
  [ -f "$live/kv.json" ] && cp "$live/kv.json" "$CAP/js/kv_$k.json"
done

# 3. listen-fire.
mkdir -p "$CAP/lf"
for k in $(seq "$ATTEMPTS"); do
  reset
  project="$WORK/lf/$k/billing"
  mkdir -p "$(dirname "$project")"
  cp -R "$TEMPLATE" "$project"
  if [ -n "${REHEARSE_LF:-}" ]; then cp "$REHEARSE_LF" "$project/$PROGRAM"; else
    ANTHROPIC_API_KEY="$ANTHROPIC_KEY" node "$HERE/author_lf.cjs" "$project" "$EXAMPLE" "$CAP/04_describe_systems.json" "$CAP/lf/attempt_$k.json" | tee "$CAP/lf/attempt_${k}_summary.txt"
  fi
  (cd "$project" && { "$LF_BIN" check --json >"$CAP/lf/attempt_${k}_check.json" || true; })
  [ -f "$project/$PROGRAM" ] && cp "$project/$PROGRAM" "$CAP/lf/program_${k}_authored.mvt"
  jq -e '.ok' "$CAP/lf/attempt_${k}_check.json" >/dev/null || { echo "lf attempt $k: the program does not check clean; not served"; continue; }

  reset
  log="$WORK/lf/$k/serve.log"
  real="$(cd "$project" && pwd -P)"
  PORT=$(node -e 'const s=require("net").createServer().listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')
  echo "publicUrl: http://127.0.0.1:$PORT" >>"$project/lf.yaml"
  (cd "$project" && exec "$LF_BIN" serve --port "$PORT" --doors-only) >"$log" 2>&1 &
  SERVE_PID=$!
  PIDS+=($SERVE_PID)
  for _ in $(seq 120); do grep -q '^stripe stripe_account: ' "$log" && break; sleep 0.25; done
  grep -q '^stripe stripe_account: ' "$log" || { echo "listen-fire serve did not start (see $log)"; exit 1; }
  stress lf "$(sed -n 's/^stripe stripe_account: //p' "$log" | head -1)" "$CAP/lf/stress_$k" "$(jq -nc --arg p "$project" --arg prog "$PROGRAM" --arg d "$CAP/04_describe_systems.json" --arg dp "$scratch" --arg src "${LF_SRC:-$REPO/../listen-fire}" \
    '{lf: {project: $p, program: $prog, describeFile: $d, describeProject: $dp, lfSrc: $src, checkEveryMs: 30000}}')"
  mkdir -p "$CAP/lf/stress_$k/runs"
  for id in $(cd "$project" && "$LF_BIN" runs --json | jq -r '.runs[]?.runId // .[]?.runId'); do
    (cd "$project" && "$LF_BIN" runs show "$id" --json) >"$CAP/lf/stress_$k/runs/$id.json"
  done
  (cd "$project" && "$LF_BIN" deliveries --json) >"$CAP/lf/stress_$k/deliveries_kept.json" || true
  cp "$project/$PROGRAM" "$CAP/lf/program_${k}_final.mvt"
  kill "$SERVE_PID"
  sleep 1
  sed -E -e $'s/\x1b\\[[0-9;?]*[A-Za-z]//g' -e "s#$real/##g" -e "s#$project/##g" "$log" >"$CAP/lf/stress_$k/serve.log"
  rename_back
done
for k in $( [ -n "${ONLY_LF:-}" ] || seq "$ATTEMPTS"); do [ -f "$CAP/js/handler_$k.js" ] && cp "$CAP/js/handler_$k.js" "$CAP/js/handler_${k}_final.js"; done
unset ANTHROPIC_KEY
cp "$CRM_CALLS" "$CAP/crm_calls.jsonl"
cp "$STRIPE_READS" "$CAP/stripe_reads.jsonl"
echo "captured in $CAP"
