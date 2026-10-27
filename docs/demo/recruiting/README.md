# Recruiting demo

A recruiting team keeps candidates in an Airtable base, Hiring, whose
Candidates table has a `Stage` select (Applied, Screen, Interview, Offer,
Rejected). When a candidate moves to Interview, the program:

- copies the "Interview scorecard" Doc in Drive into the Scorecards folder,
  named for the candidate;
- writes the copy's link to the candidate's `Scorecard` field;
- posts to `#hiring` on Slack, naming the interviewer, with the link;
- creates a Gmail draft to the candidate, for Hannah to check and send. Nothing
  is sent.

The run shows:

- the draft refused by `lf check`: it listens for `becomes: "Interviewing"`,
  which is not one of the `Stage` choices (`MOV_ENUM_UNKNOWN_VALUE`, with a
  did-you-mean);
- the one-word fix (`"Interview"`), which checks clean;
- two edits to the base under `lf serve`: Tomás moves from Applied to Screen
  (nothing runs), and Priya moves from Screen to Interview (one run, four
  writes, no model call).

It records on the open-source `lf` CLI, against the fakes for Airtable, Google
Drive, Slack and Gmail from the listen-fire repository.

## Make it

Needs `jq`, node 22, and a listen-fire checkout (its fakes stand in for the
four services). No model key: the program has no extraction.

```bash
cd docs/demo/recruiting
LF_BIN=<lf binary> LF_SRC=<listen-fire checkout> LF_BRANCHES=main ./capture.sh
node build_data.cjs ../../../../listen-fire-site/video/recruiting/data.js
```

- `LF_BIN` defaults to `lf` on PATH (a release). `LF_SRC`, when set, makes lf
  serve the modules from that checkout's sources, and its commit is recorded.
  `LF_BRANCHES` names the branch it was built from.
- The current recording is lf 0.12.10 built from listen-fire `main` at
  7191d2be43, so `validatedUnder` reads `0.12.10 (main@7191d2be43)`.

`capture.sh` starts from nothing every time. It makes a fresh project in
`.work/` with `lf init`, starts the fakes on a free port, seeds them, and
connects each module with stub credentials. It then checks the draft and the
fix, starts `lf serve` (which registers the Airtable webhook), and makes the
two edits. Everything it starts is stopped when it exits.

## What is in it

- `programs/request.txt`: what the user asked for.
- `programs/draft.mvt`, `programs/fixed.mvt`: the program before and after
  the fix.
- `programs/hiring_base.json`: the Hiring base, seeded into the fake Airtable.
- `programs/drive.json`: the template Doc and the Scorecards folder.
- `programs/hiring_channel.json`: the `#hiring` channel.
- `programs/mailbox.json`: Hannah's mailbox.
- `capture.sh`: the recording. `signin.cjs` plays the browser's part of each
  OAuth sign-in against the fake. `deliver.cjs` makes one edit (changes the
  cell, then has the fake send Airtable's webhook ping) and waits for the run,
  or for 5 seconds of no run.
- `build_data.cjs`: the captures into the video's `data.js`. Its header
  documents the shape. It refuses to build when the draft is not refused with
  exactly one `MOV_ENUM_UNKNOWN_VALUE` error, the fix is not clean, the Screen
  edit ran or wrote anything, the Interview run did not complete with exactly
  the copy, the field update, the post and the draft, the field or the post
  lack the copy's link, the draft is not to the candidate, or any email was
  sent.

## Where the figures come from

- `validatedUnder`: `lf --version`, plus the branch and commit of `LF_SRC`.
- `saved`: lf has no save step, so this is the fixed program's clean check plus the program's own `listen` line.
- `modelCalls`: lf does not count model calls, so this is the number of extraction entries in the run's trace (zero).
- `costUsd`: the run's `costMicrodollars` from `lf runs show`, divided by a million.
- `ms`: measured by `capture.sh`, from changing the cell to `lf serve` printing the finished run. `runMs` is lf's own start to finish.
- `writes`: what the fakes gained during that edit, the edit's own `Stage` change left out.
- The edit that does not fire: `lf serve` says the delivery ran nothing, `lf deliveries` shows it with no runs, and `lf runs` does not grow.

Two setup steps have no lf command:

- Drive only shows the app files the user picked, and lf has no picker. So
  `capture.sh` writes the picks (the template and the folder) into the
  module's own state file (`MODULE_STATE_DIR`).
- The fake Airtable has no UI. `deliver.cjs` changes the cell through the
  API and then asks the fake to send the webhook ping Airtable would send.
