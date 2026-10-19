// The files slot's methods (docs/contracts/files-slot.md): where a host keeps
// the documents its runs make and read. Bytes ride the JSON envelope as
// base64 (no streaming); a stored document is named by the descriptor `put`
// answers, whose `source.objectUri` is the module's own handle. A tenant
// reads only what it owns.

import { z } from 'zod';

export const FILES_METHODS = ['files.put', 'files.owns', 'files.open'] as const;

export const FilesPutRequest = z.object({
  tenant: z.string().min(1),
  name: z.string().min(1),
  contentType: z.string().min(1),
  /** The bytes, base64. */
  bytes: z.string(),
});

/** A stored document's descriptor (`documentStoreFileRef`). */
export const StoredFile = z.object({
  __brand: z.literal('FileRef'),
  name: z.string(),
  contentType: z.string(),
  size: z.number().int().nonnegative(),
  source: z.object({ store: z.literal('document'), objectUri: z.string().min(1) }),
});
export type StoredFileShape = z.infer<typeof StoredFile>;

export const FilesOwnsRequest = z.object({ objectUri: z.string(), tenant: z.string() });
export const FilesOwnsAnswer = z.boolean();

export const FilesOpenRequest = z.object({ objectUri: z.string() });
export const FilesOpenAnswer = z.object({ bytes: z.string() });
