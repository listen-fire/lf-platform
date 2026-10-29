# Field-service demo

A plumbing firm's customers message its WhatsApp Business number. Each message
becomes one row in the Job log sheet, and an urgent one also pages the on-call
engineer (Dan Price) in the firm's `#on-call` Slack channel. The run shows:

- the draft refused by `listen-fire check`: it writes an `Address` column the sheet's
  Jobs table does not have (`MOV_WRITE_UNKNOWN_FIELD`);
- the one-line fix (`Site address`), which checks clean;
- two real runs under `listen-fire serve`, each with one model call that classifies the
  job as `"urgent"` or `"routine"`: a dripping tap (logged only) and water
  through a ceiling (logged and paged).

It records on the open-source `listen-fire` CLI, not the platform's dev loop. The
platform's shared WhatsApp number only carries team members' own messages,
while under `listen-fire` the project brings its own number and any customer reaches it.

Paging is on Slack, not Telegram. Under `listen-fire`, a Telegram message must reply to
a message or go to a person who linked their account, and `listen-fire` keeps no
linked accounts.

## Make it

Needs `ANTHROPIC_API_KEY` in `apps/api/.env`, `jq`, node 22, and a
listen-fire checkout beside this repo (its fakes stand in for WhatsApp,
Google Sheets and Slack).

```bash
cd docs/demo/field-service
LF_BIN=<listen-fire binary> LF_SRC=<listen-fire checkout> ./capture.sh
node build_data.cjs ../../../../listen-fire-site/video/field-service/data.js
```

- `LF_BIN` defaults to `listen-fire` on PATH (a release). `LF_SRC`, when set, makes listen-fire
  serve the modules from that checkout's sources, and its commit is recorded.
- The current recording is from listen-fire's `airtable-enums` branch (listen-fire
  0.12.9 plus the commits that let listen-fire reach a sheet's tables through
  `spreadsheet:`). Released 0.12.9 refuses the program, so `validatedUnder`
  reads `0.12.9+<commit>`. Once a release has those commits, re-record with
  `./capture.sh` and no variables.

`capture.sh` starts from nothing every time. It makes a fresh project in
`.work/` with `listen-fire init`, starts the fakes on a free port, and connects each
module to them with stub credentials. It then checks the draft and the fix,
starts `listen-fire serve`, and sends two signed WhatsApp deliveries. Everything it
starts is stopped when it exits.

## What is in it

- `programs/request.txt`: what the user asked for.
- `programs/draft.mvt`, `programs/fixed.mvt`: the program before and after
  the fix.
- `programs/job_log.json`: the Job log spreadsheet, seeded into the fake.
- `programs/on_call.json`: the `#on-call` channel, seeded into the fake Slack.
- `capture.sh`: the recording. `signin.cjs` plays the browser's part of the
  Google sign-in against the fake. `deliver.cjs` sends one signed delivery
  and times its run.
- `build_data.cjs`: the captures into the video's `data.js`. It refuses to
  build when a run failed, the draft is not refused with exactly one error,
  the routine job paged anyone, or the urgent one did not.

## Where the figures come from

- `validatedUnder`: `listen-fire --version`, plus the listen-fire commit when `LF_SRC` is set.
- `saved`: listen-fire has no save step, so this is the fixed program's clean check plus the program's own `listen` line.
- `modelCalls`: listen-fire does not count model calls, so this is the number of extraction entries in the run's trace.
- `costUsd`: the run's `costMicrodollars` from `listen-fire runs show`, divided by a million.
- `ms`: measured by `capture.sh`, from sending the delivery to `listen-fire serve` printing the finished run.
- `writes`: the sheet rows and Slack messages the fakes gained during that run.

The spreadsheet grant is the one setup step listen-fire has no command for. Google
only shows the app spreadsheets the user picked. listen-fire has no picker, so
`capture.sh` writes the pick into the module's own state file
(`MODULE_STATE_DIR`).
