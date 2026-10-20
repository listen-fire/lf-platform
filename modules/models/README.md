# @lf/models

The models slot on the vendor you choose: Gemini, OpenAI, Claude on Anthropic's API, or Claude on Google Cloud (Vertex). A project that names it needs no Anthropic key: every `ai(…)` and `extract(…)` call, and every model call a plugin asks the host for, goes to your vendor.

It is the platform's own model layer, served as a module: the platform's model map decides which vendor model answers each name, the platform's translators speak to the vendor, and the shared price table prices each answer.

## Install

1. Install `@listen-fire/models` into the project's externals folder and keep `lf-external.yaml` (shipped in the package) beside it, as `externals/models/lf-external.yaml`.
2. Name it in `lf.yaml`:

   ```yaml
   core:
     models: models
   ```

3. Run `lf connect models` to give it its settings. They go to the project's secrets file (or `LF_SECRET__MODELS__<SETTING>` in containers and CI), never into `lf.yaml`.

## Settings

| setting | meaning |
|---|---|
| `vendor` | `gemini`, `openai`, `anthropic` (Claude on Anthropic's API) or `vertex` (Claude on Google Cloud) |
| `api_key` | the vendor's key (secret). For `gemini`, a Gemini API key; leave it empty to reach Gemini on Google Cloud instead |
| `model` | the vendor model every movement model name goes to. Defaults: `gemini-3.8-flash` (gemini), `gpt-5-mini` (openai); Claude names keep their own on `anthropic` and `vertex` |
| `model_map` | per name overrides, written as the platform's `MODEL_MAP`: `{"claude-opus-5": "gemini/gemini-3.1-pro-preview"}`. Every line names this install's vendor |
| `google_project` | Google Cloud's project (`gemini` without an API key, and `vertex`) |
| `google_region` | where Google Cloud addresses models (default `global`) |
| `google_client_email`, `google_private_key` | a service account (the key is secret). Leave both empty to use the environment's own Google credentials (a workload identity, `gcloud auth application-default login`) |
| `base_url` | another endpoint speaking the vendor's API (a proxy); empty for the vendor itself |

## Model names

A movement keeps writing the names it always has: the tiers (`haiku`, `sonnet`, `opus`, `opus5`) and the chat models (`claude-sonnet-5`, `claude-opus-5`, …). The module sends each to the vendor model its map names, as the platform's `MODEL_MAP` does:

- a name `model_map` lists goes where its line says;
- any other goes to `model` (on `anthropic` and `vertex`, to the Claude model of that name).

So a Gemini install with `model_map: {"claude-opus-5": "gemini/gemini-3.1-pro-preview"}` answers `AI("…", "thorough")` (which asks for `claude-opus-5`) on Gemini 3.1 Pro and everything else on Gemini 3.8 Flash.

## Prices

- Every answer's `cost` is its tokens priced from the shared price table (`modules/anthropic/prices.json`) at the vendor model that answered, labelled `<vendor>/<model>` (`gemini/gemini-3.8-flash`). lf adds it to the run's spend, so `maxRunCostUsd` counts it.
- The module publishes its prices (`models.prices`): every name a call may write, at the price of the vendor model it goes to. lf reads them to refuse, before calling, a call whose prompt alone costs more than the run has left.
- An install whose map names a model the table has no price for is refused at its first call, naming the model: an answer the module cannot price would count as free.

## Reading scanned files (the ocr slot)

On Gemini, whose models read PDFs and images themselves, the package also fills the ocr slot: the text of a scanned PDF or an image, for `extract(…)` and for a plugin's `ctx.ocr`.

- It is a second install entry, `models_ocr`: copy `lf-external.ocr.yaml` (shipped in the package) to `externals/models_ocr/lf-external.yaml`, name it (`core: { ocr: models_ocr }`) and run `lf connect models_ocr` with the same settings as `models`.
- Why a second entry rather than one process in two slots: lf holds a module to one slot (its manifest names it; `lf connect` and the conformance kit check it), and that rule stays simple for every slot. The cost is connecting the settings twice.
- A file goes to the model `sonnet` goes to, with an instruction to transcribe it page by page (each page begins with a `>>PAGE_START<<` line, as Document AI's reader marks it).
- Each read is priced from the table like a call. It publishes a page's least cost (`ocr.prices`: Gemini's 258 tokens a page at the model's input price), so lf refuses up front a file the run cannot afford.
- A transcription cut short at the output ceiling is refused, never returned.
- Other vendors are refused by name.

## What it does not do

- Streaming: one request, one answer, as the slot defines.

## Tests

`pnpm test` in this folder runs the models and ocr slots' conformance kits and the module's own cases against fake Gemini and OpenAI APIs, driven by the real vendor SDKs. No key reaches a vendor. `apps/cli/src/__test__/models.test.ts` runs it under the real `lf` against the fake Gemini: an `ai(…)` call completes and its price lands on the run.
