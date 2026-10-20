# The ocr slot

Part of [the adapter protocol](adapter-protocol.md), version 2 (an addition within it; no version of its own).

An OCR module reads the text of a file that has none of its own: a scanned PDF, a deck of screenshots compiled into a PDF, an image. lf builds none in, so the slot is empty unless `lf.yaml` names a module:

```yaml
core:
  ocr: document_ai
```

## Who asks it

- **The host's file-to-text** (`files.resolveFileText`, which `extract(…)` and `File.read` use). A movement needs no new construct: a file that needs OCR gets it.
  - An image (`png`, `jpeg`, `gif`, `tiff`, `bmp`, `webp`) always goes to the slot.
  - A PDF goes to the slot only when it has no usable text layer of its own, by the platform's rule (`packages/file-text/pdf.ts`): the text layer counts when its non-whitespace characters average more than 50 a page. So a scan whose only text is the page numbers a stamping tool wrote still goes to OCR. lf reads a born-digital PDF's text itself (its `pdf` feature).
- **A module, through its context** (`ctx.ocr.read({ bytes, contentType, name?, label })`). lf serves the OCR door to the modules it starts (`POST {LF_HOST_URL}/api/public/adapter/{module}/ocr`, `Authorization: Bearer {LF_HOST_TOKEN}`, the body `ocr.read`'s params, up to 96 MB). The door bills nothing itself: the module kit charges the read's cost to the call that asked, so it reaches the run on that call's answer, as the models door's does. In Rust, `Ctx::ocr` does the same.

## An empty slot

Nothing is read and nothing is guessed:

- `files.resolveFileText` answers `unreadable: extraction_failed`, its detail saying both halves, e.g. `no text layer; the ocr slot is empty: name an OCR module in lf.yaml's core: { ocr: … }`. A movement's `File.read` is then absent.
- The door answers 503 `ocr_slot_empty` with the same sentence, and `ctx.ocr.read` throws it. A host that lends a module no OCR at all says so up front (`ctx.ocr.emptyBecause`).

## Methods

One request, one answer.

| method | params | result |
|---|---|---|
| `ocr.read` | `{ bytes, contentType, name?, label }` | `{ text, pages, cost: [{ microdollars, label }] }` |
| `ocr.prices` (optional) | `{}` | `{ perPage }` |

- **`bytes`** is the file, base64. **`contentType`** is `application/pdf` or an image type. **`label`** names the read in cost lines and logs (`file_text` for the host's own reads).
- **`text`** is every page's text in page order; empty when the pages hold none (the host reads that as `no_text`).
- **`pages`** is how many pages were read; an image is one.
- **`cost`** is what the read spent, priced by the module. The host adds it to the run's spend, so `maxRunCostUsd` counts it; a host read's lines are `ocr:<label>`.
- **A read reports its cost.** An answer that read pages and whose `cost` sums to zero is refused, and the run fails, unless the module publishes its price as zero (`perPage: 0`, a free module). A cap that counts a read as free no longer holds.
- **`ocr.prices`** publishes the least one page costs, in dollars. A module offers it by listing it in its manifest's `methods`. With it, the host refuses a read before making it when the file's pages alone cost more than the run has left (an image is one page; a PDF's pages as lf counted them); the run pauses as at its cap. Without it, a read is refused up front only once the budget is spent.
- **A refusal**: `bad_request` for a request missing `bytes`, `contentType` or `label`; `unsupported_type` for bytes of a type the module does not read (the host reads the file as `unsupported_type`); `module_error` for a backend failure (the host reads the file as `extraction_failed`, naming it).
- Shapes: `packages/engine-contracts/slots/ocr.ts`. A Rust module implements `module_kit::Ocr` and is served with `Host::ocr`.

## Modules

| module | backend | price |
|---|---|---|
| `@listen-fire/document-ai` ([README](../../modules/document-ai/README.md)) | Google Document AI, the platform's own reader: online up to 15 pages and 20 MB, batched through a Cloud Storage bucket past that | per page, `price_per_page` (default $0.0015) |
| `@listen-fire/models` as `models_ocr` ([README](../../modules/models/README.md#reading-scanned-files-the-ocr-slot)) | Gemini reading the file itself | its tokens, from the shared price table; publishes Gemini's 258 tokens a page at the input price |

The platform keeps its own Document AI reader (`GOOGLE_*` environment) for its own runs; nothing here changes it.

## Conformance

`ocrSlotCases` and `commonSlotCases('ocr', …)` (`@listen-fire/module-runtime/module-wire`, re-exported by `movement-engine/public/module-wire`) run against any server: a two-page scanned PDF and an image (drawn from a bitmap font, `scannedPdfOf`, `pngOf`) are read, a read that read pages reports a cost unless the module is published free, `ocr.prices` prices a page when listed, and the two refusals. `modules/document-ai` runs them against itself before a fake Document AI and Cloud Storage; `modules/models` against its OCR install before a fake Gemini; `apps/cli/src/__test__/ocr.test.ts` against lf's own client of both (`lf --contract-ocr-slot --dir <project>`, the project's ocr slot served through lf).

## Changes

- **2026-10-20** (within adapter protocol 2): the ocr slot's methods; lf reads a PDF's own text layer and hands a file without one, and every image, to the slot; the OCR door for the modules lf starts (`ctx.ocr`).
