# The models slot's methods

Part of [the adapter protocol](adapter-protocol.md), version 2 (an addition within it; no version of its own).

A models module answers a host's model calls: the extraction keyword's, `AI()`'s, a plugin's, and a module's own through the host's models door. lf ships one, `@lf/anthropic` (the default), with the price table beside it. Another is a module lf starts, or reaches at its URL, over [the transport](adapter-protocol.md#transport). Install it as [a store module](store-slot.md#installing-one) is installed, with `slot: models`, and name it in lf.yaml: `core: { models: acme_llm }`.

## Methods

One request, one answer: no streaming.

| method | params | result |
|---|---|---|
| `models.call` | `{ label, system, userMessage, model?, effort?, maxTokens?, schema?, toolName?, toolDescription? }` | `{ text, data?, cost: [{ microdollars, label }] }` |

- **The request** is the models door's (`HostModelRequest`, `packages/engine-contracts/protocol.ts`) and an output ceiling, `maxTokens`. `model` is a name a movement writes (`sonnet`, `claude-sonnet-5`); the module maps it to its provider's.
- **`schema`** (a JSON schema) asks for the reply as data: `data` is the reply read as that value, `text` its text.
- **`cost`** is what the call spent, priced by the module. The host adds it to the run's spend, so `maxRunCostUsd` counts it. The host refuses a call before it starts once the run's budget is spent.
- **A refusal**: `bad_request` for a request missing `system`, `userMessage` or `label`, or naming no model; `module_error` (retryable) for a provider failure.
- Shapes: `packages/engine-contracts/slots/models.ts`.

## Conformance

`modelsSlotCases` and `commonSlotCases('models', …)` (`@listen-fire/module-runtime/module-wire`, re-exported by `movement-engine/public/module-wire`) run against any server. `apps/cli/src/__test__/slot_conformance.test.ts` runs them against `lf --contract-models` (`@lf/anthropic` before a fake Messages API, its `api_key` and `base_url` in the request's `settings`).

## Changes

- **2026-10-19** (within adapter protocol 2): the models slot's methods, and modules filling it over the transport.
