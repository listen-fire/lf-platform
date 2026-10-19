// A live adapter on a Node host: the runtime-neutral contract
// (`engine-contracts`) plus the one method whose answer is a Node type,
// redeeming a file the adapter owns to its bytes as a stream.

import type { Readable } from 'node:stream';
import type { Adapter as AdapterContract, FileRef } from 'engine-contracts';

/**
 * Result of resolving a `FileRef` to its live bytes — owner-side, and only
 * ever on the host: the consumer receives a Node `Readable` regardless of how
 * the owner sourced it (local adapters return the stream directly;
 * `RemoteAdapter` converts a wire `{ url }` to a stream via `fetch` +
 * `Readable.fromWeb`).
 */
export interface ResolveFileRefResult {
  stream: Readable;
  contentType?: string;
  size?: number;
}

export interface Adapter extends AdapterContract {
  /**
   * Resolve a `FileRef` this adapter owns to its live bytes. The host calls
   * it (`streamFileRef`) on the instance the descriptor names — resolved with
   * the descriptor's credential and construction args — so the owner fetches
   * with its OWN credentials.
   *
   * Optional — only adapters that EMIT `FileRef`s implement it. `RemoteAdapter` implements it by calling the wire
   * `resolveFileRef` (which returns `{ url }`) and converting url→stream.
   *
   */
  resolveFileRef?(input: { ref: FileRef }): Promise<ResolveFileRefResult>;
}
