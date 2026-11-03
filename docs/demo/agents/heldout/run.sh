#!/usr/bin/env bash
# The held-out measurement: authoring tasks no cost work was tuned on (t1,
# t2; t3 and t4 a second pair, made after the first was studied), each
# authored K times in two arms (old: listen-fire v0.14.2 and the harness
# before adopt-0.13@5017c2df; new: listen-fire main@d78f064454 and the harness
# now), every attempt graded by grade.cjs against the fakes.
#
#   LF_SRC=<listen-fire checkout> ./run.sh            the model sessions
#   DRY=1 LF_SRC=<listen-fire checkout> ./run.sh      no model call: each
#                                                     attempt's program is the
#                                                     task's reference.mvt
#
#   K                     attempts per task and arm (default 3)
#   ONLY                  space-separated <task>:<arm> pairs (default "t1:old
#                         t1:new t2:old t2:new"), any of t1–t4 with old, new or
#                         primer (new's listen-fire and harness,
#                         ../programs/lf_primer.md in the cheat sheet's place,
#                         copied to primer_arm/ first)
#   LF_BIN                the listen-fire the new and primer arms run (default
#                         <LF_SRC>/target/debug/lf-d78f); old's is always lf-0142
#   RUN_NAME              the work folder under .work/ (default run; DRY: dry)
#   SPEND_HARD_CAP_USD    with SPEND_LEDGER: the ceiling across every session
#                         (agent_tools.cjs); an attempt is not started when the
#                         ledger plus the dearest attempt so far (at least
#                         SPEND_ESTIMATE_USD, default 0.30) could pass it
#
# The order interleaves the arms (attempt 1 of each task and arm, then 2, …),
# so a stop at the ceiling leaves the arms evenly measured.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../../../.." && pwd)"
LF_SRC="$(cd "${LF_SRC:?LF_SRC is the listen-fire checkout}" && pwd)"
K="${K:-3}"
WORK="$HERE/.work/${RUN_NAME:-$([ -n "${DRY:-}" ] && echo dry || echo run)}"
# (bash 3.2: no associative arrays)
NEW_BIN="${LF_BIN:-$LF_SRC/target/debug/lf-d78f}"
case "$NEW_BIN" in /*) ;; *) NEW_BIN="$PWD/$NEW_BIN" ;; esac
bin() { if [ "$1" = old ]; then echo "$LF_SRC/target/debug/lf-0142"; else echo "$NEW_BIN"; fi; }
pname() { case "$1" in t1) echo community ;; t2) echo support ;; t3) echo events ;; t4) echo facilities ;; esac; }
program() { case "$1" in t1) echo movements/members.mvt ;; t2) echo movements/ticket_digest.mvt ;; t3) echo movements/enquiries.mvt ;; t4) echo movements/service_jobs.mvt ;; esac; }
taskdir() { case "$1" in t1) echo tasks/t1_members ;; t2) echo tasks/t2_digest ;; t3) echo tasks/t3_enquiries ;; t4) echo tasks/t4_service ;; esac; }

rm -rf "$WORK"
mkdir -p "$WORK/fakes" "$WORK/describe" "$WORK/events/t1" "$WORK/events/t2" "$WORK/events/t3" "$WORK/events/t4"

PIDS=()
cleanup() { for pid in "${PIDS[@]+"${PIDS[@]}"}"; do kill "$pid" 2>/dev/null || true; done; wait 2>/dev/null || true; }
trap cleanup EXIT INT TERM

export LF_MODULES_DIR="$LF_SRC/modules"
printf '#!/bin/sh\nexec node %s/packages/module-kit/bin/serve-module.cjs "$@"\n' "$LF_SRC" >"$WORK/serve-module"
chmod +x "$WORK/serve-module"
export LF_SERVE_MODULE="$WORK/serve-module" LF_SRC
for arm in old new; do "$(bin "$arm")" --version 2>/dev/null | head -1 | sed "s/^/$arm: /" || true; done

if [ -z "${DRY:-}" ]; then
  ANTHROPIC_KEY="$(sed -n 's/^ANTHROPIC_API_KEY=//p' "$REPO/apps/api/.env" | head -1 | tr -d "\"'")"
  [ -n "$ANTHROPIC_KEY" ] || { echo "no ANTHROPIC_API_KEY in apps/api/.env"; exit 1; }
  : "${SPEND_HARD_CAP_USD:?set SPEND_HARD_CAP_USD}" "${SPEND_LEDGER:?set SPEND_LEDGER}"
  export SPEND_HARD_CAP_USD SPEND_LEDGER
fi

(cd "$WORK/fakes" && FAKE_CHANNELS_PORT=0 exec node "$LF_SRC/packages/fake-channels/bin/fake-channels.cjs") >"$WORK/fakes.log" 2>&1 &
PIDS+=($!)
for _ in $(seq 120); do grep -q 'running on http://localhost:' "$WORK/fakes.log" && break; sleep 0.25; done
FAKES="http://127.0.0.1:$(sed -n 's/.*running on http:\/\/localhost:\([0-9]*\).*/\1/p' "$WORK/fakes.log" | head -1)"
[ "$FAKES" != "http://127.0.0.1:" ] || { echo "fake-channels did not start (see $WORK/fakes.log)"; exit 1; }
export FAKES
node "$HERE/world.cjs" "$FAKES" setup

node "$HERE/tasks/t1_members/events.cjs" "$LF_SRC" "$WORK/events/t1"
# T2's example: the tick the schedule's first Monday fires, as the cron unit
# hands it over (crates/lf/src/units.rs).
cat >"$WORK/events/t2/example.json" <<'EOF'
{"external":"cron","event":{"arrivals":[{"edge":"Ticks","identity":"tick:0 9 * * 1:UTC:2026-11-09T09:00:00.000Z","landing":{"recordType":"Tick","fields":{"Fired at":"2026-11-09T09:00:00.000Z","Schedule":"0 9 * * 1","Zone":"UTC"}},"occurredAt":"2026-11-09T09:00:00.000Z"}]}}
EOF
node "$HERE/tasks/t3_enquiries/events.cjs" "$WORK/events/t3"
node "$HERE/tasks/t4_service/events.cjs" "$WORK/events/t4"

project() { # <arm> <task> <dir>: a project with the task's connections and no program, made by that arm's listen-fire
  local arm="$1" task="$2" dir="$3" lfb="$(bin "$1")"
  mkdir -p "$dir"
  (cd "$dir" && "$lfb" init "$(pname "$task")" >/dev/null)
  (
    cd "$dir/$(pname "$task")"
    rm -f movements/*.mvt
    "$lfb" connect @lf/airtable --yes --base-url "$FAKES/airtable" --oauth-authorize-url "$FAKES/oauth/authorize" --oauth-token-url "$FAKES/oauth/token" \
      --client-id lf-airtable-app --client-secret lf-airtable-secret --redirect-port 0 >/dev/null
    node "$HERE/signin.cjs" "$lfb" @lf/airtable:airtable team_airtable >/dev/null
    if [ "$task" = t1 ]; then
      "$lfb" connect @lf/telegram --yes --webhook-secret tg-heldout-secret >/dev/null
      printf '123456:HELDOUT-BOT\n\n' | "$lfb" credential add --module telegram tg_bot --credential telegram >/dev/null
    fi
    if [ "$task" = t3 ]; then
      # Unsigned, and no idField: the form's posts carry no delivery id.
      "$lfb" connect @lf/webhook --yes >/dev/null
      printf 'none\n\n\n\n\n' | "$lfb" credential add --module webhook site_form >/dev/null
    fi
  )
}

# What every system looks like before any program exists, as each arm's
# harness made it: new, `listen-fire catalog`'s text; old, its JSON over a
# scratch program connecting every credential (compare.sh before 5017c2df).
PLAN="${ONLY:-t1:old t1:new t2:old t2:new}"
ARMS="$(for pair in $PLAN; do echo "${pair##*:}"; done | sort -u | tr '\n' ' ')"
case " $ARMS " in *" lookup "*)
  mkdir -p "$HERE/lookup_arm" && cp "${LOOKUP_FILE:-$HERE/../programs/lf_primer_basic.md}" "$HERE/lookup_arm/lf_primer_basic.md" ;;
esac
case " $ARMS " in *" primer "*)
  [ -f "${PRIMER_FILE:-$HERE/../programs/lf_primer.md}" ] || { echo "the primer arm needs ../programs/lf_primer.md"; exit 1; }
  mkdir -p "$HERE/primer_arm" && cp "${PRIMER_FILE:-$HERE/../programs/lf_primer.md}" "$HERE/primer_arm/lf_primer.md" ;;
esac
TASKS="$(for pair in $PLAN; do echo "${pair%%:*}"; done | sort -u | tr '\n' ' ')"
for task in $TASKS; do
  node "$HERE/world.cjs" "$FAKES" world "$task"
  for arm in $ARMS; do
    d="$WORK/describe/$task-$arm"
    project "$arm" "$task" "$d"
    (
      cd "$d/$(pname "$task")"
      if [ "$arm" != old ]; then "$(bin "$arm")" catalog >"$WORK/describe/$task-$arm.txt"; else
        "$(bin "$arm")" catalog | jq -r '.credentials | to_entries[] | "\(.key)_connection = connect `@lf/\(.value.adapters[0])` using \(.key)"' >movements/describe.mvt
        cp movements/describe.mvt "$WORK/describe/$task-$arm.scratch.mvt"
        "$(bin "$arm")" catalog >"$WORK/describe/$task-$arm.txt"
      fi
    )
    echo "describe $task/$arm: $(wc -c <"$WORK/describe/$task-$arm.txt") chars"
  done
done

ledger_total() { [ -n "${SPEND_LEDGER:-}" ] && [ -f "$SPEND_LEDGER" ] && jq -s 'map(.costUsd) | add // 0' "$SPEND_LEDGER" || echo 0; }
DEAREST="${SPEND_ESTIMATE_USD:-0.30}"
for k in $(seq "$K"); do
  for pair in $PLAN; do
    task="${pair%%:*}" arm="${pair##*:}"
    a="$WORK/attempts/$task-$arm-$k"
    if [ -z "${DRY:-}" ]; then
      spent="$(ledger_total)"
      if ! jq -en --argjson s "$spent" --argjson d "$DEAREST" --argjson cap "$SPEND_HARD_CAP_USD" '$s + $d <= $cap' >/dev/null; then
        echo "$task/$arm attempt $k not started: \$$spent spent, and an attempt may cost \$$DEAREST (cap \$$SPEND_HARD_CAP_USD)"
        continue
      fi
    fi
    project "$arm" "$task" "$a"
    p="$a/$(pname "$task")"
    node "$HERE/world.cjs" "$FAKES" reset "$task"
    if [ -n "${DRY:-}" ]; then
      # DRY_PROGRAMS (a folder of <task>.mvt) stands other programs in for the
      # references: the grader's own check that a wrong program fails.
      cp "${DRY_PROGRAMS:-$HERE/$(taskdir "$task")}/$([ -n "${DRY_PROGRAMS:-}" ] && echo "$task.mvt" || echo reference.mvt)" "$p/$(program "$task")"
      LF_BIN="$(bin "$arm")" PROMPT_ONLY=1 node "$HERE/author.cjs" "$arm" "$task" "$p" "$WORK/describe/$task-$arm.txt" "$WORK/events/$task/example.json" "$a/prompt.json"
      node "$HERE/world.cjs" "$FAKES" reset "$task"
    else
      ANTHROPIC_API_KEY="$ANTHROPIC_KEY" LF_BIN="$(bin "$arm")" node "$HERE/author.cjs" "$arm" "$task" "$p" "$WORK/describe/$task-$arm.txt" "$WORK/events/$task/example.json" "$a/attempt.json" || echo "$task/$arm attempt $k: the session failed"
      cost="$(jq -r '.costUsd // 0' "$a/attempt.json" 2>/dev/null || echo 0)"
      DEAREST="$(jq -n --argjson a "$DEAREST" --argjson b "$cost" '[$a, $b] | max')"
    fi
    [ -f "$p/$(program "$task")" ] && cp "$p/$(program "$task")" "$a/program.mvt"
    LF_BIN="$(bin "$arm")" node "$HERE/grade.cjs" "$task" "$p" "$WORK/events/$task" "$a/grade.json" || echo "$task/$arm attempt $k: the grader failed"
  done
done
node "$HERE/summarize.cjs" "$WORK" | tee "$WORK/summary.txt"
