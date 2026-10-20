# Getting started with `lf`

`lf` runs movements from a project folder on your machine. Install it with `cargo install listen-fire`, build it with `cargo build --release -p listen-fire` (the binary is `target/release/lf`), or install a release.

## 1. Make a project

```
lf init my-project && cd my-project
```

This writes `lf.yaml`, a starter movement in `movements/`, `externals/` and `.lf/` (run state and secrets, git-ignored). It never overwrites a file that exists. `lf.yaml` pins the engine version the project runs on, and its `core:` section chooses the modules run state, models, the judge and files come from ([core slots](core-slots.md)). The defaults need no setup.

A working project to read or copy is [`examples/lf-acme`](../examples/lf-acme): one movement, one external, a sample secrets file (copy it to `.lf/secrets.yaml`).

The starter runs straight away: `lf check`, then `lf run hello`.

## 2. Write a movement

`manual` and `cron` are the host's own sources, so a movement listens to them with no import:

```
function hello(run: <manual-[:Invocation]->>) {
  return "Hello, ${run.`Run by (name)`}!"
}
listen to manual fire hello                                    # lf run hello

function digest(t: <cron-[:Tick]->>) {
  return t.`Fired at`
}
listen to cron { schedule: "0 9 * * 1" } fire digest           # lf serve or lf drain fires it
```

A system's events need its external. Put a `.mvt` file in `movements/`:

```
import { acme_crm } from adapters
import { acme } from credentials

crm = connect acme_crm using acme

function welcome(company: <crm-[:Company]->>) {
  write crm-[:Company]-> { Name: "Welcome ${company.Name}" }
}

listen to crm { events: ["company.created"] } fire welcome
```

A module with no webhooks (Granola, Evertrace, Dealroom) is polled instead: its manifest declares `poll: { intervalSeconds }`, and a listen on it reads like any other (`listen to granola fire summarise`).

- A listen can set its own interval, `listen to granola { every: 5m } fire summarise`; without it the module's interval applies.
- `lf serve` polls each such listen on the module's interval, and runs the listen on each new event.
- `lf drain` polls every listen that is due. A poll missed while nothing ran is one poll on the next drain.
- Each listen keeps its own checkpoint, so a poll asks only for what is new since the last one.
- An event a listen has run before (the same `idempotencyKey`) runs nothing.

`lf check` prints every diagnostic; fix them before running.

## 3. Connect a module

A system is reached through an external: a folder in `externals/` holding an `lf-external.yaml` that says how the host starts or reaches it.

```
lf connect              # lists the modules lf knows, and which are set up
lf connect <module>     # installs it and asks for its server secret, webhook secret and OAuth app
```

`ai(…)` and `extract(…)` call models: `lf connect @lf/anthropic` stores your API key.

`lf connect <module> --base-url <url>` points the module at a fake or a proxy instead of its provider; `--oauth-authorize-url` and `--oauth-token-url` do the same for its sign-in. [`examples/lf-attio`](../examples/lf-attio) walks Attio through end to end, against real Attio or the repo's fake.

A plugin package is an external of `kind: plugin`. `@lf/pdf` draws text as a PDF file and needs no credential:

```
# externals/pdf/lf-external.yaml
name: pdf
kind: plugin
module: "@lf/pdf"
```

```
import { `@lf/pdf` as pdf } from plugins

function report(c: <crm-[:Company]->>) {
  write crm-[:Company]-> { Name: c.Name, Report: pdf.render("Report for ${c.Name}") }
}
```

`pdf.render(text, { pageSize: "a4" | "letter", margin })` is a file (A4, 30 points of margin by default). Its writer is thin: Helvetica, no font to ship. A character outside Latin-1 (CJK, emoji) prints as `?` and the run is warned, naming `@lf/pdf`; a PDF module that embeds a font can serve the same plugin in its place.

### How lf runs a module

A movement imports only modules installed in `externals/`; installing is always `lf connect` (or a folder you add), never an import.

**A local module runs with your permissions.** lf has no sandbox yet: a module's process can read and write what you can. Install only modules you trust.

- It starts a module's process only when a run or a check needs it. A check needs one when the movement imports a live graph such as Attio's.
- It keeps the process up while it is used, and stops it after `moduleIdleTimeout` seconds unused (in `lf.yaml`; default 300). The next call starts it again.
- First-party `@lf/*` modules, and any whose `lf-external.yaml` says `trusted: true`, share one Node process. Every other module gets a process of its own.
- A module that crashes starts again on its next call. A run whose call it broke fails or retries as any failed call does.
- One call may take `callTimeout` seconds (default 600).
- A module process exits when lf does. A process left behind by a killed lf is stopped the next time lf opens the same store.
- `runtime: node 22` in `lf-external.yaml` says what the module runs on; a served module (`module:`) runs on node 22 unless it says otherwise. `lf check` refuses, by name, a runtime this machine lacks or has too old.

## 4. Add a credential

```
lf credential add --module <module> my_credential
```

This signs you in at the provider (OAuth) or asks for the module's fields, and stores the result in `.lf/secrets.yaml`. A movement names it with `import { my_credential } from credentials`. `lf credential list|update|delete` manage the rest. In containers and CI, set `LF_SECRET__<NAME>__<FIELD>` instead of keeping a file.

## 5. Run

```
lf run hello                                   # run a movement a `listen to manual` fires
lf run --event events/company_created.json     # route one event to the listens it matches
lf run --event events/company_created.json --dry-run
lf run --poll summarise                        # poll now the polled source of each listen that fires it
lf runs                                        # the runs, most recent first
lf resume [<run-id>]                           # step a parked run, or every due one
```

## 6. Serve

```
lf serve [--port N] [--doors-only]
```

`lf serve` receives webhooks and callbacks, fires `cron` listens on their schedule, polls polled sources on their interval, and drains due work, so listens fire on their own. `lf drain` does the same work once and exits (`--until-idle`): a tick or poll missed while nothing ran happens once on the next drain, and two workers never poll one listen at once. `lf drain --kinds poll_listen` is a pool: it claims only work of those kinds (`resume_timer`, `wake_await`, `fire_event`, `fire_callback`, `poll_listen`, and `cron` for the cron ticks), so polls and run steps can be drained by separate fleets. Set `publicUrl` in `lf.yaml` when the outside world reaches it at another address. A module that registers its own webhooks (Attio) gets one when `lf serve` starts, for the events its listens name, at `<publicUrl>/api/public/webhook-sync/<provider>/<credential>`; a restart keeps it, and it is removed once no listen needs it. `lf call <callback-id>` and `lf cancel <run-id>` act on a parked or running run.

`lf serve --doors-only` (or `LF_DOORS_ONLY=1`) is for compute billed by the request, which is frozen once a response is sent. It runs no drain, and `/hooks/…` queues its events (answering 202 with the rows queued) instead of running them inside the request. `lf drain` workers run the work, started on a schedule or by the [wake slot](core-slots.md#the-wake)'s module.

## 7. Upgrade a project

> Language version 5 (Dancing Wren) is a **preview** in the 0.12.0 pre-release. Existing projects keep their version 1 to 4 pins and run unchanged; moving to 5 is opt-in, by this explicit upgrade.

`lf upgrade --check` prints what would change; `lf upgrade` rewrites the movement files into the current language version.
