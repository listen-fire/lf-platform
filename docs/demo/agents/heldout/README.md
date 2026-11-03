# Held-out authoring tasks

Listen-fire authoring tasks the cost work was not tuned on. They measure whether its gains transfer.

- Task 1 (`tasks/t1_members`): Telegram bot messages go into an Airtable table, one row per Telegram user. A row is created or updated by the user's id.
- Task 2 (`tasks/t2_digest`): every Monday, one Airtable row summarising open tickets, with a count per assignee.

Tasks 1 and 2 have since been studied and taught to. Tasks 3 and 4 are a second pair, made without looking at the reference material being measured:

- Task 3 (`tasks/t3_enquiries`): a website form posts enquiries to an unsigned `@lf/webhook` URL. Each becomes one row of an Airtable table, keyed by its enquiry id. It is assigned to the client's account manager when the email is a known client, and to a default person otherwise. Its priority depends on how soon the event is and how many guests it has.
- Task 4 (`tasks/t4_service`): every morning, equipment whose service date is within a week or past gets a service job. Retired equipment and equipment with an open job are skipped, and jobs the team has booked or closed are left alone.

`tasks/wrong_a` and `tasks/wrong_b` hold a deliberately wrong T3 and T4 each (the first line of each says what is wrong). They are the grader's check that a wrong program fails.

## Arms

- `old`: listen-fire v0.14.2 with the harness from before adopt-0.13@5017c2df. That means the builder skill, the JSON catalog, the old cheat sheet and v0.14.2's handbook front page.
- `new`: listen-fire main@d78f064454 with the harness as of 0bfa2400.
- `primer`: `new`, with `../programs/lf_primer.md` in place of the cheat sheet.
- `lookup`: `new`, with `../programs/lf_primer_basic.md` (copied to `lookup_arm/`) in place of the cheat sheet, and one more tool, `example`, which runs `<LF_BIN> example <words>` (checked micro examples).

## Files

- `author.cjs`: one authoring session. It is `../author_lf.cjs` with the task's scenario parts swapped in.
- `grade.cjs`: drives the authored program through the real `listen-fire` against fake-channels' Airtable, then checks the table contents. T3 and T4 grade in `tasks/<task>/grade.cjs`.
- `world.cjs`: the seeded bases. T1 and T2 share one world, and T3 and T4 another (`tasks/t3_enquiries/world.cjs`, `tasks/t4_service/world.cjs`). A task's reset puts its world in place.
- `run.sh`: runs everything.
- `agent_tools.cjs` and `signin.cjs`: snapshots of the harness's own copies.

## Running it

```bash
DRY=1 LF_SRC=<listen-fire> ./run.sh       # no model call: reference programs through the grader
DRY=1 DRY_PROGRAMS=tasks/wrong_a ONLY="t3:new t4:new" LF_SRC=<listen-fire> ./run.sh   # wrong programs: must fail
SPEND_HARD_CAP_USD=2.50 SPEND_LEDGER=<file> LF_SRC=<listen-fire> ./run.sh
```

Each run needs `target/debug/lf-0142` and `target/debug/lf-d78f` in the listen-fire checkout, plus `ANTHROPIC_API_KEY` in `apps/api/.env`. `LF_BIN` replaces `lf-d78f` as the listen-fire of the new and primer arms. `ONLY` picks `<task>:<arm>` pairs, e.g. `ONLY="t3:new t4:new t3:primer t4:primer"`.
