# Held-out authoring tasks

Two listen-fire authoring tasks the cost work was not tuned on. They measure whether its gains transfer.

- Task 1 (`tasks/t1_members`): Telegram bot messages go into an Airtable table, one row per Telegram user. A row is created or updated by the user's id.
- Task 2 (`tasks/t2_digest`): every Monday, one Airtable row summarising open tickets, with a count per assignee.

## Arms

- `old`: listen-fire v0.14.2 with the harness from before adopt-0.13@5017c2df. That means the builder skill, the JSON catalog, the old cheat sheet and v0.14.2's handbook front page.
- `new`: listen-fire main@d78f064454 with the harness as of 0bfa2400.
- `primer`: `new`, with `../programs/lf_primer.md` in place of the cheat sheet.

## Files

- `author.cjs`: one authoring session. It is `../author_lf.cjs` with the task's scenario parts swapped in.
- `grade.cjs`: drives the authored program through the real `listen-fire` against fake-channels' Airtable, then checks the table contents.
- `world.cjs`: the seeded bases.
- `run.sh`: runs everything.
- `agent_tools.cjs` and `signin.cjs`: snapshots of the harness's own copies.

## Running it

```bash
DRY=1 LF_SRC=<listen-fire> ./run.sh       # no model call: reference programs through the grader
SPEND_HARD_CAP_USD=2.50 SPEND_LEDGER=<file> LF_SRC=<listen-fire> ./run.sh
```

Each run needs `target/debug/lf-0142` and `target/debug/lf-d78f` in the listen-fire checkout, plus `ANTHROPIC_API_KEY` in `apps/api/.env`.
