# The judge slot's methods

Part of [the adapter protocol](adapter-protocol.md), version 2 (an addition within it; no version of its own).

A judge module settles the identity question an engine's rules cannot settle alone: which of a write's search candidates the asserted record is. lf ships `@lf/judge`, which declines every question (an ambiguous match creates a new record). Another is a module lf starts, or reaches at its URL, over [the transport](adapter-protocol.md#transport), installed with `slot: judge` and named in `core: { judge: … }`.

## Methods

| method | params | result |
|---|---|---|
| `judge.arbitrate` | `{ asserted, candidates, recordType, constraints, languageVersion }` | `{ index, judgeUnavailable?, cost }` |

- **`candidates`** are the search's answers as the adapter gave them; **`constraints`** the write's uniqueness (`{ any: [{ all: [{ field, fuzzy? }] }] }`); **`languageVersion`** the asking run's (whether a blank key is a key).
- **`index`** names the candidate the record is, or `null` to create a new one.
- **`judgeUnavailable`** says why the judge could not be asked (its own call failed), with `index: null`, so the write reads as not asked rather than as a considered decline. A host that cannot reach the module answers the same way.
- **`cost`** as [the models slot's](models-slot.md#methods).
- **A refusal**: `bad_request` when `candidates` is not a list.
- Shapes: `packages/engine-contracts/slots/judge.ts`.

## Conformance

`judgeSlotCases` and `commonSlotCases('judge', …)` (`@listen-fire/module-runtime/module-wire`, re-exported by `movement-engine/public/module-wire`); `apps/cli` runs them against `lf --contract-judge`.

## Changes

- **2026-10-19** (within adapter protocol 2): the judge slot's methods, and modules filling it over the transport.
