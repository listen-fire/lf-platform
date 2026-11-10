# One-off SQL backfills

Hand-written, operator-run maintenance SQL — NOT migrations. Files here are
**not** applied automatically by `schema:migrate`; a human runs them against a
target database on purpose, after eyeballing the accompanying dry-run report.

Convention per backfill: a `<date>_<name>.report.sql` (read-only SELECT of what
would change) and a `<date>_<name>.apply.sql` (transaction-wrapped, idempotent
writes). Each file carries a header comment stating what it does and how to run
it. Run the report first, eyeball, then the apply:

```bash
psql "$DATABASE_URL" -f <date>_<name>.report.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f <date>_<name>.apply.sql
```

Run as a role that owns the tables / bypasses RLS. Applies are idempotent —
safe to re-run.

A backfill whose "what to write" can only be produced by running application
code lives as a script instead, with its report/apply pair expressed as a
read-only check flag and a write mode. It is still an operator-run backfill and
is documented here, so this is the one place to look.

## 2026-11-10_access_statements_for_what_exists (script, also a deploy step)

Access statements say who may read, write or fire an automation and use a
connection, and a thing with none admits nobody. This states every automation
and connection that has none with the reach it has today, through the same rule
a creation with no person uses (`services/access/no_person.ts`), so turning on
the access checks changes nobody's reach: the team may read, write and use it;
firing is the narrowest of its listens' modules (Slack and the shared WhatsApp
number the team, everything else anyone; a team whose automations run on lf,
anyone). It writes only to things with no statement at all, so it is safe to
re-run, and it never changes a thing a person or a creation stated.

It is not a `.sql` migration because the rule is code. `deploy:render-pre` and
the compose `migrate` one-shot run it after the schema migrates, on every
deployment, and it fails the deployment when it cannot finish.

```bash
# report — read-only: what is unstated, per team
pnpm access:state-unstated --check [--team <teamId>]

# apply — state it, one transaction per team
pnpm access:state-unstated [--team <teamId>]

# the files whose listens mix who may fire (narrowed by the backfill), to widen by hand
pnpm access:mixed-fire-reach [--team <teamId>] [--json]
```

Run the report on a live team before the first deployment that carries this and
look at the mixed files and any machine callers (a webhook sender that fires
with no person behind it); the list names every file whose firing narrowed.

Outstanding connect links are not backfilled: a link minted before links carried
a use list is refused at its landing with a plain message, expires within 24
hours anyway, and the row cannot tell one from the Telegram link that carries
none by design. Minting a fresh link is the remedy.

## 2026-08-18_valuations_cache_degree_buckets (script)

The valuations cache became degree-bucketed: each row is now the sum of the
roll-up's leaf lots at one (event, asset, causal degree, tracking, flow side),
which is what lets a cached read answer *direct* realised value — the cash the
company itself paid, as opposed to cash out of whatever it turned into. Rows
written before the migration carry no degree and were deleted by it, so every
team's cache must be recomputed. Recomputing is pure derivation from the walk:
nothing else in the database is read or written.

```bash
# report — read-only: is every cached read identical to the full walk?
pnpm refresh:valuations-cache --team <teamId> --check

# apply — recompute; per-investment delete-and-rewrite, so re-runs are no-ops
pnpm refresh:valuations-cache --team <teamId>
```

An investment with no cached rows is reported as `uncached`, never as a
disagreement: the read path treats it as a cache miss and falls back to the
walk, so an unrefreshed cache is slow, never wrong. Equivalence to the walk is
also pinned by `lib/valuations/__test__/cache_acquisition_rollup.integration.test.ts`.

## 2026-07-23_wind_down_disposals

Completes the asset disposal that the pre-fix wind-down missed for
already-wound-down companies (SPV-profiled holdings and SPV-issued equity were
never marked down; no transfers were ever created). Writes exactly what the
disposal service (`lib/valuations/commands/wind_down.ts`) now writes, against
each company's existing `LIQUIDATION` event. Equivalence to the service is
proven by `lib/valuations/commands/__test__/wind_down.integration.test.ts`.
