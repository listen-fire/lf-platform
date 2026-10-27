# Invoices demo

An architecture practice's finance team (Fenwick & Shaw, Bristol) gets supplier
invoices by email at accounts@fenwickshaw.co.uk. Each invoice's PDF is filed in
Drive under `Invoices / <supplier> / <YYYY-MM>`, added as a row to the Ledger
sheet, and anything over £5,000 is flagged in the `#finance` Slack channel.
The run shows:

- the draft refused by `lf check`: it compares the extracted currency, typed
  as the set `GBP | EUR | USD`, with `"£"`, which is not in the set
  (`MOV_ENUM_UNKNOWN_VALUE`); as written, nothing would ever be flagged;
- the one-line fix (`"GBP"`), which checks clean;
- two real runs under `lf serve`, each started by Gmail's poll, each with one
  model call that reads the PDF: £840.00 from Paperworks Stationery (filed and
  added to the ledger) and £12,600.00 from Ashdown Building Contractors (filed,
  added, and flagged).

## Make it

Needs `ANTHROPIC_API_KEY` in `apps/api/.env`, `jq`, node 22, Google Chrome (it prints the invoices), and a listen-fire checkout beside
this repo (its fakes stand in for Gmail, Google Drive, Google Sheets and Slack).

```bash
cd docs/demo/invoices
LF_BIN=<lf binary> LF_SRC=<listen-fire checkout> ./capture.sh
node build_data.cjs ../../../../listen-fire-site/video/invoices/data.js
```

- `LF_BIN` defaults to `lf` on PATH (a release). `LF_SRC`, when set, makes lf
  serve the modules from that checkout's sources, and its branch and commit
  are recorded. `CHROME` names another Chrome binary.
- The recording is from lf 0.12.10 built from listen-fire's `main`, so
  `validatedUnder` reads `0.12.10 (main@<commit>)`.

`capture.sh` starts from nothing every time. It prints the two invoices, makes
a fresh project in `.work/` with `lf init`, starts the fakes on a free port,
and connects each module to them with stub credentials. It then checks the
draft and the fix, starts `lf serve`, waits for it to say Gmail's listen is
armed (the first poll only sets the mark), and drops two supplier emails into
the mailbox. Everything it starts is stopped when it exits.

## What is in it

- `programs/request.txt`: what the user asked for.
- `programs/draft.mvt`, `programs/fixed.mvt`: the program before and after the fix.
- `programs/ledger.json`: the Ledger spreadsheet, seeded into the fake.
- `programs/drive.json`: the `Invoices` folder, seeded into the fake Drive.
- `programs/finance.json`: the `#finance` channel, seeded into the fake Slack.
- `programs/mailbox.json`: the finance mailbox's address, seeded into the fake Gmail.
- `programs/*_email.json`: the two suppliers' emails (the PDF is attached when sent).
- `invoices/`: each invoice's figures, and `make_invoices.cjs`, which prints
  them as PDFs with a real text layer. The PDFs are never committed.
- `capture.sh`: the recording. `signin.cjs` plays the browser's part of the
  Google sign-in against the fake. `mail.cjs` sends one email, notes when, and waits for its run.
- `build_data.cjs`: the captures into the video's `data.js`; its header
  documents the shape and where each figure comes from. Each run's writes are
  lf's own record of them (`lf runs show --json`), checked against what the
  fakes gained. It refuses to build when a run failed, the draft is not
  refused with exactly one error, a run made other than one model call, a PDF
  did not arrive in Drive intact (its bytes, hash and type `application/pdf`),
  or the wrong invoice was flagged.

## Setup steps lf has no command for

- The Drive folder and the spreadsheet grants. Google only shows the app the
  items the user picked. lf has no picker, so `capture.sh` writes each pick
  into the module's own state file (`MODULE_STATE_DIR`).
