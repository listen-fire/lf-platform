// What a module and the host that loads it share at run time on Node, beside
// the runtime-neutral contracts (`engine-contracts`): a live adapter's file
// bytes as a stream, the files slot, the secrets family (resolve a credential,
// write it back at a version, refresh it once at a time) with the generic
// OAuth 2 refresh and connect, the in-memory vault an embedder starts from,
// the browser slot, and a bounded concurrency queue.

export * from './adapter';
export * from './browser';
export * from './documents';
export * from './queue';
export * from './secrets/connect';
export * from './secrets/family';
export * from './secrets/memory';
export * from './secrets/oauth2';
