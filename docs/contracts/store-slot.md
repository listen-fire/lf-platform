# The store slot's methods

Part of [the adapter protocol](adapter-protocol.md), version 2 (an addition within it; no version of its own).

A store module keeps a host's run state: runs, parks, joins, await correlations, leases, the work queue, library sources, callbacks, pull cursors and event receipts. lf ships two (`@lf/sqlite-store`, the default, and `@lf/postgres-store`). A third-party one is a module lf starts, or reaches at its URL, and calls over adapter protocol 2's HTTP, as it calls any module.

## Installing one

A folder in the project's externals folder, with an `lf-external.yaml`:

```yaml
name: acme_store
kind: core
slot: store
command: [node, store.mjs]      # started in this folder; or `url:` for a remote one
settings:                       # optional; prompted by `lf connect acme_store`
  - { name: path, label: the state file, secret: false, optional: false }
env: { LOG_LEVEL: info }        # optional
```

- lf.yaml names it for the slot: `core: { store: acme_store }`.
- `lf connect acme_store` asks its settings, keeps them on its install entry in the secrets file, and opens it once (so a module that sets itself up, a schema say, does so then).
- Every slot takes such a module ([the transport](adapter-protocol.md#transport)): the models, judge, files and browser slots' methods are [models-slot.md](models-slot.md), [judge-slot.md](judge-slot.md), [files-slot.md](files-slot.md) and [browser-slot.md](browser-slot.md).

## The envelope

The adapter protocol's ([the envelope](adapter-protocol.md#the-envelope), [the transport](adapter-protocol.md#transport)): one `POST` per method, the method in the body, the install's settings in `settings` on every request.

- A method's `params` is one object, keyed in camel case. Its `result` is the answer; `null` for a method that answers nothing.
- An absent optional string is `null`.
- Instants are `Date.toISOString` strings; ids and tokens are strings the module mints.
- A failure is `ok: false` with an `error`. The code `run_lease_lost`, with `data: { runId }`, means a fenced write found the run's lease gone: lf treats it as losing the run. Any other code is a store failure.
- lf calls a store one method at a time and waits for each answer.
- A write that must not be torn by a crash is one method, which the store keeps as one transaction: all of it or none (`parks.commit`, `events.startRun`, `inbound.keepDelivery`, and `callbacks.record` with its body's row). A remote store cannot hold a transaction open across requests, so there is no method that opens one.

## Methods

The first request is always `store.open`. The others are the run host's store families (`RunHostStore`, `CallbackStore` in `packages/movement-engine/services/run_host/`), method for method. Their meaning is the contract suite's: [`contract.ts`](../../packages/movement-engine/services/run_host/contract.ts) holds every store to the same cases, and `apps/cli` runs it through a store module (`run_host_contract.test.ts`).

| method | params | result |
|---|---|---|
| `store.open` | `{ settings: { [name]: string } }` | `{ tenant }`: the team id lf's own runs are kept under |
| `runs.start` | `{ id, file, movement, startedAt, input }` | `null` |
| `runs.lapsed` | `{ staleMs, limit }` | the ids of runs still `running` whose lease lapsed or was never taken, started more than `staleMs` ago, oldest first: their worker is gone (a live first firing holds its lease and renews it every third of its length) |
| `runs.settle` | `{ runId, status, outcome, at }`; status `completed`, `parked`, `running` or `failed`; an ending revokes the run's live callbacks | `null` |
| `runs.markParked` | `{ runId }` | `null` |
| `runs.get` | `{ runId }` | a run row, or `null` |
| `runs.list` | `{ limit }` | run rows, most recent first |
| `runs.appendTrace` | `{ runId, segmentId, entries: [...] }` | `null` |
| `runs.traceLength` | `{ runId }` | integer |
| `runs.spent` | `{ runId }` | microdollars spent since the spend baseline |
| `runs.addSpend` | `{ runId, microdollars }` | `null` |
| `runs.resetSpendBaseline` | `{ runId }` | `null` |
| `runs.requestCancel` | `{ runId, reason }` | `null` |
| `records.cancelRequest` | `{ runId }` | `{ reason }`, or `null` when none was asked |
| `records.markFailed` | `{ runId, message }` | `null` |
| `parks.putLeaf` | `{ runId, address, reason, wakeAt, state, fence }` | `null` |
| `parks.claimLeaf` | `{ runId, address, reason }` | `{ reason, state }`, or `null` |
| `parks.finishLeaf` | `{ runId, address, fence }` | `null` |
| `parks.leaves` | `{ runId, parkedOnly, reason, dueBy }` | `[{ address, reason, status, wakeAt }]` |
| `parks.deleteLeaves` | `{ runId, addresses }` | `null` |
| `parks.commit` | `{ runId, address, state, fence, park }`; `park` is `{ kind: "timer", wakeAt }`, `{ kind: "await", teamId, adapterType, correlationKey }` or `{ kind: "limit" }` | `null`. One fenced write: the leaf (`parks.putLeaf` with the kind as its reason); for a timer, the run's `resume_timer` row (key `resume_timer:<runId>`, payload `{ runId }`) armed at `wakeAt` as `work.enqueue` arms it; for an await, its correlation (`correlations.correlate`); for a limit, the address's correlation dropped; and the run marked parked (`runs.markParked`). A lost fence writes nothing (`run_lease_lost`) |
| `joins.recordJoin` | `{ runId, frameAddress, pending, fence }` | `null` |
| `joins.decrementJoin` | `{ runId, frameAddress, branchAddress, leafAddress }` | `{ closed }` |
| `joins.persistBranchExport` | `{ runId, frameAddress, branchAddress, branchIndex, exports }` | `null` |
| `joins.collectBranchExports` | `{ runId, frameAddress }` | `[{ branchAddress, branchIndex, exports }]` |
| `joins.hasPendingJoins` | `{ runId }` | boolean |
| `joins.frames` | `{ runId }` | frame addresses |
| `joins.deleteFrames` | `{ runId, frameAddresses }` | `null` |
| `correlations.correlate` | `{ runId, teamId, address, adapterType, correlationKey }` | `null` |
| `correlations.correlated` | `{ adapterType, teamId, correlationKey }` | `[{ runId, teamId, address }]` |
| `correlations.ofRun` | `{ runId, adapterType }` | `[{ runId, teamId, address, correlationKey }]` |
| `correlations.drop` | `{ runId, address }` | `null` |
| `correlations.dropRun` | `{ runId }` | `null` |
| `leases.claim` | `{ runId, ttlMs }` | `{ token }`, or `null` while another holds it |
| `leases.renew` | `{ runId, token, ttlMs }` | boolean |
| `leases.release` | `{ runId, token }` | `null` |
| `leases.dropRunState` | `{ runId, fence }` | boolean |
| `work.enqueue` | `{ kind, key, payload, dueAt, teamId }` | `null` |
| `work.claimDue` | `{ limit, leaseMs, dueBy, kinds? }`; `kinds` (a drain pool's) leases only rows of those kinds, absent every kind; a dead row is never claimed | `[{ id, kind, key, payload, claim, attempts }]`; `attempts` counts the row's claims, this one included, less those released `busy`, since it was queued or released `rescheduled` |
| `work.complete` | `{ id, claim }` | `null` |
| `work.release` | `{ id, claim, dueAt, why? }`; `why` is `failed` (the claim was an attempt; the default), `busy` (its run was held elsewhere: the attempt is given back) or `rescheduled` (done, and due again: the attempts start over) | `null` |
| `work.bury` | `{ id, claim, reason }` | `null`. The row gave up: kept with `reason`, unleased and never claimed again; unless it was re-armed since the claim, when it is only unleased. `work.enqueue` of its key brings it back, its attempts from nought |
| `sources.put` | `{ teamId, hash, source }` | `null` |
| `sources.get` | `{ teamId, hash }` | the source, or `null` |
| `callbacks.mint` | `{ teamId, runId, address, params, state, singleUse, expiresAt }` | `{ id }` |
| `callbacks.get` | `{ id }` | a callback row, or `null` |
| `callbacks.record` | `{ id, values, bodyDueAt }` | `{ kind: "recorded", callback, callIndex }`, or `{ kind: "not_found" }`, `{ kind: "closed", callback }`, `{ kind: "expired", callback }` |
| `callbacks.markBodyStarted` | `{ id, callIndex, fence }` | boolean |
| `callbacks.landed` | `{ ids }` | those of `ids` with at least one call whose body started |
| `callbacks.revokeRun` | `{ runId }` | `null` |
| `inbound.checkpoint` | `{ subscriptionId }` | `{ checkpoint }`, or `null` |
| `inbound.saveCheckpoint` | `{ subscriptionId, checkpoint }` | `null` |
| `inbound.keepDelivery` | `{ subscriptionId, checkpoint?, work: [{ kind, key, payload, dueAt, teamId }] }` | `null`. One write: the cursor saved (absent: left as it is; `null` is a cursor to save) and each row queued as `work.enqueue` queues it |
| `processes.list` | `{}` | `{ processes, version }`: the module processes the hosts on this store started (an array of `{ pid, lf, machine, command }`), at its version; `{ processes: [], version: 0 }` for a list never written |
| `processes.swap` | `{ version, processes }` | `true` when the list was still at `version` and is now `processes` at `version + 1`; `false` when another host wrote first (read again and retry) |
| `events.claim` | `{ listen, key }` | `true` the first time this event key reaches this listen; `false` for a redelivery, which runs nothing |
| `events.startRun` | `{ listen, key, id, file, movement, startedAt, input }` | `events.claim` and, when it is `true`, `runs.start`, as one write: `false`, and no run, for a redelivery |

The rows:

```ts
type RunRow = { id: string; file: string; movement: string; status: string; startedAt: string; input: string; outcome: string | null };
type CallbackRow = {
  id: string; teamId: string; runId: string; address: string;
  params: unknown; state: unknown; calls: unknown; singleUse: boolean;
  expiresAt: string | null; status: 'live' | 'fired' | 'revoked';
};
```

A run's `outcome` is the JSON object lf settled it with: `{ writes, returned? }`, or `{ error }` for a failed run. `returned` is what the movement returned, as lf records it (at most 64 KiB of JSON, a file by its reference). A store hands the outcome back as it was given (its members may be kept in columns of their own, as `@lf/postgres-store` keeps them). A store that drops `returned` still works with lf: its runs show no returned value.

`lf --contract-store <state.db|postgres://…>` serves these methods over lf's own stores, as a store module on a Unix socket. A module may forward to it, as the test module does (`apps/cli/src/__test__/store_module/forward.mjs`). `runs.status` and `runs.complete` are the contract suite's helpers and are not called by lf.

## Changes

- **2026-10-20** (within adapter protocol 2): a run's settled `outcome` may carry `returned`, what its movement returned. No method changed: a store that hands the outcome back as it was given keeps it.
- **2026-10-20** (within adapter protocol 2): a crash never tears lf's state. `parks.commit`, `events.startRun` and `inbound.keepDelivery` each keep in one write what lf wrote in several; `runs.lapsed` finds the runs whose worker was lost, which lf fails; `work.claimDue`'s rows carry `attempts`, `work.release` says `why`, and `work.bury` keeps a row that gave up dead, so a failing row is no longer retried forever.

- **2026-10-19** (within adapter protocol 2): `processes.list` and `processes.swap`, the list of module processes the hosts on a store started, written by compare-and-set on its version so two lfs on one store never overwrite each other's entries. lf used to keep it in an inbound checkpoint row.
- **2026-10-19** (within adapter protocol 2): the methods ride adapter protocol 2's HTTP, as every module's do; the stdin/stdout JSON-RPC wire is retired. A lost lease is the error code `run_lease_lost` (`data: { runId }`). A store module may be remote (`url:`).
- **2026-10-18** (within adapter protocol 2): `work.claimDue` takes `kinds`, for drain pools (`lf drain --kinds`).
- **2026-10-17** (within adapter protocol 2): the store slot's wire, and process modules filling the store slot.
