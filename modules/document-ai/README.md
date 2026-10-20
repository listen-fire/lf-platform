# @lf/document-ai

The ocr slot on Google Document AI: the text of a scanned PDF or an image. With it, `extract(…)` reads a deck that is only pictures of pages, and a plugin's `ctx.ocr` reads the PDFs it fetches.

It is the platform's own Document AI reader (`packages/ocr-google`), served as a module:

- a file of up to 15 pages and 20 MB goes to the processor's online endpoint;
- a longer one is uploaded to your Cloud Storage bucket, processed in batch, read back and deleted.

lf asks it only of a file that needs it: an image, or a PDF with no usable text layer of its own (lf reads a born-digital PDF's text itself, by the platform's rule).

## Install

1. Install `@listen-fire/document-ai` into the project's externals folder and keep `lf-external.yaml` (shipped in the package) beside it, as `externals/document_ai/lf-external.yaml`.
2. Name it in `lf.yaml`:

   ```yaml
   core:
     ocr: document_ai
   ```

3. Run `lf connect document_ai` to give it its settings. They go to the project's secrets file (or `LF_SECRET__DOCUMENT_AI__<SETTING>` in containers and CI), never into `lf.yaml`.

## Settings

| setting | meaning |
|---|---|
| `project` | the Google Cloud project the OCR processor is in |
| `location` | where the processor lives: `eu` or `us` |
| `processor_id` | the processor's id (Document AI → Processors; an Enterprise Document OCR processor) |
| `bucket` | a Cloud Storage bucket for files past 15 pages or 20 MB. Empty: such a file is refused, naming the setting |
| `client_email`, `private_key` | a service account (the key is secret) with Document AI and the bucket's object roles. Leave both empty to use the environment's own Google credentials (a workload identity, `gcloud auth application-default login`) |
| `price_per_page` | what a page costs you, in dollars. Default `0.0015`, the list price ($1.50 per 1,000 pages) |
| `base_url`, `storage_url` | other endpoints speaking Document AI's REST API and Cloud Storage's (a proxy); empty for Google's |

## Cost

Every read reports its cost: the pages Document AI read times `price_per_page`, labelled `document-ai/ocr`. lf adds it to the run's spend, so `maxRunCostUsd` counts it. The module publishes the price (`ocr.prices`), so lf refuses before reading a file whose pages alone cost more than the run has left.

## Tests

`pnpm test` in this folder starts the module as the process lf starts and runs the ocr slot's conformance kit and the module's own cases against a fake Document AI and Cloud Storage, driven by Google's own clients. A generated service account key signs its own tokens, so nothing reaches Google.
