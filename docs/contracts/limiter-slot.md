# The limiter slot's methods

Part of [the adapter protocol](adapter-protocol.md), version 2 (an addition within it; no version of its own).

A limiter module keeps a host's calls to modules and models inside the providers' limits. The host asks it before every call, and holds the call until it is granted. lf ships one, `@lf/memory-limiter` (the default), which keeps the limits in lf's own process. A limiter shared by many hosts (Redis, a database) is a third-party module lf starts (or reaches at its URL) and calls over adapter protocol 2.

The engine knows nothing of limits. Only the host asks.

## What one acquire counts

- Usually one call from the host to a module.
- For a module that declares `hostLimits`, one request from the module to its provider, retries included. The module asks the host's [limits door](adapter-protocol.md#kinds-settings-spend-and-the-hosts-models) before each one, and the host asks this slot on its behalf, under the caller it resolved for the call. The host then does not count the call itself.
- Either way the limiter sees the same `acquire`, `release` and `throttle`. Nothing here changes for a limiter, and a module never reaches one.

## Installing one

A folder in the project's externals folder, with an `lf-external.yaml`:

```yaml
name: acme_limits
kind: core
slot: limiter
command: [node, limiter.mjs]   # started in this folder
settings:                      # optional; prompted by `lf connect acme_limits`
  - { name: url, label: the Redis URL, secret: true }
```

- `modules/postgres-limiter` (`@lf/postgres-limiter`) is one such module: the limits kept in Postgres, in a schema of its own (setting `schema`, default `lf_postgres_limiter`, created when it is opened), so every worker sharing the database shares one count. Its `url` setting is secret. It reads the database's clock, so hosts with drifting clocks agree.
- lf.yaml names it for the slot: `core: { limiter: acme_limits }`.
- `lf connect acme_limits` asks its settings and opens it once.

## The envelope

The store slot's envelope ([store-slot.md](store-slot.md#the-envelope)): adapter protocol 2's HTTP, one request at a time. Instants are `Date.toISOString` strings.

## Methods

No method waits. A refusal says when to ask again; the host does the waiting.

| method | params | result |
|---|---|---|
| `limiter.open` | `{ settings: { [name]: string } }` | `null` |
| `limiter.acquire` | `{ key, cost, limits: [{ key, calls?, perMs?, concurrent? }], holdMs }` | `{ granted: true, permit }`, or `{ granted: false, retryAt }` |
| `limiter.release` | `{ permit }` | `null`; a permit released twice, or never given, changes nothing |
| `limiter.throttle` | `{ key, until }` | `null` |

- **`acquire`** is granted only when every one of `limits` has room and `key` is not throttled. Then the call counts in all of them at once. A refused call counts in none, so it spends no quota anywhere.
- **`limits[].key`** names the bucket a limit counts in. The host makes it from the module, the limit's scope and the scope's value (which credential, install or team). A limiter treats it as opaque.
- **`calls` per `perMs`**: at most that many calls (counting `cost` each) in any window of that length. The two go together.
- **`concurrent`**: at most that many permits held at once in the bucket.
- **`key`** (the request's own) is who the call is made as: where a provider's throttle lands.
- **`holdMs`**: a permit never released lapses after this long, so a crashed host frees its places.
- **`throttle`**: the provider asked for no call on `key` before `until`. Every `acquire` naming `key` is refused until then.
- Every request carries its limits. A limiter reads no manifest and keeps no configuration, so a new module, or a new limit on one, needs nothing from the limiter.

## The contract suite

[`contract.ts`](../../packages/movement-engine/services/limiter/contract.ts) holds every limiter to the same cases. `apps/cli` runs it over `lf --contract-limiter` (lf's built-in) and `lf --contract-limiter-slot` (a test module filling a project's slot, `apps/cli/src/__test__/limiter_module/serve.ts`), in `limiter_contract.test.ts`. The platform's built-in passes the same cases in `services/limiter/__test__`.

## Changes

- **2026-10-20** (within adapter protocol 2): a module that declares `hostLimits` is counted per provider request at the host's limits door, not per call. The slot's methods are unchanged.
- **2026-10-19** (within adapter protocol 2): the methods ride adapter protocol 2's HTTP; the stdin/stdout JSON-RPC wire is retired.
- **2026-10-18** (within adapter protocol 2): the limiter slot, its wire, and process modules filling it.
