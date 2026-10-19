// The adapter as the engine runs it: the runtime-neutral contract
// (`engine-contracts`), with the live adapter a Node host calls, whose file
// bytes are a stream (`module-runtime`).

export * from 'engine-contracts/adapter';
export type { Adapter, ResolveFileRefResult } from 'module-runtime/adapter';
