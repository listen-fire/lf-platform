# The files slot's methods

Part of [the adapter protocol](adapter-protocol.md), version 2 (an addition within it; no version of its own).

A files module keeps the documents a host's runs make and read. lf ships `@lf/local-files` (the project's `.lf/files/`). Another (S3, a bucket of its own) is a module lf starts, or reaches at its URL, over [the transport](adapter-protocol.md#transport), installed with `slot: files` and named in `core: { files: … }`.

## Methods

Bytes ride the envelope as base64: no streaming.

| method | params | result |
|---|---|---|
| `files.put` | `{ tenant, name, contentType, bytes }` | the stored file's descriptor |
| `files.owns` | `{ objectUri, tenant }` | boolean: the tenant stored it |
| `files.open` | `{ objectUri }` | `{ bytes }` |

```ts
type StoredFile = {
  __brand: 'FileRef';
  name: string;
  contentType: string;
  size: number; // bytes
  source: { store: 'document'; objectUri: string };
};
```

- **`objectUri`** is the module's own handle. Two puts of one name are two documents.
- **A host reads only what a tenant owns**: it asks `files.owns` before `files.open`.
- **A refusal**: `files.open` of a document never stored is refused (any code).
- Shapes: `packages/engine-contracts/slots/files.ts`.

## Conformance

`filesSlotCases` and `commonSlotCases('files', …)` (`@listen-fire/module-runtime/module-wire`, re-exported by `movement-engine/public/module-wire`); `apps/cli` runs them against `lf --contract-files`.

## Changes

- **2026-10-19** (within adapter protocol 2): the files slot's methods, and modules filling it over the transport.
