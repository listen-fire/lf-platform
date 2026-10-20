# The models slot's methods

Part of [the adapter protocol](adapter-protocol.md), version 2 (an addition within it; no version of its own).

A models module answers a host's model calls: the extraction keyword's, `AI()`'s, a plugin's, and a module's own through the host's models door. lf ships one, `@lf/anthropic` (the default), with the price table beside it. `@listen-fire/models` (modules/models) answers them on Gemini, OpenAI, Anthropic or Vertex. Another is a module lf starts, or reaches at its URL, over [the transport](adapter-protocol.md#transport). Install it as [a store module](store-slot.md#installing-one) is installed, with `slot: models`, and name it in lf.yaml: `core: { models: acme_llm }`.

## Methods

One request, one answer: no streaming.

| method | params | result |
|---|---|---|
| `models.call` | `{ label, system, userMessage, model?, effort?, maxTokens?, schema?, toolName?, toolDescription? }` | `{ text, data?, cost: [{ microdollars, label }], usage: { inputTokens, outputTokens, cacheReadTokens?, cacheCreationTokens? } }` |
| `models.prices` (optional) | `{}` | `{ prices: { <model name>: { input, output, cacheRead?, cacheCreation? } } }` |

- **The request** is the models door's (`HostModelRequest`, `packages/engine-contracts/protocol.ts`) and an output ceiling, `maxTokens`; its `effort` may also be `xhigh` (the extraction keyword's `thorough` tier). `model` is a name a movement writes (`sonnet`, `claude-sonnet-5`); the module maps it to its provider's.
- **`schema`** (a JSON schema) asks for the reply as data: `data` is the reply read as that value, `text` its text.
- **`maxTokens`** is the answer's output ceiling: the module asks its provider for no more.
- **`cost`** is what the call spent, priced by the module. The host adds it to the run's spend, so `maxRunCostUsd` counts it. The host refuses a call before it starts once the run's budget is spent.
- **A priced call reports a cost.** An answer whose `usage` spent tokens and whose `cost` sums to zero is refused, unless the module publishes that model's price as zero (a free model). A cap that counts a call as free no longer holds.
- **`models.prices`** publishes the module's price of every model name a call may write (`sonnet`, `claude-sonnet-5`), in dollars per million tokens (a missing cache rate bills at the input rate). A module offers it by listing it in its manifest's `methods`. With it, the host refuses before calling a call whose prompt alone, at the model's input price, costs more than the run has left (lf estimates the prompt's tokens as a quarter of its characters); the run pauses as at its cap.
- **`usage`** is the tokens the call spent, required: the host reports it as the run's usage (an extraction's token counts), so a third-party model is counted as the built-in one is. An answer without it is refused.
- **A refusal**: `bad_request` for a request missing `system`, `userMessage` or `label`, or naming no model; `module_error` (retryable) for a provider failure.
- Shapes: `packages/engine-contracts/slots/models.ts`.

## Conformance

`modelsSlotCases` and `commonSlotCases('models', …)` (`@listen-fire/module-runtime/module-wire`, re-exported by `movement-engine/public/module-wire`) run against any server: among them, a call that spent tokens reports a cost unless its model is published free, and `models.prices`, when listed, prices `sonnet`. `apps/cli/src/__test__/slot_conformance.test.ts` runs them against `lf --contract-models` (`@lf/anthropic` before a fake Messages API, its `api_key` and `base_url` in the request's `settings`); `modules/models` runs them against itself before fake Gemini and OpenAI APIs.

## Changes

- **2026-10-19** (within adapter protocol 2): the models slot's methods, and modules filling it over the transport.
- **2026-10-19** (within adapter protocol 2): `models.call`'s answer carries `usage`, required; the models door's answer may carry it too.
- **2026-10-20** (within adapter protocol 2): `models.prices`, optional, publishes a module's prices; lf asks it of a module whose manifest lists it, and refuses up front a call whose prompt alone costs more than the run has left. A priced call must report a non-zero cost: lf refuses an answer that spent tokens at no cost unless the model is published free. `models.call`'s `effort` may be `xhigh`. lf's `@lf/anthropic` publishes its table.
