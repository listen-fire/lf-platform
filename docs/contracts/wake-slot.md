# The wake slot's methods

Part of [the adapter protocol](adapter-protocol.md), version 2 (an addition within it; no version of its own).

A wake module is told when lf's work is due, so whatever starts lf's workers can start one then. lf says two things:

- **work is ready now** (`wake.now`)
- **work will be ready at a time** (`wake.at`)

On a scale-from-zero platform no worker runs between jobs. Without a wake module, work waits for the next scheduled worker (a job every minute, say). With one, a webhook's event starts a worker at once, and a parked timer starts one when it is due.

lf builds no wake module in. The slot is empty unless `lf.yaml` names one, and then nobody is told: the work waits for whatever drains on a schedule.

## Installing one

A folder in the project's externals folder, with an `lf-external.yaml`:

```yaml
name: acme_wake
kind: core
slot: wake
url: https://wake.example.com   # a remote module; or command: [node, wake.mjs], started in this folder
settings:                       # optional; prompted by `lf connect acme_wake`
  - { name: queue, label: the queue a wake goes on }
```

- `lf.yaml` names it for the slot: `core: { wake: acme_wake }`.
- `lf connect acme_wake` asks its settings and reads its manifest once.

## The envelope

The store slot's envelope ([store-slot.md](store-slot.md#the-envelope)): adapter protocol 2's HTTP, one request at a time, the install's settings on every request. Instants are `Date.toISOString` strings.

## Methods

| method | params | result |
|---|---|---|
| `wake.now` | `{ kind }` | `null` |
| `wake.at` | `{ kind, at }` | `null` |

- **Answer once the wake is arranged, not once the work ran.** lf waits for the answer before it goes on (the request that queued the work waits too), so a module hands the wake to its queue and answers.
- **`wake.now`**: start a worker soon. lf may say it many times in a row, and while a worker is already draining. A module may start one worker for several.
- **`wake.at`**: start a worker at `at`, never before. An `at` already past is `wake.now`.
- **`kind`** is the work row's kind: `fire_event`, `wake_await`, `resume_timer`, `fire_callback` or `poll_listen`. A module may start a worker for that kind's pool (`lf drain --kinds <kind>`), or ignore it.
- **A refusal**: `bad_request` for an `at` that is not an instant, or a request without its `kind`.
- **"Start a worker"** means run `lf drain --until-idle` against the same store (a job, a container, a function). It claims every due row, so it needs nothing from the wake but the start.

## When lf calls it

After every work row lf writes or puts back with a due time, once the write is in the store, so the worker a wake starts finds the row. A row written inside one of the store's composite calls (a park with its timer row, a delivery's cursor with its rows) is announced after that call commits, never before:

- a delivery's or a push's event queued (`fire_event`, now): `/hooks/…` under `lf serve --doors-only`, and the webhook and push doors
- a wake for parked awaits queued (`wake_await`, now)
- a timer park (`resume_timer`, at its due time)
- a callback's call (`fire_callback` at its backstop, and now when its run is busy or under `lf serve --doors-only`; `wake_await` at its backstop)
- a polled listen's first poll (`poll_listen`, now) and each next one (at the next interval)
- a row put back for a retry (its kind, at the retry time): its backoff after a failure, or a short wait while its run is held elsewhere
- nothing for a row that gives up: it is kept dead, never due again

## A failed wake loses no work

The row is already in the store when the module is called. If the call fails, lf logs one line and goes on: the request that queued the work still succeeds. A deployment keeps a scheduled worker (every minute, say) as the safety net that finds work whose wake was lost.

## A cloud queue module

A module on Google Cloud Tasks (shipped separately) turns `wake.now` into a task due now and `wake.at` into a task scheduled at `at`. The task's delivery starts a worker job rather than running the work inside the delivery, since a delivery has a time limit (about 30 minutes) and a worker may run longer.

## The conformance cases

`wakeSlotCases` (`packages/module-runtime/module_wire/conformance.ts`, re-exported as movement-engine `public/module-wire`) hold every wake module to the same meaning. A wake module's effect is outside it, so the cases take a harness:

```ts
interface WakeHarness {
  client: SlotClient;            // the module, at its address, with its settings
  started(): Promise<number[]>;  // when each worker it started began (the harness's clock)
  slackMs: number;               // how late a worker may start
}
```

For a cloud queue module, point its deliveries at an endpoint the harness serves and count each one as a worker started. The cases:

- `wake.now` answers `null`, and a worker starts within the slack.
- `wake.at` an instant ahead: a worker starts by the instant plus the slack, and none before it.
- `wake.at` an instant past starts a worker as `wake.now` does.
- Five `wake.now` in a row are each answered, and start a worker.
- An `at` that is not an instant, or a request without its `kind`, is refused as `bad_request`.

Every slot module also answers `commonSlotCases('wake', WAKE_METHODS)`: its manifest, and the envelope's refusals.

`apps/cli` runs both against a test module standing for a cloud queue (`apps/cli/src/__test__/wake_module/serve.ts`), directly and through lf's own client of it (`lf --contract-wake-slot --dir <project>`), in `wake_contract.test.ts`. A Rust module implements `module_kit::Wake` and is served with `Host::wake`.

## Changes

- **2026-10-20** (within adapter protocol 2): the wake slot, its methods, and its conformance cases.
